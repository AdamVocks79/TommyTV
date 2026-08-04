# TommyTV Football Stats

TommyTV is a single-game football statistics system for a local production
network. Two statisticians can enter and verify plays from iPads while a third
iPad shows a read-only play-by-play dashboard. A Windows 11 computer stores the
game in SQLite and receives scoreboard data over MQTT.

This is a test-week build. Play entry, roster import, persistence, shared live
updates, and preliminary team/player totals are usable. vMix output is still a
clearly labeled simulation, and the statistics model is not yet a complete
NFHS statbook implementation.

## Requirements

- Node.js 22.13 or newer
- Devices on the same local network
- Optional MQTT broker and scoreboard publisher

## First local test

Install dependencies once:

```bash
npm install
```

Open two terminals in this folder. Start the game/database service in the
first:

```bash
npm run dev:game
```

Start the web interface in the second:

```bash
npm run dev
```

Open <http://localhost:3000/admin>, enter both teams, and import both rosters.
Then use these role-specific pages:

- <http://localhost:3000/entry-primary> — primary play entry
- <http://localhost:3000/entry-detail> — defensive detail
- <http://localhost:3000/pxp> — read-only PxP dashboard
- <http://localhost:3000/control> — graphics preview (simulation only)
- <http://localhost:3000/admin> — setup and connection status

For another device on the LAN, replace `localhost` with the computer's LAN IP.
The web development server prints the available network address at startup.

## Configuration

Copy `.env.example` to `.env.local` when values need to change. Defaults:

```dotenv
GAME_SERVER_PORT=3001
GAME_SERVER_HOST=127.0.0.1
GAME_DB_PATH=data/tommytv-game.sqlite
MQTT_URL=mqtt://192.168.18.129:1883
MQTT_TOPIC=tommytv/scoreboard
SCOREBOARD_STALE_MS=10000
```

Port 3001 binds to loopback by default. Browsers use the web app's
`/api/game/...` proxy, so the unprotected database API is not directly exposed
to the local network. Keep this default unless direct API access is explicitly
needed.

Game data is stored at `data/tommytv-game.sqlite`. Delete or move that file only
when intentionally starting a new test game.

## Scoreboard behavior

The server subscribes to `tommytv/scoreboard`. Clock, score, period, down,
distance, ball position, and possession are displayed as reference data. Play
classification, player, and yardage remain statistician-entered. The interface
marks MQTT data as stale if no new payload arrives within the configured
threshold.

## Validation

```bash
npm test
npm run lint
npm run build
```

## Windows 11 deployment

### Prerequisites

- Node.js 22.13 or newer (Node.js 24 is supported)
- Git for Windows

For a fresh installation, open Command Prompt and run:

```cmd
cd C:\
git clone https://github.com/AdamVocks79/TommyTV.git
cd TommyTV
npm install
copy .env.example .env.local
notepad .env.local
npm run build
```

The environment file sets the game service bind address and port
(`GAME_SERVER_HOST` and `GAME_SERVER_PORT`), SQLite file
(`GAME_DB_PATH`), MQTT broker (`MQTT_URL`), and MQTT topic (`MQTT_TOPIC`).
The supplied defaults keep the game API on `127.0.0.1:3001`; the frontend
reaches it through the same-origin `/api/game/...` proxy.

Start the frontend:

```cmd
cd C:\TommyTV
npm start
```

In a second Command Prompt, start the game service:

```cmd
cd C:\TommyTV
node --env-file-if-exists=.env.local server\game-server.mjs
```

The repository-relative `start-frontend.cmd` and `start-game-service.cmd`
launchers provide the same commands when the repository is installed in a
different folder.

- Frontend: <http://localhost:3000>
- Game service: <http://127.0.0.1:3001>

Other studio devices can use the Windows server's IPv4 address, for example
`http://192.168.18.129:3000`. Allow inbound TCP 3000 in Windows Firewall. TCP
3001 does not need to be exposed when clients use the frontend proxy; open it
only if direct game-service access is intentionally required.

To update later:

```cmd
cd C:\TommyTV
git pull origin main
npm install
npm run build
```

Restart both processes after the build completes.

## Known next-phase work

- Verify the real MQTT payload on the production Windows computer
- Exercise three simultaneous iPads on the venue network
- Add Windows automatic startup/process supervision
- Expand the play model for complete NFHS statistical edge cases
- Implement real vMix titles and output
- Add an explicit new-game/archive workflow

See `CODEX-CHECKPOINT.md` for design history and deployment context.
