import React from 'react';

export type SurfaceLayer =
  | 'base'
  | 'container-lowest'
  | 'container-low'
  | 'container'
  | 'container-high'
  | 'container-highest';

interface SurfaceProps extends React.HTMLAttributes<HTMLDivElement> {
  layer?: SurfaceLayer;
  /**
   * Adds an ambient shadow. Floating overlays use
   * `<Surface layer="container-highest" floating>`.
   */
  floating?: boolean;
}

const layerTokens: Record<SurfaceLayer, string> = {
  'base':               'var(--color-surface)',
  'container-lowest':   'var(--color-surface-container-lowest)',
  'container-low':      'var(--color-surface-container-low)',
  'container':          'var(--color-surface-container)',
  'container-high':     'var(--color-surface-container-high)',
  'container-highest':  'var(--color-surface-container-highest)',
};

/**
 * A surface container that maps a semantic layer name to the corresponding
 * tonal background token. Depth is achieved through colour shifts, not borders
 * or shadows — except floating elements which receive an ambient shadow.
 */
export default function Surface({
  layer = 'base',
  floating = false,
  className,
  children,
  style,
  ...rest
}: SurfaceProps) {
  const background = layerTokens[layer];

  const computedStyle: React.CSSProperties = {
    backgroundColor: background,
    ...(floating
      ? { boxShadow: 'var(--shadow-floating)' }
      : undefined),
    ...style,
  };

  return (
    <div className={className} style={computedStyle} {...rest}>
      {children}
    </div>
  );
}
