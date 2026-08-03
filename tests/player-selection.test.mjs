import assert from "node:assert/strict";
import test from "node:test";

import {
  autoSelectedJerseyPlayer,
  jerseyMatches,
  positionMatches,
  samePlayer,
  sortRoster,
} from "../app/player-selection.ts";

const roster = [
  ["22", "Jalen Price", "RB"],
  ["2", "Nate Young", "WR"],
  ["7", "Cole Martin", "QB"],
  ["12", "Drew Collins", "WR"],
];

test("sorts the full roster numerically and recognizes play-type positions", () => {
  assert.deepEqual(sortRoster(roster).map((row) => row[0]), ["2", "7", "12", "22"]);
  assert.equal(positionMatches("Run", "RB"), true);
  assert.equal(positionMatches("Pass", "WR"), true);
  assert.equal(positionMatches("Pass", "OL"), false);
});

test("supports one- and two-digit jersey matching without prematurely choosing a prefix", () => {
  assert.deepEqual(jerseyMatches(roster, "2").map((row) => row[0]), ["22", "2"]);
  assert.equal(autoSelectedJerseyPlayer(roster, "2"), null);
  assert.deepEqual(autoSelectedJerseyPlayer(roster, "22"), roster[0]);
  assert.deepEqual(autoSelectedJerseyPlayer(roster, "7"), roster[2]);
  assert.deepEqual(jerseyMatches(roster, "99"), []);
});

test("does not auto-select duplicate jersey numbers and retains player identity by name", () => {
  const duplicates = [["4", "Alex Reed", "RB"], ["4", "Sam Reed", "DB"]];
  assert.equal(autoSelectedJerseyPlayer(duplicates, "4"), null);
  assert.equal(samePlayer(duplicates[0], duplicates[1]), false);
  assert.equal(jerseyMatches(duplicates, "4").length, 2);
});
