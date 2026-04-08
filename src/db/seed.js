// Seed script: Run schema.sql against Supabase
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function seed() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    console.log('Connecting to Supabase...');
    const client = await pool.connect();
    console.log('Connected!\n');

    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

    // Run entire schema as one transaction
    console.log('Running full schema...');
    await client.query(schema);
    console.log('✅ Schema executed successfully!\n');

    client.release();

    // Verify
    const teams = await pool.query('SELECT COUNT(*) as c FROM teams');
    console.log(`   Teams: ${teams.rows[0].c}`);
    const questions = await pool.query('SELECT COUNT(*) as c FROM questions');
    console.log(`   Questions: ${questions.rows[0].c}`);
    const boxes = await pool.query('SELECT COUNT(*) as c FROM mystery_boxes');
    console.log(`   Mystery Boxes: ${boxes.rows[0].c}`);
    const gs = await pool.query('SELECT current_round, round_status FROM game_state WHERE id = 1');
    console.log(`   Game State: Round ${gs.rows[0]?.current_round}, Status: ${gs.rows[0]?.round_status}`);
    console.log('\n🎯 Database ready for TECH WAR!');

  } catch (err) {
    console.error('❌ Seed failed:', err.message);
    if (err.detail) console.error('   Detail:', err.detail);
  } finally {
    await pool.end();
  }
}

seed();
