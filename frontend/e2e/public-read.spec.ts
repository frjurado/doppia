import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Anonymous public read journey (Component 10 Step 14; extended in Component 11
 * Step 7 to enter through the glossary).
 *
 * Two journeys:
 *  1. browse a concept → open a fragment detail → confirm the Verovio render and
 *     MIDI controls appear, with no editor affordance reachable.
 *  2. the full glossary path (Step 7): glossary index → concept page → expand an
 *     inline example (Verovio + MIDI) → browse the concept's fragments →
 *     fragment detail.
 *
 * The backend is stubbed with `page.route`: the public browse/detail/concept
 * endpoints return fixed approved data, and the fragment's `mei_url` serves a
 * real MEI fixture so the production Verovio WASM actually renders. No live
 * backend or seeded database is needed.
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

// --- Glossary payloads (Step 7) ------------------------------------------------

// The browse-by-domain index: one domain, a small forest whose single root is
// the concept the journey enters. `parent_id: null` marks the top-level entry.
const CONCEPT_INDEX = {
  domains: [
    {
      domain: 'cadences',
      label: 'Cadences',
      nodes: [
        {
          id: CONCEPT_ID,
          name: 'Perfect Authentic Cadence',
          aliases: ['PAC'],
          hierarchy_path: ['Perfect Authentic Cadence'],
          parent_id: null,
          fragment_count: 1,
        },
      ],
    },
  ],
};

// The concept-page payload (Step 1 shape). Non-stub, reviewed definition, no
// neighbours — the journey only needs the page to render and mount its examples.
const CONCEPT_DETAIL = {
  id: CONCEPT_ID,
  name: 'Perfect Authentic Cadence',
  aliases: ['PAC'],
  definition: 'A cadence closing on a root-position tonic with scale degree 1 in the soprano.',
  domain: 'cadences',
  complexity: 'foundational',
  stub: false,
  definition_reviewed: true,
  top_level_taggable: true,
  hierarchy_path: ['Perfect Authentic Cadence'],
  parent: null,
  children: [],
  relationships: [],
};

// The example draw (Step 3/6): the same approved fragment, reusing the browse
// item shape. Expanding its card fetches the full record via /public/fragments.
const CONCEPT_EXAMPLES = {
  examples: [BROWSE_ITEM],
  concept_id: CONCEPT_ID,
  include_subtypes: true,
};

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

test.beforeEach(async ({ page }) => {
  // Anonymous session: the AuthProvider bootstrap refresh returns 401.
  await page.route('**/api/v1/auth/refresh', (route) =>
    route.fulfill(
      json({ error: { code: 'UNAUTHORIZED', message: 'No active session.', detail: {} } }, 401)
    )
  );

  // Public browse (list) and detail (single) share a prefix — branch on the URL.
  await page.route(/\/api\/v1\/public\/fragments/, (route) => {
    const isDetail = /\/public\/fragments\/[^/?]+/.test(route.request().url());
    return route.fulfill(
      json(isDetail ? FRAGMENT_DETAIL : { items: [BROWSE_ITEM], next_cursor: null })
    );
  });

  // Public concept surface (Component 11): index, concept detail, and example
  // draw share the /public/concepts prefix — branch on the URL shape.
  await page.route(/\/api\/v1\/public\/concepts/, (route) => {
    const url = route.request().url();
    if (/\/public\/concepts\/[^/?]+\/examples/.test(url))
      return route.fulfill(json(CONCEPT_EXAMPLES));
    if (/\/public\/concepts\/[^/?]+/.test(url)) return route.fulfill(json(CONCEPT_DETAIL));
    return route.fulfill(json(CONCEPT_INDEX));
  });

  // The fragment's signed MEI URL serves a real, renderable MEI fixture.
  await page.route('**/fragment.mei', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: SAMPLE_MEI })
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

test('glossary journey: index → concept page → example expand → browse → detail', async ({
  page,
}) => {
  // 1. Enter through the browse-by-domain index (Step 7).
  await page.goto('/glossary');
  await expect(page.getByRole('heading', { name: /concept glossary/i, level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: /cadences/i, level: 2 })).toBeVisible();

  // 2. Follow the concept link to its glossary page.
  await page.getByRole('link', { name: /Perfect Authentic Cadence/i }).click();
  await expect(page).toHaveURL(new RegExp(`/glossary/${CONCEPT_ID}`));
  await expect(
    page.getByRole('heading', { name: 'Perfect Authentic Cadence', level: 1 })
  ).toBeVisible();

  // 3. Expand an inline example — the full Verovio render + MIDI mount in place
  //    (the distinctive glossary feature, Step 6). The example card is the only
  //    button naming the concept alias on this page.
  await page.getByRole('button', { name: /PAC/i }).click();
  await expect(page.locator('[class*="svgPage"] svg .note').first()).toBeAttached({
    timeout: 30_000,
  });
  await expect(page.getByRole('button', { name: /play/i })).toBeVisible();

  // 4. Follow the browse link into the concept's approved fragments.
  await page.getByRole('link', { name: /browse fragments tagged/i }).click();
  await expect(page).toHaveURL(new RegExp(`/public/concepts\\?concept=${CONCEPT_ID}`));

  // 5. Open the fragment detail from its card, and confirm it renders.
  const card = page.getByRole('button', { name: /PAC/i });
  await expect(card).toBeVisible();
  await card.click();
  await expect(page).toHaveURL(new RegExp(`/public/fragments/${FRAGMENT_ID}`));
  await expect(page.locator('[class*="svgPage"] svg .note').first()).toBeAttached({
    timeout: 30_000,
  });
});
