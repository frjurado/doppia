"""Celery task: populate ``movement_analysis.events`` for a single movement.

The task is dispatched by the upload endpoint immediately after the DB
transaction commits.  It receives the raw ``harmonies.tsv`` content as an
argument (so the upload tempdir can be cleaned up immediately), plus the
``movement_id`` UUID and the ``analysis_source`` discriminator.

Dispatch is structured so that the DCML branch is the only one that must be
production-quality in Phase 1.  All other branches raise ``NotImplementedError``
deliberately; they are filled in as the matching corpus is first ingested:

- ``"DCML"`` — implemented here (Step 8).
- ``"WhenInRome"`` — deferred until first When-in-Rome corpus.
- ``"music21_auto"`` — deferred to Component 6.
- ``"none"`` — no-op; no expert annotation and no music21 fallback yet.

See docs/roadmap/component-1-mei-corpus-ingestion.md §Step 8 and ADR-004.
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
import os
import re
from dataclasses import dataclass
from fractions import Fraction
from typing import Any, Literal

import lxml.etree
from services.celery_app import celery_app
from services.object_storage import make_storage_client
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

# ---------------------------------------------------------------------------
# MEI namespace constants
# ---------------------------------------------------------------------------

_MEI_NS = "http://www.music-encoding.org/ns/mei"
_XML_NS = "http://www.w3.org/XML/1998/namespace"

# ---------------------------------------------------------------------------
# Pitch-class lookup tables
# ---------------------------------------------------------------------------

_NOTE_TO_PC: dict[str, int] = {
    "C": 0,
    "C#": 1,
    "Db": 1,
    "D": 2,
    "D#": 3,
    "Eb": 3,
    "E": 4,
    "Fb": 4,
    "F": 5,
    "E#": 5,
    "F#": 6,
    "Gb": 6,
    "G": 7,
    "G#": 8,
    "Ab": 8,
    "A": 9,
    "A#": 10,
    "Bb": 10,
    "B": 11,
    "Cb": 11,
    "B#": 0,
}

_PC_TO_NOTE_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_PC_TO_NOTE_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]

# Global keys whose derived pitch names should prefer flat spellings.
_FLAT_KEY_TONICS = {"F", "Bb", "Eb", "Ab", "Db", "Gb", "Cb"}

# Diatonic semitone intervals from tonic for the major (ionian) scale.
_MAJOR_INTERVALS = [0, 2, 4, 5, 7, 9, 11]

_ROMAN_TO_DEG: dict[str, int] = {
    "I": 0,
    "II": 1,
    "III": 2,
    "IV": 3,
    "V": 4,
    "VI": 5,
    "VII": 6,
}

# ---------------------------------------------------------------------------
# Form (chord quality) mapping
# ---------------------------------------------------------------------------

_FORM_TO_QUALITY: dict[str, str] = {
    "M": "major",
    "m": "minor",
    "d": "diminished",
    "o": "diminished",
    "+": "augmented",
    "a": "augmented",
    "%": "half-diminished",
}

# ---------------------------------------------------------------------------
# figbass → (numeral_suffix, inversion) mapping
# ---------------------------------------------------------------------------

_FIGBASS_MAP: dict[str, tuple[str, int]] = {
    "": ("", 0),
    "6": ("6", 1),
    "64": ("64", 2),
    "7": ("7", 0),
    "65": ("65", 1),
    "43": ("43", 2),
    "2": ("2", 3),
    "9": ("9", 0),
}

# ---------------------------------------------------------------------------
# Regex helpers
# ---------------------------------------------------------------------------

# Matches a simple pitch-class letter with optional accidental: A, Bb, F#, g, ab …
_SIMPLE_LETTER_RE = re.compile(r"^([A-Ga-g])([b#]?)$")

# Matches an optional leading accidental + Roman numeral (case-insensitive).
# Longest alternatives first to avoid partial matches.
_ROMAN_RE = re.compile(r"^([b#]?)(VII|VI|IV|V|III|II|I)", re.IGNORECASE)

# ---------------------------------------------------------------------------
# Pure helper functions (no I/O)
# ---------------------------------------------------------------------------


def _is_nan(value: str) -> bool:
    """Return ``True`` for the literal string ``'NaN'``, ``'nan'``, or empty string."""
    return value.strip() in ("NaN", "nan", "NAN", "")


def _compute_beat(mn_onset: str, timesig: str) -> float:
    """Convert DCML ``mn_onset`` (quarter-note offset from bar start) to 1-indexed beat.

    DCML stores ``mn_onset`` as a rational number of quarter notes elapsed since
    the beginning of the notated bar (e.g. ``"3/2"`` for the second dotted-quarter
    beat in 6/8).  This function converts that to the 1-indexed beat number used
    in ``movement_analysis.events``.

    Args:
        mn_onset: String offset in quarter notes; may be a fraction like ``"3/2"``.
        timesig: DCML time signature string, e.g. ``"4/4"``, ``"6/8"``, ``"3/4"``.

    Returns:
        1-indexed beat position as a float (downbeat = ``1.0``).
    """
    onset = Fraction(mn_onset)
    num, den = (int(x) for x in timesig.split("/"))
    # Compound meter: denominator = 8, numerator divisible by 3 and ≥ 6.
    compound = (num % 3 == 0) and (num >= 6) and (den == 8)
    beat_unit = Fraction(3, 2) if compound else Fraction(4, den)
    return float(onset / beat_unit) + 1.0


def _parse_global_key(globalkey: str) -> tuple[int, bool]:
    """Parse a DCML globalkey string to (tonic_pitch_class, use_flats).

    Args:
        globalkey: DCML global key string, e.g. ``"A"``, ``"Bb"``, ``"F#"``.
            Uppercase = major; only the tonic pitch class is extracted here.

    Returns:
        A 2-tuple of the tonic pitch class (0–11) and whether flat spellings
        should be preferred for derived notes.

    Raises:
        ValueError: If the string cannot be parsed as a pitch-class letter.
    """
    m = _SIMPLE_LETTER_RE.match(globalkey.strip())
    if not m:
        raise ValueError(f"Cannot parse globalkey {globalkey!r} as a pitch class.")
    letter = m.group(1).upper()
    acc = m.group(2)
    note = letter + acc
    tonic_pc = _NOTE_TO_PC[note]
    use_flats = note in _FLAT_KEY_TONICS
    return tonic_pc, use_flats


def _resolve_key(localkey: str, globalkey: str) -> str:
    """Resolve a DCML ``localkey`` to a canonical key name (e.g. ``"A major"``).

    DCML local keys are either:
    - A pitch-class letter (``"A"`` = A major, ``"a"`` = A minor, ``"Bb"`` = Bb major).
    - A Roman numeral relative to the global key (``"I"``, ``"IV"``, ``"vi"``,
      ``"#III"``), with uppercase = major quality, lowercase = minor quality.

    Args:
        localkey: DCML localkey column value.
        globalkey: DCML globalkey column value (provides tonic for Roman numeral resolution).

    Returns:
        Canonical string like ``"A major"`` or ``"D minor"``.

    Raises:
        ValueError: If the string cannot be parsed.
    """
    lk = localkey.strip()

    # Case 1: simple pitch-class letter (A–G, optional b/#).
    m = _SIMPLE_LETTER_RE.match(lk)
    if m:
        letter = m.group(1)
        acc = m.group(2)
        note = letter.upper() + acc
        quality = "minor" if letter.islower() else "major"
        return f"{note} {quality}"

    # Case 2: Roman numeral relative to globalkey.
    m_rom = _ROMAN_RE.match(lk)
    if m_rom:
        acc_str = m_rom.group(1)  # "" | "b" | "#"
        roman = m_rom.group(2).upper()
        # Quality: first character of the Roman part (after stripping accidental).
        first_char = lk[len(acc_str)]
        quality = "minor" if first_char.islower() else "major"

        deg = _ROMAN_TO_DEG[roman]
        tonic_pc, use_flats = _parse_global_key(globalkey)

        interval = _MAJOR_INTERVALS[deg]
        if acc_str == "#":
            interval += 1
        elif acc_str == "b":
            interval -= 1

        result_pc = (tonic_pc + interval) % 12
        pc_table = _PC_TO_NOTE_FLAT if use_flats else _PC_TO_NOTE_SHARP
        note_name = pc_table[result_pc]
        return f"{note_name} {quality}"

    raise ValueError(f"Cannot parse localkey {localkey!r}.")


def _parse_numeral(numeral: str) -> tuple[str, str | None, int]:
    """Extract stripped Roman numeral, root_accidental, and scale-degree int.

    Args:
        numeral: DCML ``numeral`` column value (e.g. ``"I"``, ``"bVII"``, ``"#IV"``).

    Returns:
        A 3-tuple of:
        - ``stripped_numeral``: numeral with leading accidental removed
          (case preserved, e.g. ``"VII"`` or ``"ii"``).
        - ``root_accidental``: ``"flat"``, ``"sharp"``, or ``None``.
        - ``root_int``: scale degree 1–7 (case-insensitive, uppercase Roman).

    Raises:
        ValueError: If no valid Roman numeral can be parsed.
    """
    n = numeral.strip()
    root_accidental: str | None = None
    if n.startswith("b"):
        root_accidental = "flat"
        n = n[1:]
    elif n.startswith("#"):
        root_accidental = "sharp"
        n = n[1:]

    m = _ROMAN_RE.match(n)
    if not m:
        raise ValueError(f"Cannot parse Roman numeral from {numeral!r}.")
    roman = m.group(2).upper()
    root_int = _ROMAN_TO_DEG[roman] + 1  # 1-indexed scale degree
    return n, root_accidental, root_int


def _map_figbass(figbass: str) -> tuple[str, int]:
    """Map a DCML ``figbass`` string to ``(numeral_suffix, inversion)``.

    Args:
        figbass: Raw figbass string from the DCML TSV (may be ``"NaN"`` or empty).

    Returns:
        A 2-tuple of the string suffix to append to the Roman numeral (e.g.
        ``"6"``, ``"7"``) and the inversion integer (0 = root position).
    """
    if _is_nan(figbass):
        return ("", 0)
    f = figbass.strip()
    return _FIGBASS_MAP.get(f, (f, 0))


def _build_numeral(stripped: str, figbass_suffix: str) -> str:
    """Concatenate stripped Roman numeral with its figbass suffix.

    Args:
        stripped: Stripped numeral, e.g. ``"V"``, ``"ii"``.
        figbass_suffix: Suffix from :func:`_map_figbass`, e.g. ``"7"``, ``"6"``.

    Returns:
        Combined string, e.g. ``"V7"``, ``"ii6"``, ``"I"``.
    """
    return stripped + figbass_suffix


def _map_form(form: str) -> str:
    """Map a DCML ``form`` code to a quality string.

    Args:
        form: DCML form column value (e.g. ``"M"``, ``"m"``, ``"%"``).

    Returns:
        Quality string: ``"major"``, ``"minor"``, ``"diminished"``,
        ``"augmented"``, or ``"half-diminished"``.

    Raises:
        ValueError: For unrecognised form codes.
    """
    if _is_nan(form):
        return "major"
    f = form.strip()
    if f not in _FORM_TO_QUALITY:
        raise ValueError(f"Unknown DCML form code: {form!r}.")
    return _FORM_TO_QUALITY[f]


def _parse_changes(changes: str) -> list[str]:
    """Parse the DCML ``changes`` column into a list of extension strings.

    Args:
        changes: Raw changes string, e.g. ``"(9)"``, ``"(9,11)"``, or ``"NaN"``.

    Returns:
        List of extension strings, e.g. ``["9"]``, ``["9", "11"]``, or ``[]``.
    """
    if _is_nan(changes):
        return []
    c = changes.strip().strip("()")
    if not c:
        return []
    return [x.strip() for x in c.split(",") if x.strip()]


@dataclass(frozen=True)
class MeasureEntry:
    """One measure's metadata, keyed in the measure map by position index (mc).

    n_raw is the raw @n attribute string — not parsed to int, so non-integer
    values like "X1" or "12a" are preserved rather than dropped.
    volta is the integer @n of the enclosing <ending>, or None if the measure
    is not inside any <ending>.
    xml_id is the measure's xml:id, or '' if none is present.
    """

    n_raw: str
    volta: int | None
    xml_id: str


def _build_measure_map(mei_bytes: bytes) -> dict[int, MeasureEntry]:
    """Build a ``position_index → MeasureEntry`` map by walking the normalized MEI.

    The position index is 1-based document order over all ``<measure>`` elements
    in the file — the same counter as DCML ``mc`` and Verovio's ``measureRange``
    operand. Non-integer ``@n`` values are preserved as ``n_raw``; they no longer
    cause the entry to be silently dropped.

    Used to verify that every TSV row's ``mc`` value resolves to a known measure
    in the MEI source. Returns an empty dict on XML parse failure so alignment
    verification degrades gracefully.

    Args:
        mei_bytes: Normalized MEI bytes fetched from object storage.

    Returns:
        Dict mapping 1-based position indices to MeasureEntry instances.
    """
    try:
        root = lxml.etree.fromstring(mei_bytes)
    except lxml.etree.XMLSyntaxError:
        return {}

    measure_map: dict[int, MeasureEntry] = {}
    position = 0
    for measure in root.iter(f"{{{_MEI_NS}}}measure"):
        position += 1
        n_raw = measure.get("n", "")
        xml_id = measure.get(f"{{{_XML_NS}}}id", "")

        volta: int | None = None
        parent = measure.getparent()
        while parent is not None:
            if parent.tag == f"{{{_MEI_NS}}}ending":
                v = parent.get("n")
                try:
                    volta = int(v) if v else None
                except (ValueError, TypeError):
                    volta = None
                break
            parent = parent.getparent()

        measure_map[position] = MeasureEntry(n_raw=n_raw, volta=volta, xml_id=xml_id)

    return measure_map


# ---------------------------------------------------------------------------
# TSV parser
# ---------------------------------------------------------------------------


def _parse_dcml_harmonies(
    tsv_content: str,
    mei_bytes: bytes,
) -> tuple[list[dict[str, Any]], list[str], list[str]]:
    """Parse a DCML harmonies TSV into event dicts, phrase boundaries, and alignment warnings.

    Each TSV row whose ``event`` column is not a phrase marker (``{`` / ``}``)
    becomes one entry in the returned events list.  The event shape matches the
    ``movement_analysis.events`` JSONB schema documented in
    ``docs/architecture/fragment-schema.md``.

    Args:
        tsv_content: Raw text content of a DCML ``harmonies/*.tsv`` file.
        mei_bytes: Normalized MEI bytes used for ``(mn, volta)`` alignment
            verification.

    Returns:
        A 3-tuple of:
        - ``events``: Parsed and normalised event dicts.
        - ``phrase_boundaries``: Human-readable strings describing phrase markers
          (not stored; surfaced to annotators as candidate fragment boundaries).
        - ``alignment_warnings``: Warning strings for TSV rows whose ``(mn, volta)``
          pair does not resolve to a known measure in the MEI.
    """
    reader = csv.DictReader(io.StringIO(tsv_content), delimiter="\t")
    events: list[dict[str, Any]] = []
    phrase_boundaries: list[str] = []
    first_globalkey: str | None = None

    for row in reader:
        gk_raw = row.get("globalkey", "")
        event_col = row.get("event", "").strip()

        # Track the first non-NaN globalkey for key cross-checks.
        if first_globalkey is None and not _is_nan(gk_raw):
            first_globalkey = gk_raw.strip()

        # ── Phrase markers ────────────────────────────────────────────────
        if event_col in ("{", "}"):
            mn_str = row.get("mn", "?")
            volta_raw = row.get("volta", "")
            volta_display = None if _is_nan(volta_raw) else int(float(volta_raw))
            direction = "open" if event_col == "{" else "close"
            phrase_boundaries.append(f"mn={mn_str} volta={volta_display} {direction}")
            continue

        # ── Chord event rows ──────────────────────────────────────────────
        globalkey = gk_raw.strip() if not _is_nan(gk_raw) else (first_globalkey or "C")

        localkey_raw = row.get("localkey", "").strip()
        try:
            local_key_str = _resolve_key(localkey_raw, globalkey)
        except ValueError:
            # Fallback: treat as a major key named by the raw string.
            local_key_str = f"{localkey_raw} major"

        # Position
        mc_raw = row.get("mc", "")
        mn_raw = row.get("mn", "0")
        volta_raw = row.get("volta", "")
        mn_onset = row.get("mn_onset", "0")
        timesig = row.get("timesig", "4/4")

        mc: int | None = None if _is_nan(mc_raw) else int(mc_raw)
        mn: int = 0 if _is_nan(mn_raw) else int(mn_raw)
        volta: int | None = None if _is_nan(volta_raw) else int(float(volta_raw))

        try:
            beat = _compute_beat(mn_onset, timesig)
        except (ValueError, ZeroDivisionError):
            beat = 1.0

        # Harmony
        numeral_raw = row.get("numeral", "I").strip()
        figbass_raw = row.get("figbass", "").strip()
        form_raw = row.get("form", "M").strip()
        changes_raw = row.get("changes", "").strip()
        relativeroot_raw = row.get("relativeroot", "").strip()

        try:
            stripped_numeral, root_accidental, root_int = _parse_numeral(numeral_raw)
        except ValueError:
            stripped_numeral = numeral_raw
            root_accidental = None
            root_int = 1

        figbass_suffix, inversion = _map_figbass(figbass_raw)
        built_numeral = _build_numeral(stripped_numeral, figbass_suffix)

        try:
            quality = _map_form(form_raw)
        except ValueError:
            quality = "major"

        extensions = _parse_changes(changes_raw)
        # DCML relativeroot uses a leading slash (e.g. "/V" for V/V); strip it.
        applied_to: str | None = (
            None if _is_nan(relativeroot_raw) else relativeroot_raw.lstrip("/")
        )

        # Also capture phrase boundary info from phraseend column on chord rows.
        phraseend_raw = row.get("phraseend", "").strip()
        if not _is_nan(phraseend_raw) and phraseend_raw in ("{", "}"):
            direction = "open" if phraseend_raw == "{" else "close"
            phrase_boundaries.append(f"mn={mn} volta={volta} {direction}")

        events.append(
            {
                "mc": mc,
                "mn": mn,
                "volta": volta,
                "beat": beat,
                "local_key": local_key_str,
                "root": root_int,
                "quality": quality,
                "inversion": inversion,
                "numeral": built_numeral,
                "root_accidental": root_accidental,
                "applied_to": applied_to,
                "extensions": extensions,
                "bass_pitch": None,
                "soprano_pitch": None,
                "source": "DCML",
                "auto": False,
                "reviewed": False,
            }
        )

    # ── Alignment verification ────────────────────────────────────────────
    alignment_warnings: list[str] = []
    if mei_bytes:
        measure_map = _build_measure_map(mei_bytes)
        for ev in events:
            mc = ev["mc"]
            if mc is None or mc not in measure_map:
                alignment_warnings.append(
                    f"TSV event at mc={mc} mn={ev['mn']} volta={ev['volta']} "
                    f"has no matching measure in MEI."
                )

    return events, phrase_boundaries, alignment_warnings


# ---------------------------------------------------------------------------
# Smart-merge (ADR-004)
# ---------------------------------------------------------------------------


def _merge_events(
    existing: list[dict[str, Any]],
    incoming: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Smart-merge per ADR-004.

    Events keyed on ``mc`` (the stable DCML linear measure count).  Events
    without ``mc`` (manually inserted events) are left in place; their
    ``(mn, volta, beat)`` triple is their effective identity.

    Policy:
    - ``source == "manual"`` or ``reviewed == True`` → preserve unchanged;
      if ``mc`` no longer appears in *incoming*, set ``orphaned=True``.
    - Other existing events whose ``mc`` appears in *incoming* → replaced.
    - Incoming events with ``mc`` not seen in *existing* → inserted.

    Args:
        existing: Current ``events`` list from the database row (may be empty).
        incoming: Freshly parsed events from the DCML TSV.

    Returns:
        Merged event list sorted by ``(mc, mn, volta, beat)``.
    """
    incoming_by_mc: dict[int, dict[str, Any]] = {
        e["mc"]: e for e in incoming if e.get("mc") is not None
    }

    result: list[dict[str, Any]] = []
    covered_mcs: set[int] = set()

    for ev in existing:
        mc = ev.get("mc")
        protected = ev.get("source") == "manual" or ev.get("reviewed") is True

        if protected:
            if mc is not None and mc not in incoming_by_mc:
                result.append({**ev, "orphaned": True})
            else:
                result.append(ev)
            if mc is not None:
                covered_mcs.add(mc)
        else:
            if mc is not None and mc in incoming_by_mc:
                result.append(incoming_by_mc[mc])
                covered_mcs.add(mc)
            elif mc is None:
                # Manual/non-DCML event without an mc key — keep as-is.
                result.append(ev)
            # Unreviewed events with no incoming match are dropped.

    # Insert incoming events whose mc was not present in existing.
    for ev in incoming:
        mc = ev.get("mc")
        if mc is not None and mc not in covered_mcs:
            result.append(ev)

    def _sort_key(e: dict[str, Any]) -> tuple[float, int, float, float]:
        mc_val = e.get("mc")
        mc_sort = float("inf") if mc_val is None else float(mc_val)
        mn_sort = e.get("mn") or 0
        volta_sort = float("inf") if e.get("volta") is None else float(e["volta"])
        beat_sort = e.get("beat") or 1.0
        return (mc_sort, mn_sort, volta_sort, beat_sort)

    result.sort(key=_sort_key)
    return result


# ---------------------------------------------------------------------------
# Async DB helpers
# ---------------------------------------------------------------------------


async def _dcml_branch(movement_id: str, harmonies_tsv_content: str) -> None:
    """Async body of the DCML analysis ingestion branch.

    Fetches the normalized MEI from object storage, parses the DCML TSV,
    applies the smart-merge policy, and upserts ``movement_analysis``.

    A fresh SQLAlchemy engine is created and disposed within this coroutine.
    This is intentional: Celery tasks run inside ``asyncio.run()``, which
    creates and closes a new event loop per invocation.  A module-level cached
    engine holds asyncpg connections bound to the *previous* (closed) loop and
    raises ``RuntimeError: Event loop is closed`` on reuse.  Creating a
    per-invocation engine avoids this entirely with negligible overhead for an
    internal tool.

    Args:
        movement_id: UUID of the ``movement`` row (as a string).
        harmonies_tsv_content: Raw TSV text from the ``harmonies/*.tsv`` file.
    """
    import music21 as _music21

    engine = create_async_engine(
        os.environ["DATABASE_URL"],
        pool_size=1,
        max_overflow=0,
        pool_pre_ping=False,
        # Supabase uses PgBouncer in transaction pooling mode, which does not
        # support asyncpg prepared statements.  Setting statement_cache_size=0
        # disables the cache and prevents DuplicatePreparedStatementError.
        connect_args={"statement_cache_size": 0},
    )
    try:
        # Phase 1: read what we need from Postgres, then exit the transaction so
        # that the connection is not held open across the S3 round-trip below.
        async with AsyncSession(engine) as session:
            row = (
                await session.execute(
                    text(
                        "SELECT mei_object_key, key_signature "
                        "FROM movement WHERE id = :id"
                    ),
                    {"id": movement_id},
                )
            ).one_or_none()
        if row is None:
            raise ValueError(
                "ingest_movement_analysis: no movement found for"
                f" id={movement_id!r}."
            )
        mei_object_key: str = row.mei_object_key
        existing_key_sig: str | None = row.key_signature

        # Phase 2: external I/O + parsing — no DB transaction open.
        storage = make_storage_client()
        mei_bytes = await storage.get_mei(mei_object_key)

        events, _phrase_boundaries, alignment_warnings = _parse_dcml_harmonies(
            harmonies_tsv_content, mei_bytes
        )

        # Global key cross-check (pure computation; no DB needed yet).
        canonical_gk: str | None = None
        if events:
            first_globalkey = _extract_first_globalkey(harmonies_tsv_content)
            if first_globalkey:
                try:
                    canonical_gk = _resolve_key(first_globalkey, first_globalkey)
                except ValueError:
                    canonical_gk = None

                if (
                    canonical_gk
                    and existing_key_sig is not None
                    and existing_key_sig != canonical_gk
                ):
                    alignment_warnings.append(
                        f"globalkey mismatch: TSV says {canonical_gk!r}, "
                        f"movement.key_signature is {existing_key_sig!r}."
                    )

        # Phase 3: writes in a fresh transaction.
        async with AsyncSession(engine) as session:
            async with session.begin():
                # 1. Back-fill key_signature if it was absent.
                if canonical_gk and existing_key_sig is None:
                    await session.execute(
                        text(
                            "UPDATE movement "
                            "SET key_signature = :ks "
                            "WHERE id = :id"
                        ),
                        {"ks": canonical_gk, "id": movement_id},
                    )

                # 2. Load existing events for smart-merge on re-analysis.
                existing_row = (
                    await session.execute(
                        text(
                            "SELECT events FROM movement_analysis "
                            "WHERE movement_id = :mid"
                        ),
                        {"mid": movement_id},
                    )
                ).one_or_none()
                existing_events: list[dict[str, Any]] = (
                    existing_row.events if existing_row else []
                )

                # 3. Apply smart-merge.
                final_events = (
                    _merge_events(existing_events, events)
                    if existing_events
                    else events
                )

                # 4. Upsert movement_analysis.
                await session.execute(
                    text(
                        """
                        INSERT INTO movement_analysis
                            (id, movement_id, events, music21_version,
                             created_at, updated_at)
                        VALUES
                            (gen_random_uuid(), :movement_id,
                             CAST(:events AS jsonb), :music21_version,
                             now(), now())
                        ON CONFLICT (movement_id) DO UPDATE
                            SET events          = EXCLUDED.events,
                                music21_version = EXCLUDED.music21_version,
                                updated_at      = now()
                        """
                    ),
                    {
                        "movement_id": movement_id,
                        "events": json.dumps(final_events),
                        "music21_version": _music21.__version__,
                    },
                )

                # 5. Store alignment warnings in movement.normalization_warnings.
                if alignment_warnings:
                    await session.execute(
                        text(
                            """
                            UPDATE movement
                            SET normalization_warnings = jsonb_set(
                                COALESCE(normalization_warnings, '{}'),
                                '{harmony_alignment_warnings}',
                                CAST(:warnings AS jsonb)
                            )
                            WHERE id = :id
                            """
                        ),
                        {
                            "warnings": json.dumps(alignment_warnings),
                            "id": movement_id,
                        },
                    )
    finally:
        await engine.dispose()


def _extract_first_globalkey(tsv_content: str) -> str | None:
    """Return the first non-NaN ``globalkey`` value from a DCML TSV string.

    Args:
        tsv_content: Raw TSV text.

    Returns:
        The globalkey string (e.g. ``"A"``), or ``None`` if not found.
    """
    reader = csv.DictReader(io.StringIO(tsv_content), delimiter="\t")
    for row in reader:
        event_col = row.get("event", "").strip()
        if event_col in ("{", "}"):
            continue
        gk = row.get("globalkey", "")
        if not _is_nan(gk):
            return gk.strip()
    return None


# ---------------------------------------------------------------------------
# Celery task
# ---------------------------------------------------------------------------


@celery_app.task(name="ingest_analysis")
def ingest_movement_analysis(
    movement_id: str,
    analysis_source: Literal["DCML", "WhenInRome", "music21_auto", "none"],
    harmonies_tsv_content: str | None = None,
) -> None:
    """Populate ``movement_analysis.events`` for *movement_id*.

    Dispatches on *analysis_source*.  Only the ``"DCML"`` branch is implemented
    in Phase 1.  All other branches raise ``NotImplementedError`` deliberately
    and are filled in when the matching corpus is first ingested.

    Args:
        movement_id: UUID of the ``movement`` row (as a string).
        analysis_source: Provenance discriminator from ``corpus.analysis_source``.
        harmonies_tsv_content: Raw TSV text for DCML corpora; ``None`` otherwise.

    Raises:
        ValueError: If *harmonies_tsv_content* is ``None`` for a DCML corpus,
            or when *analysis_source* is not a recognised value.
        NotImplementedError: For branches not yet implemented (WhenInRome,
            music21_auto).  These are intentional placeholders.
    """
    if analysis_source == "DCML":
        if harmonies_tsv_content is None:
            raise ValueError(
                "harmonies_tsv_content is required for DCML analysis ingestion."
            )
        asyncio.run(_dcml_branch(movement_id, harmonies_tsv_content))
    elif analysis_source == "WhenInRome":
        raise NotImplementedError(
            "When in Rome ingestion is deferred until the first non-DCML corpus."
        )
    elif analysis_source == "music21_auto":
        raise NotImplementedError("music21 auto-analysis is deferred to Component 6.")
    elif analysis_source == "none":
        return
    else:
        raise ValueError(
            f"Unknown analysis_source {analysis_source!r}. "
            "Expected one of: 'DCML', 'WhenInRome', 'music21_auto', 'none'."
        )
