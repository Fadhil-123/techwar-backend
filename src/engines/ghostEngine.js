const db = require('../db/pool');

/**
 * Apply ghost betting effects after an active team answers.
 * - Correct: ghost earns +30% of coins earned
 * - Wrong: ghost loses -3% of their own coins
 */
async function applyGhostEffects(activeTeamId, isCorrect, coinsEarned, io) {
  try {
    const ghosts = await db.query(
      `SELECT gb.ghost_team_id, t.coins FROM ghost_bets gb
       JOIN teams t ON t.id = gb.ghost_team_id
       WHERE gb.target_team_id = $1`,
      [activeTeamId]
    );

    for (const ghost of ghosts.rows) {
      let delta = 0;
      if (isCorrect) {
        delta = Math.floor(coinsEarned * 0.30);
      } else {
        delta = -Math.floor(ghost.coins * 0.03);
      }

      // Update ghost team coins — never below 0
      await db.query(
        'UPDATE teams SET coins = GREATEST(0, coins + $1) WHERE id = $2',
        [delta, ghost.ghost_team_id]
      );

      // Track gains/losses in ghost_bets
      if (delta >= 0) {
        await db.query(
          'UPDATE ghost_bets SET coins_gained = coins_gained + $1 WHERE ghost_team_id = $2',
          [delta, ghost.ghost_team_id]
        );
      } else {
        await db.query(
          'UPDATE ghost_bets SET coins_lost = coins_lost + $1 WHERE ghost_team_id = $2',
          [Math.abs(delta), ghost.ghost_team_id]
        );
      }

      // Get updated total
      const updated = await db.query('SELECT coins FROM teams WHERE id = $1', [ghost.ghost_team_id]);
      const newTotal = updated.rows[0]?.coins || 0;

      // Notify individual ghost team
      if (io) {
        io.to(`team:${ghost.ghost_team_id}`).emit('ghost:coin_update', {
          delta,
          newTotal,
          targetCorrect: isCorrect,
          targetTeamId: activeTeamId,
        });
      }
    }

    // Emit ghost leaderboard update
    if (io && ghosts.rows.length > 0) {
      const ghostLeaderboard = await getGhostLeaderboard();
      io.emit('leaderboard:ghost_update', { ghostRankings: ghostLeaderboard });
    }
  } catch (err) {
    console.error('[GHOST ENGINE] Error applying effects:', err.message);
    // Don't throw — ghost errors shouldn't break main game flow
  }
}

/**
 * Lock a ghost team's bet on a target active team.
 * Once locked, cannot be changed.
 */
async function lockGhostBet(ghostTeamId, targetTeamId) {
  // Verify ghost status
  const ghostResult = await db.query(
    `SELECT id, status FROM teams WHERE id = $1 AND status = 'ghost'`,
    [ghostTeamId]
  );
  if (ghostResult.rows.length === 0) {
    return { error: 'NOT_GHOST', message: 'Only ghost teams can place bets' };
  }

  // Verify target is active
  const targetResult = await db.query(
    `SELECT id, status FROM teams WHERE id = $1 AND status = 'active'`,
    [targetTeamId]
  );
  if (targetResult.rows.length === 0) {
    return { error: 'INVALID_TARGET', message: 'Target team must be active' };
  }

  // Check if already has a bet
  const existingBet = await db.query(
    'SELECT id FROM ghost_bets WHERE ghost_team_id = $1',
    [ghostTeamId]
  );
  if (existingBet.rows.length > 0) {
    return { error: 'BET_LOCKED', message: 'Your bet is already locked and cannot be changed' };
  }

  // Lock the bet
  await db.query(
    'INSERT INTO ghost_bets (ghost_team_id, target_team_id) VALUES ($1, $2)',
    [ghostTeamId, targetTeamId]
  );

  return { success: true, targetTeamId };
}

/**
 * Get ghost leaderboard — sorted by coins DESC.
 */
async function getGhostLeaderboard() {
  const result = await db.query(
    `SELECT t.id, t.name, t.coins, gb.target_team_id, tt.name as target_name,
            gb.coins_gained, gb.coins_lost,
            RANK() OVER (ORDER BY t.coins DESC) as rank
     FROM teams t
     LEFT JOIN ghost_bets gb ON gb.ghost_team_id = t.id
     LEFT JOIN teams tt ON tt.id = gb.target_team_id
     WHERE t.status = 'ghost'
     ORDER BY t.coins DESC`
  );
  return result.rows;
}

/**
 * Resurrect top 2 ghost teams back into active play.
 */
async function resurrectTopGhosts(io) {
  const topGhosts = await db.query(
    `SELECT id, name, coins FROM teams WHERE status = 'ghost' ORDER BY coins DESC LIMIT 2`
  );

  for (const ghost of topGhosts.rows) {
    await db.query(
      `UPDATE teams SET status = 'active' WHERE id = $1`,
      [ghost.id]
    );
    if (io) {
      io.emit('ghost:resurrected', { teamId: ghost.id, teamName: ghost.name, coins: ghost.coins });
    }
  }

  return topGhosts.rows;
}

module.exports = {
  applyGhostEffects,
  lockGhostBet,
  getGhostLeaderboard,
  resurrectTopGhosts,
};
