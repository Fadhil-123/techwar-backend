const db = require('../db/pool');

/**
 * MAIN: Resolve all power cards after an answer is revealed.
 * 
 * STEAL: Target answered correct → steal 100 from target, split among attackers
 * SHIELD: Auto-blocks incoming steal (consumed)
 * BOUNTY: Target answered wrong → 300 reward split among bounty holders
 */
async function resolveCardsForAnswer(questionId, targetTeamId, isCorrect, io) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // ─── 1. Get all pending cards targeting this team ─────
    const pendingCards = await client.query(
      `SELECT pc.id, pc.team_id, pc.card_type, pc.used_at
       FROM power_cards pc
       WHERE pc.target_team_id = $1 AND pc.resolved = FALSE AND pc.used = TRUE
       ORDER BY pc.used_at ASC`,
      [targetTeamId]
    );

    const steals = pendingCards.rows.filter(c => c.card_type === 'steal');
    const bounties = pendingCards.rows.filter(c => c.card_type === 'bounty');

    // ─── 2. Check if target has an active shield ──────────
    const shieldResult = await client.query(
      `SELECT id FROM power_cards WHERE team_id = $1 AND card_type = 'shield' AND used = FALSE`,
      [targetTeamId]
    );
    const targetHasShield = shieldResult.rows.length > 0;

    // ─── 3. SHIELD resolution ─────────────────────────────
    if (targetHasShield && steals.length > 0) {
      // Consume the shield
      await client.query(
        `UPDATE power_cards SET used = TRUE, used_at = NOW(), resolved = TRUE, coins_effect = 0
         WHERE team_id = $1 AND card_type = 'shield' AND used = FALSE`,
        [targetTeamId]
      );

      // Void ALL incoming steals (shield blocks everything)
      for (const s of steals) {
        await client.query(
          'UPDATE power_cards SET resolved = TRUE, coins_effect = 0 WHERE id = $1',
          [s.id]
        );
      }

      if (io) {
        io.emit('card:blocked', {
          cardType: 'steal',
          blocker: targetTeamId,
          attackers: steals.map(s => s.team_id),
        });
      }

      console.log(`[CARD] Shield blocked ${steals.length} steal(s) for team ${targetTeamId}`);

      // Clear steals array — they've been voided
      steals.length = 0;
    }

    // ─── 4. STEAL resolution (SPLIT POOL) ─────────────────
    if (steals.length > 0 && isCorrect) {
      // Target answered correct → steal happens
      const TOTAL_STEAL = 100;
      const perAttacker = Math.floor(TOTAL_STEAL / steals.length);

      // Deduct from target (only once, total 100)
      const targetCoinsResult = await client.query('SELECT coins FROM teams WHERE id = $1', [targetTeamId]);
      const targetCoins = targetCoinsResult.rows[0]?.coins || 0;
      const actualDeduction = Math.min(TOTAL_STEAL, Math.max(0, targetCoins));

      await client.query(
        'UPDATE teams SET coins = GREATEST(0, coins - $1) WHERE id = $2',
        [actualDeduction, targetTeamId]
      );

      // Split among attackers
      for (const s of steals) {
        await client.query('UPDATE teams SET coins = coins + $1 WHERE id = $2', [perAttacker, s.team_id]);
        await client.query(
          'UPDATE power_cards SET resolved = TRUE, coins_effect = $1 WHERE id = $2',
          [perAttacker, s.id]
        );
      }

      if (io) {
        io.emit('card:steal_success', {
          target: targetTeamId,
          attackers: steals.map(s => ({ teamId: s.team_id, amount: perAttacker })),
          totalStolen: actualDeduction,
        });
      }

      console.log(`[CARD] Steal: ${steals.length} attackers split ${TOTAL_STEAL} from team ${targetTeamId}`);
    } else if (steals.length > 0 && !isCorrect) {
      // Target was wrong — steals fail silently
      for (const s of steals) {
        await client.query(
          'UPDATE power_cards SET resolved = TRUE, coins_effect = 0 WHERE id = $1',
          [s.id]
        );
      }
    }

    // ─── 5. BOUNTY resolution (SPLIT POOL) ────────────────
    if (bounties.length > 0 && !isCorrect) {
      // Target answered wrong → bounty pays out
      const TOTAL_BOUNTY = 300;
      const perBounty = Math.floor(TOTAL_BOUNTY / bounties.length);

      for (const b of bounties) {
        await client.query('UPDATE teams SET coins = coins + $1 WHERE id = $2', [perBounty, b.team_id]);
        await client.query(
          'UPDATE power_cards SET resolved = TRUE, coins_effect = $1 WHERE id = $2',
          [perBounty, b.id]
        );
      }

      if (io) {
        io.emit('card:bounty_paid', {
          target: targetTeamId,
          collectors: bounties.map(b => ({ teamId: b.team_id, amount: perBounty })),
          totalBounty: TOTAL_BOUNTY,
        });
      }

      console.log(`[CARD] Bounty: ${bounties.length} collectors split ${TOTAL_BOUNTY} (target ${targetTeamId} was wrong)`);
    } else if (bounties.length > 0 && isCorrect) {
      // Target was correct — bounties fail
      for (const b of bounties) {
        await client.query(
          'UPDATE power_cards SET resolved = TRUE, coins_effect = 0 WHERE id = $1',
          [b.id]
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[CARD ENGINE] Resolution error:', err.message);
    // Don't throw — card failure should never crash the quiz
  } finally {
    client.release();
  }
}

/**
 * Play a power card — validate ownership, mark as used, set target.
 */
async function playCard(teamId, cardType, targetTeamId) {
  // Verify card exists and is owned, unused
  const cardResult = await db.query(
    `SELECT * FROM power_cards WHERE team_id = $1 AND card_type = $2 AND used = FALSE`,
    [teamId, cardType]
  );
  if (cardResult.rows.length === 0) {
    return { error: 'CARD_NOT_FOUND', message: 'You do not have this card or it has been used' };
  }

  // Verify target exists and is active
  if (targetTeamId) {
    const targetResult = await db.query(
      `SELECT id, status FROM teams WHERE id = $1`,
      [targetTeamId]
    );
    if (targetResult.rows.length === 0 || targetResult.rows[0].status !== 'active') {
      return { error: 'INVALID_TARGET', message: 'Target team not found or not active' };
    }
    if (targetTeamId === teamId) {
      return { error: 'SELF_TARGET', message: 'You cannot target yourself' };
    }
  }

  // Check if round 3 is active
  const stateResult = await db.query('SELECT current_round, round_status FROM game_state WHERE id = 1');
  const state = stateResult.rows[0];
  if (state.current_round !== 3 || state.round_status !== 'active') {
    return { error: 'INVALID_ROUND', message: 'Power cards can only be used during Round 3' };
  }

  // Shield is passive — just acknowledge it
  if (cardType === 'shield') {
    return { success: true, message: 'Shield is active and will auto-block the next STEAL' };
  }

  // Mark card as used with target
  await db.query(
    `UPDATE power_cards SET used = TRUE, used_at = NOW(), target_team_id = $1
     WHERE team_id = $2 AND card_type = $3 AND used = FALSE`,
    [targetTeamId, teamId, cardType]
  );

  return { success: true, cardType, targetTeamId };
}

module.exports = {
  resolveCardsForAnswer,
  playCard,
};
