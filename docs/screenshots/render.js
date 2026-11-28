/**
 * @fileoverview Renders the README screenshots with sample data.
 *
 * Step-by-step instructions: README.md, "Regenerating the screenshots".
 * In short, with Playwright installed and the app served on port 8765:
 *
 *   python3 -m http.server 8765        # in the repository root
 *   node docs/screenshots/render.js    # writes the PNGs next to this file
 *
 * All OJP responses, the location, the clock (07:42:10 in Zurich) and two
 * saved favorites are faked, so no API key is needed and the pictures look
 * the same each run.
 */
const {chromium} = require('playwright');
const OUT = process.argv[2] || __dirname;
const NOW = new Date('2026-11-27T06:42:10Z'); // 07:42:10 in Zurich
const at = (min, sec = 0) => new Date(NOW.getTime() + min * 60000 + sec * 1000).toISOString();
const wrap = (inner) => `<?xml version="1.0"?><OJP xmlns="http://www.vdv.de/ojp" xmlns:siri="http://www.siri.org.uk/siri" version="2.0"><OJPResponse><siri:ServiceDelivery><siri:ResponseTimestamp>${NOW.toISOString()}</siri:ResponseTimestamp>${inner}</siri:ServiceDelivery></OJPResponse></OJP>`;
function ev(line, dest, min, {delay = 0, live = true, sit = ''} = {}) {
  const est = live ? `<EstimatedTime>${at(min, delay)}</EstimatedTime>` : '';
  return `<StopEventResult><StopEvent><ThisCall><CallAtStop><ServiceDeparture><TimetabledTime>${at(min)}</TimetabledTime>${est}</ServiceDeparture></CallAtStop></ThisCall>
  <Service><Mode><PtMode>tram</PtMode></Mode><PublishedServiceName><Text>${line}</Text></PublishedServiceName><DestinationText><Text>Zürich, ${dest}</Text></DestinationText>
  ${sit ? `<SituationFullRefs><SituationFullRef><siri:ParticipantRef>x</siri:ParticipantRef><siri:SituationNumber>${sit}</siri:SituationNumber></SituationFullRef></SituationFullRefs>` : ''}</Service></StopEvent></StopEventResult>`;
}
const situation = (num, summary, detail) => `<PtSituation><siri:SituationNumber>${num}</siri:SituationNumber><siri:PublishingActions><siri:PublishingAction><siri:PassengerInformationAction><siri:TextualContent><siri:SummaryContent><siri:SummaryText>${summary}</siri:SummaryText></siri:SummaryContent><siri:DescriptionContent><siri:DescriptionText>${detail}</siri:DescriptionText></siri:DescriptionContent></siri:TextualContent></siri:PassengerInformationAction></siri:PublishingAction></siri:PublishingActions></PtSituation>`;
const stopEvents = (events, sits = '') => wrap(`<OJPStopEventDelivery><siri:ResponseTimestamp>${NOW.toISOString()}</siri:ResponseTimestamp><StopEventResponseContext><Situations>${sits}</Situations></StopEventResponseContext>${events.join('')}</OJPStopEventDelivery>`);

const morning = stopEvents([
  ev('4', 'Bahnhof Altstetten Nord', 1, {delay: 10}),
  ev('4', 'Rehalp', 2),
  ev('4', 'Bahnhof Altstetten Nord', 5, {delay: 150, sit: 'S1'}),
  ev('4', 'Bahnhof Altstetten Nord', 9, {delay: 20}),
  ev('4', 'Rehalp', 10),
  ev('4', 'Bahnhof Altstetten Nord', 13),
  ev('4', 'Bahnhof Altstetten Nord', 17, {live: false}),
  ev('4', 'Bahnhof Altstetten Nord', 21, {live: false}),
], situation('S1', 'Bauarbeiten Bahnhofquai/HB', 'Linie 4 wird zwischen Central und Sihlquai/HB umgeleitet.'));

const bellevue = stopEvents([
  ev('11', 'Rehalp', 0, {delay: 5}), ev('2', 'Farbhof', 1), ev('5', 'Zoo', 2, {delay: 70}),
  ev('9', 'Triemli', 3), ev('15', 'Bucheggplatz', 4), ev('4', 'Tiefenbrunnen', 5),
  ev('8', 'Klusplatz', 5, {delay: 30}), ev('11', 'Auzelg', 6), ev('2', 'Tiefenbrunnen', 7),
  ev('9', 'Heuried', 8), ev('4', 'Bahnhof Altstetten Nord', 9), ev('15', 'Klusplatz', 10, {live: false}),
]);

const place = (ref, name, lat, lon) => `<PlaceResult><Place><StopPlace><StopPlaceRef>${ref}</StopPlaceRef><StopPlaceName><Text>${name}</Text></StopPlaceName></StopPlace><Name><Text>${name}</Text></Name><GeoPosition><siri:Longitude>${lon}</siri:Longitude><siri:Latitude>${lat}</siri:Latitude></GeoPosition></Place><Complete>true</Complete><Probability>0.5</Probability></PlaceResult>`;
const nearby = wrap(`<OJPLocationInformationDelivery>
  ${place('8503003', 'Zürich Stadelhofen', 47.36662, 8.54852)}
  ${place('8591123', 'Zürich, Opernhaus', 47.36520, 8.54690)}
  ${place('8576193', 'Zürich, Bellevue', 47.36703, 8.54497)}
  ${place('8591234', 'Zürich, Kunsthaus', 47.37020, 8.54830)}
  ${place('8591300', 'Zürich, Helmhaus', 47.37090, 8.54300)}
</OJPLocationInformationDelivery>`);

function respond(body) {
  if (body.includes('GeoRestriction')) return nearby;
  if (body.includes('8576193')) return bellevue;
  return morning;
}

async function open(browser, scheme) {
  const ctx = await browser.newContext({
    viewport: {width: 390, height: 844}, deviceScaleFactor: 2, colorScheme: scheme,
    geolocation: {latitude: 47.3669, longitude: 8.5452}, permissions: ['geolocation'],
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.clock.setFixedTime(NOW);
  await page.route('https://api.opentransportdata.swiss/**', (r) => r.fulfill({
    status: 200, contentType: 'application/xml', headers: {'Access-Control-Allow-Origin': '*'},
    body: respond(r.request().postData())}));
  await page.addInitScript(() => {
    localStorage.setItem('zvv-webapp.ojp-token', 'demo');
    localStorage.setItem('zvv-webapp.stop-refs', JSON.stringify({
      'Zürich, Wetlistrasse': {stopRef: '1', name: 'Zürich, Wetlistrasse', isStopPoint: false},
      'Zürich, Bahnhof Enge': {stopRef: '2', name: 'Zürich, Bahnhof Enge', isStopPoint: false}}));
    localStorage.setItem('zvv-webapp.favorites', JSON.stringify([
      {stopRef: '8576193', stopName: 'Zürich, Bellevue', isStopPoint: false,
       line: '11', direction: 'Rehalp', mode: 'tram'},
      {stopRef: '8591123', stopName: 'Zürich, Opernhaus', isStopPoint: false,
       line: '2', direction: 'Farbhof', mode: 'tram'}]));
  });
  await page.goto('http://localhost:8765/');
  await page.waitForSelector('.departure');
  return {ctx, page};
}

async function shot(page, path) {
  const bottom = await page.evaluate(() => Math.max(
      ...[...document.querySelectorAll('main.board, dialog[open]')]
          .map((e) => e.getBoundingClientRect().bottom + window.scrollY)));
  await page.screenshot({path, fullPage: true,
                         clip: {x: 0, y: 0, width: 390, height: Math.ceil(bottom) + 12}});
}

(async () => {
  const browser = await chromium.launch();
  let {ctx, page} = await open(browser, 'light');
  await shot(page, `${OUT}/board.png`);
  await page.click('#nearby-button');
  await page.waitForSelector('.nearby-stop');
  await shot(page, `${OUT}/nearby-stops.png`);
  await ctx.close();
  ({ctx, page} = await open(browser, 'dark'));
  await page.click('#nearby-button');
  await page.click('.nearby-stop >> nth=0');
  await page.waitForFunction(() => document.querySelectorAll('.departure').length >= 12);
  await shot(page, `${OUT}/nearby-board-dark.png`);
  await ctx.close();
  await browser.close();
})();
