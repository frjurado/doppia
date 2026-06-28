# ADR-030 — Deterministic MEI `xml:id`s (corpus-prep checksum seeding)

**Date:** 2026-06-29
**Status:** Accepted — implemented
**Related:** ADR-027 (corrections overlay, Pass 0 — depends on this), ADR-014 (original MEI retention), ADR-009 (DCML licensing), ADR-015 (dual measure coordinate system)

---

## Context

ADR-027 introduced the source-corrections overlay (normalizer Pass 0). Every
overlay entry locates the element it corrects by its MEI `xml:id`
(`target.xml_id`). ADR-027 §"Consequences → Neutral" asserts that an `xml:id` is
"stable per movement and unaffected by pass 1's measure renumbering or by
ADR-015 `mc` coordinates" — and the whole locator design rests on that claim.

**The claim was not actually true of the prep pipeline as built.** The corpus
prep (`scripts/prepare_dcml_corpus.py` → `convert_mxl_to_mei`) generates MEI with
Verovio's `getMEI()`, and Verovio seeds its `xml:id` generator from a *random*
source by default. Measured directly (Verovio 6.1.0) on `K279-1`:

- Two full preps of the *same* `.mscx` (fresh MuseScore export + fresh Verovio
  load each time) produced **different** ids for every note and measure
  (`stable=False`).

The overlay is applied by Pass 0 against the MEI **read from the prep zip** at
ingest, and ingest stores that pre-normalization MEI as `originals/…`
(ADR-014). So ids are frozen *within* one prep artifact — but Band 1 Item 6 of
the Component 9 read-through plan **re-preps** the corpus (the clef-recovery
fixes A1–A3 live in the prep, not the normalizer), regenerating the zip. With
random ids, every `target.xml_id` authored against the current artifact would
resolve to nothing after that re-prep, surfacing as `CORRECTION_TARGET_MISSING`
for every entry — silently disarming the entire overlay.

This blocks Band 1 Item 5 (the first errata entries): there is no point
authoring `xml:id`-keyed corrections until the ids survive a re-prep.

## Decision

**Enable Verovio's `xmlIdChecksum` option in `convert_mxl_to_mei`**, so each
element's `xml:id` is derived from a checksum of the movement's input data
rather than a random seed:

```python
tk = verovio.toolkit()
tk.setOptions({"xmlIdChecksum": True})
tk.loadFile(str(mxl_path))
mei_bytes = tk.getMEI().encode("utf-8")
```

Verified on Verovio 6.1.0 across two *independent* end-to-end preps (fresh
MuseScore `.mscx → .mxl` export feeding a fresh Verovio load):

- With the option, every note and measure id is **byte-identical** between runs
  (`stable=True`); without it, `stable=False`.

`xmlIdChecksum` is preferred over the alternative `xmlIdSeed` (a fixed integer
seed) because it is **content-derived and movement-local**: the ids depend only
on that one movement's musical content, not on a global ordinal or on which
other files were processed. This matches the overlay's `source_sha` pinning
exactly — an id is stable precisely as long as the source `.mscx` is unchanged,
which is the same condition under which a correction's pre-state is valid. A
fixed seed, by contrast, makes ids depend on document processing order, so an
unrelated edit earlier in the score shifts every later id.

This makes ADR-027's "stable per movement" claim genuinely true rather than
aspirational.

## Consequences

**Positive**

- The corrections overlay's `xml:id` locator is now robust across re-preps and
  re-ingests: an entry authored today still resolves after Item 6's full re-prep,
  and a future re-prep against the same `source_sha` produces the same ids.
- Determinism makes the prep output diffable — a source bump now shows *only* the
  musical delta, not a wholesale id reshuffle — which is exactly what the
  pre-state merge-back check (ADR-027 §3) needs to stay legible.

**Negative / one-time cost**

- The first prep after this change **renumbers every `xml:id` in the corpus
  once.** This is safe now and only now: the corpus is not yet frozen (Phase 1,
  no fragments reference these ids), and Band 1 deliberately re-preps before the
  freeze. Doing this after fragments existed would be an `mc`/id-drift hazard of
  the kind the whole interlock plan exists to avoid.
- The ids depend on the pinned Verovio version's checksum algorithm. A Verovio
  upgrade may change them; this is acceptable and is caught the same way an
  upstream source bump is — the overlay's pre-state checks flag any target that
  no longer resolves, and `source_sha` (plus, implicitly, the toolchain version)
  is re-validated on every re-prep.

**Neutral**

- Only the *seed* changes; the id *format* (`<type-letter><base36>`) is
  unchanged, so nothing downstream that merely treats ids as opaque strings is
  affected.
- Elements the prep/normalizer *insert* after `getMEI()` (recovered `<clef>`s,
  Pass 11 `<grpSym>`, Pass 9 `<accid>`) are not assigned ids by lxml and are not
  overlay targets; the overlay only ever targets Verovio-emitted notes and
  measures, all of which are covered by the checksum.

## Alternatives considered

**Fixed `xmlIdSeed`.** Deterministic, but order-dependent: ids are assigned from
a single seeded stream over the whole document, so any inserted/removed element
shifts all later ids. Not movement-local and less aligned with per-entry
`source_sha` pinning. Rejected in favour of the checksum.

**Author the overlay against the final Item-6 prep zip only (no prep change).**
Leaves ADR-027's stability claim false, couples Item 5 to Item 6 timing, and
makes any future re-prep silently disarm the overlay. Rejected as fragile.

**Post-process the MEI to assign content-stable ids ourselves** (e.g. hash of
`(mc, staff, layer, beat, pname, oct)`). Reinvents what Verovio already offers,
and would have to be kept consistent with every id Verovio emits. Rejected;
`xmlIdChecksum` is the built-in, supported mechanism.
