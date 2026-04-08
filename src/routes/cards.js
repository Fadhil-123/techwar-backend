const express = require('express');
const authMiddleware = require('../middleware/auth');
const checkPaused = require('../middleware/checkPaused');
const { playCard } = require('../engines/cardEngine');
const { z } = require('zod');

const router = express.Router();

const playSchema = z.object({
  cardType: z.enum(['steal', 'shield', 'bounty']),
  targetTeamId: z.string().uuid().optional(),
});

/**
 * POST /api/cards/play
 * Play a power card during Round 3.
 */
router.post('/play', authMiddleware, checkPaused, async (req, res) => {
  try {
    const parsed = playSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Invalid card type or target',
        retryable: false,
      });
    }

    const { cardType, targetTeamId } = parsed.data;
    const { teamId } = req.team;
    const io = req.app.get('io');

    // Steal and bounty require a target
    if ((cardType === 'steal' || cardType === 'bounty') && !targetTeamId) {
      return res.status(400).json({
        error: 'TARGET_REQUIRED',
        message: `${cardType.toUpperCase()} card requires a target team`,
        retryable: true,
      });
    }

    const result = await playCard(teamId, cardType, targetTeamId);

    if (result.error) {
      return res.status(400).json({
        error: result.error,
        message: result.message,
        retryable: false,
      });
    }

    // Emit card played event
    if (io) {
      io.emit('card:played', {
        cardType,
        playerId: teamId,
        targetId: targetTeamId,
      });
    }

    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[CARDS] Play error:', err.message);
    return res.status(500).json({
      error: 'SERVER_ERROR',
      message: 'Failed to play card',
      retryable: true,
    });
  }
});

module.exports = router;
