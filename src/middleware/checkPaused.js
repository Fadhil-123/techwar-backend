const db = require('../db/pool');

/**
 * Middleware: Reject all submissions if system is paused (admin panic button).
 * Apply to all answer, bid, card, and breach endpoints.
 */
async function checkPaused(req, res, next) {
  try {
    const result = await db.query('SELECT is_paused FROM game_state WHERE id = 1');
    if (result.rows.length > 0 && result.rows[0].is_paused) {
      return res.status(503).json({
        error: 'SYSTEM_PAUSED',
        message: 'System temporarily paused by admin. Please wait.',
        retryable: true,
      });
    }
    next();
  } catch (err) {
    console.error('[PAUSE CHECK] Error:', err.message);
    next(); // fail-open: if DB error, don't block gameplay
  }
}

module.exports = checkPaused;
