#!/usr/bin/env node
// One-off admin utility: reset a user's PIN (PINs are bcrypt-hashed and cannot
// be recovered, only reset). Set a new temporary PIN, then share it privately.
//
// Usage:
//   node scripts/reset-pin.js --list                 # list user names
//   node scripts/reset-pin.js "User Name" 1234       # set their PIN to 1234
//
// Requires the same DB env the server uses:
//   TURSO_URL=libsql://your-db.turso.io TURSO_TOKEN=... node scripts/reset-pin.js ...
//   (or TURSO_URL=file:wc26.db for a local file DB)

const { createClient } = require('@libsql/client');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10; // must match server.js

async function main() {
  const url = process.env.TURSO_URL;
  if (!url) { console.error('Set TURSO_URL (and TURSO_TOKEN in prod) first.'); process.exit(1); }
  const db = createClient({ url, authToken: process.env.TURSO_TOKEN });

  const args = process.argv.slice(2);

  if (args[0] === '--list') {
    const r = await db.execute('SELECT name, is_admin, created_at FROM users ORDER BY name COLLATE NOCASE');
    for (const u of r.rows) console.log(`${u.is_admin ? '★ ' : '  '}${u.name}`);
    console.log(`\n${r.rows.length} users`);
    return;
  }

  const [name, pin] = args;
  if (!name || !pin) {
    console.error('Usage: node scripts/reset-pin.js "User Name" <newPin>   (or --list)');
    process.exit(1);
  }
  if (!/^\d{4,8}$/.test(pin)) {
    console.error('PIN must be 4–8 digits (matches the app login rule).');
    process.exit(1);
  }

  const existing = await db.execute({
    sql: 'SELECT id, name FROM users WHERE name = ? COLLATE NOCASE',
    args: [name],
  });
  if (existing.rows.length === 0) {
    console.error(`No user named "${name}". Run --list to see exact names.`);
    process.exit(1);
  }

  const hash = await bcrypt.hash(pin, SALT_ROUNDS);
  await db.execute({
    sql: 'UPDATE users SET pin_hash = ? WHERE name = ? COLLATE NOCASE',
    args: [hash, name],
  });

  // Drop any cached sessions so the reset is clean; they'll log in fresh with the new PIN.
  await db.execute({
    sql: 'DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE name = ? COLLATE NOCASE)',
    args: [name],
  });

  console.log(`✅ Reset PIN for "${existing.rows[0].name}" to: ${pin}`);
  console.log('   Share it privately; they can log in with it immediately.');
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
