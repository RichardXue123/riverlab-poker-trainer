import assert from "node:assert/strict";
import test from "node:test";
import { getLegalActions, STREET_LABELS } from "../lib/poker/engine";
import { MultiplayerRoom } from "../server/multiplayer-room";

test("enforces 4-8 players and all-ready rule before starting game", () => {
  let stateChanges = 0;
  const room = new MultiplayerRoom("TEST", "host-1", "房主小王", () => {
    stateChanges += 1;
  }, { minPlayers: 4 });

  // Only 1 player (the host)
  assert.equal(room.seatedCount, 1);
  let eligibility = room.checkStartGameEligibility();
  assert.equal(eligibility.canStart, false);
  assert.ok(eligibility.reason?.includes("至少需要 4 名玩家"));

  // Player 2 and 3 join
  room.join("p2", "玩家老李");
  room.join("p3", "玩家小张");
  assert.equal(room.seatedCount, 3);
  eligibility = room.checkStartGameEligibility();
  assert.equal(eligibility.canStart, false);

  // Player 4 joins
  room.join("p4", "玩家大刘");
  assert.equal(room.seatedCount, 4);

  // Now 4 players seated, but p2, p3, p4 are NOT ready yet
  eligibility = room.checkStartGameEligibility();
  assert.equal(eligibility.canStart, false);
  assert.ok(eligibility.reason?.includes("未准备就绪"));

  // Non-host attempts to start game -> should fail
  const p2Start = room.startGame("p2");
  assert.equal(p2Start.success, false);
  assert.equal(p2Start.error, "只有房主才能开始牌局");

  // Host attempts to start game while unready -> should fail
  const hostStartFail = room.startGame("host-1");
  assert.equal(hostStartFail.success, false);
  assert.ok(hostStartFail.error?.includes("未准备就绪"));

  // Players toggle ready
  room.toggleReady("p2");
  room.toggleReady("p3");
  eligibility = room.checkStartGameEligibility();
  assert.equal(eligibility.canStart, false); // p4 still not ready

  room.toggleReady("p4");
  eligibility = room.checkStartGameEligibility();
  assert.equal(eligibility.canStart, true);

  // Now host starts the game (enters table view, first hand pending confirmation)!
  const hostStartOk = room.startGame("host-1");
  assert.equal(hostStartOk.success, true);
  assert.equal(room.status, "playing");
  assert.ok(room.gameState);
  assert.equal(room.firstHandPending, true);

  // Host confirms and starts the first hand!
  const firstHandOk = room.nextHand("host-1");
  assert.equal(firstHandOk.success, true);
  assert.equal(room.firstHandPending, false);
  assert.equal(room.gameState?.status, "playing");

  // Verify anti-cheat card masking:
  // Player 2's view should only see Player 2's hole cards, not Host's cards!
  const p2State = room.buildClientState("p2");
  assert.equal(p2State.myHoleCards.length, 2);
  const hostSeatInP2View = p2State.seats.find((s) => s.id === "host-1")!;
  assert.equal(hostSeatInP2View.holeCards.length, 0, "Other players' cards must be hidden from normal players");

  // Spectator joining
  room.join("spec-1", "旁观者老陈", true);
  const normalSpecState = room.buildClientState("spec-1");
  assert.equal(normalSpecState.godMode, false);
  assert.equal(normalSpecState.seats[0].holeCards.length, 0, "Normal spectator cannot see hidden hole cards");

  // Spectator activates God-Mode
  room.setGodMode("spec-1", true);
  const godSpecState = room.buildClientState("spec-1");
  assert.equal(godSpecState.godMode, true);
  assert.equal(godSpecState.seats[0].holeCards.length, 2, "God mode spectator can see all hole cards");
  assert.ok(godSpecState.godModeEquities, "God mode spectator receives real-time equity calculations");
  assert.equal(godSpecState.godModeEquities?.length, 4);

  room.cleanup();
});

test("enforces thinking time, time bank card usage (<=5s, +30s) and auto-fold", () => {
  const room = new MultiplayerRoom("TIME", "host-1", "房主", () => {}, {
    minPlayers: 2,
    regularTurnSeconds: 20,
    initialTimeBankCards: 2,
    timeBankExtensionSeconds: 30,
  });

  room.join("p2", "玩家2");
  room.toggleReady("p2");
  const started = room.startGame("host-1");
  assert.equal(started.success, true);
  const firstHandOk = room.nextHand("host-1");
  assert.equal(firstHandOk.success, true);

  // Active player identification
  const activeSeat = room.gameState!.seats[room.gameState!.activeIndex];
  const activeId = activeSeat.id;
  const nonActiveId = activeId === "host-1" ? "p2" : "host-1";

  // 1. Non-active player cannot use extension card
  const nonActiveUse = room.useTimeBank(nonActiveId);
  assert.equal(nonActiveUse.success, false);
  assert.equal(nonActiveUse.error, "还未轮到你的回合");

  // 2. Active player cannot use extension card when remaining time > 5s
  const tooEarlyUse = room.useTimeBank(activeId);
  assert.equal(tooEarlyUse.success, false);
  assert.equal(tooEarlyUse.error, "思考时间剩余 5 秒以内才可使用延时卡");

  // 3. Simulate remaining time <= 5s (e.g. 3s remaining)
  // We access private turnExpiresAt for precise test simulation
  (room as unknown as { turnExpiresAt: number }).turnExpiresAt = Date.now() + 3000;

  // Now active player uses first extension card
  const clientStateBefore = room.buildClientState(activeId);
  assert.equal(clientStateBefore.canUseTimeBank, true);
  assert.equal(clientStateBefore.myTimeBankCards, 2);

  const use1 = room.useTimeBank(activeId);
  assert.equal(use1.success, true);

  const clientStateAfter1 = room.buildClientState(activeId);
  // Timer should be extended by 1x regular thinking time (20s) to ~23s remaining
  assert.ok(clientStateAfter1.turnTimeRemaining >= 20, "Timer should be extended by 1x regular thinking time (20 seconds)");
  // Because it's now > 5s, canUseTimeBank becomes false again
  assert.equal(clientStateAfter1.canUseTimeBank, false);

  // 4. Simulate remaining time drops to <= 5s again (user uses second extension card consecutively)
  (room as unknown as { turnExpiresAt: number }).turnExpiresAt = Date.now() + 4000;
  const clientStateBefore2 = room.buildClientState(activeId);
  assert.equal(clientStateBefore2.canUseTimeBank, true);

  const use2 = room.useTimeBank(activeId);
  assert.equal(use2.success, true);

  const clientStateAfter2 = room.buildClientState(activeId);
  assert.equal(clientStateAfter2.myTimeBankCards, 0, "Should have 0 cards left");

  // 5. Try using a 3rd card when 0 cards remain -> fails
  (room as unknown as { turnExpiresAt: number }).turnExpiresAt = Date.now() + 2000;
  const use3 = room.useTimeBank(activeId);
  assert.equal(use3.success, false);
  assert.equal(use3.error, "你已没有可用的延时卡");

  // 6. Test timeout triggers auto-fold
  (room as unknown as { handleTimeout: () => void }).handleTimeout();
  // Active seat should be folded
  const foldedSeat = room.gameState!.seats.find((s) => s.id === activeId)!;
  assert.equal(foldedSeat.folded, true, "Player should be automatically folded upon thinking timeout");

  room.cleanup();
});

test("forces auto-fold upon timeout when checking is available (toCall === 0)", () => {
  const room = new MultiplayerRoom("TIMEOUT_CHECK", "host-1", "房主", () => {}, {
    minPlayers: 3,
    regularTurnSeconds: 20,
  });

  room.join("p2", "玩家2");
  room.join("p3", "玩家3");
  room.toggleReady("p2");
  room.toggleReady("p3");
  room.startGame("host-1");
  room.nextHand("host-1");

  // In 3-player hand:
  // button is host-1 (index 0).
  // SB is p2 (index 1), BB is p3 (index 2).
  // First actor preflop is BTN (host-1).
  const btnSeat = room.gameState!.seats[room.gameState!.activeIndex];
  assert.equal(btnSeat.id, "host-1");
  // BTN calls
  room.handleAction("host-1", { type: "call" });
  // SB calls
  room.handleAction("p2", { type: "call" });
  // Now BB (p3) has the option, committed 10, currentBet 10 -> toCall is 0!
  const bbSeat = room.gameState!.seats[room.gameState!.activeIndex];
  assert.equal(bbSeat.id, "p3");
  const bbLegal = getLegalActions(room.gameState!, "p3");
  assert.equal(bbLegal.toCall, 0);
  assert.equal(bbLegal.canCheck, true);
  assert.equal(bbLegal.canFold, false); // UI hides fold button

  // Time expires for BB!
  (room as unknown as { handleTimeout: () => void }).handleTimeout();

  // BB must be forcibly folded!
  const foldedBb = room.gameState!.seats.find((s) => s.id === "p3")!;
  assert.equal(foldedBb.folded, true, "BB should be forcibly folded on timeout even though checking was free");

  // Since preflop round is complete and 2 players remain (host-1, p2), game advances to flop!
  assert.equal(room.gameState!.street, "flop");
  assert.equal(room.gameState!.community.length, 3);

  // On flop, first actor has toCall === 0. Test flop timeout as well:
  const flopActorId = room.gameState!.seats[room.gameState!.activeIndex].id;
  (room as unknown as { handleTimeout: () => void }).handleTimeout();
  const foldedFlopActor = room.gameState!.seats.find((s) => s.id === flopActorId)!;
  assert.equal(foldedFlopActor.folded, true, "Flop actor should be folded on timeout");

  // Now only 1 player remains, hand should settle uncontested!
  assert.equal(room.gameState!.status, "complete");
  assert.ok(room.handResultSummary);

  room.cleanup();
});

test("handles player leaving during active turn and out-of-turn cleanly", () => {
  const room = new MultiplayerRoom("LEAVE_TEST", "host-1", "房主", () => {}, {
    minPlayers: 3,
    regularTurnSeconds: 20,
  });

  room.join("p2", "玩家2");
  room.join("p3", "玩家3");
  room.toggleReady("p2");
  room.toggleReady("p3");
  room.startGame("host-1");
  room.nextHand("host-1");

  // Active player preflop is host-1
  const activeId = room.gameState!.seats[room.gameState!.activeIndex].id;
  assert.equal(activeId, "host-1");

  // Host leaves during their active turn -> should auto-fold host and advance to next player
  room.leave("host-1");
  const nextActiveId = room.gameState!.seats[room.gameState!.activeIndex].id;
  assert.notEqual(nextActiveId, "host-1");
  const hostSeat = room.gameState!.seats.find((s) => s.id === "host-1")!;
  assert.equal(hostSeat.folded, true);

  // Now 2 players remain (p2, p3). p3 leaves out of turn -> only p2 remains, hand settles uncontested!
  const currentActorId = room.gameState!.seats[room.gameState!.activeIndex].id;
  const nonActorId = currentActorId === "p2" ? "p3" : "p2";
  const survivorId = currentActorId === "p2" ? "p2" : "p3";

  room.leave(nonActorId);
  assert.equal(room.gameState!.status, "complete");
  assert.equal(room.gameState!.lastResult?.winnerIds[0], survivorId);

  room.cleanup();
});

test("supports manual host transfer and automatic inheritance in lobby and during game", () => {
  const room = new MultiplayerRoom("TRANSFER_TEST", "host-1", "原房主", () => {}, {
    minPlayers: 3,
    regularTurnSeconds: 20,
  });

  room.join("p2", "玩家2");
  room.join("p3", "玩家3");

  // 1. In lobby, non-host cannot transfer host
  const unauthorizedTransfer = room.transferHost("p2", "p3");
  assert.equal(unauthorizedTransfer.success, false);
  assert.equal(unauthorizedTransfer.error, "只有房主才能转让房主身份");

  // 2. In lobby, host transfers to p2
  const transferOk = room.transferHost("host-1", "p2");
  assert.equal(transferOk.success, true);
  assert.equal(room.hostId, "p2");
  const p2Seat = room.seats.find((s) => s?.id === "p2")!;
  const host1Seat = room.seats.find((s) => s?.id === "host-1")!;
  assert.equal(p2Seat.isHost, true);
  assert.equal(p2Seat.isReady, true);
  assert.equal(host1Seat.isHost, false);

  // 3. Ready up and start game under new host p2
  room.toggleReady("host-1");
  room.toggleReady("p3");
  const oldHostStart = room.startGame("host-1");
  assert.equal(oldHostStart.success, false, "Old host should no longer have start permission");

  const newHostStart = room.startGame("p2");
  assert.equal(newHostStart.success, true, "New host p2 can start game");
  assert.equal(room.status, "playing");
  assert.equal(room.firstHandPending, true);

  // 4. During active table (first hand pending), transfer host from p2 to p3
  const activeTransfer = room.transferHost("p2", "p3");
  assert.equal(activeTransfer.success, true);
  assert.equal(room.hostId, "p3");
  const p3Seat = room.seats.find((s) => s?.id === "p3")!;
  assert.equal(p3Seat.isHost, true);
  assert.equal(room.seats.find((s) => s?.id === "p2")!.isHost, false);

  // 5. p3 (now host) confirms and starts first hand
  const p2NextHandFail = room.nextHand("p2");
  assert.equal(p2NextHandFail.success, false, "p2 is no longer host and cannot start hand");
  const p3NextHandOk = room.nextHand("p3");
  assert.equal(p3NextHandOk.success, true, "p3 as new host starts hand");
  assert.equal(room.firstHandPending, false);

  // 6. During game, host p3 leaves the room -> host should automatically transfer to next player
  room.leave("p3");
  // Host must be transferred to one of the remaining players (host-1 or p2)
  assert.notEqual(room.hostId, "p3");
  const currentHost = room.seats.find((s) => s?.id === room.hostId);
  assert.ok(currentHost, "A remaining seated player should be the new host");
  assert.equal(currentHost?.isHost, true);

  room.cleanup();
});

test("supports between-hands spectator joining table, seated player standing up, and enforces 4-8 players rule", () => {
  const room = new MultiplayerRoom("TABLE_SEAT_TEST", "host-1", "房主", () => {}, {
    minPlayers: 4,
    regularTurnSeconds: 20,
  });

  room.join("p2", "玩家2");
  room.join("p3", "玩家3");
  room.join("p4", "玩家4");
  room.join("spec-1", "旁观者1", true); // join as spectator

  assert.equal(room.seatedCount, 4);
  assert.equal(room.spectators.size, 1);

  // 1. Ready up and start game -> enters table view with firstHandPending
  room.toggleReady("p2");
  room.toggleReady("p3");
  room.toggleReady("p4");
  const startRes = room.startGame("host-1");
  assert.equal(startRes.success, true);
  assert.equal(room.firstHandPending, true);

  // 2. Before first hand starts (firstHandPending), a player can stand up to spectate
  const p4StandUpBeforeFirst = room.standUp("p4");
  assert.equal(p4StandUpBeforeFirst, true);
  assert.equal(room.seatedCount, 3);
  assert.equal(room.spectators.has("p4"), true);

  // 3. Trying to start first hand with only 3 players seated should fail (enforcing 4-8 rule)!
  const startFail3Players = room.nextHand("host-1");
  assert.equal(startFail3Players.success, false);
  assert.ok(startFail3Players.error?.includes("当前在座人数不足 4 人"));

  // 4. Spectator 1 takes seat (joins table)
  const specTakeSeat = room.takeSeat("spec-1");
  assert.equal(specTakeSeat, true);
  assert.equal(room.seatedCount, 4);
  assert.equal(room.spectators.has("spec-1"), false);

  // 5. Now 4 players are seated (host-1, p2, p3, spec-1), nextHand should succeed!
  const firstHandRes = room.nextHand("host-1");
  assert.equal(firstHandRes.success, true);
  assert.equal(room.firstHandPending, false);
  assert.equal(room.gameState?.status, "playing");
  assert.equal(room.gameState?.seats.length, 4);
  assert.ok(room.gameState?.seats.some((s) => s.id === "spec-1"), "spec-1 is now in the engine game seats");
  assert.ok(!room.gameState?.seats.some((s) => s.id === "p4"), "p4 is not in the engine game seats");

  // 6. While hand is actively playing, neither takeSeat nor standUp is allowed
  assert.equal(room.standUp("p2"), false, "Cannot stand up mid-hand");
  assert.equal(room.takeSeat("p4"), false, "Spectator cannot join mid-hand");

  // 7. Complete the hand: fold remaining players so hand settles
  const activeActors = room.gameState!.seats.filter((s) => !s.folded);
  // Auto-fold until only 1 remains or hand completes
  for (let i = 0; i < activeActors.length - 1; i += 1) {
    (room as unknown as { handleTimeout: () => void }).handleTimeout();
  }
  assert.equal(room.gameState!.status, "complete");

  // 8. Hand is complete (between hands): p2 stands up to spectate
  const p2StandUp = room.standUp("p2");
  assert.equal(p2StandUp, true);
  assert.equal(room.seatedCount, 3);
  assert.equal(room.spectators.has("p2"), true);

  // 9. Host attempts nextHand with 3 players -> should be blocked!
  const nextHandFail3 = room.nextHand("host-1");
  assert.equal(nextHandFail3.success, false);
  assert.ok(nextHandFail3.error?.includes("当前在座人数不足 4 人"));

  // 10. Spectator p4 takes a specific seat (e.g. seat index 5)
  const p4TakeSeat5 = room.takeSeat("p4", 5);
  assert.equal(p4TakeSeat5, true);
  assert.equal(room.seats[5]?.id, "p4");
  assert.equal(room.seatedCount, 4);

  // 11. Now 4 players seated again (host-1, p3, spec-1, p4). nextHand succeeds!
  const nextHandRes = room.nextHand("host-1");
  assert.equal(nextHandRes.success, true);
  assert.equal(room.gameState?.status, "playing");
  assert.equal(room.gameState?.seats.length, 4);
  assert.ok(room.gameState?.seats.some((s) => s.id === "p4"), "p4 received cards in new hand");
  assert.ok(!room.gameState?.seats.some((s) => s.id === "p2"), "p2 is spectating and was not dealt cards");

  // 12. Verify client state mapping
  const hostClientState = room.buildClientState("host-1");
  assert.equal(hostClientState.seats.length, 8);
  assert.equal(hostClientState.seats[5].id, "p4");
  assert.equal(hostClientState.isSpectator, false);

  const p2ClientState = room.buildClientState("p2");
  assert.equal(p2ClientState.isSpectator, true);

  room.cleanup();
});

test("startGame and buildClientState succeed without throwing when buttonIndex is -1", () => {
  const room = new MultiplayerRoom("START_TEST", "host-1", "房主", () => {}, {
    minPlayers: 3,
  });
  room.join("p2", "玩家2");
  room.join("p3", "玩家3");
  room.toggleReady("p2");
  room.toggleReady("p3");

  const startRes = room.startGame("host-1");
  assert.equal(startRes.success, true);
  assert.equal(room.gameState?.buttonIndex, -1);

  // Calling buildClientState for all players must NOT throw!
  const hostState = room.buildClientState("host-1");
  assert.equal(hostState.buttonIndex, -1);
  assert.equal(hostState.status, "playing");

  const p2State = room.buildClientState("p2");
  assert.equal(p2State.buttonIndex, -1);

  room.cleanup();
});

test("accurately logs thinking time and deep thinking formatting in multiplayer mode", () => {
  const room = new MultiplayerRoom("THINK_TEST", "host-1", "房主", () => {}, {
    minPlayers: 3,
    regularTurnSeconds: 20,
  });

  // 1. Test formatThinking logic directly
  // Under regularTurnSeconds = 20, half is 10s.
  // Thinking <= 10s is regular thinking; > 10s is deep thinking.
  const t1 = room.formatThinking(5);
  assert.equal(t1.thinkingSeconds, 5);
  assert.equal(t1.thinkingText, "已思考5s");
  assert.equal(t1.isDeepThinking, false);

  const tHalf = room.formatThinking(10);
  assert.equal(tHalf.thinkingSeconds, 10);
  assert.equal(tHalf.thinkingText, "已思考10s");
  assert.equal(tHalf.isDeepThinking, false);

  const tDeep11 = room.formatThinking(11);
  assert.equal(tDeep11.thinkingSeconds, 11);
  assert.equal(tDeep11.thinkingText, "已深度思考11s");
  assert.equal(tDeep11.isDeepThinking, true);

  const tDeep20 = room.formatThinking(20);
  assert.equal(tDeep20.thinkingSeconds, 20);
  assert.equal(tDeep20.thinkingText, "已深度思考20s");
  assert.equal(tDeep20.isDeepThinking, true);

  // Rounding test (4.7s -> 5s, 0.2s -> 1s)
  const tRound = room.formatThinking(4.7);
  assert.equal(tRound.thinkingSeconds, 5);
  assert.equal(tRound.thinkingText, "已思考5s");

  const tMin = room.formatThinking(0.2);
  assert.equal(tMin.thinkingSeconds, 1);
  assert.equal(tMin.thinkingText, "已思考1s");

  // 2. Test live room action logging with simulated elapsed thinking times
  room.join("p2", "玩家2");
  room.join("p3", "玩家3");
  room.toggleReady("p2");
  room.toggleReady("p3");
  room.startGame("host-1");
  room.nextHand("host-1");

  // First actor is BTN (host-1)
  assert.equal(room.gameState!.seats[room.gameState!.activeIndex].id, "host-1");

  // Simulate host thinking for 5s
  room.turnStartedAt = Date.now() - 5000;
  const hostActionRes = room.handleAction("host-1", { type: "call" });
  assert.equal(hostActionRes.success, true);

  const hostAction = room.gameState!.actionLog[room.gameState!.actionLog.length - 1];
  assert.equal(hostAction.playerName, "房主");
  assert.equal(hostAction.type, "call");
  assert.equal(hostAction.thinkingSeconds, 5);
  assert.equal(hostAction.thinkingText, "已思考5s");
  assert.equal(hostAction.isDeepThinking, false);

  // Next actor is SB (p2)
  assert.equal(room.gameState!.seats[room.gameState!.activeIndex].id, "p2");

  // Simulate p2 thinking deeply for 15s (> 20/2 = 10s)
  room.turnStartedAt = Date.now() - 15000;
  const p2ActionRes = room.handleAction("p2", { type: "call" });
  assert.equal(p2ActionRes.success, true);

  const p2Action = room.gameState!.actionLog[room.gameState!.actionLog.length - 1];
  assert.equal(p2Action.playerName, "玩家2");
  assert.equal(p2Action.type, "call");
  assert.equal(p2Action.thinkingSeconds, 15);
  assert.equal(p2Action.thinkingText, "已深度思考15s");
  assert.equal(p2Action.isDeepThinking, true);

  // Next actor is BB (p3)
  assert.equal(room.gameState!.seats[room.gameState!.activeIndex].id, "p3");

  // Simulate p3 thinking for full 20s until timeout
  room.turnStartedAt = Date.now() - 20000;
  (room as unknown as { handleTimeout: () => void }).handleTimeout();

  const timeoutAction = room.gameState!.actionLog[room.gameState!.actionLog.length - 1];
  assert.equal(timeoutAction.playerName, "玩家3");
  assert.equal(timeoutAction.type, "fold");
  assert.equal(timeoutAction.thinkingSeconds, 20);
  assert.equal(timeoutAction.thinkingText, "已深度思考20s");
  assert.equal(timeoutAction.isDeepThinking, true);

  // Verify buildClientState passes thinking metadata to all clients
  const clientState = room.buildClientState("host-1");
  const lastThreeActions = clientState.actionLog.slice(-3);
  assert.equal(lastThreeActions[0].thinkingText, "已思考5s");
  assert.equal(lastThreeActions[0].isDeepThinking, false);
  assert.equal(lastThreeActions[1].thinkingText, "已深度思考15s");
  assert.equal(lastThreeActions[1].isDeepThinking, true);
  assert.equal(lastThreeActions[2].thinkingText, "已深度思考20s");
  assert.equal(lastThreeActions[2].isDeepThinking, true);

  // Also verify seat states reflect the lastActionThinkingText
  const p3Seat = clientState.seats.find((s) => s.id === "p3");
  assert.equal(p3Seat?.lastActionThinkingText, "已深度思考20s");

  room.cleanup();
});

test("supports adding, removing, and auto-filling AI bots to meet 4-8 players rule", () => {
  const room = new MultiplayerRoom("BOTS", "host-1", "房主", () => {}, {
    minPlayers: 4,
    aiDelayMs: -1,
  });

  // Initially only 1 host player
  assert.equal(room.seatedCount, 1);
  assert.equal(room.checkStartGameEligibility().canStart, false);

  // Non-host cannot add AI bot
  const nonHostAdd = room.addAiBot("p2");
  assert.equal(nonHostAdd.success, false);
  assert.equal(nonHostAdd.error, "只有房主才能添加 AI 机器人");

  // Host adds 1 AI bot to seat 1
  const add1 = room.addAiBot("host-1", 1);
  assert.equal(add1.success, true);
  assert.equal(room.seatedCount, 2);
  const botSeat1 = room.seats[1];
  assert.ok(botSeat1);
  assert.equal(botSeat1.isAi, true);
  assert.equal(botSeat1.isReady, true);
  assert.ok(botSeat1.name.length > 0);

  // Host removes AI bot from seat 1
  const remove1 = room.removeAiBot("host-1", 1);
  assert.equal(remove1.success, true);
  assert.equal(room.seats[1], null);
  assert.equal(room.seatedCount, 1);

  // Cannot remove empty seat or human seat
  const removeEmpty = room.removeAiBot("host-1", 1);
  assert.equal(removeEmpty.success, false);
  const removeHost = room.removeAiBot("host-1", 0);
  assert.equal(removeHost.success, false);
  assert.equal(removeHost.error, "该座位没有 AI 机器人");

  // Host uses fillAiBots to automatically reach minPlayers (4)
  const fillRes = room.fillAiBots("host-1", 4);
  assert.equal(fillRes.success, true);
  assert.equal(fillRes.countAdded, 3);
  assert.equal(room.seatedCount, 4);

  // Check start game eligibility now satisfies 4 players and all ready
  const eligibility = room.checkStartGameEligibility();
  assert.equal(eligibility.canStart, true);

  // Client state reflects AI properties
  const clientState = room.buildClientState("host-1");
  const aiSeats = clientState.seats.filter((s) => s.isAi);
  assert.equal(aiSeats.length, 3);
  for (const bot of aiSeats) {
    assert.equal(bot.isHuman, false);
    assert.equal(bot.isReady, true);
    assert.equal(bot.holeCards.length, 0); // Cards masked for host
  }

  // Host fills to 8 seats
  const fill8 = room.fillAiBots("host-1", 8);
  assert.equal(fill8.success, true);
  assert.equal(fill8.countAdded, 4);
  assert.equal(room.seatedCount, 8);

  // Cannot add beyond 8
  const addOver = room.addAiBot("host-1");
  assert.equal(addOver.success, false);
  assert.ok(addOver.error?.includes("8人上限"));

  // Clear all AI bots
  const clearRes = room.clearAllAiBots("host-1");
  assert.equal(clearRes.success, true);
  assert.equal(clearRes.countRemoved, 7);
  assert.equal(room.seatedCount, 1);

  room.cleanup();
});

test("executes AI bot actions authority on server during multiplayer game", () => {
  const room = new MultiplayerRoom("BOTPLAY", "host-1", "房主", () => {}, {
    minPlayers: 4,
    aiDelayMs: -1, // Manual step execution for testing
  });

  // Host fills 3 AI bots to meet 4 players
  room.fillAiBots("host-1", 4);
  assert.equal(room.checkStartGameEligibility().canStart, true);

  // Host starts game and first hand
  const started = room.startGame("host-1");
  assert.equal(started.success, true);
  const firstHand = room.nextHand("host-1");
  assert.equal(firstHand.success, true);

  assert.equal(room.gameState?.status, "playing");

  // Play through the hand until complete or user turn
  // If active player is human host, host checks or calls or folds
  let iterations = 0;
  while (room.gameState && room.gameState.status === "playing" && iterations < 50) {
    iterations++;
    const activeSeat = room.gameState.seats[room.gameState.activeIndex];
    if (!activeSeat) break;

    if (activeSeat.id === "host-1") {
      // Human turn: check or call
      const legal = getLegalActions(room.gameState, "host-1");
      if (legal.canCheck) {
        room.handleAction("host-1", { type: "check" });
      } else if (legal.canCall) {
        room.handleAction("host-1", { type: "call" });
      } else {
        room.handleAction("host-1", { type: "fold" });
      }
    } else {
      // AI turn: manual step execution
      if (room.gameState.status === "playing" && !activeSeat.isHuman) {
        room.executeAiTurn(activeSeat.id);
      }
    }
  }

  // Verify that actions took place and actionLog contains AI entries
  assert.ok(room.gameState!.actionLog.length > 0);
  const hasAiAction = room.gameState!.actionLog.some((a) => a.playerId !== "host-1");
  assert.equal(hasAiAction, true, "AI players should have taken valid actions in actionLog");

  // Check that thinking seconds are formatted on voluntary actions
  const aiLog = room.gameState!.actionLog.find((a) => a.playerId !== "host-1" && a.thinkingText);
  assert.ok(aiLog?.thinkingText?.startsWith("已"));

  // Cannot transfer host to AI
  const botSeat = room.seats.find((s) => s?.isAi);
  assert.ok(botSeat);
  const transferRes = room.transferHost("host-1", botSeat.id);
  assert.equal(transferRes.success, false);
  assert.equal(transferRes.error, "无法将房主身份转让给 AI 机器人");

  // If host leaves and only bots remain, room cleans up
  const roomEmpty = room.leave("host-1");
  assert.equal(roomEmpty, true, "Room with only AI bots remaining should be cleaned up");

  room.cleanup();
});

test("bilingual stage labels are correctly formatted and map across all hand streets", () => {
  assert.equal(STREET_LABELS.preflop, "翻牌前 Pre-flop");
  assert.equal(STREET_LABELS.flop, "翻牌圈 Flop");
  assert.equal(STREET_LABELS.turn, "转牌圈 Turn");
  assert.equal(STREET_LABELS.river, "河牌圈 River");
  assert.equal(STREET_LABELS.showdown, "摊牌 Showdown");
  assert.equal(STREET_LABELS.complete, "牌局结算 Complete");

  const room = new MultiplayerRoom("STAGE1", "host-1", "StageHost", () => {}, {
    smallBlind: 10,
    bigBlind: 20,
    minPlayers: 4,
    aiDelayMs: -1,
  });

  room.fillAiBots("host-1", 4);
  const started = room.startGame("host-1");
  assert.equal(started.success, true);
  const firstHand = room.nextHand("host-1");
  assert.equal(firstHand.success, true);

  const clientState = room.buildClientState("host-1");
  assert.equal(clientState.street, "preflop");
  assert.equal(STREET_LABELS[clientState.street], "翻牌前 Pre-flop");
  assert.ok(clientState.actionLog.length >= 2); // Blinds posted
  for (const action of clientState.actionLog) {
    assert.ok(STREET_LABELS[action.street]);
    assert.equal(action.street, "preflop");
  }

  room.cleanup();
});
