import assert from "node:assert/strict";
import test from "node:test";
import { calculatePlayerStats, calculateTeamSummary } from "../app/football-statistics.mjs";

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
