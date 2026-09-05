"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createSeatRoster, chooseBotAction, driftBotsForNextHand } from "@/lib/poker/ai";
import { RANK_SYMBOL, SUIT_SYMBOL } from "@/lib/poker/cards";
import { buildCoachAdvice, createHandReview, GLOSSARY, rateDecision } from "@/lib/poker/coach";
import { evaluateSeven, compareScores, type HandScore } from "@/lib/poker/evaluator";
import MultiplayerLobby from "./MultiplayerLobby";
import MultiplayerTable from "./MultiplayerTable";
import { PokerTutorial } from "./PokerTutorial";
import type { ClientMessage, MultiplayerTableState, RoomSummary, ServerMessage } from "@/server/multiplayer-types";
import {
  ACTION_LABELS,
  STREET_LABELS,
  applyAction,
  buildBotView,
  buildPlayerView,
  createTable,
  potSize,
  startHand,
} from "@/lib/poker/engine";
import { makeSeed } from "@/lib/poker/rng";
import { playPokerSound, unlockPokerAudio } from "@/lib/poker/sound";
import { bgm, getBgmStageFromMultiplayer, getBgmStageFromSinglePlayer, type BgmStage } from "@/lib/poker/bgm";
import {
  clearStoredProfile,
  createDefaultProfile,
  exportProfile,
  loadProfile,
  parseImportedProfile,
  recordBankroll,
  recordCompletedHand,
  refillBankroll,
  saveProfile,
  updateUnlocks,
} from "@/lib/poker/storage";
import {
  createTournamentState,
  fastForwardTournament,
  recordTournamentHand,
  tournamentBlindsForHand,
  tournamentPlace,
  tournamentPrize,
  TOURNAMENT_HANDS_PER_LEVEL,
  TOURNAMENT_PRIZES,
  TOURNAMENT_STARTING_STACK,
} from "@/lib/poker/tournament";
import { STAKES } from "@/lib/poker/types";
import type {
  Card,
  CareerProfile,
  CoachAdvice,
  DecisionRecord,
  Difficulty,
  FullGameState,
  GameMode,
  HandReview,
  PlayerActionInput,
  PlayerSettlement,
  SavedHand,
  TableFormat,
  TournamentState,
} from "@/lib/poker/types";

type Screen = "lobby" | "table" | "tournament-result";
type PanelTab = "coach" | "timeline" | "tutorial" | "stats" | "glossary";

interface ActiveSession {
  mode: GameMode;
  difficulty: Difficulty;
  stakeId: string;
  tableFormat: TableFormat;
}

const MODE_COPY: Record<GameMode, { title: string; eyebrow: string; description: string }> = {
  teaching: { title: "教学模式", eyebrow: "边打边学", description: "行动前给建议、尺度与黑话解释；教练绝不看隐藏牌。" },
  review: { title: "指导模式", eyebrow: "先打后评", description: "牌局中保持沉默，每手结束后以上帝视角复盘关键决策。" },
  battle: { title: "对战模式", eyebrow: "纯粹较量", description: "关闭策略提示，选择难度，靠读牌和长期数据赢下筹码。" },
};

const DIFFICULTY_COPY: Record<Difficulty, string> = {
  casual: "休闲",
  standard: "标准",
  expert: "高手",
};

export function formatChips(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(Math.floor(value));
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
}

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
  if (hidden) return <div className={`playing-card card-back ${small ? "card-small" : ""} ${className}`} aria-label="暗牌"><span>R</span></div>;
  if (!card) return <div className={`playing-card card-empty ${small ? "card-small" : ""} ${className}`} aria-hidden="true" />;
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

function StatPill({ label, value }: { label: string; value: string }) {
  return <span className="stat-pill"><b>{label}</b>{value}</span>;
}

export function AudioControls({
  soundMuted,
  soundVolume,
  onSoundMuted,
  onSoundVolume,
  bgmMuted,
  bgmVolume,
  onBgmMuted,
  onBgmVolume,
}: {
  soundMuted: boolean;
  soundVolume: number;
  onSoundMuted: (muted: boolean) => void;
  onSoundVolume: (volume: number) => void;
  bgmMuted: boolean;
  bgmVolume: number;
  onBgmMuted: (muted: boolean) => void;
  onBgmVolume: (volume: number) => void;
}) {
  const toggleBgm = () => {
    void unlockPokerAudio();
    void bgm.unlock();
    onBgmMuted(!bgmMuted);
  };

  const toggleSound = () => {
    const nextMuted = !soundMuted;
    void unlockPokerAudio().then(() => {
      if (!nextMuted) playPokerSound("turn", soundVolume);
    });
    onSoundMuted(nextMuted);
  };

  return (
    <div className="audio-controls-group" aria-label="全局音频控制">
      <div className="sound-control" title="背景音乐 (BGM)">
        <button type="button" onClick={toggleBgm} aria-pressed={bgmMuted} title={bgmMuted ? "开启背景音乐" : "静音背景音乐"}>
          <span aria-hidden="true">{bgmMuted ? "🔇" : "🎵"}</span>
        </button>
        <input
          aria-label="背景音乐音量"
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={bgmMuted ? 0 : bgmVolume}
          onPointerDown={() => {
            void unlockPokerAudio();
            void bgm.unlock();
          }}
          onChange={(event) => onBgmVolume(Number(event.target.value))}
        />
      </div>

      <div className="sound-control" title="游戏音效 (SFX)">
        <button type="button" onClick={toggleSound} aria-pressed={soundMuted} title={soundMuted ? "开启音效" : "静音音效"}>
          <span aria-hidden="true">{soundMuted ? "🔇" : "🔊"}</span>
        </button>
        <input
          aria-label="游戏音效音量"
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={soundMuted ? 0 : soundVolume}
          onPointerDown={() => void unlockPokerAudio()}
          onChange={(event) => onSoundVolume(Number(event.target.value))}
        />
      </div>
    </div>
  );
}
function Lobby({
  profile,
  onProfile,
  onStart,
  onSwitchToMultiplayer,
}: {
  profile: CareerProfile;
  onProfile: (profile: CareerProfile) => void;
  onStart: () => void;
  onSwitchToMultiplayer: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const stake = STAKES.find((item) => item.id === profile.preferences.stakeId) ?? STAKES[0];
  const tournamentSelected = profile.preferences.tableFormat === "tournament";
  const buyIn = tournamentSelected ? TOURNAMENT_STARTING_STACK : stake.bigBlind * 100;
  const canStart = tournamentSelected || (profile.unlockedStakeIds.includes(stake.id) && profile.bankroll >= buyIn);
  const net = profile.bankroll - profile.startingBankroll;

  const updatePreference = <K extends keyof CareerProfile["preferences"]>(key: K, value: CareerProfile["preferences"][K]) => {
    const next = { ...profile, preferences: { ...profile.preferences, [key]: value } };
    onProfile(next);
  };

  const handleImport = async (file?: File) => {
    if (!file) return;
    try {
      onProfile(parseImportedProfile(await file.text()));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "导入失败");
    }
  };

  return (
    <main className="lobby-page">
      <header className="lobby-nav">
        <div className="brand-lockup">
          <span className="brand-mark">R</span>
          <div><strong>RiverLab</strong><span>德扑训练室</span></div>
        </div>
        <div className="lobby-mode-switch">
          <button type="button" className="active">🤖 单机训练</button>
          <button type="button" onClick={onSwitchToMultiplayer}>🌐 局域网联机</button>
        </div>
        <AudioControls
          soundMuted={profile.preferences.soundMuted}
          soundVolume={profile.preferences.soundVolume}
          onSoundMuted={(soundMuted) => updatePreference("soundMuted", soundMuted)}
          onSoundVolume={(soundVolume) => {
            void unlockPokerAudio();
            onProfile({ ...profile, preferences: { ...profile.preferences, soundVolume, soundMuted: soundVolume === 0 } });
          }}
          bgmMuted={profile.preferences.bgmMuted}
          bgmVolume={profile.preferences.bgmVolume}
          onBgmMuted={(bgmMuted) => {
            void bgm.unlock();
            bgm.setMuted(bgmMuted);
            updatePreference("bgmMuted", bgmMuted);
          }}
          onBgmVolume={(bgmVolume) => {
            void bgm.unlock();
            bgm.setVolume(bgmVolume);
            onProfile({ ...profile, preferences: { ...profile.preferences, bgmVolume, bgmMuted: bgmVolume === 0 } });
          }}
        />
        <div className="nav-bankroll"><span>训练资金</span><strong>{formatChips(profile.bankroll)}</strong></div>
      </header>

      <section className="hero-grid">
        <div className="hero-copy">
          <p className="kicker">8-MAX · NO-LIMIT HOLD&apos;EM · OFFLINE</p>
          <h1>把每个决定，<br />都打得更有依据。</h1>
          <p className="hero-lede">一张不作弊的八人桌。七名有性格、会调整、也会犯错的 AI；一个只使用你所见信息的中文教练。</p>
          <div className="hero-proof">
            <span><i className="proof-dot" />完全离线</span>
            <span><i className="proof-dot" />虚拟筹码</span>
            <span><i className="proof-dot" />本地存档</span>
          </div>
        </div>
        <div className="career-card">
          <div className="career-head"><span>生涯概览</span><em>LOCAL CAREER</em></div>
          <strong className="career-bankroll">{formatChips(profile.bankroll)}</strong>
          <span className={`career-net ${net >= 0 ? "positive" : "negative"}`}>{net >= 0 ? "+" : ""}{formatChips(net)} 总盈亏</span>
          <div className="career-stats">
            <div><b>{profile.stats.hands}</b><span>手牌</span></div>
            <div><b>{percent(profile.stats.vpipHands, profile.stats.hands)}</b><span>VPIP</span></div>
            <div><b>{percent(profile.stats.pfrHands, profile.stats.hands)}</b><span>PFR</span></div>
            <div><b>{profile.refillCount}</b><span>补币</span></div>
          </div>
          <div className="career-foot"><span>最大底池</span><b>{formatChips(profile.stats.biggestPot)}</b></div>
        </div>
      </section>

      <section className="setup-section">
        <div className="section-heading"><span>01</span><div><h2>选择训练方式</h2><p>三种模式共用同一套规则与 AI，只改变信息和反馈时机。</p></div></div>
        <div className="mode-grid">
          {(Object.keys(MODE_COPY) as GameMode[]).map((mode) => {
            const copy = MODE_COPY[mode];
            const selected = profile.preferences.mode === mode;
            return (
              <button key={mode} className={`mode-card ${selected ? "selected" : ""}`} onClick={() => updatePreference("mode", mode)} data-testid={`mode-${mode}`}>
                <span className="mode-check">{selected ? "?" : ""}</span>
                <em>{copy.eyebrow}</em><h3>{copy.title}</h3><p>{copy.description}</p>
              </button>
            );
          })}
        </div>
      </section>

      <section className="setup-section format-section">
        <div className="section-heading"><span>02</span><div><h2>选择赛制</h2><p>训练方式决定提示，赛制决定筹码是否可以带走或补充。</p></div></div>
        <div className="format-grid">
          <button className={`format-card ${!tournamentSelected ? "selected" : ""}`} onClick={() => updatePreference("tableFormat", "cash")}>
            <span>现金训练桌</span><strong>100BB 买入</strong><p>可以补码和离桌，桌上筹码结算回生涯资金。</p>
          </button>
          <button className={`format-card ${tournamentSelected ? "selected" : ""}`} onClick={() => updatePreference("tableFormat", "tournament")} data-testid="format-tournament">
            <span>TOURNAMENT</span><strong>八人淘汰锦标赛</strong><p>每人 1,000 比赛筹码，输光出局；前三名获得生涯训练币奖励。</p>
          </button>
        </div>
      </section>

      <section className="setup-row">
        <div className="setup-block">
          <div className="section-heading compact"><span>03</span><div><h2>AI 难度</h2><p>难度改变策略质量，不增加隐藏信息。</p></div></div>
          <div className="segmented">
            {(Object.keys(DIFFICULTY_COPY) as Difficulty[]).map((difficulty) => (
              <button key={difficulty} className={profile.preferences.difficulty === difficulty ? "active" : ""} onClick={() => updatePreference("difficulty", difficulty)}>{DIFFICULTY_COPY[difficulty]}</button>
            ))}
          </div>
        </div>
        <div className="setup-block">
          {tournamentSelected ? (
            <>
              <div className="section-heading compact"><span>04</span><div><h2>锦标赛结构</h2><p>比赛筹码与钱包分开，免费参赛，不可补码。</p></div></div>
              <div className="tournament-structure">
                <div><span>起始筹码</span><b>1,000</b></div>
                <div><span>起始盲注</span><b>5/10</b></div>
                <div><span>升级速度</span><b>每 {TOURNAMENT_HANDS_PER_LEVEL} 手</b></div>
                <p>奖励：冠军 {formatChips(TOURNAMENT_PRIZES[1])} · 亚军 {formatChips(TOURNAMENT_PRIZES[2])} · 季军 {formatChips(TOURNAMENT_PRIZES[3])}</p>
              </div>
            </>
          ) : (
            <>
              <div className="section-heading compact"><span>04</span><div><h2>盲注级别</h2><p>带 100BB 入座；达到 20 个买入解锁下一档。</p></div></div>
              <div className="stakes-list">
                {STAKES.map((item) => {
                  const unlocked = profile.unlockedStakeIds.includes(item.id);
                  return <button key={item.id} disabled={!unlocked} className={profile.preferences.stakeId === item.id ? "active" : ""} onClick={() => updatePreference("stakeId", item.id)}>{unlocked ? `${item.smallBlind}/${item.bigBlind}` : `锁定 · ${item.smallBlind}/${item.bigBlind}`}</button>;
                })}
              </div>
            </>
          )}
        </div>
      </section>

      <section className={`launch-bar ${tournamentSelected ? "tournament-launch" : ""}`}>
        <div><span>{tournamentSelected ? "起始比赛筹码" : "本次买入"}</span><strong>{formatChips(buyIn)} <small>100BB</small></strong></div>
        {tournamentSelected
          ? <p>{MODE_COPY[profile.preferences.mode].title} · {DIFFICULTY_COPY[profile.preferences.difficulty]} AI · 八人淘汰 · 免费参赛</p>
          : !canStart && profile.bankroll < buyIn
            ? <p>资金不足一个买入，可领取训练币继续。</p>
            : <p>{MODE_COPY[profile.preferences.mode].title} · {DIFFICULTY_COPY[profile.preferences.difficulty]} AI · 无抽水</p>}
        <div className="launch-actions">
          {!tournamentSelected && profile.bankroll < 20_000 && <button className="secondary-button" onClick={() => onProfile(refillBankroll(profile))}>领取训练币</button>}
          <button className="primary-button" disabled={!canStart} onClick={onStart} data-testid="start-session">{tournamentSelected ? "参加锦标赛" : `带 ${formatChips(buyIn)} 入座`} <span>→</span></button>
        </div>
      </section>

      <footer className="data-footer">
        <section className="data-footer-copy">
          <span>所有牌局与生涯数据只存在当前浏览器。</span>
          <small>免责声明：仅供扑克规则、概率与策略学习及娱乐使用；虚拟筹码不具有现金价值，教练建议不保证收益，也不构成赌博、投资或财务建议。请遵守所在地法律法规。</small>
        </section>
        <div className="data-footer-actions">
          <button onClick={() => exportProfile(profile)}>导出 JSON</button>
          <button onClick={() => fileRef.current?.click()}>导入</button>
          <button className="danger-link" onClick={() => { if (window.confirm("确定清空全部本地生涯数据？此操作无法撤销。")) onProfile(clearStoredProfile()); }}>重置生涯</button>
          <input ref={fileRef} hidden type="file" accept="application/json" onChange={(event) => handleImport(event.target.files?.[0])} />
        </div>
      </footer>
    </main>
  );
}

function Seat({
  seat,
  index,
  table,
  reveal,
}: {
  seat: FullGameState["seats"][number];
  index: number;
  table: FullGameState;
  reveal: boolean;
}) {
  const active = table.activeIndex === index;
  const eliminated = seat.stack === 0 && (table.status === "complete" || seat.holeCards.length === 0);
  const position = buildPlayerView(table, "hero").seats[index].position;
  const stats = seat.stats;
  const seatSettlement = table.status === "complete"
    ? table.lastResult?.playerSettlements?.find((s) => s.playerId === seat.id)
    : undefined;
  return (
    <div className={`table-seat seat-${index} ${active ? "seat-active" : ""} ${seat.folded ? "seat-folded" : ""} ${eliminated ? "seat-eliminated" : ""}`}>
      {table.status === "complete" && seatSettlement && (
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
            ({seatSettlement.net > 0 ? "+" : seatSettlement.net < 0 ? "−" : ""}{(Math.abs(seatSettlement.net) / table.bigBlind).toFixed(1)}BB)
          </small>
        </div>
      )}
      <div className="seat-cards">
        {seat.holeCards.length > 0 &&
          seat.holeCards.map((card) => (
            <CardFace
              key={card.id}
              card={card}
              hidden={!seat.isHuman && !reveal && !seat.folded}
              small
            />
          ))}
      </div>
      <div className="seat-panel">
        <span className="seat-position">{position}</span>
        <div className="seat-name"><b>{seat.name}</b>{seat.isHuman && <em>YOU</em>}{eliminated && <em className="eliminated-label">OUT</em>}</div>
        <strong>{formatChips(seat.stack)} <small>{(seat.stack / table.bigBlind).toFixed(0)}BB</small></strong>
        {!seat.isHuman && stats.hands >= 3 && <span className="mini-stats">{percent(stats.vpipHands, stats.hands)} / {percent(stats.pfrHands, stats.hands)}</span>}
      </div>
      {seat.committedStreet > 0 && <div className="seat-bet"><span>本轮</span><b>{formatChips(seat.committedStreet)}</b></div>}
      {seat.lastAction && <div className="seat-action">{ACTION_LABELS[seat.lastAction]}</div>}
      {index === table.buttonIndex && <span className="dealer-button">D</span>}
    </div>
  );
}

const BOARD_TEXTURE_COPY: Record<CoachAdvice["analysis"]["boardTexture"], string> = {
  preflop: "翻前",
  dry: "干燥牌面",
  dynamic: "动态牌面",
  wet: "湿润牌面",
  paired: "公共牌成对",
  monotone: "单色牌面",
};

const RANGE_LABEL_COPY: Record<string, string> = {
  "very-tight": "极窄",
  tight: "偏紧",
  medium: "中等",
  wide: "较宽",
};

const RANGE_EVIDENCE_COPY: Record<string, string> = {
  open: "open（率先加注）",
  "3-bet": "3-bet（面对加注再加注）",
  "4-bet+": "4-bet+（极强翻前再加注）",
  "cold-call": "cold-call（冷跟前方加注）",
  limp: "limp（只跟大盲入池）",
  "checked-option": "大盲过牌免费看牌",
  "not-yet-defined": "尚无足够公开行动",
  "postflop-aggression": "翻后主动下注／加注",
  "postflop-call": "翻后跟注继续",
};

const PURPOSE_COPY: Record<string, string> = {
  value: "价值下注：希望更差的牌跟注",
  "thin-value": "薄价值：向少量更差牌收取价值",
  "semi-bluff": "半诈唬：争取弃牌，同时保留补牌机会",
  "fold-equity": "制造弃牌率：尝试让部分更好牌弃牌",
  "pot-control": "控制底池：避免中等牌把底池做得过大",
  "realize-equity": "实现权益：尽量免费看到后续公共牌",
  "draw-realization": "听牌实现权益：用合适价格追逐补牌",
  "bluff-catch": "抓诈唬：只能稳定击败对手的诈唬部分",
  "showdown-value": "保留摊牌价值：让当前牌便宜进入摊牌",
  "range-protection": "保护范围：避免自己的过牌范围永远只有弱牌",
  "cut-loss": "停止负 EV 投入：把筹码留给更有利的节点",
};

const LINE_REASON_COPY: Record<string, string> = {
  "preserve-stack": "不再为当前劣势范围投入筹码。",
  "realize-equity-without-investment": "无需继续投入即可看下一张牌，但可能放弃一部分价值或保护。",
  "protect-showdown-value": "这手牌能赢一部分摊牌，但不适合承受过大的底池。",
  "price-covered": "当前范围权益能够覆盖跟注价格。",
  "price-not-covered": "当前范围权益不足以覆盖跟注价格。",
  "value-targets-continue": "模型能找到愿意继续的更差牌，因此下注具有明确价值目标。",
  "better-hands-may-fold": "有一部分当前更好的牌可能弃牌，下注能够制造有效弃牌率。",
  "semi-bluff-with-outs": "既争取立即弃牌，也保留被跟注后的改善机会。",
  "fold-equity-dependent": "收益依赖对手弃牌；面对跟注站时应明显降低频率。",
  "low-spr-commitment": "SPR 已低，剩余筹码自然集中到当前街投入。",
  "high-variance-commitment": "高波动投入，只有范围与阻断牌共同支持时才合理。",
};

function CoachCard({ advice }: { advice: CoachAdvice }) {
  const analysis = advice.analysis;
  const profile = analysis.handProfile;
  const response = analysis.rangeResponse;
  const beginner = advice.beginner;
  const advantageText = analysis.rangeAdvantage > 0.08
    ? "你的组合在行动加权范围中占优"
    : analysis.rangeAdvantage < -0.05
      ? "对手公开行动后的范围更集中，你的相对权益受压"
      : "双方范围权益接近，位置和尺度更重要";
  const recommendedLine = (line: CoachAdvice["analysis"]["candidates"][number]) => {
    if (line.action !== advice.action) return false;
    if (advice.target === undefined || line.target === undefined) return true;
    return Math.abs(line.target - advice.target) <= Math.max(1, advice.target * 0.2);
  };
  const selectedLine = analysis.candidates.find(recommendedLine);
  const primaryPurpose = selectedLine?.purpose ?? analysis.candidates.find((line) => line.action === advice.action)?.purpose;
  const shownCandidates = analysis.candidates.filter((line, index) => index < 2 || recommendedLine(line)).slice(0, 3);
  const referenceLabel = analysis.boardTexture === "preflop"
    ? "参考标准翻前继续尺度"
    : `参考约 ${Math.round(response.referenceSize * 100)}% 底池尺度`;
  const conceptPriority = ["bluff-catcher", "TPTK", "overpair", "nut draw", "non-nut draw", "pot odds", "semi-bluff", "outs", "SPR", "range"];
  const keyConcept = conceptPriority.find((term) => advice.concepts.includes(term)) ?? advice.concepts[0];
  const keyEntry = keyConcept ? GLOSSARY[keyConcept] : undefined;
  const rawRangeGap = Math.abs(advice.metrics.neutralEquity - advice.metrics.equity);

  return (
    <div className="coach-card coach-card-beginner">
      <div className="coach-recommend beginner-recommend">
        <span>现在怎么打</span>
        <strong>{advice.actionLabel}</strong>
        <em>置信度 {advice.confidence}</em>
      </div>

      <div className="metric-grid beginner-metric-grid">
        <div><span>牌面胜率</span><b>{(advice.metrics.neutralEquity * 100).toFixed(0)}%</b><small>未知牌等概率</small></div>
        {analysis.potOdds > 0
          ? <div><span>跟注门槛</span><b>{(analysis.potOdds * 100).toFixed(0)}%</b><small>低于胜率才有价格基础</small></div>
          : <div><span>仍在局中</span><b>{analysis.opponentRanges.length}</b><small>对手越多，获胜越难</small></div>}
        {analysis.outs > 0
          ? <div><span>改善牌</span><b>{analysis.outs}</b><small>不保证都是干净 outs</small></div>
          : <div><span>你的位置</span><b>{analysis.positionSummary}</b><small>{BOARD_TEXTURE_COPY[analysis.boardTexture]}</small></div>}
      </div>
      <p className="neutral-equity-note">牌面胜率只使用你的底牌、公共牌和在局人数；不考虑任何玩家风格，所有未知牌等概率，平局按分池计算。</p>

      <div className="beginner-hand-summary"><span>你现在是</span><strong>{beginner.handSummary}</strong></div>

      <div className="beginner-guide-list">
        <article className="guide-why">
          <span>为什么这么打</span>
          <p>{beginner.actionReason}</p>
        </article>
        <article className="guide-lesson">
          <span>这一手记住</span>
          <p>{beginner.lesson}</p>
        </article>
        <article className="guide-next">
          <span>接下来怎么办</span>
          <p>{beginner.nextPlan}</p>
        </article>
      </div>

      {rawRangeGap >= 0.08 && (
        <p className="range-shift-warning">为什么教练可能不按牌面胜率直接行动：对手的公开下注会收窄其可能底牌。行动范围胜率约 {(analysis.equity * 100).toFixed(0)}%，详细原因可在下方展开。</p>
      )}

      {keyConcept && keyEntry && (
        <div className="one-concept-card">
          <span>本手只学一个黑话</span>
          <strong>{keyConcept} · {keyEntry.zh}</strong>
          <p>{keyEntry.detail}</p>
        </div>
      )}

      <details className="coach-deep-dive">
        <summary><span>展开详细分析</span><small>范围、其他动作和数学依据</small></summary>
        <div className="deep-dive-content">
          <section className="coach-section hand-reading-section">
            <div className="coach-section-title"><span>01</span><h4>牌力与完整理由</h4></div>
            <div className="hand-profile-card">
              <div><span>成牌分类</span><strong>{profile.madeLabel}</strong></div>
              <div><span>相对定位</span><strong>{profile.relativeLabel}</strong></div>
              <div><span>听牌质量</span><strong>{profile.drawLabel}</strong></div>
            </div>
            <p>{profile.explanation}</p>
            <div className="vulnerability-row"><span>牌力脆弱度</span><i><b style={{ width: `${Math.round(profile.vulnerability * 100)}%` }} /></i><em>{Math.round(profile.vulnerability * 100)}%</em></div>
            <p className="plain-definition"><b>脆弱度</b>表示后续公共牌让当前牌力贬值的风险，不是输牌概率。</p>
            {profile.blockers.map((item) => <p className="blocker-note" key={item}>{item}</p>)}
            {advice.reasons.map((reason) => <p key={reason}>{reason}</p>)}
          </section>

          <section className="coach-section situation-section">
            <div className="coach-section-title"><span>02</span><h4>公开行动如何修正对手范围</h4></div>
            <p><b>{analysis.positionSummary}</b> · {BOARD_TEXTURE_COPY[analysis.boardTexture]} · {advantageText}。</p>
            <div className="range-list">
              {analysis.opponentRanges.map((range) => (
                <div key={range.playerId}>
                  <span>{range.playerName} · {range.position}</span>
                  <b>{RANGE_LABEL_COPY[range.label] ?? range.label}，约 {Math.round(range.width * 100)}%</b>
                  <small>{range.evidence.map((item) => RANGE_EVIDENCE_COPY[item] ?? item).join(" · ")}</small>
                </div>
              ))}
            </div>
            <p className="model-note">牌面胜率把所有未知牌等概率处理；这里的范围胜率会再根据位置和公开行动调整，但仍不会读取对手底牌。</p>
          </section>

          <section className="coach-section range-response-section">
            <div className="coach-section-title"><span>03</span><h4>下注想让谁跟、让谁弃</h4></div>
            {primaryPurpose && <p className="purpose-callout">主要目的：{PURPOSE_COPY[primaryPurpose] ?? primaryPurpose}</p>}
            <p className="model-note">{referenceLabel}，以下是教学模型的近似响应。</p>
            <div className="response-grid">
              <div><span>较差牌继续率</span><b>{Math.round(response.worseHandsContinue * 100)}%</b><small>比你弱的牌中预计仍会继续的比例</small></div>
              <div><span>较好牌弃牌率</span><b>{Math.round(response.betterHandsFold * 100)}%</b><small>比你强的牌中预计可能弃牌的比例</small></div>
            </div>
            {response.valueTargets.length > 0 && <p><b>价值目标：</b>{response.valueTargets.join("、")}。</p>}
            {response.foldTargets.length > 0 && <p><b>可能弃掉的较好牌：</b>{response.foldTargets.join("、")}。</p>}
          </section>

          <section className="coach-section">
            <div className="coach-section-title"><span>04</span><h4>首选与两个重要备选</h4></div>
            <div className="line-comparison">
              {shownCandidates.map((line) => (
                <div key={`${line.action}-${line.target ?? 0}`} className={`line-${line.verdict}`}>
                  <span>{recommendedLine(line) ? "教练推荐" : line.verdict === "best" ? "粗略 EV 首选" : line.verdict === "close" ? "接近" : "不优先"}</span>
                  <b>{ACTION_LABELS[line.action]}{line.target ? `到 ${line.target}` : ""}</b>
                  <p>{LINE_REASON_COPY[line.explanation] ?? line.explanation}</p>
                  {line.worseContinue !== undefined && <small>较差牌继续约 {Math.round(line.worseContinue * 100)}% · 较好牌弃牌约 {Math.round((line.betterFold ?? 0) * 100)}%</small>}
                </div>
              ))}
            </div>
            {advice.alternatives.slice(0, 2).map((item) => <p key={item}>{item}</p>)}
          </section>

          <section className="coach-section math-boundary-section">
            <div className="coach-section-title"><span>05</span><h4>数学依据与模型边界</h4></div>
            <p>牌面胜率约 {(advice.metrics.neutralEquity * 100).toFixed(0)}%；行动范围胜率约 {(analysis.equity * 100).toFixed(0)}%；{analysis.potOdds > 0 ? `跟注门槛约 ${(analysis.potOdds * 100).toFixed(0)}%` : "当前无需支付跟注成本"}；SPR 为 {analysis.spr.toFixed(1)}。</p>
            <p>牌面胜率不看对手风格；范围胜率会根据公开行动推断。两者都是本地 Monte Carlo 近似值，不是商业求解器的精确 EV。</p>
          </section>

          <details className="concept-explainer">
            <summary>查看本手全部黑话</summary>
            <div>
              {advice.concepts.map((term) => {
                const entry = GLOSSARY[term];
                return <article key={term}><b>{term}</b><span>{entry?.zh ?? "扑克术语"}</span><p>{entry?.detail ?? "这是当前策略线路使用的术语。"}</p></article>;
              })}
            </div>
          </details>
        </div>
      </details>
      <p className="estimate-note">教练只使用当时可见信息；不会看到 AI 底牌或未来牌。</p>
    </div>
  );
}
function ReviewPanel({ review }: { review: HandReview }) {
  const keySet = new Set(review.keyDecisionIndexes);
  const traces = review.snapshot.actionLog.filter((action) => action.decisionTrace);
  return (
    <div className="review-panel">
      <div className="review-result"><span>本手复盘</span><strong>{review.result.summary}</strong><p>{review.takeaway}</p></div>
      <div className="revealed-hands">
        {review.snapshot.seats.filter((seat) => !seat.isHuman).map((seat) => (
          <div key={seat.id}><span>{seat.name}</span><span className="micro-cards">{seat.holeCards.map((card) => <CardFace key={card.id} card={card} small />)}</span></div>
        ))}
      </div>
      <h4>关键决策</h4>
      {review.decisions.length === 0 && <p className="empty-copy">本手你没有面对需要选择的节点。</p>}
      {review.decisions.map((decision, index) => (
        <details key={`${decision.actionIndex}-${index}`} open={keySet.has(index)} className={`decision-item rating-${decision.rating}`}>
          <summary><span>{STREET_LABELS[decision.street]}</span><b>{decision.rating}</b><em>{ACTION_LABELS[decision.chosen.type]}</em></summary>
          <p>{decision.note}</p><p className="decision-advice">建议：{decision.advice.summary}</p>
          {decision.advice.reasons.map((reason) => <p key={reason}>{reason}</p>)}
          {decision.advice.alternatives[0] && <p className="model-note">备选：{decision.advice.alternatives[0]}</p>}
        </details>
      ))}
      {traces.length > 0 && <details className="ai-traces"><summary>查看 AI 混合策略轨迹 · 赛后可见</summary>{traces.map((action) => <div key={action.index}><b>{action.playerName} · {ACTION_LABELS[action.type]}</b><p>{action.decisionTrace?.summary}</p><div>{action.decisionTrace?.candidates.map((candidate) => <span key={`${candidate.action.type}-${candidate.action.amount ?? 0}`}>{ACTION_LABELS[candidate.action.type]} {Math.round(candidate.weight * 100)}%</span>)}</div></div>)}</details>}
      <p className="seed-line">可复现种子 <code>{review.seed}</code></p>
    </div>
  );
}

function SidePanel({
  tab,
  onTab,
  table,
  mode,
  advice,
  review,
}: {
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  table: FullGameState;
  mode: GameMode;
  advice?: CoachAdvice;
  review?: HandReview;
}) {
  const visibleView = buildPlayerView(table, "hero");
  return (
    <aside className="side-panel">
      <div className="panel-tabs">
        <button className={tab === "coach" ? "active" : ""} onClick={() => onTab("coach")}>{mode === "review" && review ? "复盘" : "教练"}</button>
        <button className={tab === "timeline" ? "active" : ""} onClick={() => onTab("timeline")}>行动</button>
        <button className={tab === "tutorial" ? "active" : ""} onClick={() => onTab("tutorial")}>教程</button>
        <button className={tab === "stats" ? "active" : ""} onClick={() => onTab("stats")}>数据</button>
        <button className={tab === "glossary" ? "active" : ""} onClick={() => onTab("glossary")}>黑话</button>
      </div>
      <div className="panel-content">
        {tab === "coach" && mode === "battle" && <div className="muted-panel"><span>对战模式</span><strong>教练已离席</strong><p>本局不会显示策略建议。只使用正常牌桌信息和你对对手的观察。</p></div>}
        {tab === "coach" && mode === "review" && !review && <div className="muted-panel"><span>指导模式</span><strong>先打，再看答案</strong><p>教练正在静默记录。整手结束前不会给出任何提示或隐藏信息。</p></div>}
        {tab === "coach" && review && mode !== "battle" && <ReviewPanel review={review} />}
        {tab === "coach" && mode === "teaching" && !review && advice && <CoachCard advice={advice} />}
        {tab === "timeline" && (
          <div className="timeline">
            <div className="timeline-stage-header">
              <div className="tsh-main">
                <div className="tsh-title-row">
                  <span className="tsh-label">当前牌局阶段</span>
                  {table.status !== "complete" && (
                    <span className="tsh-live-indicator">
                      <span className="tsh-pulse-dot" /> 进行中
                    </span>
                  )}
                  {table.status === "complete" && (
                    <span className="tsh-complete-indicator">已结束</span>
                  )}
                </div>
                <strong className={`tsh-stage-badge street-${table.street}`}>
                  {STREET_LABELS[table.street]}
                </strong>
              </div>
              {table.community.length > 0 && (
                <div className="tsh-board">
                  <span className="tsh-board-label">当前公共牌 ({table.community.length}张)</span>
                  <div className="tsh-board-cards">
                    {table.community.map((card, i) => (
                      <CardFace key={i} card={card} small />
                    ))}
                  </div>
                </div>
              )}
            </div>

            <h3>行动时间线</h3>
            {table.actionLog.length === 0 ? (
              <p className="empty-copy">本手牌局刚开始，暂无公开行动。</p>
            ) : (
              table.actionLog.map((action, idx) => {
                const isNewStreet = idx === 0 || action.street !== table.actionLog[idx - 1].street;
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
                          {action.street === "flop" && table.community.length >= 3 && (
                            <span className="divider-street-cards">
                              {table.community.slice(0, 3).map((c, i) => (
                                <CardFace key={i} card={c} small />
                              ))}
                            </span>
                          )}
                          {action.street === "turn" && table.community.length >= 4 && (
                            <span className="divider-street-cards">
                              <CardFace card={table.community[3]} small />
                            </span>
                          )}
                          {action.street === "river" && table.community.length >= 5 && (
                            <span className="divider-street-cards">
                              <CardFace card={table.community[4]} small />
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

            {table.status !== "complete" && table.street !== "complete" && table.street !== "showdown" && (
              table.actionLog.length === 0 || table.actionLog[table.actionLog.length - 1].street !== table.street
            ) && (
              <div className={`timeline-street-divider current-ongoing street-${table.street}`}>
                <div className="timeline-street-divider-line" />
                <div className="timeline-street-divider-pill current">
                  <span className="divider-street-icon">
                    {table.street === "preflop" ? "🃏" : table.street === "flop" ? "🎴" : table.street === "turn" ? "⚡" : "🌊"}
                  </span>
                  <span className="divider-street-name">
                    <span className="tsh-pulse-dot" />
                    {STREET_LABELS[table.street]} (当前进行中)
                  </span>
                  {table.street === "flop" && table.community.length >= 3 && (
                    <span className="divider-street-cards">
                      {table.community.slice(0, 3).map((c, i) => (
                        <CardFace key={i} card={c} small />
                      ))}
                    </span>
                  )}
                  {table.street === "turn" && table.community.length >= 4 && (
                    <span className="divider-street-cards">
                      <CardFace card={table.community[3]} small />
                    </span>
                  )}
                  {table.street === "river" && table.community.length >= 5 && (
                    <span className="divider-street-cards">
                      <CardFace card={table.community[4]} small />
                    </span>
                  )}
                </div>
                <div className="timeline-street-divider-line" />
              </div>
            )}

            {table.status === "complete" && (
              <div className="timeline-street-divider street-complete">
                <div className="timeline-street-divider-line" />
                <div className="timeline-street-divider-pill complete">
                  <span className="divider-street-icon">🏁</span>
                  <span className="divider-street-name">
                    {table.street === "showdown" ? STREET_LABELS.showdown : STREET_LABELS.complete}
                  </span>
                </div>
                <div className="timeline-street-divider-line" />
              </div>
            )}

            {table.status === "complete" && table.lastResult && (
              <div className="timeline-settlement-card">
                <div className="timeline-settlement-header">
                  <strong>🏆 本手结算</strong>
                  <span>底池 {formatChips(table.lastResult.potTotal)}</span>
                </div>
                <p className="timeline-settlement-summary">{table.lastResult.summary}</p>
                {table.lastResult.playerSettlements && (
                  <div className="timeline-settlement-list">
                    {table.lastResult.playerSettlements.map((s) => (
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
        {tab === "stats" && <div className="opponent-list"><h3>可观察数据</h3><p>数据来自已经发生的公开行动；样本少时不显示推断标签。</p>{visibleView.seats.filter((seat) => !seat.isHuman).map((seat) => <div className="opponent-row" key={seat.id}><b>{seat.name}</b><span>{seat.position}</span><div><StatPill label="VPIP" value={percent(seat.stats.vpipHands, seat.stats.hands)} /><StatPill label="PFR" value={percent(seat.stats.pfrHands, seat.stats.hands)} /><StatPill label="3BET" value={percent(seat.stats.threeBets, seat.stats.hands)} /><StatPill label="AF" value={percent(seat.stats.aggressiveActions, seat.stats.aggressiveActions + seat.stats.passiveActions)} /></div><small>{seat.stats.hands} hands</small></div>)}</div>}
        {tab === "glossary" && <div className="glossary"><h3>牌桌黑话</h3>{Object.entries(GLOSSARY).map(([term, entry]) => <div key={term}><b>{term}</b><span>{entry.zh}</span><p>{entry.detail}</p></div>)}</div>}
      </div>
    </aside>
  );
}

function PokerTable({
  table,
  mode,
  difficulty,
  tableFormat,
  tournament,
  bankroll,
  speed,
  soundMuted,
  soundVolume,
  advice,
  review,
  onAction,
  onNext,
  onTopUp,
  onSkipTournament,
  isSkippingTournament,
  onLeave,
  onSpeed,
  onSoundMuted,
  onSoundVolume,
  bgmMuted,
  bgmVolume,
  onBgmMuted,
  onBgmVolume,
}: {
  table: FullGameState;
  mode: GameMode;
  difficulty: Difficulty;
  tableFormat: TableFormat;
  tournament?: TournamentState;
  bankroll: number;
  speed: "normal" | "fast";
  soundMuted: boolean;
  soundVolume: number;
  advice?: CoachAdvice;
  review?: HandReview;
  onAction: (action: PlayerActionInput) => void;
  onNext: () => void;
  onTopUp: () => void;
  onSkipTournament: () => void;
  isSkippingTournament: boolean;
  onLeave: () => void;
  onSpeed: () => void;
  onSoundMuted: (muted: boolean) => void;
  onSoundVolume: (volume: number) => void;
  bgmMuted: boolean;
  bgmVolume: number;
  onBgmMuted: (muted: boolean) => void;
  onBgmVolume: (volume: number) => void;
}) {
  const [tab, setTab] = useState<PanelTab>("coach");
  const heroIndex = table.seats.findIndex((seat) => seat.isHuman);
  const hero = table.seats[heroIndex];
  const tournamentSelected = tableFormat === "tournament";
  const activeEntrants = table.seats.filter((seat) => seat.stack > 0).length;
  const blindLevel = tournamentBlindsForHand(table.handNumber).level;
  const heroTournamentPlace = tournament ? tournamentPlace(tournament, hero.id) : undefined;
  const humanTurn = table.status === "playing" && table.activeIndex === heroIndex;
  const legal = humanTurn ? buildPlayerView(table, "hero").legalActions : undefined;
  const minTo = legal?.canRaise ? legal.minRaiseTo : legal?.minBetTo ?? 0;
  const maxTo = legal?.maxTo ?? 0;
  const [raiseTo, setRaiseTo] = useState(minTo);

  useEffect(() => {
    if (humanTurn && legal) setRaiseTo(legal.canRaise ? legal.minRaiseTo : legal.minBetTo);
  }, [humanTurn, table.actionLog.length, table.street, legal?.minRaiseTo, legal?.minBetTo]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!humanTurn || !legal || ["INPUT", "TEXTAREA", "SELECT"].includes((event.target as HTMLElement)?.tagName)) return;
      if (event.key.toLowerCase() === "f" && legal.canFold) onAction({ type: "fold" });
      if (event.key.toLowerCase() === "c" && (legal.canCheck || legal.canCall)) onAction({ type: legal.canCheck ? "check" : "call" });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [humanTurn, legal, onAction]);

  const isCardEqual = (a: Card, b: Card): boolean => {
    if (a.id && b.id) return a.id === b.id;
    return a.rank === b.rank && a.suit === b.suit;
  };

  const showdownContenders = useMemo(() => {
    if (table.status !== "complete" || table.community.length < 5) return [];
    if (table.lastResult && table.lastResult.showdown === false) return [];
    const activeNonFolded = table.seats.filter(
      (s) => !s.folded && s.holeCards && s.holeCards.length >= 2
    );
    if (activeNonFolded.length === 0) return [];
    if (!table.lastResult && activeNonFolded.length < 2) return [];

    const playerView = buildPlayerView(table, "hero");
    const positionMap = new Map(playerView.seats.map((s) => [s.id, s.position]));

    return activeNonFolded
      .map((seat) => {
        const full7 = [...seat.holeCards, ...table.community.slice(0, 5)];
        const score = evaluateSeven(full7);
        const isHoleCard = (c: Card) => seat.holeCards.some((hc) => isCardEqual(hc, c));
        const settlement = table.lastResult?.playerSettlements?.find((s) => s.playerId === seat.id);
        const isWinner = Boolean(
          table.lastResult?.winnerIds?.includes(seat.id) ||
            settlement?.isWinner ||
            (settlement?.net && settlement.net > 0)
        );
        const position = positionMap.get(seat.id);
        return {
          seat,
          position,
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
  }, [table.status, table.community, table.seats, table.lastResult]);

  const showdownContendersMap = useMemo(() => {
    const map = new Map<string, (typeof showdownContenders)[number]>();
    for (const item of showdownContenders) {
      map.set(item.seat.id, item);
    }
    return map;
  }, [showdownContenders]);

  const revealAll = table.status === "complete" && mode === "review";
  const showdownReveal = table.status === "complete" && table.lastResult?.showdown;
  const pot = table.status === "complete" ? table.lastResult?.potTotal ?? 0 : potSize(table);
  const buyIn = table.bigBlind * 100;
  const topUpNeed = Math.max(0, buyIn - hero.stack);

  const preset = (fraction: number) => {
    if (!legal) return;
    const base = table.currentBet === 0 ? Math.round(pot * fraction) : table.currentBet + Math.round(pot * fraction);
    setRaiseTo(Math.max(minTo, Math.min(maxTo, base)));
  };

  return (
    <main className="table-page">
      <header className="table-topbar">
        <div className="brand-lockup compact-brand"><span className="brand-mark">R</span><div><strong>RiverLab</strong><span>{MODE_COPY[mode].title}</span></div></div>
        <div className="table-meta">
          <span>{tournamentSelected ? "TOURNAMENT" : "8-MAX"}</span><i />
          {tournamentSelected && <><span>在场 {activeEntrants}/8</span><i /><span>盲注等级 {blindLevel}</span><i /></>}
          <span>{table.smallBlind}/{table.bigBlind}</span><i /> <span>{DIFFICULTY_COPY[difficulty]} AI</span><i /> <span>第 {table.handNumber} 手</span>
        </div>
        <div className="table-top-actions"><button onClick={onSpeed}>AI {speed === "fast" ? "快速" : "正常"}</button><span>钱包 <b>{formatChips(bankroll)}</b></span><button disabled={table.status !== "complete"} onClick={onLeave}>{tournamentSelected ? "退出锦标赛" : "离桌"}</button></div>
      </header>
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
        <section className="arena-wrap">
          <div className="felt-table">
            <div className="felt-line" />
            <div className="table-brand">RIVERLAB <span>NO LIMIT</span></div>
            <div className="pot-display"><span>{table.status === "complete" ? "本手底池" : "底池"}</span><strong>{formatChips(pot)}</strong><em>{(pot / table.bigBlind).toFixed(1)}BB</em></div>
            <div className="board-cards">{[0, 1, 2, 3, 4].map((index) => <CardFace key={index} card={table.community[index]} />)}</div>
            {table.seats.map((seat, index) => (
              <Seat
                key={seat.id}
                seat={seat}
                index={index}
                table={table}
                reveal={revealAll || Boolean(showdownReveal && !seat.folded)}
              />
            ))}
          </div>

          <div className="action-dock">
            {table.status === "complete" ? (
              <div className="hand-complete">
                <div className="hand-result-copy">
                  <span>本手结束</span>
                  <strong>{table.lastResult?.summary}</strong>

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
                        {showdownContenders.map(({ seat, position, score, isHoleCard, isWinner, settlement }) => {
                          const isHero = seat.isHuman;
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
                                  {position && (
                                    <span className="showdown-contender-pos">{position}</span>
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
                  {table.lastResult?.playerSettlements?.length ? (
                    <div className="hand-settlement-grid">
                      <div className="hand-settlement-header-row">
                        <span>本手各玩家盈亏明细 ({table.lastResult.playerSettlements.length}人参与)</span>
                        <small>投入 · 获得 · 净结果</small>
                      </div>
                      <div className="hand-settlement-cards">
                        {table.lastResult.playerSettlements.map((p) => {
                          const isHero = p.playerId === "hero";
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
                                  ({isWin ? "+" : isLoss ? "−" : ""}{(Math.abs(p.net) / table.bigBlind).toFixed(1)}BB)
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
                  ) : table.lastResult?.winnerSettlements?.length ? (
                    <div className="winner-net-list">
                      {table.lastResult.winnerSettlements.map((settlement) => (
                        <div key={settlement.playerId}>
                          <span>{settlement.playerName}</span>
                          <b>{settlement.net >= 0 ? "净胜" : "净结果"} {settlement.net >= 0 ? "+" : "−"}{formatChips(Math.abs(settlement.net))}</b>
                          <small>{settlement.net >= 0 ? "+" : "−"}{(Math.abs(settlement.net) / table.bigBlind).toFixed(1)}BB</small>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div>
                  {tournamentSelected ? (
                    hero.stack === 0 ? (
                      <div className="tournament-bust-actions">
                        <span>你已出局{heroTournamentPlace ? ` · 第 ${heroTournamentPlace} 名` : ""}</span>
                        <button className="primary-button" disabled={isSkippingTournament} onClick={onSkipTournament} data-testid="skip-tournament">
                          {isSkippingTournament ? "正在模拟剩余比赛…" : "直接模拟到最终结算"} <span>→</span>
                        </button>
                      </div>
                    ) : <button className="primary-button" onClick={onNext}>下一手 <span>→</span></button>
                  ) : (
                    <>
                      {topUpNeed > 0 && <button className="secondary-button" disabled={bankroll < topUpNeed} onClick={onTopUp}>补满至 100BB · {formatChips(topUpNeed)}</button>}
                      <button className="primary-button" disabled={hero.stack === 0 && bankroll < buyIn} onClick={onNext}>{hero.stack === 0 ? `重新买入 ${formatChips(buyIn)}` : "下一手"} <span>→</span></button>
                    </>
                  )}
                </div>
              </div>
            ) : humanTurn && legal ? (
              <div className="human-actions">
                <div className="sizing-controls">
                  <div className="preset-row"><span>加注到</span>{[[1 / 3, "1/3"], [1 / 2, "1/2"], [2 / 3, "2/3"], [1, "满池"]].map(([value, label]) => <button key={String(label)} onClick={() => preset(Number(value))}>{label}</button>)}</div>
                  <div className="range-row"><input aria-label="下注金额" type="range" min={Math.min(minTo, maxTo)} max={Math.max(minTo, maxTo)} value={Math.max(Math.min(raiseTo, maxTo), Math.min(minTo, maxTo))} onChange={(event) => setRaiseTo(Number(event.target.value))} /><input aria-label="下注到" type="number" min={minTo} max={maxTo} value={raiseTo} onChange={(event) => setRaiseTo(Math.max(minTo, Math.min(maxTo, Number(event.target.value))))} /><em>{(raiseTo / table.bigBlind).toFixed(1)}BB</em></div>
                </div>
                <div className="action-buttons">
                  <button className="fold-button" disabled={!legal.canFold} onClick={() => onAction({ type: "fold" })} data-testid="action-fold">弃牌 <kbd>F</kbd></button>
                  <button disabled={!legal.canCheck && !legal.canCall} onClick={() => onAction({ type: legal.canCheck ? "check" : "call" })} data-testid="action-check-call">{legal.canCheck ? "过牌" : `跟注 ${formatChips(legal.callAmount)}`} <kbd>C</kbd></button>
                  <button className="raise-button" disabled={!legal.canBet && !legal.canRaise} onClick={() => onAction({ type: legal.canBet ? "bet" : "raise", amount: raiseTo })} data-testid="action-raise">{legal.canBet ? "下注" : "加注"} {formatChips(raiseTo)}</button>
                  <button className="allin-button" disabled={!legal.canAllIn} onClick={() => onAction({ type: "all-in" })}>ALL IN</button>
                </div>
              </div>
            ) : <div className="waiting-action"><span className="thinking-dots"><i /><i /><i /></span><p>{table.seats[table.activeIndex]?.name ?? "牌桌"} 正在思考</p><em>{STREET_LABELS[table.street]}</em></div>}
          </div>
        </section>
        <SidePanel tab={tab} onTab={setTab} table={table} mode={mode} advice={advice} review={review} />
      </div>
    </main>
  );
}

function TournamentResultScreen({
  tournament,
  bankroll,
  simulatedShowdowns,
  onBack,
}: {
  tournament: TournamentState;
  bankroll: number;
  simulatedShowdowns: number;
  onBack: () => void;
}) {
  const heroPlace = tournamentPlace(tournament, "hero");
  const heroPrize = tournamentPrize(tournament, "hero");
  const podium = tournament.standings.slice(0, 3);
  return (
    <main className="tournament-result-page">
      <header className="result-topbar">
        <div className="brand-lockup compact-brand"><span className="brand-mark">R</span><div><strong>RiverLab</strong><span>TOURNAMENT</span></div></div>
        <div><span>生涯钱包</span><b>{formatChips(bankroll)}</b></div>
      </header>
      <section className="tournament-result-shell">
        <div className="result-hero">
          <span>FINAL RESULT · 八人淘汰赛</span>
          <h1>{heroPlace === 1 ? "你是冠军" : `你获得第 ${heroPlace ?? "—"} 名`}</h1>
          <p>{heroPrize > 0 ? `奖金 ${formatChips(heroPrize)} 训练币已经加入生涯钱包。` : "本场没有获得名次奖金，再来一场继续冲击领奖台。"}</p>
          {simulatedShowdowns > 0 && <small>你出局后，系统以固定种子完成了 {simulatedShowdowns} 次公平全压摊牌模拟。</small>}
        </div>

        <div className="podium-grid">
          {podium.map((standing) => (
            <article key={standing.playerId} className={`podium-card place-${standing.place} ${standing.playerId === "hero" ? "hero-finish" : ""}`}>
              <span>第 {standing.place} 名</span>
              <strong>{standing.playerName}</strong>
              <b>+{formatChips(standing.prize)}</b>
              <small>训练币奖励</small>
            </article>
          ))}
        </div>

        <section className="final-standings">
          <div><span>最终排名</span><em>8 PLAYERS</em></div>
          {tournament.standings.map((standing) => (
            <article key={standing.playerId} className={standing.playerId === "hero" ? "hero-standing" : ""}>
              <b>{standing.place}</b><span>{standing.playerName}</span><em>{standing.prize > 0 ? `+${formatChips(standing.prize)}` : "—"}</em>
            </article>
          ))}
        </section>

        <button className="primary-button result-back" onClick={onBack}>返回大厅 <span>→</span></button>
      </section>
    </main>
  );
}
export default function PokerTrainer() {
  const [appMode, setAppMode] = useState<"singleplayer" | "multiplayer">("singleplayer");
  const [initialRoomCode, setInitialRoomCode] = useState("");
  const [playerName, setPlayerName] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("riverlab_mp_name") || `玩家${Math.floor(100 + Math.random() * 900)}`;
    }
    return "玩家";
  });
  const playerNameRef = useRef(playerName);
  useEffect(() => {
    playerNameRef.current = playerName;
  }, [playerName]);

  const [wsConnected, setWsConnected] = useState(false);
  const [lanIps, setLanIps] = useState<string[]>([]);
  const [serverPort, setServerPort] = useState(4311);
  const [roomList, setRoomList] = useState<RoomSummary[]>([]);
  const [mpState, setMpState] = useState<MultiplayerTableState | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const soundMpHand = useRef(0);
  const soundMpActions = useRef(0);
  const soundMpTurn = useRef("");

  const [screen, setScreen] = useState<Screen>("lobby");
  const [profile, setProfile] = useState<CareerProfile>(() => createDefaultProfile());
  const [table, setTable] = useState<FullGameState | null>(null);
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [decisions, setDecisions] = useState<DecisionRecord[]>([]);
  const [review, setReview] = useState<HandReview | undefined>();
  const [tournament, setTournament] = useState<TournamentState | null>(null);
  const [isSkippingTournament, setIsSkippingTournament] = useState(false);
  const [simulatedShowdowns, setSimulatedShowdowns] = useState(0);
  const processedHand = useRef<string>("");
  const settledTournament = useRef<string>("");
  const soundHand = useRef("");
  const soundedActions = useRef(0);
  const soundedResult = useRef("");
  const soundedTurn = useRef("");

  // URL auto-detect for ?room=XXXX
  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const roomParam = params.get("room");
      if (roomParam) {
        setAppMode("multiplayer");
        setInitialRoomCode(roomParam.trim().toUpperCase());
      }
    }
  }, []);

  // Multiplayer WebSocket connection
  useEffect(() => {
    if (appMode !== "multiplayer") return;

    let socket: WebSocket | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;

    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.host || "localhost:4311";
      socket = new WebSocket(`${protocol}//${host}/ws`);
      wsRef.current = socket;

      socket.onopen = () => {
        setWsConnected(true);
        socket?.send(JSON.stringify({ type: "SET_NAME", name: playerNameRef.current }));
        socket?.send(JSON.stringify({ type: "LIST_ROOMS" }));
      };

      socket.onmessage = (event) => {
        try {
          const msg: ServerMessage = JSON.parse(event.data);
          if (msg.type === "INIT") {
            setLanIps(msg.lanIps);
            setServerPort(msg.port);
          } else if (msg.type === "ROOM_LIST") {
            setRoomList(msg.rooms);
          } else if (msg.type === "ROOM_STATE") {
            setMpState(msg.state);
          } else if (msg.type === "ROOM_LEFT") {
            setMpState(null);
          } else if (msg.type === "ERROR") {
            window.alert(msg.message);
          }
        } catch {
          // ignore
        }
      };

      socket.onclose = () => {
        setWsConnected(false);
        reconnectTimer = setTimeout(connect, 2500);
      };

      socket.onerror = () => {
        socket?.close();
      };
    };

    connect();

    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
      wsRef.current = null;
    };
  }, [appMode]);

  // Multiplayer sound effects synchronization
  useEffect(() => {
    if (!mpState || mpState.status !== "playing") return;
    const volume = profile.preferences.soundMuted ? 0 : profile.preferences.soundVolume;

    // Hand deal
    if (soundMpHand.current !== mpState.handNumber) {
      soundMpHand.current = mpState.handNumber;
      soundMpActions.current = mpState.actionLog.length;
      soundMpTurn.current = "";
      playPokerSound("deal", volume);
      return;
    }

    // Action sounds
    if (mpState.actionLog.length > soundMpActions.current) {
      const newActions = mpState.actionLog.slice(soundMpActions.current);
      soundMpActions.current = mpState.actionLog.length;
      for (const a of newActions) {
        if (a.type === "fold") playPokerSound("fold", volume);
        else if (a.type === "check") playPokerSound("check", volume);
        else if (a.type === "all-in") playPokerSound("all-in", volume);
        else playPokerSound("chips", volume);
      }
    }

    // Hero turn alert
    if (mpState.activeIndex >= 0 && mpState.seats[mpState.activeIndex]?.id === mpState.myId) {
      const turnKey = `${mpState.handNumber}:${mpState.actionLog.length}`;
      if (soundMpTurn.current !== turnKey) {
        soundMpTurn.current = turnKey;
        playPokerSound("turn", volume);
      }
    }
  }, [
    mpState?.handNumber,
    mpState?.actionLog.length,
    mpState?.activeIndex,
    mpState?.status,
    profile.preferences.soundMuted,
    profile.preferences.soundVolume,
  ]);

  const sendMp = useCallback((msg: ClientMessage) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const handleSetPlayerName = (name: string) => {
    const trimmed = name.trim().slice(0, 16);
    if (!trimmed) return;
    setPlayerName(trimmed);
    playerNameRef.current = trimmed;
    if (typeof window !== "undefined") {
      localStorage.setItem("riverlab_mp_name", trimmed);
    }
    sendMp({ type: "SET_NAME", name: trimmed });
  };

  useEffect(() => setProfile(loadProfile()), []);

  useEffect(() => {
    if (!table) return;
    const volume = profile.preferences.soundMuted ? 0 : profile.preferences.soundVolume;
    if (soundHand.current !== table.handId) {
      soundHand.current = table.handId;
      soundedActions.current = table.actionLog.length;
      soundedResult.current = "";
      soundedTurn.current = "";
      playPokerSound("deal", volume);
      return;
    }

    const newActions = table.actionLog.slice(soundedActions.current);
    soundedActions.current = table.actionLog.length;
    for (const action of newActions) {
      if (action.type === "fold") playPokerSound("fold", volume);
      else if (action.type === "check") playPokerSound("check", volume);
      else if (action.type === "all-in") playPokerSound("all-in", volume);
      else playPokerSound("chips", volume);
    }

    if (table.status === "complete" && soundedResult.current !== table.handId) {
      soundedResult.current = table.handId;
      if (table.lastResult?.winnerIds.includes("hero")) playPokerSound("win", volume);
    }
  }, [table?.handId, table?.actionLog.length, table?.status, profile.preferences.soundMuted, profile.preferences.soundVolume]);

  useEffect(() => {
    if (!table || table.status !== "playing" || table.seats[table.activeIndex]?.id !== "hero") return;
    const turnKey = `${table.handId}:${table.actionLog.length}`;
    if (soundedTurn.current === turnKey) return;
    soundedTurn.current = turnKey;
    playPokerSound("turn", profile.preferences.soundMuted ? 0 : profile.preferences.soundVolume);
  }, [table?.handId, table?.actionLog.length, table?.activeIndex, table?.status, profile.preferences.soundMuted, profile.preferences.soundVolume]);
  const commitProfile = useCallback((next: CareerProfile) => {
    setProfile(next);
    saveProfile(next);
  }, []);

  const awardTournamentResult = useCallback((result: TournamentState) => {
    if (!result.finished || settledTournament.current === result.id) return;
    settledTournament.current = result.id;
    const prize = tournamentPrize(result, "hero");
    const place = tournamentPlace(result, "hero");
    if (prize <= 0 || !place) return;
    setProfile((current) => {
      const next = recordBankroll(current, current.bankroll + prize, `锦标赛第 ${place} 名奖励`);
      saveProfile(next);
      return next;
    });
  }, []);

  const startSession = () => {
    void unlockPokerAudio();
    const tableFormat = profile.preferences.tableFormat;
    const isTournament = tableFormat === "tournament";
    const stake = STAKES.find((item) => item.id === profile.preferences.stakeId) ?? STAKES[0];
    const buyIn = isTournament ? TOURNAMENT_STARTING_STACK : stake.bigBlind * 100;
    if (!isTournament && (profile.bankroll < buyIn || !profile.unlockedStakeIds.includes(stake.id))) return;
    const sessionSeed = makeSeed(isTournament ? "tournament" : "session");
    const firstBlinds = isTournament ? tournamentBlindsForHand(1) : stake;
    const seats = createSeatRoster(buyIn, profile.preferences.difficulty, sessionSeed, profile.opponentStats);
    const initial = createTable({ smallBlind: firstBlinds.smallBlind, bigBlind: firstBlinds.bigBlind, difficulty: profile.preferences.difficulty, seats });
    const live = startHand(initial, makeSeed("hand"), { refillBustedBots: !isTournament });
    if (isTournament) {
      setTournament(createTournamentState(live, sessionSeed));
    } else {
      commitProfile(recordBankroll(profile, profile.bankroll - buyIn, `买入 ${stake.id} 牌桌`));
      setTournament(null);
    }
    setSession({ mode: profile.preferences.mode, difficulty: profile.preferences.difficulty, stakeId: isTournament ? "tournament" : stake.id, tableFormat });
    setTable(live);
    setDecisions([]);
    setReview(undefined);
    setSimulatedShowdowns(0);
    setIsSkippingTournament(false);
    settledTournament.current = "";
    processedHand.current = "";
    setScreen("table");
  };

  const handleHumanAction = useCallback((action: PlayerActionInput) => {
    void unlockPokerAudio();
    setTable((current) => {
      if (!current || current.status !== "playing" || current.seats[current.activeIndex]?.id !== "hero") return current;
      const view = buildPlayerView(current, "hero");
      const advice = buildCoachAdvice(view);
      const evaluation = rateDecision(action, advice);
      setDecisions((items) => [...items, {
        actionIndex: current.actionLog.length,
        street: current.street,
        pot: potSize(current),
        chosen: structuredClone(action),
        advice,
        rating: evaluation.rating,
        note: evaluation.note,
      }]);
      return applyAction(current, action);
    });
  }, []);

  useEffect(() => {
    if (!table || table.status !== "playing" || table.activeIndex < 0) return;
    const actor = table.seats[table.activeIndex];
    if (actor.isHuman || !actor.personality) return;
    const expectedHand = table.handId;
    const expectedActions = table.actionLog.length;
    const delay = profile.preferences.aiSpeed === "fast" ? 120 : 560;
    const timer = window.setTimeout(() => {
      setTable((current) => {
        if (!current || current.handId !== expectedHand || current.actionLog.length !== expectedActions || current.seats[current.activeIndex]?.id !== actor.id) return current;
        const view = buildBotView(current, actor.id);
        const decision = chooseBotAction(view, actor.personality!, current.difficulty, profile.stats);
        return applyAction(current, decision.action, decision.trace);
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [table?.handId, table?.actionLog.length, table?.activeIndex, table?.status, profile.preferences.aiSpeed, profile.stats]);

  useEffect(() => {
    if (!table || !session || table.status !== "complete" || processedHand.current === table.handId || !table.lastResult) return;
    processedHand.current = table.handId;
    const completedReview = createHandReview(table, decisions);
    const saved: SavedHand = { id: table.handId, playedAt: Date.now(), mode: session.mode, difficulty: session.difficulty, stakeId: session.stakeId, review: completedReview };
    setReview(completedReview);
    setProfile((current) => {
      let next = recordCompletedHand(current, saved, table);
      if (session.tableFormat === "cash") {
        const heroStack = table.seats.find((seat) => seat.isHuman)?.stack ?? 0;
        next = updateUnlocks(next, next.bankroll + heroStack);
      }
      saveProfile(next);
      return next;
    });

    if (session.tableFormat === "tournament" && tournament) {
      const nextTournament = recordTournamentHand(tournament, table);
      const timer = window.setTimeout(() => {
        setTournament(nextTournament);
        if (nextTournament.finished) {
          awardTournamentResult(nextTournament);
          setScreen("tournament-result");
        }
      }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [table, session, decisions, tournament, awardTournamentResult]);

  const nextHand = () => {
    if (!table || !session) return;
    let base = structuredClone(table);
    const hero = base.seats.find((seat) => seat.isHuman)!;
    const seed = makeSeed("hand");

    if (session.tableFormat === "tournament") {
      if (!tournament || tournament.finished || hero.stack === 0 || base.seats.filter((seat) => seat.stack > 0).length < 2) return;
      for (const seat of base.seats.filter((entry) => !entry.isHuman)) seat.stats = structuredClone(profile.opponentStats[seat.id] ?? seat.stats);
      base = driftBotsForNextHand(base, seed);
      const blinds = tournamentBlindsForHand(base.handNumber + 1);
      base.smallBlind = blinds.smallBlind;
      base.bigBlind = blinds.bigBlind;
      setDecisions([]);
      setReview(undefined);
      processedHand.current = "";
      setTable(startHand(base, seed, { refillBustedBots: false }));
      return;
    }

    const buyIn = table.bigBlind * 100;
    let nextProfile = profile;
    if (hero.stack === 0) {
      if (profile.bankroll < buyIn) return;
      hero.stack = buyIn;
      nextProfile = recordBankroll(profile, profile.bankroll - buyIn, "重新买入");
    }
    for (const seat of base.seats.filter((entry) => !entry.isHuman)) seat.stats = structuredClone(nextProfile.opponentStats[seat.id] ?? seat.stats);
    base = driftBotsForNextHand(base, seed);
    commitProfile(nextProfile);
    setDecisions([]);
    setReview(undefined);
    processedHand.current = "";
    setTable(startHand(base, seed));
  };

  const skipTournament = () => {
    if (!table || !tournament || !session || session.tableFormat !== "tournament" || table.status !== "complete") return;
    if ((table.seats.find((seat) => seat.isHuman)?.stack ?? 0) > 0) return;
    setIsSkippingTournament(true);
    window.setTimeout(() => {
      try {
        const result = fastForwardTournament(table, tournament, `${tournament.id}-fast-forward-${table.handNumber}`);
        setTable(result.table);
        setTournament(result.tournament);
        setSimulatedShowdowns(result.simulatedShowdowns);
        awardTournamentResult(result.tournament);
        setScreen("tournament-result");
      } catch (error) {
        window.alert(error instanceof Error ? error.message : "锦标赛快速结算失败");
      } finally {
        setIsSkippingTournament(false);
      }
    }, 30);
  };
  const topUp = () => {
    if (!table || !session || session.tableFormat !== "cash" || table.status !== "complete") return;
    const buyIn = table.bigBlind * 100;
    const hero = table.seats.find((seat) => seat.isHuman)!;
    const need = Math.max(0, buyIn - hero.stack);
    if (need <= 0 || profile.bankroll < need) return;
    const nextTable = structuredClone(table);
    nextTable.seats.find((seat) => seat.isHuman)!.stack += need;
    setTable(nextTable);
    commitProfile(recordBankroll(profile, profile.bankroll - need, "牌桌补满 100BB"));
  };

  const leaveTable = () => {
    if (!table || !session || table.status !== "complete") return;
    if (session.tableFormat === "cash") {
      const cashOut = table.seats.find((seat) => seat.isHuman)?.stack ?? 0;
      const next = recordBankroll(profile, profile.bankroll + cashOut, "离桌结算");
      commitProfile(updateUnlocks(next, next.bankroll));
    }
    setTable(null);
    setSession(null);
    setTournament(null);
    setReview(undefined);
    setIsSkippingTournament(false);
    setSimulatedShowdowns(0);
    setScreen("lobby");
  };

  const activeAdvice = useMemo(() => {
    if (!table || !session || session.mode !== "teaching" || table.status !== "playing" || table.seats[table.activeIndex]?.id !== "hero") return undefined;
    return buildCoachAdvice(buildPlayerView(table, "hero"));
  }, [table, session]);

  const toggleSpeed = () => {
    const next = { ...profile, preferences: { ...profile.preferences, aiSpeed: profile.preferences.aiSpeed === "fast" ? "normal" as const : "fast" as const } };
    commitProfile(next);
  };

  const setSoundMuted = (soundMuted: boolean) => {
    void unlockPokerAudio();
    commitProfile({ ...profile, preferences: { ...profile.preferences, soundMuted } });
  };

  const setSoundVolume = (soundVolume: number) => {
    void unlockPokerAudio();
    commitProfile({
      ...profile,
      preferences: { ...profile.preferences, soundVolume, soundMuted: soundVolume === 0 },
    });
  };

  const setBgmMuted = (bgmMuted: boolean) => {
    void unlockPokerAudio();
    void bgm.unlock();
    bgm.setMuted(bgmMuted);
    commitProfile({ ...profile, preferences: { ...profile.preferences, bgmMuted } });
  };

  const setBgmVolume = (bgmVolume: number) => {
    void unlockPokerAudio();
    void bgm.unlock();
    bgm.setVolume(bgmVolume);
    commitProfile({
      ...profile,
      preferences: { ...profile.preferences, bgmVolume, bgmMuted: bgmVolume === 0 },
    });
  };

  // Sync BGM init and volume
  useEffect(() => {
    bgm.init(profile.preferences.bgmVolume, profile.preferences.bgmMuted);
  }, [profile.preferences.bgmVolume, profile.preferences.bgmMuted]);

  // Global user interaction unlock for browser audio policy
  useEffect(() => {
    const handleUnlock = () => {
      void unlockPokerAudio();
      void bgm.unlock();
    };
    window.addEventListener("pointerdown", handleUnlock, { passive: true });
    window.addEventListener("keydown", handleUnlock, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", handleUnlock);
      window.removeEventListener("keydown", handleUnlock);
    };
  }, []);

  // Adaptive dynamic BGM stage switching with 1s crossfade & timestamp sync
  const bgmStage = useMemo(() => {
    if (appMode === "multiplayer") {
      return getBgmStageFromMultiplayer(mpState);
    }
    return getBgmStageFromSinglePlayer(table, screen);
  }, [appMode, mpState, table, screen]);

  useEffect(() => {
    bgm.switchStage(bgmStage);
  }, [bgmStage]);

  if (appMode === "multiplayer") {
    if (mpState && mpState.status === "playing") {
      return (
        <MultiplayerTable
          state={mpState}
          soundMuted={profile.preferences.soundMuted}
          soundVolume={profile.preferences.soundVolume}
          bgmMuted={profile.preferences.bgmMuted}
          bgmVolume={profile.preferences.bgmVolume}
          onSoundMuted={setSoundMuted}
          onSoundVolume={setSoundVolume}
          onBgmMuted={setBgmMuted}
          onBgmVolume={setBgmVolume}
          onAction={(action) => sendMp({ type: "PLAYER_ACTION", action })}
          onUseTimeBank={() => sendMp({ type: "USE_TIME_BANK" })}
          onNextHand={() => sendMp({ type: "NEXT_HAND" })}
          onRebuy={() => sendMp({ type: "REBUY" })}
          onToggleGodMode={(enabled) => sendMp({ type: "TOGGLE_GOD_MODE", enabled })}
          onLeaveRoom={() => sendMp({ type: "LEAVE_ROOM" })}
          onTransferHost={(targetPlayerId) => sendMp({ type: "TRANSFER_HOST", targetPlayerId })}
          onTakeSeat={(seatIndex) => sendMp({ type: "TAKE_SEAT", seatIndex })}
          onStandUp={() => sendMp({ type: "STAND_UP" })}
          onAddAiBot={(seatIndex) => sendMp({ type: "ADD_AI_BOT", seatIndex })}
          onRemoveAiBot={(seatIndex) => sendMp({ type: "REMOVE_AI_BOT", seatIndex })}
          onFillAiBots={(targetCount) => sendMp({ type: "FILL_AI_BOTS", targetCount })}
          onClearAiBots={() => sendMp({ type: "CLEAR_AI_BOTS" })}
          onSelectCharacter={(characterId) => sendMp({ type: "SELECT_CHARACTER", characterId })}
          onUseSkill={(skillId, targetPlayerId, targetCardIndex) =>
            sendMp({ type: "USE_SKILL", skillId, targetPlayerId, targetCardIndex })
          }
        />
      );
    }

    return (
      <div className="mp-root-container">
        <header className="lobby-nav mp-nav-override">
          <div className="brand-lockup">
            <span className="brand-mark">🌐</span>
            <div><strong>RiverLab</strong><span>局域网多人对战</span></div>
          </div>
          <div className="lobby-mode-switch">
            <button type="button" onClick={() => setAppMode("singleplayer")}>🤖 单机训练</button>
            <button type="button" className="active">🌐 局域网联机</button>
          </div>
          <AudioControls
            soundMuted={profile.preferences.soundMuted}
            soundVolume={profile.preferences.soundVolume}
            onSoundMuted={(soundMuted) => commitProfile({ ...profile, preferences: { ...profile.preferences, soundMuted } })}
            onSoundVolume={(soundVolume) => commitProfile({ ...profile, preferences: { ...profile.preferences, soundVolume, soundMuted: soundVolume === 0 } })}
            bgmMuted={profile.preferences.bgmMuted}
            bgmVolume={profile.preferences.bgmVolume}
            onBgmMuted={setBgmMuted}
            onBgmVolume={setBgmVolume}
          />
        </header>

        <MultiplayerLobby
          state={mpState}
          connected={wsConnected}
          lanIps={lanIps}
          port={serverPort}
          playerName={playerName}
          roomList={roomList}
          onSetName={handleSetPlayerName}
          onCreateRoom={(cfg) => sendMp({ type: "CREATE_ROOM", config: cfg, playerName: playerNameRef.current })}
          onJoinRoom={(code, asSpec) => sendMp({ type: "JOIN_ROOM", roomCode: code, asSpectator: asSpec, playerName: playerNameRef.current })}
          onLeaveRoom={() => sendMp({ type: "LEAVE_ROOM" })}
          onTakeSeat={(index) => sendMp({ type: "TAKE_SEAT", seatIndex: index })}
          onStandUp={() => sendMp({ type: "STAND_UP" })}
          onToggleReady={() => sendMp({ type: "TOGGLE_READY" })}
          onStartGame={() => sendMp({ type: "START_GAME" })}
          onRefreshRooms={() => sendMp({ type: "LIST_ROOMS" })}
          onTransferHost={(targetPlayerId) => sendMp({ type: "TRANSFER_HOST", targetPlayerId })}
          onAddAiBot={(seatIndex) => sendMp({ type: "ADD_AI_BOT", seatIndex })}
          onRemoveAiBot={(seatIndex) => sendMp({ type: "REMOVE_AI_BOT", seatIndex })}
          onFillAiBots={(targetCount) => sendMp({ type: "FILL_AI_BOTS", targetCount })}
          onClearAiBots={() => sendMp({ type: "CLEAR_AI_BOTS" })}
          onToggleChaosMode={(enabled) => sendMp({ type: "TOGGLE_CHAOS_MODE", enabled })}
          initialRoomCode={initialRoomCode}
        />
      </div>
    );
  }

  if (screen === "tournament-result" && tournament?.finished && table && session) {
    return <TournamentResultScreen tournament={tournament} bankroll={profile.bankroll} simulatedShowdowns={simulatedShowdowns} onBack={leaveTable} />;
  }
  if (screen === "lobby" || !table || !session) return <Lobby profile={profile} onProfile={commitProfile} onStart={startSession} onSwitchToMultiplayer={() => setAppMode("multiplayer")} />;
  return <PokerTable table={table} mode={session.mode} difficulty={session.difficulty} tableFormat={session.tableFormat} tournament={tournament ?? undefined} bankroll={profile.bankroll} speed={profile.preferences.aiSpeed} soundMuted={profile.preferences.soundMuted} soundVolume={profile.preferences.soundVolume} bgmMuted={profile.preferences.bgmMuted} bgmVolume={profile.preferences.bgmVolume} advice={activeAdvice} review={review} onAction={handleHumanAction} onNext={nextHand} onTopUp={topUp} onSkipTournament={skipTournament} isSkippingTournament={isSkippingTournament} onLeave={leaveTable} onSpeed={toggleSpeed} onSoundMuted={setSoundMuted} onSoundVolume={setSoundVolume} onBgmMuted={setBgmMuted} onBgmVolume={setBgmVolume} />;
}
