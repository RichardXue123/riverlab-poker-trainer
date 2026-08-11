import type { PlayerActionType } from "./types";

export interface AiAuditSample {
  action: PlayerActionType;
  sizeBucket: "none" | "small" | "medium" | "large" | "jam";
  value: boolean;
}

export interface AiReadabilityAudit {
  samples: number;
  actionPredictability: number;
  jamBluffShare: number;
  normalizedActionEntropy: number;
  aggressiveSamples: number;
  aggressiveValueShare: number;
  bluffAggressionRate: number;
  valuePassiveRate: number;
}

/**
 * Measures how easily a player could infer value versus bluff from the public action
 * and size alone. Lower predictability and higher entropy mean fewer fixed tells.
 */
export function auditAiReadability(samples: AiAuditSample[]): AiReadabilityAudit {
  if (samples.length === 0) {
    return {
      samples: 0,
      actionPredictability: 0,
      jamBluffShare: 0,
      normalizedActionEntropy: 0,
      aggressiveSamples: 0,
      aggressiveValueShare: 0,
      bluffAggressionRate: 0,
      valuePassiveRate: 0,
    };
  }

  const groups = new Map<string, { value: number; bluff: number }>();
  const actionCounts = new Map<PlayerActionType, number>();
  for (const sample of samples) {
    const key = `${sample.action}:${sample.sizeBucket}`;
    const group = groups.get(key) ?? { value: 0, bluff: 0 };
    if (sample.value) group.value += 1;
    else group.bluff += 1;
    groups.set(key, group);
    actionCounts.set(sample.action, (actionCounts.get(sample.action) ?? 0) + 1);
  }

  const predictable = [...groups.values()].reduce((sum, group) => sum + Math.max(group.value, group.bluff), 0);
  const jams = samples.filter((sample) => sample.action === "all-in");
  const jamBluffs = jams.filter((sample) => !sample.value).length;
  const aggressive = samples.filter((sample) => ["bet", "raise", "all-in"].includes(sample.action));
  const aggressiveValue = aggressive.filter((sample) => sample.value).length;
  const bluffs = samples.filter((sample) => !sample.value);
  const values = samples.filter((sample) => sample.value);
  const bluffAggression = bluffs.filter((sample) => ["bet", "raise", "all-in"].includes(sample.action)).length;
  const valuePassive = values.filter((sample) => !["bet", "raise", "all-in"].includes(sample.action)).length;
  let entropy = 0;
  for (const count of actionCounts.values()) {
    const probability = count / samples.length;
    entropy -= probability * Math.log2(probability);
  }
  const maximumEntropy = Math.log2(Math.max(2, actionCounts.size));

  return {
    samples: samples.length,
    actionPredictability: predictable / samples.length,
    jamBluffShare: jams.length > 0 ? jamBluffs / jams.length : 0,
    normalizedActionEntropy: entropy / maximumEntropy,
    aggressiveSamples: aggressive.length,
    aggressiveValueShare: aggressive.length > 0 ? aggressiveValue / aggressive.length : 0,
    bluffAggressionRate: bluffs.length > 0 ? bluffAggression / bluffs.length : 0,
    valuePassiveRate: values.length > 0 ? valuePassive / values.length : 0,
  };
}