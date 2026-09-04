import { shuffledDeck } from "./cards";
import { compareScores, evaluateSeven } from "./evaluator";
import type {
  BotViewState,
  DecisionTrace,
  Difficulty,
  FullGameState,
  GameAction,
  LegalActions,
  LoggedActionType,
  PlayerActionInput,
  PlayerSettlement,
  PlayerViewState,
  PublicSeatState,
  ReviewSnapshot,
  SeatState,
  Street,
} from "./types";

const POSITION_BY_COUNT: Record<number, string[]> = {
  2: ["BTN/SB", "BB"],
  3: ["BTN", "SB", "BB"],
  4: ["BTN", "SB", "BB", "CO"],
  5: ["BTN", "SB", "BB", "HJ", "CO"],
  6: ["BTN", "SB", "BB", "UTG", "HJ", "CO"],
  7: ["BTN", "SB", "BB", "UTG", "LJ", "HJ", "CO"],
  8: ["BTN", "SB", "BB", "UTG", "UTG+1", "LJ", "HJ", "CO"],
};

export interface CreateTableOptions {
  smallBlind: number;
  bigBlind: number;
  difficulty: Difficulty;
  seats: SeatState[];
}

export interface StartHandOptions {
  refillBustedBots?: boolean;
  requireFundedHuman?: boolean;
}

function cloneState(state: FullGameState): FullGameState {
  return structuredClone(state);
}

function occupied(state: FullGameState, index: number): boolean {
  if (index < 0 || index >= state.seats.length) return false;
  const seat = state.seats[index];
  return Boolean(seat && (seat.stack > 0 || seat.committedHand > 0));
}

function nextIndex(state: FullGameState, from: number, predicate: (seat: SeatState) => boolean): number {
  for (let offset = 1; offset <= state.seats.length; offset += 1) {
    const index = (from + offset + state.seats.length) % state.seats.length;
    if (predicate(state.seats[index])) return index;
  }
  return -1;
}

function nextOccupied(state: FullGameState, from: number): number {
  return nextIndex(state, from, (_, index?: number) => true);
}

function findNextOccupied(state: FullGameState, from: number): number {
  for (let offset = 1; offset <= state.seats.length; offset += 1) {
    const index = (from + offset + state.seats.length) % state.seats.length;
    if (occupied(state, index)) return index;
  }
  return -1;
}

function nextActor(state: FullGameState, from: number): number {
  return nextIndex(state, from, (seat) => !seat.folded && !seat.allIn && seat.stack > 0);
}

export function potSize(state: Pick<FullGameState, "seats">): number {
  return state.seats.reduce((sum, seat) => sum + seat.committedHand, 0);
}

export function createTable(options: CreateTableOptions): FullGameState {
  if (options.seats.length < 2 || options.seats.length > 8) throw new Error("A table needs two to eight seats");
  if (options.smallBlind <= 0 || options.bigBlind <= options.smallBlind) throw new Error("Invalid blinds");
  return {
    handId: "waiting",
    handNumber: 0,
    seed: "waiting",
    smallBlind: options.smallBlind,
    bigBlind: options.bigBlind,
    difficulty: options.difficulty,
    deck: [],
    deckIndex: 0,
    community: [],
    seats: structuredClone(options.seats),
    buttonIndex: -1,
    activeIndex: -1,
    street: "preflop",
    status: "waiting",
    currentBet: 0,
    minRaise: options.bigBlind,
    actionLog: [],
  };
}

function recordAction(
  state: FullGameState,
  seat: SeatState,
  type: LoggedActionType,
  amount: number,
  potBefore: number,
  trace?: DecisionTrace,
  thinkingMeta?: { thinkingSeconds?: number; thinkingText?: string; isDeepThinking?: boolean },
): void {
  const action: GameAction = {
    index: state.actionLog.length,
    playerId: seat.id,
    playerName: seat.name,
    type,
    amount,
    to: seat.committedStreet,
    street: state.street,
    potBefore,
    timestamp: Date.now(),
    thinkingSeconds: thinkingMeta?.thinkingSeconds,
    thinkingText: thinkingMeta?.thinkingText,
    isDeepThinking: thinkingMeta?.isDeepThinking,
    decisionTrace: trace,
  };
  state.actionLog.push(action);
  seat.lastAction = type;
  seat.lastActionThinkingSeconds = thinkingMeta?.thinkingSeconds;
  seat.lastActionThinkingText = thinkingMeta?.thinkingText;
}

function contribute(state: FullGameState, seat: SeatState, requested: number): number {
  const amount = Math.max(0, Math.min(seat.stack, Math.floor(requested)));
  seat.stack -= amount;
  seat.committedStreet += amount;
  seat.committedHand += amount;
  if (seat.stack === 0) seat.allIn = true;
  return amount;
}

function postBlind(state: FullGameState, index: number, amount: number, type: "small-blind" | "big-blind"): void {
  const seat = state.seats[index];
  const before = potSize(state);
  const posted = contribute(state, seat, amount);
  recordAction(state, seat, type, posted, before);
}

export function startHand(previous: FullGameState, seed: string, options: StartHandOptions = {}): FullGameState {
  const state = cloneState(previous);
  const buyIn = state.bigBlind * 100;
  const refillBustedBots = options.refillBustedBots ?? true;
  const requireFundedHuman = options.requireFundedHuman ?? true;
  for (const seat of state.seats) {
    if (refillBustedBots && !seat.isHuman && seat.stack === 0) seat.stack = buyIn;
    seat.holeCards = [];
    seat.folded = seat.stack === 0;
    seat.allIn = false;
    seat.committedStreet = 0;
    seat.committedHand = 0;
    seat.acted = false;
    seat.raiseLocked = false;
    seat.lastAction = undefined;
  }
  const activeCount = state.seats.filter((_, index) => occupied(state, index)).length;
  if (activeCount < 2) throw new Error("Not enough funded seats to start a hand");
  if (requireFundedHuman && state.seats.find((seat) => seat.isHuman)?.stack === 0) throw new Error("Human player needs chips");

  state.handNumber += 1;
  state.handId = `${state.handNumber}-${seed}`;
  state.seed = seed;
  state.deck = shuffledDeck(seed);
  state.deckIndex = 0;
  state.community = [];
  state.street = "preflop";
  state.status = "playing";
  state.currentBet = 0;
  state.minRaise = state.bigBlind;
  state.lastAggressorId = undefined;
  state.actionLog = [];
  state.lastResult = undefined;
  state.buttonIndex = findNextOccupied(state, state.buttonIndex);

  const sbIndex = activeCount === 2 ? state.buttonIndex : findNextOccupied(state, state.buttonIndex);
  const bbIndex = findNextOccupied(state, sbIndex);
  let dealIndex = findNextOccupied(state, state.buttonIndex);
  for (let round = 0; round < 2; round += 1) {
    for (let dealt = 0; dealt < activeCount; dealt += 1) {
      state.seats[dealIndex].holeCards.push(state.deck[state.deckIndex]);
      state.deckIndex += 1;
      dealIndex = findNextOccupied(state, dealIndex);
    }
  }

  postBlind(state, sbIndex, state.smallBlind, "small-blind");
  postBlind(state, bbIndex, state.bigBlind, "big-blind");
  state.currentBet = Math.max(...state.seats.map((seat) => seat.committedStreet));
  state.activeIndex = activeCount === 2 ? state.buttonIndex : nextActor(state, bbIndex);
  return state;
}

export function getPosition(state: FullGameState, seatIndex: number): string {
  if (state.buttonIndex < 0 || state.buttonIndex >= state.seats.length || !state.seats[state.buttonIndex]) {
    return `座位${seatIndex + 1}`;
  }
  const activeIndexes: number[] = [];
  let cursor = state.buttonIndex;
  for (let count = 0; count < state.seats.length; count += 1) {
    if (occupied(state, cursor) || (state.seats[cursor] && state.seats[cursor].holeCards.length > 0)) {
      activeIndexes.push(cursor);
    }
    cursor = (cursor + 1) % state.seats.length;
  }
  const position = activeIndexes.indexOf(seatIndex);
  return POSITION_BY_COUNT[activeIndexes.length]?.[position] ?? `座位${seatIndex + 1}`;
}

export function getLegalActions(state: FullGameState, playerId: string): LegalActions {
  const index = state.seats.findIndex((seat) => seat.id === playerId);
  const seat = state.seats[index];
  if (!seat || state.status !== "playing" || state.activeIndex !== index || seat.folded || seat.allIn) {
    return { canFold: false, canCheck: false, canCall: false, canBet: false, canRaise: false, canAllIn: false, toCall: 0, callAmount: 0, minBetTo: 0, minRaiseTo: 0, maxTo: 0 };
  }
  const toCall = Math.max(0, state.currentBet - seat.committedStreet);
  const maxTo = seat.committedStreet + seat.stack;
  const minRaiseTo = state.currentBet + state.minRaise;
  return {
    canFold: toCall > 0,
    canCheck: toCall === 0,
    canCall: toCall > 0 && seat.stack > 0,
    canBet: state.currentBet === 0 && maxTo > 0,
    canRaise: state.currentBet > 0 && !seat.raiseLocked && maxTo > state.currentBet,
    canAllIn: seat.stack > 0 && (!seat.raiseLocked || maxTo <= state.currentBet),
    toCall,
    callAmount: Math.min(toCall, seat.stack),
    minBetTo: Math.min(maxTo, state.bigBlind),
    minRaiseTo: Math.min(maxTo, minRaiseTo),
    maxTo,
  };
}

function bettingRoundComplete(state: FullGameState): boolean {
  const actors = state.seats.filter((seat) => !seat.folded && !seat.allIn);
  return actors.every((seat) => seat.acted && seat.committedStreet === state.currentBet);
}

function remainingPlayers(state: FullGameState): SeatState[] {
  return state.seats.filter((seat) => !seat.folded);
}

function burn(state: FullGameState): void {
  state.deckIndex += 1;
}

function dealStreet(state: FullGameState, street: Exclude<Street, "preflop" | "showdown" | "complete">): void {
  burn(state);
  const count = street === "flop" ? 3 : 1;
  for (let index = 0; index < count; index += 1) {
    state.community.push(state.deck[state.deckIndex]);
    state.deckIndex += 1;
  }
  state.street = street;
}

function clockwiseWinnerOrder(state: FullGameState, winnerIds: string[]): string[] {
  const set = new Set(winnerIds);
  const ordered: string[] = [];
  let index = state.buttonIndex;
  for (let count = 0; count < state.seats.length; count += 1) {
    index = (index + 1) % state.seats.length;
    if (set.has(state.seats[index].id)) ordered.push(state.seats[index].id);
  }
  return ordered;
}

export function settleShowdown(state: FullGameState): FullGameState {
  state.street = "showdown";
  const total = potSize(state);
  const contributions = new Map(state.seats.map((seat) => [seat.id, seat.committedHand]));
  const payouts = new Map<string, number>();
  const levels = [...new Set(state.seats.map((seat) => seat.committedHand).filter((amount) => amount > 0))].sort((a, b) => a - b);
  const awards = [];
  const allWinners = new Set<string>();
  let previousLevel = 0;

  for (const level of levels) {
    const contributors = state.seats.filter((seat) => seat.committedHand >= level);
    const amount = (level - previousLevel) * contributors.length;
    previousLevel = level;
    const eligible = contributors.filter((seat) => !seat.folded);
    if (amount <= 0 || eligible.length === 0) continue;
    const scored = eligible.map((seat) => ({ seat, score: evaluateSeven([...seat.holeCards, ...state.community]) }));
    const best = scored.reduce((winner, contender) => compareScores(contender.score, winner.score) > 0 ? contender : winner);
    const winners = scored.filter((entry) => compareScores(entry.score, best.score) === 0).map((entry) => entry.seat.id);
    const ordered = clockwiseWinnerOrder(state, winners);
    const share = Math.floor(amount / winners.length);
    let odd = amount % winners.length;
    for (const id of ordered) {
      const seat = state.seats.find((entry) => entry.id === id)!;
      const received = share + (odd > 0 ? 1 : 0);
      seat.stack += received;
      payouts.set(id, (payouts.get(id) ?? 0) + received);
      if (odd > 0) odd -= 1;
      allWinners.add(id);
    }
    awards.push({ amount, winnerIds: winners, label: awards.length === 0 ? "主池" : `边池 ${awards.length}` });
  }

  const names = [...allWinners].map((id) => state.seats.find((seat) => seat.id === id)?.name).filter(Boolean).join("、");
  const playerSettlements: PlayerSettlement[] = state.seats
    .filter((seat) => (contributions.get(seat.id) ?? 0) > 0 || (payouts.get(seat.id) ?? 0) > 0 || seat.holeCards.length > 0)
    .map((seat) => {
      const received = payouts.get(seat.id) ?? 0;
      const contributed = contributions.get(seat.id) ?? 0;
      return {
        playerId: seat.id,
        playerName: seat.name,
        contributed,
        received,
        net: received - contributed,
        isWinner: allWinners.has(seat.id),
        folded: seat.folded,
      };
    })
    .sort((a, b) => b.net - a.net || b.received - a.received);

  state.lastResult = {
    potTotal: total,
    awards,
    winnerIds: [...allWinners],
    winnerSettlements: [...allWinners].map((id) => {
      const seat = state.seats.find((entry) => entry.id === id)!;
      const received = payouts.get(id) ?? 0;
      const contributed = contributions.get(id) ?? 0;
      return { playerId: id, playerName: seat.name, contributed, received, net: received - contributed };
    }),
    playerSettlements,
    summary: `${names} 在摊牌赢得 ${total} 筹码`,
    showdown: true,
  };
  for (const seat of state.seats) {
    seat.committedHand = 0;
    seat.committedStreet = 0;
  }
  state.street = "complete";
  state.status = "complete";
  state.activeIndex = -1;
  return state;
}

export function settleUncontested(state: FullGameState, winner: SeatState): FullGameState {
  const total = potSize(state);
  const contributions = new Map(state.seats.map((seat) => [seat.id, seat.committedHand]));
  const contributed = winner.committedHand;
  winner.stack += total;
  const playerSettlements: PlayerSettlement[] = state.seats
    .filter((seat) => (contributions.get(seat.id) ?? 0) > 0 || seat.id === winner.id || seat.holeCards.length > 0)
    .map((seat) => {
      const received = seat.id === winner.id ? total : 0;
      const cont = contributions.get(seat.id) ?? 0;
      return {
        playerId: seat.id,
        playerName: seat.name,
        contributed: cont,
        received,
        net: received - cont,
        isWinner: seat.id === winner.id,
        folded: seat.folded,
      };
    })
    .sort((a, b) => b.net - a.net || b.received - a.received);

  state.lastResult = {
    potTotal: total,
    awards: [{ amount: total, winnerIds: [winner.id], label: "底池" }],
    winnerIds: [winner.id],
    winnerSettlements: [{
      playerId: winner.id,
      playerName: winner.name,
      contributed,
      received: total,
      net: total - contributed,
    }],
    playerSettlements,
    summary: `${winner.name} 无需摊牌赢得 ${total} 筹码`,
    showdown: false,
  };
  for (const seat of state.seats) {
    seat.committedHand = 0;
    seat.committedStreet = 0;
  }
  state.street = "complete";
  state.status = "complete";
  state.activeIndex = -1;
  return state;
}

function runOut(state: FullGameState): FullGameState {
  if (state.community.length === 0) dealStreet(state, "flop");
  if (state.community.length === 3) dealStreet(state, "turn");
  if (state.community.length === 4) dealStreet(state, "river");
  return settleShowdown(state);
}

function advanceAfterRound(state: FullGameState): FullGameState {
  if (state.street === "river") return settleShowdown(state);
  const actionCapable = state.seats.filter((seat) => !seat.folded && !seat.allIn && seat.stack > 0);
  if (actionCapable.length <= 1) return runOut(state);

  for (const seat of state.seats) {
    seat.committedStreet = 0;
    seat.acted = false;
    seat.raiseLocked = false;
    if (!seat.folded) {
      seat.lastAction = undefined;
      seat.lastActionThinkingSeconds = undefined;
      seat.lastActionThinkingText = undefined;
    }
  }
  state.currentBet = 0;
  state.minRaise = state.bigBlind;
  state.lastAggressorId = undefined;
  if (state.street === "preflop") dealStreet(state, "flop");
  else if (state.street === "flop") dealStreet(state, "turn");
  else dealStreet(state, "river");
  state.activeIndex = nextActor(state, state.buttonIndex);
  return state;
}

export function applyAction(
  stateInput: FullGameState,
  input: PlayerActionInput,
  trace?: DecisionTrace,
  thinkingMeta?: { thinkingSeconds?: number; thinkingText?: string; isDeepThinking?: boolean },
): FullGameState {
  const state = cloneState(stateInput);
  if (state.status !== "playing" || state.activeIndex < 0) throw new Error("No active betting decision");
  const seat = state.seats[state.activeIndex];
  const legal = getLegalActions(state, seat.id);
  const before = potSize(state);
  const toCall = legal.toCall;
  let amount = 0;

  if (input.type === "fold") {
    seat.folded = true;
  } else if (input.type === "check") {
    if (!legal.canCheck) throw new Error("Cannot check facing a bet");
  } else if (input.type === "call") {
    if (!legal.canCall) throw new Error("Call is not legal");
    amount = contribute(state, seat, legal.callAmount);
  } else {
    const maxTo = legal.maxTo;
    let target = input.type === "all-in" ? maxTo : Math.floor(input.amount ?? 0);
    target = Math.min(target, maxTo);
    if (target <= seat.committedStreet) throw new Error("Bet target must add chips");
    const oldCurrentBet = state.currentBet;
    const isRaise = target > oldCurrentBet;
    const minimum = oldCurrentBet === 0 ? state.bigBlind : oldCurrentBet + state.minRaise;
    const isFullRaise = target >= minimum;
    if (oldCurrentBet === 0 && target < state.bigBlind && target !== maxTo) throw new Error("Bet is below the minimum");
    if (oldCurrentBet > 0 && isRaise && !isFullRaise && target !== maxTo) throw new Error("Raise is below the minimum");
    if (oldCurrentBet > 0 && isRaise && seat.raiseLocked) throw new Error("Action was not reopened for a raise");
    if (!isRaise && target < oldCurrentBet && target !== maxTo) throw new Error("Use call to match the bet");

    amount = contribute(state, seat, target - seat.committedStreet);
    if (seat.committedStreet > oldCurrentBet) {
      const raiseSize = seat.committedStreet - oldCurrentBet;
      const actedBefore = new Map(state.seats.map((entry) => [entry.id, entry.acted]));
      state.currentBet = seat.committedStreet;
      state.lastAggressorId = seat.id;
      for (const other of state.seats) {
        if (other.id === seat.id || other.folded || other.allIn) continue;
        if (other.committedStreet < state.currentBet) other.acted = false;
        if (isFullRaise) other.raiseLocked = false;
        else if (actedBefore.get(other.id)) other.raiseLocked = true;
      }
      if (isFullRaise) state.minRaise = raiseSize;
    }
  }

  seat.acted = true;
  const loggedType: LoggedActionType = input.type === "all-in" ? "all-in" : input.type;
  recordAction(state, seat, loggedType, amount, before, trace, thinkingMeta);

  const remaining = remainingPlayers(state);
  if (remaining.length === 1) return settleUncontested(state, remaining[0]);
  if (bettingRoundComplete(state)) return advanceAfterRound(state);
  state.activeIndex = nextActor(state, state.activeIndex);
  if (state.activeIndex < 0) return runOut(state);
  return state;
}

function publicSeat(state: FullGameState, seat: SeatState, index: number): PublicSeatState {
  return {
    id: seat.id,
    name: seat.name,
    isHuman: seat.isHuman,
    stack: seat.stack,
    folded: seat.folded,
    allIn: seat.allIn,
    committedStreet: seat.committedStreet,
    committedHand: seat.committedHand,
    lastAction: seat.lastAction,
    lastActionThinkingSeconds: seat.lastActionThinkingSeconds,
    lastActionThinkingText: seat.lastActionThinkingText,
    position: getPosition(state, index),
    stats: structuredClone(seat.stats),
  };
}

function visibleActions(state: FullGameState): GameAction[] {
  return state.actionLog.map(({ decisionTrace: _hidden, ...action }) => action);
}

export function buildPlayerView(state: FullGameState, playerId: string): PlayerViewState {
  const seat = state.seats.find((entry) => entry.id === playerId);
  if (!seat) throw new Error("Unknown player");
  return {
    viewKind: "player",
    viewerId: playerId,
    holeCards: structuredClone(seat.holeCards),
    handId: state.handId,
    handNumber: state.handNumber,
    seed: state.seed,
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    community: structuredClone(state.community),
    seats: state.seats.map((entry, index) => publicSeat(state, entry, index)),
    buttonIndex: state.buttonIndex,
    activeIndex: state.activeIndex,
    street: state.street,
    currentBet: state.currentBet,
    minRaise: state.minRaise,
    actionLog: visibleActions(state),
    legalActions: getLegalActions(state, playerId),
  };
}

export function buildBotView(state: FullGameState, botId: string): BotViewState {
  const seat = state.seats.find((entry) => entry.id === botId);
  if (!seat || seat.isHuman) throw new Error("Unknown bot");
  return {
    ...buildPlayerView(state, botId),
    viewKind: "bot",
  };
}

export function buildReviewSnapshot(state: FullGameState): ReviewSnapshot {
  return {
    handId: state.handId,
    seed: state.seed,
    community: structuredClone(state.community),
    seats: state.seats.map((seat, index) => ({ ...publicSeat(state, seat, index), holeCards: structuredClone(seat.holeCards) })),
    actionLog: structuredClone(state.actionLog),
    result: structuredClone(state.lastResult),
  };
}

export const ACTION_LABELS: Record<LoggedActionType, string> = {
  fold: "弃牌",
  check: "过牌",
  call: "跟注",
  bet: "下注",
  raise: "加注",
  "all-in": "全下",
  "small-blind": "小盲",
  "big-blind": "大盲",
};

export const STREET_LABELS: Record<Street, string> = {
  preflop: "翻前",
  flop: "翻牌",
  turn: "转牌",
  river: "河牌",
  showdown: "摊牌",
  complete: "本手结束",
};
