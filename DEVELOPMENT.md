# WC2026 Predictor — Development Notes

> **See [`SPEC.md`](SPEC.md) for the authoritative, up-to-date build specification** —
> including the full feature set and the "swap kit" of tournament-specific data needed
> to recreate this app for a new tournament. This file is older background notes; a few
> "known issues" below (sequential R16 pairing, missing third-place logic) have since
> been implemented and are superseded by `SPEC.md`.

## What This Is

A shared pick'em app for a small friend group to predict World Cup 2026 results.
Every participant enters scores for all 72 group-stage games and the full knockout
bracket. Points are awarded per game; everyone's picks and a live leaderboard are
visible to all players. A secondary "Repicker" mode lets players re-pick the
Round of 32 once group stage results are known.

Built as a single Node/Express server on Railway with a Turso (libSQL) remote
database and a single-file client (`client.html`).

---

## Project Structure

```
wc2026-predictor/
├── server.js          # Express + WebSocket backend (all API routes, ESPN polling)
├── client.html        # Full single-page frontend (HTML + CSS + JS in one file)
├── public/            # Static assets (ball.png, tailwind.css after build)
├── src/
│   └── input.css      # Tailwind entry point (just the three @tailwind directives)
├── tailwind.config.js # Tailwind content config (scans client.html)
├── package.json
├── railway.toml       # Railway deploy config (healthcheck, start command, build)
├── .gitignore
└── DEVELOPMENT.md     # This file
```

---

## Architecture

### Server (`server.js`)

- **Express** serves `client.html` at `/` and static files from `/public`
- **WebSocket (ws)** maintains persistent connections; broadcasts full state to all
  clients whenever anything changes (picks saved, result set, etc.)
- **Turso** (libSQL over HTTP) is the persistent database; accessed via `@libsql/client`
- **ESPN poller** runs a `setTimeout` loop — every 30s during live games, 60s
  otherwise — fetching the FIFA World Cup scoreboard and auto-writing results to DB
- **`buildStatePayload()`** runs 8 parallel DB queries and assembles the full shared
  state object. It has a 150ms in-memory cache so rapid sequential calls (e.g. during
  a broadcast debounce window) hit the DB at most once.
- **Startup order**: HTTP server starts immediately (so Railway healthcheck can reach
  `/api/health`), DB init runs async, `/api/health` returns 503 until DB is ready.

### Client (`client.html`)

- Vanilla JS, no framework. All rendering is done by string-returning functions that
  set `innerHTML` on a single `#app` div.
- **State** lives in a single `S` object (group picks, KO picks, results, settings, etc.)
- **WebSocket** connection receives a full state broadcast from the server on connect
  and whenever anything changes. `_applyServerState()` merges server picks into local
  state (per-key merge, not all-or-nothing, so in-flight edits are preserved).
- **Auto-save** debounces 600ms after any pick change, then `PUT /api/predictions`
  with just the picks payload (avatar excluded). A red banner appears if this fails.
- **Tailwind** is used for utility classes. The CDN runtime was replaced with a
  pre-built static CSS file (`public/tailwind.css`) generated from `client.html`.

---

## Database Schema

### `users`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | |
| name | TEXT UNIQUE COLLATE NOCASE | Display name, case-insensitive unique |
| pin_hash | TEXT | bcrypt hash (cost 10) |
| avatar | TEXT | base64 data URL, resized to max 160×160 before storage |
| is_admin | INTEGER | 0 or 1 |
| created_at | TEXT | datetime('now') |

### `sessions`
| Column | Type | Notes |
|---|---|---|
| token | TEXT PK | 64-char hex (32 random bytes) |
| user_id | INTEGER FK → users | CASCADE DELETE |
| name | TEXT | Cached at login time |
| is_admin | INTEGER | Cached at login time |
| created_at | TEXT | |

> **Note**: `name` and `is_admin` are cached in sessions for fast auth middleware
> lookups. If you change a user's admin status in the DB, they must re-login for it
> to take effect. Old sessions for the same user are deleted on new login.

### `group_predictions`
| Column | Type | Notes |
|---|---|---|
| user_id | INTEGER FK | |
| game_id | INTEGER | 1–72 |
| home_score | INTEGER | |
| away_score | INTEGER | |

### `ko_predictions`
| Column | Type | Notes |
|---|---|---|
| user_id | INTEGER FK | |
| match_id | TEXT | e.g. `r32-1`, `r16-3`, `qf-2`, `sf-1`, `final`, `3rd` |
| home | TEXT | Team name at time of pick |
| away | TEXT | Team name at time of pick |
| home_score | INTEGER | nullable |
| away_score | INTEGER | nullable |
| pen_winner | TEXT | nullable — team name of pen shootout winner |

### `group_results` / `ko_results`
Same structure as predictions but per-game only (no user_id). `source` column is
`'espn'` for auto-scored or `'manual'` for admin overrides.

### `settings`
Key/value pairs. Currently used keys:
- `repicker_open` — computed, not stored; set by `buildStatePayload()`
- `repicker_admin_open` — admin manually opens Repicker mode
- `repicker_force_closed` — admin overrides auto-open

### `re_bracket` / `re_picks`
Repicker mode bracket assignments and user picks for the R32.

---

## Authentication

Flow:
1. User enters name + 4–8 digit PIN → `POST /api/auth`
2. If name exists → bcrypt verify PIN → create session → return token
3. If name is new → bcrypt hash PIN → insert user → create session → return token
4. Token stored in `localStorage` as `wc26_token`; sent as `Authorization: Bearer <token>`
5. Auth middleware (`requireAuth`) validates token against `sessions` table on every request

**First user** to register auto-gets admin. Subsequent users get admin only if the
`ADMIN_PIN` env var is set and they use that PIN. See environment variables below.

**Rate limiting**: 10 failed attempts per IP within a 15-minute window returns 429.

**Token security**: Tokens are 32 cryptographically random bytes (64-char hex via
`crypto.randomBytes`). Previously used `Math.random()` — if any tokens were issued
under the old scheme, they should be invalidated (delete the `sessions` table).

---

## Scoring System

Group stage (per game):
- **3 pts** — exact score (e.g. predicted 2-1, actual 2-1)
- **1 pt** — correct result (e.g. predicted 2-1, actual 3-1)
- **0 pts** — wrong result

Knockout stage: scored the same way per match. The leaderboard runs a cumulative
total across all completed games.

---

## ESPN Integration

`pollESPN()` fetches:
```
https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=YYYYMMDD-YYYYMMDD&limit=100
```
covering yesterday, today, and tomorrow. Only `status.type.state === 'post'` (finished)
games are written to the DB. Live games (`state === 'in'`) shorten the poll interval to 30s.

Team names from ESPN are mapped to app names via `ESPN_NAME_MAP` in `server.js`.
**Important**: app team names in `server.js`'s `GROUP_GAMES` must exactly match the
canonical names used in the client's `GROUP_GAMES`. If a fixture is ever corrected,
update both files.

The same poll also handles **knockout** games. Group events map by team pair
(`FIXTURE_LOOKUP`); any other finished event is matched to a bracket slot via
`matchKoSlot()` (venue token + date within ±1 day, using `KO_SCHEDULE`) and written to
`ko_results` with `source='espn'`, including the penalty-shootout winner (from the
competitor `winner` flag or `shootoutScore`). A result an admin entered manually
(`source='manual'`) is never overwritten by ESPN. Because ESPN's exact KO venue/team
strings can't be verified pre-tournament, this should be sanity-checked on the first
R32 games; the admin KO entry UI is the fallback/override.

---

## Fixture List Duplication

`GROUP_GAMES` is defined in both `server.js` and `client.html`. They must stay in sync:
- **Server** uses it for `FIXTURE_LOOKUP` (mapping ESPN scores to game IDs)
- **Client** uses it for rendering, standings, scoring

The team names and game IDs are the source of truth. The client version has additional
fields (`g` for group, `venue`) that the server doesn't need. If the FIFA schedule
changes, update both files and verify ESPN name mappings still work.

---

## Deployment (Railway + Turso)

### Required environment variables (Railway dashboard → Variables)

| Variable | Required | Description |
|---|---|---|
| `TURSO_URL` | Yes | `libsql://your-db.turso.io` |
| `TURSO_TOKEN` | Yes | Turso auth token |
| `ADMIN_PIN` | Recommended | PIN that grants admin to any new user who uses it |
| `PORT` | Auto | Set by Railway; defaults to 3000 |

> **Admin PIN**: During early development the default was `wc2026`. This has been
> removed from source code. Set `ADMIN_PIN` in Railway Variables to whatever PIN
> you want to use. If not set, only the first registered user gets admin (which is
> fine for a fresh deploy — the first person to register becomes admin automatically).

### Railway config (`railway.toml`)
- Builder: nixpacks
- Start: `node server.js`
- Build: `npm run build` (generates Tailwind CSS)
- Healthcheck: `GET /api/health` — returns 200 once DB is ready, 503 while initialising
- Healthcheck timeout: 60s (cold start + Turso init can take 10–20s)

### Turso notes
- Uses HTTP transport (`@libsql/client`) — no WebSocket/native SQLite driver
- **No PRAGMA support** in batch mode (removed after discovering this hard way)
- All batch statements must include `args: []` even if no parameters
- Local dev uses a file-based SQLite (`wc26.db`) when `TURSO_URL` is not set

---

## Tailwind CSS

The CDN runtime (`cdn.tailwindcss.com`) was replaced with a pre-built static file:

```bash
npm run build       # builds public/tailwind.css (run once or on HTML changes)
npm run build:watch # auto-rebuilds during development
```

`tailwind.config.js` scans `client.html` for class usage. The generated file is
committed to the repo so Railway doesn't need a separate CSS build cache.

---

## Key Design Decisions

**Single-file client**: Everything in `client.html` — easy to iterate, no build step
for the JS. The downside is a large file (~5 000 lines) that's harder to navigate.
Long-term the JS should be extracted to a separate file.

**Full re-render on state change**: `render()` replaces `#app` innerHTML entirely on
every state update. Simple and predictable, but loses scroll position and focus on
every pick. A targeted DOM update approach would improve UX but requires more structure.

**Name-keyed state**: `predictions` in the state payload is keyed by username. This
works fine for a small group but means a name change would orphan all picks. Consider
keying by user ID in a future version.

**Avatar in DB**: Avatars are stored as base64 data URLs in the `users` table (max
~30 KB after client-side resize to 160×160). This avoids an external file store.
Large avatars previously killed auto-save silently because every PUT request included
the full avatar; the save payload now sends only picks, and avatar is updated separately.

**Light/dark mode**: The app was built dark-first with colours baked into inline
`style=""` attributes. Light mode is applied via ~50 CSS `!important` attribute
substring selectors that pattern-match those inline colours. This works but is
fragile — any new hard-coded colour also needs an override. New code should use
CSS variables (`var(--bg)`, `var(--text)`, etc.) which are already defined in `:root`
and `body[data-theme="dark"]`.

---

## Known Issues / Future Work

- **Full DOM re-render**: Every pick change rebuilds the entire page. Targeted updates
  for score inputs would preserve scroll/focus (see Design Decisions above).
- **Bracket pairing**: `buildR16` uses sequential pairing of R32 winners. The official
  FIFA bracket has specific cross-bracket matchups that differ from this. Needs
  rewriting once the official bracket structure is confirmed.
- **No session expiry**: Sessions live indefinitely until logout. Adding `expires_at`
  with a 30-day TTL would be a small improvement.
- **Light mode inline style refactor**: All inline `style=""` dark colours should be
  migrated to CSS variables over time. New code must use variables only.
- **GROUP_GAMES duplication**: Fixtures are defined in both server and client. A future
  improvement would serve them from the server as part of the state payload.
- **Knockout results auto-fill from ESPN — needs live validation.** Implemented (see
  Knockout Results below), but the ESPN venue/team strings for KO games can't be
  verified until those matches exist. If auto-fill misses a game, the admin entry is
  the fallback. Worth a quick check once the first R32 games are played.
