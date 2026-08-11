import { EMPTY_STATS, STAKES } from "./types";
import type { CareerProfile, FullGameState, ObservedOpponentStats, SavedHand } from "./types";

const STORAGE_KEY = "riverlab-poker-profile-v1";

export function createDefaultProfile(): CareerProfile {
  return {
    version: 1,
    bankroll: 20_000,
    startingBankroll: 20_000,
    unlockedStakeIds: ["5-10"],
    refillCount: 0,
    bankruptcyCount: 0,
    maxBankroll: 20_000,
    minBankroll: 20_000,
    bankrollHistory: [{ at: Date.now(), value: 20_000, reason: "创建训练生涯" }],
    stats: {
      ...EMPTY_STATS,
      wins: 0,
      biggestPot: 0,
    },
    opponentStats: {},
    hands: [],
    preferences: {
      aiSpeed: "normal",
      mode: "teaching",
      tableFormat: "cash",
      difficulty: "standard",
      stakeId: "5-10",
      soundMuted: false,
      soundVolume: 0.55,
    },
  };
}

function normalizeObservedStats(value?: Partial<ObservedOpponentStats>): ObservedOpponentStats {
  return { ...EMPTY_STATS, ...(value ?? {}) };
}

function mergeProfile(value: Partial<CareerProfile>): CareerProfile {
  const base = createDefaultProfile();
  const opponentStats = Object.fromEntries(
    Object.entries(value.opponentStats ?? {}).map(([id, stats]) => [id, normalizeObservedStats(stats)]),
  );
  return {
    ...base,
    ...value,
    stats: { ...base.stats, ...(value.stats ?? {}) },
    preferences: { ...base.preferences, ...(value.preferences ?? {}) },
    opponentStats,
    bankrollHistory: Array.isArray(value.bankrollHistory) ? value.bankrollHistory.slice(-300) : base.bankrollHistory,
    hands: Array.isArray(value.hands) ? value.hands.slice(-100) : [],
    unlockedStakeIds: Array.isArray(value.unlockedStakeIds) ? value.unlockedStakeIds : ["5-10"],
    version: 1,
  };
}

export function loadProfile(): CareerProfile {
  if (typeof window === "undefined") return createDefaultProfile();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultProfile();
    return mergeProfile(JSON.parse(raw) as Partial<CareerProfile>);
  } catch {
    return createDefaultProfile();
  }
}

export function saveProfile(profile: CareerProfile): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
}

export function parseImportedProfile(raw: string): CareerProfile {
  const value = JSON.parse(raw) as Partial<CareerProfile>;
  if (value.version !== 1 || typeof value.bankroll !== "number") throw new Error("这不是有效的 RiverLab 生涯文件");
  return mergeProfile(value);
}

export function exportProfile(profile: CareerProfile): void {
  const blob = new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `riverlab-career-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function clearStoredProfile(): CareerProfile {
  const fresh = createDefaultProfile();
  saveProfile(fresh);
  return fresh;
}

export function updateUnlocks(profile: CareerProfile, totalWealth: number): CareerProfile {
  const next = structuredClone(profile);
  for (const stake of STAKES) {
    if (totalWealth >= stake.unlockBankroll && !next.unlockedStakeIds.includes(stake.id)) {
      next.unlockedStakeIds.push(stake.id);
    }
  }
  return next;
}

export function refillBankroll(profile: CareerProfile): CareerProfile {
  const next = structuredClone(profile);
  if (next.bankroll >= 20_000) return next;
  if (next.bankroll === 0) next.bankruptcyCount += 1;
  next.bankroll = 20_000;
  next.refillCount += 1;
  next.maxBankroll = Math.max(next.maxBankroll, next.bankroll);
  next.bankrollHistory.push({ at: Date.now(), value: next.bankroll, reason: "领取训练币" });
  return next;
}

const AGGRESSIVE_TYPES = new Set(["bet", "raise", "all-in"]);
const PASSIVE_TYPES = new Set(["check", "call"]);
const POSTFLOP_STREETS = ["flop", "turn", "river"] as const;

function facedAggressionBefore(state: FullGameState, playerId: string, actionIndex: number, street: string): boolean {
  const priorOwnAction = state.actionLog
    .filter((action) => action.playerId === playerId && action.street === street && action.index < actionIndex)
    .at(-1)?.index ?? -1;
  return state.actionLog.some((action) => action.street === street
    && action.playerId !== playerId
    && action.index > priorOwnAction
    && action.index < actionIndex
    && AGGRESSIVE_TYPES.has(action.type));
}

export function updateObservedStats(
  state: FullGameState,
  playerId: string,
  currentInput: Partial<ObservedOpponentStats> = EMPTY_STATS,
): ObservedOpponentStats {
  const current = normalizeObservedStats(currentInput);
  const actions = state.actionLog.filter((action) => action.playerId === playerId);
  const preflop = actions.filter((action) => action.street === "preflop" && !action.type.includes("blind"));
  const aggressivePreflop = preflop.filter((action) => AGGRESSIVE_TYPES.has(action.type));
  const voluntary = preflop.some((action) => ["call", "bet", "raise", "all-in"].includes(action.type));
  const raisesBefore = (actionIndex: number) => state.actionLog.filter((action) => action.street === "preflop"
    && action.index < actionIndex
    && AGGRESSIVE_TYPES.has(action.type)).length;
  const madeThreeBet = aggressivePreflop.some((action) => raisesBefore(action.index) >= 1);
  const postflopActions = actions.filter((action) => POSTFLOP_STREETS.includes(action.street as typeof POSTFLOP_STREETS[number]));
  const postflopAggressive = postflopActions.filter((action) => AGGRESSIVE_TYPES.has(action.type)).length;
  const postflopPassive = postflopActions.filter((action) => PASSIVE_TYPES.has(action.type)).length;
  const streetCount = (street: typeof POSTFLOP_STREETS[number], types: Set<string>) => postflopActions
    .filter((action) => action.street === street && types.has(action.type)).length;

  let facedPostflopBets = 0;
  let foldedToPostflopBets = 0;
  let facedRiverBets = 0;
  let foldedToRiverBets = 0;
  for (const action of postflopActions) {
    if (!facedAggressionBefore(state, playerId, action.index, action.street)) continue;
    facedPostflopBets += 1;
    foldedToPostflopBets += action.type === "fold" ? 1 : 0;
    if (action.street === "river") {
      facedRiverBets += 1;
      foldedToRiverBets += action.type === "fold" ? 1 : 0;
    }
  }

  const firstAction = (street: typeof POSTFLOP_STREETS[number]) => postflopActions.find((action) => action.street === street);
  const wasAggressive = (street: typeof POSTFLOP_STREETS[number]) => postflopActions.some((action) => action.street === street && AGGRESSIVE_TYPES.has(action.type));
  const turnFirst = firstAction("turn");
  const riverFirst = firstAction("river");
  const turnBarrelOpportunity = Boolean(wasAggressive("flop") && turnFirst && !facedAggressionBefore(state, playerId, turnFirst.index, "turn"));
  const riverBarrelOpportunity = Boolean(wasAggressive("turn") && riverFirst && !facedAggressionBefore(state, playerId, riverFirst.index, "river"));
  const riverBeforeFirst = riverFirst ? state.actionLog.filter((action) => action.street === "river" && action.index < riverFirst.index) : [];
  const riverStabOpportunity = Boolean(riverFirst
    && riverBeforeFirst.some((action) => action.playerId !== playerId && action.type === "check")
    && !riverBeforeFirst.some((action) => AGGRESSIVE_TYPES.has(action.type)));
  const handAggression = postflopAggressive + postflopPassive > 0
    ? postflopAggressive / (postflopAggressive + postflopPassive)
    : current.recentAggression;

  return {
    ...current,
    hands: current.hands + 1,
    vpipHands: current.vpipHands + (voluntary ? 1 : 0),
    pfrHands: current.pfrHands + (aggressivePreflop.length > 0 ? 1 : 0),
    threeBets: current.threeBets + (madeThreeBet ? 1 : 0),
    aggressiveActions: current.aggressiveActions + postflopAggressive,
    passiveActions: current.passiveActions + postflopPassive,
    flopAggressiveActions: current.flopAggressiveActions + streetCount("flop", AGGRESSIVE_TYPES),
    flopPassiveActions: current.flopPassiveActions + streetCount("flop", PASSIVE_TYPES),
    turnAggressiveActions: current.turnAggressiveActions + streetCount("turn", AGGRESSIVE_TYPES),
    turnPassiveActions: current.turnPassiveActions + streetCount("turn", PASSIVE_TYPES),
    riverAggressiveActions: current.riverAggressiveActions + streetCount("river", AGGRESSIVE_TYPES),
    riverPassiveActions: current.riverPassiveActions + streetCount("river", PASSIVE_TYPES),
    facedPostflopBets: current.facedPostflopBets + facedPostflopBets,
    foldedToPostflopBets: current.foldedToPostflopBets + foldedToPostflopBets,
    facedRiverBets: current.facedRiverBets + facedRiverBets,
    foldedToRiverBets: current.foldedToRiverBets + foldedToRiverBets,
    turnBarrelOpportunities: current.turnBarrelOpportunities + (turnBarrelOpportunity ? 1 : 0),
    turnBarrels: current.turnBarrels + (turnBarrelOpportunity && turnFirst && AGGRESSIVE_TYPES.has(turnFirst.type) ? 1 : 0),
    riverBarrelOpportunities: current.riverBarrelOpportunities + (riverBarrelOpportunity ? 1 : 0),
    riverBarrels: current.riverBarrels + (riverBarrelOpportunity && riverFirst && AGGRESSIVE_TYPES.has(riverFirst.type) ? 1 : 0),
    riverStabOpportunities: current.riverStabOpportunities + (riverStabOpportunity ? 1 : 0),
    riverStabs: current.riverStabs + (riverStabOpportunity && riverFirst && AGGRESSIVE_TYPES.has(riverFirst.type) ? 1 : 0),
    recentAggression: current.recentAggression * 0.88 + handAggression * 0.12,
  };
}

export function recordCompletedHand(profile: CareerProfile, savedHand: SavedHand, state: FullGameState): CareerProfile {
  const next = structuredClone(profile);
  next.hands = [...next.hands, savedHand].slice(-100);
  const heroParticipated = state.seats.some((seat) => seat.isHuman && seat.holeCards.length === 2);
  const heroStats = heroParticipated ? updateObservedStats(state, "hero", next.stats) : next.stats;
  next.stats = {
    ...heroStats,
    wins: next.stats.wins + (heroParticipated && state.lastResult?.winnerIds.includes("hero") ? 1 : 0),
    biggestPot: Math.max(next.stats.biggestPot, state.lastResult?.potTotal ?? 0),
  };
  for (const seat of state.seats.filter((entry) => !entry.isHuman && entry.holeCards.length === 2)) {
    next.opponentStats[seat.id] = updateObservedStats(state, seat.id, next.opponentStats[seat.id]);
  }
  return next;
}
export function recordBankroll(profile: CareerProfile, value: number, reason: string): CareerProfile {
  let next = structuredClone(profile);
  next.bankroll = Math.max(0, Math.floor(value));
  next.maxBankroll = Math.max(next.maxBankroll, next.bankroll);
  next.minBankroll = Math.min(next.minBankroll, next.bankroll);
  next.bankrollHistory = [...next.bankrollHistory, { at: Date.now(), value: next.bankroll, reason }].slice(-300);
  next = updateUnlocks(next, next.bankroll);
  return next;
}
