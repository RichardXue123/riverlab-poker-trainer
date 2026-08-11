import { writeFileSync } from "node:fs";
import type { PolicyEvaluation, SelfPlayTrainingConfig } from "./types";

export interface PromotedPolicyFile {
  schemaVersion: 1;
  enabled: true;
  policyId: string;
  promotedAt: string;
  trainingSeed: string;
  evaluatedHands: number;
  totalTrainingHands: number;
  fitness: number;
  genes: PolicyEvaluation["policy"]["genes"];
}

export function promotePolicy(
  best: PolicyEvaluation,
  config: SelfPlayTrainingConfig,
  totalTrainingHands: number,
  targetPath: string,
  force = false,
): PromotedPolicyFile {
  if (!force && totalTrainingHands < 500) {
    throw new Error(`Refusing to promote a policy trained on only ${totalTrainingHands} table hands; run at least 500 or pass --force-promote`);
  }
  const promoted: PromotedPolicyFile = {
    schemaVersion: 1,
    enabled: true,
    policyId: best.policy.id,
    promotedAt: new Date().toISOString(),
    trainingSeed: config.seed,
    evaluatedHands: best.hands,
    totalTrainingHands,
    fitness: best.fitness,
    genes: structuredClone(best.policy.genes),
  };
  writeFileSync(targetPath, `${JSON.stringify(promoted, null, 2)}\n`, "utf8");
  return promoted;
}