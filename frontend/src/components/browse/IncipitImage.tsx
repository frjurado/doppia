import { useState } from 'react';
import Type from '../ui/Type';
import Surface from '../ui/Surface';
import styles from './IncipitImage.module.css';

interface IncipitImageProps {
  url: string | null;
  ready: boolean;
}

/**
 * Renders a movement incipit SVG as a fixed-height image.
 * Shows a "Rendering…" placeholder when the incipit is not yet available.
 * Shows a "Reload to refresh" placeholder when the signed URL has expired.
 * The image slot always occupies 120px height to prevent layout shifts
 * when an incipit becomes ready after initial render.
 */
export default function IncipitImage({ url, ready }: IncipitImageProps) {
  const [errored, setErrored] = useState(false);

  if (ready && url && !errored) {
    return (
      <div className={styles.wrapper}>
        {/* Decorative: the movement title in MovementCard is the accessible name. */}
        <img
          src={url}
          alt=""
          className={styles.img}
          onError={() => setErrored(true)}
        />
      </div>
    );
  }

  return (
    <Surface layer="container" className={styles.placeholder}>
      <Type variant="label-sm" style={{ color: 'var(--color-on-surface-variant)' }}>
        {errored ? 'Reload to refresh' : 'Rendering…'}
      </Type>
    </Surface>
  );
}
