import type { AiAuditSample } from "../lib/poker/ai-audit";
import type { BotPersonality, ObservedOpponentStats } from "../lib/poker/types";

export interface SelfPlayPolicy {
  schemaVersion: 1;
  id: string;
  generation: number;
  parentIds: string[];
  genes: BotPersonality;
}

export interface SelfPlayTrainingConfig {
  seed: string;
  generations: number;
  populationSize: number;
  handsPerTable: number;
  roundsPerGeneration: number;
  anchorHandsPerCandidate?: number;
  anchorRoundsPerGeneration?: number;
  decisionIterations: number;
  mutationRate: number;
  eliteFraction: number;
  smallBlind: number;
  bigBlind: number;
  maxActionsPerHand: number;
}

export interface MatchPolicyResult {
  policy: SelfPlayPolicy;
  hands: number;
  netChips: number;
  wins: number;
  decisions: number;
  aggressiveActions: number;
  jams: number;
  deepIrrationalJams: number;
  auditSamples: AiAuditSample[];
}

export interface SelfPlayMatchResult {
  seed: string;
  hands: number;
  totalActions: number;
  chipConserved: boolean;
  observedStats: Record<string, ObservedOpponentStats>;
  policyResults: MatchPolicyResult[];
}

export interface PolicyEvaluation {
  policy: SelfPlayPolicy;
  hands: number;
  netChips: number;
  bb100: number;
  robustBb100?: number;
  matchStdDev?: number;
  matchSamples?: number;
  wins: number;
  decisions: number;
  aggressionRate: number;
  jamRate: number;
  deepIrrationalJamRate: number;
  actionPredictability: number;
  jamBluffShare: number;
  normalizedActionEntropy: number;
  aggressiveValueShare: number;
  bluffAggressionRate: number;
  valuePassiveRate: number;
  riverSamples: number;
  fitness: number;
}

export interface GenerationEvaluation {
  generation: number;
  seed: string;
  matches: number;
  handsPlayed: number;
  totalActions: number;
  evaluations: PolicyEvaluation[];
}

export interface TrainingCheckpoint {
  schemaVersion: 1;
  runId: string;
  nextGeneration: number;
  config: SelfPlayTrainingConfig;
  population: SelfPlayPolicy[];
  hallOfFame: PolicyEvaluation[];
  history: Array<{
    generation: number;
    championId: string;
    fitness: number;
    bb100: number;
    handsPlayed: number;
  }>;
}

export type TrainingEventType =
  | "run_start"
  | "run_resume"
  | "generation_start"
  | "match_complete"
  | "generation_complete"
  | "checkpoint_saved"
  | "policy_promoted"
  | "run_complete"
  | "run_error";