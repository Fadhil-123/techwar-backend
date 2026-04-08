const db = require('../db/pool');
const r4Engine = require('./r4Engine');

/**
 * Round 1 — Speed Quiz Scoring
 * Correct + fast = more coins; Wrong = -25 penalty
 */
function calculateR1Score(submittedAt, questionOpenedAt, isCorrect) {
  if (!isCorrect) return -25;
  const elapsedMs = new Date(submittedAt) - new Date(questionOpenedAt);
  const elapsedSec = elapsedMs / 1000;
  if (elapsedSec < 0) return 0;       // clock skew protection
  if (elapsedSec <= 5) return 50;
  if (elapsedSec <= 10) return 30;
  if (elapsedSec <= 15) return 10;
  return 0;                            // after window — no score, no penalty
}

/**
 * Round 2 — Multi-Set Strategy Scoring
 * Coins based on difficulty; no penalty for wrong
 */
function calculateR2Score(difficulty, isCorrect) {
  if (!isCorrect) return 0;
  switch (difficulty) {
    case 'easy': return 100;
    case 'medium': return 200;
    case 'hard': return 300;
    default: return 100;
  }
}

/**
 * Round 3 — Steal/Shield Scoring
 * Correct = +100, Wrong = -30
 */
function calculateR3Score(isCorrect) {
  return isCorrect ? 100 : -30;
}

/**
 * Lock an answer — stores the team's choice but does NOT score it yet.
 * Used in R1: teams lock in answers, admin reveals, THEN scoring happens.
 */
async function lockAnswer(teamId, questionId, answerGiven) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Get question
    const qResult = await client.query('SELECT * FROM questions WHERE id = $1', [questionId]);
    if (qResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { error: 'INVALID_QUESTION', message: 'Question not found' };
    }
    const question = qResult.rows[0];

    // Get game state
    const stateResult = await client.query('SELECT * FROM game_state WHERE id = 1');
    const gameState = stateResult.rows[0];

    // Check round matches
    if (gameState.current_round !== question.round_id) {
      await client.query('ROLLBACK');
      return { error: 'INVALID_ROUND', message: 'Not the current round' };
    }

    // For R1: check if this question is the active one
    if (question.round_id === 1 && gameState.active_question_id !== questionId) {
      await client.query('ROLLBACK');
      return { error: 'WINDOW_CLOSED', message: 'Question is not active' };
    }

    // Check for duplicate submission
    const dupCheck = await client.query(
      'SELECT id FROM answers WHERE team_id = $1 AND question_id = $2',
      [teamId, questionId]
    );
    if (dupCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return { error: 'DUPLICATE_SUBMISSION', message: 'You already locked an answer' };
    }

    const now = new Date();
    const timeElapsedMs = gameState.question_opened_at
      ? Math.max(0, now - new Date(gameState.question_opened_at))
      : 0;

    // Insert answer as LOCKED (is_correct = false, coins_earned = 0 — will be updated on reveal)
    await client.query(
      `INSERT INTO answers (team_id, question_id, answer_given, is_correct, coins_earned, time_elapsed_ms)
       VALUES ($1, $2, $3, false, 0, $4)`,
      [teamId, questionId, answerGiven, timeElapsedMs]
    );

    await client.query('COMMIT');

    return { locked: true, answer: answerGiven, timeElapsedMs };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[SCORE ENGINE] Lock error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reveal answer — admin triggers this. Evaluates ALL locked answers for a question,
 * applies scoring, updates coins, and returns results per team.
 */
async function revealAnswer(questionId, io) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Get question with correct answer
    const qResult = await client.query('SELECT * FROM questions WHERE id = $1', [questionId]);
    if (qResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { error: 'NOT_FOUND', message: 'Question not found' };
    }
    const question = qResult.rows[0];

    // Get game state for timing
    const stateResult = await client.query('SELECT * FROM game_state WHERE id = 1');
    const gameState = stateResult.rows[0];

    // Get all locked answers for this question
    const answersResult = await client.query(
      `SELECT a.*, t.name as team_name FROM answers a
       JOIN teams t ON t.id = a.team_id
       WHERE a.question_id = $1`,
      [questionId]
    );

    const results = [];

    for (const answer of answersResult.rows) {
      const isCorrect = answer.answer_given.trim().toLowerCase() === question.correct_answer.trim().toLowerCase();

      // Calculate score based on round
      let coinsEarned = 0;
      switch (question.round_id) {
        case 1:
          coinsEarned = calculateR1Score(
            answer.submitted_at,
            gameState.question_opened_at || answer.submitted_at,
            isCorrect
          );
          break;
        case 2:
          coinsEarned = calculateR2Score(question.difficulty, isCorrect);
          break;
        case 3:
          coinsEarned = calculateR3Score(isCorrect);
          break;
        case 4: {
          const r4Mode = r4Engine.getMode(answer.team_id, questionId);
          coinsEarned = r4Engine.calculateR4Score(r4Mode || 'safe', isCorrect);
          break;
        }
        default:
          coinsEarned = isCorrect ? (question.coins_reward || 50) : 0;
      }

      // Update the answer record with actual correctness and coins
      await client.query(
        `UPDATE answers SET is_correct = $1, coins_earned = $2 WHERE id = $3`,
        [isCorrect, coinsEarned, answer.id]
      );

      // Update team coins
      await client.query(
        'UPDATE teams SET coins = GREATEST(0, coins + $1) WHERE id = $2',
        [coinsEarned, answer.team_id]
      );

      // Update avg response time
      await client.query(
        `UPDATE teams SET avg_response_time_ms = (
          SELECT COALESCE(AVG(time_elapsed_ms), 0) FROM answers WHERE team_id = $1 AND coins_earned != 0
        ) WHERE id = $1`,
        [answer.team_id]
      );

      // Get updated coins
      const teamResult = await client.query('SELECT coins FROM teams WHERE id = $1', [answer.team_id]);

      results.push({
        teamId: answer.team_id,
        teamName: answer.team_name,
        answerGiven: answer.answer_given,
        isCorrect,
        coinsEarned,
        totalCoins: teamResult.rows[0].coins,
        timeElapsedMs: answer.time_elapsed_ms,
        mode: question.round_id === 4 ? (r4Engine.getMode(answer.team_id, questionId) || 'safe') : undefined,
      });
    }

    // Clear active question
    await client.query(
      `UPDATE game_state SET active_question_id = NULL, question_opened_at = NULL, updated_at = NOW() WHERE id = 1`
    );

    await client.query('COMMIT');

    // Emit results to each team individually
    if (io) {
      for (const r of results) {
        io.to(`team:${r.teamId}`).emit('answer:result', {
          correct: r.isCorrect,
          coinsEarned: r.coinsEarned,
          totalCoins: r.totalCoins,
          correctAnswer: question.correct_answer,
        });
      }

      // ─── R3: Resolve power cards after scoring ──────────
      if (question.round_id === 3) {
        try {
          const { resolveCardsForAnswer } = require('./cardEngine');
          for (const r of results) {
            await resolveCardsForAnswer(questionId, r.teamId, r.isCorrect, io);
          }
        } catch (cardErr) {
          console.error('[REVEAL] Card resolution error (non-fatal):', cardErr.message);
        }
      }

      // Emit reveal event to ALL clients (for the leaderboard projector etc.)
      io.emit('answer:revealed', {
        questionId,
        correctAnswer: question.correct_answer,
        results: results.map(r => ({
          teamName: r.teamName,
          isCorrect: r.isCorrect,
          coinsEarned: r.coinsEarned,
          mode: r.mode,
        })),
        totalLocked: answersResult.rows.length,
      });

      // R4: Clear mode selections after reveal
      if (question.round_id === 4) {
        r4Engine.clearModesForQuestion(questionId);
      }

      // Broadcast updated leaderboard (re-query after card effects)
      const lb = await db.query(
        `SELECT id, name, coins, status,
                RANK() OVER (ORDER BY coins DESC, avg_response_time_ms ASC) as rank
         FROM teams WHERE status = 'active'
         ORDER BY coins DESC, avg_response_time_ms ASC`
      );
      io.emit('leaderboard:update', { rankings: lb.rows });
    }

    return {
      success: true,
      correctAnswer: question.correct_answer,
      totalAnswered: results.length,
      correctCount: results.filter(r => r.isCorrect).length,
      results,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[SCORE ENGINE] Reveal error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Unified answer processor for R2/R3 — instant scoring (not lock-reveal).
 */
async function processAnswer(teamId, questionId, answerGiven, io) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const qResult = await client.query('SELECT * FROM questions WHERE id = $1', [questionId]);
    if (qResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { error: 'INVALID_QUESTION', message: 'Question not found' };
    }
    const question = qResult.rows[0];

    const stateResult = await client.query('SELECT * FROM game_state WHERE id = 1');
    const gameState = stateResult.rows[0];

    if (gameState.current_round !== question.round_id) {
      await client.query('ROLLBACK');
      return { error: 'INVALID_ROUND', message: 'Not the current round' };
    }

    // CRITICAL: reject answers when round is ended or paused
    if (gameState.round_status !== 'active') {
      await client.query('ROLLBACK');
      return { error: 'ROUND_ENDED', message: 'Round is not active — submissions closed' };
    }

    // Duplicate check
    const dupCheck = await client.query(
      'SELECT id FROM answers WHERE team_id = $1 AND question_id = $2',
      [teamId, questionId]
    );
    if (dupCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return { error: 'DUPLICATE_SUBMISSION', message: 'Already answered' };
    }

    const isCorrect = answerGiven.trim().toLowerCase() === question.correct_answer.trim().toLowerCase();
    let coinsEarned = 0;
    const now = new Date();

    switch (question.round_id) {
      case 2:
        coinsEarned = calculateR2Score(question.difficulty, isCorrect);
        break;
      case 3:
        coinsEarned = calculateR3Score(isCorrect);
        break;
      default:
        coinsEarned = isCorrect ? (question.coins_reward || 50) : 0;
    }

    const timeElapsedMs = gameState.question_opened_at
      ? Math.max(0, now - new Date(gameState.question_opened_at))
      : 0;

    await client.query(
      `INSERT INTO answers (team_id, question_id, answer_given, is_correct, coins_earned, time_elapsed_ms)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [teamId, questionId, answerGiven, isCorrect, coinsEarned, timeElapsedMs]
    );

    await client.query(
      'UPDATE teams SET coins = GREATEST(0, coins + $1) WHERE id = $2',
      [coinsEarned, teamId]
    );

    await client.query(
      `UPDATE teams SET avg_response_time_ms = (
        SELECT COALESCE(AVG(time_elapsed_ms), 0) FROM answers WHERE team_id = $1
      ) WHERE id = $1`,
      [teamId]
    );

    const totalResult = await client.query('SELECT coins FROM teams WHERE id = $1', [teamId]);
    const totalCoins = totalResult.rows[0].coins;

    await client.query('COMMIT');
    return { isCorrect, coinsEarned, totalCoins, timeElapsedMs };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * R2 LOCK — stores answer without scoring (coins_earned=0, is_correct=false).
 * Actual scoring happens on revealR2Category.
 */
async function lockR2Answer(teamId, questionId, answerGiven) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Verify question exists
    const qResult = await client.query('SELECT id FROM questions WHERE id = $1 AND round_id = 2', [questionId]);
    if (qResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { error: 'INVALID_QUESTION', message: 'Question not found' };
    }

    // Verify round is active
    const stateResult = await client.query('SELECT * FROM game_state WHERE id = 1');
    const gs = stateResult.rows[0];
    if (gs.current_round !== 2 || gs.round_status !== 'active') {
      await client.query('ROLLBACK');
      return { error: 'ROUND_NOT_ACTIVE', message: 'Round 2 is not active' };
    }

    // Duplicate check
    const dup = await client.query(
      'SELECT id FROM answers WHERE team_id = $1 AND question_id = $2',
      [teamId, questionId]
    );
    if (dup.rows.length > 0) {
      await client.query('ROLLBACK');
      return { error: 'DUPLICATE_SUBMISSION', message: 'Already answered' };
    }

    const now = new Date();
    const timeElapsedMs = gs.question_opened_at
      ? Math.max(0, now - new Date(gs.question_opened_at))
      : 0;

    // Store answer with is_correct=false, coins_earned=0 (will be scored on reveal)
    await client.query(
      `INSERT INTO answers (team_id, question_id, answer_given, is_correct, coins_earned, time_elapsed_ms)
       VALUES ($1, $2, $3, false, 0, $4)`,
      [teamId, questionId, answerGiven, timeElapsedMs]
    );

    await client.query('COMMIT');
    console.log(`[R2 LOCK] Team ${teamId} locked answer for Q:${questionId}`);
    return { success: true, locked: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * R2 REVEAL — batch-scores all locked answers for a category.
 * Called when admin clicks "END CATEGORY & REVEAL SCORES".
 */
async function revealR2Category(category, io) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Get all R2 questions for this category
    const questions = await client.query(
      'SELECT id, correct_answer, difficulty FROM questions WHERE round_id = 2 AND theme = $1',
      [category]
    );

    if (questions.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: 'No questions for category' };
    }

    const questionMap = {};
    const questionIds = [];
    for (const q of questions.rows) {
      questionMap[q.id] = q;
      questionIds.push(q.id);
    }

    // Get all locked (unscored) answers for these questions FROM CURRENT SESSION ONLY
    // lockR2Answer sets: is_correct=false, coins_earned=0
    // We also filter by submitted_at >= question_opened_at to avoid re-scoring old test answers
    const gsResult = await client.query('SELECT question_opened_at FROM game_state WHERE id = 1');
    const sessionStart = gsResult.rows[0]?.question_opened_at || new Date(0).toISOString();

    const answersResult = await client.query(
      `SELECT a.id, a.team_id, a.question_id, a.answer_given
       FROM answers a
       WHERE a.question_id = ANY($1)
         AND a.is_correct = false
         AND a.coins_earned = 0
         AND a.submitted_at >= $2`,
      [questionIds, sessionStart]
    );

    const results = [];

    for (const ans of answersResult.rows) {
      const q = questionMap[ans.question_id];
      if (!q) continue;

      const isCorrect = ans.answer_given.trim().toLowerCase() === q.correct_answer.trim().toLowerCase();
      const coinsEarned = calculateR2Score(q.difficulty, isCorrect);

      // Update answer record with actual correctness and coins
      await client.query(
        'UPDATE answers SET is_correct = $1, coins_earned = $2 WHERE id = $3',
        [isCorrect, coinsEarned, ans.id]
      );

      // Update team coins
      await client.query(
        'UPDATE teams SET coins = GREATEST(0, coins + $1) WHERE id = $2',
        [coinsEarned, ans.team_id]
      );

      results.push({
        teamId: ans.team_id,
        isCorrect,
        coinsEarned,
        difficulty: q.difficulty,
      });
    }

    // Update avg response times for affected teams
    const uniqueTeams = [...new Set(results.map(r => r.teamId))];
    for (const tid of uniqueTeams) {
      await client.query(
        `UPDATE teams SET avg_response_time_ms = (
          SELECT COALESCE(AVG(time_elapsed_ms), 0) FROM answers WHERE team_id = $1
        ) WHERE id = $1`,
        [tid]
      );
    }

    await client.query('COMMIT');

    // Emit results to each team
    for (const r of results) {
      const teamCoins = await db.query('SELECT coins FROM teams WHERE id = $1', [r.teamId]);
      io.to(`team:${r.teamId}`).emit('r2:answer-revealed', {
        correct: r.isCorrect,
        coinsEarned: r.coinsEarned,
        totalCoins: teamCoins.rows[0]?.coins || 0,
        difficulty: r.difficulty,
      });
    }

    // Broadcast leaderboard
    const lb = await db.query(
      `SELECT id, name, coins, status,
              RANK() OVER (ORDER BY coins DESC, avg_response_time_ms ASC) as rank
       FROM teams WHERE status = 'active'
       ORDER BY coins DESC, avg_response_time_ms ASC`
    );
    io.emit('leaderboard:update', { rankings: lb.rows });

    console.log(`[R2 REVEAL] Category "${category}" — ${results.length} answers scored`);
    return {
      success: true,
      totalRevealed: results.length,
      correctCount: results.filter(r => r.isCorrect).length,
      results,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[R2 REVEAL] Error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  calculateR1Score,
  calculateR2Score,
  calculateR3Score,
  lockAnswer,
  revealAnswer,
  processAnswer,
  lockR2Answer,
  revealR2Category,
};
