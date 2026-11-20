# GPS Site Survey

A phone web app for surveying exterior lighting: walk up to a fixture, tap **PIN HERE**, pick the style, and get counts, a list and a map.

Live at: https://jermy-noienergygroup.github.io/GPS-Site-Survey/

## Using it

1. Open the link on your phone and add it to the home screen (Chrome: ⋮ → Add to Home screen / Install app). Allow location when asked.
2. **New survey**: name it, add the fixture and pole styles for this site (comma separated works), and optionally lots or zones.
3. **Survey screen**: the map is on top with your live position. The badge shows GPS accuracy (green ≤16ft, yellow ≤40ft, red worse). The chip next to it is the current lot; tap it to switch lots or add one.
4. **PIN HERE** saves your position at the moment you tap, then opens the pin sheet:
   - Tap a style once per fixture at that spot (tap Shoebox twice = 2pcs). Use − / + to fix counts.
   - **+ New style** adds a style to this survey for all later pins.
   - **More details** (collapsed) has wattage, height, condition, a "took a photo" check and notes. Recent wattages and heights show as one-tap chips.
5. Tap a pin on the map → **Edit** to change it, move it on the map, re-pin it where you stand, or delete it.
6. **☰ menu**:
   - **List and totals**: pcs-first counts by lot and overall, plus every pin.
   - **Match photos**: take photos with your normal camera. Afterward, pick them here and each one is linked to a pin by its GPS location or time. Photos stay in your camera roll; only file names are saved.
   - **Export and backup**: copy or share the summary; download or share the KML (Google Earth / My Maps), CSV, or a backup file.
   - **Edit survey**: rename, add or remove styles and lots (only unused ones can be removed), delete the survey.

## Where the data lives

Surveys are saved in the phone's browser storage only. Nothing is sent to GitHub or any server. Clearing the browser's site data deletes them, so **export a backup** after each survey (Export → Backup). Restore it from the first screen on any phone.

The app works with no signal once it has been opened online once. Map tiles you have already looked at are cached; new areas need signal, but pinning works without the map.

## Files

| File | What it is |
|---|---|
| `index.html` | Page layout |
| `css/app.css` | Styling |
| `js/app.js` | Screens, map, GPS, pin sheet, photos, exports |
| `js/logic.js` | Counts, summary text, CSV, KML, photo matching, EXIF reader (no browser code; tested) |
| `sw.js` | Offline caching. **Bump `VERSION` when you change app files.** |
| `manifest.webmanifest`, `icons/` | Home-screen install |
| `tests/` | `node tests/test-logic.mjs` for logic; `tests/ui-check.mjs` is a Playwright smoke test |

No build step: GitHub Pages serves the files as they are. Map: [Leaflet](https://leafletjs.com) from unpkg; satellite imagery from Esri World Imagery, street map from OpenStreetMap. Both tile sources have usage terms; light use like this is normally fine, but heavy commercial use of Esri imagery officially calls for an ArcGIS account.

## GitHub Pages setup

Repo → Settings → Pages → Source: **Deploy from a branch** → Branch: **main**, folder **/(root)** → Save.
