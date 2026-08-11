import { shuffledDeck } from "./cards";
import { compareScores, evaluateSeven } from "./evaluator";
import { SeededRng } from "./rng";
import type { FullGameState, TournamentStanding, TournamentState } from "./types";

export const TOURNAMENT_STARTING_STACK = 1_000;
export const TOURNAMENT_HANDS_PER_LEVEL = 8;
export const TOURNAMENT_PRIZES: Readonly<Record<number, number>> = {
  1: 5_000,
  2: 2_000,
  3: 1_000,
};

const BLIND_LEVELS = [
  { smallBlind: 5, bigBlind: 10 },
  { smallBlind: 10, bigBlind: 20 },
  { smallBlind: 15, bigBlind: 30 },
  { smallBlind: 25, bigBlind: 50 },
  { smallBlind: 40, bigBlind: 80 },
  { smallBlind: 60, bigBlind: 120 },
  { smallBlind: 100, bigBlind: 200 },
] as const;

export function tournamentBlindsForHand(handNumber: number): { smallBlind: number; bigBlind: number; level: number } {
  const levelIndex = Math.min(BLIND_LEVELS.length - 1, Math.floor((Math.max(1, handNumber) - 1) / TOURNAMENT_HANDS_PER_LEVEL));
  return { ...BLIND_LEVELS[levelIndex], level: levelIndex + 1 };
}

export function createTournamentState(table: FullGameState, id: string): TournamentState {
  return {
    id,
    startingStack: TOURNAMENT_STARTING_STACK,
    entrantIds: table.seats.map((seat) => seat.id),
    eliminationOrder: [],
    standings: [],
    finished: false,
  };
}

function finishIfDecided(state: TournamentState, table: FullGameState): TournamentState {
  const active = table.seats.filter((seat) => state.entrantIds.includes(seat.id) && seat.stack > 0);
  if (active.length !== 1) return state;
  const champion = active[0];
  const names = new Map(table.seats.map((seat) => [seat.id, seat.name]));
  const standings: TournamentStanding[] = [
    { playerId: champion.id, playerName: champion.name, place: 1, prize: TOURNAMENT_PRIZES[1] },
    ...state.eliminationOrder.map((playerId, index) => ({
      playerId,
      playerName: names.get(playerId) ?? playerId,
      place: state.entrantIds.length - index,
      prize: TOURNAMENT_PRIZES[state.entrantIds.length - index] ?? 0,
    })),
  ].sort((a, b) => a.place - b.place);
  return { ...state, standings, finished: true, championId: champion.id };
}

function amountCommittedThisHand(table: FullGameState, playerId: string): number {
  return table.actionLog
    .filter((action) => action.playerId === playerId)
    .reduce((sum, action) => sum + action.amount, 0);
}

export function recordTournamentHand(state: TournamentState, table: FullGameState): TournamentState {
  if (state.finished) return state;
  const known = new Set(state.eliminationOrder);
  const seatIndex = new Map(table.seats.map((seat, index) => [seat.id, index]));
  const newlyEliminated = table.seats
    .filter((seat) => state.entrantIds.includes(seat.id) && seat.stack === 0 && !known.has(seat.id))
    .sort((a, b) => amountCommittedThisHand(table, a.id) - amountCommittedThisHand(table, b.id)
      || (seatIndex.get(a.id) ?? 0) - (seatIndex.get(b.id) ?? 0))
    .map((seat) => seat.id);
  return finishIfDecided({ ...state, eliminationOrder: [...state.eliminationOrder, ...newlyEliminated] }, table);
}

export function tournamentPlace(state: TournamentState, playerId: string): number | undefined {
  const finalPlace = state.standings.find((standing) => standing.playerId === playerId)?.place;
  if (finalPlace) return finalPlace;
  const eliminationIndex = state.eliminationOrder.indexOf(playerId);
  return eliminationIndex >= 0 ? state.entrantIds.length - eliminationIndex : undefined;
}

export function tournamentPrize(state: TournamentState, playerId: string): number {
  return state.standings.find((standing) => standing.playerId === playerId)?.prize ?? 0;
}

function forceFinish(table: FullGameState, state: TournamentState): TournamentState {
  const active = table.seats.filter((seat) => seat.stack > 0).sort((a, b) => b.stack - a.stack || a.id.localeCompare(b.id));
  if (active.length <= 1) return finishIfDecided(state, table);
  const champion = active[0];
  for (const seat of active.slice(1).reverse()) {
    champion.stack += seat.stack;
    seat.stack = 0;
    if (!state.eliminationOrder.includes(seat.id)) state.eliminationOrder.push(seat.id);
  }
  return finishIfDecided(state, table);
}

/**
 * Fast-forward is available only after the human player has busted. Remaining
 * bots play deterministic, seeded heads-up all-in showdowns until one stack
 * owns every tournament chip. It uses real cards and the normal hand evaluator,
 * but intentionally omits the betting animation so the result is immediate.
 */
export function fastForwardTournament(
  currentTable: FullGameState,
  currentState: TournamentState,
  seed: string,
): { table: FullGameState; tournament: TournamentState; simulatedShowdowns: number } {
  const table = structuredClone(currentTable);
  let tournament = recordTournamentHand(structuredClone(currentState), table);
  const rng = new SeededRng(seed);
  let simulatedShowdowns = 0;

  while (!tournament.finished && simulatedShowdowns < 20_000) {
    const active = table.seats.filter((seat) => seat.stack > 0);
    if (active.length <= 1) {
      tournament = finishIfDecided(tournament, table);
      break;
    }
    const firstIndex = rng.int(active.length);
    let secondIndex = rng.int(active.length - 1);
    if (secondIndex >= firstIndex) secondIndex += 1;
    const first = active[firstIndex];
    const second = active[secondIndex];
    const deck = shuffledDeck(`${seed}-${simulatedShowdowns}-${rng.next()}`);
    const board = deck.slice(4, 9);
    const firstScore = evaluateSeven([deck[0], deck[1], ...board]);
    const secondScore = evaluateSeven([deck[2], deck[3], ...board]);
    const comparison = compareScores(firstScore, secondScore);
    simulatedShowdowns += 1;
    if (comparison === 0) continue;

    const winner = comparison > 0 ? first : second;
    const loser = comparison > 0 ? second : first;
    const wager = Math.min(winner.stack, loser.stack);
    winner.stack += wager;
    loser.stack -= wager;
    if (loser.stack === 0 && !tournament.eliminationOrder.includes(loser.id)) {
      tournament.eliminationOrder.push(loser.id);
    }
    tournament = finishIfDecided(tournament, table);
  }

  if (!tournament.finished) tournament = forceFinish(table, tournament);
  table.handNumber += simulatedShowdowns;
  table.status = "complete";
  table.street = "complete";
  table.activeIndex = -1;
  table.community = [];
  for (const seat of table.seats) {
    seat.holeCards = [];
    seat.committedHand = 0;
    seat.committedStreet = 0;
    seat.folded = seat.stack === 0;
    seat.allIn = false;
  }
  return { table, tournament, simulatedShowdowns };
}