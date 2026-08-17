/**
 * netlify/functions/clean.js
 *
 * Netlify serverless function: expands TikTok short links and strips
 * tracking parameters. This is a straight port of the Python
 * sanitizer.py logic from the original Flask build, adapted to run on
 * Netlify's Node runtime.
 *
 * Nothing is logged or stored. Short links are expanded by reading
 * HTTP redirect headers only (HEAD request, or a GET whose body is
 * closed unread) — the linked video content is never fetched.
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const SHORT_LINK_HOSTS = new Set(["vm.tiktok.com", "vt.tiktok.com"]);
const TIKTOK_HOST_SUFFIX = "tiktok.com";
const REQUEST_TIMEOUT_MS = 8000;

class TikTokLinkError extends Error {}

function normalizeInput(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) throw new TikTokLinkError("Empty input.");
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return "https://" + trimmed;
  }
  return trimmed;
}

function isTikTokHost(host) {
  host = host.toLowerCase();
  return host === TIKTOK_HOST_SUFFIX || host.endsWith("." + TIKTOK_HOST_SUFFIX);
}

function needsResolution(url) {
  const host = url.hostname.toLowerCase();
  if (SHORT_LINK_HOSTS.has(host)) return true;
  if (isTikTokHost(host) && /^\/t\/[^/]+\/?$/.test(url.pathname)) return true;
  return false;
}

function stripTracking(rawUrl) {
  const url = new URL(rawUrl);
  let host = url.host.toLowerCase(); // includes port, if any
  // tiktok.com and www.tiktok.com serve the same content; normalize to
  // www for a single consistent canonical form.
  if (host === TIKTOK_HOST_SUFFIX) host = "www." + TIKTOK_HOST_SUFFIX;
  const path = url.pathname.replace(/\/+$/, "") || "/";
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
 * Follow a short link's redirect chain without downloading any
 * response body. Tries HEAD first (cheapest); falls back to a GET
 * whose body is cancelled unread for edges that reject HEAD.
 */
async function resolveRedirect(url) {
  const headers = { "User-Agent": USER_AGENT };

  try {
    const resp = await fetchWithTimeout(url, {
      method: "HEAD",
      redirect: "follow",
      headers,
    });
    if (resp.body) resp.body.cancel().catch(() => {});
    if (resp.url) return resp.url;
  } catch (_) {
    // fall through to GET fallback
  }

  const resp = await fetchWithTimeout(url, {
    method: "GET",
    redirect: "follow",
    headers,
  });
  if (resp.body) resp.body.cancel().catch(() => {});
  return resp.url;
}

async function cleanTikTokUrl(rawInput) {
  const normalized = normalizeInput(rawInput);
  const parsed = new URL(normalized);

  if (!isTikTokHost(parsed.hostname)) {
    throw new TikTokLinkError("That doesn't look like a TikTok link.");
  }

  let workingUrl = normalized;
  let resolvedRedirect = false;

  if (needsResolution(parsed)) {
    workingUrl = await resolveRedirect(normalized);
    resolvedRedirect = true;
  }

  return {
    original_url: rawInput.trim(),
    clean_url: stripTracking(workingUrl),
    resolved_redirect: resolvedRedirect,
  };
}

exports.handler = async (event) => {
  const rawUrl = (event.queryStringParameters && event.queryStringParameters.url) || "";
  const jsonHeaders = { "Content-Type": "application/json" };

  try {
    const result = await cleanTikTokUrl(rawUrl);
    return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify(result) };
  } catch (err) {
    if (err instanceof TikTokLinkError) {
      return {
        statusCode: 400,
        headers: jsonHeaders,
        body: JSON.stringify({ error: err.message }),
      };
    }
    return {
      statusCode: 502,
      headers: jsonHeaders,
      body: JSON.stringify({
        error: "Couldn't reach that link. Double-check it and try again.",
      }),
    };
  }
};

// Exported for local unit testing (see test_clean.js) — not used by Netlify.
module.exports._internal = {
  normalizeInput,
  isTikTokHost,
  needsResolution,
  stripTracking,
  resolveRedirect,
  cleanTikTokUrl,
  TikTokLinkError,
};
