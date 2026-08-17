/**
 * test_clean.js
 *
 * Plain-Node test suite for netlify/functions/clean.js — no Netlify
 * CLI required. Query-stripping/validation logic is tested with zero
 * network calls; short-link redirect resolution is tested against a
 * throwaway local HTTP server (this build environment's network is
 * allowlisted and can't reach tiktok.com directly — see README.md for
 * the manual live smoke-test to run once deployed).
 */

const assert = require("node:assert");
const http = require("node:http");
const { handler, _internal } = require("./netlify/functions/clean.js");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    failed++;
  }
}

async function invoke(url) {
  const res = await handler({ queryStringParameters: { url } });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

async function main() {
  await test("strips query params from a video URL", async () => {
    const { status, body } = await invoke(
      "https://www.tiktok.com/@charlidamelio/video/7290123456789012345" +
        "?is_from_webapp=1&sender_device=pc&web_id=7295551234567891234"
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(
      body.clean_url,
      "https://www.tiktok.com/@charlidamelio/video/7290123456789012345"
    );
    assert.strictEqual(body.resolved_redirect, false);
  });

  await test("normalizes bare tiktok.com host to www", async () => {
    const { body } = await invoke("https://tiktok.com/@someuser/video/123456?lang=en");
    assert.strictEqual(body.clean_url, "https://www.tiktok.com/@someuser/video/123456");
  });

  await test("photo post URL", async () => {
    const { body } = await invoke("https://www.tiktok.com/@someuser/photo/999?is_from_webapp=1");
    assert.strictEqual(body.clean_url, "https://www.tiktok.com/@someuser/photo/999");
  });

  await test("profile URL without query is unchanged", async () => {
    const { body } = await invoke("https://www.tiktok.com/@someuser");
    assert.strictEqual(body.clean_url, "https://www.tiktok.com/@someuser");
  });

  await test("adds https scheme if missing", async () => {
    const { body } = await invoke("www.tiktok.com/@someuser/video/42?foo=bar");
    assert.strictEqual(body.clean_url, "https://www.tiktok.com/@someuser/video/42");
  });

  await test("rejects non-tiktok host", async () => {
    const { status, body } = await invoke("https://example.com/@someuser/video/42");
    assert.strictEqual(status, 400);
    assert.match(body.error, /doesn't look like a TikTok link/);
  });

  await test("rejects empty input", async () => {
    const { status, body } = await invoke("");
    assert.strictEqual(status, 400);
    assert.match(body.error, /Empty input/);
  });

  // --- Short-link redirect resolution against a local mock server ---
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/ZMmockshort")) {
      res.writeHead(301, {
        Location:
          "/@mockuser/video/1111111111111111111" +
          "?is_from_webapp=1&sender_device=pc&checksum=abc123",
      });
      res.end();
    } else {
      res.writeHead(200);
      res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  await test("resolves short-link-style redirect and strips tracking", async () => {
    const shortUrl = `http://127.0.0.1:${port}/ZMmockshort/`;
    const final = await _internal.resolveRedirect(shortUrl);
    assert.ok(final.startsWith(`http://127.0.0.1:${port}/@mockuser/video/`));
    assert.match(final, /checksum=abc123/);

    const clean = _internal.stripTracking(final);
    assert.strictEqual(
      clean,
      `https://127.0.0.1:${port}/@mockuser/video/1111111111111111111`
    );
    assert.ok(!clean.includes("checksum"));
  });

  await new Promise((resolve) => server.close(resolve));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
