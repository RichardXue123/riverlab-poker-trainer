import fs from "node:fs";
import path from "node:path";
import type { FeedbackRuntimeInfo } from "../../lib/feedback/types";
import type { AiFixProvider } from "./ai-provider";
import type { FeedbackRepository } from "./repository";
import { runProcess } from "./process";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const RETRY_DELAY_MS = 5 * 60 * 60 * 1000;

export class FeedbackFixWorker {
  private timer?: NodeJS.Timeout;
  private running = false;
  private started = false;
  private nextSweepAt?: string;

  constructor(
    private readonly root: string,
    private readonly dataDir: string,
    private readonly repository: FeedbackRepository,
    private readonly provider: AiFixProvider,
  ) {}

  start(): void {
    if (this.started || process.env.FEEDBACK_AUTOFIX_ENABLED === "false") return;
    this.started = true;
    const lastSweepAt = this.repository.getLastSweepAt();
    if (!lastSweepAt) {
      const now = new Date().toISOString();
      this.repository.setLastSweepAt(now);
      this.schedule(FIVE_HOURS_MS);
      return;
    }
    const elapsed = Date.now() - Date.parse(lastSweepAt);
    this.schedule(Math.max(0, FIVE_HOURS_MS - elapsed));
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  info(): FeedbackRuntimeInfo {
    return {
      provider: this.provider.name,
      running: this.running,
      lastSweepAt: this.repository.getLastSweepAt(),
      nextSweepAt: this.nextSweepAt,
    };
  }

  async runNow(): Promise<boolean> {
    if (this.running) return false;
    await this.sweep(false);
    return true;
  }

  private schedule(delayMs: number): void {
    if (!this.started) return;
    const safeDelay = Math.max(500, delayMs);
    this.nextSweepAt = new Date(Date.now() + safeDelay).toISOString();
    this.timer = setTimeout(() => void this.sweep(true), safeDelay);
    this.timer.unref();
  }

  private async sweep(scheduled: boolean): Promise<void> {
    if (this.running) {
      if (scheduled) this.schedule(60_000);
      return;
    }
    this.running = true;
    if (scheduled) this.repository.setLastSweepAt(new Date().toISOString());
    try {
      const feedback = this.repository.claimOldestDeveloper();
      if (feedback) await this.processFeedback(feedback.id);
    } finally {
      this.running = false;
      if (scheduled) this.schedule(FIVE_HOURS_MS);
    }
  }

  private async processFeedback(id: string): Promise<void> {
    const feedback = this.repository.list("developer").find((item) => item.id === id);
    if (!feedback) return;
    const worktreesDir = path.join(this.root, ".feedback-worktrees");
    const worktreePath = path.join(worktreesDir, feedback.id.toLowerCase());
    const logsDir = path.join(this.dataDir, "feedback-logs", feedback.id);
    fs.mkdirSync(worktreesDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
    const branchName = await this.uniqueBranchName(feedback.id);
    let worktreeCreated = false;

    try {
      await this.mustRun("git", ["worktree", "add", "-b", branchName, worktreePath, "HEAD"], this.root, 2 * 60_000);
      worktreeCreated = true;

      const aiResult = await this.provider.run({ feedback, worktreePath });
      fs.writeFileSync(path.join(logsDir, `attempt-${feedback.attempts}-ai.log`), aiResult.rawLog, "utf8");

      const changed = await this.mustRun("git", ["status", "--short"], worktreePath, 30_000);
      if (!changed.stdout.trim()) throw new Error("AI 未产生代码修改；可能无法复现或反馈信息不足");

      const checks = [
        ["npm", ["test"]],
        ["npm", ["run", "check"]],
        ["npm", ["run", "build"]],
      ] as const;
      const checkSummaries: string[] = [];
      for (const [command, args] of checks) {
        const result = await this.mustRun(command, [...args], worktreePath, 20 * 60_000);
        checkSummaries.push(`${command} ${args.join(" ")}：通过`);
        fs.writeFileSync(path.join(logsDir, `attempt-${feedback.attempts}-${args.at(-1)}.log`), `${result.stdout}\n${result.stderr}`, "utf8");
      }

      await this.mustRun("git", ["add", "-A"], worktreePath, 30_000);
      await this.mustRun("git", ["-c", "user.name=RiverLab Auto Fix", "-c", "user.email=riverlab-autofix@local", "commit", "-m", `fix: resolve ${feedback.id}`], worktreePath, 2 * 60_000);
      const commit = await this.mustRun("git", ["rev-parse", "HEAD"], worktreePath, 30_000);
      this.repository.markAwaitingReview(feedback.id, {
        branchName,
        commitHash: commit.stdout.trim(),
        aiProvider: this.provider.name,
        aiSummary: aiResult.summary,
        testSummary: checkSummaries.join("；"),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (worktreeCreated) {
        const diff = await runProcess("git", ["diff", "--binary", "HEAD"], { cwd: worktreePath, timeoutMs: 30_000, maxOutputBytes: 5_000_000 }).catch(() => undefined);
        if (diff?.stdout) fs.writeFileSync(path.join(logsDir, `attempt-${feedback.attempts}-failure.patch`), diff.stdout, "utf8");
      }
      this.repository.markAttemptFailed(feedback.id, message, new Date(Date.now() + RETRY_DELAY_MS));
    } finally {
      if (worktreeCreated) {
        await runProcess("git", ["worktree", "remove", "--force", worktreePath], { cwd: this.root, timeoutMs: 2 * 60_000 }).catch(() => undefined);
      }
      const success = this.repository.list("developer").find((item) => item.id === feedback.id)?.branchName === branchName;
      if (!success) {
        await runProcess("git", ["branch", "-D", branchName], { cwd: this.root, timeoutMs: 30_000 }).catch(() => undefined);
      }
    }
  }

  private async uniqueBranchName(feedbackId: string): Promise<string> {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    const parts = Object.fromEntries(formatter.formatToParts(new Date()).map((part) => [part.type, part.value]));
    const base = `CICD_${parts.month}${parts.day}_${parts.hour}${parts.minute}_bugfix`;
    const exists = await runProcess("git", ["show-ref", "--verify", "--quiet", `refs/heads/${base}`], { cwd: this.root, timeoutMs: 30_000 });
    return exists.exitCode === 0 ? `${base}_${feedbackId.replace(/^F0*/, "") || "1"}` : base;
  }

  private async mustRun(command: string, args: string[], cwd: string, timeoutMs: number) {
    const result = await runProcess(command, args, { cwd, timeoutMs, maxOutputBytes: 4_000_000 });
    if (result.timedOut) throw new Error(`${command} ${args.join(" ")} 执行超时`);
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-12).join("\n").slice(0, 2000);
      throw new Error(`${command} ${args.join(" ")} 失败（退出码 ${result.exitCode}）\n${detail}`);
    }
    return result;
  }
}
