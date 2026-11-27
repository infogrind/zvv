/**
 * @fileoverview Seasonal decorations. From 1 December to 6 January (Zurich
 * time) the page gets the `xmas` class on <html>, which style.css uses for a
 * few unobtrusive Christmas touches. `?xmas=1` / `?xmas=0` in the URL force
 * it on or off, e.g. to try it out in other months.
 */

import {ZURICH_TZ} from './ojp.js';

const zurichMonthDay = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZURICH_TZ,
  month: 'numeric',
  day: 'numeric',
});

/** True from 1 December to 6 January (Epiphany), in Zurich. */
export function isChristmasSeason(date) {
  const parts = Object.fromEntries(
      zurichMonthDay.formatToParts(date).map((p) => [p.type, Number(p.value)]));
  return parts.month === 12 || (parts.month === 1 && parts.day <= 6);
}

/** The `xmas` URL parameter as true/false, or null when absent. */
export function christmasOverride(search) {
  const value = new URLSearchParams(search).get('xmas');
  if (value === null) return null;
  return !['0', 'false', 'off', 'no'].includes(value.toLowerCase());
}

/**
 * Sets or clears the `xmas` class, and re-checks whenever the page becomes
 * visible again (a home-screen app can stay open from November into
 * December).
 */
export function applySeason({
  doc = document,
  search = window.location.search,
  clock = () => new Date(),
} = {}) {
  const override = christmasOverride(search);
  const update = () => {
    const on = override ?? isChristmasSeason(clock());
    doc.documentElement.classList.toggle('xmas', on);
  };
  update();
  doc.addEventListener('visibilitychange', update);
}
