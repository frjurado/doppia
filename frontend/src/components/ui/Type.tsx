import React from 'react';

export type TypeVariant =
  | 'display-lg'   // 3.5rem Newsreader, used for major section headers
  | 'display-sm'   // 2rem Newsreader
  | 'headline'     // 1.5rem Newsreader
  | 'title'        // 1.25rem Newsreader
  | 'body-lg'      // 1rem Newsreader, generous line-height
  | 'body-sm'      // 0.875rem Newsreader, for marginalia
  | 'label-md'     // 0.875rem Public Sans, uppercase
  | 'label-sm';    // 0.75rem Public Sans, uppercase

type AsProp = keyof JSX.IntrinsicElements;

interface TypeProps {
  variant: TypeVariant;
  as?: AsProp;
  className?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}

const variantStyles: Record<TypeVariant, React.CSSProperties> = {
  'display-lg': {
    fontFamily: 'var(--font-serif)',
    fontSize: '3.5rem',
    fontWeight: 400,
    lineHeight: 1.1,
  },
  'display-sm': {
    fontFamily: 'var(--font-serif)',
    fontSize: '2rem',
    fontWeight: 400,
    lineHeight: 1.2,
  },
  'headline': {
    fontFamily: 'var(--font-serif)',
    fontSize: '1.5rem',
    fontWeight: 400,
    lineHeight: 1.3,
  },
  'title': {
    fontFamily: 'var(--font-serif)',
    fontSize: '1.25rem',
    fontWeight: 400,
    lineHeight: 1.4,
  },
  'body-lg': {
    fontFamily: 'var(--font-serif)',
    fontSize: '1rem',
    fontWeight: 400,
    lineHeight: 1.6,
  },
  'body-sm': {
    fontFamily: 'var(--font-serif)',
    fontSize: '0.875rem',
    fontWeight: 400,
    lineHeight: 1.5,
  },
  'label-md': {
    fontFamily: 'var(--font-sans)',
    fontSize: '0.875rem',
    fontWeight: 500,
    lineHeight: 1.4,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  'label-sm': {
    fontFamily: 'var(--font-sans)',
    fontSize: '0.75rem',
    fontWeight: 500,
    lineHeight: 1.4,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
};

const defaultTags: Record<TypeVariant, AsProp> = {
  'display-lg': 'h1',
  'display-sm': 'h2',
  'headline':   'h3',
  'title':      'h4',
  'body-lg':    'p',
  'body-sm':    'p',
  'label-md':   'span',
  'label-sm':   'span',
};

/**
 * Typographic primitive that maps semantic variant names to the design system's
 * typographic scale. label-md and label-sm use Public Sans; all others use
 * Newsreader. No downstream component should hard-code font or size values.
 */
export default function Type({
  variant,
  as,
  className,
  children,
  style,
}: TypeProps) {
  const Tag = (as ?? defaultTags[variant]) as AsProp;
  const computedStyle: React.CSSProperties = { ...variantStyles[variant], ...style };

  return (
    <Tag className={className} style={computedStyle}>
      {children}
    </Tag>
  );
}
