import fs from "node:fs";
import path from "node:path";
import type { FeedbackKind, FeedbackRecord, FeedbackStatus } from "../../lib/feedback/types";

interface FeedbackStore {
  version: 1;
  nextId: number;
  lastSweepAt?: string;
  items: FeedbackRecord[];
}

export interface CreateFeedbackInput {
  kind: FeedbackKind;
  playerName: string;
  content: string;
  targetProvider?: "agy" | "codex";
}

export interface FeedbackRepository {
  list(kind: FeedbackKind): FeedbackRecord[];
  create(input: CreateFeedbackInput): FeedbackRecord;
  updateStatus(id: string, status: FeedbackStatus): FeedbackRecord | undefined;
  updateTargetProvider(id: string, targetProvider: "agy" | "codex"): FeedbackRecord | undefined;
  hasClaimableDeveloper(targetId?: string, forceImmediate?: boolean, now?: Date): boolean;
  claimOldestDeveloper(now?: Date, forceImmediate?: boolean): FeedbackRecord | undefined;
  claimDeveloperById(id: string, now?: Date): FeedbackRecord | undefined;

  delete(id: string): boolean;
  markAwaitingReview(id: string, result: Pick<FeedbackRecord, "branchName" | "commitHash" | "aiProvider" | "aiSummary" | "testSummary">): FeedbackRecord | undefined;
  markAttemptFailed(id: string, error: string, retryAt?: Date, needsManual?: boolean): FeedbackRecord | undefined;
  getLastSweepAt(): string | undefined;
  setLastSweepAt(value: string): void;
}

const DEFAULT_STORE: FeedbackStore = { version: 1, nextId: 1, items: [] };

export class JsonFeedbackRepository implements FeedbackRepository {
  private readonly filePath: string;
  private store: FeedbackStore;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.store = this.load();
    let recovered = false;
    for (const item of this.store.items) {
      if (item.kind === "developer" && item.status === "processing" && item.statusDetail === "AI 正在分析与修复") {
        item.status = "pending";
        item.statusDetail = "上次自动修复中断，等待重试";
        item.updatedAt = new Date().toISOString();
        recovered = true;
      }
    }
    if (recovered) this.persist();
  }

  list(kind: FeedbackKind): FeedbackRecord[] {
    return this.store.items
      .filter((item) => item.kind === kind)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((item) => structuredClone(item));
  }

  create(input: CreateFeedbackInput): FeedbackRecord {
    const now = new Date().toISOString();
    const item: FeedbackRecord = {
      id: `F${String(this.store.nextId).padStart(6, "0")}`,
      kind: input.kind,
      playerName: input.playerName,
      content: input.content,
      createdAt: now,
      updatedAt: now,
      status: "pending",
      statusDetail: input.kind === "developer" ? "等待自动修复" : "等待处理",
      attempts: 0,
      ...(input.targetProvider ? { targetProvider: input.targetProvider } : {}),
    };
    this.store.nextId += 1;
    this.store.items.push(item);
    this.persist();
    return structuredClone(item);
  }

  updateTargetProvider(id: string, targetProvider: "agy" | "codex"): FeedbackRecord | undefined {
    const item = this.store.items.find((entry) => entry.id === id);
    if (!item) return undefined;
    item.targetProvider = targetProvider;
    item.updatedAt = new Date().toISOString();
    this.persist();
    return structuredClone(item);
  }

  updateStatus(id: string, status: FeedbackStatus): FeedbackRecord | undefined {
    const item = this.store.items.find((entry) => entry.id === id);
    if (!item) return undefined;
    item.status = status;
    item.updatedAt = new Date().toISOString();
    item.statusDetail = status === "resolved" ? "已由开发者确认处理" : status === "processing" ? "开发者处理中" : item.kind === "developer" ? "等待自动修复" : "等待处理";
    if (status === "pending") {
      item.attempts = 0;
      delete item.nextAttemptAt;
      delete item.lastError;
      delete item.branchName;
      delete item.commitHash;
      delete item.aiSummary;
      delete item.testSummary;
    }
    this.persist();
    return structuredClone(item);
  }

  delete(id: string): boolean {
    const index = this.store.items.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    this.store.items.splice(index, 1);
    this.persist();
    return true;
  }

  hasClaimableDeveloper(targetId?: string, forceImmediate = false, now = new Date()): boolean {
    const nowIso = now.toISOString();
    if (targetId) {
      const item = this.store.items.find((entry) => entry.id === targetId && entry.kind === "developer");
      if (!item) return false;
      if (item.status !== "pending") return false;
      if (item.statusDetail?.includes("待人工处理") || item.statusDetail?.includes("已暂停")) return false;
      if (forceImmediate) return true;
      return item.attempts < 3 && (!item.nextAttemptAt || item.nextAttemptAt <= nowIso);
    }
    return this.store.items.some((entry) => {
      if (entry.kind !== "developer" || entry.status !== "pending") return false;
      if (entry.statusDetail?.includes("待人工处理") || entry.statusDetail?.includes("已暂停")) return false;
      if (forceImmediate) return true;
      return entry.attempts < 3 && (!entry.nextAttemptAt || entry.nextAttemptAt <= nowIso);
    });
  }

  claimOldestDeveloper(now = new Date(), forceImmediate = false): FeedbackRecord | undefined {
    const nowIso = now.toISOString();
    const item = this.store.items
      .filter((entry) => {
        if (entry.kind !== "developer" || entry.status !== "pending") return false;
        if (entry.statusDetail?.includes("待人工处理") || entry.statusDetail?.includes("已暂停")) return false;
        if (forceImmediate) return true;
        return entry.attempts < 3 && (!entry.nextAttemptAt || entry.nextAttemptAt <= nowIso);
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!item) return undefined;
    item.status = "processing";
    item.statusDetail = "AI 正在分析与修复";
    item.attempts += 1;
    item.updatedAt = nowIso;
    delete item.lastError;
    delete item.nextAttemptAt;
    this.persist();
    return structuredClone(item);
  }

  claimDeveloperById(id: string, now = new Date()): FeedbackRecord | undefined {
    const nowIso = now.toISOString();
    const item = this.store.items.find((entry) => entry.id === id && entry.kind === "developer");
    if (!item) return undefined;
    item.status = "processing";
    item.statusDetail = "AI 正在分析与修复";
    item.attempts += 1;
    item.updatedAt = nowIso;
    delete item.lastError;
    delete item.nextAttemptAt;
    this.persist();
    return structuredClone(item);
  }

  markAwaitingReview(id: string, result: Pick<FeedbackRecord, "branchName" | "commitHash" | "aiProvider" | "aiSummary" | "testSummary">): FeedbackRecord | undefined {
    const item = this.store.items.find((entry) => entry.id === id);
    if (!item) return undefined;
    if (item.status !== "processing" || item.statusDetail !== "AI 正在分析与修复") return structuredClone(item);
    Object.assign(item, result);
    item.status = "processing";
    item.statusDetail = "AI 已生成修复，等待人工验收";
    item.updatedAt = new Date().toISOString();
    delete item.nextAttemptAt;
    delete item.lastError;
    this.persist();
    return structuredClone(item);
  }

  markAttemptFailed(id: string, error: string, retryAt?: Date, needsManual = false): FeedbackRecord | undefined {
    const item = this.store.items.find((entry) => entry.id === id);
    if (!item) return undefined;
    if (item.status !== "processing" || item.statusDetail !== "AI 正在分析与修复") return structuredClone(item);
    item.status = "pending";
    item.lastError = error.slice(0, 2000);
    item.updatedAt = new Date().toISOString();
    if (needsManual) {
      item.statusDetail = "自动修复失败，待人工处理";
      delete item.nextAttemptAt;
    } else if (item.attempts >= 3) {
      item.statusDetail = "自动修复已暂停，需要人工处理或重新打开";
      delete item.nextAttemptAt;
    } else {
      item.statusDetail = `自动修复失败，等待第 ${item.attempts + 1} 次尝试`;
      item.nextAttemptAt = (retryAt || new Date(Date.now() + 5 * 60 * 60 * 1000)).toISOString();
    }
    this.persist();
    return structuredClone(item);
  }

  getLastSweepAt(): string | undefined {
    return this.store.lastSweepAt;
  }

  setLastSweepAt(value: string): void {
    this.store.lastSweepAt = value;
    this.persist();
  }

  private load(): FeedbackStore {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as FeedbackStore;
      if (parsed.version === 1 && Array.isArray(parsed.items)) return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`无法读取反馈数据：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return structuredClone(DEFAULT_STORE);
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(this.store, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, this.filePath);
  }
}
