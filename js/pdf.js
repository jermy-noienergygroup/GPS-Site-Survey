// Map PDF export: a poster-style map page (numbered pins, shaded lots, legend, scale, north arrow)
// followed by summary pages. Map tiles are stitched onto a canvas; pdf-lib (vendored) builds the PDF.
import { summaryText, tally, pinQty, toFt } from './logic.js';

const TILE_URLS = {
  sat: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
  street: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
};
const ATTRIB = { sat: 'Imagery © Esri, Maxar, Earthstar Geographics', street: '© OpenStreetMap contributors' };
const LOT_COLORS = ['#ffb300', '#00acc1', '#8e24aa', '#43a047', '#e53935', '#3949ab', '#f4511e', '#6d4c41'];
const BAD = new Set(['Out', 'Damaged']);
const DPI = 200;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

// ---- Web Mercator helpers (world pixels at zoom z, 256px tiles) ----
function worldX(lng, z) { return ((lng + 180) / 360) * 256 * 2 ** z; }
function worldY(lat, z) {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z;
}
function metresPerWorldPx(lat, z) { return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z; }

function loadTile(url, ms = 9000) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => resolve(null), ms);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); resolve(null); };
    img.src = url;
  });
}

// Andrew's monotone chain convex hull.
function hull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

// ---- Page 1: the map poster, drawn on a canvas ----
async function drawPoster(project, base, onProgress) {
  const pins = project.pins;
  const lats = pins.map((p) => p.lat);
  const lngs = pins.map((p) => p.lng);
  let minLat = Math.min(...lats); let maxLat = Math.max(...lats);
  let minLng = Math.min(...lngs); let maxLng = Math.max(...lngs);
  // Make sure the map covers at least ~80m so a small site isn't absurdly zoomed.
  const midLat = (minLat + maxLat) / 2;
  const minSpanLat = 80 / 111320;
  const minSpanLng = 80 / (111320 * Math.cos((midLat * Math.PI) / 180));
  if (maxLat - minLat < minSpanLat) { const c = (maxLat + minLat) / 2; minLat = c - minSpanLat / 2; maxLat = c + minSpanLat / 2; }
  if (maxLng - minLng < minSpanLng) { const c = (maxLng + minLng) / 2; minLng = c - minSpanLng / 2; maxLng = c + minSpanLng / 2; }

  // Orientation from the site's shape.
  const bw0 = worldX(maxLng, 0) - worldX(minLng, 0);
  const bh0 = worldY(minLat, 0) - worldY(maxLat, 0);
  const landscape = bw0 >= bh0;
  const W = landscape ? 11 * DPI : 8.5 * DPI;
  const H = landscape ? 8.5 * DPI : 11 * DPI;
  const M = 60;
  const headH = 200;
  let map; let legend;
  if (landscape) {
    map = { x: M, y: headH + 40, w: W - 2 * M - 640, h: H - headH - 40 - M };
    legend = { x: map.x + map.w + 36, y: map.y, w: 604, h: map.h };
  } else {
    map = { x: M, y: headH + 40, w: W - 2 * M, h: 1300 };
    legend = { x: M, y: map.y + map.h + 40, w: W - 2 * M, h: H - (map.y + map.h + 40) - M };
  }

  // Continuous zoom that fits the pins (with margin), then pick the tile zoom to draw.
  const fill = 0.84;
  let zc = Math.log2(Math.min((map.w * fill) / bw0, (map.h * fill) / bh0));
  zc = Math.min(zc, 20.5);
  let zt = Math.min(19, Math.ceil(zc));
  let k = 2 ** (zc - zt); // canvas px per tile px (<= 1 normally)
  const cxw = (z) => (worldX(minLng, z) + worldX(maxLng, z)) / 2;
  const cyw = (z) => (worldY(minLat, z) + worldY(maxLat, z)) / 2;
  const tileRange = (z, kk) => {
    const x0 = Math.floor((cxw(z) - map.w / 2 / kk) / 256); const x1 = Math.floor((cxw(z) + map.w / 2 / kk) / 256);
    const y0 = Math.floor((cyw(z) - map.h / 2 / kk) / 256); const y1 = Math.floor((cyw(z) + map.h / 2 / kk) / 256);
    return { x0, x1, y0, y1, n: (x1 - x0 + 1) * (y1 - y0 + 1) };
  };
  let tr = tileRange(zt, k);
  while (tr.n > 160 && zt > 3) { zt -= 1; k *= 2; tr = tileRange(zt, k); }

  const toCanvas = (lat, lng) => [
    map.x + map.w / 2 + (worldX(lng, zt) - cxw(zt)) * k,
    map.y + map.h / 2 + (worldY(lat, zt) - cyw(zt)) * k,
  ];

  // Load tiles.
  const jobs = [];
  for (let x = tr.x0; x <= tr.x1; x++) {
    for (let y = tr.y0; y <= tr.y1; y++) {
      const max = 2 ** zt;
      if (y < 0 || y >= max) continue;
      const wx = ((x % max) + max) % max;
      jobs.push({ x, y, url: TILE_URLS[base](zt, wx, y) });
    }
  }
  let done = 0;
  const imgs = await Promise.all(jobs.map(async (j) => {
    const img = await loadTile(j.url);
    done++;
    if (onProgress) onProgress(`Loading map ${done}/${jobs.length}`);
    return { ...j, img };
  }));
  const loaded = imgs.filter((t) => t.img).length;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const drawMapBackground = (withTiles) => {
    ctx.save();
    roundRect(ctx, map.x, map.y, map.w, map.h, 28);
    ctx.clip();
    ctx.fillStyle = '#e9eef1';
    ctx.fillRect(map.x, map.y, map.w, map.h);
    if (withTiles) {
      for (const t of imgs) {
        if (!t.img) continue;
        const px = map.x + map.w / 2 + (t.x * 256 - cxw(zt)) * k;
        const py = map.y + map.h / 2 + (t.y * 256 - cyw(zt)) * k;
        ctx.drawImage(t.img, px, py, 256 * k + 0.6, 256 * k + 0.6);
      }
      if (base === 'sat') { ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(map.x, map.y, map.w, map.h); }
    } else {
      ctx.strokeStyle = '#d3dbe0';
      ctx.lineWidth = 2;
      for (let gx = map.x; gx < map.x + map.w; gx += 100) { ctx.beginPath(); ctx.moveTo(gx, map.y); ctx.lineTo(gx, map.y + map.h); ctx.stroke(); }
      for (let gy = map.y; gy < map.y + map.h; gy += 100) { ctx.beginPath(); ctx.moveTo(map.x, gy); ctx.lineTo(map.x + map.w, gy); ctx.stroke(); }
    }
    ctx.restore();
  };

  // Page background and header.
  ctx.fillStyle = '#fbf7ee';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#14324a';
  roundRect(ctx, M, M - 20, W - 2 * M, headH - 20, 30);
  ctx.fill();
  ctx.fillStyle = '#ffd54a';
  ctx.fillRect(M + 30, M + headH - 58, W - 2 * M - 60, 8);
  ctx.fillStyle = '#fff';
  ctx.font = `800 76px ${FONT}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(fitText(ctx, project.name, W - 2 * M - 80), M + 40, M + 70);
  const fixtures = pins.reduce((a, p) => a + pinQty(p), 0);
  const first = new Date(Math.min(...pins.map((p) => p.t)));
  ctx.font = `500 38px ${FONT}`;
  ctx.fillStyle = '#cfe0ee';
  ctx.fillText(`Exterior lighting survey  ·  ${first.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}  ·  ${pins.length} pins  ·  ${fixtures}pcs total`, M + 42, M + 128);

  let imagery = loaded > 0;
  drawMapBackground(imagery);
  if (imagery) {
    try { ctx.getImageData(map.x + 5, map.y + 5, 1, 1); } catch { imagery = false; drawMapBackground(false); }
  }

  ctx.save();
  roundRect(ctx, map.x, map.y, map.w, map.h, 28);
  ctx.clip();

  // Lot areas: soft padded shapes with a banner label.
  const lots = project.lots.filter((l) => pins.some((p) => p.lot === l));
  const lotColor = (l) => LOT_COLORS[project.lots.indexOf(l) % LOT_COLORS.length];
  const showLots = lots.length > 1;
  const pad = 46;
  const labels = [];
  if (showLots) {
    for (const lot of lots) {
      const pts = pins.filter((p) => p.lot === lot).map((p) => toCanvas(p.lat, p.lng));
      const h = hull(pts);
      const off = document.createElement('canvas');
      off.width = W; off.height = H;
      const o = off.getContext('2d');
      o.fillStyle = lotColor(lot);
      o.strokeStyle = lotColor(lot);
      o.lineJoin = 'round'; o.lineCap = 'round';
      o.lineWidth = pad * 2;
      o.beginPath();
      h.forEach(([x, y], i) => (i ? o.lineTo(x, y) : o.moveTo(x, y)));
      if (h.length === 1) o.lineTo(h[0][0] + 0.1, h[0][1]);
      if (h.length > 2) o.closePath();
      o.stroke();
      if (h.length > 2) o.fill();
      ctx.globalAlpha = 0.3;
      ctx.drawImage(off, 0, 0);
      ctx.globalAlpha = 1;
      const top = h.reduce((a, b) => (b[1] < a[1] ? b : a), h[0]);
      const cx = h.reduce((a, b) => a + b[0], 0) / h.length;
      labels.push({ text: lot, x: cx, y: top[1] - pad - 6, color: lotColor(lot) });
    }
  }

  // Pins.
  const styleColor = (id) => (project.styles.find((s) => s.id === id) || { color: '#777' }).color;
  const r = pins.length > 150 ? 15 : pins.length > 60 ? 19 : 22;
  for (const p of [...pins].sort((a, b) => a.n - b.n)) {
    const [x, y] = toCanvas(p.lat, p.lng);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 3;
    if (BAD.has(p.cond)) {
      ctx.beginPath(); ctx.arc(x, y, r + 8, 0, Math.PI * 2); ctx.fillStyle = '#d50000'; ctx.fill();
    }
    ctx.beginPath(); ctx.arc(x, y, r + 3.5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.restore();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = p.items.length ? styleColor(p.items[0].s) : '#777';
    ctx.fill();
    if (p.items.length > 1) { // second style shown as a half
      ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, r, -Math.PI / 2, Math.PI / 2); ctx.closePath();
      ctx.fillStyle = styleColor(p.items[1].s); ctx.fill();
    }
    const label = String(p.n);
    ctx.font = `800 ${label.length >= 3 ? r * 0.85 : r * 1.05}px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.strokeText(label, x, y + 1);
    ctx.fillStyle = '#fff'; ctx.fillText(label, x, y + 1);
  }

  // Lot banners on top of pins.
  for (const l of labels) {
    ctx.font = `800 40px ${FONT}`;
    const tw = ctx.measureText(l.text).width;
    const bw = tw + 50; const bh = 64;
    let bx = l.x - bw / 2; let by = l.y - bh;
    bx = Math.max(map.x + 12, Math.min(bx, map.x + map.w - bw - 12));
    by = Math.max(map.y + 12, by);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 4;
    roundRect(ctx, bx, by, bw, bh, 32); ctx.fillStyle = l.color; ctx.fill();
    ctx.restore();
    roundRect(ctx, bx, by, bw, bh, 32); ctx.lineWidth = 5; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(l.text, bx + bw / 2, by + bh / 2 + 2);
  }
  ctx.restore();

  // Map frame.
  roundRect(ctx, map.x, map.y, map.w, map.h, 28);
  ctx.lineWidth = 8; ctx.strokeStyle = '#14324a'; ctx.stroke();

  // North arrow.
  const nx = map.x + 70; const ny = map.y + 80;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 8;
  ctx.beginPath(); ctx.arc(nx, ny, 46, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
  ctx.restore();
  ctx.beginPath(); ctx.moveTo(nx, ny - 34); ctx.lineTo(nx + 18, ny + 18); ctx.lineTo(nx, ny + 8); ctx.lineTo(nx - 18, ny + 18); ctx.closePath();
  ctx.fillStyle = '#14324a'; ctx.fill();
  ctx.font = `800 26px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#c62828'; ctx.fillText('N', nx, ny + 34);

  // Scale bar.
  const mPerPx = metresPerWorldPx(midLat, zt) / k;
  const ftPerPx = mPerPx * 3.28084;
  const nice = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];
  let ft = nice[0];
  for (const n of nice) if (n / ftPerPx <= 300) ft = n;
  const len = ft / ftPerPx;
  const sx = map.x + 34; const sy = map.y + map.h - 40;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.25)'; ctx.shadowBlur = 8;
  roundRect(ctx, sx - 14, sy - 66, len + 140, 86, 18); ctx.fillStyle = 'rgba(255,255,255,0.93)'; ctx.fill();
  ctx.restore();
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = i % 2 ? '#fff' : '#14324a';
    ctx.fillRect(sx + (len / 4) * i, sy - 20, len / 4, 14);
  }
  ctx.strokeStyle = '#14324a'; ctx.lineWidth = 2; ctx.strokeRect(sx, sy - 20, len, 14);
  ctx.fillStyle = '#14324a'; ctx.font = `700 30px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('0', sx - 6, sy - 30);
  ctx.textAlign = 'center';
  ctx.fillText(`${ft} ft`, sx + len, sy - 30);

  // Attribution.
  if (imagery) {
    ctx.font = `500 20px ${FONT}`; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
    const at = ATTRIB[base];
    const aw = ctx.measureText(at).width;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(map.x + map.w - aw - 30, map.y + map.h - 38, aw + 20, 30);
    ctx.fillStyle = '#333';
    ctx.fillText(at, map.x + map.w - 20, map.y + map.h - 16);
  }

  // Legend panel.
  drawLegend(ctx, project, legend, { landscape, showLots, lotColor, lots, imagery, r });
  return { canvas, landscape, imagery };
}

function drawLegend(ctx, project, box, o) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.12)'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 4;
  roundRect(ctx, box.x, box.y, box.w, box.h, 28); ctx.fillStyle = '#fff'; ctx.fill();
  ctx.restore();
  roundRect(ctx, box.x, box.y, box.w, box.h, 28); ctx.lineWidth = 4; ctx.strokeStyle = '#14324a'; ctx.stroke();

  const rows = tally(project, project.pins);
  const lotRows = o.lots.map((l) => {
    const pins = project.pins.filter((p) => p.lot === l);
    return { name: l, pins: pins.length, qty: pins.reduce((a, p) => a + pinQty(p), 0) };
  });
  const bad = project.pins.filter((p) => BAD.has(p.cond)).length;
  const total = project.pins.reduce((a, p) => a + pinQty(p), 0);

  // Size the text to fit.
  const lineCount = rows.length + (o.showLots ? lotRows.length + 2 : 0) + 7 + (bad ? 1 : 0);
  const cols = o.landscape ? 1 : 2;
  const usable = o.landscape ? box.h - 60 : (box.h - 60) * cols;
  const colW = (box.w - 60) / cols;
  let fs = Math.max(22, Math.min(38, Math.floor(usable / (lineCount * 1.7))));
  // Shrink until the longest legend line fits the column width.
  const longest = [
    ...rows.map((s) => `${s.qty}pcs, ${s.name}`),
    `${total}pcs total, ${project.pins.length} pins`,
    bad ? `Red ring = out/damaged (${bad})` : '',
  ];
  const widest = (size) => {
    ctx.font = `600 ${size}px ${FONT}`;
    return Math.max(...longest.map((t) => ctx.measureText(t).width));
  };
  while (fs > 22 && widest(fs) > colW - fs * 1.2 - 10) fs -= 1;
  const lh = fs * 1.55;
  let col = 0;
  let x = box.x + 34;
  let y = box.y + 30;
  const nextLine = (n = 1) => {
    y += lh * n;
    if (!o.landscape && y > box.y + box.h - 40 && col === 0) { col = 1; x = box.x + 34 + colW; y = box.y + 30 + lh; }
  };
  const heading = (t) => {
    ctx.font = `800 ${fs * 1.12}px ${FONT}`; ctx.fillStyle = '#14324a'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    nextLine(); ctx.fillText(t, x, y);
  };
  const dotRow = (color, text, sub, ring) => {
    nextLine();
    const rr = fs * 0.42;
    if (ring) { ctx.beginPath(); ctx.arc(x + rr + 2, y, rr + 6, 0, Math.PI * 2); ctx.fillStyle = '#d50000'; ctx.fill(); }
    ctx.beginPath(); ctx.arc(x + rr + 2, y, rr + 3, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.beginPath(); ctx.arc(x + rr + 2, y, rr, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.stroke();
    ctx.fillStyle = '#111'; ctx.font = `600 ${fs}px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const tx = x + rr * 2 + 20;
    const main = fitText(ctx, text, colW - (tx - x) - 10);
    ctx.fillText(main, tx, y);
    if (sub) {
      const mw = ctx.measureText(main).width;
      ctx.font = `400 ${fs * 0.78}px ${FONT}`; ctx.fillStyle = '#5d6873';
      if (tx + mw + 14 + ctx.measureText(sub).width < x + colW - 10) ctx.fillText(sub, tx + mw + 14, y + 2);
      else { y += fs * 0.95; ctx.fillText(fitText(ctx, sub, colW - (tx - x) - 10), tx, y); }
    }
  };

  heading('Fixtures');
  for (const s of rows) {
    const st = project.styles.find((z) => z.name === s.name);
    dotRow(st ? st.color : '#777', `${s.qty}pcs, ${s.name}`, s.pins !== s.qty ? `${s.pins} location${s.pins === 1 ? '' : 's'}` : '');
  }
  nextLine(0.3);
  ctx.font = `800 ${fs * 1.05}px ${FONT}`; ctx.fillStyle = '#14324a'; ctx.textBaseline = 'middle';
  nextLine(); ctx.fillText(`${total}pcs total, ${project.pins.length} pins`, x, y);

  if (o.showLots) {
    nextLine(0.4);
    heading('Lots');
    for (const l of lotRows) {
      nextLine();
      ctx.fillStyle = o.lotColor(l.name);
      roundRect(ctx, x, y - fs * 0.45, fs * 0.95, fs * 0.9, 8); ctx.fill();
      ctx.fillStyle = '#111'; ctx.font = `600 ${fs}px ${FONT}`; ctx.textAlign = 'left';
      const t = fitText(ctx, l.name, colW * 0.55);
      const tw = ctx.measureText(t).width;
      ctx.fillText(t, x + fs * 1.4, y);
      ctx.font = `400 ${fs * 0.85}px ${FONT}`; ctx.fillStyle = '#5d6873';
      ctx.fillText(`${l.qty}pcs, ${l.pins} pin${l.pins === 1 ? '' : 's'}`, x + fs * 1.4 + tw + 16, y + 1);
    }
  }

  nextLine(0.4);
  heading('Key');
  dotRow('#9aa5ae', 'Number = pin #', 'see list on next page');
  if (bad) dotRow('#9aa5ae', `Red ring = out/damaged (${bad})`, '', true);
  if (!o.imagery) {
    nextLine();
    ctx.font = `600 ${fs * 0.8}px ${FONT}`; ctx.fillStyle = '#c62828'; ctx.textAlign = 'left';
    ctx.fillText(fitText(ctx, 'Map imagery unavailable (offline?)', colW), x, y);
  }
}

// ---- Text pages ----
function makeSafe(font) {
  const cache = new Map();
  return (s) => [...String(s)].map((ch) => {
    if (!cache.has(ch)) {
      try { font.encodeText(ch); cache.set(ch, ch); } catch { cache.set(ch, ch === '📷' ? '' : '?'); }
    }
    return cache.get(ch);
  }).join('');
}

function wrap(text, font, size, maxW) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(t, size) <= maxW || !line) line = t;
    else { lines.push(line); line = w; }
  }
  lines.push(line);
  return lines;
}

export async function buildMapPdf(project, { base = 'sat', onProgress } = {}) {
  if (!project.pins.length) throw new Error('No pins yet');
  const { PDFDocument, StandardFonts, rgb } = await import('./vendor/pdf-lib.esm.min.js');
  const poster = await drawPoster(project, base, onProgress);
  if (onProgress) onProgress('Building PDF…');

  const doc = await PDFDocument.create();
  doc.setTitle(`${project.name} - lighting survey`);
  doc.setCreator('GPS Site Survey');
  const blob = await new Promise((res) => poster.canvas.toBlob(res, 'image/jpeg', 0.9));
  const jpg = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
  const pw = poster.landscape ? 792 : 612;
  const ph = poster.landscape ? 612 : 792;
  doc.addPage([pw, ph]).drawImage(jpg, { x: 0, y: 0, width: pw, height: ph });

  // Summary pages.
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const safe = makeSafe(font);
  const navy = rgb(0.078, 0.196, 0.29);
  const M = 54;
  const size = 10.5;
  const lh = 14.5;
  let page; let y;
  let pageNo = 1;
  const newPage = () => {
    page = doc.addPage([612, 792]);
    pageNo++;
    y = 792 - M;
    page.drawText(safe(project.name), { x: M, y: 792 - 34, size: 9, font, color: rgb(0.4, 0.45, 0.5) });
    page.drawText(`Page ${pageNo}`, { x: 612 - M - 40, y: 34, size: 9, font, color: rgb(0.4, 0.45, 0.5) });
  };
  newPage();
  page.drawText('Survey summary', { x: M, y, size: 20, font: bold, color: navy });
  y -= 30;

  const lines = summaryText(project).split('\n');
  const isHeading = (l, i) => l && !l.startsWith('-') && !l.startsWith(' ') && i > 0 && !/^\d+pcs,/.test(l) && !/^Surveyed /.test(l);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (i === 0) continue; // project name already in header
    if (!raw.trim()) { y -= lh * 0.6; continue; }
    const indent = raw.match(/^ */)[0].length;
    const head = isHeading(raw, i);
    const f = head ? bold : font;
    const sz = head ? 12.5 : size;
    const x = M + indent * 4;
    let text = raw.trim();
    if (head && y < M + 60) newPage();
    if (head) y -= 4;
    if (text.startsWith('- ')) {
      text = text.slice(2);
      if (y < M) newPage();
      page.drawText('•', { x, y, size: sz, font, color: navy });
    }
    const tx = raw.trim().startsWith('- ') ? x + 12 : x;
    for (const w of wrap(safe(text), f, sz, 612 - M - tx)) {
      if (y < M) newPage();
      page.drawText(w, { x: tx, y, size: sz, font: f, color: head ? navy : rgb(0.07, 0.07, 0.07) });
      y -= head ? lh * 1.2 : lh;
    }
  }

  const avgAcc = project.pins.reduce((a, p) => a + p.acc, 0) / project.pins.length;
  y -= lh;
  if (y < M) newPage();
  page.drawText(safe(`Average GPS accuracy ±${toFt(avgAcc)} ft. Pin positions are approximate.`), { x: M, y, size: 9, font, color: rgb(0.4, 0.45, 0.5) });

  return doc.save();
}
