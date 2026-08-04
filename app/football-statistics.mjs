const otherTeam = (team) => team === "away" ? "home" : "away";
export const EXPLOSIVE_THRESHOLDS = { run: 20, pass: 25, puntReturn: 20, kickoffReturn: 30, interceptionReturn: 20 };

export function isSpecialTeamsPlay(play) { return play.playType === "Special" || Boolean(play.details?.specialTeams); }
export function isTurnoverPlay(play) {
  const special = play.details?.specialTeams;
  return play.passResult === "Interception" || play.tag === "INTERCEPTION" || play.tag === "FUMBLE LOST" || (special?.subtype === "Kickoff" && String(special.result || "").startsWith("Onside") && special.result === "Onside kicking team");
}
export function isScoringPlay(play) {
  const special = play.details?.specialTeams;
  return play.tag === "TOUCHDOWN" || Boolean(play.details?.turnoverDetail?.returnTouchdown) || Boolean(special?.returnTouchdown) || (special?.subtype === "Field goal" && special.result === "Made") || (special?.subtype === "Try" && special.result === "Made");
}
export function isExplosivePlay(play) {
  const special = play.details?.specialTeams;
  if (play.playType === "Run") return Number(play.yards || 0) >= EXPLOSIVE_THRESHOLDS.run;
  if (play.playType === "Pass" && play.passResult === "Complete") return Number(play.yards || 0) >= EXPLOSIVE_THRESHOLDS.pass;
  if (special?.subtype === "Punt" && special.result === "Returned") return Number(special.returnYards || 0) >= EXPLOSIVE_THRESHOLDS.puntReturn;
  if (special?.subtype === "Kickoff" && special.result === "Returned") return Number(special.returnYards || 0) >= EXPLOSIVE_THRESHOLDS.kickoffReturn;
  return Number(play.details?.turnoverDetail?.interceptionReturnYards || 0) >= EXPLOSIVE_THRESHOLDS.interceptionReturn;
}

export function filterTimelinePlays(plays, { category = "All", period = "All", query = "", rosters = {} } = {}) {
  const categoryMatch = (play) => category === "All" || (category === "Scoring" && isScoringPlay(play)) || (category === "Turnovers" && isTurnoverPlay(play)) || (category === "Penalties" && play.playType === "Penalty") || (category === "Special Teams" && isSpecialTeamsPlay(play)) || (category === "Explosive Plays" && isExplosivePlay(play));
  const term = query.trim().toLowerCase();
  return plays.filter((play) => categoryMatch(play) && (period === "All" || String(play.period || "").toUpperCase() === String(period).replace(/^Q/, "")) && (!term || (() => {
    const roster = rosters[play.team ?? "home"] ?? [];
    const numbers = [play.playerNumber, play.passerNumber, play.receiverNumber, play.details?.specialTeams?.actorNumber, play.details?.specialTeams?.returnerNumber].filter(Boolean);
    const names = roster.filter((row) => numbers.includes(row[0])).map((row) => row[1]);
    return [play.description, ...numbers.map((number) => `#${number}`), ...numbers, ...names].join(" ").toLowerCase().includes(term);
  })()));
}

function offenseYards(play) {
  if (play.playType === "Run") return Number(play.yards || 0);
  if (play.playType === "Pass" && play.passResult === "Complete") return Number(play.yards || 0);
  if (play.playType === "Pass" && play.passResult === "Sacked") return -Math.abs(Number(play.yards || 0));
  return 0;
}

function driveResult(play) {
  const special = play.details?.specialTeams;
  if (play.tag === "TOUCHDOWN") return "Touchdown";
  if (special?.subtype === "Field goal") return special.result === "Made" ? "Field Goal" : "Missed Field Goal";
  if (special?.subtype === "Punt") return "Punt";
  if (play.passResult === "Interception") return "Interception";
  if (play.tag === "FUMBLE LOST") return "Fumble";
  return null;
}

export function buildDriveSummaries(plays) {
  const drives = [];
  let current = null;
  const finish = (result) => { if (!current) return; current.result = result || "Unknown"; delete current.lastPlay; drives.push(current); current = null; };
  for (const play of plays) {
    const team = play.team ?? "home";
    if (current && String(current.endPeriod) === "2" && String(play.period) === "3") finish("End of Half");
    if (!current || current.team !== team) {
      if (current) {
        const last = current.lastPlay;
        const downs = last?.down === 4 && (last.playType === "Run" || last.playType === "Pass") && last.tag !== "FIRST DOWN" && last.tag !== "TOUCHDOWN";
        finish(downs ? "Downs" : "Unknown");
      }
      current = { number: drives.length + 1, team, plays: 0, yards: 0, startPeriod: play.period, startClock: play.clock, endPeriod: play.period, endClock: play.clock, result: "In Progress", playIds: [] };
    }
    current.endPeriod = play.period; current.endClock = play.clock; current.playIds.push(play.id); current.lastPlay = play;
    if (play.playType === "Run" || play.playType === "Pass") { current.plays += 1; current.yards += offenseYards(play); }
    const result = driveResult(play);
    if (result) finish(result);
  }
  if (current) drives.push(current);
  return drives;
}

export function buildScoringSummary(plays) {
  return plays.filter(isScoringPlay).map((play) => {
    const special = play.details?.specialTeams;
    const returnScore = play.details?.turnoverDetail?.returnTouchdown || special?.returnTouchdown;
    const team = returnScore ? otherTeam(play.team ?? "home") : play.team ?? "home";
    const type = play.tag === "TOUCHDOWN" || returnScore ? "Touchdown" : special?.subtype === "Field goal" ? "Field Goal" : special?.tryType || "Try";
    return { playId: play.id, period: play.period, clock: play.clock, team, type, description: play.description };
  });
}

export function buildLongestPlaySummary(plays) {
  const byTeam = (team, predicate, value) => plays.filter((play) => (play.team ?? "home") === team && predicate(play)).reduce((best, play) => !best || value(play) > value(best) ? play : best, null);
  const specialLongest = (subtype, result, value) => plays.filter((play) => play.details?.specialTeams?.subtype === subtype && (!result || play.details.specialTeams.result === result)).reduce((best, play) => !best || value(play) > value(best) ? play : best, null);
  return {
    home: { run: byTeam("home", (p) => p.playType === "Run", (p) => Number(p.yards || 0)), completion: byTeam("home", (p) => p.playType === "Pass" && p.passResult === "Complete", (p) => Number(p.yards || 0)) },
    away: { run: byTeam("away", (p) => p.playType === "Run", (p) => Number(p.yards || 0)), completion: byTeam("away", (p) => p.playType === "Pass" && p.passResult === "Complete", (p) => Number(p.yards || 0)) },
    punt: specialLongest("Punt", null, (p) => Number(p.details.specialTeams.distance || 0)),
    puntReturn: specialLongest("Punt", "Returned", (p) => Number(p.details.specialTeams.returnYards || 0)),
    kickoffReturn: specialLongest("Kickoff", "Returned", (p) => Number(p.details.specialTeams.returnYards || 0)),
  };
}

export function parseBallPosition(ballOn, offense, codes) {
  const match = String(ballOn || "").trim().toUpperCase().match(/^([A-Z0-9]{1,4})\s+(\d{1,2})$/);
  if (!match) return null;
  const ownCode = String(codes?.[offense] || "").toUpperCase();
  const opponent = otherTeam(offense);
  const opponentCode = String(codes?.[opponent] || "").toUpperCase();
  const yard = Number(match[2]);
  if (match[1] === opponentCode && yard <= 20) return { redZone: true, yard };
  if (match[1] === ownCode || match[1] === opponentCode) return { redZone: false, yard };
  return null;
}

export function buildRedZoneSummary(plays, codes) {
  const result = { home: { trips: 0, touchdowns: 0, fieldGoals: 0, empty: 0, touchdownRate: 0 }, away: { trips: 0, touchdowns: 0, fieldGoals: 0, empty: 0, touchdownRate: 0 } };
  const byId = new Map(plays.map((play) => [play.id, play]));
  for (const drive of buildDriveSummaries(plays)) {
    const drivePlays = drive.playIds.map((id) => byId.get(id)).filter(Boolean);
    if (!drivePlays.some((play) => (play.playType === "Run" || play.playType === "Pass") && parseBallPosition(play.ballOn, drive.team, codes)?.redZone)) continue;
    const totals = result[drive.team]; totals.trips += 1;
    if (drive.result === "Touchdown") totals.touchdowns += 1;
    else if (drive.result === "Field Goal") totals.fieldGoals += 1;
    else totals.empty += 1;
  }
  for (const team of ["home", "away"]) result[team].touchdownRate = result[team].trips ? result[team].touchdowns / result[team].trips * 100 : 0;
  return result;
}

export function calculateTeamSummary(plays, team) {
  const owned = plays.filter((play) => (play.team ?? "home") === team);
  const offensive = owned.filter((play) => play.playType === "Run" || play.playType === "Pass");
  const rushing = offensive.filter((play) => play.playType === "Run").reduce((sum, play) => sum + Number(play.yards || 0), 0);
  const passing = offensive.filter((play) => play.playType === "Pass" && play.passResult === "Complete").reduce((sum, play) => sum + Number(play.yards || 0), 0);
  const sackLoss = offensive.filter((play) => play.playType === "Pass" && play.passResult === "Sacked").reduce((sum, play) => sum + Math.abs(Number(play.yards || 0)), 0);
  const punts = owned.filter((play) => play.details?.specialTeams?.subtype === "Punt");
  const penalties = plays.filter((play) => play.details?.penalty?.team === team && play.details.penalty.accepted);
  // Conversion attempts require a structured pre-play down and a real offensive snap;
  // standalone penalty and special-teams records never count in the current model.
  const conversions = (down) => {
    const attempts = offensive.filter((play) => play.down === down && play.details?.playCounts !== false);
    const made = attempts.filter((play) => play.tag === "FIRST DOWN" || play.tag === "TOUCHDOWN").length;
    return { attempts: attempts.length, conversions: made, rate: attempts.length ? made / attempts.length * 100 : 0 };
  };
  const third = conversions(3);
  const fourth = conversions(4);
  return {
    plays: offensive.length, ledgerRecords: owned.length,
    rushingFirstDowns: offensive.filter((play) => play.playType === "Run" && play.tag === "FIRST DOWN").length,
    passingFirstDowns: offensive.filter((play) => play.playType === "Pass" && play.tag === "FIRST DOWN").length,
    penaltyFirstDowns: plays.filter((play) => play.details?.penalty?.team === otherTeam(team) && play.details.penalty.accepted && play.details.penalty.automaticFirstDown).length,
    yards: rushing + passing - sackLoss, rushing, passing,
    touchdowns: offensive.filter((play) => play.tag === "TOUCHDOWN").length,
    turnovers: offensive.filter((play) => play.tag === "FUMBLE LOST" || play.passResult === "Interception").length,
    penalties: penalties.length,
    penaltyYards: penalties.reduce((sum, play) => sum + Number(play.details.penalty.yards || 0), 0),
    punts: punts.length,
    puntAverage: punts.length ? punts.reduce((sum, play) => sum + Number(play.details.specialTeams.distance || 0), 0) / punts.length : 0,
    thirdDownAttempts: third.attempts, thirdDownConversions: third.conversions, thirdDownRate: third.rate,
    fourthDownAttempts: fourth.attempts, fourthDownConversions: fourth.conversions, fourthDownRate: fourth.rate,
  };
}

export function calculatePlayerStats(plays) {
  const stats = new Map();
  const credit = (team, number, values) => {
    if (!number) return;
    const key = `${team}-${number}`;
    const current = stats.get(key) ?? {
      team, number, plays: 0, yards: 0, rushingYards: 0, passingYards: 0,
      receivingYards: 0, attempts: 0, completions: 0, receptions: 0,
      interceptionsThrown: 0, touchdowns: 0, fumbles: 0, fumblesLost: 0,
      soloTackles: 0, assistedTackles: 0, tackles: 0, sacks: 0,
      tacklesForLoss: 0, forcedFumbles: 0, fumbleRecoveries: 0,
      interceptions: 0, passBreakups: 0,
    };
    for (const [field, amount] of Object.entries(values)) current[field] += amount;
    stats.set(key, current);
  };

  for (const play of plays) {
    const offense = play.team ?? "home";
    const defense = otherTeam(offense);
    if (play.playType === "Pass" && play.passerNumber) {
      const complete = play.passResult === "Complete";
      const sack = play.passResult === "Sacked";
      credit(offense, play.passerNumber, {
        plays: 1, attempts: sack ? 0 : 1, completions: complete ? 1 : 0,
        interceptionsThrown: play.passResult === "Interception" ? 1 : 0,
        passingYards: complete ? Number(play.yards || 0) : 0,
        yards: complete ? Number(play.yards || 0) : 0,
      });
      if (complete && play.receiverNumber) credit(offense, play.receiverNumber, {
        plays: 1, receptions: 1, receivingYards: Number(play.yards || 0),
        yards: Number(play.yards || 0), touchdowns: play.tag === "TOUCHDOWN" ? 1 : 0,
      });
      if (play.tag === "FUMBLE LOST") {
        const responsible = complete && play.receiverNumber ? play.receiverNumber : play.passerNumber;
        credit(offense, responsible, { fumbles: 1, fumblesLost: 1 });
      }
    } else if (play.playType === "Run" && play.playerNumber) {
      credit(offense, play.playerNumber, {
        plays: 1, yards: Number(play.yards || 0), rushingYards: Number(play.yards || 0),
        touchdowns: play.tag === "TOUCHDOWN" ? 1 : 0,
        fumbles: play.tag === "FUMBLE LOST" ? 1 : 0, fumblesLost: play.tag === "FUMBLE LOST" ? 1 : 0,
      });
    }

    const detail = play.details?.defensiveCredits ?? {};
    const primary = detail.primary ?? play.details?.tacklers?.[0];
    const assists = detail.assists ?? play.details?.tacklers?.slice(1) ?? [];
    if (primary) credit(defense, primary, { soloTackles: 1, tackles: 1 });
    for (const number of assists) credit(defense, number, { assistedTackles: 1, tackles: 1 });
    for (const number of detail.sack ?? []) credit(defense, number, { sacks: 1 });
    for (const number of detail.tackleForLoss ?? []) credit(defense, number, { tacklesForLoss: 1 });
    if (detail.forcedFumble) credit(defense, detail.forcedFumble, { forcedFumbles: 1 });
    if (detail.passBreakup) credit(defense, detail.passBreakup, { passBreakups: 1 });
    if (play.details?.turnoverDetail?.interceptorNumber) credit(defense, play.details.turnoverDetail.interceptorNumber, { interceptions: 1 });
    if (play.details?.turnoverDetail?.recovererNumber) credit(defense, play.details.turnoverDetail.recovererNumber, { fumbleRecoveries: 1 });
  }
  return stats;
}
