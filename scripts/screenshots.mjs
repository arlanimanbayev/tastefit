#!/usr/bin/env node
/**
 * End-to-end check + screenshots (demo mode, no keys needed).
 *
 *   npm run screenshots
 *
 * Starts dev-server.js, drives the UI with Playwright (adds 3 people through the
 * form, plans, re-plans a card and uses the chat box), asserts there is no
 * horizontal scroll or console error, and writes PNGs to docs/screenshots/.
 * Playwright isn't a project dependency: install it globally or set PLAYWRIGHT_MODULE.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/npm-tools/node_modules/playwright', '/usr/local/lib/node_modules/playwright', '/usr/lib/node_modules/playwright'].filter(Boolean);
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* try next */
    }
  }
  throw new Error('Playwright not found. Install it (npm i -g playwright) or set PLAYWRIGHT_MODULE.');
}
const { chromium } = loadPlaywright();

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(root, 'docs', 'screenshots');
mkdirSync(outDir, { recursive: true });
const port = Number(process.env.SHOT_PORT) || 3456;
const base = `http://localhost:${port}`;

const server = spawn(process.execPath, [join(root, 'dev-server.js')], {
  env: { ...process.env, PORT: String(port), RATE_LIMIT: 'off', MOCK_LATENCY_MS: '35', QLOO_API_KEY: '', GEMINI_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('dev server did not start')), 10000);
  server.stdout.on('data', (d) => {
    if (String(d).includes('running at')) {
      clearTimeout(t);
      resolve();
    }
  });
  server.stderr.on('data', (d) => process.stderr.write(d));
});

const failures = [];
const check = (cond, msg) => {
  if (!cond) failures.push(msg);
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
};

const browser = await chromium.launch();
const runs = [
  { device: 'desktop', theme: 'light', viewport: { width: 1440, height: 900 }, scale: 1, buildGroup: true },
  { device: 'desktop', theme: 'dark', viewport: { width: 1440, height: 900 }, scale: 1 },
  { device: 'mobile', theme: 'light', viewport: { width: 390, height: 844 }, scale: 2, buildGroup: true },
  { device: 'mobile', theme: 'dark', viewport: { width: 390, height: 844 }, scale: 2 },
];

async function noHorizontalScroll(page, label, width) {
  // Compare against the configured viewport: on mobile emulation an overflowing
  // page silently widens window.innerWidth instead of scrolling.
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  check(sw <= width && iw <= width, `${label}: no horizontal overflow (scrollWidth ${sw}, innerWidth ${iw}, viewport ${width})`);
}

async function addFavorites(page, personIndex, favs) {
  const person = page.locator(`.person[data-index="${personIndex}"]`);
  for (const [text, kind] of favs) {
    await person.locator('[data-role="kind"]').selectOption(kind);
    const input = person.locator('[data-role="fav-input"]');
    await input.fill(text);
    await input.press('Enter');
  }
}

for (const run of runs) {
  const tag = `${run.device}-${run.theme}`;
  const context = await browser.newContext({ viewport: run.viewport, deviceScaleFactor: run.scale, colorScheme: run.theme, isMobile: run.device === 'mobile', hasTouch: run.device === 'mobile' });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(base);
  await page.evaluate(() => localStorage.clear());

  if (run.buildGroup) {
    // Start from an empty two-person group and build three people through the UI.
    await page.evaluate(() =>
      localStorage.setItem('tastefit-group-v1', JSON.stringify({ city: '', occasion: 'night_out', budget: 2, people: [{ name: '', favorites: [] }, { name: '', favorites: [] }] })),
    );
    await page.reload();
    await page.locator('#city').fill('Chicago');
    await page.locator('.person[data-index="0"] [data-role="name"]').fill('Ana');
    await addFavorites(page, 0, [['Phoebe Bridgers', 'music'], ['Lady Bird', 'film'], ['Ramen', 'food'], ['Normal People', 'book']]);
    await page.locator('.person[data-index="1"] [data-role="name"]').fill('Ben');
    await addFavorites(page, 1, [['Korean food', 'food'], ['Parasite', 'film'], ['NewJeans', 'music']]);
    await page.locator('#add-person').click();
    await page.locator('.person[data-index="2"] [data-role="name"]').fill('Cleo');
    await addFavorites(page, 2, [['Daft Punk', 'music'], ['Blade Runner 2049', 'film'], ['Tacos', 'food']]);
    check((await page.locator('.person').count()) === 3, `${tag}: three people added through the form`);
    check((await page.locator('.chip').count()) === 10, `${tag}: ten favourites added as chips`);
  } else {
    await page.reload();
  }
  await page.waitForFunction(() => document.querySelector('#qloo-pill')?.textContent.includes('Demo data'));
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    document.activeElement?.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: join(outDir, `01-start-${tag}.png`) });
  await noHorizontalScroll(page, `${tag} start`, run.viewport.width);

  // Plan
  await page.locator('#plan-button').click();
  await page.waitForSelector('.trace .tr', { timeout: 10000 });
  if (run.theme === 'light') {
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(outDir, `02-agent-trace-${tag}.png`) });
  }
  await page.waitForSelector('#run .slot-card .pick-name', { timeout: 30000 });
  await page.waitForTimeout(1600); // meter fill animation
  check((await page.locator('#run .slot').count()) === 4, `${tag}: plan has 4 slots`);
  check((await page.locator('#run .meter').count()) === 12, `${tag}: 12 per-person fit meters (4 slots x 3 people)`);
  const reasons = await page.locator('#run .reason').allTextContents();
  check(reasons.every((r) => /Ana|Ben|Cleo/.test(r)), `${tag}: every reason names a person`);
  await noHorizontalScroll(page, `${tag} plan`, run.viewport.width);
  await page.screenshot({ path: join(outDir, `03-plan-${tag}.png`), fullPage: true });
  await page.locator('#night-title').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -80));
  await page.screenshot({ path: join(outDir, `03b-plan-top-${tag}.png`) });

  // Evidence panel
  const firstCard = page.locator('#run .slot').first();
  await firstCard.locator('details.evidence summary').click();
  await page.waitForTimeout(200);
  check(await firstCard.locator('.ev-table').isVisible(), `${tag}: evidence table visible`);
  check((await firstCard.locator('.req').textContent()).includes('/v2/insights'), `${tag}: evidence shows the Qloo request`);
  await noHorizontalScroll(page, `${tag} evidence open`, run.viewport.width);
  await firstCard.screenshot({ path: join(outDir, `04-evidence-${tag}.png`) });

  // Re-plan one card
  const before = await firstCard.locator('.pick-name').textContent();
  await firstCard.locator('.swap input').fill('cheaper, no korean');
  await firstCard.locator('.swap button').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.msg.from-agent')].some((m) => /Swapped|kept/.test(m.textContent)), null, { timeout: 20000 });
  const after = await page.locator('#run .slot').first().locator('.pick-name').textContent();
  check(before !== after, `${tag}: card swap changed dinner (${before} -> ${after})`);
  const others = await page.locator('#run .slot .pick-name').allTextContents();
  check(others.length === 4, `${tag}: still 4 slots after swap`);

  // Chat box
  await page.locator('#chat-input').fill('a lighter film');
  await page.locator('#chat-form button').click();
  await page.waitForFunction(() => document.querySelectorAll('.msg.from-agent').length >= 2 && ![...document.querySelectorAll('.msg.from-agent')].some((m) => m.textContent.includes('…')), null, { timeout: 20000 });
  const lastMsg = await page.locator('.msg.from-agent').last().textContent();
  check(/Swapped film/.test(lastMsg), `${tag}: chat re-plan swapped the film ("${lastMsg.trim().slice(0, 80)}")`);
  await page.waitForTimeout(400);
  await noHorizontalScroll(page, `${tag} after re-plans`, run.viewport.width);
  await page.locator('.chat').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(outDir, `05-replan-${tag}.png`), fullPage: run.device === 'mobile' ? false : true });

  check(errors.length === 0, `${tag}: no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await context.close();
}

await browser.close();
server.kill();
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log(`\nAll checks passed. Screenshots in ${outDir}`);
