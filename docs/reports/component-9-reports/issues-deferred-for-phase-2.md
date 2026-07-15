# Issues deferred for Phase 2


I'm dumping here a set of issues and questions already identified but not yet tackled, as of the completion of Phase 1. They should be triaged & packed together with `phase-2-entry-backlog.md`.


## Core

- What's there about capture extensions? That's a concept stated on the initial design, but not yet implemented anyway, though there are concepts that ought to use it (evaded cadence, closing section, standing on the dominant).


## Fragment browser

- What's the update schedule of the numbers in the concept tree? Right now it seems to get stuck on cache.


## Fragment editor

The cadence editor doesn't work properly:

 - The concept itself is not shown (the search bar is empty).
 - The stage components & properties are also blank.
 - Fragment properties ARE updated to real values.
 - Harmony panel is absent.
 - The commentary is also not shown.
 - "Fragment drawn" is off, but I can't update it either, as I see the "recorded fragment" brackets, not the "editing fragment" ones.
 
 In summary: I can't really use it...


## Tagging sidebar

- Even more cleanup to be done here: let's delete the text "stage properties" from the text within stages - it's kind of obvious.
- Stages dynamic ordering: I found the uncanny behavior, what happens is that un-toggled stages are moved to the end of the list, which is confusing. Let's keep that order fixed once set.


## Info sidebar

- On showing cadence data (fragment already created), properties should be shown in the same order as in "create or edit cadence".
- The harmony shows the chords for the full measures, not limited to sub-beat-precision fragment length (this was solved earlier on cadence creation, but it seems not here).
- This panel's harmony should follow the score convention: local key only on first + when it changes.
- Stage properties are not shown here!
- Summary shows C major + 4/4 irrespective of the real key & meter?? Seen on 279/ii, for example (really in F major, 3/4):
	> Tonalidad C major
	> Compás 4/4


## Harmony panel

- Grado != Fundamental? (Explain better the fields, and give a thought to the terms and their sense. For example, it seems the actual text in the score is drawn literally from one of the fields, "grado", when it might probably be computed (or, at least, pre-populated) from other fields.)
- Can we prepopulate "Local Key" with last event value?
- Can Local Key be shown fainter on the sidebar list? (it's almost always the same)
- A more serious question: should it be possible to edit a harmonic event outside of a fragment?


## Revision workflow

- When selecting an item from the review queue, the sidebar shows it, but the score doesn't scroll to the fragment, which is annoying.
- You open the queue, click on an item, the score opens, you do your work. Now the "back" button brings you back to the main browser instead of the review queue...
- Evaded Cadences are not named as such in the review queue, neither in the brackets in score. Why?? (Abandoned Cadence neither...)


## Score

- Brackets could be redesigned a bit, helping identification or coordinates & function. For example, I would try making it "square" brackets (little downward handles at the ends) on main fragments already created (not necesarily during creation/edition). I would try to differentiate better the one being edited vs. the rest, & the substage vs. main brackets. This implies some design thinking before executing.
- Above & below staff brackets frequently collide or even cross. Think about how to minimize this.
- The sub-brackets text often collides (Dominant with Final Tonic, etc.). This should be packed with the previous item.
- Consider re-turning on the ghosts on edition, even on mere selection?
- Weird behavior of stage brackets: off by default, clicking on a fragment shows them. Clicking on another one does the same, but the old one doesn't turn off? (What's the desired behavior here?)


## I18N

- There are more surfaces to be translated. Make a list per type/complexity/urgency, then let's decide when to implement.


## Real bugs

- 279/ii, m. 8-10 (also m. 48-50): main bracket & info show real fragment ("m. 8, beat 3 – m. 10, beat 1"), but stages show whole measures, so first & last overflow the actual fragment size (seen both in stage brackets & sidebar info).


---

## Editorial work

These are just small errors on the fragments recorded. As I can barely use the fragment editor, they are documented here. To be edited at some point:

- General: harmonies are not confirmed in any places - check all.
- 279/i m. 9-10: V = 64 (no comma), then V7 (grade, type major).
- 279/i m. 11-12: Final Tonic harmony is not confirmed, an extra one is shown?
- 279/i m. 77: commentary has a typo.
- 279/i m. 81: delete the IV6?
- 279/i m. 93: stages are not ok.
- 279/ii, m. 3: evaded no text, summary is generic (C major + 4/4)
- 279/ii, m. 15: wrong stages
- 279/ii, m. 22: mistake on commentary (3 failed attemps).
