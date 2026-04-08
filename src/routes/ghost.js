const express = require('express');
const db = require('../db/pool');
const authMiddleware = require('../middleware/auth');
const { lockGhostBet, getGhostLeaderboard } = require('../engines/ghostEngine');
const { z } = require('zod');

const router = express.Router();

const betSchema = z.object({
  targetTeamId: z.string().uuid(),
});

/**
 * POST /api/ghost/bet
 * Ghost team locks their bet on an active team. Cannot be changed.
 */
router.post('/bet', authMiddleware, async (req, res) => {
  try {
    const parsed = betSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Invalid target team ID',
        retryable: false,
      });
    }

    const { targetTeamId } = parsed.data;
    const { teamId } = req.team;

    const result = await lockGhostBet(teamId, targetTeamId);

    if (result.error) {
      return res.status(400).json({
        error: result.error,
        message: result.message,
        retryable: false,
      });
    }

    return res.json({ success: true, targetTeamId });
  } catch (err) {
    console.error('[GHOST] Bet error:', err.message);
    return res.status(500).json({
      error: 'SERVER_ERROR',
      message: 'Failed to place bet',
      retryable: true,
    });
  }
});

/**
 * GET /api/ghost/leaderboard
 * Get the ghost team leaderboard.
 */
router.get('/leaderboard', async (req, res) => {
  try {
    const leaderboard = await getGhostLeaderboard();
    return res.json({ rankings: leaderboard });
  } catch (err) {
    console.error('[GHOST] Leaderboard error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to get ghost leaderboard' });
  }
});

/**
 * GET /api/ghost/active-teams
 * Get all active teams that ghosts can bet on.
 */
router.get('/active-teams', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, coins FROM teams WHERE status = 'active' ORDER BY coins DESC`
    );
    return res.json({ teams: result.rows });
  } catch (err) {
    console.error('[GHOST] Active teams error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to get active teams' });
  }
});

/**
 * GET /api/ghost/my-bet
 * Get the current ghost team's bet info.
 */
router.get('/my-bet', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT gb.*, t.name as target_name, t.coins as target_coins
       FROM ghost_bets gb JOIN teams t ON t.id = gb.target_team_id
       WHERE gb.ghost_team_id = $1`,
      [req.team.teamId]
    );

    if (result.rows.length === 0) {
      return res.json({ bet: null });
    }

    return res.json({ bet: result.rows[0] });
  } catch (err) {
    console.error('[GHOST] My bet error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to get bet info' });
  }
});

module.exports = router;
