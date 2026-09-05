"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { RANK_SYMBOL, SUIT_SYMBOL } from "@/lib/poker/cards";
import { GLOSSARY } from "@/lib/poker/coach";
import { ACTION_LABELS, STREET_LABELS } from "@/lib/poker/engine";
import { evaluateSeven, compareScores } from "@/lib/poker/evaluator";
import { playPokerSound } from "@/lib/poker/sound";
import type { Card, PlayerActionInput } from "@/lib/poker/types";
import type { MultiplayerTableState } from "@/server/multiplayer-types";
import { AudioControls, formatChips } from "./PokerTrainer";
import { PokerTutorial } from "./PokerTutorial";
import CharacterAvatar from "./CharacterAvatar";
import ChaosSkillBadge from "./ChaosSkillBadge";
import type { ChaosSkill } from "@/lib/poker/chaos-types";

interface MultiplayerTableProps {
  state: MultiplayerTableState;
  soundMuted: boolean;
  soundVolume: number;
  bgmMuted: boolean;
  bgmVolume: number;
  onSoundMuted: (muted: boolean) => void;
  onSoundVolume: (volume: number) => void;
  onBgmMuted: (muted: boolean) => void;
  onBgmVolume: (volume: number) => void;
  onAction: (action: PlayerActionInput) => void;
  onUseTimeBank: () => void;
  onNextHand: () => void;
  onRebuy: () => void;
  onToggleGodMode: (enabled: boolean) => void;
  onLeaveRoom: () => void;
  onTransferHost?: (targetPlayerId: string) => void;
  onTakeSeat?: (seatIndex: number) => void;
  onStandUp?: () => void;
  onAddAiBot?: (seatIndex?: number) => void;
  onRemoveAiBot?: (seatIndex: number) => void;
  onFillAiBots?: (targetCount?: number) => void;
  onClearAiBots?: () => void;
  onSelectCharacter?: (characterId: string) => void;
  onUseSkill?: (skillId: string, targetPlayerId?: string, targetCardIndex?: number) => void;
}

type MpPanelTab = "timeline" | "tutorial" | "glossary" | "equity";

function CardFace({
  card,
  hidden = false,
  small = false,
  highlight = false,
  highlightLabel,
  className = "",
}: {
  card?: Card;
  hidden?: boolean;
  small?: boolean;
  highlight?: boolean;
  highlightLabel?: string;
  className?: string;
}) {
  if (hidden) {
    return (
      <div className={`playing-card card-back ${small ? "card-small" : ""} ${className}`} aria-label="暗牌">
        <span>R</span>
      </div>
    );
  }
  if (!card) {
    return <div className={`playing-card card-empty ${small ? "card-small" : ""} ${className}`} aria-hidden="true" />;
  }
  const red = card.suit === "h" || card.suit === "d";
  return (
    <div
      className={`playing-card ${red ? "card-red" : "card-black"} ${small ? "card-small" : ""} ${
        highlight ? "card-highlighted-hole" : ""
      } ${className}`}
      aria-label={`${RANK_SYMBOL[card.rank]}${SUIT_SYMBOL[card.suit]}`}
    >
      {highlight && highlightLabel && <span className="card-hole-badge">{highlightLabel}</span>}
      <span className="card-rank">{RANK_SYMBOL[card.rank]}</span>
      <span className="card-suit">{SUIT_SYMBOL[card.suit]}</span>
    </div>
  );
}

export default function MultiplayerTable({
  state,
  soundMuted,
  soundVolume,
  bgmMuted,
  bgmVolume,
  onSoundMuted,
  onSoundVolume,
  onBgmMuted,
  onBgmVolume,
  onAction,
  onUseTimeBank,
  onNextHand,
  onToggleGodMode,
  onLeaveRoom,
  onTransferHost,
  onTakeSeat,
  onStandUp,
  onAddAiBot,
  onRemoveAiBot,
  onFillAiBots,
  onClearAiBots,
  onSelectCharacter,
  onUseSkill,
}: MultiplayerTableProps) {
  const [tab, setTab] = useState<MpPanelTab>("timeline");
  const [activeSkillTargetModal, setActiveSkillTargetModal] = useState<ChaosSkill | null>(null);

  const mySeat = state.seats.find((s) => s.id === state.myId);
  const isMyTurn = state.activeIndex >= 0 && state.seats[state.activeIndex]?.id === state.myId;
  const activeSeat = state.activeIndex >= 0 ? state.seats[state.activeIndex] : null;

  const minTo = state.legalActions.canRaise ? state.legalActions.minRaiseTo : state.legalActions.minBetTo;
  const maxTo = state.legalActions.maxTo;
  const [betSlider, setBetSlider] = useState(minTo || state.bigBlind);

  const isFirstHandPending = Boolean(state.firstHandPending) || state.handNumber === 0;
  const isHandComplete = state.street === "complete" || Boolean(state.handResultSummary);
  const isComplete = isHandComplete;
  const isWaitingForHost = isFirstHandPending || isHandComplete;

  const seatedPlayers = state.seats.filter((s) => s.id && !s.id.startsWith("empty-"));
  const seatedCount = seatedPlayers.length;
  const canStartNext = seatedCount >= state.config.minPlayers && seatedCount <= 8;

  // Live client countdown & smooth progress bar
  const [remainingSeconds, setRemainingSeconds] = useState(state.turnTimeRemaining);
  const [progressPercent, setProgressPercent] = useState(100);

  useEffect(() => {
    if (state.activeIndex < 0 || state.status !== "playing" || !state.turnExpiresAt || state.turnExpiresAt <= 0 || isWaitingForHost) {
      setRemainingSeconds(0);
      setProgressPercent(0);
      return;
    }

    const update = () => {
      const now = Date.now();
      const remainingMs = Math.max(0, state.turnExpiresAt - now);
      const remainingSec = Math.ceil(remainingMs / 1000);
      const totalMs = Math.max(1000, (state.turnTotalTime || state.config.regularTurnSeconds || 20) * 1000);
      const pct = Math.min(100, Math.max(0, (remainingMs / totalMs) * 100));

      setRemainingSeconds(remainingSec);
      setProgressPercent(pct);
    };

    update();
    const interval = setInterval(update, 100);
    return () => clearInterval(interval);
  }, [state.activeIndex, state.status, state.turnExpiresAt, state.turnTotalTime, state.config.regularTurnSeconds, isWaitingForHost]);

  // Live countdown & smooth progress bar for Chaos Character Selection
  const [charTimeRemaining, setCharTimeRemaining] = useState(
    state.characterSelection?.timeRemaining ?? 20
  );
  const [charProgressPercent, setCharProgressPercent] = useState(100);

  useEffect(() => {
    if (!state.characterSelection?.active || !state.characterSelection.expiresAt) {
      setCharProgressPercent(100);
      setCharTimeRemaining(state.characterSelection?.timeRemaining ?? 20);
      return;
    }

    const totalMs = 20000;
    const updateCharTimer = () => {
      const now = Date.now();
      const remainingMs = Math.max(0, state.characterSelection!.expiresAt - now);
      const remainingSec = Math.ceil(remainingMs / 1000);
      const pct = Math.min(100, Math.max(0, (remainingMs / totalMs) * 100));
      setCharTimeRemaining(remainingSec);
      setCharProgressPercent(pct);
    };

    updateCharTimer();
    const interval = setInterval(updateCharTimer, 100);
    return () => clearInterval(interval);
  }, [state.characterSelection?.active, state.characterSelection?.expiresAt, state.characterSelection?.timeRemaining]);

  const canUseTimeBank = isMyTurn && state.myTimeBankCards > 0 && remainingSeconds <= 5 && !isWaitingForHost;

  useEffect(() => {
    if (isMyTurn) {
      setBetSlider(minTo || state.bigBlind);
    }
  }, [isMyTurn, state.handNumber, state.street, minTo, state.bigBlind]);

  // Keyboard shortcuts F (Fold) & C (Check/Call)
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!isMyTurn || ["INPUT", "TEXTAREA", "SELECT"].includes((event.target as HTMLElement)?.tagName)) return;
      if (event.key.toLowerCase() === "f" && state.legalActions.canFold) {
        handleActionClick({ type: "fold" });
      }
      if (event.key.toLowerCase() === "c" && (state.legalActions.canCheck || state.legalActions.canCall)) {
        handleActionClick({ type: state.legalActions.canCheck ? "check" : "call" });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isMyTurn, state.legalActions]);

  const handleActionClick = (action: PlayerActionInput) => {
    playPokerSound("chips", 0.7);
    onAction(action);
  };

  const handlePreset = (fraction: number) => {
    const pot = state.pot;
    const base = state.currentBet === 0 ? Math.round(pot * fraction) : state.currentBet + Math.round(pot * fraction);
    setBetSlider(Math.max(minTo, Math.min(maxTo, base)));
  };

  const isCardEqual = (a: Card, b: Card): boolean => {
    if (a.id && b.id) return a.id === b.id;
    return a.rank === b.rank && a.suit === b.suit;
  };

  const showdownContenders = useMemo(() => {
    if (!isHandComplete || state.community.length < 5) return [];
    if (state.lastResult && state.lastResult.showdown === false) return [];
    const activeNonFolded = state.seats.filter(
      (s) => s.id && !s.id.startsWith("empty-") && !s.folded && s.holeCards && s.holeCards.length >= 2
    );
    if (activeNonFolded.length === 0) return [];
    if (!state.lastResult && activeNonFolded.length < 2) return [];

    return activeNonFolded
      .map((seat) => {
        const full7 = [...seat.holeCards, ...state.community.slice(0, 5)];
        const score = evaluateSeven(full7);
        const isHoleCard = (c: Card) => seat.holeCards.some((hc) => isCardEqual(hc, c));
        const settlement = state.lastResult?.playerSettlements?.find((s) => s.playerId === seat.id);
        const isWinner = Boolean(
          state.lastResult?.winnerIds?.includes(seat.id) ||
            settlement?.isWinner ||
            (settlement?.net && settlement.net > 0)
        );
        return {
          seat,
          score,
          isHoleCard,
          isWinner,
          settlement,
        };
      })
      .sort((a, b) => {
        if (a.isWinner !== b.isWinner) return a.isWinner ? -1 : 1;
        return compareScores(b.score, a.score);
      });
  }, [isHandComplete, state.community, state.seats, state.lastResult]);

  const showdownContendersMap = useMemo(() => {
    const map = new Map<string, (typeof showdownContenders)[number]>();
    for (const item of showdownContenders) {
      map.set(item.seat.id, item);
    }
    return map;
  }, [showdownContenders]);

  const showEquityTab = Boolean(state.isSpectator || state.godMode);

  return (
    <main className="table-page">
      {/* Upper Status Bar - Exact match of single-player table-topbar */}
      <header className="table-topbar">
        <div className="brand-lockup compact-brand">
          <span className="brand-mark">🌐</span>
          <div>
            <strong>RiverLab</strong>
            <span>局域网多人对战</span>
          </div>
        </div>

        <div className="table-meta">
          <span>房间 {state.roomCode}</span>
          <i />
          <span>8-MAX</span>
          <i />
          <span>在座 {seatedCount}/8</span>
          <i />
          <span>{state.smallBlind}/{state.bigBlind}</span>
          <i />
          <span>{isFirstHandPending ? "第 1 手 (待发牌)" : `第 ${state.handNumber} 手`}</span>
          <i />
          <span>{isFirstHandPending ? "准备就绪" : STREET_LABELS[state.street]}</span>
        </div>

        <div className="table-top-actions">
          {state.isSpectator && (
            <button
              type="button"
              className={state.godMode ? "active" : ""}
              onClick={() => onToggleGodMode(!state.godMode)}
              style={state.godMode ? { color: "var(--gold-light)", borderColor: "var(--gold)" } : undefined}
            >
              {state.godMode ? "👁️ 上帝视角: 开启" : "👁️ 开启上帝视角"}
            </button>
          )}
          {isWaitingForHost && state.isHost && seatedCount < state.config.minPlayers && onFillAiBots && (
            <button
              type="button"
              className="table-quick-sit-btn"
              style={{ color: "#93c5fd", borderColor: "rgba(59, 130, 246, 0.4)" }}
              onClick={() => onFillAiBots(state.config.minPlayers)}
              title={`一键添加 AI 补齐至 ${state.config.minPlayers} 人`}
            >
              🤖 补齐 AI ({seatedCount}/{state.config.minPlayers})
            </button>
          )}
          {isWaitingForHost && state.isSpectator && onTakeSeat && seatedCount < 8 && (
            <button
              type="button"
              className="table-quick-sit-btn"
              onClick={() => {
                const firstEmpty = state.seats.findIndex((s) => !s.id || s.id.startsWith("empty-"));
                if (firstEmpty !== -1) {
                  onTakeSeat(firstEmpty);
                }
              }}
              title="入座第一个空闲座位"
            >
              💺 快速入座
            </button>
          )}
          {!state.isSpectator && (
            <span>
              筹码 <b>{formatChips(mySeat?.stack ?? 0)}</b>
            </span>
          )}
          {isWaitingForHost && !state.isSpectator && onStandUp && (
            <button
              type="button"
              className="table-standup-btn"
              onClick={() => {
                if (window.confirm("确认离座转为观战吗？（下一手牌将不再为你发牌）")) {
                  onStandUp();
                }
              }}
              title="离开座位转为观战"
            >
              🚶 转为观战
            </button>
          )}
          {state.isHost && onTransferHost && (
            <select
              className="table-host-select"
              defaultValue=""
              onChange={(e) => {
                const targetId = e.target.value;
                if (!targetId) return;
                const target = state.seats.find((s) => s.id === targetId) ?? state.spectators.find((s) => s.id === targetId);
                const name = target?.name ?? "该玩家";
                if (window.confirm(`确认在对局中将房主身份移交给「${name}」吗？`)) {
                  onTransferHost(targetId);
                }
                e.target.value = "";
              }}
              title="移交房主给其他玩家"
            >
              <option value="" disabled>👑 移交房主...</option>
              {state.seats
                .filter((s) => s.id && !s.id.startsWith("empty-") && s.id !== state.myId)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    在座: {s.name} (#{state.seats.indexOf(s) + 1})
                  </option>
                ))}
              {state.spectators
                .filter((s) => s.id !== state.myId)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    旁观: {s.name}
                  </option>
                ))}
            </select>
          )}
          <button type="button" onClick={onLeaveRoom}>
            离开房间
          </button>
        </div>
      </header>

      {/* Audio Controls - Fixed at top-right exactly like single-player */}
      <AudioControls
        soundMuted={soundMuted}
        soundVolume={soundVolume}
        onSoundMuted={onSoundMuted}
        onSoundVolume={onSoundVolume}
        bgmMuted={bgmMuted}
        bgmVolume={bgmVolume}
        onBgmMuted={onBgmMuted}
        onBgmVolume={onBgmVolume}
      />

      <div className="table-layout">
        {/* Left: Felt Arena */}
        <section className="arena-wrap">
          <div className="felt-table">
            <div className="felt-line" />
            <div className="table-brand">
              RIVERLAB <span>LAN MULTIPLAYER</span>
            </div>

            {/* Pot Display */}
            <div className="pot-display">
              <span>{isComplete ? "本手底池" : "底池"}</span>
              <strong>{formatChips(state.pot)}</strong>
              <em>{(state.pot / state.bigBlind).toFixed(1)}BB</em>
            </div>

            {/* Board Cards */}
            <div className="board-cards">
              {[0, 1, 2, 3, 4].map((index) => (
                <CardFace key={index} card={state.community[index]} />
              ))}
            </div>

            {/* 8 Seats - Exact match of single-player seat styling */}
            {state.seats.map((seat, index) => {
              const isEmpty = !seat.id || seat.id.startsWith("empty-");
              if (isEmpty) {
                if (!isWaitingForHost) return null;
                return (
                  <div
                    key={`empty-${index}`}
                    className={`table-seat seat-${index} seat-empty`}
                  >
                    <div className="seat-empty-panel">
                      <span className="seat-empty-label">座位 {index + 1}</span>
                      {state.isSpectator && onTakeSeat && (
                        <button
                          type="button"
                          className="seat-take-btn"
                          onClick={() => onTakeSeat(index)}
                          title={`入座座位 ${index + 1}`}
                        >
                          💺 入座此位
                        </button>
                      )}
                      {state.isHost && onAddAiBot && (
                        <button
                          type="button"
                          className="seat-take-btn seat-add-ai-btn"
                          onClick={() => onAddAiBot(index)}
                          title={`在座位 ${index + 1} 添加 AI 机器人`}
                          style={{ marginTop: "4px", background: "rgba(59, 130, 246, 0.2)", borderColor: "rgba(59, 130, 246, 0.4)", color: "#93c5fd" }}
                        >
                          🤖 添加 AI
                        </button>
                      )}
                    </div>
                  </div>
                );
              }

              const isActive = state.activeIndex === index;
              const isHero = seat.id === state.myId;
              const showCards = isHero || state.godMode || seat.folded || state.street === "showdown" || state.street === "complete";
              const seatEquity = state.godMode ? state.godModeEquities?.find((eq) => eq.playerId === seat.id) : undefined;
              const seatSettlement = isHandComplete
                ? state.lastResult?.playerSettlements?.find((s) => s.playerId === seat.id)
                : undefined;
              const seatShowdown = showdownContendersMap.get(seat.id);

              return (
                <div
                  key={seat.id}
                  className={`table-seat seat-${index} ${isActive ? "seat-active" : ""} ${
                    seat.folded ? "seat-folded" : ""
                  }`}
                >
                  {/* Floating Settlement Profit/Loss Badge */}
                  {isHandComplete && seatSettlement && (
                    <div
                      className={`seat-settlement-badge ${
                        seatSettlement.net > 0 ? "win" : seatSettlement.net < 0 ? "loss" : "even"
                      }`}
                      title={`投入: ${formatChips(seatSettlement.contributed)} · 获得: ${formatChips(seatSettlement.received)} · 净结果: ${seatSettlement.net > 0 ? "+" : ""}${formatChips(seatSettlement.net)}`}
                    >
                      <span className="settlement-badge-tag">{seatSettlement.net > 0 ? "胜" : seatSettlement.net < 0 ? "亏" : "平"}</span>
                      <span className="settlement-badge-amount">
                        {seatSettlement.net > 0 ? "+" : seatSettlement.net < 0 ? "−" : "±0"}{formatChips(Math.abs(seatSettlement.net))}
                      </span>
                      <small className="settlement-badge-bb">
                        ({seatSettlement.net > 0 ? "+" : seatSettlement.net < 0 ? "−" : ""}{(Math.abs(seatSettlement.net) / state.bigBlind).toFixed(1)}BB)
                      </small>
                    </div>
                  )}

                  {/* Floating Live Equity Pill right beside player's cards/avatar */}
                  {state.godMode && seatEquity && (
                    <div
                      className={`seat-floating-equity ${seatEquity.isFolded ? "folded" : ""} ${
                        !seatEquity.isFolded && seatEquity.equity >= 0.5 ? "leading" : ""
                      }`}
                      title={
                        seatEquity.isFolded
                          ? "已弃牌 (胜率 0.0%)"
                          : `当前真实胜率: ${seatEquity.equityFormatted || `${(seatEquity.equity * 100).toFixed(1)}%`}`
                      }
                    >
                      <span className="eq-pill-tag">{seatEquity.isFolded ? "弃牌" : "胜率"}</span>
                      <b className="eq-pill-val">
                        {seatEquity.isFolded
                          ? "0.0%"
                          : (seatEquity.equityFormatted || `${(seatEquity.equity * 100).toFixed(1)}%`)}
                      </b>
                    </div>
                  )}

                  <div className="seat-cards">
                    {seat.holeCards.length > 0 ? (
                      seat.holeCards.map((c, i) => (
                        <CardFace
                          key={i}
                          card={c}
                          hidden={!showCards}
                          small
                        />
                      ))
                    ) : (
                      !seat.folded && (
                        <>
                          <CardFace hidden small />
                          <CardFace hidden small />
                        </>
                      )
                    )}
                  </div>

                  <div className={`seat-panel ${seat.characterId ? "has-character" : ""}`}>
                    {seat.position && <span className="seat-position">{seat.position}</span>}
                    {seat.characterId ? (
                      <div
                        className="seat-hero-layout"
                        title={
                          `${seat.characterName || "出战角色"} · ${seat.characterTitle || ""}\n` +
                          (seat.characterSkills
                            ?.map(
                              (s) =>
                                `【${s.name}】(${s.type === "limited" ? "限定技" : "锁定技"})${
                                  seat.skillStates?.[s.id]?.used ? " [已发动/灰化]" : ""
                                }：${s.description}`
                            )
                            .join("\n") || "")
                        }
                      >
                        <div className="seat-hero-avatar-box">
                          <CharacterAvatar
                            src={seat.characterAvatar}
                            name={seat.characterName}
                            fallbackText={seat.characterFallbackText}
                            themeColor={seat.characterThemeColor || "#38bdf8"}
                            size="md"
                            showBorder={true}
                          />
                          {seat.characterSkills?.some((s) => s.type === "limited") && (
                            <span
                              className={`seat-skill-micro-badge ${
                                seat.characterSkills.some(
                                  (s) => s.type === "limited" && seat.skillStates?.[s.id]?.used
                                )
                                  ? "spent"
                                  : "ready"
                              }`}
                              title={
                                seat.characterSkills.some(
                                  (s) => s.type === "limited" && seat.skillStates?.[s.id]?.used
                                )
                                  ? "限定技已耗尽 (已变灰)"
                                  : "限定技待命中"
                              }
                            >
                              {seat.characterSkills.some(
                                (s) => s.type === "limited" && seat.skillStates?.[s.id]?.used
                              )
                                ? "灰"
                                : "🔥"}
                            </span>
                          )}
                        </div>

                        <div className="seat-hero-meta">
                          <div className="seat-hero-title-row">
                            <span
                              className="seat-hero-badge"
                              style={{
                                backgroundColor: seat.characterThemeColor || "#38bdf8",
                                color: "#0f172a",
                              }}
                            >
                              {seat.characterTitle || "角色"}
                            </span>
                            <span className="seat-hero-name" style={{ color: seat.characterThemeColor || "#38bdf8" }}>
                              {seat.characterName}
                            </span>
                          </div>
                          <b className="seat-player-name-line">
                            {seat.isHost && <span title="当前房主">👑 </span>}
                            {seat.isAi && <span className="seat-ai-tag" title="AI 机器人" style={{ color: "#60a5fa", marginRight: "3px" }}>🤖</span>}
                            {seat.name} {isHero && "(你)"}
                          </b>
                          <strong className="seat-hero-chips">
                            {formatChips(seat.stack)}{" "}
                            <small>{(seat.stack / state.bigBlind).toFixed(0)}BB</small>
                          </strong>
                        </div>
                      </div>
                    ) : (
                      <>
                        <b>
                          {seat.isHost && <span title="当前房主">👑 </span>}
                          {seat.isAi && <span className="seat-ai-tag" title="AI 机器人" style={{ color: "#60a5fa", marginRight: "3px" }}>🤖</span>}
                          {seat.name} {isHero && "(你)"}
                        </b>
                        <strong>
                          {formatChips(seat.stack)}{" "}
                          <small>{(seat.stack / state.bigBlind).toFixed(0)}BB</small>
                        </strong>
                      </>
                    )}
                    {state.isHost && seat.isAi && isWaitingForHost && onRemoveAiBot && (
                      <button
                        type="button"
                        className="seat-remove-ai-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`确认移除 AI「${seat.name}」吗？`)) {
                            onRemoveAiBot(index);
                          }
                        }}
                        title="移除该 AI 机器人"
                        style={{ marginTop: "4px", background: "rgba(239, 68, 68, 0.2)", borderColor: "rgba(239, 68, 68, 0.4)", color: "#f87171", fontSize: "11px", padding: "2px 6px", borderRadius: "4px", cursor: "pointer" }}
                      >
                        ✕ 移除 AI
                      </button>
                    )}
                    {state.isHost && !isHero && !seat.isAi && onTransferHost && (
                      <button
                        type="button"
                        className="seat-transfer-host-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`确认在对局中将房主身份移交给「${seat.name}」吗？`)) {
                            onTransferHost(seat.id);
                          }
                        }}
                        title="移交房主给此玩家"
                      >
                        👑 设为房主
                      </button>
                    )}
                    {isHero && isWaitingForHost && onStandUp && (
                      <button
                        type="button"
                        className="seat-standup-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm("确认离座转为观战吗？（下一手牌将不再为你发牌）")) {
                            onStandUp();
                          }
                        }}
                        title="离座转为观战"
                      >
                        🚶 离座观战
                      </button>
                    )}
                    {/* Live God Mode Equity & Hand Display in Seat Panel */}
                    {state.godMode && seatEquity && (
                      <div
                        className={`seat-live-equity ${seatEquity.isFolded ? "folded" : ""} ${
                          !seatEquity.isFolded && seatEquity.equity >= 0.5 ? "leading" : ""
                        }`}
                        title={
                          seatEquity.isFolded
                            ? "已弃牌 (胜率 0.0%)"
                            : `实时胜率: ${seatEquity.equityFormatted || `${(seatEquity.equity * 100).toFixed(1)}%`} · 当前手牌: ${seatEquity.handName || ""}`
                        }
                      >
                        <span className="eq-label">胜率</span>
                        <b className="eq-pct">
                          {seatEquity.isFolded
                            ? "0.0%"
                            : (seatEquity.equityFormatted || `${(seatEquity.equity * 100).toFixed(1)}%`)}
                        </b>
                        {!seatEquity.isFolded && seatEquity.handName && (
                          <span className="eq-hand">{seatEquity.handName}</span>
                        )}
                      </div>
                    )}
                    {seat.folded && (
                      <span
                        className={`seat-action ${seat.lastActionThinkingText?.includes("已深度思考") ? "deep-action" : ""}`}
                        title={seat.lastActionThinkingText ? `弃牌 · ${seat.lastActionThinkingText}` : undefined}
                      >
                        弃牌
                        {seat.lastActionThinkingText && (
                          <span className="seat-action-time"> · {seat.lastActionThinkingText}</span>
                        )}
                      </span>
                    )}
                    {seat.allIn && (
                      <span
                        className={`seat-action ${seat.lastActionThinkingText?.includes("已深度思考") ? "deep-action" : ""}`}
                        style={{ color: "#ffd6d3" }}
                        title={seat.lastActionThinkingText ? `ALL-IN · ${seat.lastActionThinkingText}` : undefined}
                      >
                        ALL-IN
                        {seat.lastActionThinkingText && (
                          <span className="seat-action-time"> · {seat.lastActionThinkingText}</span>
                        )}
                      </span>
                    )}
                    {!seat.folded && !seat.allIn && seat.lastAction && (
                      <span
                        className={`seat-action ${seat.lastActionThinkingText?.includes("已深度思考") ? "deep-action" : ""}`}
                        title={seat.lastActionThinkingText ? `${ACTION_LABELS[seat.lastAction as keyof typeof ACTION_LABELS] || seat.lastAction} · ${seat.lastActionThinkingText}` : undefined}
                      >
                        {ACTION_LABELS[seat.lastAction as keyof typeof ACTION_LABELS] || seat.lastAction}
                        {seat.lastActionThinkingText && (
                          <span className="seat-action-time"> · {seat.lastActionThinkingText}</span>
                        )}
                      </span>
                    )}
                    {isActive && (
                      <>
                        <span className="seat-action" style={{ color: remainingSeconds <= 5 ? "#ef4444" : "var(--gold-light)" }}>
                          思考中 {remainingSeconds}s
                        </span>
                        <div className="seat-thinking-bar" title={`思考倒计时 ${remainingSeconds}s`}>
                          <div
                            className={`seat-thinking-fill ${remainingSeconds <= 5 ? "urgent" : ""}`}
                            style={{ width: `${progressPercent}%` }}
                          />
                        </div>
                      </>
                    )}
                  </div>

                  {seat.committedStreet > 0 && (
                    <div className="seat-bet">
                      <span>本轮</span>
                      <b>{formatChips(seat.committedStreet)}</b>
                    </div>
                  )}

                  {index === state.buttonIndex && <div className="dealer-button">D</div>}
                </div>
              );
            })}
          </div>

          {/* Action Dock - Exact match of single-player action-dock with live progress bar */}
          <div className="action-dock">
            {!isWaitingForHost && state.activeIndex >= 0 && (
              <div className="dock-timer-track">
                <div
                  className={`dock-timer-fill ${remainingSeconds <= 5 ? "urgent" : ""}`}
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            )}

            {/* Chaos Mode: Hero Character Cockpit HUD */}
            {state.chaosMode && mySeat?.characterId && (
              <div
                className="hero-chaos-hud"
                style={{
                  borderColor: mySeat.characterThemeColor ? `${mySeat.characterThemeColor}55` : undefined,
                }}
              >
                {!isWaitingForHost && state.activeIndex >= 0 && (
                  <div className="hero-chaos-timer-track" title={`思考倒计时 ${remainingSeconds}s`}>
                    <div
                      className={`hero-chaos-timer-fill ${remainingSeconds <= 5 ? "urgent" : ""}`}
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                )}
                <div className="hero-chaos-avatar-slot">
                  <CharacterAvatar
                    src={mySeat.characterAvatar}
                    name={mySeat.characterName}
                    fallbackText={mySeat.characterFallbackText}
                    themeColor={mySeat.characterThemeColor || "#38bdf8"}
                    size="lg"
                    shape="circle"
                    showBorder={true}
                  />
                </div>
                <div className="hero-chaos-info">
                  <div className="hero-chaos-tagline">
                    <span
                      className="hero-chaos-badge"
                      style={{
                        backgroundColor: mySeat.characterThemeColor || "#38bdf8",
                        color: "#0f172a",
                      }}
                    >
                      {mySeat.characterTitle || "出战角色"}
                    </span>
                    <strong className="hero-chaos-name">{mySeat.characterName}</strong>
                  </div>
                  <small style={{ color: "#94a3b8", fontSize: "11px" }}>专属技能栏 (限定技一局限一次，用完灰化)</small>
                </div>
                <div className="hero-chaos-skills-tray">
                  {mySeat.characterSkills && mySeat.characterSkills.length > 0 ? (
                    mySeat.characterSkills.map((skill) => {
                      const status = mySeat.skillStates?.[skill.id];
                      return (
                        <ChaosSkillBadge
                          key={skill.id}
                          skill={skill}
                          status={status}
                          interactive={true}
                          size="sm"
                          onTrigger={(s) => {
                            if (s.targetType === "player" || s.targetType === "self_card") {
                              setActiveSkillTargetModal(s);
                            } else {
                              onUseSkill?.(s.id);
                            }
                          }}
                        />
                      );
                    })
                  ) : (
                    <div className="hero-chaos-skill-pill" title="技能设计接入就绪">
                      <span>⚡ 专属技能准备就绪</span>
                    </div>
                  )}

                  {/* 锁定技【显影】透视公共牌预览 */}
                  {state.chaosPeekCards && state.chaosPeekCards.length > 0 && (
                    <div className="hero-chaos-peek-slot" title="【显影】翻前预知到的下一张公共牌">
                      <span className="peek-tag">👁️ 翻牌显影</span>
                      <CardFace card={state.chaosPeekCards[0]} small />
                    </div>
                  )}

                  {/* 锁定技【出千】牌堆底牌预览 */}
                  {state.chaosDeckBottomCards && state.chaosDeckBottomCards.length > 0 && (
                    <div className="hero-chaos-peek-slot chuqian-slot" title="【出千】始终可见的牌堆底3张牌">
                      <span className="peek-tag">🃏 出千底牌</span>
                      <div className="chuqian-cards-row" style={{ display: "flex", gap: "4px" }}>
                        {state.chaosDeckBottomCards.map((c, i) => (
                          <CardFace key={i} card={c} small />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Chaos Mode: Target Selection Dialog for Skills */}
            {activeSkillTargetModal && (
              <div className="skill-target-dialog" role="dialog" aria-modal="true" aria-label="选择技能目标">
                <div className="skill-target-dialog-inner">
                  <div className="skill-target-header">
                    <span className="skill-target-badge">
                      {activeSkillTargetModal.type === "limited" ? "🔥 限定技发动" : "⚡ 技能发动"}
                    </span>
                    <h4>【{activeSkillTargetModal.name}】选择生效目标</h4>
                    <p>{activeSkillTargetModal.description}</p>
                  </div>

                  {activeSkillTargetModal.targetType === "player" && (
                    <div className="skill-target-players-list">
                      <p className="skill-target-prompt">请选择场上一名目标对手：</p>
                      <div className="skill-target-chips">
                        {state.seats
                          .filter((s) => s.id && !s.id.startsWith("empty-") && s.id !== state.myId && !s.folded)
                          .map((targetSeat) => (
                            <button
                              key={targetSeat.id}
                              type="button"
                              className="skill-target-player-btn"
                              onClick={() => {
                                onUseSkill?.(activeSkillTargetModal.id, targetSeat.id);
                                setActiveSkillTargetModal(null);
                              }}
                            >
                              <CharacterAvatar
                                src={targetSeat.characterAvatar}
                                name={targetSeat.name}
                                fallbackText={targetSeat.characterFallbackText}
                                themeColor={targetSeat.characterThemeColor}
                                size="sm"
                              />
                              <span className="target-name">{targetSeat.name}</span>
                              <small className="target-chips">{formatChips(targetSeat.stack)}</small>
                            </button>
                          ))}
                      </div>
                    </div>
                  )}

                  {activeSkillTargetModal.targetType === "self_card" && (
                    <div className="skill-target-cards-list">
                      <p className="skill-target-prompt">
                        {activeSkillTargetModal.id === "skill_bianpai"
                          ? "请选择你想要尝试变造为【♦3】的底牌："
                          : "请选择你想要替换为随机未使用牌的底牌："}
                      </p>
                      <div className="skill-target-cards">
                        {(mySeat?.holeCards ?? []).map((c, idx) => (
                          <button
                            key={idx}
                            type="button"
                            className="skill-target-card-btn"
                            onClick={() => {
                              onUseSkill?.(activeSkillTargetModal.id, undefined, idx);
                              setActiveSkillTargetModal(null);
                            }}
                          >
                            <span className="target-card-index">第 {idx + 1} 张底牌</span>
                            <CardFace card={c} small />
                            <span className="target-card-action">
                              {activeSkillTargetModal.id === "skill_bianpai" ? "变幻为 ♦3" : "随机换牌"}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="skill-target-footer">
                    <button
                      type="button"
                      className="skill-target-cancel-btn"
                      onClick={() => setActiveSkillTargetModal(null)}
                    >
                      取消
                    </button>
                  </div>
                </div>
              </div>
            )}

            {isFirstHandPending ? (
              <div className="hand-complete">
                <div className="hand-result-copy">
                  <span>准备就绪</span>
                  <strong>
                    {canStartNext
                      ? "全员入座完毕 · 待房主确认发牌"
                      : `牌桌人数不足：当前 ${seatedCount} 人，至少需要 ${state.config.minPlayers} 人在座才能开始游戏`}
                  </strong>
                </div>
                <div>
                  {state.isHost ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px", alignItems: "center" }}>
                      <button
                        className="primary-button"
                        onClick={onNextHand}
                        disabled={!canStartNext}
                        title={
                          !canStartNext
                            ? `当前在座人数 (${seatedCount}/${state.config.minPlayers})，至少需要 ${state.config.minPlayers} 人在座才能开始`
                            : undefined
                        }
                      >
                        {canStartNext ? (
                          <>开始第一手 <span>🚀</span></>
                        ) : (
                          <>等待玩家入座 ({seatedCount}/${state.config.minPlayers}人) ⏳</>
                        )}
                      </button>
                      {!canStartNext && onFillAiBots && (
                        <button
                          type="button"
                          className="primary-button"
                          style={{ background: "linear-gradient(135deg, #2563eb, #1d4ed8)", boxShadow: "0 0 12px rgba(37,99,235,0.4)" }}
                          onClick={() => onFillAiBots(state.config.minPlayers)}
                          title={`一键添加 AI 补齐至 ${state.config.minPlayers} 人开局`}
                        >
                          🤖 一键补齐 AI ({seatedCount}/{state.config.minPlayers}人)
                        </button>
                      )}
                    </div>
                  ) : (
                    <span className="empty-copy">
                      {canStartNext
                        ? "等待房主确认并开启第一手..."
                        : `等待更多玩家入座 (${seatedCount}/${state.config.minPlayers}人)...`}
                    </span>
                  )}
                </div>
              </div>
            ) : isHandComplete ? (
              <div className="hand-complete">
                <div className="hand-result-copy">
                  <span>本手结束</span>
                  <strong>
                    {state.handResultSummary || "牌局结算完成"}
                    {!canStartNext && (
                      <span style={{ display: "block", color: "#f87171", fontSize: "11px", marginTop: "3px" }}>
                        ⚠️ 当前在座玩家 ({seatedCount}/{state.config.minPlayers}人)，需至少 {state.config.minPlayers} 人在座才能开始下一手
                      </span>
                    )}
                  </strong>

                  {/* Showdown 5-Card Combinations Showcase */}
                  {showdownContenders.length > 0 && (
                    <div className="showdown-hands-container">
                      <div className="showdown-hands-header">
                        <span className="showdown-hands-title">
                          <span className="showdown-icon">⚔️</span> 摊牌比牌 · 牌力与五张组合
                        </span>
                        <span className="showdown-hands-sub">
                          金框高亮为玩家自身底牌 ({showdownContenders.length}家参与比牌)
                        </span>
                      </div>
                      <div className="showdown-hands-grid">
                        {showdownContenders.map(({ seat, score, isHoleCard, isWinner, settlement }) => {
                          const isHero = seat.id === state.myId;
                          const holeUsedCount = score.cards.filter(isHoleCard).length;
                          return (
                            <div
                              key={seat.id}
                              className={`showdown-contender-card ${isWinner ? "is-winner" : ""} ${isHero ? "is-hero" : ""}`}
                            >
                              <div className="showdown-contender-header">
                                <div className="showdown-contender-user">
                                  {isWinner ? (
                                    <span className="showdown-crown-badge">👑 胜者</span>
                                  ) : (
                                    <span className="showdown-contender-tag">比牌</span>
                                  )}
                                  <span className="showdown-contender-name" title={seat.name}>
                                    {seat.name} {isHero && <em className="hero-tag">你</em>}
                                  </span>
                                  {seat.position && (
                                    <span className="showdown-contender-pos">{seat.position}</span>
                                  )}
                                </div>

                                <div className="showdown-contender-rank-box">
                                  <span className={`showdown-rank-badge rank-category-${score.category}`}>
                                    【{score.name}】
                                  </span>
                                  {settlement && (
                                    <span
                                      className={`showdown-net-pill ${
                                        settlement.net > 0 ? "win" : settlement.net < 0 ? "loss" : "even"
                                      }`}
                                    >
                                      {settlement.net > 0 ? "+" : settlement.net < 0 ? "−" : "±0"}
                                      {formatChips(Math.abs(settlement.net))}
                                    </span>
                                  )}
                                </div>
                              </div>

                              <div className="showdown-five-cards">
                                {score.cards.map((c, idx) => {
                                  const isFromHole = isHoleCard(c);
                                  return (
                                    <CardFace
                                      key={`${c.rank}-${c.suit}-${idx}`}
                                      card={c}
                                      small
                                      highlight={isFromHole}
                                      highlightLabel="底牌"
                                    />
                                  );
                                })}
                              </div>

                              <div className="showdown-contender-footer">
                                <span className="showdown-usage-desc">
                                  {holeUsedCount === 2 ? (
                                    <>使用 <b>2</b> 张自身底牌 + <b>3</b> 张公共牌</>
                                  ) : holeUsedCount === 1 ? (
                                    <>使用 <b>1</b> 张自身底牌 + <b>4</b> 张公共牌</>
                                  ) : (
                                    <>公共牌打板 (<b>0</b> 张底牌)</>
                                  )}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {state.lastResult?.playerSettlements && state.lastResult.playerSettlements.length > 0 && (
                    <div className="hand-settlement-grid">
                      <div className="hand-settlement-header-row">
                        <span>本手各玩家盈亏明细 ({state.lastResult.playerSettlements.length}人参与)</span>
                        <small>投入 · 获得 · 净结果</small>
                      </div>
                      <div className="hand-settlement-cards">
                        {state.lastResult.playerSettlements.map((p) => {
                          const isHero = p.playerId === state.myId;
                          const isWin = p.net > 0;
                          const isLoss = p.net < 0;
                          const toneClass = isWin ? "win" : isLoss ? "loss" : "even";
                          return (
                            <div key={p.playerId} className={`settlement-pill ${toneClass} ${isHero ? "is-hero" : ""}`}>
                              <div className="settlement-pill-left">
                                <span className="settlement-pill-tag">
                                  {isWin ? "赢家" : p.folded ? "弃牌" : "跟注"}
                                </span>
                                <span className="settlement-pill-name" title={p.playerName}>
                                  {p.playerName} {isHero && "(你)"}
                                </span>
                              </div>
                              <div className="settlement-pill-right">
                                <span className="settlement-pill-amount">
                                  {isWin ? "+" : isLoss ? "−" : "±0"}{formatChips(Math.abs(p.net))}
                                </span>
                                <small className="settlement-pill-bb">
                                  ({isWin ? "+" : isLoss ? "−" : ""}{(Math.abs(p.net) / state.bigBlind).toFixed(1)}BB)
                                </small>
                                <span className="settlement-pill-detail" title={`投入 ${formatChips(p.contributed)} · 获得 ${formatChips(p.received)}`}>
                                  投{formatChips(p.contributed)}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
                <div>
                  {state.isHost ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px", alignItems: "center" }}>
                      <button
                        className="primary-button"
                        onClick={onNextHand}
                        disabled={!canStartNext}
                        title={
                          !canStartNext
                            ? `当前在座人数 (${seatedCount}/${state.config.minPlayers})，至少需要 ${state.config.minPlayers} 人在座才能开始`
                            : undefined
                        }
                      >
                        {canStartNext ? (
                          <>开始下一手 <span>→</span></>
                        ) : (
                          <>等待玩家入座 ({seatedCount}/${state.config.minPlayers}人) ⏳</>
                        )}
                      </button>
                      {!canStartNext && onFillAiBots && (
                        <button
                          type="button"
                          className="primary-button"
                          style={{ background: "linear-gradient(135deg, #2563eb, #1d4ed8)", boxShadow: "0 0 12px rgba(37,99,235,0.4)" }}
                          onClick={() => onFillAiBots(state.config.minPlayers)}
                          title={`一键添加 AI 补齐至 ${state.config.minPlayers} 人`}
                        >
                          🤖 一键补齐 AI ({seatedCount}/{state.config.minPlayers}人)
                        </button>
                      )}
                    </div>
                  ) : (
                    <span className="empty-copy">
                      {canStartNext
                        ? "等待房主开启下一手..."
                        : `等待更多玩家入座 (${seatedCount}/${state.config.minPlayers}人)...`}
                    </span>
                  )}
                </div>
              </div>
            ) : isMyTurn ? (
              <div className="human-actions">
                <div className="sizing-controls">
                  <div className="preset-row">
                    <span>思考:</span>
                    <b style={{ color: remainingSeconds <= 5 ? "#ef4444" : "var(--gold-light)", fontSize: "11px", minWidth: "26px" }}>
                      {remainingSeconds}s
                    </b>
                    <button
                      type="button"
                      disabled={!canUseTimeBank}
                      onClick={onUseTimeBank}
                      title={
                        state.myTimeBankCards <= 0
                          ? "延时卡已用尽"
                          : remainingSeconds > 5
                          ? `剩余 ≤5s 时可用 · 增加一倍单次思考时间 (+${state.config.regularTurnSeconds}s)`
                          : `点击使用延时卡 (+${state.config.regularTurnSeconds}s)`
                      }
                      style={{
                        borderColor: canUseTimeBank ? "var(--gold)" : undefined,
                        color: canUseTimeBank ? "var(--gold-light)" : undefined,
                        fontWeight: canUseTimeBank ? 800 : undefined,
                      }}
                    >
                      ⏱️ 延时卡 ({state.myTimeBankCards}张 · +{state.config.regularTurnSeconds}s)
                    </button>
                    {(state.legalActions.canBet || state.legalActions.canRaise) && (
                      <>
                        <button type="button" onClick={() => handlePreset(0.5)}>1/2</button>
                        <button type="button" onClick={() => handlePreset(0.67)}>2/3</button>
                        <button type="button" onClick={() => handlePreset(1.0)}>全池</button>
                        <button type="button" onClick={() => setBetSlider(state.legalActions.maxTo)}>All-In</button>
                      </>
                    )}
                  </div>

                  {(state.legalActions.canBet || state.legalActions.canRaise) && (
                    <div className="range-row">
                      <input
                        type="range"
                        min={minTo}
                        max={maxTo}
                        step={state.bigBlind}
                        value={betSlider}
                        onChange={(e) => setBetSlider(Number(e.target.value))}
                      />
                      <input
                        type="number"
                        min={minTo}
                        max={maxTo}
                        step={state.bigBlind}
                        value={betSlider}
                        onChange={(e) => setBetSlider(Number(e.target.value))}
                      />
                      <em>{(betSlider / state.bigBlind).toFixed(0)}BB</em>
                    </div>
                  )}
                </div>

                <div className="action-buttons">
                  {state.legalActions.canFold && (
                    <button type="button" onClick={() => handleActionClick({ type: "fold" })}>
                      弃牌 <kbd>F</kbd>
                    </button>
                  )}
                  {state.legalActions.canCheck && (
                    <button type="button" onClick={() => handleActionClick({ type: "check" })}>
                      过牌 <kbd>C</kbd>
                    </button>
                  )}
                  {state.legalActions.canCall && (
                    <button type="button" onClick={() => handleActionClick({ type: "call" })}>
                      跟注 {formatChips(state.legalActions.callAmount)} <kbd>C</kbd>
                    </button>
                  )}
                  {state.legalActions.canBet && (
                    <button
                      type="button"
                      className="raise-button"
                      onClick={() => handleActionClick({ type: "bet", amount: betSlider })}
                    >
                      下注 {formatChips(betSlider)}
                    </button>
                  )}
                  {state.legalActions.canRaise && (
                    <button
                      type="button"
                      className="raise-button"
                      onClick={() => handleActionClick({ type: "raise", amount: betSlider })}
                    >
                      加注到 {formatChips(betSlider)}
                    </button>
                  )}
                  {state.legalActions.canAllIn && (
                    <button
                      type="button"
                      className="allin-button"
                      onClick={() => handleActionClick({ type: "all-in" })}
                    >
                      全下 {formatChips(state.legalActions.maxTo)}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="waiting-action">
                <div className="thinking-dots">
                  <i />
                  <i />
                  <i />
                </div>
                <div className="waiting-action-detail">
                  <p>
                    等待 <b>{activeSeat?.name ?? "玩家"}</b> 行动中... <em>({remainingSeconds}s)</em>
                  </p>
                  <div className="waiting-timer-track">
                    <div
                      className={`waiting-timer-fill ${remainingSeconds <= 5 ? "urgent" : ""}`}
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Right Side Panel - Exact match of single-player SidePanel */}
        <aside className="side-panel">
          <div
            className="panel-tabs"
            style={{
              gridTemplateColumns: showEquityTab ? "repeat(4, 1fr)" : "repeat(3, 1fr)",
            }}
          >
            <button
              className={tab === "timeline" ? "active" : ""}
              onClick={() => setTab("timeline")}
            >
              行动
            </button>
            <button
              className={tab === "tutorial" ? "active" : ""}
              onClick={() => setTab("tutorial")}
            >
              教程
            </button>
            <button
              className={tab === "glossary" ? "active" : ""}
              onClick={() => setTab("glossary")}
            >
              黑话
            </button>
            {showEquityTab && (
              <button
                className={tab === "equity" ? "active" : ""}
                onClick={() => setTab("equity")}
              >
                胜率
              </button>
            )}
          </div>

          <div className="panel-content">
            {tab === "timeline" && (
              <div className="timeline">
                <div className="timeline-stage-header">
                  <div className="tsh-main">
                    <div className="tsh-title-row">
                      <span className="tsh-label">当前牌局阶段</span>
                      {!isHandComplete && !isFirstHandPending && (
                        <span className="tsh-live-indicator">
                          <span className="tsh-pulse-dot" /> 进行中
                        </span>
                      )}
                      {isHandComplete && (
                        <span className="tsh-complete-indicator">已结束</span>
                      )}
                    </div>
                    <strong className={`tsh-stage-badge street-${state.street}`}>
                      {isFirstHandPending ? "准备就绪 Ready" : STREET_LABELS[state.street]}
                    </strong>
                  </div>
                  {state.community.length > 0 && (
                    <div className="tsh-board">
                      <span className="tsh-board-label">当前公共牌 ({state.community.length}张)</span>
                      <div className="tsh-board-cards">
                        {state.community.map((card, i) => (
                          <CardFace key={i} card={card} small />
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <h3>行动时间线</h3>
                {state.actionLog.length === 0 ? (
                  <p className="empty-copy">本手牌局刚开始，暂无公开行动。</p>
                ) : (
                  state.actionLog.map((action, idx) => {
                    const isNewStreet = idx === 0 || action.street !== state.actionLog[idx - 1].street;
                    return (
                      <Fragment key={action.index}>
                        {isNewStreet && (
                          <div className={`timeline-street-divider street-${action.street}`}>
                            <div className="timeline-street-divider-line" />
                            <div className="timeline-street-divider-pill">
                              <span className="divider-street-icon">
                                {action.street === "preflop" ? "🃏" : action.street === "flop" ? "🎴" : action.street === "turn" ? "⚡" : action.street === "river" ? "🌊" : "🏆"}
                              </span>
                              <span className="divider-street-name">{STREET_LABELS[action.street]}</span>
                              {action.street === "flop" && state.community.length >= 3 && (
                                <span className="divider-street-cards">
                                  {state.community.slice(0, 3).map((c, i) => (
                                    <CardFace key={i} card={c} small />
                                  ))}
                                </span>
                              )}
                              {action.street === "turn" && state.community.length >= 4 && (
                                <span className="divider-street-cards">
                                  <CardFace card={state.community[3]} small />
                                </span>
                              )}
                              {action.street === "river" && state.community.length >= 5 && (
                                <span className="divider-street-cards">
                                  <CardFace card={state.community[4]} small />
                                </span>
                              )}
                            </div>
                            <div className="timeline-street-divider-line" />
                          </div>
                        )}
                        <div className={`timeline-action-row street-${action.street}`}>
                          <span className="action-street-badge">{STREET_LABELS[action.street]}</span>
                          <b className="action-player-name">{action.playerName}</b>
                          <em className="action-detail">
                            <span className="action-type-amount">
                              {ACTION_LABELS[action.type]}
                              {action.amount > 0 ? ` ${formatChips(action.amount)}` : ""}
                            </span>
                            {action.thinkingText && (
                              <span
                                className={`action-thinking ${action.isDeepThinking ? "deep" : ""}`}
                                title={action.isDeepThinking ? "思考时间超过单轮时间的一半" : undefined}
                              >
                                {action.thinkingText}
                              </span>
                            )}
                          </em>
                        </div>
                      </Fragment>
                    );
                  })
                )}

                {!isHandComplete && !isFirstHandPending && state.street !== "complete" && state.street !== "showdown" && (
                  state.actionLog.length === 0 || state.actionLog[state.actionLog.length - 1].street !== state.street
                ) && (
                  <div className={`timeline-street-divider current-ongoing street-${state.street}`}>
                    <div className="timeline-street-divider-line" />
                    <div className="timeline-street-divider-pill current">
                      <span className="divider-street-icon">
                        {state.street === "preflop" ? "🃏" : state.street === "flop" ? "🎴" : state.street === "turn" ? "⚡" : "🌊"}
                      </span>
                      <span className="divider-street-name">
                        <span className="tsh-pulse-dot" />
                        {STREET_LABELS[state.street]} (当前进行中)
                      </span>
                      {state.street === "flop" && state.community.length >= 3 && (
                        <span className="divider-street-cards">
                          {state.community.slice(0, 3).map((c, i) => (
                            <CardFace key={i} card={c} small />
                          ))}
                        </span>
                      )}
                      {state.street === "turn" && state.community.length >= 4 && (
                        <span className="divider-street-cards">
                          <CardFace card={state.community[3]} small />
                        </span>
                      )}
                      {state.street === "river" && state.community.length >= 5 && (
                        <span className="divider-street-cards">
                          <CardFace card={state.community[4]} small />
                        </span>
                      )}
                    </div>
                    <div className="timeline-street-divider-line" />
                  </div>
                )}

                {isHandComplete && (
                  <div className="timeline-street-divider street-complete">
                    <div className="timeline-street-divider-line" />
                    <div className="timeline-street-divider-pill complete">
                      <span className="divider-street-icon">🏁</span>
                      <span className="divider-street-name">
                        {state.street === "showdown" ? STREET_LABELS.showdown : STREET_LABELS.complete}
                      </span>
                    </div>
                    <div className="timeline-street-divider-line" />
                  </div>
                )}

                {isHandComplete && state.lastResult && (
                  <div className="timeline-settlement-card">
                    <div className="timeline-settlement-header">
                      <strong>🏆 本手结算</strong>
                      <span>底池 {formatChips(state.lastResult.potTotal)}</span>
                    </div>
                    <p className="timeline-settlement-summary">{state.lastResult.summary}</p>
                    {state.lastResult.playerSettlements && state.lastResult.playerSettlements.length > 0 && (
                      <div className="timeline-settlement-list">
                        {state.lastResult.playerSettlements.map((s) => (
                          <div key={s.playerId} className={`timeline-settlement-item ${s.net > 0 ? "win" : s.net < 0 ? "loss" : "even"}`}>
                            <span className="ts-name">{s.playerName}</span>
                            <span className="ts-net">{s.net > 0 ? "+" : s.net < 0 ? "−" : "±0"}{formatChips(Math.abs(s.net))}</span>
                            <small className="ts-detail">(投{formatChips(s.contributed)} 拿{formatChips(s.received)})</small>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {tab === "tutorial" && <PokerTutorial />}

            {tab === "glossary" && (
              <div className="glossary">
                <h3>牌桌黑话</h3>
                {Object.entries(GLOSSARY).map(([term, entry]) => (
                  <div key={term}>
                    <b>{term}</b>
                    <span>{entry.zh}</span>
                    <p>{entry.detail}</p>
                  </div>
                ))}
              </div>
            )}

            {tab === "equity" && showEquityTab && (
              <div className="opponent-list">
                <h3>上帝视角 · 实时胜率</h3>
                <p>基于当前已知底牌与公共牌实时推算：</p>
                {state.godModeEquities && state.godModeEquities.length > 0 ? (
                  state.godModeEquities.map((item) => (
                    <div className="opponent-row" key={item.seatIndex}>
                      <b>{item.playerName}</b>
                      <span>{item.isFolded ? "已弃牌" : `${(item.equity * 100).toFixed(1)}%`}</span>
                      <div>
                        {item.holeCards.map((c, i) => (
                          <span key={i} className="stat-pill">
                            <b>{RANK_SYMBOL[c.rank]}</b>
                            {SUIT_SYMBOL[c.suit]}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="empty-copy">等待手牌发下后计算胜率。</p>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Chaos Mode Character Selection Modal */}
      {state.characterSelection?.active && (
        <div className="char-selection-overlay" role="dialog" aria-modal="true" aria-label="角色选择">
          <div className="char-selection-modal">
            <div className="char-selection-header">
              <div className="char-selection-title-box">
                <span className="char-selection-badge">🌀 胡闹德州模式</span>
                <h2>选择你的出战角色</h2>
                <p>每个角色拥有独特的被动或主动技能，初版支持自由选将（可重复选择）</p>
              </div>
              <div className="char-selection-timer">
                <span>思考倒计时</span>
                <strong className={charTimeRemaining <= 5 ? "timer-urgent" : ""}>
                  {charTimeRemaining}s
                </strong>
              </div>
            </div>

            {/* Live Character Selection Thinking Progress Bar */}
            <div className="char-selection-progress-bar" title={`选将思考时间剩余 ${charTimeRemaining}s`}>
              <div
                className={`char-selection-progress-fill ${charTimeRemaining <= 5 ? "urgent" : ""}`}
                style={{ width: `${charProgressPercent}%` }}
              />
            </div>

            <div className="char-cards-grid">
              {state.characterSelection.availableCharacters.map((char) => {
                const isSelected = state.characterSelection?.selectedMap[state.myId] === char.id;
                return (
                  <div
                    key={char.id}
                    className={`char-card ${isSelected ? "char-card-selected" : ""}`}
                    style={{ borderColor: isSelected ? char.themeColor : undefined }}
                    onClick={() => onSelectCharacter?.(char.id)}
                  >
                    <div className="char-avatar-box" style={{ background: `radial-gradient(circle, ${char.themeColor}33 0%, rgba(15,23,42,0.8) 70%)` }}>
                      <CharacterAvatar
                        src={char.avatar}
                        name={char.name}
                        fallbackText={char.avatarFallbackText}
                        themeColor={char.themeColor}
                        size="xl"
                        showBorder={true}
                      />
                      <span className="char-theme-badge" style={{ backgroundColor: char.themeColor }}>
                        {char.title}
                      </span>
                    </div>

                    <div className="char-info-box">
                      <h4 style={{ color: char.themeColor }}>{char.name}</h4>
                      <p className="char-desc">{char.description}</p>
                      
                      <div className="char-skills-box">
                        {char.skills.map((skill) => (
                          <ChaosSkillBadge key={skill.id} skill={skill} size="sm" interactive={false} />
                        ))}
                      </div>

                      <button
                        type="button"
                        className={`char-select-btn ${isSelected ? "btn-selected" : ""}`}
                        style={isSelected ? { backgroundColor: char.themeColor, borderColor: char.themeColor } : {}}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectCharacter?.(char.id);
                        }}
                      >
                        {isSelected ? "✓ 已选定此角色" : "出战此角色"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Selection Progress Bar */}
            <div className="char-selection-roster">
              <span className="roster-title">各座位选将进度：</span>
              <div className="roster-list">
                {state.seats
                  .filter((s) => s.id && !s.id.startsWith("empty-"))
                  .map((s) => {
                    const pickedId = state.characterSelection?.selectedMap[s.id];
                    const pickedChar = pickedId
                      ? state.characterSelection?.availableCharacters.find((c) => c.id === pickedId)
                      : undefined;
                    return (
                      <div key={s.id} className={`roster-chip ${pickedId ? "confirmed" : "pending"}`}>
                        <span className="roster-player-name">{s.name}</span>
                        {s.isAi ? (
                          <span className="roster-status ai">🤖 无技能</span>
                        ) : pickedChar ? (
                          <span className="roster-status confirmed" style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                            <CharacterAvatar
                              src={pickedChar.avatar}
                              name={pickedChar.name}
                              fallbackText={pickedChar.avatarFallbackText}
                              themeColor={pickedChar.themeColor}
                              size="xs"
                              showBorder={false}
                            />
                            <span>✓ {pickedChar.name}</span>
                          </span>
                        ) : (
                          <span className="roster-status pending">思考中...</span>
                        )}
                      </div>
                    );
                  })}
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
