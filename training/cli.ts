import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePopulation } from "./league";
import { TrainingLogger } from "./logger";
import { evolvePopulation, makeCenteredPopulation, makeInitialPopulation, validatePolicy } from "./policy";
import { promotePolicy } from "./promote";
import type { PolicyEvaluation, SelfPlayPolicy, SelfPlayTrainingConfig, TrainingCheckpoint } from "./types";

const rawArgs = process.argv.slice(2);

function argument(name: string): string | undefined {
  const index = rawArgs.indexOf(name);
  return index >= 0 ? rawArgs[index + 1] : undefined;
}

function integerArgument(name: string, fallback: number): number {
  const raw = argument(name);
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function numberArgument(name: string, fallback: number): number {
  const raw = argument(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function printHelp(): void {
  console.log(`RiverLab 离线自博弈训练器

用法：npm run train:ai -- [参数]

  --generations N   迭代代数，默认 3
  --population N    策略数量，必须是 8 的倍数，默认 8
  --hands N         每张训练桌每轮手数，默认 8
  --rounds N        每代重新分桌次数，默认 1
  --anchor-hands N  每个策略对固定强对手的手数，默认 0
  --anchor-rounds N 固定强对手复赛轮数，默认 1
  --iterations N    每次决策的范围模拟次数，默认 12
  --mutation N      基因最大变异幅度，默认 0.08
  --seed TEXT       固定随机种子，默认 riverlab-selfplay-v1
  --output PATH     日志和检查点输出目录
  --resume FILE     从 checkpoint JSON 继续
  --promote         训练量不少于 500 手时晋级最佳策略
  --force-promote   忽略样本门槛强制晋级（仅调试）
  --help            显示帮助

正式训练示例：
npm run train:ai -- --generations 10 --population 16 --hands 32 --rounds 2 --iterations 24 --seed league-v1`);
}

if (rawArgs.includes("--help")) {
  printHelp();
  process.exit(0);
}

function validateConfig(config: SelfPlayTrainingConfig): void {
  if (config.populationSize < 8 || config.populationSize % 8 !== 0) throw new Error("--population must be a multiple of eight");
  for (const [name, value] of Object.entries({
    generations: config.generations,
    handsPerTable: config.handsPerTable,
    roundsPerGeneration: config.roundsPerGeneration,
    decisionIterations: config.decisionIterations,
    maxActionsPerHand: config.maxActionsPerHand,
  })) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  }
  const anchorHands = config.anchorHandsPerCandidate ?? 0;
  const anchorRounds = config.anchorRoundsPerGeneration ?? 1;
  if (!Number.isInteger(anchorHands) || anchorHands < 0) throw new Error("--anchor-hands must be a non-negative integer");
  if (!Number.isInteger(anchorRounds) || anchorRounds <= 0) throw new Error("--anchor-rounds must be a positive integer");
  if (config.mutationRate <= 0 || config.mutationRate > 0.35) throw new Error("--mutation must be in (0, 0.35]");
  if (config.eliteFraction <= 0 || config.eliteFraction > 0.5) throw new Error("eliteFraction must be in (0, 0.5]");
}

function bestHallOfFame(current: PolicyEvaluation[], previous: PolicyEvaluation[]): PolicyEvaluation[] {
  const seen = new Set<string>();
  return [...current, ...previous]
    .sort((left, right) => right.fitness - left.fitness || left.policy.id.localeCompare(right.policy.id))
    .filter((entry) => {
      if (seen.has(entry.policy.id)) return false;
      seen.add(entry.policy.id);
      return true;
    })
    .slice(0, 16);
}

const resumePath = argument("--resume");
let logger: TrainingLogger | undefined;

try {
  const defaultConfig: SelfPlayTrainingConfig = {
    seed: argument("--seed") ?? "riverlab-selfplay-v1",
    generations: integerArgument("--generations", 3),
    populationSize: integerArgument("--population", 8),
    handsPerTable: integerArgument("--hands", 8),
    roundsPerGeneration: integerArgument("--rounds", 1),
    anchorHandsPerCandidate: integerArgument("--anchor-hands", 0),
    anchorRoundsPerGeneration: integerArgument("--anchor-rounds", 1),
    decisionIterations: integerArgument("--iterations", 12),
    mutationRate: numberArgument("--mutation", 0.08),
    eliteFraction: 0.25,
    smallBlind: 5,
    bigBlind: 10,
    maxActionsPerHand: 320,
  };

  let config = defaultConfig;
  let population: SelfPlayPolicy[];
  let startGeneration = 0;
  let hallOfFame: PolicyEvaluation[] = [];
  let history: TrainingCheckpoint["history"] = [];
  let runId = `selfplay-${config.seed.replace(/[^a-zA-Z0-9_-]+/g, "-")}-${Date.now().toString(36)}`;
  let outputDirectory: string;

  if (resumePath) {
    const checkpoint = JSON.parse(readFileSync(path.resolve(resumePath), "utf8")) as TrainingCheckpoint;
    if (checkpoint.schemaVersion !== 1) throw new Error("Unsupported checkpoint version");
    config = {
      ...checkpoint.config,
      generations: argument("--generations") ? defaultConfig.generations : checkpoint.config.generations,
      anchorHandsPerCandidate: argument("--anchor-hands") ? defaultConfig.anchorHandsPerCandidate : checkpoint.config.anchorHandsPerCandidate,
      anchorRoundsPerGeneration: argument("--anchor-rounds") ? defaultConfig.anchorRoundsPerGeneration : checkpoint.config.anchorRoundsPerGeneration,
    };
    population = checkpoint.population;
    for (const policy of population) validatePolicy(policy);
    startGeneration = checkpoint.nextGeneration;
    hallOfFame = checkpoint.hallOfFame;
    history = checkpoint.history;
    runId = checkpoint.runId;
    outputDirectory = path.resolve(argument("--output") ?? path.dirname(path.resolve(resumePath)));
  } else {
    validateConfig(config);
    const initialPolicyPath = argument("--initial-policy");
    if (initialPolicyPath) {
      const initialPayload = JSON.parse(readFileSync(path.resolve(initialPolicyPath), "utf8")) as SelfPlayPolicy | { policy: SelfPlayPolicy };
      const center = "policy" in initialPayload ? initialPayload.policy : initialPayload;
      population = makeCenteredPopulation(
        config.populationSize,
        config.seed,
        center,
        numberArgument("--initial-radius", 0.06),
      );
    } else {
      population = makeInitialPopulation(config.populationSize, config.seed);
    }
    outputDirectory = path.resolve(argument("--output") ?? path.join("training-output", runId));
  }
  validateConfig(config);
  if (startGeneration >= config.generations) throw new Error("Checkpoint has already reached the configured generation count");

  const displayOutputDirectory = path.relative(process.cwd(), outputDirectory) || ".";
  logger = new TrainingLogger(outputDirectory);
  logger.event(resumePath ? "run_resume" : "run_start", resumePath
    ? `继续训练：从第 ${startGeneration + 1} 代开始，输出 ${displayOutputDirectory}`
    : `开始训练：${config.populationSize} 个策略，${config.generations} 代，每桌每轮 ${config.handsPerTable} 手`, {
    runId,
    outputDirectory: displayOutputDirectory,
    config,
    startGeneration,
  });

  let latestBest: PolicyEvaluation | undefined;
  for (let generation = startGeneration; generation < config.generations; generation += 1) {
    logger.event("generation_start", `第 ${generation + 1}/${config.generations} 代开始`, {
      generation,
      population: population.map((policy) => policy.id),
    });
    let matchNumber = 0;
    let lastMatchAt = Date.now();
    const evaluation = evaluatePopulation(population, config, generation, (progress) => {
      matchNumber += 1;
      const now = Date.now();
      const durationMs = Math.max(1, now - lastMatchAt);
      lastMatchAt = now;
      logger!.event("match_complete", `第 ${generation + 1} 代桌 ${matchNumber}：${progress.hands} 手，${progress.actions} 次行动，${(progress.hands / durationMs * 1000).toFixed(2)} 手牌/秒`, {
        ...progress,
        durationMs,
        handsPerSecond: progress.hands / durationMs * 1000,
      });
    });
    latestBest = evaluation.evaluations[0];
    hallOfFame = bestHallOfFame(evaluation.evaluations, hallOfFame);
    history.push({
      generation,
      championId: latestBest.policy.id,
      fitness: latestBest.fitness,
      bb100: latestBest.bb100,
      handsPlayed: evaluation.handsPlayed,
    });
    logger.event("generation_complete", `第 ${generation + 1} 代冠军 ${latestBest.policy.id}：fitness=${latestBest.fitness.toFixed(2)}，稳健/原始 BB/100=${(latestBest.robustBb100 ?? latestBest.bb100).toFixed(2)}/${latestBest.bb100.toFixed(2)}，可读性=${latestBest.actionPredictability.toFixed(3)}（${latestBest.riverSamples} 个河牌样本）`, {
      generation,
      matches: evaluation.matches,
      handsPlayed: evaluation.handsPlayed,
      totalActions: evaluation.totalActions,
      champion: latestBest,
      ranking: evaluation.evaluations.map((entry) => ({
        policyId: entry.policy.id,
        fitness: entry.fitness,
        bb100: entry.bb100,
        robustBb100: entry.robustBb100,
        matchStdDev: entry.matchStdDev,
        matchSamples: entry.matchSamples,
        hands: entry.hands,
        aggressionRate: entry.aggressionRate,
        jamRate: entry.jamRate,
        deepIrrationalJamRate: entry.deepIrrationalJamRate,
        actionPredictability: entry.actionPredictability,
        normalizedActionEntropy: entry.normalizedActionEntropy,
        riverSamples: entry.riverSamples,
      })),
    });

    population = evolvePopulation(
      evaluation.evaluations,
      generation + 1,
      config.seed,
      config.mutationRate,
      config.eliteFraction,
    );
    const checkpoint: TrainingCheckpoint = {
      schemaVersion: 1,
      runId,
      nextGeneration: generation + 1,
      config,
      population,
      hallOfFame,
      history,
    };
    const checkpointName = `checkpoint-gen-${String(generation + 1).padStart(4, "0")}.json`;
    const checkpointPath = logger.writeJson(checkpointName, checkpoint);
    logger.event("checkpoint_saved", `检查点已保存：${checkpointName}`, { generation, checkpointPath: path.basename(checkpointPath) });
  }

  const best = hallOfFame[0] ?? latestBest;
  if (!best) throw new Error("Training produced no evaluated policy");
  logger.writeJson("best-policy.json", {
    schemaVersion: 1,
    runId,
    trainedAt: new Date().toISOString(),
    seed: config.seed,
    evaluatedHands: best.hands,
    fitness: best.fitness,
    bb100: best.bb100,
    robustBb100: best.robustBb100,
    matchStdDev: best.matchStdDev,
    policy: best.policy,
  });
  const totalTrainingHands = history.reduce((sum, entry) => sum + entry.handsPlayed, 0);
  logger.writeJson("summary.json", { runId, config, best, hallOfFame, history, totalTrainingHands });
  if (rawArgs.includes("--promote") || rawArgs.includes("--force-promote")) {
    const trainingDirectory = path.dirname(fileURLToPath(import.meta.url));
    const targetPath = path.resolve(trainingDirectory, "../lib/poker/policies/expert-selfplay.json");
    const promoted = promotePolicy(best, config, totalTrainingHands, targetPath, rawArgs.includes("--force-promote"));
    logger.event("policy_promoted", `策略 ${promoted.policyId} 已晋级；下次启动或构建时应用于高手 AI`, {
      policyId: promoted.policyId,
      evaluatedHands: promoted.evaluatedHands,
      totalTrainingHands: promoted.totalTrainingHands,
      fitness: promoted.fitness,
    });
  }
  logger.event("run_complete", `训练完成：最佳策略 ${best.policy.id}，日志目录 ${displayOutputDirectory}`, {
    runId,
    bestPolicyId: best.policy.id,
    bestFitness: best.fitness,
    bestBb100: best.bb100,
    outputDirectory: displayOutputDirectory,
    totalTrainingHands,
  });
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  const safeMessage = message.replace(/[A-Z]:[\\/]Users[\\/][^\\/\s]+/gi, "<user-profile>");
  logger?.event("run_error", "训练异常终止，最近检查点仍可用于恢复", { message: safeMessage });
  console.error(message);
  process.exitCode = 1;
}