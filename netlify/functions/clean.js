'use strict';

/**
 * Netlify serverless function behind /api/clean (see netlify.toml).
 *
 *   GET /api/clean?url=<a TikTok or YouTube link, or text containing one>
 *
 * 200 -> { original_url, platform, clean_url, resolved_redirect, removed, notes }
 * 400 -> { error }  bad input (shown to the user as-is)
 * 502 -> { error }  couldn't reach TikTok to expand a short link
 * 500 -> { error }  anything unexpected
 *
 * The cleaning logic lives in lib/ so it can be tested without Netlify.
 * Nothing is logged or stored, and responses are marked no-store so no
 * cache keeps a copy of the links either.
 */

const { cleanLink } = require('../../lib/sanitize');
const { LinkError, UpstreamError } = require('../../lib/errors');

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

function reply(statusCode, body) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  const input = (event && event.queryStringParameters && event.queryStringParameters.url) || '';

  try {
    return reply(200, await cleanLink(input));
  } catch (err) {
    if (err instanceof LinkError) return reply(400, { error: err.message });
    if (err instanceof UpstreamError) return reply(502, { error: err.message });
    return reply(500, { error: 'Something went wrong cleaning that link. Please try again.' });
  }
};
