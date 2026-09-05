import { RANK_SYMBOL, SUIT_SYMBOL } from "./cards";
import {
  applyAction as engineApplyAction,
  createTable as engineCreateTable,
  getLegalActions as engineGetLegalActions,
  potSize,
  settleShowdown as engineSettleShowdown,
  settleUncontested as engineSettleUncontested,
  startHand as engineStartHand,
} from "./engine";
import type {
  Card,
  DecisionTrace,
  FullGameState,
  HandResult,
  LegalActions,
  PlayerActionInput,
  Rank,
  SeatState,
  Street,
  Suit,
} from "./types";

/**
 * 细粒度的德州扑克生命周期阶段
 * 解决原引擎中街道直接跨越、缺乏时机点的问题
 */
export type PokerPhase =
  | "idle" // 房间待机
  | "hand_setup" // 初始化洗牌、定庄
  | "blinds_posting" // 大小盲注下注阶段
  | "hole_dealing" // 底牌分发阶段
  | "betting_round" // 街区下注行动轮 (Preflop, Flop, Turn, River)
  | "street_transition" // 销牌并翻开公共牌
  | "showdown" // 摊牌与比牌阶段
  | "settlement" // 底池与各玩家损益结算
  | "hand_complete"; // 本手牌局结束

/**
 * 玩家座位修饰器（用于承载技能 Buff/Debuff 及状态影响）
 */
export interface SeatModifier {
  playerId: string;
  cannotFold?: boolean; // 禁止弃牌标记 (用于干扰技能)
  forceCheckOrCallOnly?: boolean; // 只能看牌或跟注
  peekedUpcomingCards?: Card[]; // 透视到的未来公共牌
  customTags?: Record<string, unknown>; // 技能扩展载荷
}

/**
 * 生命周期钩子 / 拦截器体系
 * 《三国杀》《风声再临》式技能系统在各个时机注入的挂载点
 */
export interface PokerLifecycleHooks {
  /**
   * 手牌开始前（洗牌、重置后，发底牌前）
   */
  beforeHandStart?: (state: FullGameState) => void;

  /**
   * 玩家底牌分发完毕后
   */
  afterHoleDealt?: (state: FullGameState) => void;

  /**
   * 某一街区公共牌翻开前（销牌前）
   */
  beforeStreetDeal?: (state: FullGameState, targetStreet: Exclude<Street, "preflop" | "showdown" | "complete">) => void;

  /**
   * 某一街区公共牌翻开后
   */
  afterStreetDeal?: (state: FullGameState, targetStreet: Exclude<Street, "preflop" | "showdown" | "complete">) => void;

  /**
   * 轮到某位玩家行动开始时
   */
  onTurnStart?: (state: FullGameState, activeIndex: number) => void;

  /**
   * 动态过滤与修饰合法动作（如禁止弃牌、注入技能选项等）
   */
  filterLegalActions?: (state: FullGameState, playerId: string, actions: LegalActions) => LegalActions;

  /**
   * 玩家执行具体动作前（可拦截校验或消耗标记）
   */
  beforeAction?: (state: FullGameState, action: PlayerActionInput) => void;

  /**
   * 玩家执行动作后
   */
  afterAction?: (state: FullGameState, action: PlayerActionInput) => void;

  /**
   * 进入摊牌比牌前（可触发底牌交换、变牌等终局技能）
   */
  beforeShowdown?: (state: FullGameState) => void;

  /**
   * 彩池结算完成时
   */
  afterSettlement?: (state: FullGameState, result: HandResult) => void;
}

/**
 * 卡牌池全局安全管理器
 * 提供卡牌排他性检测、原子换牌、唯一点数变造与安全预视能力，防止重牌与破坏牌堆守恒
 */
export class CardPoolManager {
  /**
   * 获取当前场上所有“已知/已进入流通”的卡牌
   * 包括：各家底牌（无论弃牌与否）、已翻开的公共牌、以及已销的暗牌
   */
  public static getInPlayCards(state: FullGameState): Card[] {
    const cards: Card[] = [];
    // 玩家底牌
    for (const seat of state.seats) {
      cards.push(...seat.holeCards);
    }
    // 公共牌
    cards.push(...state.community);
    // 牌堆中已经被消费过的牌 (包括销牌 burn cards)
    if (state.deck && state.deckIndex > 0) {
      const consumed = state.deck.slice(0, Math.min(state.deckIndex, state.deck.length));
      for (const c of consumed) {
        if (!cards.some((existing) => existing.id === c.id)) {
          cards.push(c);
        }
      }
    }
    return cards;
  }

  /**
   * 严格检测指定点数花色的牌是否已在场上（玩家手中、公共牌或已消耗牌堆）
   */
  public static isCardInPlay(
    state: FullGameState,
    target: Card | { rank: Rank; suit: Suit } | string,
  ): boolean {
    const targetId = typeof target === "string"
      ? target
      : "id" in target
        ? target.id
        : `${RANK_SYMBOL[target.rank]}${target.suit}`;

    const inPlay = this.getInPlayCards(state);
    return inPlay.some((c) => c.id === targetId);
  }

  /**
   * 交换两名玩家的底牌（原子操作）
   */
  public static swapHoleCards(
    state: FullGameState,
    playerAId: string,
    playerBId: string,
  ): { success: boolean; error?: string } {
    const seatA = state.seats.find((s) => s.id === playerAId);
    const seatB = state.seats.find((s) => s.id === playerBId);

    if (!seatA || !seatB) {
      return { success: false, error: "未找到指定的玩家座位" };
    }
    if (seatA.folded || seatB.folded) {
      return { success: false, error: "已弃牌的玩家无法交换底牌" };
    }
    if (seatA.holeCards.length === 0 || seatB.holeCards.length === 0) {
      return { success: false, error: "玩家手中没有底牌可交换" };
    }

    // 原子交换
    const tempCards = [...seatA.holeCards];
    seatA.holeCards = [...seatB.holeCards];
    seatB.holeCards = tempCards;

    return { success: true };
  }

  /**
   * 将玩家的某张底牌变造成指定牌
   * 前提条件：变造后的目标牌绝不能已在场上（不在任何人手中、公共牌或废牌堆中）
   */
  public static transformCard(
    state: FullGameState,
    playerId: string,
    cardIndex: number,
    newCard: { rank: Rank; suit: Suit },
  ): { success: boolean; transformedCard?: Card; error?: string } {
    const seat = state.seats.find((s) => s.id === playerId);
    if (!seat) {
      return { success: false, error: "未找到指定的玩家座位" };
    }
    if (seat.folded) {
      return { success: false, error: "已弃牌玩家无法变造底牌" };
    }
    if (cardIndex < 0 || cardIndex >= seat.holeCards.length) {
      return { success: false, error: "指定的卡牌索引无效" };
    }

    const newId = `${RANK_SYMBOL[newCard.rank]}${newCard.suit}`;
    const targetCard: Card = {
      rank: newCard.rank,
      suit: newCard.suit,
      id: newId,
    };

    // 严谨排他性检查：目标牌是否已在场
    if (this.isCardInPlay(state, targetCard)) {
      return {
        success: false,
        error: `变造失败：卡牌 ${newId} 已经在场上或已被销弃，不可重复出现！`,
      };
    }

    // 从剩余未发的牌堆中，将目标牌与旧卡牌对调，以维持 52 张牌的全局守恒与唯一性
    const oldCard = seat.holeCards[cardIndex];
    if (state.deck) {
      const remainingIdx = state.deck.findIndex(
        (c, idx) => idx >= state.deckIndex && c.id === newId,
      );
      const dealtIdx = state.deck.findIndex(
        (c, idx) => idx < state.deckIndex && c.id === oldCard.id,
      );
      if (remainingIdx !== -1) {
        state.deck[remainingIdx] = oldCard;
      }
      if (dealtIdx !== -1) {
        state.deck[dealtIdx] = targetCard;
      }
    }

    seat.holeCards[cardIndex] = targetCard;
    return { success: true, transformedCard: targetCard };
  }

  /**
   * 安全预视下一张即将翻开的公共牌（用于透视/预知技能）
   * 在德州扑克发牌规则中：
   * 发公共牌前会先销一张牌 (burn card, index+1)，然后发出一张 (index+2)。
   * 如果还没发翻牌 (flop)，第 1 张公共牌位于 deckIndex + 1 (销1发3)。
   * 如果已发翻牌/转牌，下一张公共牌位于 deckIndex + 1。
   * 此方法只读预览，不会推进 deckIndex，不会破坏发牌次序。
   */
  public static peekNextCommunityCard(state: FullGameState): Card | null {
    if (!state.deck || state.deck.length === 0) return null;

    // 销牌位于 deckIndex，下一张翻开的牌位于 deckIndex + 1
    const targetIdx = state.deckIndex + 1;
    if (targetIdx < state.deck.length) {
      return state.deck[targetIdx];
    }
    return null;
  }
}

/**
 * 结构严谨的多人德州扑克分层状态机
 * 1. 严格兼容底层纯函数 engine.ts；
 * 2. 补全阶段演进 (PokerPhase)；
 * 3. 提供可插拔生命周期钩子 (Lifecycle Hooks)；
 * 4. 内置动作修饰管线与卡牌安全操作器。
 */
export class PokerStateMachine {
  private state: FullGameState;
  private phase: PokerPhase = "idle";
  private hooks: PokerLifecycleHooks = {};
  private seatModifiers: Map<string, SeatModifier> = new Map();

  constructor(initialState?: FullGameState, hooks?: PokerLifecycleHooks) {
    if (initialState) {
      this.state = initialState;
      this.phase = this.resolvePhaseFromState(initialState);
    } else {
      this.state = engineCreateTable({
        smallBlind: 5,
        bigBlind: 10,
        difficulty: "standard",
        seats: [],
      });
      this.phase = "idle";
    }
    if (hooks) {
      this.hooks = hooks;
    }
  }

  public getState(): FullGameState {
    return this.state;
  }

  public getPhase(): PokerPhase {
    return this.phase;
  }

  public setHooks(hooks: Partial<PokerLifecycleHooks>): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  public addSeatModifier(playerId: string, modifier: Partial<SeatModifier>): void {
    const existing = this.seatModifiers.get(playerId) ?? { playerId };
    this.seatModifiers.set(playerId, { ...existing, ...modifier });
  }

  public getSeatModifier(playerId: string): SeatModifier | undefined {
    return this.seatModifiers.get(playerId);
  }

  public clearSeatModifiers(playerId?: string): void {
    if (playerId) {
      this.seatModifiers.delete(playerId);
    } else {
      this.seatModifiers.clear();
    }
  }

  /**
   * 计算指定玩家当前的合法动作，并流经动作修饰器管线
   */
  public getLegalActions(playerId: string): LegalActions {
    const rawActions = engineGetLegalActions(this.state, playerId);
    let modified = { ...rawActions };

    // 1. 应用座位状态修饰器（如不能弃牌）
    const seatMod = this.seatModifiers.get(playerId);
    if (seatMod) {
      if (seatMod.cannotFold) {
        modified.canFold = false;
      }
      if (seatMod.forceCheckOrCallOnly) {
        modified.canBet = false;
        modified.canRaise = false;
        modified.canAllIn = false;
      }
    }

    // 2. 触发外部钩子修饰
    if (this.hooks.filterLegalActions) {
      modified = this.hooks.filterLegalActions(this.state, playerId, modified);
    }

    return modified;
  }

  /**
   * 开始新一手牌（驱动 Hand Setup -> Blinds -> Hole Dealing -> Preflop Round）
   */
  public startHand(
    seed: string,
    options?: { refillBustedBots?: boolean; requireFundedHuman?: boolean },
  ): FullGameState {
    this.phase = "hand_setup";
    this.hooks.beforeHandStart?.(this.state);

    // 驱动底层发牌
    this.state = engineStartHand(this.state, seed, options);

    this.phase = "hole_dealing";
    this.hooks.afterHoleDealt?.(this.state);

    this.phase = "betting_round";
    if (this.state.activeIndex >= 0) {
      this.hooks.onTurnStart?.(this.state, this.state.activeIndex);
    }

    return this.state;
  }

  /**
   * 执行玩家下注行动，自动处理轮次推进与各个时机点
   */
  public applyAction(
    action: PlayerActionInput,
    trace?: DecisionTrace,
    thinkingMeta?: { thinkingSeconds?: number; thinkingText?: string; isDeepThinking?: boolean },
  ): FullGameState {
    if (this.state.status !== "playing" || this.state.activeIndex < 0) {
      throw new Error("No active betting decision");
    }

    const currentSeat = this.state.seats[this.state.activeIndex];
    const legal = this.getLegalActions(currentSeat.id);

    // 针对修饰后的动作合法性进行拦截校验
    if (action.type === "fold" && !legal.canFold) {
      throw new Error("当前受到技能或规则限制，不可弃牌！");
    }

    // 动作前钩子
    this.hooks.beforeAction?.(this.state, action);

    const prevStreet = this.state.street;

    // 执行底层逻辑
    this.state = engineApplyAction(this.state, action, trace, thinkingMeta);

    // 动作后钩子
    this.hooks.afterAction?.(this.state, action);

    // 分析状态变迁
    if (this.state.status === "complete") {
      this.phase = "hand_complete";
      if (this.state.lastResult) {
        this.hooks.afterSettlement?.(this.state, this.state.lastResult);
      }
    } else if (this.state.street !== prevStreet) {
      // 街道发生切换 (例如从 preflop 到 flop)
      this.phase = "street_transition";
      const targetStreet = this.state.street as Exclude<Street, "preflop" | "showdown" | "complete">;
      this.hooks.afterStreetDeal?.(this.state, targetStreet);

      this.phase = "betting_round";
      if (this.state.activeIndex >= 0) {
        this.hooks.onTurnStart?.(this.state, this.state.activeIndex);
      }
    } else {
      // 依然在同一轮下注中，轮到下一位行动者
      this.phase = "betting_round";
      if (this.state.activeIndex >= 0) {
        this.hooks.onTurnStart?.(this.state, this.state.activeIndex);
      }
    }

    return this.state;
  }

  private resolvePhaseFromState(state: FullGameState): PokerPhase {
    if (state.status === "waiting") return "idle";
    if (state.status === "complete") return "hand_complete";
    if (state.street === "showdown") return "showdown";
    return "betting_round";
  }
}
