import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import mqtt from "mqtt";

const PORT = Number(process.env.GAME_SERVER_PORT || 3001);
const HOST = process.env.GAME_SERVER_HOST || "0.0.0.0";
const MQTT_URL = process.env.MQTT_URL || "mqtt://192.168.18.129:1883";
const MQTT_TOPIC = process.env.MQTT_TOPIC || "tommytv/scoreboard";
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
    "SELECT id, clock, situation, description, tag, status, team, play_type, player_number, yards, details_json FROM play ORDER BY id"
  ).all().map((play) => ({
    id: Number(play.id),
    clock: String(play.clock),
    situation: String(play.situation),
    description: String(play.description),
    tag: play.tag == null ? undefined : String(play.tag),
    status: String(play.status),
    team: String(play.team),
    playType: String(play.play_type),
    playerNumber: String(play.player_number),
    yards: Number(play.yards),
    details: JSON.parse(String(play.details_json || "{}")),
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
    stale: !scoreboard.connected || !receivedAt || Date.now() - receivedAt > 10_000,
  };
}

function broadcast() {
  const event = `event: state\ndata: ${JSON.stringify(readState())}\n\n`;
  for (const response of eventClients) response.write(event);
}

function json(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
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

const api = createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

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
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
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
      if (!String(body.description || "").trim()) throw new Error("Play description is required");
      const now = new Date().toISOString();
      const result = db.prepare(`
        INSERT INTO play
        (clock, situation, description, tag, status, team, play_type, player_number, yards, details_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'logged', ?, ?, ?, ?, '{}', ?, ?)
      `).run(
        String(body.clock || currentScoreboard().payload.clock || ""),
        String(body.situation || ""),
        String(body.description).trim(),
        body.tag ? String(body.tag) : null,
        body.team === "away" ? "away" : "home",
        String(body.playType || ""),
        String(body.playerNumber || ""),
        Number(body.yards || 0),
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
      db.prepare(`
        UPDATE play SET clock = ?, situation = ?, description = ?, tag = ?, updated_at = ? WHERE id = ?
      `).run(
        String(body.clock || ""),
        String(body.situation || ""),
        String(body.description || "").trim(),
        body.tag ? String(body.tag) : null,
        new Date().toISOString(),
        Number(playMatch[1]),
      );
      broadcast();
      json(response, 200, readState());
      return;
    }
    if (playMatch && request.method === "DELETE") {
      db.prepare("DELETE FROM play WHERE id = ?").run(Number(playMatch[1]));
      broadcast();
      response.writeHead(204, { "Access-Control-Allow-Origin": "*" });
      response.end();
      return;
    }
    const confirmMatch = url.pathname.match(/^\/api\/plays\/(\d+)\/confirm$/);
    if (confirmMatch && request.method === "POST") {
      const body = await readJson(request);
      db.prepare(`
        UPDATE play SET status = 'confirmed', details_json = ?, updated_at = ? WHERE id = ?
      `).run(
        JSON.stringify({
          tacklers: Array.isArray(body.tacklers) ? body.tacklers : [],
          flags: Array.isArray(body.flags) ? body.flags : [],
        }),
        new Date().toISOString(),
        Number(confirmMatch[1]),
      );
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

function shutdown() {
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
