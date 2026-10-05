'use strict';

/**
 * YouTube link cleaner.
 *
 * Whitelist, not blacklist: instead of chasing YouTube's tracking
 * parameters one at a time (si, is, pp, feature, ab_channel... and
 * whatever gets added next), every link is rebuilt from scratch using
 * only what it needs to work: the video, playlist or channel it points
 * to, plus an optional start time for videos. Everything else is
 * dropped, so parameters YouTube invents later are removed too.
 *
 * Behaviour:
 *   - Start times (t=, or start= on embeds) are kept, normalised to
 *     whole seconds. time_continue= is dropped: YouTube adds it
 *     automatically when someone leaves an embedded player, so it
 *     records how far they had watched rather than a chosen start point.
 *   - Playlist info (list=, index=) is dropped from video links, since a
 *     personal playlist ID can lead back to whoever made it. Links to a
 *     playlist page keep their playlist ID.
 *   - youtu.be, /live/, /embed/ and legacy /v/ links become standard
 *     https://www.youtube.com/watch?v=ID links. Shorts stay /shorts/ID.
 *   - YouTube Music links stay on music.youtube.com.
 *   - YouTube's outbound click-tracking redirects (/redirect?q=...) are
 *     unwrapped to their real destination.
 *
 * No network requests: every YouTube link carries its target in the URL.
 */

const { LinkError } = require('./errors');
const { queryKeys, stripGenericTrackers } = require('./query');

const WWW = 'https://www.youtube.com';
const MUSIC = 'https://music.youtube.com';

// Hosts that all serve the regular YouTube site; output is normalised to www.
const MAIN_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'gaming.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);
const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);
const MUSIC_HOST = 'music.youtube.com';

// Parameters that tie a link to the account that shared it. YouTube uses
// them to attribute clicks to the sharer and, where its sharing and
// messaging feature has rolled out, to show the recipient who sent it.
const SHARE_ID_PARAMS = new Set(['si', 'is']);

// 11 ID characters not followed by a 12th (tolerates junk like "ID&feature=x").
const VIDEO_ID_RE = /^([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/;
const LIST_ID_RE = /^[A-Za-z0-9_-]{2,80}$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9_-]{6,100}$/; // clip and community post IDs
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{10,40}$/;
const MAX_UNWRAP_DEPTH = 3;

const INVALID_VIDEO = "That YouTube link doesn't contain a valid video ID.";
const INCOMPLETE = 'That YouTube link looks incomplete.';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isYouTubeHost(hostname) {
  const h = String(hostname).toLowerCase();
  return (
    SHORT_HOSTS.has(h) ||
    h === 'youtube.com' ||
    h.endsWith('.youtube.com') ||
    h === 'youtube-nocookie.com' ||
    h.endsWith('.youtube-nocookie.com')
  );
}

function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch (_) {
    return segment;
  }
}

function extractVideoId(value) {
  if (!value) return null;
  const match = VIDEO_ID_RE.exec(String(value).trim());
  return match ? match[1] : null;
}

function requireVideoId(value) {
  const id = extractVideoId(value);
  if (!id) throw new LinkError(INVALID_VIDEO);
  return id;
}

/** "90", "90s", "1m30s", "1h2m3s" or "1m30" -> seconds. Anything else -> null. */
function parseTimestamp(value) {
  if (value == null) return null;
  const match = /^(?:(\d{1,3})h)?(?:(\d{1,4})m)?(?:(\d{1,7})s?)?$/i.exec(String(value).trim());
  if (!match || !match[0]) return null;
  const seconds =
    Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
  return seconds > 0 ? seconds : null;
}

/**
 * The start time someone chose: t= (watch, youtu.be, live), start=
 * (embeds) or an old-style #t= fragment. Returns the seconds and which
 * query key it came from (so that key isn't reported as removed).
 */
function findStartTime(url) {
  for (const key of ['t', 'start']) {
    if (!url.searchParams.has(key)) continue;
    const seconds = parseTimestamp(url.searchParams.get(key));
    if (seconds) return { seconds, key };
  }
  const fragment = /(?:^#|&)t=([^&]+)/.exec(url.hash || '');
  const seconds = fragment ? parseTimestamp(fragment[1]) : null;
  return { seconds, key: null };
}

function union(first, second) {
  const merged = [...first];
  for (const item of second) if (!merged.includes(item)) merged.push(item);
  return merged;
}

function cleanPath(pathname) {
  return pathname.replace(/\/+$/, '') || '/';
}

function watchUrl(videoId, seconds, base = WWW) {
  return `${base}/watch?v=${videoId}${seconds ? `&t=${seconds}` : ''}`;
}

function playlistUrl(listId, base = WWW) {
  return `${base}/playlist?list=${listId}`;
}

// ---------------------------------------------------------------------------
// Building results. Internally a result is { cleanUrl, removed, notes };
// `removed` lists every query parameter that didn't survive.
// ---------------------------------------------------------------------------

function finish(url, cleanUrl, keptKeys = [], extraRemoved = []) {
  const kept = new Set(keptKeys.filter(Boolean));
  const removed = union(
    queryKeys(url.search).filter((key) => !kept.has(key)),
    extraRemoved
  );
  return { cleanUrl, removed, notes: [] };
}

/** Like finish(), for single-video links: also explains a dropped playlist. */
function finishVideo(url, cleanUrl, keptKeys, extraRemoved) {
  const result = finish(url, cleanUrl, keptKeys, extraRemoved);
  if (url.searchParams.has('list')) {
    result.notes.push('Dropped the playlist info, so the link opens on its own.');
  }
  return result;
}

function pageOnly(url, base = WWW) {
  return finish(url, `${base}${cleanPath(url.pathname)}`);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** youtu.be/<id> */
function cleanShortLink(url) {
  const segment = decodePathSegment(url.pathname.split('/').filter(Boolean)[0] || '');
  const id = requireVideoId(segment);
  // Some apps produce "youtu.be/ID&feature=share" (no "?"): report that junk too.
  const junk = queryKeys(segment.slice(id.length).replace(/^[?&]/, ''));
  const start = findStartTime(url);
  return finishVideo(url, watchUrl(id, start.seconds), [start.key], junk);
}

/** music.youtube.com */
function cleanMusicLink(url) {
  const route = (url.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
  const params = url.searchParams;

  if (route === 'watch') {
    if (params.get('v')) {
      const id = requireVideoId(params.get('v'));
      const start = findStartTime(url);
      return finishVideo(url, watchUrl(id, start.seconds, MUSIC), ['v', start.key]);
    }
    const list = params.get('list');
    if (list && LIST_ID_RE.test(list)) return finish(url, playlistUrl(list, MUSIC), ['list']);
    throw new LinkError("That YouTube Music link doesn't contain a valid song or video ID.");
  }

  if (route === 'playlist') {
    const list = params.get('list');
    if (!list || !LIST_ID_RE.test(list)) {
      throw new LinkError('That YouTube Music playlist link is missing its playlist ID.');
    }
    return finish(url, playlistUrl(list, MUSIC), ['list']);
  }

  if (route === 'search' && params.get('q')) {
    return finish(url, `${MUSIC}/search?q=${encodeURIComponent(params.get('q'))}`, ['q']);
  }

  return pageOnly(url, MUSIC);
}

/** youtube.com, m.youtube.com, youtube-nocookie.com, ... */
function cleanMainSiteLink(url, depth) {
  const segments = url.pathname.split('/').filter(Boolean);
  const route = (segments[0] || '').toLowerCase();
  const second = decodePathSegment(segments[1] || '');
  const params = url.searchParams;

  switch (route) {
    case 'watch': {
      const rawId = params.get('v') || second; // second covers /watch/<id>
      if (rawId) {
        const id = requireVideoId(rawId);
        const start = findStartTime(url);
        return finishVideo(url, watchUrl(id, start.seconds), ['v', start.key]);
      }
      // /watch?list=... with no video: send them to the playlist page.
      const list = params.get('list');
      if (list && LIST_ID_RE.test(list)) return finish(url, playlistUrl(list), ['list']);
      throw new LinkError(INVALID_VIDEO);
    }

    case 'shorts':
      return finishVideo(url, `${WWW}/shorts/${requireVideoId(second)}`);

    case 'live': {
      if (!second) return pageOnly(url); // youtube.com/live is a hub page
      const id = requireVideoId(second);
      const start = findStartTime(url);
      return finishVideo(url, watchUrl(id, start.seconds), [start.key]);
    }

    case 'embed':
    case 'v':
    case 'e': {
      const list = params.get('list');
      if (!second || second === 'videoseries') {
        if (list && LIST_ID_RE.test(list)) return finish(url, playlistUrl(list), ['list']);
        throw new LinkError(INCOMPLETE);
      }
      if (second === 'live_stream') {
        const channel = params.get('channel');
        if (channel && CHANNEL_ID_RE.test(channel)) {
          return finish(url, `${WWW}/channel/${channel}/live`, ['channel']);
        }
        throw new LinkError(INCOMPLETE);
      }
      const id = requireVideoId(second);
      const start = findStartTime(url);
      return finishVideo(url, watchUrl(id, start.seconds), [start.key]);
    }

    case 'playlist': {
      const list = params.get('list');
      if (!list || !LIST_ID_RE.test(list)) {
        throw new LinkError('That YouTube playlist link is missing its playlist ID.');
      }
      return finish(url, playlistUrl(list), ['list']);
    }

    case 'clip':
    case 'post':
      if (!OPAQUE_ID_RE.test(second)) throw new LinkError(INCOMPLETE);
      return finish(url, `${WWW}/${route}/${second}`);

    case 'channel': {
      // Old-style community post links: /channel/<id>/community?lb=<post id>
      const lb = params.get('lb');
      if ((segments[2] || '').toLowerCase() === 'community' && lb && OPAQUE_ID_RE.test(lb)) {
        return finish(url, `${WWW}/post/${lb}`, ['lb']);
      }
      return pageOnly(url);
    }

    case 'results': {
      const query = params.get('search_query');
      if (!query) return pageOnly(url);
      return finish(url, `${WWW}/results?search_query=${encodeURIComponent(query)}`, [
        'search_query',
      ]);
    }

    case 'redirect':
      return unwrapRedirect(url, depth);

    case 'attribution_link':
      return unwrapAttributionLink(url, depth);

    default:
      // Channels (@handle, /c/, /user/, custom names), hashtags, feeds,
      // the home page...: keep the page, drop every parameter.
      return pageOnly(url);
  }
}

/** youtube.com/redirect?q=<destination>&redir_token=...&event=... */
function unwrapRedirect(url, depth) {
  let destination = null;
  try {
    destination = new URL(url.searchParams.get('q'));
  } catch (_) {
    destination = null;
  }
  if (!destination || !/^https?:$/.test(destination.protocol)) {
    throw new LinkError("That YouTube redirect link doesn't contain a destination.");
  }

  const wrapperRemoved = queryKeys(url.search).filter((key) => key !== 'q');
  const note = "Unwrapped YouTube's click-tracking redirect to the real destination.";

  if (isYouTubeHost(destination.hostname) && depth < MAX_UNWRAP_DEPTH) {
    const inner = route(destination, depth + 1);
    return {
      cleanUrl: inner.cleanUrl,
      removed: union(wrapperRemoved, inner.removed),
      notes: [note, ...inner.notes],
    };
  }

  const stripped = stripGenericTrackers(destination);
  return { cleanUrl: stripped.url, removed: union(wrapperRemoved, stripped.removed), notes: [note] };
}

/** Old share format: youtube.com/attribution_link?u=/watch%3Fv%3D... */
function unwrapAttributionLink(url, depth) {
  let target = null;
  try {
    const inner = url.searchParams.get('u');
    target = inner ? new URL(inner, WWW) : null;
  } catch (_) {
    target = null;
  }
  if (!target || !isYouTubeHost(target.hostname) || depth >= MAX_UNWRAP_DEPTH) {
    throw new LinkError(INCOMPLETE);
  }
  const inner = route(target, depth + 1);
  return {
    cleanUrl: inner.cleanUrl,
    removed: union(queryKeys(url.search).filter((key) => key !== 'u'), inner.removed),
    notes: inner.notes,
  };
}

function route(url, depth) {
  const host = url.hostname.toLowerCase();
  if (SHORT_HOSTS.has(host)) return cleanShortLink(url);
  if (host === MUSIC_HOST) return cleanMusicLink(url);
  if (MAIN_HOSTS.has(host)) return cleanMainSiteLink(url, depth);
  // Other YouTube properties (tv.youtube.com, studio.youtube.com...):
  // keep the page, drop every parameter.
  return finish(url, `https://${host}${cleanPath(url.pathname)}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function shareIdNote(keys) {
  return keys.length === 1
    ? `Removed the share ID (${keys[0]}) that tells YouTube who shared this link.`
    : `Removed the share IDs (${keys.join(', ')}) that tell YouTube who shared this link.`;
}

/**
 * Clean a YouTube link (a URL object whose host passed isYouTubeHost).
 * Throws LinkError if the link is missing the ID it needs.
 */
function cleanYouTubeUrl(url) {
  const result = route(url, 0);
  const shareIds = result.removed.filter((key) => SHARE_ID_PARAMS.has(key));
  const notes = shareIds.length ? [shareIdNote(shareIds), ...result.notes] : result.notes;
  return {
    platform: 'youtube',
    clean_url: result.cleanUrl,
    resolved_redirect: false,
    removed: result.removed,
    notes,
  };
}

module.exports = {
  isYouTubeHost,
  cleanYouTubeUrl,
  parseTimestamp,
  extractVideoId,
  SHARE_ID_PARAMS,
};
