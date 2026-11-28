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
    mode: 'tram',  // Colors the line badge on the tab.
    defaultFromHour: 0,  // Before noon: first tram of the morning commute.
  },
  {
    id: 'evening',
    label: 'Tram 8 · Bahnhof Enge',
    stopName: 'Zürich, Bahnhof Enge',
    lines: ['8'],
    direction: 'Kirche Fluntern',
    mode: 'tram',
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
/**
 * Tapping a departure on the nearby board follows that line and direction:
 * this many rows, from a larger request so that a busy stop still yields
 * enough departures of the one line.
 */
export const FOLLOW_DEPARTURE_LIMIT = 4;
export const FOLLOW_FETCH_COUNT = 100;
/**
 * Geolocation options. The nearby button accepts a fix up to a minute old,
 * which is quick; "refresh location" in the popup always asks for a new one
 * (e.g. on a moving tram, where a minute can be a whole stop).
 */
const GEOLOCATION_OPTIONS = Object.freeze({
  enableHighAccuracy: true,
  timeout: 15000,
  maximumAge: 60000,
});
const FRESH_GEOLOCATION_OPTIONS = Object.freeze({
  ...GEOLOCATION_OPTIONS,
  maximumAge: 0,
});

export const TOKEN_STORAGE_KEY = 'zvv-webapp.ojp-token';
export const STOP_CACHE_STORAGE_KEY = 'zvv-webapp.stop-refs';
/**
 * Favorites: boards saved with the star while following a line on the
 * nearby board. Kept in this browser only, shown after the presets, and never
 * picked as the default board.
 */
export const FAVORITES_STORAGE_KEY = 'zvv-webapp.favorites';
export const MAX_FAVORITES = 3;

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
    // Bumped when the board's filters change, so a request started before
    // the change is followed by a fresh one.
    filterVersion: 0,
  };
}

/**
 * Replaces `container`'s children with `nodes` only when what they show
 * differs from what is there. The board re-renders every second; rebuilding
 * unchanged rows would make a tap that spans a re-render get lost.
 */
function replaceIfChanged(container, nodes) {
  const key = nodes.map((n) => [
    n.className, n.textContent, n.title || '',
    n.dataset ? JSON.stringify(n.dataset) : '',
  ].join('\u0001')).join('\u0002');
  if (container.renderKey === key) return;
  container.renderKey = key;
  container.replaceChildren(...nodes);
}

/** Drops the "Zürich, " prefix, which every city stop has. */
function shortStopName(name) {
  return String(name).replace(/^Zürich,\s*/, '');
}

/** Saved favorites, skipping malformed entries; at most MAX_FAVORITES. */
function readFavorites(storage) {
  const saved = readJson(storage, FAVORITES_STORAGE_KEY, []);
  if (!Array.isArray(saved)) return [];
  return saved.filter((f) => f && typeof f.stopRef === 'string' && f.stopRef &&
      typeof f.stopName === 'string' && typeof f.line === 'string' && f.line &&
      typeof f.direction === 'string').slice(0, MAX_FAVORITES);
}

/** Board preset for a saved favorite. */
function favoritePreset(fav) {
  return {
    id: `fav:${ojp.favoriteKey(fav)}`,
    label: `${fav.line} · ${shortStopName(fav.stopName)} → ${fav.direction}`,
    stopName: fav.stopName,
    lines: [fav.line],
    direction: fav.direction,
    mode: fav.mode || '',
    limit: FOLLOW_DEPARTURE_LIMIT,
    fetchCount: FOLLOW_FETCH_COUNT,
    favorite: true,
  };
}

/** Board for a saved favorite; its stop is known, so it is never looked up. */
function favoriteBoard(fav) {
  return makeBoard(favoritePreset(fav), {
    stopRef: fav.stopRef,
    name: fav.stopName,
    isStopPoint: Boolean(fav.isStopPoint),
  });
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
    nearbyLocation: $('nearby-location'),
    nearbyRefresh: $('nearby-refresh'),
    nearbyCancel: $('nearby-cancel'),
  };

  // The preset boards, then the saved favorites, then at most one temporary
  // "nearby" board at the end. Indexes 0..presets.length-1 are the presets.
  let favorites = readFavorites(storage);
  const boards = [
    ...presets.map((preset) => makeBoard(preset)),
    ...favorites.map(favoriteBoard),
  ];

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

  function setNearbyStatus(message, {isError = false} = {}) {
    ui.nearbyMessage.textContent = message;
    ui.nearbyMessage.hidden = !message;
    ui.nearbyMessage.classList.toggle('error', isError);
  }

  /** "location just now, ±20 m" / "location 45 s old, ±20 m". */
  function describePosition(position) {
    const ageS = Math.max(0, Math.round(
        (clock().getTime() - position.timestamp) / 1000));
    let age = 'just now';
    if (ageS >= 120) {
      age = `${Math.floor(ageS / 60)} min old`;
    } else if (ageS >= 5) {
      age = `${ageS} s old`;
    }
    const accuracy = Number.isFinite(position.accuracy) ?
        `, ±${ojp.formatDistance(position.accuracy)}` : '';
    return `location ${age}${accuracy}`;
  }

  function closeNearbyDialog() {
    nearbyGeneration += 1;
    hideDialog(ui.nearbyDialog);
  }

  function getPosition(fresh) {
    return new Promise((resolve, reject) => {
      geolocation.getCurrentPosition(
          (pos) => resolve({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            timestamp: pos.timestamp,
          }),
          reject, fresh ? FRESH_GEOLOCATION_OPTIONS : GEOLOCATION_OPTIONS);
    });
  }

  /**
   * Fills the nearby popup. `fresh` insists on a new location fix instead of
   * one the browser cached in the last minute.
   */
  async function lookUpNearbyStops({fresh = false} = {}) {
    const generation = ++nearbyGeneration;
    const isStale = () => generation !== nearbyGeneration;
    ui.nearbyList.replaceChildren();
    ui.nearbyLocation.textContent = '';
    ui.nearbyRefresh.disabled = true;
    try {
      await fillNearbyStops(fresh, isStale);
    } finally {
      if (!isStale()) ui.nearbyRefresh.disabled = false;
    }
  }

  async function fillNearbyStops(fresh, isStale) {
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
      position = await getPosition(fresh);
    } catch (err) {
      if (!isStale()) {
        setNearbyStatus(geolocationErrorMessage(err), {isError: true});
      }
      return;
    }
    if (isStale()) return;
    ui.nearbyLocation.textContent = describePosition(position);
    setNearbyStatus('Looking up stops…');
    let stops;
    try {
      stops = await api.findNearbyStops(
          position, {limit: NEARBY_STOP_COUNT,
                     radiusMeters: NEARBY_RADIUS_METERS});
    } catch (err) {
      if (isStale()) return;
      const message = err && err.message ? err.message : String(err);
      setNearbyStatus(`Could not look up stops: ${message}`, {isError: true});
      if (err instanceof ojp.OjpError && err.isAuthError) {
        closeNearbyDialog();
        openKeyDialog(`${message}. Please check or replace your key.`);
      }
      return;
    }
    if (isStale()) return;
    if (!stops.length) {
      setNearbyStatus(
          `No stops within ${ojp.formatDistance(NEARBY_RADIUS_METERS)}.`);
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

  /** Preset of the nearby board, following one line when `follow` is set. */
  function nearbyPreset(stopName, follow = null) {
    const base = `📍 ${shortStopName(stopName)}`;
    return follow ? {
      id: NEARBY_BOARD_ID,
      label: `${base} · ${follow.line}`,
      stopName,
      lines: [follow.line],
      direction: follow.direction,
      mode: follow.mode || '',
      limit: FOLLOW_DEPARTURE_LIMIT,
      fetchCount: FOLLOW_FETCH_COUNT,
      following: true,
    } : {
      id: NEARBY_BOARD_ID,
      label: base,
      stopName,
      lines: [],
      direction: '',
      limit: NEARBY_DEPARTURE_LIMIT,
      following: false,
    };
  }

  /** Narrows the nearby board to one line and direction, or back to all. */
  function setNearbyFollow(follow) {
    const index = nearbyBoardIndex();
    if (index < 0) return;
    const board = boards[index];
    board.preset = nearbyPreset(board.preset.stopName, follow);
    board.filterVersion += 1;
    // Reload now (the request size changed), unless backing off from errors.
    if (board.failures === 0) board.nextFetchAt = 0;
    activeIndex = index;
    renderTabs();
    tick();
  }

  /** Replaces the nearby board (if any) with one for `stop`, and shows it. */
  function showNearbyBoard(stop) {
    const preset = nearbyPreset(stop.name);
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

  // -------------------------------------------------------------------------
  // Favorites
  // -------------------------------------------------------------------------

  /**
   * The favorite a board shows or could be saved as: a favorite board, or the
   * nearby board while it follows one line. Null for other boards.
   */
  function favoriteFor(board) {
    const {preset, resolvedStop} = board;
    if (!resolvedStop || !(preset.favorite || preset.following)) return null;
    return {
      stopRef: resolvedStop.stopRef,
      stopName: resolvedStop.name || preset.stopName,
      isStopPoint: Boolean(resolvedStop.isStopPoint),
      line: preset.lines[0],
      direction: preset.direction,
      mode: preset.mode || '',
    };
  }

  function isSaved(fav) {
    const key = ojp.favoriteKey(fav);
    return favorites.some((f) => ojp.favoriteKey(f) === key);
  }

  function saveFavorites() {
    storage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favorites));
  }

  /** Saves `fav` and adds its board before the nearby board. */
  function addFavorite(fav) {
    if (isSaved(fav) || favorites.length >= MAX_FAVORITES) return;
    const active = boards[activeIndex];
    favorites = [...favorites, fav];
    saveFavorites();
    const nearby = nearbyBoardIndex();
    boards.splice(nearby >= 0 ? nearby : boards.length, 0, favoriteBoard(fav));
    activeIndex = boards.indexOf(active);
    renderTabs();
    render();
  }

  /**
   * Forgets `fav` and drops its board. If that board was showing, the time of
   * day picks the board again.
   */
  function removeFavorite(fav) {
    const key = ojp.favoriteKey(fav);
    favorites = favorites.filter((f) => ojp.favoriteKey(f) !== key);
    saveFavorites();
    const active = boards[activeIndex];
    const index = boards.findIndex((b) => b.preset.id === `fav:${key}`);
    if (index >= 0) boards.splice(index, 1);
    activeIndex = boards.indexOf(active);
    if (activeIndex < 0) {
      userPicked = false;
      activeIndex = ojp.defaultPresetIndex(presets, clock());
    }
    renderTabs();
    tick();
  }

  function toggleFavorite() {
    const fav = favoriteFor(boards[activeIndex]);
    if (!fav) return;
    if (isSaved(fav)) {
      removeFavorite(fav);
    } else {
      addFavorite(fav);
    }
  }

  ui.nearbyButton.addEventListener('click', () => {
    showDialog(ui.nearbyDialog);
    lookUpNearbyStops();
  });
  ui.nearbyRefresh.addEventListener(
      'click', () => lookUpNearbyStops({fresh: true}));
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
      const filterVersion = board.filterVersion;
      const result = await api.fetchDepartures(
          board.resolvedStop, board.preset.fetchCount || FETCH_COUNT);
      if (isStale()) return;
      board.lastGood = result;
      board.lastError = '';
      board.failures = 0;
      // Filters changed while this was loading: fetch again for the new ones.
      board.nextFetchAt = filterVersion === board.filterVersion ?
          clock().getTime() + REFRESH_SECONDS * 1000 : 0;
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

  /**
   * Tab content: a line badge (tram-colored) and the shortened stop name,
   * with the direction below it when `showDirection` is set (favorites).
   */
  function tabContent(button, preset, showDirection) {
    if (preset.id === NEARBY_BOARD_ID) {
      button.append(el(doc, 'span', 'tab-icon', '📍'));
    }
    if (preset.lines.length === 1) {
      const line = el(doc, 'span', 'line', preset.lines[0]);
      if (preset.mode === 'tram') line.dataset.tram = preset.lines[0].trim();
      button.append(line);
    }
    const name = el(doc, 'span', 'tab-name', ojp.shortenLabel(preset.stopName));
    if (!showDirection) {
      button.append(name);
      return;
    }
    const text = el(doc, 'span', 'tab-text');
    text.append(name, el(doc, 'span', 'tab-direction',
                         `→ ${ojp.shortenLabel(preset.direction)}`));
    button.append(text);
  }

  function tabButton(board, showDirection = false) {
    const index = boards.indexOf(board);
    const button = el(doc, 'button', 'tab');
    tabContent(button, board.preset, showDirection);
    button.type = 'button';
    button.title = board.preset.label;
    button.setAttribute('aria-label', board.preset.label);
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(index === activeIndex));
    button.addEventListener('click', () => {
      userPicked = true;
      activeIndex = index;
      renderTabs();
      tick();
    });
    return button;
  }

  /**
   * Row 1: the presets. Row 2: the nearby board (with its close button) if
   * one is open, otherwise the favorites; left out when empty.
   */
  function renderTabs() {
    const presetRow = el(doc, 'div', 'tab-row');
    presetRow.setAttribute('role', 'presentation');
    presetRow.append(...boards.slice(0, presets.length).map((b) => tabButton(b)));
    const rows = [presetRow];

    const nearbyIndex = nearbyBoardIndex();
    const second = nearbyIndex >= 0 ? [boards[nearbyIndex]] :
        boards.filter((b) => b.preset.favorite);
    if (second.length) {
      const row = el(doc, 'div', 'tab-row');
      row.setAttribute('role', 'presentation');
      row.append(...second.map((b) => tabButton(b, Boolean(b.preset.favorite))));
      if (nearbyIndex >= 0) {
        const close = el(doc, 'button', 'tab-close', '✕');
        close.type = 'button';
        close.title = 'Close this board';
        close.setAttribute('aria-label',
                           `Close ${boards[nearbyIndex].preset.label}`);
        close.addEventListener('click', closeNearbyBoard);
        row.append(close);
      }
      rows.push(row);
    }
    ui.tabs.replaceChildren(...rows);
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
    const nodes = [
      el(doc, 'span', 'stop-name', `◉ ${name}`),
      el(doc, 'span', 'stop-filters', filters.length ? `[${filters.join(' ')}]` : ''),
    ];
    const fav = favoriteFor(board);
    if (fav) {
      const saved = isSaved(fav);
      const full = !saved && favorites.length >= MAX_FAVORITES;
      const star = el(doc, 'button', 'star', saved ? '★' : '☆');
      star.type = 'button';
      star.dataset.action = 'star';
      star.dataset.saved = String(saved);
      star.disabled = full;
      star.title = full ? `max ${MAX_FAVORITES} favorites` :
          (saved ? 'Remove from favorites' : 'Add to favorites');
      star.setAttribute('aria-label', star.title);
      star.setAttribute('aria-pressed', String(saved));
      nodes.push(star);
    }
    if (preset.id === NEARBY_BOARD_ID) {
      if (preset.following) {
        const all = el(doc, 'button', 'show-all', 'show all');
        all.type = 'button';
        all.dataset.action = 'show-all';
        nodes.push(all);
      } else if (board.lastGood) {
        nodes.push(el(doc, 'span', 'stop-hint', 'tap a departure to follow it'));
      }
    }
    replaceIfChanged(ui.stopHeader, nodes);
  }

  function departureRow(dep, stopName, now, pickable) {
    const state = ojp.departureState(dep);
    const row = el(doc, 'li', `departure ${state}`);
    if (pickable) {
      row.classList.add('pickable');
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.dataset.line = dep.line;
      row.dataset.direction = ojp.shortenDestination(dep.destination, stopName);
      row.dataset.mode = dep.mode.toLowerCase();
    }
    const countdown = ojp.formatCountdown(ojp.effectiveTime(dep), now);

    const line = el(doc, 'span', 'line', dep.line);
    // Trams get their line color (see style.css). Only trams: bus numbers
    // elsewhere (e.g. Winterthur bus 2) overlap the Zurich tram numbers.
    // Cancelled rows stay grey.
    if (dep.mode.toLowerCase() === 'tram' && state !== ojp.State.CANCELLED) {
      line.dataset.tram = dep.line.trim();
    }
    row.append(line);
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

  function departureNodes(board, filtered, now) {
    if (!board.lastGood) {
      const msg = board.lastError ? `! ${board.lastError}` :
          (token ? 'loading…' : 'Enter your OJP API key to start.');
      return [el(doc, 'li', board.lastError ? 'message error' : 'message', msg)];
    }
    if (!filtered.length) {
      const nodes = [el(doc, 'li', 'message', '(no matching departures)')];
      const {preset} = board;
      const all = ojp.destinationsForLines(board.lastGood.departures, preset.lines);
      if (preset.direction && all.length) {
        const names = all.map((d) => ojp.shortenDestination(d, board.lastGood.stop.name));
        nodes.push(el(
            doc, 'li', 'message hint',
            `Line ${preset.lines.join(',')} here goes to: ${names.join(', ')}`));
      }
      return nodes;
    }
    const pickable = board.preset.id === NEARBY_BOARD_ID &&
        !board.preset.following;
    const nodes = [];
    const seenSituations = new Set();
    for (const dep of filtered) {
      nodes.push(departureRow(dep, board.lastGood.stop.name, now, pickable));
      for (const situation of dep.situations) {
        if (seenSituations.has(situation)) continue;
        seenSituations.add(situation);
        nodes.push(el(doc, 'li', 'situation', `▲ ${situation}`));
      }
    }
    return nodes;
  }

  function renderDepartures(board, filtered, now) {
    replaceIfChanged(ui.departures, departureNodes(board, filtered, now));
  }

  // Delegated, so the handlers survive re-renders.
  function pickableRow(target) {
    const row = target.closest && target.closest('li.pickable');
    return row && ui.departures.contains(row) ? row : null;
  }
  function followRow(row) {
    setNearbyFollow({
      line: row.dataset.line,
      direction: row.dataset.direction,
      mode: row.dataset.mode,
    });
  }
  ui.departures.addEventListener('click', (event) => {
    const row = pickableRow(event.target);
    if (row) followRow(row);
  });
  ui.departures.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = pickableRow(event.target);
    if (!row) return;
    event.preventDefault();
    followRow(row);
  });
  ui.stopHeader.addEventListener('click', (event) => {
    const button = event.target.closest && event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    if (button.dataset.action === 'show-all') setNearbyFollow(null);
    if (button.dataset.action === 'star') toggleFavorite();
  });

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
