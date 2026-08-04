"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { autoSelectedJerseyPlayer, jerseyMatches, positionMatches, samePlayer, sortRoster } from "./player-selection";
import { buildDriveSummaries, buildLongestPlaySummary, buildRedZoneSummary, buildScoringSummary, calculatePlayerStats, calculateTeamSummary, filterTimelinePlays, isExplosivePlay, isScoringPlay, isSpecialTeamsPlay, isTurnoverPlay } from "./football-statistics.mjs";

type Role = "entry-primary" | "entry-detail" | "pxp" | "timeline" | "control" | "admin";
type PassResult = "Complete" | "Incomplete" | "Sacked" | "Interception";
type PlaySnapshot = { period?: string; clock?: string; down?: number; distance?: number; ballOn?: string; possession?: "home" | "away"; homeScore?: number; awayScore?: number; capturedAt: string; source: "mqtt" | "manual" | "mixed" | "unavailable" };
type PlayDetails = {
  tacklers?: string[]; flags?: string[];
  defensiveCredits?: { primary?: string; assists?: string[]; sack?: string[]; tackleForLoss?: string[]; forcedFumble?: string; passBreakup?: string };
  turnoverDetail?: { interceptorNumber?: string; interceptionReturnYards?: number; returnTouchdown?: boolean; recovererNumber?: string };
  penalty?: { team: "home" | "away"; name: string; accepted: boolean; yards: number; automaticFirstDown: boolean; playCounts: boolean };
  specialTeams?: { subtype: string; result: string; actorNumber: string; returnerNumber?: string; distance?: number; returnYards?: number; returnTouchdown?: boolean; tryType?: string; passerNumber?: string; receiverNumber?: string };
};
type Play = {
  id: number;
  clock: string;
  situation: string;
  down?: number;
  distance?: number;
  ballOn?: string;
  period?: string;
  description: string;
  tag?: string;
  status: "logged" | "confirmed";
  playType?: string;
  playerNumber?: string;
  passerNumber?: string;
  receiverNumber?: string;
  passResult?: PassResult;
  yards?: number;
  details?: PlayDetails;
  team?: "home" | "away";
};

const roles: { id: Role; label: string; short: string }[] = [
  { id: "entry-primary", label: "Primary Stats", short: "ENTRY" },
  { id: "entry-detail", label: "Defensive Detail", short: "DETAIL" },
  { id: "pxp", label: "PxP Panel", short: "PXP" },
  { id: "timeline", label: "Game Timeline", short: "TIMELINE" },
  { id: "control", label: "TommyTV Control", short: "TV" },
  { id: "admin", label: "Game Setup", short: "SETUP" },
];

type GameContextValue = {
  plays: Play[];
  setPlays: React.Dispatch<React.SetStateAction<Play[]>>;
  homeName: string;
  setHomeName: (name: string) => void;
  awayName: string;
  setAwayName: (name: string) => void;
  homeCode: string;
  setHomeCode: (code: string) => void;
  awayCode: string;
  setAwayCode: (code: string) => void;
  rosterRows: string[][];
  setRosterRows: (rows: string[][]) => void;
  awayRosterRows: string[][];
  setAwayRosterRows: (rows: string[][]) => void;
  scoreboard: Record<string, string | number | boolean | null>;
  backendOnline: boolean;
  saveGame: () => Promise<void>;
  saveRoster: (team: "home" | "away", rows: string[][]) => Promise<void>;
  createPlay: (play: Omit<Play, "id" | "status"> & { team: "home" | "away"; playType: string; yards: number }) => Promise<boolean>;
  updatePlay: (play: Play) => Promise<boolean>;
  deletePlay: (id: number) => Promise<void>;
  confirmPlay: (id: number, detail: PlayDetails) => Promise<boolean>;
  exportCurrentGame: () => Promise<boolean>;
  resetGame: (keepTeamsAndRosters: boolean, confirmation: string) => Promise<boolean>;
  toast: string;
  notify: (message: string) => void;
};

const GameContext = createContext<GameContextValue | null>(null);

function useGame() {
  const value = useContext(GameContext);
  if (!value) throw new Error("Game context is unavailable");
  return value;
}

function parseRoster(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const cells = line.includes("\t")
        ? line.split("\t")
        : line.includes(",")
          ? line.split(",")
          : line.split(/\s{2,}/);
      return cells.map((cell) => cell.trim()).filter(Boolean);
    })
    .filter((row) => row.length >= 2 && !/^(number|#)$/i.test(row[0]));
}

function apiUrl(path: string) {
  return `/api/game${path.replace(/^\/api/, "")}`;
}

function scoreboardNumber(value: unknown, minimum: number, maximum?: number) {
  if (value == null || String(value).trim() === "") return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && (maximum == null || number <= maximum) ? number : undefined;
}

async function apiRequest(path: string, options?: RequestInit) {
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || "Request failed");
  }
  if (response.status === 204) return null;
  return response.json();
}

function GameProvider({ children }: { children: React.ReactNode }) {
  const [plays, setPlays] = useState<Play[]>([]);
  const [homeName, setHomeName] = useState("");
  const [awayName, setAwayName] = useState("");
  const [homeCode, setHomeCode] = useState("");
  const [awayCode, setAwayCode] = useState("");
  const [rosterRows, setRosterRows] = useState<string[][]>([]);
  const [awayRosterRows, setAwayRosterRows] = useState<string[][]>([]);
  const [scoreboard, setScoreboard] = useState<Record<string, string | number | boolean | null>>({});
  const [backendOnline, setBackendOnline] = useState(false);
  const [toast, setToast] = useState("");

  const applyState = useCallback((state: {
    game?: { homeName?: string; awayName?: string; homeCode?: string; awayCode?: string };
    rosters?: { home?: string[][]; away?: string[][] };
    plays?: Play[];
    scoreboard?: { connected?: boolean; stale?: boolean; payload?: Record<string, string | number | boolean | null> };
  }) => {
    setHomeName(state.game?.homeName ?? "");
    setAwayName(state.game?.awayName ?? "");
    setHomeCode(state.game?.homeCode ?? "");
    setAwayCode(state.game?.awayCode ?? "");
    setRosterRows(state.rosters?.home ?? []);
    setAwayRosterRows(state.rosters?.away ?? []);
    setPlays(state.plays ?? []);
    setScoreboard({
      ...(state.scoreboard?.payload ?? {}),
      _connected: Boolean(state.scoreboard?.connected),
      _stale: Boolean(state.scoreboard?.stale),
    });
    setBackendOnline(true);
  }, []);

  useEffect(() => {
    let active = true;
    apiRequest("/api/state")
      .then((state) => { if (active) applyState(state); })
      .catch(() => { if (active) setBackendOnline(false); });
    const events = new EventSource(apiUrl("/api/events"));
    events.addEventListener("state", (event) => {
      if (!active) return;
      applyState(JSON.parse((event as MessageEvent).data));
    });
    events.onerror = () => { if (active) setBackendOnline(false); };
    return () => {
      active = false;
      events.close();
    };
  }, [applyState]);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }

  async function saveGame() {
    try {
      const state = await apiRequest("/api/game", {
        method: "PUT",
        body: JSON.stringify({ homeName, awayName, homeCode, awayCode }),
      });
      applyState(state);
      notify("Game setup saved to SQLite");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not save game setup");
    }
  }

  async function saveRoster(team: "home" | "away", rows: string[][]) {
    try {
      const state = await apiRequest(`/api/rosters/${team}`, {
        method: "PUT",
        body: JSON.stringify({ rows }),
      });
      applyState(state);
      notify(`${rows.length} ${team} players saved to SQLite`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not save roster");
    }
  }

  async function createPlay(play: Omit<Play, "id" | "status"> & { team: "home" | "away"; playType: string; yards: number }) {
    try {
      const result = await apiRequest("/api/plays", { method: "POST", body: JSON.stringify(play) });
      applyState(result.state);
      notify(`Play ${result.id} saved to SQLite`);
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not save play");
      return false;
    }
  }

  async function updatePlay(play: Play) {
    try {
      const state = await apiRequest(`/api/plays/${play.id}`, { method: "PUT", body: JSON.stringify(play) });
      applyState(state);
      notify(`Play ${play.id} corrected`);
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not update play");
      return false;
    }
  }

  async function deletePlay(id: number) {
    try {
      await apiRequest(`/api/plays/${id}`, { method: "DELETE" });
      setPlays((current) => current.filter((play) => play.id !== id));
      notify(`Play ${id} deleted`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not delete play");
    }
  }

  async function confirmPlay(id: number, detail: PlayDetails) {
    try {
      const state = await apiRequest(`/api/plays/${id}/confirm`, {
        method: "POST",
        body: JSON.stringify(detail),
      });
      applyState(state);
      notify(`Play ${id} defensive detail saved`);
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not save defensive detail");
      return false;
    }
  }

  async function exportCurrentGame() {
    try {
      const response = await fetch(apiUrl("/api/export"));
      if (!response.ok) throw new Error("Could not export game");
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") || "";
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] || "tommytv-game.json";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = filename; link.click();
      URL.revokeObjectURL(url);
      notify("Current game exported");
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not export game");
      return false;
    }
  }

  async function resetGame(keepTeamsAndRosters: boolean, confirmation: string) {
    try {
      const state = await apiRequest("/api/game/reset", { method: "POST", body: JSON.stringify({ keepTeamsAndRosters, confirmation }) });
      applyState(state);
      notify("New game ready");
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not start new game");
      return false;
    }
  }

  return (
    <GameContext.Provider value={{
      plays, setPlays, homeName, setHomeName, awayName, setAwayName,
      homeCode, setHomeCode, awayCode, setAwayCode, rosterRows, setRosterRows,
      awayRosterRows, setAwayRosterRows,
      scoreboard, backendOnline, saveGame, saveRoster, createPlay, updatePlay,
      deletePlay, confirmPlay, exportCurrentGame, resetGame,
      toast, notify,
    }}>
      {children}
      {toast && <div className="toast" role="status">{toast}</div>}
    </GameContext.Provider>
  );
}

function useRole() {
  const pathname = usePathname();
  const path = pathname.replace("/", "") as Role;
  const [role, setRole] = useState<Role>(
    roles.some((item) => item.id === path) ? path : "entry-primary"
  );
  return [role, setRole] as const;
}

function Header({
  role,
  setRole,
}: {
  role: Role;
  setRole: (role: Role) => void;
}) {
  const { homeCode, awayCode, scoreboard, backendOnline } = useGame();
  const mqttLive = Boolean(scoreboard._connected) && !scoreboard._stale;
  const clock = String(scoreboard.clock || "--:--");
  const period = String(scoreboard.period || "–");
  const homeScore = String(scoreboard.home_score || "–");
  const awayScore = String(scoreboard.away_score || "–");
  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">T</span>
          <div>
            <strong>TommyTV</strong>
            <small>Friday Night Stats</small>
          </div>
        </div>
        <div className="score-strip">
          <div className="team away">
            <span className="team-code">{awayCode || "AWAY"}</span>
            <strong>{awayScore}</strong>
          </div>
          <div className="game-clock">
            <span>Q{period}</span>
            <strong>{clock}</strong>
            <small className={mqttLive ? "" : "offline"}><i /> {mqttLive ? "MQTT LIVE" : "MQTT WAITING"}</small>
          </div>
          <div className="team home">
            <strong>{homeScore}</strong>
            <span className="team-code">{homeCode || "HOME"}</span>
          </div>
        </div>
        <div className={backendOnline ? "connection" : "connection offline"}><i /> {backendOnline ? "Game server connected" : "Game server offline"}</div>
      </header>
      <nav className="role-nav" aria-label="Application sections">
        {roles.map((item) => (
          <a
            href={`/${item.id}`}
            key={item.id}
            className={role === item.id ? "active" : ""}
            onClick={(event) => {
              event.preventDefault();
              if (item.id !== role && sessionStorage.getItem("tommytv-pending-play") && !window.confirm("Discard this marked play and leave Primary Stats?")) return;
              if (item.id !== role) sessionStorage.removeItem("tommytv-pending-play");
              window.history.pushState({}, "", `/${item.id}`);
              setRole(item.id);
            }}
          >
            <b>{item.short}</b>
            <span>{item.label}</span>
          </a>
        ))}
      </nav>
    </>
  );
}

function FieldState({ live, marked, onAdjustLive, onResumeMqtt, onToggleOffense, hasManualLive = false }: {
  live?: PlaySnapshot;
  marked?: PlaySnapshot | null;
  onAdjustLive?: () => void;
  onResumeMqtt?: () => void;
  onToggleOffense?: () => void;
  hasManualLive?: boolean;
} = {}) {
  const { scoreboard, homeCode, awayCode, plays } = useGame();
  const state = marked ?? live;
  const possession = state?.possession === "home"
    ? homeCode || "HOME"
    : state?.possession === "away"
      ? awayCode || "AWAY"
      : scoreboard.home_possession
    ? homeCode || "HOME"
    : scoreboard.away_possession
      ? awayCode || "AWAY"
      : "UNSET";
  const source = state?.source ?? (scoreboard._connected ? "mqtt" : "unavailable");
  return (
    <section className={`field-state${marked ? " marked" : ""}`}>
      <div className="field-state-values">
        <div><small>DOWN</small><strong>{String(state?.down || scoreboard.down || "–")}</strong></div>
        <div><small>TO GO</small><strong>{String(state?.distance || scoreboard.to_go || "–")}</strong></div>
        <div><small>BALL ON</small><strong>{String(state?.ballOn || scoreboard.ball_on || "–")}</strong></div>
        {onToggleOffense ? <button className="offense-toggle" aria-label={`Toggle offense between ${homeCode || "home"} and ${awayCode || "away"}`} onClick={onToggleOffense} disabled={!homeCode || !awayCode}><small>OFFENSE</small><strong className="possession">{possession}</strong><span>Tap to change</span></button>
          : <div><small>OFFENSE</small><strong className="possession">{possession}</strong></div>}
      </div>
      <div className="field-state-status">
        {state ? <span className="state-mode">{marked ? <>MARKED PLAY · Q{marked.period || "—"} {marked.clock || "--:--"}</> : "LIVE"}</span> : <span className="state-mode">{plays.length} PLAYS LOGGED</span>}
        {state && <strong className={`source-badge ${source}`}>{source.toUpperCase()}</strong>}
        {!marked && onAdjustLive && <button className="field-state-adjust" aria-label="Adjust live game state" onClick={onAdjustLive}>Adjust</button>}
        {!marked && hasManualLive && onResumeMqtt && <button className="field-state-resume" onClick={onResumeMqtt}>Resume All MQTT</button>}
      </div>
    </section>
  );
}

function PlayList({
  plays,
  onUndo,
  onEdit,
}: {
  plays: Play[];
  onUndo?: () => void;
  onEdit?: (play: Play) => void;
}) {
  return (
    <section className="panel play-panel">
      <div className="panel-title">
        <div><span className="eyebrow">LIVE LEDGER</span><h2>Recent plays</h2></div>
        {onUndo && <button className="quiet-button" onClick={onUndo}>↶ Undo last</button>}
      </div>
      <div className="plays">
        {[...plays].reverse().map((play) => (
          <button className="play-row" key={play.id} onClick={() => onEdit?.(play)}>
            <span className="play-number">{play.id}</span>
            <span className="play-clock">{play.clock}</span>
            <span className="play-copy">
              <small>{play.situation}</small>
              <strong>{play.description}</strong>
            </span>
            {play.tag && <span className="tag">{play.tag}</span>}
            <span className={`play-status ${play.status}`}>
              {play.status === "confirmed" ? "✓" : "DETAIL"}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function PlayerSelect({ label, roster, value, onChange, optional = false }: {
  label: string; roster: string[][]; value?: string; onChange: (number: string) => void; optional?: boolean;
}) {
  return (
    <label><span>{label}</span><select value={value ?? ""} onChange={(event) => onChange(event.target.value)}>
      <option value="">{optional ? "None selected" : `Choose ${label.toLowerCase()}`}</option>
      {sortRoster(roster).map((row, index) => <option key={`${row[0]}-${row[1]}-${index}`} value={row[0]}>#{row[0]} {row[1]}{row[2] ? ` · ${row[2]}` : ""}</option>)}
    </select></label>
  );
}

function SpecialCorrectionFields({ play, setPlay, offenseRoster, receivingRoster }: { play: Play; setPlay: (play: Play) => void; offenseRoster: string[][]; receivingRoster: string[][] }) {
  const current = play.details?.specialTeams ?? { subtype: "Punt", result: "Returned", actorNumber: "" };
  const update = (changes: Partial<NonNullable<PlayDetails["specialTeams"]>>) => setPlay({ ...play, details: { ...play.details, specialTeams: { ...current, ...changes } } });
  const results = current.subtype === "Punt" ? ["Returned", "Fair catch", "Touchback", "Downed", "Out of bounds", "Blocked"] : current.subtype === "Kickoff" ? ["Returned", "Touchback", "Out of bounds", "Onside kicking team", "Onside receiving team"] : current.subtype === "Field goal" ? ["Made", "Missed", "Blocked"] : ["Made", "Failed"];
  const tryType = current.tryType ?? "PAT kick";
  return <>
    <label><span>TYPE</span><select value={current.subtype} onChange={(event) => { const subtype = event.target.value; update({ subtype, result: subtype === "Try" || subtype === "Field goal" ? "Made" : "Returned", actorNumber: "", returnerNumber: "", distance: 0, returnYards: 0, returnTouchdown: false, tryType: subtype === "Try" ? "PAT kick" : undefined, passerNumber: "", receiverNumber: "" }); }}><option>Punt</option><option>Kickoff</option><option>Field goal</option><option>Try</option></select></label>
    {current.subtype === "Try" && <label><span>TRY TYPE</span><select value={tryType} onChange={(event) => update({ tryType: event.target.value, actorNumber: "", passerNumber: "", receiverNumber: "" })}><option>PAT kick</option><option>Two-point run</option><option>Two-point pass</option></select></label>}
    <label><span>RESULT</span><select value={current.result} onChange={(event) => update({ result: event.target.value, returnerNumber: event.target.value === "Returned" ? current.returnerNumber : "", returnYards: event.target.value === "Returned" ? current.returnYards : 0, returnTouchdown: event.target.value === "Returned" && current.returnTouchdown })}>{results.map((result) => <option key={result}>{result}</option>)}</select></label>
    {current.subtype === "Try" && tryType === "Two-point pass" ? <><PlayerSelect label="PASSER" roster={offenseRoster} value={current.passerNumber} onChange={(passerNumber) => update({ passerNumber })} /><PlayerSelect label="RECEIVER" roster={offenseRoster} value={current.receiverNumber} onChange={(receiverNumber) => update({ receiverNumber })} /></> : <PlayerSelect label={current.subtype === "Punt" ? "PUNTER" : current.subtype === "Try" && tryType === "Two-point run" ? "RUNNER" : "KICKER"} roster={offenseRoster} value={current.actorNumber} onChange={(actorNumber) => update({ actorNumber })} />}
    {(current.subtype === "Punt" || current.subtype === "Field goal") && <label><span>DISTANCE</span><input inputMode="numeric" value={current.distance ?? 0} onChange={(event) => update({ distance: Number(event.target.value || 0) })} /></label>}
    {current.result === "Returned" && <><PlayerSelect label="RETURNER" roster={receivingRoster} value={current.returnerNumber} onChange={(returnerNumber) => update({ returnerNumber })} /><label><span>RETURN YARDS</span><input inputMode="numeric" value={current.returnYards ?? 0} onChange={(event) => update({ returnYards: Number(event.target.value || 0) })} /></label><button className={current.returnTouchdown ? "selected" : ""} onClick={() => update({ returnTouchdown: !current.returnTouchdown })}>Return touchdown</button></>}
  </>;
}

function PrimaryEntry() {
  const {
    plays, rosterRows, awayRosterRows, homeCode, awayCode, scoreboard,
    createPlay, updatePlay, deletePlay, notify,
  } = useGame();
  const [playType, setPlayType] = useState("");
  const [snapshot, setSnapshot] = useState<PlaySnapshot | null>(null);
  const [snapshotModal, setSnapshotModal] = useState<"live" | "marked" | null>(null);
  const [snapshotDraft, setSnapshotDraft] = useState<PlaySnapshot | null>(null);
  const [manualLive, setManualLive] = useState<Partial<PlaySnapshot>>({});
  const [passResult, setPassResult] = useState<PassResult>("Complete");
  const [passerNumber, setPasserNumber] = useState("");
  const [receiverNumber, setReceiverNumber] = useState("");
  const scoreboardOffense: "home" | "away" | undefined = scoreboard.away_possession ? "away" : scoreboard.home_possession ? "home" : undefined;
  const liveOffense = manualLive.possession ?? scoreboardOffense;
  const activeOffense = snapshot?.possession ?? liveOffense;
  const activeRoster = useMemo(() => activeOffense === "home" ? rosterRows : activeOffense === "away" ? awayRosterRows : [], [activeOffense, awayRosterRows, rosterRows]);
  const [player, setPlayer] = useState<string[]>(["00", "Choose player", ""]);
  const [recentPlayers, setRecentPlayers] = useState<Record<"home" | "away", string[][]>>({ home: [], away: [] });
  const [jerseyEntry, setJerseyEntry] = useState("");
  const [rosterPickerOpen, setRosterPickerOpen] = useState(false);
  const [rosterFilter, setRosterFilter] = useState("");
  const [yards, setYards] = useState("0");
  const [firstDown, setFirstDown] = useState(false);
  const [touchdown, setTouchdown] = useState(false);
  const [turnover, setTurnover] = useState<"" | "FUMBLE LOST" | "INTERCEPTION">("");
  const [outOfBounds, setOutOfBounds] = useState(false);
  const [specialSubtype, setSpecialSubtype] = useState("Punt");
  const [specialResult, setSpecialResult] = useState("Returned");
  const [returnerNumber, setReturnerNumber] = useState("");
  const [returnYards, setReturnYards] = useState("0");
  const [tryType, setTryType] = useState("PAT kick");
  const [penaltyName, setPenaltyName] = useState("");
  const [penaltyTeam, setPenaltyTeam] = useState<"home" | "away">("home");
  const [penaltyAccepted, setPenaltyAccepted] = useState(true);
  const [penaltyFirstDown, setPenaltyFirstDown] = useState(false);
  const [penaltyPlayCounts, setPenaltyPlayCounts] = useState(false);
  const [editing, setEditing] = useState<Play | null>(null);
  const previousPlayCount = useRef(plays.length);
  const hasEntryData = Boolean(playType || passerNumber || receiverNumber || jerseyEntry || penaltyName || Number(yards) || firstDown || touchdown || turnover || outOfBounds);
  const liveSnapshot = useCallback((): PlaySnapshot => {
    const manual = Object.keys(manualLive).some((key) => !["capturedAt", "source"].includes(key));
    const mqtt = Boolean(scoreboard._connected);
    const value = <T,>(field: keyof PlaySnapshot, fallback: T) => manualLive[field] !== undefined ? manualLive[field] as T : fallback;
    return {
      period: value("period", String(scoreboard.period || "").trim() || undefined),
      clock: value("clock", String(scoreboard.clock || "").trim() || undefined),
      down: value("down", scoreboardNumber(scoreboard.down, 1, 4)),
      distance: value("distance", scoreboardNumber(scoreboard.to_go, 1)),
      ballOn: value("ballOn", String(scoreboard.ball_on || "").trim() || undefined),
      possession: value("possession", scoreboardOffense),
      homeScore: value("homeScore", scoreboardNumber(scoreboard.home_score, 0)),
      awayScore: value("awayScore", scoreboardNumber(scoreboard.away_score, 0)),
      capturedAt: new Date().toISOString(), source: manual && mqtt ? "mixed" : manual ? "manual" : mqtt ? "mqtt" : "unavailable",
    };
  }, [manualLive, scoreboard, scoreboardOffense]);

  function clearEntry() {
    setPlayType(""); setYards("0"); setFirstDown(false); setTouchdown(false); setTurnover(""); setOutOfBounds(false);
    setPasserNumber(""); setReceiverNumber(""); setPenaltyName(""); setReturnerNumber(""); setReturnYards("0"); setJerseyEntry("");
  }
  function markPlay() {
    const frozen = liveSnapshot();
    if (!frozen.possession) return notify("Set the offense before marking the play");
    setPenaltyTeam(frozen.possession); setSnapshot(frozen); sessionStorage.setItem("tommytv-pending-play", "1");
  }
  function discardMarked() {
    if (hasEntryData && !window.confirm("Discard this marked play and all unsaved entry data?")) return;
    clearEntry(); setSnapshot(null); sessionStorage.removeItem("tommytv-pending-play");
  }

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (!snapshot) return; event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [snapshot]);
  useEffect(() => {
    if (snapshot && previousPlayCount.current > 0 && plays.length === 0) { clearEntry(); setSnapshot(null); sessionStorage.removeItem("tommytv-pending-play"); }
    previousPlayCount.current = plays.length;
  }, [plays.length, snapshot]);
  const activePlayer = useMemo(() => activeRoster.some((row) => samePlayer(row, player))
    ? player
    : ["00", "Choose player", ""], [activeRoster, player]);
  const numberMatches = useMemo(() => jerseyMatches(activeRoster, jerseyEntry), [activeRoster, jerseyEntry]);
  const quickPlayers = useMemo(() => {
    const sorted = sortRoster(activeRoster);
    const prioritized = [
      activePlayer,
      ...numberMatches,
      ...(activeOffense ? recentPlayers[activeOffense] : []),
      ...sorted.filter((row) => positionMatches(playType, row[2] ?? "")),
      ...sorted,
    ];
    return prioritized.filter((row, index) =>
      activeRoster.some((candidate) => samePlayer(candidate, row)) &&
      prioritized.findIndex((candidate) => samePlayer(candidate, row)) === index
    ).slice(0, 8);
  }, [activePlayer, activeOffense, activeRoster, numberMatches, playType, recentPlayers]);
  const filteredRoster = useMemo(() => {
    const query = rosterFilter.trim().toLowerCase();
    return sortRoster(activeRoster).filter((row) =>
      !query || row[0].includes(query) || row[1].toLowerCase().includes(query)
    );
  }, [activeRoster, rosterFilter]);

  function revalidatePlayers(nextOffense: "home" | "away") {
    const nextRoster = nextOffense === "home" ? rosterRows : awayRosterRows;
    const receivingRoster = nextOffense === "home" ? awayRosterRows : rosterRows;
    const invalidPlayer = !nextRoster.some((row) => samePlayer(row, player)) && player[0] !== "00";
    const invalidPasser = Boolean(passerNumber) && !nextRoster.some((row) => row[0] === passerNumber);
    const invalidReceiver = Boolean(receiverNumber) && !nextRoster.some((row) => row[0] === receiverNumber);
    const invalidReturner = Boolean(returnerNumber) && !receivingRoster.some((row) => row[0] === returnerNumber);
    if (invalidPlayer) setPlayer(["00", "Choose player", ""]);
    if (invalidPasser) setPasserNumber("");
    if (invalidReceiver) setReceiverNumber("");
    if (invalidReturner) setReturnerNumber("");
    setJerseyEntry("");
    setRosterFilter("");
    setRosterPickerOpen(false);
    if (invalidPlayer || invalidPasser || invalidReceiver || invalidReturner) notify("Player selection cleared after offense changed");
  }

  function toggleOffense() {
    if (!homeCode || !awayCode) return notify("Set up both teams before choosing offense");
    const current = snapshot?.possession ?? liveOffense;
    const nextOffense = current === "home" ? "away" : "home";
    if (snapshot) {
      revalidatePlayers(nextOffense);
      setSnapshot({ ...snapshot, possession: nextOffense, source: snapshot.source === "mqtt" ? "mixed" : "manual" });
    } else {
      setManualLive((value) => ({ ...value, possession: nextOffense }));
    }
  }

  function selectPlayer(nextPlayer: string[]) {
    if (!activeOffense) return;
    setPlayer(nextPlayer);
    setJerseyEntry("");
    setRosterPickerOpen(false);
    setRecentPlayers((current) => ({
      ...current,
      [activeOffense]: [nextPlayer, ...current[activeOffense].filter((row) => !samePlayer(row, nextPlayer))].slice(0, 4),
    }));
  }

  function enterJerseyDigit(digit: string) {
    const next = `${jerseyEntry}${digit}`.slice(0, 2);
    setJerseyEntry(next);
    const exact = autoSelectedJerseyPlayer(activeRoster, next);
    if (exact) selectPlayer(exact);
  }

  function playForEditing(play: Play): Play {
    if (play.playType !== "Pass") return { ...play };
    const description = play.description || "";
    const complete = description.match(/^#([^\s]+)\s+.+?\s+complete to\s+#([^\s]+)\b/i);
    const passerOnly = description.match(/^#([^\s]+)\b/);
    const inferredResult: PassResult = /\bintercepted\b/i.test(description)
      ? "Interception"
      : /\bsacked\b/i.test(description)
        ? "Sacked"
      : /\bincomplete\b/i.test(description)
        ? "Incomplete"
        : "Complete";
    return {
      ...play,
      passerNumber: play.passerNumber || complete?.[1] || passerOnly?.[1] || "",
      receiverNumber: play.receiverNumber || complete?.[2] || "",
      passResult: play.passResult || inferredResult,
    };
  }

  async function savePlay() {
    if (!snapshot) return notify("Mark the play first");
    if (!snapshot.possession) return notify("Set the offense before saving the play");
    const verb: Record<string, string> = {
      Run: "rush",
      Pass: "pass",
      Penalty: "penalty",
      Special: "special teams return",
    };
    const modifiers = [
      touchdown ? "touchdown" : "",
      turnover === "FUMBLE LOST" ? "fumble lost" : "",
      turnover === "INTERCEPTION" ? "intercepted" : "",
      outOfBounds ? "out of bounds" : "",
    ].filter(Boolean);
    const passer = activeRoster.find((row) => row[0] === passerNumber);
    const receiver = activeRoster.find((row) => row[0] === receiverNumber);
    if (playType === "Pass" && !passer) return notify("Choose a passer from the offensive roster");
    if (playType === "Pass" && passResult === "Complete" && !receiver) return notify("A complete pass requires a receiver");
    if (playType === "Pass" && passResult === "Sacked" && Number(yards || 0) > 0) return notify("Sack yards must be zero or negative");
    if (playType === "Pass" && passResult !== "Complete" && passResult !== "Sacked" && Number(yards || 0) !== 0) return notify("Incomplete and intercepted passes must have zero yards");
    const description = playType === "Pass"
      ? passResult === "Complete"
        ? `#${passer?.[0]} ${passer?.[1]} complete to #${receiver?.[0]} ${receiver?.[1]} for ${yards || "0"} yards`
        : passResult === "Sacked"
          ? `#${passer?.[0]} ${passer?.[1]} sacked ${Number(yards || 0) < 0 ? `for a loss of ${Math.abs(Number(yards))} yards` : "for no gain"}`
          : `#${passer?.[0]} ${passer?.[1]} ${passResult === "Incomplete" ? "pass incomplete" : "intercepted"}`
      : `#${activePlayer[0]} ${activePlayer[1]} ${verb[playType]} for ${yards || "0"} yards${modifiers.length ? ` · ${modifiers.join(" · ")}` : ""}`;
    const next = {
      // The frozen snapshot supplies the pre-play situation and mark-time clock.
      clock: snapshot.clock || "",
      situation: [
        snapshot.down ? `${snapshot.down}${snapshot.distance ? ` & ${snapshot.distance}` : ""}` : "",
        snapshot.ballOn ? `at ${snapshot.ballOn}` : "",
      ].filter(Boolean).join(" "),
      down: snapshot.down, distance: snapshot.distance, ballOn: snapshot.ballOn, period: snapshot.period,
      description,
      tag: touchdown ? "TOUCHDOWN" : playType === "Pass" && passResult === "Interception" ? "INTERCEPTION" : turnover || (firstDown ? "FIRST DOWN" : undefined),
      team: snapshot.possession,
      playType,
      playerNumber: playType === "Pass" ? "" : activePlayer[0],
      passerNumber: playType === "Pass" ? passerNumber : undefined,
      receiverNumber: playType === "Pass" && (passResult === "Complete" || passResult === "Incomplete") && receiverNumber ? receiverNumber : undefined,
      passResult: playType === "Pass" ? passResult : undefined,
      yards: playType === "Pass" && passResult !== "Complete" && passResult !== "Sacked" ? 0 : Number(yards || 0),
      details: playType === "Penalty" ? { penalty: { team: penaltyTeam, name: penaltyName, accepted: penaltyAccepted, yards: Number(yards || 0), automaticFirstDown: penaltyFirstDown, playCounts: penaltyPlayCounts } }
        : playType === "Special" ? { specialTeams: { subtype: specialSubtype, result: specialResult, actorNumber: specialSubtype === "Try" && tryType === "Two-point pass" ? "" : activePlayer[0], returnerNumber, distance: Number(yards || 0), returnYards: Number(returnYards || 0), returnTouchdown: touchdown, tryType, passerNumber, receiverNumber } }
          : undefined,
    };
    if (!await createPlay(next)) return;
    clearEntry(); setSnapshot(null); sessionStorage.removeItem("tommytv-pending-play");
  }
  const currentLive = liveSnapshot();
  const openSnapshotEditor = (mode: "live" | "marked") => { const value = mode === "marked" ? snapshot : currentLive; setSnapshotDraft(value ? { ...value } : null); setSnapshotModal(mode); };

  return (
    <main>
      <FieldState
        live={currentLive}
        marked={snapshot}
        onAdjustLive={() => openSnapshotEditor("live")}
        onResumeMqtt={() => setManualLive({})}
        onToggleOffense={toggleOffense}
        hasManualLive={Object.keys(manualLive).length > 0}
      />
      <div className="workspace entry-workspace">
        <section className="panel entry-card">
          <div className={`panel-title entry-header${snapshot ? " marked-entry-header" : ""}`}>
            <div><span className="eyebrow">NEXT PLAY · {plays.length + 1}</span><h1>What happened?</h1></div>
            {snapshot ? <div className="marked-header-tools">
              <span className="operator">PRIMARY · AV</span>
              <div className="marked-actions" aria-label="Marked play actions"><button aria-label="Adjust marked play snapshot" onClick={() => openSnapshotEditor("marked")}>Adjust</button><button aria-label="Replace marked snapshot with current live state" onClick={() => { if (hasEntryData && !window.confirm("Replace the marked snapshot with the current live state?")) return; const fresh = liveSnapshot(); if (!fresh.possession) return notify("Set the live offense first"); revalidatePlayers(fresh.possession); setSnapshot(fresh); }}>Use Live State</button><button aria-label="Cancel marked play" onClick={discardMarked}>Cancel</button></div>
            </div> : <span className="operator">PRIMARY · AV</span>}
          </div>
          {!snapshot ? <div className="mark-idle">
            <button className="primary-button mark-play-button" onClick={markPlay}>Mark Play</button>
            <p>Tap as soon as the play ends to freeze the game state.</p>
          </div> : <>
          <div className="segmented">
            {["Run", "Pass", "Penalty", "Special"].map((type) => (
              <button
                key={type}
                className={playType === type ? "selected" : ""}
                onClick={() => setPlayType(type)}
              >
                {type}
              </button>
            ))}
          </div>
          {playType && <>
          {playType === "Pass" ? (
            <div className="form-grid pass-entry-fields">
              <PlayerSelect label="PASSER" roster={activeRoster} value={passerNumber} onChange={setPasserNumber} />
              <label><span>PASS RESULT</span><select value={passResult} onChange={(event) => {
                const result = event.target.value as PassResult;
                setPassResult(result);
                if (result !== "Complete" && result !== "Sacked") setYards("0");
              }}><option>Complete</option><option>Incomplete</option><option>Sacked</option><option>Interception</option></select></label>
              {(passResult === "Complete" || passResult === "Incomplete") && <PlayerSelect label="RECEIVER" roster={activeRoster} value={receiverNumber} onChange={setReceiverNumber} optional={passResult === "Incomplete"} />}
            </div>
          ) : <>
          {playType === "Penalty" && <div className="form-grid">
            <label><span>PENALTY ON</span><select value={penaltyTeam} onChange={(event) => setPenaltyTeam(event.target.value as "home" | "away")}><option value="home">{homeCode || "Home"}</option><option value="away">{awayCode || "Away"}</option></select></label>
            <label><span>PENALTY</span><input value={penaltyName} onChange={(event) => setPenaltyName(event.target.value)} placeholder="Holding" /></label>
            <label><span>STATUS</span><select value={penaltyAccepted ? "Accepted" : "Declined"} onChange={(event) => setPenaltyAccepted(event.target.value === "Accepted")}><option>Accepted</option><option>Declined</option></select></label>
            <button className={penaltyFirstDown ? "selected" : ""} onClick={() => setPenaltyFirstDown(!penaltyFirstDown)}>Automatic first down</button>
            <button className={penaltyPlayCounts ? "selected" : ""} onClick={() => setPenaltyPlayCounts(!penaltyPlayCounts)}>Underlying play counts</button>
          </div>}
          {playType === "Special" && <div className="form-grid">
            <label><span>TYPE</span><select value={specialSubtype} onChange={(event) => { const subtype = event.target.value; setSpecialSubtype(subtype); setSpecialResult(subtype === "Try" ? "Made" : subtype === "Field goal" ? "Made" : "Returned"); }}><option>Punt</option><option>Kickoff</option><option>Field goal</option><option>Try</option></select></label>
            {specialSubtype === "Try" && <label><span>TRY TYPE</span><select value={tryType} onChange={(event) => setTryType(event.target.value)}><option>PAT kick</option><option>Two-point run</option><option>Two-point pass</option></select></label>}
            <label><span>RESULT</span><select value={specialResult} onChange={(event) => setSpecialResult(event.target.value)}>{(specialSubtype === "Punt" ? ["Returned", "Fair catch", "Touchback", "Downed", "Out of bounds", "Blocked"] : specialSubtype === "Kickoff" ? ["Returned", "Touchback", "Out of bounds", "Onside kicking team", "Onside receiving team"] : ["Made", "Missed", "Blocked", "Failed"].filter((item) => specialSubtype === "Try" ? ["Made", "Failed"].includes(item) : !["Failed"].includes(item))).map((item) => <option key={item}>{item}</option>)}</select></label>
            {specialResult === "Returned" && <><PlayerSelect label="RETURNER" roster={activeOffense === "home" ? awayRosterRows : rosterRows} value={returnerNumber} onChange={setReturnerNumber} /><label><span>RETURN YARDS</span><input inputMode="numeric" value={returnYards} onChange={(event) => setReturnYards(event.target.value.replace(/[^0-9]/g, ""))} /></label></>}
            {specialSubtype === "Try" && tryType === "Two-point pass" && <><PlayerSelect label="PASSER" roster={activeRoster} value={passerNumber} onChange={setPasserNumber} /><PlayerSelect label="RECEIVER" roster={activeRoster} value={receiverNumber} onChange={setReceiverNumber} /></>}
          </div>}
          {(playType === "Run" || (playType === "Special" && !(specialSubtype === "Try" && tryType === "Two-point pass"))) && <><label className="section-label">{playType === "Run" ? "BALL CARRIER" : specialSubtype === "Punt" ? "PUNTER" : specialSubtype === "Try" && tryType === "Two-point run" ? "RUNNER" : "KICKER"}</label>
          <div className="player-selection">
            <section className="jersey-selector" aria-label="Jersey number selector">
              <div className="jersey-display">
                <span>JERSEY #</span><strong>{jerseyEntry || "—"}</strong>
                <small>{jerseyEntry
                  ? numberMatches.length
                    ? `${numberMatches.length} match${numberMatches.length === 1 ? "" : "es"}`
                    : `No player #${jerseyEntry}`
                  : "Tap number"}</small>
              </div>
              <div className="number-pad">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9", "CLEAR", "0", "⌫"].map((key) => (
                  <button
                    type="button"
                    key={key}
                    aria-label={key === "⌫" ? "Backspace jersey number" : key === "CLEAR" ? "Clear jersey number" : `Jersey digit ${key}`}
                    className={key.length > 1 ? "utility" : ""}
                    onClick={() => {
                      if (key === "CLEAR") setJerseyEntry("");
                      else if (key === "⌫") setJerseyEntry((current) => current.slice(0, -1));
                      else enterJerseyDigit(key);
                    }}
                  >{key}</button>
                ))}
              </div>
            </section>
            <div className="quick-player-area">
              <div className="quick-player-head"><small>QUICK PLAYERS</small><button type="button" onClick={() => setRosterPickerOpen(true)}>All players <span>→</span></button></div>
              <div className="player-grid">
            {quickPlayers.map((item, index) => (
              <button
                type="button"
                className={samePlayer(activePlayer, item) ? "player selected" : jerseyEntry && item[0].startsWith(jerseyEntry) ? "player matching" : "player"}
                key={`${item[0]}-${item[1]}-${index}`}
                onClick={() => selectPlayer(item)}
              >
                <b>#{item[0]}</b><span>{item[1]}</span><small>{item[2]}</small>
              </button>
            ))}
              </div>
            </div>
          </div></>}
          </>}
          <div className="result-row">
            <label>
              <span>{playType === "Pass" ? "TOTAL YARDS" : "YARDS"}</span>
              <span className="yard-control">
                <button disabled={playType === "Pass" && passResult !== "Complete" && passResult !== "Sacked"} onClick={() => setYards(String(Number(yards || 0) - 1))}>−</button>
                <input
                  inputMode="numeric"
                  value={yards}
                  aria-label="Yards gained"
                  disabled={playType === "Pass" && passResult !== "Complete" && passResult !== "Sacked"}
                  onChange={(event) => setYards(event.target.value.replace(/[^0-9-]/g, ""))}
                />
                <button disabled={playType === "Pass" && passResult !== "Complete" && passResult !== "Sacked"} onClick={() => setYards(String(Number(yards || 0) + 1))}>+</button>
              </span>
            </label>
            <div className="quick-flags">
              {["First down", "Touchdown", "Fumble lost", "Out of bounds"].map((flag) => (
                <button
                  key={flag}
                  className={
                    (flag === "First down" && firstDown) ||
                    (flag === "Touchdown" && touchdown) ||
                    (flag === "Fumble lost" && turnover === "FUMBLE LOST") ||
                    (flag === "Interception" && turnover === "INTERCEPTION") ||
                    (flag === "Out of bounds" && outOfBounds) ? "selected" : ""
                  }
                  onClick={() => {
                    if (flag === "First down") setFirstDown(!firstDown);
                    if (flag === "Touchdown") setTouchdown(!touchdown);
                    if (flag === "Fumble lost") setTurnover(turnover === "FUMBLE LOST" ? "" : "FUMBLE LOST");
                    if (flag === "Interception") setTurnover(turnover === "INTERCEPTION" ? "" : "INTERCEPTION");
                    if (flag === "Out of bounds") setOutOfBounds(!outOfBounds);
                  }}
                >
                  {flag}
                </button>
              ))}
            </div>
          </div>
          <div className="save-row">
            <button className="secondary-button" onClick={() => {
              clearEntry();
              notify("Play entry cleared");
            }}>Clear</button>
            <div className="next-state">FROZEN <b>{snapshot.clock || "No game clock"}</b></div>
            <button className="primary-button" disabled={!activeRoster.length} onClick={savePlay}>{activeRoster.length ? "Save play" : "Add roster first"} <span>→</span></button>
          </div>
          </>}
          </>}
        </section>
        <PlayList
          plays={plays}
          onEdit={(play) => setEditing(playForEditing(play))}
          onUndo={() => {
            if (!plays.length) return;
            const removed = plays.at(-1);
            if (removed) deletePlay(removed.id);
          }}
        />
      </div>
      {rosterPickerOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => setRosterPickerOpen(false)}>
          <section className="modal roster-picker-modal" role="dialog" aria-modal="true" aria-labelledby="roster-picker-title" onClick={(event) => event.stopPropagation()}>
            <div className="panel-title"><div><span className="eyebrow">{activeOffense === "home" ? homeCode || "HOME" : awayCode || "AWAY"} ROSTER</span><h2 id="roster-picker-title">Choose a player</h2></div><button className="icon-button" aria-label="Close player picker" onClick={() => setRosterPickerOpen(false)}>×</button></div>
            <label className="roster-search"><span>FILTER BY NUMBER OR NAME</span><input autoFocus value={rosterFilter} onChange={(event) => setRosterFilter(event.target.value)} placeholder="Example: 22 or Martin" /></label>
            <div className="full-roster-grid">
              {filteredRoster.map((item, index) => (
                <button type="button" className={samePlayer(activePlayer, item) ? "roster-player selected" : "roster-player"} key={`${item[0]}-${item[1]}-${index}`} onClick={() => selectPlayer(item)}>
                  <b>#{item[0]}</b><span>{item[1]}</span><small>{item[2] || "Position not set"}</small>
                </button>
              ))}
            </div>
            {!filteredRoster.length && <p className="empty-panel-copy">No roster players match “{rosterFilter}”.</p>}
          </section>
        </div>
      )}
      {snapshotModal && snapshotDraft && (() => {
        const ballMatch = snapshotDraft.ballOn?.match(/^([^\s]+)\s+(\d+)$/);
        const ballSide = snapshotDraft.ballOn === "50" ? "50" : ballMatch?.[1] === awayCode ? "away" : "home";
        const ballYard = ballMatch?.[2] || "";
        const setBall = (side: string, yard = ballYard) => setSnapshotDraft({ ...snapshotDraft, ballOn: side === "50" ? "50" : `${side === "away" ? awayCode || "AWAY" : homeCode || "HOME"} ${Math.max(1, Math.min(49, Number(yard || 1)))}` });
        return <div className="modal-backdrop" role="presentation" onClick={() => setSnapshotModal(null)}><section className="modal snapshot-modal" role="dialog" aria-modal="true" aria-labelledby="snapshot-title" onClick={(event) => event.stopPropagation()}>
          <div className="panel-title"><div><span className="eyebrow">{snapshotModal === "live" ? "MANUAL LIVE STATE" : "FROZEN PLAY STATE"}</span><h2 id="snapshot-title">Adjust Snapshot</h2></div><button className="icon-button" aria-label="Close" onClick={() => setSnapshotModal(null)}>×</button></div>
          <div className="form-grid"><label><span>PERIOD</span><input value={snapshotDraft.period ?? ""} onChange={(event) => setSnapshotDraft({ ...snapshotDraft, period: event.target.value || undefined })} /></label><label><span>CLOCK</span><input value={snapshotDraft.clock ?? ""} onChange={(event) => setSnapshotDraft({ ...snapshotDraft, clock: event.target.value || undefined })} /></label><label><span>DOWN</span><input inputMode="numeric" value={snapshotDraft.down ?? ""} onChange={(event) => setSnapshotDraft({ ...snapshotDraft, down: scoreboardNumber(event.target.value, 1, 4) })} /></label><label><span>DISTANCE</span><input inputMode="numeric" value={snapshotDraft.distance ?? ""} onChange={(event) => setSnapshotDraft({ ...snapshotDraft, distance: scoreboardNumber(event.target.value, 1) })} /></label>
            <label><span>BALL-ON SIDE</span><select value={ballSide} onChange={(event) => setBall(event.target.value)}><option value="home">{homeCode || "Home"}</option><option value="away">{awayCode || "Away"}</option><option value="50">50</option></select></label>{ballSide !== "50" && <label><span>YARD LINE</span><input inputMode="numeric" min="1" max="49" value={ballYard} onChange={(event) => setBall(ballSide, event.target.value)} /></label>}
            <label><span>OFFENSE</span><select value={snapshotDraft.possession ?? ""} onChange={(event) => setSnapshotDraft({ ...snapshotDraft, possession: event.target.value as "home" | "away" })}><option value="">Unset</option><option value="home">{homeCode || "Home"}</option><option value="away">{awayCode || "Away"}</option></select></label><label><span>HOME SCORE</span><input inputMode="numeric" value={snapshotDraft.homeScore ?? ""} onChange={(event) => setSnapshotDraft({ ...snapshotDraft, homeScore: scoreboardNumber(event.target.value, 0) })} /></label><label><span>AWAY SCORE</span><input inputMode="numeric" value={snapshotDraft.awayScore ?? ""} onChange={(event) => setSnapshotDraft({ ...snapshotDraft, awayScore: scoreboardNumber(event.target.value, 0) })} /></label>
          </div><div className="modal-actions"><button className="secondary-button" onClick={() => setSnapshotModal(null)}>Cancel</button><button className="primary-button" onClick={() => { if (snapshotModal === "live") setManualLive({ ...snapshotDraft, capturedAt: undefined, source: undefined }); else { if (snapshotDraft.possession && snapshotDraft.possession !== snapshot?.possession) revalidatePlayers(snapshotDraft.possession); setSnapshot({ ...snapshotDraft, source: snapshot?.source === "mqtt" ? "mixed" : "manual" }); } setSnapshotModal(null); }}>Apply Changes</button></div>
        </section></div>;
      })()}
      {editing && (
        <div className="modal-backdrop" role="presentation" onClick={() => setEditing(null)}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-play-title" onClick={(event) => event.stopPropagation()}>
            <div className="panel-title"><div><span className="eyebrow">CORRECT PLAY {editing.id}</span><h2 id="edit-play-title">Edit recorded play</h2></div><button className="icon-button" aria-label="Close" onClick={() => setEditing(null)}>×</button></div>
            <label><span>GAME CLOCK</span><input value={editing.clock} onChange={(event) => setEditing({ ...editing, clock: event.target.value })} /></label>
            <label><span>SITUATION</span><input value={editing.situation} onChange={(event) => setEditing({ ...editing, situation: event.target.value })} /></label>
            <p className="empty-panel-copy">Description is regenerated from the statistical fields when saved.</p>
            <div className="form-grid">
              <label><span>DOWN</span><input inputMode="numeric" value={editing.down ?? ""} placeholder="—" onChange={(event) => setEditing({ ...editing, down: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
              <label><span>DISTANCE</span><input inputMode="numeric" value={editing.distance ?? ""} placeholder="—" onChange={(event) => setEditing({ ...editing, distance: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
              <label><span>BALL POSITION</span><input value={editing.ballOn ?? ""} placeholder="TAY 35" onChange={(event) => setEditing({ ...editing, ballOn: event.target.value || undefined })} /></label>
              <label><span>PERIOD</span><input value={editing.period ?? ""} placeholder="1 or OT" onChange={(event) => setEditing({ ...editing, period: event.target.value || undefined })} /></label>
              <label><span>TEAM</span><select value={editing.team ?? "home"} onChange={(event) => setEditing({ ...editing, team: event.target.value as "home" | "away" })}><option value="home">{homeCode || "Home"}</option><option value="away">{awayCode || "Away"}</option></select></label>
              <label><span>PLAY TYPE</span><select value={editing.playType ?? "Run"} onChange={(event) => setEditing({ ...editing, playType: event.target.value })}>{["Run", "Pass", "Penalty", "Special"].map((type) => <option key={type}>{type}</option>)}</select></label>
              {editing.playType === "Pass" ? <>
                <PlayerSelect label="PASSER" roster={(editing.team ?? "home") === "home" ? rosterRows : awayRosterRows} value={editing.passerNumber} onChange={(passerNumber) => setEditing({ ...editing, passerNumber })} />
                <label><span>PASS RESULT</span><select value={editing.passResult ?? "Complete"} onChange={(event) => {
                  const passResult = event.target.value as PassResult;
                  setEditing({ ...editing, passResult, yards: passResult === "Complete" || passResult === "Sacked" ? editing.yards : 0 });
                }}><option>Complete</option><option>Incomplete</option><option>Sacked</option><option>Interception</option></select></label>
                {(["Complete", "Incomplete"] as PassResult[]).includes(editing.passResult ?? "Complete") && <PlayerSelect label="RECEIVER" roster={(editing.team ?? "home") === "home" ? rosterRows : awayRosterRows} value={editing.receiverNumber} onChange={(receiverNumber) => setEditing({ ...editing, receiverNumber })} optional={editing.passResult === "Incomplete"} />}
              </> : editing.playType === "Run" ? <PlayerSelect label="BALL CARRIER" roster={(editing.team ?? "home") === "home" ? rosterRows : awayRosterRows} value={editing.playerNumber} onChange={(playerNumber) => setEditing({ ...editing, playerNumber })} /> : null}
              {editing.playType === "Penalty" && <>
                <label><span>PENALTY ON</span><select value={editing.details?.penalty?.team ?? editing.team ?? "home"} onChange={(event) => setEditing({ ...editing, details: { ...editing.details, penalty: { ...(editing.details?.penalty ?? { name: "", accepted: true, yards: 0, automaticFirstDown: false, playCounts: false }), team: event.target.value as "home" | "away" } } })}><option value="home">{homeCode || "Home"}</option><option value="away">{awayCode || "Away"}</option></select></label>
                <label><span>PENALTY</span><input value={editing.details?.penalty?.name ?? ""} onChange={(event) => setEditing({ ...editing, details: { ...editing.details, penalty: { ...(editing.details?.penalty ?? { team: editing.team ?? "home", accepted: true, yards: 0, automaticFirstDown: false, playCounts: false }), name: event.target.value } } })} /></label>
                <label><span>STATUS</span><select value={editing.details?.penalty?.accepted === false ? "Declined" : "Accepted"} onChange={(event) => setEditing({ ...editing, details: { ...editing.details, penalty: { ...(editing.details?.penalty ?? { team: editing.team ?? "home", name: "", yards: 0, automaticFirstDown: false, playCounts: false }), accepted: event.target.value === "Accepted" } } })}><option>Accepted</option><option>Declined</option></select></label>
                <label><span>PENALTY YARDS</span><input inputMode="numeric" value={editing.details?.penalty?.yards ?? 0} onChange={(event) => setEditing({ ...editing, details: { ...editing.details, penalty: { ...(editing.details?.penalty ?? { team: editing.team ?? "home", name: "", accepted: true, automaticFirstDown: false, playCounts: false }), yards: Number(event.target.value || 0) } } })} /></label>
                <button className={editing.details?.penalty?.automaticFirstDown ? "selected" : ""} onClick={() => setEditing({ ...editing, details: { ...editing.details, penalty: { ...(editing.details?.penalty ?? { team: editing.team ?? "home", name: "", accepted: true, yards: 0, playCounts: false }), automaticFirstDown: !editing.details?.penalty?.automaticFirstDown } } })}>Automatic first down</button>
                <button className={editing.details?.penalty?.playCounts ? "selected" : ""} onClick={() => setEditing({ ...editing, details: { ...editing.details, penalty: { ...(editing.details?.penalty ?? { team: editing.team ?? "home", name: "", accepted: true, yards: 0, automaticFirstDown: false }), playCounts: !editing.details?.penalty?.playCounts } } })}>Underlying play counts</button>
              </>}
              {editing.playType === "Special" && <SpecialCorrectionFields play={editing} setPlay={setEditing} offenseRoster={(editing.team ?? "home") === "home" ? rosterRows : awayRosterRows} receivingRoster={(editing.team ?? "home") === "home" ? awayRosterRows : rosterRows} />}
              {(editing.playType === "Run" || editing.playType === "Pass") && <label><span>YARDS</span><input inputMode="numeric" value={editing.yards ?? 0} onChange={(event) => setEditing({ ...editing, yards: Number(event.target.value || 0) })} /></label>}
              <label><span>RESULT</span><select value={editing.tag ?? ""} onChange={(event) => setEditing({ ...editing, tag: event.target.value || undefined })}><option value="">None</option><option>FIRST DOWN</option><option>TOUCHDOWN</option><option>FUMBLE LOST</option><option>INTERCEPTION</option></select></label>
            </div>
            <div className="modal-actions">
              <button className="danger-button" onClick={() => {
                deletePlay(editing.id);
                setEditing(null);
              }}>Delete play</button>
              <button className="secondary-button" onClick={() => setEditing(null)}>Cancel</button>
              <button className="primary-button" onClick={async () => {
                if (await updatePlay(editing)) setEditing(null);
              }}>Save correction</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function DetailEntry() {
  const { plays, rosterRows, awayRosterRows, confirmPlay } = useGame();
  const [tacklers, setTacklers] = useState<string[]>([]);
  const [detailFlags, setDetailFlags] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [turnoverPlayer, setTurnoverPlayer] = useState("");
  const [returnYards, setReturnYards] = useState("0");
  const [returnTouchdown, setReturnTouchdown] = useState(false);
  const waitingPlays = plays.filter((play) => play.status === "logged");
  const waiting = waitingPlays.find((play) => play.id === selectedId) ?? waitingPlays[0];
  const defenders = waiting?.team === "away" ? rosterRows : awayRosterRows;
  async function finishDetail(noTackle = false) {
    if (!waiting) return;
    const selectedTacklers = noTackle ? [] : tacklers;
    const detail: PlayDetails = {
      tacklers: selectedTacklers,
      flags: detailFlags,
      defensiveCredits: {
        primary: selectedTacklers[0], assists: selectedTacklers.slice(1),
        sack: detailFlags.includes("Sack") ? selectedTacklers : [],
        tackleForLoss: detailFlags.includes("Tackle for loss") ? selectedTacklers : [],
        forcedFumble: detailFlags.includes("Forced fumble") ? selectedTacklers[0] : undefined,
        passBreakup: detailFlags.includes("Pass breakup") ? selectedTacklers[0] : undefined,
      },
      turnoverDetail: waiting.passResult === "Interception"
        ? { interceptorNumber: turnoverPlayer || undefined, interceptionReturnYards: Number(returnYards || 0), returnTouchdown }
        : waiting.tag === "FUMBLE LOST" ? { recovererNumber: turnoverPlayer || undefined } : undefined,
    };
    if (await confirmPlay(waiting.id, detail)) {
      setSelectedId(null); setTacklers([]); setDetailFlags([]); setTurnoverPlayer(""); setReturnYards("0"); setReturnTouchdown(false);
    }
  }
  return (
    <main>
      <FieldState />
      <div className="workspace detail-workspace">
        <section className="panel detail-card">
          <div className="panel-title">
            <div><span className="eyebrow">{waiting ? `NEEDS DETAIL · PLAY ${waiting.id}` : "DETAIL QUEUE CLEAR"}</span><h1>Finish the play</h1></div>
            <span className="operator">SPOTTER · KM</span>
          </div>
          {waiting ? (
            <div className="play-callout">
              <span>{waiting.clock}</span>
              <div><small>{waiting.situation}</small><strong>{waiting.description}</strong></div>
              <b>{waiting.tag ?? "IN REVIEW"}</b>
            </div>
          ) : (
            <div className="empty-callout"><b>✓</b><span><strong>All caught up</strong><small>Waiting for the primary statistician.</small></span></div>
          )}
          <label className="section-label">TACKLERS</label>
          <div className="defender-list">
            {defenders.map((player) => (
              <button
                key={player[0]}
                className={tacklers.includes(player[0]) ? "defender selected" : "defender"}
                onClick={() => setTacklers(
                  tacklers.includes(player[0])
                    ? tacklers.filter((number) => number !== player[0])
                    : [...tacklers, player[0]]
                )}
              >
                <b>#{player[0]}</b><span>{player[1]}</span><small>{player[2]}</small>
                <i>{tacklers.includes(player[0]) ? "✓" : "+"}</i>
              </button>
            ))}
          </div>
          {!defenders.length && <p className="empty-panel-copy">Add the opposing roster to assign defensive players.</p>}
          {(waiting?.passResult === "Interception" || waiting?.tag === "FUMBLE LOST") && <div className="form-grid">
            <PlayerSelect label={waiting.passResult === "Interception" ? "INTERCEPTOR" : "FUMBLE RECOVERER"} roster={defenders} value={turnoverPlayer} onChange={setTurnoverPlayer} optional />
            {waiting.passResult === "Interception" && <><label><span>RETURN YARDS</span><input inputMode="numeric" value={returnYards} onChange={(event) => setReturnYards(event.target.value.replace(/[^0-9]/g, ""))} /></label><button className={returnTouchdown ? "selected" : ""} onClick={() => setReturnTouchdown(!returnTouchdown)}>Return touchdown</button></>}
          </div>}
          <div className="detail-flags">
            {["Tackle for loss", "Sack", "Forced fumble", "Pass breakup"].map((flag) => (
              <button
                key={flag}
                className={detailFlags.includes(flag) ? "selected" : ""}
                onClick={() => setDetailFlags(detailFlags.includes(flag)
                  ? detailFlags.filter((item) => item !== flag)
                  : [...detailFlags, flag])}
              >{flag}</button>
            ))}
          </div>
          <button className="primary-button wide" disabled={!waiting} onClick={() => finishDetail(false)}>
            {waiting ? "Confirm detail" : "No detail waiting"}
          </button>
          <button className="secondary-button wide" disabled={!waiting} onClick={() => finishDetail(true)}>No tackle / Confirm play</button>
        </section>
        <aside className="panel queue">
          <span className="eyebrow">DETAIL QUEUE</span>
          <h2>{waitingPlays.length ? `${waitingPlays.length} play${waitingPlays.length === 1 ? "" : "s"} waiting` : "All caught up"}</h2>
          <p>{waitingPlays.length ? `Currently reviewing play ${waiting?.id}.` : "You are ready for the next play."}</p>
          <div className="plays">{waitingPlays.map((play) => <button className={play.id === waiting?.id ? "play-row selected" : "play-row"} key={play.id} onClick={() => { setSelectedId(play.id); setTacklers([]); setDetailFlags([]); }}><span className="play-number">{play.id}</span><span className="play-copy"><strong>{play.description}</strong></span></button>)}</div>
          <div className="stat-summary"><span>CONFIRMED DETAIL</span><b>{plays.filter((play) => play.status === "confirmed").length} plays reviewed</b><b>{plays.reduce((sum, play) => sum + (play.details?.tacklers?.length ?? 0), 0)} tackles assigned</b></div>
        </aside>
      </div>
    </main>
  );
}

function PxpPanel() {
  const { plays, homeName, awayName, homeCode, awayCode, rosterRows, awayRosterRows, scoreboard } = useGame();
  function teamSummary(team: "home" | "away") {
    return calculateTeamSummary(plays, team);
  }
  const awayStats = teamSummary("away");
  const homeStats = teamSummary("home");
  const teamStats = [
    ["Score", String(scoreboard.away_score || 0), String(scoreboard.home_score || 0)],
    ["Plays", awayStats.plays, homeStats.plays],
    ["First downs", awayStats.rushingFirstDowns + awayStats.passingFirstDowns + awayStats.penaltyFirstDowns, homeStats.rushingFirstDowns + homeStats.passingFirstDowns + homeStats.penaltyFirstDowns],
    ["3rd down", `${awayStats.thirdDownConversions}/${awayStats.thirdDownAttempts}`, `${homeStats.thirdDownConversions}/${homeStats.thirdDownAttempts}`],
    ["4th down", `${awayStats.fourthDownConversions}/${awayStats.fourthDownAttempts}`, `${homeStats.fourthDownConversions}/${homeStats.fourthDownAttempts}`],
    ["Rush / pass / penalty 1D", `${awayStats.rushingFirstDowns}/${awayStats.passingFirstDowns}/${awayStats.penaltyFirstDowns}`, `${homeStats.rushingFirstDowns}/${homeStats.passingFirstDowns}/${homeStats.penaltyFirstDowns}`],
    ["Total yards", awayStats.yards, homeStats.yards],
    ["Rushing", awayStats.rushing, homeStats.rushing],
    ["Passing", awayStats.passing, homeStats.passing],
    ["Touchdowns", awayStats.touchdowns, homeStats.touchdowns],
    ["Turnovers", awayStats.turnovers, homeStats.turnovers],
    ["Penalties", `${awayStats.penalties}-${awayStats.penaltyYards}`, `${homeStats.penalties}-${homeStats.penaltyYards}`],
    ["Punts / avg", `${awayStats.punts}/${awayStats.puntAverage.toFixed(1)}`, `${homeStats.punts}/${homeStats.puntAverage.toFixed(1)}`],
  ];
  const playersByKey = new Map<string, { number: string; name: string; team: string; plays: number; yards: number; touchdowns: number; passing: number; receiving: number; attempts: number; completions: number; receptions: number; interceptions: number }>();
  const credit = (play: Play, number: string, values: Partial<{ plays: number; yards: number; touchdowns: number; passing: number; receiving: number; attempts: number; completions: number; receptions: number; interceptions: number }>) => {
    const team = play.team ?? "home";
    const teamRoster = team === "home" ? rosterRows : awayRosterRows;
    const rosterPlayer = teamRoster.find((row) => row[0] === number);
    const key = `${team}-${number}`;
    const current = playersByKey.get(key) ?? { number, name: rosterPlayer?.[1] ?? `#${number}`, team: team === "home" ? homeCode || "HOME" : awayCode || "AWAY", plays: 0, yards: 0, touchdowns: 0, passing: 0, receiving: 0, attempts: 0, completions: 0, receptions: 0, interceptions: 0 };
    for (const [field, amount] of Object.entries(values)) current[field as keyof typeof values] += amount ?? 0;
    playersByKey.set(key, current);
  };
  for (const play of plays) {
    if (play.playType === "Pass" && play.passerNumber) {
      credit(play, play.passerNumber, { plays: 1, attempts: play.passResult === "Sacked" ? 0 : 1, completions: play.passResult === "Complete" ? 1 : 0, interceptions: play.passResult === "Interception" ? 1 : 0, passing: play.passResult === "Complete" ? Number(play.yards || 0) : 0, yards: play.passResult === "Complete" ? Number(play.yards || 0) : 0 });
      if (play.passResult === "Complete" && play.receiverNumber) credit(play, play.receiverNumber, { plays: 1, receptions: 1, receiving: Number(play.yards || 0), yards: Number(play.yards || 0), touchdowns: play.tag === "TOUCHDOWN" ? 1 : 0 });
    } else if (play.playerNumber) credit(play, play.playerNumber, { plays: 1, yards: Number(play.yards || 0), touchdowns: play.tag === "TOUCHDOWN" ? 1 : 0 });
  }
  const passingKeys = new Set(plays.filter((play) => play.playType === "Pass" && play.passerNumber).map((play) => `${play.team ?? "home"}-${play.passerNumber}`));
  const rushingKeys = new Set(plays.filter((play) => play.playType === "Run" && play.playerNumber).map((play) => `${play.team ?? "home"}-${play.playerNumber}`));
  const passingLeaders = [...playersByKey.entries()].filter(([key]) => passingKeys.has(key)).map(([, player]) => player).sort((a, b) => b.passing - a.passing).slice(0, 2);
  const rushingLeaders = [...playersByKey.entries()].filter(([key]) => rushingKeys.has(key)).map(([, player]) => player).sort((a, b) => b.yards - a.yards).slice(0, 2);
  const receivingLeaders = [...playersByKey.values()].filter((player) => player.receptions).sort((a, b) => b.receiving - a.receiving).slice(0, 2);
  const defensiveLeaders = [...calculatePlayerStats(plays).values()].filter((player) => player.tackles || player.sacks || player.interceptions || player.fumbleRecoveries || player.passBreakups).map((player) => ({ ...player, team: player.team === "home" ? homeCode || "HOME" : awayCode || "AWAY" })).sort((a, b) => b.tackles - a.tackles || b.sacks - a.sacks).slice(0, 2);
  const leaderGroups: Array<[string, Array<{ number: string; team: string; tackles?: number; sacks?: number; interceptions?: number; fumbleRecoveries?: number; passBreakups?: number; attempts?: number; completions?: number; passing?: number; plays?: number; yards?: number; receptions?: number; receiving?: number }>]> = [
    ["Passing", passingLeaders], ["Rushing", rushingLeaders], ["Receiving", receivingLeaders], ["Defense", defensiveLeaders],
  ];
  const latestPlay = plays.at(-1);
  return (
    <main>
      <FieldState />
      <div className="workspace pxp-workspace">
        <section className="panel current-drive">
          <span className="eyebrow">CURRENT DRIVE</span>
          <div className="drive-score"><strong>{plays.length}</strong><span>plays logged</span><strong>{homeStats.yards + awayStats.yards}</strong><span>total yards</span><strong>{homeStats.touchdowns + awayStats.touchdowns}</strong><span>touchdowns</span></div>
          <p>{latestPlay ? `${latestPlay.clock || "No clock"} · ${latestPlay.description}` : "Waiting for the first recorded play"}</p>
          <div className="previous-drives"><small>TEAM YARDAGE</small><span>{awayCode || "AWAY"} {awayStats.yards}</span><span>{homeCode || "HOME"} {homeStats.yards}</span></div>
        </section>
        <section className="panel leaders">
          <div className="panel-title"><div><span className="eyebrow">GAME LEADERS</span><h2>{homeName || awayName ? "Live leaders" : "Game not configured"}</h2></div></div>
          {leaderGroups.map(([category, categoryLeaders]) => <div key={category}><span className="eyebrow">{category.toUpperCase()}</span>{categoryLeaders.map((leader) => <div className="leader" key={`${leader.team}-${leader.number}`}><b>#{leader.number}</b><span><strong>{leader.team}</strong></span><em>{category === "Passing" ? `${leader.completions}/${leader.attempts} · ${leader.passing} YDS` : category === "Receiving" ? `${leader.receptions} REC · ${leader.receiving} YDS` : category === "Defense" ? [[leader.tackles, "TKL"], [leader.sacks, "SACK"], [leader.interceptions, "INT"], [leader.fumbleRecoveries, "FR"], [leader.passBreakups, "PBU"]].filter(([value]) => value).map(([value, label]) => `${value} ${label}`).join(" · ") : `${leader.plays} ATT · ${leader.yards} YDS`}</em></div>)}</div>)}
          {!leaderGroups.some(([, items]) => items.length) && <p className="empty-panel-copy">Leaders will appear after plays are recorded.</p>}
        </section>
        <section className="panel comparison">
          <div className="comparison-head"><b>{awayCode}</b><span>TEAM COMPARISON</span><b>{homeCode}</b></div>
          {teamStats.map((stat) => (
            <div className="comparison-row" key={stat[0]}>
              <strong>{stat[1]}</strong><span>{stat[0]}</span><strong>{stat[2]}</strong>
            </div>
          ))}
        </section>
        <PlayList plays={plays} />
      </div>
    </main>
  );
}

function TvControl() {
  const { notify, homeName, awayName, homeCode, awayCode, plays, rosterRows, awayRosterRows } = useGame();
  const [selected, setSelected] = useState("Player stat");
  const [onAir, setOnAir] = useState(false);
  const graphics = ["Player stat", "Team comparison", "Current drive", "Scoring summary", "Game leaders", "Last score"];
  const latestWithPlayer = [...plays].reverse().find((play) => play.playerNumber || play.passerNumber || play.receiverNumber || play.details?.tacklers?.[0]);
  const participantNumber = latestWithPlayer?.playerNumber || latestWithPlayer?.passerNumber || latestWithPlayer?.receiverNumber || latestWithPlayer?.details?.tacklers?.[0];
  const defensiveParticipant = !latestWithPlayer?.playerNumber && !latestWithPlayer?.passerNumber && !latestWithPlayer?.receiverNumber;
  const graphicTeam = defensiveParticipant ? (latestWithPlayer?.team === "away" ? "home" : "away") : latestWithPlayer?.team === "away" ? "away" : "home";
  const graphicRoster = graphicTeam === "away" ? awayRosterRows : rosterRows;
  const graphicPlayer = graphicRoster.find((row) => row[0] === participantNumber);
  const playerPlays = participantNumber
    ? plays.filter((play) => (play.playerNumber === participantNumber || play.passerNumber === participantNumber || play.receiverNumber === participantNumber || play.details?.tacklers?.includes(participantNumber)) && ((defensiveParticipant ? play.team !== graphicTeam : (play.team ?? "home") === graphicTeam)))
    : [];
  const playerYards = playerPlays.reduce((sum, play) => sum + Number(play.yards || 0), 0);
  const playerTouchdowns = playerPlays.filter((play) => play.tag === "TOUCHDOWN").length;
  return (
    <main className="workspace control-workspace">
      <section className="panel graphics-list">
        <span className="eyebrow">VMIX GRAPHICS</span><h1>Choose a look</h1>
        {graphics.map((graphic) => (
          <button className={selected === graphic ? "selected" : ""} onClick={() => setSelected(graphic)} key={graphic}>
            <span>{graphic}</span><b>→</b>
          </button>
        ))}
      </section>
      <section className="panel preview-card">
        <div className="panel-title"><div><span className="eyebrow">PREVIEW</span><h2>{selected}</h2></div><span className="vmix-status prototype">PROTOTYPE MODE</span></div>
        <div className="graphic-preview">
          <div className="preview-team">{(graphicTeam === "away" ? awayName || awayCode : homeName || homeCode || "GAME NOT CONFIGURED").toUpperCase()}</div>
          <div className="preview-player"><b>{graphicPlayer?.[0] || "–"}</b><span><strong>{graphicPlayer?.[1]?.toUpperCase() || "NO PLAYER DATA"}</strong><small>{graphicPlayer?.[2] || "Record a play to populate this graphic"}</small></span></div>
          <div className="preview-stats">{defensiveParticipant ? <><span><b>{playerPlays.length}</b>TACKLES</span><span><b>{playerPlays.filter((play) => play.details?.flags?.includes("Sack")).length}</b>SACK</span></> : latestWithPlayer?.passerNumber === participantNumber ? <><span><b>{playerPlays.filter((play) => play.passResult === "Complete").length}/{playerPlays.filter((play) => play.passResult !== "Sacked").length}</b>CMP/ATT</span><span><b>{playerPlays.filter((play) => play.passResult === "Complete").reduce((sum, play) => sum + Number(play.yards || 0), 0)}</b>PASS YDS</span></> : <><span><b>{playerPlays.length}</b>PLAYS</span><span><b>{playerYards}</b>YDS</span><span><b>{playerTouchdowns}</b>TD</span></>}</div>
        </div>
        <div className="control-actions">
          <button className="secondary-button" onClick={() => notify(`${selected} preview refreshed`)}>Update preview</button>
          <button className={onAir ? "danger-button" : "primary-button"} onClick={() => {
            setOnAir(!onAir);
            notify(onAir ? `${selected} preview cleared` : `${selected} action simulated — vMix backend not connected yet`);
          }}>{onAir ? "Clear simulation" : "Simulate vMix push →"}</button>
        </div>
      </section>
    </main>
  );
}

function GameTimeline() {
  const { plays, homeCode, awayCode, rosterRows, awayRosterRows, scoreboard } = useGame();
  const [category, setCategory] = useState("All");
  const [period, setPeriod] = useState("All");
  const [query, setQuery] = useState("");
  const categories = ["All", "Scoring", "Turnovers", "Penalties", "Special Teams", "Explosive Plays"];
  const periods = ["All", "Q1", "Q2", "Q3", "Q4", ...(plays.some((play) => String(play.period).toUpperCase() === "OT") ? ["OT"] : [])];
  const rosters = { home: rosterRows, away: awayRosterRows };
  const filtered = filterTimelinePlays(plays, { category, period, query, rosters });
  const counts = Object.fromEntries(categories.map((item) => [item, filterTimelinePlays(plays, { category: item }).length]));
  const home = calculateTeamSummary(plays, "home");
  const away = calculateTeamSummary(plays, "away");
  const scoring = buildScoringSummary(plays);
  const drives = buildDriveSummaries(plays);
  const longest = buildLongestPlaySummary(plays);
  const redZone = buildRedZoneSummary(plays, { home: homeCode, away: awayCode });
  const explosive = (team: "home" | "away", type: "Run" | "Pass") => plays.filter((play) => (play.team ?? "home") === team && play.playType === type && isExplosivePlay(play)).length;
  const teamLabel = (team?: string) => team === "away" ? awayCode || "AWAY" : homeCode || "HOME";
  const longValue = (play: Play | null, field: "yards" | "distance" | "returnYards") => !play ? "—" : field === "yards" ? `${play.yards ?? 0} yd` : `${play.details?.specialTeams?.[field] ?? 0} yd`;
  return <main className="timeline-page">
    <section className="timeline-sticky">
      <div className="timeline-overview">
        <div><small>SCORE</small><b>{awayCode || "AWAY"} {String(scoreboard.away_score || 0)} · {homeCode || "HOME"} {String(scoreboard.home_score || 0)}</b></div>
        <div><small>OFFENSE</small><b>{away.plays} plays / {away.yards} yd · {home.plays} plays / {home.yards} yd</b></div>
        <div><small>TURNOVERS</small><b>{away.turnovers} · {home.turnovers}</b></div>
        <div><small>3RD / 4TH</small><b>{away.thirdDownConversions}/{away.thirdDownAttempts} · {away.fourthDownConversions}/{away.fourthDownAttempts} | {home.thirdDownConversions}/{home.thirdDownAttempts} · {home.fourthDownConversions}/{home.fourthDownAttempts}</b></div>
      </div>
      <div className="timeline-filter-row">{categories.map((item) => <button key={item} className={category === item ? "selected" : ""} onClick={() => setCategory(item)}>{item} <b>{counts[item]}</b></button>)}</div>
      <div className="timeline-filter-row compact">{periods.map((item) => <button key={item} className={period === item ? "selected" : ""} onClick={() => setPeriod(item)}>{item}</button>)}<input aria-label="Search timeline" placeholder="Search player, # or description" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
    </section>
    <div className="timeline-layout">
      <section className="panel timeline-list">
        <div className="panel-title"><div><span className="eyebrow">FULL GAME</span><h1>{filtered.length} timeline entries</h1></div></div>
        {filtered.map((play: Play) => {
          const special = play.details?.specialTeams;
          const marker = isScoringPlay(play) ? "SCORING" : isTurnoverPlay(play) ? "TURNOVER" : play.playType === "Penalty" ? "PENALTY" : isSpecialTeamsPlay(play) ? "SPECIAL" : isExplosivePlay(play) ? "EXPLOSIVE" : "PLAY";
          const down = play.down ? `${play.down}${play.down === 1 ? "st" : play.down === 2 ? "nd" : play.down === 3 ? "rd" : "th"}${play.distance ? ` & ${play.distance}` : ""}` : "";
          return <article className={`timeline-item ${marker.toLowerCase()} ${play.id === plays.at(-1)?.id ? "latest" : ""}`} key={play.id}>
            <div className="timeline-meta"><b>#{play.id}</b><span>{play.period ? `Q${play.period}`.replace("QOT", "OT") : "Period —"} {play.clock || "--:--"} · {teamLabel(play.team)}{down ? ` · ${down}` : ""}{play.ballOn ? ` at ${play.ballOn}` : ""}</span><em>{marker}</em></div>
            <strong>{play.description}</strong>
            <small>{play.tag || special?.result || ""} · {play.status === "confirmed" ? "Detail confirmed" : "Needs detail"}</small>
          </article>;
        })}
        {!filtered.length && <p className="empty-panel-copy">No plays match these timeline filters.</p>}
      </section>
      <aside className="timeline-sidebar">
        <section className="panel timeline-card"><span className="eyebrow">SCORING SUMMARY</span>{scoring.map((event: { playId: number; period?: string; clock: string; team: "home" | "away"; type: string; description: string }) => <p key={event.playId}><b>{event.period ? `Q${event.period}` : "—"} {event.clock}</b> · {teamLabel(event.team)} · {event.type}<small>{event.description}</small></p>)}{!scoring.length && <p>No scoring plays.</p>}</section>
        <section className="panel timeline-card"><span className="eyebrow">LONGEST PLAYS</span><p>{homeCode || "HOME"}: Run {longValue(longest.home.run, "yards")} · Pass {longValue(longest.home.completion, "yards")}</p><p>{awayCode || "AWAY"}: Run {longValue(longest.away.run, "yards")} · Pass {longValue(longest.away.completion, "yards")}</p><p>Punt {longValue(longest.punt, "distance")} · PR {longValue(longest.puntReturn, "returnYards")} · KR {longValue(longest.kickoffReturn, "returnYards")}</p></section>
        <section className="panel timeline-card"><span className="eyebrow">EXPLOSIVE PLAYS</span><p>{homeCode || "HOME"}: {explosive("home", "Run")} run · {explosive("home", "Pass")} pass</p><p>{awayCode || "AWAY"}: {explosive("away", "Run")} run · {explosive("away", "Pass")} pass</p></section>
        <section className="panel timeline-card"><span className="eyebrow">RED ZONE</span><p>{homeCode || "HOME"}: {redZone.home.touchdowns}/{redZone.home.trips} TD · {redZone.home.fieldGoals} FG · {redZone.home.empty} empty</p><p>{awayCode || "AWAY"}: {redZone.away.touchdowns}/{redZone.away.trips} TD · {redZone.away.fieldGoals} FG · {redZone.away.empty} empty</p></section>
        <section className="panel timeline-card drives"><span className="eyebrow">INFERRED DRIVES</span>{drives.map((drive) => <p key={drive.number}><b>#{drive.number} {teamLabel(drive.team)}</b> · {drive.plays} plays · {drive.yards} yd<small>{drive.startPeriod ? `Q${drive.startPeriod}` : "—"} {drive.startClock || "--:--"} → {drive.endClock || "--:--"} · {drive.result}</small></p>)}</section>
      </aside>
    </div>
  </main>;
}

function Admin() {
  const {
    homeName, setHomeName, awayName, setAwayName, homeCode, setHomeCode,
    awayCode, setAwayCode, rosterRows, setRosterRows, awayRosterRows,
    setAwayRosterRows, scoreboard, backendOnline, saveGame, saveRoster, notify,
    plays, exportCurrentGame, resetGame,
  } = useGame();
  const [tested, setTested] = useState(false);
  const [rosterText, setRosterText] = useState(rosterRows.map((row) => row.join("\t")).join("\n"));
  const [awayRosterText, setAwayRosterText] = useState(awayRosterRows.map((row) => row.join("\t")).join("\n"));
  const [homeRosterDirty, setHomeRosterDirty] = useState(false);
  const [awayRosterDirty, setAwayRosterDirty] = useState(false);
  const [previewRows, setPreviewRows] = useState<string[][] | null>(null);
  const [previewTeam, setPreviewTeam] = useState<"home" | "away">("home");
  const [resetOpen, setResetOpen] = useState(false);
  const [resetChoice, setResetChoice] = useState<"keep" | "clear" | "">("");
  const [resetAcknowledged, setResetAcknowledged] = useState(false);
  const [resetConfirmation, setResetConfirmation] = useState("");
  const [lastExport, setLastExport] = useState<Date | null>(null);
  const performExport = async () => { if (await exportCurrentGame()) setLastExport(new Date()); };
  const resetReady = Boolean(resetChoice) && resetAcknowledged && resetConfirmation === "NEW GAME";
  const displayedHomeRoster = homeRosterDirty ? rosterText : rosterRows.map((row) => row.join("\t")).join("\n");
  const displayedAwayRoster = awayRosterDirty ? awayRosterText : awayRosterRows.map((row) => row.join("\t")).join("\n");
  return (
    <main className="workspace admin-workspace">
      <section className="panel setup-card">
        <span className="eyebrow">GAME SETUP</span><h1>Friday night configuration</h1>
        <div className="form-grid">
          <label><span>HOME TEAM</span><input value={homeName} onChange={(event) => setHomeName(event.target.value)} /></label>
          <label><span>AWAY TEAM</span><input value={awayName} onChange={(event) => setAwayName(event.target.value)} /></label>
          <label><span>HOME SHORT NAME</span><input maxLength={4} value={homeCode} onChange={(event) => setHomeCode(event.target.value.toUpperCase())} /></label>
          <label><span>AWAY SHORT NAME</span><input maxLength={4} value={awayCode} onChange={(event) => setAwayCode(event.target.value.toUpperCase())} /></label>
        </div>
        <div className="roster-import-grid">
          <section className="roster-import-card">
            <div className="roster-import-head"><span><b>{homeCode}</b><small>HOME ROSTER</small></span><em>{rosterRows.length} players</em></div>
            <textarea aria-label="Home roster spreadsheet data" value={displayedHomeRoster} onChange={(event) => {
              setHomeRosterDirty(true);
              setRosterText(event.target.value);
            }} />
            <button className="secondary-button wide" onClick={() => {
              const parsed = parseRoster(displayedHomeRoster);
              if (!parsed.length) {
                notify("No valid home roster rows found");
                return;
              }
              setPreviewTeam("home");
              setPreviewRows(parsed);
            }}>Preview home roster</button>
          </section>
          <section className="roster-import-card away-roster">
            <div className="roster-import-head"><span><b>{awayCode}</b><small>AWAY ROSTER</small></span><em>{awayRosterRows.length} players</em></div>
            <textarea aria-label="Away roster spreadsheet data" value={displayedAwayRoster} onChange={(event) => {
              setAwayRosterDirty(true);
              setAwayRosterText(event.target.value);
            }} />
            <button className="secondary-button wide" onClick={() => {
              const parsed = parseRoster(displayedAwayRoster);
              if (!parsed.length) {
                notify("No valid away roster rows found");
                return;
              }
              setPreviewTeam("away");
              setPreviewRows(parsed);
            }}>Preview away roster</button>
          </section>
        </div>
        <button className="primary-button save-setup" onClick={saveGame}>Save game setup</button>
      </section>
      <aside className="panel integrations">
        <span className="eyebrow">CONNECTIONS</span><h2>Production network</h2>
        <div className="integration-item">
          <i className={scoreboard._connected ? "online" : "configured"} /><span><strong>MQTT scoreboard</strong><small>192.168.18.129:1883 · tommytv/scoreboard</small></span><b>{scoreboard._connected ? "CONNECTED" : "WAITING"}</b>
        </div>
        <div className="integration-item">
          <i className={backendOnline ? "online" : "configured"} /><span><strong>Game service</strong><small>Port 3001 · SQLite</small></span><b>{backendOnline ? "CONNECTED" : "OFFLINE"}</b>
        </div>
        <div className="raw-feed"><small>LATEST SCOREBOARD MESSAGE</small><code>{Object.keys(scoreboard).filter((key) => !key.startsWith("_")).length ? JSON.stringify(Object.fromEntries(Object.entries(scoreboard).filter(([key]) => !key.startsWith("_"))), null, 2) : "Waiting for MQTT data…"}</code></div>
        <button className="primary-button wide" onClick={() => {
          setTested(true);
          notify("Configuration looks valid — live connection testing requires the Windows backend");
        }}>{tested ? "✓ Configuration valid" : "Check configuration"}</button>
      </aside>
      <section className="panel setup-card">
        <span className="eyebrow">GAME MANAGEMENT</span><h2>Current game</h2>
        <div className="stat-summary">
          <b>{homeName || "Home team not set"} vs {awayName || "Away team not set"}</b>
          <b>{plays.length} recorded plays</b>
          <b>{plays.filter((play) => play.status === "confirmed").length} with confirmed detail</b>
          {lastExport && <span>Last exported this session: {lastExport.toLocaleTimeString()}</span>}
        </div>
        <button className="secondary-button wide" onClick={performExport}>Export Current Game</button>
        <div className="empty-callout"><b>!</b><span><strong>Start New Game</strong><small>This permanently removes the current game’s plays and statistics. Export first if you may need them later.</small></span></div>
        <button className="danger-button wide" onClick={() => { setResetOpen(true); setResetChoice(""); setResetAcknowledged(false); setResetConfirmation(""); }}>Start New Game</button>
      </section>
      {previewRows && (
        <div className="modal-backdrop" role="presentation" onClick={() => setPreviewRows(null)}>
          <section className="modal roster-modal" role="dialog" aria-modal="true" aria-labelledby="roster-preview-title" onClick={(event) => event.stopPropagation()}>
            <div className="panel-title"><div><span className="eyebrow">{previewTeam.toUpperCase()} ROSTER · IMPORT PREVIEW</span><h2 id="roster-preview-title">{previewRows.length} players found</h2></div><button className="icon-button" aria-label="Close" onClick={() => setPreviewRows(null)}>×</button></div>
            <div className="roster-preview">
              {previewRows.map((row, index) => (
                <div key={`${row[0]}-${index}`}><b>#{row[0]}</b><span>{row[1]}</span><small>{row.slice(2).join(" · ") || "Position not set"}</small></div>
              ))}
            </div>
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setPreviewRows(null)}>Cancel</button>
              <button className="primary-button" onClick={() => {
                if (previewTeam === "home") {
                  setRosterRows(previewRows);
                  setHomeRosterDirty(false);
                } else {
                  setAwayRosterRows(previewRows);
                  setAwayRosterDirty(false);
                }
                saveRoster(previewTeam, previewRows);
                setPreviewRows(null);
              }}>Import {previewTeam} roster</button>
            </div>
          </section>
        </div>
      )}
      {resetOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => setResetOpen(false)}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="new-game-title" onClick={(event) => event.stopPropagation()}>
            <div className="panel-title"><div><span className="eyebrow">DANGER ZONE</span><h2 id="new-game-title">Start New Game</h2></div><button className="icon-button" aria-label="Close" onClick={() => setResetOpen(false)}>×</button></div>
            <div className="reset-step"><span className="eyebrow">1 · EXPORT</span><button className="secondary-button wide" onClick={performExport}>Export Current Game</button><small>Last export: {lastExport ? lastExport.toLocaleTimeString() : "Not exported this session"}</small></div>
            <div className="reset-step"><span className="eyebrow">2 · CHOOSE WHAT TO KEEP</span><div className="reset-options" role="radiogroup" aria-label="New game reset option">
              <button role="radio" aria-checked={resetChoice === "keep"} className={resetChoice === "keep" ? "selected" : ""} onClick={() => setResetChoice("keep")}><b>Keep teams and rosters</b><small>Clear plays and statistics</small></button>
              <button role="radio" aria-checked={resetChoice === "clear"} className={resetChoice === "clear" ? "selected" : ""} onClick={() => setResetChoice("clear")}><b>Clear everything</b><small>Also clear teams and rosters</small></button>
            </div></div>
            <div className="reset-step"><span className="eyebrow">3 · CONFIRM</span>
              <label className="reset-check"><input type="checkbox" checked={resetAcknowledged} onChange={(event) => setResetAcknowledged(event.target.checked)} /><span>I understand this permanently deletes the current game data</span></label>
              <label><span>TYPE NEW GAME</span><input value={resetConfirmation} onChange={(event) => setResetConfirmation(event.target.value)} /></label>
            </div>
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setResetOpen(false)}>Cancel</button>
              <button className="danger-button" disabled={!resetReady} onClick={async () => { if (await resetGame(resetChoice === "keep", resetConfirmation)) setResetOpen(false); }}>Start New Game</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function TommyTvApp() {
  const [role, setRole] = useRole();
  const screen = useMemo(() => {
    if (role === "entry-detail") return <DetailEntry />;
    if (role === "pxp") return <PxpPanel />;
    if (role === "timeline") return <GameTimeline />;
    if (role === "control") return <TvControl />;
    if (role === "admin") return <Admin />;
    return <PrimaryEntry />;
  }, [role]);
  return <div className="app-shell"><Header role={role} setRole={setRole} />{screen}</div>;
}

export default function Home() {
  return <GameProvider><TommyTvApp /></GameProvider>;
}
