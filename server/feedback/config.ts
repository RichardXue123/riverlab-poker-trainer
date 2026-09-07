import fs from "node:fs";
import path from "node:path";

export type FixProviderKind = "agy" | "codex";

export interface AgyProviderSettings {
  command?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | string;
  mode?: "accept-edits" | "plan" | string;
  dangerouslySkipPermissions?: boolean;
}

export interface CodexProviderSettings {
  command?: string;
}

export interface FeedbackConfigFile {
  provider: FixProviderKind;
  timeoutMs?: number;
  agy?: AgyProviderSettings;
  codex?: CodexProviderSettings;
}

export const DEFAULT_FEEDBACK_CONFIG: FeedbackConfigFile = {
  provider: "agy",
  timeoutMs: 45 * 60_000,
  agy: {
    command: "agy",
    mode: "accept-edits",
    effort: "high",
    dangerouslySkipPermissions: true,
  },
  codex: {
    command: "codex",
  },
};

export function normalizeProvider(name: unknown): FixProviderKind {
  const str = String(name || "").trim().toLowerCase();
  if (str === "codex" || str === "codex-cli") return "codex";
  return "agy";
}

export function getFeedbackConfigPath(root: string): string {
  if (process.env.FEEDBACK_CONFIG_PATH) {
    return path.resolve(process.env.FEEDBACK_CONFIG_PATH);
  }
  return path.join(root, "feedback.config.json");
}

export function loadFeedbackConfig(root: string): FeedbackConfigFile {
  const filePath = getFeedbackConfigPath(root);
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<FeedbackConfigFile>;
      const provider = normalizeProvider(parsed.provider);
      return {
        ...DEFAULT_FEEDBACK_CONFIG,
        ...parsed,
        provider,
        agy: { ...DEFAULT_FEEDBACK_CONFIG.agy, ...parsed.agy },
        codex: { ...DEFAULT_FEEDBACK_CONFIG.codex, ...parsed.codex },
      };
    }
  } catch (error) {
    console.warn(`[Feedback] 读取配置文件 ${filePath} 失败，将使用默认配置:`, error);
  }
  return { ...DEFAULT_FEEDBACK_CONFIG };
}

export function saveFeedbackConfig(root: string, partial: Partial<FeedbackConfigFile>): FeedbackConfigFile {
  const filePath = getFeedbackConfigPath(root);
  const current = loadFeedbackConfig(root);
  const provider = partial.provider ? normalizeProvider(partial.provider) : current.provider;
  const updated: FeedbackConfigFile = {
    ...current,
    ...partial,
    provider,
    agy: partial.agy ? { ...current.agy, ...partial.agy } : current.agy,
    codex: partial.codex ? { ...current.codex, ...partial.codex } : current.codex,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(updated, null, 2) + "\n", "utf8");
  return updated;
}
