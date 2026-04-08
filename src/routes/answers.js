const express = require('express');
const db = require('../db/pool');
const authMiddleware = require('../middleware/auth');
const checkPaused = require('../middleware/checkPaused');
const { answerLimiter } = require('../middleware/rateLimit');
const { processAnswer } = require('../engines/scoreEngine');
const { resolveCardsForAnswer } = require('../engines/cardEngine');
const { applyGhostEffects } = require('../engines/ghostEngine');
const { z } = require('zod');

const router = express.Router();

const answerSchema = z.object({
  questionId: z.string().uuid(),
  answer: z.string().min(1).max(500),
});

/**
 * POST /api/answers/submit
 * Unified answer submission for all rounds.
 */
router.post('/submit', authMiddleware, checkPaused, answerLimiter, async (req, res) => {
  try {
    const parsed = answerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Invalid question ID or answer',
        retryable: false,
      });
    }

    const { questionId, answer } = parsed.data;
    const { teamId } = req.team;
    const io = req.app.get('io');

    // Process the answer through score engine
    const result = await processAnswer(teamId, questionId, answer, io);

    if (result.error) {
      return res.status(400).json({
        error: result.error,
        message: result.message,
        retryable: false,
      });
    }

    // Get current round for card/ghost processing
    const stateResult = await db.query('SELECT current_round FROM game_state WHERE id = 1');
    const currentRound = stateResult.rows[0]?.current_round;

    // Round 3: resolve power cards after answer
    if (currentRound === 3) {
      try {
        await resolveCardsForAnswer(questionId, teamId, result.isCorrect, io);
      } catch (err) {
        console.error('[ANSWERS] Card resolution error:', err.message);
        // Don't fail the answer — cards are secondary
      }
    }

    // Round 3: apply ghost betting effects
    if (currentRound === 3) {
      try {
        await applyGhostEffects(teamId, result.isCorrect, result.coinsEarned, io);
      } catch (err) {
        console.error('[ANSWERS] Ghost effect error:', err.message);
      }
    }

    // Send result to team's private room
    if (io) {
      io.to(`team:${teamId}`).emit('answer:result', {
        correct: result.isCorrect,
        coinsEarned: result.coinsEarned,
        totalCoins: result.totalCoins,
      });

      // Broadcast leaderboard update
      const leaderboard = await db.query(
        `SELECT id, name, coins, status,
                RANK() OVER (ORDER BY coins DESC) as rank
         FROM teams WHERE status = 'active'
         ORDER BY coins DESC`
      );
      io.emit('leaderboard:update', { rankings: leaderboard.rows });
    }

    return res.json({
      success: true,
      correct: result.isCorrect,
      coinsEarned: result.coinsEarned,
      totalCoins: result.totalCoins,
    });
  } catch (err) {
    console.error('[ANSWERS] Submit error:', err.message);
    return res.status(500).json({
      error: 'SERVER_ERROR',
      message: 'Failed to process answer',
      retryable: true,
    });
  }
});

module.exports = router;
