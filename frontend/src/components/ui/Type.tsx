import React from 'react';
import styles from './Type.module.css';

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

const defaultTags: Record<TypeVariant, AsProp> = {
  'display-lg': 'span',
  'display-sm': 'span',
  'headline':   'span',
  'title':      'span',
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
  const variantClass = styles[variant];
  const combined = [variantClass, className].filter(Boolean).join(' ') || undefined;

  return (
    <Tag className={combined} style={style}>
      {children}
    </Tag>
  );
}
