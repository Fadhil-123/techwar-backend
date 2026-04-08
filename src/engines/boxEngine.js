const db = require('../db/pool');

/**
 * Shuffle an array (Fisher-Yates).
 */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Seed/randomize the 15 mystery boxes at round start.
 * 4 reward, 4 bomb, 7 challenge
 */
async function seedBoxes() {
  const types = [
    ...Array(4).fill('reward'),
    ...Array(4).fill('bomb'),
    ...Array(7).fill('challenge'),
  ];
  const shuffled = shuffle(types);

  // Get challenge questions from DB (R4 theme)
  const challengeQs = await db.query(
    `SELECT challenge_question, challenge_answer FROM mystery_boxes WHERE box_type = 'challenge' ORDER BY id`
  );

  let challengeIdx = 0;
  for (let i = 0; i < 15; i++) {
    const boxType = shuffled[i];
    let cq = null;
    let ca = null;
    if (boxType === 'challenge' && challengeQs.rows[challengeIdx]) {
      cq = challengeQs.rows[challengeIdx].challenge_question;
      ca = challengeQs.rows[challengeIdx].challenge_answer;
      challengeIdx++;
    }

    await db.query(
      `UPDATE mystery_boxes SET box_type = $1, challenge_question = $2, challenge_answer = $3,
       revealed = FALSE, winner_team_id = NULL, winning_bid = NULL, opened_at = NULL
       WHERE id = $4`,
      [boxType, cq, ca, i + 1]
    );
  }

  return shuffled.map((type, i) => ({ id: i + 1, type, revealed: false }));
}

/**
 * Get all boxes with their reveal status (hide type for unrevealed).
 */
async function getBoxesPublic() {
  const result = await db.query(
    `SELECT id, revealed, winner_team_id, winning_bid,
       CASE WHEN revealed THEN box_type ELSE 'hidden' END as box_type
     FROM mystery_boxes ORDER BY id`
  );
  return result.rows;
}

/**
 * Process a bid on a mystery box.
 */
async function processBid(teamId, boxId, bidAmount, io) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Get team
    const teamResult = await client.query('SELECT * FROM teams WHERE id = $1', [teamId]);
    if (teamResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { error: 'TEAM_NOT_FOUND', message: 'Team not found' };
    }
    const team = teamResult.rows[0];

    // Minimum bid check
    if (bidAmount < 100) {
      await client.query('ROLLBACK');
      return { error: 'BID_TOO_LOW', message: 'Minimum bid is 100 coins' };
    }

    // Sufficient balance check — HARD GUARD
    if (bidAmount > team.coins) {
      await client.query('ROLLBACK');
      return { error: 'INSUFFICIENT_COINS', message: 'You do not have enough coins for this bid' };
    }

    // Check box exists and not opened
    const boxResult = await client.query('SELECT * FROM mystery_boxes WHERE id = $1', [boxId]);
    if (boxResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { error: 'INVALID_BOX', message: 'Box not found' };
    }
    const box = boxResult.rows[0];

    if (box.revealed) {
      await client.query('ROLLBACK');
      return { error: 'BOX_ALREADY_OPENED', message: 'This box has already been opened' };
    }

    // Deduct bid first
    await client.query(
      'UPDATE teams SET coins = coins - $1 WHERE id = $2',
      [bidAmount, teamId]
    );

    let coinsEffect = 0;
    let resultType = box.box_type;

    if (box.box_type === 'reward') {
      coinsEffect = 500;
      await client.query('UPDATE teams SET coins = coins + 500 WHERE id = $1', [teamId]);
    } else if (box.box_type === 'bomb') {
      const currentResult = await client.query('SELECT coins FROM teams WHERE id = $1', [teamId]);
      const currentCoins = currentResult.rows[0].coins;
      coinsEffect = -Math.floor(currentCoins * 0.40);
      await client.query(
        'UPDATE teams SET coins = GREATEST(0, coins + $1) WHERE id = $2',
        [coinsEffect, teamId]
      );
    } else if (box.box_type === 'challenge') {
      // Don't resolve immediately — send challenge privately
      coinsEffect = 0; // will be resolved after challenge answer
    }

    // Mark box as revealed
    await client.query(
      `UPDATE mystery_boxes SET revealed = TRUE, winner_team_id = $1, winning_bid = $2, opened_at = NOW()
       WHERE id = $3`,
      [teamId, bidAmount, boxId]
    );

    // Get final coin total
    const finalResult = await client.query('SELECT coins FROM teams WHERE id = $1', [teamId]);
    const finalCoins = finalResult.rows[0].coins;

    await client.query('COMMIT');

    // Emit events
    if (io) {
      io.emit('box:revealed', {
        boxId,
        type: box.box_type,
        teamId,
        coinsEffect: box.box_type !== 'challenge' ? coinsEffect : null,
      });

      if (box.box_type === 'challenge') {
        io.to(`team:${teamId}`).emit('box:challenge', {
          boxId,
          question: box.challenge_question,
          timeLimit: 30,
        });
      }
    }

    return {
      success: true,
      boxType: box.box_type,
      coinsEffect: box.box_type !== 'challenge' ? coinsEffect : 'pending',
      finalCoins,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[BOX ENGINE] Error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Process a challenge box answer.
 * +500 if correct within 30s, +100 if wrong/timeout.
 */
async function processChallengeAnswer(teamId, boxId, answer) {
  const boxResult = await db.query(
    'SELECT * FROM mystery_boxes WHERE id = $1 AND winner_team_id = $2',
    [boxId, teamId]
  );
  if (boxResult.rows.length === 0) {
    return { error: 'NOT_YOUR_CHALLENGE', message: 'This challenge was not assigned to you' };
  }
  const box = boxResult.rows[0];

  if (!box.challenge_answer) {
    return { error: 'NO_CHALLENGE', message: 'This box does not have a challenge' };
  }

  const isCorrect = answer.trim().toLowerCase() === box.challenge_answer.trim().toLowerCase();
  const bonus = isCorrect ? 500 : 100;

  await db.query('UPDATE teams SET coins = coins + $1 WHERE id = $2', [bonus, teamId]);

  const updatedTeam = await db.query('SELECT coins FROM teams WHERE id = $1', [teamId]);

  return {
    success: true,
    correct: isCorrect,
    bonus,
    finalCoins: updatedTeam.rows[0].coins,
  };
}

module.exports = {
  seedBoxes,
  getBoxesPublic,
  processBid,
  processChallengeAnswer,
};
