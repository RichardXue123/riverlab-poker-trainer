import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { auditAiReadability } from "../lib/poker/ai-audit";
import type { AiAuditSample } from "../lib/poker/ai-audit";
import { makeHoldoutPolicies } from "./anchors";
import { policyDistance } from "./policy";
import { playSelfPlayMatch } from "./simulator";
import type { MatchPolicyResult, PolicyEvaluation, SelfPlayPolicy, SelfPlayTrainingConfig } from "./types";

interface TrainingSummary {
  runId: string;
  config: SelfPlayTrainingConfig;
  hallOfFame: PolicyEvaluation[];
  totalTrainingHands: number;
}

interface CandidateAggregate {
  policy: SelfPlayPolicy;
  hands: number;
  netChips: number;
  wins: number;
  decisions: number;
  aggressiveActions: number;
  jams: number;
  deepIrrationalJams: number;
  auditSamples: AiAuditSample[];
  batchBb100: number[];
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function integerOption(name: string, fallback: number): number {
  const raw = option(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(name + " must be a positive integer");
  return value;
}

function fixed(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
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

function fresh(policy: SelfPlayPolicy): CandidateAggregate {
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
    batchBb100: [],
  };
}

function merge(target: CandidateAggregate, source: MatchPolicyResult, bigBlind: number): void {
  target.hands += source.hands;
  target.netChips += source.netChips;
  target.wins += source.wins;
  target.decisions += source.decisions;
  target.aggressiveActions += source.aggressiveActions;
  target.jams += source.jams;
  target.deepIrrationalJams += source.deepIrrationalJams;
  target.auditSamples.push(...source.auditSamples);
  target.batchBb100.push(source.netChips / bigBlind / Math.max(1, source.hands) * 100);
}

function scoreCandidate(aggregate: CandidateAggregate, bigBlind: number) {
  const audit = auditAiReadability(aggregate.auditSamples);
  const bb100 = aggregate.netChips / bigBlind / Math.max(1, aggregate.hands) * 100;
  const winsorized = aggregate.batchBb100.map((value) => Math.max(-120, Math.min(120, value)));
  const winsorMean = average(winsorized);
  const robustBb100 = winsorMean * 0.70 + median(winsorized) * 0.30;
  const batchStdDev = Math.sqrt(average(winsorized.map((value) => (value - winsorMean) ** 2)));
  const decisions = Math.max(1, aggregate.decisions);
  const aggressionRate = aggregate.aggressiveActions / decisions;
  const jamRate = aggregate.jams / decisions;
  const deepIrrationalJamRate = aggregate.deepIrrationalJams / decisions;
  const predictabilityPenalty = Math.max(0, audit.actionPredictability - 0.86) * 70;
  const polarPenalty = audit.aggressiveSamples >= 30
    ? Math.max(0, Math.abs(audit.aggressiveValueShare - 0.72) - 0.12) * 50 : 0;
  const bluffPenalty = Math.max(0, 0.06 - audit.bluffAggressionRate) * 50;
  const trapPenalty = Math.max(0, 0.08 - audit.valuePassiveRate) * 40;
  const behaviorChecks = {
    riverActionNotOverlyReadable: audit.actionPredictability <= 0.88,
    riverAggressionBalanced: audit.aggressiveSamples >= 30
      && audit.aggressiveValueShare >= 0.55 && audit.aggressiveValueShare <= 0.88,
    conditionalBluffsPresent: audit.bluffAggressionRate >= 0.06,
    valueChecksPresent: audit.valuePassiveRate >= 0.08,
    noDeepIrrationalJams: aggregate.deepIrrationalJams === 0,
  };
  const behaviorQualified = Object.values(behaviorChecks).every(Boolean);
  const score = robustBb100
    - batchStdDev * 0.08
    - predictabilityPenalty
    - polarPenalty
    - bluffPenalty
    - trapPenalty
    - deepIrrationalJamRate * 900
    - Math.max(0, jamRate - 0.06) * 220
    + audit.normalizedActionEntropy * 4;
  return {
    policy: aggregate.policy,
    hands: aggregate.hands,
    netChips: aggregate.netChips,
    bb100: fixed(bb100),
    robustBb100: fixed(robustBb100),
    batchStdDev: fixed(batchStdDev),
    batchBb100: aggregate.batchBb100.map((value) => fixed(value)),
    wins: aggregate.wins,
    decisions: aggregate.decisions,
    aggressionRate: fixed(aggressionRate),
    jamRate: fixed(jamRate),
    deepIrrationalJams: aggregate.deepIrrationalJams,
    riverSamples: audit.samples,
    actionPredictability: fixed(audit.actionPredictability),
    normalizedActionEntropy: fixed(audit.normalizedActionEntropy),
    aggressiveSamples: audit.aggressiveSamples,
    aggressiveValueShare: fixed(audit.aggressiveValueShare),
    bluffAggressionRate: fixed(audit.bluffAggressionRate),
    valuePassiveRate: fixed(audit.valuePassiveRate),
    jamBluffShare: fixed(audit.jamBluffShare),
    behaviorChecks,
    behaviorQualified,
    selectionScore: fixed(score),
  };
}

function main(): void {
  const runDirectory = resolve(option("--run") ?? "training-output/robust-adaptive-v3");
  const hands = integerOption("--hands", 1_000);
  const batchHands = integerOption("--batch", 250);
  const candidateCount = integerOption("--candidates", 12);
  const seed = option("--seed") ?? "robust-selection-holdout-v1";
  const summary = JSON.parse(readFileSync(join(runDirectory, "summary.json"), "utf8")) as TrainingSummary;
  const candidates: SelfPlayPolicy[] = [];
  for (const entry of summary.hallOfFame) {
    if (candidates.some((policy) => policy.id === entry.policy.id)) continue;
    if (candidates.some((policy) => policyDistance(policy, entry.policy) < 0.012)) continue;
    candidates.push(entry.policy);
    if (candidates.length >= candidateCount) break;
  }
  if (candidates.length < 2) throw new Error("Training summary does not contain enough distinct finalists");

  const outputDirectory = join(runDirectory, "selection");
  mkdirSync(outputDirectory, { recursive: true });
  const humanLog = join(outputDirectory, "selection.log");
  const eventLog = join(outputDirectory, "events.jsonl");
  writeFileSync(humanLog, "", "utf8");
  writeFileSync(eventLog, "", "utf8");
  const emit = (type: string, message: string, details: Record<string, unknown> = {}): void => {
    const event = { timestamp: new Date().toISOString(), type, message, ...details };
    const line = "[" + event.timestamp + "] " + type.padEnd(22) + message;
    appendFileSync(humanLog, line + "\n", "utf8");
    appendFileSync(eventLog, JSON.stringify(event) + "\n", "utf8");
    console.log(line);
  };

  emit("selection_start", "开始未见对手复赛：" + candidates.length + " 个候选，每个 " + hands + " 手", {
    runId: summary.runId,
    trainingHands: summary.totalTrainingHands,
    seed,
    candidateIds: candidates.map((policy) => policy.id),
  });

  const holdouts = makeHoldoutPolicies();
  const ranking = [];
  for (const [candidateIndex, candidate] of candidates.entries()) {
    const aggregate = fresh(candidate);
    let completed = 0;
    let batch = 0;
    while (completed < hands) {
      const currentHands = Math.min(batchHands, hands - completed);
      batch += 1;
      const match = playSelfPlayMatch(
        [candidate, ...holdouts],
        {
          handsPerTable: currentHands,
          decisionIterations: summary.config.decisionIterations,
          smallBlind: summary.config.smallBlind,
          bigBlind: summary.config.bigBlind,
          maxActionsPerHand: summary.config.maxActionsPerHand,
        },
        seed + "-batch-" + String(batch).padStart(3, "0"),
      );
      const result = match.policyResults.find((entry) => entry.policy.id === candidate.id);
      if (!result || !match.chipConserved) throw new Error("Invalid selection match for " + candidate.id);
      merge(aggregate, result, summary.config.bigBlind);
      completed += currentHands;
      emit("candidate_batch", "候选 " + (candidateIndex + 1) + "/" + candidates.length + " " + candidate.id
        + "：完成 " + completed + "/" + hands + " 手", {
        candidateId: candidate.id,
        completedHands: completed,
        batch,
        batchBb100: aggregate.batchBb100[aggregate.batchBb100.length - 1],
      });
    }
    const scored = scoreCandidate(aggregate, summary.config.bigBlind);
    ranking.push(scored);
    emit("candidate_complete", candidate.id + "：复赛分 " + scored.selectionScore
      + "，稳健 " + scored.robustBb100 + " BB/100，可读性 " + scored.actionPredictability, scored);
  }

  ranking.sort((left, right) => Number(right.behaviorQualified) - Number(left.behaviorQualified)
    || right.selectionScore - left.selectionScore || left.policy.id.localeCompare(right.policy.id));
  const selected = ranking[0];
  const report = {
    schemaVersion: 1,
    runId: summary.runId,
    seed,
    trainingHands: summary.totalTrainingHands,
    candidatesEvaluated: candidates.length,
    handsPerCandidate: hands,
    holdoutOpponentIds: holdouts.map((policy) => policy.id),
    selectedPolicyId: selected.policy.id,
    selected,
    ranking,
    note: "Holdout opponents are frozen and were not used during evolution. Selection does not promote the policy.",
  };
  writeFileSync(join(outputDirectory, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  writeFileSync(join(outputDirectory, "selected-policy.json"), JSON.stringify({
    schemaVersion: 1,
    runId: summary.runId,
    selectedAt: new Date().toISOString(),
    seed,
    policy: selected.policy,
    selectionMetrics: selected,
  }, null, 2) + "\n", "utf8");
  emit("selection_complete", "复赛完成，第一名 " + selected.policy.id + "；尚未晋级", {
    selectedPolicyId: selected.policy.id,
    report: relative(process.cwd(), join(outputDirectory, "report.json")),
  });
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("复赛失败：" + message);
  process.exitCode = 1;
}
