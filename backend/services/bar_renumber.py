"""Editorial restarts of a movement's notated bar numbering (§ 9G, Track M1).

Some movements are numbered in two independent runs by their edition — a Menuetto
and its Menuetto II each counting from 1 — where the DCML encoding numbers them
continuously. K282/ii is the case in the corpus: the NMA restarts at Menuetto II,
DCML runs 0–72 straight through, so our bar labels disagree with the edition a
reader has open.

**Only ``@n`` and the harmony ``mn`` move. ``mc`` never does.** mc is the
document-order position index of ADR-015 and the join key everything mechanical
uses — rendering, fragment ranges, previews, the mc-stability check. That is what
makes an editorial renumbering safe to perform at all.

The declaration lives here rather than in the corpus TOML because two consumers
need it and only one of them reads the manifest: corpus prep applies it when the
MEI and harmonies TSV are built, and a data migration applies it to already-stored
movements. Sharing one plan builder is what keeps them from diverging.

Split measures keep their ``X`` form. A bar written across a repeat barline
appears as two measures — its first beats, then an ``X``-labelled complement
carrying the rest — and DCML gives the complement its partner's ``mn``. The
restart preserves that shape, renumbering the ``X`` counter alongside the bars, so
a complement still reports the bar it belongs to.

References: ADR-015, § 9G of the Component 11 plan, mei-ingest-normalization.md.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass

import lxml.etree


@dataclass(frozen=True)
class Restart:
    """One editorial restart of the bar count.

    Attributes:
        at_mc: 1-based document-order measure the new count begins at.
        first_number: The number that measure takes. ``0`` for a movement whose
            new section opens with an anacrusis, matching how an opening upbeat is
            numbered; ``1`` when the section starts on a complete bar.
    """

    at_mc: int
    first_number: int


#: Editorial declarations, keyed ``"{work_slug}/{movement_slug}"``.
#:
#: K282/ii — Menuetto I (mc 1–34, `@n` 0–32 with one split complement) then
#: Menuetto II from mc 35. Its upbeat is beat 3 of the shared bar 32, split across
#: the repeat barline; the NMA counts it as bar 0 of the new section, exactly as
#: Menuetto I's own one-beat anacrusis is bar 0 (decided with Francisco
#: 2026-07-27). So mc 35 becomes 0, mc 36–51 become 1–16, the complement at mc 52
#: becomes X1, and mc 53–76 become 17–40.
RESTARTS: dict[str, tuple[Restart, ...]] = {
    "k282/movement-2": (Restart(at_mc=35, first_number=0),),
}


def _localname(el: lxml.etree._Element) -> str:
    """Tag name without its namespace."""
    tag = el.tag
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _measures(root: lxml.etree._Element) -> list[lxml.etree._Element]:
    """Every ``<measure>`` in document order."""
    return [el for el in root.iter() if _localname(el) == "measure"]


def _is_complement(label: str | None) -> bool:
    """True for an ``X``-prefixed label — the tail of a split measure."""
    return bool(label) and label.strip().upper().startswith("X")  # type: ignore[arg-type]


def renumber_plan(
    xml: bytes | str,
    restarts: tuple[Restart, ...],
) -> dict[int, tuple[str, int]]:
    """Build the new numbering for every measure a restart affects.

    Walks measures in document order from each restart to the next (or to the end
    of the movement), assigning consecutive bar numbers and a fresh ``X`` counter
    for split-measure complements.

    Args:
        xml: The movement's MEI.
        restarts: Restarts to apply, in any order.

    Returns:
        ``{mc: (new_n, new_mn)}`` covering only the measures at or after the first
        restart; measures before it are absent and must be left untouched.
        ``new_n`` is the ``@n`` label (``"0"``, ``"17"``, ``"X1"``); ``new_mn`` is
        the number a harmony row at that measure should carry — for a complement,
        the bar it completes.
    """
    if not restarts:
        return {}
    data = xml.encode("utf-8") if isinstance(xml, str) else xml
    try:
        root = lxml.etree.fromstring(data)
    except lxml.etree.XMLSyntaxError:
        return {}

    measures = _measures(root)
    ordered = sorted(restarts, key=lambda r: r.at_mc)
    plan: dict[int, tuple[str, int]] = {}

    for i, restart in enumerate(ordered):
        stop = ordered[i + 1].at_mc if i + 1 < len(ordered) else len(measures) + 1
        number = restart.first_number
        x_counter = 1
        last_number = restart.first_number
        for mc in range(restart.at_mc, min(stop, len(measures) + 1)):
            current = measures[mc - 1].get("n")
            # The measure the restart lands on takes first_number outright, even
            # when it is currently a complement: an editorial restart is exactly
            # the claim that this measure begins a count of its own.
            if mc != restart.at_mc and _is_complement(current):
                plan[mc] = (f"X{x_counter}", last_number)
                x_counter += 1
                continue
            plan[mc] = (str(number), number)
            last_number = number
            number += 1
    return plan


def apply_to_mei(xml: bytes | str, plan: dict[int, tuple[str, int]]) -> bytes:
    """Return the MEI with ``@n`` rewritten per the plan.

    Only ``@n`` changes; every other byte of structure is preserved, so mc — being
    document position — is untouched by construction.

    Args:
        xml: The movement's MEI.
        plan: Output of :func:`renumber_plan`.

    Returns:
        The re-serialised document.
    """
    data = xml.encode("utf-8") if isinstance(xml, str) else xml
    root = lxml.etree.fromstring(data)
    for mc, measure in enumerate(_measures(root), start=1):
        entry = plan.get(mc)
        if entry is not None:
            measure.set("n", entry[0])
    return lxml.etree.tostring(
        root.getroottree(), xml_declaration=True, encoding="UTF-8"
    )


def apply_to_events(
    events: list[dict],
    plan: dict[int, tuple[str, int]],
) -> tuple[list[dict], int]:
    """Return harmony events with ``mn`` rewritten per the plan.

    Args:
        events: ``movement_analysis.events`` list; each event may carry ``mc``.
        plan: Output of :func:`renumber_plan`.

    Returns:
        ``(events, changed)`` — a new list, and how many events moved. Events
        with no ``mc``, or an ``mc`` the plan does not cover, pass through.
    """
    out: list[dict] = []
    changed = 0
    for event in events:
        mc = event.get("mc")
        entry = (
            plan.get(int(mc))
            if isinstance(mc, int | str) and str(mc).isdigit()
            else None
        )
        if entry is None or event.get("mn") == entry[1]:
            out.append(event)
            continue
        out.append({**event, "mn": entry[1]})
        changed += 1
    return out, changed


def apply_to_harmonies_tsv(tsv: str, plan: dict[int, tuple[str, int]]) -> str:
    """Return a DCML harmonies TSV with its ``mn`` column rewritten per the plan.

    Rows whose ``mc`` the plan does not cover, or which have no usable ``mc``, are
    passed through untouched. Column order and every other field are preserved.

    Args:
        tsv: The harmonies TSV text.
        plan: Output of :func:`renumber_plan`.

    Returns:
        The rewritten TSV text.
    """
    reader = csv.DictReader(io.StringIO(tsv), delimiter="\t")
    if reader.fieldnames is None:
        return tsv
    rows = []
    for row in reader:
        mc_raw = (row.get("mc") or "").strip()
        entry = plan.get(int(mc_raw)) if mc_raw.isdigit() else None
        if entry is not None and "mn" in row:
            row["mn"] = str(entry[1])
        rows.append(row)

    buf = io.StringIO()
    writer = csv.DictWriter(
        buf, fieldnames=reader.fieldnames, delimiter="\t", lineterminator="\n"
    )
    writer.writeheader()
    writer.writerows(rows)
    return buf.getvalue()
