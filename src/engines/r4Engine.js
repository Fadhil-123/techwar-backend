/**
 * R4 Engine — DOUBLE OR NOTHING mode selection store.
 * In-memory Map for mode selections (safe/double).
 * Lives for the duration of each question only.
 */

const modeSelections = new Map(); // key: `${teamId}:${questionId}` → 'safe' | 'double'

function setMode(teamId, questionId, mode) {
  if (mode !== 'safe' && mode !== 'double') return false;
  const key = `${teamId}:${questionId}`;
  if (modeSelections.has(key)) return false; // Already selected — no changes
  modeSelections.set(key, mode);
  return true;
}

function getMode(teamId, questionId) {
  return modeSelections.get(`${teamId}:${questionId}`) || null;
}

function clearModesForQuestion(questionId) {
  for (const key of [...modeSelections.keys()]) {
    if (key.endsWith(`:${questionId}`)) {
      modeSelections.delete(key);
    }
  }
}

function getModeCount(questionId) {
  let safe = 0, double = 0;
  for (const [key, mode] of modeSelections) {
    if (key.endsWith(`:${questionId}`)) {
      if (mode === 'safe') safe++;
      else double++;
    }
  }
  return { safe, double, total: safe + double };
}

/**
 * R4 Scoring — SAFE vs DOUBLE
 */
function calculateR4Score(mode, isCorrect) {
  if (mode === 'double') {
    return isCorrect ? 200 : -100;
  }
  // safe mode (default fallback)
  return isCorrect ? 100 : -30;
}

module.exports = { setMode, getMode, clearModesForQuestion, getModeCount, calculateR4Score };
