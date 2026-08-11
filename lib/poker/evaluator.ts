import { createDeck, withoutCards } from "./cards";
import { SeededRng } from "./rng";
import type { Card } from "./types";

export interface HandScore {
  category: number;
  kickers: number[];
  name: string;
  cards: Card[];
}

const CATEGORY_NAMES = ["高牌", "一对", "两对", "三条", "顺子", "同花", "葫芦", "四条", "同花顺"];

function straightHigh(ranks: number[]): number | null {
  const unique = [...new Set(ranks)].sort((a, b) => b - a);
  if (unique.includes(14)) unique.push(1);
  for (let index = 0; index <= unique.length - 5; index += 1) {
    if (unique[index] - unique[index + 4] === 4) return unique[index];
  }
  return null;
}

export function evaluateFive(cards: Card[]): HandScore {
  if (cards.length !== 5) throw new Error("evaluateFive requires exactly five cards");
  const ranks = cards.map((card) => card.rank).sort((a, b) => b - a);
  const counts = new Map<number, number>();
  for (const rank of ranks) counts.set(rank, (counts.get(rank) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = cards.every((card) => card.suit === cards[0].suit);
  const straight = straightHigh(ranks);

  let category = 0;
  let kickers: number[] = [...ranks];
  if (flush && straight) {
    category = 8;
    kickers = [straight];
  } else if (groups[0][1] === 4) {
    category = 7;
    kickers = [groups[0][0], groups[1][0]];
  } else if (groups[0][1] === 3 && groups[1]?.[1] === 2) {
    category = 6;
    kickers = [groups[0][0], groups[1][0]];
  } else if (flush) {
    category = 5;
  } else if (straight) {
    category = 4;
    kickers = [straight];
  } else if (groups[0][1] === 3) {
    category = 3;
    kickers = [groups[0][0], ...groups.filter((group) => group[1] === 1).map((group) => group[0]).sort((a, b) => b - a)];
  } else if (groups[0][1] === 2 && groups[1]?.[1] === 2) {
    category = 2;
    const pairs = groups.filter((group) => group[1] === 2).map((group) => group[0]).sort((a, b) => b - a);
    const kicker = groups.find((group) => group[1] === 1)?.[0] ?? 0;
    kickers = [pairs[0], pairs[1], kicker];
  } else if (groups[0][1] === 2) {
    category = 1;
    kickers = [groups[0][0], ...groups.filter((group) => group[1] === 1).map((group) => group[0]).sort((a, b) => b - a)];
  }

  return { category, kickers, name: CATEGORY_NAMES[category], cards };
}

export function compareScores(left: HandScore, right: HandScore): number {
  if (left.category !== right.category) return left.category - right.category;
  const length = Math.max(left.kickers.length, right.kickers.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left.kickers[index] ?? 0) - (right.kickers[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function evaluateSeven(cards: Card[]): HandScore {
  if (cards.length < 5 || cards.length > 7) throw new Error("evaluateSeven requires five to seven cards");
  let best: HandScore | undefined;
  for (let a = 0; a < cards.length - 4; a += 1) {
    for (let b = a + 1; b < cards.length - 3; b += 1) {
      for (let c = b + 1; c < cards.length - 2; c += 1) {
        for (let d = c + 1; d < cards.length - 1; d += 1) {
          for (let e = d + 1; e < cards.length; e += 1) {
            const score = evaluateFive([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (!best || compareScores(score, best) > 0) best = score;
          }
        }
      }
    }
  }
  if (!best) throw new Error("Could not evaluate hand");
  return best;
}

export function estimateEquity(
  heroCards: Card[],
  community: Card[],
  opponentCount: number,
  iterations: number,
  seed: string,
): number {
  if (heroCards.length !== 2 || opponentCount < 1) return 0;
  const known = [...heroCards, ...community];
  const remaining = withoutCards(createDeck(), known);
  const rng = new SeededRng(seed);
  let equity = 0;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = rng.shuffle(remaining);
    let cursor = 0;
    const opponents: Card[][] = [];
    for (let opponent = 0; opponent < opponentCount; opponent += 1) {
      opponents.push([sample[cursor], sample[cursor + 1]]);
      cursor += 2;
    }
    const board = [...community];
    while (board.length < 5) {
      board.push(sample[cursor]);
      cursor += 1;
    }
    const heroScore = evaluateSeven([...heroCards, ...board]);
    const opponentScores = opponents.map((cards) => evaluateSeven([...cards, ...board]));
    const better = opponentScores.filter((score) => compareScores(score, heroScore) > 0).length;
    if (better > 0) continue;
    const ties = opponentScores.filter((score) => compareScores(score, heroScore) === 0).length;
    equity += 1 / (ties + 1);
  }

  return equity / Math.max(1, iterations);
}

export function countImprovementOuts(heroCards: Card[], community: Card[]): number {
  if (community.length < 3 || community.length >= 5) return 0;
  const known = [...heroCards, ...community];
  const current = evaluateSeven(known);
  return withoutCards(createDeck(), known).filter((card) => {
    const next = evaluateSeven([...known, card]);
    return compareScores(next, current) > 0;
  }).length;
}

export function preflopStrength(cards: Card[]): number {
  if (cards.length !== 2) return 0;
  const [first, second] = [...cards].sort((a, b) => b.rank - a.rank);
  const high = first.rank / 14;
  const low = second.rank / 14;
  const pairBonus = first.rank === second.rank ? 0.32 + first.rank / 70 : 0;
  const suitedBonus = first.suit === second.suit ? 0.055 : 0;
  const gap = Math.abs(first.rank - second.rank);
  const connectorBonus = gap === 1 ? 0.055 : gap === 2 ? 0.025 : 0;
  const broadwayBonus = first.rank >= 11 && second.rank >= 10 ? 0.07 : 0;
  const weakGapPenalty = gap >= 5 ? 0.08 : 0;
  return Math.max(0.05, Math.min(0.98, high * 0.43 + low * 0.24 + pairBonus + suitedBonus + connectorBonus + broadwayBonus - weakGapPenalty));
}

export function madeHandName(heroCards: Card[], community: Card[]): string {
  const cards = [...heroCards, ...community];
  if (cards.length < 5) return "未成牌";
  return evaluateSeven(cards).name;
}
