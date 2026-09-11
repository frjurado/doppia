/**
 * apiErrorMessage — resolving an API error to readable text (Step 19b).
 *
 * The `t` stub mirrors i18next's contract in the one respect that matters
 * here: a missing key comes back as the key itself. That is what lets an
 * unmapped backend code degrade to the fallback instead of rendering
 * "errors:codes.SOMETHING_NEW" to a reader.
 */

import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { ApiError } from '../api';
import { apiErrorMessage } from '../errorMessage';

const STRINGS: Record<string, string> = {
  'errors:unexpected': 'An unexpected error occurred.',
  'errors:codes.FORBIDDEN': 'You do not have permission to do this.',
  'errors:codes.FRAGMENT_VALIDATION_ERROR': 'This fragment cannot be saved: {{message}}',
};

const t = ((key: string, opts?: Record<string, unknown>) => {
  const found = STRINGS[key];
  if (found === undefined) return key; // i18next's missing-key behaviour
  return found.replace(/\{\{(\w+)\}\}/g, (_, name) => String(opts?.[name] ?? ''));
}) as unknown as TFunction;

describe('apiErrorMessage', () => {
  it('translates a code with a fixed meaning, ignoring the server prose', () => {
    const err = new ApiError('FORBIDDEN', 'Caller lacks role editor', 403);
    expect(apiErrorMessage(err, t)).toBe('You do not have permission to do this.');
  });

  it('keeps the server detail for codes whose string interpolates it', () => {
    // The specifics — which sub-part, which bar — exist only in the message,
    // and an editor needs them. The translated frame wraps rather than replaces.
    const err = new ApiError(
      'FRAGMENT_VALIDATION_ERROR',
      'Sub-part 0 range [mc 5, mc 9] falls outside the parent',
      422
    );
    expect(apiErrorMessage(err, t)).toBe(
      'This fragment cannot be saved: Sub-part 0 range [mc 5, mc 9] falls outside the parent'
    );
  });

  it('falls back for a code with no string, never showing the key', () => {
    const err = new ApiError('SOME_NEW_BACKEND_CODE', 'raw server prose', 500);
    expect(apiErrorMessage(err, t)).toBe('An unexpected error occurred.');
  });

  it('prefers a surface-specific fallback when one is given', () => {
    const err = new ApiError('SOME_NEW_BACKEND_CODE', 'raw server prose', 500);
    expect(apiErrorMessage(err, t, 'Could not load the fragment.')).toBe(
      'Could not load the fragment.'
    );
  });

  it('falls back for anything that is not an ApiError', () => {
    expect(apiErrorMessage(new TypeError('boom'), t)).toBe('An unexpected error occurred.');
    expect(apiErrorMessage('a string', t, 'Nope.')).toBe('Nope.');
  });
});
