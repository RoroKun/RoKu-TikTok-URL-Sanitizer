'use strict';

/**
 * TikTok link cleaner (same behaviour as the original build).
 *
 * Short links (vm.tiktok.com, vt.tiktok.com, tiktok.com/t/...) only
 * reveal the real video after a redirect, so they're expanded by reading
 * redirect headers only (HEAD, or a GET whose body is cancelled unread);
 * the video itself is never fetched. Then the query string and fragment
 * are dropped, leaving the canonical @user/video/<id> URL.
 */

const { UpstreamError } = require('./errors');
const { queryKeys } = require('./query');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const SHORT_LINK_HOSTS = new Set(['vm.tiktok.com', 'vt.tiktok.com']);
const TIKTOK_HOST_SUFFIX = 'tiktok.com';
const REQUEST_TIMEOUT_MS = 8000;

function isTikTokHost(hostname) {
  const host = String(hostname).toLowerCase();
  return host === TIKTOK_HOST_SUFFIX || host.endsWith('.' + TIKTOK_HOST_SUFFIX);
}

function needsResolution(url) {
  const host = url.hostname.toLowerCase();
  if (SHORT_LINK_HOSTS.has(host)) return true;
  return isTikTokHost(host) && /^\/t\/[^/]+\/?$/.test(url.pathname);
}

/** Drop the query string and fragment; keep host and path only. */
function stripTracking(rawUrl) {
  const url = new URL(rawUrl);
  let host = url.host.toLowerCase(); // includes port, if any
  // tiktok.com and www.tiktok.com serve the same content; normalise to
  // www for a single consistent canonical form.
  if (host === TIKTOK_HOST_SUFFIX) host = 'www.' + TIKTOK_HOST_SUFFIX;
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return `https://${host}${path}`;
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Follow a short link's redirect chain without downloading any response
 * body. Tries HEAD first (cheapest); falls back to a GET whose body is
 * cancelled unread for edges that reject HEAD (an error status with no
 * redirect, or a network error).
 */
async function resolveRedirect(url) {
  const headers = { 'User-Agent': USER_AGENT };

  try {
    const resp = await fetchWithTimeout(url, { method: 'HEAD', redirect: 'follow', headers });
    if (resp.body) resp.body.cancel().catch(() => {});
    if (resp.url && (resp.ok || resp.url !== url)) return resp.url;
  } catch (_) {
    // fall through to the GET fallback
  }

  const resp = await fetchWithTimeout(url, { method: 'GET', redirect: 'follow', headers });
  if (resp.body) resp.body.cancel().catch(() => {});
  return resp.url;
}

/** True if a resolved short link landed on an actual TikTok page. */
function isExpandedTikTokPage(resolvedUrl) {
  let url;
  try {
    url = new URL(resolvedUrl);
  } catch (_) {
    return false;
  }
  if (!isTikTokHost(url.hostname) || needsResolution(url)) return false;
  const path = url.pathname.toLowerCase();
  return path !== '/' && !/^\/(login|404|notfound)(\/|$)/.test(path);
}

/** Clean a TikTok link (a URL object whose host passed isTikTokHost). */
async function cleanTikTokUrl(url) {
  let workingUrl = url.href;
  let resolvedRedirect = false;

  if (needsResolution(url)) {
    try {
      workingUrl = await resolveRedirect(workingUrl);
    } catch (err) {
      throw new UpstreamError(
        "Couldn't reach TikTok to expand that short link. Try again in a moment.",
        err
      );
    }
    // Never hand back an unexpanded short link: its code is unique to the
    // share. That happens when TikTok answers with an error (rate limit,
    // bot check...) instead of a redirect, or redirects to a dead end.
    if (!isExpandedTikTokPage(workingUrl)) {
      throw new UpstreamError(
        "TikTok didn't say where that short link goes. Try again in a moment, " +
          'or open it in TikTok and copy the full link.'
      );
    }
    resolvedRedirect = true;
  }

  return {
    platform: 'tiktok',
    clean_url: stripTracking(workingUrl),
    resolved_redirect: resolvedRedirect,
    removed: queryKeys(new URL(workingUrl).search),
    notes: [],
  };
}

module.exports = {
  isTikTokHost,
  needsResolution,
  stripTracking,
  resolveRedirect,
  cleanTikTokUrl,
};
