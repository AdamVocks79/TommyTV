import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import mqtt from "mqtt";

const PORT = Number(process.env.GAME_SERVER_PORT || 3001);
// The browser reaches this service through the Next.js same-origin proxy. Keep
// the database API private to this machine unless an operator explicitly opts
// into LAN access with GAME_SERVER_HOST.
const HOST = process.env.GAME_SERVER_HOST || "127.0.0.1";
const MQTT_URL = process.env.MQTT_URL || "mqtt://192.168.18.129:1883";
const MQTT_TOPIC = process.env.MQTT_TOPIC || "tommytv/scoreboard";
const SCOREBOARD_STALE_MS = Number(process.env.SCOREBOARD_STALE_MS || 10_000);
const DB_PATH = resolve(process.env.GAME_DB_PATH || "data/tommytv-game.sqlite");

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS game (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    home_name TEXT NOT NULL DEFAULT '',
    away_name TEXT NOT NULL DEFAULT '',
    home_code TEXT NOT NULL DEFAULT '',
    away_code TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS roster (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team TEXT NOT NULL CHECK (team IN ('home', 'away')),
    number TEXT NOT NULL,
    name TEXT NOT NULL,
    position TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS play (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clock TEXT NOT NULL DEFAULT '',
    situation TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL,
    tag TEXT,
    status TEXT NOT NULL DEFAULT 'logged',
    team TEXT NOT NULL DEFAULT 'home',
    play_type TEXT NOT NULL DEFAULT '',
    player_number TEXT NOT NULL DEFAULT '',
    yards INTEGER NOT NULL DEFAULT 0,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const playColumns = db.prepare("PRAGMA table_info(play)").all().map((column) => String(column.name));
if (!playColumns.includes("team")) {
  db.exec("ALTER TABLE play ADD COLUMN team TEXT NOT NULL DEFAULT 'home'");
}
if (!playColumns.includes("passer_number")) db.exec("ALTER TABLE play ADD COLUMN passer_number TEXT");
if (!playColumns.includes("receiver_number")) db.exec("ALTER TABLE play ADD COLUMN receiver_number TEXT");
if (!playColumns.includes("pass_result")) db.exec("ALTER TABLE play ADD COLUMN pass_result TEXT");
if (!playColumns.includes("down")) db.exec("ALTER TABLE play ADD COLUMN down INTEGER");
if (!playColumns.includes("distance")) db.exec("ALTER TABLE play ADD COLUMN distance INTEGER");
if (!playColumns.includes("ball_on")) db.exec("ALTER TABLE play ADD COLUMN ball_on TEXT");
if (!playColumns.includes("period")) db.exec("ALTER TABLE play ADD COLUMN period TEXT");

db.prepare(`
  INSERT OR IGNORE INTO game
  (id, home_name, away_name, home_code, away_code, updated_at)
  VALUES (1, '', '', '', '', ?)
`).run(new Date().toISOString());

let scoreboard = {
  connected: false,
  stale: true,
  received_at_utc: null,
  payload: {},
};
const eventClients = new Set();

function rowsToRoster(team) {
  return db.prepare(
    "SELECT id, number, name, position FROM roster WHERE team = ? ORDER BY sort_order, id"
  ).all(team).map((row) => [String(row.number), String(row.name), String(row.position)]);
}

function readState() {
  const game = db.prepare("SELECT * FROM game WHERE id = 1").get();
  const plays = db.prepare(
    "SELECT id, clock, situation, down, distance, ball_on, period, description, tag, status, team, play_type, player_number, passer_number, receiver_number, pass_result, yards, details_json, created_at, updated_at FROM play ORDER BY id"
  ).all().map((play) => ({
    id: Number(play.id),
    clock: String(play.clock),
    situation: String(play.situation),
    down: play.down == null ? undefined : Number(play.down),
    distance: play.distance == null ? undefined : Number(play.distance),
    ballOn: play.ball_on == null ? undefined : String(play.ball_on),
    period: play.period == null ? undefined : String(play.period),
    description: String(play.description),
    tag: play.tag == null ? undefined : String(play.tag),
    status: String(play.status),
    team: String(play.team),
    playType: String(play.play_type),
    playerNumber: String(play.player_number),
    passerNumber: play.passer_number == null ? undefined : String(play.passer_number),
    receiverNumber: play.receiver_number == null ? undefined : String(play.receiver_number),
    passResult: play.pass_result == null ? undefined : String(play.pass_result),
    yards: Number(play.yards),
    details: JSON.parse(String(play.details_json || "{}")),
    createdAt: String(play.created_at),
    updatedAt: String(play.updated_at),
  }));

  return {
    game: {
      homeName: String(game.home_name),
      awayName: String(game.away_name),
      homeCode: String(game.home_code),
      awayCode: String(game.away_code),
    },
    rosters: {
      home: rowsToRoster("home"),
      away: rowsToRoster("away"),
    },
    plays,
    scoreboard: currentScoreboard(),
  };
}

function currentScoreboard() {
  const receivedAt = scoreboard.received_at_utc
    ? Date.parse(scoreboard.received_at_utc)
    : 0;
  return {
    ...scoreboard,
    stale: !scoreboard.connected || !receivedAt || Date.now() - receivedAt > SCOREBOARD_STALE_MS,
  };
}

function broadcast() {
  const event = `event: state\ndata: ${JSON.stringify(readState())}\n\n`;
  for (const response of eventClients) response.write(event);
}

function json(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function exportFilename(state) {
  const date = new Date().toISOString().slice(0, 10);
  const clean = (value, fallback) => String(value || fallback).normalize("NFKD").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || fallback;
  return `${date}_${clean(state.game.homeName, "Home")}_vs_${clean(state.game.awayName, "Away")}.json`;
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Request body is too large");
  }
  return body ? JSON.parse(body) : {};
}

function replaceRoster(team, rows) {
  if (!["home", "away"].includes(team)) throw new Error("Unknown team");
  if (!Array.isArray(rows)) throw new Error("Roster rows must be an array");
  const cleanRows = rows.map((row, index) => {
    if (!Array.isArray(row) || !String(row[0] || "").trim() || !String(row[1] || "").trim()) {
      throw new Error(`Roster row ${index + 1} requires a number and name`);
    }
    return [
      String(row[0]).trim(),
      String(row[1]).trim(),
      String(row[2] || "").trim(),
      index,
    ];
  });

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM roster WHERE team = ?").run(team);
    const insert = db.prepare(
      "INSERT INTO roster (team, number, name, position, sort_order) VALUES (?, ?, ?, ?, ?)"
    );
    for (const row of cleanRows) insert.run(team, ...row);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function applyScoreboardPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  scoreboard = {
    connected: true,
    stale: false,
    received_at_utc: new Date().toISOString(),
    payload,
  };
  broadcast();
}

const PASS_RESULTS = new Set(["Complete", "Incomplete", "Sacked", "Interception"]);
const SPECIAL_RESULTS = {
  Punt: new Set(["Returned", "Fair catch", "Touchback", "Downed", "Out of bounds", "Blocked"]),
  Kickoff: new Set(["Returned", "Touchback", "Out of bounds", "Onside kicking team", "Onside receiving team"]),
  "Field goal": new Set(["Made", "Missed", "Blocked"]),
  Try: new Set(["Made", "Failed"]),
};

function cleanPlay(body) {
  if (!['home', 'away'].includes(body.team)) throw new Error("Choose the offensive team");
  const team = body.team;
  const playType = String(body.playType || "");
  const playerNumber = String(body.playerNumber || "").trim();
  const passerNumber = String(body.passerNumber || "").trim();
  const receiverNumber = String(body.receiverNumber || "").trim();
  const passResult = String(body.passResult || "").trim();
  let yards = Number(body.yards || 0);
  const incomingDetails = body.details && typeof body.details === "object" && !Array.isArray(body.details) ? body.details : {};
  const details = { ...incomingDetails };
  const optionalInteger = (value, label, minimum, maximum) => {
    if (value == null || value === "") return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || (maximum != null && parsed > maximum)) throw new Error(`${label} is invalid`);
    return parsed;
  };
  const down = optionalInteger(body.down, "Down", 1, 4);
  const distance = optionalInteger(body.distance, "Distance", 1);
  const ballOn = String(body.ballOn || "").trim() || null;
  const period = String(body.period || "").trim() || null;
  if (!Number.isFinite(yards) || !Number.isInteger(yards)) throw new Error("Yards must be a whole number");

  const rosterHas = (number) => Boolean(number) && Boolean(db.prepare(
    "SELECT 1 FROM roster WHERE team = ? AND number = ? LIMIT 1"
  ).get(team, number));
  const rosterName = (number) => String(db.prepare(
    "SELECT name FROM roster WHERE team = ? AND number = ? ORDER BY sort_order LIMIT 1"
  ).get(team, number)?.name || "");
  const defense = team === "home" ? "away" : "home";
  const defenseHas = (number) => Boolean(number) && Boolean(db.prepare(
    "SELECT 1 FROM roster WHERE team = ? AND number = ? LIMIT 1"
  ).get(defense, number));

  if (!["Run", "Pass", "Penalty", "Special"].includes(playType)) throw new Error("Choose Run, Pass, Penalty, or Special");

  if (playType === "Pass") {
    if (!PASS_RESULTS.has(passResult)) throw new Error("Choose Complete, Incomplete, Sacked, or Interception");
    if (!rosterHas(passerNumber)) throw new Error("Choose a passer from the offensive roster");
    if (passResult === "Complete" && !rosterHas(receiverNumber)) {
      throw new Error("A complete pass requires a receiver from the offensive roster");
    }
    if (passResult === "Sacked" && yards > 0) throw new Error("Sack yards must be zero or negative");
    if (passResult !== "Complete" && passResult !== "Sacked" && yards !== 0) throw new Error("Incomplete and intercepted passes must have zero yards");
    if (passResult !== "Complete" && passResult !== "Sacked") yards = 0;
  } else if (playType === "Run" && !rosterHas(playerNumber)) {
    throw new Error("Choose a ball carrier from the offensive roster");
  }

  if (playType === "Penalty") {
    const penalty = details.penalty || {};
    if (!['home', 'away'].includes(penalty.team)) throw new Error("Choose the penalized team");
    const penaltyTeam = penalty.team;
    const penaltyYards = Number(penalty.yards || 0);
    const accepted = penalty.accepted !== false;
    if (accepted && !String(penalty.name || "").trim()) throw new Error("Enter a penalty name");
    if (!Number.isInteger(penaltyYards) || penaltyYards < 0) throw new Error("Penalty yards must be a non-negative whole number");
    details.penalty = { team: penaltyTeam, name: String(penalty.name || "").trim(), accepted, yards: penaltyYards, automaticFirstDown: Boolean(penalty.automaticFirstDown), playCounts: Boolean(penalty.playCounts) };
    yards = 0;
  }

  if (playType === "Special") {
    const special = details.specialTeams || {};
    const subtype = String(special.subtype || "");
    const result = String(special.result || "");
    if (!SPECIAL_RESULTS[subtype]?.has(result)) throw new Error("Choose a valid special-teams subtype and result");
    const actor = String(special.actorNumber || "").trim();
    const returner = String(special.returnerNumber || "").trim();
    const distance = Number(special.distance || 0);
    const returnYards = Number(special.returnYards || 0);
    if (result === "Returned" && !defenseHas(returner)) throw new Error("Choose a returner from the receiving roster");
    if (![distance, returnYards].every(Number.isInteger) || distance < 0 || returnYards < 0) throw new Error("Special-teams yards must be non-negative whole numbers");
    if (subtype === "Try") {
      const tryType = String(special.tryType || "");
      if (!["PAT kick", "Two-point run", "Two-point pass"].includes(tryType)) throw new Error("Choose a valid try type");
      if (tryType === "PAT kick" && !rosterHas(actor)) throw new Error("Choose a kicker for the PAT");
      if (tryType === "Two-point run" && !rosterHas(actor)) throw new Error("Choose a runner for the two-point try");
      if (tryType === "Two-point pass" && (!rosterHas(String(special.passerNumber || "").trim()) || !rosterHas(String(special.receiverNumber || "").trim()))) throw new Error("Choose a passer and receiver for the two-point try");
    } else if (!rosterHas(actor)) {
      throw new Error(`Choose a ${subtype === "Punt" ? "punter" : "kicker"} from the offensive roster`);
    }
    if (subtype === "Field goal" && distance <= 0) throw new Error("Enter a valid field-goal distance");
    const tryType = subtype === "Try" ? String(special.tryType) : undefined;
    details.specialTeams = {
      subtype, result,
      actorNumber: subtype !== "Try" || tryType !== "Two-point pass" ? actor : "",
      returnerNumber: result === "Returned" ? returner : "",
      distance: subtype === "Punt" || subtype === "Field goal" ? distance : 0,
      returnYards: result === "Returned" ? returnYards : 0,
      returnTouchdown: result === "Returned" && Boolean(special.returnTouchdown),
      ...(tryType ? { tryType } : {}),
      ...(tryType === "Two-point pass" ? { passerNumber: String(special.passerNumber).trim(), receiverNumber: String(special.receiverNumber).trim() } : {}),
    };
    yards = 0;
  }

  const turnover = details.turnoverDetail || {};
  if (turnover.interceptorNumber && !defenseHas(String(turnover.interceptorNumber))) throw new Error("Interceptor must be on the defensive roster");
  if (turnover.recovererNumber && !defenseHas(String(turnover.recovererNumber))) throw new Error("Recoverer must be on the defensive roster");

  const description = playType === "Pass"
    ? passResult === "Complete"
      ? `#${passerNumber} ${rosterName(passerNumber)} complete to #${receiverNumber} ${rosterName(receiverNumber)} for ${yards} yards`
      : passResult === "Sacked"
        ? `#${passerNumber} ${rosterName(passerNumber)} sacked ${yards < 0 ? `for a loss of ${Math.abs(yards)} yards` : "for no gain"}`
        : `#${passerNumber} ${rosterName(passerNumber)} ${passResult === "Incomplete" ? "pass incomplete" : "intercepted"}`
    : playType === "Run"
      ? `#${playerNumber} ${rosterName(playerNumber)} rush for ${yards} yards${body.tag === "TOUCHDOWN" ? " · touchdown" : body.tag === "FUMBLE LOST" ? " · fumble lost" : ""}`
      : playType === "Penalty"
        ? `${details.penalty.accepted ? "Accepted" : "Declined"} ${details.penalty.name} penalty on ${details.penalty.team === "home" ? "home" : "away"}${details.penalty.accepted ? ` for ${details.penalty.yards} yards` : ""}${details.penalty.automaticFirstDown ? " · automatic first down" : ""}`
        : details.specialTeams.subtype === "Try"
          ? details.specialTeams.tryType === "PAT kick"
            ? `#${details.specialTeams.actorNumber} PAT ${details.specialTeams.result === "Made" ? "good" : "failed"}`
            : details.specialTeams.tryType === "Two-point run"
              ? `#${details.specialTeams.actorNumber} two-point run ${details.specialTeams.result === "Made" ? "successful" : "failed"}`
              : `#${details.specialTeams.passerNumber} pass to #${details.specialTeams.receiverNumber} for ${details.specialTeams.result === "Made" ? "successful" : "failed"} two-point conversion`
          : `${details.specialTeams.subtype}: #${details.specialTeams.actorNumber} ${rosterName(details.specialTeams.actorNumber)} · ${details.specialTeams.result.toLowerCase()}${details.specialTeams.distance ? ` · ${details.specialTeams.distance} yards` : ""}${details.specialTeams.returnerNumber ? ` · #${details.specialTeams.returnerNumber} return for ${details.specialTeams.returnYards} yards` : ""}`;
  return {
    team, playType, playerNumber,
    passerNumber: playType === "Pass" ? passerNumber : "",
    receiverNumber: playType === "Pass" && (passResult === "Complete" || passResult === "Incomplete") ? receiverNumber : "",
    passResult: playType === "Pass" ? passResult : "",
    yards, description, details, down, distance, ballOn, period,
  };
}

const api = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      json(response, 200, {
        ok: true,
        database: DB_PATH,
        mqtt: { url: MQTT_URL, topic: MQTT_TOPIC, ...currentScoreboard() },
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      json(response, 200, readState());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/export") {
      const state = readState();
      const snapshot = {
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        game: state.game,
        rosters: state.rosters,
        plays: state.plays.map((play) => ({
          ...play,
          down: play.down ?? null, distance: play.distance ?? null, ballOn: play.ballOn ?? null,
          period: play.period ?? null,
          passerNumber: play.passerNumber ?? null, receiverNumber: play.receiverNumber ?? null, passResult: play.passResult ?? null,
          details: play.details ?? {},
        })),
        scoreboard: state.scoreboard,
      };
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFilename(state)}"`,
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(snapshot, null, 2));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      response.write(`event: state\ndata: ${JSON.stringify(readState())}\n\n`);
      eventClients.add(response);
      request.on("close", () => eventClients.delete(response));
      return;
    }
    if (request.method === "PUT" && url.pathname === "/api/game") {
      const body = await readJson(request);
      db.prepare(`
        UPDATE game
        SET home_name = ?, away_name = ?, home_code = ?, away_code = ?, updated_at = ?
        WHERE id = 1
      `).run(
        String(body.homeName || "").trim(),
        String(body.awayName || "").trim(),
        String(body.homeCode || "").trim().toUpperCase().slice(0, 4),
        String(body.awayCode || "").trim().toUpperCase().slice(0, 4),
        new Date().toISOString(),
      );
      broadcast();
      json(response, 200, readState());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/game/reset") {
      const body = await readJson(request);
      if (body.confirmation !== "NEW GAME") throw new Error("Type NEW GAME to confirm");
      const keepTeamsAndRosters = body.keepTeamsAndRosters === true;
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM play").run();
        if (!keepTeamsAndRosters) {
          db.prepare("DELETE FROM roster").run();
          db.prepare("UPDATE game SET home_name = '', away_name = '', home_code = '', away_code = '', updated_at = ? WHERE id = 1").run(new Date().toISOString());
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      // Preserve the MQTT client connection, but discard payload retained from the previous game.
      scoreboard = { connected: scoreboard.connected, stale: true, received_at_utc: null, payload: {} };
      broadcast();
      json(response, 200, readState());
      return;
    }
    const rosterMatch = url.pathname.match(/^\/api\/rosters\/(home|away)$/);
    if (request.method === "PUT" && rosterMatch) {
      const body = await readJson(request);
      replaceRoster(rosterMatch[1], body.rows);
      broadcast();
      json(response, 200, readState());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/plays") {
      const body = await readJson(request);
      const play = cleanPlay(body);
      const now = new Date().toISOString();
      const result = db.prepare(`
        INSERT INTO play
        (clock, situation, down, distance, ball_on, period, description, tag, status, team, play_type, player_number, passer_number, receiver_number, pass_result, yards, details_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'logged', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        String(body.clock || currentScoreboard().payload.clock || ""),
        String(body.situation || ""),
        play.down, play.distance, play.ballOn, play.period,
        play.description,
        body.tag ? String(body.tag) : null,
        play.team, play.playType, play.playerNumber, play.passerNumber || null,
        play.receiverNumber || null, play.passResult || null, play.yards, JSON.stringify(play.details),
        now,
        now,
      );
      broadcast();
      json(response, 201, { id: Number(result.lastInsertRowid), state: readState() });
      return;
    }
    const playMatch = url.pathname.match(/^\/api\/plays\/(\d+)$/);
    if (playMatch && request.method === "PUT") {
      const body = await readJson(request);
      const play = cleanPlay(body);
      const existing = db.prepare("SELECT details_json FROM play WHERE id = ?").get(Number(playMatch[1]));
      if (!existing) throw new Error("Play not found");
      const existingDetails = JSON.parse(String(existing.details_json || "{}"));
      const mergedDetails = { ...existingDetails, ...play.details };
      const result = db.prepare(`
        UPDATE play
        SET clock = ?, situation = ?, down = ?, distance = ?, ball_on = ?, period = ?, description = ?, tag = ?, team = ?, play_type = ?,
            player_number = ?, passer_number = ?, receiver_number = ?, pass_result = ?, yards = ?, details_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        String(body.clock || ""),
        String(body.situation || ""),
        play.down, play.distance, play.ballOn, play.period,
        play.description,
        body.tag ? String(body.tag) : null,
        play.team, play.playType, play.playerNumber, play.passerNumber || null,
        play.receiverNumber || null, play.passResult || null, play.yards, JSON.stringify(mergedDetails),
        new Date().toISOString(),
        Number(playMatch[1]),
      );
      if (!result.changes) throw new Error("Play not found");
      broadcast();
      json(response, 200, readState());
      return;
    }
    if (playMatch && request.method === "DELETE") {
      const result = db.prepare("DELETE FROM play WHERE id = ?").run(Number(playMatch[1]));
      if (!result.changes) throw new Error("Play not found");
      broadcast();
      response.writeHead(204);
      response.end();
      return;
    }
    const confirmMatch = url.pathname.match(/^\/api\/plays\/(\d+)\/confirm$/);
    if (confirmMatch && request.method === "POST") {
      const body = await readJson(request);
      const existingPlay = db.prepare("SELECT team, details_json FROM play WHERE id = ?").get(Number(confirmMatch[1]));
      if (!existingPlay) throw new Error("Play not found");
      const defensiveTeam = existingPlay.team === "home" ? "away" : "home";
      const defensiveNumbers = new Set(rowsToRoster(defensiveTeam).map((row) => row[0]));
      const selectedDefenders = [
        ...(Array.isArray(body.tacklers) ? body.tacklers : []),
        body.defensiveCredits?.primary,
        ...(Array.isArray(body.defensiveCredits?.assists) ? body.defensiveCredits.assists : []),
        ...(Array.isArray(body.defensiveCredits?.sack) ? body.defensiveCredits.sack : []),
        ...(Array.isArray(body.defensiveCredits?.tackleForLoss) ? body.defensiveCredits.tackleForLoss : []),
        body.defensiveCredits?.forcedFumble,
        body.defensiveCredits?.passBreakup,
        body.turnoverDetail?.interceptorNumber,
        body.turnoverDetail?.recovererNumber,
      ].filter(Boolean).map(String);
      if (selectedDefenders.some((number) => !defensiveNumbers.has(number))) throw new Error("Defensive detail player must be on the opposing roster");
      const result = db.prepare(`
        UPDATE play SET status = 'confirmed', details_json = ?, updated_at = ? WHERE id = ?
      `).run(
        JSON.stringify({
          ...JSON.parse(String(existingPlay.details_json || "{}")),
          tacklers: Array.isArray(body.tacklers) ? body.tacklers : [],
          flags: Array.isArray(body.flags) ? body.flags : [],
          defensiveCredits: body.defensiveCredits && typeof body.defensiveCredits === "object" ? body.defensiveCredits : undefined,
          turnoverDetail: body.turnoverDetail && typeof body.turnoverDetail === "object" ? body.turnoverDetail : undefined,
        }),
        new Date().toISOString(),
        Number(confirmMatch[1]),
      );
      if (!result.changes) throw new Error("Play not found");
      broadcast();
      json(response, 200, readState());
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/test/mqtt" &&
      process.env.NODE_ENV !== "production"
    ) {
      applyScoreboardPayload(await readJson(request));
      json(response, 200, currentScoreboard());
      return;
    }
    json(response, 404, { error: "Not found" });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : "Request failed" });
  }
});

api.listen(PORT, HOST, () => {
  console.log(`TommyTV game service listening on http://${HOST}:${PORT}`);
  console.log(`SQLite database: ${DB_PATH}`);
});

const mqttClient = mqtt.connect(MQTT_URL, {
  reconnectPeriod: 2_000,
  connectTimeout: 5_000,
});

mqttClient.on("connect", () => {
  scoreboard.connected = true;
  mqttClient.subscribe(MQTT_TOPIC, (error) => {
    if (error) console.error(`MQTT subscribe failed: ${error.message}`);
    else console.log(`MQTT subscribed: ${MQTT_TOPIC}`);
  });
  broadcast();
});

mqttClient.on("message", (topic, buffer) => {
  if (topic !== MQTT_TOPIC) return;
  try {
    applyScoreboardPayload(JSON.parse(buffer.toString("utf8")));
  } catch (error) {
    console.error(`Ignored invalid MQTT JSON: ${error instanceof Error ? error.message : error}`);
  }
});

mqttClient.on("offline", () => {
  scoreboard.connected = false;
  broadcast();
});

mqttClient.on("error", (error) => {
  scoreboard.connected = false;
  if (process.env.NODE_ENV !== "test") console.error(`MQTT: ${error.message}`);
});

// Staleness changes with time, not with an incoming message. Broadcast when a
// previously live feed crosses the threshold so every open iPad updates.
const staleTimer = setInterval(() => {
  if (scoreboard.connected && !scoreboard.stale && currentScoreboard().stale) {
    scoreboard.stale = true;
    broadcast();
  }
}, Math.max(1_000, Math.min(SCOREBOARD_STALE_MS, 5_000)));
staleTimer.unref();

function shutdown() {
  clearInterval(staleTimer);
  mqttClient.end(true);
  for (const response of eventClients) response.end();
  api.closeAllConnections();
  api.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
