/**
 * 検証結果・記事用のスクリーンショットを docs/images/ に保存する。
 *   npm run build && npx vite preview --port 4173 &
 *   node scripts/screenshots.mjs [http://localhost:4173] [撮影名...]
 * Playwright（Chromium）が必要。
 */
import { createRequire } from 'node:module';
// グローバルにインストールされた Playwright も使えるよう require で読み込む
const { chromium } = createRequire(import.meta.url)('playwright');
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:4173';
/** 3 番目以降の引数で撮影するものを絞り込める */
const only = process.argv.slice(3);
const out = 'docs/images';
mkdirSync(out, { recursive: true });

const HILLY_VIEW = { zoom: 15.6, pitch: 72, bearing: 20, center: [143.0365, 42.6735] };

const shots = [
  { name: 'hero', sample: 'hilly-relative.kmz', view: HILLY_VIEW, ui: ['[data-group="basemap"] [data-value="photo"]'] },
  { name: 'terrain-on', sample: 'hilly-relative.kmz', view: HILLY_VIEW },
  { name: 'terrain-off', sample: 'hilly-relative.kmz', view: HILLY_VIEW, ui: ['[data-group="terrain"] [data-value="off"]'] },
  {
    name: 'absolute-terrain-off',
    sample: 'hilly-relative.kmz',
    view: { ...HILLY_VIEW, zoom: 14.8, pitch: 70 },
    ui: ['[data-tab="verify"]', 'input[name="anchor"][value="absolute"]', '[data-group="terrain"] [data-value="off"]'],
  },
  {
    name: 'exaggeration-ground',
    sample: 'hilly-relative.kmz',
    view: HILLY_VIEW,
    ui: ['[data-tab="verify"]'],
    select: { '#exag': '2' },
  },
  {
    name: 'exaggeration-absolute',
    sample: 'hilly-relative.kmz',
    view: HILLY_VIEW,
    ui: ['[data-tab="verify"]', 'input[name="anchor"][value="absolute"]'],
    select: { '#exag': '2' },
  },
  { name: 'pitch-0', sample: 'flat-relative.kmz', view: { zoom: 16, pitch: 0, bearing: 0, center: [143.1018, 42.8808] } },
  { name: 'pitch-75', sample: 'flat-relative.kmz', view: { zoom: 16.4, pitch: 75, bearing: -20, center: [143.1018, 42.8808] } },
  {
    name: 'overlap-off',
    sample: 'multi-wayline-wgs84.kmz',
    view: { zoom: 15.2, pitch: 70, bearing: -60, center: [143.1068, 42.8818] },
    ui: ['[data-tab="verify"]', '#overlap'],
  },
  {
    name: 'overlap-on',
    sample: 'multi-wayline-wgs84.kmz',
    view: { zoom: 15.2, pitch: 70, bearing: -60, center: [143.1068, 42.8818] },
    ui: ['[data-tab="verify"]'],
  },
  { name: 'route-2d', sample: 'hilly-relative.kmz', view: HILLY_VIEW, ui: ['[data-group="route"] [data-value="2d"]'] },
  { name: 'mixed-modes', sample: 'mixed-height-modes.kmz', view: { zoom: 16.6, pitch: 65, bearing: -15, center: [143.1018, 42.885] }, ui: ['#height-labels'] , pre: ['[data-tab="verify"]'] },
  { name: 'wgs84-no-geoid', sample: 'multi-wayline-wgs84.kmz', view: { zoom: 15.8, pitch: 65, bearing: -30, center: [143.1068, 42.8818] }, clearGeoid: true },
  { name: 'mobile', sample: 'hilly-relative.kmz', mobile: true },
];

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
for (const s of shots) {
  if (only.length && !only.includes(s.name)) continue;
  const page = await browser.newPage(
    s.mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 800 } },
  );
  await page.goto(`${base}/?sample=${s.sample}`);
  await page.waitForFunction(() => window.__app?.state?.resolved?.length >= 0 && window.__app.state.mission, null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  for (const sel of s.pre ?? []) await page.click(sel);
  for (const sel of s.ui ?? []) await page.click(sel);
  for (const [sel, v] of Object.entries(s.select ?? {})) await page.selectOption(sel, v);
  if (s.clearGeoid) {
    await page.fill('#geoid', '');
    await page.dispatchEvent('#geoid', 'change');
  }
  if (s.view) await page.evaluate((v) => window.__app.view.map.jumpTo(v), s.view);
  // 5m メッシュは z15 のためタイル数が多く、ソフトウェア描画では読み込みに時間がかかる
  await page.waitForFunction(() => window.__app.view.map.areTilesLoaded(), null, { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${out}/${s.name}.jpg`, type: 'jpeg', quality: 82 });
  console.log('saved', s.name);
  await page.close();
}
await browser.close();
