import assert from "node:assert/strict";
import test from "node:test";
import { createDeck, parseCard, shuffledDeck } from "../lib/poker/cards";
import { calculateGodModeEquities } from "../server/multiplayer-equity";

const c = (str: string) => str.split(/\s+/).map(parseCard);

test("德州扑克规则：一副牌包含52张唯一点数花色，新开局独立洗牌", () => {
  const deck1 = createDeck();
  assert.equal(deck1.length, 52, "标准扑克一副牌必须为 52 张");
  const uniqueCards1 = new Set(deck1.map((card) => card.id));
  assert.equal(uniqueCards1.size, 52, "52 张牌绝无重复");

  const shuffled1 = shuffledDeck("test-seed-1");
  const shuffled2 = shuffledDeck("test-seed-2");
  assert.equal(shuffled1.length, 52);
  assert.equal(shuffled2.length, 52);
  assert.notDeepEqual(shuffled1.map((k) => k.id), shuffled2.map((k) => k.id));
});

test("calculates god-mode equity accurately on river (showdown)", () => {
  const contenders = [
    { playerId: "p1", playerName: "Player 1", seatIndex: 0, holeCards: c("Ah Kh"), isFolded: false },
    { playerId: "p2", playerName: "Player 2", seatIndex: 1, holeCards: c("Qd Qs"), isFolded: false },
    { playerId: "p3", playerName: "Player 3", seatIndex: 2, holeCards: c("Jc Tc"), isFolded: false },
    { playerId: "p4", playerName: "Player 4", seatIndex: 3, holeCards: c("7s 8s"), isFolded: true },
  ];

  // River board: As 7c 2d 2h Kd -> p1 has two pair As and Ks with Kh kicker
  const community = c("As 7c 2d 2h Kd");
  const equities = calculateGodModeEquities(contenders, community);

  assert.equal(equities.length, 4);
  const p1 = equities.find((e) => e.playerId === "p1")!;
  const p2 = equities.find((e) => e.playerId === "p2")!;
  const p3 = equities.find((e) => e.playerId === "p3")!;
  const p4 = equities.find((e) => e.playerId === "p4")!;

  assert.equal(p1.equity, 1);
  assert.equal(p1.equityFormatted, "100.0%");
  assert.equal(p2.equity, 0);
  assert.equal(p2.equityFormatted, "0.0%");
  assert.equal(p3.equity, 0);
  assert.equal(p3.equityFormatted, "0.0%");
  assert.equal(p4.equity, 0);
  assert.equal(p4.equityFormatted, "0.0%");
  assert.equal(p4.handName, "已弃牌");
  assert.equal(p1.handName, "两对");
});

test("excludes folded cards from stub deck so discarded cards never appear on turn or river", () => {
  // Scenario:
  // p1 holds A-A (Ah As)
  // p2 holds K-K (Kh Ks)
  // p3 FOLDED preflop holding the other two Kings (Kd Kc)!
  // Turn board: 2c 3d 7h 8s (rainbow, no flush draw, no straight possible for kings)
  // Because p3 folded holding Kd and Kc, there are ZERO remaining Kings in the deck.
  // Thus, p2 has 0 outs to hit a set or quads on the river!
  // p1 MUST have 100.0% equity on the turn!
  const contenders = [
    { playerId: "p1", playerName: "Player 1", seatIndex: 0, holeCards: c("Ah As"), isFolded: false },
    { playerId: "p2", playerName: "Player 2", seatIndex: 1, holeCards: c("Kh Ks"), isFolded: false },
    { playerId: "p3", playerName: "Player 3", seatIndex: 2, holeCards: c("Kd Kc"), isFolded: true },
  ];

  const turnBoard = c("2c 3d 7h 8s");
  const turnEquities = calculateGodModeEquities(contenders, turnBoard);

  const p1 = turnEquities.find((e) => e.playerId === "p1")!;
  const p2 = turnEquities.find((e) => e.playerId === "p2")!;
  const p3 = turnEquities.find((e) => e.playerId === "p3")!;

  assert.equal(p3.isFolded, true);
  assert.equal(p3.equity, 0);
  assert.equal(p3.equityFormatted, "0.0%");

  // If p3's folded cards (Kd, Kc) were incorrectly left in the deck, p2 would have ~4.5% equity (2/44).
  // Because folded cards are strictly excluded from the remaining stub deck, p2 has 0 outs and 0.0% equity!
  assert.equal(p2.equity, 0, "p2 has zero outs because other Kings are in the folded player's hand");
  assert.equal(p2.equityFormatted, "0.0%");
  assert.equal(p1.equity, 1, "p1 locks up 100% equity on turn");
  assert.equal(p1.equityFormatted, "100.0%");
});

test("calculates god-mode equity on turn and flop summing to ~1", () => {
  const contenders = [
    { playerId: "p1", playerName: "Player 1", seatIndex: 0, holeCards: c("Ah As"), isFolded: false },
    { playerId: "p2", playerName: "Player 2", seatIndex: 1, holeCards: c("Kd Ks"), isFolded: false },
    { playerId: "p3", playerName: "Player 3", seatIndex: 2, holeCards: c("Qc Qd"), isFolded: false },
    { playerId: "p4", playerName: "Player 4", seatIndex: 3, holeCards: c("Jc Js"), isFolded: false },
  ];

  // Flop: 2c 3d 7h
  const flopCommunity = c("2c 3d 7h");
  const flopEquities = calculateGodModeEquities(contenders, flopCommunity);

  const activeSum = flopEquities.reduce((sum, e) => sum + e.equity, 0);
  assert.ok(Math.abs(activeSum - 1) < 0.05, `Active equity sum ${activeSum} should be ~1.0`);

  // AA should have the highest equity
  const aa = flopEquities.find((e) => e.playerId === "p1")!;
  const kk = flopEquities.find((e) => e.playerId === "p2")!;
  assert.ok(aa.equity > kk.equity, "AA should have higher equity than KK on dry board");

  for (const eq of flopEquities) {
    assert.match(eq.equityFormatted || "", /^\d+\.\d%$/, "Equity formatted string should match e.g. 45.2%");
  }
});

test("single survivor gets 100% equity", () => {
  const contenders = [
    { playerId: "p1", playerName: "Player 1", seatIndex: 0, holeCards: c("2h 7d"), isFolded: false },
    { playerId: "p2", playerName: "Player 2", seatIndex: 1, holeCards: c("Ah Kh"), isFolded: true },
    { playerId: "p3", playerName: "Player 3", seatIndex: 2, holeCards: c("Qh Qd"), isFolded: true },
  ];
  const equities = calculateGodModeEquities(contenders, c("As Ks Qs"));
  const p1 = equities.find((e) => e.playerId === "p1")!;
  assert.equal(p1.equity, 1);
  assert.equal(p1.equityFormatted, "100.0%");
});
