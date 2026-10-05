'use strict';

/**
 * Test suite: run with `npm test` (or `node --test test_clean.js`).
 *
 * No dependencies and no network access needed. YouTube cleaning never
 * touches the network; TikTok short-link expansion is tested with a
 * throwaway local server and a stubbed fetch that behave like TikTok's
 * redirect.
 */

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { cleanLink, extractLink } = require('./lib/sanitize');
const { LinkError, UpstreamError } = require('./lib/errors');
const tiktok = require('./lib/tiktok');
const youtube = require('./lib/youtube');
const { stripGenericTrackers } = require('./lib/query');
const { handler } = require('./netlify/functions/clean');

const W = 'https://www.youtube.com';
const VID = 'aBcDeFgHiJk'; // any 11-character video ID
const LIST = 'PLabcdef1234567890';

async function youtubeResult(input) {
  const result = await cleanLink(input);
  assert.equal(result.platform, 'youtube');
  return result;
}

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

describe('YouTube: links are rebuilt from only what they need', () => {
  // [description, input, expected clean_url, expected removed params]
  const cases = [
    ['watch link with a share ID', `${W}/watch?v=${VID}&si=Ab12Cd34Ef56Gh78`, `${W}/watch?v=${VID}`, ['si']],
    ['youtu.be link with a share ID', `https://youtu.be/${VID}?si=Ab12Cd34Ef56Gh78`, `${W}/watch?v=${VID}`, ['si']],
    ['youtu.be link with the newer is= ID', `https://youtu.be/${VID}?is=Ab12Cd34Ef56Gh78`, `${W}/watch?v=${VID}`, ['is']],
    ['youtu.be keeps a chosen start time', `https://youtu.be/${VID}?si=x1&t=42`, `${W}/watch?v=${VID}&t=42`, ['si']],
    ['1m30s start time becomes seconds', `${W}/watch?v=${VID}&t=1m30s&pp=ygUJc2VhcmNo&feature=youtu.be&ab_channel=SomeCreator`, `${W}/watch?v=${VID}&t=90`, ['pp', 'feature', 'ab_channel']],
    ['90s start time becomes seconds', `${W}/watch?v=${VID}&t=90s`, `${W}/watch?v=${VID}&t=90`, []],
    ['mobile site', `https://m.youtube.com/watch?v=${VID}&feature=share`, `${W}/watch?v=${VID}`, ['feature']],
    ['app=desktop before the video ID', `${W}/watch?app=desktop&v=${VID}`, `${W}/watch?v=${VID}`, ['app']],
    ['playlist info is dropped from a video link', `${W}/watch?v=${VID}&list=${LIST}&index=3&si=x1`, `${W}/watch?v=${VID}`, ['list', 'index', 'si']],
    ['mix/radio params are dropped', `${W}/watch?v=${VID}&list=RD${VID}&start_radio=1&rv=${VID}`, `${W}/watch?v=${VID}`, ['list', 'start_radio', 'rv']],
    ['time_continue and embed referrers are dropped', `${W}/watch?time_continue=42&v=${VID}&embeds_referring_euri=https%3A%2F%2Fexample.com%2F&source_ve_path=MjM4NTE`, `${W}/watch?v=${VID}`, ['time_continue', 'embeds_referring_euri', 'source_ve_path']],
    ['old #t= fragment becomes t=', `${W}/watch?v=${VID}#t=30`, `${W}/watch?v=${VID}&t=30`, []],
    ['t=0 is dropped', `${W}/watch?v=${VID}&t=0`, `${W}/watch?v=${VID}`, ['t']],
    ['unreadable t= is dropped', `${W}/watch?v=${VID}&t=abc`, `${W}/watch?v=${VID}`, ['t']],
    ['generic trackers are dropped', `${W}/watch?v=${VID}&utm_source=newsletter&fbclid=IwAR0abc`, `${W}/watch?v=${VID}`, ['utm_source', 'fbclid']],
    ['Shorts stay Shorts', `https://youtube.com/shorts/${VID}?si=x1&feature=share`, `${W}/shorts/${VID}`, ['si', 'feature']],
    ['live links become watch links', `${W}/live/${VID}?si=x1&feature=share`, `${W}/watch?v=${VID}`, ['si', 'feature']],
    ['embed start= becomes t=', `${W}/embed/${VID}?start=30&end=60&autoplay=1`, `${W}/watch?v=${VID}&t=30`, ['end', 'autoplay']],
    ['privacy-enhanced embed', `https://www.youtube-nocookie.com/embed/${VID}?rel=0`, `${W}/watch?v=${VID}`, ['rel']],
    ['embedded playlist', `${W}/embed/videoseries?list=${LIST}&si=x1`, `${W}/playlist?list=${LIST}`, ['si']],
    ['legacy /v/ embed', `${W}/v/${VID}?version=3`, `${W}/watch?v=${VID}`, ['version']],
    ['playlist page keeps its playlist ID', `${W}/playlist?list=${LIST}&si=x1`, `${W}/playlist?list=${LIST}`, ['si']],
    ['watch link with only a playlist', `${W}/watch?list=${LIST}`, `${W}/playlist?list=${LIST}`, []],
    ['channel handle', `${W}/@SomeCreator?si=x1`, `${W}/@SomeCreator`, ['si']],
    ['channel tab', `https://youtube.com/@SomeCreator/videos?view=0&sort=p&si=x1`, `${W}/@SomeCreator/videos`, ['view', 'sort', 'si']],
    ['channel ID', `${W}/channel/UCabcdefghijklmnopqrstuv?si=x1`, `${W}/channel/UCabcdefghijklmnopqrstuv`, ['si']],
    ['old community post link', `${W}/channel/UCabcdefghijklmnopqrstuv/community?lb=UgkxAbCdEf123456&si=x1`, `${W}/post/UgkxAbCdEf123456`, ['si']],
    ['community post', `${W}/post/UgkxAbCdEf123456?si=x1`, `${W}/post/UgkxAbCdEf123456`, ['si']],
    ['clip', `https://youtube.com/clip/UgkxAAAAbbbbCCCCddddEEEEffffGGGGhhhh?si=x1`, `${W}/clip/UgkxAAAAbbbbCCCCddddEEEEffffGGGGhhhh`, ['si']],
    ['YouTube Music song stays on YouTube Music', `https://music.youtube.com/watch?v=${VID}&si=x1&list=OLAK5uy_abcdefg`, `https://music.youtube.com/watch?v=${VID}`, ['si', 'list']],
    ['YouTube Music playlist', `https://music.youtube.com/playlist?list=OLAK5uy_abcdefg&si=x1`, 'https://music.youtube.com/playlist?list=OLAK5uy_abcdefg', ['si']],
    ['YouTube Music album page', `https://music.youtube.com/browse/MPREb_abc123?si=x1`, 'https://music.youtube.com/browse/MPREb_abc123', ['si']],
    ['search results keep only the search', `${W}/results?search_query=cat+videos&sp=EgIQAQ%253D%253D&si=x1`, `${W}/results?search_query=cat%20videos`, ['sp', 'si']],
    ['home page', `${W}/?si=x1`, `${W}/`, ['si']],
    ['already-clean link is unchanged', `${W}/watch?v=${VID}`, `${W}/watch?v=${VID}`, []],
    ['malformed youtu.be/ID&feature=...', `https://youtu.be/${VID}&feature=youtu.be`, `${W}/watch?v=${VID}`, ['feature']],
    ['http and uppercase host', `http://WWW.YouTube.com/watch?v=${VID}&si=x1`, `${W}/watch?v=${VID}`, ['si']],
    ['non-Latin channel handle', `${W}/@%E3%81%82%E3%81%84?si=x1`, `${W}/@%E3%81%82%E3%81%84`, ['si']],
    ['old attribution_link share format', `${W}/attribution_link?a=abc123&u=%2Fwatch%3Fv%3D${VID}%26feature%3Dshare`, `${W}/watch?v=${VID}`, ['a', 'feature']],
    ['click-tracking redirect is unwrapped', `${W}/redirect?event=video_description&redir_token=QUFFLUhqbTVa&q=https%3A%2F%2Fexample.com%2Fshop%3Fitem%3D42%26utm_source%3Dyoutube&v=${VID}`, 'https://example.com/shop?item=42', ['event', 'redir_token', 'v', 'utm_source']],
    ['redirect to a YouTube link is cleaned too', `${W}/redirect?q=https%3A%2F%2Fyoutu.be%2F${VID}%3Fsi%3Dabc&event=x`, `${W}/watch?v=${VID}`, ['event', 'si']],
    ['other YouTube properties keep their page', 'https://tv.youtube.com/watch/abc123?si=x1', 'https://tv.youtube.com/watch/abc123', ['si']],
  ];

  for (const [description, input, expectedUrl, expectedRemoved] of cases) {
    it(description, async () => {
      const result = await youtubeResult(input);
      assert.equal(result.clean_url, expectedUrl);
      assert.deepEqual(result.removed, expectedRemoved);
      assert.equal(result.resolved_redirect, false);
    });
  }
});

describe('YouTube: rejects links that are missing what they need', () => {
  const bad = [
    ['video ID too short', `${W}/watch?v=tooShort`],
    ['video ID too long', `${W}/watch?v=${VID}X`],
    ['youtu.be with no ID', 'https://youtu.be/'],
    ['playlist page with no playlist', `${W}/playlist?si=x1`],
    ['redirect to a javascript: URL', `${W}/redirect?q=javascript%3Aalert(1)`],
    ['attribution_link pointing off YouTube', `${W}/attribution_link?u=https%3A%2F%2Fevil.example%2F`],
  ];
  for (const [description, input] of bad) {
    it(description, async () => {
      await assert.rejects(cleanLink(input), LinkError);
    });
  }
});

describe('YouTube: notes explain what changed', () => {
  it('flags a removed share ID', async () => {
    const { notes } = await youtubeResult(`https://youtu.be/${VID}?si=abc`);
    assert.match(notes[0], /share ID \(si\) that tells YouTube who shared this link/);
  });

  it('flags both share IDs together', async () => {
    const { notes } = await youtubeResult(`https://youtu.be/${VID}?si=abc&is=def`);
    assert.match(notes[0], /share IDs \(si, is\)/);
  });

  it('explains a dropped playlist', async () => {
    const { notes } = await youtubeResult(`${W}/watch?v=${VID}&list=${LIST}`);
    assert.ok(notes.some((note) => /playlist info/.test(note)));
  });

  it('explains an unwrapped redirect', async () => {
    const { notes } = await youtubeResult(`${W}/redirect?q=https%3A%2F%2Fexample.com%2F`);
    assert.ok(notes.some((note) => /Unwrapped/.test(note)));
  });

  it('says nothing when there was nothing to remove', async () => {
    const { notes, removed } = await youtubeResult(`${W}/watch?v=${VID}&t=5`);
    assert.deepEqual(notes, []);
    assert.deepEqual(removed, []);
  });
});

describe('YouTube helpers', () => {
  it('recognises only real YouTube hosts', () => {
    for (const host of ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtube-nocookie.com']) {
      assert.equal(youtube.isYouTubeHost(host), true, host);
    }
    for (const host of ['notyoutube.com', 'youtube.com.evil.example', 'youtu.be.evil.example', 'example.com']) {
      assert.equal(youtube.isYouTubeHost(host), false, host);
    }
  });

  it('parses start times the way YouTube does', () => {
    const expected = { '90': 90, '90s': 90, '1m30s': 90, '1m30': 90, '1h2m3s': 3723, '2m': 120 };
    for (const [input, seconds] of Object.entries(expected)) {
      assert.equal(youtube.parseTimestamp(input), seconds, input);
    }
    for (const input of ['0', '', 'abc', '1:30', 's', '-5']) {
      assert.equal(youtube.parseTimestamp(input), null, input);
    }
  });
});

// ---------------------------------------------------------------------------
// Finding the link in pasted text
// ---------------------------------------------------------------------------

describe('Pasted text', () => {
  it('finds a link inside share text', () => {
    const url = extractLink(`Check this out! https://youtu.be/${VID}?si=abc`);
    assert.equal(url.hostname, 'youtu.be');
  });

  it('prefers the TikTok/YouTube link when there are several', () => {
    const url = extractLink(`https://example.com/a and https://youtu.be/${VID}`);
    assert.equal(url.hostname, 'youtu.be');
  });

  it('accepts a link without https://', async () => {
    const result = await youtubeResult(`youtu.be/${VID}?si=abc`);
    assert.equal(result.clean_url, `${W}/watch?v=${VID}`);
  });

  it('ignores punctuation stuck to the end of a link', () => {
    const url = extractLink(`(https://youtu.be/${VID}).`);
    assert.equal(url.pathname, `/${VID}`);
  });

  it("finds a TikTok link in TikTok's share text", () => {
    const url = extractLink('https://vm.tiktok.com/ZMabc123/ Check out this video! #fyp');
    assert.equal(url.href, 'https://vm.tiktok.com/ZMabc123/');
  });

  it('rejects empty input, non-links and unsupported sites', async () => {
    await assert.rejects(cleanLink(''), LinkError);
    await assert.rejects(cleanLink('ftp://example.com/x'), LinkError);
    await assert.rejects(cleanLink('javascript:alert(1)'), LinkError);
    await assert.rejects(cleanLink('hello there'), /TikTok or YouTube/);
    await assert.rejects(cleanLink(`https://notyoutube.com/watch?v=${VID}`), /TikTok or YouTube/);
  });
});

describe('Generic tracker stripping (used on unwrapped redirects)', () => {
  it('removes trackers without re-encoding the rest', () => {
    const { url, removed } = stripGenericTrackers(new URL('https://example.com/p?a=1&utm_source=x&b=%20y&gclid=z#frag'));
    assert.equal(url, 'https://example.com/p?a=1&b=%20y#frag');
    assert.deepEqual(removed, ['utm_source', 'gclid']);
  });
});

// ---------------------------------------------------------------------------
// TikTok (unchanged behaviour)
// ---------------------------------------------------------------------------

describe('TikTok', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('strips query params from a video URL', async () => {
    const result = await cleanLink(
      'https://www.tiktok.com/@someuser/video/7290123456789012345?is_from_webapp=1&sender_device=pc&web_id=7295551234567891234'
    );
    assert.equal(result.platform, 'tiktok');
    assert.equal(result.clean_url, 'https://www.tiktok.com/@someuser/video/7290123456789012345');
    assert.deepEqual(result.removed, ['is_from_webapp', 'sender_device', 'web_id']);
    assert.equal(result.resolved_redirect, false);
  });

  it('normalises the bare tiktok.com host to www', async () => {
    const result = await cleanLink('https://tiktok.com/@someuser/video/123456?lang=en');
    assert.equal(result.clean_url, 'https://www.tiktok.com/@someuser/video/123456');
  });

  it('handles photo posts, profiles and missing https://', async () => {
    assert.equal(
      (await cleanLink('https://www.tiktok.com/@someuser/photo/999?is_from_webapp=1')).clean_url,
      'https://www.tiktok.com/@someuser/photo/999'
    );
    assert.equal((await cleanLink('https://www.tiktok.com/@someuser')).clean_url, 'https://www.tiktok.com/@someuser');
    assert.equal(
      (await cleanLink('www.tiktok.com/@someuser/video/42?foo=bar')).clean_url,
      'https://www.tiktok.com/@someuser/video/42'
    );
  });

  it('knows which links are short links', () => {
    assert.equal(tiktok.needsResolution(new URL('https://vm.tiktok.com/ZMabc/')), true);
    assert.equal(tiktok.needsResolution(new URL('https://vt.tiktok.com/ZSabc/')), true);
    assert.equal(tiktok.needsResolution(new URL('https://www.tiktok.com/t/ZTabc/')), true);
    assert.equal(tiktok.needsResolution(new URL('https://www.tiktok.com/@u/video/1')), false);
  });

  it('expands a short link and strips the tracking it redirects to', async () => {
    globalThis.fetch = async () => ({
      url: 'https://www.tiktok.com/@someuser/video/7290123456789012345?_r=1&_t=ZT-8abc&is_from_webapp=1',
      body: null,
    });
    const result = await cleanLink('https://vm.tiktok.com/ZMabc123/');
    assert.equal(result.clean_url, 'https://www.tiktok.com/@someuser/video/7290123456789012345');
    assert.equal(result.resolved_redirect, true);
    assert.deepEqual(result.removed, ['_r', '_t', 'is_from_webapp']);
  });

  it('reports a TikTok outage as an UpstreamError', async () => {
    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    await assert.rejects(cleanLink('https://vm.tiktok.com/ZMabc123/'), UpstreamError);
  });

  it('falls back to GET when TikTok rejects the HEAD request', async () => {
    const methods = [];
    globalThis.fetch = async (requested, options) => {
      methods.push(options.method);
      return options.method === 'HEAD'
        ? { url: requested, ok: false, status: 405, body: null }
        : { url: 'https://www.tiktok.com/@someuser/video/123?_t=abc', ok: true, status: 200, body: null };
    };
    const result = await cleanLink('https://vm.tiktok.com/ZMabc123/');
    assert.deepEqual(methods, ['HEAD', 'GET']);
    assert.equal(result.clean_url, 'https://www.tiktok.com/@someuser/video/123');
    assert.equal(result.resolved_redirect, true);
  });

  it('never hands back an unexpanded short link', async () => {
    // e.g. TikTok rate-limits us and answers 403 with no redirect
    globalThis.fetch = async (requested) => ({ url: requested, ok: false, status: 403, body: null });
    await assert.rejects(cleanLink('https://vm.tiktok.com/ZMabc123/'), UpstreamError);
  });

  it('treats a redirect to a dead end as a failure', async () => {
    for (const deadEnd of ['https://www.tiktok.com/', 'https://www.tiktok.com/login?redirect_url=x', 'https://example.com/']) {
      globalThis.fetch = async () => ({ url: deadEnd, ok: true, status: 200, body: null });
      await assert.rejects(cleanLink('https://vm.tiktok.com/ZMabc123/'), UpstreamError, deadEnd);
    }
  });

  describe('real redirect against a local mock server', () => {
    let server;
    let port;

    before(async () => {
      server = http.createServer((req, res) => {
        if (req.url.startsWith('/ZMmockshort')) {
          res.writeHead(301, {
            Location: '/@mockuser/video/1111111111111111111?is_from_webapp=1&sender_device=pc&checksum=abc123',
          });
        } else {
          res.writeHead(200);
        }
        res.end();
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = server.address().port;
    });

    after(() => new Promise((resolve) => server.close(resolve)));

    it('follows the redirect without reading the body, then strips tracking', async () => {
      const final = await tiktok.resolveRedirect(`http://127.0.0.1:${port}/ZMmockshort/`);
      assert.match(final, /checksum=abc123/);
      assert.equal(
        tiktok.stripTracking(final),
        `https://127.0.0.1:${port}/@mockuser/video/1111111111111111111`
      );
    });
  });
});

// ---------------------------------------------------------------------------
// The Netlify function itself
// ---------------------------------------------------------------------------

describe('API handler (/api/clean)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const call = async (url) => {
    const res = await handler(url === undefined ? undefined : { queryStringParameters: { url } });
    return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.body) };
  };

  it('cleans a YouTube link and never lets it be cached', async () => {
    const { status, headers, body } = await call(`https://youtu.be/${VID}?si=abc&t=10`);
    assert.equal(status, 200);
    assert.equal(headers['Cache-Control'], 'no-store');
    assert.equal(body.platform, 'youtube');
    assert.equal(body.clean_url, `${W}/watch?v=${VID}&t=10`);
    assert.deepEqual(body.removed, ['si']);
    assert.equal(body.notes.length, 1);
  });

  it('returns 400 with a readable message for bad input', async () => {
    for (const input of ['', 'https://example.com/', `${W}/watch?v=nope`, undefined]) {
      const { status, body } = await call(input);
      assert.equal(status, 400, String(input));
      assert.equal(typeof body.error, 'string');
    }
  });

  it('returns 502 when TikTok cannot be reached', async () => {
    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    const { status, body } = await call('https://vm.tiktok.com/ZMabc123/');
    assert.equal(status, 502);
    assert.match(body.error, /TikTok/);
  });
});
