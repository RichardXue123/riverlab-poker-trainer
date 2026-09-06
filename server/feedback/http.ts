import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FeedbackKind, FeedbackStatus } from "../../lib/feedback/types";
import type { FeedbackRuntime } from "./runtime";

type Next = (error?: unknown) => void;

interface RateEntry { count: number; resetAt: number }

const submissionRates = new Map<string, RateEntry>();
const failedKeyRates = new Map<string, RateEntry>();

export function createFeedbackMiddleware(runtime: FeedbackRuntime) {
  return async function feedbackMiddleware(req: IncomingMessage, res: ServerResponse, next: Next): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (!url.pathname.startsWith("/api/feedback")) return next();

    try {
      if (req.method === "GET" && url.pathname === "/api/feedback") {
        const kind = parseKind(url.searchParams.get("kind"));
        if (kind === "developer" && !authorize(req, res)) return;
        return sendJson(res, 200, { items: runtime.repository.list(kind) });
      }

      if (req.method === "POST" && url.pathname === "/api/feedback") {
        const ip = clientIp(req);
        if (!consumeRate(submissionRates, ip, 6, 60_000)) return sendError(res, 429, "提交过于频繁，请稍后再试");
        const body = await readJson(req) as { kind?: unknown; playerName?: unknown; content?: unknown; developerKey?: unknown };
        const kind = parseKind(body.kind);
        if (kind === "developer" && !authorize(req, res, body.developerKey)) return;
        const playerName = cleanText(body.playerName, 24, "玩家名字");
        const content = cleanText(body.content, 4000, "反馈内容", 2);
        return sendJson(res, 201, { item: runtime.repository.create({ kind, playerName, content }) });
      }

      if (req.method === "GET" && url.pathname === "/api/feedback/runtime") {
        if (!authorize(req, res)) return;
        return sendJson(res, 200, runtime.worker.info());
      }

      if (req.method === "POST" && url.pathname === "/api/feedback/run") {
        if (!authorize(req, res)) return;
        if (runtime.worker.info().running) return sendError(res, 409, "已有自动修复任务正在运行");
        void runtime.worker.runNow();
        return sendJson(res, 202, { accepted: true });
      }

      const match = url.pathname.match(/^\/api\/feedback\/(F\d{6})$/);
      if (req.method === "PATCH" && match) {
        if (!authorize(req, res)) return;
        const body = await readJson(req) as { status?: unknown };
        const status = parseStatus(body.status);
        const item = runtime.repository.updateStatus(match[1], status);
        if (!item) return sendError(res, 404, "反馈不存在");
        return sendJson(res, 200, { item });
      }

      return sendError(res, 404, "接口不存在");
    } catch (error) {
      const message = error instanceof Error ? error.message : "服务器处理反馈时发生错误";
      return sendError(res, message.includes("过大") ? 413 : 400, message);
    }
  };
}

function authorize(req: IncomingMessage, res: ServerResponse, bodyKey?: unknown): boolean {
  const ip = clientIp(req);
  if (!consumeRate(failedKeyRates, ip, 12, 10 * 60_000, false)) {
    sendError(res, 429, "密钥尝试次数过多，请稍后再试");
    return false;
  }
  const supplied = typeof req.headers["x-developer-key"] === "string"
    ? req.headers["x-developer-key"]
    : typeof bodyKey === "string" ? bodyKey : "";
  const expected = process.env.FEEDBACK_DEVELOPER_KEY || "2026";
  const validFormat = /^\d+$/.test(supplied);
  const valid = validFormat && safeEqual(supplied, expected);
  if (!valid) {
    consumeRate(failedKeyRates, ip, 12, 10 * 60_000, true);
    sendError(res, 403, "开发者密钥不正确");
  }
  return valid;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseKind(value: unknown): FeedbackKind {
  if (value === "player" || value === "developer") return value;
  throw new Error("反馈类型无效");
}

function parseStatus(value: unknown): FeedbackStatus {
  if (value === "pending" || value === "processing" || value === "resolved") return value;
  throw new Error("反馈状态无效");
}

function cleanText(value: unknown, maxLength: number, label: string, minLength = 1): string {
  if (typeof value !== "string") throw new Error(`${label}不能为空`);
  const cleaned = value.replace(/\0/g, "").trim();
  if (cleaned.length < minLength) throw new Error(`${label}不能为空`);
  if (cleaned.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return cleaned;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > 16_384) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求格式无效");
  }
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress || "unknown";
}

function consumeRate(map: Map<string, RateEntry>, key: string, limit: number, windowMs: number, increment = true): boolean {
  const now = Date.now();
  let entry = map.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs };
    map.set(key, entry);
  }
  if (entry.count >= limit) return false;
  if (increment) entry.count += 1;
  return true;
}

function sendError(res: ServerResponse, status: number, error: string): void {
  sendJson(res, status, { error });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

