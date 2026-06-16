"""MEI normalization pipeline.

Applies ten normalization passes to an MEI file, writing the result to
``output_path`` and returning a :class:`~models.normalization.NormalizationReport`.

Normalization rules (applied in this order):

1. **Pickup bar** — assigns ``@n="0"`` and ``@metcon="false"`` to the
   anacrusis, renumbering subsequent measures if needed.
2. **Meter change propagation** — inserts ``<meterSig>`` children into
   measures whose meter change is expressed only via ``<staffDef>`` attributes.
3. **``<ending>`` @n assignment** — assigns sequential ``@n`` values to
   ``<ending>`` elements that lack one; flags empty or non-sequential endings.
4. **Repeat-barline pairing** — flags unpaired ``rptend``/``rptstart``
   barlines; treats ``rptboth`` as a combined ``rptend``+``rptstart``.
5. **``@n`` uniqueness outside ``<ending>``** — flags duplicate, non-integer,
   and large-gap ``@n`` values.
6. **``@n`` inside ``<ending>`` elements** — strips alphabetic suffixes from
   suffix-style values (e.g. ``"12a"`` → ``"12"``); flags ambiguous or
   duplicate values within the same ending.
7. **Incomplete measures at repeat boundaries** — when a measure at an
   ``rptend``/``rptboth`` has ``@metcon="false"``, locates the complement
   measure and sets ``@metcon="false"`` on it if missing.
8. **Cross-barline tie completion** — resolves ``<tie>`` elements that carry a
   ``@startid`` but no ``@endid``/``@tstamp2`` (a MuseScore-to-MEI export
   artefact) by pointing ``@endid`` at the first same-pitch note in the
   following measure's matching staff/layer, and propagating the start note's
   alteration onto that continuation note as ``accid.ges`` so its pitch is
   preserved.  Corrects a lost tie (and the consequent wrong accidental) that
   Verovio cannot render from an endpoint-less tie (ADR-026).
9. **Spurious gestural accidentals** — strips ``accid.ges`` (and orphaned
   ``glyph.auth``) from ``<accid>`` elements where ``accid.ges`` is present
   but ``@accid`` is absent and the gestural alteration is *not* explained
   by either the active key signature, a within-staff/measure/octave carry
   from a prior explicit ``@accid``, or a tie from a note that carries the
   same alteration.  Corrects a MuseScore-to-MEI artefact that causes wrong
   MIDI pitch without affecting SVG display (ADR-022).
10. **Clef ``sameas`` resolution** — rewrites ``<clef sameas="#id">`` references
   (per-voice clef restatements emitted by the converter) to explicit
   ``shape``/``line`` so Verovio 6.1.0 renders them instead of an empty clef
   group.

Normalization is **idempotent**: running the normalizer on an already-
normalized file produces byte-identical output and an
:attr:`~models.normalization.NormalizationReport.is_clean` report.

The normalizer never touches musical content (pitches, durations, dynamics),
``xml:id`` values, or encoding style, with two exceptions that repair MEI
conversion-pipeline damage: pass 8 completes endpoint-less ties and restores
the tied continuation's pitch (ADR-026), and pass 9 removes spurious
``accid.ges`` values (ADR-022, which supersedes ADR-021).

Example usage::

    from services.mei_normalizer import normalize_mei

    report = normalize_mei("movement-1.mei", "/tmp/movement-1-norm.mei")
    if not report.is_clean:
        for w in report.warnings:
            print(f"{w.severity.upper()}: {w.message}")
    print("Duration (bars):", report.duration_bars)
"""

from __future__ import annotations

import re

import lxml.etree
from models.normalization import NormalizationIssue, NormalizationReport

# ---------------------------------------------------------------------------
# MEI namespace
# ---------------------------------------------------------------------------

_MEI_NS: str = "http://www.music-encoding.org/ns/mei"
_XML_NS: str = "http://www.w3.org/XML/1998/namespace"
_NSMAP: dict[str, str] = {"mei": _MEI_NS}

# Regex for suffix-style @n values inside <ending> elements, e.g. "12a", "12b".
_SUFFIX_RE: re.Pattern[str] = re.compile(r"^(\d+)[a-zA-Z]+$")

# Regex for DCML/MuseScore X-prefixed @n values, e.g. "X1", "X2".  These appear
# on split-measure complements and volta-ending bars MuseScore could not integer-
# number; under ADR-015 the machine coordinate (mc) keys correctly regardless, so
# they are accepted (downgraded to info) rather than flagged.  See Component 9
# Step 8 triage in docs/architecture/mei-ingest-normalization.md.
_DCML_X_RE: re.Pattern[str] = re.compile(r"^X\d+$")

# Standard additive pitch-class order for key signatures (MEI pname values).
_SHARP_ORDER: tuple[str, ...] = ("f", "c", "g", "d", "a", "e", "b")
_FLAT_ORDER: tuple[str, ...] = ("b", "e", "a", "d", "g", "c", "f")


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _xpath(elem: lxml.etree._Element, expr: str) -> list[lxml.etree._Element]:
    """Evaluate *expr* against *elem* in the MEI namespace.

    Args:
        elem: The context element.
        expr: XPath expression; ``mei:`` prefix refers to the MEI namespace.

    Returns:
        List of matching elements (may be empty).
    """
    return elem.xpath(expr, namespaces=_NSMAP)  # type: ignore[no-any-return]


def _xp(root: lxml.etree._Element, elem: lxml.etree._Element) -> str:
    """Return the document XPath for *elem*.

    Args:
        root: Document root (used to obtain the element tree).
        elem: Target element.

    Returns:
        XPath string such as ``/mei/music/body/mdiv/score/section/measure[2]``.
    """
    return root.getroottree().getpath(elem)


def _build_repeat_sections(
    all_measures: list[lxml.etree._Element],
) -> list[tuple[int | None, int]]:
    """Map each repeat-close event to its matching open event.

    Returns a list of ``(open_idx_or_None, close_idx)`` pairs in document
    order.  ``open_idx`` is ``None`` for the first, implicitly-unpaired
    close (the repeat goes back to the beginning of the piece).

    Args:
        all_measures: All ``<measure>`` elements in document order.

    Returns:
        List of ``(open_idx | None, close_idx)`` tuples.
    """
    pairs: list[tuple[int | None, int]] = []
    open_stack: list[int] = []  # indices of measures that opened a section
    first_close_seen = False

    for i, measure in enumerate(all_measures):
        right = measure.get("right", "")
        left = measure.get("left", "")

        # Open events
        if right == "rptstart" or left == "rptstart":
            open_stack.append(i)

        # Close events (rptend or the close half of rptboth)
        if right in ("rptend", "rptboth"):
            if not first_close_seen:
                first_close_seen = True
                # First close is *allowed* to be unpaired — no warning if unpaired.
                # But if a matching open IS present, consume it normally.
                open_idx: int | None = open_stack.pop() if open_stack else None
            elif open_stack:
                open_idx = open_stack.pop()
            else:
                open_idx = None  # unpaired non-first close (flagged by pass 4)
            pairs.append((open_idx, i))

            # rptboth also opens a new section
            if right == "rptboth":
                open_stack.append(i)

    return pairs


# ---------------------------------------------------------------------------
# Normalization passes
# ---------------------------------------------------------------------------


def _normalize_pickup_bar(
    root: lxml.etree._Element,
    changes_applied: list[str],
) -> None:
    """Pass 1 — Pickup bar encoding.

    Detects the anacrusis from ``@metcon="false"`` on the first measure or
    from ``@n="0"`` already being present.  Ensures ``@n="0"`` and
    ``@metcon="false"``.  Renumbers all subsequent bare measures (those not
    inside an ``<ending>``) if the original used ``@n="1"`` for the pickup.

    Args:
        root: Document root element.
        changes_applied: Mutable list; auto-corrections are appended here.
    """
    all_measures: list[lxml.etree._Element] = _xpath(root, "//mei:measure")
    if not all_measures:
        return

    first = all_measures[0]
    n_str = first.get("n", "")
    metcon = first.get("metcon", "")

    # Case 1: first measure already has @n="0" — ensure @metcon="false".
    if n_str == "0":
        if metcon != "false":
            first.set("metcon", "false")
            changes_applied.append(
                "Set @metcon='false' on pickup bar (already @n='0')."
            )
        return

    # Case 2: first measure is @metcon="false" with @n="1" — renumber.
    if metcon == "false" and n_str == "1":
        first.set("n", "0")
        bare_measures: list[lxml.etree._Element] = _xpath(
            root, "//mei:measure[not(ancestor::mei:ending)]"
        )
        # Skip the pickup itself (index 0); renumber the rest by -1.
        for m in bare_measures[1:]:
            try:
                old_n = int(m.get("n", ""))
                m.set("n", str(old_n - 1))
            except ValueError:
                pass  # non-integer @n — flagged by pass 5, not touched here
        changes_applied.append(
            "Pickup bar renumbered from @n='1' to @n='0'; "
            "subsequent bare measures decremented by 1."
        )


def _propagate_meter_changes(
    root: lxml.etree._Element,
    changes_applied: list[str],
) -> None:
    """Pass 2 — Meter change propagation into measures.

    When a ``<measure>`` contains a ``<staffDef>`` with ``@meter.count`` and
    ``@meter.unit``, inserts a matching ``<meterSig>`` as the first direct
    child of that ``<measure>`` (unless one is already present).

    Args:
        root: Document root element.
        changes_applied: Mutable list; insertions are appended here.
    """
    for measure in _xpath(root, "//mei:measure"):
        staffdefs = measure.xpath(
            ".//mei:staffDef[@meter.count and @meter.unit]",
            namespaces=_NSMAP,
        )
        if not staffdefs:
            continue

        # Skip if a <meterSig> direct child already exists.
        existing = measure.xpath("mei:meterSig", namespaces=_NSMAP)
        if existing:
            continue

        count: str = staffdefs[0].get("meter.count")  # type: ignore[assignment]
        unit: str = staffdefs[0].get("meter.unit")  # type: ignore[assignment]

        meter_sig = lxml.etree.Element(f"{{{_MEI_NS}}}meterSig")
        meter_sig.set("count", count)
        meter_sig.set("unit", unit)
        # Insert as first child so it precedes <staff> content.
        measure.insert(0, meter_sig)
        xp = _xp(root, measure)
        changes_applied.append(
            f"Inserted <meterSig count='{count}' unit='{unit}'/> "
            f"into measure at {xp}."
        )


def _normalize_ending_ns(
    root: lxml.etree._Element,
    changes_applied: list[str],
    warnings: list[NormalizationIssue],
) -> None:
    """Pass 3 — ``<ending>`` @n assignment and structure checks.

    Assigns sequential integer ``@n`` values (1, 2, …) in document order
    to ``<ending>`` elements that have no ``@n``.  Flags empty endings,
    non-sequential numbering, and single-ending sections.

    Args:
        root: Document root element.
        changes_applied: Mutable list; assignments are appended here.
        warnings: Mutable list; structural issues are appended here.
    """
    endings: list[lxml.etree._Element] = _xpath(root, "//mei:ending")
    if not endings:
        return

    # Assign sequential @n to unnumbered endings (by document position).
    counter = 1
    for ending in endings:
        if ending.get("n") is None:
            ending.set("n", str(counter))
            changes_applied.append(
                f"Assigned @n='{counter}' to unnumbered <ending> element."
            )
        counter += 1

    # Flag endings with no <measure> children.
    for ending in endings:
        measures = ending.xpath("mei:measure", namespaces=_NSMAP)
        if not measures:
            warnings.append(
                NormalizationIssue(
                    code="ENDING_EMPTY",
                    message=(
                        f"<ending n='{ending.get('n', '?')}'> contains zero "
                        f"<measure> elements."
                    ),
                    severity="warning",
                )
            )

    # Check ending numbering.  A single global 1..N sequence is the simple case,
    # but multi-repetition / multi-section movements legitimately repeat volta
    # numbers (e.g. [1, 1, 2, 2] or [1, 1, 1, 2, 2, 2]) — the same bracket read
    # on several passes.  ADR-025's runtime volta index is the authority; here we
    # only require that the *distinct* ending numbers form a contiguous run from
    # 1 (no gap, no missing first).  Repeated numbers within that run are an
    # accepted pattern (info); a non-contiguous set is a genuine defect (warning).
    numbered: list[int] = []
    for ending in endings:
        try:
            numbered.append(int(ending.get("n", "")))
        except ValueError:
            pass  # non-integer @n on ending — leave for upstream handling
    if numbered:
        distinct = set(numbered)
        expected_set = set(range(1, max(numbered) + 1))
        if distinct != expected_set:
            warnings.append(
                NormalizationIssue(
                    code="ENDING_NON_SEQUENTIAL",
                    message=(
                        f"<ending> @n values do not form a contiguous run from 1: "
                        f"{sorted(numbered)} (expected the set {sorted(expected_set)})."
                    ),
                    severity="warning",
                )
            )
        elif len(numbered) != len(distinct):
            warnings.append(
                NormalizationIssue(
                    code="ENDING_REPEATED_VOLTA",
                    message=(
                        f"<ending> @n values repeat across passes/sections: "
                        f"{sorted(numbered)}. Accepted multi-repetition encoding; "
                        f"volta disambiguation is by document order (mc), per "
                        f"ADR-015/ADR-025."
                    ),
                    severity="info",
                )
            )

    # Flag sections with only one ending.
    if len(endings) == 1:
        warnings.append(
            NormalizationIssue(
                code="ENDING_SINGLE",
                message=(
                    "<section> has only one <ending>; second ending appears to "
                    "be missing."
                ),
                severity="warning",
            )
        )


def _check_repeat_barlines(
    root: lxml.etree._Element,
    warnings: list[NormalizationIssue],
) -> None:
    """Pass 4 — Repeat-barline pairing check.

    Flags unpaired ``rptend`` and unclosed ``rptstart`` events.
    ``rptboth`` is treated as an ``rptend`` followed by an ``rptstart``.
    The first ``rptend`` (or ``rptboth``-as-close) is allowed to be
    unpaired.  Legacy ``@left="rptstart"`` is treated equivalently to
    ``@right="rptstart"``.

    Args:
        root: Document root element.
        warnings: Mutable list; pairing errors are appended here.
    """
    all_measures: list[lxml.etree._Element] = _xpath(root, "//mei:measure")
    open_stack: list[lxml.etree._Element] = []
    first_close_seen = False

    for measure in all_measures:
        right = measure.get("right", "")
        left = measure.get("left", "")
        xp = _xp(root, measure)

        # Open events
        if right == "rptstart" or left == "rptstart":
            open_stack.append(measure)

        # Close events
        if right in ("rptend", "rptboth"):
            if not first_close_seen:
                first_close_seen = True
                # First close is *allowed* to be unpaired — no warning if unpaired.
                # If a matching open IS present, consume it (it is paired).
                if open_stack:
                    open_stack.pop()
            elif open_stack:
                open_stack.pop()
            else:
                event = "rptboth (close)" if right == "rptboth" else "rptend"
                # Accepted (info), not actionable: an extra unpaired close beyond
                # the first is a benign artefact of written-out repeats /
                # multi-section movements (e.g. K331/ii).  The tool already
                # treats every rptend as a selection-neutral barline (ADR-025),
                # and mc coordinates are unaffected (ADR-015).
                warnings.append(
                    NormalizationIssue(
                        code="REPEAT_UNPAIRED_END",
                        message=(
                            f"Unpaired {event} at {xp}: no matching rptstart found. "
                            f"Accepted (written-out repeat / multi-section); mc is "
                            f"unaffected."
                        ),
                        severity="info",
                        xpath=xp,
                    )
                )

            # rptboth also opens a new section
            if right == "rptboth":
                open_stack.append(measure)

    # Any still-open sections at end of document are flagged — an rptstart with
    # no close is the riskier defect and stays actionable.
    for measure in open_stack:
        xp = _xp(root, measure)
        warnings.append(
            NormalizationIssue(
                code="REPEAT_UNCLOSED_START",
                message=(
                    f"Unclosed rptstart at {xp}: no matching rptend before end "
                    f"of document."
                ),
                severity="warning",
                xpath=xp,
            )
        )


def _split_increasing_runs(ints: list[int]) -> list[list[int]]:
    """Split *ints* into maximal strictly-increasing runs (document order).

    A new run starts whenever a value is not greater than its predecessor —
    i.e. wherever the measure numbering restarts or steps back.

    Args:
        ints: Integer ``@n`` values in document order.

    Returns:
        List of runs; each run is a strictly-increasing list of integers.
    """
    runs: list[list[int]] = []
    current: list[int] = []
    prev: int | None = None
    for n in ints:
        if prev is not None and n <= prev:
            runs.append(current)
            current = []
        current.append(n)
        prev = n
    if current:
        runs.append(current)
    return runs


def _is_multi_section_restart(ints: list[int]) -> bool:
    """True if *ints* is a multi-section / written-out-repeat numbering.

    Recognises the K331/ii pattern: the measure numbering restarts at 1 in
    each of two or more sections (e.g. a written-out da capo, or a
    Menuetto + Trio whose bar count restarts).  Such files legitimately
    carry duplicate ``@n`` outside ``<ending>`` — the duplication is
    explained entirely by the restart, and under ADR-015 the machine
    coordinate (mc) remains unique.

    The check is deliberately conservative: it requires every run to begin
    at 1 and be strictly increasing, so genuine duplicate-``@n`` defects
    (which do not restart cleanly at 1) still fall through to per-value
    warnings.

    Args:
        ints: Integer ``@n`` values in document order.

    Returns:
        ``True`` if the sequence is a clean multi-section restart with
        duplicates, ``False`` otherwise.
    """
    if len(ints) != len(set(ints)):  # there must be duplicates to explain
        runs = _split_increasing_runs(ints)
        return len(runs) >= 2 and all(run and run[0] == 1 for run in runs)
    return False


def _check_measure_n_outside_endings(
    root: lxml.etree._Element,
    warnings: list[NormalizationIssue],
) -> None:
    """Pass 5 — ``@n`` uniqueness outside ``<ending>`` elements.

    Flags missing ``@n``, non-integer ``@n``, duplicate ``@n``, and gaps
    greater than 10 in the sorted integer sequence.  No mutations are made.

    Two families are downgraded to ``info`` per the Component 9 Step 8 triage:
    DCML ``X``-prefixed values (accepted; mc keys correctly under ADR-015) and
    duplicate ``@n`` arising from a multi-section / written-out-repeat restart
    (collapsed into a single summary advisory rather than one per measure).

    Args:
        root: Document root element.
        warnings: Mutable list; findings are appended here.
    """
    bare_measures: list[lxml.etree._Element] = _xpath(
        root, "//mei:measure[not(ancestor::mei:ending)]"
    )

    ordered_ns: list[int] = []  # valid integers in document order
    for measure in bare_measures:
        n_str: str | None = measure.get("n")
        xp = _xp(root, measure)

        if n_str is None:
            warnings.append(
                NormalizationIssue(
                    code="MEASURE_N_MISSING",
                    message=f"<measure> outside <ending> at {xp} is missing @n.",
                    severity="warning",
                    xpath=xp,
                )
            )
            continue

        try:
            n_int = int(n_str)
        except ValueError:
            if _DCML_X_RE.match(n_str):
                # Accepted DCML/MuseScore X-prefixed @n (e.g. split-measure
                # complement at a repeat boundary).  mc keys correctly (ADR-015).
                warnings.append(
                    NormalizationIssue(
                        code="MEASURE_N_DCML_X",
                        message=(
                            f"<measure> outside <ending> at {xp} has DCML "
                            f"X-prefixed @n={n_str!r}. Accepted; machine "
                            f"coordinate (mc) is unaffected (ADR-015)."
                        ),
                        severity="info",
                        xpath=xp,
                    )
                )
            else:
                warnings.append(
                    NormalizationIssue(
                        code="MEASURE_N_NON_INTEGER",
                        message=(
                            f"<measure> outside <ending> at {xp} has non-integer "
                            f"@n={n_str!r}."
                        ),
                        severity="warning",
                        xpath=xp,
                    )
                )
            continue

        ordered_ns.append(n_int)

    # Duplicate handling.  A clean multi-section restart (K331/ii) is collapsed
    # into a single info advisory; any other duplicate shape stays actionable.
    if _is_multi_section_restart(ordered_ns):
        runs = _split_increasing_runs(ordered_ns)
        warnings.append(
            NormalizationIssue(
                code="MEASURE_N_MULTI_SECTION_DUPLICATE",
                message=(
                    f"Measure @n restarts across {len(runs)} sections "
                    f"(runs of length {[len(r) for r in runs]}); duplicate @n "
                    f"outside <ending> is expected for written-out repeats / "
                    f"multi-section movements. Machine coordinates (mc) remain "
                    f"unique (ADR-015)."
                ),
                severity="info",
            )
        )
    else:
        warned: set[int] = set()
        seen: set[int] = set()
        for n_int in ordered_ns:
            if n_int in seen and n_int not in warned:
                warnings.append(
                    NormalizationIssue(
                        code="MEASURE_N_DUPLICATE",
                        message=f"Duplicate @n={n_int} on <measure> outside <ending>.",
                        severity="warning",
                    )
                )
                warned.add(n_int)
            seen.add(n_int)

    # Flag gaps > 10 in the sorted sequence of distinct values.
    distinct_sorted = sorted(set(ordered_ns))
    if len(distinct_sorted) >= 2:
        for prev, curr in zip(distinct_sorted, distinct_sorted[1:]):
            gap = curr - prev
            if gap > 10:
                warnings.append(
                    NormalizationIssue(
                        code="MEASURE_N_GAP",
                        message=(
                            f"Gap of {gap} in measure @n sequence "
                            f"(from {prev} to {curr})."
                        ),
                        severity="warning",
                    )
                )


def _normalize_ending_measure_ns(
    root: lxml.etree._Element,
    changes_applied: list[str],
    warnings: list[NormalizationIssue],
) -> None:
    """Pass 6 — ``@n`` values inside ``<ending>`` elements.

    Strips alphabetic suffixes from suffix-style values (e.g. ``"12a"`` →
    ``"12"``).  Flags non-parseable non-integer values and duplicate ``@n``
    values within the same ``<ending>``.

    Args:
        root: Document root element.
        changes_applied: Mutable list; suffix-stripping is recorded here.
        warnings: Mutable list; non-parseable values and intra-ending
            duplicates are recorded here.
    """
    for ending in _xpath(root, "//mei:ending"):
        seen_in_ending: dict[int, bool] = {}

        for measure in ending.xpath("mei:measure", namespaces=_NSMAP):
            n_str: str = measure.get("n", "")
            xp = _xp(root, measure)

            # Strip alphabetic suffix if present (e.g. "12a" → "12").
            m = _SUFFIX_RE.match(n_str)
            if m:
                base = m.group(1)
                measure.set("n", base)
                changes_applied.append(
                    f"Stripped suffix from @n={n_str!r} → '{base}' "
                    f"on measure inside <ending> at {xp}."
                )
                n_str = base

            # Attempt integer parse.
            try:
                n_int = int(n_str)
            except ValueError:
                if _DCML_X_RE.match(n_str):
                    # Accepted DCML/MuseScore X-prefixed volta-ending bar.
                    # mc keys correctly (ADR-015); the integer base cannot be
                    # inferred reliably, so it is left untouched, not renumbered.
                    warnings.append(
                        NormalizationIssue(
                            code="ENDING_MEASURE_N_DCML_X",
                            message=(
                                f"<measure> inside <ending> at {xp} has DCML "
                                f"X-prefixed @n={n_str!r}. Accepted; machine "
                                f"coordinate (mc) is unaffected (ADR-015)."
                            ),
                            severity="info",
                            xpath=xp,
                        )
                    )
                else:
                    warnings.append(
                        NormalizationIssue(
                            code="ENDING_MEASURE_N_UNPARSEABLE",
                            message=(
                                f"Unparseable @n={n_str!r} on <measure> inside "
                                f"<ending> at {xp}."
                            ),
                            severity="warning",
                            xpath=xp,
                        )
                    )
                continue

            # Flag duplicate within this ending (cross-ending duplicates are fine).
            if n_int in seen_in_ending:
                if not seen_in_ending[n_int]:
                    warnings.append(
                        NormalizationIssue(
                            code="ENDING_MEASURE_N_DUPLICATE",
                            message=(
                                f"Duplicate @n={n_int} within same <ending> "
                                f"(first seen at {xp})."
                            ),
                            severity="warning",
                            xpath=xp,
                        )
                    )
                    seen_in_ending[n_int] = True
            else:
                seen_in_ending[n_int] = False


def _normalize_split_measures(
    root: lxml.etree._Element,
    changes_applied: list[str],
    warnings: list[NormalizationIssue],
) -> None:
    """Pass 7 — Incomplete measures at repeat boundaries.

    For each measure at an ``rptend``/``rptboth`` that carries
    ``@metcon="false"`` (the "close half" of a split bar), locates the
    complement measure (the first measure after the matching ``rptstart``
    or the start of the piece) and sets ``@metcon="false"`` on it if
    missing.  Flags cases where no complement can be identified.

    Also validates ``@join`` references: warns if an ``@join`` attribute
    points to a non-existent ``xml:id``.

    Args:
        root: Document root element.
        changes_applied: Mutable list; metcon corrections are recorded here.
        warnings: Mutable list; unresolvable complements and broken
            ``@join`` references are recorded here.
    """
    all_measures: list[lxml.etree._Element] = _xpath(root, "//mei:measure")
    if not all_measures:
        return

    pairs = _build_repeat_sections(all_measures)

    for open_idx, close_idx in pairs:
        close_measure = all_measures[close_idx]
        if close_measure.get("metcon") != "false":
            continue

        # Determine complement position.
        if open_idx is None:
            # First unpaired close: section goes back to beginning.
            # The complement is the very first measure of the document,
            # provided it precedes the close measure.
            if close_idx == 0:
                xp = _xp(root, close_measure)
                warnings.append(
                    NormalizationIssue(
                        code="SPLIT_MEASURE_NO_COMPLEMENT",
                        message=(
                            f"Split measure at {xp}: @metcon='false' on the first "
                            f"measure in the document — no complement can be "
                            f"identified."
                        ),
                        severity="warning",
                        xpath=xp,
                    )
                )
                continue
            complement = all_measures[0]
        else:
            # Paired close: complement is the first measure after the open.
            next_idx = open_idx + 1
            if next_idx >= len(all_measures):
                xp = _xp(root, close_measure)
                warnings.append(
                    NormalizationIssue(
                        code="SPLIT_MEASURE_NO_COMPLEMENT",
                        message=(
                            f"Split measure at {xp}: @metcon='false' but no measure "
                            f"follows the matching rptstart."
                        ),
                        severity="warning",
                        xpath=xp,
                    )
                )
                continue
            complement = all_measures[next_idx]

        if complement.get("metcon") != "false":
            complement.set("metcon", "false")
            xp_comp = _xp(root, complement)
            changes_applied.append(
                f"Set @metcon='false' on split-measure complement at {xp_comp}."
            )

    # Validate @join references.
    for measure in all_measures:
        join_ref: str | None = measure.get("join")
        if join_ref is not None:
            targets = root.xpath(
                "//*[@xml:id=$ref]",
                namespaces={"xml": "http://www.w3.org/XML/1998/namespace"},
                ref=join_ref,
            )
            if not targets:
                xp = _xp(root, measure)
                warnings.append(
                    NormalizationIssue(
                        code="JOIN_BROKEN_REFERENCE",
                        message=(
                            f"<measure> at {xp} has @join='{join_ref}' referencing "
                            f"non-existent xml:id."
                        ),
                        severity="warning",
                        xpath=xp,
                    )
                )


# ---------------------------------------------------------------------------
# Pass 8 — Spurious gestural accidentals
# ---------------------------------------------------------------------------

_XML_ID_KEY: str = "{http://www.w3.org/XML/1998/namespace}id"


def _key_sig_from_attr(val: str) -> dict[str, str]:
    """Convert a ``key.sig`` attribute value to a pitch-class → alteration map.

    Args:
        val: The ``key.sig`` value, e.g. ``"3s"``, ``"2f"``, ``"0"``.

    Returns:
        Dict mapping MEI pitch-class name to alteration string (``"s"`` or
        ``"f"``).  Returns an empty dict for ``"0"`` (C major / A minor),
        ``"none"``, ``"mixed"``, or unrecognised values.
    """
    if not val or val in ("0", "none", "mixed"):
        return {}
    m = re.match(r"^(\d+)(s|f)$", val)
    if not m:
        return {}
    count = int(m.group(1))
    alt = m.group(2)
    order = _SHARP_ORDER if alt == "s" else _FLAT_ORDER
    return {p: alt for p in order[:count]}


def _key_sig_from_element(keysig: lxml.etree._Element) -> dict[str, str]:
    """Parse a ``<keySig>`` element to a pitch-class → alteration map.

    Handles two MEI encodings:

    * **Shorthand** — ``<keySig sig="1s"/>`` (Verovio/MusicXML output); the
      ``@sig`` attribute is decoded the same way as ``key.sig`` on
      ``<scoreDef>``/``<staffDef>``.
    * **Explicit** — ``<keySig><keyAccid pname="f" accid="s"/>…</keySig>``
      (hand-encoded or MuseScore 4 export).

    Args:
        keysig: A ``<keySig>`` element.

    Returns:
        Dict mapping pitch-class name to alteration string.
    """
    sig_attr = keysig.get("sig")
    if sig_attr is not None:
        return _key_sig_from_attr(sig_attr)
    result: dict[str, str] = {}
    for ka in keysig.findall(f"{{{_MEI_NS}}}keyAccid"):
        pname = ka.get("pname", "")
        accid = ka.get("accid", "")
        if pname and accid:
            result[pname] = accid
    return result


def _read_elem_key_sig(elem: lxml.etree._Element) -> dict[str, str] | None:
    """Extract the key signature from a ``<scoreDef>`` or ``<staffDef>`` element.

    Checks the ``key.sig`` shorthand attribute first, then a ``<keySig>``
    child element (explicit form with ``<keyAccid>`` children).

    Args:
        elem: A ``<scoreDef>`` or ``<staffDef>`` element.

    Returns:
        Pitch-class → alteration dict if a key signature is present on this
        element, or ``None`` if the element carries no key signature information.
    """
    ks_attr = elem.get("key.sig")
    if ks_attr is not None:
        return _key_sig_from_attr(ks_attr)
    keysig_child = elem.find(f"{{{_MEI_NS}}}keySig")
    if keysig_child is not None:
        return _key_sig_from_element(keysig_child)
    return None


def _build_measure_key_sigs(
    root: lxml.etree._Element,
) -> dict[str, dict[str | None, dict[str, str]]]:
    """Pre-compute the active key signature at the start of each measure.

    Walks the document in element order, maintaining a global (``<scoreDef>``-
    level) and per-staff (``<staffDef n="X">``) key signature state.  When a
    ``<measure>`` element is first encountered, the current state is snapshotted
    and stored under the element's document XPath path (the only identifier that
    is stable across different lxml traversal methods).

    Each ``<scoreDef>`` is processed as a complete unit (global key + all
    descendant ``<staffDef>`` per-staff keys resolved together).  When a
    ``<scoreDef>`` declares a new global key without providing per-staff
    overrides for staves that were set by an earlier ``<staffDef>`` block,
    those stale per-staff entries are removed so the new global key takes
    effect — this is the K.331-mvt-3 fix: the initial ``<staffDef n="X">``
    elements carry ``<keySig sig="0"/>`` children that set per-staff entries,
    and mid-piece ``<scoreDef><keySig sig="3s"/></scoreDef>`` elements (global
    change, no per-staff children) must override them.

    Inline ``<staffDef>`` elements *inside* a ``<measure>`` appear after the
    measure open-tag in document order and are therefore reflected in the
    snapshot for the *next* measure.  The caller applies such inline overrides
    to the current measure's notes explicitly after retrieving the snapshot.

    Args:
        root: Document root element.

    Returns:
        Dict mapping each measure's XPath path to a snapshot dict of the form
        ``{None: global_ks, "1": staff1_ks, …}`` where ``None`` is the global
        default and per-staff entries override it.
    """
    tree = root.getroottree()
    global_ks: dict[str, str] = {}
    staff_ks: dict[str, dict[str, str]] = {}
    # id() values of <staffDef> elements already consumed while processing their
    # parent <scoreDef> as a unit — skip them when the main loop reaches them.
    consumed_staffdefs: set[int] = set()
    result: dict[str, dict[str | None, dict[str, str]]] = {}

    for elem in root.iter():
        tag = elem.tag
        if tag == f"{{{_MEI_NS}}}scoreDef":
            # Process the entire scoreDef as a unit so that a global key change
            # (via key.sig attribute or <keySig> child on the scoreDef itself)
            # correctly clears per-staff entries that were set by earlier staffDef
            # blocks.  Without this, initial <staffDef><keySig sig="0"/></staffDef>
            # entries shadow every subsequent global key change for those staves.
            global_ks_new = _read_elem_key_sig(elem)

            # Collect per-staff key updates from all descendant staffDef elements,
            # marking them consumed so the main loop does not double-process them.
            staff_updates: dict[str, dict[str, str]] = {}
            for staffdef in elem.iter(f"{{{_MEI_NS}}}staffDef"):
                consumed_staffdefs.add(id(staffdef))
                n = staffdef.get("n")
                if n is not None:
                    ks = _read_elem_key_sig(staffdef)
                    if ks is not None:
                        staff_updates[n] = ks

            if global_ks_new is not None:
                global_ks = global_ks_new
                # Remove per-staff entries not explicitly overridden by this
                # scoreDef so they fall through to the new global key.
                for sn in list(staff_ks.keys()):
                    if sn not in staff_updates:
                        del staff_ks[sn]

            staff_ks.update(staff_updates)

        elif tag == f"{{{_MEI_NS}}}staffDef":
            # Skip staffDef elements already consumed during scoreDef processing.
            if id(elem) in consumed_staffdefs:
                continue
            n = elem.get("n")
            if n is not None:
                ks = _read_elem_key_sig(elem)
                if ks is not None:
                    staff_ks[n] = ks

        elif tag == f"{{{_MEI_NS}}}measure":
            snap: dict[str | None, dict[str, str]] = {None: dict(global_ks)}
            for sn, ks in staff_ks.items():
                snap[sn] = dict(ks)
            result[tree.getpath(elem)] = snap

    return result


# ---------------------------------------------------------------------------
# Cross-barline tie completion
# ---------------------------------------------------------------------------


def _note_alteration(note: lxml.etree._Element) -> str | None:
    """Return the chromatic alteration carried by *note*, or ``None``.

    Reads the note's ``<accid>`` child, preferring the notated ``@accid`` over
    the gestural ``accid.ges``.  Returns ``None`` when the note has no accidental
    child or the child carries neither attribute (a natural in context).

    Args:
        note: An MEI ``<note>`` element.

    Returns:
        The alteration token (e.g. ``"f"``, ``"s"``, ``"n"``) or ``None``.
    """
    accid_el = note.find(f"{{{_MEI_NS}}}accid")
    if accid_el is None:
        return None
    if "accid" in accid_el.attrib:
        return accid_el.get("accid")
    if "accid.ges" in accid_el.attrib:
        return accid_el.get("accid.ges")
    return None


def _build_tie_targets(root: lxml.etree._Element) -> dict[str, str]:
    """Map each completed tie's continuation-note id to its expected alteration.

    Considers only ``<tie>`` elements carrying both ``@startid`` and ``@endid``
    whose start note has an explicit or gestural alteration.  Used by pass 9 to
    treat a tied continuation's ``accid.ges`` as legitimate carry (ADR-026).

    Args:
        root: Document root element.

    Returns:
        Mapping of ``@endid`` target ``xml:id`` → alteration token.
    """
    note_by_id: dict[str, lxml.etree._Element] = {}
    for note in _xpath(root, "//mei:note"):
        nid = note.get(_XML_ID_KEY)
        if nid:
            note_by_id[nid] = note

    targets: dict[str, str] = {}
    for tie in _xpath(root, "//mei:tie"):
        start_ref = tie.get("startid")
        end_ref = tie.get("endid")
        if not start_ref or not end_ref:
            continue
        start = note_by_id.get(start_ref.lstrip("#"))
        if start is None:
            continue
        alt = _note_alteration(start)
        if alt is not None:
            targets[end_ref.lstrip("#")] = alt
    return targets


def _find_continuation_note(
    measure: lxml.etree._Element,
    staff_n: str,
    layer_n: str,
    pname: str,
    oct_: str,
) -> lxml.etree._Element | None:
    """Return the first ``(pname, oct)`` note in *measure*'s matching staff/layer.

    Searches the staff with ``@n == staff_n`` and the layer with
    ``@n == layer_n`` in document order, which (for a cross-barline tie) is the
    note the tie continues into.

    Args:
        measure: The ``<measure>`` to search (the one following the tie start).
        staff_n: Target ``@n`` of the containing ``<staff>``.
        layer_n: Target ``@n`` of the containing ``<layer>``.
        pname: Pitch name to match.
        oct_: Octave to match.

    Returns:
        The first matching ``<note>`` element, or ``None``.
    """
    for staff in measure.findall(f"{{{_MEI_NS}}}staff"):
        if staff.get("n", "") != staff_n:
            continue
        for layer in staff.findall(f"{{{_MEI_NS}}}layer"):
            if layer.get("n", "") != layer_n:
                continue
            for note in layer.findall(f".//{{{_MEI_NS}}}note"):
                if note.get("pname", "") == pname and note.get("oct", "") == oct_:
                    return note
    return None


def _complete_cross_barline_ties(
    root: lxml.etree._Element,
    changes_applied: list[str],
    warnings: list[NormalizationIssue],
) -> None:
    """Pass 8 — Complete endpoint-less cross-barline ties (ADR-026).

    The MuseScore-to-MEI converter sometimes emits a ``<tie>`` with a
    ``@startid`` but no ``@endid`` (and no ``@tstamp2``).  Verovio cannot render
    such an endpoint-less tie, so the tie disappears; the continuation note —
    written without a fresh ``@accid`` because it relied on the tie to carry the
    pitch — then renders with the default (often wrong) accidental.

    For each such tie this pass resolves the continuation note as the first
    same-``(pname, oct)`` note in the *following* measure's matching
    ``staff``/``layer`` (the legitimate cross-barline target), sets ``@endid``
    accordingly, and — when the start note carries an alteration and the
    continuation note carries none — adds ``accid.ges`` to the continuation so
    its sounding pitch and MIDI match the tie's origin (no notated accidental is
    added, matching the original engraving).

    Ties that already carry ``@endid``/``@tstamp2`` are left untouched, making
    the pass idempotent.  When no continuation note can be located in the
    following measure, the tie is left untouched and a warning is recorded
    rather than fabricating an endpoint.  Runs before the accidental pass so the
    completed ties inform its tie-continuation rule.

    Args:
        root: Document root element.
        changes_applied: Mutable list; completions are appended here.
        warnings: Mutable list; unresolved ties are appended here.
    """
    measures = _xpath(root, "//mei:measure")

    # Index every note by xml:id → (measure index, staff @n, layer @n, element).
    note_index: dict[str, tuple[int, str, str, lxml.etree._Element]] = {}
    for m_idx, measure in enumerate(measures):
        for staff in measure.findall(f"{{{_MEI_NS}}}staff"):
            staff_n = staff.get("n", "")
            for layer in staff.findall(f"{{{_MEI_NS}}}layer"):
                layer_n = layer.get("n", "")
                for note in layer.findall(f".//{{{_MEI_NS}}}note"):
                    nid = note.get(_XML_ID_KEY)
                    if nid:
                        note_index[nid] = (m_idx, staff_n, layer_n, note)

    for tie in _xpath(root, "//mei:tie"):
        if tie.get("endid") or tie.get("tstamp2"):
            continue
        start_ref = tie.get("startid")
        if not start_ref:
            continue
        tie_id = tie.get(_XML_ID_KEY, "?")
        sid = start_ref.lstrip("#")
        info = note_index.get(sid)
        if info is None:
            warnings.append(
                NormalizationIssue(
                    code="TIE_UNRESOLVED",
                    message=(
                        f"Endpoint-less tie (xml:id={tie_id!r}) references unknown "
                        f"start note {start_ref!r}; left unresolved."
                    ),
                    severity="warning",
                )
            )
            continue

        m_idx, staff_n, layer_n, start_note = info
        pname = start_note.get("pname", "")
        oct_ = start_note.get("oct", "")
        if m_idx + 1 >= len(measures):
            warnings.append(
                NormalizationIssue(
                    code="TIE_UNRESOLVED",
                    message=(
                        f"Endpoint-less tie (xml:id={tie_id!r}) on {pname}{oct_} has "
                        f"no following measure to continue into; left unresolved."
                    ),
                    severity="warning",
                )
            )
            continue

        next_measure = measures[m_idx + 1]
        target = _find_continuation_note(next_measure, staff_n, layer_n, pname, oct_)
        target_id = target.get(_XML_ID_KEY) if target is not None else None
        if target is None or not target_id:
            warnings.append(
                NormalizationIssue(
                    code="TIE_UNRESOLVED",
                    message=(
                        f"Endpoint-less tie (xml:id={tie_id!r}) on {pname}{oct_} "
                        f"(staff {staff_n}, layer {layer_n}): no continuation note "
                        f"found in measure {next_measure.get('n', '?')}; left "
                        f"unresolved."
                    ),
                    severity="warning",
                )
            )
            continue

        tie.set("endid", f"#{target_id}")
        msg = (
            f"Completed cross-barline tie (xml:id={tie_id!r}) on {pname}{oct_}: "
            f"endid -> {target_id!r} in measure {next_measure.get('n', '?')}"
        )

        # Preserve the continuation note's pitch: a tied note inheriting an
        # altered pitch must carry accid.ges if it has no notated accidental.
        alteration = _note_alteration(start_note)
        if alteration is not None:
            t_accid = target.find(f"{{{_MEI_NS}}}accid")
            if t_accid is None:
                t_accid = lxml.etree.SubElement(target, f"{{{_MEI_NS}}}accid")
            if "accid" not in t_accid.attrib and "accid.ges" not in t_accid.attrib:
                t_accid.set("accid.ges", alteration)
                msg += f"; added accid.ges={alteration!r} to continuation note"

        changes_applied.append(msg)


# ---------------------------------------------------------------------------
# Spurious gestural accidentals
# ---------------------------------------------------------------------------


def _strip_spurious_gestural_accidentals(
    root: lxml.etree._Element,
    changes_applied: list[str],
) -> None:
    """Pass 9 — Strip spurious gestural accidentals from MEI conversion artefacts.

    The MuseScore-to-MEI converter incorrectly propagates accidentals across
    staves: a treble-staff explicit accidental (``@accid``) sometimes causes
    the converter to mark same-pitch-class notes in other staves or later in
    the same staff with ``accid.ges`` (and often ``glyph.auth="smufl"``) but
    no ``@accid``, making MIDI play the wrong chromatic pitch while SVG display
    remains correct.

    **Algorithm** (ADR-022, supersedes ADR-021): a ``<accid>`` element with
    ``accid.ges`` set and ``@accid`` absent is *legitimate* when the gestural
    alteration is explained by *any* of three sources:

    1. **Active key signature** — the staff's key signature at this position
       alters this pitch class (e.g. F# in G major).  The key sig is read from
       ``key.sig`` attributes and ``<keySig>/<keyAccid>`` children on
       ``<scoreDef>`` and ``<staffDef>`` elements, with per-staff values
       overriding the global default.
    2. **Within-staff/measure/octave carry** — the same ``(pname, oct)`` in this
       staff already carries an explicit ``@accid`` earlier in the same measure.
    3. **Tie continuation** — the note is the ``@endid`` target of a ``<tie>``
       whose start note carries the same alteration (ADR-026).  A tied
       continuation inherits its predecessor's pitch and is written without a
       fresh ``@accid``; its ``accid.ges`` must not be stripped or the pitch
       would change.  This includes the gestural accidental added by pass 8.

    Within-staff carry takes precedence over the key signature (a natural sign
    written in the measure overrides the key-sig alteration for its octave).

    If ``accid.ges`` is present but its value does *not* match the expected
    alteration from either source, the element is flagged as a mismatch and
    stripped.  Any other ``accid.ges`` without an explaining source is stripped
    as spurious.

    ``glyph.auth="smufl"`` is recorded in ``changes_applied`` as diagnostic
    evidence when present, but is *not* used to trigger the pass — the decision
    is driven entirely by key-signature and carry logic.

    Args:
        root: Document root element.
        changes_applied: Mutable list; stripped elements are recorded here.
    """
    key_sig_index = _build_measure_key_sigs(root)
    tie_targets = _build_tie_targets(root)
    tree = root.getroottree()

    for measure in _xpath(root, "//mei:measure"):
        m_n = measure.get("n", "?")

        # Start from the pre-computed snapshot for this measure.
        raw_snap = key_sig_index.get(tree.getpath(measure), {None: {}})
        ks_by_staff: dict[str | None, dict[str, str]] = {
            k: dict(v) for k, v in raw_snap.items()
        }

        # Apply inline <staffDef> key-sig changes inside this measure.  The
        # pre-pass snapshots state *before* these elements are visited, so they
        # would otherwise only take effect for the next measure.
        for staffdef in measure.findall(f"{{{_MEI_NS}}}staffDef"):
            n = staffdef.get("n")
            if n is not None:
                ks = _read_elem_key_sig(staffdef)
                if ks is not None:
                    ks_by_staff[n] = ks
        for scoredef in measure.findall(f"{{{_MEI_NS}}}scoreDef"):
            ks = _read_elem_key_sig(scoredef)
            if ks is not None:
                ks_by_staff[None] = ks

        for staff in measure.findall(f"{{{_MEI_NS}}}staff"):
            staff_n = staff.get("n", "?")
            # Resolve active key sig: per-staff entry overrides global default.
            if staff_n in ks_by_staff:
                active_ks = ks_by_staff[staff_n]
            else:
                active_ks = ks_by_staff.get(None, {})

            # Track (pname, oct) → alteration for within-staff/measure carry.
            explicit: dict[tuple[str, str], str] = {}

            for note in staff.findall(f".//{{{_MEI_NS}}}note"):
                pname = note.get("pname", "")
                oct_ = note.get("oct", "")
                accid_el = note.find(f"{{{_MEI_NS}}}accid")
                if accid_el is None:
                    continue

                has_accid = "accid" in accid_el.attrib
                has_ges = "accid.ges" in accid_el.attrib

                if has_accid:
                    # Correctly notated accidental — record for carry; do not touch.
                    explicit[(pname, oct_)] = accid_el.get("accid", "")
                elif has_ges:
                    ges_val = accid_el.get("accid.ges", "")
                    carry_expected = explicit.get((pname, oct_))
                    key_expected = active_ks.get(pname)
                    note_id = note.get(_XML_ID_KEY, "?")
                    glyph = accid_el.get("glyph.auth", "")
                    glyph_note = f" (glyph.auth={glyph!r})" if glyph else ""

                    if tie_targets.get(note_id) == ges_val:
                        # Tie continuation inherits its predecessor's pitch
                        # (ADR-026) — legitimate; do not touch.
                        continue
                    if carry_expected is not None:
                        # Within-staff carry takes precedence over key sig.
                        if carry_expected == ges_val:
                            pass  # Legitimate carry — do not touch.
                        else:
                            # Carry value mismatches accid.ges — converter noise.
                            changes_applied.append(
                                f"Measure {m_n}, staff {staff_n}: stripped "
                                f"mismatched accid.ges='{ges_val}' from "
                                f"{pname}{oct_} — within-staff carry expects "
                                f"'{carry_expected}'{glyph_note} "
                                f"(note xml:id={note_id!r}); auditing recommended."
                            )
                            accid_el.attrib.pop("accid.ges")
                            accid_el.attrib.pop("glyph.auth", None)
                    elif key_expected is not None:
                        if key_expected == ges_val:
                            pass  # Legitimate key-signature carry — do not touch.
                        else:
                            # Key sig implies a different alteration — converter noise.
                            changes_applied.append(
                                f"Measure {m_n}, staff {staff_n}: stripped "
                                f"mismatched accid.ges='{ges_val}' from "
                                f"{pname}{oct_} — key signature expects "
                                f"'{key_expected}'{glyph_note} "
                                f"(note xml:id={note_id!r}); auditing recommended."
                            )
                            accid_el.attrib.pop("accid.ges")
                            accid_el.attrib.pop("glyph.auth", None)
                    else:
                        # No key-sig or carry explanation — spurious; strip.
                        changes_applied.append(
                            f"Measure {m_n}, staff {staff_n}: stripped spurious "
                            f"accid.ges='{ges_val}' from {pname}{oct_} "
                            f"(note xml:id={note_id!r}){glyph_note}; no "
                            f"key-signature or within-staff/measure cause found."
                        )
                        accid_el.attrib.pop("accid.ges")
                        accid_el.attrib.pop("glyph.auth", None)


# ---------------------------------------------------------------------------
# Clef sameas resolution
# ---------------------------------------------------------------------------


def _resolve_clef_sameas(
    root: lxml.etree._Element,
    changes_applied: list[str],
) -> None:
    """Pass 10 — Resolve ``<clef sameas="#id">`` references to explicit shape/line.

    The MuseScore-to-MEI converter emits per-voice clef restatements as
    ``<clef sameas="#other"/>`` carrying no ``shape``/``line`` of their own.
    Verovio 6.1.0 does not resolve the reference and renders an empty clef group
    (no glyph).  This pass copies the referenced clef's ``shape``/``line`` (and any
    octave displacement) onto the referring clef and removes ``@sameas`` so the
    clef is self-describing and renders.

    Only clefs whose ``@sameas`` target resolves to a clef with explicit
    ``shape``/``line`` are rewritten; anything unresolved is left untouched.  The
    pass is idempotent: a resolved clef no longer carries ``@sameas``.

    Args:
        root: The MEI document root element.
        changes_applied: Accumulator for human-readable change descriptions.
    """
    by_id: dict[str, lxml.etree._Element] = {}
    for clef in _xpath(root, "//mei:clef"):
        cid = clef.get(f"{{{_XML_NS}}}id")
        if cid:
            by_id[cid] = clef

    for clef in _xpath(root, "//mei:clef[@sameas]"):
        if clef.get("shape") and clef.get("line"):
            continue
        target = by_id.get(clef.get("sameas", "").lstrip("#"))
        if target is None or not target.get("shape") or not target.get("line"):
            continue
        clef.set("shape", target.get("shape"))
        clef.set("line", target.get("line"))
        for opt in ("dis", "dis.place"):
            if target.get(opt):
                clef.set(opt, target.get(opt))
        del clef.attrib["sameas"]
        changes_applied.append(
            f"Resolved clef sameas reference (xml:id="
            f"{clef.get(f'{{{_XML_NS}}}id', '?')!r}) -> "
            f"shape={target.get('shape')} line={target.get('line')}"
        )


# ---------------------------------------------------------------------------
# Duration metadata
# ---------------------------------------------------------------------------


def _compute_duration_bars(root: lxml.etree._Element) -> int:
    """Return the maximum integer ``@n`` found across all ``<measure>`` elements.

    Pickup bars (``@n="0"``) are naturally excluded as the minimum.  Both
    plain measures and measures inside ``<ending>`` elements are considered,
    because pieces frequently end inside a final or second ending.

    Args:
        root: Document root element.

    Returns:
        Maximum integer ``@n`` value, or ``0`` if no parseable values exist.
    """
    max_n = 0
    for measure in _xpath(root, "//mei:measure"):
        n_str = measure.get("n", "")
        # Also strip suffix if still present (pass 6 may not have run yet in
        # tests; we take the integer base for robustness).
        suffix_m = _SUFFIX_RE.match(n_str)
        if suffix_m:
            n_str = suffix_m.group(1)
        try:
            n_int = int(n_str)
            if n_int > max_n:
                max_n = n_int
        except ValueError:
            pass
    return max_n


# ---------------------------------------------------------------------------
# Public interface
# ---------------------------------------------------------------------------


def normalize_mei(source_path: str, output_path: str) -> NormalizationReport:
    """Read *source_path*, apply all normalization rules, write *output_path*.

    Normalization is idempotent: running this function on an already-
    normalized file produces byte-identical output and returns a report
    with ``is_clean=True`` and no entries in ``changes_applied``.

    The original source file is never modified; callers are responsible for
    copying it to the ``originals/`` prefix before calling this function.

    Args:
        source_path: Path to the MEI file to normalize.
        output_path: Destination path for the normalized MEI file.  May be
            the same as *source_path* (in-place normalization).

    Returns:
        A :class:`~models.normalization.NormalizationReport` describing
        auto-corrections and warnings.

    Raises:
        lxml.etree.XMLSyntaxError: If the source file is not well-formed XML.
        FileNotFoundError: If *source_path* does not exist.
    """
    tree = lxml.etree.parse(source_path)
    root = tree.getroot()

    changes_applied: list[str] = []
    warnings: list[NormalizationIssue] = []

    _normalize_pickup_bar(root, changes_applied)
    _propagate_meter_changes(root, changes_applied)
    _normalize_ending_ns(root, changes_applied, warnings)
    _check_repeat_barlines(root, warnings)
    _check_measure_n_outside_endings(root, warnings)
    _normalize_ending_measure_ns(root, changes_applied, warnings)
    _normalize_split_measures(root, changes_applied, warnings)
    _complete_cross_barline_ties(root, changes_applied, warnings)
    _strip_spurious_gestural_accidentals(root, changes_applied)
    _resolve_clef_sameas(root, changes_applied)

    duration_bars = _compute_duration_bars(root)

    # Write output.  pretty_print=False is critical for idempotence: lxml
    # preserves original whitespace text nodes and does not reformat.
    tree.write(
        output_path,
        xml_declaration=True,
        encoding="UTF-8",
        pretty_print=False,
    )

    return NormalizationReport(
        changes_applied=changes_applied,
        warnings=warnings,
        duration_bars=duration_bars,
    )
