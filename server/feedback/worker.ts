import fs from "node:fs";
import path from "node:path";
import type { FeedbackRuntimeInfo } from "../../lib/feedback/types";
import { type FixProviderKind, isAutofixEnabled } from "./config";
import { type AiFixProvider, createAiFixProvider } from "./ai-provider";
import type { FeedbackRepository } from "./repository";
import { runProcess } from "./process";
import { logger } from "../logger";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const RETRY_DELAY_MS = 5 * 60 * 60 * 1000;

export class FeedbackFixWorker {
  private timer?: NodeJS.Timeout;
  private running = false;
  private started = false;
  private nextSweepAt?: string;
  private providerOverride?: FixProviderKind;

  constructor(
    private readonly root: string,
    private readonly dataDir: string,
    private readonly repository: FeedbackRepository,
    private readonly explicitProvider?: AiFixProvider,
  ) {}

  getProvider(explicitName?: string): AiFixProvider {
    if (this.explicitProvider && !explicitName) return this.explicitProvider;
    return createAiFixProvider(this.root, explicitName || this.providerOverride);
  }

  setProvider(providerName: FixProviderKind): void {
    this.providerOverride = providerName;
    if (process.env.AI_FIX_PROVIDER) {
      process.env.AI_FIX_PROVIDER = providerName;
    }
  }

  start(force?: boolean): void {
    if (this.started) return;
    if (!force && !isAutofixEnabled()) return;
    this.started = true;
    logger.info("CICD", "Feedback fix worker started", undefined, { autofixEnabled: isAutofixEnabled() });
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
    logger.info("CICD", "Feedback fix worker stopped");
  }

  info(): FeedbackRuntimeInfo {
    return {
      provider: this.getProvider().name,
      running: this.running,
      autofixEnabled: isAutofixEnabled(),
      lastSweepAt: this.repository.getLastSweepAt(),
      nextSweepAt: this.nextSweepAt,
    };
  }

  async runNow(feedbackId?: string, targetProvider?: "agy" | "codex"): Promise<boolean> {
    if (this.running) return false;
    await this.sweep(false, feedbackId, targetProvider);
    return true;
  }

  private schedule(delayMs: number): void {
    if (!this.started) return;
    const safeDelay = Math.max(500, delayMs);
    this.nextSweepAt = new Date(Date.now() + safeDelay).toISOString();
    this.timer = setTimeout(() => void this.sweep(true), safeDelay);
    this.timer.unref();
  }

  private async sweep(scheduled: boolean, targetId?: string, targetProvider?: "agy" | "codex"): Promise<void> {
    if (this.running) {
      if (scheduled) this.schedule(60_000);
      return;
    }
    this.running = true;
    logger.info("CICD", `Feedback sweep started (scheduled=${scheduled}, targetId=${targetId || "oldest"})`, targetId);
    if (scheduled) this.repository.setLastSweepAt(new Date().toISOString());
    try {
      if (targetId && targetProvider) {
        this.repository.updateTargetProvider(targetId, targetProvider);
      }
      const feedback = targetId
        ? this.repository.claimDeveloperById(targetId)
        : this.repository.claimOldestDeveloper(new Date(), !scheduled);
      if (feedback) {
        await this.processFeedback(feedback.id, targetProvider);
      } else {
        logger.info("CICD", `No claimable feedback found in queue (target=${targetId || "oldest"}, scheduled=${scheduled})`);
      }

    } finally {
      this.running = false;
      if (scheduled) this.schedule(FIVE_HOURS_MS);
    }
  }

  private async processFeedback(id: string, preferredProvider?: "agy" | "codex"): Promise<void> {
    const feedback = this.repository.list("developer").find((item) => item.id === id);
    if (!feedback) return;
    const worktreesDir = path.join(this.root, ".feedback-worktrees");
    const worktreePath = path.join(worktreesDir, feedback.id.toLowerCase());
    const logsDir = path.join(this.dataDir, "feedback-logs", feedback.id);
    fs.mkdirSync(worktreesDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
    const branchName = await this.uniqueBranchName(feedback.id);
    let worktreeCreated = false;

    logger.info("CICD", `Processing feedback [${id}] (attempt #${feedback.attempts + 1}) on branch ${branchName}`, id);

    try {
      await this.mustRun("git", ["worktree", "add", "-b", branchName, worktreePath, "HEAD"], this.root, 2 * 60_000);
      worktreeCreated = true;

      const activeProvider = this.getProvider(preferredProvider);
      logger.info("CICD", `Invoking AI fix provider [${activeProvider.name}] for [${id}]`, id);
      const liveLogPath = path.join(this.root, "logs", "feedback-live.log");
      const appendLiveLog = (text: string) => {
        try {
          fs.appendFileSync(liveLogPath, text, "utf8");
        } catch {
          // ignore
        }
      };

      const aiResult = await activeProvider.run({ feedback, worktreePath, liveLogPath });
      fs.writeFileSync(path.join(logsDir, `attempt-${feedback.attempts}-ai.log`), aiResult.rawLog, "utf8");

      const changed = await this.mustRun("git", ["status", "--short"], worktreePath, 30_000);
      if (!changed.stdout.trim()) throw new Error("AI 未产生代码修改；可能无法复现或反馈信息不足");

      appendLiveLog("\n\n" + "=".repeat(80) + "\n【AI 修复执行完成，开始自动化流水线测试】\n" + "-".repeat(80) + "\n");
      const checks = [
        ["npm", ["test"]],
        ["npm", ["run", "check"]],
        ["npm", ["run", "build"]],
      ] as const;
      const checkSummaries: string[] = [];
      for (const [command, args] of checks) {
        logger.info("CICD", `Running validation check: ${command} ${args.join(" ")}`, id);
        appendLiveLog(`⏳ 正在执行验证: ${command} ${args.join(" ")} ...\n`);
        const result = await this.mustRun(command, [...args], worktreePath, 20 * 60_000);
        checkSummaries.push(`${command} ${args.join(" ")}：通过`);
        appendLiveLog(`✅ 验证通过: ${command} ${args.join(" ")}\n`);
        fs.writeFileSync(path.join(logsDir, `attempt-${feedback.attempts}-${args.at(-1)}.log`), `${result.stdout}\n${result.stderr}`, "utf8");
      }

      await this.mustRun("git", ["add", "-A"], worktreePath, 30_000);
      await this.mustRun("git", ["-c", "user.name=RiverLab Auto Fix", "-c", "user.email=riverlab-autofix@local", "commit", "-m", `fix: resolve ${feedback.id}`], worktreePath, 2 * 60_000);
      const commit = await this.mustRun("git", ["rev-parse", "HEAD"], worktreePath, 30_000);
      const commitHash = commit.stdout.trim();
      logger.info("CICD", `Feedback [${id}] fix committed successfully (${commitHash}) on ${branchName}`, id, {
        commitHash,
        provider: activeProvider.name,
      });

      appendLiveLog([
        "",
        "=".repeat(80),
        "🎉【自动修复成功完成】",
        `- 分支名称: ${branchName}`,
        `- 提交哈希: ${commitHash}`,
        `- AI 总结: ${aiResult.summary}`,
        "=".repeat(80),
        "",
      ].join("\n"));

      this.repository.markAwaitingReview(feedback.id, {
        branchName,
        commitHash,
        aiProvider: activeProvider.name,
        aiSummary: aiResult.summary,
        testSummary: checkSummaries.join("；"),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("CICD", `Feedback [${id}] auto-fix failed: ${message}`, id);
      const liveLogPath = path.join(this.root, "logs", "feedback-live.log");
      try {
        fs.appendFileSync(liveLogPath, `\n\n❌【修复未完成/失败】: ${message}\n`, "utf8");
      } catch {
        // ignore
      }
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
