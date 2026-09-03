import assert from "node:assert/strict";
import test from "node:test";
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

