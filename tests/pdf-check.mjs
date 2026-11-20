// Builds map PDFs from a fake mall survey, with stand-in map tiles and with no tiles.
// Run: python3 -m http.server 8765 & node tests/pdf-check.mjs
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

mkdirSync('/tmp/pdf', { recursive: true });
const tilePng = readFileSync('/tmp/pdf/tile.png');
const FAKE_L = readFileSync(new URL('./fake-leaflet.js', import.meta.url), 'utf8');

function fakeProject() {
  const styles = [
    { id: 's1', name: 'Shoebox head', color: '#e6194b' },
    { id: 's2', name: 'Wall pack', color: '#3cb44b' },
    { id: 's3', name: 'Flood', color: '#4363d8' },
    { id: 's4', name: 'Decorative post top', color: '#f58231' },
  ];
  const pins = [];
  let n = 1;
  const t0 = Date.parse('2026-11-20T09:30:00-05:00');
  const add = (lot, lat, lng, items, extra = {}) => pins.push({
    id: 'p' + n, n, lat, lng, acc: 3 + (n % 5), t: t0 + n * 70000, lot, items,
    watt: extra.watt || '', height: extra.height || '', cond: extra.cond || '', notes: extra.notes || '', photoFlag: false, photos: [], ...(n++, {}),
  });
  // Lot A: 4 x 5 grid of poles, mostly double heads
  for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) {
    add('Lot A', 40.0850 + r * 0.00035, -74.2060 + c * 0.00045, [{ s: 's1', q: c % 2 ? 1 : 2 }], { watt: '400W MH', cond: r === 2 && c === 3 ? 'Out' : '' });
  }
  // Lot B: 3 x 6 single heads
  for (let r = 0; r < 3; r++) for (let c = 0; c < 6; c++) {
    add('Lot B', 40.0850 + r * 0.00035, -74.2030 + c * 0.00040, [{ s: 's1', q: 1 }], { watt: '250W MH', cond: r === 0 && c === 5 ? 'Damaged' : '' });
  }
  // Building wall packs along the north edge
  for (let c = 0; c < 9; c++) add('Building', 40.08665, -74.2058 + c * 0.0005, [{ s: 's2', q: 1 }], { height: '14ft' });
  // Entrance: post tops + a flood combo
  add('Entrance', 40.08460, -74.2040, [{ s: 's4', q: 1 }]);
  add('Entrance', 40.08460, -74.2036, [{ s: 's4', q: 1 }]);
  add('Entrance', 40.08455, -74.2032, [{ s: 's3', q: 2 }, { s: 's1', q: 1 }], { notes: 'Sign flood on pole' });
  return { id: 'demo', name: 'Ocean County Mall - Exterior', created: t0, styles, lots: ['Lot A', 'Lot B', 'Building', 'Entrance'], curLot: 'Lot A', pins, nextN: n, lastBackup: null };
}

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true, geolocation: { latitude: 40.085, longitude: -74.205, accuracy: 5 }, permissions: ['geolocation'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.route('https://unpkg.com/**', (r) => (r.request().url().endsWith('.js')
  ? r.fulfill({ contentType: 'text/javascript', body: FAKE_L }) : r.fulfill({ contentType: 'text/css', body: '' })));
let tilesOn = true;
let tileCount = 0;
await page.route('https://server.arcgisonline.com/**', (r) => {
  tileCount++;
  return tilesOn ? r.fulfill({ contentType: 'image/png', body: tilePng, headers: { 'access-control-allow-origin': '*' } }) : r.abort();
});
await page.route('https://tile.openstreetmap.org/**', (r) => r.abort());

await page.goto('http://localhost:8765/');
await page.evaluate((p) => localStorage.setItem('gss.projects.v1', JSON.stringify([p])), fakeProject());
await page.reload();
await page.click('.project');

async function exportPdf(file) {
  await page.click('#survey-menu');
  await page.click('#m-export');
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await page.click('[data-pdf="dl"]');
  const d = await dl;
  await d.saveAs(file);
  await page.click('#x-close');
}
await exportPdf('/tmp/pdf/with-tiles.pdf');
console.log('tiles requested:', tileCount);
// Offline fallback: fresh context so no cached tiles.
{
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errors.push('offline: ' + e.message));
  await p2.route('https://unpkg.com/**', (r) => (r.request().url().endsWith('.js')
    ? r.fulfill({ contentType: 'text/javascript', body: FAKE_L }) : r.fulfill({ contentType: 'text/css', body: '' })));
  await p2.route('https://server.arcgisonline.com/**', (r) => r.abort());
  await p2.goto('http://localhost:8765/');
  await p2.evaluate((p) => localStorage.setItem('gss.projects.v1', JSON.stringify([p])), fakeProject());
  await p2.reload();
  await p2.click('.project');
  await p2.click('#survey-menu');
  await p2.click('#m-export');
  const dl = p2.waitForEvent('download', { timeout: 60000 });
  await p2.click('[data-pdf="dl"]');
  await (await dl).saveAs('/tmp/pdf/no-tiles.pdf');
  await ctx2.close();
}

// Small site, single lot, portrait-ish shape
await page.evaluate(() => {
  const p = JSON.parse(localStorage.getItem('gss.projects.v1'))[0];
  p.id = 'small'; p.name = 'Corner Bank'; p.lots = ['Main lot'];
  p.pins = p.pins.slice(0, 4).map((x, i) => ({ ...x, lot: 'Main lot', lat: 40.08 + i * 0.0002, lng: -74.2 }));
  localStorage.setItem('gss.projects.v1', JSON.stringify([p]));
});
tilesOn = true;
await page.reload();
await page.click('.project');
await exportPdf('/tmp/pdf/small.pdf');

console.log('Errors:', errors.length ? errors : 'none');
await browser.close();
