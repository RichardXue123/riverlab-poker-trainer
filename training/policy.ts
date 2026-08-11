import { createBotPersonality } from "../lib/poker/ai";
import { SeededRng } from "../lib/poker/rng";
import type { BotPersonality } from "../lib/poker/types";
import type { PolicyEvaluation, SelfPlayPolicy } from "./types";

export const GENE_KEYS: Array<keyof BotPersonality> = [
  "looseness",
  "aggression",
  "bluff",
  "trapping",
  "calling",
  "risk",
  "sizing",
  "adaptability",
];

function clampGene(value: number): number {
  return Math.max(0.06, Math.min(0.94, value));
}

export function validatePolicy(policy: SelfPlayPolicy): void {
  if (policy.schemaVersion !== 1 || !policy.id) throw new Error("Invalid self-play policy metadata");
  for (const key of GENE_KEYS) {
    const value = policy.genes[key];
    if (!Number.isFinite(value) || value < 0.06 || value > 0.94) throw new Error(`Invalid ${key} gene in ${policy.id}`);
  }
}

export function makeInitialPopulation(size: number, seed: string): SelfPlayPolicy[] {
  if (!Number.isInteger(size) || size < 8 || size % 8 !== 0) throw new Error("Population size must be a positive multiple of eight");
  const policies: SelfPlayPolicy[] = [];
  for (let index = 0; index < size; index += 1) {
    const genes = createBotPersonality(`${seed}-initial`, "expert", index);
    const rng = new SeededRng(`${seed}-initial-variation-${index}`);
    for (const key of GENE_KEYS) genes[key] = clampGene(genes[key] + rng.between(-0.035, 0.035));
    const policy: SelfPlayPolicy = {
      schemaVersion: 1,
      id: `g000-p${String(index + 1).padStart(3, "0")}`,
      generation: 0,
      parentIds: [],
      genes,
    };
    validatePolicy(policy);
    policies.push(policy);
  }
  return policies;
}

export function makeCenteredPopulation(
  size: number,
  seed: string,
  center: SelfPlayPolicy,
  radius = 0.06,
): SelfPlayPolicy[] {
  if (!Number.isInteger(size) || size < 8 || size % 8 !== 0) throw new Error("Population size must be a positive multiple of eight");
  if (!Number.isFinite(radius) || radius <= 0 || radius > 0.25) throw new Error("Initial radius must be in (0, 0.25]");
  validatePolicy(center);
  const policies: SelfPlayPolicy[] = [];
  for (let index = 0; index < size; index += 1) {
    const genes = structuredClone(center.genes);
    if (index > 0) {
      const rng = new SeededRng(`${seed}-centered-variation-${index}`);
      for (const key of GENE_KEYS) genes[key] = clampGene(genes[key] + rng.between(-radius, radius));
    }
    const policy: SelfPlayPolicy = {
      schemaVersion: 1,
      id: `g000-p${String(index + 1).padStart(3, "0")}`,
      generation: 0,
      parentIds: [center.id],
      genes,
    };
    validatePolicy(policy);
    policies.push(policy);
  }
  return policies;
}

function rankPick(evaluations: PolicyEvaluation[], rng: SeededRng): SelfPlayPolicy {
  const pool = evaluations.slice(0, Math.max(2, Math.ceil(evaluations.length / 2)));
  const weights = pool.map((_, index) => pool.length - index);
  return pool[rng.weightedIndex(weights)].policy;
}

function breedGenes(
  first: BotPersonality,
  second: BotPersonality,
  mutationRate: number,
  rng: SeededRng,
): BotPersonality {
  const genes = {} as BotPersonality;
  for (const key of GENE_KEYS) {
    const blend = rng.between(0.25, 0.75);
    const inherited = first[key] * blend + second[key] * (1 - blend);
    const mutation = rng.between(-mutationRate, mutationRate);
    genes[key] = clampGene(inherited + mutation);
  }
  return genes;
}

export function evolvePopulation(
  evaluations: PolicyEvaluation[],
  nextGeneration: number,
  seed: string,
  mutationRate: number,
  eliteFraction: number,
): SelfPlayPolicy[] {
  if (evaluations.length < 8 || evaluations.length % 8 !== 0) throw new Error("Evaluated population must be a multiple of eight");
  const sorted = [...evaluations].sort((left, right) => right.fitness - left.fitness || left.policy.id.localeCompare(right.policy.id));
  const eliteCount = Math.max(2, Math.min(sorted.length, Math.ceil(sorted.length * eliteFraction)));
  const next: SelfPlayPolicy[] = [];
  for (let index = 0; index < eliteCount; index += 1) {
    const parent = sorted[index].policy;
    next.push({
      schemaVersion: 1,
      id: `g${String(nextGeneration).padStart(3, "0")}-e${String(index + 1).padStart(3, "0")}`,
      generation: nextGeneration,
      parentIds: [parent.id],
      genes: structuredClone(parent.genes),
    });
  }

  const rng = new SeededRng(`${seed}-evolve-${nextGeneration}`);
  while (next.length < sorted.length) {
    const first = rankPick(sorted, rng);
    const second = rankPick(sorted, rng);
    const index = next.length;
    next.push({
      schemaVersion: 1,
      id: `g${String(nextGeneration).padStart(3, "0")}-p${String(index + 1).padStart(3, "0")}`,
      generation: nextGeneration,
      parentIds: [first.id, second.id],
      genes: breedGenes(first.genes, second.genes, mutationRate, rng),
    });
  }
  for (const policy of next) validatePolicy(policy);
  return next;
}

export function policyDistance(first: SelfPlayPolicy, second: SelfPlayPolicy): number {
  return GENE_KEYS.reduce((sum, key) => sum + Math.abs(first.genes[key] - second.genes[key]), 0) / GENE_KEYS.length;
}