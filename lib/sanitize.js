'use strict';

/**
 * Entry point for cleaning: find the link in whatever was pasted (share
 * sheets often add text around it) and hand it to the right cleaner.
 */

const { LinkError } = require('./errors');
const tiktok = require('./tiktok');
const youtube = require('./youtube');

const MAX_INPUT_LENGTH = 4096;
// Full http(s) links anywhere in the text...
const LINK_RE = /https?:\/\/[^\s<>"'`]+/gi;
// ...and scheme-less links to a supported site, e.g. "youtu.be/abc".
const BARE_LINK_RE =
  /(?:^|[\s(<"'])((?:[a-z0-9-]+\.)*(?:tiktok\.com|youtube\.com|youtu\.be|youtube-nocookie\.com)(?:[/?#][^\s<>"'`]*)?)/gi;
const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}>"'`»…]+$/;

function isSupportedHost(hostname) {
  return tiktok.isTikTokHost(hostname) || youtube.isYouTubeHost(hostname);
}

function toUrl(candidate) {
  const trimmed = candidate.replace(TRAILING_PUNCTUATION_RE, '');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return /^https?:$/.test(url.protocol) ? url : null;
  } catch (_) {
    return null;
  }
}

/**
 * Pick the link to clean: the first TikTok/YouTube link in the text,
 * else the first link of any kind (so the error can say it's unsupported).
 */
function extractLink(rawInput) {
  const text = String(rawInput == null ? '' : rawInput).trim();
  if (!text) throw new LinkError('Paste a TikTok or YouTube link first.');
  if (text.length > MAX_INPUT_LENGTH) {
    throw new LinkError('That text is too long. Paste just the link.');
  }

  const candidates = [
    ...Array.from(text.matchAll(LINK_RE), (m) => m[0]),
    ...Array.from(text.matchAll(BARE_LINK_RE), (m) => m[1]),
    text.split(/\s+/)[0],
  ];
  const urls = candidates.map(toUrl).filter(Boolean);
  const link = urls.find((url) => isSupportedHost(url.hostname)) || urls[0];
  if (!link) throw new LinkError("That doesn't look like a link.");
  return link;
}

/** Clean one pasted link. Resolves to the API response body. */
async function cleanLink(rawInput) {
  const url = extractLink(rawInput);
  let result;
  if (tiktok.isTikTokHost(url.hostname)) {
    result = await tiktok.cleanTikTokUrl(url);
  } else if (youtube.isYouTubeHost(url.hostname)) {
    result = youtube.cleanYouTubeUrl(url);
  } else {
    throw new LinkError("That doesn't look like a TikTok or YouTube link.");
  }
  return { original_url: url.href, ...result };
}

module.exports = { cleanLink, extractLink, isSupportedHost };
