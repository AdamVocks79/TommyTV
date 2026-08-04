import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url);
const gamePort = 33102;
const nextPort = 33103;
const baseUrl = `http://127.0.0.1:${nextPort}`;

async function waitFor(url, processes) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    for (const process of processes) {
      if (process.exitCode != null) throw new Error(`Service exited with code ${process.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Service did not start: ${url}`);
}

async function stop(process) {
  if (process.exitCode != null) return;
  const exited = new Promise((resolve) => process.once("exit", resolve));
  process.kill("SIGTERM");
  const forced = setTimeout(() => process.kill("SIGKILL"), 2_000);
  await exited;
  clearTimeout(forced);
}

test("native Next serves the app, assets, API proxy, and SSE", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tommytv-next-"));
  const commonEnv = { ...process.env, NODE_ENV: "production" };
  const game = spawn(process.execPath, ["server/game-server.mjs"], {
    cwd: root,
    env: { ...commonEnv, GAME_SERVER_HOST: "127.0.0.1", GAME_SERVER_PORT: String(gamePort), GAME_DB_PATH: join(directory, "game.sqlite"), MQTT_URL: "mqtt://127.0.0.1:1" },
    stdio: "ignore",
  });
  const frontend = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(nextPort)], {
    cwd: root,
    env: { ...commonEnv, GAME_SERVICE_URL: `http://127.0.0.1:${gamePort}` },
    stdio: "ignore",
  });

  t.after(async () => {
    await Promise.all([stop(frontend), stop(game)]);
    await rm(directory, { recursive: true, force: true });
  });

  await waitFor(`http://127.0.0.1:${gamePort}/api/health`, [game]);
  const response = await waitFor(`${baseUrl}/`, [frontend, game]);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>TommyTV Football Stats<\/title>/i);
  assert.match(html, /What happened\?/);

  const cssPath = html.match(/href="([^\"]+\.css[^\"]*)"/)?.[1];
  const jsPath = html.match(/src="([^\"]+\.js[^\"]*)"/)?.[1];
  assert.ok(cssPath, "rendered HTML should reference a CSS asset");
  assert.ok(jsPath, "rendered HTML should reference a JavaScript asset");
  assert.match((await fetch(new URL(cssPath, baseUrl))).headers.get("content-type") ?? "", /^text\/css\b/i);
  assert.match((await fetch(new URL(jsPath, baseUrl))).headers.get("content-type") ?? "", /^(application|text)\/javascript\b/i);

  for (const [path, expected] of [["/entry-primary", /What happened\?/], ["/entry-detail", /Finish the play/], ["/pxp", /GAME LEADERS/], ["/control", /Choose a look/], ["/admin", /Friday night configuration/]]) {
    const roleResponse = await fetch(`${baseUrl}${path}`);
    assert.equal(roleResponse.status, 200);
    assert.match(await roleResponse.text(), expected);
  }

  const state = await fetch(`${baseUrl}/api/game/state`);
  assert.equal(state.status, 200);
  assert.match(state.headers.get("content-type") ?? "", /^application\/json\b/i);

  const setup = await fetch(`${baseUrl}/api/game/game`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ homeName: "Home", awayName: "Away", homeCode: "HOM", awayCode: "AWY" }) });
  assert.equal(setup.status, 200);
  const roster = await fetch(`${baseUrl}/api/game/rosters/home`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows: [["22", "Runner", "RB"]] }) });
  assert.equal(roster.status, 200);
  const created = await fetch(`${baseUrl}/api/game/plays`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ team: "home", playType: "Run", playerNumber: "22", yards: 4 }) });
  assert.equal(created.status, 201);
  const playId = (await created.json()).id;
  assert.equal((await fetch(`${baseUrl}/api/game/plays/${playId}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tacklers: [] }) })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/game/plays/${playId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ team: "home", playType: "Run", playerNumber: "22", yards: 5 }) })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/game/export`)).status, 200);

  const events = await fetch(`${baseUrl}/api/game/events`);
  assert.equal(events.status, 200);
  assert.match(events.headers.get("content-type") ?? "", /^text\/event-stream\b/i);
  const reader = events.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: state/);
  await reader.cancel();

  assert.equal((await fetch(`${baseUrl}/api/game/plays/${playId}`, { method: "DELETE" })).status, 204);
  assert.equal((await fetch(`${baseUrl}/api/game/game/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmation: "NEW GAME", keepTeamsAndRosters: false }) })).status, 200);
});

test("native build excludes Cloudflare runtime code and launchers are repository-relative", async () => {
  const [appPage, route, tsconfig, gitignore, frontendLauncher, gameLauncher] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/game/[...path]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../tsconfig.json", import.meta.url), "utf8"),
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
    readFile(new URL("../start-frontend.cmd", import.meta.url), "utf8"),
    readFile(new URL("../start-game-service.cmd", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(`${appPage}\n${route}`, /cloudflare:workers|db\/index/);
  assert.deepEqual(JSON.parse(tsconfig).exclude.slice(1, 3), ["db", "worker"]);
  assert.match(gitignore, /^\.env\*$/m);
  assert.match(gitignore, /^!\.env\.example$/m);
  assert.match(frontendLauncher, /cd \/d "%~dp0"/);
  assert.match(gameLauncher, /cd \/d "%~dp0"/);
  assert.doesNotMatch(`${frontendLauncher}\n${gameLauncher}`, /C:\\TommyTV/i);
});
