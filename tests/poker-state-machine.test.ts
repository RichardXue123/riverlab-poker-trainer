import test from "node:test";
import assert from "node:assert/strict";
import { createTable, getLegalActions, startHand } from "../lib/poker/engine";
import { CardPoolManager, PokerStateMachine } from "../lib/poker/state-machine";
import { makeSeed } from "../lib/poker/rng";
import { EMPTY_STATS } from "../lib/poker/types";
import type { FullGameState, SeatState } from "../lib/poker/types";

function createFourSeatTable(): FullGameState {
  const seats: SeatState[] = [
    {
      id: "p1",
      name: "玩家1",
      isHuman: true,
      stack: 1000,
      holeCards: [],
      folded: false,
      allIn: false,
      committedStreet: 0,
      committedHand: 0,
      acted: false,
      raiseLocked: false,
      stats: structuredClone(EMPTY_STATS),
    },
    {
      id: "p2",
      name: "玩家2",
      isHuman: true,
      stack: 1000,
      holeCards: [],
      folded: false,
      allIn: false,
      committedStreet: 0,
      committedHand: 0,
      acted: false,
      raiseLocked: false,
      stats: structuredClone(EMPTY_STATS),
    },
    {
      id: "p3",
      name: "玩家3",
      isHuman: true,
      stack: 1000,
      holeCards: [],
      folded: false,
      allIn: false,
      committedStreet: 0,
      committedHand: 0,
      acted: false,
      raiseLocked: false,
      stats: structuredClone(EMPTY_STATS),
    },
    {
      id: "p4",
      name: "玩家4",
      isHuman: true,
      stack: 1000,
      holeCards: [],
      folded: false,
      allIn: false,
      committedStreet: 0,
      committedHand: 0,
      acted: false,
      raiseLocked: false,
      stats: structuredClone(EMPTY_STATS),
    },
  ];

  return createTable({
    smallBlind: 5,
    bigBlind: 10,
    difficulty: "standard",
    seats,
  });
}

test("PokerStateMachine: triggers lifecycle hooks in exact chronological order", () => {
  const table = createFourSeatTable();
  const events: string[] = [];

  const sm = new PokerStateMachine(table, {
    beforeHandStart: () => events.push("beforeHandStart"),
    afterHoleDealt: (state) => events.push(`afterHoleDealt:${state.seats.filter((s) => s.holeCards.length === 2).length}`),
    onTurnStart: (_state, activeIndex) => events.push(`onTurnStart:${activeIndex}`),
    beforeAction: (_state, action) => events.push(`beforeAction:${action.type}`),
    afterAction: (_state, action) => events.push(`afterAction:${action.type}`),
    afterStreetDeal: (_state, street) => events.push(`afterStreetDeal:${street}`),
    afterSettlement: () => events.push("afterSettlement"),
  });

  assert.equal(sm.getPhase(), "idle");

  // 1. Start hand
  sm.startHand("test-seed-hooks");
  assert.equal(sm.getPhase(), "betting_round");
  assert.ok(events.includes("beforeHandStart"));
  assert.ok(events.includes("afterHoleDealt:4"));
  assert.ok(events.some((e) => e.startsWith("onTurnStart:")));

  // 2. Drive folding around to BB to test early settlement hook
  // Active players sequentially fold until 1 remains
  while (sm.getState().status === "playing") {
    sm.applyAction({ type: "fold" });
  }

  assert.equal(sm.getPhase(), "hand_complete");
  assert.ok(events.includes("afterSettlement"));
});

test("PokerStateMachine: Action Modifier can restrict folding (干扰技能：不能弃牌)", () => {
  const table = createFourSeatTable();
  const sm = new PokerStateMachine(table);
  sm.startHand("test-seed-cannot-fold");

  const activeIdx = sm.getState().activeIndex;
  const activePlayerId = sm.getState().seats[activeIdx].id;

  // Normal legal actions: facing big blind, can fold
  const normalLegal = sm.getLegalActions(activePlayerId);
  assert.equal(normalLegal.canFold, true);

  // Apply modifier: cannotFold = true
  sm.addSeatModifier(activePlayerId, { cannotFold: true });

  const restrictedLegal = sm.getLegalActions(activePlayerId);
  assert.equal(restrictedLegal.canFold, false, "canFold must be filtered out by seat modifier");

  // Attempting to fold must throw error
  assert.throws(() => {
    sm.applyAction({ type: "fold" });
  }, /不可弃牌/);

  // Call or Raise should work normally
  assert.doesNotThrow(() => {
    sm.applyAction({ type: "call" });
  });
});

test("CardPoolManager: accurately identifies cards in play vs cards in remaining deck", () => {
  const table = createFourSeatTable();
  const state = startHand(table, "test-seed-cardpool");

  // Total 4 players * 2 cards = 8 hole cards dealt
  const inPlay = CardPoolManager.getInPlayCards(state);
  assert.ok(inPlay.length >= 8);

  const heroHoleCard = state.seats[0].holeCards[0];
  assert.equal(CardPoolManager.isCardInPlay(state, heroHoleCard), true);
  assert.equal(CardPoolManager.isCardInPlay(state, heroHoleCard.id), true);

  // The very last card in the deck (index 51) has definitely not been played
  const unseenCard = state.deck[51];
  assert.equal(CardPoolManager.isCardInPlay(state, unseenCard), false);
});

test("CardPoolManager: transforms a card safely when not in play, and prevents duplicates", () => {
  const table = createFourSeatTable();
  const state = startHand(table, "test-seed-transform");

  const hero = state.seats[0];
  const oldHoleCard = hero.holeCards[0];

  // Target card: let's pick the last card in the deck (guaranteed not in play)
  const availableCard = state.deck[50];

  // 1. Trying to transform into a card that IS already in play (e.g. opponent's hole card) must fail!
  const opponentCard = state.seats[1].holeCards[0];
  const failResult = CardPoolManager.transformCard(state, hero.id, 0, {
    rank: opponentCard.rank,
    suit: opponentCard.suit,
  });
  assert.equal(failResult.success, false);
  assert.match(failResult.error!, /已经在场上/);
  assert.equal(hero.holeCards[0].id, oldHoleCard.id, "Original card should be untouched on failure");

  // 2. Transforming into a valid unseen card (e.g. availableCard) must succeed
  const successResult = CardPoolManager.transformCard(state, hero.id, 0, {
    rank: availableCard.rank,
    suit: availableCard.suit,
  });
  assert.equal(successResult.success, true);
  assert.equal(hero.holeCards[0].id, availableCard.id);

  // Verify that the card is now in play, and deck remains 52 unique cards
  assert.equal(CardPoolManager.isCardInPlay(state, availableCard), true);
  const allCardIds = new Set(state.deck.map((c) => c.id));
  assert.equal(allCardIds.size, 52, "Deck must still contain 52 unique cards");
});

test("CardPoolManager: swaps hole cards between two active players atomically", () => {
  const table = createFourSeatTable();
  const state = startHand(table, "test-seed-swap");

  const p1 = state.seats[0];
  const p2 = state.seats[1];

  const p1OriginalCards = [...p1.holeCards.map((c) => c.id)];
  const p2OriginalCards = [...p2.holeCards.map((c) => c.id)];

  const res = CardPoolManager.swapHoleCards(state, p1.id, p2.id);
  assert.equal(res.success, true);

  assert.deepEqual(p1.holeCards.map((c) => c.id), p2OriginalCards);
  assert.deepEqual(p2.holeCards.map((c) => c.id), p1OriginalCards);

  // Trying to swap with folded player must fail
  p2.folded = true;
  const failRes = CardPoolManager.swapHoleCards(state, p1.id, p2.id);
  assert.equal(failRes.success, false);
  assert.match(failRes.error!, /已弃牌/);
});

test("CardPoolManager: peeks upcoming community card without consuming deck index", () => {
  const table = createFourSeatTable();
  const state = startHand(table, "test-seed-peek");

  const deckIndexBefore = state.deckIndex;
  const peeked = CardPoolManager.peekNextCommunityCard(state);

  assert.ok(peeked !== null);
  assert.equal(state.deckIndex, deckIndexBefore, "Peek must not advance deckIndex");
  assert.equal(peeked?.id, state.deck[deckIndexBefore + 1].id);
});
