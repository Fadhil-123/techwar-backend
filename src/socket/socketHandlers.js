const jwt = require('jsonwebtoken');
const db = require('../db/pool');

/**
 * Initialize all Socket.io event handlers.
 * R1: lock-then-reveal flow (admin reveals answer)
 * R2+: instant scoring on submit
 */
function initSocketHandlers(io) {
  io.on('connection', (socket) => {
    console.log(`[SOCKET] Client connected: ${socket.id}`);

    // ─── Authenticate and join team room ─────────────────
    socket.on('auth', async (data) => {
      try {
        const { token } = data;
        if (!token) {
          socket.emit('auth:error', { message: 'No token provided' });
          return;
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret_key_2026');
        socket.teamId = decoded.teamId;
        socket.teamName = decoded.teamName;

        // Join team-specific room
        socket.join(`team:${decoded.teamId}`);
        console.log(`[SOCKET] Team "${decoded.teamName}" joined room team:${decoded.teamId}`);

        // Send current game state
        const state = await db.query('SELECT * FROM game_state WHERE id = 1');
        const team = await db.query('SELECT coins, status FROM teams WHERE id = $1', [decoded.teamId]);

        socket.emit('auth:success', {
          teamId: decoded.teamId,
          teamName: decoded.teamName,
          gameState: state.rows[0],
          coins: team.rows[0]?.coins || 0,
          status: team.rows[0]?.status || 'active',
        });

        // --- AUTO-RECOVER R2 STATE FOR CACHED PHONES ---
        if (state.rows[0]?.current_round === 2 && state.rows[0]?.round_status === 'active') {
          const { getR2State } = require('../routes/r2');
          const r2s = getR2State();
          if (r2s && r2s.activeCategory && r2s.phase !== 'idle') {
             const difficulty = r2s.selections[decoded.teamId];
             if (r2s.phase === 'selecting') {
               socket.emit('r2:select-difficulty', {
                 category: r2s.activeCategory,
                 categoryLabel: r2s.activeCategory, // simplify
                 timeLimit: Math.max(0, (new Date(r2s.selectionDeadline).getTime() - Date.now()) / 1000),
                 deadline: r2s.selectionDeadline,
               });
               if (difficulty) {
                 socket.emit('r2:difficulty-confirmed', { difficulty, reward: difficulty === 'medium' ? 200 : difficulty === 'hard' ? 300 : 100 });
               }
             } else if (r2s.phase === 'answering') {
               const questionId = r2s.assignedQuestions[decoded.teamId];
               if (questionId) {
                 try {
                   const qResult = await db.query('SELECT difficulty, question_text, options FROM questions WHERE id = $1', [questionId]);
                   if (qResult.rows.length > 0) {
                     const q = qResult.rows[0];
                     socket.emit('r2:question', {
                       questionId,
                       text: q.question_text,
                       options: typeof q.options === 'string' ? JSON.parse(q.options) : q.options,
                       difficulty: q.difficulty,
                       reward: q.difficulty === 'medium' ? 200 : q.difficulty === 'hard' ? 300 : 100,
                       category: r2s.activeCategory,
                       categoryLabel: r2s.activeCategory,
                       timeLimit: Math.max(0, (new Date(r2s.answerDeadline).getTime() - Date.now()) / 1000),
                       deadline: r2s.answerDeadline,
                     });
                   }
                 } catch(e) {}
               }
             }
          }
        }
      } catch (err) {
        console.error('[SOCKET] Auth error:', err.message);
        socket.emit('auth:error', { message: 'Authentication failed' });
      }
    });

    // ─── Answer Lock (R1) — team picks answer, waits for admin reveal ─
    socket.on('answer:lock', async (data) => {
      try {
        if (!socket.teamId) {
          socket.emit('answer:error', { message: 'Not authenticated' });
          return;
        }

        const { questionId, answer } = data;
        if (!questionId || !answer) {
          socket.emit('answer:error', { message: 'Missing questionId or answer' });
          return;
        }

        // Check pause state
        const stateCheck = await db.query('SELECT is_paused, current_round, active_question_id FROM game_state WHERE id = 1');
        if (stateCheck.rows[0]?.is_paused) {
          socket.emit('answer:error', { error: 'SYSTEM_PAUSED', message: 'System is paused' });
          return;
        }

        // R4: Verify mode was selected before allowing answer lock
        const currentRound = stateCheck.rows[0]?.current_round;
        if (currentRound === 4) {
          const { getMode } = require('../engines/r4Engine');
          if (!getMode(socket.teamId, questionId)) {
            socket.emit('answer:error', { error: 'NO_MODE', message: 'Select SAFE or DOUBLE first' });
            return;
          }
        }

        const { lockAnswer } = require('../engines/scoreEngine');
        const result = await lockAnswer(socket.teamId, questionId, answer);

        if (result.error) {
          socket.emit('answer:error', { error: result.error, message: result.message });
          return;
        }

        // Confirm lock to team
        socket.emit('answer:locked', {
          questionId,
          answer: result.answer,
          message: 'Answer locked! Waiting for reveal...',
        });

        // Notify admin how many have locked in
        const lockCount = await db.query(
          'SELECT COUNT(*) as c FROM answers WHERE question_id = $1',
          [questionId]
        );
        const totalTeams = await db.query(
          "SELECT COUNT(*) as c FROM teams WHERE status = 'active'"
        );

        io.to('admin').emit('lock:count', {
          questionId,
          lockedCount: parseInt(lockCount.rows[0].c),
          totalTeams: parseInt(totalTeams.rows[0].c),
        });

        console.log(`[SOCKET] Team "${socket.teamName}" locked answer for Q:${questionId}`);
      } catch (err) {
        console.error('[SOCKET] Lock error:', err.message);
        socket.emit('answer:error', { message: 'Failed to lock answer' });
      }
    });

    // ─── Answer Submit (R2: lock only, R3+: instant scoring) ─
    socket.on('answer:submit', async (data) => {
      try {
        if (!socket.teamId) {
          socket.emit('answer:error', { message: 'Not authenticated' });
          return;
        }

        const { questionId, answer } = data;
        if (!questionId || !answer) {
          socket.emit('answer:error', { message: 'Missing questionId or answer' });
          return;
        }

        const stateCheck = await db.query('SELECT is_paused, current_round FROM game_state WHERE id = 1');
        if (stateCheck.rows[0]?.is_paused) {
          socket.emit('answer:error', { error: 'SYSTEM_PAUSED', message: 'System is paused' });
          return;
        }

        const currentRound = stateCheck.rows[0]?.current_round;

        // ─── R2: LOCK answer (no scoring, no result shown) ───
        if (currentRound === 2) {
          const { lockR2Answer } = require('../engines/scoreEngine');
          const lockResult = await lockR2Answer(socket.teamId, questionId, answer);

          if (lockResult.error) {
            socket.emit('answer:error', { error: lockResult.error, message: lockResult.message });
            return;
          }

          // Tell team: answer is locked, wait for admin reveal
          socket.emit('r2:answer-locked', {
            questionId,
            message: 'Answer locked! Waiting for reveal...',
          });

          // Notify admin of lock count for this category
          const lockCount = await db.query(
            `SELECT COUNT(*) as c FROM answers WHERE question_id IN (
              SELECT id FROM questions WHERE round_id = 2 AND theme = (
                SELECT theme FROM questions WHERE id = $1
              )
            )`,
            [questionId]
          );
          const totalTeams = await db.query(
            "SELECT COUNT(*) as c FROM teams WHERE status = 'active'"
          );
          io.to('admin').emit('r2:answer-count', {
            count: parseInt(lockCount.rows[0].c),
            total: parseInt(totalTeams.rows[0].c),
          });

          return; // NO scoring, NO leaderboard update here
        }

        // ─── R3+: Instant scoring ────────────────────────────
        const { processAnswer } = require('../engines/scoreEngine');
        const result = await processAnswer(socket.teamId, questionId, answer, io);

        if (result.error) {
          socket.emit('answer:error', { error: result.error, message: result.message });
          return;
        }

        socket.emit('answer:result', {
          correct: result.isCorrect,
          coinsEarned: result.coinsEarned,
          totalCoins: result.totalCoins,
        });

        // Broadcast leaderboard
        const leaderboard = await db.query(
          `SELECT id, name, coins, status,
                  RANK() OVER (ORDER BY coins DESC, avg_response_time_ms ASC) as rank
           FROM teams WHERE status = 'active'
           ORDER BY coins DESC, avg_response_time_ms ASC`
        );
        io.emit('leaderboard:update', { rankings: leaderboard.rows });
      } catch (err) {
        console.error('[SOCKET] Answer error:', err.message);
        socket.emit('answer:error', { message: 'Failed to process answer' });
      }
    });

    // ─── Request Leaderboard ─────────────────────────────
    socket.on('leaderboard:request', async () => {
      try {
        const leaderboard = await db.query(
          `SELECT id, name, coins, status,
                  RANK() OVER (ORDER BY coins DESC, avg_response_time_ms ASC) as rank
           FROM teams WHERE status = 'active'
           ORDER BY coins DESC, avg_response_time_ms ASC`
        );
        socket.emit('leaderboard:update', { rankings: leaderboard.rows });
      } catch (err) {
        console.error('[SOCKET] Leaderboard error:', err.message);
      }
    });

    // ─── Admin join ──────────────────────────────────────
    socket.on('admin:auth', (data) => {
      try {
        const decoded = jwt.verify(data.token, process.env.ADMIN_JWT_SECRET || 'admin_fallback_secret_key_2026');
        if (decoded.isAdmin) {
          socket.join('admin');
          socket.isAdmin = true;
          socket.emit('admin:auth:success', { message: 'Admin connected' });
          console.log('[SOCKET] Admin connected');
        }
      } catch (err) {
        socket.emit('admin:auth:error', { message: 'Invalid admin token' });
      }
    });

    // ─── R4: Lock Mode (SAFE / DOUBLE) ────────────────────
    socket.on('r4:lock-mode', async (data) => {
      try {
        if (!socket.teamId) {
          socket.emit('r4:mode-error', { message: 'Not authenticated' });
          return;
        }

        const { questionId, mode } = data;
        if (!questionId || (mode !== 'safe' && mode !== 'double')) {
          socket.emit('r4:mode-error', { message: 'Invalid mode' });
          return;
        }

        const stateCheck = await db.query(
          'SELECT current_round, round_status, active_question_id, is_paused FROM game_state WHERE id = 1'
        );
        const gs = stateCheck.rows[0];
        if (!gs || gs.current_round !== 4 || gs.round_status !== 'active') {
          socket.emit('r4:mode-error', { message: 'Round 4 is not active' });
          return;
        }
        if (gs.is_paused) {
          socket.emit('r4:mode-error', { message: 'System is paused' });
          return;
        }
        if (gs.active_question_id !== questionId) {
          socket.emit('r4:mode-error', { message: 'Question is not active' });
          return;
        }

        const { setMode, getModeCount } = require('../engines/r4Engine');
        const success = setMode(socket.teamId, questionId, mode);

        if (!success) {
          socket.emit('r4:mode-error', { message: 'Mode already selected' });
          return;
        }

        socket.emit('r4:mode-locked', { questionId, mode });

        // Notify admin of mode counts
        const counts = getModeCount(questionId);
        io.to('admin').emit('r4:mode-count', counts);

        console.log(`[R4] Team "${socket.teamName}" chose ${mode.toUpperCase()} for Q:${questionId}`);
      } catch (err) {
        console.error('[R4] Mode lock error:', err.message);
        socket.emit('r4:mode-error', { message: 'Failed to lock mode' });
      }
    });

    // ─── R4: Check Mode (for page refresh recovery) ───────
    socket.on('r4:check-mode', (data) => {
      if (!socket.teamId || !data?.questionId) return;
      const { getMode } = require('../engines/r4Engine');
      const mode = getMode(socket.teamId, data.questionId);
      if (mode) {
        socket.emit('r4:mode-locked', { questionId: data.questionId, mode });
      }
    });

    // ─── Disconnect ──────────────────────────────────────
    socket.on('disconnect', (reason) => {
      console.log(`[SOCKET] Client disconnected: ${socket.id} (${reason})`);
    });
  });
}

module.exports = { initSocketHandlers };
