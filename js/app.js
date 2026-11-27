/**
 * @fileoverview ZVV departures web app: UI, polling and API key handling.
 *
 * The OJP API key is kept in this browser's localStorage and is only ever
 * sent to api.opentransportdata.swiss (also enforced by the page's
 * Content-Security-Policy).
 */

import * as ojp from './ojp.js';

/**
 * Hardcoded boards. `defaultFromHour` picks the default board by time of day
 * in Zurich: the board with the latest defaultFromHour <= current hour wins.
 */
export const PRESETS = Object.freeze([
  {
    id: 'morning',
    label: 'Tram 4 · Wetlistrasse',
    stopName: 'Zürich, Wetlistrasse',
    lines: ['4'],
    direction: 'Bahnhof',
    defaultFromHour: 0,  // Before noon: first tram of the morning commute.
  },
  {
    id: 'evening',
    label: 'Tram 8 · Bahnhof Enge',
    stopName: 'Zürich, Bahnhof Enge',
    lines: ['8'],
    direction: 'Kirche Fluntern',
    defaultFromHour: 12,  // After noon: first tram of the evening commute.
  },
]);

/** Poll interval per board (OJP free tier: 50 req/min, 20k/day). */
export const REFRESH_SECONDS = 30;
export const MIN_REFRESH_SECONDS = 5;
export const STALE_AFTER_SECONDS = 90;
export const DEPARTURE_LIMIT = 6;
/** Raw stop events requested so enough survive the line/direction filter. */
export const FETCH_COUNT = 40;

/** Nearby stops: how many to offer, search radius, rows on their board. */
export const NEARBY_STOP_COUNT = 5;
export const NEARBY_RADIUS_METERS = 1000;
export const NEARBY_DEPARTURE_LIMIT = 12;
export const NEARBY_BOARD_ID = 'nearby';
/** Geolocation options: a fix up to a minute old is good enough. */
const GEOLOCATION_OPTIONS = Object.freeze({
  enableHighAccuracy: true,
  timeout: 15000,
  maximumAge: 60000,
});

export const TOKEN_STORAGE_KEY = 'zvv-webapp.ojp-token';
export const STOP_CACHE_STORAGE_KEY = 'zvv-webapp.stop-refs';

const API_MANAGER_URL = 'https://api-manager.opentransportdata.swiss/';

/** Creates a DOM element with optional class names and text. */
function el(doc, tag, className = '', textContent = '') {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (textContent) node.textContent = textContent;
  return node;
}

function readJson(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

/** Creates the mutable state of one departure board. */
function makeBoard(preset, resolvedStop = null) {
  return {
    preset,
    resolvedStop,
    lastGood: null,
    lastError: '',
    failures: 0,
    nextFetchAt: 0,
    lastAttemptAt: 0,
    inFlight: false,
  };
}

/** Drops the "Zürich, " prefix, which every city stop has. */
function shortStopName(name) {
  return String(name).replace(/^Zürich,\s*/, '');
}

/** User-facing text for a GeolocationPositionError. */
function geolocationErrorMessage(err) {
  switch (err && err.code) {
    case 1:
      return 'Location access was denied. Allow location for this site in ' +
          'your browser settings, then try again.';
    case 2:
      return 'Your location is not available right now.';
    case 3:
      return 'Finding your location took too long.';
    default:
      return 'Could not get your location.';
  }
}

/**
 * Starts the app.
 * @param {{doc?: !Document, storage?: !Storage, fetchFn?: Function,
 *     clock?: function(): !Date, presets?: !Array<!Object>,
 *     geolocation?: ?Geolocation, autoStart?: boolean}=} options
 *     Dependencies (overridable for tests).
 * @return {!Object} Handle with `tick()` and `stop()` for tests.
 */
export function startApp({
  doc = document,
  storage = window.localStorage,
  fetchFn = (...args) => window.fetch(...args),
  clock = () => new Date(),
  presets = PRESETS,
  geolocation = (typeof navigator !== 'undefined' && navigator.geolocation) ||
      null,
  autoStart = true,
} = {}) {
  const $ = (id) => doc.getElementById(id);
  const ui = {
    clock: $('clock'),
    age: $('age'),
    summary: $('summary'),
    tabs: $('tabs'),
    stopHeader: $('stop-header'),
    departures: $('departures'),
    refresh: $('refresh-button'),
    keyButton: $('key-button'),
    keyDialog: $('key-dialog'),
    keyForm: $('key-form'),
    keyInput: $('key-input'),
    keyMessage: $('key-message'),
    keyForget: $('key-forget'),
    keyCancel: $('key-cancel'),
    nearbyButton: $('nearby-button'),
    nearbyDialog: $('nearby-dialog'),
    nearbyMessage: $('nearby-message'),
    nearbyList: $('nearby-list'),
    nearbyRetry: $('nearby-retry'),
    nearbyCancel: $('nearby-cancel'),
  };

  // The preset boards, plus at most one temporary "nearby" board at the end.
  const boards = presets.map((preset) => makeBoard(preset));

  let token = storage.getItem(TOKEN_STORAGE_KEY) || '';
  let client = null;
  let activeIndex = ojp.defaultPresetIndex(presets, clock());
  let userPicked = false;
  let timer = null;
  // Bumped on every key change so responses to requests made with a
  // superseded key are ignored.
  let tokenGeneration = 0;
  // Bumped on every nearby lookup and when its dialog closes, so a late
  // answer never fills a dialog that is closed or showing a newer lookup.
  let nearbyGeneration = 0;

  function getClient() {
    if (!token) return null;
    if (!client) client = new ojp.OjpClient(token, {fetchFn, clock});
    return client;
  }

  // -------------------------------------------------------------------------
  // API key dialog
  // -------------------------------------------------------------------------

  function openKeyDialog(message = '') {
    ui.keyMessage.textContent = message;
    ui.keyMessage.hidden = !message;
    ui.keyInput.value = '';
    ui.keyForget.hidden = !token;
    ui.keyCancel.hidden = !token;
    if (!ui.keyDialog.open) {
      if (typeof ui.keyDialog.showModal === 'function') {
        ui.keyDialog.showModal();
      } else {
        ui.keyDialog.setAttribute('open', '');
      }
    }
    ui.keyInput.focus();
  }

  function closeKeyDialog() {
    if (typeof ui.keyDialog.close === 'function') {
      ui.keyDialog.close();
    } else {
      ui.keyDialog.removeAttribute('open');
    }
  }

  function setToken(newToken) {
    token = newToken;
    client = null;
    tokenGeneration += 1;
    if (token) {
      storage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      storage.removeItem(TOKEN_STORAGE_KEY);
    }
    for (const board of boards) {
      board.lastError = '';
      board.failures = 0;
      board.nextFetchAt = 0;
      board.inFlight = false;
    }
  }

  ui.keyForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = ui.keyInput.value.trim();
    if (!value) {
      ui.keyMessage.textContent = 'Please paste your OJP 2.0 API key.';
      ui.keyMessage.hidden = false;
      return;
    }
    setToken(value);
    ui.keyInput.value = '';
    closeKeyDialog();
    tick();
  });

  ui.keyForget.addEventListener('click', () => {
    setToken('');
    openKeyDialog('Key removed from this browser.');
    render();
  });

  ui.keyCancel.addEventListener('click', () => {
    if (token) closeKeyDialog();
  });

  // Without a key the dialog must stay open (Escape would otherwise close it).
  ui.keyDialog.addEventListener('cancel', (event) => {
    if (!token) event.preventDefault();
  });

  ui.keyButton.addEventListener('click', () => openKeyDialog());

  // -------------------------------------------------------------------------
  // Nearby stops
  // -------------------------------------------------------------------------

  function showDialog(dialog) {
    if (dialog.open) return;
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function hideDialog(dialog) {
    if (typeof dialog.close === 'function') {
      dialog.close();
    } else {
      dialog.removeAttribute('open');
    }
  }

  function setNearbyStatus(message, {isError = false, canRetry = false} = {}) {
    ui.nearbyMessage.textContent = message;
    ui.nearbyMessage.hidden = !message;
    ui.nearbyMessage.classList.toggle('error', isError);
    ui.nearbyRetry.hidden = !canRetry;
  }

  function closeNearbyDialog() {
    nearbyGeneration += 1;
    hideDialog(ui.nearbyDialog);
  }

  function getPosition() {
    return new Promise((resolve, reject) => {
      geolocation.getCurrentPosition(
          (pos) => resolve({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
          }),
          reject, GEOLOCATION_OPTIONS);
    });
  }

  async function lookUpNearbyStops() {
    const generation = ++nearbyGeneration;
    const isStale = () => generation !== nearbyGeneration;
    ui.nearbyList.replaceChildren();
    if (!geolocation) {
      setNearbyStatus('This browser cannot share your location.',
                      {isError: true});
      return;
    }
    const api = getClient();
    if (!api) {
      setNearbyStatus('An API key is needed first.', {isError: true});
      return;
    }
    setNearbyStatus('Finding your location…');
    let position;
    try {
      position = await getPosition();
    } catch (err) {
      if (!isStale()) {
        setNearbyStatus(geolocationErrorMessage(err),
                        {isError: true, canRetry: true});
      }
      return;
    }
    if (isStale()) return;
    setNearbyStatus('Looking up stops…');
    let stops;
    try {
      stops = await api.findNearbyStops(
          position, {limit: NEARBY_STOP_COUNT,
                     radiusMeters: NEARBY_RADIUS_METERS});
    } catch (err) {
      if (isStale()) return;
      const message = err && err.message ? err.message : String(err);
      setNearbyStatus(`Could not look up stops: ${message}`,
                      {isError: true, canRetry: true});
      if (err instanceof ojp.OjpError && err.isAuthError) {
        closeNearbyDialog();
        openKeyDialog(`${message}. Please check or replace your key.`);
      }
      return;
    }
    if (isStale()) return;
    if (!stops.length) {
      setNearbyStatus(
          `No stops within ${ojp.formatDistance(NEARBY_RADIUS_METERS)}.`,
          {canRetry: true});
      return;
    }
    setNearbyStatus('');
    for (const stop of stops) {
      const item = el(doc, 'li');
      const button = el(doc, 'button', 'nearby-stop');
      button.type = 'button';
      button.append(el(doc, 'span', 'nearby-name', shortStopName(stop.name)));
      if (stop.distanceMeters !== null) {
        button.append(el(doc, 'span', 'nearby-distance',
                         ojp.formatDistance(stop.distanceMeters)));
      }
      button.addEventListener('click', () => {
        closeNearbyDialog();
        showNearbyBoard(stop);
      });
      item.append(button);
      ui.nearbyList.append(item);
    }
  }

  function nearbyBoardIndex() {
    return boards.findIndex((b) => b.preset.id === NEARBY_BOARD_ID);
  }

  /** Replaces the nearby board (if any) with one for `stop`, and shows it. */
  function showNearbyBoard(stop) {
    const preset = {
      id: NEARBY_BOARD_ID,
      label: `📍 ${shortStopName(stop.name)}`,
      stopName: stop.name,
      lines: [],
      direction: '',
      limit: NEARBY_DEPARTURE_LIMIT,
    };
    const resolved = {
      stopRef: stop.stopRef,
      name: stop.name,
      isStopPoint: stop.isStopPoint,
    };
    const board = makeBoard(preset, resolved);
    const existing = nearbyBoardIndex();
    if (existing >= 0) {
      boards[existing] = board;
    } else {
      boards.push(board);
    }
    userPicked = true;
    activeIndex = boards.indexOf(board);
    renderTabs();
    tick();
  }

  function closeNearbyBoard() {
    const index = nearbyBoardIndex();
    if (index < 0) return;
    boards.splice(index, 1);
    if (activeIndex >= boards.length || activeIndex === index) {
      // Back to the board the time of day calls for.
      userPicked = false;
      activeIndex = ojp.defaultPresetIndex(presets, clock());
    }
    renderTabs();
    tick();
  }

  ui.nearbyButton.addEventListener('click', () => {
    showDialog(ui.nearbyDialog);
    lookUpNearbyStops();
  });
  ui.nearbyRetry.addEventListener('click', () => lookUpNearbyStops());
  ui.nearbyCancel.addEventListener('click', () => closeNearbyDialog());
  ui.nearbyDialog.addEventListener('close', () => {
    nearbyGeneration += 1;
  });

  // -------------------------------------------------------------------------
  // Fetching
  // -------------------------------------------------------------------------

  function cachedStop(stopName) {
    const cache = readJson(storage, STOP_CACHE_STORAGE_KEY, {});
    const hit = cache[stopName];
    return hit && hit.stopRef ? hit : null;
  }

  function cacheStop(stopName, stop) {
    const cache = readJson(storage, STOP_CACHE_STORAGE_KEY, {});
    cache[stopName] = stop;
    storage.setItem(STOP_CACHE_STORAGE_KEY, JSON.stringify(cache));
  }

  async function refreshBoard(board) {
    const api = getClient();
    if (!api || board.inFlight) return;
    const generation = tokenGeneration;
    const isStale = () => generation !== tokenGeneration;
    board.inFlight = true;
    board.lastAttemptAt = clock().getTime();
    try {
      if (!board.resolvedStop) {
        // Stop names resolve once and are cached, so later visits cost a
        // single StopEventRequest per refresh.
        board.resolvedStop = cachedStop(board.preset.stopName);
        if (!board.resolvedStop) {
          const stop = await api.resolveStop(board.preset.stopName);
          if (isStale()) return;
          board.resolvedStop = stop;
          cacheStop(board.preset.stopName, stop);
        }
      }
      const result = await api.fetchDepartures(board.resolvedStop, FETCH_COUNT);
      if (isStale()) return;
      board.lastGood = result;
      board.lastError = '';
      board.failures = 0;
      board.nextFetchAt = clock().getTime() + REFRESH_SECONDS * 1000;
    } catch (err) {
      if (isStale()) return;
      const error = err instanceof ojp.OjpError ? err : new ojp.OjpError(
          `Unexpected error: ${err && err.message ? err.message : err}`);
      board.failures += 1;
      board.lastError = error.message;
      const backoff = ojp.computeBackoffSeconds(
          REFRESH_SECONDS, board.failures,
          error.isRetriable ? error.retryAfterSeconds : null);
      board.nextFetchAt = clock().getTime() + backoff * 1000;
      if (error.isAuthError) {
        openKeyDialog(`${error.message}. Please check or replace your key.`);
      }
    } finally {
      // A stale request must not clear the flag of a newer in-flight one.
      if (!isStale()) board.inFlight = false;
      render();
    }
  }

  function isVisible() {
    return doc.visibilityState !== 'hidden';
  }

  /** Renders and fetches the active board when due. Runs every second. */
  function tick() {
    render();
    if (!token || !isVisible()) return;
    const board = boards[activeIndex];
    if (!board.inFlight && clock().getTime() >= board.nextFetchAt) {
      refreshBoard(board);
    }
  }

  ui.refresh.addEventListener('click', () => {
    const board = boards[activeIndex];
    const earliest = board.lastAttemptAt + MIN_REFRESH_SECONDS * 1000;
    // Manual refresh never shortcuts a rate-limit / server-error backoff.
    if (board.failures === 0) {
      board.nextFetchAt = Math.max(clock().getTime(), earliest);
    }
    tick();
  });

  doc.addEventListener('visibilitychange', () => {
    if (!isVisible()) return;
    if (!userPicked) {
      activeIndex = ojp.defaultPresetIndex(presets, clock());
      renderTabs();
    }
    tick();
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function renderTabs() {
    ui.tabs.replaceChildren();
    boards.forEach((board, index) => {
      const button = el(doc, 'button', 'tab', board.preset.label);
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(index === activeIndex));
      button.addEventListener('click', () => {
        userPicked = true;
        activeIndex = index;
        renderTabs();
        tick();
      });
      ui.tabs.append(button);
      if (board.preset.id === NEARBY_BOARD_ID) {
        const close = el(doc, 'button', 'tab-close', '✕');
        close.type = 'button';
        close.title = 'Close this board';
        close.setAttribute('aria-label', `Close ${board.preset.label}`);
        close.addEventListener('click', closeNearbyBoard);
        ui.tabs.append(close);
      }
    });
  }

  function renderTitle(board, now) {
    ui.clock.textContent = ojp.formatZurichClockSeconds(now);
    let ageText = 'waiting for data';
    let warn = Boolean(board.lastError);
    if (board.lastGood) {
      const age = Math.max(0, Math.floor((now - board.lastGood.fetchedAt) / 1000));
      ageText = `updated ${age} s ago`;
      warn = warn || age >= STALE_AFTER_SECONDS;
    } else if (!token) {
      ageText = 'no API key';
    } else if (board.inFlight) {
      ageText = 'loading…';
    }
    ui.age.textContent = ageText;
    ui.age.classList.toggle('warn', warn);
  }

  function badge(className, label) {
    return el(doc, 'span', `badge ${className}`, label);
  }

  function renderSummary(board, filtered, now) {
    ui.summary.replaceChildren();
    const stale = board.lastGood &&
        (now - board.lastGood.fetchedAt) / 1000 >= STALE_AFTER_SECONDS;
    if (stale || board.lastError) {
      const parts = [];
      if (stale) parts.push('STALE');
      if (board.lastError) parts.push(board.lastError);
      ui.summary.append(badge('error', `⚠ ${parts.join(' · ')}`));
      return;
    }
    if (!board.lastGood) {
      ui.summary.append(badge('muted', token ? 'resolving stop…' : 'API key needed'));
      return;
    }
    if (!filtered.length) {
      ui.summary.append(badge('muted', 'no upcoming departures'));
      return;
    }
    const total = filtered.length;
    const live = filtered.filter((d) => d.estimatedTime).length;
    const states = filtered.map(ojp.departureState);
    const delayed = filtered.filter(
        (d, i) => states[i] === ojp.State.DELAYED);
    const cancelled = states.filter((s) => s === ojp.State.CANCELLED).length;
    const skipped = states.filter((s) => s === ojp.State.NOT_SERVICED).length;
    const disruptions = new Set(filtered.flatMap((d) => d.situations)).size;

    const liveClass = live === total ? 'ok' : (live > 0 ? 'delayed' : 'muted');
    ui.summary.append(badge(liveClass, `● ${live}/${total} live`));
    if (!cancelled && !skipped && !disruptions && !delayed.length) {
      ui.summary.append(badge('ok', '✔ all on time'));
      return;
    }
    if (cancelled) ui.summary.append(badge('error', `✕ ${cancelled} cancelled`));
    if (disruptions) {
      ui.summary.append(badge(
          'warn', `▲ ${disruptions} disruption${disruptions === 1 ? '' : 's'}`));
    }
    if (delayed.length) {
      const maxDelay = Math.max(...delayed.map(ojp.delayMinutes));
      ui.summary.append(
          badge('delayed', `+${delayed.length} delayed (max +${maxDelay}')`));
    }
    if (skipped) ui.summary.append(badge('warn', `⊘ ${skipped} skipped`));
  }

  function renderStopHeader(board) {
    const {preset} = board;
    const name = board.lastGood ? board.lastGood.stop.name : preset.stopName;
    const filters = [];
    if (preset.lines.length) filters.push(preset.lines.join(','));
    if (preset.direction) filters.push(`→ ${preset.direction}`);
    ui.stopHeader.replaceChildren(
        el(doc, 'span', 'stop-name', `◉ ${name}`),
        el(doc, 'span', 'stop-filters', filters.length ? `[${filters.join(' ')}]` : ''));
  }

  function departureRow(dep, stopName, now) {
    const state = ojp.departureState(dep);
    const row = el(doc, 'li', `departure ${state}`);
    const countdown = ojp.formatCountdown(ojp.effectiveTime(dep), now);

    row.append(el(doc, 'span', 'line', dep.line));
    row.append(el(doc, 'span', 'destination',
                  ojp.shortenDestination(dep.destination, stopName)));

    const right = el(doc, 'span', 'right');
    const status = el(doc, 'span', 'status');
    if (state === ojp.State.CANCELLED) {
      status.append(el(doc, 'span', 'flag', '✕ CANC'), ' ',
                    el(doc, 'span', 'countdown', countdown));
    } else if (state === ojp.State.NOT_SERVICED) {
      status.append(el(doc, 'span', 'flag', '⊘ SKIP'));
    } else if (state === ojp.State.DELAYED) {
      status.append(el(doc, 'span', 'delay', `+${ojp.delayMinutes(dep)}'`), ' ',
                    el(doc, 'span', 'dot', '●'), ' ',
                    el(doc, 'span', 'countdown', countdown));
    } else if (state === ojp.State.LIVE) {
      status.append(el(doc, 'span', 'dot', '●'), ' ',
                    el(doc, 'span', 'countdown', countdown));
    } else {
      status.append(el(doc, 'span', 'dot', '~'), ' ',
                    el(doc, 'span', 'countdown', countdown));
    }
    right.append(status);
    const clockText = ojp.formatZurichClock(ojp.effectiveTime(dep));
    right.append(el(doc, 'span', 'clock-time', clockText));
    row.append(right);
    row.title = `planned ${ojp.formatZurichClock(dep.timetabledTime)}` +
        (dep.estimatedTime ? `, forecast ${clockText}` : ', no live data');
    return row;
  }

  function renderDepartures(board, filtered, now) {
    ui.departures.replaceChildren();
    if (!board.lastGood) {
      const msg = board.lastError ? `! ${board.lastError}` :
          (token ? 'loading…' : 'Enter your OJP API key to start.');
      ui.departures.append(
          el(doc, 'li', board.lastError ? 'message error' : 'message', msg));
      return;
    }
    if (!filtered.length) {
      ui.departures.append(el(doc, 'li', 'message', '(no matching departures)'));
      const {preset} = board;
      const all = ojp.destinationsForLines(board.lastGood.departures, preset.lines);
      if (preset.direction && all.length) {
        const names = all.map((d) => ojp.shortenDestination(d, board.lastGood.stop.name));
        ui.departures.append(el(
            doc, 'li', 'message hint',
            `Line ${preset.lines.join(',')} here goes to: ${names.join(', ')}`));
      }
      return;
    }
    const seenSituations = new Set();
    for (const dep of filtered) {
      ui.departures.append(departureRow(dep, board.lastGood.stop.name, now));
      for (const situation of dep.situations) {
        if (seenSituations.has(situation)) continue;
        seenSituations.add(situation);
        ui.departures.append(el(doc, 'li', 'situation', `▲ ${situation}`));
      }
    }
  }

  function render() {
    const now = clock();
    const board = boards[activeIndex];
    const filtered = board.lastGood ?
        ojp.filterDepartures(board.lastGood.departures, board.preset, now,
                             board.preset.limit || DEPARTURE_LIMIT) :
        [];
    renderTitle(board, now);
    renderSummary(board, filtered, now);
    renderStopHeader(board);
    renderDepartures(board, filtered, now);
    ui.refresh.disabled = !token || board.inFlight;
    ui.nearbyButton.disabled = !token;
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  ui.keyDialog.querySelector('a.api-manager').href = API_MANAGER_URL;
  renderTabs();
  render();
  if (!token) openKeyDialog();
  if (autoStart) {
    tick();
    timer = setInterval(tick, 1000);
  }

  return {
    tick,
    render,
    boards,
    get activeIndex() {
      return activeIndex;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
