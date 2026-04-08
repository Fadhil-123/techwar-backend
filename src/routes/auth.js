const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db/pool');
const { z } = require('zod');

const router = express.Router();

const joinSchema = z.object({
  teamName: z.string().min(1).max(50),
  joinCode: z.string().min(1).max(20),
});

/**
 * POST /api/auth/join
 * Team joins the game using their name + 6-char join code.
 * Returns a JWT for all subsequent requests.
 */
router.post('/join', async (req, res) => {
  try {
    const parsed = joinSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Invalid Team ID or Password format',
        retryable: true,
      });
    }

    const { teamName, joinCode } = parsed.data;

    // Look up team by join code
    const result = await db.query(
      'SELECT id, name, public_id, join_code, coins, status FROM teams WHERE join_code = $1',
      [joinCode]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'INVALID_CODE',
        message: 'Password not found. Check your credential card and try again.',
        retryable: true,
      });
    }

    const team = result.rows[0];

    // Verify team ID matches (case-insensitive)
    if (!team.public_id || team.public_id.toLowerCase() !== teamName.toLowerCase()) {
      return res.status(401).json({
        error: 'NAME_MISMATCH',
        message: 'Team ID does not match the Password.',
        retryable: true,
      });
    }

    // Generate JWT
    const token = jwt.sign(
      { teamId: team.id, teamName: team.name },
      process.env.JWT_SECRET || 'fallback_secret_key_2026',
      { expiresIn: '12h' }
    );

    return res.json({
      success: true,
      token,
      team: {
        id: team.id,
        name: team.name,
        coins: team.coins,
        status: team.status,
      },
    });
  } catch (err) {
    console.error('[AUTH] Join error:', err.message);
    return res.status(500).json({
      error: 'SERVER_ERROR',
      message: err.message || 'Internal server error',
      retryable: true,
    });
  }
});

/**
 * GET /api/auth/me
 * Returns the current team's profile from JWT.
 */
router.get('/me', require('../middleware/auth'), async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, name, coins, status, avg_response_time_ms FROM teams WHERE id = $1',
      [req.team.teamId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'TEAM_NOT_FOUND', message: 'Team not found' });
    }

    // Get power cards
    const cards = await db.query(
      'SELECT card_type, used, used_at FROM power_cards WHERE team_id = $1',
      [req.team.teamId]
    );

    // Get game state
    const state = await db.query('SELECT current_round, round_status, is_paused FROM game_state WHERE id = 1');

    return res.json({
      team: result.rows[0],
      powerCards: cards.rows,
      gameState: state.rows[0],
    });
  } catch (err) {
    console.error('[AUTH] /me error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Internal server error' });
  }
});

module.exports = router;
