/**
 * Resolving an API error to text a reader can act on.
 *
 * The error envelope carries a `code` and a `message`. The message is written
 * in English at the raise site and is not translated, so surfacing it directly
 * — which every call site used to do — put English in front of a Spanish
 * reader at exactly the moment clarity matters most (Component 12 Step 19b).
 *
 * The code is the stable, translatable part. `errors:codes.<CODE>` carries one
 * string per `ErrorCode` in `backend/models/errors.py`.
 *
 * Some codes carry specifics the reader needs — which sub-part fell outside its
 * parent, which field failed validation — and those live only in the server's
 * message. Those strings interpolate `{{message}}`, so the translated frame
 * wraps the English detail rather than discarding it. Codes with a fixed
 * meaning omit the placeholder and read as fully translated text.
 */

import type { TFunction } from 'i18next';
import { ApiError } from './api';

/**
 * Return a display message for a caught error.
 *
 * @param err       The caught value; anything that is not an `ApiError` falls
 *                  through to `fallback`, since only `ApiError` carries a code.
 * @param t         The `t` function from `useTranslation()`.
 * @param fallback  Message for a non-API error, or for a code with no string
 *                  of its own. Defaults to the generic `errors:unexpected` —
 *                  pass a surface-specific one where that reads better.
 */
export function apiErrorMessage(err: unknown, t: TFunction, fallback?: string): string {
  if (!(err instanceof ApiError)) {
    return fallback ?? t('errors:unexpected');
  }

  const key = `errors:codes.${err.code}`;
  // An unmapped code must not render as the raw key. i18next returns the key
  // itself when a string is missing, so compare against it rather than trusting
  // the lookup — a new backend code then degrades to the fallback instead of
  // showing "errors:codes.SOMETHING_NEW" to a reader.
  const translated = t(key, { message: err.message });
  if (translated === key) {
    return fallback ?? t('errors:unexpected');
  }
  return translated;
}
