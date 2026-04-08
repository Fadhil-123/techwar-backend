const express = require('express');
const db = require('../db/pool');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

// ─── R2 In-Memory State (lives for server lifetime) ──────
const R2_CATEGORIES = ['programming', 'ai', 'cybersecurity', 'logic'];

let r2State = {
  activeCategory: null,
  phase: 'idle', // idle | selecting | answering | results
  selections: {},        // { teamId: 'easy'|'medium'|'hard' }
  assignedQuestions: {},  // { teamId: questionId }
  categoryIndex: 0,
  selectionDeadline: null,
  answerDeadline: null,
};

function getR2State() { return r2State; }
function resetR2State() {
  r2State = {
    activeCategory: null,
    phase: 'idle',
    selections: {},
    assignedQuestions: {},
    categoryIndex: 0,
    selectionDeadline: null,
    answerDeadline: null,
  };
}

// ─── Admin: Get R2 State ─────────────────────────────────
router.get('/state', adminAuth, (req, res) => {
  const totalTeams = Object.keys(r2State.selections).length;
  return res.json({
    ...r2State,
    categories: R2_CATEGORIES,
    totalSelections: totalTeams,
  });
});

// ─── Admin: Start Category (teams choose difficulty) ──────
router.post('/start-category', adminAuth, async (req, res) => {
  try {
    const { category, selectionTimeSec = 15 } = req.body;

    if (!category || !R2_CATEGORIES.includes(category)) {
      return res.status(400).json({
        error: 'INVALID_CATEGORY',
        message: `Category must be one of: ${R2_CATEGORIES.join(', ')}`,
      });
    }

    const io = req.app.get('io');

    // Clear previous selections
    r2State.activeCategory = category;
    r2State.phase = 'selecting';
    r2State.selections = {};
    r2State.assignedQuestions = {};
    r2State.selectionDeadline = new Date(Date.now() + selectionTimeSec * 1000).toISOString();
    r2State.answerDeadline = null;
    r2State.categoryIndex = R2_CATEGORIES.indexOf(category);

    // Broadcast to all teams: choose difficulty
    if (io) {
      io.emit('r2:select-difficulty', {
        category,
        categoryLabel: getCategoryLabel(category),
        timeLimit: selectionTimeSec,
        deadline: r2State.selectionDeadline,
      });
    }

    console.log(`[R2] Category "${category}" started — selection phase (${selectionTimeSec}s)`);
    return res.json({ success: true, category, phase: 'selecting' });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ─── Admin: Push Questions (assign based on selections) ───
router.post('/push-questions', adminAuth, async (req, res) => {
  try {
    const { answerTimeSec = 20 } = req.body;

    if (!r2State.activeCategory) {
      return res.status(400).json({ error: 'NO_CATEGORY', message: 'No active category' });
    }

    const io = req.app.get('io');
    const category = r2State.activeCategory;

    // Get all R2 questions for this category
    const qResult = await db.query(
      `SELECT id, difficulty, question_text, options, correct_answer, coins_reward
       FROM questions WHERE round_id = 2 AND theme = $1`,
      [category]
    );

    // Map: difficulty -> question
    const questionByDifficulty = {};
    for (const q of qResult.rows) {
      questionByDifficulty[q.difficulty] = {
        ...q,
        options: typeof q.options === 'string' ? JSON.parse(q.options) : q.options,
      };
    }

    // For teams that didn't select, auto-assign easy
    const allTeams = await db.query("SELECT id FROM teams WHERE status = 'active'");
    for (const t of allTeams.rows) {
      if (!r2State.selections[t.id]) {
        r2State.selections[t.id] = 'easy'; // default
      }
    }

    r2State.phase = 'answering';
    r2State.answerDeadline = new Date(Date.now() + answerTimeSec * 1000).toISOString();

    // Store question_opened_at for scoring
    const now = new Date().toISOString();
    await db.query(
      `UPDATE game_state SET active_question_id = NULL, question_opened_at = $1, updated_at = NOW() WHERE id = 1`,
      [now]
    );

    // Send each team their question based on their difficulty choice
    let assignCount = 0;
    for (const [teamId, difficulty] of Object.entries(r2State.selections)) {
      const question = questionByDifficulty[difficulty];
      if (!question) continue;

      r2State.assignedQuestions[teamId] = question.id;

      if (io) {
        io.to(`team:${teamId}`).emit('r2:question', {
          questionId: question.id,
          text: question.question_text,
          options: question.options,
          difficulty: question.difficulty,
          reward: difficulty === 'easy' ? 100 : difficulty === 'medium' ? 200 : 300,
          category,
          categoryLabel: getCategoryLabel(category),
          timeLimit: answerTimeSec,
          deadline: r2State.answerDeadline,
        });
        assignCount++;
      }
    }

    console.log(`[R2] Questions pushed for "${category}" — ${assignCount} teams`);
    return res.json({
      success: true,
      category,
      phase: 'answering',
      assignedCount: assignCount,
      selectionBreakdown: getSelectionBreakdown(),
    });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ─── Admin: End Category (REVEAL — batch score + show results)
router.post('/end-category', adminAuth, async (req, res) => {
  try {
    const io = req.app.get('io');
    const category = r2State.activeCategory;

    if (!category) {
      return res.status(400).json({ error: 'NO_CATEGORY', message: 'No active category' });
    }

    // BATCH SCORE all locked answers for this category
    const { revealR2Category } = require('../engines/scoreEngine');
    const revealResult = await revealR2Category(category, io);

    r2State.phase = 'results';

    // Notify all teams category is done
    if (io) {
      io.emit('r2:category-end', {
        category,
        categoryLabel: getCategoryLabel(category),
      });
    }

    console.log(`[R2] Category "${category}" revealed — ${revealResult.totalRevealed} answers scored, ${revealResult.correctCount} correct`);
    return res.json({
      success: true,
      phase: 'results',
      totalRevealed: revealResult.totalRevealed,
      correctCount: revealResult.correctCount,
    });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ─── Admin: Get selection breakdown ───────────────────────
router.get('/selections', adminAuth, (req, res) => {
  return res.json({
    category: r2State.activeCategory,
    phase: r2State.phase,
    breakdown: getSelectionBreakdown(),
    selections: r2State.selections,
    totalSelections: Object.keys(r2State.selections).length,
  });
});

// ─── Admin: Reset R2 ─────────────────────────────────────
router.post('/reset', adminAuth, (req, res) => {
  resetR2State();
  return res.json({ success: true, message: 'R2 state reset' });
});

// ─── Socket handler for difficulty selection ──────────────
function initR2SocketHandlers(io) {
  io.on('connection', (socket) => {
    // Team picks difficulty
    socket.on('r2:pick-difficulty', (data) => {
      if (!socket.teamId) {
        socket.emit('r2:error', { message: 'Not authenticated' });
        return;
      }

      if (r2State.phase !== 'selecting') {
        socket.emit('r2:error', { message: 'Selection phase is not active' });
        return;
      }

      const { difficulty } = data;
      if (!['easy', 'medium', 'hard'].includes(difficulty)) {
        socket.emit('r2:error', { message: 'Invalid difficulty' });
        return;
      }

      // Check if already selected
      if (r2State.selections[socket.teamId]) {
        socket.emit('r2:error', { message: 'Already selected difficulty' });
        return;
      }

      // Store selection
      r2State.selections[socket.teamId] = difficulty;

      // Confirm to team
      socket.emit('r2:difficulty-confirmed', {
        difficulty,
        reward: difficulty === 'easy' ? 100 : difficulty === 'medium' ? 200 : 300,
        message: `${difficulty.toUpperCase()} selected! Waiting for question...`,
      });

      // Notify admin of selection count
      io.to('admin').emit('r2:selection-update', {
        totalSelections: Object.keys(r2State.selections).length,
        breakdown: getSelectionBreakdown(),
      });

      console.log(`[R2] Team "${socket.teamName}" selected ${difficulty}`);
    });

    // ─── Recover state if phone reconnects ─────────────
    socket.on('r2:recover', async () => {
      if (!socket.teamId) return;
      
      const category = r2State.activeCategory;
      if (!category || r2State.phase === 'idle') return;

      const difficulty = r2State.selections[socket.teamId];

      if (r2State.phase === 'selecting') {
        socket.emit('r2:select-difficulty', {
          category,
          categoryLabel: getCategoryLabel(category),
          timeLimit: Math.max(0, (new Date(r2State.selectionDeadline).getTime() - Date.now()) / 1000),
          deadline: r2State.selectionDeadline,
        });

        if (difficulty) {
          socket.emit('r2:difficulty-confirmed', {
            difficulty,
            reward: difficulty === 'easy' ? 100 : difficulty === 'medium' ? 200 : 300,
          });
        }
      } 
      else if (r2State.phase === 'answering') {
        const questionId = r2State.assignedQuestions[socket.teamId];
        if (questionId) {
          try {
            const qResult = await db.query(
              `SELECT difficulty, question_text, options FROM questions WHERE id = $1`,
              [questionId]
            );
            if (qResult.rows.length > 0) {
              const q = qResult.rows[0];
              socket.emit('r2:question', {
                questionId,
                text: q.question_text,
                options: typeof q.options === 'string' ? JSON.parse(q.options) : q.options,
                difficulty: q.difficulty,
                reward: q.difficulty === 'easy' ? 100 : q.difficulty === 'medium' ? 200 : 300,
                category,
                categoryLabel: getCategoryLabel(category),
                timeLimit: Math.max(0, (new Date(r2State.answerDeadline).getTime() - Date.now()) / 1000),
                deadline: r2State.answerDeadline,
              });
            }
          } catch (err) {
            console.error('[R2] Recover error:', err.message);
          }
        }
      }
      else if (r2State.phase === 'results') {
        socket.emit('r2:category-end', { category, categoryLabel: getCategoryLabel(category) });
      }
    });
  });
}

// ─── Helpers ──────────────────────────────────────────────
function getCategoryLabel(cat) {
  const labels = {
    programming: 'Programming',
    ai: 'Artificial Intelligence',
    cybersecurity: 'Cybersecurity',
    logic: 'Logic & DSA',
  };
  return labels[cat] || cat;
}

function getSelectionBreakdown() {
  const breakdown = { easy: 0, medium: 0, hard: 0 };
  for (const d of Object.values(r2State.selections)) {
    if (breakdown[d] !== undefined) breakdown[d]++;
  }
  return breakdown;
}

module.exports = { router, initR2SocketHandlers, getR2State };
