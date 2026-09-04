import test from "node:test";
import assert from "node:assert/strict";
import { getBgmStageFromMultiplayer, getBgmStageFromSinglePlayer } from "../lib/poker/bgm";
import type { MultiplayerTableState } from "../server/multiplayer-types";
import type { Card, FullGameState } from "../lib/poker/types";

test("getBgmStageFromMultiplayer returns correct stage for each scenario", () => {
  const baseState: MultiplayerTableState = {
    roomCode: "TEST",
    status: "lobby",
    config: {
      smallBlind: 5,
      bigBlind: 10,
      startingStack: 1000,
      minPlayers: 4,
      regularTurnSeconds: 20,
      initialTimeBankCards: 2,
      timeBankExtensionSeconds: 30,
    },
    myId: "user-1",
    isHost: true,
    isSpectator: false,
    godMode: false,
    handNumber: 1,
    street: "preflop",
    smallBlind: 5,
    bigBlind: 10,
    pot: 15,
    currentBet: 10,
    minRaise: 10,
    buttonIndex: 0,
    activeIndex: 1,
    community: [],
    myHoleCards: [],
    myTimeBankCards: 2,
    canUseTimeBank: false,
    timeBankActive: false,
    seats: [],
    spectators: [],
    actionLog: [],
    legalActions: { canFold: true, canCheck: false, canCall: true, canBet: false, canRaise: false, canAllIn: true, toCall: 10, callAmount: 10, minBetTo: 0, minRaiseTo: 0, maxTo: 1000 },
    turnTimeRemaining: 20,
    turnTotalTime: 20,
    turnExpiresAt: Date.now() + 20000,
    canStartGame: false,
  };

  // 1. Ready Theme: Lobby, null state, handNumber === 0, or firstHandPending
  assert.equal(getBgmStageFromMultiplayer(baseState), "ready");
  assert.equal(getBgmStageFromMultiplayer(null), "ready");
  const pendingFirstHand: MultiplayerTableState = { ...baseState, status: "playing", firstHandPending: true };
  assert.equal(getBgmStageFromMultiplayer(pendingFirstHand), "ready");
  const zeroHand: MultiplayerTableState = { ...baseState, status: "playing", handNumber: 0, firstHandPending: false };
  assert.equal(getBgmStageFromMultiplayer(zeroHand), "ready");

  // 2. Main Theme: Host started hand (preflop / flop / turn)
  const preflopState: MultiplayerTableState = { ...baseState, status: "playing", street: "preflop", handNumber: 1, firstHandPending: false };
  assert.equal(getBgmStageFromMultiplayer(preflopState), "main");

  const flopCards: Card[] = [
    { id: "Ah", suit: "h", rank: 14 },
    { id: "Kd", suit: "d", rank: 13 },
    { id: "Qc", suit: "c", rank: 12 },
  ];
  const flopState: MultiplayerTableState = { ...preflopState, street: "flop", community: flopCards };
  assert.equal(getBgmStageFromMultiplayer(flopState), "main");

  const turnCards: Card[] = [
    ...flopCards,
    { id: "Js", suit: "s", rank: 11 },
  ];
  const turnState: MultiplayerTableState = { ...preflopState, street: "turn", community: turnCards };
  assert.equal(getBgmStageFromMultiplayer(turnState), "main");

  // 3. AllShown Theme: 5 river cards displayed
  const riverCards: Card[] = [
    ...turnCards,
    { id: "Th", suit: "h", rank: 10 },
  ];
  const riverState: MultiplayerTableState = {
    ...preflopState,
    street: "river",
    community: riverCards,
  };
  assert.equal(getBgmStageFromMultiplayer(riverState), "allshown");

  // 4. TimeBank Theme: Active time bank extension card
  const timeBankFlop: MultiplayerTableState = { ...flopState, timeBankActive: true };
  assert.equal(getBgmStageFromMultiplayer(timeBankFlop), "timebank");

  const timeBankRiver: MultiplayerTableState = { ...riverState, timeBankActive: true };
  assert.equal(getBgmStageFromMultiplayer(timeBankRiver), "timebank");

  // 5. Settlement Theme: Hand complete / showdown / settlement summary
  const completeState: MultiplayerTableState = { ...baseState, status: "playing", street: "complete", handResultSummary: "Winner老王" };
  assert.equal(getBgmStageFromMultiplayer(completeState), "settlement");

  const showdownState: MultiplayerTableState = { ...baseState, status: "playing", street: "showdown" };
  assert.equal(getBgmStageFromMultiplayer(showdownState), "settlement");
});

test("getBgmStageFromSinglePlayer returns correct stage for singleplayer", () => {
  assert.equal(getBgmStageFromSinglePlayer(null, "lobby"), "ready");
  assert.equal(getBgmStageFromSinglePlayer(null, "tournament-result"), "ready");

  const mockPlayingTable: FullGameState = {
    handId: "h1",
    handNumber: 1,
    seed: "seed",
    smallBlind: 5,
    bigBlind: 10,
    difficulty: "standard",
    deck: [],
    deckIndex: 0,
    community: [],
    seats: [],
    buttonIndex: 0,
    activeIndex: 0,
    street: "preflop",
    status: "playing",
    currentBet: 10,
    minRaise: 10,
    actionLog: [],
  };

  assert.equal(getBgmStageFromSinglePlayer(mockPlayingTable, "lobby"), "ready");
  assert.equal(getBgmStageFromSinglePlayer(mockPlayingTable, "table"), "main");

  const riverTable: FullGameState = {
    ...mockPlayingTable,
    street: "river",
    community: [
      { id: "Ah", suit: "h", rank: 14 },
      { id: "Kd", suit: "d", rank: 13 },
      { id: "Qc", suit: "c", rank: 12 },
      { id: "Js", suit: "s", rank: 11 },
      { id: "Th", suit: "h", rank: 10 },
    ],
  };
  assert.equal(getBgmStageFromSinglePlayer(riverTable, "table"), "allshown");

  const completeTable: FullGameState = {
    ...mockPlayingTable,
    status: "complete",
    street: "complete",
  };
  assert.equal(getBgmStageFromSinglePlayer(completeTable, "table"), "settlement");
});
