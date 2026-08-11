import type { Card, Rank, Suit } from "./types";
import { SeededRng } from "./rng";

export const SUITS: Suit[] = ["s", "h", "d", "c"];
export const RANKS: Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

export const SUIT_SYMBOL: Record<Suit, string> = {
  s: "\u2660",
  h: "\u2665",
  d: "\u2666",
  c: "\u2663",
};

export const RANK_SYMBOL: Record<Rank, string> = {
  2: "2",
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  10: "T",
  11: "J",
  12: "Q",
  13: "K",
  14: "A",
};

export function createDeck(): Card[] {
  return SUITS.flatMap((suit) =>
    RANKS.map((rank) => ({
      rank,
      suit,
      id: `${RANK_SYMBOL[rank]}${suit}`,
    })),
  );
}

export function shuffledDeck(seed: string): Card[] {
  return new SeededRng(seed).shuffle(createDeck());
}

export function cardLabel(card: Card): string {
  return `${RANK_SYMBOL[card.rank]}${SUIT_SYMBOL[card.suit]}`;
}

export function cardsLabel(cards: Card[]): string {
  return cards.map(cardLabel).join(" ");
}

export function parseCard(value: string): Card {
  const trimmed = value.trim();
  const suit = trimmed.slice(-1).toLowerCase() as Suit;
  const rankText = trimmed.slice(0, -1).toUpperCase();
  const rankMap: Record<string, Rank> = {
    "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
    T: 10, "10": 10, J: 11, Q: 12, K: 13, A: 14,
  };
  const rank = rankMap[rankText];
  if (!rank || !SUITS.includes(suit)) throw new Error(`Invalid card: ${value}`);
  return { rank, suit, id: `${RANK_SYMBOL[rank]}${suit}` };
}

export function withoutCards(deck: Card[], known: Card[]): Card[] {
  const ids = new Set(known.map((card) => card.id));
  return deck.filter((card) => !ids.has(card.id));
}
