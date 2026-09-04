import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBotPersonality, createSeatRoster, chooseBotAction } from "../lib/poker/ai";
import { auditAiReadability } from "../lib/poker/ai-audit";
import { createDeck, parseCard, shuffledDeck, SUIT_SYMBOL } from "../lib/poker/cards";
import { buildCoachAdvice } from "../lib/poker/coach";
import { compareScores, evaluateFive, evaluateSeven } from "../lib/poker/evaluator";
import { applyAction, buildBotView, buildPlayerView, createTable, getLegalActions, potSize, settleShowdown, settleUncontested, startHand } from "../lib/poker/engine";
import { classifyRelativeHand } from "../lib/poker/hand-profile";
import { buildBotLinePlan } from "../lib/poker/line-planner";
import { buildBayesianRange } from "../lib/poker/range-model";
import { createDefaultProfile, parseImportedProfile, refillBankroll, updateObservedStats, updateUnlocks } from "../lib/poker/storage";
import { analyzeVisibleDecision } from "../lib/poker/strategy";
import {
  createTournamentState,
  fastForwardTournament,
  recordTournamentHand,
  tournamentBlindsForHand,
  tournamentPlace,
  tournamentPrize,
  TOURNAMENT_PRIZES,
} from "../lib/poker/tournament";
import { EMPTY_STATS } from "../lib/poker/types";
import type { BotPersonality, CareerStats, Difficulty, SeatState } from "../lib/poker/types";
import { evaluatePopulation } from "../training/league";
import { TrainingLogger } from "../training/logger";
import { evolvePopulation, makeCenteredPopulation, makeInitialPopulation, policyDistance } from "../training/policy";
import { promotePolicy } from "../training/promote";
import { playSelfPlayMatch } from "../training/simulator";
import type { SelfPlayTrainingConfig } from "../training/types";

test("renders four distinct poker suit symbols", () => {
  assert.deepEqual(SUIT_SYMBOL, { s: "\u2660", h: "\u2665", d: "\u2666", c: "\u2663" });
  assert.equal(new Set(Object.values(SUIT_SYMBOL)).size, 4);
});

const cards = (values: string) => values.split(/\s+/).map(parseCard);

function seats(stacks: number[], difficulty: Difficulty = "standard"): SeatState[] {
  return stacks.map((stack, index) => ({
    id: index === 0 ? "hero" : `bot-${index}`,
    name: index === 0 ? "你" : `Bot ${index}`,
    isHuman: index === 0,
    stack,
    holeCards: [],
    folded: false,
    allIn: false,
    committedStreet: 0,
    committedHand: 0,
    acted: false,
    raiseLocked: false,
    personality: index === 0 ? undefined : createBotPersonality("test", difficulty, index),
    stats: { ...EMPTY_STATS },
  }));
}

function riverBotView(hole: string, handId: string, facingBet = false) {
  const table = createTable({ smallBlind: 5, bigBlind: 10, difficulty: "expert", seats: createSeatRoster(1000, "expert", handId) });
  const state = startHand(table, handId);
  state.handId = handId;
  state.street = "river";
  state.community = cards("Ks 8s 3s 2d 9h");
  state.currentBet = 0;
  state.minRaise = state.bigBlind;
  state.activeIndex = 1;
  for (const [index, seat] of state.seats.entries()) {
    seat.folded = index > 1;
    seat.allIn = false;
    seat.acted = false;
    seat.raiseLocked = false;
    seat.committedStreet = 0;
    seat.committedHand = index <= 1 ? 300 : 0;
  }
  state.seats[1].stack = 720;
  state.seats[1].holeCards = cards(hole);
  if (facingBet) {
    state.currentBet = 180;
    state.minRaise = 180;
    state.seats[0].committedStreet = 180;
    state.seats[0].committedHand = 390;
    state.seats[1].committedHand = 210;
    state.actionLog.push({
      index: state.actionLog.length,
      playerId: "hero",
      playerName: "你",
      type: "bet",
      amount: 180,
      to: 180,
      street: "river",
      potBefore: 420,
      timestamp: 1,
    });
  }
  return buildBotView(state, state.seats[1].id);
}
test("creates an eight-max roster with all positions and rotates the button", () => {
  const roster = createSeatRoster(1000, "standard", "eight-max");
  assert.equal(roster.length, 8);
  assert.equal(roster.filter((seat) => !seat.isHuman).length, 7);
  assert.equal(new Set(roster.map((seat) => seat.id)).size, 8);
  assert.equal(new Set(roster.map((seat) => seat.name)).size, 8);

  const table = createTable({ smallBlind: 5, bigBlind: 10, difficulty: "standard", seats: roster });
  let state = startHand(table, "eight-max-first");
  const firstButton = state.buttonIndex;
  assert.deepEqual(
    new Set(buildPlayerView(state, "hero").seats.map((seat) => seat.position)),
    new Set(["BTN", "SB", "BB", "UTG", "UTG+1", "LJ", "HJ", "CO"]),
  );
  while (state.status === "playing") {
    const actor = state.seats[state.activeIndex];
    const legal = getLegalActions(state, actor.id);
    state = applyAction(state, legal.canFold ? { type: "fold" } : { type: "check" });
  }
  const next = startHand(state, "eight-max-second");
  assert.equal(next.buttonIndex, (firstButton + 1) % 8);
});

test("evaluates every hand category and wheel straight", () => {
  const examples = [
    ["As Kh Qd Jc 9s", 0],
    ["As Ah Ks Qd Jc", 1],
    ["As Ah Ks Kh Qd", 2],
    ["As Ah Ad Ks Qh", 3],
    ["9s 8h 7d 6c 5s", 4],
    ["As Js 8s 4s 2s", 5],
    ["As Ah Ad Ks Kh", 6],
    ["As Ah Ad Ac Ks", 7],
    ["As Ks Qs Js Ts", 8],
  ] as const;
  for (const [hand, category] of examples) assert.equal(evaluateFive(cards(hand)).category, category, hand);
  const wheel = evaluateFive(cards("As 2h 3d 4c 5s"));
  assert.equal(wheel.category, 4);
  assert.equal(wheel.kickers[0], 5);
  assert.equal(evaluateSeven(cards("As Ah Ad Ks Kh Kd 2c")).category, 6);
});

test("compares kickers and recognizes exact ties", () => {
  const aceKing = evaluateFive(cards("As Ah Kd Qc Js"));
  const aceQueen = evaluateFive(cards("Ad Ac Qd Jc Ts"));
  assert.ok(compareScores(aceKing, aceQueen) > 0);
  assert.equal(compareScores(evaluateFive(cards("As Kh Qd Jc 9s")), evaluateFive(cards("Ah Kd Qc Js 9h"))), 0);
});

test("seeded shuffle is reproducible and contains 52 unique cards", () => {
  const first = shuffledDeck("repeatable").map((card) => card.id);
  const second = shuffledDeck("repeatable").map((card) => card.id);
  const other = shuffledDeck("different").map((card) => card.id);
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, other);
  assert.equal(new Set(first).size, 52);
  assert.equal(createDeck().length, 52);
});

test("folding around awards the blinds without a showdown", () => {
  const table = createTable({ smallBlind: 5, bigBlind: 10, difficulty: "standard", seats: createSeatRoster(1000, "standard", "fold-test") });
  let state = startHand(table, "fold-hand");
  while (state.status === "playing") {
    const actor = state.seats[state.activeIndex];
    if (actor.id === "bot-2") break;
    state = applyAction(state, { type: "fold" });
  }
  assert.equal(state.status, "complete");
  assert.equal(state.lastResult?.showdown, false);
  assert.equal(state.lastResult?.winnerSettlements.length, 1);
  assert.equal(state.lastResult?.winnerSettlements[0].received, 15);
  assert.equal(state.lastResult?.winnerSettlements[0].net, state.lastResult!.winnerSettlements[0].received - state.lastResult!.winnerSettlements[0].contributed);
  assert.equal(state.lastResult?.potTotal, 15);
  assert.equal(state.seats.reduce((sum, seat) => sum + seat.stack, 0), 8000);
});

test("heads-up all-in runs the board and conserves chips", () => {
  const table = createTable({ smallBlind: 5, bigBlind: 10, difficulty: "standard", seats: seats([50, 100]) });
  let state = startHand(table, "heads-up-allin");
  state = applyAction(state, { type: "all-in" });
  state = applyAction(state, { type: "call" });
  assert.equal(state.status, "complete");
  assert.equal(state.community.length, 5);
  assert.equal(state.lastResult?.potTotal, 100);
  assert.equal(state.seats.reduce((sum, seat) => sum + seat.stack, 0), 150);
});

test("a short all-in does not reopen raising but still permits an all-in call", () => {
  const table = createTable({ smallBlind: 5, bigBlind: 10, difficulty: "standard", seats: createSeatRoster(1000, "standard", "short-allin-lock") });
  const state = startHand(table, "short-allin-lock-hand");
  state.activeIndex = 0;
  state.currentBet = 30;
  state.minRaise = 20;
  state.seats[0].committedStreet = 20;
  state.seats[0].committedHand = 20;
  state.seats[0].raiseLocked = true;

  const locked = getLegalActions(state, "hero");
  assert.equal(locked.canCall, true);
  assert.equal(locked.canRaise, false);
  assert.equal(locked.canAllIn, false);
  assert.throws(() => applyAction(state, { type: "all-in" }), /not reopened/);

  state.seats[0].stack = 5;
  const shortCall = getLegalActions(state, "hero");
  assert.equal(shortCall.maxTo, 25);
  assert.equal(shortCall.canAllIn, true);
  assert.doesNotThrow(() => applyAction(state, { type: "all-in" }));
});
test("side pots pay the short stack main pot and deep stack side pot", () => {
  const state = createTable({ smallBlind: 5, bigBlind: 10, difficulty: "standard", seats: seats([0, 0, 0]) });
  state.status = "playing";
  state.buttonIndex = 0;
  state.community = cards("Ac Kd 7h 4s 2c");
  state.seats[0].holeCards = cards("As Ah");
  state.seats[1].holeCards = cards("Ks Kh");
  state.seats[2].holeCards = cards("Qs Qh");
  state.seats[0].committedHand = 50;
  state.seats[1].committedHand = 100;
  state.seats[2].committedHand = 100;
  assert.equal(potSize(state), 250);
  const settled = settleShowdown(structuredClone(state));
  assert.equal(settled.lastResult?.awards.length, 2);
  assert.deepEqual(settled.lastResult?.awards.map((award) => award.amount), [150, 100]);
  assert.equal(settled.seats[0].stack, 150);
  assert.equal(settled.seats[1].stack, 100);
  assert.equal(settled.seats.reduce((sum, seat) => sum + seat.stack, 0), 250);
  assert.deepEqual(settled.lastResult?.winnerSettlements.map(({ playerId, contributed, received, net }) => ({ playerId, contributed, received, net })), [
    { playerId: "hero", contributed: 50, received: 150, net: 100 },
    { playerId: "bot-1", contributed: 100, received: 100, net: 0 },
  ]);
  assert.equal(settled.lastResult?.winnerSettlements.reduce((sum, result) => sum + result.received, 0), 250);
});

test("playerSettlements accurately computes profit and loss for all hand participants in showdown", () => {
  const state = createTable({ smallBlind: 5, bigBlind: 10, difficulty: "standard", seats: seats([0, 0, 0, 0]) });
  state.status = "playing";
  state.buttonIndex = 0;
  state.community = cards("Ac Kd 7h 4s 2c");
  state.seats[0].holeCards = cards("As Ah");
  state.seats[1].holeCards = cards("Ks Kh");
  state.seats[2].holeCards = cards("Qs Qh");
  state.seats[3].holeCards = cards("Js Jh");
  state.seats[3].folded = true;
  state.seats[0].committedHand = 50;
  state.seats[1].committedHand = 100;
  state.seats[2].committedHand = 100;
  state.seats[3].committedHand = 20;
  assert.equal(potSize(state), 270);

  const settled = settleShowdown(structuredClone(state));
  const ps = settled.lastResult?.playerSettlements;
  assert.ok(ps, "playerSettlements should exist");
  assert.equal(ps.length, 4);

  // Winner (Hero) took main pot (50*3 + 20 = 170)
  const heroSettlement = ps.find((p) => p.playerId === "hero");
  assert.ok(heroSettlement);
  assert.equal(heroSettlement.contributed, 50);
  assert.equal(heroSettlement.received, 170);
  assert.equal(heroSettlement.net, 120);
  assert.equal(heroSettlement.isWinner, true);
  assert.equal(heroSettlement.folded, false);

  // Side pot winner (Bot 1) took side pot (50*2 = 100)
  const bot1Settlement = ps.find((p) => p.playerId === "bot-1");
  assert.ok(bot1Settlement);
  assert.equal(bot1Settlement.contributed, 100);
  assert.equal(bot1Settlement.received, 100);
  assert.equal(bot1Settlement.net, 0);
  assert.equal(bot1Settlement.isWinner, true);

  // Loser (Bot 2) lost 100
  const bot2Settlement = ps.find((p) => p.playerId === "bot-2");
  assert.ok(bot2Settlement);
  assert.equal(bot2Settlement.contributed, 100);
  assert.equal(bot2Settlement.received, 0);
  assert.equal(bot2Settlement.net, -100);
  assert.equal(bot2Settlement.isWinner, false);

  // Folded player (Bot 3) lost 20
  const bot3Settlement = ps.find((p) => p.playerId === "bot-3");
  assert.ok(bot3Settlement);
  assert.equal(bot3Settlement.contributed, 20);
  assert.equal(bot3Settlement.received, 0);
  assert.equal(bot3Settlement.net, -20);
  assert.equal(bot3Settlement.isWinner, false);
  assert.equal(bot3Settlement.folded, true);

  // Zero-sum chip conservation: 120 + 0 + (-100) + (-20) === 0
  const totalNet = ps.reduce((sum, p) => sum + p.net, 0);
  assert.equal(totalNet, 0, "Sum of net profit/loss across all participants must be exactly 0");
});

test("playerSettlements accurately computes profit and loss in uncontested win (fold victory)", () => {
  const state = createTable({ smallBlind: 5, bigBlind: 10, difficulty: "standard", seats: seats([500, 500, 500]) });
  state.status = "playing";
  state.buttonIndex = 0;
  state.seats[0].committedHand = 150;
  state.seats[1].committedHand = 80;
  state.seats[1].folded = true;
  state.seats[2].committedHand = 10;
  state.seats[2].folded = true;

  const totalPot = potSize(state);
  assert.equal(totalPot, 240);

  const settled = settleUncontested(structuredClone(state), state.seats[0]);
  const ps = settled.lastResult?.playerSettlements;
  assert.ok(ps, "playerSettlements should exist");
  assert.equal(ps.length, 3);

  // Winner (Hero): received 240, contributed 150 -> net +90
  const heroSettlement = ps.find((p) => p.playerId === "hero");
  assert.ok(heroSettlement);
  assert.equal(heroSettlement.contributed, 150);
  assert.equal(heroSettlement.received, 240);
  assert.equal(heroSettlement.net, 90);
  assert.equal(heroSettlement.isWinner, true);

  // Folded Bot 1: contributed 80, received 0 -> net -80
  const bot1Settlement = ps.find((p) => p.playerId === "bot-1");
  assert.ok(bot1Settlement);
  assert.equal(bot1Settlement.contributed, 80);
  assert.equal(bot1Settlement.received, 0);
  assert.equal(bot1Settlement.net, -80);
  assert.equal(bot1Settlement.isWinner, false);
  assert.equal(bot1Settlement.folded, true);

  // Folded Bot 2: contributed 10, received 0 -> net -10
  const bot2Settlement = ps.find((p) => p.playerId === "bot-2");
  assert.ok(bot2Settlement);
  assert.equal(bot2Settlement.contributed, 10);
  assert.equal(bot2Settlement.received, 0);
  assert.equal(bot2Settlement.net, -10);
  assert.equal(bot2Settlement.isWinner, false);
  assert.equal(bot2Settlement.folded, true);

  // Zero-sum chip conservation: 90 - 80 - 10 === 0
  const totalNet = ps.reduce((sum, p) => sum + p.net, 0);
  assert.equal(totalNet, 0, "Sum of net profit/loss across all participants must be exactly 0");
});

test("tournament hands keep busted seats out and advance blinds", () => {
  const table = createTable({ smallBlind: 5, bigBlind: 10, difficulty: "standard", seats: seats([0, 1_000, 1_000]) });
  const live = startHand(table, "tournament-no-refill", { refillBustedBots: false, requireFundedHuman: false });
  assert.equal(live.seats[0].stack, 0);
  assert.equal(live.seats[0].holeCards.length, 0);
  assert.equal(live.seats[1].holeCards.length, 2);
  assert.deepEqual(tournamentBlindsForHand(1), { smallBlind: 5, bigBlind: 10, level: 1 });
  assert.deepEqual(tournamentBlindsForHand(9), { smallBlind: 10, bigBlind: 20, level: 2 });
  assert.deepEqual(tournamentBlindsForHand(49), { smallBlind: 100, bigBlind: 200, level: 7 });
});

test("tournament records eliminations and awards the requested podium prizes", () => {
  const table = createTable({ smallBlind: 5, bigBlind: 10, difficulty: "standard", seats: seats(Array(8).fill(1_000)) });
  let tournament = createTournamentState(table, "places");
  table.seats[0].stack = 0;
  table.seats[1].stack = 0;
  tournament = recordTournamentHand(tournament, table);
  assert.equal(tournamentPlace(tournament, "hero"), 8);
  assert.equal(tournamentPlace(tournament, "bot-1"), 7);

  for (const seat of table.seats) seat.stack = 0;
  table.seats[7].stack = 8_000;
  tournament = recordTournamentHand(tournament, table);
  assert.equal(tournament.finished, true);
  assert.equal(tournament.standings.length, 8);
  assert.deepEqual(tournament.standings.slice(0, 3).map(({ place, prize }) => ({ place, prize })), [
    { place: 1, prize: TOURNAMENT_PRIZES[1] },
    { place: 2, prize: TOURNAMENT_PRIZES[2] },
    { place: 3, prize: TOURNAMENT_PRIZES[3] },
  ]);
  assert.equal(tournamentPrize(tournament, table.seats[7].id), 5_000);
});

test("tournament fast-forward is seeded, finishes, and conserves all chips", () => {
  const table = createTable({ smallBlind: 5, bigBlind: 10, difficulty: "expert", seats: seats(Array(8).fill(1_000), "expert") });
  table.status = "complete";
  table.street = "complete";
  table.seats[0].stack = 0;
  table.seats[1].stack = 2_000;
  const tournament = recordTournamentHand(createTournamentState(table, "fast-forward"), table);
  const first = fastForwardTournament(table, tournament, "fixed-fast-forward");
  const second = fastForwardTournament(table, tournament, "fixed-fast-forward");
  assert.equal(first.tournament.finished, true);
  assert.equal(first.tournament.standings.length, 8);
  assert.equal(first.tournament.standings[0].place, 1);
  assert.equal(first.table.seats.reduce((sum, seat) => sum + seat.stack, 0), 8_000);
  assert.deepEqual(first.table.seats.map((seat) => seat.stack), second.table.seats.map((seat) => seat.stack));
  assert.deepEqual(first.tournament.standings, second.tournament.standings);
  assert.equal(first.simulatedShowdowns, second.simulatedShowdowns);
});
test("player and bot views cannot access deck or other hole cards", () => {
  const table = createTable({ smallBlind: 5, bigBlind: 10, difficulty: "expert", seats: createSeatRoster(1000, "expert", "privacy") });
  const state = startHand(table, "privacy-hand");
  const player = buildPlayerView(state, "hero");
  const bot = buildBotView(state, state.seats[state.activeIndex].id);
  assert.equal("deck" in player, false);
  assert.equal("deck" in bot, false);
  assert.equal(player.holeCards.length, 2);
  assert.equal(bot.holeCards.length, 2);
  assert.equal(player.seats.some((seat) => "holeCards" in seat), false);
  assert.equal(JSON.stringify(player).includes(state.seats[1].holeCards[0].id), false);
});

test("coach output is unchanged when hidden cards and future deck change", () => {
  const table = createTable({ smallBlind: 5, bigBlind: 10, difficulty: "standard", seats: createSeatRoster(1000, "standard", "coach") });
  const first = startHand(table, "coach-visible");
  const second = structuredClone(first);
  [second.seats[1].holeCards, second.seats[2].holeCards] = [second.seats[2].holeCards, second.seats[1].holeCards];
  second.deck.reverse();
  assert.deepEqual(buildPlayerView(first, "hero"), buildPlayerView(second, "hero"));
  assert.deepEqual(buildCoachAdvice(buildPlayerView(first, "hero")), buildCoachAdvice(buildPlayerView(second, "hero")));
});

test("coach shows beginner guidance and neutral equity ignores betting style", () => {
  const table = createTable({ smallBlind: 5, bigBlind: 10, difficulty: "standard", seats: createSeatRoster(1000, "standard", "neutral-equity") });
  const state = startHand(table, "neutral-equity-hand");
  state.activeIndex = 0;
  const baseView = buildPlayerView(state, "hero");
  const activeOpponent = baseView.seats.find((seat) => seat.id !== "hero" && !seat.folded)!;
  const aggressiveView = structuredClone(baseView);
  aggressiveView.actionLog.push({
    index: aggressiveView.actionLog.length,
    playerId: activeOpponent.id,
    playerName: activeOpponent.name,
    type: "raise",
    amount: 30,
    to: 30,
    street: aggressiveView.street,
    potBefore: 15,
    timestamp: 1,
  });

  const baseAdvice = buildCoachAdvice(baseView);
  const aggressiveAdvice = buildCoachAdvice(aggressiveView);
  assert.equal(baseAdvice.metrics.neutralEquity, aggressiveAdvice.metrics.neutralEquity);
  assert.ok(baseAdvice.metrics.neutralEquity >= 0 && baseAdvice.metrics.neutralEquity <= 1);
  for (const guidance of Object.values(baseAdvice.beginner)) assert.ok(guidance.length > 10);
});
test("bot personalities are reproducible but distinct and avoid irrational deep all-ins", () => {
  assert.deepEqual(createBotPersonality("same", "standard", 2), createBotPersonality("same", "standard", 2));
  assert.notDeepEqual(createBotPersonality("same", "standard", 1), createBotPersonality("same", "standard", 2));
  const table = createTable({ smallBlind: 5, bigBlind: 10, difficulty: "standard", seats: createSeatRoster(1000, "standard", "mix") });
  const state = startHand(table, "mix-hand");
  const actor = state.seats[state.activeIndex];
  assert.equal(actor.isHuman, false);
  const view = buildBotView(state, actor.id);
  const first = chooseBotAction(view, actor.personality!, "standard");
  const second = chooseBotAction(view, actor.personality!, "standard");
  assert.deepEqual(first, second);
  assert.notEqual(first.action.type, "all-in");
  assert.ok(first.trace.candidates.length >= 1);
  assert.ok(Math.abs(first.trace.candidates.reduce((sum, candidate) => sum + candidate.weight, 0) - 1) < 1e-9);
});

test("river AI mixes a missed nut draw into the same polarized line as value", () => {
  const personality: BotPersonality = {
    looseness: 0.42,
    aggression: 0.82,
    bluff: 0.84,
    trapping: 0.34,
    calling: 0.38,
    risk: 0.72,
    sizing: 0.78,
    adaptability: 0.78,
  };
  const chosen = new Set<string>();
  let sawBluffBet = false;
  let sawBluffJam = false;
  let sawValueJam = false;

  for (let index = 0; index < 18; index += 1) {
    const bluffDecision = chooseBotAction(riverBotView("As Qd", `river-bluff-${index}`), personality, "expert");
    chosen.add(bluffDecision.action.type);
    sawBluffBet ||= bluffDecision.trace.candidates.some((candidate) => candidate.action.type === "bet" && candidate.label.includes("极化诈唬"));
    sawBluffJam ||= bluffDecision.trace.candidates.some((candidate) => candidate.action.type === "all-in" && candidate.label.includes("极化诈唬"));

    const valueDecision = chooseBotAction(riverBotView("Qs Js", `river-value-${index}`), personality, "expert");
    sawValueJam ||= valueDecision.trace.candidates.some((candidate) => candidate.action.type === "all-in" && candidate.label.includes("价值"));
  }

  assert.equal(sawBluffBet, true);
  assert.equal(sawBluffJam, true);
  assert.equal(sawValueJam, true);
  assert.ok(chosen.has("check"));
  assert.ok(chosen.has("bet"));
  assert.ok(chosen.has("all-in"));

  const unsupportedAir = chooseBotAction(riverBotView("7c 4d", "river-unsupported-air"), personality, "expert");
  assert.equal(unsupportedAir.trace.candidates.some((candidate) => candidate.action.type === "all-in" && candidate.label.includes("极化诈唬")), false);
});
test("expert AI bluff-catches more often against an over-aggressive player", () => {
  const personality: BotPersonality = {
    looseness: 0.38,
    aggression: 0.62,
    bluff: 0.52,
    trapping: 0.42,
    calling: 0.52,
    risk: 0.55,
    sizing: 0.62,
    adaptability: 0.88,
  };
  const stats = (aggressiveActions: number, passiveActions: number): CareerStats => ({
    ...EMPTY_STATS,
    hands: 50,
    wins: 25,
    vpipHands: 25,
    pfrHands: 18,
    threeBets: 5,
    aggressiveActions,
    passiveActions,
    riverAggressiveActions: aggressiveActions,
    riverPassiveActions: passiveActions,
    recentAggression: aggressiveActions / (aggressiveActions + passiveActions),
    biggestPot: 1000,
  });
  const view = riverBotView("8c 7d", "river-bluff-catch", true);
  const passiveHero = chooseBotAction(view, personality, "expert", stats(10, 40));
  const aggressiveHero = chooseBotAction(view, personality, "expert", stats(40, 10));
  const callWeight = (decision: ReturnType<typeof chooseBotAction>) => decision.trace.candidates.find((candidate) => candidate.action.type === "call")?.weight ?? 0;
  assert.ok(callWeight(aggressiveHero) > callWeight(passiveHero));
});
test("Bayesian combo ranges keep checking traps and add blocker bluffs to aggression", () => {
  const checkView = riverBotView("Qs Js", "bayesian-check");
  const heroSeat = checkView.seats.find((seat) => seat.id === "hero")!;
  checkView.actionLog.push({
    index: checkView.actionLog.length,
    playerId: "hero",
    playerName: "你",
    type: "check",
    amount: 0,
    to: 0,
    street: "river",
    potBefore: 600,
    timestamp: 1,
  });
  const betView = structuredClone(checkView);
  betView.actionLog[betView.actionLog.length - 1] = {
    ...betView.actionLog[betView.actionLog.length - 1],
    type: "bet",
    amount: 450,
    to: 450,
  };

  const checked = buildBayesianRange(checkView, heroSeat, 0.45);
  const aggressive = buildBayesianRange(betView, heroSeat, 0.45);
  const averageTier = (range: typeof checked) => range.reduce((sum, combo) => sum + combo.weight * combo.tierScore, 0);

  assert.ok(Math.abs(checked.reduce((sum, combo) => sum + combo.weight, 0) - 1) < 1e-9);
  assert.ok(checked.some((combo) => combo.tierScore >= 0.86), "checking range should retain traps");
  assert.ok(checked.some((combo) => combo.tierScore <= 0.25), "checking range should retain weak hands");
  assert.ok(aggressive.some((combo) => combo.tierScore < 0.40 && combo.blockerScore >= 0.58), "aggression should retain blocker bluffs");
  assert.ok(averageTier(aggressive) > averageTier(checked), "aggression should still be value-weighted overall");
});

test("expert AI defends a river check more often after reliable hero stab evidence", () => {
  const personality: BotPersonality = {
    looseness: 0.38,
    aggression: 0.68,
    bluff: 0.55,
    trapping: 0.48,
    calling: 0.58,
    risk: 0.56,
    sizing: 0.62,
    adaptability: 0.90,
  };
  const view = riverBotView("8c 7d", "river-check-defense", true);
  const heroBet = view.actionLog.pop()!;
  view.actionLog.push({
    index: view.actionLog.length,
    playerId: view.viewerId,
    playerName: "Bot",
    type: "check",
    amount: 0,
    to: 0,
    street: "river",
    potBefore: 420,
    timestamp: 1,
  });
  view.actionLog.push({ ...heroBet, index: view.actionLog.length, timestamp: 2 });
  const stats = (riverStabs: number): CareerStats => ({
    ...EMPTY_STATS,
    hands: 70,
    wins: 28,
    vpipHands: 34,
    pfrHands: 23,
    threeBets: 7,
    aggressiveActions: 28,
    passiveActions: 32,
    riverAggressiveActions: 14,
    riverPassiveActions: 16,
    recentAggression: 0.47,
    riverStabs,
    riverStabOpportunities: 50,
    biggestPot: 1200,
  });
  const lowStab = chooseBotAction(view, personality, "expert", stats(5));
  const highStab = chooseBotAction(view, personality, "expert", stats(45));
  const defenseWeight = (decision: ReturnType<typeof chooseBotAction>) => decision.trace.candidates
    .filter((candidate) => candidate.action.type === "call" || candidate.action.type === "raise" || candidate.action.type === "all-in")
    .reduce((sum, candidate) => sum + candidate.weight, 0);
  assert.ok(defenseWeight(highStab) > defenseWeight(lowStab));
});

test("range response separates folds, calls, and raise-backs and exposes one-street rollout", () => {
  const table = createTable({ smallBlind: 5, bigBlind: 10, difficulty: "expert", seats: createSeatRoster(1000, "expert", "rollout") });
  const state = startHand(table, "rollout-hand");
  state.activeIndex = 0;
  state.street = "flop";
  state.currentBet = 0;
  state.seats[0].holeCards = cards("As 8s");
  state.community = cards("Ks 5s 2d");
  const analysis = analyzeVisibleDecision(buildPlayerView(state, "hero"), 80);
  const responseTotal = analysis.rangeResponse.foldShare + analysis.rangeResponse.callShare + analysis.rangeResponse.raiseBack;
  assert.ok(Math.abs(responseTotal - 1) < 1e-9);
  assert.ok(analysis.rangeResponse.raiseBack > 0);
  assert.ok(analysis.candidates.some((line) => (line.rolloutValue ?? 0) > 0));
});
test("line plans stay reproducible and carry a prior-street betting story", () => {
  const view = riverBotView("As Qd", "line-plan");
  view.actionLog.push({
    index: view.actionLog.length,
    playerId: view.viewerId,
    playerName: "Bot",
    type: "bet",
    amount: 120,
    to: 120,
    street: "turn",
    potBefore: 240,
    timestamp: 1,
  });
  const personality = createBotPersonality("line-plan", "expert", 0);
  const first = buildBotLinePlan(view, personality);
  const second = buildBotLinePlan(view, personality);
  assert.deepEqual(first, second);
  assert.equal(first.carriedAggression, true);
  assert.equal(first.aggressiveStreets, 1);
  assert.ok(first.coherentBluffMultiplier >= 0.62 && first.coherentBluffMultiplier <= 1.38);
});

test("observed stats learn street aggression, barrels, stabs, and folds to bets", () => {
  const state = startHand(createTable({ smallBlind: 5, bigBlind: 10, difficulty: "standard", seats: seats([1000, 1000]) }), "stats");
  state.actionLog = [
    { index: 0, playerId: "hero", playerName: "你", type: "raise", amount: 25, to: 30, street: "preflop", potBefore: 15, timestamp: 1 },
    { index: 1, playerId: "hero", playerName: "你", type: "bet", amount: 40, to: 40, street: "flop", potBefore: 60, timestamp: 2 },
    { index: 2, playerId: "bot-1", playerName: "Bot 1", type: "check", amount: 0, to: 0, street: "turn", potBefore: 140, timestamp: 3 },
    { index: 3, playerId: "hero", playerName: "你", type: "bet", amount: 90, to: 90, street: "turn", potBefore: 140, timestamp: 4 },
    { index: 4, playerId: "bot-1", playerName: "Bot 1", type: "check", amount: 0, to: 0, street: "river", potBefore: 320, timestamp: 5 },
    { index: 5, playerId: "hero", playerName: "你", type: "bet", amount: 180, to: 180, street: "river", potBefore: 320, timestamp: 6 },
    { index: 6, playerId: "bot-1", playerName: "Bot 1", type: "raise", amount: 360, to: 360, street: "river", potBefore: 500, timestamp: 7 },
    { index: 7, playerId: "hero", playerName: "你", type: "fold", amount: 0, to: 180, street: "river", potBefore: 680, timestamp: 8 },
  ];
  const stats = updateObservedStats(state, "hero");
  assert.equal(stats.flopAggressiveActions, 1);
  assert.equal(stats.turnAggressiveActions, 1);
  assert.equal(stats.riverAggressiveActions, 1);
  assert.equal(stats.turnBarrelOpportunities, 1);
  assert.equal(stats.turnBarrels, 1);
  assert.equal(stats.riverBarrelOpportunities, 1);
  assert.equal(stats.riverBarrels, 1);
  assert.equal(stats.riverStabOpportunities, 1);
  assert.equal(stats.riverStabs, 1);
  assert.equal(stats.facedRiverBets, 1);
  assert.equal(stats.foldedToRiverBets, 1);
});

test("real expert decisions do not make river action and size a fixed value tell", () => {
  const personality: BotPersonality = {
    looseness: 0.42,
    aggression: 0.82,
    bluff: 0.84,
    trapping: 0.34,
    calling: 0.38,
    risk: 0.72,
    sizing: 0.78,
    adaptability: 0.78,
  };
  const samples: Parameters<typeof auditAiReadability>[0] = [];
  for (let index = 0; index < 24; index += 1) {
    for (const [hole, value] of [["Qs Js", true], ["As Qd", false]] as const) {
      const view = riverBotView(hole, `real-readability-${value ? "value" : "bluff"}-${index}`);
      const decision = chooseBotAction(view, personality, "expert");
      const actor = view.seats.find((seat) => seat.id === view.viewerId)!;
      const pot = view.seats.reduce((sum, seat) => sum + seat.committedHand, 0);
      const fraction = Math.max(0, (decision.action.amount ?? actor.stack) - actor.committedStreet) / Math.max(1, pot);
      const sizeBucket = decision.action.type === "all-in" ? "jam"
        : decision.action.type !== "bet" && decision.action.type !== "raise" ? "none"
          : fraction <= 0.45 ? "small" : fraction <= 0.80 ? "medium" : "large";
      samples.push({ action: decision.action.type, sizeBucket, value });
    }
  }
  const audit = auditAiReadability(samples);
  assert.equal(audit.samples, 48);
  assert.ok(audit.actionPredictability < 0.84, `predictability was ${audit.actionPredictability}`);
  assert.ok(audit.normalizedActionEntropy > 0.55, `entropy was ${audit.normalizedActionEntropy}`);
  assert.ok(audit.jamBluffShare > 0.08 && audit.jamBluffShare < 0.92, `jam bluff share was ${audit.jamBluffShare}`);
});
test("readability audit detects mixed value and bluff actions", () => {
  const audit = auditAiReadability([
    { action: "check", sizeBucket: "none", value: true },
    { action: "check", sizeBucket: "none", value: false },
    { action: "bet", sizeBucket: "large", value: true },
    { action: "bet", sizeBucket: "large", value: false },
    { action: "all-in", sizeBucket: "jam", value: true },
    { action: "all-in", sizeBucket: "jam", value: false },
  ]);
  assert.equal(audit.samples, 6);
  assert.equal(audit.actionPredictability, 0.5);
  assert.equal(audit.jamBluffShare, 0.5);
  assert.ok(audit.normalizedActionEntropy > 0.99);
});

test("a fixed-seed eight-max hand completes with legal actions and conserves chips", () => {
  let state = startHand(createTable({
    smallBlind: 5,
    bigBlind: 10,
    difficulty: "casual",
    seats: createSeatRoster(1000, "casual", "eight-complete"),
  }), "eight-complete-hand");
  let steps = 0;
  while (state.status === "playing" && steps < 240) {
    const actor = state.seats[state.activeIndex];
    if (actor.isHuman) {
      const legal = getLegalActions(state, actor.id);
      const action = legal.canCheck ? { type: "check" as const }
        : legal.canCall ? { type: "call" as const }
          : { type: "fold" as const };
      state = applyAction(state, action);
    } else {
      const decision = chooseBotAction(buildBotView(state, actor.id), actor.personality!, "casual");
      state = applyAction(state, decision.action, decision.trace);
    }
    steps += 1;
  }
  assert.equal(state.status, "complete");
  assert.ok(steps < 240);
  assert.equal(state.seats.reduce((sum, seat) => sum + seat.stack, 0), 8000);
  const dealtCards = [...state.community, ...state.seats.flatMap((seat) => seat.holeCards)].map((card) => card.id);
  assert.equal(new Set(dealtCards).size, dealtCards.length);
});

test("legacy six-seat saves migrate without losing bankroll or opponent history", () => {
  const imported = parseImportedProfile(JSON.stringify({
    version: 1,
    bankroll: 23_450,
    stats: { hands: 12, wins: 4, vpipHands: 6, pfrHands: 4, threeBets: 1, aggressiveActions: 9, passiveActions: 11, biggestPot: 720 },
    opponentStats: {
      "bot-1": { hands: 12, vpipHands: 4, pfrHands: 3, threeBets: 1, aggressiveActions: 7, passiveActions: 8 },
    },
  }));
  assert.equal(imported.bankroll, 23_450);
  assert.equal(imported.stats.hands, 12);
  assert.equal(imported.stats.riverAggressiveActions, 0);
  assert.equal(imported.opponentStats["bot-1"].hands, 12);
  assert.equal(imported.opponentStats["bot-1"].recentAggression, 0.42);
  assert.equal(imported.preferences.tableFormat, "cash");
});

test("bankroll refill records bankruptcy and stake unlocks never relock", () => {
  let profile = createDefaultProfile();
  profile.bankroll = 0;
  profile = refillBankroll(profile);
  assert.equal(profile.bankroll, 20_000);
  assert.equal(profile.bankruptcyCount, 1);
  assert.equal(profile.refillCount, 1);
  profile = updateUnlocks(profile, 100_000);
  assert.ok(profile.unlockedStakeIds.includes("10-20"));
  assert.ok(profile.unlockedStakeIds.includes("25-50"));
  profile = updateUnlocks(profile, 1_000);
  assert.ok(profile.unlockedStakeIds.includes("25-50"));
});
test("coach uses raise-or-fold instead of limping an unopened weak hand", () => {
  const table = createTable({ smallBlind: 5, bigBlind: 10, difficulty: "standard", seats: createSeatRoster(1000, "standard", "raise-fold") });
  const state = startHand(table, "raise-fold-hand");
  state.activeIndex = 0;
  state.seats[0].holeCards = cards("7s 2h");
  const advice = buildCoachAdvice(buildPlayerView(state, "hero"));
  assert.equal(advice.action, "fold");
  assert.ok(advice.concepts.includes("limp"));
});

test("range analysis narrows an opponent after public aggression and stays reproducible", () => {
  const table = createTable({ smallBlind: 5, bigBlind: 10, difficulty: "expert", seats: createSeatRoster(1000, "expert", "ranges") });
  const state = startHand(table, "range-hand");
  state.activeIndex = 0;
  const baseView = buildPlayerView(state, "hero");
  const base = analyzeVisibleDecision(baseView, 80);
  const opponentId = state.seats[1].id;
  const baseRange = base.opponentRanges.find((range) => range.playerId === opponentId)!;
  const afterRaise = structuredClone(state);
  afterRaise.actionLog.push({
    index: afterRaise.actionLog.length,
    playerId: opponentId,
    playerName: afterRaise.seats[1].name,
    type: "raise",
    amount: 30,
    to: 30,
    street: "preflop",
    potBefore: 15,
    timestamp: 1,
  });
  const raisedView = buildPlayerView(afterRaise, "hero");
  const first = analyzeVisibleDecision(raisedView, 80);
  const second = analyzeVisibleDecision(raisedView, 80);
  const raisedRange = first.opponentRanges.find((range) => range.playerId === opponentId)!;
  assert.ok(raisedRange.width < baseRange.width);
  assert.deepEqual(first, second);
  assert.ok(first.candidates.length >= 2);
});
test("classifies beginner-facing relative hand and draw categories", () => {
  const tptk = classifyRelativeHand(cards("As Kd"), cards("Ah 7c 2d"));
  assert.equal(tptk.madeClass, "top-pair-top-kicker");
  assert.match(tptk.madeLabel, /TPTK/);

  const overpair = classifyRelativeHand(cards("Ks Kd"), cards("Qh 7c 2d"));
  assert.equal(overpair.madeClass, "overpair");

  const bluffCatcher = classifyRelativeHand(cards("8s 8d"), cards("Ah Kc 2d"));
  assert.equal(bluffCatcher.madeClass, "underpair");
  assert.equal(bluffCatcher.bluffCatcher, true);

  const nutDraw = classifyRelativeHand(cards("As 8s"), cards("Ks 5s 2d"));
  assert.equal(nutDraw.drawClass, "nut-flush-draw");
  assert.equal(nutDraw.nutPotential, true);

  const dominatedDraw = classifyRelativeHand(cards("Qs 8s"), cards("Ks 5s 2d"));
  assert.equal(dominatedDraw.drawClass, "non-nut-flush-draw");

  const nuts = classifyRelativeHand(cards("Th 3c"), cards("Ah Kh Qh Jh 2c"));
  assert.equal(nuts.relativeTier, "nuts");
});

test("strategy exposes worse-call and better-fold reasoning without hidden cards", () => {
  const table = createTable({ smallBlind: 5, bigBlind: 10, difficulty: "standard", seats: createSeatRoster(1000, "standard", "relative") });
  const state = startHand(table, "relative-hand");
  state.activeIndex = 0;
  state.street = "flop";
  state.currentBet = 0;
  state.seats[0].holeCards = cards("As Kd");
  state.community = cards("Ah 7c 2d");
  const view = buildPlayerView(state, "hero");
  const analysis = analyzeVisibleDecision(view, 80);
  const advice = buildCoachAdvice(view);

  assert.equal(analysis.handProfile.madeClass, "top-pair-top-kicker");
  assert.ok(analysis.rangeResponse.worseHandsContinue >= 0 && analysis.rangeResponse.worseHandsContinue <= 1);
  assert.ok(analysis.rangeResponse.betterHandsFold >= 0 && analysis.rangeResponse.betterHandsFold <= 1);
  assert.ok(analysis.candidates.some((line) => line.worseContinue !== undefined));
  assert.ok(advice.concepts.includes("TPTK"));
  assert.ok(advice.reasons.some((reason) => reason.includes("顶对顶踢脚")));
});
test("self-play policies, matches, and evolution are seeded and chip-conserving", () => {
  const population = makeInitialPopulation(8, "self-play-test");
  const centered = makeCenteredPopulation(8, "centered-test", population[0], 0.04);
  assert.deepEqual(centered, makeCenteredPopulation(8, "centered-test", population[0], 0.04));
  assert.deepEqual(centered[0].genes, population[0].genes);
  assert.equal(centered.every((policy) => policy.parentIds.includes(population[0].id)), true);
  assert.equal(centered.slice(1).every((policy) => policyDistance(policy, population[0]) <= 0.04), true);
  const config: SelfPlayTrainingConfig = {
    seed: "self-play-test",
    generations: 2,
    populationSize: 8,
    handsPerTable: 1,
    roundsPerGeneration: 1,
    decisionIterations: 4,
    mutationRate: 0.08,
    eliteFraction: 0.25,
    smallBlind: 5,
    bigBlind: 10,
    maxActionsPerHand: 320,
  };
  const first = playSelfPlayMatch(population, config, "self-play-fixed");
  const second = playSelfPlayMatch(population, config, "self-play-fixed");
  assert.deepEqual(first, second);
  assert.equal(first.chipConserved, true);
  assert.equal(first.policyResults.reduce((sum, result) => sum + result.netChips, 0), 0);
  assert.ok(first.totalActions > 0);
  assert.equal(first.observedStats[population[0].id].hands, 1);

  const evaluation = evaluatePopulation(population, config, 0);
  assert.equal(evaluation.evaluations.length, 8);
  assert.equal(evaluation.evaluations.every((entry) => Number.isFinite(entry.fitness)), true);
  const anchored = evaluatePopulation([...population], { ...config, anchorHandsPerCandidate: 1, anchorRoundsPerGeneration: 1 }, 0);
  assert.equal(anchored.matches, 9);
  assert.equal(anchored.handsPlayed, 9);
  assert.equal(anchored.evaluations.every((entry) => entry.matchSamples === 2), true);
  const evolved = evolvePopulation(evaluation.evaluations, 1, config.seed, config.mutationRate, config.eliteFraction);
  const repeated = evolvePopulation(evaluation.evaluations, 1, config.seed, config.mutationRate, config.eliteFraction);
  assert.deepEqual(evolved, repeated);
  assert.equal(new Set(evolved.map((policy) => policy.id)).size, 8);
  assert.ok(evolved.some((policy) => population.every((parent) => policyDistance(policy, parent) > 0.001)));

  const promotionDirectory = mkdtempSync(join(tmpdir(), "riverlab-promotion-test-"));
  try {
    const target = join(promotionDirectory, "expert-selfplay.json");
    assert.throws(() => promotePolicy(evaluation.evaluations[0], config, 499, target), /at least 500/);
    const promoted = promotePolicy(evaluation.evaluations[0], config, 500, target);
    assert.equal(promoted.enabled, true);
    assert.equal(JSON.parse(readFileSync(target, "utf8")).policyId, promoted.policyId);
  } finally {
    rmSync(promotionDirectory, { recursive: true, force: true });
  }
});

test("training logger writes readable and structured progress logs", () => {
  const directory = mkdtempSync(join(tmpdir(), "riverlab-selfplay-test-"));
  try {
    const logger = new TrainingLogger(directory, false);
    logger.event("run_start", "测试训练开始", { seed: "fixed" });
    logger.event("generation_complete", "第一代完成", { champion: "policy-1", chipConserved: true });
    const human = readFileSync(logger.humanLogPath, "utf8");
    const events = readFileSync(logger.eventLogPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.match(human, /测试训练开始/);
    assert.match(human, /generation_complete/);
    assert.equal(events.length, 2);
    assert.equal(events[1].payload.chipConserved, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
