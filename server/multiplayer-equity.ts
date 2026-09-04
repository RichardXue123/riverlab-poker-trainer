import { createDeck, withoutCards, RANK_SYMBOL } from "../lib/poker/cards";
import { compareScores, evaluateSeven } from "../lib/poker/evaluator";
import type { Card } from "../lib/poker/types";
import type { GodModeEquityItem } from "./multiplayer-types";

export interface ContenderInput {
  playerId: string;
  playerName: string;
  seatIndex: number;
  holeCards: Card[];
  isFolded: boolean;
}

function preflopHandDescription(cards: Card[]): string {
  if (cards.length !== 2) return "未知手牌";
  const [c1, c2] = cards;
  const r1 = RANK_SYMBOL[c1.rank];
  const r2 = RANK_SYMBOL[c2.rank];
  if (c1.rank === c2.rank) {
    return `口袋对 ${r1}`;
  }
  const suited = c1.suit === c2.suit ? "同花" : "杂色";
  const high = c1.rank > c2.rank ? `${r1}${r2}` : `${r2}${r1}`;
  return `${suited} ${high}`;
}

export function calculateGodModeEquities(
  contenders: ContenderInput[],
  community: Card[],
  iterations = 1000,
): GodModeEquityItem[] {
  const result: GodModeEquityItem[] = contenders.map((c) => ({
    playerId: c.playerId,
    playerName: c.playerName,
    seatIndex: c.seatIndex,
    equity: 0,
    equityFormatted: "0.0%",
    handName: c.isFolded ? "已弃牌" : preflopHandDescription(c.holeCards),
    holeCards: c.holeCards,
    isFolded: c.isFolded,
  }));

  const active = contenders.filter((c) => !c.isFolded && c.holeCards.length === 2);
  if (active.length === 0) return result;

  // Single active player remaining (everyone else folded)
  if (active.length === 1) {
    const single = result.find((item) => item.playerId === active[0].playerId);
    if (single) {
      single.equity = 1;
      single.equityFormatted = "100.0%";
      if (community.length >= 3) {
        single.handName = evaluateSeven([...single.holeCards, ...community]).name;
      }
    }
    return result;
  }

  // Update current made hand labels if board has cards
  for (const item of result) {
    if (!item.isFolded && item.holeCards.length === 2) {
      if (community.length >= 3) {
        item.handName = evaluateSeven([...item.holeCards, ...community]).name;
      }
    }
  }

  // Strictly exclude all cards dealt to ANY player (both active and folded)
  // as well as all current board cards so folded cards never reappear.
  const allDealtCards = contenders.flatMap((c) => c.holeCards);
  const knownCards: Card[] = [...community, ...allDealtCards];
  const stubDeck = withoutCards(createDeck(), knownCards);
  const wins: Record<string, number> = {};
  for (const c of active) wins[c.playerId] = 0;

  function finalizeEquities(total: number) {
    for (const item of result) {
      if (item.isFolded) {
        item.equity = 0;
        item.equityFormatted = "0.0%";
      } else if (wins[item.playerId] !== undefined && total > 0) {
        const raw = wins[item.playerId] / total;
        item.equity = Math.round(raw * 1000) / 1000;
        item.equityFormatted = `${(item.equity * 100).toFixed(1)}%`;
      } else {
        item.equity = 0;
        item.equityFormatted = "0.0%";
      }
    }
  }

  // Case 1: River or complete (5 board cards) -> exact evaluation
  if (community.length >= 5) {
    const scores = active.map((c) => ({
      playerId: c.playerId,
      score: evaluateSeven([...c.holeCards, ...community.slice(0, 5)]),
    }));
    scores.sort((a, b) => compareScores(b.score, a.score));
    const bestScore = scores[0].score;
    const tied = scores.filter((s) => compareScores(s.score, bestScore) === 0);
    const splitEquity = 1 / tied.length;
    for (const t of tied) {
      wins[t.playerId] = splitEquity;
    }
    finalizeEquities(1);
    return result;
  }

  // Case 2: Turn (4 board cards) -> 1 card to come, exact loop over remaining stub deck
  if (community.length === 4) {
    const boardFour = community.slice(0, 4);
    let totalOutcomes = 0;
    for (let i = 0; i < stubDeck.length; i += 1) {
      const riverCard = stubDeck[i];
      const fullBoard = [...boardFour, riverCard];
      const scores = active.map((c) => ({
        playerId: c.playerId,
        score: evaluateSeven([...c.holeCards, ...fullBoard]),
      }));
      scores.sort((a, b) => compareScores(b.score, a.score));
      const best = scores[0].score;
      const tied = scores.filter((s) => compareScores(s.score, best) === 0);
      const share = 1 / tied.length;
      for (const t of tied) {
        wins[t.playerId] += share;
      }
      totalOutcomes += 1;
    }
    finalizeEquities(totalOutcomes);
    return result;
  }

  // Case 3: Flop (3 board cards) -> 2 cards to come (~800 pairs), exact loop over stub deck
  if (community.length === 3) {
    const boardThree = community.slice(0, 3);
    let totalOutcomes = 0;
    for (let i = 0; i < stubDeck.length; i += 1) {
      for (let j = i + 1; j < stubDeck.length; j += 1) {
        const fullBoard = [...boardThree, stubDeck[i], stubDeck[j]];
        const scores = active.map((c) => ({
          playerId: c.playerId,
          score: evaluateSeven([...c.holeCards, ...fullBoard]),
        }));
        scores.sort((a, b) => compareScores(b.score, a.score));
        const best = scores[0].score;
        const tied = scores.filter((s) => compareScores(s.score, best) === 0);
        const share = 1 / tied.length;
        for (const t of tied) {
          wins[t.playerId] += share;
        }
        totalOutcomes += 1;
      }
    }
    finalizeEquities(totalOutcomes);
    return result;
  }

  // Case 4: Preflop (0 board cards) -> Monte Carlo simulation with fast sample
  const totalIterations = Math.max(100, iterations);
  const stubLength = stubDeck.length;
  const cardsNeeded = 5 - community.length;

  for (let it = 0; it < totalIterations; it += 1) {
    const sample = [...stubDeck];
    for (let i = 0; i < cardsNeeded; i += 1) {
      const swapIndex = i + Math.floor(Math.random() * (stubLength - i));
      const temp = sample[i];
      sample[i] = sample[swapIndex];
      sample[swapIndex] = temp;
    }
    const drawnBoard = sample.slice(0, cardsNeeded);
    const fullBoard = [...community, ...drawnBoard];

    const scores = active.map((c) => ({
      playerId: c.playerId,
      score: evaluateSeven([...c.holeCards, ...fullBoard]),
    }));
    scores.sort((a, b) => compareScores(b.score, a.score));
    const best = scores[0].score;
    const tied = scores.filter((s) => compareScores(s.score, best) === 0);
    const share = 1 / tied.length;
    for (const t of tied) {
      wins[t.playerId] += share;
    }
  }

  finalizeEquities(totalIterations);
  return result;
}
