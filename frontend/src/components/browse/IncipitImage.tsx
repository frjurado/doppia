import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Type from '../ui/Type';
import Surface from '../ui/Surface';
import styles from './IncipitImage.module.css';

interface IncipitImageProps {
  url: string | null;
  ready: boolean;
  /** When true, animate the image to scroll right; when false, return to start. */
  scrollActive?: boolean;
}

const SCROLL_SPEED_PX_PER_S = 60;
const RETURN_DURATION_S = 0.5;

/**
 * Renders a movement incipit SVG sized to fill the container's height,
 * overflowing horizontally. When scrollActive changes to true the image
 * slowly pans right to reveal the full score; on false it snaps back.
 */
export default function IncipitImage({ url, ready, scrollActive = false }: IncipitImageProps) {
  const { t } = useTranslation('browse');
  const [errored, setErrored] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const img = imgRef.current;
    const wrapper = wrapperRef.current;
    if (!img || !wrapper) return;

    if (scrollActive) {
      const scrollDist = img.offsetWidth - wrapper.offsetWidth;
      if (scrollDist > 0) {
        const duration = scrollDist / SCROLL_SPEED_PX_PER_S;
        img.style.transition = `transform ${duration}s linear`;
        img.style.transform = `translateX(-${scrollDist}px)`;
      }
    } else {
      img.style.transition = `transform ${RETURN_DURATION_S}s ease-out`;
      img.style.transform = 'translateX(0)';
    }
  }, [scrollActive]);

  if (ready && url && !errored) {
    return (
      <div ref={wrapperRef} className={styles.wrapper}>
        {/* Decorative: the movement title in MovementCard is the accessible name. */}
        <img
          ref={imgRef}
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
        {errored ? t('incipit.reloadToRefresh') : t('incipit.rendering')}
      </Type>
    </Surface>
  );
}
