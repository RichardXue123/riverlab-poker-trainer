import {
  applyAction,
  createTable,
  getLegalActions,
  potSize,
  startHand,
} from "../lib/poker/engine";
import { makeSeed } from "../lib/poker/rng";
import { EMPTY_STATS } from "../lib/poker/types";
import type { FullGameState, PlayerActionInput, SeatState } from "../lib/poker/types";
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

  private turnTimer: NodeJS.Timeout | null = null;
  private turnExpiresAt = 0;
  private turnTotalTime = 20;
  private autoNextHandTimer: NodeJS.Timeout | null = null;
  private onStateChange: () => void;

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
          gameSeat.folded = true;
          // If it was this player's turn, advance
          if (this.gameState.activeIndex === this.gameState.seats.indexOf(gameSeat)) {
            this.handleTimeout();
          }
        }
      }
      this.seats[seatIndex] = null;
    }

    this.spectators.delete(clientId);

    // If room is empty, return true to signal cleanup
    const remainingSeated = this.seats.filter((s): s is RoomSeatPlayer => s !== null);
    const remainingSpectators = Array.from(this.spectators.values());
    if (remainingSeated.length === 0 && remainingSpectators.length === 0) {
      this.cleanup();
      return true;
    }

    // Transfer host if host left
    if (wasHost) {
      if (remainingSeated.length > 0) {
        remainingSeated[0].isHost = true;
        remainingSeated[0].isReady = true;
        this.hostId = remainingSeated[0].id;
      } else if (remainingSpectators.length > 0) {
        this.hostId = remainingSpectators[0].id;
      }
    }

    this.broadcast();
    return false;
  }

  public takeSeat(clientId: string, targetIndex?: number): boolean {
    if (this.status === "playing") return false;
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
    if (this.status === "playing") return false;
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

  public startGame(clientId: string): { success: boolean; error?: string } {
    if (this.hostId !== clientId) {
      return { success: false, error: "只有房主才能开始牌局" };
    }
    const eligibility = this.checkStartGameEligibility();
    if (!eligibility.canStart) {
      return { success: false, error: eligibility.reason };
    }

    this.status = "playing";
    this.firstHandPending = true;
    this.handResultSummary = undefined;

    // Convert seated players to engine SeatState
    const activeSeated = this.seats.filter((s): s is RoomSeatPlayer => s !== null);
    const engineSeats: SeatState[] = activeSeated.map((player) => ({
      id: player.id,
      name: player.name,
      isHuman: true,
      stack: player.stack > 0 ? player.stack : this.config.startingStack,
      holeCards: [],
      folded: false,
      allIn: false,
      committedStreet: 0,
      committedHand: 0,
      acted: false,
      raiseLocked: false,
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
    this.broadcast();
    return { success: true };
  }

  public handleAction(clientId: string, actionInput: PlayerActionInput): { success: boolean; error?: string } {
    if (!this.gameState || this.gameState.status !== "playing") {
      return { success: false, error: "牌局不在进行状态" };
    }

    const activeSeat = this.gameState.seats[this.gameState.activeIndex];
    if (!activeSeat || activeSeat.id !== clientId) {
      return { success: false, error: "还未轮到你的回合" };
    }

    this.clearTurnTimer();
    this.timeBankActive = false;

    try {
      this.gameState = applyAction(this.gameState, actionInput);
    } catch (err) {
      this.startTurnTimer();
      return { success: false, error: err instanceof Error ? err.message : "无效的行动" };
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

    this.clearAutoNextHandTimer();
    this.clearTurnTimer();
    this.timeBankActive = false;
    this.handResultSummary = undefined;
    this.firstHandPending = false;

    // Filter funded seats
    const fundedSeats = this.gameState.seats.filter((s) => s.stack > 0);
    if (fundedSeats.length < 2) {
      this.status = "lobby";
      this.gameState = null;
      this.firstHandPending = false;
      this.broadcast();
      return { success: false, error: "存活筹码玩家不足 2 人，牌局已返回大厅" };
    }

    try {
      this.gameState = startHand(this.gameState, makeSeed("lan-hand"), {
        refillBustedBots: false,
        requireFundedHuman: false,
      });
      this.startTurnTimer();
      this.broadcast();
      return { success: true };
    } catch (err) {
      this.status = "lobby";
      this.gameState = null;
      this.broadcast();
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
      // - If game reached showdown/complete: reveal showdown cards
      const isShowdown = this.gameState?.street === "showdown" || this.gameState?.status === "complete";
      let holeCards = (gameSeat?.holeCards ?? []).map((c) => ({ ...c }));

      if (!isHero && !godMode && !isShowdown) {
        // Mask other players' hole cards
        holeCards = [];
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
        isHuman: true,
        isHero,
        holeCards,
        stats: gameSeat?.stats ? structuredClone(gameSeat.stats) : structuredClone(EMPTY_STATS),
        isReady: roomSeat.isReady,
        isHost: roomSeat.isHost,
        connected: roomSeat.connected,
        timeBankCards: roomSeat.timeBankCards,
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

    // My own hole cards
    const heroGameSeat = this.gameState?.seats.find((s) => s.id === clientId);
    const myHoleCards = heroGameSeat?.holeCards ?? [];

    // God-mode equity calculation
    let godModeEquities: GodModeEquityItem[] | undefined;
    if (godMode && this.gameState && this.gameState.status === "playing") {
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
    const heroRoomSeat = this.seats.find((s) => s?.id === clientId);
    const myTimeBankCards = heroRoomSeat?.timeBankCards ?? 0;
    const isMyTurn = this.gameState?.status === "playing" && this.gameState.seats[this.gameState.activeIndex]?.id === clientId;
    // Allowed to use extension card only if remaining time <= 5 seconds and cards > 0
    const canUseTimeBank = isMyTurn && myTimeBankCards > 0 && timeRemaining <= 5;

    return {
      roomCode: this.code,
      status: this.status,
      config: this.config,
      myId: clientId,
      isHost,
      isSpectator,
      godMode,
      handNumber: this.gameState?.handNumber ?? 0,
      street: this.gameState?.street ?? "preflop",
      smallBlind: this.gameState?.smallBlind ?? this.config.smallBlind,
      bigBlind: this.gameState?.bigBlind ?? this.config.bigBlind,
      pot: this.gameState ? potSize(this.gameState) : 0,
      currentBet: this.gameState?.currentBet ?? 0,
      minRaise: this.gameState?.minRaise ?? this.config.bigBlind,
      buttonIndex: this.gameState?.buttonIndex ?? -1,
      activeIndex: this.gameState?.activeIndex ?? -1,
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
    if (!this.gameState) return "";
    const activeSeats = this.gameState.seats.filter((s) => s.stack > 0 || s.committedHand > 0);
    const seatIndex = activeSeats.findIndex((s) => s.id === playerId);
    if (seatIndex === -1) return "";
    const count = activeSeats.length;
    const positions: Record<number, string[]> = {
      2: ["BTN/SB", "BB"],
      3: ["BTN", "SB", "BB"],
      4: ["BTN", "SB", "BB", "CO"],
      5: ["BTN", "SB", "BB", "HJ", "CO"],
      6: ["BTN", "SB", "BB", "UTG", "HJ", "CO"],
      7: ["BTN", "SB", "BB", "UTG", "LJ", "HJ", "CO"],
      8: ["BTN", "SB", "BB", "UTG", "UTG+1", "LJ", "HJ", "CO"],
    };
    return positions[count]?.[seatIndex] ?? `位${seatIndex + 1}`;
  }

  private startTurnTimer(): void {
    this.clearTurnTimer();
    if (!this.gameState || this.gameState.status !== "playing") return;

    this.turnTotalTime = this.config.regularTurnSeconds;
    this.turnExpiresAt = Date.now() + this.config.regularTurnSeconds * 1000;
    this.turnTimer = setTimeout(() => {
      this.handleTimeout();
    }, this.config.regularTurnSeconds * 1000);
  }

  private clearTurnTimer(): void {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    this.turnExpiresAt = 0;
  }

  private clearAutoNextHandTimer(): void {
    if (this.autoNextHandTimer) {
      clearTimeout(this.autoNextHandTimer);
      this.autoNextHandTimer = null;
    }
  }

  private handleTimeout(): void {
    if (!this.gameState || this.gameState.status !== "playing") return;
    const activeSeat = this.gameState.seats[this.gameState.activeIndex];
    if (!activeSeat) return;

    // Strict auto-fold on thinking time expiration
    const action: PlayerActionInput = { type: "fold" };
    this.timeBankActive = false;

    try {
      this.gameState = applyAction(this.gameState, action);
      this.syncPlayerStacks();
      this.checkHandCompletion();
      this.broadcast();
    } catch {
      // Ignore
    }
  }

  private checkHandCompletion(): void {
    if (!this.gameState) return;

    if (this.gameState.status === "complete") {
      this.clearTurnTimer();
      this.timeBankActive = false;
      if (this.gameState.lastResult) {
        const winnerNames = this.gameState.lastResult.winnerSettlements.map((w) => w.playerName).join("、");
        const pot = this.gameState.lastResult.potTotal;
        this.handResultSummary = `🏆 本手结算：${winnerNames} 赢得了底池 ${pot} 筹码！`;
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
    this.clearAutoNextHandTimer();
  }
}
