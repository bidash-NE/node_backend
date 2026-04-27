require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./index');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);

  const conn = await pool.getConnection();
  try {
    for (const stmt of statements) {
      await conn.execute(stmt);
    }
    console.log('Migration complete');
  } finally {
    conn.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
