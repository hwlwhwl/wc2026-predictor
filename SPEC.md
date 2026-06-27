# Tournament Pick'em — Build Specification

A complete, implementation-ready spec for the shared prediction app, written so it
can be **rebuilt for a new tournament** (a future World Cup, a Euros, a Copa
América, etc.) by swapping a well-defined set of tournament-specific data.

This document is authoritative. `DEVELOPMENT.md` and `README.md` predate several
features and contain stale "known issues" (e.g. sequential R16 pairing, missing
third-place logic) that have since been implemented — prefer this file.

---

## 0. Tournament rules — specify these first ⚠️

**Different tournaments are run by different governing bodies (FIFA, UEFA, CAF,
CONMEBOL, AFC, CONCACAF, OFC, …) and their rules are NOT interchangeable.** This
engine *encodes* a specific set of rules. If you re-point it at a new tournament
without confirming them, you will ship wrong standings, wrong qualifiers, and wrong
matchups — silently.

Before building or adapting, obtain **that tournament's official regulations** and pin
down each item below. Treat anything you can't confirm as a **blocking question for
the tournament owner**, not a default to be guessed.

| Rule to confirm | What varies between tournaments | Lives in |
|---|---|---|
| **Group ranking / tiebreakers** | The exact ordered criteria, and crucially whether head-to-head is a *mini-league among all tied teams* vs *pairwise*, and whether it sits **before or after** overall goal difference. (2026 FIFA: H2H before overall GD. Older FIFA: overall GD first. UEFA Euros: H2H-first with a different cascade.) | `_rankGroup`, `cmpThird` |
| **Who advances & how many** | Top-N per group; whether best third-/fourth-placed teams advance and how many; host/seeding quirks. | qualifier logic, `R32_FIXED` |
| **Best-placed allocation** | If "best thirds" (or similar) advance, the **official published table** mapping which qualifying groups feed which bracket slots. A fixed lookup — **never infer it**. | `THIRD_PLACE_TABLE` |
| **Bracket structure** | The exact cross-bracket pairings, round by round. | `R32_FIXED`, `RE_*_PAIRS` |
| **Disciplinary / fair play** | Whether it's a tiebreaker at all, and the point value per card type. | `computeFairPlay` |
| **Final tiebreaker** | The official last step (often *drawing of lots*). This app substitutes a ranking table for determinism — confirm that's acceptable and that a "locked" claim is understood as a modelling assumption in that rare edge case. | `cmpThird` / `fifaRankOf` |
| **Ranking table** | Which ranking is used for the deterministic tiebreaker and the bot — FIFA world ranking, UEFA coefficients, a confederation ranking, etc. | `FIFA_RANK` |
| **Knockout draws** | Whether KO draws go to a penalty shootout (and need a recorded winner) or replays/extra-time only. | KO scoring, `pen_winner` |

> **Naming note:** several constants/functions are named after FIFA (`FIFA_RANK`,
> `fifaRankOf`) for historical reasons. They are **generic** — fill them with whatever
> governing body's data applies. Rename if you like; nothing else depends on the name.

---

## 1. Concept

A shared multiplayer pick'em for a friend group. Every participant predicts the
**score** of every group-stage game and the **entire knockout bracket**. Points are
awarded per game; everyone's picks, a live leaderboard, and per-group distributions
are visible to all. Results fill in automatically from a live sports API. A
secondary **Repicker** mode lets players re-pick the whole knockout bracket from the
*real* draw once group results are known.

Design priorities, in order: zero-friction for players (name + PIN, autosave,
instant sync), correctness of **the specific tournament's** rules (the real
tiebreakers and best-placed allocation for that competition — see §0), and "it just
updates itself" (live results, live qualification/lock logic).

---

## 2. Architecture

```
client.html  ── single-file SPA (HTML+CSS+vanilla JS), served by Express
     │  WebSocket (full-state push on every change) + REST fallback
server.js    ── Express + ws + libSQL(Turso) + live-results poller
```

- **Server** (`server.js`): Express serves `client.html` at `/` and static assets
  from `/public`. A `ws` WebSocket server holds persistent connections and
  broadcasts the **entire shared state** to all clients whenever anything changes.
  `buildStatePayload()` runs ~8 parallel DB queries, assembles the state object, and
  caches it ~150 ms so a broadcast storm hits the DB once. HTTP starts immediately so
  the platform healthcheck (`GET /api/health`, 503 until DB ready) passes during
  async DB init.
- **Database**: libSQL via `@libsql/client` (Turso in prod; a local SQLite file when
  `TURSO_URL` is unset). HTTP transport — **no PRAGMA in batch mode**, and every
  batch statement must include `args: []`.
- **Client** (`client.html`): no framework. All UI is string-returning `render*()`
  functions assigned to `#app.innerHTML`. All state lives in one global `S` object.
  `_applyServerState()` merges server data **per-key** (never all-or-nothing) so
  in-flight local edits survive a broadcast. Full re-render on every change (simple;
  the trade-off is losing scroll/focus).
- **Live results poller**: a `setTimeout` loop (≈30 s when games are live, 60 s
  otherwise) fetches the sports API scoreboard for yesterday→tomorrow, writes
  finished games to the DB, and captures in-progress scores + disciplinary cards.
- **Version guard**: server hashes `client.html` → `CLIENT_VERSION`, injects it into
  the served HTML, and includes `serverVersion` in the payload; the client shows a
  "reload" banner on mismatch (so stale tabs after a deploy self-heal).

---

## 3. Data model (tables)

| Table | Key columns | Purpose |
|---|---|---|
| `users` | id, name (UNIQUE NOCASE), pin_hash (bcrypt), avatar (base64 ≤~30 KB), is_admin, created_at | Accounts |
| `sessions` | token (PK, 32 random bytes hex), user_id, name, is_admin, created_at | Auth tokens (name/is_admin cached) |
| `group_predictions` | user_id, game_id (1..N), home_score, away_score | Group picks |
| `ko_predictions` | user_id, match_id (`r32-1`,`r16-3`,`qf-2`,`sf-1`,`final`,`3rd`), home, away, home_score, away_score, pen_winner | Knockout picks |
| `group_results` | game_id, home_score, away_score, fp_home, fp_away, source(`espn`/`manual`) | Actual group results + fair-play points |
| `ko_results` | match_id, home, away, home_score, away_score, pen_winner, source | Actual KO results |
| `settings` | key, value | Admin/config flags (weights, KO curve, repicker open state) |
| `re_bracket` | match_id, home, away | (Optional) admin-set R32 matchups for the Repicker |
| `re_picks` | user_id, match_id, winner, home, away, home_score, away_score, pen_winner, pen_home, pen_away, updated_at | Repicker picks |
| `messages` | id, user_id, name, body, created_at | Chat |

The broadcast state payload (`predictions`, `rePicks`, `allRePicks`) is **keyed by
username** — fine for a small group, but a rename would orphan picks (a known
trade-off; key by user_id if rebuilding for scale).

---

## 4. Tournament-specific data — the "swap kit"

**This is the heart of recreating the app for a new tournament.** Everything below
is data, not logic. Replace these and the engine works unchanged. Locations are the
`const` names; line numbers drift, so grep by name.

### In `client.html`

| Constant | What it is | Notes for a new tourney |
|---|---|---|
| `GROUPS` | `{ A:[team,team,team,team], ... }` | The groups and their teams. Canonical team-name strings used everywhere. |
| `GROUP_GAMES` | `[{id, g, home, away, md, venue, date}]` | Every group fixture. `id` 1..N, `g`=group letter, `md`=matchday. **Names must exactly match `GROUPS`.** |
| `R32_FIXED` | `[{id:'r32-1', posA, posB, date}]` | The Round-of-32 bracket slots. `posA/posB` are like `'1A'`,`'2B'` (group winner/runner-up) or `'3rd-slot-1X'` (a best-third slot). Encodes the official bracket structure. |
| `RE_R32_PAIRS`,`RE_R16_PAIRS`,`RE_QF_PAIRS` | Arrays of `[a,b]` game numbers | Which earlier-round winners meet in each later-round slot (the official cross-bracket pairing, **not** sequential). Also used by `buildR16`/`buildAllRounds`. |
| `THIRD_PLACE_TABLE` | `{ "ABCDEFGH":"HGBCAFDE", ... }` (the 495 combos) | **FIFA's official third-place allocation table** (Annex C). Key = sorted set of the 8 qualifying-third groups; value = the group letter assigned to slots `[1A,1B,1D,1E,1G,1I,1K,1L]` in order. Parse from the tournament's published table / Wikipedia. |
| `FIFA_RANK` | `{ 'Spain':2, ... }` | World ranking per team; final deterministic tiebreaker + bot strength input. |
| `KICKOFFS` | `{ gameId or matchId : ISO datetime }` | Local kickoff times for every game (group + KO). |
| `KO_VENUES` | `{ 'r32-1':'City', ... }` | Host city per knockout match. |
| `VENUES` / `CITY_COORDS` | coords per group venue / per city | For the weather lookup. |
| `TEAM_DATA` | `{ team:{host, w,d,l,gf,ga, best} }` | Qualifying record + best-ever finish; powers the bot's "form" factor and team tooltips. |
| `TEAM_SHORT` | `{ 'Bosnia and Herz.':'Bosnia' }` | Display abbreviations for long names. |
| `H2H` | `{ 'A|B':{...record...} }` | Head-to-head history shown on game cards and used (lightly) by the bot. |
| `KO_ROUND_WEIGHTS` | `{gentle,moderate,steep}` curves | Per-round KO point multipliers (admin-selectable). Tournament-agnostic but tune if round count differs. |
| `LOCK_TIME` | datetime | When the main predictions lock (tournament kickoff). |
| `window.TEAM_DOSSIER` (`/public` `dossiers.js`) | per-team profile data | Optional richer team profiles. |

### In `server.js`

| Constant | What it is |
|---|---|
| `GROUP_GAMES` | **Duplicate** of the client list (server needs it for result mapping). Keep in exact sync. |
| `ESPN_NAME_MAP` | `{ 'ESPN Display Name':'App Name' }` — maps the sports API's team strings to canonical app names. |
| `FIXTURE_LOOKUP` | derived `home|away → game_id` for mapping group scores. |
| `KO_SCHEDULE` / `matchKoSlot()` | venue-token + date matching to assign API'd KO events to bracket slots. |
| Scoreboard URL | the sports API endpoint + `dates=YYYYMMDD-YYYYMMDD` range (e.g. `.../soccer/fifa.world/scoreboard`). |

### Rules that may change between tournaments

- **Tiebreaker order** (`cmpThird`, `_rankGroup`): see §6. FIFA changed the order for
  2026 (head-to-head before overall GD). Verify against the new tournament's regs.
- **Qualifiers**: 12 groups → top-2 + 8 best thirds → 32. A different format (e.g. 8
  groups → top-2 → 16) changes `R32_FIXED`, the third-place table, and the bracket
  builders. The scoring/UI engine is unaffected.
- **Fair-play values** (`computeFairPlay` in `server.js`): yellow/second-yellow/red
  point values.

---

## 5. Feature specification

### 5.1 Auth & users
- Name + 4–8 digit PIN. New name ⇒ register (bcrypt-hash PIN, insert); existing ⇒
  verify. Token = 32 random bytes hex, stored in `localStorage`, sent as
  `Authorization: Bearer`. Middleware validates against `sessions` each request.
- First registered user becomes admin; later users get admin only by registering with
  the `ADMIN_PIN` env value. Rate-limit failed logins (e.g. 10 / 15 min / IP → 429).
- **Multi-device**: login must NOT delete the user's other sessions (only prune very
  old ones), or chat/other tabs get "session expired".
- Avatars: client resizes to ≤160×160, stored as a base64 data URL. The pick autosave
  payload must **exclude** the avatar (large avatars previously killed saves).

### 5.2 Group-stage predictions
- A score entry (home/away) per group game, grouped by matchday tabs. Autosaves
  (debounced ~600 ms) via `PUT /api/predictions`; red banner on failure.
- Locks at `LOCK_TIME`.

### 5.3 Knockout bracket predictions
- Predict the score of every knockout game from R32 → Final (+ third-place game). The
  user's bracket **advances from their own scores** (winner of each pick flows
  forward). Draws require a penalty-shootout winner.
- Later-round teams are filled from the user's advancers; a slot resets if its
  upstream advancer changes.

### 5.4 Scoring
**Group, per game:** exact score = **3**, correct result (W/D/L) = **1**, wrong = **0**.

**Points-are-bad (PAB):** total goal error `|pH−aH| + |pA−aA|`. A **skipped** game
(played, but no pick) counts as **+3 PAB** and contributes no correct/exact.

**Weighted group score:** `A×correct + B×exact − C×PAB`, where A/B/C are
admin-configured weights stored server-side (so changes propagate to all clients; the
version banner handles stale tabs).

**Knockout, per match:** matchup credit `+0.5` per correct team in the slot (0/0.5/1);
result credit needs both teams right — exact score `+3` (a draw also needs the right
pen-winner) else correct advancer `+1`; the whole match is multiplied by that round's
weight from the selected **KO curve** (`gentle`/`moderate`/`steep`).

**Leaderboard Total** = weighted group score + weighted KO score.

**Surprise column:** an odds-weighted score where each game's value derives from the
crowd's predicted odds (rarer correct calls are worth more), capped at ×5, extended
through the KO rounds.

### 5.5 Standings & qualification logic
- **Within-group ranking** (`_rankGroup`): points, then a **mini-league among the
  teams tied on points** (H2H points, H2H goal difference, H2H goals scored — across
  *all* tied teams, not pairwise), then overall GD, overall GF, fair play, then FIFA
  ranking. (2026 order — verify per tournament.)
- **Best-8 thirds** (`ranked3rds`): the 12 third-placed teams ranked by the same full
  chain (`cmpThird`: points → GD → GF → fair play → FIFA ranking); top 8 qualify.
- **Slot assignment** (`assign3rdToSlots`): a **direct lookup into the official 495-row
  `THIRD_PLACE_TABLE`** — given the set of 8 qualifying-third groups, it returns which
  group's third faces each winner slot. (Do **not** approximate this with a constraint
  solver; FIFA's table is a fixed mapping and a solver can pick a different valid
  layout.)
- **Qualification markers** (Picks tab): solid gold ring = group position locked;
  solid silver = guaranteed top-2; dashed green = "into the knockouts" (secured a
  best-third). Computed by brute-forcing remaining W/D/L outcomes.
- **Third-place lock detection** (`thirdSlotLocks`): for each group, find its third's
  best- and worst-possible finish over remaining results (ranked by the full chain;
  GD is bounded because running the score up too far stops a team being third); group
  X "dominates" Y when X's worst still beats Y's best; drop any of the 495 combos that
  place Y without X. A slot is **locked** iff every surviving combo assigns it the
  same group and that group's third is already decided. (Validated to reproduce FIFA's
  published "still-possible" set exactly.) Memoised on the results signature.

### 5.6 Leaderboard
- Tiles for the title-holders of each metric (avatar bounces when someone newly takes
  a title). A table with Correct / Exact / PAB / Surprise / Total (+ KO once active),
  sortable. A "today's games" strip with live/finished scores, the pick split
  (home·draw·away counts), and the viewer's own pick.

### 5.7 Picks tab (per-group)
- Each group card: the live standings (with the qualification markers above) beside a
  compact **distribution per metric** — Correct, Exact, Points (goal error),
  Standings. Each metric is a small field histogram with the **viewer's own value
  printed on top of their bar** (metric name on the left, no axis). "Standings" shows
  a pending note until all group games are played.
- A **third-place table** below: live best-third ranking with a cut line after 8th and
  a fair-play column.

### 5.8 Repicker mode
- A second, separate game: re-predict the **entire knockout bracket from the real
  draw**, scored on its **own leaderboard** (KO points + matchups, weighted by round).
- **Open/lock gating** (`repicker_open` computed server-side): auto-opens when all
  group results are in; admin can **force-open** (only while no R32 result exists) or
  **force-close**. The transition force-open → auto-open is seamless.
- **Per-game pickability**: a game is pickable as soon as **at least one** side is a
  settled team; with neither settled it's locked. Unsettled sides show the **possible
  teams** (group winner/runner-up contenders, or the current third of each group that
  can still feed a third-place slot, or — for later rounds — the two participants of
  the feeding match). Locked third-place slots show the actual team.
- Each card shows the **same info as the main picks**: kickoff, venue + weather, FIFA
  rank badges, dossier button, and H2H / prior group-pick (when both teams known).
- **Autosave**: writes via `PUT /api/re-picks`, debounced. Restore is **authoritative
  with dirty-tracking** — `_reDirty` holds ids with unsaved edits; the server-state
  merge overwrites every slot **except** dirty ones (so a saved pick always reappears
  and live edits are never clobbered). A green "✓ Saved" flashes on success. A pick is
  only reset when a *known* team is replaced by a *different known* team; a placeholder
  merely resolving keeps the score.
- Only players with a **complete** bracket appear on the Repicker leaderboard.

### 5.9 Auto-pick helper ("the bot")
- Suggests a plausible score per game from a light model: team strength = FIFA rank
  (55%) + qualifier form (45%), blended 18% toward H2H, sampled via Poisson (so
  favourites usually score more but upsets happen). KO games are forced **decisive**.
- One game at a time with a popover anchored to the card (✓ confirm / 🎲 reroll / ↷
  skip / ✕ stop); auto-advances across tabs/rounds. **Mode-aware**: the same engine
  drives both the main picks (writes `gPreds`/`kPreds`) and the Repicker (writes
  `rePicks`, only offering fully-settled games, flowing the bracket forward).

### 5.10 Live results integration
- Poller fetches the scoreboard for yesterday→tomorrow. Only finished
  (`state==='post'`) games are written. Group events map by team-pair
  (`FIXTURE_LOOKUP`); KO events map to bracket slots by venue token + date
  (`matchKoSlot`). `source='manual'` admin entries are never overwritten.
- **Fair-play points** are parsed from card events in the same feed
  (`computeFairPlay`): yellow +1, second-yellow dismissal +2, straight red +4; stored
  as `fp_home`/`fp_away` and broadcast as `[hs, as, fpH, fpA]`.
- **Live scores**: in-progress games are captured and broadcast (so all clients see
  them without each hitting the API); guard against the feed's occasionally stuck
  clock.

### 5.11 Chat, admin, theming
- **Chat**: last ~50 messages, `@`-mention autocomplete, mention notifications to the
  mentioned user (reply / dismiss), per-user send cooldown. Unread tracking must not
  resurface already-read messages.
- **Admin**: enter/edit/delete results manually, configure scoring weights + KO curve,
  control the Repicker open state.
- **Theming**: dark-first; light mode currently applied via `!important` overrides of
  inline colours. **New code should use the CSS variables** (`var(--bg)`,
  `var(--text)`, …) defined in `:root`/`body[data-theme]`.

### 5.12 Configuration & admin options

Several behaviours are currently **hard-coded assumptions** that vary by group, host,
or tournament. They should be **admin settings** (stored in the `settings` table,
edited in the admin panel, broadcast in state) rather than baked into code — so the
same build serves different tournaments and group preferences without edits.

Implemented as settings today:

| Option | Default | Notes |
|---|---|---|
| Scoring weights (A correct / B exact / C PAB) | tuned | Server-synced; version banner covers stale tabs. |
| KO round-weight curve | `moderate` | `gentle` / `moderate` / `steep`. |
| Repicker open state | auto | Auto-open when all group results in; admin force-open / force-close. |

Recommended to make configurable (currently assumed):

| Option | Current hard-coded behaviour | Proposed setting |
|---|---|---|
| **Require a photo to register** | Avatar is mandatory at sign-up | `avatar_policy`: required / optional / off |
| **Repicker feature** | Always present (only its open-state toggles) | `repicker_enabled`: on / off (hide the tab + logic entirely) |
| **Auto-pick helper** | Always available | `bot_enabled`: on / off |
| **Surprise (odds-weighted) column** | Always shown | `show_surprise`: on / off |
| **PAB skip penalty** | Skipped game = +3 PAB | `pab_skip_penalty`: integer |
| **Predictions lock time** | `LOCK_TIME` constant | `lock_time`: admin-set datetime |
| **Live results auto-poll** | Always polling | `results_mode`: auto (API) / manual-only |
| **Hide others' picks until lock** | All picks always visible | `picks_visibility`: always / after-lock |
| **Open registrations** | Anyone can register | `signups_open`: on / off (lock the roster once set) |
| **Chat** | Always on | `chat_enabled`: on / off |
| **Tournament metadata** | UI strings assume "World Cup 2026" | `tournament_name`, `governing_body`, `season` — so headings/labels aren't hard-coded |
| **Format / advancement** | 12 groups → top-2 + 8 thirds → 32 | A `format` config (groups, advancers, whether best-placed teams qualify). Larger change — drives `R32_FIXED`, the third-place table, and the bracket builders. |
| **Theme default & user toggle** | Dark default, user can switch | `default_theme`, `allow_theme_toggle` |

When adding a setting: store it in `settings`, surface it in the admin panel, include
it in `buildStatePayload()`, read it on the client from `S.settings`, and **default to
today's behaviour** so existing deployments are unchanged.

---

## 6. Tiebreaker reference (governing-body specific — see §0, verify per tournament)

Ranking teams (within group and for best-thirds):
1. Points
2. **Head-to-head mini-league** among all teams still tied: H2H points → H2H GD → H2H goals scored
3. Overall goal difference
4. Overall goals scored
5. Fair-play points (fewer is better)
6. *Official:* drawing of lots → **we substitute the configured ranking table**
   (`FIFA_RANK` — fill with the tournament's ranking) as a deterministic stand-in,
   since the app can't draw lots. A "lock" that depends on this step is a
   modelling assumption, not a guarantee.

Shared comparator: `cmpThird(a,b)` = points → GD → goals → fair-play → FIFA rank.

---

## 7. Build & deploy

- **Stack**: Node ≥20, Express, `ws`, `@libsql/client`, `bcrypt`, `compression`;
  Tailwind (pre-built to `public/tailwind.css`, committed; the CDN runtime is **not**
  used in prod).
- **Scripts**: `npm start` (node server.js); `npm run build` (Tailwind → CSS).
- **Env vars**:

| Var | Required | Purpose |
|---|---|---|
| `TURSO_URL` | prod | `libsql://…turso.io` (unset ⇒ local SQLite file) |
| `TURSO_TOKEN` | prod | Turso auth token |
| `ADMIN_PIN` | recommended | PIN that grants admin to a new registrant (no hard-coded default) |
| `PORT` | auto | platform-provided |

- **Deploy** (Railway): nixpacks; start `node server.js`; build `npm run build`;
  healthcheck `GET /api/health` (200 once DB ready, 503 during init; ~60 s timeout for
  cold start + Turso init).

---

## 8. Recreate-for-a-new-tournament checklist

1. **Confirm the format**: number of groups, how many advance, knockout bracket shape.
   This drives `R32_FIXED` (or its equivalent), the round pairings, and whether a
   third-place table is needed at all.
2. **Fixtures & groups**: write `GROUPS` and `GROUP_GAMES` (client) with canonical
   team names; duplicate `GROUP_GAMES` into `server.js`; set `KICKOFFS` and dates.
3. **Bracket**: set `R32_FIXED` slot definitions and the `RE_*_PAIRS` cross-bracket
   pairings from the official bracket; set `KO_VENUES`, `KO_SCHEDULE`.
4. **Third-place table** (if applicable): transcribe the tournament's official
   allocation table into `THIRD_PLACE_TABLE` (sorted-group-set → slot mapping). Verify
   by checking the current standings resolve to the matchups the broadcasters show.
5. **Reference data**: `FIFA_RANK`, `TEAM_DATA`, `TEAM_SHORT`, `H2H`, `VENUES`/
   `CITY_COORDS`, optional `TEAM_DOSSIER`.
6. **Live results**: point the poller at the right sports-API scoreboard endpoint;
   build `ESPN_NAME_MAP` for that feed's team strings; confirm `matchKoSlot` venue
   tokens. Sanity-check on the first finished games and the first R32 game.
7. **Rules**: verify the **tiebreaker order** and **fair-play values** against the new
   tournament's regulations; adjust `cmpThird`/`_rankGroup`/`computeFairPlay`.
8. **Scoring tuning**: set default weights (A/B/C) and KO curve; both are
   admin-editable at runtime.
9. **Lock/dates**: set `LOCK_TIME` to tournament kickoff.
10. **Deploy**: new Turso DB, env vars, `npm run build`, ship. First registrant is
    admin.

---

## 9. Constraints & gotchas

- `GROUP_GAMES` is duplicated (client + server) and **must stay in exact sync**
  (names and ids). Serving fixtures from the server would remove this footgun.
- Full DOM re-render on every change loses scroll/focus — acceptable, but score
  inputs re-mount on each keystroke (`render()` is called after a debounced save).
- libSQL batch: no PRAGMA; always pass `args: []`.
- The third-place **lock** logic substitutes FIFA ranking for the official "drawing of
  lots" final tiebreaker — extremely rarely decisive, but it means a declared lock is
  a modelling assumption in that edge case.
- Name-keyed state: renaming a user orphans their picks.
