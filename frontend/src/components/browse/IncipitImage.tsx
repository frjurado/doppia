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
 * The image slot always occupies 120px height to prevent layout shifts
 * when an incipit becomes ready after initial render.
 */
export default function IncipitImage({ url, ready }: IncipitImageProps) {
  if (ready && url) {
    return (
      <div className={styles.wrapper}>
        <img
          src={url}
          alt="Score incipit"
          className={styles.img}
        />
      </div>
    );
  }

  return (
    <Surface layer="container" className={styles.placeholder}>
      <Type variant="label-sm" style={{ color: 'var(--color-on-surface-variant)' }}>
        Rendering…
      </Type>
    </Surface>
  );
}
