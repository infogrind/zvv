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

/**
 * Starts the app.
 * @param {{doc?: !Document, storage?: !Storage, fetchFn?: Function,
 *     clock?: function(): !Date, presets?: !Array<!Object>,
 *     autoStart?: boolean}=} options Dependencies (overridable for tests).
 * @return {!Object} Handle with `tick()` and `stop()` for tests.
 */
export function startApp({
  doc = document,
  storage = window.localStorage,
  fetchFn = (...args) => window.fetch(...args),
  clock = () => new Date(),
  presets = PRESETS,
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
  };

  const boards = presets.map((preset) => ({
    preset,
    resolvedStop: null,
    lastGood: null,
    lastError: '',
    failures: 0,
    nextFetchAt: 0,
    lastAttemptAt: 0,
    inFlight: false,
  }));

  let token = storage.getItem(TOKEN_STORAGE_KEY) || '';
  let client = null;
  let activeIndex = ojp.defaultPresetIndex(presets, clock());
  let userPicked = false;
  let timer = null;
  // Bumped on every key change so responses to requests made with a
  // superseded key are ignored.
  let tokenGeneration = 0;

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
                             DEPARTURE_LIMIT) :
        [];
    renderTitle(board, now);
    renderSummary(board, filtered, now);
    renderStopHeader(board);
    renderDepartures(board, filtered, now);
    ui.refresh.disabled = !token || board.inFlight;
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
