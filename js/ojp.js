/**
 * @fileoverview OJP 2.0 client for Swiss public transport departures.
 *
 * Builds OJP 2.0 StopEventRequest / LocationInformationRequest XML, parses
 * the responses with DOMParser, and holds the pure formatting and filtering
 * helpers used by the UI. No dependencies; runs in any modern browser.
 */

export const OJP_ENDPOINT = 'https://api.opentransportdata.swiss/ojp20';
export const OJP_NS = 'http://www.vdv.de/ojp';
export const SIRI_NS = 'http://www.siri.org.uk/siri';
export const REQUESTOR_REF = 'zvv-departures-webapp';
export const ZURICH_TZ = 'Europe/Zurich';

export const DELAY_THRESHOLD_SECONDS = 60;
export const NOW_THRESHOLD_SECONDS = 30;
export const CLOCK_TIME_THRESHOLD_SECONDS = 3570; // 59m 30s -> >= 60' rounded
export const PAST_DEPARTURE_GRACE_SECONDS = 20;
export const MAX_BACKOFF_SECONDS = 300;

/** Operational states of a departure. */
export const State = Object.freeze({
  LIVE: 'live',
  DELAYED: 'delayed',
  SCHEDULED: 'scheduled',
  CANCELLED: 'cancelled',
  NOT_SERVICED: 'not_serviced',
});

/** Error raised for OJP failures. Messages never contain the API key. */
export class OjpError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, retryAfterSeconds?: ?number}=} options
   */
  constructor(message, {status = 0, retryAfterSeconds = null} = {}) {
    super(message);
    this.name = 'OjpError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  /** True for HTTP 429 or 5xx responses that warrant backoff. */
  get isRetriable() {
    return this.status === 429 || (this.status >= 500 && this.status <= 599);
  }

  /** True when the API rejected the key. */
  get isAuthError() {
    return this.status === 401 || this.status === 403;
  }
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

/** Escapes text for inclusion in XML element content. */
export function xmlEscape(text) {
  return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
}

/** Formats a Date as UTC ISO-8601 with whole seconds. */
export function formatUtcIso(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function wrapServiceRequest(innerXml, timestamp, requestorRef, language) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      `<OJP xmlns="${OJP_NS}" xmlns:siri="${SIRI_NS}" version="2.0">\n` +
      '  <OJPRequest>\n' +
      '    <siri:ServiceRequest>\n' +
      '      <siri:ServiceRequestContext>\n' +
      `        <siri:Language>${xmlEscape(language)}</siri:Language>\n` +
      '      </siri:ServiceRequestContext>\n' +
      `      <siri:RequestTimestamp>${timestamp}</siri:RequestTimestamp>\n` +
      `      <siri:RequestorRef>${xmlEscape(requestorRef)}</siri:RequestorRef>\n` +
      innerXml +
      '    </siri:ServiceRequest>\n' +
      '  </OJPRequest>\n' +
      '</OJP>\n';
}

/**
 * Builds an OJP 2.0 OJPLocationInformationRequest for a stop name.
 * @param {string} stopName
 * @param {!Date} requestTime
 * @param {{maxResults?: number, requestorRef?: string, language?: string}=} options
 * @return {string}
 */
export function buildLocationRequestXml(
    stopName, requestTime,
    {maxResults = 10, requestorRef = REQUESTOR_REF, language = 'de'} = {}) {
  const name = String(stopName).trim();
  if (!name) throw new Error('stopName must not be empty');
  const ts = formatUtcIso(requestTime);
  const count = Math.max(1, Math.floor(maxResults));
  const inner =
      '      <OJPLocationInformationRequest>\n' +
      `        <siri:RequestTimestamp>${ts}</siri:RequestTimestamp>\n` +
      '        <InitialInput>\n' +
      `          <Name>${xmlEscape(name)}</Name>\n` +
      '        </InitialInput>\n' +
      '        <Restrictions>\n' +
      '          <Type>stop</Type>\n' +
      `          <NumberOfResults>${count}</NumberOfResults>\n` +
      '        </Restrictions>\n' +
      '      </OJPLocationInformationRequest>\n';
  return wrapServiceRequest(inner, ts, requestorRef, language);
}

/** Formats a coordinate in decimal degrees for OJP (WGS84). */
function formatCoordinate(value, name, limit) {
  const num = Number(value);
  if (!Number.isFinite(num) || Math.abs(num) > limit) {
    throw new Error(`${name} must be a number within ±${limit}`);
  }
  return num.toFixed(6);
}

/**
 * Builds an OJP 2.0 OJPLocationInformationRequest for stops within a circle
 * around a WGS84 coordinate.
 * @param {{latitude: number, longitude: number}} position
 * @param {!Date} requestTime
 * @param {{radiusMeters?: number, maxResults?: number, requestorRef?: string,
 *     language?: string}=} options
 * @return {string}
 */
export function buildNearbyStopsRequestXml(
    position, requestTime,
    {radiusMeters = 1000, maxResults = 20, requestorRef = REQUESTOR_REF,
     language = 'de'} = {}) {
  const lat = formatCoordinate(position.latitude, 'latitude', 90);
  const lon = formatCoordinate(position.longitude, 'longitude', 180);
  const radius = Math.max(1, Math.round(radiusMeters));
  const count = Math.max(1, Math.floor(maxResults));
  const ts = formatUtcIso(requestTime);
  const inner =
      '      <OJPLocationInformationRequest>\n' +
      `        <siri:RequestTimestamp>${ts}</siri:RequestTimestamp>\n` +
      '        <InitialInput>\n' +
      '          <GeoRestriction>\n' +
      '            <Circle>\n' +
      '              <Center>\n' +
      `                <siri:Longitude>${lon}</siri:Longitude>\n` +
      `                <siri:Latitude>${lat}</siri:Latitude>\n` +
      '              </Center>\n' +
      `              <Radius>${radius}</Radius>\n` +
      '            </Circle>\n' +
      '          </GeoRestriction>\n' +
      '        </InitialInput>\n' +
      '        <Restrictions>\n' +
      '          <Type>stop</Type>\n' +
      `          <NumberOfResults>${count}</NumberOfResults>\n` +
      '        </Restrictions>\n' +
      '      </OJPLocationInformationRequest>\n';
  return wrapServiceRequest(inner, ts, requestorRef, language);
}

/**
 * Builds an OJP 2.0 OJPStopEventRequest for departures at a stop.
 * @param {{stopRef: string, name: string, isStopPoint: boolean}} stop
 * @param {!Date} departureTime
 * @param {{numResults?: number, requestorRef?: string, language?: string}=} options
 * @return {string}
 */
export function buildStopEventRequestXml(
    stop, departureTime,
    {numResults = 24, requestorRef = REQUESTOR_REF, language = 'de'} = {}) {
  const ts = formatUtcIso(departureTime);
  const count = Math.max(1, Math.floor(numResults));
  const ref = xmlEscape(stop.stopRef);
  const refXml = stop.isStopPoint ?
      `<siri:StopPointRef>${ref}</siri:StopPointRef>` :
      `<StopPlaceRef>${ref}</StopPlaceRef>`;
  const inner =
      '      <OJPStopEventRequest>\n' +
      `        <siri:RequestTimestamp>${ts}</siri:RequestTimestamp>\n` +
      '        <Location>\n' +
      '          <PlaceRef>\n' +
      `            ${refXml}\n` +
      `            <Name><Text>${xmlEscape(stop.name)}</Text></Name>\n` +
      '          </PlaceRef>\n' +
      `          <DepArrTime>${ts}</DepArrTime>\n` +
      '        </Location>\n' +
      '        <Params>\n' +
      `          <NumberOfResults>${count}</NumberOfResults>\n` +
      '          <StopEventType>departure</StopEventType>\n' +
      '          <IncludePreviousCalls>false</IncludePreviousCalls>\n' +
      '          <IncludeOnwardCalls>false</IncludeOnwardCalls>\n' +
      '          <UseRealtimeData>explanatory</UseRealtimeData>\n' +
      '        </Params>\n' +
      '      </OJPStopEventRequest>\n';
  return wrapServiceRequest(inner, ts, requestorRef, language);
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

const KNOWN_NS = [OJP_NS, SIRI_NS];

function isNamed(node, localName) {
  return node.nodeType === 1 && node.localName === localName &&
      KNOWN_NS.includes(node.namespaceURI);
}

/** Returns the first direct child element named localName (OJP or SIRI). */
function child(el, localName) {
  if (!el) return null;
  for (const node of el.childNodes) {
    if (isNamed(node, localName)) return node;
  }
  return null;
}

/** Returns all direct child elements named localName (OJP or SIRI). */
function children(el, localName) {
  if (!el) return [];
  return Array.from(el.childNodes).filter((n) => isNamed(n, localName));
}

/** Follows a '/'-separated path of direct children. */
function path(el, pathSpec) {
  let cur = el;
  for (const part of pathSpec.split('/')) {
    cur = child(cur, part);
    if (!cur) return null;
  }
  return cur;
}

/** Returns all descendant elements named localName (OJP or SIRI). */
function descendants(el, localName) {
  if (!el) return [];
  const out = [];
  for (const ns of KNOWN_NS) {
    out.push(...el.getElementsByTagNameNS(ns, localName));
  }
  if (KNOWN_NS.length > 1) {
    // Restore document order when both namespaces matched.
    out.sort((a, b) => (a.compareDocumentPosition(b) & 4) ? -1 : 1);
  }
  return out;
}

/** Returns trimmed text at pathSpec under el, or ''. */
function text(el, pathSpec) {
  const found = pathSpec ? path(el, pathSpec) : el;
  return found && found.textContent ? found.textContent.trim() : '';
}

function xmlBool(el, pathSpec) {
  const val = text(el, pathSpec).toLowerCase();
  return val === 'true' || val === '1';
}

function parseIsoDate(raw) {
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new OjpError(`Invalid OJP timestamp: ${JSON.stringify(raw)}`);
  }
  return date;
}

/** Parses XML text into a Document, raising OjpError when malformed. */
export function parseXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0 ||
      !doc.documentElement) {
    throw new OjpError('Malformed OJP XML response');
  }
  return doc;
}

/** Raises OjpError when the delivery or ServiceDelivery reports an error. */
function checkSiriErrors(root, delivery) {
  const scopes = [delivery, descendants(root, 'ServiceDelivery')[0]];
  for (const scope of scopes) {
    if (!scope) continue;
    let errCond = child(scope, 'ErrorCondition');
    const status = text(scope, 'Status').toLowerCase();
    if (errCond || status === 'false') {
      if (!errCond) errCond = descendants(root, 'ErrorCondition')[0] || null;
      let desc = text(errCond, 'Description');
      if (!desc && errCond) {
        const errText = descendants(errCond, 'ErrorText')[0];
        desc = errText ? text(errText) : '';
      }
      throw new OjpError(
          `OJP service error: ${desc || 'OJP service returned Status=false'}`);
    }
  }
}

/** Reads Place/GeoPosition as {latitude, longitude}, or null. */
function parseGeoPosition(place) {
  const geo = child(place, 'GeoPosition');
  if (!geo) return null;
  const latitude = parseFloat(text(geo, 'Latitude'));
  const longitude = parseFloat(text(geo, 'Longitude'));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {latitude, longitude};
}

/**
 * Parses StopPlace and StopPoint results from a LocationInformation response.
 * @param {string} xmlText
 * @return {!Array<{stopRef: string, name: string, isStopPoint: boolean,
 *     probability: number, position: ?{latitude: number, longitude: number}}>}
 */
export function parseLocationResponseXml(xmlText) {
  const root = parseXml(xmlText).documentElement;
  const delivery = descendants(root, 'OJPLocationInformationDelivery')[0];
  checkSiriErrors(root, delivery);
  if (!delivery) {
    throw new OjpError('Missing OJPLocationInformationDelivery in response');
  }
  const results = [];
  for (const placeRes of children(delivery, 'PlaceResult')) {
    const place = child(placeRes, 'Place') || child(placeRes, 'Location');
    if (!place) continue;
    const probability = parseFloat(text(placeRes, 'Probability')) || 0;
    const label = text(place, 'Name/Text');
    const position = parseGeoPosition(place);
    const stopPlace = child(place, 'StopPlace');
    if (stopPlace) {
      const stopRef = text(stopPlace, 'StopPlaceRef');
      if (stopRef) {
        results.push({
          stopRef,
          name: text(stopPlace, 'StopPlaceName/Text') || label || stopRef,
          isStopPoint: false,
          probability,
          position,
        });
        continue;
      }
    }
    const stopPoint = child(place, 'StopPoint');
    if (stopPoint) {
      const pointRef = text(stopPoint, 'StopPointRef');
      if (pointRef) {
        results.push({
          stopRef: pointRef,
          name: text(stopPoint, 'StopPointName/Text') || label || pointRef,
          isStopPoint: true,
          probability,
          position,
        });
      }
    }
  }
  return results;
}

const EARTH_RADIUS_METERS = 6371008.8;

/** Great-circle distance in metres between two WGS84 positions. */
export function distanceMeters(a, b) {
  const rad = (deg) => deg * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "180 m" below 1 km (rounded to 10 m), otherwise "1.2 km". */
export function formatDistance(meters) {
  if (meters < 995) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/**
 * The closest distinct stops to `origin`, nearest first, each with a
 * `distanceMeters` field. Whole stops (stop places) are preferred: a platform
 * (stop point) is kept only when no stop of the same name is in the list.
 * Results without coordinates sort last, in server order.
 */
export function nearestStops(candidates, origin, limit = 5) {
  const byName = new Map();
  for (const cand of candidates) {
    const key = normalizeStopText(cand.name);
    const prev = byName.get(key);
    if (!prev || (prev.isStopPoint && !cand.isStopPoint)) {
      byName.set(key, cand);
    }
  }
  return Array.from(byName.values())
      .map((cand, index) => ({
        ...cand,
        index,
        distanceMeters: cand.position ?
            distanceMeters(origin, cand.position) : null,
      }))
      .sort((a, b) => {
        if (a.distanceMeters === null || b.distanceMeters === null) {
          if (a.distanceMeters !== b.distanceMeters) {
            return a.distanceMeters === null ? 1 : -1;
          }
          return a.index - b.index;
        }
        return a.distanceMeters - b.distanceMeters;
      })
      .slice(0, limit)
      .map(({index, ...stop}) => stop);
}

function normalizeStopText(value) {
  return String(value).normalize('NFC').split(/\s+/).filter(Boolean)
      .join(' ').toLowerCase();
}

/**
 * Picks the best candidate for a stop query: exact name, then "Zürich, <query>",
 * then Zurich stops containing the query, then any match; stop places beat
 * quays, then higher probability wins.
 */
export function selectBestStop(query, candidates) {
  if (!candidates.length) {
    throw new OjpError(`No OJP stop found for ${JSON.stringify(query)}`);
  }
  const normQuery = normalizeStopText(query);
  const zhQueries = [`zürich, ${normQuery}`, `zurich, ${normQuery}`];
  const rank = (cand) => {
    const name = normalizeStopText(cand.name);
    let tier = 0;
    if (name === normQuery) {
      tier = 4;
    } else if (zhQueries.includes(name)) {
      tier = 3;
    } else if ((name.startsWith('zürich,') || name.startsWith('zürich ')) &&
               name.includes(normQuery)) {
      tier = 2;
    } else if (name.includes(normQuery)) {
      tier = 1;
    }
    return [tier, cand.isStopPoint ? 0 : 1, cand.probability];
  };
  let best = candidates[0];
  let bestRank = rank(best);
  for (const cand of candidates.slice(1)) {
    const r = rank(cand);
    for (let i = 0; i < r.length; i++) {
      if (r[i] !== bestRank[i]) {
        if (r[i] > bestRank[i]) {
          best = cand;
          bestRank = r;
        }
        break;
      }
    }
  }
  return best;
}

function extractSituationText(ptSit) {
  const summaries = [];
  const details = [];
  for (const tc of descendants(ptSit, 'TextualContent')) {
    if (!tc.parentNode || !isNamed(tc.parentNode, 'PassengerInformationAction')) {
      continue;
    }
    const summary = text(tc, 'SummaryContent/SummaryText');
    if (summary && !summaries.includes(summary)) summaries.push(summary);
    for (const detailPath of [
           'DescriptionContent/DescriptionText',
           'ReasonContent/ReasonText',
           'ConsequenceContent/ConsequenceText',
         ]) {
      const detail = text(tc, detailPath);
      if (detail && !details.includes(detail) && !summaries.includes(detail)) {
        details.push(detail);
      }
    }
  }
  if (!summaries.length && !details.length) {
    const summary = text(ptSit, 'Summary');
    if (summary) summaries.push(summary);
    for (const name of ['Description', 'Detail']) {
      const detail = text(ptSit, name);
      if (detail && !details.includes(detail) && !summaries.includes(detail)) {
        details.push(detail);
      }
    }
  }
  const head = summaries.join('; ');
  const body = details.join(' ');
  return head && body ? `${head}: ${body}` : (head || body);
}

function parseSituationsMap(delivery) {
  const situations = new Map();
  for (const container of descendants(delivery, 'Situations')) {
    const elements = [
      ...children(container, 'PtSituation'),
      ...children(container, 'PtSituationElement'),
    ];
    for (const ptSit of elements) {
      const num = text(ptSit, 'SituationNumber');
      if (!num) continue;
      const msg = extractSituationText(ptSit);
      if (msg) situations.set(num, msg.split(/\s+/).join(' '));
    }
  }
  return situations;
}

function parseStopEvent(stopEvent, situations) {
  const call = path(stopEvent, 'ThisCall/CallAtStop') ||
      child(stopEvent, 'CallAtStop');
  if (!call) return null;
  const service = child(stopEvent, 'Service') || child(call, 'Service');
  const dep = child(call, 'ServiceDeparture') || child(call, 'ServiceArrival');
  if (!dep) return null;
  const timetabledTime = parseIsoDate(text(dep, 'TimetabledTime'));
  if (!timetabledTime) return null;

  const attached = [];
  for (const ref of descendants(stopEvent, 'SituationFullRef')) {
    const msg = situations.get(text(ref, 'SituationNumber'));
    if (msg && !attached.includes(msg)) attached.push(msg);
  }

  return {
    line: text(service, 'PublishedServiceName/Text') ||
        text(service, 'PublishedLineName/Text') || '?',
    destination: text(service, 'DestinationText/Text'),
    mode: text(service, 'Mode/PtMode'),
    timetabledTime,
    estimatedTime: parseIsoDate(text(dep, 'EstimatedTime')),
    cancelled: xmlBool(service, 'Cancelled'),
    notServiced: xmlBool(call, 'NotServicedStop'),
    noBoarding: xmlBool(call, 'NoBoardingAtStop'),
    deviation: xmlBool(service, 'Deviation'),
    unplanned: xmlBool(service, 'Unplanned'),
    directionRef: text(service, 'DirectionRef'),
    plannedQuay: text(call, 'PlannedQuay/Text'),
    estimatedQuay: text(call, 'EstimatedQuay/Text'),
    situations: attached,
  };
}

/**
 * Parses an OJP 2.0 StopEvent response into a departure board snapshot.
 * @param {string} xmlText
 * @param {{stop: !Object, fetchedAt: !Date}} context
 */
export function parseStopEventResponseXml(xmlText, {stop, fetchedAt}) {
  const root = parseXml(xmlText).documentElement;
  const delivery = descendants(root, 'OJPStopEventDelivery')[0];
  checkSiriErrors(root, delivery);
  if (!delivery) throw new OjpError('Missing OJPStopEventDelivery in response');
  const situations = parseSituationsMap(delivery);
  const departures = [];
  for (const stopEvent of descendants(delivery, 'StopEvent')) {
    const parsed = parseStopEvent(stopEvent, situations);
    if (parsed) departures.push(parsed);
  }
  departures.sort((a, b) => effectiveTime(a) - effectiveTime(b));
  return {
    stop,
    fetchedAt,
    responseTimestamp: parseIsoDate(text(delivery, 'ResponseTimestamp')),
    departures,
  };
}

// ---------------------------------------------------------------------------
// Departure helpers
// ---------------------------------------------------------------------------

/** Forecast time when available, otherwise the timetabled time. */
export function effectiveTime(dep) {
  return dep.estimatedTime || dep.timetabledTime;
}

/** Forecast delay in whole seconds, or null when timetable-only. */
export function delaySeconds(dep) {
  if (!dep.estimatedTime) return null;
  return Math.round((dep.estimatedTime - dep.timetabledTime) / 1000);
}

/** Whole minutes of delay when delayed (>= 60 s), otherwise 0. */
export function delayMinutes(dep) {
  const s = delaySeconds(dep);
  if (s === null || s < DELAY_THRESHOLD_SECONDS) return 0;
  return Math.floor(s / 60);
}

/** Primary operational state for display. */
export function departureState(dep) {
  if (dep.cancelled) return State.CANCELLED;
  if (dep.notServiced || dep.noBoarding) return State.NOT_SERVICED;
  const s = delaySeconds(dep);
  if (s !== null && s >= DELAY_THRESHOLD_SECONDS) return State.DELAYED;
  if (dep.estimatedTime) return State.LIVE;
  return State.SCHEDULED;
}

/** Whether a departure matches the preset's line and direction filters. */
export function matchesFilters(dep, {lines = [], direction = ''}) {
  const allowed = lines.map((l) => String(l).trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(dep.line.trim().toLowerCase())) {
    return false;
  }
  const needle = String(direction).trim().toLowerCase();
  if (needle) {
    const destMatch = dep.destination.toLowerCase().includes(needle);
    const refMatch = dep.directionRef.trim().toLowerCase() === needle;
    if (!destMatch && !refMatch) return false;
  }
  return true;
}

/** Upcoming departures matching the filters, at most `limit`. */
export function filterDepartures(departures, filters, now, limit = 6) {
  const out = [];
  for (const dep of departures) {
    const remS = (effectiveTime(dep) - now) / 1000;
    if (remS < -PAST_DEPARTURE_GRACE_SECONDS) continue;
    if (!matchesFilters(dep, filters)) continue;
    out.push(dep);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Destinations served by the preset's lines, ignoring the direction filter.
 * Shown when the direction filter matches nothing, so a wrong direction
 * string is easy to spot and fix.
 */
export function destinationsForLines(departures, lines) {
  const seen = [];
  for (const dep of departures) {
    if (!matchesFilters(dep, {lines})) continue;
    if (dep.destination && !seen.includes(dep.destination)) {
      seen.push(dep.destination);
    }
  }
  return seen;
}

const zurichClockFormat = new Intl.DateTimeFormat('de-CH', {
  timeZone: ZURICH_TZ,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const zurichClockSecondsFormat = new Intl.DateTimeFormat('de-CH', {
  timeZone: ZURICH_TZ,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** HH:MM in Europe/Zurich. */
export function formatZurichClock(date) {
  return zurichClockFormat.format(date);
}

/** HH:MM:SS in Europe/Zurich. */
export function formatZurichClockSeconds(date) {
  return zurichClockSecondsFormat.format(date);
}

/** Hour of day (0-23) in Europe/Zurich. */
export function zurichHour(date) {
  return Number(new Intl.DateTimeFormat('en-GB', {
                  timeZone: ZURICH_TZ,
                  hour: 'numeric',
                  hourCycle: 'h23',
                }).format(date));
}

/**
 * Countdown with nearest-minute (+-30 s) rounding:
 * < 30 s -> "now"; < 59m30s -> "N'"; otherwise HH:MM (Europe/Zurich).
 */
export function formatCountdown(effective, now) {
  const remS = (effective - now) / 1000;
  if (remS < NOW_THRESHOLD_SECONDS) return 'now';
  if (remS < CLOCK_TIME_THRESHOLD_SECONDS) {
    return `${Math.floor((remS + 30) / 60)}'`;
  }
  return formatZurichClock(effective);
}

/** Drops the redundant "Zürich, " prefix for destinations of Zurich stops. */
export function shortenDestination(destination, stopName) {
  const prefix = 'Zürich, ';
  if (destination.startsWith(prefix) && String(stopName).startsWith('Zürich,')) {
    return destination.slice(prefix.length);
  }
  return destination;
}

/**
 * Compact stop name for a tab: drops the "Zürich, " prefix and abbreviates
 * "Bahnhof" to "Bhf." and a trailing "strasse" to "str."
 * ("Zürich, Bahnhof Enge" -> "Bhf. Enge", "Wetlistrasse" -> "Wetlistr.").
 */
export function shortenLabel(name) {
  return String(name)
      .replace(/^Zürich,\s*/, '')
      .replace(/(^|[\s,/(-])Bahnhof(?=$|[\s,/)-])/g, '$1Bhf.')
      .replace(/strasse(?=$|[\s,/)-])/g, 'str.')
      .replace(/Strasse(?=$|[\s,/)-])/g, 'Str.');
}

/** Identity of a favorite: the same stop, line and direction. */
export function favoriteKey({stopRef, line, direction}) {
  return [stopRef, line, direction].map((v) => String(v ?? '')).join('|');
}

/**
 * Index of the preset to show by default: the one with the latest
 * `defaultFromHour` that is <= the current Zurich hour.
 */
export function defaultPresetIndex(presets, now) {
  const hour = zurichHour(now);
  let bestIndex = 0;
  let bestFrom = -1;
  presets.forEach((preset, index) => {
    const from = preset.defaultFromHour || 0;
    if (from <= hour && from > bestFrom) {
      bestIndex = index;
      bestFrom = from;
    }
  });
  return bestIndex;
}

/** Exponential backoff: 2x, 4x, ... base, capped. */
export function computeBackoffSeconds(
    baseSeconds, failures, retryAfterSeconds = null) {
  const base = Math.max(1, baseSeconds);
  const exponent = Math.max(1, Math.min(10, failures));
  const computed = Math.min(MAX_BACKOFF_SECONDS, base * 2 ** exponent);
  if (retryAfterSeconds !== null && retryAfterSeconds !== undefined) {
    return Math.max(computed, Math.min(MAX_BACKOFF_SECONDS * 2, retryAfterSeconds));
  }
  return computed;
}

function parseRetryAfter(value, now) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, (date - now.getTime()) / 1000);
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

/** OJP 2.0 HTTP client. The key is only ever sent to the OJP endpoint. */
export class OjpClient {
  /**
   * @param {string} token Bearer token from api-manager.opentransportdata.swiss.
   * @param {{fetchFn?: Function, endpoint?: string, timeoutMs?: number,
   *     clock?: function(): !Date}=} options
   */
  constructor(token, {
    fetchFn = (...args) => fetch(...args),
    endpoint = OJP_ENDPOINT,
    timeoutMs = 10000,
    clock = () => new Date(),
  } = {}) {
    const clean = String(token || '').trim();
    if (!clean) throw new OjpError('Missing OJP API key');
    // Kept in a closure-like private field so it never shows up in logs.
    this.#token = clean;
    this.fetchFn = fetchFn;
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.clock = clock;
  }

  #token;

  toString() {
    return `OjpClient(${this.endpoint})`;
  }

  /** POSTs an OJP XML request and returns the response text. */
  async postXml(xml) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.#token}`,
          'Content-Type': 'application/xml; charset=utf-8',
          'Accept': 'application/xml',
        },
        body: xml,
        signal: controller.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new OjpError('OJP request timed out');
      }
      throw new OjpError(
          'Network error: offline, or the request was blocked (CORS)');
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const retryAfterSeconds =
          parseRetryAfter(response.headers.get('Retry-After'), this.clock());
      const status = response.status;
      let message = `HTTP ${status}`;
      if (status === 401 || status === 403) {
        message = `API key rejected (HTTP ${status})`;
      } else if (status === 429) {
        message = 'HTTP 429: rate limit exceeded';
      }
      throw new OjpError(message, {status, retryAfterSeconds});
    }
    return response.text();
  }

  /** Searches stops matching a name. */
  async searchStops(query, maxResults = 10) {
    const xml = buildLocationRequestXml(query, this.clock(), {maxResults});
    return parseLocationResponseXml(await this.postXml(xml));
  }

  /**
   * Finds the stops closest to a position, nearest first.
   * @param {{latitude: number, longitude: number}} position
   * @param {{limit?: number, radiusMeters?: number}=} options
   */
  async findNearbyStops(position, {limit = 5, radiusMeters = 1000} = {}) {
    // Ask for more than `limit`: platforms and duplicates are dropped, and
    // the server orders by match quality rather than by distance.
    const xml = buildNearbyStopsRequestXml(
        position, this.clock(), {radiusMeters, maxResults: limit * 4});
    const candidates = parseLocationResponseXml(await this.postXml(xml));
    return nearestStops(candidates, position, limit);
  }

  /** Resolves a stop name to the best matching stop. */
  async resolveStop(stopName) {
    return selectBestStop(stopName, await this.searchStops(stopName));
  }

  /** Fetches the current departure board for a resolved stop. */
  async fetchDepartures(stop, numResults = 24) {
    const now = this.clock();
    const xml = buildStopEventRequestXml(stop, now, {numResults});
    const body = await this.postXml(xml);
    return parseStopEventResponseXml(body, {stop, fetchedAt: now});
  }
}
