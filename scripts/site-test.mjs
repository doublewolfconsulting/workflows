#!/usr/bin/env node
/**
 * Site test: validates build output against site.config.js
 *
 * Runs after `npm run build` in the caller repo, with dist/ served on localhost:3000.
 * Reads site.config.js from the caller repo to derive expected counts and content.
 * Uses data-testid attributes on generated elements for stable selectors.
 *
 * Tests:
 *   All pages  — loads without 4xx/5xx, no JS console errors
 *              — no unreplaced {{PLACEHOLDER}} tokens in rendered HTML
 *   Homepage   — section counts match config (services, clients, testimonials, partners)
 *              — hero h1 contains heroHeadline text
 *              — booking URL link present
 *              — nav anchor links resolve to elements on the page
 *              — contact form is present
 *   FAQ page   — item count matches config
 *              — accordion opens on click (aria-expanded becomes "true")
 *
 * Required: dist/ must be served on http://localhost:3000 before this script runs.
 */

import { chromium } from 'playwright';
import { createRequire } from 'module';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Script lives at _wf/scripts/site-test.mjs; ROOT = caller repo workspace root
const ROOT = join(__dirname, '../..');
const BASE = 'http://localhost:3000';

// Load caller's site.config.js (CommonJS module)
const require = createRequire(import.meta.url);
const cfg = require(join(ROOT, 'site.config.js'));

// --- Assertions -------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label, detail) {
  if (!condition) {
    const msg = detail ? `${label}\n    ${detail}` : label;
    failures.push(msg);
    failed++;
    console.error(`  FAIL  ${label}`);
    if (detail) console.error(`        ${detail}`);
  } else {
    passed++;
    console.log(`  pass  ${label}`);
  }
}

async function assertCount(page, selector, expected, sectionLabel) {
  const actual = await page.locator(selector).count();
  const attr = selector.match(/data-testid="([^"]+)"/)?.[1] || selector;
  assert(
    actual === expected,
    `${sectionLabel}: found ${actual} of ${expected} expected element(s)`,
    actual === 0
      ? `No elements matched ${selector}. Check that data-testid="${attr}" is present on each generated item.`
      : `Count mismatch. If you updated site.config.js this should auto-pass. Check that every generated item carries the attribute.`
  );
}

// --- Page load --------------------------------------------------------------

async function loadPage(browser, url, label) {
  console.log(`\n  ${label} (${url})`);
  const page = await browser.newPage();
  const consoleErrors = [];

  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => {
    consoleErrors.push(`JS exception: ${err.message}`);
  });

  let response;
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch (err) {
    assert(false, `${label}: page navigation failed`, err.message);
    await page.close();
    return null;
  }

  assert(
    response && response.status() < 400,
    `${label}: HTTP status ok (got ${response ? response.status() : 'no response'})`
  );
  assert(
    consoleErrors.length === 0,
    `${label}: no JS console errors`,
    consoleErrors.length > 0 ? consoleErrors.slice(0, 3).join(' | ') : undefined
  );

  // Check for unreplaced placeholders — catches missed build.js replacements silently
  const html = await page.content();
  assert(
    !html.includes('{{'),
    `${label}: no unreplaced placeholders in HTML`,
    'Found "{{" in rendered HTML. A placeholder was not replaced at build time. Check build.js and site.config.js.'
  );

  return page;
}

// --- Homepage tests ---------------------------------------------------------

async function testHomepage(browser) {
  const page = await loadPage(browser, `${BASE}/`, 'Homepage');
  if (!page) return;

  await assertCount(page, '[data-testid="service-card"]',    cfg.services.length,             'Services section');
  await assertCount(page, '[data-testid="client-logo"]',     cfg.clients.length,              'Client logos');
  await assertCount(page, '[data-testid="testimonial-card"]',cfg.testimonials.length,         'Testimonials');
  await assertCount(page, '[data-testid="partner-logo"]',    (cfg.partners || []).length,     'Partner logos');

  // Hero headline
  const h1Text = await page.locator('h1').first().textContent().catch(() => '');
  assert(
    h1Text.includes(cfg.pages.home.heroHeadline),
    `Hero h1 contains expected text`,
    `Expected "${cfg.pages.home.heroHeadline}" in h1, got "${h1Text.trim().slice(0, 80)}"`
  );

  // Booking URL link
  const bookingLinks = await page.locator(`a[href="${cfg.company.bookingUrl}"]`).count();
  assert(
    bookingLinks > 0,
    `Booking URL link present`,
    `No <a href="${cfg.company.bookingUrl}"> found. Check that {{BOOKING_URL}} is replaced correctly in build.js.`
  );

  // Nav anchor links resolve to elements on the page
  const navAnchors = await page.locator('nav a[href^="#"]').all();
  assert(
    navAnchors.length > 0,
    `Nav contains anchor links`,
    'No <a href="#..."> found in <nav>. Check the navbar partial.'
  );
  for (const link of navAnchors) {
    const href = await link.getAttribute('href');
    const id = href.slice(1);
    const targetCount = await page.locator(`#${id}`).count();
    assert(
      targetCount > 0,
      `Nav anchor ${href} resolves to an element on the page`,
      `No element with id="${id}" found. Check that the section with that ID exists in the page HTML.`
    );
  }

  // Contact form
  const formCount = await page.locator('form').count();
  assert(
    formCount > 0,
    `Contact form is present`,
    'No <form> element found on homepage. Check the contact section HTML.'
  );

  await page.close();
}

// --- FAQ tests --------------------------------------------------------------

async function testFaq(browser) {
  const page = await loadPage(browser, `${BASE}/faq`, 'FAQ page');
  if (!page) return;

  await assertCount(page, '[data-testid="faq-item"]', cfg.faqs.length, 'FAQ items');

  // Accordion: click first trigger, panel should expand
  const firstTrigger = page.locator('[data-testid="faq-item"] button.faq-trigger').first();
  const triggerCount = await firstTrigger.count();
  if (triggerCount === 0) {
    assert(false, 'FAQ accordion: trigger button found',
      'No button.faq-trigger found inside [data-testid="faq-item"]. Check that the FAQ trigger button has class "faq-trigger" and the accordion JS targets that class.');
  } else {
    await firstTrigger.click();
    await page.waitForTimeout(400); // allow CSS grid transition to complete

    const ariaExpanded = await firstTrigger.getAttribute('aria-expanded');
    assert(
      ariaExpanded === 'true',
      'FAQ accordion: first item expands on click',
      `aria-expanded is "${ariaExpanded}" after click (expected "true"). Check the FAQ accordion toggle in the site JS.`
    );
  }

  await page.close();
}

// --- Other pages ------------------------------------------------------------

async function testOtherPages(browser) {
  const skip = new Set(['home', 'faq']);
  for (const [key, p] of Object.entries(cfg.pages)) {
    if (skip.has(key)) continue;
    const page = await loadPage(browser, `${BASE}${p.url}`, key);
    if (page) await page.close();
  }
}

// --- Main -------------------------------------------------------------------

async function main() {
  const { services, clients, testimonials, partners, faqs } = cfg;
  console.log('Site test starting...');
  console.log(`Config: ${services.length} services, ${clients.length} clients, ` +
    `${testimonials.length} testimonials, ${(partners || []).length} partners, ${faqs.length} FAQs`);

  const browser = await chromium.launch();
  try {
    await testHomepage(browser);
    await testFaq(browser);
    await testOtherPages(browser);
  } finally {
    await browser.close();
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach((f, i) => console.log(`\n${i + 1}. ${f}`));
    process.exit(1);
  }

  console.log('All tests passed.');
}

main().catch(err => {
  console.error('\nTest runner crashed:', err.message);
  process.exit(1);
});
