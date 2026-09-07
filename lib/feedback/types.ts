export type FeedbackKind = "player" | "developer";

export type FeedbackStatus = "pending" | "processing" | "resolved";

export interface FeedbackRecord {
  id: string;
  kind: FeedbackKind;
  playerName: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  status: FeedbackStatus;
  statusDetail: string;
  attempts: number;
  nextAttemptAt?: string;
  branchName?: string;
  commitHash?: string;
  aiProvider?: string;
  aiSummary?: string;
  testSummary?: string;
  lastError?: string;
  targetProvider?: "agy" | "codex";
}

export interface FeedbackListResponse {
  items: FeedbackRecord[];
}

export interface FeedbackRuntimeInfo {
  provider: string;
  running: boolean;
  autofixEnabled?: boolean;
  lastSweepAt?: string;
  nextSweepAt?: string;
}

export interface FeedbackConfigResponse {
  config: {
    provider: string;
    timeoutMs?: number;
    agy?: {
      command?: string;
      model?: string;
      effort?: string;
      mode?: string;
      dangerouslySkipPermissions?: boolean;
    };
    codex?: {
      command?: string;
    };
  };
  activeProvider: string;
  availableProviders: string[];
}

