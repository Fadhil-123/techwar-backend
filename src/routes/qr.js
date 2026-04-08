const express = require('express');
const db = require('../db/pool');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

/**
 * POST /api/qr/scan
 * Team scans ANY QR code → server assigns ONE random power card.
 * EACH TEAM CAN SCAN ONLY ONCE IN ENTIRE ROUND.
 */
router.post('/scan', authMiddleware, async (req, res) => {
  try {
    const { teamId } = req.team;
    const qrPayload = req.body.qrPayload || req.body.qrRawData || 'scan';
    const io = req.app.get('io');

    // Verify R3 is active
    const stateResult = await db.query('SELECT current_round, round_status FROM game_state WHERE id = 1');
    const gs = stateResult.rows[0];
    if (!gs || gs.current_round !== 3 || gs.round_status !== 'active') {
      return res.status(400).json({
        error: 'INVALID_ROUND',
        message: 'QR scanning is only available during Round 3',
      });
    }

    // CHECK: Has this team already scanned? (1 scan per team EVER)
    const existingCard = await db.query(
      'SELECT id, card_type FROM power_cards WHERE team_id = $1 LIMIT 1',
      [teamId]
    );

    if (existingCard.rows.length > 0) {
      return res.status(400).json({
        error: 'SCAN_ALREADY_USED',
        message: 'You have already scanned your card',
        card: existingCard.rows[0].card_type,
      });
    }

    // Assign ONE random card
    const allTypes = ['steal', 'shield', 'bounty'];
    const assigned = allTypes[Math.floor(Math.random() * allTypes.length)];

    // Insert with conflict guard
    const insertResult = await db.query(
      `INSERT INTO power_cards (team_id, card_type, acquired_via, qr_scan_code)
       VALUES ($1, $2, 'qr_scan', $3)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [teamId, assigned, qrPayload]
    );

    if (insertResult.rows.length === 0) {
      return res.status(400).json({
        error: 'SCAN_ALREADY_USED',
        message: 'Card already assigned (race condition)',
      });
    }

    // Audit log
    await db.query(
      `INSERT INTO qr_scans (team_id, qr_payload, card_assigned, round_active)
       VALUES ($1, $2, $3, 3)`,
      [teamId, qrPayload, assigned]
    );

    // Notify team's socket room
    if (io) {
      io.to(`team:${teamId}`).emit('card:received', { cardType: assigned });
    }

    console.log(`[QR] Team ${teamId} scanned → ${assigned.toUpperCase()}`);

    return res.json({
      success: true,
      cardType: assigned,
      message: `You received a ${assigned.toUpperCase()} card!`,
    });
  } catch (err) {
    console.error('[QR] Scan error:', err.message);
    return res.status(500).json({
      error: 'SERVER_ERROR',
      message: 'Failed to process QR scan',
    });
  }
});

/**
 * GET /api/qr/cards
 * Get the power card owned by the authenticated team.
 */
router.get('/cards', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT card_type, used, used_at, target_team_id, resolved, coins_effect
       FROM power_cards WHERE team_id = $1`,
      [req.team.teamId]
    );
    return res.json({ cards: result.rows });
  } catch (err) {
    console.error('[QR] Get cards error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to get cards' });
  }
});

module.exports = router;
