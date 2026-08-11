import { chooseBotAction } from "../lib/poker/ai";
import { auditAiReadability } from "../lib/poker/ai-audit";
import { applyAction, buildBotView, createTable, startHand } from "../lib/poker/engine";
import { updateObservedStats } from "../lib/poker/storage";
import { EMPTY_STATS } from "../lib/poker/types";
import type { AiAuditSample } from "../lib/poker/ai-audit";
import type { DecisionCandidate, ObservedOpponentStats, PlayerActionType, SeatState } from "../lib/poker/types";
import type { MatchPolicyResult, SelfPlayMatchResult, SelfPlayPolicy, SelfPlayTrainingConfig } from "./types";

interface MutableResult extends MatchPolicyResult {
  auditSamples: AiAuditSample[];
}

function actionKey(action: { type: PlayerActionType; amount?: number }): string {
  return `${action.type}-${action.amount ?? 0}`;
}

function chosenCandidate(candidates: DecisionCandidate[], action: { type: PlayerActionType; amount?: number }): DecisionCandidate | undefined {
  return candidates.find((candidate) => actionKey(candidate.action) === actionKey(action));
}

function sizeBucket(
  action: { type: PlayerActionType; amount?: number },
  committedStreet: number,
  stack: number,
  pot: number,
): AiAuditSample["sizeBucket"] {
  if (action.type === "all-in") return "jam";
  if (action.type !== "bet" && action.type !== "raise") return "none";
  const cost = Math.max(0, (action.amount ?? committedStreet) - committedStreet);
  const fraction = cost / Math.max(1, pot);
  if (fraction <= 0.45) return "small";
  if (fraction <= 0.80) return "medium";
  return "large";
}

function freshSeats(
  assignments: SelfPlayPolicy[],
  buyIn: number,
  statsByPolicy: Map<string, ObservedOpponentStats>,
): SeatState[] {
  return assignments.map((policy, index) => ({
    id: `seat-${index + 1}`,
    name: `训练席 ${index + 1}`,
    isHuman: false,
    stack: buyIn,
    holeCards: [],
    folded: false,
    allIn: false,
    committedStreet: 0,
    committedHand: 0,
    acted: false,
    raiseLocked: false,
    personality: structuredClone(policy.genes),
    stats: structuredClone(statsByPolicy.get(policy.id) ?? EMPTY_STATS),
  }));
}

function initialResult(policy: SelfPlayPolicy): MutableResult {
  return {
    policy,
    hands: 0,
    netChips: 0,
    wins: 0,
    decisions: 0,
    aggressiveActions: 0,
    jams: 0,
    deepIrrationalJams: 0,
    auditSamples: [],
  };
}
function modelledOpponent(view: ReturnType<typeof buildBotView>, actorId: string) {
  const latestAggressor = [...view.actionLog].reverse().find((action) =>
    action.playerId !== actorId && ["bet", "raise", "all-in"].includes(action.type),
  );
  if (latestAggressor) return view.seats.find((seat) => seat.id === latestAggressor.playerId);
  return view.seats
    .filter((seat) => seat.id !== actorId && !seat.folded)
    .sort((left, right) => {
      const leftSamples = left.stats.aggressiveActions + left.stats.passiveActions;
      const rightSamples = right.stats.aggressiveActions + right.stats.passiveActions;
      const leftAggression = left.stats.aggressiveActions / Math.max(1, leftSamples);
      const rightAggression = right.stats.aggressiveActions / Math.max(1, rightSamples);
      return right.stats.hands + rightAggression * 12 - left.stats.hands - leftAggression * 12;
    })[0];
}

/**
 * Runs actual RiverLab rules without rendering. Policies rotate through all
 * seats, while every decision still receives only BotViewState information.
 */
export function playSelfPlayMatch(
  policies: SelfPlayPolicy[],
  config: Pick<SelfPlayTrainingConfig, "handsPerTable" | "decisionIterations" | "smallBlind" | "bigBlind" | "maxActionsPerHand">,
  seed: string,
): SelfPlayMatchResult {
  if (policies.length !== 8) throw new Error("A self-play match requires exactly eight policies");
  const buyIn = config.bigBlind * 100;
  const expectedChips = buyIn * policies.length;
  const results = new Map(policies.map((policy) => [policy.id, initialResult(policy)]));
  const statsByPolicy = new Map(policies.map((policy) => [policy.id, structuredClone(EMPTY_STATS)]));
  let totalActions = 0;

  for (let handIndex = 0; handIndex < config.handsPerTable; handIndex += 1) {
    const assignments = Array.from({ length: 8 }, (_, seatIndex) => policies[(seatIndex + handIndex) % policies.length]);
    const policyBySeat = new Map(assignments.map((policy, seatIndex) => [`seat-${seatIndex + 1}`, policy]));
    const table = createTable({
      smallBlind: config.smallBlind,
      bigBlind: config.bigBlind,
      difficulty: "expert",
      seats: freshSeats(assignments, buyIn, statsByPolicy),
    });
    let state = startHand(table, `${seed}-hand-${String(handIndex + 1).padStart(6, "0")}`);
    let actions = 0;

    for (const policy of policies) results.get(policy.id)!.hands += 1;
    while (state.status === "playing" && actions < config.maxActionsPerHand) {
      const actor = state.seats[state.activeIndex];
      const policy = policyBySeat.get(actor.id);
      if (!policy || !actor.personality) throw new Error(`Missing policy assignment for ${actor.id}`);
      const view = buildBotView(state, actor.id);
      const pot = view.seats.reduce((sum, seat) => sum + seat.committedHand, 0);
      const spr = actor.stack / Math.max(config.bigBlind, pot);
      const opponent = modelledOpponent(view, actor.id);
      const decision = chooseBotAction(view, actor.personality, "expert", undefined, {
        iterations: config.decisionIterations,
        opponentId: opponent?.id,
        opponentStats: opponent?.stats,
      });
      const candidate = chosenCandidate(decision.trace.candidates, decision.action);
      const label = candidate?.label ?? "unlabelled";
      const value = label.includes("价值")
        || decision.trace.summary.includes("坚果牌")
        || decision.trace.summary.includes("近坚果牌")
        || decision.trace.summary.includes("强价值牌");
      const metric = results.get(policy.id)!;
      metric.decisions += 1;
      if (["bet", "raise", "all-in"].includes(decision.action.type)) metric.aggressiveActions += 1;
      if (decision.action.type === "all-in") {
        metric.jams += 1;
        const justified = value || label.includes("诈唬") || label.includes("听牌") || label.includes("权益") || spr <= 1.1;
        if (spr > 2.2 && !justified) metric.deepIrrationalJams += 1;
      }
      if (view.street === "river") {
        metric.auditSamples.push({
          action: decision.action.type,
          sizeBucket: sizeBucket(decision.action, actor.committedStreet, actor.stack, pot),
          value,
        });
      }

      state = applyAction(state, decision.action, decision.trace);
      actions += 1;
      totalActions += 1;
    }

    if (state.status !== "complete") throw new Error(`Self-play hand exceeded ${config.maxActionsPerHand} actions: ${state.handId}`);
    const finalChips = state.seats.reduce((sum, seat) => sum + seat.stack, 0);
    if (finalChips !== expectedChips) throw new Error(`Chip conservation failed in ${state.handId}: ${finalChips} != ${expectedChips}`);
    for (const seat of state.seats) {
      const policy = policyBySeat.get(seat.id)!;
      statsByPolicy.set(policy.id, updateObservedStats(state, seat.id, statsByPolicy.get(policy.id)));
    }
    for (const seat of state.seats) {
      const policy = policyBySeat.get(seat.id)!;
      results.get(policy.id)!.netChips += seat.stack - buyIn;
    }
    for (const winnerId of state.lastResult?.winnerIds ?? []) {
      const policy = policyBySeat.get(winnerId);
      if (policy) results.get(policy.id)!.wins += 1;
    }
  }

  return {
    seed,
    hands: config.handsPerTable,
    totalActions,
    chipConserved: true,
    observedStats: Object.fromEntries([...statsByPolicy].map(([id, stats]) => [id, structuredClone(stats)])),
    policyResults: policies.map((policy) => {
      const result = results.get(policy.id)!;
      // Exercise the audit here so malformed samples fail during simulation.
      auditAiReadability(result.auditSamples);
      return result;
    }),
  };
}