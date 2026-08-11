import { preflopStrength } from "./evaluator";
import promotedExpertPolicy from "./policies/expert-selfplay.json";
import { classifyDraw } from "./hand-profile";
import { buildBotLinePlan } from "./line-planner";
import { SeededRng } from "./rng";
import { analyzeVisibleDecision } from "./strategy";
import { EMPTY_STATS } from "./types";
import type {
  BotPersonality,
  BotViewState,
  CareerStats,
  DecisionCandidate,
  DecisionTrace,
  Difficulty,
  FullGameState,
  ObservedOpponentStats,
  PlayerActionInput,
  SeatState,
} from "./types";

const BOT_NAMES = ["林澈", "老周", "Mika", "阿岚", "北辰", "乔木", "Rin"];

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

export function createBotPersonality(seed: string, difficulty: Difficulty, index: number): BotPersonality {
  const rng = new SeededRng(`${seed}-personality-${index}`);
  const archetypes: BotPersonality[] = [
    { looseness: 0.34, aggression: 0.72, bluff: 0.54, trapping: 0.22, calling: 0.34, risk: 0.62, sizing: 0.72, adaptability: 0.66 },
    { looseness: 0.18, aggression: 0.62, bluff: 0.28, trapping: 0.48, calling: 0.24, risk: 0.38, sizing: 0.50, adaptability: 0.58 },
    { looseness: 0.48, aggression: 0.34, bluff: 0.26, trapping: 0.38, calling: 0.70, risk: 0.45, sizing: 0.36, adaptability: 0.40 },
    { looseness: 0.42, aggression: 0.82, bluff: 0.66, trapping: 0.30, calling: 0.22, risk: 0.74, sizing: 0.82, adaptability: 0.78 },
    { looseness: 0.26, aggression: 0.46, bluff: 0.34, trapping: 0.70, calling: 0.44, risk: 0.32, sizing: 0.58, adaptability: 0.52 },
    { looseness: 0.30, aggression: 0.68, bluff: 0.46, trapping: 0.56, calling: 0.31, risk: 0.50, sizing: 0.66, adaptability: 0.84 },
    { looseness: 0.39, aggression: 0.52, bluff: 0.58, trapping: 0.36, calling: 0.51, risk: 0.60, sizing: 0.44, adaptability: 0.62 },
  ];
  const base = archetypes[index % archetypes.length];
  const spread = difficulty === "casual" ? 0.16 : difficulty === "standard" ? 0.10 : 0.06;
  const centerPull = difficulty === "expert" ? 0.22 : 0;
  const learnedBlend = promotedExpertPolicy.enabled
    ? difficulty === "expert" ? 0.30 : difficulty === "standard" ? 0.10 : 0
    : 0;
  return Object.fromEntries(
    Object.entries(base).map(([key, value]) => {
      const trait = key as keyof BotPersonality;
      const natural = value + rng.between(-spread, spread) + (0.5 - value) * centerPull;
      const learned = promotedExpertPolicy.genes[trait];
      return [key, clamp(natural * (1 - learnedBlend) + learned * learnedBlend, 0.08, 0.92)];
    }),
  ) as unknown as BotPersonality;
}

export function driftPersonality(personality: BotPersonality, seed: string): BotPersonality {
  const rng = new SeededRng(seed);
  return Object.fromEntries(
    Object.entries(personality).map(([key, value]) => [key, clamp(value + rng.between(-0.025, 0.025), 0.06, 0.94)]),
  ) as unknown as BotPersonality;
}

export function createSeatRoster(
  buyIn: number,
  difficulty: Difficulty,
  seed: string,
  observed: Record<string, ObservedOpponentStats> = {},
): SeatState[] {
  const human: SeatState = {
    id: "hero",
    name: "你",
    isHuman: true,
    stack: buyIn,
    holeCards: [],
    folded: false,
    allIn: false,
    committedStreet: 0,
    committedHand: 0,
    acted: false,
    raiseLocked: false,
    stats: { ...EMPTY_STATS },
  };
  const bots = BOT_NAMES.map((name, index): SeatState => ({
    id: `bot-${index + 1}`,
    name,
    isHuman: false,
    stack: buyIn,
    holeCards: [],
    folded: false,
    allIn: false,
    committedStreet: 0,
    committedHand: 0,
    acted: false,
    raiseLocked: false,
    personality: createBotPersonality(seed, difficulty, index),
    stats: { ...EMPTY_STATS, ...structuredClone(observed[`bot-${index + 1}`] ?? {}) },
  }));
  return [human, ...bots];
}

function posteriorRate(numerator: number, denominator: number, fallback: number, priorHands = 12): number {
  return (numerator + fallback * priorHands) / Math.max(1, denominator + priorHands);
}

function sampleConfidence(samples: number, fullConfidenceAt = 36): number {
  return clamp(samples / Math.max(1, fullConfidenceAt));
}

function makeBetTarget(view: BotViewState, personality: BotPersonality, equity: number, polarized = false): number {
  const legal = view.legalActions;
  const pot = view.seats.reduce((sum, seat) => sum + seat.committedHand, 0);
  if (view.street === "preflop") {
    if (view.currentBet <= view.bigBlind) {
      const open = view.bigBlind * (2.15 + personality.sizing * 0.8);
      return Math.max(legal.minRaiseTo, Math.min(legal.maxTo, Math.round(open)));
    }
    const multiplier = 2.65 + personality.sizing * 0.85 + (equity > 0.82 ? 0.25 : 0);
    return Math.max(legal.minRaiseTo, Math.min(legal.maxTo, Math.round(view.currentBet * multiplier)));
  }
  const fraction = polarized && (view.street === "turn" || view.street === "river")
    ? view.street === "river" ? 0.84 + personality.sizing * 0.66 : 0.58 + personality.sizing * 0.48
    : equity > 0.72 ? 0.56 + personality.sizing * 0.30 : 0.32 + personality.sizing * 0.36;
  const chips = Math.max(view.bigBlind, Math.round(pot * fraction));
  const target = view.currentBet === 0 ? chips : view.currentBet + Math.max(view.minRaise, chips);
  return Math.max(view.currentBet === 0 ? legal.minBetTo : legal.minRaiseTo, Math.min(legal.maxTo, target));
}

function addCandidate(candidates: DecisionCandidate[], action: PlayerActionInput, label: string, weight: number): void {
  if (weight <= 0) return;
  const key = `${action.type}-${action.amount ?? 0}`;
  const existing = candidates.find((candidate) => `${candidate.action.type}-${candidate.action.amount ?? 0}` === key);
  if (existing) existing.weight += weight;
  else candidates.push({ action, label, weight });
}

function normalizeCandidates(candidates: DecisionCandidate[]): DecisionCandidate[] {
  const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0) || 1;
  return candidates.map((candidate) => ({ ...candidate, weight: candidate.weight / total }));
}

function boardBluffQuality(view: BotViewState): number {
  if (view.community.length === 0) return preflopStrength(view.holeCards) * 0.55;
  const highBlocker = view.holeCards.some((card) => card.rank >= 13) ? 0.18 : 0;
  const suitCounts = new Map<string, number>();
  for (const card of view.community) suitCounts.set(card.suit, (suitCounts.get(card.suit) ?? 0) + 1);
  const monotonePenalty = Math.max(...suitCounts.values()) >= 4 ? 0.16 : 0;
  const uniqueRanks = new Set(view.community.map((card) => card.rank)).size;
  const dryBonus = uniqueRanks === view.community.length ? 0.14 : 0.05;
  return clamp(0.30 + highBlocker + dryBonus - monotonePenalty);
}

function runoutPressure(view: BotViewState): number {
  if (view.community.length < 4) return 0;
  const last = view.community[view.community.length - 1];
  const previous = view.community.slice(0, -1);
  const previousHigh = Math.max(...previous.map((card) => card.rank));
  const overcard = last.rank > previousHigh && last.rank >= 11 ? 0.24 : 0;
  const paired = previous.some((card) => card.rank === last.rank) ? 0.16 : 0;
  const previousSuitCount = previous.filter((card) => card.suit === last.suit).length;
  const flushShift = previousSuitCount === 2 ? 0.28 : previousSuitCount >= 3 ? 0.12 : 0;
  const connected = previous.filter((card) => Math.abs(card.rank - last.rank) <= 2).length >= 2 ? 0.16 : 0;
  return clamp(overcard + paired + flushShift + connected);
}

type BluffProfile = {
  quality: number;
  credible: boolean;
  missedDraw: boolean;
  nutBlocker: boolean;
  label: string;
};

function lateStreetBluffProfile(
  view: BotViewState,
  analysis: ReturnType<typeof analyzeVisibleDecision>,
  opponents: number,
): BluffProfile {
  const lateStreet = view.street === "turn" || view.street === "river";
  const weakEnough = analysis.handProfile.relativeTier === "weak" || analysis.handProfile.relativeTier === "bluff-catcher";
  const previousDraw = view.street === "river" && view.community.length === 5
    ? classifyDraw(view.holeCards, view.community.slice(0, 4))
    : classifyDraw(view.holeCards, view.community);
  const missedDraw = view.street === "river"
    && previousDraw.drawClass !== "none"
    && previousDraw.drawClass !== "backdoor-flush"
    && analysis.handProfile.madeClass === "high-card";
  const nutBlocker = analysis.handProfile.blockers.some((note) => note.includes("坚果"));
  const aceBlocker = analysis.handProfile.blockers.some((note) => note.startsWith("A 阻断牌"));
  const carriedAggression = view.actionLog.some((action) => action.playerId === view.viewerId
    && action.street !== view.street
    && action.street !== "preflop"
    && ["bet", "raise", "all-in"].includes(action.type));
  const checkedTo = view.legalActions.toCall === 0 && view.actionLog.some((action) => action.street === view.street && action.type === "check" && action.playerId !== view.viewerId);
  const currentDraw = view.street === "turn" && analysis.handProfile.drawClass !== "none" && analysis.handProfile.drawClass !== "backdoor-flush";
  const showdownPenalty = analysis.handProfile.relativeTier === "bluff-catcher" ? 0.18
    : analysis.handProfile.relativeTier === "medium" ? 0.40
      : strongTier(analysis.handProfile.relativeTier) ? 0.80 : 0;
  const multiwayPenalty = Math.max(0, opponents - 1) * 0.20;
  const quality = clamp(
    boardBluffQuality(view) * 0.18
      + runoutPressure(view) * 0.24
      + (missedDraw ? 0.32 : 0)
      + (currentDraw ? 0.20 : 0)
      + (nutBlocker ? 0.28 : aceBlocker ? 0.07 : 0)
      + (carriedAggression ? 0.08 : 0)
      + (checkedTo ? 0.06 : 0)
      + (opponents === 1 ? 0.08 : 0)
      - showdownPenalty
      - multiwayPenalty,
  );
  const credible = lateStreet && weakEnough && quality >= (view.street === "river" ? 0.34 : 0.28);
  const label = missedDraw ? "错失听牌" : nutBlocker ? "坚果阻断牌" : currentDraw ? "强听牌" : "范围阻断";
  return { quality, credible, missedDraw, nutBlocker, label };
}

function strongTier(tier: ReturnType<typeof analyzeVisibleDecision>["handProfile"]["relativeTier"]): boolean {
  return tier === "nuts" || tier === "near-nuts" || tier === "strong";
}

export interface BotDecisionOptions {
  /** Overrides Monte Carlo work for offline training or deterministic audits. */
  iterations?: number;
  /** Public identity and accumulated public stats of the opponent being modelled. */
  opponentId?: string;
  opponentStats?: ObservedOpponentStats;
}

export function chooseBotAction(
  view: BotViewState,
  personality: BotPersonality,
  difficulty: Difficulty,
  heroStats?: CareerStats,
  options: BotDecisionOptions = {},
): { action: PlayerActionInput; trace: DecisionTrace } {
  const legal = view.legalActions;
  const actor = view.seats.find((seat) => seat.id === view.viewerId)!;
  const opponents = view.seats.filter((seat) => seat.id !== actor.id && !seat.folded).length;
  const rng = new SeededRng(`${view.handId}-${view.actionLog.length}-${actor.id}`);
  const iterations = options.iterations ?? (difficulty === "expert" ? 360 : difficulty === "standard" ? 220 : 120);
  const analysis = analyzeVisibleDecision(view, iterations);
  const targetStats = options.opponentStats ?? heroStats;
  const targetOpponentId = options.opponentId ?? "hero";
  let equity = analysis.equity;
  const noise = difficulty === "casual" ? 0.14 : difficulty === "standard" ? 0.07 : 0.025;
  equity = clamp(equity + rng.between(-noise, noise));
  const pot = view.seats.reduce((sum, seat) => sum + seat.committedHand, 0);
  const potOdds = analysis.potOdds;
  const overallAggressive = targetStats?.aggressiveActions ?? 0;
  const overallPassive = targetStats?.passiveActions ?? 0;
  const overallSamples = overallAggressive + overallPassive;
  const heroAggression = posteriorRate(overallAggressive, overallSamples, 0.42);
  const streetAggressive = targetStats && view.street === "flop" ? targetStats.flopAggressiveActions
    : targetStats && view.street === "turn" ? targetStats.turnAggressiveActions
      : targetStats && view.street === "river" ? targetStats.riverAggressiveActions : 0;
  const streetPassive = targetStats && view.street === "flop" ? targetStats.flopPassiveActions
    : targetStats && view.street === "turn" ? targetStats.turnPassiveActions
      : targetStats && view.street === "river" ? targetStats.riverPassiveActions : 0;
  const streetSamples = streetAggressive + streetPassive;
  const heroStreetAggression = posteriorRate(streetAggressive, streetSamples, heroAggression, 10);
  const recentConfidence = sampleConfidence(targetStats?.hands ?? 0, 45);
  const heroRecentAggression = 0.42 * (1 - recentConfidence) + (targetStats?.recentAggression ?? 0.42) * recentConfidence;
  const heroPressure = clamp(heroAggression * 0.40 + heroStreetAggression * 0.38 + heroRecentAggression * 0.22);
  const generalFoldRate = targetStats
    ? posteriorRate(targetStats.foldedToPostflopBets, targetStats.facedPostflopBets, 0.42, 14)
    : 0.42;
  const heroFoldRate = targetStats && view.street === "river"
    ? posteriorRate(targetStats.foldedToRiverBets, targetStats.facedRiverBets, generalFoldRate, 12)
    : generalFoldRate;
  const heroRiverStabRate = targetStats
    ? posteriorRate(targetStats.riverStabs, targetStats.riverStabOpportunities, 0.42, 12)
    : 0.42;
  const adaptationScale = difficulty === "expert" ? 1 : difficulty === "standard" ? 0.48 : 0.12;
  const aggressionConfidence = Math.max(sampleConfidence(overallSamples), sampleConfidence(streetSamples, 24));
  const foldConfidence = sampleConfidence(view.street === "river" ? targetStats?.facedRiverBets ?? 0 : targetStats?.facedPostflopBets ?? 0, 24);
  const stabConfidence = sampleConfidence(targetStats?.riverStabOpportunities ?? 0, 22);
  const currentStreetActions = view.actionLog.filter((action) => action.street === view.street);
  const checkedEarlier = currentStreetActions.some((action) => action.playerId === actor.id && action.type === "check");
  const latestAggressiveAction = [...currentStreetActions].reverse().find((action) => ["bet", "raise", "all-in"].includes(action.type));
  const heroIsCurrentBettor = latestAggressiveAction?.playerId === targetOpponentId;
  const heroLateAggression = view.actionLog.filter((action) => action.playerId === targetOpponentId
    && (action.street === "turn" || action.street === "river")
    && ["bet", "raise", "all-in"].includes(action.type)).length;
  const antiBluffAdjustment = Math.max(-0.10, Math.min(0.15,
    (heroPressure - 0.42) * personality.adaptability * 0.32 * adaptationScale * aggressionConfidence
      + Math.max(0, heroLateAggression - 1) * 0.018 * adaptationScale,
  ));
  const checkDefenseBoost = view.street === "river" && checkedEarlier && heroIsCurrentBettor
    ? Math.max(0, (heroRiverStabRate - 0.38) * 0.62 * personality.adaptability * adaptationScale * stabConfidence)
    : 0;
  const foldExploitMultiplier = clamp(
    1 + (heroFoldRate - 0.42) * personality.adaptability * 1.65 * adaptationScale * foldConfidence,
    0.74,
    1.34,
  );
  const linePlan = buildBotLinePlan(view, personality);
  const bluffProfile = lateStreetBluffProfile(view, analysis, opponents);
  const streetBluffBoost = view.street === "river" ? 1.24 : view.street === "turn" ? 1.08 : 0.82;
  const bluffWindow = clamp(
    boardBluffQuality(view) * personality.bluff * (0.48 + personality.aggression * 0.44) * streetBluffBoost
      + bluffProfile.quality * personality.bluff * 0.42,
  );
  const candidates: DecisionCandidate[] = [];
  const stackToPot = actor.stack / Math.max(view.bigBlind, pot);
  const relativeTier = analysis.handProfile.relativeTier;
  const strong = strongTier(relativeTier) || equity > 0.62 - personality.looseness * 0.06;
  const lateStreet = view.street === "turn" || view.street === "river";
  const thinValue = lateStreet
    && relativeTier === "medium"
    && equity >= 0.48
    && analysis.rangeResponse.worseHandsContinue >= 0.34
    && heroFoldRate <= 0.46;
  const valueBet = strong || thinValue;
  const premium = relativeTier === "nuts" || relativeTier === "near-nuts"
    || equity > 0.79 + (1 - personality.risk) * 0.04;
  const polarized = premium || (lateStreet && bluffProfile.credible);
  const target = makeBetTarget(view, personality, equity, polarized);
  const targetCost = Math.max(0, target - actor.committedStreet);
  const targetSizeFraction = targetCost / Math.max(1, pot);
  const balancedBluffShare = clamp(targetSizeFraction / Math.max(1, 1 + targetSizeFraction * 2), 0.12, 0.43);
  const sizingBalanceMultiplier = clamp(balancedBluffShare / 0.30, 0.62, 1.36);
  const bluffCatchMargin = lateStreet && relativeTier === "bluff-catcher"
    ? (difficulty === "expert" ? 0.045 : difficulty === "standard" ? 0.022 : 0) + checkDefenseBoost
    : checkDefenseBoost * 0.45;
  const profitableCall = equity + personality.calling * 0.055 + antiBluffAdjustment + bluffCatchMargin >= potOdds;

  if (legal.toCall === 0) {
    if (legal.canCheck) {
      const riverValueMix = view.street === "river" && strong
        ? difficulty === "expert" ? 0.16 + personality.trapping * 0.08 : difficulty === "standard" ? 0.08 : 0
        : 0;
      const checkWeight = strong
        ? 0.28 + linePlan.trap + riverValueMix
        : bluffProfile.credible ? 0.66 + (1 - linePlan.pressure) * 0.24 : 1.05;
      addCandidate(candidates, { type: "check" }, strong ? "控池 / trap" : bluffProfile.credible ? "保留部分弱牌过牌" : "免费看牌", checkWeight);
    }
    if (legal.canBet || legal.canRaise) {
      const type = legal.canBet ? "bet" : "raise";
      const riverBluffMix = view.street === "river" && difficulty === "expert" ? 1.20
        : view.street === "river" && difficulty === "standard" ? 1.10 : 1;
      const balancedBluffWeight = (bluffProfile.credible
        ? (0.28 + personality.bluff * 0.72) * bluffProfile.quality * (difficulty === "expert" ? 1.08 : difficulty === "standard" ? 1 : 0.82)
        : bluffWindow * 0.30) * linePlan.coherentBluffMultiplier * foldExploitMultiplier * sizingBalanceMultiplier * riverBluffMix;
      const betLabel = valueBet ? thinValue ? "薄价值下注" : "极化价值下注" : bluffProfile.credible ? `${bluffProfile.label}极化诈唬` : "低频有条件诈唬";
      const betWeight = valueBet ? thinValue ? 0.42 + personality.aggression * 0.48 : 0.72 + personality.aggression : balancedBluffWeight;
      const mixRiverSizing = view.street === "river"
        && (valueBet || bluffProfile.credible)
        && difficulty !== "casual";
      if (mixRiverSizing) {
        const alternateShare = difficulty === "expert" ? 0.28 : 0.18;
        const mixedFraction = 0.58 + personality.sizing * 0.22;
        const mixedChips = Math.max(view.bigBlind, Math.round(pot * mixedFraction));
        const mixedBase = view.currentBet === 0 ? mixedChips : view.currentBet + Math.max(view.minRaise, mixedChips);
        const mixedTarget = Math.max(
          view.currentBet === 0 ? legal.minBetTo : legal.minRaiseTo,
          Math.min(legal.maxTo, mixedBase),
        );
        addCandidate(candidates, { type, amount: target }, betLabel, betWeight * (1 - alternateShare));
        addCandidate(candidates, { type, amount: mixedTarget }, betLabel, betWeight * alternateShare);
      } else {
        addCandidate(candidates, { type, amount: target }, betLabel, betWeight);
      }    }
  } else {
    if (legal.canFold) {
      const foldWeight = (profitableCall ? 0.08 + (1 - personality.risk) * 0.10 : 0.92 + (1 - personality.calling) * 0.42) * Math.max(0.46, 1 - checkDefenseBoost * 2.4);
      addCandidate(candidates, { type: "fold" }, "放弃负收益跟注", foldWeight);
    }
    if (legal.canCall) {
      const callWeight = profitableCall
        ? 0.72 + personality.calling * 0.65 + personality.trapping * (premium ? 0.45 : 0) + Math.max(0, antiBluffAdjustment) * 2.2 + checkDefenseBoost * 3.4
        : 0.08 + personality.calling * 0.18 + checkDefenseBoost * 1.8;
      addCandidate(candidates, { type: "call" }, premium && personality.trapping > 0.55 ? "慢打隐藏牌力" : relativeTier === "bluff-catcher" ? "按频率抓诈唬" : "实现权益", callWeight);
    }
    if (legal.canRaise) {
      const bluffRaise = !strong && bluffProfile.credible
        && (view.street === "river" ? bluffProfile.nutBlocker || bluffProfile.missedDraw : analysis.handProfile.drawClass !== "none");
      if (strong || bluffRaise) {
        const raiseWeight = strong
          ? 0.50 + personality.aggression * 0.78 - personality.trapping * (premium ? 0.34 : 0) + (checkedEarlier ? linePlan.trap * 0.42 : 0)
          : (0.10 + personality.bluff * 0.30) * bluffProfile.quality * linePlan.coherentBluffMultiplier * foldExploitMultiplier * sizingBalanceMultiplier * (view.street === "river" && difficulty === "expert" ? 1.15 : 1);
        addCandidate(candidates, { type: "raise", amount: target }, strong ? "价值加注" : `${bluffProfile.label}极化诈唬加注`, raiseWeight);
      }
    }
  }

  const shortAllInCall = legal.maxTo <= view.currentBet;
  const strongDraw = ["combo-draw", "nut-flush-draw", "open-ended"].includes(analysis.handProfile.drawClass);
  const lowSprCommitment = stackToPot <= 0.78 && (strong || profitableCall || strongDraw);
  const valueJam = premium && stackToPot <= 2.1;
  const jamCost = Math.max(0, legal.maxTo - actor.committedStreet);
  const jamSizeFraction = jamCost / Math.max(1, pot);
  const jamBluffShare = clamp(jamSizeFraction / Math.max(1, 1 + jamSizeFraction * 2), 0.12, 0.45);
  const jamBalanceMultiplier = clamp(jamBluffShare / 0.30, 0.62, 1.42);
  const polarBluffJam = view.street === "river"
    && opponents === 1
    && bluffProfile.credible
    && (bluffProfile.nutBlocker || bluffProfile.missedDraw)
    && (linePlan.carriedAggression || linePlan.polarization >= 0.58)
    && stackToPot <= 1.55
    && legal.toCall <= pot * 0.55;
  const allInIsNatural = legal.canAllIn && (shortAllInCall || lowSprCommitment || valueJam || polarBluffJam);
  if (allInIsNatural) {
    const allInLabel = valueJam ? "极化价值推注"
      : polarBluffJam ? `${bluffProfile.label}极化诈唬推注`
        : shortAllInCall ? "短码 all-in 跟注" : "低 SPR 权益推注";
    const allInWeight = valueJam ? 0.58 + personality.risk * 0.42
      : polarBluffJam ? (0.18 + personality.bluff * 0.42) * bluffProfile.quality * linePlan.coherentBluffMultiplier * foldExploitMultiplier * jamBalanceMultiplier * (difficulty === "expert" ? 1.24 : difficulty === "standard" ? 1 : 0.70)
        : shortAllInCall ? 0.70 + personality.calling * 0.30
          : 0.18 + personality.risk * 0.25;
    addCandidate(candidates, { type: "all-in" }, allInLabel, allInWeight);
  }
  const strategicLines = analysis.candidates
    .filter((line, index) => index === 0 || line.verdict === "close")
    .slice(0, difficulty === "expert" ? 3 : difficulty === "standard" ? 2 : 1);
  const searchBestScore = strategicLines[0]?.score ?? 0;
  const searchTemperature = Math.max(view.bigBlind, pot * 0.12);
  for (const [index, line] of strategicLines.entries()) {
    const scoreWeight = Math.exp(-(searchBestScore - line.score) / searchTemperature);
    const baseSearchWeight = (difficulty === "expert" ? 0.72 : difficulty === "standard" ? 0.52 : 0.24) * (index === 0 ? 1 : 0.72);
    const mixedRangeDiscount = bluffProfile.credible && !strong && ["bet", "raise", "all-in"].includes(line.action)
      ? difficulty === "expert" ? 0.68 : difficulty === "standard" ? 0.76 : 0.88
      : 1;
    const responseRisk = line.raiseBack && !strong ? clamp(1 - line.raiseBack * 0.85, 0.55, 1) : 1;
    addCandidate(
      candidates,
      { type: line.action, amount: line.target },
      index === 0 ? "range-EV lead" : "range-EV mixed line",
      baseSearchWeight * scoreWeight * mixedRangeDiscount * responseRisk,
    );
  }

  if (candidates.length === 0) {
    if (legal.canCheck) addCandidate(candidates, { type: "check" }, "默认过牌", 1);
    else if (legal.canCall) addCandidate(candidates, { type: "call" }, "默认跟注", 1);
    else addCandidate(candidates, { type: "fold" }, "默认弃牌", 1);
  }

  const bestScore = analysis.candidates[0]?.score ?? 0;
  const temperature = Math.max(view.bigBlind, pot * (difficulty === "expert" ? 0.24 : difficulty === "standard" ? 0.48 : 0.9));
  for (const candidate of candidates) {
    const matchingLines = analysis.candidates.filter((line) => line.action === candidate.action.type);
    const line = matchingLines.sort((left, right) => {
      const leftGap = Math.abs((left.target ?? 0) - (candidate.action.amount ?? 0));
      const rightGap = Math.abs((right.target ?? 0) - (candidate.action.amount ?? 0));
      return leftGap - rightGap;
    })[0];
    const evMultiplier = line
      ? 0.12 + Math.exp(-(bestScore - line.score) / temperature)
      : difficulty === "expert" ? 0.12 : difficulty === "standard" ? 0.34 : 0.68;
    const balancedBluff = candidate.label.includes("极化诈唬");
    const sizeMix = candidate.action.type === "all-in" ? jamBalanceMultiplier : sizingBalanceMultiplier;
    const rationalMixFloor = balancedBluff
      ? bluffProfile.quality * sizeMix * (difficulty === "expert" ? 0.58 : difficulty === "standard" ? 0.48 : 0.34)
      : 0;
    candidate.weight *= Math.max(evMultiplier, rationalMixFloor);
  }

  const normalized = normalizeCandidates(candidates);
  const chosenIndex = rng.weightedIndex(normalized.map((candidate) => candidate.weight));
  const chosen = normalized[chosenIndex];

  const trace: DecisionTrace = {
    summary: `${analysis.handProfile.madeLabel} · ${analysis.handProfile.relativeLabel}；具体组合范围权益 ${(equity * 100).toFixed(0)}%，底池赔率 ${(potOdds * 100).toFixed(0)}%。预计对手弃/跟/反加 ${(analysis.rangeResponse.foldShare * 100).toFixed(0)}/${(analysis.rangeResponse.callShare * 100).toFixed(0)}/${(analysis.rangeResponse.raiseBack * 100).toFixed(0)}%；本手线路压力 ${(linePlan.pressure * 100).toFixed(0)}%。`,
    candidates: normalized,
  };
  return { action: chosen.action, trace };
}

export function driftBotsForNextHand(state: FullGameState, seed: string): FullGameState {
  const next = structuredClone(state);
  for (const seat of next.seats) {
    if (seat.personality) seat.personality = driftPersonality(seat.personality, `${seed}-${seat.id}`);
  }
  return next;
}
