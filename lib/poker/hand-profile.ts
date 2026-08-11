import { createDeck, RANKS, withoutCards } from "./cards";
import { compareScores, evaluateSeven, preflopStrength } from "./evaluator";
import type {
  Card,
  DrawClass,
  MadeHandClass,
  RelativeHandProfile,
  RelativeTier,
  Suit,
} from "./types";

const MADE_LABELS: Record<MadeHandClass, string> = {
  "preflop-premium": "翻前顶级牌",
  "preflop-strong": "翻前强牌",
  "preflop-speculative": "翻前可玩牌",
  "preflop-weak": "翻前弱牌",
  "straight-flush": "同花顺",
  quads: "四条",
  "full-house": "葫芦",
  flush: "同花",
  straight: "顺子",
  set: "暗三条（set）",
  trips: "明三条（trips）",
  "two-pair": "两对",
  overpair: "超对（overpair）",
  "top-pair-top-kicker": "顶对顶踢脚（TPTK）",
  "top-pair": "顶对",
  "weak-top-pair": "弱顶对",
  "middle-pair": "中对",
  "bottom-pair": "底对",
  underpair: "小口袋对（underpair）",
  "board-pair": "公共牌对子",
  "high-card": "高牌／空气牌",
};

const TIER_LABELS: Record<RelativeTier, string> = {
  nuts: "坚果牌（nuts，当前理论最强）",
  "near-nuts": "近坚果牌（near-nuts）",
  strong: "强价值牌",
  medium: "中等摊牌价值",
  "bluff-catcher": "抓诈唬牌（bluff-catcher）",
  weak: "弱牌／诈唬候选",
};

const DRAW_LABELS: Record<DrawClass, string> = {
  none: "没有主要听牌",
  "backdoor-flush": "后门同花听牌（需要连续两张同花色）",
  gutshot: "卡顺听牌（gutshot，通常 4 张直接补牌）",
  "open-ended": "开放式顺子听牌（OESD，通常 8 张直接补牌）",
  "nut-flush-draw": "坚果同花听牌（成花后通常是最大同花）",
  "non-nut-flush-draw": "非坚果同花听牌（成花后仍可能被更大同花压制）",
  "combo-draw": "组合听牌（同时具有同花与顺子潜力）",
};

const rankCache = new Map<string, { nutRank: number; better: number }>();

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function hasStraight(ranks: number[]): boolean {
  const unique = [...new Set(ranks)].sort((a, b) => b - a);
  if (unique.includes(14)) unique.push(1);
  for (let index = 0; index <= unique.length - 5; index += 1) {
    if (unique[index] - unique[index + 4] === 4) return true;
  }
  return false;
}

function highestRankNotOnBoard(board: Card[], suit: Suit): number {
  const occupied = new Set(board.filter((card) => card.suit === suit).map((card) => card.rank));
  return [...RANKS].sort((a, b) => b - a).find((rank) => !occupied.has(rank)) ?? 14;
}

export function classifyDraw(holeCards: Card[], community: Card[]): {
  drawClass: DrawClass;
  drawLabel: string;
  nutPotential: boolean;
} {
  if (holeCards.length !== 2 || community.length < 3 || community.length >= 5) {
    return { drawClass: "none", drawLabel: DRAW_LABELS.none, nutPotential: false };
  }
  const all = [...holeCards, ...community];
  const current = evaluateSeven(all);
  const suitCounts = new Map<Suit, number>();
  for (const card of all) suitCounts.set(card.suit, (suitCounts.get(card.suit) ?? 0) + 1);
  const flushSuit = [...suitCounts.entries()].find(([suit, count]) => count === 4 && holeCards.some((card) => card.suit === suit))?.[0];
  const hasMadeFlush = current.category >= 5;
  const flushDraw = Boolean(flushSuit) && !hasMadeFlush;
  const nutFlushDraw = flushSuit
    ? holeCards.some((card) => card.suit === flushSuit && card.rank === highestRankNotOnBoard(community, flushSuit))
    : false;

  const ranks = all.map((card) => card.rank);
  const completionRanks = current.category < 4
    ? RANKS.filter((rank) => !ranks.includes(rank) && hasStraight([...ranks, rank]))
    : [];
  const straightDraw = completionRanks.length >= 2 ? "open-ended" : completionRanks.length === 1 ? "gutshot" : undefined;

  if (flushDraw && straightDraw) {
    return { drawClass: "combo-draw", drawLabel: DRAW_LABELS["combo-draw"], nutPotential: nutFlushDraw || completionRanks.some((rank) => rank >= 12) };
  }
  if (flushDraw) {
    const drawClass: DrawClass = nutFlushDraw ? "nut-flush-draw" : "non-nut-flush-draw";
    return { drawClass, drawLabel: DRAW_LABELS[drawClass], nutPotential: nutFlushDraw };
  }
  if (straightDraw) {
    return { drawClass: straightDraw, drawLabel: DRAW_LABELS[straightDraw], nutPotential: completionRanks.some((rank) => rank >= 12) };
  }

  if (community.length === 3) {
    const backdoor = [...suitCounts.entries()].some(([suit, count]) => count === 3 && holeCards.some((card) => card.suit === suit));
    if (backdoor) return { drawClass: "backdoor-flush", drawLabel: DRAW_LABELS["backdoor-flush"], nutPotential: false };
  }
  return { drawClass: "none", drawLabel: DRAW_LABELS.none, nutPotential: false };
}

function theoreticalRank(holeCards: Card[], community: Card[]): { nutRank: number; better: number } {
  const key = `${holeCards.map((card) => card.id).sort().join("-")}|${community.map((card) => card.id).join("-")}`;
  const cached = rankCache.get(key);
  if (cached) return cached;
  const heroScore = evaluateSeven([...holeCards, ...community]);
  const deck = withoutCards(createDeck(), [...holeCards, ...community]);
  let better = 0;
  let tied = 0;
  let total = 0;
  for (let first = 0; first < deck.length - 1; first += 1) {
    for (let second = first + 1; second < deck.length; second += 1) {
      const opponent = evaluateSeven([deck[first], deck[second], ...community]);
      const comparison = compareScores(opponent, heroScore);
      if (comparison > 0) better += 1;
      else if (comparison === 0) tied += 1;
      total += 1;
    }
  }
  const value = { nutRank: total > 0 ? (total - better - tied * 0.5) / total : 0, better };
  if (rankCache.size > 240) rankCache.clear();
  rankCache.set(key, value);
  return value;
}

function classifyMadeHand(holeCards: Card[], community: Card[]): MadeHandClass {
  const score = evaluateSeven([...holeCards, ...community]);
  if (score.category === 8) return "straight-flush";
  if (score.category === 7) return "quads";
  if (score.category === 6) return "full-house";
  if (score.category === 5) return "flush";
  if (score.category === 4) return "straight";
  if (score.category === 3) {
    const pocketPair = holeCards[0].rank === holeCards[1].rank;
    const boardContainsPocketRank = community.some((card) => card.rank === holeCards[0].rank);
    return pocketPair && boardContainsPocketRank ? "set" : "trips";
  }
  if (score.category === 2) return "two-pair";
  if (score.category !== 1) return "high-card";

  const boardRanks = [...new Set(community.map((card) => card.rank))].sort((a, b) => b - a);
  const topBoard = boardRanks[0];
  const pairRank = score.kickers[0];
  const pocketPair = holeCards[0].rank === holeCards[1].rank;
  if (pocketPair) {
    if (holeCards[0].rank > topBoard) return "overpair";
    if (holeCards[0].rank < topBoard) return "underpair";
  }
  const matchingHole = holeCards.find((card) => card.rank === pairRank);
  if (!matchingHole) return "board-pair";
  if (pairRank === topBoard) {
    const kicker = holeCards.find((card) => card.id !== matchingHole.id)?.rank ?? 0;
    const bestKicker = [...RANKS].sort((a, b) => b - a).find((rank) => rank !== topBoard && !community.some((card) => card.rank === rank)) ?? 14;
    if (kicker === bestKicker) return "top-pair-top-kicker";
    return kicker >= 10 ? "top-pair" : "weak-top-pair";
  }
  if (pairRank === boardRanks[1]) return "middle-pair";
  if (pairRank === boardRanks[boardRanks.length - 1]) return "bottom-pair";
  return "middle-pair";
}

function vulnerabilityFor(madeClass: MadeHandClass, community: Card[]): number {
  const base: Partial<Record<MadeHandClass, number>> = {
    "straight-flush": 0.01,
    quads: 0.02,
    "full-house": 0.06,
    flush: 0.22,
    straight: 0.34,
    set: 0.30,
    trips: 0.34,
    "two-pair": 0.43,
    overpair: 0.55,
    "top-pair-top-kicker": 0.58,
    "top-pair": 0.65,
    "weak-top-pair": 0.70,
    "middle-pair": 0.72,
    "bottom-pair": 0.74,
    underpair: 0.76,
    "board-pair": 0.80,
    "high-card": 0.88,
  };
  const suitCounts = new Map<Suit, number>();
  for (const card of community) suitCounts.set(card.suit, (suitCounts.get(card.suit) ?? 0) + 1);
  const maxSuit = Math.max(...suitCounts.values());
  const ranks = [...new Set(community.map((card) => card.rank))].sort((a, b) => a - b);
  const connected = ranks.some((rank, index) => index > 0 && rank - ranks[index - 1] <= 2);
  return clamp((base[madeClass] ?? 0.5) + (maxSuit >= 2 ? 0.07 : 0) + (connected ? 0.07 : 0) - (community.length === 5 ? 0.22 : 0));
}

function blockerNotes(holeCards: Card[], community: Card[]): string[] {
  const notes: string[] = [];
  const boardSuits = new Map<Suit, number>();
  for (const card of community) boardSuits.set(card.suit, (boardSuits.get(card.suit) ?? 0) + 1);
  for (const [suit, count] of boardSuits) {
    if (count >= 3 && holeCards.some((card) => card.suit === suit && card.rank === highestRankNotOnBoard(community, suit))) {
      notes.push("坚果同花阻断牌：你占住了对手最大同花需要的关键牌");
    }
  }
  if (holeCards.some((card) => card.rank === 14)) notes.push("A 阻断牌：减少对手持有强 Ax 组合的数量");
  return notes;
}

export function classifyRelativeHand(holeCards: Card[], community: Card[]): RelativeHandProfile {
  if (holeCards.length !== 2) throw new Error("Relative hand analysis requires two hole cards");
  if (community.length < 3) {
    const strength = preflopStrength(holeCards);
    const madeClass: MadeHandClass = strength >= 0.8 ? "preflop-premium" : strength >= 0.62 ? "preflop-strong" : strength >= 0.38 ? "preflop-speculative" : "preflop-weak";
    const relativeTier: RelativeTier = strength >= 0.8 ? "strong" : strength >= 0.5 ? "medium" : "weak";
    const blockers = holeCards.some((card) => card.rank === 14) ? ["A 阻断牌：降低对手持有 AA、AK 和 AQ 的组合数"] : [];
    return {
      madeClass,
      madeLabel: MADE_LABELS[madeClass],
      relativeTier,
      relativeLabel: TIER_LABELS[relativeTier],
      absoluteName: "翻前起手牌",
      drawClass: "none",
      drawLabel: "翻前尚未形成听牌",
      nutRank: strength,
      showdownStrength: strength,
      vulnerability: 0.5,
      bluffCatcher: false,
      nutPotential: strength >= 0.8,
      blockers,
      explanation: `这手牌的翻前结构评分约为 ${Math.round(strength * 100)}%，仍需结合位置和前方行动决定是否入池。`,
    };
  }

  const score = evaluateSeven([...holeCards, ...community]);
  const madeClass = classifyMadeHand(holeCards, community);
  const rank = theoreticalRank(holeCards, community);
  const draw = classifyDraw(holeCards, community);
  let relativeTier: RelativeTier = rank.better === 0 ? "nuts" : rank.nutRank >= 0.96 ? "near-nuts" : rank.nutRank >= 0.74 ? "strong" : rank.nutRank >= 0.48 ? "medium" : "weak";
  const pairLike = ["top-pair", "weak-top-pair", "middle-pair", "bottom-pair", "underpair", "board-pair"].includes(madeClass);
  const bluffCatcher = pairLike && relativeTier !== "strong" && draw.drawClass === "none";
  if (bluffCatcher) relativeTier = "bluff-catcher";
  const vulnerability = vulnerabilityFor(madeClass, community);
  return {
    madeClass,
    madeLabel: MADE_LABELS[madeClass],
    relativeTier,
    relativeLabel: TIER_LABELS[relativeTier],
    absoluteName: score.name,
    drawClass: draw.drawClass,
    drawLabel: draw.drawLabel,
    nutRank: rank.nutRank,
    showdownStrength: rank.nutRank,
    vulnerability,
    bluffCatcher,
    nutPotential: draw.nutPotential || relativeTier === "nuts" || relativeTier === "near-nuts",
    blockers: blockerNotes(holeCards, community),
    explanation: `${MADE_LABELS[madeClass]}在当前所有合法两张牌组合中的即时排名约为前 ${Math.max(1, Math.round((1 - rank.nutRank) * 100))}%；相对定位是${TIER_LABELS[relativeTier]}。`,
  };
}