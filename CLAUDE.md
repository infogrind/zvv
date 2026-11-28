# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A dependency-free, backend-free browser app showing live ZVV (Zurich) departures
via the Swiss OJP 2.0 API (`https://api.opentransportdata.swiss/ojp20`). Plain
HTML/CSS/ES modules: no build step, no `package.json`, no third-party
JavaScript. README.md is detailed and user-facing; keep it in sync when
behavior, tunables or the feature list change.

## Commands

- Run locally (ES modules need HTTP, not `file://`):
  `python3 -m http.server 8000` → http://localhost:8000/
- Regenerate README screenshots after UI changes (needs Node + Playwright,
  installed without creating a `package.json`):
  ```sh
  npm install --no-save --no-package-lock playwright
  npx playwright install chromium
  python3 -m http.server 8765   # render.js expects this port
  node docs/screenshots/render.js   # overwrites docs/screenshots/*.png
  ```
  `render.js` fakes OJP responses, geolocation and the clock (07:42:10
  Zurich), so no API key or network is needed. Sample data lives at its top.

There is no test suite, linter or formatter configured in the repo.

## Architecture

- `js/ojp.js` — OJP client and all pure logic: XML request builders
  (`build*RequestXml`), namespace-aware `DOMParser` response parsing
  (`parse*ResponseXml`, SIRI error/situation handling), stop matching
  (`selectBestStop`, `nearestStops`), departure filtering, Zurich-timezone
  formatting, `defaultPresetIndex`, and `computeBackoffSeconds`. `OjpClient`
  holds the token in a private field so it never appears in logs/errors.
- `js/app.js` — all UI and state inside one `startApp({doc, storage, fetchFn, clock, presets, geolocation, autoStart})` closure. Every external dependency
  is injectable so the app can be driven without a browser or network; keep
  new side effects going through these parameters (use `clock()`, not
  `new Date()`; `fetchFn`, not `fetch`).
- Boards: `boards` is ordered presets, then favorites, then at most one
  temporary "nearby" board (`NEARBY_BOARD_ID`), and the array returned by
  `startApp` is mutated in place. `PRESETS` (top of `app.js`) become board
  objects via `makeBoard`; only presets take part in the time-of-day default
  (`defaultPresetIndex(presets, …)`). The nearby board can be put into a
  "follow one line" mode, and the ☆ in its header saves that stop/line/direction
  as a favorite (max `MAX_FAVORITES`, `localStorage` key
  `zvv-webapp.favorites`). Favorites carry their stop ref, so they never need a
  name lookup. Preset stop names resolve to OJP stop refs once and are cached
  in `localStorage` (`zvv-webapp.stop-refs`).
- Tabs (`renderTabs`): row 1 is the presets, row 2 is the nearby board if
  open, otherwise the favorites. Labels are a line badge plus
  `ojp.shortenLabel(stopName)`, plus the shortened direction below it on
  favorites; the board's `label` is only the aria-label and tooltip.
- Polling: a 1 s `tick()` re-renders and fetches only the active board, only
  when the page is visible and `nextFetchAt` has passed. Per-board
  `failures`/`nextFetchAt`/`inFlight` implement exponential backoff (honoring
  `Retry-After`); manual refresh is rate-limited and never shortcuts a backoff.
- Stale-response guards: `tokenGeneration` (bumped on key change) and
  `nearbyGeneration` (bumped per nearby lookup / dialog close) are captured
  before async calls and checked after, so late responses are dropped.
  Follow this pattern for any new async flow.
- Rendering uses DOM APIs only (`el()` helper, `replaceIfChanged`); never
  `innerHTML`.

## Constraints

- `index.html` has a strict CSP: `script-src 'self'`, `style-src 'self'`,
  `connect-src https://api.opentransportdata.swiss` only. No inline scripts,
  inline `<style>`/`style=""` attributes, CDNs, or other hosts — adding any
  requires a deliberate CSP change.
- The API key lives only in `localStorage` (`zvv-webapp.ojp-token`), is sent
  only to the OJP host, and must never be committed or included in error
  messages.
- Tram line colors are defined at the end of `style.css`.
