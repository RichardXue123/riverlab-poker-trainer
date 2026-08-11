import type { SelfPlayPolicy } from "./types";

const REFERENCE_GENES = [
  { looseness: 0.20, aggression: 0.70, bluff: 0.32, trapping: 0.40, calling: 0.28, risk: 0.42, sizing: 0.60, adaptability: 0.78 },
  { looseness: 0.48, aggression: 0.82, bluff: 0.68, trapping: 0.28, calling: 0.30, risk: 0.74, sizing: 0.78, adaptability: 0.86 },
  { looseness: 0.52, aggression: 0.32, bluff: 0.24, trapping: 0.38, calling: 0.78, risk: 0.50, sizing: 0.42, adaptability: 0.64 },
  { looseness: 0.30, aggression: 0.50, bluff: 0.40, trapping: 0.80, calling: 0.48, risk: 0.38, sizing: 0.58, adaptability: 0.72 },
  { looseness: 0.34, aggression: 0.64, bluff: 0.48, trapping: 0.50, calling: 0.42, risk: 0.54, sizing: 0.62, adaptability: 0.88 },
  { looseness: 0.38, aggression: 0.72, bluff: 0.76, trapping: 0.30, calling: 0.32, risk: 0.66, sizing: 0.82, adaptability: 0.82 },
  { looseness: 0.31, aggression: 0.60, bluff: 0.44, trapping: 0.56, calling: 0.56, risk: 0.48, sizing: 0.55, adaptability: 0.94 },
] as const;

const REFERENCE_NAMES = [
  "anchor-tight-aggressive",
  "anchor-loose-aggressive",
  "anchor-calling-station",
  "anchor-trapper",
  "anchor-balanced",
  "anchor-blocker-bluffer",
  "anchor-adaptive-defender",
] as const;

/**
 * A frozen, diverse opponent panel. Keeping these policies unchanged makes
 * scores comparable across generations and discourages population-only tricks.
 */
export function makeReferencePolicies(): SelfPlayPolicy[] {
  return REFERENCE_GENES.map((genes, index) => ({
    schemaVersion: 1,
    id: REFERENCE_NAMES[index],
    generation: -1,
    parentIds: [],
    genes: { ...genes },
  }));
}
const HOLDOUT_GENES = [
  { looseness: 0.14, aggression: 0.58, bluff: 0.20, trapping: 0.52, calling: 0.20, risk: 0.32, sizing: 0.48, adaptability: 0.82 },
  { looseness: 0.60, aggression: 0.90, bluff: 0.82, trapping: 0.18, calling: 0.24, risk: 0.86, sizing: 0.90, adaptability: 0.80 },
  { looseness: 0.45, aggression: 0.68, bluff: 0.50, trapping: 0.40, calling: 0.70, risk: 0.65, sizing: 0.64, adaptability: 0.92 },
  { looseness: 0.28, aggression: 0.58, bluff: 0.62, trapping: 0.88, calling: 0.45, risk: 0.45, sizing: 0.72, adaptability: 0.90 },
  { looseness: 0.24, aggression: 0.55, bluff: 0.38, trapping: 0.40, calling: 0.18, risk: 0.38, sizing: 0.55, adaptability: 0.72 },
  { looseness: 0.36, aggression: 0.67, bluff: 0.52, trapping: 0.48, calling: 0.46, risk: 0.58, sizing: 0.68, adaptability: 0.90 },
  { looseness: 0.32, aggression: 0.62, bluff: 0.40, trapping: 0.56, calling: 0.68, risk: 0.48, sizing: 0.58, adaptability: 0.94 },
] as const;

const HOLDOUT_NAMES = [
  "holdout-nit",
  "holdout-maniac",
  "holdout-sticky-aggressor",
  "holdout-tricky-trapper",
  "holdout-overfolder",
  "holdout-balanced-alt",
  "holdout-river-defender",
] as const;

/** Opponent panel reserved for post-training selection; never used by evolution. */
export function makeHoldoutPolicies(): SelfPlayPolicy[] {
  return HOLDOUT_GENES.map((genes, index) => ({
    schemaVersion: 1,
    id: HOLDOUT_NAMES[index],
    generation: -2,
    parentIds: [],
    genes: { ...genes },
  }));
}
