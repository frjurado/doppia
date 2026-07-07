/**
 * i18n infrastructure tests (Component 9 Step 25).
 *
 *  - en/es resource files expose an identical key set per namespace (guards the
 *    Step 26 Spanish translation against missing/extra keys).
 *  - The API client injects the active language as Accept-Language (the seam
 *    that drives the backend translation overlay, ADR-006 §6).
 *  - Interpolation and plural keys resolve.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import i18n, { NAMESPACES, changeLanguage, getCurrentLanguage } from '../index';
import { apiFetch } from '../../services/api';

/** Recursively collect dotted key paths from a nested resource object. */
function keyPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...keyPaths(v as Record<string, unknown>, path));
    } else {
      out.push(path);
    }
  }
  return out.sort();
}

describe('locale key parity', () => {
  it.each([...NAMESPACES])('en and es agree on keys for the %s namespace', (ns) => {
    const en = i18n.getResourceBundle('en', ns) as Record<string, unknown>;
    const es = i18n.getResourceBundle('es', ns) as Record<string, unknown>;
    expect(es).toBeTruthy();
    expect(keyPaths(es)).toEqual(keyPaths(en));
  });
});

describe('Accept-Language injection', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await changeLanguage('en');
  });

  it('sends the active language as Accept-Language', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await changeLanguage('es');
    expect(getCurrentLanguage()).toBe('es');

    await apiFetch('/api/v1/ping');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Accept-Language']).toBe('es');
  });
});

describe('interpolation and plurals', () => {
  it('interpolates named values', () => {
    expect(i18n.t('common:movementNumber', { number: 3 })).toBe('Movement 3');
  });

  it('selects plural forms by count', () => {
    expect(i18n.t('browse:workCount', { count: 1 })).toBe('1 work');
    expect(i18n.t('browse:workCount', { count: 4 })).toBe('4 works');
  });
});
