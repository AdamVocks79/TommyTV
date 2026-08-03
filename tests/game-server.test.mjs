import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

async function rejected(path, method, body) {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, 400);
  return response.json();
}

test("persists game, rosters, MQTT state, plays, and defensive detail", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tommytv-test-"));
  const database = join(directory, "game.sqlite");
  const legacy = new DatabaseSync(database);
  legacy.exec(`CREATE TABLE play (
    id INTEGER PRIMARY KEY AUTOINCREMENT, clock TEXT NOT NULL DEFAULT '', situation TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL, tag TEXT, status TEXT NOT NULL DEFAULT 'logged', play_type TEXT NOT NULL DEFAULT '',
    player_number TEXT NOT NULL DEFAULT '', yards INTEGER NOT NULL DEFAULT 0, details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  legacy.close();
  const startServer = () => spawn(process.execPath, ["server/game-server.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, NODE_ENV: "test", GAME_SERVER_HOST: "127.0.0.1", GAME_SERVER_PORT: String(port), GAME_DB_PATH: database, MQTT_URL: "mqtt://127.0.0.1:1" },
    stdio: "ignore",
  });
  let child = startServer();

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
    rows: [["5", "Logan Carter", "QB"], ["12", "Cole Martin", "QB"], ["22", "Jalen Price", "RB"], ["68", "Ryan Smith", "WR"]],
  });
  await request("/api/rosters/away", "PUT", {
    rows: [["4", "Drew Collins", "QB"], ["21", "Micah Lewis", "RB"], ["66", "Alex Jones", "LB"], ["80", "Sam Reed", "WR"]],
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
    down: 2,
    distance: 6,
    ballOn: "TAY 35",
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
  assert.ok(state.rosters.home.some((row) => row[0] === "22" && row[1] === "Jalen Price"));
  assert.deepEqual(state.rosters.away[0], ["4", "Drew Collins", "QB"]);
  assert.equal(state.scoreboard.payload.clock, "08:42");
  assert.equal(state.plays[0].team, "home");
  assert.equal(state.plays[0].yards, 8);
  assert.deepEqual({ down: state.plays[0].down, distance: state.plays[0].distance, ballOn: state.plays[0].ballOn }, { down: 2, distance: 6, ballOn: "TAY 35" });
  assert.equal(state.plays[0].status, "confirmed");
  assert.deepEqual(state.plays[0].details.tacklers, ["21"]);

  await request("/api/plays/1", "PUT", {
    clock: "08:31",
    situation: "1 & 10 at TAY 43",
    down: 3,
    distance: 10,
    ballOn: "TAY 43",
    description: "regenerated from structured fields",
    tag: "FIRST DOWN",
    team: "away",
    playType: "Pass",
    playerNumber: "",
    passerNumber: "4",
    receiverNumber: "80",
    passResult: "Complete",
    yards: 12,
  });
  const correctedState = await request("/api/state");
  assert.equal(correctedState.plays[0].team, "away");
  assert.equal(correctedState.plays[0].playType, "Pass");
  assert.equal(correctedState.plays[0].passerNumber, "4");
  assert.equal(correctedState.plays[0].receiverNumber, "80");
  assert.equal(correctedState.plays[0].passResult, "Complete");
  assert.equal(correctedState.plays[0].yards, 12);
  assert.deepEqual({ down: correctedState.plays[0].down, distance: correctedState.plays[0].distance, ballOn: correctedState.plays[0].ballOn }, { down: 3, distance: 10, ballOn: "TAY 43" });
  assert.equal(correctedState.plays[0].description, "#4 Drew Collins complete to #80 Sam Reed for 12 yards");
  assert.deepEqual(correctedState.plays[0].details.tacklers, ["21"]);

  const completed = await request("/api/plays", "POST", {
    team: "home", description: "pass", playType: "Pass", playerNumber: "",
    passerNumber: "5", receiverNumber: "68", passResult: "Complete", yards: 40,
  });
  await request(`/api/plays/${completed.id}/confirm`, "POST", { tacklers: ["66"], flags: [] });
  await request("/api/plays", "POST", {
    team: "home", description: "pass", playType: "Pass", playerNumber: "",
    passerNumber: "5", receiverNumber: "68", passResult: "Incomplete", yards: 0,
  });
  await request("/api/plays", "POST", {
    team: "away", description: "pass", playType: "Pass", playerNumber: "",
    passerNumber: "4", passResult: "Interception", yards: 0,
  });
  const passState = await request("/api/state");
  assert.equal(passState.plays.length, 4);
  assert.equal(passState.plays[1].description, "#5 Logan Carter complete to #68 Ryan Smith for 40 yards");
  assert.deepEqual(passState.plays[1].details.tacklers, ["66"]);
  assert.equal(passState.plays[2].description, "#5 Logan Carter pass incomplete");
  assert.equal(passState.plays[3].description, "#4 Drew Collins intercepted");

  const sack = await request("/api/plays", "POST", {
    team: "home", description: "sack", playType: "Pass", playerNumber: "",
    passerNumber: "5", receiverNumber: "68", passResult: "Sacked", yards: -7,
  });
  await request(`/api/plays/${sack.id}/confirm`, "POST", { tacklers: ["66", "21"], flags: ["Sack"] });
  const sackState = await request("/api/state");
  const savedSack = sackState.plays.find((play) => play.id === sack.id);
  assert.equal(savedSack.playType, "Pass");
  assert.equal(savedSack.passResult, "Sacked");
  assert.equal(savedSack.passerNumber, "5");
  assert.equal(savedSack.receiverNumber, undefined);
  assert.equal(savedSack.yards, -7);
  assert.equal(savedSack.description, "#5 Logan Carter sacked for a loss of 7 yards");
  assert.equal(savedSack.status, "confirmed");
  assert.deepEqual(savedSack.details, { tacklers: ["66", "21"], flags: ["Sack"] });

  const intercepted = await request("/api/plays", "POST", { team: "home", playType: "Pass", passerNumber: "5", passResult: "Interception", yards: 0 });
  await request(`/api/plays/${intercepted.id}/confirm`, "POST", { tacklers: [], flags: [], turnoverDetail: { interceptorNumber: "66", interceptionReturnYards: 18, returnTouchdown: true } });
  const fumble = await request("/api/plays", "POST", { team: "home", playType: "Run", playerNumber: "22", yards: 3, tag: "FUMBLE LOST" });
  await request(`/api/plays/${fumble.id}/confirm`, "POST", { tacklers: ["21", "66"], flags: ["Forced fumble"], defensiveCredits: { primary: "21", assists: ["66"], forcedFumble: "21" }, turnoverDetail: { recovererNumber: "66" } });
  const noTackle = await request("/api/plays", "POST", { team: "home", playType: "Pass", passerNumber: "5", passResult: "Incomplete", yards: 0 });
  await request(`/api/plays/${noTackle.id}/confirm`, "POST", { tacklers: [], flags: [] });

  for (const specialTeams of [
    { subtype: "Punt", result: "Returned", actorNumber: "5", returnerNumber: "21", distance: 42, returnYards: 9, returnTouchdown: false },
    { subtype: "Punt", result: "Fair catch", actorNumber: "5", distance: 38 },
    { subtype: "Kickoff", result: "Touchback", actorNumber: "5" },
    { subtype: "Field goal", result: "Made", actorNumber: "5", distance: 31 },
    { subtype: "Field goal", result: "Missed", actorNumber: "5", distance: 44 },
    { subtype: "Try", result: "Made", actorNumber: "5", tryType: "PAT kick" },
    { subtype: "Try", result: "Failed", actorNumber: "22", tryType: "Two-point run" },
    { subtype: "Try", result: "Made", passerNumber: "5", receiverNumber: "68", tryType: "Two-point pass" },
  ]) await request("/api/plays", "POST", { team: "home", playType: "Special", yards: 0, details: { specialTeams } });

  const defensivePenalty = await request("/api/plays", "POST", { team: "home", playType: "Penalty", yards: 0, details: { penalty: { team: "away", name: "Defensive pass interference", accepted: true, yards: 15, automaticFirstDown: true, playCounts: false } } });
  await request("/api/plays", "POST", { team: "away", playType: "Penalty", yards: 0, details: { penalty: { team: "away", name: "Holding", accepted: true, yards: 10, automaticFirstDown: false, playCounts: false } } });
  await request("/api/plays", "POST", { team: "away", playType: "Penalty", yards: 0, details: { penalty: { team: "away", name: "Pass interference", accepted: true, yards: 15, automaticFirstDown: true, playCounts: true } } });

  const detailedState = await request("/api/state");
  assert.deepEqual(detailedState.plays.find((play) => play.id === intercepted.id).details.turnoverDetail, { interceptorNumber: "66", interceptionReturnYards: 18, returnTouchdown: true });
  assert.deepEqual(detailedState.plays.find((play) => play.id === fumble.id).details.defensiveCredits, { primary: "21", assists: ["66"], forcedFumble: "21" });
  assert.deepEqual(detailedState.plays.find((play) => play.id === noTackle.id).details.tacklers, []);
  assert.deepEqual(detailedState.plays.filter((play) => play.status === "logged").map((play) => play.id), [...detailedState.plays.filter((play) => play.status === "logged").map((play) => play.id)].sort((a, b) => a - b));
  assert.equal(detailedState.plays.find((play) => play.details.specialTeams?.result === "Returned").details.specialTeams.returnYards, 9);
  assert.equal(detailedState.plays.find((play) => play.id === defensivePenalty.id).team, "home");
  assert.equal(detailedState.plays.find((play) => play.id === defensivePenalty.id).details.penalty.team, "away");
  const twoPointPass = detailedState.plays.find((play) => play.details.specialTeams?.tryType === "Two-point pass");
  assert.equal(twoPointPass.details.specialTeams.actorNumber, "");
  assert.equal(twoPointPass.description, "#5 pass to #68 for successful two-point conversion");
  assert.equal(detailedState.plays.filter((play) => play.details.penalty?.accepted).reduce((sum, play) => sum + play.details.penalty.yards, 0), 40);

  const invalidEdit = await rejected(`/api/plays/${completed.id}`, "PUT", { team: "home", playType: "Pass", passerNumber: "5", passResult: "Complete", yards: 10 });
  assert.match(invalidEdit.error, /receiver/);
  const afterInvalidEdit = await request("/api/state");
  assert.equal(afterInvalidEdit.plays.find((play) => play.id === completed.id).yards, 40);

  for (const invalid of [
    { team: "home", playType: "Run", playerNumber: "22", yards: 1, down: 0 },
    { team: "home", playType: "Run", playerNumber: "22", yards: 1, down: 5 },
    { team: "home", playType: "Run", playerNumber: "22", yards: 1, distance: -1 },
    { team: "home", playType: "Penalty", details: { penalty: { name: "Holding", accepted: true, yards: 10 } } },
    { team: "home", playType: "Pass", passerNumber: "5", receiverNumber: "68", passResult: "Incomplete", yards: 2 },
    { team: "home", playType: "Pass", passerNumber: "5", passResult: "Sacked", yards: 1 },
    { team: "home", playType: "Special", details: { specialTeams: { subtype: "Try", tryType: "Two-point run", result: "Made" } } },
    { team: "home", playType: "Special", details: { specialTeams: { subtype: "Try", tryType: "Two-point pass", result: "Made", passerNumber: "5" } } },
    { team: "home", playType: "Special", details: { specialTeams: { subtype: "Try", tryType: "PAT kick", result: "Made" } } },
    { team: "home", playType: "Special", details: { specialTeams: { subtype: "Kickoff", result: "Returned", actorNumber: "5" } } },
    { team: "home", playType: "Special", details: { specialTeams: { subtype: "Field goal", result: "Made", actorNumber: "5", distance: 0 } } },
  ]) await rejected("/api/plays", "POST", invalid);

  const stopped = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await stopped;
  child = startServer();
  await waitForServer(child);
  const restartedState = await request("/api/state");
  assert.deepEqual({ down: restartedState.plays[0].down, distance: restartedState.plays[0].distance, ballOn: restartedState.plays[0].ballOn }, { down: 3, distance: 10, ballOn: "TAY 43" });

  await request("/api/plays/1", "DELETE");
  const emptyState = await request("/api/state");
  assert.equal(emptyState.plays.length, detailedState.plays.length - 1);
});
