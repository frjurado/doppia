/**
 * Playback caret — Component 9 Step 19.
 *
 * A thin vertical overlay bar that tracks the playback position over the score.
 * Replaces the former `.is-playing` note highlight.
 *
 * The element is positioned imperatively (its `transform`/`height` are mutated
 * per animation frame by the viewer's `handlePositionUpdate`, via
 * `applyCaretPlacement` in `caret.ts`) — there is no React state on the 60 fps
 * path. The component therefore just renders the styled `<div>` and forwards a
 * ref so the viewer can drive it.
 *
 * Overlay rule (CLAUDE.md): this is an absolutely-positioned HTML element above
 * the SVG, never injected into Verovio's SVG output; `pointer-events: none`.
 *
 * See `docs/architecture/playback-coordinates.md` §"Playback caret".
 */

import { forwardRef } from 'react';
import styles from './PlaybackCaret.module.css';

const PlaybackCaret = forwardRef<HTMLDivElement>(function PlaybackCaret(_props, ref) {
  return <div ref={ref} className={styles.caret} aria-hidden="true" data-testid="playback-caret" />;
});

export default PlaybackCaret;
