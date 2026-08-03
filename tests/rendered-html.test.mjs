import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${path}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the TommyTV primary stat interface", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>TommyTV Football Stats<\/title>/i);
  assert.match(html, /What happened\?/);
  assert.match(html, /Primary Stats/);
  assert.match(html, /Defensive Detail/);
  assert.match(html, /PxP Panel/);
  assert.match(html, /TommyTV Control/);
  assert.match(html, /Game Setup/);
  assert.match(html, /MQTT WAITING/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("supports direct role shortcut routes", async () => {
  const routes = [
    ["/entry-primary", /What happened\?/],
    ["/entry-detail", /Finish the play/],
    ["/pxp", /GAME LEADERS/],
    ["/control", /Choose a look/],
    ["/admin", /Friday night configuration/],
  ];

  for (const [path, expected] of routes) {
    const response = await render(path);
    assert.equal(response.status, 200, `${path} should render successfully`);
    assert.match(await response.text(), expected);
  }
});

test("keeps core interactive workflows in the product source", async () => {
  const [page, layout, roleRoute, gameRoute, gameServer, packageJson, viteConfig] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/[...role]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/game/[...path]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../server/game-server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /function savePlay\(\)/);
  assert.match(page, /Save correction/);
  assert.match(page, /Import \{previewTeam\} roster/);
  assert.match(page, /Preview away roster/);
  assert.match(page, /setAwayRosterRows/);
  assert.match(page, /Confirm detail/);
  assert.match(page, /Fumble lost/);
  assert.match(page, /Jersey number selector/);
  assert.match(page, /All players/);
  assert.match(page, /autoSelectedJerseyPlayer/);
  assert.doesNotMatch(page, /aria-label="More players"/);
  assert.doesNotMatch(page, /useState\(\["34"\]\)/);
  assert.match(page, /Simulate vMix push/);
  assert.match(page, /GameContext\.Provider/);
  assert.match(page, /apiRequest/);
  assert.match(layout, /appleWebApp/);
  assert.match(roleRoute, /export \{ default \} from "\.\.\/page"/);
  assert.match(gameRoute, /GAME_SERVICE_URL/);
  assert.match(gameServer, /tommytv\/scoreboard/);
  assert.match(gameServer, /DatabaseSync/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(packageJson, /vinext dev --hostname 0\.0\.0\.0/);
  assert.doesNotMatch(viteConfig, /import hostingConfig from/);
});
