import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  assert.match(page, /className="offense-toggle"/);
  assert.match(page, /Toggle offense between/);
  assert.match(page, /team: snapshot\.possession/);
  assert.match(page, /Player selection cleared after offense changed/);
  assert.doesNotMatch(page, /className="possession-toggle"/);
  assert.doesNotMatch(page, /setOffense/);
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
  assert.match(packageJson, /"build": "next build"/);
  assert.match(packageJson, /"build:vinext": "cross-env .*vinext build"/);
  assert.doesNotMatch(viteConfig, /import hostingConfig from/);
});
