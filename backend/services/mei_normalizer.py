"""MEI normalization pipeline.

Applies seven structural normalization passes to an MEI file, writing the
result to ``output_path`` and returning a :class:`~models.normalization.NormalizationReport`.

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

Normalization is **idempotent**: running the normalizer on an already-
normalized file produces byte-identical output and an
:attr:`~models.normalization.NormalizationReport.is_clean` report.

The normalizer never touches musical content (pitches, durations, dynamics),
``xml:id`` values, or encoding style.

Example usage::

    from services.mei_normalizer import normalize_mei

    report = normalize_mei("movement-1.mei", "/tmp/movement-1-norm.mei")
    if not report.is_clean:
        for w in report.warnings:
            print("WARNING:", w)
    print("Duration (bars):", report.duration_bars)
"""

from __future__ import annotations

import re

import lxml.etree
from models.normalization import NormalizationReport

# ---------------------------------------------------------------------------
# MEI namespace
# ---------------------------------------------------------------------------

_MEI_NS: str = "http://www.music-encoding.org/ns/mei"
_NSMAP: dict[str, str] = {"mei": _MEI_NS}

# Regex for suffix-style @n values inside <ending> elements, e.g. "12a", "12b".
_SUFFIX_RE: re.Pattern[str] = re.compile(r"^(\d+)[a-zA-Z]+$")


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
    warnings: list[str],
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
                f"<ending n='{ending.get('n', '?')}'> contains zero "
                f"<measure> elements."
            )

    # Flag non-sequential ending numbers.
    numbered: list[int] = []
    for ending in endings:
        try:
            numbered.append(int(ending.get("n", "")))
        except ValueError:
            pass  # non-integer @n on ending — leave for upstream handling
    if numbered:
        expected = list(range(1, len(numbered) + 1))
        if sorted(numbered) != expected:
            warnings.append(
                f"<ending> @n values are not sequential: "
                f"{sorted(numbered)} (expected {expected})."
            )

    # Flag sections with only one ending.
    if len(endings) == 1:
        warnings.append(
            "<section> has only one <ending>; second ending appears to be missing."
        )


def _check_repeat_barlines(
    root: lxml.etree._Element,
    warnings: list[str],
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
                warnings.append(
                    f"Unpaired {event} at {xp}: no matching rptstart found."
                )

            # rptboth also opens a new section
            if right == "rptboth":
                open_stack.append(measure)

    # Any still-open sections at end of document are flagged.
    for measure in open_stack:
        xp = _xp(root, measure)
        warnings.append(
            f"Unclosed rptstart at {xp}: no matching rptend before end of document."
        )


def _check_measure_n_outside_endings(
    root: lxml.etree._Element,
    warnings: list[str],
) -> None:
    """Pass 5 — ``@n`` uniqueness outside ``<ending>`` elements.

    Flags duplicate ``@n`` values, non-integer ``@n`` values, and gaps
    greater than 10 in the sorted integer sequence.  No mutations are made.

    Args:
        root: Document root element.
        warnings: Mutable list; findings are appended here.
    """
    bare_measures: list[lxml.etree._Element] = _xpath(
        root, "//mei:measure[not(ancestor::mei:ending)]"
    )

    valid_ns: list[int] = []
    seen_ns: dict[int, bool] = {}  # n -> already_warned_duplicate

    for measure in bare_measures:
        n_str: str | None = measure.get("n")
        xp = _xp(root, measure)

        if n_str is None:
            warnings.append(f"<measure> outside <ending> at {xp} is missing @n.")
            continue

        try:
            n_int = int(n_str)
        except ValueError:
            warnings.append(
                f"<measure> outside <ending> at {xp} has non-integer " f"@n={n_str!r}."
            )
            continue

        if n_int in seen_ns:
            if not seen_ns[n_int]:
                # Warn once per duplicate value.
                warnings.append(f"Duplicate @n={n_int} on <measure> outside <ending>.")
                seen_ns[n_int] = True
        else:
            seen_ns[n_int] = False
            valid_ns.append(n_int)

    # Flag gaps > 10 in the sorted sequence.
    if len(valid_ns) >= 2:
        sorted_ns = sorted(valid_ns)
        for prev, curr in zip(sorted_ns, sorted_ns[1:]):
            gap = curr - prev
            if gap > 10:
                warnings.append(
                    f"Gap of {gap} in measure @n sequence (from {prev} to {curr})."
                )


def _normalize_ending_measure_ns(
    root: lxml.etree._Element,
    changes_applied: list[str],
    warnings: list[str],
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
                warnings.append(
                    f"Unparseable @n={n_str!r} on <measure> inside "
                    f"<ending> at {xp}."
                )
                continue

            # Flag duplicate within this ending (cross-ending duplicates are fine).
            if n_int in seen_in_ending:
                if not seen_in_ending[n_int]:
                    warnings.append(
                        f"Duplicate @n={n_int} within same <ending> "
                        f"(first seen at {xp})."
                    )
                    seen_in_ending[n_int] = True
            else:
                seen_in_ending[n_int] = False


def _normalize_split_measures(
    root: lxml.etree._Element,
    changes_applied: list[str],
    warnings: list[str],
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
                    f"Split measure at {xp}: @metcon='false' on the first "
                    f"measure in the document — no complement can be identified."
                )
                continue
            complement = all_measures[0]
        else:
            # Paired close: complement is the first measure after the open.
            next_idx = open_idx + 1
            if next_idx >= len(all_measures):
                xp = _xp(root, close_measure)
                warnings.append(
                    f"Split measure at {xp}: @metcon='false' but no measure "
                    f"follows the matching rptstart."
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
                    f"<measure> at {xp} has @join='{join_ref}' referencing "
                    f"non-existent xml:id."
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
    warnings: list[str] = []

    _normalize_pickup_bar(root, changes_applied)
    _propagate_meter_changes(root, changes_applied)
    _normalize_ending_ns(root, changes_applied, warnings)
    _check_repeat_barlines(root, warnings)
    _check_measure_n_outside_endings(root, warnings)
    _normalize_ending_measure_ns(root, changes_applied, warnings)
    _normalize_split_measures(root, changes_applied, warnings)

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
