const db = require('../db/pool');

/**
 * Get current game state.
 */
async function getGameState() {
  const result = await db.query('SELECT * FROM game_state WHERE id = 1');
  return result.rows[0];
}

/**
 * Update the r5_layers in game state.
 */
async function updateLayerState(layers) {
  await db.query(
    'UPDATE game_state SET r5_layers = $1, updated_at = NOW() WHERE id = 1',
    [JSON.stringify(layers)]
  );
}

/**
 * Get layer questions — map layer IDs to R5 questions.
 */
async function getLayerQuestions() {
  const result = await db.query(
    `SELECT * FROM questions WHERE round_id = 5 ORDER BY created_at ASC LIMIT 5`
  );
  return result.rows;
}

/**
 * Claim a layer — lock it to a team for 60 seconds.
 */
async function claimLayer(teamId, layerId, io) {
  const state = await getGameState();
  const layers = state.r5_layers;
  const layer = layers.find(l => l.id === layerId);

  if (!layer) {
    return { error: 'INVALID_LAYER', message: 'Layer does not exist' };
  }
  if (layer.status === 'breached') {
    return { error: 'ALREADY_BREACHED', message: 'This layer has already been breached' };
  }
  if (layer.status === 'claimed') {
    return { error: 'LAYER_TAKEN', message: 'This layer is currently claimed by another team' };
  }

  // Lock to team with 60-second expiry
  layer.status = 'claimed';
  layer.claimed_by = teamId;
  layer.claim_expires_at = new Date(Date.now() + 60000).toISOString();

  await updateLayerState(layers);

  if (io) {
    io.emit('breach:layer_claimed', {
      layerId,
      teamId,
      expiresAt: layer.claim_expires_at,
    });
  }

  // Auto-release if no answer in 61 seconds
  setTimeout(async () => {
    try {
      const freshState = await getGameState();
      const freshLayers = freshState.r5_layers;
      const freshLayer = freshLayers.find(l => l.id === layerId);

      if (freshLayer && freshLayer.status === 'claimed' && freshLayer.claimed_by === teamId) {
        freshLayer.status = 'open';
        freshLayer.claimed_by = null;
        freshLayer.claim_expires_at = null;
        await updateLayerState(freshLayers);

        if (io) {
          io.emit('breach:layer_released', { layerId, reason: 'timeout' });
        }
      }
    } catch (err) {
      console.error('[BREACH ENGINE] Auto-release error:', err.message);
    }
  }, 61000);

  return { success: true, layerId, expiresAt: layer.claim_expires_at };
}

/**
 * Submit an answer for a claimed layer.
 */
async function submitBreachAnswer(teamId, layerId, answer, io) {
  const state = await getGameState();
  const layers = state.r5_layers;
  const layer = layers.find(l => l.id === layerId);

  if (!layer) {
    return { error: 'INVALID_LAYER', message: 'Layer does not exist' };
  }
  if (layer.claimed_by !== teamId) {
    return { error: 'NOT_YOUR_LAYER', message: 'You have not claimed this layer' };
  }

  // Get the question for this layer
  const questions = await getLayerQuestions();
  const question = questions[layerId - 1]; // layer 1 → question[0], etc.
  if (!question) {
    return { error: 'NO_QUESTION', message: 'No question found for this layer' };
  }

  const isCorrect = answer.trim().toLowerCase() === question.correct_answer.trim().toLowerCase();

  if (isCorrect) {
    layer.status = 'breached';
    layer.breached_by = teamId;
    layer.claimed_by = null;
    layer.claim_expires_at = null;
    await updateLayerState(layers);

    // Count total breaches by this team
    const breachCount = layers.filter(l => l.breached_by === teamId).length;

    if (io) {
      io.emit('breach:success', { teamId, layerId, breachCount });
    }

    // Win condition: first team to 3 breaches
    if (breachCount >= 3) {
      if (io) {
        io.emit('breach:victory', { winnerId: teamId });
      }
      // Update game state to ended
      await db.query(
        `UPDATE game_state SET round_status = 'ended', updated_at = NOW() WHERE id = 1`
      );
      return { success: true, breached: true, breachCount, victory: true };
    }

    return { success: true, breached: true, breachCount, victory: false };
  } else {
    // Wrong answer — release the layer
    layer.status = 'open';
    layer.claimed_by = null;
    layer.claim_expires_at = null;
    await updateLayerState(layers);

    if (io) {
      io.emit('breach:failed', { teamId, layerId });
    }

    return { success: true, breached: false, message: 'Wrong answer. Layer released.' };
  }
}

/**
 * Get current breach board state for display.
 */
async function getBreachBoard() {
  const state = await getGameState();
  const layers = state.r5_layers;

  // Get team names for display
  const teamIds = [
    ...new Set(
      layers
        .filter(l => l.claimed_by || l.breached_by)
        .flatMap(l => [l.claimed_by, l.breached_by].filter(Boolean))
    ),
  ];

  let teamNames = {};
  if (teamIds.length > 0) {
    const result = await db.query(
      `SELECT id, name FROM teams WHERE id = ANY($1)`,
      [teamIds]
    );
    teamNames = Object.fromEntries(result.rows.map(r => [r.id, r.name]));
  }

  return layers.map(l => ({
    ...l,
    claimed_by_name: teamNames[l.claimed_by] || null,
    breached_by_name: teamNames[l.breached_by] || null,
  }));
}

module.exports = {
  claimLayer,
  submitBreachAnswer,
  getBreachBoard,
  getLayerQuestions,
};
