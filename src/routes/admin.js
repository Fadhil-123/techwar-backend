const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db/pool');
const adminAuth = require('../middleware/adminAuth');
const { z } = require('zod');

const router = express.Router();

// ─── Admin Login ───────────────────────────────────────────
router.post('/login', (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'INVALID_PASSWORD', message: 'Wrong admin password' });
  }
  const token = jwt.sign({ isAdmin: true }, process.env.ADMIN_JWT_SECRET, { expiresIn: '24h' });
  return res.json({ success: true, token });
});

// ─── All routes below require admin auth ───────────────────
router.use(adminAuth);

// ─── Game State ────────────────────────────────────────────
router.get('/state', async (req, res) => {
  try {
    const state = await db.query('SELECT * FROM game_state WHERE id = 1');
    return res.json({ state: state.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ─── Round Control ─────────────────────────────────────────
const roundSchema = z.object({
  roundId: z.number().int().min(1).max(5),
  action: z.enum(['start', 'end', 'pause']),
});

router.post('/round', async (req, res) => {
  try {
    const parsed = roundSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid round or action' });
    }
    const { roundId, action } = parsed.data;
    const io = req.app.get('io');
    const now = new Date().toISOString();

    let roundStatus;
    if (action === 'start') roundStatus = 'active';
    else if (action === 'end') roundStatus = 'ended';
    else if (action === 'pause') roundStatus = 'paused';

    if (action === 'start') {
      // Set question_opened_at as round start time (used for R2 global timer)
      await db.query(
        `UPDATE game_state SET current_round = $1, round_status = $2, question_opened_at = $3, active_question_id = NULL, updated_at = NOW() WHERE id = 1`,
        [roundId, roundStatus, now]
      );
    } else {
      await db.query(
        `UPDATE game_state SET current_round = $1, round_status = $2, updated_at = NOW() WHERE id = 1`,
        [roundId, roundStatus]
      );
    }

    if (io) {
      if (action === 'start') {
        io.emit('round:start', { roundId, config: { status: 'active' }, roundStartedAt: now });
      } else if (action === 'end') {
        io.emit('round:end', { roundId, nextRound: roundId + 1 });
      } else if (action === 'pause') {
        io.emit('round:paused', { roundId });
      }
    }

    return res.json({ success: true, roundId, status: roundStatus });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ─── Push Question ─────────────────────────────────────────
router.post('/push-question', async (req, res) => {
  try {
    const { questionId } = req.body;
    if (!questionId) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'questionId required' });
    }

    const qResult = await db.query('SELECT * FROM questions WHERE id = $1', [questionId]);
    if (qResult.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Question not found' });
    }
    const question = qResult.rows[0];
    const now = new Date().toISOString();

    await db.query(
      `UPDATE game_state SET active_question_id = $1, question_opened_at = $2, updated_at = NOW() WHERE id = 1`,
      [questionId, now]
    );

    const io = req.app.get('io');
    if (io) {
      const parsedOptions = question.options
        ? JSON.parse(typeof question.options === 'string' ? question.options : JSON.stringify(question.options))
        : [];

      // Send question WITH options immediately — teams lock their answer, admin reveals later
      io.emit('round:question', {
        questionId: question.id,
        text: question.question_text,
        round: question.round_id,
        theme: question.theme,
        difficulty: question.difficulty,
        options: parsedOptions,
        openedAt: now,
      });
    }

    return res.json({ success: true, question: question });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ─── Reveal Answer (Admin triggers scoring) ────────────────
router.post('/reveal-answer', async (req, res) => {
  try {
    const { questionId } = req.body;
    if (!questionId) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'questionId required' });
    }

    const io = req.app.get('io');
    const { revealAnswer } = require('../engines/scoreEngine');
    const result = await revealAnswer(questionId, io);

    if (result.error) {
      return res.status(400).json(result);
    }

    return res.json({
      success: true,
      correctAnswer: result.correctAnswer,
      totalAnswered: result.totalAnswered,
      correctCount: result.correctCount,
      results: result.results,
    });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ─── Get All Questions (for admin to select which to push) ─
router.get('/questions', async (req, res) => {
  try {
    const { round } = req.query;
    let result;
    if (round) {
      result = await db.query(
        'SELECT * FROM questions WHERE round_id = $1 ORDER BY theme, difficulty, created_at',
        [parseInt(round)]
      );
    } else {
      result = await db.query('SELECT * FROM questions ORDER BY round_id, theme, difficulty, created_at');
    }
    return res.json({ questions: result.rows });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ─── Get R2 Questions (grouped by theme/difficulty) ────────
router.get('/r2/questions', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM questions WHERE round_id = 2 ORDER BY theme, difficulty`
    );
    return res.json({ questions: result.rows });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ─── Pause / Resume System (Panic Button) ──────────────────
router.post('/pause', async (req, res) => {
  try {
    await db.query('UPDATE game_state SET is_paused = TRUE, updated_at = NOW() WHERE id = 1');
    const io = req.app.get('io');
    if (io) io.emit('system:paused', { message: 'System paused by admin. Please wait.' });
    return res.json({ success: true, paused: true });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

router.post('/resume', async (req, res) => {
  try {
    await db.query('UPDATE game_state SET is_paused = FALSE, updated_at = NOW() WHERE id = 1');
    const io = req.app.get('io');
    if (io) io.emit('system:resumed', {});
    return res.json({ success: true, paused: false });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ─── Override Score ────────────────────────────────────────
const scoreSchema = z.object({
  teamId: z.string().uuid(),
  delta: z.number().int(),
  reason: z.string().optional(),
});

router.post('/override-score', async (req, res) => {
  try {
    const parsed = scoreSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid teamId or delta' });
    }
    const { teamId, delta } = parsed.data;

    await db.query(
      'UPDATE teams SET coins = GREATEST(0, coins + $1) WHERE id = $2',
      [delta, teamId]
    );

    const updated = await db.query('SELECT id, name, coins FROM teams WHERE id = $1', [teamId]);
    const io = req.app.get('io');
    if (io) {
      io.to(`team:${teamId}`).emit('answer:result', {
        correct: delta > 0,
        coinsEarned: delta,
        totalCoins: updated.rows[0].coins,
      });
      // Refresh leaderboard
      const lb = await db.query(
        `SELECT id, name, coins, status, RANK() OVER (ORDER BY coins DESC) as rank
         FROM teams WHERE status = 'active' ORDER BY coins DESC`
      );
      io.emit('leaderboard:update', { rankings: lb.rows });
    }

    return res.json({ success: true, team: updated.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ─── View All Answers for a Question ───────────────────────
router.get('/answers/:questionId', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT a.*, t.name as team_name
       FROM answers a JOIN teams t ON t.id = a.team_id
       WHERE a.question_id = $1
       ORDER BY a.submitted_at ASC`,
      [req.params.questionId]
    );
    return res.json({ answers: result.rows });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ─── All Teams ─────────────────────────────────────────────
router.get('/teams', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, join_code, coins, status, eliminated_after_round, avg_response_time_ms, created_at
       FROM teams ORDER BY coins DESC`
    );
    return res.json({ teams: result.rows });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ─── Eliminate Teams (end of round) ────────────────────────
router.post('/eliminate', async (req, res) => {
  try {
    const { teamIds, round, newStatus } = req.body;
    if (!teamIds || !Array.isArray(teamIds) || !round) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'teamIds array and round required' });
    }

    const status = newStatus || 'eliminated';
    await db.query(
      `UPDATE teams SET status = $1, eliminated_after_round = $2 WHERE id = ANY($3)`,
      [status, round, teamIds]
    );

    const io = req.app.get('io');
    if (io) {
      for (const tid of teamIds) {
        io.to(`team:${tid}`).emit('team:eliminated', { round, status });
      }
      // Refresh leaderboard
      const lb = await db.query(
        `SELECT id, name, coins, status, RANK() OVER (ORDER BY coins DESC) as rank
         FROM teams WHERE status = 'active' ORDER BY coins DESC`
      );
      io.emit('leaderboard:update', { rankings: lb.rows });
    }

    return res.json({ success: true, eliminatedCount: teamIds.length });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ─── Reset Question (re-open a closed question) ───────────
router.post('/reset-question', async (req, res) => {
  try {
    const { questionId } = req.body;
    if (!questionId) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'questionId required' });

    // Delete all answers for this question
    await db.query('DELETE FROM answers WHERE question_id = $1', [questionId]);

    const io = req.app.get('io');
    if (io) {
      io.emit('question:reset', { questionId });
    }

    return res.json({ success: true, message: 'Question reset — all answers deleted' });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ─── CSV Export ────────────────────────────────────────────
router.get('/export', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT name, coins, status, eliminated_after_round, avg_response_time_ms
       FROM teams ORDER BY coins DESC`
    );

    let csv = 'Rank,Team Name,Coins,Status,Eliminated After Round,Avg Response Time (ms)\n';
    result.rows.forEach((row, i) => {
      csv += `${i + 1},"${row.name}",${row.coins},${row.status},${row.eliminated_after_round || ''},${Math.round(row.avg_response_time_ms || 0)}\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=techwar_leaderboard.csv');
    return res.send(csv);
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ─── R3: Card Stats ───────────────────────────────────────
router.get('/card-stats', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT card_type, used FROM power_cards`
    );
    const stats = { steal: 0, shield: 0, bounty: 0, used: 0, total: result.rows.length };
    for (const row of result.rows) {
      if (stats[row.card_type] !== undefined) stats[row.card_type]++;
      if (row.used) stats.used++;
    }
    return res.json(stats);
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ─── Create Question (generic — works for any round) ──────
router.post('/questions', async (req, res) => {
  try {
    const { roundId, questionText, options, correctAnswer, theme, difficulty } = req.body;
    if (!roundId || !questionText || !options || !correctAnswer) {
      return res.status(400).json({ error: 'VALIDATION', message: 'roundId, questionText, options, correctAnswer required' });
    }
    const result = await db.query(
      `INSERT INTO questions (round_id, theme, difficulty, question_text, options, correct_answer, coins_reward)
       VALUES ($1, $2, $3, $4, $5, $6, 100) RETURNING id`,
      [roundId, theme || 'general', difficulty || 'medium', questionText, JSON.stringify(options), correctAnswer]
    );
    return res.json({ success: true, questionId: result.rows[0].id });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ─── Delete Question ──────────────────────────────────────
router.delete('/questions/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM questions WHERE id = $1', [req.params.id]);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

module.exports = router;
