import assert from "node:assert/strict";
import test from "node:test";
import { parseCard } from "../lib/poker/cards";
import { calculateGodModeEquities } from "../server/multiplayer-equity";

const c = (str: string) => str.split(/\s+/).map(parseCard);

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
  assert.equal(p2.equity, 0);
  assert.equal(p3.equity, 0);
  assert.equal(p4.equity, 0);
  assert.equal(p4.handName, "已弃牌");
  assert.equal(p1.handName, "两对");
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
});
