# Caplin graph review (Track E, stage E1)

**Date:** 2026-10-08
**Status:** Draft for Francisco's review. Proposals only: no YAML, ADR or
`cadences-design.md` change has been made. The decisions are Francisco's; once
taken, the seed changes go through Claude Code (`seed(cadences):`) and the
amendments to `cadences-design.md` and the ADRs follow in the same pass.
**Roadmap:** [`../../roadmap/track-e-editorial-acceleration.md`](../../roadmap/track-e-editorial-acceleration.md) § E1.
**Report:** [`../../reports/editorial-acceleration-planning.md`](../../reports/editorial-acceleration-planning.md) § 4.3 (method, property criterion).

---

## What this is

A review of the cadence domain (`backend/seed/domains/cadences.yaml`, with its
design record [`../../seed-drafts/cadences-design.md`](../../seed-drafts/cadences-design.md))
against the source it names as its theoretical reference: William E. Caplin,
*Cadence: A Study of Closure in Tonal Music* (Oxford University Press, 2024).

## Files

| File | Contents |
|---|---|
| [`concordance.md`](concordance.md) | Every concept, property, capture extension and edge in the domain, plus the hard-locked decisions: Caplin section and pages, a status, a note. |
| [`proposals.md`](proposals.md) | The decisions the roadmap defers to E1, each with a proposal, its arguments and page references; the other changes the concordance calls for; open questions for Francisco. |
| [`corpus-test-cases.md`](corpus-test-cases.md) | The passages from the Doppia corpus (Mozart piano sonatas) that Caplin analyses, with the point each one illustrates. A reference annotation for E2 and E4, and a ready set of hard cases. |

## Source and scope

- **Read:** Part I (the classical style), chapters 2–5, pp. 13–281, and the
  glossary, pp. 583–592. Chapter 5 was read selectively (the harmonic content
  of expanded progressions, minimum sizes, and the deviations of expanded
  progressions, §§ 5.1.1, 5.2–5.5); § 5.6 (Beethoven's symphonies) was
  skipped.
- **Skimmed:** chapter 7 (the galant), §§ 7.1.4, 7.2, 7.3.1, 7.4.1–7.4.2,
  pp. 392–419. Relevant because the early sonatas (K279–284) still carry galant
  habits, which Caplin himself points out (p. 98, p. 177).
- **Not read:** chapter 6 (baroque) and Part II beyond chapter 7. The graph's
  portability claim (decision 4) is about those repertoires, so they matter
  later, not for this review.
- **Page numbers** are the book's printed pages. In the PDF under
  `private/sources/`, PDF page = book page + 23.
- **Paraphrase only.** Nothing here transcribes the book beyond single terms
  and short labels. Caplin's own analytical labels ("deceptive cadence (3̂)",
  "initiating harmony", "abandoned cadential progression") are cited as terms.

## Statuses

The report defines three statuses. The exit criterion ("every graph concept
and property has a status") needs a fourth for the many points where the graph
agrees with the book, so the concordance uses:

| Status | Meaning |
|---|---|
| **Consistent** | Agrees with Caplin; at most a wording refinement. |
| **Contradiction** | The graph says something Caplin denies, and the difference is not argued anywhere. |
| **Departure (recorded)** | The graph differs on purpose, and the reason is in `cadences-design.md` or an ADR. |
| **Departure (to record)** | The graph differs, the difference is defensible, but no record says so yet. |
| **Loose end** | A gap: a case Caplin describes that the graph cannot express, or a choice nobody has made. |

## Summary of findings

- The core taxonomy holds. The split authentic / half, realised / deviation,
  the four stages and their substages (`Stage2Components` is exactly Caplin's
  2a/2b; `Cadential64` is 3a), function as a property rather than a type, and
  the reinterpreted/reopened HC pair all match the book.
- **Four public definitions contradict Caplin** (they carry
  `definition_reviewed: true`, so they are on the glossary page):
  `ImperfectAuthenticCadence` (presents the IAC on scale degree 5 as an
  ordinary option; for Caplin it is highly exceptional), `EvadedCadence` (the
  replacing event need not be "unrelated"; it is defined by grouping forward),
  `DominantArrival` (Caplin's two conditions are blurred) and the description
  of `Premature` (a different criterion).
- **`CadenceFunction` stretches Caplin's terms.** Caplin defines
  independent / way-station for IACs and authentic deviations only, relative to
  an expected PAC. The graph applies the pair to every cadence with a broader
  meaning of "independent". Defensible, but it needs recording and guidance
  for four cases the book names.
- **The "contextual" family resolves under one rule** (proposal P2):
  judgements about the arrival itself are BOOLs on the cadence (`Covered`, a
  new `Elided`, `ReinterpretedAsHC`); relations to a later tagged unit are
  `FOLLOWS` plus a backward pointer; facts already in the analysis data are
  computed (`post_evasion_harmony`, texture, metric position). `Unison` falls
  in the computed group.
- **Decision 4 should stand**, and Caplin's stage requirements should become
  per-concept *expected stages* used by defaults and checks (proposal P1). The
  deviations break exactly the stages that the theory requires, so structural
  requiredness would reject correct tags.
- **Caplin's text is full of ambiguities he declines to settle.** That is the
  strongest argument found for implementing decision 8 (`confidence`), and for
  letting it name the competing reading (proposal P5).
- **Caplin discusses 73 passages from the Doppia corpus**, from all eighteen
  sonatas; fifteen of them are explicit ambiguity cases. See
  `corpus-test-cases.md`.
