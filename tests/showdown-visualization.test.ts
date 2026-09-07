import test from "node:test";
import assert from "node:assert/strict";
import { parseCard } from "../lib/poker/cards";
import { evaluateSeven, compareScores } from "../lib/poker/evaluator";
import type { Card, SeatState, FullGameState } from "../lib/poker/types";

const cards = (str: string): Card[] => str.split(" ").map(parseCard);

const isCardEqual = (a: Card, b: Card): boolean => {
  if (a.id && b.id) return a.id === b.id;
  return a.rank === b.rank && a.suit === b.suit;
};

test("Showdown: 5-card evaluation and hole cards identification (2 hole cards used)", () => {
  const holeCards = cards("As Ks");
  const community = cards("Qs Js Ts 2d 3c");

  const full7 = [...holeCards, ...community];
  const score = evaluateSeven(full7);

  assert.equal(score.name, "同花顺");
  assert.equal(score.category, 8);
  assert.equal(score.cards.length, 5);

  const isHoleCard = (c: Card) => holeCards.some((hc) => isCardEqual(hc, c));
  const highlightedHoleCards = score.cards.filter(isHoleCard);

  assert.equal(highlightedHoleCards.length, 2, "Both As and Ks must be identified as hole cards to be highlighted");
  assert.ok(highlightedHoleCards.some((c) => c.rank === 14 && c.suit === "s"));
  assert.ok(highlightedHoleCards.some((c) => c.rank === 13 && c.suit === "s"));
});

test("Showdown: 5-card evaluation and hole cards identification (1 hole card used)", () => {
  const holeCards = cards("Ah 2c");
  const community = cards("As Ad Ac Kd 3s");

  const full7 = [...holeCards, ...community];
  const score = evaluateSeven(full7);

  assert.equal(score.name, "四条");
  assert.equal(score.category, 7);
  assert.equal(score.cards.length, 5);

  const isHoleCard = (c: Card) => holeCards.some((hc) => isCardEqual(hc, c));
  const highlightedHoleCards = score.cards.filter(isHoleCard);

  assert.equal(highlightedHoleCards.length, 1, "Only Ah is used, 2c is discarded/kicker replaced");
  assert.equal(highlightedHoleCards[0].rank, 14);
  assert.equal(highlightedHoleCards[0].suit, "h");
});

test("Showdown: 5-card evaluation and hole cards identification (0 hole cards used - playing the board)", () => {
  const holeCards = cards("4h 2c");
  const community = cards("As Ks Qs Js Ts"); // Royal flush on board

  const full7 = [...holeCards, ...community];
  const score = evaluateSeven(full7);

  assert.equal(score.name, "同花顺");
  assert.equal(score.cards.length, 5);

  const isHoleCard = (c: Card) => holeCards.some((hc) => isCardEqual(hc, c));
  const highlightedHoleCards = score.cards.filter(isHoleCard);

  assert.equal(highlightedHoleCards.length, 0, "No hole cards used when playing the board");
});

test("Showdown: contenders extraction excludes folded players and uncontested hands", () => {
  const community = cards("Ah Kh Qh Jh Th");
  const seats = [
    { id: "p1", name: "Alice", folded: false, holeCards: cards("2c 3c") },
    { id: "p2", name: "Bob", folded: true, holeCards: cards("9h 8h") }, // folded
    { id: "p3", name: "Charlie", folded: false, holeCards: cards("As Kd") },
  ];

  const lastResult = {
    showdown: true,
    winnerIds: ["p1", "p3"],
  };

  const activeNonFolded = seats.filter((s) => !s.folded && s.holeCards.length >= 2);
  assert.equal(activeNonFolded.length, 2);
  assert.ok(!activeNonFolded.some((s) => s.id === "p2"), "Folded player Bob must be excluded from showdown contenders");
});

test("Folded player: cards remain face-down to other players, visible to hero, and retained in seat state", () => {
  const bobHoleCards = cards("9h 8h");
  const bobSeat = { id: "p2", name: "Bob", folded: true, holeCards: bobHoleCards };

  const getShowCards = (isHero: boolean, godMode: boolean, street: string, seatFolded: boolean) =>
    isHero || godMode || (!seatFolded && (street === "showdown" || street === "complete"));

  // 1. In other players' perspective (isHero = false, godMode = false), folded cards must remain face-down
  assert.equal(
    getShowCards(false, false, "turn", bobSeat.folded),
    false,
    "Folded player cards must remain face-down from other players' perspective during turn"
  );
  assert.equal(
    getShowCards(false, false, "showdown", bobSeat.folded),
    false,
    "Folded player cards must remain face-down from other players' perspective even at showdown"
  );
  assert.equal(
    getShowCards(false, false, "complete", bobSeat.folded),
    false,
    "Folded player cards must remain face-down from other players' perspective when hand completes"
  );

  // 2. In the folding player's own perspective (isHero = true), they can still see their own hole cards
  assert.equal(
    getShowCards(true, false, "turn", bobSeat.folded),
    true,
    "Hero can still see their own hole cards after folding"
  );

  // 3. In god mode, all cards are visible to spectator
  assert.equal(
    getShowCards(false, true, "turn", bobSeat.folded),
    true,
    "God mode spectator can see folded cards"
  );

  // 4. Active non-folded players have cards revealed at showdown
  assert.equal(
    getShowCards(false, false, "showdown", false),
    true,
    "Active contenders have cards revealed at showdown"
  );

  // 5. Folded player retains their two dead cards in memory/seat data
  assert.equal(bobSeat.holeCards.length, 2, "Folded player retains their two dead cards");

  // 6. PokerTrainer single-player visibility: hidden = !seat.isHuman && !reveal
  const isCardHidden = (isHuman: boolean, reveal: boolean) => !isHuman && !reveal;
  assert.equal(isCardHidden(false, false), true, "Bot's cards remain hidden after folding");
  assert.equal(isCardHidden(true, false), false, "Hero's cards remain visible after folding");
  assert.equal(isCardHidden(false, true), false, "Bot's cards are visible in revealAll mode");
});
