# Various Issues

Here are some issues & small things to get better. They are ordered per section of the app, not per importance.


## General site

- The top bar in navigation is, right now, deficient: there is no "doppia" name or logo; the links (review queue, fragment browser, etc.) show a quite silly arrow, and the right-alignment means they are difficult to see if you don't know they're there. Redesign, based on the `DESIGN.md` doc and the expected future elements (user dropdown, etc.). We could even add a login button already, as there is a /login view anyway.


## Fragment browser

- The "Concepts" column may show the available ones? (An empty search bar is somewhat scary). Also, we might consider, for a future moment when more than one domain is implemented, having a filter of some sort? Think about it and, if decided, let's draft and document for later.
- Preview here is not useful (it's tiny!). If it's going to be a one system, set height to thumbnail height, maybe on hover scroll? See what the options are.


## Fragment viewer

- Width can be wider, and probably centered in browser.
- On header info, same font & display makes it hard to understand (concept hierarchy vs composer/work vs measure/beat). Find a more elegant solution that is in line with the design system. Order my be reconsidered too, as well as grouping source/license.
- Measure/beat data is presented in a weird manner: beat only makes sense within measure, so M 3-4, B 1-3 is uncomprehensible. If measures are complete, don't even show the beats at all.
- Size controls are ok, but I would default to Medium on loading the fragment.
- Don't force one system for the rendering: system breaks are fine, and preferable to horizontal scrolling. (In future contexts this might not be so, as in the projected blog with scrolly-telling; but right now it's the right call.) This also means leaving the necessary vertical space, no vertical scrolling to see the whole fragment (right now it is easy for stage brackets to seem absent, when they're just hidden).
- The score should show the bracket above, as the fragment shown is not necessarily the exact same as the significant fragment.
- The harmonic info is shown in the data below, but not in the score itself. It's incongruent, but I'm not sure what the solution is here, please consider the options, what they imply, and how they relate to the decision of showing them only in tagging mode in the general score view.
- The play button starts from the start of the score, not of the fragment (and continues playing afterwards, which is weird). Just play the fragment itself.
- Don't duplicate the license/source data below (it's already in the header, which is is fine).


## Review queue

- It's fine, but there's a variety of designs here (browser, fragment browser, review queue) that I'm not sure is justified. Please review them with a critical view, and if needed consider the options for better coherence.


## Browser

- The previews displayed are too small, and the centered position is not the best. Should get them about 25% bigger (then we can iterate on visual testing), and left aligned in their column.
- It is to be decided what to do with the very wide column (it fits the rest of the browser width, which in a normal screen is wider than the other three columns combined. May check against the fragment browser layout, and find a similar approach.


## Score viewer

- Remove the "Music Font" selector: it was a development tool for checking the preferred font, but it isn't necessary for the end user, and only adds noise.


## On ingestion

- On some ocasions, changing clefs are not rendered. For example, K 279 mvt. 1 has several changes on bass staff (measure 5 G clef, measure 9 F clef, etc.). These are in the original file, but they aren't shown in the app. In other cases they ARE shown (example: K 279, mvt. 2, measure 10 or 11). See why this is happening.
- Issue seen in K 279, mvt. 1, measures 13 to 14: a flat note should be tied to next bar, but the tie is not there (again, I can see it in MuseScore). This even causes the second note to become natural again (the tie makes it unnecessary to re-state the flat). See why this is happening.
- (from Claude Code) "One side note from the output: K.331 mvt 2 has 51 warnings about duplicate @n measures — that's the known messy file flagged in your corpus browser memory. Nothing to do about it now, but worth a future cleanup ticket." - This is probably because it is a minuet + trio, and numbering re-starts on trio. See what can be done with these (legitimate) cases.
- Apart from that, the ingestion script returns a long list of warnings, which might be better revised as well (see  `ingestion-warnings.md`).


## Playback

- A better way of following playback (than highlighting the notes) is, of course, a moving caret. Research how complicated this would be, and if it's reasonable, draft the solution.
- After a caret is implemented, some better playback controls might be added: in particular, a way of playing _from_ a specific position. Investigate how this could be done (per measure? beat? selecting a note? re-using the here invisible ghosts? what would the actual interaction be?)


## Tagging sidebar

- Save draft / Submit for review end up in the same state (a very fast info is shown, then dissappears), which is weird. Form & ghosts should be reset to initial state, plus a more obvious sign that the submitting was successful? Different is, of course, the case of Save draft, but study the actual behavior right now to see if something should change.


## Harmonic labels

- On harmonic labels in score, the very least is to get the font a tiny bit bigger.
- Alignment is subtly wrong: right now it aligns with ghost. The ideal behavior is to align with notehead. Please investigate how convoluted this would be.
- The third & more elaborate thing to consider is getting a better display of this harmonic analysis: roman numeral, then stacked figures. Study the common cases & how this could be done. If there are edge cases difficult to implement, they could even default to normal rendering.


## Tagging tool

(from Claude Code in G2.3 — Partial barlines after a repetition) "Remaining limitation (unchanged): if Verovio does not render the partial-after measure as a separate SVG group, buildGhosts skips it entirely (no ghost → not clickable). This is a Verovio rendering constraint requiring corpus verification in Component 9."


### Basic fragment selection

A frequent use of this tool has surfaced a sizzeable set of bugs. Many are probably interrelated.

- On selecting a fragment that ends on a partial bar + repeat sign (hard gate works ok): measure or beat select work just fine; sub-beat selection is shown ok on ghosts, but the bracket avoids the partial bar. From this situation (ghost larger than bracket), clicking on resolution measure extends the bracket to ghost, but clicking on beat resolution shortens ghost to bracket...
- In other cases (K 331, mvt. 3, Alla turca), this has a different result: ghost is ok, bracket extends also above all partial bars after repeat barline (not on initial pickup). This happens with beat-resolution as well.
- If I try the same on the other side of repetition (initial partial bar after repetition sign, + some others), ghost is shown, bracket is not; on the harmony panel a "Request validation failed" sign is shown. In Alla turca, a bracket is drawn over the whole movement... Fly logs show this:
{
  "id": "00000000000000006c339c101139d7b23d807f273be46f2d-1781089591072726289",
  "message": "INFO:     172.16.58.146:60304 - \"GET /api/v1/movements/964a1281-a699-421a-b7b7-22da6ad82120/analysis/events?bar_start=NaN&amp;bar_end=55 HTTP/1.1\" 422 Unprocessable Entity",
  "timestamp": "2026-06-10T11:06:31.072Z",
  "level": "info",
  "instance": "8d5990bee73948",
  "provider": "app",
  "region": "lhr",
  "process_group": null
}

- The same "Request validation failed" is shown if including a second repeat bar.
- On selecting the pickup + some other bars, ghost appears ok, and bracket appears on the same fragment PLUS in ALL separate partial bars after barlines!! This happens on beat or sub-beat selection, not on measure.
- Selecting a fragment with sub-beat that ends on the first sub-beat of a measure breaks the bracket: it doesn't reach that last measure part.
- Rethink how to handle repeat start: right now it is not a barrier, which is asymetrical...
- Entering a first reapeat bar with beat or sub-beat precision breaks the bracket: it extends up to both repeat endings (plus subsequent second endings far away from the initial selection).
- Actually, in scores with 1st/2nd endings, any selection seems to include all 2dn endings???


### Stages

If main fragment selection is buggy, this is a huge mess. I'll point to some obvious issues & confusions as to how this tool should actually behave, BUT: more than start solving them right away, I think a clearer map of the expected behavior is necessary.

- On measure resolution, moving a handle can collapse a stage (it is toggled off from the sidebar). Who takes that space is weird, though: sometimes is not the one you were growing, but the one on the other side (you grow stage 3 back until you collapse 2, then 1 takes up the space...). That only happens dragging back; dragging forward collapses sensibly.
- With beat or sub-beat resolution, dragging backwards to collapse a stage works in the same weird way. Dragging forward makes the handle bounce bock to original position.
- Resizing the main fragment when stages are shown already DOES work as expected: it resizes the stages proportionally, even changing resolution.
- In some cases, resizing the main fragment without risking any collapse makes the main fragment & the last stage differ.
- Sometimes, even resizing fragment on one side makes the stage on the other side to resize (again differing from main fragment ghost).
- Sometimes selecting a concept with stages doesn't make them appear right away, but they can after resizing the fragment.
- In many many cases, involving small fragments & sub-beat resolution, stages can end up overlapping. A common case involves a stage that ends up covering whole bars.

There are probably many more, but, again: don't try to solve them right away - we need to clearly define first what action results in what behavior, what "rules" the interactions helpl uncover, etc.
