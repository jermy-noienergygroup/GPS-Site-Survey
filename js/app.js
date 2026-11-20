import {
  newProject, addStyle, addLot, uid, toFt, pinItemsText, pinQty, summaryText, toCSV, toKML,
  matchPhotos, readExif, fmtTime, safeFileName, styleName,
} from './logic.js';

const KEY = 'gss.projects.v1';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------- Storage ----------------
let projects = [];
let cur = null; // current project

function load() {
  try { projects = JSON.parse(localStorage.getItem(KEY)) || []; } catch { projects = []; }
}
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(projects));
  } catch (e) {
    toast('Could not save! Phone storage may be full. Export a backup now.', 6000);
  }
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// ---------------- UI helpers ----------------
function show(view) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== view;
  if (view === 'view-survey') {
    requestWake();
    setTimeout(() => map && map.invalidateSize(), 50);
  } else {
    releaseWake();
  }
}

let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function askText(title, placeholder = '', value = '') {
  return new Promise((resolve) => {
    const d = $('#dialog');
    d.innerHTML = `<div class="box"><h3>${esc(title)}</h3>
      <input type="text" id="dlg-in" placeholder="${esc(placeholder)}" value="${esc(value)}" autocomplete="off">
      <div class="btns"><button class="btn" id="dlg-no">Cancel</button><button class="btn primary" id="dlg-ok">OK</button></div></div>`;
    d.hidden = false;
    const inp = $('#dlg-in');
    setTimeout(() => inp.focus(), 50);
    const done = (v) => { d.hidden = true; d.innerHTML = ''; resolve(v); };
    $('#dlg-no').onclick = () => done(null);
    $('#dlg-ok').onclick = () => done(inp.value.trim() || null);
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value.trim() || null); };
  });
}

function confirmBox(msg, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    const d = $('#dialog');
    d.innerHTML = `<div class="box"><h3>${esc(msg)}</h3>
      <div class="btns"><button class="btn" id="dlg-no">Cancel</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" style="width:auto" id="dlg-ok">${esc(okLabel)}</button></div></div>`;
    d.hidden = false;
    const done = (v) => { d.hidden = true; d.innerHTML = ''; resolve(v); };
    $('#dlg-no').onclick = () => done(false);
    $('#dlg-ok').onclick = () => done(true);
  });
}

function chooseFrom(title, options) {
  // options: [{label, value}] -> value or null
  return new Promise((resolve) => {
    const d = $('#dialog');
    d.innerHTML = `<div class="box"><h3>${esc(title)}</h3>
      ${options.map((o, i) => `<button class="menu-item" data-i="${i}">${esc(o.label)}</button>`).join('')}
      <div class="btns"><button class="btn" id="dlg-no">Cancel</button></div></div>`;
    d.hidden = false;
    const done = (v) => { d.hidden = true; d.innerHTML = ''; resolve(v); };
    $('#dlg-no').onclick = () => done(null);
    d.querySelectorAll('[data-i]').forEach((b) => { b.onclick = () => done(options[+b.dataset.i].value); });
  });
}

function openSheet(html) {
  $('#sheet').innerHTML = html;
  $('#sheet').hidden = false;
  $('#scrim').hidden = false;
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#scrim').hidden = true;
  $('#sheet').innerHTML = '';
}
$('#scrim').onclick = () => { /* tapping outside does nothing on purpose: no lost pins */ };

// ---------------- Projects screen ----------------
function renderProjects() {
  const list = $('#project-list');
  const sorted = [...projects].sort((a, b) => (b.updated || b.created) - (a.updated || a.created));
  list.innerHTML = sorted.length ? sorted.map((p) => {
    const fixtures = p.pins.reduce((a, x) => a + pinQty(x), 0);
    return `<button class="project" data-id="${p.id}"><b>${esc(p.name)}</b>
      <span class="muted small">${p.pins.length} pins, ${fixtures} fixtures · started ${new Date(p.created).toLocaleDateString()}</span></button>`;
  }).join('') : '<p class="muted center gap-top">No surveys yet.</p>';
  list.querySelectorAll('.project').forEach((b) => { b.onclick = () => openSurvey(b.dataset.id); });
  show('view-projects');
}
$('#btn-new-project').onclick = () => openSetup(null);
$('#btn-restore').onclick = () => $('#file-restore').click();
$('#file-restore').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const incoming = Array.isArray(data) ? data : [data];
    let n = 0;
    for (const p of incoming) {
      if (!p || !p.id || !Array.isArray(p.pins) || !Array.isArray(p.styles)) continue;
      const i = projects.findIndex((x) => x.id === p.id);
      if (i >= 0) {
        if (!(await confirmBox(`"${p.name}" already exists on this phone. Replace it with the backup?`, 'Replace'))) continue;
        projects[i] = p;
      } else projects.push(p);
      n++;
    }
    save();
    renderProjects();
    toast(n ? `Restored ${n} survey${n > 1 ? 's' : ''}` : 'Nothing restored');
  } catch {
    toast('That file is not a survey backup');
  }
};

// ---------------- Setup screen ----------------
let setupDraft = null;

function openSetup(project) {
  setupDraft = project
    ? { editing: project, name: project.name, styles: project.styles.map((s) => ({ ...s })), lots: [...project.lots] }
    : { editing: null, name: '', styles: [], lots: [] };
  $('#setup-title').textContent = project ? 'Edit survey' : 'New survey';
  $('#setup-name').value = setupDraft.name;
  $('#setup-save').textContent = project ? 'Save' : 'Start surveying';
  $('#setup-delete').hidden = !project;
  renderSetupChips();
  show('view-setup');
}

function usedStyleIds(p) {
  return new Set(p ? p.pins.flatMap((x) => x.items.map((i) => i.s)) : []);
}

function renderSetupChips() {
  const used = usedStyleIds(setupDraft.editing);
  const usedLots = new Set(setupDraft.editing ? setupDraft.editing.pins.map((x) => x.lot) : []);
  $('#setup-styles').innerHTML = setupDraft.styles.map((s, i) => `<span class="chip"><span class="dot" style="background:${s.color || '#999'}"></span>
    ${esc(s.name)}${used.has(s.id) ? '' : `<button class="x" data-si="${i}" aria-label="Remove">×</button>`}</span>`).join('') ||
    '<span class="muted small">No styles yet. Add the ones you expect, like "Shoebox head" or "Wall pack".</span>';
  $('#setup-lots').innerHTML = setupDraft.lots.map((l, i) => `<span class="chip">${esc(l)}${usedLots.has(l) ? '' :
    `<button class="x" data-li="${i}" aria-label="Remove">×</button>`}</span>`).join('') ||
    '<span class="muted small">None: everything goes under "Main lot".</span>';
  document.querySelectorAll('[data-si]').forEach((b) => { b.onclick = () => { setupDraft.styles.splice(+b.dataset.si, 1); renderSetupChips(); }; });
  document.querySelectorAll('[data-li]').forEach((b) => { b.onclick = () => { setupDraft.lots.splice(+b.dataset.li, 1); renderSetupChips(); }; });
}

function setupAddStyle() {
  const inp = $('#setup-style-input');
  // Allow pasting several, comma separated.
  for (const part of inp.value.split(',')) {
    const n = part.trim();
    if (n && !setupDraft.styles.some((s) => s.name.toLowerCase() === n.toLowerCase())) setupDraft.styles.push({ id: null, name: n });
  }
  inp.value = '';
  inp.focus();
  renderSetupChips();
}
function setupAddLot() {
  const inp = $('#setup-lot-input');
  for (const part of inp.value.split(',')) {
    const n = part.trim();
    if (n && !setupDraft.lots.includes(n)) setupDraft.lots.push(n);
  }
  inp.value = '';
  inp.focus();
  renderSetupChips();
}
$('#setup-style-add').onclick = setupAddStyle;
$('#setup-lot-add').onclick = setupAddLot;
$('#setup-style-input').onkeydown = (e) => { if (e.key === 'Enter') setupAddStyle(); };
$('#setup-lot-input').onkeydown = (e) => { if (e.key === 'Enter') setupAddLot(); };
$('#setup-back').onclick = () => (setupDraft.editing ? openSurvey(setupDraft.editing.id) : renderProjects());

$('#setup-save').onclick = () => {
  // Pick up anything typed but not yet added.
  if ($('#setup-style-input').value.trim()) setupAddStyle();
  if ($('#setup-lot-input').value.trim()) setupAddLot();
  const name = $('#setup-name').value.trim();
  if (!name) { toast('Give the survey a name'); $('#setup-name').focus(); return; }
  if (setupDraft.editing) {
    const p = setupDraft.editing;
    p.name = name;
    const keep = setupDraft.styles.filter((s) => s.id).map((s) => s.id);
    p.styles = p.styles.filter((s) => keep.includes(s.id));
    setupDraft.styles.filter((s) => !s.id).forEach((s) => addStyle(p, s.name));
    p.lots = p.lots.filter((l) => setupDraft.lots.includes(l));
    setupDraft.lots.forEach((l) => addLot(p, l));
    if (!p.lots.length) addLot(p, 'Main lot');
    if (!p.lots.includes(p.curLot)) p.curLot = p.lots[0];
    p.updated = Date.now();
    save();
    openSurvey(p.id);
  } else {
    const p = newProject(name, setupDraft.styles.map((s) => s.name), setupDraft.lots);
    p.updated = Date.now();
    projects.push(p);
    save();
    openSurvey(p.id);
  }
};
$('#setup-delete').onclick = async () => {
  const p = setupDraft.editing;
  if (!p) return;
  if (!(await confirmBox(`Delete "${p.name}" and all ${p.pins.length} pins? Export a backup first if you might need it.`, 'Delete', true))) return;
  projects = projects.filter((x) => x.id !== p.id);
  save();
  renderProjects();
};

// ---------------- Map and GPS ----------------
let map = null;
let baseSat;
let baseStreet;
let meMarker;
let accCircle;
let pinLayer;
let follow = true;
let fix = null; // {lat, lng, acc, t}
let gpsError = null;
let watchId = null;

function initMap() {
  if (map || !window.L) return;
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView([40.08, -74.2], 17);
  baseSat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 21, maxNativeZoom: 19, attribution: 'Imagery © Esri',
  });
  baseStreet = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 21, maxNativeZoom: 19, attribution: '© OpenStreetMap',
  });
  baseSat.addTo(map);
  pinLayer = L.layerGroup().addTo(map);
  accCircle = L.circle([0, 0], { radius: 1, color: '#1f6feb', weight: 1, fillOpacity: 0.12, interactive: false });
  meMarker = L.marker([0, 0], { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, zIndexOffset: 1000 });

  const Ctl = L.Control.extend({
    onAdd() {
      const div = L.DomUtil.create('div', 'map-btns');
      div.innerHTML = '<button class="map-btn on" id="btn-follow" title="Follow me">◎</button>' +
        '<button class="map-btn" id="btn-layer" title="Street / satellite">MAP</button>' +
        '<button class="map-btn" id="btn-zin">+</button><button class="map-btn" id="btn-zout">−</button>';
      L.DomEvent.disableClickPropagation(div);
      return div;
    },
  });
  new Ctl({ position: 'topright' }).addTo(map);
  $('#btn-follow').onclick = () => { setFollow(true); if (fix) map.setView([fix.lat, fix.lng], Math.max(map.getZoom(), 19)); };
  $('#btn-layer').onclick = () => {
    if (map.hasLayer(baseSat)) { map.removeLayer(baseSat); baseStreet.addTo(map); $('#btn-layer').textContent = 'SAT'; } else { map.removeLayer(baseStreet); baseSat.addTo(map); $('#btn-layer').textContent = 'MAP'; }
  };
  $('#btn-zin').onclick = () => map.zoomIn();
  $('#btn-zout').onclick = () => map.zoomOut();
  map.on('dragstart', () => setFollow(false));

  // Buttons inside pin popups.
  map.getContainer().addEventListener('click', (e) => {
    const b = e.target.closest('[data-edit]');
    if (b) {
      map.closePopup();
      const pin = cur && cur.pins.find((x) => x.id === b.dataset.edit);
      if (pin) openPinSheet(pin);
    }
  });
}

function setFollow(on) {
  follow = on;
  const b = $('#btn-follow');
  if (b) b.classList.toggle('on', on);
}

function startGps() {
  if (watchId !== null) return;
  if (!('geolocation' in navigator)) { gpsError = 'This browser has no GPS access'; updateGpsUi(); return; }
  watchId = navigator.geolocation.watchPosition((pos) => {
    gpsError = null;
    fix = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, t: Date.now() };
    if (map) {
      meMarker.setLatLng([fix.lat, fix.lng]);
      accCircle.setLatLng([fix.lat, fix.lng]).setRadius(fix.acc);
      if (!map.hasLayer(meMarker)) { meMarker.addTo(map); accCircle.addTo(map); map.setView([fix.lat, fix.lng], 19); }
      else if (follow && !moving) map.panTo([fix.lat, fix.lng], { animate: true });
    }
    updateGpsUi();
  }, (err) => {
    gpsError = err.code === 1 ? 'Location blocked: allow location for this site' : 'GPS error: ' + err.message;
    updateGpsUi();
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}
setInterval(() => updateGpsUi(), 5000);

function gpsQuality(accM) {
  const ft = toFt(accM);
  return ft <= 16 ? 'good' : ft <= 40 ? 'ok' : 'bad';
}

function updateGpsUi() {
  const s = $('#gps-status');
  const btn = $('#btn-pin');
  const sub = $('#pin-sub');
  if (!s) return;
  if (gpsError) {
    s.className = 'gps bad'; s.textContent = 'No GPS';
    btn.disabled = true; sub.textContent = gpsError;
    return;
  }
  if (!fix) { s.className = 'gps bad'; s.textContent = 'Waiting for GPS…'; btn.disabled = true; sub.textContent = 'waiting for GPS'; return; }
  const age = (Date.now() - fix.t) / 1000;
  const ft = toFt(fix.acc);
  if (age > 30) { s.className = 'gps bad'; s.textContent = `GPS stale (${Math.round(age)}s)`; } else {
    s.className = `gps ${gpsQuality(fix.acc)}`; s.textContent = `±${ft} ft`;
  }
  btn.disabled = false;
  sub.textContent = cur ? `${cur.curLot} · ±${ft} ft` : '';
}

function pinIcon(pin) {
  const style = pin.items.length && cur.styles.find((s) => s.id === pin.items[0].s);
  const color = style ? style.color : '#777';
  const size = pin.n >= 100 ? 28 : 24;
  return L.divIcon({ className: '', html: `<div class="pin-num" style="background:${color};width:${size}px;height:${size}px">${pin.n}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

function popupHtml(pin) {
  return `<b>#${pin.n}</b> · ${esc(pin.lot)}<br>${esc(pinItemsText(cur, pin)) || '<i>no fixture</i>'}` +
    `${pin.watt ? `<br>${esc(pin.watt)}` : ''}${pin.height ? `<br>Height ${esc(pin.height)}` : ''}` +
    `${pin.cond ? `<br>${esc(pin.cond)}` : ''}${pin.notes ? `<br>${esc(pin.notes)}` : ''}` +
    `${pin.photos && pin.photos.length ? `<br>📷 ${pin.photos.map((p) => esc(p.name)).join(', ')}` : pin.photoFlag ? '<br>📷 photo taken' : ''}` +
    `<br><span style="color:#666">${fmtTime(pin.t)} · ±${toFt(pin.acc)} ft</span>` +
    `<br><button class="btn" style="margin-top:6px;min-height:36px;padding:4px 14px" data-edit="${pin.id}">Edit</button>`;
}

function drawPins() {
  if (!cur) return;
  if (map) {
    pinLayer.clearLayers();
    for (const pin of cur.pins) {
      L.marker([pin.lat, pin.lng], { icon: pinIcon(pin) }).bindPopup(popupHtml(pin)).addTo(pinLayer);
    }
  }
  const n = cur.pins.length;
  const f = cur.pins.reduce((a, p) => a + pinQty(p), 0);
  $('#pin-count').textContent = `${n} pins · ${f} fixtures`;
}

// ---------------- Survey screen ----------------
function openSurvey(id) {
  cur = projects.find((p) => p.id === id);
  if (!cur) { renderProjects(); return; }
  $('#survey-title').textContent = cur.name;
  $('#lot-chip').textContent = cur.curLot;
  show('view-survey');
  initMap();
  startGps();
  drawPins();
  if (map && !fix && cur.pins.length) {
    map.fitBounds(L.latLngBounds(cur.pins.map((p) => [p.lat, p.lng])), { maxZoom: 19, padding: [30, 30] });
  }
  updateGpsUi();
}
$('#survey-back').onclick = () => { closeSheet(); renderProjects(); };

$('#lot-chip').onclick = async () => {
  const v = await chooseFrom('Pins go to which lot?', [
    ...cur.lots.map((l) => ({ label: (l === cur.curLot ? '✓ ' : '') + l, value: l })),
    { label: '+ New lot', value: '__new' },
  ]);
  if (!v) return;
  let lot = v;
  if (v === '__new') {
    lot = await askText('New lot name', 'e.g. Lot C');
    if (!lot) return;
    addLot(cur, lot);
  }
  cur.curLot = lot;
  $('#lot-chip').textContent = lot;
  touch();
  updateGpsUi();
};

function touch() {
  cur.updated = Date.now();
  save();
}

$('#btn-pin').onclick = () => {
  if (!fix) return;
  // Snapshot the position at the moment of the tap.
  const draft = {
    id: null, lat: fix.lat, lng: fix.lng, acc: fix.acc, t: Date.now(), lot: cur.curLot,
    items: [], watt: '', height: '', cond: '', notes: '', photoFlag: false,
  };
  openPinSheet(draft);
};

// ---------------- Pin sheet ----------------
let draft = null;

function recentValues(field) {
  const seen = [];
  for (let i = cur.pins.length - 1; i >= 0 && seen.length < 6; i--) {
    const v = (cur.pins[i][field] || '').trim();
    if (v && !seen.includes(v)) seen.push(v);
  }
  return seen;
}

function openPinSheet(pin) {
  const isNew = !pin.id;
  draft = JSON.parse(JSON.stringify(pin));
  const accFt = toFt(draft.acc);
  const lowAcc = accFt > 40;
  const title = isNew ? `New pin #${cur.nextN}` : `Pin #${draft.n}`;
  openSheet(`
    <div class="sheet-head"><h2>${title}<span class="sub">${esc(draft.lot)} · ±${accFt} ft${draft.moved ? ' (moved by hand)' : ''}</span></h2>
      ${isNew ? '' : '<button class="btn" id="ps-lot">Lot</button>'}</div>
    <div class="scroll pad">
      ${lowAcc && isNew ? `<p class="small" style="color:var(--red);margin-top:0">Low accuracy (±${accFt} ft). You can move this pin on the map afterward.</p>` : ''}
      <div id="ps-grid" class="style-grid"></div>
      <div id="ps-picked" class="picked"></div>
      <details class="more" id="ps-more" ${draft.watt || draft.height || draft.cond || draft.notes || draft.photoFlag ? 'open' : ''}>
        <summary>More details</summary>
        <div class="inner">
          <label class="field">Wattage / lamp
            <input type="text" id="ps-watt" value="${esc(draft.watt)}" placeholder="e.g. 400W MH" autocomplete="off">
            <div class="seg" id="ps-watt-recent"></div>
          </label>
          <label class="field">Pole or mount height
            <input type="text" id="ps-height" value="${esc(draft.height)}" placeholder="e.g. 25ft" autocomplete="off">
            <div class="seg" id="ps-height-recent"></div>
          </label>
          <div class="field">Condition
            <div class="seg" id="ps-cond">${['Working', 'Out', 'Damaged'].map((c) => `<button data-c="${c}" class="${draft.cond === c ? 'on' : ''}">${c}</button>`).join('')}</div>
          </div>
          <label class="toggle"><input type="checkbox" id="ps-photo" ${draft.photoFlag ? 'checked' : ''}> 📷 I took a photo here</label>
          <label class="field">Notes
            <textarea id="ps-notes" rows="3" placeholder="Anything else (use the keyboard mic to dictate)">${esc(draft.notes)}</textarea>
          </label>
          ${isNew ? '' : `<button class="btn" id="ps-move" style="width:100%">Move pin on map</button>
          <button class="btn" id="ps-here" style="width:100%;margin-top:8px">Re-pin at my current location</button>
          <button class="btn danger" id="ps-del" style="margin-top:8px">Delete pin</button>`}
        </div>
      </details>
    </div>
    <div class="sheet-foot"><button class="btn" id="ps-cancel">Cancel</button><button class="btn primary" id="ps-save">Save</button></div>`);
  renderStylePicker();
  renderRecent('watt', '#ps-watt', '#ps-watt-recent');
  renderRecent('height', '#ps-height', '#ps-height-recent');

  $('#ps-watt').oninput = (e) => { draft.watt = e.target.value; };
  $('#ps-height').oninput = (e) => { draft.height = e.target.value; };
  $('#ps-notes').oninput = (e) => { draft.notes = e.target.value; updateSaveBtn(); };
  $('#ps-photo').onchange = (e) => { draft.photoFlag = e.target.checked; };
  $('#ps-cond').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      draft.cond = draft.cond === b.dataset.c ? '' : b.dataset.c;
      $('#ps-cond').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.c === draft.cond));
    };
  });
  $('#ps-cancel').onclick = async () => {
    if (isNew && (draft.items.length || draft.notes) && !(await confirmBox('Discard this pin?', 'Discard', true))) return;
    closeSheet();
  };
  $('#ps-save').onclick = () => savePin(isNew);
  if (!isNew) {
    $('#ps-del').onclick = async () => {
      if (!(await confirmBox(`Delete pin #${draft.n}?`, 'Delete', true))) return;
      cur.pins = cur.pins.filter((p) => p.id !== draft.id);
      touch(); drawPins(); closeSheet(); toast(`Pin #${draft.n} deleted`);
    };
    $('#ps-move').onclick = () => { const id = draft.id; savePin(false, true); startMove(id); };
    $('#ps-here').onclick = async () => {
      if (!fix) { toast('No GPS fix yet'); return; }
      if (!(await confirmBox(`Move pin #${draft.n} to where you are standing now (±${toFt(fix.acc)} ft)?`, 'Move'))) return;
      draft.lat = fix.lat; draft.lng = fix.lng; draft.acc = fix.acc; draft.moved = false;
      savePin(false);
    };
    $('#ps-lot').onclick = async () => {
      const v = await chooseFrom(`Pin #${draft.n} belongs to`, cur.lots.map((l) => ({ label: (l === draft.lot ? '✓ ' : '') + l, value: l })));
      if (v) { draft.lot = v; $('.sheet-head .sub').textContent = `${v} · ±${accFt} ft`; }
    };
  }
  updateSaveBtn();
}

function renderRecent(field, inputSel, boxSel) {
  const vals = recentValues(field);
  const box = $(boxSel);
  box.innerHTML = vals.map((v) => `<button type="button">${esc(v)}</button>`).join('');
  box.querySelectorAll('button').forEach((b) => {
    b.onclick = (e) => { e.preventDefault(); $(inputSel).value = b.textContent; draft[field] = b.textContent; };
  });
}

function renderStylePicker() {
  const counts = new Map(draft.items.map((it) => [it.s, it.q]));
  $('#ps-grid').innerHTML = cur.styles.map((s) => {
    const q = counts.get(s.id);
    return `<button class="style-btn ${q ? 'sel' : ''}" style="--c:${s.color}" data-s="${s.id}">${esc(s.name)}${q ? `<span class="badge">${q}</span>` : ''}</button>`;
  }).join('') + '<button class="style-btn add" id="ps-newstyle">+ New style</button>';
  $('#ps-grid').querySelectorAll('[data-s]').forEach((b) => { b.onclick = () => bump(b.dataset.s, 1); });
  $('#ps-newstyle').onclick = async () => {
    const name = await askText('New fixture or pole style', 'e.g. Double-head shoebox');
    if (!name) return;
    const s = addStyle(cur, name);
    touch();
    bump(s.id, 1);
  };
  $('#ps-picked').innerHTML = draft.items.length ? draft.items.map((it) => `
    <div class="picked-row"><span class="name">${esc(styleName(cur, it.s))}</span>
      <button class="step" data-m="${it.s}">−</button><span class="qty">${it.q}pcs</span><button class="step" data-p="${it.s}">+</button></div>`).join('')
    : '<p class="muted small center">Tap a style. Tap again for each extra head at this spot.</p>';
  $('#ps-picked').querySelectorAll('[data-m]').forEach((b) => { b.onclick = () => bump(b.dataset.m, -1); });
  $('#ps-picked').querySelectorAll('[data-p]').forEach((b) => { b.onclick = () => bump(b.dataset.p, 1); });
}

function bump(styleId, d) {
  const it = draft.items.find((x) => x.s === styleId);
  if (it) it.q += d; else if (d > 0) draft.items.push({ s: styleId, q: d });
  draft.items = draft.items.filter((x) => x.q > 0);
  renderStylePicker();
  updateSaveBtn();
}

function updateSaveBtn() {
  const b = $('#ps-save');
  if (b) b.disabled = !draft.items.length && !draft.notes.trim();
}

function savePin(isNew, keepOpen = false) {
  draft.notes = draft.notes.trim();
  draft.watt = draft.watt.trim();
  draft.height = draft.height.trim();
  if (isNew) {
    draft.id = uid();
    draft.n = cur.nextN++;
    draft.photos = [];
    cur.pins.push(draft);
  } else {
    const i = cur.pins.findIndex((p) => p.id === draft.id);
    if (i >= 0) cur.pins[i] = draft;
  }
  touch();
  drawPins();
  if (!keepOpen) closeSheet();
  if (isNew) toast(`Pin #${draft.n} saved: ${pinItemsText(cur, draft) || 'note only'}`);
}

// ---------------- Move a pin ----------------
let moving = null; // {id, marker}
function startMove(id) {
  closeSheet();
  const pin = cur.pins.find((p) => p.id === id);
  if (!pin) return;
  if (!map) { toast('Map is not loaded, so pins cannot be moved right now'); return; }
  setFollow(false);
  map.setView([pin.lat, pin.lng], Math.max(map.getZoom(), 20));
  const m = L.marker([pin.lat, pin.lng], {
    draggable: true, zIndexOffset: 2000,
    icon: L.divIcon({ className: '', html: '<div class="drag-pin"></div>', iconSize: [30, 30], iconAnchor: [15, 30] }),
  }).addTo(map);
  moving = { id, marker: m };
  $('#move-bar').hidden = false;
}
function endMove(apply) {
  if (!moving) return;
  if (apply) {
    const pin = cur.pins.find((p) => p.id === moving.id);
    const ll = moving.marker.getLatLng();
    if (pin) { pin.lat = ll.lat; pin.lng = ll.lng; pin.moved = true; touch(); toast(`Pin #${pin.n} moved`); }
  }
  map.removeLayer(moving.marker);
  moving = null;
  $('#move-bar').hidden = true;
  drawPins();
}
$('#move-done').onclick = () => endMove(true);
$('#move-cancel').onclick = () => endMove(false);

// ---------------- Menu ----------------
$('#survey-menu').onclick = () => {
  openSheet(`<div class="sheet-head"><h2>${esc(cur.name)}</h2><button class="btn" id="m-close">Close</button></div>
    <div class="scroll pad">
      <button class="menu-item" id="m-list">List and totals<small>Counts by lot, every pin, tap to edit</small></button>
      <button class="menu-item" id="m-photos">Match photos<small>Link camera-roll photos to pins by time and location</small></button>
      <button class="menu-item" id="m-export">Export and backup<small>Summary text, KML for Google Earth, CSV, backup file</small></button>
      <button class="menu-item" id="m-setup">Edit survey<small>Name, styles, lots, delete</small></button>
    </div>`);
  $('#m-close').onclick = closeSheet;
  $('#m-list').onclick = openList;
  $('#m-photos').onclick = openPhotos;
  $('#m-export').onclick = openExport;
  $('#m-setup').onclick = () => { closeSheet(); openSetup(cur); };
};

// ---------------- List ----------------
function openList() {
  const text = summaryText(cur);
  const totalsPart = text.split('\nPin details')[0];
  const lotOrder = (l) => cur.lots.indexOf(l);
  const pins = [...cur.pins].sort((a, b) => lotOrder(a.lot) - lotOrder(b.lot) || b.n - a.n);
  openSheet(`<div class="sheet-head"><h2>List and totals</h2><button class="btn" id="l-close">Close</button></div>
    <div class="scroll pad">
      <pre class="summary">${esc(totalsPart)}</pre>
      <h3>Pins (${pins.length})</h3>
      ${pins.map((p) => `<button class="pin-row" data-id="${p.id}"><b>#${p.n}</b> ${esc(pinItemsText(cur, p) || 'note only')}
        <div class="t">${esc(p.lot)} · ${fmtTime(p.t)}${p.cond ? ' · ' + esc(p.cond) : ''}${p.watt ? ' · ' + esc(p.watt) : ''}${p.notes ? ' · ' + esc(p.notes) : ''}${p.photos && p.photos.length ? ' · 📷' + p.photos.length : p.photoFlag ? ' · 📷?' : ''}</div></button>`).join('')}
    </div>`);
  $('#l-close').onclick = closeSheet;
  $('#sheet').querySelectorAll('.pin-row').forEach((b) => {
    b.onclick = () => {
      const pin = cur.pins.find((p) => p.id === b.dataset.id);
      closeSheet();
      if (map) { setFollow(false); map.setView([pin.lat, pin.lng], Math.max(map.getZoom(), 19)); }
      openPinSheet(pin);
    };
  });
}

// ---------------- Photos ----------------
let photoMatches = [];
function openPhotos() {
  const linked = cur.pins.reduce((a, p) => a + (p.photos ? p.photos.length : 0), 0);
  const flagged = cur.pins.filter((p) => p.photoFlag && !(p.photos && p.photos.length)).length;
  openSheet(`<div class="sheet-head"><h2>Match photos</h2><button class="btn" id="ph-close">Close</button></div>
    <div class="scroll pad">
      <p>Pick the photos you took during this survey. The app reads only each photo's time and location to find its pin. The photos stay in your camera roll.</p>
      <p class="muted small">${linked} photo${linked === 1 ? '' : 's'} linked so far. ${flagged} pin${flagged === 1 ? '' : 's'} marked "took a photo" with no photo linked yet.</p>
      <button class="btn primary big" id="ph-pick">Choose photos</button>
      <div id="ph-results"></div>
    </div>
    <div class="sheet-foot" id="ph-foot" hidden><button class="btn primary" id="ph-save">Save links</button></div>`);
  $('#ph-close').onclick = closeSheet;
  $('#ph-pick').onclick = () => $('#file-photos').click();
}

$('#file-photos').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  $('#ph-results').innerHTML = '<p class="muted">Reading photos…</p>';
  const photos = [];
  for (const f of files) {
    let ex = {};
    try { ex = readExif(await f.slice(0, 256 * 1024).arrayBuffer()); } catch { ex = {}; }
    photos.push({ name: f.name, t: ex.t ?? f.lastModified, fromFile: ex.t === undefined, lat: ex.lat, lng: ex.lng });
  }
  photos.sort((a, b) => a.t - b.t);
  photoMatches = matchPhotos(photos, cur.pins);
  const opts = (sel) => `<option value="">Not linked</option>` + cur.pins.map((p) =>
    `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>#${p.n} ${esc(pinItemsText(cur, p))} (${fmtTime(p.t)})</option>`).join('');
  const anyFile = photos.some((p) => p.fromFile);
  $('#ph-results').innerHTML = (anyFile ? '<p class="small" style="color:var(--yellow)">Some photos had no capture time inside, so their file date was used. Double-check those.</p>' : '') +
    photoMatches.map((m, i) => `<div class="photo-row"><b>${esc(m.name)}</b> <span class="muted small">${fmtTime(m.t)}${m.fromFile ? ' (file date)' : ''}</span>
      <div class="how">${m.pinId ? 'Matched by ' : ''}${esc(m.how)}</div><select data-i="${i}">${opts(m.pinId)}</select></div>`).join('');
  $('#ph-results').querySelectorAll('select').forEach((s) => { s.onchange = () => { photoMatches[+s.dataset.i].pinId = s.value || null; }; });
  $('#ph-foot').hidden = false;
  $('#ph-save').onclick = () => {
    const names = new Set(photoMatches.map((m) => m.name));
    for (const p of cur.pins) p.photos = (p.photos || []).filter((x) => !names.has(x.name));
    let n = 0;
    for (const m of photoMatches) {
      const pin = m.pinId && cur.pins.find((p) => p.id === m.pinId);
      if (pin) { pin.photos.push({ name: m.name, t: m.t }); n++; }
    }
    touch(); drawPins(); closeSheet();
    toast(`${n} photo${n === 1 ? '' : 's'} linked`);
  };
};

// ---------------- Export ----------------
function fileFor(kind) {
  const base = safeFileName(cur.name);
  const stamp = new Date().toISOString().slice(0, 10);
  if (kind === 'kml') return { name: `${base}-${stamp}.kml`, type: 'application/vnd.google-earth.kml+xml', text: toKML(cur) };
  if (kind === 'csv') return { name: `${base}-${stamp}.csv`, type: 'text/csv', text: toCSV(cur) };
  if (kind === 'txt') return { name: `${base}-${stamp}.txt`, type: 'text/plain', text: summaryText(cur) };
  return { name: `${base}-backup-${stamp}.json`, type: 'application/json', text: JSON.stringify(cur) };
}

function download(f) {
  const blob = new Blob([f.bytes || f.text], { type: f.type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = f.name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function share(f) {
  // Some apps reject unusual types; plain text is the safest for sharing.
  const file = new File([f.bytes || f.text], f.name, { type: f.type === 'application/vnd.google-earth.kml+xml' ? 'application/octet-stream' : f.type });
  try {
    await navigator.share({ files: [file], title: f.name });
    return true;
  } catch (e) {
    if (e && e.name === 'AbortError') return true;
    return false;
  }
}

function canShareFiles() {
  try {
    return !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] }));
  } catch { return false; }
}

function openExport() {
  const shareOk = canShareFiles();
  const rows = [
    ['txt', 'Summary (.txt)', 'Your list with totals'],
    ['kml', 'Map file (.kml)', 'Opens in Google Earth or Google My Maps'],
    ['csv', 'Spreadsheet (.csv)', 'One row per fixture style per pin'],
    ['json', 'Backup (.json)', 'Restore this survey on any phone'],
  ];
  openSheet(`<div class="sheet-head"><h2>Export and backup</h2><button class="btn" id="x-close">Close</button></div>
    <div class="scroll pad">
      <div class="list-block"><b>Map PDF</b><div class="muted small">Site map with numbered pins, lots, legend and scale, plus the summary</div>
        <div class="seg" id="x-base"><button data-b="sat" class="on">Satellite</button><button data-b="street">Street map</button></div>
        <div class="row"><button class="btn primary" data-pdf="dl" style="flex:1">Download PDF</button>
        ${shareOk ? '<button class="btn" data-pdf="sh" style="flex:1">Share PDF</button>' : ''}</div></div>
      <div class="row" style="margin-bottom:12px"><button class="btn primary" id="x-copy" style="flex:1">Copy summary</button>
        ${navigator.share ? '<button class="btn" id="x-sharetext" style="flex:1">Share summary text</button>' : ''}</div>
      ${rows.map(([k, label, sub]) => `<div class="list-block"><b>${label}</b><div class="muted small">${sub}</div>
        <div class="row"><button class="btn" data-dl="${k}" style="flex:1">Download</button>
        ${shareOk ? `<button class="btn" data-sh="${k}" style="flex:1">Share</button>` : ''}</div></div>`).join('')}
      <p class="muted small">Last backup: ${cur.lastBackup ? fmtTime(cur.lastBackup) : 'never'}</p>
      <pre class="summary">${esc(summaryText(cur))}</pre>
    </div>`);
  $('#x-close').onclick = closeSheet;
  const markBackup = (k) => { if (k === 'json') { cur.lastBackup = Date.now(); touch(); } };
  $('#sheet').querySelectorAll('[data-dl]').forEach((b) => { b.onclick = () => { download(fileFor(b.dataset.dl)); markBackup(b.dataset.dl); }; });
  $('#sheet').querySelectorAll('[data-sh]').forEach((b) => {
    b.onclick = async () => {
      const f = fileFor(b.dataset.sh);
      if (await share(f)) markBackup(b.dataset.sh); else { toast('Sharing not available, downloading instead'); download(f); markBackup(b.dataset.sh); }
    };
  });
  let pdfBase = 'sat';
  $('#x-base').querySelectorAll('button').forEach((b) => {
    b.onclick = () => { pdfBase = b.dataset.b; $('#x-base').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); };
  });
  $('#sheet').querySelectorAll('[data-pdf]').forEach((b) => {
    b.onclick = async () => {
      if (!cur.pins.length) { toast('No pins yet'); return; }
      const btns = $('#sheet').querySelectorAll('[data-pdf]');
      btns.forEach((x) => { x.disabled = true; });
      try {
        const { buildMapPdf } = await import('./pdf.js');
        const bytes = await buildMapPdf(cur, { base: pdfBase, onProgress: (m) => toast(m, 20000) });
        const f = { name: `${safeFileName(cur.name)}-map-${new Date().toISOString().slice(0, 10)}.pdf`, type: 'application/pdf', bytes };
        toast('PDF ready');
        if (b.dataset.pdf === 'sh' && await share(f)) return;
        download(f);
      } catch (e) {
        console.error(e);
        toast('PDF failed: ' + (e && e.message ? e.message : e), 5000);
      } finally {
        btns.forEach((x) => { x.disabled = false; });
      }
    };
  });
  $('#x-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(summaryText(cur)); toast('Summary copied'); } catch { toast('Copy failed: long-press the text below instead'); }
  };
  if ($('#x-sharetext')) $('#x-sharetext').onclick = () => navigator.share({ text: summaryText(cur), title: cur.name }).catch(() => {});
}

// ---------------- Screen wake lock ----------------
let wake = null;
async function requestWake() {
  try { if ('wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch { wake = null; }
}
function releaseWake() { if (wake) { wake.release().catch(() => {}); wake = null; } }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('#view-survey').hidden) requestWake();
});

// ---------------- Start ----------------
load();
if (!window.L) {
  document.body.insertAdjacentHTML('afterbegin', '<div style="background:#c62828;color:#fff;padding:8px;text-align:center;position:relative;z-index:5000">Map library did not load (no signal?). Pins still work; the map will show once online.</div>');
}
renderProjects();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Expose for debugging/tests.
window.__gss = { get projects() { return projects; }, get cur() { return cur; }, setFix(f) { fix = { ...f, t: Date.now() }; updateGpsUi(); } };
