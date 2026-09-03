"use client";

import { useEffect, useState } from "react";
import { RANK_SYMBOL, SUIT_SYMBOL } from "@/lib/poker/cards";
import { GLOSSARY } from "@/lib/poker/coach";
import { ACTION_LABELS, STREET_LABELS } from "@/lib/poker/engine";
import { playPokerSound } from "@/lib/poker/sound";
import type { Card, PlayerActionInput } from "@/lib/poker/types";
import type { MultiplayerTableState } from "@/server/multiplayer-types";
import { AudioControls, formatChips } from "./PokerTrainer";

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
}

type MpPanelTab = "timeline" | "glossary" | "equity";

function CardFace({ card, hidden = false, small = false }: { card?: Card; hidden?: boolean; small?: boolean }) {
  if (hidden) {
    return (
      <div className={`playing-card card-back ${small ? "card-small" : ""}`} aria-label="暗牌">
        <span>R</span>
      </div>
    );
  }
  if (!card) {
    return <div className={`playing-card card-empty ${small ? "card-small" : ""}`} aria-hidden="true" />;
  }
  const red = card.suit === "h" || card.suit === "d";
  return (
    <div
      className={`playing-card ${red ? "card-red" : "card-black"} ${small ? "card-small" : ""}`}
      aria-label={`${RANK_SYMBOL[card.rank]}${SUIT_SYMBOL[card.suit]}`}
    >
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
}: MultiplayerTableProps) {
  const [tab, setTab] = useState<MpPanelTab>("timeline");

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

  const seatedCount = state.seats.filter((s) => s.id && !s.id.startsWith("empty-")).length;
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
          {!state.isSpectator && (
            <span>
              筹码 <b>{formatChips(mySeat?.stack ?? 0)}</b>
            </span>
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
              if (isEmpty) return null;

              const isActive = state.activeIndex === index;
              const isHero = seat.id === state.myId;
              const showCards = isHero || state.godMode || state.street === "showdown" || state.street === "complete";

              return (
                <div
                  key={seat.id}
                  className={`table-seat seat-${index} ${isActive ? "seat-active" : ""} ${
                    seat.folded ? "seat-folded" : ""
                  }`}
                >
                  <div className="seat-cards">
                    {seat.holeCards.length > 0 ? (
                      seat.holeCards.map((c, i) => (
                        <CardFace key={i} card={c} hidden={!showCards} small />
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

                  <div className="seat-panel">
                    {seat.position && <span className="seat-position">{seat.position}</span>}
                    <b>
                      {seat.name} {isHero && "(你)"}
                    </b>
                    <strong>
                      {formatChips(seat.stack)}{" "}
                      <small>{(seat.stack / state.bigBlind).toFixed(0)}BB</small>
                    </strong>
                    {seat.folded && <span className="seat-action">弃牌</span>}
                    {seat.allIn && <span className="seat-action" style={{ color: "#ffd6d3" }}>ALL-IN</span>}
                    {!seat.folded && !seat.allIn && seat.lastAction && (
                      <span className="seat-action">
                        {ACTION_LABELS[seat.lastAction as keyof typeof ACTION_LABELS] || seat.lastAction}
                      </span>
                    )}
                    {isActive && (
                      <span className="seat-action" style={{ color: remainingSeconds <= 5 ? "#ef4444" : "var(--gold-light)" }}>
                        思考中 {remainingSeconds}s
                      </span>
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

            {isFirstHandPending ? (
              <div className="hand-complete">
                <div className="hand-result-copy">
                  <span>准备就绪</span>
                  <strong>全员入座完毕 · 待房主确认发牌</strong>
                </div>
                <div>
                  {state.isHost ? (
                    <button className="primary-button" onClick={onNextHand}>
                      开始第一手 <span>🚀</span>
                    </button>
                  ) : (
                    <span className="empty-copy">等待房主确认并开启第一手...</span>
                  )}
                </div>
              </div>
            ) : isHandComplete ? (
              <div className="hand-complete">
                <div className="hand-result-copy">
                  <span>本手结束</span>
                  <strong>{state.handResultSummary || "牌局结算完成"}</strong>
                </div>
                <div>
                  {state.isHost ? (
                    <button className="primary-button" onClick={onNextHand}>
                      开始下一手 <span>→</span>
                    </button>
                  ) : (
                    <span className="empty-copy">等待房主开启下一手...</span>
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
                <p>
                  等待 <b>{activeSeat?.name ?? "玩家"}</b> 行动中... <em>({remainingSeconds}s)</em>
                </p>
              </div>
            )}
          </div>
        </section>

        {/* Right Side Panel - Exact match of single-player SidePanel */}
        <aside className="side-panel">
          <div
            className="panel-tabs"
            style={{
              gridTemplateColumns: showEquityTab ? "repeat(3, 1fr)" : "repeat(2, 1fr)",
            }}
          >
            <button
              className={tab === "timeline" ? "active" : ""}
              onClick={() => setTab("timeline")}
            >
              行动
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
                <h3>行动时间线</h3>
                {state.actionLog.length === 0 ? (
                  <p className="empty-copy">本手牌局刚开始，暂无公开行动。</p>
                ) : (
                  state.actionLog.map((action) => (
                    <div key={action.index}>
                      <span>{STREET_LABELS[action.street]}</span>
                      <b>{action.playerName}</b>
                      <em>
                        {ACTION_LABELS[action.type]}
                        {action.amount > 0 ? ` ${formatChips(action.amount)}` : ""}
                      </em>
                    </div>
                  ))
                )}
              </div>
            )}

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
    </main>
  );
}
