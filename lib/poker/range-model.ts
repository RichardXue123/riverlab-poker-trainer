import { createDeck, withoutCards } from "./cards";
import { compareScores, evaluateSeven, preflopStrength } from "./evaluator";
import { classifyDraw } from "./hand-profile";
import type { Card, GameAction, PlayerViewState, PublicSeatState, Street } from "./types";

export interface BayesianRangeCombo {
  cards: [Card, Card];
  weight: number;
  strength: number;
  tierScore: number;
  drawScore: number;
  blockerScore: number;
  madeCategory: number;
  madeLabel: string;
  showdownComparison: number;
}

type RangeModelView = Pick<PlayerViewState, "holeCards" | "community" | "actionLog" | "bigBlind">;

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function boardAtStreet(community: Card[], street: Street): Card[] {
  if (street === "flop") return community.slice(0, 3);
  if (street === "turn") return community.slice(0, 4);
  if (street === "river" || street === "showdown" || street === "complete") return community.slice(0, 5);
  return [];
}

function suitedConnectorBonus(cards: [Card, Card]): number {
  const suited = cards[0].suit === cards[1].suit ? 0.06 : 0;
  const gap = Math.abs(cards[0].rank - cards[1].rank);
  const connected = gap <= 1 ? 0.07 : gap === 2 ? 0.035 : 0;
  return suited + connected;
}

function raisesBefore(view: RangeModelView, action: GameAction): number {
  return view.actionLog.filter((entry) => entry.street === "preflop"
    && entry.index < action.index
    && ["raise", "all-in"].includes(entry.type)).length;
}

function preflopActionLikelihood(
  view: RangeModelView,
  cards: [Card, Card],
  action: GameAction,
  strength: number,
): number {
  if (action.type === "check") return 0.96;
  if (action.type === "call") {
    const middle = Math.exp(-Math.pow((strength - 0.50) / 0.25, 2));
    const trap = strength >= 0.78 ? 0.18 : 0;
    return clamp(0.05 + middle * 0.70 + trap + suitedConnectorBonus(cards), 0.025, 0.96);
  }
  if (["raise", "all-in"].includes(action.type)) {
    const depth = raisesBefore(view, action);
    const threshold = depth >= 2 ? 0.77 : depth === 1 ? 0.64 : 0.42;
    const sizePressure = clamp(action.amount / Math.max(view.bigBlind, action.potBefore), 0, 5) * 0.018;
    const value = sigmoid((strength - threshold - sizePressure) / 0.075);
    const suitedBluff = depth <= 1 ? suitedConnectorBonus(cards) * (depth === 1 ? 0.72 : 1) : 0;
    return clamp(0.018 + value * 0.91 + suitedBluff, 0.012, 0.985);
  }
  return 1;
}


const DRAW_SCORE = {
  "combo-draw": 0.92,
  "nut-flush-draw": 0.82,
  "open-ended": 0.68,
  "non-nut-flush-draw": 0.61,
  gutshot: 0.38,
  "backdoor-flush": 0.16,
  none: 0,
} as const;

type PostflopFeatures = {
  tierScore: number;
  drawScore: number;
  blockerScore: number;
  madeCategory: number;
  madeLabel: string;
  score: ReturnType<typeof evaluateSeven>;
};

const featureCache = new Map<string, PostflopFeatures>();

function postflopFeatures(cards: [Card, Card], board: Card[]): PostflopFeatures {
  const key = `${cards.map((card) => card.id).sort().join("-")}|${board.map((card) => card.id).join("-")}`;
  const cached = featureCache.get(key);
  if (cached) return cached;
  const score = evaluateSeven([...cards, ...board]);
  const draw = classifyDraw(cards, board);
  const categoryBase = [0.10, 0.40, 0.58, 0.69, 0.78, 0.86, 0.93, 0.97, 1][score.category] ?? 0.1;
  const kickerCredit = (score.kickers[0] ?? 0) / 14 * (score.category <= 2 ? 0.08 : 0.025);
  const tierScore = clamp(categoryBase + kickerCredit);
  const drawScore = DRAW_SCORE[draw.drawClass];
  const boardSuitCounts = new Map<string, number>();
  for (const card of board) boardSuitCounts.set(card.suit, (boardSuitCounts.get(card.suit) ?? 0) + 1);
  const blocksFlush = cards.some((card) => card.rank === 14 && (boardSuitCounts.get(card.suit) ?? 0) >= 2);
  const blocksTopPair = cards.some((card) => card.rank === Math.max(...board.map((item) => item.rank)));
  const blockerScore = draw.nutPotential ? 1 : blocksFlush ? 0.82 : cards.some((card) => card.rank === 14) ? 0.58 : blocksTopPair ? 0.36 : 0;
  const value = { tierScore, drawScore, blockerScore, madeCategory: score.category, madeLabel: score.name, score };
  if (featureCache.size > 6000) featureCache.clear();
  featureCache.set(key, value);
  return value;
}

function postflopActionLikelihood(cards: [Card, Card], board: Card[], action: GameAction) {
  const features = postflopFeatures(cards, board);
  const { tierScore, drawScore, blockerScore } = features;
  const sizeFraction = clamp(action.amount / Math.max(1, action.potBefore), 0, 3);
  const polarization = clamp((sizeFraction - 0.34) / 1.16);

  if (action.type === "check") {
    const weakOrMedium = 0.76 - tierScore * 0.28;
    const trap = tierScore >= 0.78 ? 0.20 + tierScore * 0.20 : 0;
    const missedOpportunity = drawScore > 0.55 ? -0.10 : 0;
    return { likelihood: clamp(weakOrMedium + trap + missedOpportunity, 0.08, 0.94), ...features };
  }
  if (action.type === "call") {
    const bluffCatcher = 0.72 - Math.abs(tierScore - 0.48) * 0.88;
    const drawContinue = drawScore * 0.48;
    const slowplay = tierScore >= 0.90 ? 0.24 : 0;
    const pricePenalty = Math.max(0, sizeFraction - 0.70) * 0.14;
    return { likelihood: clamp(0.04 + bluffCatcher + drawContinue + slowplay - pricePenalty, 0.025, 0.97), ...features };
  }
  if (["bet", "raise", "all-in"].includes(action.type)) {
    const value = Math.pow(tierScore, action.type === "all-in" ? 2.0 : 1.55) * (0.68 + polarization * 0.27);
    const semiBluff = drawScore * (0.36 + (1 - polarization) * 0.28);
    const polarBluff = (1 - tierScore) * blockerScore * (0.12 + polarization * 0.42);
    const thinValue = Math.max(0, 1 - Math.abs(tierScore - 0.56) / 0.24) * (1 - polarization) * 0.27;
    const raiseTightening = action.type === "raise" ? 0.88 : 1;
    return { likelihood: clamp((0.018 + value + semiBluff + polarBluff + thinValue) * raiseTightening, 0.012, 0.99), ...features };
  }
  return { likelihood: 1, ...features };
}

/**
 * Builds a concrete combo distribution using only cards and actions visible to
 * the viewer. Every public action updates the prior with an action likelihood.
 */
export function buildBayesianRange(
  view: RangeModelView,
  seat: PublicSeatState,
  inferredWidth: number,
): BayesianRangeCombo[] {
  const known = [...view.holeCards, ...view.community];
  const deck = withoutCards(createDeck(), known);
  const actions = view.actionLog.filter((action) => action.playerId === seat.id && !action.type.includes("blind"));
  const heroScore = view.community.length >= 3 ? evaluateSeven([...view.holeCards, ...view.community]) : undefined;
  const combos: BayesianRangeCombo[] = [];

  for (let first = 0; first < deck.length - 1; first += 1) {
    for (let second = first + 1; second < deck.length; second += 1) {
      const cards: [Card, Card] = [deck[first], deck[second]];
      const strength = preflopStrength(cards);
      const selectivity = 1 - clamp(inferredWidth, 0.03, 0.82);
      let weight = 0.025 + Math.pow(strength, 1.15 + selectivity * 2.35) * 0.975;
      let tierScore = strength;
      let drawScore = 0;
      let blockerScore = 0;
      let madeCategory = -1;
      let madeLabel = "翻前牌";
      let showdownComparison = 0;

      for (const action of actions) {
        if (action.street === "preflop") {
          weight *= preflopActionLikelihood(view, cards, action, strength);
        } else {
          const board = boardAtStreet(view.community, action.street);
          if (board.length < 3) continue;
          const update = postflopActionLikelihood(cards, board, action);
          weight *= update.likelihood;
          tierScore = update.tierScore;
          drawScore = update.drawScore;
          blockerScore = update.blockerScore;
        }
      }

      if (view.community.length >= 3) {
        const current = postflopFeatures(cards, view.community);
        tierScore = current.tierScore;
        drawScore = current.drawScore;
        blockerScore = current.blockerScore;
        madeCategory = current.madeCategory;
        madeLabel = current.madeLabel;
        showdownComparison = compareScores(current.score, heroScore!);
      }
      combos.push({ cards, strength, weight: Math.max(0.00001, weight), tierScore, drawScore, blockerScore, madeCategory, madeLabel, showdownComparison });
    }
  }

  combos.sort((left, right) => right.weight - left.weight);
  const retain = Math.max(96, Math.min(560, Math.ceil(110 + clamp(inferredWidth, 0.03, 0.82) * 610)));
  const selected = combos.slice(0, retain);
  const total = selected.reduce((sum, combo) => sum + combo.weight, 0) || 1;
  for (const combo of selected) combo.weight /= total;
  return selected;
}