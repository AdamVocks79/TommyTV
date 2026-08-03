export type RosterPlayer = string[];

function jerseyNumber(row: RosterPlayer) {
  const parsed = Number.parseInt(row[0], 10);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export function sortRoster(rows: RosterPlayer[]) {
  return [...rows].sort((a, b) => jerseyNumber(a) - jerseyNumber(b) || a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}

export function positionMatches(playType: string, position: string) {
  const value = position.toUpperCase();
  if (playType === "Run") return /^(RB|FB|HB|TB|QB)$/.test(value);
  if (playType === "Pass") return /^(WR|TE|RB|FB|HB)$/.test(value);
  if (playType === "Sack") return value === "QB";
  if (playType === "Special") return /^(KR|PR|K|P|WR|RB|DB)$/.test(value);
  return false;
}

export function samePlayer(a: RosterPlayer, b: RosterPlayer) {
  return a[0] === b[0] && a[1] === b[1];
}

export function jerseyMatches(rows: RosterPlayer[], entry: string) {
  return entry ? rows.filter((row) => row[0].startsWith(entry)) : [];
}

export function autoSelectedJerseyPlayer(rows: RosterPlayer[], entry: string) {
  const exact = rows.filter((row) => row[0] === entry);
  const longerMatch = rows.some((row) => row[0].startsWith(entry) && row[0] !== entry);
  return exact.length === 1 && !longerMatch ? exact[0] : null;
}
