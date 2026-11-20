// UI smoke test with Playwright + a stand-in for Leaflet (the sandbox can't reach the CDN).
// Run: python3 -m http.server 8765 & node tests/ui-check.mjs
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import { mkdirSync, readFileSync } from 'node:fs';

const FAKE_L = readFileSync(new URL('./fake-leaflet.js', import.meta.url), 'utf8');

mkdirSync('/tmp/shots', { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  geolocation: { latitude: 40.08, longitude: -74.21, accuracy: 4 }, permissions: ['geolocation'],
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.route('https://unpkg.com/**', (r) => r.request().url().endsWith('.js')
  ? r.fulfill({ contentType: 'text/javascript', body: FAKE_L })
  : r.fulfill({ contentType: 'text/css', body: '' }));
await page.route('https://server.arcgisonline.com/**', (r) => r.abort());

await page.goto('http://localhost:8765/');
await page.screenshot({ path: '/tmp/shots/1-projects.png' });

// New survey
await page.click('#btn-new-project');
await page.fill('#setup-name', 'Ocean Mall exterior');
await page.fill('#setup-style-input', 'Shoebox head, Wall pack, Flood');
await page.click('#setup-style-add');
await page.fill('#setup-lot-input', 'Lot A');
await page.click('#setup-lot-add');
await page.fill('#setup-lot-input', 'Lot B');
await page.press('#setup-lot-input', 'Enter');
await page.screenshot({ path: '/tmp/shots/2-setup.png' });
await page.click('#setup-save');
await page.waitForFunction(() => !document.querySelector('#btn-pin').disabled);
await page.screenshot({ path: '/tmp/shots/3-survey.png' });

// Pin 1: 2 shoebox heads + wattage
await page.click('#btn-pin');
await page.click('.style-btn >> text=Shoebox head');
await page.click('.style-btn >> text=Shoebox head');
await page.click('#ps-more summary');
await page.fill('#ps-watt', '400W MH');
await page.screenshot({ path: '/tmp/shots/4-pin-sheet.png' });
await page.click('#ps-save');

// Pin 2: new style added mid-survey, condition Out, photo flag
await page.click('#btn-pin');
page.once('dialog', (d) => d.dismiss());
await page.click('#ps-newstyle');
await page.fill('#dlg-in', 'Bollard');
await page.click('#dlg-ok');
await page.click('#ps-more summary');
await page.click('#ps-cond button[data-c="Out"]');
await page.check('#ps-photo');
await page.click('#ps-save');

// Switch lot and add pin 3 using recent wattage chip
await page.click('#lot-chip');
await page.click('.dialog .menu-item >> text=Lot B');
await page.click('#btn-pin');
await page.click('.style-btn >> text=Wall pack');
await page.click('#ps-more summary');
await page.click('#ps-watt-recent button');
await page.click('#ps-save');

// List
await page.click('#survey-menu');
await page.click('#m-list');
await page.screenshot({ path: '/tmp/shots/5-list.png', fullPage: false });
const listText = await page.textContent('pre.summary');
await page.click('#l-close');

// Edit pin 1 via list, bump qty
await page.click('#survey-menu');
await page.click('#m-list');
await page.click('.pin-row >> text=#1');
await page.click('[data-p]');
await page.click('#ps-save');

// Photos
await page.click('#survey-menu');
await page.click('#m-photos');
await page.setInputFiles('#file-photos', ['tests/fixtures/gps.jpg', 'tests/fixtures/nogps.jpg']);
await page.waitForSelector('.photo-row');
await page.screenshot({ path: '/tmp/shots/6-photos.png' });
await page.click('#ph-save');

// Export
await page.click('#survey-menu');
await page.click('#m-export');
await page.screenshot({ path: '/tmp/shots/7-export.png' });
const dl = page.waitForEvent('download');
await page.click('[data-dl="kml"]');
const kml = await dl;
const exportText = await page.textContent('pre.summary');

// Persistence across reload
await page.reload();
const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('gss.projects.v1'))[0].pins.length);

console.log('LIST:\n' + listText);
console.log('\nEXPORT SUMMARY:\n' + exportText);
console.log('\nKML file:', kml.suggestedFilename());
console.log('Pins after reload:', persisted);
console.log('Errors:', errors.length ? errors : 'none');
await browser.close();
