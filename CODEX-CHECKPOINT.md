# TommyTV Football Stats App — Codex Checkpoint

**Checkpoint date:** July 27, 2026  
**Repository:** `https://github.com/AdamVocks79/TommyTV`  
**Branch:** `main`  
**Current commit:** `40fb54f` — `Add TommyTV game application with SQLite and MQTT support`

## Purpose

TommyTV needs a fast, touch-friendly, one-game football statistics application for iPads. Two statisticians should be able to enter and correct plays while a separate landscape iPad gives the play-by-play crew a read-only statistics dashboard. A Windows 11 game server stores the game locally, receives scoreboard data by MQTT, and will eventually feed selected statistics and graphics to vMix.

This is intentionally a **single-game system**. Season statistics and backups are not required at this stage.

## Confirmed environment and decisions

- Football rules: IHSA/NFHS
- Production server: Windows 11 with Node.js
- Game server and MQTT broker: `192.168.18.129`
- MQTT port: `1883`
- MQTT authentication: none
- MQTT topic: `tommytv/scoreboard`
- vMix computer: `192.168.18.182`
- Devices are on the same fixed-IP local network
- iPads will use home-screen shortcuts to role-specific URLs
- Two statisticians should be supported
- One landscape, read-only PxP panel
- Rosters are pasted from spreadsheets
- Both home and away rosters are required
- No season-stat database
- One local SQLite game database
- No backup workflow required yet
- vMix title design and XML/output details will be planned later

## Scoreboard data policy

The scoreboard feed is useful, but it should not blindly control every statistical field.

Recommended authority:

- Game clock: MQTT
- Play clock: MQTT when available
- Score: MQTT as display/reference data
- Period/quarter: MQTT, with a future statistician override if needed
- Down, distance, ball position, and possession: available from MQTT as reference
- Field position/statistical interpretation: statistician-entered data should remain authoritative where scoreboard operation may lag or lack context

Example MQTT payload observed during planning:

```json
{
  "away_possession": false,
  "away_score": "",
  "away_timeouts": "",
  "ball_on": "",
  "changed_index": 0,
  "changed_length": 31,
  "clock": "30:19",
  "device": "/dev/ttyUSB0",
  "down": "",
  "home_possession": false,
  "home_score": "",
  "home_timeouts": "",
  "packets": 6116,
  "period": "",
  "play_clock": "",
  "to_go": "",
  "updated_at_utc": "2026-07-27T23:04:48Z"
}
```

The upstream scoreboard gateway reconstructs incremental Daktronics All Sport 5000 RTD packets and publishes a complete retained state snapshot. Football mode is expected to provide clock, scores, play clock, down, to-go, ball-on, quarter, timeouts, and possession.

## Current application routes

- `/entry-primary` — primary play-entry statistician
- `/entry-detail` — defensive-detail statistician
- `/pxp` — landscape read-only PxP dashboard
- `/control` — TommyTV/vMix control and preview
- `/admin` — game and roster setup
- `/` — main application route

The role shortcut route is implemented through:

```text
app/[...role]/page.tsx
```

## Work completed

### Interface and workflow

- Touch-friendly iPad layout
- Primary play-entry workflow
- Play type, player, yardage, and result/flag entry
- Clear and undo during entry
- Edit/correct recorded plays
- Delete recorded plays
- Secondary defensive-detail queue
- Tackler/defensive-detail confirmation
- Shared state across entry, detail, PxP, control, and setup screens
- Read-only landscape PxP dashboard
- Highlighting/visibility of notable player statistics
- TommyTV control preview
- Clearly labeled vMix simulation rather than claiming a live connection
- Team name and abbreviation setup
- Separate home and away roster paste, preview, validation, and import
- Importing one roster does not overwrite the other
- Direct role-specific iPad routes
- Responsive testing at 1024×768 and 1180×820
- Misleading placeholder labels were removed or changed

### Real data and persistence

The initial demonstration/placeholder data was removed. The application now starts with an intentionally empty game database.

Implemented:

- Local SQLite game database
- Persistent team setup
- Persistent home roster
- Persistent away roster
- Persistent play creation
- Persistent play correction
- Persistent play deletion
- Persistent defensive detail
- Shared live updates for multiple browser/iPad clients
- PxP statistics calculated from recorded plays
- TommyTV preview populated from recorded player data
- MQTT ingestion into the shared scoreboard state

### Same-origin API design

The game service runs separately on port `3001`, but iPads should access only the main web application address. A same-origin proxy was added:

```text
app/api/game/[...path]/route.ts
```

It forwards `/api/game/...` requests to:

```text
http://127.0.0.1:3001/api/...
```

This avoids making iPads call a second port directly and avoids browser cross-origin/cross-port problems.

The upstream service URL can be overridden with:

```text
GAME_SERVICE_URL
```

### Backend service

Primary backend file:

```text
server/game-server.mjs
```

Defaults:

```dotenv
GAME_SERVER_PORT=3001
GAME_SERVER_HOST=0.0.0.0
GAME_DB_PATH=data/tommytv-game.sqlite
MQTT_URL=mqtt://192.168.18.129:1883
MQTT_TOPIC=tommytv/scoreboard
```

These values are documented in `.env.example`. Local overrides can be placed in `.env.local`.

The service uses Node's `DatabaseSync` SQLite implementation and enables WAL mode and foreign keys.

Core database tables:

- `game`
  - home/away names
  - home/away abbreviations
- `roster`
  - team
  - number
  - name
  - position
  - sort order
- `play`
  - clock
  - situation
  - description
  - tag
  - status
  - play type
  - player number
  - yards
  - defensive/detail JSON
  - created/updated timestamps

### Backend capabilities and APIs

The logs show support for:

- Reading complete game state
- Updating game/team setup
- Replacing home or away roster independently
- Creating a play
- Correcting a play
- Deleting a play
- Confirming defensive detail
- Streaming/broadcasting state changes to connected clients
- Receiving and retaining current MQTT scoreboard state
- A test-only MQTT injection route used by automated tests

Known API patterns include:

```text
GET    /api/state
PUT    /api/game
PUT    /api/rosters/home
PUT    /api/rosters/away
POST   /api/plays
PUT    /api/plays/:id
DELETE /api/plays/:id
POST   /api/plays/:id/confirm
```

The browser application reaches these through the `/api/game/...` same-origin proxy.

## Important source files

```text
app/page.tsx                         Main application and shared UI/state
app/globals.css                      Responsive/touch interface styling
app/layout.tsx                       Application layout/metadata
app/[...role]/page.tsx               Direct role shortcuts
app/api/game/[...path]/route.ts      Same-origin proxy to game service
server/game-server.mjs               SQLite, APIs, live updates, MQTT
tests/game-server.test.mjs           Backend end-to-end tests
tests/rendered-html.test.mjs         Route/render/source integration tests
.env.example                         Local service configuration template
package.json                         Scripts and dependencies
README.md                            Current repository documentation
```

There are also starter/framework files under `db/`, `drizzle/`, `worker/`, `examples/`, and `build/`. Do not assume those are the production SQLite game backend; the active local game backend is `server/game-server.mjs`.

## Development commands

Install dependencies:

```bash
npm install
```

Start the web interface:

```bash
npm run dev
```

Start the local game service:

```bash
npm run dev:game
```

The `dev:game` script is:

```text
node --env-file-if-exists=.env.local server/game-server.mjs
```

Run validation:

```bash
npm test
npm run lint
npm run build
```

Typical local addresses:

```text
Web interface: http://localhost:3000
Game service:  http://localhost:3001
```

## Validation already completed

The prior Codex session reported successful:

- Production builds
- Lint/code-quality checks
- Route rendering tests
- All five direct role routes
- Browser-based interaction tests
- iPad landscape layouts
- Play creation
- Play correction
- Play deletion
- Defensive confirmation
- Cross-panel updates
- Home roster parsing/import
- Away roster parsing/import
- Team setup propagation
- SQLite persistence
- Simulated MQTT ingestion
- End-to-end backend tests

The final automated test run reported four passing tests:

- Persists game, rosters, MQTT state, plays, and defensive detail
- Server-renders the TommyTV primary stat interface
- Supports direct role shortcut routes
- Keeps core interactive workflows in the product source

## Current status and unresolved work

### Must verify next

1. **Run on the Windows 11 server at `192.168.18.129`.**
2. **Verify the real MQTT broker connection.** The Mac development environment timed out connecting to the broker. Configuration appears correct, but live network ingestion has not been proven on the production Windows machine.
3. Confirm that the actual MQTT payload field formats map correctly to the interface, especially blank values, quarter/period, possession booleans, and ball position.
4. Confirm simultaneous use from both statistician iPads and the PxP iPad over the local network.
5. Decide how the web app and game service should launch automatically when Windows boots.
6. Establish the production URL or hostname used for iPad home-screen shortcuts.

### Later phases

- Real vMix API integration
- Definition of vMix titles and fields
- XML or other output format for graphics
- TommyTV graphic selection and push-to-vMix actions
- More complete IHSA/NFHS statistical rules and edge cases
- Game lifecycle controls, such as new game/reset/archive
- Manual overrides for scoreboard-derived fields
- Deployment documentation and Windows service/process management
- Review whether starter Cloudflare/Drizzle/example files should remain in the repository

## Guardrails for future Codex work

- Do not replace the current app or start over.
- Inspect the repository and this checkpoint before changing code.
- Keep the repository as the source of truth; do not import the full prior Codex transcript.
- Work on one narrowly defined milestone at a time.
- Preserve the separate web UI and local game-service architecture unless there is a clear reason to change it.
- Preserve same-origin browser access through `/api/game/...`.
- Do not reintroduce demonstration data.
- Keep both home and away roster workflows.
- Keep the database one-game/local unless requirements change.
- Do not claim MQTT or vMix is live until it has been tested against the actual device/service.
- Use focused tests while developing, then run the full suite once at the end.
- Do not commit `.env.local`, `data/`, SQLite files, `node_modules/`, `.openai/`, or generated output.
- Update this checkpoint after each meaningful milestone instead of carrying a long chat transcript forward.

## Recommended next milestone

Deploy and validate the committed application on the Windows game server:

1. Clone/pull `main` at commit `40fb54f`.
2. Install a compatible current Node.js version and run `npm install`.
3. Create `.env.local` from `.env.example`.
4. Start `npm run dev:game`.
5. Start the web interface.
6. Open `/admin` from another device.
7. Enter both teams and paste both rosters.
8. Confirm persistence after refresh/restart.
9. Verify live MQTT data from `tommytv/scoreboard`.
10. Open the three iPad roles simultaneously and verify shared updates.
11. Document the Windows auto-start approach.

## Copy/paste prompt for a fresh Codex chat

```text
Work in the existing repository https://github.com/AdamVocks79/TommyTV on branch main.

The current checkpoint is commit 40fb54f, "Add TommyTV game application with SQLite and MQTT support."

First read CODEX-CHECKPOINT.md and inspect the current repository. Do not import or recreate the prior Codex conversation, do not start over, and do not replace the existing architecture.

The app is a one-game IHSA football statistics system for iPads. It has:
- primary play entry
- secondary defensive detail
- landscape read-only PxP panel
- home and away spreadsheet roster import
- SQLite persistence
- shared multi-client updates
- a local Node game service on port 3001
- a same-origin `/api/game/...` proxy
- MQTT configured for mqtt://192.168.18.129:1883 on topic `tommytv/scoreboard`

The next milestone is to prepare and validate deployment on the Windows 11 game server at 192.168.18.129. Focus only on:
1. verifying the current startup/configuration requirements,
2. making the web interface and game service practical to run on Windows,
3. testing the real MQTT connection and payload mapping,
4. verifying simultaneous access from the statistician and PxP iPads,
5. documenting an automatic startup method.

Do not work on real vMix integration yet. Do not reintroduce placeholder data. Use focused tests, run the full test suite once at the end, summarize files changed and remaining issues, and update CODEX-CHECKPOINT.md before stopping.
```

## Git checkpoint

The current source was committed and pushed successfully:

```text
Commit: 40fb54f
Message: Add TommyTV game application with SQLite and MQTT support
Remote:  https://github.com/AdamVocks79/TommyTV.git
Branch:  main
Status:  clean and synchronized with origin/main
```
