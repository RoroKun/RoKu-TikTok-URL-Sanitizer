'use strict';

/**
 * Thrown for input we can't clean: empty, not a link, an unsupported
 * site, or a link that's missing the part that identifies the content.
 * The API turns this into a 400 with the message shown to the user.
 */
class LinkError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LinkError';
  }
}

/**
 * Thrown when a network lookup fails (only TikTok short links need
 * one). The API turns this into a 502.
 */
class UpstreamError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'UpstreamError';
    this.cause = cause;
  }
}

module.exports = { LinkError, UpstreamError };
