import test from "node:test";
import assert from "node:assert/strict";
import { MultiplayerRoom } from "../server/multiplayer-room";
import { INITIAL_CHAOS_CHARACTERS } from "../lib/poker/chaos-types";
import { resolveCharacterAvatar, DEFAULT_AVATAR_PLACEHOLDER } from "../lib/poker/chaos-avatars";

test("MultiplayerRoom: Chaos Mode character selection and avatar assignment for God of Gamblers", () => {
  let broadcastCount = 0;
  const room = new MultiplayerRoom(
    "CH01",
    "host-1",
    "房主",
    () => { broadcastCount += 1; },
    { chaosMode: true, minPlayers: 2 }
  );

  // Join a second player
  room.join("player-2", "玩家2");
  const p2Seat = room.seats.find((s) => s?.id === "player-2")!;
  p2Seat.isReady = true;

  // Add 2 AI bots to reach 4 players
  room.addAiBot("host-1", 2);
  room.addAiBot("host-1", 3);

  // Host starts game in Chaos Mode
  const startRes = room.startGame("host-1");
  assert.equal(startRes.success, true);
  assert.equal(room.status, "playing");

  // Verify that room is in Character Selection phase
  assert.ok(room.characterSelectionState);
  assert.equal(room.characterSelectionState.active, true);
  assert.equal(room.characterSelectionState.availableCharacters.length, 4);

  // Check client state during character selection
  const hostState = room.buildClientState("host-1");
  assert.equal(hostState.chaosMode, true);
  assert.ok(hostState.characterSelection);
  assert.equal(hostState.characterSelection.active, true);
  assert.equal(hostState.characterSelection.availableCharacters.length, 4);

  // Host selects character 2 (龙五 · 神枪保镖)
  const pickRes1 = room.selectCharacter("host-1", "chaos_char_2");
  assert.equal(pickRes1.success, true);
  const hostSeat = room.seats.find((s) => s?.id === "host-1")!;
  assert.equal(hostSeat.characterId, "chaos_char_2");

  // Player 2 selects character 2 as well
  const pickRes2 = room.selectCharacter("player-2", "chaos_char_2");
  assert.equal(pickRes2.success, true);

  // Character selection finishes
  assert.equal(room.characterSelectionState, undefined);
  assert.equal(room.firstHandPending, true);

  // Check public seats
  const finalState = room.buildClientState("host-1");
  const publicHostSeat = finalState.seats.find((s) => s.id === "host-1")!;
  assert.equal(publicHostSeat.characterId, "chaos_char_2");
  assert.equal(publicHostSeat.characterName, "龙五");
  assert.equal(publicHostSeat.characterAvatar, "/avatars/chaos_char_2.svg");
  assert.equal(publicHostSeat.characterThemeColor, "#38bdf8");
  assert.equal(publicHostSeat.characterFallbackText, "五");

  const publicP2Seat = finalState.seats.find((s) => s.id === "player-2")!;
  assert.equal(publicP2Seat.characterId, "chaos_char_2");
  assert.equal(publicP2Seat.characterAvatar, "/avatars/chaos_char_2.svg");

  // AI bots have no characters
  const publicAiSeat = finalState.seats.find((s) => s.id?.startsWith("bot-"))!;
  assert.equal(publicAiSeat.characterId, undefined);
  assert.equal(publicAiSeat.characterAvatar, undefined);

  room.cleanup();
});

test("Chaos Avatar: resolveCharacterAvatar handles valid, missing, and fallback avatars safely", () => {
  assert.equal(
    resolveCharacterAvatar({ id: "chaos_char_1", avatar: "/avatars/characters/custom.png" }),
    "/avatars/characters/custom.png"
  );
  assert.equal(
    resolveCharacterAvatar({ id: "chaos_char_1", avatar: "" }),
    "/avatars/chaos_char_1.svg"
  );
  assert.equal(resolveCharacterAvatar(null), DEFAULT_AVATAR_PLACEHOLDER);
  assert.equal(resolveCharacterAvatar({ id: "unknown", avatar: "" }), DEFAULT_AVATAR_PLACEHOLDER);
});

test("高进【变牌】成功与限定技消耗，以及【朱古力】主动投入>=10BB重置变牌", () => {
  const room = new MultiplayerRoom(
    "GJ01",
    "host-1",
    "高进",
    () => {},
    { chaosMode: true, minPlayers: 2, bigBlind: 10 }
  );

  room.join("p2", "对手");
  room.seats[1]!.isReady = true;
  room.addAiBot("host-1", 2);
  room.addAiBot("host-1", 3);

  room.startGame("host-1");
  room.selectCharacter("host-1", "chaos_char_1"); // 高进
  room.selectCharacter("p2", "chaos_char_2");

  room.nextHand();
  assert.ok(room.gameState);

  const hostIndex = room.gameState.seats.findIndex((s) => s.id === "host-1");
  const hostSeat = room.gameState.seats[hostIndex];

  // 确保方块3不在公共牌也不在任何玩家手中，也不在已消耗牌中，放在剩余未发牌堆中
  room.gameState.community = room.gameState.community.filter((c) => !(c.rank === 3 && c.suit === "d"));
  for (const s of room.gameState.seats) {
    s.holeCards = s.holeCards.filter((c) => !(c.rank === 3 && c.suit === "d"));
    while (s.holeCards.length < 2) {
      s.holeCards.push({ rank: 7, suit: "s", id: `temp-${s.holeCards.length}` });
    }
  }
  const d3 = { rank: 3 as const, suit: "d" as const, id: "3d" };
  room.gameState.deck = room.gameState.deck.filter((c) => !(c.rank === 3 && c.suit === "d"));
  room.gameState.deck.push({ ...d3 });

  // 设为河牌圈且轮到高进行动
  room.gameState.street = "river";
  room.gameState.activeIndex = hostIndex;

  // 1. 发动【变牌】成功
  const useRes = room.useSkill("host-1", "skill_bianpai", undefined, 0);
  assert.equal(useRes.success, true);
  assert.ok(useRes.broadcastText?.includes("成功"));
  assert.equal(hostSeat.holeCards[0].rank, 3);
  assert.equal(hostSeat.holeCards[0].suit, "d");

  // 客户端状态中【变牌】显示已用尽
  const clientState = room.buildClientState("host-1");
  const heroSeat = clientState.seats.find((s) => s.id === "host-1")!;
  assert.equal(heroSeat.skillStates?.["skill_bianpai"]?.used, true);
  assert.equal(heroSeat.skillStates?.["skill_bianpai"]?.available, false);

  // 再次发动失败
  const secondUse = room.useSkill("host-1", "skill_bianpai", undefined, 0);
  assert.equal(secondUse.success, false);

  // 2. 测试【朱古力】：模拟高进主动投入达到 100 (10BB)
  room.gameState.actionLog.push({
    index: room.gameState.actionLog.length,
    playerId: "host-1",
    playerName: "高进",
    type: "raise",
    amount: 100, // 10BB
    to: 100,
    street: "river",
    potBefore: 200,
    timestamp: Date.now(),
  });

  // 触发结算
  room.gameState.status = "complete";
  room.gameState.lastResult = {
    potTotal: 250,
    awards: [{ amount: 250, winnerIds: ["host-1"], label: "Main Pot" }],
    winnerIds: ["host-1"],
    showdown: true,
    summary: "高进获胜",
    winnerSettlements: [{ playerId: "host-1", playerName: "高进", contributed: 100, received: 250, net: 150 }],
    playerSettlements: [{ playerId: "host-1", playerName: "高进", contributed: 100, received: 250, net: 150, isWinner: true, folded: false }],
  };

  // 调用内部结算技能处理
  (room as any).checkHandCompletion();

  // 验证【变牌】被朱古力重新恢复就绪！
  const refreshedSeat = room.seats.find((s) => s?.id === "host-1")!;
  assert.equal(refreshedSeat.usedSkills?.includes("skill_bianpai"), false);

  room.cleanup();
});

test("高进【变牌】在方块3已在场时变牌失败，但仍计入发动", () => {
  const room = new MultiplayerRoom(
    "GJ02",
    "host-1",
    "高进",
    () => {},
    { chaosMode: true, minPlayers: 2, bigBlind: 10 }
  );

  room.join("p2", "对手");
  room.seats[1]!.isReady = true;
  room.addAiBot("host-1", 2);
  room.addAiBot("host-1", 3);

  room.startGame("host-1");
  room.selectCharacter("host-1", "chaos_char_1"); // 高进
  room.selectCharacter("p2", "chaos_char_2");

  room.nextHand();
  assert.ok(room.gameState);

  const hostIndex = room.gameState.seats.findIndex((s) => s.id === "host-1");
  const hostSeat = room.gameState.seats[hostIndex];
  const origCard = { ...hostSeat.holeCards[0] };

  // 人为将方块3放入对手的手牌中（即便对手弃牌）
  const p2Seat = room.gameState.seats.find((s) => s.id === "p2")!;
  p2Seat.holeCards[0] = { rank: 3, suit: "d", id: "3d" };
  p2Seat.folded = true; // 即使已弃牌，同样参与判断

  room.gameState.street = "river";
  room.gameState.activeIndex = hostIndex;

  // 发动【变牌】
  const useRes = room.useSkill("host-1", "skill_bianpai", undefined, 0);
  assert.equal(useRes.success, true);
  assert.ok(useRes.broadcastText?.includes("失败"));

  // 底牌未发生改变
  assert.deepEqual(hostSeat.holeCards[0], origCard);

  // 但【变牌】依然视为发动过（限定技耗尽）
  const roomSeat = room.seats.find((s) => s?.id === "host-1")!;
  assert.ok(roomSeat.usedSkills?.includes("skill_bianpai"));

  room.cleanup();
});

test("龙五【枪神】：以跟注进入摊牌并获胜，额外获得 1BB 筹码奖励", () => {
  const room = new MultiplayerRoom(
    "LW01",
    "host-1",
    "龙五",
    () => {},
    { chaosMode: true, minPlayers: 2, bigBlind: 10 }
  );

  room.join("p2", "激进对手");
  room.seats[1]!.isReady = true;
  room.addAiBot("host-1", 2);
  room.addAiBot("host-1", 3);

  room.startGame("host-1");
  room.selectCharacter("host-1", "chaos_char_2"); // 龙五
  room.selectCharacter("p2", "chaos_char_3");

  room.nextHand();
  assert.ok(room.gameState);

  const initialStack = 1000;
  const hostSeat = room.gameState.seats.find((s) => s.id === "host-1")!;
  hostSeat.stack = initialStack;

  // 模拟最后动作：对手下注，龙五跟注 (call)
  room.gameState.actionLog.push({
    index: 0,
    playerId: "p2",
    playerName: "激进对手",
    type: "bet",
    amount: 50,
    to: 50,
    street: "river",
    potBefore: 100,
    timestamp: Date.now(),
  });
  room.gameState.actionLog.push({
    index: 1,
    playerId: "host-1",
    playerName: "龙五",
    type: "call",
    amount: 50,
    to: 50,
    street: "river",
    potBefore: 150,
    timestamp: Date.now(),
  });

  // 摊牌结算：龙五获胜
  room.gameState.status = "complete";
  room.gameState.lastResult = {
    potTotal: 200,
    awards: [{ amount: 200, winnerIds: ["host-1"], label: "Main Pot" }],
    winnerIds: ["host-1"],
    showdown: true,
    summary: "龙五摊牌获胜",
    winnerSettlements: [{ playerId: "host-1", playerName: "龙五", contributed: 50, received: 200, net: 150 }],
    playerSettlements: [{ playerId: "host-1", playerName: "龙五", contributed: 50, received: 200, net: 150, isWinner: true, folded: false }],
  };

  (room as any).checkHandCompletion();

  // 龙五筹码获得额外 1BB (10)
  const roomSeat = room.seats.find((s) => s?.id === "host-1")!;
  assert.equal(roomSeat.stack, initialStack + 10);

  room.cleanup();
});

test("陈刀仔【学艺】随机换牌且下一手重置，【翻本】短码净收益补贴", () => {
  const room = new MultiplayerRoom(
    "CDZ01",
    "host-1",
    "陈刀仔",
    () => {},
    { chaosMode: true, minPlayers: 2, bigBlind: 10 }
  );

  room.join("p2", "对手");
  room.seats[1]!.isReady = true;
  room.addAiBot("host-1", 2);
  room.addAiBot("host-1", 3);

  room.startGame("host-1");
  room.selectCharacter("host-1", "chaos_char_3"); // 陈刀仔
  room.selectCharacter("p2", "chaos_char_1");

  // 1. 测试短码开局：令陈刀仔筹码为 80 (< 10BB = 100)
  const cdzRoomSeat = room.seats.find((s) => s?.id === "host-1")!;
  cdzRoomSeat.stack = 80;

  room.nextHand();
  assert.ok(room.gameState);
  assert.ok(room.fanbenEligiblePlayerIds.has("host-1"));

  const hostIndex = room.gameState.seats.findIndex((s) => s.id === "host-1");
  const hostSeat = room.gameState.seats[hostIndex];
  const origCard = { ...hostSeat.holeCards[0] };

  // 河牌圈发动【学艺】
  room.gameState.street = "river";
  room.gameState.activeIndex = hostIndex;

  const useRes = room.useSkill("host-1", "skill_xueyi", undefined, 0);
  assert.equal(useRes.success, true);
  assert.ok(useRes.broadcastText?.includes("学艺"));

  // 底牌已被替换为新牌
  assert.notDeepEqual(hostSeat.holeCards[0], origCard);

  // 本手再次发动受限
  const secondUse = room.useSkill("host-1", "skill_xueyi", undefined, 0);
  assert.equal(secondUse.success, false);

  // 2. 测试【翻本】结算：净收益 30 (3BB)，获得等额补贴 +30
  room.gameState.status = "complete";
  room.gameState.lastResult = {
    potTotal: 60,
    awards: [{ amount: 60, winnerIds: ["host-1"], label: "Main Pot" }],
    winnerIds: ["host-1"],
    showdown: true,
    summary: "刀仔获胜",
    winnerSettlements: [{ playerId: "host-1", playerName: "陈刀仔", contributed: 30, received: 60, net: 30 }],
    playerSettlements: [{ playerId: "host-1", playerName: "陈刀仔", contributed: 30, received: 60, net: 30, isWinner: true, folded: false }],
  };

  const stackBefore = hostSeat.stack;
  (room as any).checkHandCompletion();

  // 补贴了 30
  assert.equal(hostSeat.stack, stackBefore + 30);

  // 3. 开始下一手，验证【学艺】已自动重置恢复
  room.nextHand();
  assert.equal(cdzRoomSeat.usedSkills?.includes("skill_xueyi"), false);

  room.cleanup();
});

test("高义【显影】翻前可见未来公共牌第一张，【出千】始终可见牌堆底3张牌", () => {
  const room = new MultiplayerRoom(
    "GY01",
    "host-1",
    "高义",
    () => {},
    { chaosMode: true, minPlayers: 2, bigBlind: 10 }
  );

  room.join("p2", "对手");
  room.seats[1]!.isReady = true;
  room.addAiBot("host-1", 2);
  room.addAiBot("host-1", 3);

  room.startGame("host-1");
  room.selectCharacter("host-1", "chaos_char_4"); // 高义
  room.selectCharacter("p2", "chaos_char_1");

  room.nextHand();
  assert.ok(room.gameState);
  assert.equal(room.gameState.street, "preflop");

  // 翻前高义的客户端状态
  const gyState = room.buildClientState("host-1");

  // 【显影】：翻前下一张公共牌
  assert.ok(gyState.chaosPeekCards);
  assert.equal(gyState.chaosPeekCards.length, 1);
  const peekCard = gyState.chaosPeekCards[0];
  // 校验其为 deckIndex + 1 的翻牌第一张
  assert.equal(peekCard.id, room.gameState.deck[room.gameState.deckIndex + 1].id);

  // 【出千】：牌堆底 3 张牌始终可见
  assert.ok(gyState.chaosDeckBottomCards);
  assert.equal(gyState.chaosDeckBottomCards.length, 3);
  const bottom3 = room.gameState.deck.slice(-3);
  assert.deepEqual(gyState.chaosDeckBottomCards.map((c) => c.id), bottom3.map((c) => c.id));

  // 对手（非高义）无权窥探
  const p2State = room.buildClientState("p2");
  assert.equal(p2State.chaosPeekCards, undefined);
  assert.equal(p2State.chaosDeckBottomCards, undefined);

  room.cleanup();
});

test("MultiplayerRoom: Thinking countdown timers and expiresAt broadcast for Chaos Mode character selection and gameplay", () => {
  const room = new MultiplayerRoom(
    "CH_TIMER",
    "host-1",
    "房主",
    () => {},
    { chaosMode: true, minPlayers: 2, regularTurnSeconds: 20, aiDelayMs: 1500 }
  );

  room.join("p2", "玩家2");
  room.seats[1]!.isReady = true;
  room.addAiBot("host-1", 2);
  room.addAiBot("host-1", 3);

  // 1. 开始游戏进入选角阶段
  room.startGame("host-1");
  const selectState = room.buildClientState("host-1");
  assert.ok(selectState.characterSelection);
  assert.equal(selectState.characterSelection.active, true);
  assert.ok(selectState.characterSelection.timeRemaining > 0);
  assert.ok(selectState.characterSelection.expiresAt > Date.now());

  // 2. 完成选将并开启第一手
  room.selectCharacter("host-1", "chaos_char_1");
  room.selectCharacter("p2", "chaos_char_2");
  const nextRes = room.nextHand();
  assert.equal(nextRes.success, true);

  // 3. 牌局进行中思考时间与截止时间正常下发
  const playState = room.buildClientState("host-1");
  assert.ok(playState.activeIndex >= 0);
  assert.ok(playState.turnExpiresAt > Date.now());
  assert.ok(playState.turnTimeRemaining > 0);
  assert.ok(playState.turnTotalTime > 0);

  room.cleanup();
});
