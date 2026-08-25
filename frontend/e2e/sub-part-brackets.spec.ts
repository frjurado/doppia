import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Sub-part bracket geometry on the public fragment detail (Component 11 Step 11,
 * M7 regression guard).
 *
 * A sub-part is a *part of* its parent fragment, so its bracket must never start
 * before or end after the parent's. It used to: the stage layout frame applied
 * the selection's beat-precision endpoint filters at beat and sub-beat resolution
 * only, and since the stage grid is chosen from the *stage count* rather than the
 * fragment's precision, a beat-precise fragment whose stages fit measure-granularly
 * — the ordinary case — got whole-measure stage bounds written to the database.
 * Both bracket and sidebar then faithfully rendered the overflow.
 *
 * This is the geometry half of the guard; the unit suites cover the frame
 * arithmetic. It has to run in a browser because the answer depends on real
 * Verovio output: the bracket's left edge is derived from where Verovio actually
 * drew the notehead at the fragment's start beat.
 *
 * The backend is stubbed with `page.route` (same approach as public-read.spec.ts)
 * and `beat-precise.mei` is served as the fragment's MEI, so no live backend or
 * seeded database is needed. That fixture carries `xml:id` and `dur.ppq` — see
 * its header comment for why their absence would make this test pass vacuously.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MEI = readFileSync(join(HERE, 'fixtures', 'beat-precise.mei'), 'utf-8');

const CONCEPT_ID = 'PerfectAuthenticCadence';
const FRAGMENT_ID = 'frag-brackets-001';
const MEI_URL = 'https://mei.test/beat-precise.mei';

/** 3/4 fixture: three beats per bar, so a full measure ends at beat 4.0. */
const MEASURE_END = 4.0;

const common = {
  movement_id: 'mov-brackets',
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
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  composer_name: 'Mozart',
  work_title: 'Piano Sonata',
  work_catalogue_number: 'K. 279',
  movement_number: 2,
  movement_title: 'Andante',
  summary: { version: 1, key: 'C', meter: '3/4', music21_version: null, concepts: [CONCEPT_ID] },
  prose_annotation: null,
  concept_tags: [
    {
      concept_id: CONCEPT_ID,
      is_primary: true,
      name: 'Perfect Authentic Cadence',
      alias: 'PAC',
      hierarchy_path: ['Cadence'],
    },
  ],
  harmony_events: [],
  sub_parts: [],
  mei_url: MEI_URL,
};

// The 279/ii shape that M7 was reported on, transposed onto the fixture:
// the parent runs from m2 beat 3 to m4 beat 1 (stored as the exclusive bound 2.0),
// and two stages tile it.
const PARENT_BEAT_START = 3.0;
const PARENT_BEAT_END = 2.0;

/** Correctly bounded stages: outer edges pinned to the fragment's own. */
const CLAMPED = [
  {
    ...common,
    id: 'sp-a',
    parent_fragment_id: FRAGMENT_ID,
    bar_start: 2,
    bar_end: 2,
    mc_start: 2,
    mc_end: 2,
    beat_start: PARENT_BEAT_START,
    beat_end: MEASURE_END,
  },
  {
    ...common,
    id: 'sp-b',
    parent_fragment_id: FRAGMENT_ID,
    bar_start: 3,
    bar_end: 4,
    mc_start: 3,
    mc_end: 4,
    beat_start: 1.0,
    beat_end: PARENT_BEAT_END,
  },
];

/** The same two stages as M7 wrote them: whole measures, ignoring the beats. */
const OVERFLOWING = CLAMPED.map((sp) => ({ ...sp, beat_start: null, beat_end: null }));

function detail(subParts: unknown[]) {
  return {
    ...common,
    id: FRAGMENT_ID,
    parent_fragment_id: null,
    bar_start: 2,
    bar_end: 4,
    mc_start: 2,
    mc_end: 4,
    beat_start: PARENT_BEAT_START,
    beat_end: PARENT_BEAT_END,
    sub_parts: subParts,
  };
}

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

interface Span {
  left: number;
  right: number;
}
interface Geometry {
  main: Span;
  subs: Span[];
  measures: Array<Span & { id: string }>;
}

/** Render the detail page with the given sub-parts and read the bracket spans. */
async function renderAndMeasure(page: Page, subParts: unknown[]): Promise<Geometry> {
  await page.route('**/api/v1/auth/refresh', (route) =>
    route.fulfill(
      json({ error: { code: 'UNAUTHORIZED', message: 'No active session.', detail: {} } }, 401)
    )
  );
  await page.route(/\/api\/v1\/public\/fragments/, (route) =>
    route.fulfill(json(detail(subParts)))
  );
  await page.route(MEI_URL, (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: MEI })
  );

  await page.goto(`/public/fragments/${FRAGMENT_ID}`);
  // Verovio (real WASM) must finish before any geometry exists.
  await expect(page.locator('[class*="svgPage"] svg .note').first()).toBeAttached({
    timeout: 60_000,
  });
  await page.waitForSelector('[data-testid="fragment-bracket"]', { timeout: 30_000 });

  // Brackets are positioned from a post-paint RAF measurement pass; poll until
  // both sub-part brackets have been projected rather than sleeping a fixed time.
  await expect
    .poll(() => page.locator('[class*="subPartBracket"]').count(), { timeout: 15_000 })
    .toBe(subParts.length);

  return page.evaluate(() => {
    const span = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right) };
    };
    return {
      main: span(document.querySelector('[data-testid="fragment-bracket"]')!),
      subs: [...document.querySelectorAll('[class*="subPartBracket"]')].map(span),
      measures: [...document.querySelectorAll('g.measure')].map((m) => ({
        id: m.id,
        ...span(m),
      })),
    };
  });
}

test('sub-part brackets stay inside their parent, flush at its outer edges', async ({ page }) => {
  const { main, subs, measures } = await renderAndMeasure(page, CLAMPED);
  expect(subs).toHaveLength(2);

  // I7 — outer-edge pinning, exactly: the first stage starts where the fragment
  // starts and the last ends where it ends (1px for rounding).
  expect(Math.abs(subs[0]!.left - main.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(subs[1]!.right - main.right)).toBeLessThanOrEqual(1);

  // I8 — containment: nothing sticks out of the parent on either side.
  for (const sub of subs) {
    expect(sub.left).toBeGreaterThanOrEqual(main.left - 1);
    expect(sub.right).toBeLessThanOrEqual(main.right + 1);
  }

  // The clip is real, not an accident of the fixture's layout: the fragment
  // starts on beat 3 of m2, so its bracket begins well inside that measure.
  const m2 = measures.find((m) => m.id === 'm2')!;
  expect(main.left).toBeGreaterThan(m2.left + 10);
  expect(main.left).toBeLessThan(m2.right);
});

test('measure-level sub-part bounds render the overflow M7 reported', async ({ page }) => {
  // The control that keeps the assertions above from passing vacuously: with the
  // *same* fixture and parent, whole-measure sub-part bounds visibly break out of
  // the parent bracket on both sides. So the geometry above really does follow
  // the stored beats, and a regression that dropped them would be caught.
  const { main, subs } = await renderAndMeasure(page, OVERFLOWING);
  expect(subs[0]!.left).toBeLessThan(main.left);
  expect(subs[1]!.right).toBeGreaterThan(main.right);
});
