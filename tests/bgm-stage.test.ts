import test from "node:test";
import assert from "node:assert/strict";
import { getBgmStageFromMultiplayer, getBgmStageFromSinglePlayer } from "../lib/poker/bgm";
import type { MultiplayerTableState } from "../server/multiplayer-types";

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

  // 1. Lobby & First Hand Pending
  assert.equal(getBgmStageFromMultiplayer(baseState), "lobby");
  const pendingFirstHand: MultiplayerTableState = { ...baseState, status: "playing", firstHandPending: true };
  assert.equal(getBgmStageFromMultiplayer(pendingFirstHand), "lobby");

  // 2. Pre-river (flop / turn)
  const flopState: MultiplayerTableState = { ...baseState, status: "playing", street: "flop" };
  assert.equal(getBgmStageFromMultiplayer(flopState), "pre-river");

  const turnState: MultiplayerTableState = { ...baseState, status: "playing", street: "turn" };
  assert.equal(getBgmStageFromMultiplayer(turnState), "pre-river");

  // 3. River
  const riverState: MultiplayerTableState = { ...baseState, status: "playing", street: "river" };
  assert.equal(getBgmStageFromMultiplayer(riverState), "river");

  // 4. Time Bank Active (higher priority than street)
  const timeBankFlop: MultiplayerTableState = { ...flopState, timeBankActive: true };
  assert.equal(getBgmStageFromMultiplayer(timeBankFlop), "time-bank");

  const timeBankRiver: MultiplayerTableState = { ...riverState, timeBankActive: true };
  assert.equal(getBgmStageFromMultiplayer(timeBankRiver), "time-bank");

  // 5. Settlement / Hand complete
  const completeState: MultiplayerTableState = { ...baseState, status: "playing", street: "complete", handResultSummary: "Winner老王" };
  assert.equal(getBgmStageFromMultiplayer(completeState), "settlement");
});

test("getBgmStageFromSinglePlayer returns correct stage for singleplayer", () => {
  assert.equal(getBgmStageFromSinglePlayer(null, "lobby"), "lobby");
});
