import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const port = 33101;
const baseUrl = `http://127.0.0.1:${port}`;

async function waitForServer(process) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (process.exitCode != null) throw new Error("Game service exited during startup");
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Game service did not start");
}

async function request(path, method = "GET", body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.ok(response.ok, `${method} ${path} returned ${response.status}`);
  if (response.status === 204) return null;
  return response.json();
}

test("persists game, rosters, MQTT state, plays, and defensive detail", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tommytv-test-"));
  const database = join(directory, "game.sqlite");
  const child = spawn(process.execPath, ["server/game-server.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: "test",
      GAME_SERVER_HOST: "127.0.0.1",
      GAME_SERVER_PORT: String(port),
      GAME_DB_PATH: database,
      MQTT_URL: "mqtt://127.0.0.1:1",
    },
    stdio: "ignore",
  });

  t.after(async () => {
    if (child.exitCode != null) {
      await rm(directory, { recursive: true, force: true });
      return;
    }
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    const forced = setTimeout(() => child.kill("SIGKILL"), 2_000);
    await exited;
    clearTimeout(forced);
    await rm(directory, { recursive: true, force: true });
  });

  await waitForServer(child);

  await request("/api/game", "PUT", {
    homeName: "Taylorville Tornadoes",
    awayName: "Lincoln Railsplitters",
    homeCode: "TAY",
    awayCode: "LIN",
  });
  await request("/api/rosters/home", "PUT", {
    rows: [["12", "Cole Martin", "QB"], ["22", "Jalen Price", "RB"]],
  });
  await request("/api/rosters/away", "PUT", {
    rows: [["4", "Drew Collins", "QB"], ["21", "Micah Lewis", "RB"]],
  });
  await request("/api/test/mqtt", "POST", {
    clock: "08:42",
    period: "3",
    home_score: "17",
    away_score: "14",
    down: "2",
    to_go: "6",
    ball_on: "TAY 35",
  });

  const created = await request("/api/plays", "POST", {
    team: "home",
    clock: "08:42",
    situation: "2 & 6 at TAY 35",
    description: "#22 Jalen Price rush for 8 yards",
    tag: "FIRST DOWN",
    playType: "Run",
    playerNumber: "22",
    yards: 8,
  });
  assert.equal(created.id, 1);

  await request("/api/plays/1/confirm", "POST", {
    tacklers: ["21"],
    flags: ["Tackle for loss"],
  });

  const state = await request("/api/state");
  assert.equal(state.game.homeName, "Taylorville Tornadoes");
  assert.deepEqual(state.rosters.home[1], ["22", "Jalen Price", "RB"]);
  assert.deepEqual(state.rosters.away[0], ["4", "Drew Collins", "QB"]);
  assert.equal(state.scoreboard.payload.clock, "08:42");
  assert.equal(state.plays[0].team, "home");
  assert.equal(state.plays[0].yards, 8);
  assert.equal(state.plays[0].status, "confirmed");
  assert.deepEqual(state.plays[0].details.tacklers, ["21"]);

  await request("/api/plays/1", "DELETE");
  const emptyState = await request("/api/state");
  assert.equal(emptyState.plays.length, 0);
});
