# Corpus passages Caplin discusses

**Date:** 2026-10-08. Part of the [E1 review](README.md).

Caplin, *Cadence* (2024), Part I, analyses or cites the passages below from
the eighteen Mozart sonatas in the Doppia corpus (the DCML set, in which the
Rondo K494 is the finale of K533). The list was built by searching the text
for every corpus K number, then reading the discussion of each example.
Chapter 7 adds two more K545 references (p. 383, p. 415 n. 88).

**Uses.**

- **E1/E2 reference reading.** Caplin's reading is a third annotator for these
  bars (proposal P4). Where he leaves two readings open, both count as
  agreement.
- **E4 hard cases.** The **bold** rows are the ones where Caplin weighs
  competing readings: the cases the `confidence` field (P5) is for.
- **Component 15.** Ready-made exercise material with a published argument
  behind each answer.

**Columns.** *Concepts* names the graph concepts or properties in play
(`LimitedScope` etc. are `CadenceFunction` values). "Ex." is Caplin's example
number; pages are where the discussion is. Bar numbers are Caplin's; check them
against the MEI measure numbering (`mn`) before using them as data, since
upbeats and volta endings can shift them.

| Movement | Bars | Ex. | Pages | What Caplin shows | Concepts |
|---|---|---|---|---|---|
| K279/i | 1–12 | 2.19 | 36–37 | "Cadences" in mm. 3 and 5 close basic ideas only (limited scope); DC m. 10; PAC m. 12 | `LimitedScope`, DC, PAC |
| **K279/ii** | 1–6 | 4.33 | 171–172, 175–176 | Evaded cadence at m. 4 with IV⁶ as initiating harmony (also passing); the nearest Caplin finds to a non-way-station evaded cadence | Evaded, `post_evasion_harmony`, `CadenceFunction` |
| K280/i | 6–11 | 4.32 | 171–172 | Evaded at m. 10, V⁶₅ as initiating harmony; one more time back to m. 7 | Evaded, `post_evasion_harmony` |
| **K280/iii** | 45–51 | 4.82 | 217 | HC (V⁶₅/V in stage 2b makes the dominant ultimate) vs evaded; Caplin prefers HC | HC vs Evaded |
| K280/iii | 78–106 | — | 120 | The seeming PAC at m. 85 has limited scope inside an incomplete pre-core | `LimitedScope` |
| K281/i | 1–3, 7–8 | 3.157 | 133–134; 94 n. 116 | Antecedent IAC on a weak beat (ratio 1:16), a galant remnant; independent IAC | IAC, `Independent`, meter |
| **K281/i** | 24–40 | 4.41 | 176–177 | Possibly three evaded cadences in a row; internal dominant arrival at m. 27; evaded / PAC ambiguity typical of early Mozart | Evaded, PAC, DA |
| K281/iii | 1–8 | 2.15 | 28–30; 276 | Period bass model; the antecedent's I⁶–IV barely starts a cadential progression, the bass turns prolongational, and a compact HC follows | HC, abandoned (barely) |
| K281/iii | 55–59 | 3.141 | 115–116 | Converging HC turning into expanding by voice exchange | `HalfCadenceShape` (MANY_OF) |
| K282/i | 1–4 | 3.91 | 98 | A Prinner cadence closes the main theme | IAC (Prinner), `ClosesMainTheme` |
| **K282/i** | 6–8 | 4.73 | 205–207 | Martin & Pedneault-Deslauriers' "doppia HC" vs Caplin's doppia premature DA on V⁷ | HC vs DA, `Premature` |
| K282/ii | 15–16 | — | 167 | Deceptive-cadence complications (§ 4.1.2.4) | DC, `CadenceFunction` |
| K283/i | 21–22 | 3.139 | 114–115 | Unison HC on a converging bass | `Unison`, `HalfCadenceShape` |
| **K283/i** | 31–44 | 4.42 | 177–178 | Root-position I with 1 at m. 38 heard as evaded because of the one-more-time repetition | Evaded vs PAC |
| K283/ii | 1–4 | — | 103 n. 145 | Burstein's example: a possible HC or no cadence at all, decided by where the group boundary falls | HC vs none |
| **K283/ii** | 9–14 | 4.49 | 184–185 | Expanded progression abandoned (IV → I⁶), then an evaded cadence with a passing V⁴₂, one more time | Abandoned, Evaded, `ECP` |
| K283/ii | 20–23 | 3.143 | 116–117 | Expanding HC disrupted by V⁷ (passing), becomes converging | `HalfCadenceShape`, HC vs DA |
| K284/ii | 7–8, 15–16 | 3.164 | 136; 110 n. 166; 222 | Antecedent and consequent both close on beat 2 (ratio 1:12) | meter |
| K284/iii | 3–4 | 3.126a | 111–112 | HC melody: tenor and soprano streams together, the lower one alone in stage 3 | melody |
| K284/iii | 7–8 | 3.50 | 74 | Soprano and tenor streams combined | melody |
| K284/iii | 122–23 | 3.137 | 105, 115 | HC with V⁴₂/IV in stage 1 | `Stage1Components` |
| K284/iii | 130–31 | 3.108 | 107 | HC from I⁶; ascending melody | HC |
| K309/i | 30–32 | 3.140 | 115 | Unison HC with no obvious model | `Unison` |
| K309/ii | 7–8 | 3.125 | 111 | HC melody combining tenor and soprano streams | melody |
| K309/iii | 13–19 | 4.38 | 174 | Evaded cadence without a literal harmonic interruption (m. 16) | Evaded |
| **K310/i** | 1–10 (4–9) | 4.84 | 218–220 | Four readings of the main theme's close: HC/DA m. 8; evaded at the end of m. 8; elided AC (on 5?) m. 9; covered PAC m. 9 (Caplin's choice). His aim is to weigh, not decide | HC, DA, Evaded, IAC, `Covered`, `Elided` |
| **K310/i** | 31–47 | 4.79 | 211–213; 183 n. 81 | Three potential PACs (mm. 35, 40, 45): two evaded + PAC, or three PACs; abandonment via V⁴₂ at m. 38 | Evaded vs PAC, Abandoned |
| K310/ii | 2–4 | 3.122 | 110–111 | HC melody embellished in stage 1 | melody |
| K310/iii; K311/ii | 1–20; 1–8 | — | 137 | Cited on hypermeter | meter |
| K311/iii | 6–8 | 3.123a | 111 | HC melody | melody |
| K330/i | 4–8 | 3.71 | 84 | IAC with stages 1 and 2 omitted; the tenor stream is completed by the material before the cadence | IAC (incomplete) |
| K330/ii | 8 | — | 70 | Melodic pattern with an upward arpeggiation | melody |
| K330/iii | 14–16 | 3.45 | 72 | Leaping approach to 1 | melody |
| K330/iii | 73–76 | 5.45 | 265 | Compound melody in an expanded progression (varied tenor over varied alto) | `ECP`, melody |
| K331/i | 7–8 | 3.24 | 67 | Pattern starting at stage 2; four-part realisation | melody |
| K331/i | 13–18 | 3.87 | 95–96 | Way-station IAC at m. 16 near the end of a small ternary (where A′ is expected to be a single consequent); a short extension leads to the PAC at m. 18 | IAC, `WayStation` |
| K331/ii | 1–7 | 3.146 | 123; 132; 222 | Reinterpreted HC closing a simple antecedent (m. 4), on a weak beat | `ReinterpretedAsHC`, meter |
| K332/i | 10 | — | 57 n. 12 | Embellishing VI after an initial I⁶ (stage 1b tonic substitute) | `Stage1Components` (P9) |
| K332/i | 13–20 | 3.75 | 86–87 | IAC melody | IAC |
| **K332/i** | 31–40 | 4.59 | 194 | HC vs premature DA on a consonant triad inside a fragmentation | DA `Premature` vs HC |
| K332/i | 121–34 | 4.66 | 200 | Core: HC in VI, then a lowered leading tone and V⁴₃ retransition: PDA on an inverted terminal dominant | DA, `Premature` |
| K332/i | 167–73 | 5.53 | 268–269 | Seven-bar expanded HC | HC, `ECP` |
| K332/ii | 1–4; 4 | 3.105 | 105; 131 n. 221 | HC with a cadential 6-4; R = ½N notation | HC, `Cadential64` |
| **K332/iii** | 21–32 | 4.22 | 165–166 | DC(3̂) at m. 26 ending a contextually initiating phrase; independent vs way station left open | DC, P7, `CadenceFunction` |
| K332/iii | 29–32 | 3.46 | 73 | Tenor-combo variant | melody |
| K332/iii | 55–57 | 3.134 | 114–115 | Soprano stream on top, bass stream in an inner voice | melody |
| **K333/i** | 1–4 | — | 280 n. 98 | Cadential conundrum: Zhang hears a possible IAC at m. 4 but prefers non-cadential closure | IAC vs prolongational closure |
| K333/i | 14–18 | 5.57 | 271–272 | Expanded HC in a transition (stage 2b VII⁷/V) | HC, `ECP`, `ClosesTransition` |
| K333/i | 56–59 | 2.16 | 31 | Bass-line model; ECP annotation | `ECP` |
| K333/ii | 3–4 | 3.121 | 110 | HC melody (gap then scalar fill) | melody |
| K333/ii | 5–6 | 4.28 | 168–169 | Deceptive resolution at the end of a basic idea: not a DC | DC (negative case) |
| K333/ii | 6–8 | 3.62 | 77 | Cudworth pattern with chromatic embellishment | melody |
| **K333/ii** | 14–21 | 4.50 | 186–187 | Expanded progression abandoned (II⁶ → V⁴₂), against Cutler's single-ECP reading | Abandoned, `ECP` |
| K457/i | 9–13 | — | 297 n. 140 | Cited as an earlier case of a standing on the dominant inside the continuation of a simple theme | `StandingOnTheDominant` (non-postcadential) |
| K457/i | 44–59 | 4.2 | 151–152 | Deceptive cadence in a subordinate theme (m. 48), the chapter's model case | DC, `WayStation` |
| K457/ii | — | — | 40 n. 150 | Agawu's rhetorical repeated cadences | consecutive cadences |
| K533/iii (K494) | 63–67 | 5.11 | 230 | Stage-1 expansion in an expanded progression | `ECP`, `Stage1Components` |
| K545/i | 1–12 | 3.66 | 80–81; 86; 144; 415 n. 88 | Main-theme/transition fusion (a classical exception); mm. 5–8 a Prinner that yields no cadence (VII⁶ in its third stage) and a prolongational close | prolongational closure, IAC (negative case) |
| K545/i | 3–4 | 7.9 | 383 | Galant clausula (Gjerdingen) | — |
| K545/i | 20–23 | 5.30 | 246 | Expanded progression beginning on II⁶ after a sequence | `ECP`, stages |
| K545/i | 67–71 | — | 264 | Expanded progression beginning at stage 2 | `ECP`, stages |
| K545/ii | 40 | — | 70 | Melodic pattern with an upward arpeggiation | melody |
| **K545/ii** | 44–48 | 5.12 | 230 | Does a single VII⁴₃ → I⁶ start an expanded progression? Left open | `ECP` |
| **K570/i** | 41–57 | 5.61 | 276–277 | Rocking on the tonic more continuational than cadential; abandonment confirmed by V⁶ at m. 55; compact PAC | Abandoned, PAC |
| K570/iii | 40–42 | 3.10 | 61 | Two I⁶ chords: end of a prolongation vs start of the cadence | stage 1 boundary |
| K576/i | 7–8 | 3.4b | 57–58 | Chromatic stage-1b embellishment | `Stage1Components` |
| K576/i | 49 | — | 57 n. 16 | V⁴₂–I⁶ before the cadence ("stage 0") | stage 1 |
| K576/i | 24–26 | 3.119 | 108–110 | ♯4 breaks a sequence and announces the HC | HC, `Stage2Components` |
| K576/i | 147–55 | 5.32 | 248 | VII⁷/V interrupting the cadential 6-4 in stage 3 of an expanded progression | `Cadential64`, `ECP` |
| K576/ii | 5–8 | 3.6b | 59 | Pre-dominant diminished seventh | `Stage2Components` |
| K576/iii | 6–8, 15–16 | 3.162 | 134–135 | Reinterpreted HC on a weak beat (1:16); the consequent restores 1:8 | `ReinterpretedAsHC`, meter |
| K576/iii | 22–23 | 3.138 | 115 | Unison simple HC | `Unison`, `HalfCadenceShape` |
| **K576/iii** | 175–84 | 4.76 | 209–211 | Deceptive or evaded at mm. 178 and 181; the one-more-time at 181 tips it to evaded | DC vs Evaded, `Elided` |

## Coverage

- **73 rows, all eighteen sonatas.** The densest are K279–K283 (galant habits,
  and the evaded / PAC ambiguities Caplin attributes to early Mozart, p. 177
  n. 69), K310/i and K332.
- **Not found:** no corpus passage illustrates the reopened HC, the reopened DA
  or the reinterpreted DA. Caplin's examples for those are K458 and K515
  (reopened HC), K475 (reopened DA, Ex. 4.71) and Beethoven (reinterpreted DA,
  Ex. 4.70).
- **Starting point for E2 and E4:** the fifteen bold rows. They cover every
  ambiguity pair in § 4.6 except abandoned / deceptive.
