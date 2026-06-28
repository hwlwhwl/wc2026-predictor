'use strict';

const crypto     = require('crypto');
const express    = require('express');
const compression = require('compression');
const http       = require('http');
const { WebSocketServer } = require('ws');
const { createClient } = require('@libsql/client');
const bcrypt     = require('bcrypt');
const path       = require('path');
const fs         = require('fs');

// App version = short hash of the client.html this server is serving. Injected
// into the page (replacing __APP_VERSION__) and sent in every state payload, so
// a tab still running an older build can prompt the user to reload after a deploy.
let CLIENT_HTML = '', CLIENT_VERSION = '';
try {
  const raw = fs.readFileSync(path.join(__dirname, 'client.html'), 'utf8');
  CLIENT_VERSION = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
  CLIENT_HTML = raw.replace('__APP_VERSION__', CLIENT_VERSION);
} catch (e) { console.error('client.html load failed:', e.message); }

// ── Config ──────────────────────────────────────────────────────────────────
const PORT        = parseInt(process.env.PORT || '3000', 10);
const IS_PROD     = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
const TURSO_URL   = process.env.TURSO_URL   || (IS_PROD ? null : `file:${path.join(__dirname, 'wc26.db')}`);
const TURSO_TOKEN = process.env.TURSO_TOKEN || undefined;
// ADMIN_PIN: if set, any user who registers with this PIN gets admin.
// Default intentionally removed from source — set via Railway environment variable.
// The first user to register always gets admin regardless of PIN.
// See DEVELOPMENT.md → Environment Variables.
const ADMIN_PIN = process.env.ADMIN_PIN;

// Predictions lock — first kickoff. Must match LOCK_TIME in client.html.
// After this instant the server rejects any pick edits (avatar changes still allowed).
const LOCK_TIME = new Date('2026-06-11T19:00:00Z');
function predictionsLocked() { return Date.now() >= LOCK_TIME.getTime(); }

if (!TURSO_URL) {
  console.error('FATAL: TURSO_URL env var is not set. Set it in the Railway dashboard (Variables tab).');
  process.exit(1);
}
const SALT_ROUNDS = 10;

// ── Database ────────────────────────────────────────────────────────────────
const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

// Async helpers (mirror the node:sqlite synchronous API style)
async function dbGet(sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows[0] ?? null;
}

async function dbAll(sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows;
}

async function dbRun(sql, args = []) {
  const result = await db.execute({ sql, args });
  return result;
}

// Wrap an async Express route handler so errors propagate to next()
const asyncHandler = fn => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// ── Schema init ──────────────────────────────────────────────────────────────
async function initDB() {
  await db.batch([
    { sql: `CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      pin_hash   TEXT    NOT NULL,
      avatar     TEXT    NOT NULL DEFAULT '',
      is_admin   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    )`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS group_predictions (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id    INTEGER NOT NULL,
      home_score INTEGER NOT NULL,
      away_score INTEGER NOT NULL,
      updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, game_id)
    )`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS ko_predictions (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      match_id   TEXT    NOT NULL,
      home       TEXT,
      away       TEXT,
      home_score INTEGER,
      away_score INTEGER,
      pen_winner TEXT,
      pen_home   INTEGER,
      pen_away   INTEGER,
      updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, match_id)
    )`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS group_results (
      game_id    INTEGER PRIMARY KEY,
      home_score INTEGER NOT NULL,
      away_score INTEGER NOT NULL,
      source     TEXT    NOT NULL DEFAULT 'manual',
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    )`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS ko_results (
      match_id   TEXT    PRIMARY KEY,
      home       TEXT,
      away       TEXT,
      home_score INTEGER,
      away_score INTEGER,
      pen_winner TEXT,
      source     TEXT    NOT NULL DEFAULT 'manual',
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    )`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       TEXT    NOT NULL,
      is_admin   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    )`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS settings (
      key        TEXT    PRIMARY KEY,
      value      TEXT    NOT NULL DEFAULT ''
    )`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS re_bracket (
      match_id   TEXT    PRIMARY KEY,
      home       TEXT    NOT NULL DEFAULT '',
      away       TEXT    NOT NULL DEFAULT ''
    )`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS re_picks (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      match_id   TEXT    NOT NULL,
      winner     TEXT    NOT NULL DEFAULT '',
      home       TEXT,
      away       TEXT,
      home_score INTEGER,
      away_score INTEGER,
      pen_winner TEXT,
      pen_home   INTEGER,
      pen_away   INTEGER,
      updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, match_id)
    )`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       TEXT    NOT NULL,
      text       TEXT    NOT NULL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    )`, args: [] },
  ], 'write');

  // Migrations for existing databases (CREATE TABLE IF NOT EXISTS won't add
  // columns to a table that already exists). Run individually; ignore the
  // "duplicate column" error when the column is already present.
  const migrations = [
    'ALTER TABLE ko_predictions ADD COLUMN pen_home INTEGER',
    'ALTER TABLE ko_predictions ADD COLUMN pen_away INTEGER',
    'ALTER TABLE ko_results ADD COLUMN home TEXT',
    'ALTER TABLE ko_results ADD COLUMN away TEXT',
    'ALTER TABLE re_picks ADD COLUMN home TEXT',
    'ALTER TABLE re_picks ADD COLUMN away TEXT',
    'ALTER TABLE re_picks ADD COLUMN home_score INTEGER',
    'ALTER TABLE re_picks ADD COLUMN away_score INTEGER',
    'ALTER TABLE re_picks ADD COLUMN pen_winner TEXT',
    'ALTER TABLE re_picks ADD COLUMN pen_home INTEGER',
    'ALTER TABLE re_picks ADD COLUMN pen_away INTEGER',
    // Fair-play points per team (yellow 1, 2nd-yellow +2, straight red 4) from ESPN cards.
    'ALTER TABLE group_results ADD COLUMN fp_home INTEGER',
    'ALTER TABLE group_results ADD COLUMN fp_away INTEGER',
  ];
  for (const sql of migrations) {
    try { await db.execute(sql); }
    catch (e) { if (!/duplicate column/i.test(e.message || '')) throw e; }
  }

  console.log('DB schema initialised');
}

// ── Auth ─────────────────────────────────────────────────────────────────────

// Cryptographically secure token (replaces Math.random() which is not secure)
function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ── Rate limiting (in-memory; resets on server restart) ───────────────────────
// Limits failed auth attempts to 10 per IP per 15-minute window.
const _authAttempts = new Map(); // ip → { count, resetAt }
function _checkAuthRateLimit(ip) {
  const now = Date.now();
  const rec = _authAttempts.get(ip);
  if (!rec || now > rec.resetAt) {
    _authAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return true;
  }
  if (rec.count >= 10) return false;
  rec.count++;
  return true;
}
function _clearAuthRateLimit(ip) {
  _authAttempts.delete(ip);
}

async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  const session = await dbGet('SELECT * FROM sessions WHERE token = ?', [auth.slice(7)]);
  if (!session) return res.status(401).json({ error: 'Session expired — please log in again' });
  req.session = { userId: Number(session.user_id), name: session.name, isAdmin: !!session.is_admin };
  next();
}

// Standalone admin check — does not chain through requireAuth to avoid the
// "dead error branch" problem where requireAuth never calls next(err).
async function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  const session = await dbGet('SELECT * FROM sessions WHERE token = ?', [auth.slice(7)]);
  if (!session) return res.status(401).json({ error: 'Session expired — please log in again' });
  req.session = { userId: Number(session.user_id), name: session.name, isAdmin: !!session.is_admin };
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ── ESPN team name → app team name ──────────────────────────────────────────
const ESPN_NAME_MAP = {
  'United States':               'USA',
  'Türkiye':                     'Turkey',
  'Turkey':                      'Turkey',
  'Bosnia-Herzegovina':          'Bosnia and Herz.',
  'Bosnia & Herzegovina':        'Bosnia and Herz.',
  'Bosnia and Herzegovina':      'Bosnia and Herz.',
  "Côte d'Ivoire":               'Ivory Coast',
  "Cote d'Ivoire":               'Ivory Coast',
  "Côte D'Ivoire":               'Ivory Coast',
  'Ivory Coast':                 'Ivory Coast',
  'DR Congo':                    'DR Congo',
  'Congo DR':                    'DR Congo',
  'Democratic Republic of Congo':'DR Congo',
  'Curaçao':                     'Curaçao',
  'Curacao':                     'Curaçao',
  'Korea Republic':              'South Korea',
  'Republic of Korea':           'South Korea',
  'Cabo Verde':                  'Cape Verde',
  'Saudi Arabia':                'Saudi Arabia',
  'New Zealand':                 'New Zealand',
};
function mapTeamName(n) { return ESPN_NAME_MAP[n] || n; }

// ── Fixture list (mirrors client GROUP_GAMES — must stay in sync) ────────────
const GROUP_GAMES = [
  // MD1
  {id:1,  home:'Mexico',           away:'South Africa',    date:'2026-06-11'},
  {id:2,  home:'South Korea',      away:'Czechia',         date:'2026-06-12'},
  {id:3,  home:'Canada',           away:'Bosnia and Herz.',date:'2026-06-12'},
  {id:4,  home:'Qatar',            away:'Switzerland',     date:'2026-06-13'},
  {id:5,  home:'Brazil',           away:'Morocco',         date:'2026-06-13'},
  {id:6,  home:'Haiti',            away:'Scotland',        date:'2026-06-14'},
  {id:7,  home:'USA',              away:'Paraguay',        date:'2026-06-13'},
  {id:8,  home:'Australia',        away:'Turkey',          date:'2026-06-14'},
  {id:9,  home:'Germany',          away:'Curaçao',         date:'2026-06-14'},
  {id:10, home:'Ivory Coast',      away:'Ecuador',         date:'2026-06-15'},
  {id:11, home:'Netherlands',      away:'Japan',           date:'2026-06-14'},
  {id:12, home:'Sweden',           away:'Tunisia',         date:'2026-06-15'},
  {id:13, home:'Belgium',          away:'Egypt',           date:'2026-06-15'},
  {id:14, home:'Iran',             away:'New Zealand',     date:'2026-06-16'},
  {id:15, home:'Spain',            away:'Cape Verde',      date:'2026-06-15'},
  {id:16, home:'Saudi Arabia',     away:'Uruguay',         date:'2026-06-15'},
  {id:17, home:'France',           away:'Senegal',         date:'2026-06-16'},
  {id:18, home:'Iraq',             away:'Norway',          date:'2026-06-16'},
  {id:19, home:'Argentina',        away:'Algeria',         date:'2026-06-17'},
  {id:20, home:'Austria',          away:'Jordan',          date:'2026-06-17'},
  {id:21, home:'Portugal',         away:'DR Congo',        date:'2026-06-17'},
  {id:22, home:'Uzbekistan',       away:'Colombia',        date:'2026-06-18'},
  {id:23, home:'England',          away:'Croatia',         date:'2026-06-17'},
  {id:24, home:'Ghana',            away:'Panama',          date:'2026-06-18'},
  // MD2
  {id:25, home:'Mexico',           away:'South Korea',     date:'2026-06-19'},
  {id:26, home:'Czechia',          away:'South Africa',    date:'2026-06-18'},
  {id:27, home:'Canada',           away:'Qatar',           date:'2026-06-18'},
  {id:28, home:'Switzerland',      away:'Bosnia and Herz.',date:'2026-06-18'},
  {id:29, home:'Scotland',         away:'Morocco',         date:'2026-06-19'},
  {id:30, home:'Brazil',           away:'Haiti',           date:'2026-06-20'},
  {id:31, home:'USA',              away:'Australia',       date:'2026-06-19'},
  {id:32, home:'Turkey',           away:'Paraguay',        date:'2026-06-20'},
  {id:33, home:'Germany',          away:'Ivory Coast',     date:'2026-06-20'},
  {id:34, home:'Ecuador',          away:'Curaçao',         date:'2026-06-21'},
  {id:35, home:'Netherlands',      away:'Sweden',          date:'2026-06-20'},
  {id:36, home:'Tunisia',          away:'Japan',           date:'2026-06-21'},
  {id:37, home:'Belgium',          away:'Iran',            date:'2026-06-21'},
  {id:38, home:'New Zealand',      away:'Egypt',           date:'2026-06-22'},
  {id:39, home:'Spain',            away:'Saudi Arabia',    date:'2026-06-21'},
  {id:40, home:'Uruguay',          away:'Cape Verde',      date:'2026-06-21'},
  {id:41, home:'France',           away:'Iraq',            date:'2026-06-22'},
  {id:42, home:'Norway',           away:'Senegal',         date:'2026-06-23'},
  {id:43, home:'Argentina',        away:'Austria',         date:'2026-06-22'},
  {id:44, home:'Jordan',           away:'Algeria',         date:'2026-06-23'},
  {id:45, home:'Portugal',         away:'Uzbekistan',      date:'2026-06-23'},
  {id:46, home:'Colombia',         away:'DR Congo',        date:'2026-06-24'},
  {id:47, home:'England',          away:'Ghana',           date:'2026-06-23'},
  {id:48, home:'Panama',           away:'Croatia',         date:'2026-06-24'},
  // MD3
  {id:49, home:'South Africa',     away:'South Korea',     date:'2026-06-25'},
  {id:50, home:'Czechia',          away:'Mexico',          date:'2026-06-25'},
  {id:51, home:'Switzerland',      away:'Canada',          date:'2026-06-24'},
  {id:52, home:'Bosnia and Herz.', away:'Qatar',           date:'2026-06-24'},
  {id:53, home:'Morocco',          away:'Haiti',           date:'2026-06-24'},
  {id:54, home:'Scotland',         away:'Brazil',          date:'2026-06-24'},
  {id:55, home:'Turkey',           away:'USA',             date:'2026-06-26'},
  {id:56, home:'Paraguay',         away:'Australia',       date:'2026-06-26'},
  {id:57, home:'Curaçao',          away:'Ivory Coast',     date:'2026-06-25'},
  {id:58, home:'Ecuador',          away:'Germany',         date:'2026-06-25'},
  {id:59, home:'Tunisia',          away:'Netherlands',     date:'2026-06-26'},
  {id:60, home:'Japan',            away:'Sweden',          date:'2026-06-26'},
  {id:61, home:'New Zealand',      away:'Belgium',         date:'2026-06-27'},
  {id:62, home:'Egypt',            away:'Iran',            date:'2026-06-27'},
  {id:63, home:'Cape Verde',       away:'Saudi Arabia',    date:'2026-06-27'},
  {id:64, home:'Uruguay',          away:'Spain',           date:'2026-06-27'},
  {id:65, home:'Norway',           away:'France',          date:'2026-06-26'},
  {id:66, home:'Senegal',          away:'Iraq',            date:'2026-06-26'},
  {id:67, home:'Algeria',          away:'Austria',         date:'2026-06-28'},
  {id:68, home:'Jordan',           away:'Argentina',       date:'2026-06-28'},
  {id:69, home:'Colombia',         away:'Portugal',        date:'2026-06-28'},
  {id:70, home:'DR Congo',         away:'Uzbekistan',      date:'2026-06-28'},
  {id:71, home:'Panama',           away:'England',         date:'2026-06-27'},
  {id:72, home:'Croatia',          away:'Ghana',           date:'2026-06-27'},
];

// Build lookup: "HomeTeam|AwayTeam" → fixture id
const FIXTURE_LOOKUP = {};
for (const g of GROUP_GAMES) {
  FIXTURE_LOOKUP[`${g.home}|${g.away}`] = g.id;
}

// ── Knockout schedule (for mapping ESPN KO events → our bracket-slot ids) ──────
// ESPN doesn't expose our slot ids (r16-1, …), so we map each finished KO event
// to a slot by date + venue. `tokens` are lowercase substrings matched against
// ESPN's venue.fullName and venue.address.city (any one hit + a date within ±1
// day = a match). Dates mirror the client's KO schedule.
const KO_SCHEDULE = {
  'r32-1':  { date:'2026-06-28', tokens:['sofi','inglewood','los angeles'] },
  'r32-2':  { date:'2026-06-29', tokens:['nrg','houston'] },
  'r32-3':  { date:'2026-06-29', tokens:['bbva','monterrey','guadalupe'] },
  'r32-4':  { date:'2026-07-03', tokens:['at&t','arlington','dallas'] },
  'r32-5':  { date:'2026-07-02', tokens:['sofi','inglewood','los angeles'] },
  'r32-6':  { date:'2026-07-03', tokens:['hard rock','miami'] },
  'r32-7':  { date:'2026-06-30', tokens:['at&t','arlington','dallas'] },
  'r32-8':  { date:'2026-07-02', tokens:['bmo','toronto'] },
  'r32-9':  { date:'2026-06-30', tokens:['azteca','banorte','mexico city'] },
  'r32-10': { date:'2026-07-02', tokens:['bc place','vancouver'] },
  'r32-11': { date:'2026-07-01', tokens:['levi','santa clara','san francisco'] },
  'r32-12': { date:'2026-06-29', tokens:['gillette','foxborough','boston'] },
  'r32-13': { date:'2026-07-01', tokens:['lumen','seattle'] },
  'r32-14': { date:'2026-06-30', tokens:['metlife','rutherford'] },
  'r32-15': { date:'2026-07-03', tokens:['arrowhead','kansas city'] },
  'r32-16': { date:'2026-07-01', tokens:['mercedes','atlanta'] },
  'r16-1':  { date:'2026-07-04', tokens:['lincoln financial','philadelphia'] },
  'r16-2':  { date:'2026-07-04', tokens:['nrg','houston'] },
  'r16-3':  { date:'2026-07-05', tokens:['metlife','rutherford'] },
  'r16-4':  { date:'2026-07-05', tokens:['azteca','banorte','mexico city'] },
  'r16-5':  { date:'2026-07-06', tokens:['at&t','arlington','dallas'] },
  'r16-6':  { date:'2026-07-06', tokens:['lumen','seattle'] },
  'r16-7':  { date:'2026-07-07', tokens:['mercedes','atlanta'] },
  'r16-8':  { date:'2026-07-07', tokens:['bc place','vancouver'] },
  'qf-1':   { date:'2026-07-09', tokens:['gillette','foxborough','boston'] },
  'qf-2':   { date:'2026-07-11', tokens:['hard rock','miami'] },
  'qf-3':   { date:'2026-07-10', tokens:['sofi','inglewood','los angeles'] },
  'qf-4':   { date:'2026-07-11', tokens:['arrowhead','kansas city'] },
  'sf-1':   { date:'2026-07-14', tokens:['at&t','arlington','dallas'] },
  'sf-2':   { date:'2026-07-15', tokens:['mercedes','atlanta'] },
  '3rd':    { date:'2026-07-18', tokens:['hard rock','miami'] },
  'final':  { date:'2026-07-19', tokens:['metlife','rutherford'] },
};

function _daysApart(a, b) {
  return Math.abs((new Date(a+'T12:00:00Z') - new Date(b+'T12:00:00Z')) / 86400000);
}

// Map a finished ESPN KO event to our slot id by venue token + nearest date (≤1 day).
function matchKoSlot(venueName, venueCity, eventDate) {
  const hay = `${venueName || ''} ${venueCity || ''}`.toLowerCase();
  let best = null, bestDiff = Infinity;
  for (const [koId, sch] of Object.entries(KO_SCHEDULE)) {
    if (!sch.tokens.some(t => hay.includes(t))) continue;
    const diff = _daysApart(sch.date, eventDate);
    if (diff <= 1 && diff < bestDiff) { best = koId; bestDiff = diff; }
  }
  return best;
}

// ── Shared state builder ─────────────────────────────────────────────────────
// Simple in-memory cache — avoids redundant DB queries when multiple WS clients
// connect simultaneously or a broadcast fires within the debounce window.
let _stateCache     = null;
let _stateCacheTime = 0;
const STATE_CACHE_TTL_MS = 150; // just under the 200ms broadcast debounce

function invalidateStateCache() { _stateCache = null; }

async function buildStatePayload() {
  const now = Date.now();
  if (_stateCache && (now - _stateCacheTime) < STATE_CACHE_TTL_MS) {
    return _stateCache;
  }
  // Fetch all data in parallel
  const [gPredRows, koPredRows, gResRows, koResRows, allUsers, settingRows, reBracketRows, rePickRows, msgRows] =
    await Promise.all([
      dbAll(`SELECT u.name, u.avatar, gp.game_id, gp.home_score, gp.away_score
             FROM group_predictions gp JOIN users u ON u.id = gp.user_id`),
      dbAll(`SELECT u.name, kp.*
             FROM ko_predictions kp JOIN users u ON u.id = kp.user_id`),
      dbAll(`SELECT * FROM group_results`),
      dbAll(`SELECT * FROM ko_results`),
      dbAll(`SELECT id, name, avatar FROM users`),
      dbAll(`SELECT key, value FROM settings`),
      dbAll(`SELECT * FROM re_bracket`),
      dbAll(`SELECT u.name, rp.* FROM re_picks rp JOIN users u ON u.id = rp.user_id`),
      // Last 50 messages, oldest-first for display — avatar looked up client-side
      dbAll(`SELECT id, user_id, name, text, created_at FROM messages ORDER BY id DESC LIMIT 50`),
    ]);

  // predictions: { name: { avatar, gPreds: {gameId:[h,a]}, kPreds: {matchId:{...}} } }
  const predictions = {};
  for (const row of gPredRows) {
    if (!predictions[row.name]) predictions[row.name] = { avatar: row.avatar, gPreds: {}, kPreds: {} };
    predictions[row.name].gPreds[row.game_id] = [row.home_score, row.away_score];
  }
  for (const row of koPredRows) {
    if (!predictions[row.name]) predictions[row.name] = { avatar: '', gPreds: {}, kPreds: {} };
    predictions[row.name].kPreds[row.match_id] = {
      home: row.home, away: row.away,
      homeScore: row.home_score, awayScore: row.away_score,
      penWinner: row.pen_winner || '',
      penHome: row.pen_home != null ? row.pen_home : undefined,
      penAway: row.pen_away != null ? row.pen_away : undefined,
    };
  }

  // Ensure ALL users appear (even with no picks) so avatars are always broadcast
  for (const u of allUsers) {
    if (!predictions[u.name]) {
      predictions[u.name] = { avatar: u.avatar, gPreds: {}, kPreds: {} };
    } else if (!predictions[u.name].avatar && u.avatar) {
      predictions[u.name].avatar = u.avatar;
    }
  }

  // results
  const gResults = {};
  // [homeScore, awayScore, fpHome, fpAway] — fp fields present once cards are known.
  for (const row of gResRows) gResults[row.game_id] = [row.home_score, row.away_score, row.fp_home ?? 0, row.fp_away ?? 0];

  const kResults = {};
  for (const row of koResRows) {
    kResults[row.match_id] = {
      home: row.home || '', away: row.away || '',
      homeScore: row.home_score, awayScore: row.away_score, penWinner: row.pen_winner || '',
    };
  }

  // Settings
  const settings = {};
  for (const r of settingRows) settings[r.key] = r.value;

  // Auto-compute whether Repicker is open.
  // The Repicker no longer slams shut at the first R32 kickoff — it stays open
  // while the Round of 32 is being played so players can still fill the rest of
  // the bracket. Each game locks individually at its own kickoff (client-side),
  // and a game a player hasn't picked by then gets a random, always-wrong outcome
  // and −5. The WHOLE Repicker hard-locks once every R32 game has been played
  // (so nobody picks the later rounds after the R32 field is fully known).
  // An optional `repicker_close_date` is an extra admin backstop.
  const gResultCount = Object.keys(gResults).length;
  const r32Done      = Object.keys(kResults).filter(id => id.startsWith('r32-')).length >= 16;
  const closeDate    = settings.repicker_close_date || '';            // optional admin hard cutoff
  const today        = new Date().toISOString().slice(0, 10);
  const pastClose    = !!closeDate && today >= closeDate;
  const autoOpen     = gResultCount >= 72 && !r32Done && !pastClose;
  const adminOpen    = settings.repicker_admin_open === 'true' && !r32Done && !pastClose;
  const forceClosed  = settings.repicker_force_closed === 'true';
  settings.repicker_open = (!forceClosed && (autoOpen || adminOpen)) ? 'true' : 'false';
  settings.repicker_auto = autoOpen ? 'true' : 'false';

  // Re-bracket
  const reBracket = {};
  for (const r of reBracketRows) reBracket[r.match_id] = { home: r.home, away: r.away };

  // Re-picks
  const rePicks = {};
  for (const r of rePickRows) {
    if (!rePicks[r.name]) rePicks[r.name] = {};
    rePicks[r.name][r.match_id] = {
      home: r.home || '', away: r.away || '',
      homeScore: r.home_score, awayScore: r.away_score,
      penWinner: r.pen_winner || '',
      penHome: r.pen_home != null ? r.pen_home : undefined,
      penAway: r.pen_away != null ? r.pen_away : undefined,
      winner: r.winner || '',
    };
  }

  const messages = msgRows.slice().reverse(); // reverse DESC fetch → chronological order
  // liveScores: transient in-progress scores from the ESPN poll (not persisted).
  const payload = { predictions, results: { gResults, kResults }, settings, reBracket, rePicks, messages, liveScores: _liveScores, serverVersion: CLIENT_VERSION };
  _stateCache     = payload;
  _stateCacheTime = Date.now();
  return payload;
}

// ── WebSocket broadcast ──────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });
const wsClients = new Set();

wss.on('connection', async (ws) => {
  wsClients.add(ws);
  try {
    ws.send(JSON.stringify({ type: 'state', data: await buildStatePayload() }));
  } catch (err) {
    console.error('WS initial state error:', err.message);
  }
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === 1 /* OPEN */) ws.send(payload);
  }
}

async function broadcastState() {
  try {
    broadcast({ type: 'state', data: await buildStatePayload() });
  } catch (err) {
    console.error('broadcastState error:', err.message);
  }
}

// Debounce broadcasts — also invalidates state cache so the next buildStatePayload
// fetches fresh data rather than returning a stale cached result.
let _broadcastTimer = null;
function scheduleBroadcast() {
  invalidateStateCache();
  clearTimeout(_broadcastTimer);
  _broadcastTimer = setTimeout(broadcastState, 200);
}

// ── ESPN polling ─────────────────────────────────────────────────────────────
const TOURNAMENT_START = new Date('2026-06-11T00:00:00Z');
const TOURNAMENT_END   = new Date('2026-07-20T00:00:00Z');

let _espnLiveGamesDetected = false;
let _espnPollTimer = null;
// Transient in-progress scores, keyed by group fixture id (number) or KO slot id.
// { id: { hs, as, clock, detail } }. Rebuilt every poll, broadcast to clients.
let _liveScores = {};

// Fair-play points per team from a competition's card events: a yellow = 1, a
// second yellow to the same player = +2 (3 total), a straight red = 4. Returns
// { home, away } by ESPN's home/away orientation.
function computeFairPlay(comps) {
  const details = comps?.details || [];
  const competitors = comps?.competitors || [];
  const idHome = competitors.find(c => c.homeAway === 'home')?.team?.id;
  const idAway = competitors.find(c => c.homeAway === 'away')?.team?.id;
  const fp = { home: 0, away: 0 };
  const yel = {}, off = {};
  for (const d of details) {
    const isY = d.yellowCard === true, isR = d.redCard === true;
    if (!isY && !isR) continue;
    const tid = d.team?.id;
    const side = tid === idHome ? 'home' : tid === idAway ? 'away' : null;
    if (!side) continue;
    const ath = d.athletesInvolved?.[0]?.id || ('x' + (d.clock?.value ?? Math.random()));
    if (isY) {
      yel[ath] = (yel[ath] || 0) + 1;
      if (yel[ath] === 1) fp[side] += 1;
      else if (yel[ath] === 2) { fp[side] += 2; off[ath] = true; }
    } else {
      if (off[ath]) continue;                  // 2nd yellow already counted
      if ((yel[ath] || 0) >= 1) fp[side] += 2; // red following a yellow → 2nd-yellow dismissal
      else fp[side] += 4;                       // straight red
      off[ath] = true;
    }
  }
  return fp;
}

async function pollESPN() {
  const now = new Date();
  if (now < TOURNAMENT_START || now > TOURNAMENT_END) {
    _espnPollTimer = setTimeout(pollESPN, 24 * 60 * 60 * 1000);
    return;
  }

  const dates = [-1, 0, 1].map(delta => {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  });
  const dateRange = `${dates[0]}-${dates[2]}`;
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${dateRange}&limit=100`;

  let hasLive = false;
  let changed  = false;

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) throw new Error(`ESPN HTTP ${resp.status}`);
    const data = await resp.json();

    const nextLive = {};
    for (const event of (data.events || [])) {
      const status = event.status?.type?.state;
      const comps  = event.competitions?.[0];
      if (!comps) continue;

      const competitors = comps.competitors || [];
      const homeComp = competitors.find(c => c.homeAway === 'home');
      const awayComp = competitors.find(c => c.homeAway === 'away');
      if (!homeComp || !awayComp) continue;

      const homeName = mapTeamName(homeComp.team?.displayName || '');
      const awayName = mapTeamName(awayComp.team?.displayName || '');
      const homeScore = parseInt(homeComp.score ?? '-1', 10);
      const awayScore = parseInt(awayComp.score ?? '-1', 10);

      const fixtureId = FIXTURE_LOOKUP[`${homeName}|${awayName}`]
                     || FIXTURE_LOOKUP[`${awayName}|${homeName}`];
      const isFlipped = fixtureId ? !FIXTURE_LOOKUP[`${homeName}|${awayName}`] : false;

      // ── Live (in-progress) game: capture transient score for broadcast ──
      if (status === 'in') {
        hasLive = true;
        if (homeScore >= 0 && awayScore >= 0 && homeName && awayName) {
          const clock  = comps.status?.displayClock || event.status?.displayClock || '';
          const detail = event.status?.type?.shortDetail || event.status?.type?.description || 'LIVE';
          if (fixtureId) {
            nextLive[fixtureId] = { hs: isFlipped ? awayScore : homeScore, as: isFlipped ? homeScore : awayScore, clock, detail };
          } else {
            const liveKo = matchKoSlot(comps.venue?.fullName, comps.venue?.address?.city, (event.date || '').slice(0, 10));
            if (liveKo) nextLive[liveKo] = { hs: homeScore, as: awayScore, home: homeName, away: awayName, clock, detail };
          }
        }
        continue;
      }

      if (status !== 'post') continue;
      if (homeScore < 0 || awayScore < 0 || !homeName || !awayName) continue;

      if (fixtureId) {
        // ── Group-stage fixture ──
        const existing = await dbGet('SELECT home_score, away_score, fp_home, fp_away FROM group_results WHERE game_id = ?', [fixtureId]);
        const dbHome = isFlipped ? awayScore : homeScore;
        const dbAway = isFlipped ? homeScore : awayScore;
        const fpRaw  = computeFairPlay(comps);
        const fpHome = isFlipped ? fpRaw.away : fpRaw.home;
        const fpAway = isFlipped ? fpRaw.home : fpRaw.away;
        if (!existing || existing.home_score !== dbHome || existing.away_score !== dbAway) {
          await dbRun(
            `INSERT INTO group_results (game_id, home_score, away_score, fp_home, fp_away, source, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(game_id) DO UPDATE SET
               home_score = excluded.home_score,
               away_score = excluded.away_score,
               fp_home    = excluded.fp_home,
               fp_away    = excluded.fp_away,
               source     = excluded.source,
               updated_at = excluded.updated_at`,
            [fixtureId, dbHome, dbAway, fpHome, fpAway, 'espn']
          );
          console.log(`ESPN: Game ${fixtureId} (${homeName} v ${awayName}) → ${dbHome}–${dbAway}${(fpHome||fpAway)?` [FP ${fpHome}-${fpAway}]`:''}`);
          changed = true;
        } else if (existing && existing.fp_home == null && (fpHome || fpAway)) {
          // Backfill fair-play onto an already-recorded result without touching the score.
          await dbRun('UPDATE group_results SET fp_home = ?, fp_away = ? WHERE game_id = ?', [fpHome, fpAway, fixtureId]);
          changed = true;
        }
        continue;
      }

      // ── Knockout match? Map ESPN event → our bracket slot by venue + date ──
      const koId = matchKoSlot(comps.venue?.fullName, comps.venue?.address?.city, (event.date || '').slice(0, 10));
      if (!koId) continue;

      // Don't overwrite a result an admin entered manually.
      const exKo = await dbGet('SELECT home, away, home_score, away_score, pen_winner, source FROM ko_results WHERE match_id = ?', [koId]);
      if (exKo && exKo.source === 'manual') continue;

      // Penalty winner: KO draws (incl. after extra time) are decided on penalties.
      let penWinner = null;
      if (homeScore === awayScore) {
        if (homeComp.winner === true) penWinner = homeName;
        else if (awayComp.winner === true) penWinner = awayName;
        else {
          const hSO = parseInt(homeComp.shootoutScore ?? '-1', 10);
          const aSO = parseInt(awayComp.shootoutScore ?? '-1', 10);
          if (hSO >= 0 && aSO >= 0 && hSO !== aSO) penWinner = hSO > aSO ? homeName : awayName;
        }
        if (!penWinner) continue; // drawn but winner not yet resolvable — wait for next poll
      }

      const koChanged = !exKo || exKo.home !== homeName || exKo.away !== awayName ||
                        exKo.home_score !== homeScore || exKo.away_score !== awayScore ||
                        (exKo.pen_winner || null) !== penWinner;
      if (koChanged) {
        await dbRun(
          `INSERT INTO ko_results (match_id, home, away, home_score, away_score, pen_winner, source, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(match_id) DO UPDATE SET
             home       = excluded.home,
             away       = excluded.away,
             home_score = excluded.home_score,
             away_score = excluded.away_score,
             pen_winner = excluded.pen_winner,
             source     = excluded.source,
             updated_at = excluded.updated_at`,
          [koId, homeName, awayName, homeScore, awayScore, penWinner, 'espn']
        );
        console.log(`ESPN: KO ${koId} (${homeName} v ${awayName}) → ${homeScore}–${awayScore}${penWinner ? ` (pens: ${penWinner})` : ''}`);
        changed = true;
      }
    }
    // Replace the live snapshot. Broadcast only when a live SCORE (or the set of
    // live games) changes — not on every clock tick — so clients don't do a full
    // re-render every 30s just to advance the minute. The fresh clock still rides
    // along on the next broadcast triggered by a goal or any other change.
    const liveSig = o => Object.keys(o).sort().map(k => `${k}:${o[k].hs}-${o[k].as}`).join('|');
    const liveChanged = liveSig(_liveScores) !== liveSig(nextLive);
    _liveScores = nextLive;
    if (changed || liveChanged) { invalidateStateCache(); scheduleBroadcast(); }
  } catch (err) {
    console.warn('ESPN poll error:', err.message);
  }

  _espnLiveGamesDetected = hasLive;
  const interval = hasLive ? 30_000 : 60_000;
  _espnPollTimer = setTimeout(pollESPN, interval);
}

// ── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders: (res, filePath) => {
    // JS/CSS change with app updates — revalidate every load (cheap 304 via ETag)
    // so fixes aren't masked by a stale 7-day cache. Images rarely change → cache long.
    if (/\.(js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }
  },
}));

// Serve client.html at root. no-cache so a reload always revalidates and picks
// up a new deploy; serve the version-injected copy when available.
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  if (CLIENT_HTML) res.type('html').send(CLIENT_HTML);
  else res.sendFile(path.join(__dirname, 'client.html'));
});

// Health check — reports DB readiness so Railway healthcheck passes even during slow cold starts
let _dbReady = false;
app.get('/api/health', (req, res) => {
  if (!_dbReady) return res.status(503).json({ ok: false, reason: 'db_initializing' });
  res.json({ ok: true, clients: wsClients.size });
});

// ── Auth endpoints ───────────────────────────────────────────────────────────

// POST /api/auth — login or register
app.post('/api/auth', asyncHandler(async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';

  const { name, pin } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length < 1) {
    return res.status(400).json({ error: 'Name is required' });
  }
  if (!pin || typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) {
    return res.status(400).json({ error: 'PIN must be 4–8 digits' });
  }

  // Rate limit: 10 failed attempts per IP per 15 minutes
  if (!_checkAuthRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many attempts — please wait 15 minutes' });
  }

  const trimmedName = name.trim().slice(0, 40);

  const existing = await dbGet('SELECT * FROM users WHERE name = ? COLLATE NOCASE', [trimmedName]);
  if (existing) {
    // Login — verify PIN
    const ok = await bcrypt.compare(pin, existing.pin_hash);
    if (!ok) return res.status(401).json({ error: 'Wrong PIN' });
    // Clear rate limit on successful login
    _clearAuthRateLimit(ip);
    // Keep other devices/tabs logged in (multi-device) — only prune very old
    // sessions so the table doesn't grow unbounded. Logging in on a phone no
    // longer kicks the laptop (which caused "session expired" on chat/picks).
    await dbRun("DELETE FROM sessions WHERE user_id = ? AND created_at < datetime('now','-90 days')", [existing.id]);
    const token = genToken();
    await dbRun(
      'INSERT INTO sessions (token, user_id, name, is_admin) VALUES (?, ?, ?, ?)',
      [token, existing.id, existing.name, existing.is_admin]
    );
    return res.json({ token, name: existing.name, avatar: existing.avatar, isAdmin: !!existing.is_admin, isNew: false });
  } else {
    // Register
    const hash = await bcrypt.hash(pin, SALT_ROUNDS);
    let userId;
    try {
      const result = await dbRun(
        `INSERT INTO users (name, pin_hash, avatar) VALUES (?, ?, '')`,
        [trimmedName, hash]
      );
      userId = Number(result.lastInsertRowid);
    } catch (err) {
      if (err.message?.includes('UNIQUE')) {
        return res.status(409).json({ error: 'Name already taken — choose another or check your PIN' });
      }
      throw err;
    }
    // First ever user auto-gets admin, or if they know the ADMIN_PIN
    const countRow = await dbGet('SELECT COUNT(*) as n FROM users');
    const isAdmin  = (Number(countRow.n) === 1) || (ADMIN_PIN && pin === ADMIN_PIN);
    if (isAdmin) {
      await dbRun('UPDATE users SET is_admin = 1 WHERE id = ?', [userId]);
    }
    _clearAuthRateLimit(ip);
    const token = genToken();
    await dbRun(
      'INSERT INTO sessions (token, user_id, name, is_admin) VALUES (?, ?, ?, ?)',
      [token, userId, trimmedName, isAdmin ? 1 : 0]
    );
    const apRow = await dbGet("SELECT value FROM settings WHERE key = 'avatar_policy'");
    const avatarPolicy = apRow?.value || 'required';
    return res.status(201).json({ token, name: trimmedName, avatar: '', isAdmin, isNew: true, avatarPolicy });
  }
}));

// POST /api/auth/logout — invalidate token
app.post('/api/auth/logout', requireAuth, asyncHandler(async (req, res) => {
  const auth = req.headers.authorization;
  await dbRun('DELETE FROM sessions WHERE token = ?', [auth.slice(7)]);
  res.json({ ok: true });
}));

// DELETE /api/users/:name — admin removes a user and ALL their data.
// Child rows are deleted explicitly (FK cascade isn't guaranteed on Turso's
// HTTP transport, where PRAGMA foreign_keys can't be enabled).
app.delete('/api/users/:name', requireAdmin, asyncHandler(async (req, res) => {
  const name = (req.params.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const target = await dbGet('SELECT id FROM users WHERE name = ? COLLATE NOCASE', [name]);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const id = Number(target.id);
  if (id === req.session.userId) return res.status(400).json({ error: 'You cannot delete your own account' });

  await db.batch([
    { sql: 'DELETE FROM group_predictions WHERE user_id = ?', args: [id] },
    { sql: 'DELETE FROM ko_predictions    WHERE user_id = ?', args: [id] },
    { sql: 'DELETE FROM re_picks          WHERE user_id = ?', args: [id] },
    { sql: 'DELETE FROM sessions          WHERE user_id = ?', args: [id] },
    { sql: 'DELETE FROM messages          WHERE user_id = ?', args: [id] },
    { sql: 'DELETE FROM users             WHERE id = ?',      args: [id] },
  ], 'write');

  scheduleBroadcast();
  res.json({ ok: true });
}));

// ── State endpoint ───────────────────────────────────────────────────────────

// GET /api/state — return full shared state (no auth needed — read-only)
app.get('/api/state', asyncHandler(async (req, res) => {
  res.json(await buildStatePayload());
}));

// ── Prediction endpoints ─────────────────────────────────────────────────────

// PUT /api/predictions — save my group + KO predictions
app.put('/api/predictions', requireAuth, asyncHandler(async (req, res) => {
  const { userId } = req.session;

  // Hard lock once the tournament has started (backstop to the client-side lock)
  if (predictionsLocked()) {
    return res.status(403).json({ error: 'Predictions are locked — the tournament has begun.' });
  }

  const { gPreds = {}, kPreds = {} } = req.body;

  const statements = [];

  // Group predictions
  for (const [gameIdStr, scores] of Object.entries(gPreds)) {
    const gameId = parseInt(gameIdStr, 10);
    if (!Number.isInteger(gameId) || gameId < 1 || gameId > 72) continue;
    if (!Array.isArray(scores) || scores.length < 2) continue;
    const h = parseInt(scores[0], 10), a = parseInt(scores[1], 10);
    if (!Number.isFinite(h) || !Number.isFinite(a) || h < 0 || a < 0 || h > 30 || a > 30) continue;
    statements.push({
      sql: `INSERT INTO group_predictions (user_id, game_id, home_score, away_score, updated_at)
            VALUES (?, ?, ?, ?, datetime('now'))
            ON CONFLICT(user_id, game_id) DO UPDATE SET
              home_score = excluded.home_score,
              away_score = excluded.away_score,
              updated_at = excluded.updated_at`,
      args: [userId, gameId, h, a],
    });
  }

  // KO predictions
  for (const [matchId, pred] of Object.entries(kPreds)) {
    if (typeof matchId !== 'string' || !pred || typeof pred !== 'object') continue;
    const hs = pred.homeScore != null ? parseInt(pred.homeScore, 10) : null;
    const as_ = pred.awayScore != null ? parseInt(pred.awayScore, 10) : null;
    // Validate scores if provided (same range as group predictions)
    if (hs !== null && (!Number.isFinite(hs) || hs < 0 || hs > 30)) continue;
    if (as_ !== null && (!Number.isFinite(as_) || as_ < 0 || as_ > 30)) continue;
    // Penalty shootout scores (only present when regulation was a draw)
    let ph = pred.penHome != null ? parseInt(pred.penHome, 10) : null;
    let pa = pred.penAway != null ? parseInt(pred.penAway, 10) : null;
    if (ph !== null && (!Number.isFinite(ph) || ph < 0 || ph > 30)) ph = null;
    if (pa !== null && (!Number.isFinite(pa) || pa < 0 || pa > 30)) pa = null;
    statements.push({
      sql: `INSERT INTO ko_predictions (user_id, match_id, home, away, home_score, away_score, pen_winner, pen_home, pen_away, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(user_id, match_id) DO UPDATE SET
              home = excluded.home, away = excluded.away,
              home_score = excluded.home_score, away_score = excluded.away_score,
              pen_winner = excluded.pen_winner,
              pen_home = excluded.pen_home, pen_away = excluded.pen_away,
              updated_at = excluded.updated_at`,
      args: [userId, matchId, pred.home || null, pred.away || null, hs, as_, pred.penWinner || null, ph, pa],
    });
  }

  if (statements.length > 0) {
    await db.batch(statements, 'write');
  }

  scheduleBroadcast();
  res.json({ ok: true });
}));

// PUT /api/avatar — update profile photo. Deliberately NOT subject to the
// predictions lock, so players can still change their photo during the tournament.
app.put('/api/avatar', requireAuth, asyncHandler(async (req, res) => {
  const { userId } = req.session;
  const { avatar } = req.body;
  if (typeof avatar !== 'string') return res.status(400).json({ error: 'avatar required' });
  const safeAvatar = avatar.startsWith('data:image/') ? avatar : '';
  await dbRun('UPDATE users SET avatar = ? WHERE id = ?', [safeAvatar, userId]);
  scheduleBroadcast();
  res.json({ ok: true });
}));

// ── Admin / results endpoints ────────────────────────────────────────────────

// PUT /api/results/group/:gameId — manually set a group result (admin)
app.put('/api/results/group/:gameId', requireAdmin, asyncHandler(async (req, res) => {
  const gameId = parseInt(req.params.gameId, 10);
  if (gameId < 1 || gameId > 72) return res.status(400).json({ error: 'Invalid game ID' });
  const { homeScore, awayScore } = req.body;
  const h = parseInt(homeScore, 10), a = parseInt(awayScore, 10);
  if (!Number.isFinite(h) || !Number.isFinite(a)) return res.status(400).json({ error: 'Invalid scores' });
  await dbRun(
    `INSERT INTO group_results (game_id, home_score, away_score, source, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(game_id) DO UPDATE SET
       home_score = excluded.home_score,
       away_score = excluded.away_score,
       source     = excluded.source,
       updated_at = excluded.updated_at`,
    [gameId, h, a, 'manual']
  );
  scheduleBroadcast();
  res.json({ ok: true });
}));

// DELETE /api/results/group/:gameId — remove a group result (admin)
app.delete('/api/results/group/:gameId', requireAdmin, asyncHandler(async (req, res) => {
  const gameId = parseInt(req.params.gameId, 10);
  await dbRun('DELETE FROM group_results WHERE game_id = ?', [gameId]);
  scheduleBroadcast();
  res.json({ ok: true });
}));

// PUT /api/results/ko/:matchId — manually set a KO result (admin)
app.put('/api/results/ko/:matchId', requireAdmin, asyncHandler(async (req, res) => {
  const { matchId } = req.params;
  const { home, away, homeScore, awayScore, penWinner } = req.body;
  const h = homeScore != null ? parseInt(homeScore, 10) : null;
  const a = awayScore != null ? parseInt(awayScore, 10) : null;
  const homeTeam = typeof home === 'string' && home.trim() ? home.trim().slice(0, 40) : null;
  const awayTeam = typeof away === 'string' && away.trim() ? away.trim().slice(0, 40) : null;
  await dbRun(
    `INSERT INTO ko_results (match_id, home, away, home_score, away_score, pen_winner, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(match_id) DO UPDATE SET
       home       = excluded.home,
       away       = excluded.away,
       home_score = excluded.home_score,
       away_score = excluded.away_score,
       pen_winner = excluded.pen_winner,
       source     = excluded.source,
       updated_at = excluded.updated_at`,
    [matchId, homeTeam, awayTeam, h, a, penWinner || null, 'manual']
  );
  scheduleBroadcast();
  res.json({ ok: true });
}));

// DELETE /api/results/ko/:matchId — remove a KO result (admin)
app.delete('/api/results/ko/:matchId', requireAdmin, asyncHandler(async (req, res) => {
  const { matchId } = req.params;
  await dbRun('DELETE FROM ko_results WHERE match_id = ?', [matchId]);
  scheduleBroadcast();
  res.json({ ok: true });
}));

// GET /api/admin/espn-status — admin only: check ESPN poller status
app.get('/api/admin/espn-status', requireAdmin, asyncHandler(async (req, res) => {
  const gResults = await dbAll('SELECT * FROM group_results');
  res.json({
    liveGamesDetected: _espnLiveGamesDetected,
    resultCount: gResults.length,
    results: gResults,
  });
}));

// ── Settings endpoints ───────────────────────────────────────────────────────

// PUT /api/settings/:key — admin only
app.put('/api/settings/:key', requireAdmin, asyncHandler(async (req, res) => {
  const { key } = req.params;
  if (!/^[a-z_]+$/.test(key)) return res.status(400).json({ error: 'Invalid key' });
  const { value } = req.body;
  await dbRun(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
    [key, String(value ?? '')]
  );
  scheduleBroadcast();
  res.json({ ok: true });
}));

// ── Repicker endpoints ───────────────────────────────────────────────────────

// PUT /api/re-bracket — admin only, set a R32 matchup
app.put('/api/re-bracket', requireAdmin, asyncHandler(async (req, res) => {
  const { matchId, home, away } = req.body;
  if (typeof matchId !== 'string' || !matchId) return res.status(400).json({ error: 'matchId required' });
  await dbRun(
    'INSERT OR REPLACE INTO re_bracket (match_id, home, away) VALUES (?, ?, ?)',
    [matchId, String(home || ''), String(away || '')]
  );
  scheduleBroadcast();
  res.json({ ok: true });
}));

// Advancing team from a repicker score (decisive score, else pen winner).
function reAdvancer(home, away, hs, as_, penWinner) {
  if (hs == null || as_ == null) return '';
  if (hs > as_) return home || '';
  if (as_ > hs) return away || '';
  return penWinner || '';
}

// PUT /api/re-picks — save the user's Repicker score predictions.
// Body: { picks: { matchId: { home, away, homeScore, awayScore, penWinner, penHome, penAway } } }
// A null/empty pick (no teams) deletes that slot.
app.put('/api/re-picks', requireAuth, asyncHandler(async (req, res) => {
  const { userId } = req.session;
  const { picks } = req.body;
  if (!picks || typeof picks !== 'object') return res.status(400).json({ error: 'picks required' });

  const intOrNull = (v, max) => {
    if (v == null) return null;
    const n = parseInt(v, 10);
    return (Number.isFinite(n) && n >= 0 && n <= max) ? n : null;
  };

  const statements = [];
  for (const [matchId, pred] of Object.entries(picks)) {
    if (typeof matchId !== 'string' || !matchId) continue;
    if (!pred || typeof pred !== 'object' || (!pred.home && !pred.away)) {
      statements.push({ sql: 'DELETE FROM re_picks WHERE user_id = ? AND match_id = ?', args: [userId, matchId] });
      continue;
    }
    const home = typeof pred.home === 'string' ? pred.home.slice(0, 40) : null;
    const away = typeof pred.away === 'string' ? pred.away.slice(0, 40) : null;
    const hs = intOrNull(pred.homeScore, 30);
    const as_ = intOrNull(pred.awayScore, 30);
    const penWinner = (pred.penWinner && (pred.penWinner === home || pred.penWinner === away)) ? pred.penWinner : null;
    const ph = intOrNull(pred.penHome, 30);
    const pa = intOrNull(pred.penAway, 30);
    const winner = reAdvancer(home, away, hs, as_, penWinner);
    statements.push({
      sql: `INSERT OR REPLACE INTO re_picks
            (user_id, match_id, winner, home, away, home_score, away_score, pen_winner, pen_home, pen_away, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      args: [userId, matchId, winner, home, away, hs, as_, penWinner, ph, pa],
    });
  }

  if (statements.length > 0) {
    await db.batch(statements, 'write');
  }

  scheduleBroadcast();
  res.json({ ok: true });
}));

// ── Chat endpoints ───────────────────────────────────────────────────────────

// Simple per-user send rate limit (10 s cooldown)
const _msgCooldown = new Map(); // userId → timestamp

// POST /api/messages — send a chat message
app.post('/api/messages', requireAuth, asyncHandler(async (req, res) => {
  const { userId, name } = req.session;

  // Rate limit: one message per 10 seconds per user
  const last = _msgCooldown.get(userId) || 0;
  if (Date.now() - last < 10_000) {
    return res.status(429).json({ error: 'Please wait a moment before sending another message' });
  }

  const { text } = req.body;
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text required' });
  const trimmed = text.trim().slice(0, 280);
  if (!trimmed) return res.status(400).json({ error: 'Message cannot be empty' });

  _msgCooldown.set(userId, Date.now());
  await dbRun('INSERT INTO messages (user_id, name, text) VALUES (?, ?, ?)', [userId, name, trimmed]);
  scheduleBroadcast();
  res.json({ ok: true });
}));

// DELETE /api/messages/:id — delete a message (own or admin)
app.delete('/api/messages/:id', requireAuth, asyncHandler(async (req, res) => {
  const { userId, isAdmin } = req.session;
  const msgId = parseInt(req.params.id, 10);
  if (!Number.isInteger(msgId)) return res.status(400).json({ error: 'Invalid message ID' });

  const msg = await dbGet('SELECT user_id FROM messages WHERE id = ?', [msgId]);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (!isAdmin && Number(msg.user_id) !== userId) {
    return res.status(403).json({ error: 'You can only delete your own messages' });
  }

  await dbRun('DELETE FROM messages WHERE id = ?', [msgId]);
  scheduleBroadcast();
  res.json({ ok: true });
}));

// ── Global error handler ─────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled route error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── HTTP server + WebSocket upgrade ─────────────────────────────────────────
const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// ── Startup ──────────────────────────────────────────────────────────────────
// Start HTTP server immediately so Railway healthcheck can reach /api/health
// while DB init is still running (returns 503 until ready, then 200)
server.listen(PORT, () => {
  console.log(`WC2026 Predictor server listening on port ${PORT}`);
  console.log(`DB: ${TURSO_URL}`);
});

initDB()
  .then(() => {
    _dbReady = true;
    console.log('DB ready — accepting traffic');
    pollESPN();
  })
  .catch(err => {
    console.error('Failed to initialise DB:', err);
    process.exit(1);
  });

process.on('SIGTERM', () => {
  clearTimeout(_espnPollTimer);
  clearTimeout(_broadcastTimer);
  server.close();
});
