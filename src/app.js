require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const { generalLimiter } = require('./middleware/rateLimit');
const { initSocketHandlers } = require('./socket/socketHandlers');
const { router: r2Router, initR2SocketHandlers } = require('./routes/r2');

const app = express();
const server = http.createServer(app);

// ─── Socket.io Setup ───────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Make io accessible in route handlers via req.app.get('io')
app.set('io', io);

// ─── Middleware ─────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(generalLimiter);

// ─── Health Check ──────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── API Routes (Phase 1) ─────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/answers', require('./routes/answers'));
app.use('/api/leaderboard', require('./routes/leaderboard'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/admin/r2', r2Router);

// ─── Phase 3: QR + Cards + R3 Admin ──────────────────────
app.use('/api/qr', require('./routes/qr'));
app.use('/api/cards', require('./routes/cards'));
app.use('/api/admin/r3', require('./routes/r3'));

// ─── Serve uploaded images ───────────────────────────────
const path = require('path');
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// ─── R2 Questions (public for authenticated teams) ────────
const authMiddleware = require('./middleware/auth');
const db = require('./db/pool');

app.get('/api/r2/questions', authMiddleware, async (req, res) => {
  try {
    const state = await db.query('SELECT current_round, round_status, question_opened_at FROM game_state WHERE id = 1');
    const gs = state.rows[0];
    if (gs?.current_round !== 2 || gs?.round_status !== 'active') {
      return res.status(400).json({ error: 'INVALID_ROUND', message: 'Round 2 is not active' });
    }

    const result = await db.query(
      `SELECT id, theme, difficulty, question_text, options, coins_reward
       FROM questions WHERE round_id = 2 ORDER BY theme, difficulty`
    );

    // Get this team's already-answered question IDs
    const answeredResult = await db.query(
      `SELECT question_id, is_correct, coins_earned FROM answers
       WHERE team_id = $1 AND question_id IN (SELECT id FROM questions WHERE round_id = 2)`,
      [req.team.teamId]
    );

    // Group by theme
    const grouped = {};
    for (const q of result.rows) {
      if (!grouped[q.theme]) grouped[q.theme] = [];
      grouped[q.theme].push({
        ...q,
        options: typeof q.options === 'string' ? JSON.parse(q.options) : q.options,
      });
    }

    return res.json({
      questions: grouped,
      answered: answeredResult.rows,
      roundStartedAt: gs.question_opened_at, // reusing this field for round timer
    });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ─── 404 Handler ───────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` });
});

// ─── Global Error Handler ─────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[SERVER] Unhandled error:', err);
  res.status(500).json({ error: 'SERVER_ERROR', message: 'Internal server error' });
});

// ─── Socket.io Init ───────────────────────────────────────
initSocketHandlers(io);
initR2SocketHandlers(io);

// ─── Start Server ─────────────────────────────────────────
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`\n⚔️  TECH WAR Backend running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Socket.io: ws://localhost:${PORT}`);
  console.log(`   CORS Origin: ${process.env.CORS_ORIGIN || 'http://localhost:5173'}\n`);
});

module.exports = { app, server, io };
