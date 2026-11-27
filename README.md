# ZVV Departures

A small, dependency-free web app that shows live departures for Zurich (ZVV)
public transport stops, using the Swiss
[OJP 2.0 API](https://opentransportdata.swiss/en/cookbook/ojp/) from
opentransportdata.swiss. It runs entirely in the browser: there is no backend,
no build step and no third-party JavaScript.

It is built around a commute: a small set of hardcoded "boards" (stop + line +
direction), with the right one picked automatically by time of day.

## Features

- **Live departure board** with countdowns (`now`, `4'`, or `HH:MM` for
  departures an hour or more away), the forecast clock time, and a marker for
  whether the time is real-time (`●`) or timetable-only (`~`).
- **Status at a glance**: a summary row shows how many departures have live
  data, plus delays (with the maximum delay), cancellations, skipped stops and
  disruptions.
- **Disruption messages** (SIRI situations) are shown inline below the first
  departure they affect.
- **Line and direction filters** per board, e.g. "only tram 4 towards
  Bahnhof". If the direction filter matches nothing, the board lists the
  destinations that line actually serves from that stop, so a typo is easy to
  fix.
- **Time-of-day default board**: before noon the morning board is shown, after
  noon the evening board. Picking a tab by hand overrides this for the session.
- **Polite polling**: only the visible board is refreshed, every 30 s, and only
  while the page is visible. Failures back off exponentially (up to 5 minutes)
  and respect `Retry-After`. Manual refresh is limited to once per 5 s and
  never skips a backoff.
- **Stale-data warning** when the last successful update is older than 90 s.
- **Installable** as a home-screen app (web app manifest, Apple touch icon,
  standalone display mode).
- **Light and dark mode** follow the system setting.

## Getting an API key

1. Create a free account at the
   [opentransportdata.swiss API manager](https://api-manager.opentransportdata.swiss/).
2. Subscribe to the **OJP 2.0** API and create a key (token).
3. Open the app and paste the key into the dialog that appears on first start.
   The "API key" button in the footer lets you replace or forget it later.

The free tier allows 50 requests per minute and 20,000 per day. At one request
every 30 s for the visible board, the app stays well within that.

## Running locally

The app uses ES modules, so it must be served over HTTP rather than opened as a
`file://` URL. Any static file server works, for example:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

## Deploying

Serve the repository root as static files from any HTTPS host (GitHub Pages,
Netlify, an S3 bucket, a home server, ...). There is nothing to build. HTTPS is
recommended because home-screen installation and some browser features require
a secure context.

## Configuration

Boards are defined in `PRESETS` at the top of [`js/app.js`](js/app.js):

```js
{
  id: 'morning',
  label: 'Tram 4 · Wetlistrasse',   // tab label
  stopName: 'Zürich, Wetlistrasse', // resolved to an OJP stop ID on first use
  lines: ['4'],                     // empty array = all lines
  direction: 'Bahnhof',             // substring of the destination; '' = any
  defaultFromHour: 0,               // board is the default from this hour on
}
```

The board with the latest `defaultFromHour` that is not after the current
Zurich hour is shown by default.

Other tunables live next to it: `REFRESH_SECONDS` (poll interval),
`MIN_REFRESH_SECONDS` (manual refresh limit), `STALE_AFTER_SECONDS`,
`DEPARTURE_LIMIT` (rows shown) and `FETCH_COUNT` (raw departures requested so
enough survive the filters).

## Project structure

| Path | Purpose |
| --- | --- |
| `index.html` | Page markup, Content-Security-Policy and the API key dialog. |
| `style.css` | Departure board styles, light and dark themes. |
| `js/main.js` | Entry point; calls `startApp()`. |
| `js/app.js` | UI: boards, tabs, polling, rendering and API key handling. |
| `js/ojp.js` | OJP 2.0 client: XML request building, response parsing, stop matching, and pure formatting and filtering helpers. |
| `manifest.webmanifest`, `icon.svg`, `icon-180.png` | Home-screen install metadata and icons. |

### How it talks to OJP

1. **Stop lookup** – on first use of a board, its `stopName` is sent as an
   `OJPLocationInformationRequest`. The best match is chosen (exact name, then
   `Zürich, <name>`, then other Zurich stops; stop places are preferred over
   individual platforms) and cached in `localStorage`, so this happens once
   per stop.
2. **Departures** – each refresh sends one `OJPStopEventRequest` for the cached
   stop, with real-time data included. The response is parsed with the
   browser's `DOMParser`, sorted by effective time, and filtered by the
   board's lines and direction.

`startApp()` accepts its document, storage, `fetch` and clock as parameters,
so the app can be driven from tests without a browser or network.

## Privacy and security

- The API key is stored only in this browser's `localStorage`
  (`zvv-webapp.ojp-token`) and is sent only to `api.opentransportdata.swiss`.
- The page's Content-Security-Policy allows network connections to that host
  only, allows scripts and styles from the app's own origin only, and blocks
  everything else (no inline scripts, no third-party resources).
- Requests are sent without cookies or a referrer, and error messages never
  include the key.
- "Forget key" in the API key dialog removes it from the browser.

## License

[MIT](LICENSE)
