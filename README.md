# Tournament Pick'em

A shared, real-time prediction game for a friend group. Everyone predicts the score
of every group-stage game and the full knockout bracket; points are scored per game;
results fill in automatically from a live sports API; and all clients stay in sync
over WebSockets. A secondary **Repicker** mode lets players re-pick the whole
knockout bracket from the *real* draw once the group stage is decided.

Built for the 2026 World Cup, but designed to be re-pointed at a different tournament
(Euros, AFCON, Copa América, …) by swapping a defined set of data — see
**[`SPEC.md`](SPEC.md)**.

## Features

- **Score predictions** for every group game and the entire knockout bracket; the
  user's bracket advances from their own picks (penalty-shootout winner on draws).
- **Autosave** — picks persist as you type (debounced), with save/restore that never
  drops an in-flight edit.
- **Live results** — a poller writes finished scores automatically and shows
  in-progress scores; disciplinary cards feed a fair-play tiebreaker.
- **Real tournament rules** — within-group head-to-head mini-league tiebreakers,
  best-third qualification via the official third-place allocation table, and live
  "who's locked / still possible" detection.
- **Leaderboard** with weighted scoring (correct / exact / goal-error / odds-weighted
  surprise) and per-group distribution charts that highlight *your* score.
- **Repicker** — a second game on its own leaderboard; games become pickable as soon
  as one side is settled, with the possible opponents shown for the rest.
- **Auto-pick helper** — suggests plausible scores one game at a time (main picks and
  Repicker).
- Chat with `@`-mentions, avatars, light/dark mode, and an admin panel.

## Tech stack

Node ≥20 · Express · `ws` (WebSocket) · libSQL/Turso (`@libsql/client`) · `bcrypt` ·
Tailwind (pre-built to a static stylesheet). The frontend is a single
`client.html` (HTML + CSS + vanilla JS); the backend is a single `server.js`.

```
client.html  ←── served by Express
     │
     ├── POST /api/auth          login / register (name + PIN)
     ├── GET  /api/state         full state snapshot (REST fallback)
     ├── PUT  /api/predictions   save group/KO picks (debounced)
     ├── PUT  /api/re-picks      save Repicker picks (debounced)
     └── WebSocket               real-time full-state push on any change

server.js
     ├── Express routes + static assets
     ├── WebSocket server (ws)
     ├── libSQL / Turso          users, predictions, results, settings, chat
     └── live-results poller     ~60s, ~30s when games are live
```

## Local development

```bash
npm install
npm run build        # build public/tailwind.css (once, or on HTML changes)
node server.js       # http://localhost:3000
```

With no `TURSO_URL` set, the server uses a local SQLite file for the database, so you
can run it without any cloud setup.

## Deploy (Railway + Turso)

1. Create a **Turso** database and grab its URL + auth token.
2. Push this repo to GitHub → [railway.app](https://railway.app) → **New Project →
   Deploy from GitHub**. Railway auto-detects Node and runs `npm run build` then
   `node server.js`.
3. Set the environment variables below.
4. Railway gives you a `*.railway.app` URL — share it with your group.

Healthcheck is `GET /api/health` (returns 200 once the DB is ready, 503 during init;
allow ~60s for cold start + Turso init).

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `TURSO_URL` | prod | `libsql://your-db.turso.io`. If unset, a local SQLite file is used. |
| `TURSO_TOKEN` | prod | Turso auth token. |
| `ADMIN_PIN` | recommended | PIN that grants admin to a new registrant. **No hard-coded default** — if unset, only the first registered user becomes admin. |
| `PORT` | auto | Set by the platform; defaults to 3000. |

## Admin

The **first user to register** automatically becomes admin. Any later user who
registers with the `ADMIN_PIN` also becomes admin. Admins can enter/edit/delete
results manually, configure the scoring weights and knockout-round curve, and control
the Repicker's open/closed state. (Live results auto-fill; admins mainly intervene to
sanity-check or override.)

## Documentation

- **[`SPEC.md`](SPEC.md)** — the authoritative build specification: full feature set,
  data model, scoring formulas, the tournament-specific "swap kit", and a checklist
  for recreating the app for a different tournament.
- `DEVELOPMENT.md` — older background notes (superseded by `SPEC.md` where they differ).
