const otherTeam = (team) => team === "away" ? "home" : "away";

export function calculateTeamSummary(plays, team) {
  const owned = plays.filter((play) => (play.team ?? "home") === team);
  const offensive = owned.filter((play) => play.playType === "Run" || play.playType === "Pass");
  const rushing = offensive.filter((play) => play.playType === "Run").reduce((sum, play) => sum + Number(play.yards || 0), 0);
  const passing = offensive.filter((play) => play.playType === "Pass" && play.passResult === "Complete").reduce((sum, play) => sum + Number(play.yards || 0), 0);
  const sackLoss = offensive.filter((play) => play.playType === "Pass" && play.passResult === "Sacked").reduce((sum, play) => sum + Math.abs(Number(play.yards || 0)), 0);
  const punts = owned.filter((play) => play.details?.specialTeams?.subtype === "Punt");
  const penalties = plays.filter((play) => play.details?.penalty?.team === team && play.details.penalty.accepted);
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
