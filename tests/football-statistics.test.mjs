import assert from "node:assert/strict";
import test from "node:test";
import { buildDriveSummaries, buildLongestPlaySummary, buildRedZoneSummary, buildScoringSummary, calculatePlayerStats, calculateTeamSummary, filterTimelinePlays, isExplosivePlay, parseBallPosition } from "../app/football-statistics.mjs";

test("credits one completed pass to passer, receiver, and tackler without rushing yards", () => {
  const stats = calculatePlayerStats([{ team: "home", playType: "Pass", passerNumber: "5", receiverNumber: "68", passResult: "Complete", yards: 40, details: { tacklers: ["66"] } }]);
  assert.deepEqual({ attempts: stats.get("home-5").attempts, completions: stats.get("home-5").completions, passingYards: stats.get("home-5").passingYards }, { attempts: 1, completions: 1, passingYards: 40 });
  assert.equal(stats.get("home-68").receptions, 1);
  assert.equal(stats.get("home-68").receivingYards, 40);
  assert.equal(stats.get("away-66").tackles, 1);
});

test("sacks are not attempts and special teams or penalties are not offensive plays", () => {
  const plays = [
    { team: "home", playType: "Run", playerNumber: "22", yards: 6 },
    { team: "home", playType: "Pass", passerNumber: "5", receiverNumber: "68", passResult: "Complete", yards: 24 },
    { team: "home", playType: "Pass", passerNumber: "5", passResult: "Incomplete", yards: 0 },
    { team: "home", playType: "Pass", passerNumber: "5", passResult: "Sacked", yards: -7, details: { defensiveCredits: { primary: "66", sack: ["66"] } } },
    { team: "home", playType: "Special", details: { specialTeams: { subtype: "Punt", distance: 40 } } },
    { team: "home", playType: "Penalty", details: { penalty: { team: "away", accepted: true, yards: 15, automaticFirstDown: true, playCounts: true } } },
  ];
  assert.equal(calculatePlayerStats(plays).get("home-5").attempts, 2);
  assert.deepEqual({ plays: calculateTeamSummary(plays, "home").plays, yards: calculateTeamSummary(plays, "home").yards }, { plays: 4, yards: 23 });
  assert.equal(calculateTeamSummary(plays, "away").penalties, 1);
  assert.equal(calculatePlayerStats(plays).get("away-66").sacks, 1);
});

test("aggregates defensive credits and offensive fumbles by responsible player", () => {
  const stats = calculatePlayerStats([
    { team: "home", playType: "Run", playerNumber: "22", yards: 3, tag: "FUMBLE LOST", details: { defensiveCredits: { primary: "21", assists: ["66"], tackleForLoss: ["21"], forcedFumble: "21", passBreakup: "66" }, turnoverDetail: { recovererNumber: "66" } } },
    { team: "away", playType: "Pass", passerNumber: "4", passResult: "Interception", yards: 0, details: { turnoverDetail: { interceptorNumber: "5" } } },
  ]);
  assert.deepEqual({ fumbles: stats.get("home-22").fumbles, lost: stats.get("home-22").fumblesLost }, { fumbles: 1, lost: 1 });
  assert.deepEqual({ solo: stats.get("away-21").soloTackles, tackles: stats.get("away-21").tackles, forced: stats.get("away-21").forcedFumbles }, { solo: 1, tackles: 1, forced: 1 });
  assert.deepEqual({ assisted: stats.get("away-66").assistedTackles, recovery: stats.get("away-66").fumbleRecoveries, breakup: stats.get("away-66").passBreakups }, { assisted: 1, recovery: 1, breakup: 1 });
  assert.equal(stats.get("home-5").interceptions, 1);
});

test("credits incomplete and intercepted passes as attempts but not completions", () => {
  const stats = calculatePlayerStats([
    { team: "away", playType: "Pass", passerNumber: "4", passResult: "Incomplete", yards: 0 },
    { team: "away", playType: "Pass", passerNumber: "4", passResult: "Interception", yards: 0 },
    { team: "away", playType: "Run", playerNumber: "21", yards: 9 },
  ]);
  assert.equal(stats.get("away-4").attempts, 2);
  assert.equal(stats.get("away-4").completions, 0);
  assert.equal(stats.get("away-4").interceptionsThrown, 1);
  assert.equal(stats.get("away-21").rushingYards, 9);
});

test("tracks third- and fourth-down conversions only for structured offensive snaps", () => {
  const plays = [
    { team: "home", playType: "Run", down: 3, distance: 7, yards: 8, tag: "FIRST DOWN" },
    { team: "home", playType: "Run", down: 3, distance: 7, yards: 4 },
    { team: "home", playType: "Pass", down: 3, distance: 7, passResult: "Complete", yards: 9, tag: "FIRST DOWN" },
    { team: "home", playType: "Pass", down: 3, distance: 8, passResult: "Sacked", yards: -7 },
    { team: "home", playType: "Pass", down: 3, distance: 8, passResult: "Interception", yards: 0 },
    { team: "home", playType: "Run", down: 3, yards: 1, tag: "TOUCHDOWN" },
    { team: "home", playType: "Run", down: 4, distance: 2, yards: 3, tag: "FIRST DOWN" },
    { team: "home", playType: "Pass", down: 4, distance: 5, passResult: "Incomplete", yards: 0 },
    { team: "home", playType: "Special", down: 4, details: { specialTeams: { subtype: "Punt" } } },
    { team: "home", playType: "Special", down: 4, details: { specialTeams: { subtype: "Field goal" } } },
    { team: "home", playType: "Penalty", down: 3, details: { penalty: { accepted: true, automaticFirstDown: true, playCounts: true } } },
    { team: "home", playType: "Run", yards: 20, tag: "FIRST DOWN" },
    { team: "home", playType: "Run", down: 3, details: { playCounts: false }, tag: "FIRST DOWN" },
    { team: "away", playType: "Run", down: 3, distance: 1, yards: 2, tag: "FIRST DOWN" },
  ];
  const home = calculateTeamSummary(plays, "home");
  const away = calculateTeamSummary(plays, "away");
  assert.deepEqual({ attempts: home.thirdDownAttempts, conversions: home.thirdDownConversions, rate: home.thirdDownRate }, { attempts: 6, conversions: 3, rate: 50 });
  assert.deepEqual({ attempts: home.fourthDownAttempts, conversions: home.fourthDownConversions, rate: home.fourthDownRate }, { attempts: 2, conversions: 1, rate: 50 });
  assert.deepEqual({ attempts: away.thirdDownAttempts, conversions: away.thirdDownConversions }, { attempts: 1, conversions: 1 });
});

test("recalculates conversions after correcting down or result", () => {
  const play = { team: "home", playType: "Run", down: 2, distance: 3, yards: 3 };
  assert.equal(calculateTeamSummary([play], "home").thirdDownAttempts, 0);
  play.down = 3;
  assert.deepEqual({ attempts: calculateTeamSummary([play], "home").thirdDownAttempts, conversions: calculateTeamSummary([play], "home").thirdDownConversions }, { attempts: 1, conversions: 0 });
  play.tag = "FIRST DOWN";
  assert.equal(calculateTeamSummary([play], "home").thirdDownConversions, 1);
});

test("uses frozen pre-play down and unambiguous field side for commentary statistics", () => {
  const frozenPlay = { id: 1, team: "home", playType: "Run", period: "2", clock: "06:14", down: 3, distance: 4, ballOn: "LIN 18", yards: 5, tag: "FIRST DOWN" };
  assert.deepEqual({ attempts: calculateTeamSummary([frozenPlay], "home").thirdDownAttempts, conversions: calculateTeamSummary([frozenPlay], "home").thirdDownConversions }, { attempts: 1, conversions: 1 });
  assert.equal(filterTimelinePlays([frozenPlay])[0].clock, "06:14");
  assert.equal(parseBallPosition("LIN 18", "home", { home: "TAY", away: "LIN" }).redZone, true);
  assert.equal(parseBallPosition("TAY 18", "home", { home: "TAY", away: "LIN" }).redZone, false);
});

test("filters a chronological timeline by category, quarter, and player search", () => {
  const plays = [
    { id: 1, team: "home", period: "1", playType: "Run", playerNumber: "22", yards: 20, description: "#22 Jalen Price rush for 20 yards" },
    { id: 2, team: "home", period: "1", playType: "Pass", passerNumber: "5", receiverNumber: "68", passResult: "Complete", yards: 25, tag: "TOUCHDOWN", description: "#5 pass to #68 for touchdown" },
    { id: 3, team: "away", period: "2", playType: "Pass", passResult: "Interception", details: { turnoverDetail: { interceptionReturnYards: 20 } }, description: "intercepted" },
    { id: 4, team: "away", playType: "Penalty", description: "Holding" },
    { id: 5, team: "away", period: "2", playType: "Special", details: { specialTeams: { subtype: "Punt", result: "Returned", distance: 48, returnYards: 21 } }, description: "punt returned" },
  ];
  assert.deepEqual(filterTimelinePlays(plays).map((play) => play.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(filterTimelinePlays(plays, { category: "Scoring" }).map((play) => play.id), [2]);
  assert.deepEqual(filterTimelinePlays(plays, { category: "Turnovers" }).map((play) => play.id), [3]);
  assert.deepEqual(filterTimelinePlays(plays, { category: "Penalties" }).map((play) => play.id), [4]);
  assert.deepEqual(filterTimelinePlays(plays, { category: "Special Teams" }).map((play) => play.id), [5]);
  assert.deepEqual(filterTimelinePlays(plays, { period: "Q1" }).map((play) => play.id), [1, 2]);
  assert.equal(filterTimelinePlays(plays, { period: "All" }).some((play) => play.id === 4), true);
  assert.deepEqual(filterTimelinePlays(plays, { query: "Jalen", rosters: { home: [["22", "Jalen Price", "RB"]] } }).map((play) => play.id), [1]);
  assert.deepEqual(filterTimelinePlays(plays, { query: "#68" }).map((play) => play.id), [2]);
  assert.equal(isExplosivePlay(plays[0]), true);
  assert.equal(isExplosivePlay(plays[1]), true);
  assert.equal(isExplosivePlay({ playType: "Run", yards: 19 }), false);
  assert.equal(isExplosivePlay({ playType: "Pass", passResult: "Complete", yards: 24 }), false);
  assert.equal(buildScoringSummary(plays).length, 1);
});

test("builds longest-play and separate team commentary summaries", () => {
  const plays = [
    { id: 1, team: "home", playType: "Run", yards: 12 }, { id: 2, team: "home", playType: "Run", yards: 24 },
    { id: 3, team: "away", playType: "Pass", passResult: "Complete", yards: 31 },
    { id: 4, team: "home", playType: "Special", details: { specialTeams: { subtype: "Punt", result: "Returned", distance: 52, returnYards: 22 } } },
    { id: 5, team: "away", playType: "Special", details: { specialTeams: { subtype: "Kickoff", result: "Returned", returnYards: 35 } } },
  ];
  const longest = buildLongestPlaySummary(plays);
  assert.equal(longest.home.run.id, 2);
  assert.equal(longest.away.completion.id, 3);
  assert.equal(longest.punt.id, 4);
  assert.equal(longest.puntReturn.id, 4);
  assert.equal(longest.kickoffReturn.id, 5);
  assert.equal(calculateTeamSummary(plays, "home").plays, 2);
  assert.equal(calculateTeamSummary(plays, "away").plays, 1);
});

test("infers common drive endings and excludes non-offensive yards", () => {
  const drives = buildDriveSummaries([
    { id: 1, team: "home", period: "1", clock: "10:00", playType: "Run", yards: 8 },
    { id: 2, team: "home", period: "1", clock: "09:20", playType: "Penalty", yards: 0 },
    { id: 3, team: "home", period: "1", clock: "08:50", playType: "Pass", passResult: "Complete", yards: 22, tag: "TOUCHDOWN" },
    { id: 4, team: "away", playType: "Run", yards: 3 },
    { id: 5, team: "away", playType: "Special", details: { specialTeams: { subtype: "Punt", distance: 40 } } },
    { id: 6, team: "home", playType: "Pass", passResult: "Interception", yards: 0 },
    { id: 7, team: "away", playType: "Run", yards: 4, tag: "FUMBLE LOST" },
    { id: 8, team: "home", playType: "Run", yards: 5 },
  ]);
  assert.deepEqual(drives.map((drive) => drive.result), ["Touchdown", "Punt", "Interception", "Fumble", "In Progress"]);
  assert.deepEqual({ plays: drives[0].plays, yards: drives[0].yards }, { plays: 2, yards: 30 });
});

test("summarizes recognized red-zone trips and safely excludes unknown ball positions", () => {
  const codes = { home: "TAY", away: "LIN" };
  const summary = buildRedZoneSummary([
    { id: 1, team: "home", playType: "Run", ballOn: "LIN 20", yards: 4 },
    { id: 2, team: "home", playType: "Run", ballOn: "LIN 16", yards: 16, tag: "TOUCHDOWN" },
    { id: 3, team: "away", playType: "Run", ballOn: "TAY 18", yards: 2 },
    { id: 4, team: "away", playType: "Special", details: { specialTeams: { subtype: "Field goal", result: "Made" } } },
    { id: 5, team: "home", playType: "Run", ballOn: "LIN 12", yards: 1 },
    { id: 6, team: "away", playType: "Run", ballOn: "UNKNOWN", yards: 2 },
  ], codes);
  assert.deepEqual({ trips: summary.home.trips, touchdowns: summary.home.touchdowns, empty: summary.home.empty }, { trips: 2, touchdowns: 1, empty: 1 });
  assert.deepEqual({ trips: summary.away.trips, fieldGoals: summary.away.fieldGoals }, { trips: 1, fieldGoals: 1 });
});
