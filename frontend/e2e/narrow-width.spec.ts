import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Narrow-width guards for the public reading surfaces (Component 12 Step 12).
 *
 * These lock the commitments `DESIGN.md` § 7 (Responsive Addendum) makes, on
 * the two surfaces the support matrix rates **Full**: the glossary concept
 * page and fragment detail. They exist because the addendum's claims were
 * measured, not assumed, and the topbar redesign (Step 13) plus the
 * design-system pass (Step 14) are about to move this chrome around.
 *
 * What is guarded, and why each one:
 *  - **No horizontal page scroll** at phone widths (§ 7.6). The single most
 *    valuable guard: it is the failure a layout regression produces first.
 *  - **Bracket overlays stay aligned** through the optical downscale (§ 7.6).
 *    Overlays are absolutely-positioned HTML read from post-layout rects
 *    (the CLAUDE.md overlay rule), so a change to how the SVG is sized can
 *    silently desynchronise them from the notation they annotate.
 *  - **The optical-scale contract** (§ 7.6): below the `sm` breakpoint the
 *    Verovio canvas is clamped to MIN_PAGE_WIDTH and CSS-scaled to fit; at
 *    tablet width and above it renders 1:1. This is a recorded design
 *    decision, so a change to MIN_PAGE_WIDTH should fail here and be made
 *    deliberately, with the addendum updated.
 *
 * The backend is stubbed with `page.route` exactly as `public-read.spec.ts`
 * does, and a real MEI fixture is served so the production Verovio WASM
 * actually renders. No live backend or seeded database is needed.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BEAT_MEI = readFileSync(join(HERE, 'fixtures', 'beat-precise.mei'), 'utf-8');

const CONCEPT_ID = 'PerfectAuthenticCadence';
const FRAGMENT_ID = 'frag-narrow-001';
const MEI_URL = 'https://mei.test/beat-precise.mei';

/** Verovio's pageWidth floor — `FragmentNotation.tsx` MIN_PAGE_WIDTH. */
const MIN_PAGE_WIDTH = 480;

const common = {
  movement_id: 'mov-narrow',
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

/** Two stages tiling the parent fragment — the bracket-alignment subject. */
const SUB_PARTS = [
  {
    ...common,
    id: 'sp-a',
    parent_fragment_id: FRAGMENT_ID,
    bar_start: 2,
    bar_end: 2,
    mc_start: 2,
    mc_end: 2,
    beat_start: 3.0,
    beat_end: 4.0,
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
    beat_end: 2.0,
  },
];

const DETAIL = {
  ...common,
  id: FRAGMENT_ID,
  parent_fragment_id: null,
  bar_start: 2,
  bar_end: 4,
  mc_start: 2,
  mc_end: 4,
  beat_start: 3.0,
  beat_end: 2.0,
  sub_parts: SUB_PARTS,
};

const BROWSE_ITEM = { ...DETAIL, sub_parts: undefined };

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

const CONCEPT_EXAMPLES = {
  examples: [BROWSE_ITEM],
  concept_id: CONCEPT_ID,
  include_subtypes: true,
};

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/auth/refresh', (route) =>
    route.fulfill(
      json({ error: { code: 'UNAUTHORIZED', message: 'No active session.', detail: {} } }, 401)
    )
  );
  await page.route(/\/api\/v1\/public\/fragments/, (route) => {
    const isDetail = /\/public\/fragments\/[^/?]+/.test(route.request().url());
    return route.fulfill(json(isDetail ? DETAIL : { items: [BROWSE_ITEM], next_cursor: null }));
  });
  await page.route(/\/api\/v1\/public\/concepts/, (route) => {
    const url = route.request().url();
    if (/\/public\/concepts\/[^/?]+\/examples/.test(url))
      return route.fulfill(json(CONCEPT_EXAMPLES));
    if (/\/public\/concepts\/[^/?]+/.test(url)) return route.fulfill(json(CONCEPT_DETAIL));
    return route.fulfill(json(CONCEPT_INDEX));
  });
  await page.route('**/beat-precise.mei', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: BEAT_MEI })
  );
});

interface Span {
  left: number;
  right: number;
  width: number;
}

interface Layout {
  /** Page scroll width minus client width: > 0 means the page scrolls sideways. */
  hOverflow: number;
  /** Verovio's own canvas width (the SVG's width attribute), in px. */
  canvasWidth: number;
  /** Laid-out SVG width ÷ canvas width: 1 when not optically scaled. */
  cssScale: number;
  svg: Span;
  main: Span[];
  subs: Span[];
}

/** Read the layout facts §7 commits to, after the render has settled. */
async function readLayout(page: Page): Promise<Layout> {
  return page.evaluate(() => {
    const span = (el: Element): { left: number; right: number; width: number } => {
      const b = el.getBoundingClientRect();
      return { left: b.left, right: b.right, width: b.width };
    };
    const svgEl = document.querySelector('[class*="svgPage"] svg') as SVGSVGElement;
    const canvasWidth = parseFloat(svgEl.getAttribute('width') || '0');
    const svg = span(svgEl);
    return {
      hOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      canvasWidth,
      cssScale: svg.width / canvasWidth,
      svg,
      main: Array.from(document.querySelectorAll('[class*="mainBracket"]')).map(span),
      subs: Array.from(document.querySelectorAll('[class*="subPartBracket"]')).map(span),
    };
  });
}

/** Wait for real musical content, then let the resize-driven re-render settle. */
async function waitForNotation(page: Page) {
  await expect(page.locator('[class*="svgPage"] svg .note').first()).toBeAttached({
    timeout: 30_000,
  });
  // The ResizeObserver re-render is debounced 300ms; give it room to land so
  // the geometry read below is the final one.
  await page.waitForTimeout(1000);
}

/** The bracket overlays must annotate the notation they sit above. */
function expectBracketsAligned(layout: Layout) {
  expect(layout.main.length).toBeGreaterThan(0);
  expect(layout.subs.length).toBe(SUB_PARTS.length);

  const main = layout.main[0];
  // The main bracket lies within the rendered score, not beside or beyond it.
  expect(main.left).toBeGreaterThanOrEqual(layout.svg.left - 1);
  expect(main.right).toBeLessThanOrEqual(layout.svg.right + 1);
  expect(main.width).toBeGreaterThan(0);

  // The two stages tile the parent: they start together, end together, and
  // meet in the middle without a visible gap or overlap. The tolerance is
  // 1.5px because the projection from SVG geometry to overlay pixels rounds
  // per-edge; the claim is "no visible seam", not pixel identity.
  const seam = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1.5);
  const [a, b] = layout.subs;
  seam(a.left, main.left);
  seam(b.right, main.right);
  seam(b.left, a.right);
}

const PHONES = [
  { name: '360px', width: 360, height: 740 },
  { name: '390px', width: 390, height: 844 },
];

for (const vp of PHONES) {
  test(`fragment detail at ${vp.name}: no horizontal scroll, brackets aligned`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto(`/public/fragments/${FRAGMENT_ID}`);
    await waitForNotation(page);

    const layout = await readLayout(page);

    // DESIGN.md § 7.6 — the page never scrolls sideways on a phone.
    expect(layout.hOverflow).toBe(0);

    // DESIGN.md § 7.6 — below `sm` the canvas is clamped and optically scaled.
    expect(layout.canvasWidth).toBe(MIN_PAGE_WIDTH);
    expect(layout.cssScale).toBeLessThan(0.95);
    expect(layout.cssScale).toBeGreaterThan(0.4);

    expectBracketsAligned(layout);
  });

  test(`glossary example at ${vp.name}: no horizontal scroll, brackets aligned`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto(`/glossary/${CONCEPT_ID}`);
    await page.getByRole('button', { name: /PAC/i }).first().click();
    await waitForNotation(page);

    const layout = await readLayout(page);
    expect(layout.hOverflow).toBe(0);
    expect(layout.canvasWidth).toBe(MIN_PAGE_WIDTH);
    expect(layout.cssScale).toBeLessThan(0.95);

    expectBracketsAligned(layout);
  });
}

test('fragment detail at tablet width renders 1:1 and stays aligned', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto(`/public/fragments/${FRAGMENT_ID}`);
  await waitForNotation(page);

  const layout = await readLayout(page);
  expect(layout.hOverflow).toBe(0);

  // Above `sm` the canvas is the container, so nothing is optically scaled —
  // the other half of the § 7.6 contract.
  expect(layout.canvasWidth).toBeGreaterThan(MIN_PAGE_WIDTH);
  expect(layout.cssScale).toBeCloseTo(1, 2);

  expectBracketsAligned(layout);
});
