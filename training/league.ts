import { auditAiReadability } from "../lib/poker/ai-audit";
import { SeededRng } from "../lib/poker/rng";
import type { AiAuditSample } from "../lib/poker/ai-audit";
import { makeReferencePolicies } from "./anchors";
import { playSelfPlayMatch } from "./simulator";
import type {
  GenerationEvaluation,
  MatchPolicyResult,
  PolicyEvaluation,
  SelfPlayPolicy,
  SelfPlayTrainingConfig,
} from "./types";

export interface MatchProgress {
  generation: number;
  kind: "league" | "anchor";
  round: number;
  group: number;
  policyId?: string;
  seed: string;
  hands: number;
  actions: number;
  chipConserved: boolean;
}

interface Aggregate extends Omit<MatchPolicyResult, "auditSamples"> {
  auditSamples: AiAuditSample[];
  matchBb100: number[];
}

function emptyAggregate(policy: SelfPlayPolicy): Aggregate {
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
    matchBb100: [],
  };
}

function mergeResult(target: Aggregate, source: MatchPolicyResult, bigBlind: number): void {
  target.hands += source.hands;
  target.netChips += source.netChips;
  target.wins += source.wins;
  target.decisions += source.decisions;
  target.aggressiveActions += source.aggressiveActions;
  target.jams += source.jams;
  target.deepIrrationalJams += source.deepIrrationalJams;
  target.auditSamples.push(...source.auditSamples);
  target.matchBb100.push(source.netChips / bigBlind / Math.max(1, source.hands) * 100);
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function finalize(aggregate: Aggregate, bigBlind: number): PolicyEvaluation {
  const audit = auditAiReadability(aggregate.auditSamples);
  const hands = Math.max(1, aggregate.hands);
  const decisions = Math.max(1, aggregate.decisions);
  const bb100 = aggregate.netChips / bigBlind / hands * 100;
  const aggressionRate = aggregate.aggressiveActions / decisions;
  const jamRate = aggregate.jams / decisions;
  const deepIrrationalJamRate = aggregate.deepIrrationalJams / decisions;
  const winsorized = aggregate.matchBb100.map((value) => Math.max(-120, Math.min(120, value)));
  const winsorMean = average(winsorized);
  const robustBb100 = winsorMean * 0.70 + median(winsorized) * 0.30;
  const matchStdDev = Math.sqrt(average(winsorized.map((value) => (value - winsorMean) ** 2)));
  const enoughRiverSamples = aggregate.auditSamples.length >= 18;
  const riverValueSamples = aggregate.auditSamples.filter((sample) => sample.value).length;
  const riverBluffSamples = aggregate.auditSamples.length - riverValueSamples;
  const predictabilityPenalty = enoughRiverSamples ? Math.max(0, audit.actionPredictability - 0.82) * 110
    + Math.max(0, audit.actionPredictability - 0.92) * 120 : 0;
  const entropyBonus = enoughRiverSamples ? audit.normalizedActionEntropy * 5 : 0;
  const deepJamPenalty = deepIrrationalJamRate * 800;
  const jamBalancePenalty = aggregate.jams >= 8 ? Math.abs(audit.jamBluffShare - 0.30) * 12 : 0;
  const jamFrequencyPenalty = Math.max(0, jamRate - 0.06) * 220;
  const polarBalancePenalty = audit.aggressiveSamples >= 12
    ? Math.max(0, Math.abs(audit.aggressiveValueShare - 0.72) - 0.12) * 45 : 0;
  const lowValueSharePenalty = audit.aggressiveSamples >= 12
    ? Math.max(0, 0.56 - audit.aggressiveValueShare) * 110 : 0;
  const bluffSilencePenalty = riverBluffSamples >= 12
    ? Math.max(0, 0.08 - audit.bluffAggressionRate) * 45 : 0;
  const trapAbsencePenalty = riverValueSamples >= 8
    ? Math.max(0, 0.10 - audit.valuePassiveRate) * 35 : 0;
  const aggressionPenalty = aggressionRate < 0.12
    ? (0.12 - aggressionRate) * 90
    : aggressionRate > 0.34 ? (aggressionRate - 0.34) * 70 : 0;
  const variancePenalty = aggregate.matchBb100.length >= 3 ? matchStdDev * 0.10 : 0;
  const fitness = robustBb100 + entropyBonus
    - predictabilityPenalty
    - deepJamPenalty
    - jamBalancePenalty
    - jamFrequencyPenalty
    - polarBalancePenalty
    - lowValueSharePenalty
    - bluffSilencePenalty
    - trapAbsencePenalty
    - aggressionPenalty
    - variancePenalty;
  return {
    policy: aggregate.policy,
    hands: aggregate.hands,
    netChips: aggregate.netChips,
    bb100,
    robustBb100,
    matchStdDev,
    matchSamples: aggregate.matchBb100.length,
    wins: aggregate.wins,
    decisions: aggregate.decisions,
    aggressionRate,
    jamRate,
    deepIrrationalJamRate,
    actionPredictability: audit.actionPredictability,
    jamBluffShare: audit.jamBluffShare,
    normalizedActionEntropy: audit.normalizedActionEntropy,
    aggressiveValueShare: audit.aggressiveValueShare,
    bluffAggressionRate: audit.bluffAggressionRate,
    valuePassiveRate: audit.valuePassiveRate,
    riverSamples: aggregate.auditSamples.length,
    fitness,
  };
}

/** Runs deterministic, seat-rotated league tables plus optional frozen-anchor tables. */
export function evaluatePopulation(
  population: SelfPlayPolicy[],
  config: SelfPlayTrainingConfig,
  generation: number,
  onMatch?: (progress: MatchProgress) => void,
): GenerationEvaluation {
  if (population.length !== config.populationSize || population.length % 8 !== 0) {
    throw new Error("Population/config mismatch; population must be a multiple of eight");
  }
  const aggregates = new Map(population.map((policy) => [policy.id, emptyAggregate(policy)]));
  let matches = 0;
  let handsPlayed = 0;
  let totalActions = 0;

  for (let round = 0; round < config.roundsPerGeneration; round += 1) {
    const rng = new SeededRng(config.seed + "-generation-" + generation + "-round-" + round);
    const shuffled = rng.shuffle(population);
    for (let start = 0; start < shuffled.length; start += 8) {
      const group = shuffled.slice(start, start + 8);
      const groupIndex = start / 8;
      const matchSeed = config.seed + "-g" + generation + "-r" + round + "-table" + groupIndex;
      const match = playSelfPlayMatch(group, config, matchSeed);
      for (const result of match.policyResults) mergeResult(aggregates.get(result.policy.id)!, result, config.bigBlind);
      matches += 1;
      handsPlayed += match.hands;
      totalActions += match.totalActions;
      onMatch?.({
        generation,
        kind: "league",
        round,
        group: groupIndex,
        seed: matchSeed,
        hands: match.hands,
        actions: match.totalActions,
        chipConserved: match.chipConserved,
      });
    }
  }

  const anchorHands = config.anchorHandsPerCandidate ?? 0;
  const anchorRounds = anchorHands > 0 ? Math.max(1, config.anchorRoundsPerGeneration ?? 1) : 0;
  if (anchorRounds > 0) {
    const references = makeReferencePolicies();
    for (let round = 0; round < anchorRounds; round += 1) {
      const commonSeed = config.seed + "-g" + generation + "-anchor-r" + round;
      for (const [policyIndex, policy] of population.entries()) {
        const match = playSelfPlayMatch(
          [policy, ...references],
          { ...config, handsPerTable: anchorHands },
          commonSeed,
        );
        const result = match.policyResults.find((entry) => entry.policy.id === policy.id);
        if (!result) throw new Error("Missing anchor result for " + policy.id);
        mergeResult(aggregates.get(policy.id)!, result, config.bigBlind);
        matches += 1;
        handsPlayed += match.hands;
        totalActions += match.totalActions;
        onMatch?.({
          generation,
          kind: "anchor",
          round,
          group: policyIndex,
          policyId: policy.id,
          seed: commonSeed,
          hands: match.hands,
          actions: match.totalActions,
          chipConserved: match.chipConserved,
        });
      }
    }
  }

  const evaluations = population
    .map((policy) => finalize(aggregates.get(policy.id)!, config.bigBlind))
    .sort((left, right) => right.fitness - left.fitness || left.policy.id.localeCompare(right.policy.id));
  return {
    generation,
    seed: config.seed + "-generation-" + generation,
    matches,
    handsPlayed,
    totalActions,
    evaluations,
  };
}
