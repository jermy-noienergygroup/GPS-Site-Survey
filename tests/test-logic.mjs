// Run with: node tests/test-logic.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  newProject, addStyle, summaryText, toCSV, toKML, matchPhotos, readExif, tally, distanceM,
} from '../js/logic.js';

process.env.TZ = 'America/New_York';
let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('ok -', name);
}

// Build a fake mall survey.
const p = newProject('Test Mall', ['Shoebox head', 'Wall pack', 'Flood'], ['Lot A', 'Lot B']);
const [shoe, wall, flood] = p.styles;
const t0 = Date.parse('2026-11-20T10:00:00-05:00');
let n = 1;
const pin = (lot, items, extra = {}, minute = 0, dLat = 0) => {
  const x = { id: 'p' + n, n: n++, lat: 40.08 + dLat, lng: -74.21, acc: 4, t: t0 + minute * 60000, lot, items, watt: '', height: '', cond: '', notes: '', photoFlag: false, photos: [], ...extra };
  p.pins.push(x);
  return x;
};
pin('Lot A', [{ s: shoe.id, q: 2 }], { watt: '400W MH' }, 0);
pin('Lot A', [{ s: shoe.id, q: 2 }], { watt: '400W MH' }, 2, 0.0003);
pin('Lot A', [{ s: shoe.id, q: 1 }, { s: flood.id, q: 1 }], { cond: 'Out', notes: 'arm bent, "check"' }, 4, 0.0006);
pin('Lot B', [{ s: wall.id, q: 1 }], {}, 10, 0.002);
pin('Lot B', [{ s: wall.id, q: 1 }], { photoFlag: true }, 12, 0.0023);

test('tally counts fixtures and locations', () => {
  const rows = tally(p, p.pins);
  assert.deepEqual(rows.map((r) => [r.name, r.qty, r.pins]), [['Shoebox head', 5, 3], ['Wall pack', 2, 2], ['Flood', 1, 1]]);
  assert.deepEqual(rows[0].watts, [{ w: '400W MH', qty: 4 }]);
});

test('summary uses pcs-first style, lots, totals', () => {
  const s = summaryText(p);
  console.log('\n' + s + '\n');
  assert.match(s, /Lot A\n- 5pcs, Shoebox head \(3 locations\)/);
  assert.match(s, /    - 4pcs, 400W MH\n    - 1pcs, wattage not noted/);
  assert.match(s, /Lot B\n2pcs, Wall pack\./);
  assert.match(s, /Totals, all lots/);
  assert.match(s, /Not working or damaged\n- #3, Lot A: 1pcs, Shoebox head\. 1pcs, Flood \(Out\)/);
  assert.doesNotMatch(s, /Shoebox head: \d/);
  assert.ok(s.indexOf('Lot A') < s.indexOf('Lot B'));
});

test('single lot uses plain totals heading', () => {
  const q = newProject('One', ['A']);
  q.pins.push({ id: 'x', n: 1, lat: 1, lng: 1, acc: 3, t: t0, lot: q.lots[0], items: [{ s: q.styles[0].id, q: 3 }], photos: [] });
  const s = summaryText(q);
  assert.match(s, /Totals, Main lot\n- 3pcs, A \(1 location\)/);
  assert.match(s, /1 pin\n/);
});

test('CSV has one row per style per pin and escapes quotes', () => {
  const csv = toCSV(p).split('\r\n');
  assert.equal(csv.length, 1 + 6);
  assert.ok(csv[0].startsWith('pin,lot,qty,style'));
  assert.ok(csv.some((r) => r.includes('"arm bent, ""check"""')));
  const sum = csv.slice(1).reduce((a, r) => a + Number(r.split(',')[2]), 0);
  assert.equal(sum, 8);
});

test('KML is well formed with folders per lot', () => {
  const k = toKML(p);
  assert.equal((k.match(/<Placemark>/g) || []).length, 5);
  assert.equal((k.match(/<Folder>/g) || []).length, 2);
  assert.match(k, /<coordinates>-74\.2100000,40\.0800000,0<\/coordinates>/);
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(k.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')));
});

test('photo matching: no GPS -> latest pin before photo', () => {
  const m = matchPhotos([{ name: 'a.jpg', t: t0 + 12.5 * 60000 }], p.pins);
  assert.equal(m[0].pinId, 'p5');
});

test('photo matching: GPS beats time', () => {
  const target = p.pins[0];
  const m = matchPhotos([{ name: 'b.jpg', t: t0 + 3 * 60000, lat: target.lat, lng: target.lng }], p.pins);
  assert.equal(m[0].pinId, 'p1');
});

test('photo matching: far in time and space -> unmatched', () => {
  const m = matchPhotos([{ name: 'c.jpg', t: t0 + 300 * 60000, lat: 41, lng: -75 }], p.pins);
  assert.equal(m[0].pinId, null);
});

test('EXIF reader: time with offset and GPS', () => {
  const b = readFileSync(new URL('./fixtures/gps.jpg', import.meta.url));
  const ex = readExif(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  assert.equal(ex.t, Date.parse('2026-11-20T10:15:30-05:00'));
  assert.ok(Math.abs(ex.lat - (40 + 4 / 60 + 48 / 3600)) < 1e-9);
  assert.ok(Math.abs(ex.lng + (74 + 12 / 60 + 36 / 3600)) < 1e-9);
});

test('EXIF reader: time only, local time', () => {
  const b = readFileSync(new URL('./fixtures/nogps.jpg', import.meta.url));
  const ex = readExif(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  assert.equal(ex.t, new Date('2026-11-20T10:20:00').getTime());
  assert.equal(ex.lat, undefined);
});

test('EXIF reader: non-JPEG returns empty', () => {
  assert.deepEqual(readExif(new Uint8Array([1, 2, 3, 4, 5]).buffer), {});
});

test('distance sanity', () => {
  const d = distanceM(40, -74, 40.001, -74);
  assert.ok(d > 110 && d < 112);
});

test('addStyle de-duplicates', () => {
  const before = p.styles.length;
  addStyle(p, 'shoebox HEAD');
  assert.equal(p.styles.length, before);
});

console.log(`\n${passed} tests passed`);
