const express = require('express');
const multer = require('multer');
const path = require('path');
const db = require('../db/pool');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

// ─── Multer config for image uploads ─────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../../uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `r3_${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

// All routes require admin auth
router.use(adminAuth);

/**
 * GET /api/admin/r3/questions
 * Get all R3 questions
 */
router.get('/questions', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, theme, question_text, options, correct_answer, coins_reward
       FROM questions WHERE round_id = 3 ORDER BY created_at ASC`
    );
    return res.json({ questions: result.rows });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

/**
 * POST /api/admin/r3/questions
 * Create a new R3 question (AI vs Human format)
 * Body: { type: 'text'|'image', content: string, correctAnswer: 'AI'|'Human' }
 * Or multipart with image file
 */
router.post('/questions', upload.single('image'), async (req, res) => {
  try {
    const { type, content, correctAnswer } = req.body;

    if (!correctAnswer || !['AI', 'Human'].includes(correctAnswer)) {
      return res.status(400).json({ error: 'VALIDATION', message: 'correctAnswer must be AI or Human' });
    }

    let questionText = '';

    if (type === 'image') {
      if (req.file) {
        // Image uploaded — store the URL path
        questionText = `/uploads/${req.file.filename}`;
      } else if (content) {
        // Image URL provided directly
        questionText = content;
      } else {
        return res.status(400).json({ error: 'VALIDATION', message: 'Image file or URL required' });
      }
    } else {
      // Text question
      if (!content) {
        return res.status(400).json({ error: 'VALIDATION', message: 'Content text required' });
      }
      questionText = content;
    }

    const result = await db.query(
      `INSERT INTO questions (round_id, theme, difficulty, question_text, options, correct_answer, coins_reward)
       VALUES (3, $1, 'medium', $2, $3, $4, 100)
       RETURNING id`,
      [
        type || 'text',                           // theme = 'text' or 'image'
        questionText,
        JSON.stringify(['AI', 'Human']),           // Always 2 options
        correctAnswer,
      ]
    );

    return res.json({ success: true, questionId: result.rows[0].id });
  } catch (err) {
    console.error('[R3] Create question error:', err.message);
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

/**
 * DELETE /api/admin/r3/questions/:id
 * Delete an R3 question
 */
router.delete('/questions/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM questions WHERE id = $1 AND round_id = 3', [req.params.id]);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

module.exports = router;
