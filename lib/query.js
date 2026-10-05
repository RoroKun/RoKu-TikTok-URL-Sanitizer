'use strict';

/**
 * Small helpers for working with query strings without re-encoding
 * them. (URLSearchParams.toString() rewrites encodings, e.g. %20 -> +,
 * which can subtly change a third-party URL we only meant to trim.)
 */

// Tracking parameters that are safe to remove from any site's URLs.
// Only used on the destination of an unwrapped YouTube redirect link.
const GENERIC_TRACKERS = new Set([
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid',
  'yclid', 'twclid', 'ttclid', 'igshid', 'igsh', 'mc_cid', 'mc_eid',
  '_ga', '_gl', '_hsenc', '_hsmi', 'mkt_tok',
]);
const GENERIC_TRACKER_PREFIXES = ['utm_'];

function safeDecode(component) {
  try {
    return decodeURIComponent(component.replace(/\+/g, ' '));
  } catch (_) {
    return component;
  }
}

/** Parameter names in the order they appear, without duplicates. */
function queryKeys(search) {
  const keys = [];
  for (const pair of String(search || '').replace(/^\?/, '').split('&')) {
    if (!pair) continue;
    const key = safeDecode(pair.split('=')[0]);
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * Keep only the raw "key=value" pairs whose key passes `shouldKeep`.
 * Returns the new search string ('' or '?a=b&c=d') and the removed keys.
 */
function filterQuery(search, shouldKeep) {
  const kept = [];
  const removed = [];
  for (const pair of String(search || '').replace(/^\?/, '').split('&')) {
    if (!pair) continue;
    const key = safeDecode(pair.split('=')[0]);
    if (shouldKeep(key)) {
      kept.push(pair);
    } else if (!removed.includes(key)) {
      removed.push(key);
    }
  }
  return { search: kept.length ? `?${kept.join('&')}` : '', removed };
}

function isGenericTracker(key) {
  const k = key.toLowerCase();
  return GENERIC_TRACKERS.has(k) || GENERIC_TRACKER_PREFIXES.some((p) => k.startsWith(p));
}

/** Remove universally-recognised trackers (utm_*, fbclid, gclid...) from any URL. */
function stripGenericTrackers(url) {
  const { search, removed } = filterQuery(url.search, (key) => !isGenericTracker(key));
  const clean = `${url.protocol}//${url.host}${url.pathname}${search}${url.hash}`;
  return { url: clean, removed };
}

module.exports = { queryKeys, filterQuery, isGenericTracker, stripGenericTrackers };
