import { INITIAL_CHAOS_CHARACTERS } from "../lib/poker/chaos-types";
import type { ChaosCharacter, ChaosSelectionState, ChaosSkill, PlayerSkillStatus } from "../lib/poker/chaos-types";
import { CardPoolManager } from "../lib/poker/state-machine";
import { BOT_NAMES, chooseBotAction, createBotPersonality } from "../lib/poker/ai";
import {
  applyAction,
  buildBotView,
  createTable,
  getLegalActions,
  getPosition,
  potSize,
  settleUncontested,
  startHand,
} from "../lib/poker/engine";
import { makeSeed } from "../lib/poker/rng";
import { EMPTY_STATS } from "../lib/poker/types";
import type { Card, FullGameState, PlayerActionInput, SeatState } from "../lib/poker/types";
import { calculateGodModeEquities } from "./multiplayer-equity";
import type {
  GodModeEquityItem,
  MultiplayerPublicSeat,
  MultiplayerTableState,
  RoomConfig,
  RoomSeatPlayer,
  RoomSpectator,
} from "./multiplayer-types";

export class MultiplayerRoom {
  public readonly code: string;
  public config: RoomConfig;
  public hostId: string;
  public status: "lobby" | "playing" = "lobby";
  public seats: (RoomSeatPlayer | null)[] = new Array(8).fill(null);
  public spectators: Map<string, RoomSpectator> = new Map();
  public gameState: FullGameState | null = null;
  public handResultSummary?: string;
  public timeBankActive = false;
  public firstHandPending = false;
  public characterSelectionState?: ChaosSelectionState;
  private characterSelectionTimer: NodeJS.Timeout | null = null;
  public cannotFoldPlayerIds: Set<string> = new Set();
  public fanbenEligiblePlayerIds: Set<string> = new Set();

  public turnStartedAt = 0;
  private turnTimer: NodeJS.Timeout | null = null;
  private aiTimer: NodeJS.Timeout | null = null;
  private turnExpiresAt = 0;
  private turnTotalTime = 20;
  private autoNextHandTimer: NodeJS.Timeout | null = null;
  private onStateChange: () => void;

  public formatThinking(seconds: number): { thinkingSeconds: number; thinkingText: string; isDeepThinking: boolean } {
    const sec = Math.max(1, Math.round(seconds));
    const isDeep = sec > this.config.regularTurnSeconds / 2;
    const thinkingText = isDeep ? `已深度思考${sec}s` : `已思考${sec}s`;
    return { thinkingSeconds: sec, thinkingText, isDeepThinking: isDeep };
  }

  constructor(code: string, hostId: string, hostName: string, onStateChange: () => void, config?: Partial<RoomConfig>) {
    this.code = code;
    this.hostId = hostId;
    this.onStateChange = onStateChange;
    const regSeconds = config?.regularTurnSeconds ?? 20;
    this.config = {
      smallBlind: config?.smallBlind ?? 5,
      bigBlind: config?.bigBlind ?? 10,
      startingStack: config?.startingStack ?? 1000,
      minPlayers: config?.minPlayers ?? 4,
      regularTurnSeconds: regSeconds,
      initialTimeBankCards: config?.initialTimeBankCards ?? 2,
      timeBankExtensionSeconds: regSeconds, // 延时卡增加长度等于单次常规思考时间的一倍
      aiDelayMs: config?.aiDelayMs,
      chaosMode: Boolean(config?.chaosMode),
    };
    this.turnTotalTime = regSeconds;

    // Host takes seat 0 by default
    this.seats[0] = {
      id: hostId,
      name: hostName || "房主",
      seatIndex: 0,
      stack: this.config.startingStack,
      isReady: true,
      isHost: true,
      connected: true,
      timeBankCards: this.config.initialTimeBankCards,
    };
  }

  public get seatedCount(): number {
    return this.seats.filter((s): s is RoomSeatPlayer => s !== null).length;
  }

  public get readyCount(): number {
    return this.seats.filter((s): s is RoomSeatPlayer => s !== null && (s.isHost || s.isReady)).length;
  }

  public join(clientId: string, name: string, asSpectator = false): { isHost: boolean; isSpectator: boolean } {
    // Check if client is already seated
    const existingSeat = this.seats.find((s) => s?.id === clientId);
    if (existingSeat) {
      existingSeat.connected = true;
      existingSeat.name = name || existingSeat.name;
      this.broadcast();
      return { isHost: existingSeat.isHost, isSpectator: false };
    }

    // Check if client is already spectator
    if (this.spectators.has(clientId)) {
      const spec = this.spectators.get(clientId)!;
      spec.connected = true;
      spec.name = name || spec.name;
      this.broadcast();
      return { isHost: this.hostId === clientId, isSpectator: true };
    }

    // If game in progress or asSpectator requested, join as spectator
    if (asSpectator || this.status === "playing") {
      this.spectators.set(clientId, {
        id: clientId,
        name: name || `观战者 ${this.spectators.size + 1}`,
        connected: true,
        godMode: false,
      });
      this.broadcast();
      return { isHost: this.hostId === clientId, isSpectator: true };
    }

    // Find empty seat (0..7)
    const emptyIndex = this.seats.findIndex((s) => s === null);
    if (emptyIndex !== -1) {
      const isHost = this.hostId === clientId;
      this.seats[emptyIndex] = {
        id: clientId,
        name: name || `玩家 ${emptyIndex + 1}`,
        seatIndex: emptyIndex,
        stack: this.config.startingStack,
        isReady: isHost, // Host is ready by default
        isHost,
        connected: true,
        timeBankCards: this.config.initialTimeBankCards,
      };
      this.broadcast();
      return { isHost, isSpectator: false };
    }

    // Seats are full (8/8), join as spectator
    this.spectators.set(clientId, {
      id: clientId,
      name: name || `观战者 ${this.spectators.size + 1}`,
      connected: true,
      godMode: false,
    });
    this.broadcast();
    return { isHost: this.hostId === clientId, isSpectator: true };
  }

  public leave(clientId: string): boolean {
    let wasHost = this.hostId === clientId;
    const seatIndex = this.seats.findIndex((s) => s?.id === clientId);

    if (seatIndex !== -1) {
      const seat = this.seats[seatIndex]!;
      // If game is playing, fold player in engine
      if (this.gameState && this.gameState.status === "playing") {
        const gameSeat = this.gameState.seats.find((s) => s.id === clientId);
        if (gameSeat && !gameSeat.folded) {
          // If it was this player's turn, advance by triggering timeout / auto-fold
          if (this.gameState.activeIndex === this.gameState.seats.indexOf(gameSeat)) {
            this.handleTimeout();
          } else {
            gameSeat.folded = true;
            const activeRemaining = this.gameState.seats.filter((s) => !s.folded);
            if (activeRemaining.length === 1) {
              this.gameState = settleUncontested(this.gameState, activeRemaining[0]);
              this.syncPlayerStacks();
              this.checkHandCompletion();
            }
          }
        }
      }
      this.seats[seatIndex] = null;
    }

    this.spectators.delete(clientId);

    // If room has no human players and no spectators, return true to signal cleanup
    const remainingHumans = this.seats.filter((s): s is RoomSeatPlayer => s !== null && !s.isAi);
    const remainingSpectators = Array.from(this.spectators.values());
    if (remainingHumans.length === 0 && remainingSpectators.length === 0) {
      this.cleanup();
      return true;
    }

    // Transfer host if host left (clockwise to next seated human player, or first spectator)
    if (wasHost) {
      let nextHostSeat: RoomSeatPlayer | null = null;
      if (seatIndex !== -1) {
        for (let offset = 1; offset < 8; offset += 1) {
          const checkIndex = (seatIndex + offset) % 8;
          const candidate = this.seats[checkIndex];
          if (candidate && !candidate.isAi) {
            nextHostSeat = candidate;
            break;
          }
        }
      } else if (remainingHumans.length > 0) {
        nextHostSeat = remainingHumans[0];
      }

      if (nextHostSeat) {
        nextHostSeat.isHost = true;
        nextHostSeat.isReady = true;
        this.hostId = nextHostSeat.id;
      } else if (remainingSpectators.length > 0) {
        this.hostId = remainingSpectators[0].id;
      }
    }

    this.broadcast();
    return false;
  }

  public transferHost(currentHostId: string, targetId: string): { success: boolean; error?: string } {
    if (this.hostId !== currentHostId) {
      return { success: false, error: "只有房主才能转让房主身份" };
    }
    if (targetId === currentHostId) {
      return { success: false, error: "您已经是房主" };
    }

    const targetSeat = this.seats.find((s) => s?.id === targetId);
    const targetSpectator = this.spectators.get(targetId);
    if (!targetSeat && !targetSpectator) {
      return { success: false, error: "目标玩家不在房间内" };
    }
    if (targetSeat?.isAi) {
      return { success: false, error: "无法将房主身份转让给 AI 机器人" };
    }

    // Reset old host flag and set target host flag
    for (const seat of this.seats) {
      if (seat) {
        if (seat.id === currentHostId) {
          seat.isHost = false;
          seat.isReady = false;
        }
        if (seat.id === targetId) {
          seat.isHost = true;
          seat.isReady = true;
        }
      }
    }

    this.hostId = targetId;
    this.broadcast();
    return { success: true };
  }

  public isIdleBetweenHands(): boolean {
    return (this.status === "lobby" || this.firstHandPending || this.gameState?.status === "complete") && !this.characterSelectionState?.active;
  }

  public takeSeat(clientId: string, targetIndex?: number): boolean {
    if (!this.isIdleBetweenHands()) return false;
    const currentSeatIndex = this.seats.findIndex((s) => s?.id === clientId);
    if (currentSeatIndex !== -1) return true; // already seated

    const spectator = this.spectators.get(clientId);
    if (!spectator) return false;

    let target = targetIndex !== undefined && targetIndex >= 0 && targetIndex < 8 && this.seats[targetIndex] === null
      ? targetIndex
      : this.seats.findIndex((s) => s === null);

    if (target === -1) return false; // no empty seats

    this.spectators.delete(clientId);
    const isHost = this.hostId === clientId;
    this.seats[target] = {
      id: clientId,
      name: spectator.name,
      seatIndex: target,
      stack: this.config.startingStack,
      isReady: isHost,
      isHost,
      connected: true,
      timeBankCards: this.config.initialTimeBankCards,
    };

    this.broadcast();
    return true;
  }

  public standUp(clientId: string): boolean {
    if (!this.isIdleBetweenHands()) return false;
    const seatIndex = this.seats.findIndex((s) => s?.id === clientId);
    if (seatIndex === -1) return false;

    const seat = this.seats[seatIndex]!;
    this.seats[seatIndex] = null;
    this.spectators.set(clientId, {
      id: clientId,
      name: seat.name,
      connected: true,
      godMode: false,
    });

    this.broadcast();
    return true;
  }

  public addAiBot(clientId: string, seatIndex?: number): { success: boolean; error?: string } {
    if (this.hostId !== clientId) {
      return { success: false, error: "只有房主才能添加 AI 机器人" };
    }
    if (!this.isIdleBetweenHands()) {
      return { success: false, error: "牌局进行中无法添加 AI 机器人" };
    }

    let target = seatIndex !== undefined && seatIndex >= 0 && seatIndex < 8 && this.seats[seatIndex] === null
      ? seatIndex
      : this.seats.findIndex((s) => s === null);

    if (target === -1) {
      return { success: false, error: "牌桌已满（8人上限），无法添加更多 AI" };
    }

    const usedNames = new Set(
      this.seats
        .filter((s): s is RoomSeatPlayer => s !== null)
        .map((s) => s.name)
        .concat(Array.from(this.spectators.values()).map((s) => s.name))
    );
    const botName = BOT_NAMES.find((name) => !usedNames.has(name)) ?? `AI-${target + 1}`;
    const botId = `bot-${target + 1}-${Math.random().toString(36).slice(2, 6)}`;

    this.seats[target] = {
      id: botId,
      name: botName,
      seatIndex: target,
      stack: this.config.startingStack,
      isReady: true,
      isHost: false,
      connected: true,
      timeBankCards: 0,
      isAi: true,
    };

    this.broadcast();
    return { success: true };
  }

  public removeAiBot(clientId: string, seatIndex: number): { success: boolean; error?: string } {
    if (this.hostId !== clientId) {
      return { success: false, error: "只有房主才能移除 AI 机器人" };
    }
    if (!this.isIdleBetweenHands()) {
      return { success: false, error: "牌局进行中无法移除 AI 机器人" };
    }

    if (seatIndex < 0 || seatIndex >= 8) {
      return { success: false, error: "无效的座位号" };
    }

    const seat = this.seats[seatIndex];
    if (!seat || !seat.isAi) {
      return { success: false, error: "该座位没有 AI 机器人" };
    }

    this.seats[seatIndex] = null;
    if (this.gameState) {
      this.gameState.seats = this.gameState.seats.filter((s) => s.id !== seat.id);
    }

    this.broadcast();
    return { success: true };
  }

  public fillAiBots(clientId: string, targetCount?: number): { success: boolean; countAdded: number; error?: string } {
    if (this.hostId !== clientId) {
      return { success: false, countAdded: 0, error: "只有房主才能操作 AI 机器人" };
    }
    if (!this.isIdleBetweenHands()) {
      return { success: false, countAdded: 0, error: "牌局进行中无法添加 AI 机器人" };
    }

    const target = targetCount !== undefined
      ? Math.min(8, Math.max(this.config.minPlayers, targetCount))
      : this.config.minPlayers;

    let countAdded = 0;
    while (this.seatedCount < target) {
      const emptyIdx = this.seats.findIndex((s) => s === null);
      if (emptyIdx === -1) break;
      const res = this.addAiBot(clientId, emptyIdx);
      if (!res.success) break;
      countAdded += 1;
    }

    return { success: true, countAdded };
  }

  public clearAllAiBots(clientId: string): { success: boolean; countRemoved: number; error?: string } {
    if (this.hostId !== clientId) {
      return { success: false, countRemoved: 0, error: "只有房主才能操作 AI 机器人" };
    }
    if (!this.isIdleBetweenHands()) {
      return { success: false, countRemoved: 0, error: "牌局进行中无法移除 AI 机器人" };
    }

    let countRemoved = 0;
    for (let i = 0; i < 8; i++) {
      const seat = this.seats[i];
      if (seat && seat.isAi) {
        this.seats[i] = null;
        if (this.gameState) {
          this.gameState.seats = this.gameState.seats.filter((s) => s.id !== seat.id);
        }
        countRemoved += 1;
      }
    }

    if (countRemoved > 0) {
      this.broadcast();
    }
    return { success: true, countRemoved };
  }

  public toggleReady(clientId: string): boolean {
    if (this.status === "playing") return false;
    const seat = this.seats.find((s) => s?.id === clientId);
    if (!seat || seat.isHost) return false; // Host doesn't toggle; host starts

    seat.isReady = !seat.isReady;
    this.broadcast();
    return true;
  }

  public setGodMode(clientId: string, enabled: boolean): void {
    const spec = this.spectators.get(clientId);
    if (spec) {
      spec.godMode = enabled;
      this.broadcast();
    }
  }

  public checkStartGameEligibility(): { canStart: boolean; reason?: string } {
    const seated = this.seats.filter((s): s is RoomSeatPlayer => s !== null);
    if (seated.length < this.config.minPlayers) {
      return {
        canStart: false,
        reason: `房间当前只有 ${seated.length} 人，至少需要 ${this.config.minPlayers} 名玩家入座才能开局`,
      };
    }
    if (seated.length > 8) {
      return { canStart: false, reason: "房间人数超过 8 人上限" };
    }

    const unreadyPlayers = seated.filter((s) => !s.isHost && !s.isReady);
    if (unreadyPlayers.length > 0) {
      const names = unreadyPlayers.map((p) => p.name).join("、");
      return {
        canStart: false,
        reason: `尚有玩家未准备就绪：${names}`,
      };
    }

    return { canStart: true };
  }

  public toggleChaosMode(clientId: string, enabled: boolean): { success: boolean; error?: string } {
    if (this.hostId !== clientId) {
      return { success: false, error: "只有房主才能切换胡闹模式" };
    }
    if (this.status === "playing") {
      return { success: false, error: "牌局进行中无法切换模式" };
    }
    this.config.chaosMode = enabled;
    this.broadcast();
    return { success: true };
  }

  public clearCharacterSelectionTimer(): void {
    if (this.characterSelectionTimer) {
      clearTimeout(this.characterSelectionTimer);
      this.characterSelectionTimer = null;
    }
  }

  public startCharacterSelection(): void {
    this.clearCharacterSelectionTimer();
    const expiresAt = Date.now() + 20000;
    this.characterSelectionState = {
      active: true,
      expiresAt,
      timeRemaining: 20,
      availableCharacters: INITIAL_CHAOS_CHARACTERS,
      selectedMap: {},
    };

    this.characterSelectionTimer = setTimeout(() => {
      this.handleCharacterSelectionTimeout();
    }, 20000);
  }

  public handleCharacterSelectionTimeout(): void {
    if (!this.characterSelectionState || !this.characterSelectionState.active) return;
    this.clearCharacterSelectionTimer();

    // 未选择的真人玩家默认随机或指定第一个角色
    const seatedHumans = this.seats.filter((s): s is RoomSeatPlayer => s !== null && !s.isAi);
    for (const human of seatedHumans) {
      if (!human.characterId) {
        human.characterId = "chaos_char_1";
      }
    }

    this.characterSelectionState = undefined;
    this.initGameTable();
  }

  public selectCharacter(clientId: string, characterId: string): { success: boolean; error?: string } {
    if (!this.characterSelectionState || !this.characterSelectionState.active) {
      return { success: false, error: "当前不在选将阶段" };
    }
    const seat = this.seats.find((s) => s?.id === clientId);
    if (!seat || seat.isAi) {
      return { success: false, error: "只有在座真人玩家才能选择角色" };
    }
    const valid = INITIAL_CHAOS_CHARACTERS.find((c) => c.id === characterId);
    if (!valid) {
      return { success: false, error: "无效的角色" };
    }

    seat.characterId = characterId;
    this.characterSelectionState.selectedMap[clientId] = characterId;

    // 检查是否所有在座真人玩家均已选定角色
    const seatedHumans = this.seats.filter((s): s is RoomSeatPlayer => s !== null && !s.isAi);
    const allSelected = seatedHumans.every((h) => Boolean(h.characterId));
    if (allSelected) {
      this.clearCharacterSelectionTimer();
      this.characterSelectionState = undefined;
      this.initGameTable();
    } else {
      this.broadcast();
    }

    return { success: true };
  }

  public startGame(clientId: string): { success: boolean; error?: string } {
    if (this.hostId !== clientId) {
      return { success: false, error: "只有房主才能开始牌局" };
    }
    const eligibility = this.checkStartGameEligibility();
    if (!eligibility.canStart) {
      return { success: false, error: eligibility.reason };
    }

    if (this.config.chaosMode) {
      this.status = "playing";
      this.startCharacterSelection();
      this.broadcast();
      return { success: true };
    }

    this.initGameTable();
    return { success: true };
  }

  private initGameTable(): void {
    this.status = "playing";
    this.firstHandPending = true;
    this.handResultSummary = undefined;

    // Convert seated players to engine SeatState
    const activeSeated = this.seats.filter((s): s is RoomSeatPlayer => s !== null);
    const engineSeats: SeatState[] = activeSeated.map((player, idx) => ({
      id: player.id,
      name: player.name,
      isHuman: !player.isAi,
      stack: player.stack > 0 ? player.stack : this.config.startingStack,
      holeCards: [],
      folded: false,
      allIn: false,
      committedStreet: 0,
      committedHand: 0,
      acted: false,
      raiseLocked: false,
      personality: player.isAi ? createBotPersonality(makeSeed(`mp-bot-${player.id}`), "standard", idx) : undefined,
      stats: structuredClone(EMPTY_STATS),
    }));

    const table = createTable({
      smallBlind: this.config.smallBlind,
      bigBlind: this.config.bigBlind,
      difficulty: "standard",
      seats: engineSeats,
    });

    this.gameState = table;
    this.clearTurnTimer();
    this.clearAiTimer();
    this.broadcast();
  }

  public handleAction(clientId: string, actionInput: PlayerActionInput): { success: boolean; error?: string } {
    if (!this.gameState || this.gameState.status !== "playing") {
      return { success: false, error: "牌局不在进行状态" };
    }

    const activeSeat = this.gameState.seats[this.gameState.activeIndex];
    if (!activeSeat || activeSeat.id !== clientId) {
      return { success: false, error: "还未轮到你的回合" };
    }

    const now = Date.now();
    const elapsedMs = this.turnStartedAt > 0 ? Math.max(0, now - this.turnStartedAt) : 0;
    const thinkingMeta = this.formatThinking(elapsedMs / 1000);

    if (actionInput.type === "fold" && this.cannotFoldPlayerIds.has(clientId)) {
      return { success: false, error: "受到【断魂】封绝，本轮不能弃牌！" };
    }

    this.clearTurnTimer();
    this.clearAiTimer();
    this.timeBankActive = false;

    const prevStreet = this.gameState.street;
    try {
      this.gameState = applyAction(this.gameState, actionInput, undefined, thinkingMeta);
    } catch (err) {
      this.startTurnTimer();
      return { success: false, error: err instanceof Error ? err.message : "无效的行动" };
    }

    if (this.gameState.street !== prevStreet) {
      this.cannotFoldPlayerIds.clear();
    }

    this.syncPlayerStacks();
    this.checkHandCompletion();
    this.broadcast();
    return { success: true };
  }

  public nextHand(clientId?: string): { success: boolean; error?: string } {
    if (clientId && clientId !== this.hostId) {
      return { success: false, error: "只有房主可以手动触发下一手" };
    }
    if (!this.gameState) {
      return { success: false, error: "牌局未初始化" };
    }

    const currentSeated = this.seats.filter((s): s is RoomSeatPlayer => s !== null);
    if (currentSeated.length < this.config.minPlayers) {
      return {
        success: false,
        error: `当前在座人数不足 ${this.config.minPlayers} 人（当前 ${currentSeated.length} 人），至少需要 ${this.config.minPlayers} 人在座才能开始游戏`,
      };
    }
    if (currentSeated.length > 8) {
      return { success: false, error: "牌桌人数超过 8 人上限" };
    }

    // Refill busted AI bots so they don't block next hand
    for (const player of currentSeated) {
      if (player.isAi && player.stack <= 0) {
        player.stack = this.config.startingStack;
      }
    }

    const fundedPlayers = currentSeated.filter((s) => s.stack > 0);
    if (fundedPlayers.length < this.config.minPlayers) {
      return {
        success: false,
        error: `当前筹码充足玩家不足 ${this.config.minPlayers} 人（仅 ${fundedPlayers.length} 人），请筹码耗尽的玩家补充筹码（Rebuy）后再开始`,
      };
    }

    this.clearAutoNextHandTimer();
    this.clearTurnTimer();
    this.clearAiTimer();
    this.timeBankActive = false;
    this.handResultSummary = undefined;
    this.firstHandPending = false;

    // Synchronize engine seats with room seats (maintaining clockwise order around table)
    const prevButtonPlayerId = this.gameState.seats[this.gameState.buttonIndex]?.id;
    const newEngineSeats: SeatState[] = currentSeated.map((player, idx) => {
      const existing = this.gameState!.seats.find((s) => s.id === player.id);
      if (existing) {
        existing.name = player.name;
        existing.stack = player.stack > 0 ? player.stack : this.config.startingStack;
        existing.isHuman = !player.isAi;
        if (player.isAi && !existing.personality) {
          existing.personality = createBotPersonality(makeSeed(`mp-bot-${player.id}`), "standard", idx);
        }
        return existing;
      }
      return {
        id: player.id,
        name: player.name,
        isHuman: !player.isAi,
        stack: player.stack > 0 ? player.stack : this.config.startingStack,
        holeCards: [],
        folded: false,
        allIn: false,
        committedStreet: 0,
        committedHand: 0,
        acted: false,
        raiseLocked: false,
        personality: player.isAi ? createBotPersonality(makeSeed(`mp-bot-${player.id}`), "standard", idx) : undefined,
        stats: structuredClone(EMPTY_STATS),
      };
    });
    this.gameState.seats = newEngineSeats;

    if (this.gameState.handNumber > 0 && this.gameState.buttonIndex >= 0) {
      const prevButtonPlayerId = this.gameState.seats[this.gameState.buttonIndex]?.id;
      if (prevButtonPlayerId) {
        const foundIdx = newEngineSeats.findIndex((s) => s.id === prevButtonPlayerId);
        if (foundIdx !== -1) {
          this.gameState.buttonIndex = foundIdx;
        } else {
          this.gameState.buttonIndex = this.gameState.buttonIndex % newEngineSeats.length;
        }
      }
    } else {
      this.gameState.buttonIndex = -1;
    }

    this.cannotFoldPlayerIds.clear();
    this.fanbenEligiblePlayerIds.clear();

    if (this.config.chaosMode) {
      const bb = this.config.bigBlind;
      for (const roomSeat of this.seats) {
        if (roomSeat) {
          // 陈刀仔【翻本】：一手牌开始时，若筹码少于 10BB 则获得翻本补贴资格
          if (roomSeat.characterId === "chaos_char_3" && roomSeat.stack < 10 * bb) {
            this.fanbenEligiblePlayerIds.add(roomSeat.id);
          }
          // 陈刀仔【学艺】：每手限一次，新开手牌时重置
          if (roomSeat.usedSkills) {
            roomSeat.usedSkills = roomSeat.usedSkills.filter((sId) => sId !== "skill_xueyi");
          }
        }
      }
    }

    try {
      this.gameState = startHand(this.gameState, makeSeed("lan-hand"), {
        refillBustedBots: true,
        requireFundedHuman: false,
      });

      this.startTurnTimer();
      this.broadcast();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "无法开始下一手" };
    }
  }

  public rebuy(clientId: string, amount?: number): boolean {
    const buyIn = amount ?? this.config.startingStack;
    const seat = this.seats.find((s) => s?.id === clientId);
    if (seat) {
      seat.stack = buyIn;
      if (this.gameState) {
        const gameSeat = this.gameState.seats.find((s) => s.id === clientId);
        if (gameSeat && gameSeat.stack === 0 && (this.gameState.status === "complete" || gameSeat.folded)) {
          gameSeat.stack = buyIn;
        }
      }
      this.broadcast();
      return true;
    }
    return false;
  }

  public useSkill(
    clientId: string,
    skillId: string,
    targetPlayerId?: string,
    targetCardIndex?: number,
  ): { success: boolean; error?: string; broadcastText?: string } {
    if (!this.config.chaosMode) {
      return { success: false, error: "当前房间未开启胡闹模式" };
    }
    if (!this.gameState || this.gameState.status !== "playing") {
      return { success: false, error: "牌局尚未开始" };
    }
    const seat = this.seats.find((s) => s?.id === clientId);
    if (!seat || !seat.characterId) {
      return { success: false, error: "你尚未选择出战角色" };
    }

    const char = INITIAL_CHAOS_CHARACTERS.find((c) => c.id === seat.characterId);
    if (!char) {
      return { success: false, error: "未找到角色定义" };
    }

    const skill = char.skills.find((s) => s.id === skillId);
    if (!skill) {
      return { success: false, error: "该角色没有此技能" };
    }

    if (!seat.usedSkills) {
      seat.usedSkills = [];
    }

    if (skill.type === "limited" && seat.usedSkills.includes(skillId)) {
      return { success: false, error: `限定技【${skill.name}】本局已发动过，无法再次使用` };
    }

    let effectBroadcast = "";

    if (skillId === "skill_bianpai") {
      if (this.gameState.street !== "river") {
        return { success: false, error: "【变牌】只能在翻开河牌后发动" };
      }
      const activeSeat = this.gameState.seats[this.gameState.activeIndex];
      if (!activeSeat || activeSeat.id !== clientId) {
        return { success: false, error: "【变牌】只能在轮到你行动时发动" };
      }
      const heroSeat = this.gameState.seats.find((s) => s.id === clientId);
      if (!heroSeat || heroSeat.holeCards.length === 0) {
        return { success: false, error: "底牌无效" };
      }

      // 无论成败均视为发动过【变牌】
      if (!seat.usedSkills.includes("skill_bianpai")) {
        seat.usedSkills.push("skill_bianpai");
      }

      // 校验方块3：若方块3已出现在公共牌中，或已被发给任意玩家（已弃牌玩家的底牌同样参与判断），则变牌失败
      const inPlayCards = [
        ...this.gameState.community,
        ...this.gameState.seats.flatMap((s) => s.holeCards),
      ];
      const diamond3InPlay = inPlayCards.some((c) => c.rank === 3 && c.suit === "d");

      if (diamond3InPlay) {
        effectBroadcast = `❌【${seat.name}】尝试发动限定技【变牌】，但【♦3】已被其他玩家持有或已在公共牌中，变牌失败！`;
      } else {
        const cardIdx = targetCardIndex !== undefined && targetCardIndex >= 0 && targetCardIndex < heroSeat.holeCards.length
          ? targetCardIndex
          : 0;
        CardPoolManager.transformCard(this.gameState, clientId, cardIdx, { rank: 3, suit: "d" });
        effectBroadcast = `✨【${seat.name}】发动限定技【变牌】成功！将第 ${cardIdx + 1} 张底牌变幻为【♦3】！`;
      }
    } else if (skillId === "skill_xueyi") {
      if (this.gameState.street !== "river") {
        return { success: false, error: "【学艺】只能在翻开河牌后发动" };
      }
      const activeSeat = this.gameState.seats[this.gameState.activeIndex];
      if (!activeSeat || activeSeat.id !== clientId) {
        return { success: false, error: "【学艺】只能在轮到你行动时发动" };
      }
      const heroSeat = this.gameState.seats.find((s) => s.id === clientId);
      if (!heroSeat || heroSeat.holeCards.length === 0) {
        return { success: false, error: "底牌无效" };
      }
      if (seat.usedSkills.includes("skill_xueyi")) {
        return { success: false, error: "【学艺】每手限发动一次，本手已使用过" };
      }

      // 未使用牌指当前未出现在任何玩家底牌及公共牌中的牌
      const inPlayCards = [
        ...this.gameState.community,
        ...this.gameState.seats.flatMap((s) => s.holeCards),
      ];
      const inPlayIds = new Set(inPlayCards.map((c) => c.id));
      const unusedCards = this.gameState.deck.filter((c) => !inPlayIds.has(c.id));
      if (unusedCards.length === 0) {
        return { success: false, error: "牌库中暂无可用剩余牌" };
      }

      const pickedCard = unusedCards[Math.floor(Math.random() * unusedCards.length)];
      const cardIdx = targetCardIndex !== undefined && targetCardIndex >= 0 && targetCardIndex < heroSeat.holeCards.length
        ? targetCardIndex
        : 0;
      const oldCard = heroSeat.holeCards[cardIdx];
      heroSeat.holeCards[cardIdx] = { ...pickedCard };

      // 维护牌库一致性：将替换掉的牌放入牌堆
      const deckIdx = this.gameState.deck.findIndex((c) => c.id === pickedCard.id);
      if (deckIdx !== -1) {
        this.gameState.deck[deckIdx] = { ...oldCard };
      }

      seat.usedSkills.push("skill_xueyi");
      effectBroadcast = `🎲【${seat.name}】发动【学艺】：将第 ${cardIdx + 1} 张底牌替换为牌库中的随机未使用牌！`;
    } else {
      return { success: false, error: "该技能为常驻锁定技，无需手动发动" };
    }

    if (effectBroadcast && this.gameState) {
      const potBefore = this.gameState.seats.reduce((sum, s) => sum + s.committedHand, 0);
      this.gameState.actionLog.push({
        index: this.gameState.actionLog.length,
        playerId: seat.id,
        playerName: seat.name,
        type: "call",
        amount: 0,
        to: 0,
        street: this.gameState.street,
        potBefore,
        timestamp: Date.now(),
        thinkingText: effectBroadcast,
      });
    }

    this.broadcast();
    return { success: true, broadcastText: effectBroadcast };
  }

  public buildClientState(clientId: string): MultiplayerTableState {
    const isHost = this.hostId === clientId;
    const isSpectator = this.spectators.has(clientId);
    const spectator = this.spectators.get(clientId);
    const godMode = isSpectator && Boolean(spectator?.godMode);

    const eligibility = this.checkStartGameEligibility();

    // Map public seats
    const publicSeats: MultiplayerPublicSeat[] = this.seats.map((roomSeat, index) => {
      if (!roomSeat) {
        return {
          id: `empty-${index}`,
          name: `座位 ${index + 1}`,
          position: "",
          stack: 0,
          committedStreet: 0,
          committedHand: 0,
          folded: true,
          allIn: false,
          acted: false,
          isHuman: true,
          isAi: false,
          isHero: false,
          holeCards: [],
          stats: structuredClone(EMPTY_STATS),
          isReady: false,
          isHost: false,
          connected: false,
          timeBankCards: 0,
        };
      }

      const gameSeat = this.gameState?.seats.find((s) => s.id === roomSeat.id);
      const isHero = roomSeat.id === clientId;

      // Determine visible hole cards with anti-cheat protection:
      // - If client is hero: reveal own hole cards
      // - If client is spectator AND godMode: reveal all active cards
      // Determine visible hole cards:
      // - If client is hero: reveal own hole cards
      // - If client is spectator AND godMode: reveal all cards
      // - If game reached showdown/complete: reveal showdown cards
      // - If player folded: reveal folded cards (they are dead cards and will not be drawn again)
      const isShowdown =
        (this.gameState?.street === "showdown" || this.gameState?.status === "complete") &&
        (this.gameState?.lastResult ? this.gameState.lastResult.showdown : true);
      const isFolded = Boolean(gameSeat?.folded);
      let holeCards = (gameSeat?.holeCards ?? []).map((c) => ({ ...c }));

      if (!isHero && !godMode) {
        if (!isShowdown && !isFolded) {
          // Mask other active players' hole cards if hand is still in progress and they have not folded
          holeCards = [];
        }
      }

        let lastActionThinkingSeconds = gameSeat?.lastActionThinkingSeconds;
        let lastActionThinkingText = gameSeat?.lastActionThinkingText;
        if (gameSeat?.folded && !lastActionThinkingText && this.gameState) {
          for (let i = this.gameState.actionLog.length - 1; i >= 0; i--) {
            const act = this.gameState.actionLog[i];
            if (act.playerId === roomSeat.id && act.type === "fold") {
              lastActionThinkingSeconds = act.thinkingSeconds;
              lastActionThinkingText = act.thinkingText;
              break;
            }
          }
        }

        const char = roomSeat.characterId ? INITIAL_CHAOS_CHARACTERS.find((c) => c.id === roomSeat.characterId) : undefined;
        const characterSkills = char?.skills ?? [];
        const skillStates: Record<string, PlayerSkillStatus> = {};

        for (const skill of characterSkills) {
          const used = roomSeat.usedSkills?.includes(skill.id) ?? false;
          let available = false;
          if (skill.type === "locked") {
            available = true;
          } else if (skill.type === "limited" || skill.type === "active") {
            if (!used && this.gameState && this.gameState.status === "playing") {
              const isSeatTurn = this.gameState.activeIndex >= 0 && this.gameState.seats[this.gameState.activeIndex]?.id === roomSeat.id;
              if (skill.id === "skill_bianpai" && this.gameState.street === "river" && isSeatTurn) {
                available = true;
              } else if (skill.id === "skill_xueyi" && this.gameState.street === "river" && isSeatTurn) {
                available = true;
              }
            }
          }
          skillStates[skill.id] = {
            used,
            available,
            usagesCount: used ? 1 : 0,
          };
        }

        return {
          id: roomSeat.id,
          name: roomSeat.name,
          position: gameSeat ? this.getPositionName(gameSeat.id) : "",
          stack: gameSeat?.stack ?? roomSeat.stack,
          committedStreet: gameSeat?.committedStreet ?? 0,
          committedHand: gameSeat?.committedHand ?? 0,
          folded: gameSeat?.folded ?? false,
          allIn: gameSeat?.allIn ?? false,
          acted: gameSeat?.acted ?? false,
          lastAction: gameSeat?.lastAction,
          lastActionThinkingSeconds,
          lastActionThinkingText,
          isHuman: !roomSeat.isAi,
          isAi: Boolean(roomSeat.isAi),
          isHero,
          holeCards,
          stats: gameSeat?.stats ? structuredClone(gameSeat.stats) : structuredClone(EMPTY_STATS),
          isReady: roomSeat.isReady,
          isHost: roomSeat.isHost,
          connected: roomSeat.connected,
          timeBankCards: roomSeat.timeBankCards,
          characterId: roomSeat.characterId,
          characterAvatar: char?.avatar,
          characterName: char?.name,
          characterTitle: char?.title,
          characterThemeColor: char?.themeColor,
          characterFallbackText: char?.avatarFallbackText,
          characterSkills,
          skillStates,
        };
      });

    // Spectator list
    const spectatorsList = Array.from(this.spectators.values()).map((s) => ({
      id: s.id,
      name: s.name,
    }));

    // Legal actions for hero
    const legalActions = this.gameState && this.gameState.status === "playing"
      ? getLegalActions(this.gameState, clientId)
      : {
          canFold: false,
          canCheck: false,
          canCall: false,
          canBet: false,
          canRaise: false,
          canAllIn: false,
          toCall: 0,
          callAmount: 0,
          minBetTo: 0,
          minRaiseTo: 0,
          maxTo: 0,
        };

    if (this.cannotFoldPlayerIds.has(clientId)) {
      legalActions.canFold = false;
    }

    // My own hole cards
    const heroGameSeat = this.gameState?.seats.find((s) => s.id === clientId);
    const myHoleCards = heroGameSeat?.holeCards ?? [];

    // 锁定技【显影】：在翻前下注轮中，未来翻牌的第一张公共牌对高义可见
    let chaosPeekCards: Card[] | undefined;
    const heroRoomSeat = this.seats.find((s) => s?.id === clientId);
    if (
      this.config.chaosMode &&
      heroRoomSeat?.characterId === "chaos_char_4" &&
      this.gameState &&
      this.gameState.street === "preflop" &&
      this.gameState.deck &&
      this.gameState.deck.length > this.gameState.deckIndex + 1
    ) {
      // 翻牌发牌前会 burn 1 张牌 (deckIndex + 0)，翻牌第 1 张为 deckIndex + 1
      const firstFlopCard = this.gameState.deck[this.gameState.deckIndex + 1];
      if (firstFlopCard) {
        chaosPeekCards = [{ ...firstFlopCard }];
      }
    }

    // 锁定技【出千】：牌堆底的 3 张牌对高义始终可见
    let chaosDeckBottomCards: Card[] | undefined;
    if (
      this.config.chaosMode &&
      heroRoomSeat?.characterId === "chaos_char_4" &&
      this.gameState &&
      this.gameState.deck &&
      this.gameState.deck.length >= 3
    ) {
      chaosDeckBottomCards = this.gameState.deck.slice(-3).map((c) => ({ ...c }));
    }

    // God-mode equity calculation
    let godModeEquities: GodModeEquityItem[] | undefined;
    if (godMode && this.gameState && (this.gameState.status === "playing" || this.gameState.status === "complete")) {
      const contenders = this.gameState.seats.map((seat, index) => ({
        playerId: seat.id,
        playerName: seat.name,
        seatIndex: index,
        holeCards: seat.holeCards,
        isFolded: seat.folded,
      }));
      godModeEquities = calculateGodModeEquities(contenders, this.gameState.community);
    }

    const timeRemaining = Math.max(0, Math.ceil((this.turnExpiresAt - Date.now()) / 1000));
    const myTimeBankCards = heroRoomSeat?.timeBankCards ?? 0;
    const isMyTurn = this.gameState?.status === "playing" && this.gameState.seats[this.gameState.activeIndex]?.id === clientId;
    // Allowed to use extension card only if remaining time <= 5 seconds and cards > 0
    const canUseTimeBank = isMyTurn && myTimeBankCards > 0 && timeRemaining <= 5;

    const buttonPlayerId = this.gameState && this.gameState.buttonIndex >= 0 && this.gameState.buttonIndex < this.gameState.seats.length
      ? this.gameState.seats[this.gameState.buttonIndex]?.id
      : undefined;
    const tableButtonIndex = buttonPlayerId ? this.seats.findIndex((s) => s?.id === buttonPlayerId) : -1;

    const activePlayerId = this.gameState && this.gameState.activeIndex >= 0 && this.gameState.activeIndex < this.gameState.seats.length
      ? this.gameState.seats[this.gameState.activeIndex]?.id
      : undefined;
    const tableActiveIndex = activePlayerId ? this.seats.findIndex((s) => s?.id === activePlayerId) : -1;

    return {
      roomCode: this.code,
      status: this.status,
      config: this.config,
      myId: clientId,
      isHost,
      isSpectator,
      godMode,
      chaosMode: Boolean(this.config.chaosMode),
      characterSelection: this.characterSelectionState
        ? {
            ...this.characterSelectionState,
            timeRemaining: Math.max(0, Math.ceil((this.characterSelectionState.expiresAt - Date.now()) / 1000)),
          }
        : undefined,
      chaosPeekCards,
      chaosDeckBottomCards,
      handNumber: this.gameState?.handNumber ?? 0,
      street: this.gameState?.street ?? "preflop",
      smallBlind: this.gameState?.smallBlind ?? this.config.smallBlind,
      bigBlind: this.gameState?.bigBlind ?? this.config.bigBlind,
      pot: this.gameState ? potSize(this.gameState) : 0,
      currentBet: this.gameState?.currentBet ?? 0,
      minRaise: this.gameState?.minRaise ?? this.config.bigBlind,
      buttonIndex: tableButtonIndex,
      activeIndex: tableActiveIndex,
      community: this.gameState?.community ?? [],
      myHoleCards,
      myTimeBankCards,
      canUseTimeBank,
      timeBankActive: this.timeBankActive,
      seats: publicSeats,
      spectators: spectatorsList,
      actionLog: this.gameState?.actionLog ?? [],
      legalActions,
      turnTimeRemaining: timeRemaining,
      turnTotalTime: this.turnTotalTime || this.config.regularTurnSeconds,
      turnExpiresAt: this.turnExpiresAt,
      godModeEquities,
      canStartGame: eligibility.canStart,
      cannotStartReason: eligibility.reason,
      handResultSummary: this.handResultSummary,
      lastResult: this.gameState?.lastResult,
      firstHandPending: this.firstHandPending,
    };
  }

  public useTimeBank(clientId: string): { success: boolean; error?: string } {
    if (!this.gameState || this.gameState.status !== "playing") {
      return { success: false, error: "牌局未处于进行中" };
    }
    const activeSeat = this.gameState.seats[this.gameState.activeIndex];
    if (!activeSeat || activeSeat.id !== clientId) {
      return { success: false, error: "还未轮到你的回合" };
    }
    const roomSeat = this.seats.find((s) => s?.id === clientId);
    if (!roomSeat || roomSeat.timeBankCards <= 0) {
      return { success: false, error: "你已没有可用的延时卡" };
    }
    const remainingSeconds = Math.ceil((this.turnExpiresAt - Date.now()) / 1000);
    if (remainingSeconds > 5) {
      return { success: false, error: "思考时间剩余 5 秒以内才可使用延时卡" };
    }

    // Deduct 1 extension card and add configured seconds (1x regular turn time)
    roomSeat.timeBankCards -= 1;
    const extensionSec = this.config.regularTurnSeconds;
    this.turnExpiresAt += extensionSec * 1000;
    this.turnTotalTime += extensionSec;
    this.timeBankActive = true;

    // Reset turn timer timeout
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
    }
    const newDelayMs = Math.max(1000, this.turnExpiresAt - Date.now());
    this.turnTimer = setTimeout(() => {
      this.handleTimeout();
    }, newDelayMs);

    this.broadcast();
    return { success: true };
  }

  private getPositionName(playerId: string): string {
    if (!this.gameState || this.gameState.buttonIndex < 0) return "";
    const engineIdx = this.gameState.seats.findIndex((s) => s.id === playerId);
    if (engineIdx === -1) return "";
    return getPosition(this.gameState, engineIdx);
  }

  private clearAiTimer(): void {
    if (this.aiTimer) {
      clearTimeout(this.aiTimer);
      this.aiTimer = null;
    }
  }

  private startTurnTimer(): void {
    this.clearTurnTimer();
    this.clearAiTimer();
    if (!this.gameState || this.gameState.status !== "playing") return;

    const activeSeat = this.gameState.seats[this.gameState.activeIndex];
    if (!activeSeat) return;

    const roomSeat = this.seats.find((s) => s?.id === activeSeat.id);
    const isAi = Boolean(roomSeat?.isAi) || !activeSeat.isHuman;

    this.turnStartedAt = Date.now();

    if (isAi) {
      const delayMs = this.config.aiDelayMs ?? 1500;
      if (delayMs >= 0) {
        this.turnTotalTime = Math.max(1, delayMs / 1000);
        this.turnExpiresAt = Date.now() + delayMs;
        this.aiTimer = setTimeout(() => {
          this.executeAiTurn(activeSeat.id);
        }, delayMs);
      }
    } else {
      this.turnTotalTime = this.config.regularTurnSeconds;
      this.turnExpiresAt = Date.now() + this.config.regularTurnSeconds * 1000;
      this.turnTimer = setTimeout(() => {
        this.handleTimeout();
      }, this.config.regularTurnSeconds * 1000);
    }
  }

  public executeAiTurn(botId: string): void {
    this.clearAiTimer();
    if (!this.gameState || this.gameState.status !== "playing") return;

    const activeSeat = this.gameState.seats[this.gameState.activeIndex];
    if (!activeSeat || activeSeat.id !== botId) return;

    try {
      const botView = buildBotView(this.gameState, botId);
      const personality = activeSeat.personality ?? createBotPersonality(makeSeed(`mp-bot-${botId}`), "standard", this.gameState.activeIndex);
      const decision = chooseBotAction(botView, personality, "standard", undefined, { iterations: 120 });
      this.handleAction(botId, decision.action);
    } catch (err) {
      console.error(`[MultiplayerRoom] AI turn failed for ${botId}:`, err);
      const legal = getLegalActions(this.gameState, botId);
      const fallbackAction: PlayerActionInput = legal.canCheck ? { type: "check" } : { type: "fold" };
      this.handleAction(botId, fallbackAction);
    }
  }

  private clearTurnTimer(): void {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    this.turnExpiresAt = 0;
    this.turnStartedAt = 0;
  }

  private clearAutoNextHandTimer(): void {
    if (this.autoNextHandTimer) {
      clearTimeout(this.autoNextHandTimer);
      this.autoNextHandTimer = null;
    }
  }

  private handleTimeout(): void {
    if (!this.gameState || this.gameState.status !== "playing") return;
    const elapsedSec = this.turnStartedAt > 0
      ? Math.max(1, Math.round((Date.now() - this.turnStartedAt) / 1000))
      : (this.turnTotalTime || this.config.regularTurnSeconds);
    const thinkingMeta = this.formatThinking(elapsedSec);

    this.clearTurnTimer();
    const activeSeat = this.gameState.seats[this.gameState.activeIndex];
    if (!activeSeat) return;

    // Strict auto-fold on thinking time expiration
    const action: PlayerActionInput = { type: "fold" };
    this.timeBankActive = false;

    try {
      this.gameState = applyAction(this.gameState, action, undefined, thinkingMeta);
      this.syncPlayerStacks();
      this.checkHandCompletion();
      this.broadcast();
    } catch (err) {
      console.error("[MultiplayerRoom] Auto-fold on timeout failed:", err);
      try {
        activeSeat.folded = true;
        activeSeat.acted = true;
        activeSeat.lastAction = "fold";
        activeSeat.lastActionThinkingSeconds = thinkingMeta.thinkingSeconds;
        activeSeat.lastActionThinkingText = thinkingMeta.thinkingText;
        const activeRemaining = this.gameState.seats.filter((s) => !s.folded);
        if (activeRemaining.length === 1) {
          this.gameState = settleUncontested(this.gameState, activeRemaining[0]);
        }
        this.syncPlayerStacks();
        this.checkHandCompletion();
        this.broadcast();
      } catch (fallbackErr) {
        console.error("[MultiplayerRoom] Emergency advance failed:", fallbackErr);
      }
    }
  }

  private checkHandCompletion(): void {
    if (!this.gameState) return;

    if (this.gameState.status === "complete") {
      this.clearTurnTimer();
      this.clearAiTimer();
      this.timeBankActive = false;
      if (this.gameState.lastResult) {
        const winnerNames = this.gameState.lastResult.winnerSettlements.map((w) => w.playerName).join("、");
        const pot = this.gameState.lastResult.potTotal;
        const mainWinner = this.gameState.lastResult.playerSettlements?.find((p) => p.isWinner);
        const netStr = mainWinner && this.gameState.lastResult.winnerSettlements.length === 1 && mainWinner.net > 0
          ? `（净胜 +${mainWinner.net}）`
          : "";
        this.handResultSummary = `🏆 本手结算：${winnerNames} 赢得了底池 ${pot} 筹码${netStr}！`;
      }

      // 胡闹德州：一手牌结算触发技能
      if (this.config.chaosMode && this.gameState) {
        const bb = this.config.bigBlind;

        // 1. 高进【朱古力】：本手牌累计主动投入不少于 10BB，且【变牌】已经发动过，重置【变牌】
        for (const seat of this.gameState.seats) {
          const roomSeat = this.seats.find((s) => s?.id === seat.id);
          if (roomSeat?.characterId === "chaos_char_1" && roomSeat.usedSkills?.includes("skill_bianpai")) {
            const voluntaryCommitted = this.gameState.actionLog
              .filter((a) => a.playerId === seat.id && ["call", "bet", "raise", "all-in"].includes(a.type))
              .reduce((sum, a) => sum + a.amount, 0);

            if (voluntaryCommitted >= 10 * bb) {
              roomSeat.usedSkills = roomSeat.usedSkills.filter((sId) => sId !== "skill_bianpai");
              const resetNotice = `🍫【${roomSeat.name}】触发锁定技【朱古力】：本手牌累计主动投入达 ${(voluntaryCommitted / bb).toFixed(1)}BB，限定技【变牌】已恢复就绪！`;
              this.gameState.actionLog.push({
                index: this.gameState.actionLog.length,
                playerId: seat.id,
                playerName: seat.name,
                type: "call",
                amount: 0,
                to: 0,
                street: this.gameState.street,
                potBefore: potSize(this.gameState),
                timestamp: Date.now(),
                thinkingText: resetNotice,
              });
            }
          }
        }

        // 2. 龙五【枪神】：以跟注的方式进入摊牌并最终获胜，额外获得 1BB
        if (this.gameState.lastResult?.showdown) {
          for (const seat of this.gameState.seats) {
            const roomSeat = this.seats.find((s) => s?.id === seat.id);
            if (roomSeat?.characterId === "chaos_char_2" && this.gameState.lastResult.winnerIds.includes(seat.id)) {
              const playerActions = this.gameState.actionLog.filter(
                (a) => a.playerId === seat.id && ["call", "bet", "raise", "all-in", "check"].includes(a.type)
              );
              const lastAction = playerActions[playerActions.length - 1];
              if (lastAction && lastAction.type === "call") {
                const bonus = 1 * bb;
                seat.stack += bonus;
                roomSeat.stack += bonus;
                const qiangshenNotice = `🎯【${roomSeat.name}】触发锁定技【枪神】：以跟注识破对手进入摊牌并获胜，额外获赠 1BB (${bonus}) 筹码！`;
                this.gameState.actionLog.push({
                  index: this.gameState.actionLog.length,
                  playerId: seat.id,
                  playerName: seat.name,
                  type: "call",
                  amount: bonus,
                  to: bonus,
                  street: this.gameState.street,
                  potBefore: potSize(this.gameState),
                  timestamp: Date.now(),
                  thinkingText: qiangshenNotice,
                });
              }
            }
          }
        }

        // 3. 陈刀仔【翻本】：一手牌开始时筹码少于 10BB，结算若获得净收益，额外获得等同于净收益的筹码，至多 5BB
        if (this.gameState.lastResult?.playerSettlements) {
          for (const seat of this.gameState.seats) {
            const roomSeat = this.seats.find((s) => s?.id === seat.id);
            if (roomSeat?.characterId === "chaos_char_3" && this.fanbenEligiblePlayerIds.has(seat.id)) {
              const settlement = this.gameState.lastResult.playerSettlements.find((p) => p.playerId === seat.id);
              if (settlement) {
                const netProfit = settlement.received - settlement.contributed;
                if (netProfit > 0) {
                  const bonus = Math.min(netProfit, 5 * bb);
                  seat.stack += bonus;
                  roomSeat.stack += bonus;
                  const fanbenNotice = `💰【${roomSeat.name}】触发锁定技【翻本】：本手净收益 +${netProfit}，额外获得 +${bonus} 筹码翻本补贴！`;
                  this.gameState.actionLog.push({
                    index: this.gameState.actionLog.length,
                    playerId: seat.id,
                    playerName: seat.name,
                    type: "call",
                    amount: bonus,
                    to: bonus,
                    street: this.gameState.street,
                    potBefore: potSize(this.gameState),
                    timestamp: Date.now(),
                    thinkingText: fanbenNotice,
                  });
                }
              }
            }
          }
          this.fanbenEligiblePlayerIds.clear();
        }

        this.syncPlayerStacks();
      }
      // 不会自动进入下一手，必须等待房主主动点击「开始下一手」
    } else {
      // Continue next turn
      this.startTurnTimer();
    }
  }

  private syncPlayerStacks(): void {
    if (!this.gameState) return;
    for (const seat of this.gameState.seats) {
      const roomSeat = this.seats.find((s) => s?.id === seat.id);
      if (roomSeat) {
        roomSeat.stack = seat.stack;
      }
    }
  }

  private broadcast(): void {
    this.onStateChange();
  }

  public cleanup(): void {
    this.clearTurnTimer();
    this.clearAiTimer();
    this.clearAutoNextHandTimer();
    this.clearCharacterSelectionTimer();
  }
}
