"""Reading time signatures out of an MEI document.

The meter is a property of the notation, so the MEI is its only authority. It was
also carried by hand in the corpus TOML manifests, and 21 of 54 movements
disagreed with their own score (Track M18) — including two that had fragments, so
76 fragments displayed a meter their notation never had. Nothing hand-carries it
now; everything reads it from here.

Contrast ``key_signature``, which is *not* derivable: MEI records
``<keySig sig="4f"/>`` with no mode, and that is A-flat major and F minor alike.
Key stays curated for exactly that reason (Component 11 Step 10). Meter does not.

Two questions are answered separately because they have different answers in a
movement whose meter changes:

- :func:`starting_meter` — what the movement is *in*, for its metadata record.
- :func:`meter_at_mc` — what is in force at one measure, for a fragment that sits
  there. Two of the 54 movements change meter mid-piece (K331/i at mc 110,
  K284/iii at mc 247), so for most of the corpus these coincide — but a fragment
  after the change must not be labelled with the movement's opening meter.

References: ADR-015 (mc as document-order position), mei-ingest-normalization.md
§2 (the normalizer's ``<meterSig>`` insertion).
"""

from __future__ import annotations

import lxml.etree

_MEI_NS = "http://www.music-encoding.org/ns/mei"


def _localname(el: lxml.etree._Element) -> str:
    """Tag name without its namespace, lowercased."""
    tag = el.tag
    if not isinstance(tag, str):
        return ""
    return tag.rsplit("}", 1)[-1].lower()


def _declared_meter(el: lxml.etree._Element) -> str | None:
    """The meter this element declares as ``"count/unit"``, or None.

    Handles both spellings: ``@meter.count``/``@meter.unit`` on ``<scoreDef>`` and
    ``<staffDef>``, and ``@count``/``@unit`` on ``<meterSig>``.
    """
    name = _localname(el)
    if name in ("scoredef", "staffdef"):
        count, unit = el.get("meter.count"), el.get("meter.unit")
    elif name == "metersig":
        count, unit = el.get("count"), el.get("unit")
    else:
        return None
    if not count or not unit:
        return None
    if not (count.isdigit() and unit.isdigit()):
        return None
    if int(count) <= 0 or int(unit) <= 0:
        return None
    return f"{int(count)}/{int(unit)}"


def _inside_measure(el: lxml.etree._Element) -> bool:
    """True when the element sits within a ``<measure>``."""
    for ancestor in el.iterancestors():
        if _localname(ancestor) == "measure":
            return True
    return False


def meter_timeline(xml: bytes | str) -> list[tuple[int, str]]:
    """Every meter in the document, each with the ``mc`` it takes effect at.

    ``mc`` is the 1-based document-order measure index of ADR-015. A declaration
    *inside* a measure takes effect at that measure; one *between* measures (a
    section-level ``<scoreDef>``) takes effect at the next. Consecutive
    declarations of the same meter — the normalizer restates them freely — collapse
    to one entry.

    Args:
        xml: MEI document, as bytes or text.

    Returns:
        ``[(mc, "count/unit"), …]`` ascending by mc, empty when the document
        declares no meter at all. The first entry is the opening meter, at mc 1.
    """
    data = xml.encode("utf-8") if isinstance(xml, str) else xml
    try:
        root = lxml.etree.fromstring(data)
    except lxml.etree.XMLSyntaxError:
        return []

    timeline: list[tuple[int, str]] = []
    mc = 0
    for el in root.iter():
        if _localname(el) == "measure":
            mc += 1
            continue
        sig = _declared_meter(el)
        if sig is None:
            continue
        # A declaration before the first measure is the opening meter.
        effective = mc if (mc and _inside_measure(el)) else mc + 1
        if timeline and timeline[-1][1] == sig:
            continue
        if timeline and timeline[-1][0] == effective:
            timeline[-1] = (effective, sig)  # same measure, later wins
            continue
        timeline.append((effective, sig))
    return timeline


def starting_meter(xml: bytes | str) -> str | None:
    """The meter the movement opens in, e.g. ``"3/4"``; None if none is declared.

    This is the value that belongs on the movement record — "what is this piece
    in?" — regardless of any later change.
    """
    timeline = meter_timeline(xml)
    return timeline[0][1] if timeline else None


def meter_at_mc(xml: bytes | str, mc: int) -> str | None:
    """The meter in force at measure ``mc`` (1-based document order).

    This is the value that belongs on a *fragment*, which sits at one place in the
    movement rather than standing for the whole of it.

    Args:
        xml: MEI document.
        mc: 1-based document-order measure index (ADR-015).

    Returns:
        The meter in force there, or None when the document declares none.
    """
    current: str | None = None
    for effective, sig in meter_timeline(xml):
        if effective > mc:
            break
        current = sig
    return current
