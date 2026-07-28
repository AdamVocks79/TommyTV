"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";

type Role = "entry-primary" | "entry-detail" | "pxp" | "control" | "admin";
type Play = {
  id: number;
  clock: string;
  situation: string;
  description: string;
  tag?: string;
  status: "logged" | "confirmed";
  playType?: string;
  playerNumber?: string;
  yards?: number;
  details?: { tacklers?: string[]; flags?: string[] };
  team?: "home" | "away";
};

const roles: { id: Role; label: string; short: string }[] = [
  { id: "entry-primary", label: "Primary Stats", short: "ENTRY" },
  { id: "entry-detail", label: "Defensive Detail", short: "DETAIL" },
  { id: "pxp", label: "PxP Panel", short: "PXP" },
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
  createPlay: (play: Omit<Play, "id" | "status"> & { team: "home" | "away"; playType: string; playerNumber: string; yards: number }) => Promise<void>;
  updatePlay: (play: Play) => Promise<void>;
  deletePlay: (id: number) => Promise<void>;
  confirmPlay: (id: number, tacklers: string[], flags: string[]) => Promise<void>;
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

  async function createPlay(play: Omit<Play, "id" | "status"> & { team: "home" | "away"; playType: string; playerNumber: string; yards: number }) {
    try {
      const result = await apiRequest("/api/plays", { method: "POST", body: JSON.stringify(play) });
      applyState(result.state);
      notify(`Play ${result.id} saved to SQLite`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not save play");
    }
  }

  async function updatePlay(play: Play) {
    try {
      const state = await apiRequest(`/api/plays/${play.id}`, { method: "PUT", body: JSON.stringify(play) });
      applyState(state);
      notify(`Play ${play.id} corrected`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not update play");
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

  async function confirmPlay(id: number, tacklers: string[], flags: string[]) {
    try {
      const state = await apiRequest(`/api/plays/${id}/confirm`, {
        method: "POST",
        body: JSON.stringify({ tacklers, flags }),
      });
      applyState(state);
      notify(`Play ${id} defensive detail saved`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not save defensive detail");
    }
  }

  return (
    <GameContext.Provider value={{
      plays, setPlays, homeName, setHomeName, awayName, setAwayName,
      homeCode, setHomeCode, awayCode, setAwayCode, rosterRows, setRosterRows,
      awayRosterRows, setAwayRosterRows,
      scoreboard, backendOnline, saveGame, saveRoster, createPlay, updatePlay,
      deletePlay, confirmPlay,
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

function FieldState() {
  const { scoreboard, homeCode, awayCode, plays } = useGame();
  const possession = scoreboard.home_possession
    ? homeCode || "HOME"
    : scoreboard.away_possession
      ? awayCode || "AWAY"
      : "UNSET";
  return (
    <section className="field-state">
      <div><small>DOWN</small><strong>{String(scoreboard.down || "–")}</strong></div>
      <div><small>TO GO</small><strong>{String(scoreboard.to_go || "–")}</strong></div>
      <div><small>BALL ON</small><strong>{String(scoreboard.ball_on || "–")}</strong></div>
      <div><small>POSSESSION</small><strong className="possession">{possession}</strong></div>
      <div className="drive"><small>PLAYS LOGGED</small><strong>{plays.length} this game</strong></div>
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

function PrimaryEntry() {
  const {
    plays, rosterRows, awayRosterRows, homeCode, awayCode, scoreboard,
    createPlay, updatePlay, deletePlay, notify,
  } = useGame();
  const [offense, setOffense] = useState<"home" | "away">(
    scoreboard.away_possession ? "away" : "home"
  );
  const [playType, setPlayType] = useState("Run");
  const activeRoster = offense === "home" ? rosterRows : awayRosterRows;
  const [player, setPlayer] = useState(activeRoster[0] ?? ["00", "Roster needed", ""]);
  const [yards, setYards] = useState("6");
  const [firstDown, setFirstDown] = useState(true);
  const [touchdown, setTouchdown] = useState(false);
  const [fumble, setFumble] = useState(false);
  const [outOfBounds, setOutOfBounds] = useState(false);
  const [editing, setEditing] = useState<Play | null>(null);
  const activePlayer = activeRoster.some((row) => row[0] === player[0])
    ? player
    : activeRoster[0] ?? ["00", "Roster needed", ""];

  async function savePlay() {
    const verb: Record<string, string> = {
      Run: "rush",
      Pass: "pass complete",
      Sack: "sacked",
      Penalty: "penalty",
      Special: "special teams return",
    };
    const modifiers = [
      touchdown ? "touchdown" : "",
      fumble ? "fumble" : "",
      outOfBounds ? "out of bounds" : "",
    ].filter(Boolean);
    const next = {
      clock: String(scoreboard.clock || ""),
      situation: [
        scoreboard.down ? `${scoreboard.down}${scoreboard.to_go ? ` & ${scoreboard.to_go}` : ""}` : "",
        scoreboard.ball_on ? `at ${scoreboard.ball_on}` : "",
      ].filter(Boolean).join(" "),
      description: `#${activePlayer[0]} ${activePlayer[1]} ${verb[playType]} for ${yards || "0"} yards${modifiers.length ? ` · ${modifiers.join(" · ")}` : ""}`,
      tag: touchdown ? "TOUCHDOWN" : firstDown ? "FIRST DOWN" : fumble ? "FUMBLE" : undefined,
      team: offense,
      playType,
      playerNumber: activePlayer[0],
      yards: Number(yards || 0),
    };
    await createPlay(next);
    setYards("0");
    setFirstDown(false);
    setTouchdown(false);
    setFumble(false);
    setOutOfBounds(false);
  }

  return (
    <main>
      <FieldState />
      <div className="workspace entry-workspace">
        <section className="panel entry-card">
          <div className="panel-title">
            <div><span className="eyebrow">NEXT PLAY · {plays.length + 1}</span><h1>What happened?</h1></div>
            <span className="operator">PRIMARY · AV</span>
          </div>
          <div className="possession-toggle" aria-label="Offensive team">
            <button className={offense === "home" ? "selected" : ""} onClick={() => setOffense("home")}>{homeCode || "HOME"} offense</button>
            <button className={offense === "away" ? "selected" : ""} onClick={() => setOffense("away")}>{awayCode || "AWAY"} offense</button>
          </div>
          <div className="segmented">
            {["Run", "Pass", "Sack", "Penalty", "Special"].map((type) => (
              <button
                key={type}
                className={playType === type ? "selected" : ""}
                onClick={() => setPlayType(type)}
              >
                {type}
              </button>
            ))}
          </div>
          <label className="section-label">BALL CARRIER</label>
          <div className="player-grid">
            {activeRoster.slice(0, 5).map((item) => (
              <button
                className={activePlayer[0] === item[0] ? "player selected" : "player"}
                key={item[0]}
                onClick={() => setPlayer(item)}
              >
                <b>#{item[0]}</b><span>{item[1]}</span><small>{item[2]}</small>
              </button>
            ))}
            <button className="player more"><b>•••</b><span>More</span></button>
          </div>
          <div className="result-row">
            <label>
              <span>YARDS</span>
              <span className="yard-control">
                <button onClick={() => setYards(String(Number(yards || 0) - 1))}>−</button>
                <input
                  inputMode="numeric"
                  value={yards}
                  aria-label="Yards gained"
                  onChange={(event) => setYards(event.target.value.replace(/[^0-9-]/g, ""))}
                />
                <button onClick={() => setYards(String(Number(yards || 0) + 1))}>+</button>
              </span>
            </label>
            <div className="quick-flags">
              {["First down", "Touchdown", "Fumble", "Out of bounds"].map((flag) => (
                <button
                  key={flag}
                  className={
                    (flag === "First down" && firstDown) ||
                    (flag === "Touchdown" && touchdown) ||
                    (flag === "Fumble" && fumble) ||
                    (flag === "Out of bounds" && outOfBounds) ? "selected" : ""
                  }
                  onClick={() => {
                    if (flag === "First down") setFirstDown(!firstDown);
                    if (flag === "Touchdown") setTouchdown(!touchdown);
                    if (flag === "Fumble") setFumble(!fumble);
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
              setPlayType("Run"); setYards("0"); setFirstDown(false);
              setTouchdown(false); setFumble(false); setOutOfBounds(false);
              notify("Play entry cleared");
            }}>Clear</button>
            <div className="next-state">SOURCE <b>{scoreboard.clock ? `Scoreboard · ${scoreboard.clock}` : "Waiting for scoreboard clock"}</b></div>
            <button className="primary-button" disabled={!activeRoster.length} onClick={savePlay}>{activeRoster.length ? "Save play" : "Add roster first"} <span>→</span></button>
          </div>
        </section>
        <PlayList
          plays={plays}
          onEdit={setEditing}
          onUndo={() => {
            if (!plays.length) return;
            const removed = plays.at(-1);
            if (removed) deletePlay(removed.id);
          }}
        />
      </div>
      {editing && (
        <div className="modal-backdrop" role="presentation" onClick={() => setEditing(null)}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-play-title" onClick={(event) => event.stopPropagation()}>
            <div className="panel-title"><div><span className="eyebrow">CORRECT PLAY {editing.id}</span><h2 id="edit-play-title">Edit recorded play</h2></div><button className="icon-button" aria-label="Close" onClick={() => setEditing(null)}>×</button></div>
            <label><span>GAME CLOCK</span><input value={editing.clock} onChange={(event) => setEditing({ ...editing, clock: event.target.value })} /></label>
            <label><span>SITUATION</span><input value={editing.situation} onChange={(event) => setEditing({ ...editing, situation: event.target.value })} /></label>
            <label><span>PLAY DESCRIPTION</span><textarea value={editing.description} onChange={(event) => setEditing({ ...editing, description: event.target.value })} /></label>
            <div className="modal-actions">
              <button className="danger-button" onClick={() => {
                deletePlay(editing.id);
                setEditing(null);
              }}>Delete play</button>
              <button className="secondary-button" onClick={() => setEditing(null)}>Cancel</button>
              <button className="primary-button" onClick={() => {
                updatePlay(editing);
                setEditing(null);
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
  const [tacklers, setTacklers] = useState(["34"]);
  const [detailFlags, setDetailFlags] = useState<string[]>([]);
  const waitingPlays = plays.filter((play) => play.status === "logged");
  const waiting = waitingPlays.at(-1);
  const defenders = (waiting?.team === "away" ? rosterRows : awayRosterRows).slice(0, 12);
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
          <button className="primary-button wide" disabled={!waiting} onClick={() => {
            if (waiting) {
              confirmPlay(waiting.id, tacklers, detailFlags);
              setTacklers([]);
              setDetailFlags([]);
            }
          }}>
            {waiting ? "Confirm detail" : "No detail waiting"}
          </button>
        </section>
        <aside className="panel queue">
          <span className="eyebrow">DETAIL QUEUE</span>
          <h2>{waitingPlays.length ? `${waitingPlays.length} play${waitingPlays.length === 1 ? "" : "s"} waiting` : "All caught up"}</h2>
          <p>{waitingPlays.length ? `Currently reviewing play ${waiting?.id}.` : "You are ready for the next play."}</p>
          <div className="stat-summary"><span>CONFIRMED DETAIL</span><b>{plays.filter((play) => play.status === "confirmed").length} plays reviewed</b><b>{plays.reduce((sum, play) => sum + (play.details?.tacklers?.length ?? 0), 0)} tackles assigned</b></div>
        </aside>
      </div>
    </main>
  );
}

function PxpPanel() {
  const { plays, homeName, awayName, homeCode, awayCode, rosterRows, awayRosterRows } = useGame();
  function teamSummary(team: "home" | "away") {
    const teamPlays = plays.filter((play) => (play.team ?? "home") === team);
    return {
      plays: teamPlays.length,
      firstDowns: teamPlays.filter((play) => play.tag === "FIRST DOWN").length,
      yards: teamPlays.reduce((sum, play) => sum + Number(play.yards || 0), 0),
      rushing: teamPlays.filter((play) => play.playType === "Run").reduce((sum, play) => sum + Number(play.yards || 0), 0),
      passing: teamPlays.filter((play) => play.playType === "Pass").reduce((sum, play) => sum + Number(play.yards || 0), 0),
      touchdowns: teamPlays.filter((play) => play.tag === "TOUCHDOWN").length,
      turnovers: teamPlays.filter((play) => play.tag === "FUMBLE" || /intercept/i.test(play.description)).length,
    };
  }
  const awayStats = teamSummary("away");
  const homeStats = teamSummary("home");
  const teamStats = [
    ["Plays", awayStats.plays, homeStats.plays],
    ["First downs", awayStats.firstDowns, homeStats.firstDowns],
    ["Total yards", awayStats.yards, homeStats.yards],
    ["Rushing", awayStats.rushing, homeStats.rushing],
    ["Passing", awayStats.passing, homeStats.passing],
    ["Touchdowns", awayStats.touchdowns, homeStats.touchdowns],
    ["Turnovers", awayStats.turnovers, homeStats.turnovers],
  ];
  const playersByKey = new Map<string, { number: string; name: string; team: string; plays: number; yards: number; touchdowns: number }>();
  for (const play of plays) {
    if (!play.playerNumber) continue;
    const team = play.team ?? "home";
    const teamRoster = team === "home" ? rosterRows : awayRosterRows;
    const rosterPlayer = teamRoster.find((row) => row[0] === play.playerNumber);
    const key = `${team}-${play.playerNumber}`;
    const current = playersByKey.get(key) ?? {
      number: play.playerNumber,
      name: rosterPlayer?.[1] ?? `#${play.playerNumber}`,
      team: team === "home" ? homeCode || "HOME" : awayCode || "AWAY",
      plays: 0,
      yards: 0,
      touchdowns: 0,
    };
    current.plays += 1;
    current.yards += Number(play.yards || 0);
    current.touchdowns += play.tag === "TOUCHDOWN" ? 1 : 0;
    playersByKey.set(key, current);
  }
  const leaders = [...playersByKey.values()].sort((a, b) => b.yards - a.yards).slice(0, 3);
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
          {leaders.length ? leaders.map((leader, index) => (
            <div className={index === 0 && leader.yards >= 100 ? "leader standout" : "leader"} key={`${leader.team}-${leader.number}`}>
              <b>#{leader.number}</b><span><strong>{leader.name}</strong><small>{leader.team}</small></span>
              <em>{leader.plays} PLAYS · {leader.yards} YDS · {leader.touchdowns} TD</em>
            </div>
          )) : <p className="empty-panel-copy">Leaders will appear after plays are recorded.</p>}
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
  const latestWithPlayer = [...plays].reverse().find((play) => play.playerNumber);
  const graphicTeam = latestWithPlayer?.team === "away" ? "away" : "home";
  const graphicRoster = graphicTeam === "away" ? awayRosterRows : rosterRows;
  const graphicPlayer = graphicRoster.find((row) => row[0] === latestWithPlayer?.playerNumber);
  const playerPlays = latestWithPlayer?.playerNumber
    ? plays.filter((play) => play.playerNumber === latestWithPlayer.playerNumber && (play.team ?? "home") === graphicTeam)
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
          <div className="preview-stats"><span><b>{playerPlays.length}</b>PLAYS</span><span><b>{playerYards}</b>YDS</span><span><b>{playerPlays.length ? (playerYards / playerPlays.length).toFixed(1) : "0.0"}</b>AVG</span><span><b>{playerTouchdowns}</b>TD</span></div>
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

function Admin() {
  const {
    homeName, setHomeName, awayName, setAwayName, homeCode, setHomeCode,
    awayCode, setAwayCode, rosterRows, setRosterRows, awayRosterRows,
    setAwayRosterRows, scoreboard, backendOnline, saveGame, saveRoster, notify,
  } = useGame();
  const [tested, setTested] = useState(false);
  const [rosterText, setRosterText] = useState(rosterRows.map((row) => row.join("\t")).join("\n"));
  const [awayRosterText, setAwayRosterText] = useState(awayRosterRows.map((row) => row.join("\t")).join("\n"));
  const [homeRosterDirty, setHomeRosterDirty] = useState(false);
  const [awayRosterDirty, setAwayRosterDirty] = useState(false);
  const [previewRows, setPreviewRows] = useState<string[][] | null>(null);
  const [previewTeam, setPreviewTeam] = useState<"home" | "away">("home");
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
    </main>
  );
}

function TommyTvApp() {
  const [role, setRole] = useRole();
  const screen = useMemo(() => {
    if (role === "entry-detail") return <DetailEntry />;
    if (role === "pxp") return <PxpPanel />;
    if (role === "control") return <TvControl />;
    if (role === "admin") return <Admin />;
    return <PrimaryEntry />;
  }, [role]);
  return <div className="app-shell"><Header role={role} setRole={setRole} />{screen}</div>;
}

export default function Home() {
  return <GameProvider><TommyTvApp /></GameProvider>;
}
