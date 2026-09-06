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
}

export interface FeedbackListResponse {
  items: FeedbackRecord[];
}

export interface FeedbackRuntimeInfo {
  provider: string;
  running: boolean;
  lastSweepAt?: string;
  nextSweepAt?: string;
}

