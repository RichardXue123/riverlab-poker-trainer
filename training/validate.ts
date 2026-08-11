import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { auditAiReadability } from "../lib/poker/ai-audit";
import type { AiAuditSample } from "../lib/poker/ai-audit";
import { playSelfPlayMatch } from "./simulator";
import type { MatchPolicyResult, PolicyEvaluation, SelfPlayPolicy, SelfPlayTrainingConfig } from "./types";

interface TrainingSummary {
  runId: string;
  config: SelfPlayTrainingConfig;
  best: PolicyEvaluation;
  hallOfFame: PolicyEvaluation[];
  totalTrainingHands: number;
}

interface ValidationOptions {
  runDirectory: string;
  hands: number;
  batchHands: number;
  seed: string;
}

interface Aggregate extends Omit<MatchPolicyResult, "auditSamples"> {
  auditSamples: AiAuditSample[];
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function integerOption(name: string, fallback: number): number {
  const raw = option(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function parseOptions(): ValidationOptions {
  return {
    runDirectory: resolve(option("--run") ?? "training-output/formal-league-v1"),
    hands: integerOption("--hands", 2_000),
    batchHands: integerOption("--batch", 250),
    seed: option("--seed") ?? "formal-holdout-v1",
  };
}

function freshAggregate(policy: SelfPlayPolicy): Aggregate {
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

function merge(target: Aggregate, source: MatchPolicyResult): void {
  target.hands += source.hands;
  target.netChips += source.netChips;
  target.wins += source.wins;
  target.decisions += source.decisions;
  target.aggressiveActions += source.aggressiveActions;
  target.jams += source.jams;
  target.deepIrrationalJams += source.deepIrrationalJams;
  target.auditSamples.push(...source.auditSamples);
}

function fixed(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

function displayPath(path: string): string {
  const local = relative(process.cwd(), path);
  return local && !local.startsWith("..") ? local : path.split(/[\\/]/).pop() ?? "validation";
}

function main(): void {
  const options = parseOptions();
  const summaryPath = join(options.runDirectory, "summary.json");
  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as TrainingSummary;
  const candidatePath = option("--candidate");
  const candidate = candidatePath
    ? (JSON.parse(readFileSync(resolve(candidatePath), "utf8")) as { policy: SelfPlayPolicy }).policy
    : summary.best.policy;
  const opponents = summary.hallOfFame
    .map((entry) => entry.policy)
    .filter((policy, index, policies) => policy.id !== candidate.id && policies.findIndex((item) => item.id === policy.id) === index)
    .slice(0, 7);
  if (opponents.length !== 7) throw new Error("The training run does not contain seven distinct holdout opponents");

  const policies = [candidate, ...opponents];
  const aggregates = new Map(policies.map((policy) => [policy.id, freshAggregate(policy)]));
  const validationDirectory = join(options.runDirectory, "validation");
  const humanLogPath = join(validationDirectory, "validation.log");
  const eventsPath = join(validationDirectory, "events.jsonl");
  mkdirSync(validationDirectory, { recursive: true });
  writeFileSync(humanLogPath, "", "utf8");
  writeFileSync(eventsPath, "", "utf8");

  const emit = (type: string, message: string, details: Record<string, unknown> = {}): void => {
    const event = { timestamp: new Date().toISOString(), type, message, ...details };
    const line = `[${event.timestamp}] ${type.padEnd(20)} ${message}`;
    appendFileSync(humanLogPath, `${line}\n`, "utf8");
    appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
    console.log(line);
  };

  emit("validation_start", `开始独立验证：候选 ${candidate.id}，${options.hands} 手`, {
    candidateId: candidate.id,
    opponentIds: opponents.map((policy) => policy.id),
    seed: options.seed,
    trainingHands: summary.totalTrainingHands,
  });

  let completedHands = 0;
  let totalActions = 0;
  const batchBb100: number[] = [];
  while (completedHands < options.hands) {
    const hands = Math.min(options.batchHands, options.hands - completedHands);
    const batchIndex = batchBb100.length + 1;
    const match = playSelfPlayMatch(
      policies,
      {
        handsPerTable: hands,
        decisionIterations: summary.config.decisionIterations,
        smallBlind: summary.config.smallBlind,
        bigBlind: summary.config.bigBlind,
        maxActionsPerHand: summary.config.maxActionsPerHand,
      },
      `${options.seed}-batch-${String(batchIndex).padStart(3, "0")}`,
    );
    if (!match.chipConserved) throw new Error(`Chip conservation failed in validation batch ${batchIndex}`);
    for (const result of match.policyResults) merge(aggregates.get(result.policy.id)!, result);
    const candidateBatch = match.policyResults.find((result) => result.policy.id === candidate.id)!;
    const rate = candidateBatch.netChips / summary.config.bigBlind / candidateBatch.hands * 100;
    batchBb100.push(rate);
    completedHands += hands;
    totalActions += match.totalActions;
    emit("batch_complete", `批次 ${batchIndex}：累计 ${completedHands}/${options.hands} 手，候选本批 ${fixed(rate, 1)} BB/100`, {
      batch: batchIndex,
      completedHands,
      batchHands: hands,
      batchCandidateBb100: fixed(rate),
      actions: match.totalActions,
    });
  }

  const result = aggregates.get(candidate.id)!;
  const audit = auditAiReadability(result.auditSamples);
  const bb100 = result.netChips / summary.config.bigBlind / result.hands * 100;
  const aggressionRate = result.aggressiveActions / Math.max(1, result.decisions);
  const jamRate = result.jams / Math.max(1, result.decisions);
  const deepIrrationalJamRate = result.deepIrrationalJams / Math.max(1, result.decisions);
  const mean = batchBb100.reduce((sum, value) => sum + value, 0) / batchBb100.length;
  const variance = batchBb100.length > 1
    ? batchBb100.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (batchBb100.length - 1)
    : 0;
  const standardError = Math.sqrt(variance / batchBb100.length);
  const checks = {
    positiveHoldoutResult: bb100 > 0,
    noDeepIrrationalJams: deepIrrationalJamRate <= 0.002,
    sufficientRiverSample: audit.samples >= 100,
    riverActionNotOverlyReadable: audit.actionPredictability <= 0.88,
    actionMixNotCollapsed: audit.normalizedActionEntropy >= 0.55,
    riverAggressionBalanced: audit.aggressiveSamples >= 30
      && audit.aggressiveValueShare >= 0.55 && audit.aggressiveValueShare <= 0.88,
    conditionalBluffsPresent: audit.bluffAggressionRate >= 0.06,
    valueChecksPresent: audit.valuePassiveRate >= 0.08,
  };
  const recommendedForPromotion = Object.values(checks).every(Boolean);
  const report = {
    schemaVersion: 1,
    runId: summary.runId,
    seed: options.seed,
    candidate,
    candidateSource: candidatePath ? relative(process.cwd(), resolve(candidatePath)) : "summary.best",
    opponentIds: opponents.map((policy) => policy.id),
    trainingHands: summary.totalTrainingHands,
    validationHands: result.hands,
    totalActions,
    chipConserved: true,
    candidateMetrics: {
      netChips: result.netChips,
      bb100: fixed(bb100),
      approximateBb100Interval95: [fixed(mean - 1.96 * standardError), fixed(mean + 1.96 * standardError)],
      wins: result.wins,
      decisions: result.decisions,
      aggressionRate: fixed(aggressionRate),
      jamRate: fixed(jamRate),
      deepIrrationalJams: result.deepIrrationalJams,
      deepIrrationalJamRate: fixed(deepIrrationalJamRate),
      riverSamples: audit.samples,
      actionPredictability: fixed(audit.actionPredictability),
      jamBluffShare: fixed(audit.jamBluffShare),
      normalizedActionEntropy: fixed(audit.normalizedActionEntropy),
      aggressiveSamples: audit.aggressiveSamples,
      aggressiveValueShare: fixed(audit.aggressiveValueShare),
      bluffAggressionRate: fixed(audit.bluffAggressionRate),
      valuePassiveRate: fixed(audit.valuePassiveRate),
      batchBb100: batchBb100.map((value) => fixed(value)),
    },
    checks,
    recommendedForPromotion,
    note: "The interval is a rough batch-based diagnostic, not a solver-grade confidence interval.",
  };
  const reportPath = join(validationDirectory, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  emit("validation_complete", `验证完成：${fixed(bb100, 1)} BB/100，${recommendedForPromotion ? "达到" : "未达到"}自动晋级门槛`, {
    report: displayPath(reportPath),
    recommendedForPromotion,
  });
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`验证失败：${message}`);
  process.exitCode = 1;
}
