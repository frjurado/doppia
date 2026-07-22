import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Anonymous public read journey (Component 10 Step 14).
 *
 * browse a concept → open a fragment detail → confirm the Verovio render and
 * MIDI controls appear, with no editor affordance reachable.
 *
 * The backend is stubbed with `page.route`: the public browse/detail endpoints
 * return fixed approved data, and the fragment's `mei_url` serves a real MEI
 * fixture so the production Verovio WASM actually renders. No live backend or
 * seeded database is needed.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_MEI = readFileSync(join(HERE, 'fixtures', 'sample.mei'), 'utf-8');

const CONCEPT_ID = 'PerfectAuthenticCadence';
const FRAGMENT_ID = 'frag-e2e-001';
const MEI_URL = 'https://mei.test/fragment.mei';

const BROWSE_ITEM = {
  id: FRAGMENT_ID,
  movement_id: 'mov-e2e',
  bar_start: 1,
  bar_end: 4,
  beat_start: null,
  beat_end: null,
  repeat_context: null,
  status: 'approved',
  primary_concept_id: CONCEPT_ID,
  primary_concept_alias: 'PAC',
  primary_concept_name: 'Perfect Authentic Cadence',
  data_licence: 'CC BY-SA 4.0',
  data_licence_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
  harmony_sources: [],
  preview_url: null,
  created_by: 'user-1',
  updated_at: '2024-01-01T00:00:00Z',
  composer_name: 'Mozart',
  work_title: 'Piano Sonata',
  work_catalogue_number: 'K. 331',
  movement_number: 1,
  movement_title: 'Andante grazioso',
};

const FRAGMENT_DETAIL = {
  id: FRAGMENT_ID,
  movement_id: 'mov-e2e',
  parent_fragment_id: null,
  bar_start: 1,
  bar_end: 4,
  mc_start: 1,
  mc_end: 4,
  beat_start: null,
  beat_end: null,
  repeat_context: null,
  summary: {
    version: 1,
    key: 'C',
    meter: '4/4',
    music21_version: null,
    concepts: [CONCEPT_ID],
  },
  prose_annotation: null,
  data_licence: 'CC BY-SA 4.0',
  data_licence_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
  harmony_sources: [],
  status: 'approved',
  created_by: 'user-1',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  concept_tags: [
    {
      concept_id: CONCEPT_ID,
      is_primary: true,
      name: 'Perfect Authentic Cadence',
      alias: 'PAC',
      hierarchy_path: ['Cadence', 'Authentic Cadence'],
    },
  ],
  harmony_events: [],
  sub_parts: [],
  composer_name: 'Mozart',
  work_title: 'Piano Sonata',
  work_catalogue_number: 'K. 331',
  movement_number: 1,
  movement_title: 'Andante grazioso',
  mei_url: MEI_URL,
  preview_url: null,
};

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

test.beforeEach(async ({ page }) => {
  // Anonymous session: the AuthProvider bootstrap refresh returns 401.
  await page.route('**/api/v1/auth/refresh', (route) =>
    route.fulfill(
      json({ error: { code: 'UNAUTHORIZED', message: 'No active session.', detail: {} } }, 401),
    ),
  );

  // Public browse (list) and detail (single) share a prefix — branch on the URL.
  await page.route(/\/api\/v1\/public\/fragments/, (route) => {
    const isDetail = /\/public\/fragments\/[^/?]+/.test(route.request().url());
    return route.fulfill(json(isDetail ? FRAGMENT_DETAIL : { items: [BROWSE_ITEM], next_cursor: null }));
  });

  // The fragment's signed MEI URL serves a real, renderable MEI fixture.
  await page.route('**/fragment.mei', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: SAMPLE_MEI }),
  );
});

test('anonymous read journey: browse → detail → score + MIDI, no editor affordances', async ({
  page,
}) => {
  // Browse by concept (the deep-link shape the glossary will use).
  await page.goto(`/public/concepts?concept=${CONCEPT_ID}`);

  // The approved fragment appears as a card (a button whose accessible name
  // includes the primary concept alias).
  const card = page.getByRole('button', { name: /PAC/i });
  await expect(card).toBeVisible();

  // Open the fragment detail.
  await card.click();
  await expect(page).toHaveURL(new RegExp(`/public/fragments/${FRAGMENT_ID}`));

  // The production Verovio WASM renders the fragment into the score page
  // container: wait for real musical content (a note glyph) to appear. We assert
  // *attached* rather than pixel-visible because Verovio sizes its SVG from a
  // measured container width, which is 0 under the headless layout — the render
  // itself (Verovio ran, produced notes) is what this journey checks.
  await expect(page.locator('[class*="svgPage"] svg .note').first()).toBeAttached({
    timeout: 30_000,
  });

  // A MIDI transport control is present (play).
  await expect(page.getByRole('button', { name: /play/i })).toBeVisible();

  // No editor affordances are reachable on the public surface.
  await expect(page.getByRole('button', { name: /^edit/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /submit|approve|reject/i })).toHaveCount(0);
});
