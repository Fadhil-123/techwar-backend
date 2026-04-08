const express = require('express');
const db = require('../db/pool');

const router = express.Router();

/**
 * GET /api/leaderboard
 * Public leaderboard — active teams sorted by coins DESC.
 */
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, coins, status, avg_response_time_ms,
              RANK() OVER (ORDER BY coins DESC, avg_response_time_ms ASC) as rank
       FROM teams
       WHERE status = 'active'
       ORDER BY coins DESC, avg_response_time_ms ASC`
    );
    return res.json({ rankings: result.rows });
  } catch (err) {
    console.error('[LEADERBOARD] Error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to get leaderboard' });
  }
});

/**
 * GET /api/leaderboard/all
 * All teams including ghost/eliminated (for admin).
 */
router.get('/all', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, coins, status, eliminated_after_round, avg_response_time_ms,
              RANK() OVER (ORDER BY coins DESC, avg_response_time_ms ASC) as rank
       FROM teams
       ORDER BY coins DESC, avg_response_time_ms ASC`
    );
    return res.json({ rankings: result.rows });
  } catch (err) {
    console.error('[LEADERBOARD] All error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to get full leaderboard' });
  }
});

module.exports = router;
