const rateLimit = require('express-rate-limit');

/**
 * General API rate limiter — 10 req/sec per IP
 */
const generalLimiter = rateLimit({
  windowMs: 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'RATE_LIMITED',
    message: 'Too many requests. Please slow down.',
    retryable: true,
  },
});

/**
 * Answer submission rate limiter — 5 req/sec per IP
 */
const answerLimiter = rateLimit({
  windowMs: 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'RATE_LIMITED',
    message: 'Submission rate limit exceeded.',
    retryable: true,
  },
});

/**
 * QR scan rate limiter — 1 per 5 sec per IP (DB cooldown handles 60s per team)
 */
const qrLimiter = rateLimit({
  windowMs: 5000,
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'SCAN_COOLDOWN',
    message: 'Please wait before scanning again.',
    retryable: true,
  },
});

module.exports = { generalLimiter, answerLimiter, qrLimiter };
