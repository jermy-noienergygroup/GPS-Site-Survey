// Pure logic: no DOM, no Leaflet. Shared by the app and by tests/test-logic.mjs.

export const FT_PER_M = 3.28084;

export const PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4',
  '#f032e6', '#9a6324', '#469990', '#808000', '#000075', '#e6a700',
];

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function toFt(m) {
  return Math.round(m * FT_PER_M);
}

// Distance in metres between two lat/lng points (haversine).
export function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function newProject(name, styleNames = [], lotNames = []) {
  const p = {
    id: uid(),
    name: name.trim() || 'Untitled survey',
    created: Date.now(),
    styles: [],
    lots: [],
    curLot: null,
    pins: [],
    nextN: 1,
    lastBackup: null,
  };
  styleNames.forEach((s) => addStyle(p, s));
  lotNames.map((l) => l.trim()).filter(Boolean).forEach((l) => addLot(p, l));
  if (!p.lots.length) addLot(p, 'Main lot');
  p.curLot = p.lots[0];
  return p;
}

export function addStyle(project, name) {
  const n = name.trim();
  if (!n) return null;
  const existing = project.styles.find((s) => s.name.toLowerCase() === n.toLowerCase());
  if (existing) return existing;
  const style = { id: uid(), name: n, color: PALETTE[project.styles.length % PALETTE.length] };
  project.styles.push(style);
  return style;
}

export function addLot(project, name) {
  const n = name.trim();
  if (!n) return null;
  if (!project.lots.includes(n)) project.lots.push(n);
  return n;
}

export function styleName(project, id) {
  const s = project.styles.find((x) => x.id === id);
  return s ? s.name : '(deleted style)';
}

export function pinQty(pin) {
  return pin.items.reduce((a, it) => a + it.q, 0);
}

// "2pcs, Shoebox. 1pcs, Flood" for one pin.
export function pinItemsText(project, pin) {
  return pin.items.map((it) => `${it.q}pcs, ${styleName(project, it.s)}`).join('. ');
}

// Count fixtures per style for a set of pins. Returns rows in project style order.
// Each row: { name, qty, pins, watts: [{w, qty}] }
export function tally(project, pins) {
  const rows = new Map();
  for (const pin of pins) {
    for (const it of pin.items) {
      if (!rows.has(it.s)) rows.set(it.s, { name: styleName(project, it.s), qty: 0, pins: 0, watts: new Map() });
      const r = rows.get(it.s);
      r.qty += it.q;
      r.pins += 1;
      const w = (pin.watt || '').trim();
      if (w) r.watts.set(w, (r.watts.get(w) || 0) + it.q);
    }
  }
  const order = project.styles.map((s) => s.id);
  return [...rows.entries()]
    .sort((a, b) => {
      const ia = order.indexOf(a[0]);
      const ib = order.indexOf(b[0]);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    })
    .map(([, r]) => ({ ...r, watts: [...r.watts.entries()].map(([w, qty]) => ({ w, qty })) }));
}

function rowLine(r) {
  let s = `${r.qty}pcs, ${r.name}`;
  if (r.pins !== r.qty) s += ` (${r.pins} location${r.pins === 1 ? '' : 's'})`;
  return s;
}

// Rows as text: single line when few styles, bullets when many.
function rowsText(rows) {
  if (!rows.length) return ['(nothing pinned)'];
  const simple = rows.length <= 3 && rows.every((r) => r.pins === r.qty && r.watts.length === 0);
  if (simple) return [rows.map((r) => `${r.qty}pcs, ${r.name}.`).join(' ')];
  const out = [];
  for (const r of rows) {
    out.push(`- ${rowLine(r)}`);
    const unknown = r.qty - r.watts.reduce((a, x) => a + x.qty, 0);
    if (r.watts.length) {
      for (const x of r.watts) out.push(`    - ${x.qty}pcs, ${x.w}`);
      if (unknown > 0) out.push(`    - ${unknown}pcs, wattage not noted`);
    }
  }
  return out;
}

export function fmtTime(t) {
  const d = new Date(t);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function pinDetailLine(project, pin) {
  const parts = [`#${pin.n}`, pinItemsText(project, pin)];
  if (pin.watt) parts.push(pin.watt);
  if (pin.height) parts.push(`height ${pin.height}`);
  if (pin.cond) parts.push(pin.cond);
  if (pin.notes) parts.push(`"${pin.notes}"`);
  if (pin.photos && pin.photos.length) parts.push(`photos: ${pin.photos.map((p) => p.name).join(', ')}`);
  else if (pin.photoFlag) parts.push('photo taken (not matched yet)');
  if (!pin.items.length && !pin.notes) parts.push('(empty pin)');
  return parts.join(' | ');
}

// Full text summary in the pcs-first house style.
export function summaryText(project) {
  const lines = [];
  lines.push(project.name);
  const times = project.pins.map((p) => p.t);
  if (times.length) {
    const d = new Date(Math.min(...times));
    lines.push(`Surveyed ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}, ${project.pins.length} pin${project.pins.length === 1 ? '' : 's'}`);
  }
  lines.push('');
  const lotsUsed = project.lots.filter((l) => project.pins.some((p) => p.lot === l));
  const multiLot = lotsUsed.length > 1;
  if (multiLot) {
    for (const lot of lotsUsed) {
      const pins = project.pins.filter((p) => p.lot === lot);
      lines.push(lot);
      lines.push(...rowsText(tally(project, pins)));
      lines.push('');
    }
  }
  lines.push(multiLot ? 'Totals, all lots' : `Totals${lotsUsed[0] ? `, ${lotsUsed[0]}` : ''}`);
  lines.push(...rowsText(tally(project, project.pins)));

  const attention = project.pins.filter((p) => p.cond && p.cond !== 'Working');
  if (attention.length) {
    lines.push('');
    lines.push('Not working or damaged');
    for (const p of attention) lines.push(`- #${p.n}, ${p.lot}: ${pinItemsText(project, p)} (${p.cond})`);
  }

  lines.push('');
  lines.push('Pin details');
  const lotOrder = (l) => project.lots.indexOf(l);
  const sorted = [...project.pins].sort((a, b) => lotOrder(a.lot) - lotOrder(b.lot) || a.n - b.n);
  let cur = null;
  for (const p of sorted) {
    if (multiLot && p.lot !== cur) {
      cur = p.lot;
      lines.push(cur);
    }
    lines.push(`- ${pinDetailLine(project, p)}`);
  }
  return lines.join('\n');
}

function csvCell(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// One row per fixture style per pin, so a spreadsheet SUM on qty gives real counts.
export function toCSV(project) {
  const head = ['pin', 'lot', 'qty', 'style', 'lat', 'lng', 'accuracy_ft', 'time', 'wattage', 'height', 'condition', 'notes', 'photos'];
  const rows = [head];
  for (const p of project.pins) {
    const common = (q, s) => [
      p.n, p.lot, q, s, p.lat.toFixed(7), p.lng.toFixed(7), toFt(p.acc), new Date(p.t).toISOString(),
      p.watt || '', p.height || '', p.cond || '', p.notes || '', (p.photos || []).map((x) => x.name).join(' '),
    ];
    if (!p.items.length) rows.push(common(0, ''));
    for (const it of p.items) rows.push(common(it.q, styleName(project, it.s)));
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

function xml(s) {
  return String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

// KML colour is aabbggrr.
function kmlColor(hex) {
  const h = hex.replace('#', '');
  return `ff${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`;
}

export function toKML(project) {
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<kml xmlns="http://www.opengis.net/kml/2.2"><Document>');
  out.push(`<name>${xml(project.name)}</name>`);
  for (const s of project.styles) {
    out.push(`<Style id="s${s.id}"><IconStyle><color>${kmlColor(s.color)}</color><scale>1.0</scale>` +
      '<Icon><href>http://maps.google.com/mapfiles/kml/paddle/wht-blank.png</href></Icon></IconStyle></Style>');
  }
  out.push('<Style id="empty"><IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/paddle/wht-blank.png</href></Icon></IconStyle></Style>');
  for (const lot of project.lots) {
    const pins = project.pins.filter((p) => p.lot === lot);
    if (!pins.length) continue;
    out.push(`<Folder><name>${xml(lot)}</name>`);
    for (const p of pins) {
      const styleRef = p.items.length ? `s${p.items[0].s}` : 'empty';
      const desc = [
        pinItemsText(project, p) || '(no fixture)',
        p.watt && `Wattage: ${p.watt}`,
        p.height && `Height: ${p.height}`,
        p.cond && `Condition: ${p.cond}`,
        p.notes && `Notes: ${p.notes}`,
        p.photos && p.photos.length && `Photos: ${p.photos.map((x) => x.name).join(', ')}`,
        `GPS accuracy: ±${toFt(p.acc)}ft`,
        `Time: ${fmtTime(p.t)}`,
      ].filter(Boolean).join('<br/>');
      out.push(`<Placemark><name>#${p.n} ${xml(p.items.map((it) => `${it.q}pcs ${styleName(project, it.s)}`).join(', '))}</name>` +
        `<description><![CDATA[${desc}]]></description><styleUrl>#${styleRef}</styleUrl>` +
        `<Point><coordinates>${p.lng.toFixed(7)},${p.lat.toFixed(7)},0</coordinates></Point></Placemark>`);
    }
    out.push('</Folder>');
  }
  out.push('</Document></kml>');
  return out.join('\n');
}

// Match photos (from the camera roll) to pins by time, and by GPS when the photo still has it.
// photos: [{name, t, lat?, lng?}]  -> [{name, t, pinId|null, how}]
export function matchPhotos(photos, pins, windowMin = 20) {
  const win = windowMin * 60000;
  return photos.map((ph) => {
    const near = pins.filter((p) => Math.abs(p.t - ph.t) <= win);
    const hasGps = Number.isFinite(ph.lat) && Number.isFinite(ph.lng);
    if (hasGps) {
      const pool = near.length ? near : pins;
      let best = null;
      let bestD = Infinity;
      for (const p of pool) {
        const d = distanceM(ph.lat, ph.lng, p.lat, p.lng);
        if (d < bestD) { bestD = d; best = p; }
      }
      if (best && (near.length || bestD <= 30)) {
        return { ...ph, pinId: best.id, how: `GPS, ${toFt(bestD)}ft away` };
      }
    }
    if (near.length) {
      // You pin first, then take the photo: prefer the latest pin at or before the photo.
      const before = near.filter((p) => p.t <= ph.t).sort((a, b) => b.t - a.t);
      const best = before[0] || near.sort((a, b) => Math.abs(a.t - ph.t) - Math.abs(b.t - ph.t))[0];
      const mins = Math.round(Math.abs(best.t - ph.t) / 60000);
      return { ...ph, pinId: best.id, how: `time, ${mins < 1 ? '<1' : mins} min apart` };
    }
    return { ...ph, pinId: null, how: 'No pin nearby in time. Pick one below if you know it.' };
  });
}

// ---- Minimal EXIF reader for JPEG: DateTimeOriginal, OffsetTimeOriginal, GPS. ----
// Returns {t?: ms, lat?, lng?}. Anything missing is left out.
export function readExif(buffer) {
  const v = new DataView(buffer);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return {};
  let off = 2;
  while (off + 4 <= v.byteLength) {
    const marker = v.getUint16(off);
    if ((marker & 0xff00) !== 0xff00) return {};
    const len = v.getUint16(off + 2);
    if (marker === 0xffe1 && off + 10 <= v.byteLength &&
        v.getUint32(off + 4) === 0x45786966 /* Exif */) {
      return parseTiff(v, off + 10);
    }
    if (marker === 0xffda) return {}; // start of scan, no EXIF found
    off += 2 + len;
  }
  return {};
}

function parseTiff(v, start) {
  const le = v.getUint16(start) === 0x4949;
  const u16 = (o) => v.getUint16(start + o, le);
  const u32 = (o) => v.getUint32(start + o, le);
  const inRange = (o, n) => start + o + n <= v.byteLength;

  function readIfd(o) {
    const tags = {};
    if (!inRange(o, 2)) return tags;
    const count = u16(o);
    for (let i = 0; i < count; i++) {
      const e = o + 2 + i * 12;
      if (!inRange(e, 12)) break;
      tags[u16(e)] = { type: u16(e + 2), count: u32(e + 4), valOff: e + 8 };
    }
    return tags;
  }
  function ascii(tag) {
    if (!tag) return null;
    const o = tag.count > 4 ? u32(tag.valOff) : tag.valOff;
    if (!inRange(o, tag.count)) return null;
    let s = '';
    for (let i = 0; i < tag.count; i++) {
      const c = v.getUint8(start + o + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  function rationals(tag) {
    if (!tag) return null;
    const o = u32(tag.valOff);
    if (!inRange(o, tag.count * 8)) return null;
    const out = [];
    for (let i = 0; i < tag.count; i++) {
      const den = u32(o + i * 8 + 4);
      out.push(den ? u32(o + i * 8) / den : 0);
    }
    return out;
  }

  const result = {};
  const ifd0 = readIfd(u32(4));
  if (ifd0[0x8769]) {
    const exif = readIfd(u32(ifd0[0x8769].valOff));
    const dt = ascii(exif[0x9003]) || ascii(ifd0[0x0132]);
    const tz = ascii(exif[0x9011]);
    const m = dt && dt.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
      const t = tz && /^[+-]\d{2}:\d{2}$/.test(tz) ? Date.parse(iso + tz) : new Date(iso).getTime();
      if (Number.isFinite(t)) result.t = t;
    }
  }
  if (ifd0[0x8825]) {
    const gps = readIfd(u32(ifd0[0x8825].valOff));
    const lat = rationals(gps[2]);
    const lng = rationals(gps[4]);
    const latRef = ascii(gps[1]);
    const lngRef = ascii(gps[3]);
    if (lat && lng && lat.length === 3 && lng.length === 3) {
      let la = lat[0] + lat[1] / 60 + lat[2] / 3600;
      let lo = lng[0] + lng[1] / 60 + lng[2] / 3600;
      if (latRef === 'S') la = -la;
      if (lngRef === 'W') lo = -lo;
      if (la !== 0 || lo !== 0) { result.lat = la; result.lng = lo; }
    }
  }
  return result;
}

export function safeFileName(s) {
  return (s || 'survey').replace(/[^a-z0-9-_ ]/gi, '').trim().replace(/\s+/g, '-') || 'survey';
}
