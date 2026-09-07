import fs from "node:fs";
import path from "node:path";
import type { FeedbackRecord, FeedbackRuntimeInfo } from "../../lib/feedback/types";
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

  async runNow(feedbackId?: string, targetProvider?: "agy" | "codex"): Promise<{ started: boolean; message?: string }> {
    if (this.running) return { started: false, message: "已有自动修复任务正在运行" };
    const hasWork = this.repository.hasClaimableDeveloper(feedbackId, true);
    if (!hasWork) {
      return { started: false, message: feedbackId ? `反馈 [${feedbackId}] 当前无需自动修复` : "当前没有需要自动修复的反馈" };
    }
    void this.sweep(false, feedbackId, targetProvider);
    return { started: true };
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

    // 1. Pre-check: only invoke AI and setup worktree if there are claimable items
    const hasWork = this.repository.hasClaimableDeveloper(targetId, !scheduled);
    if (!hasWork) {
      logger.info("CICD", `Pre-check: No claimable developer feedback found (scheduled=${scheduled}, targetId=${targetId || "all"}). Skipping pipeline.`);
      if (scheduled) this.schedule(FIVE_HOURS_MS);
      return;
    }

    this.running = true;
    logger.info("CICD", `Feedback sweep started (scheduled=${scheduled}, targetId=${targetId || "sequential_queue"})`, targetId);
    if (scheduled) this.repository.setLastSweepAt(new Date().toISOString());

    const liveLogPath = path.join(this.root, "logs", "feedback-live.log");
    const appendLiveLog = (text: string) => {
      try {
        fs.appendFileSync(liveLogPath, text, "utf8");
      } catch {
        // ignore
      }
    };

    // 2. Create ONE unified test branch and ONE worktree for this entire pipeline run
    const branchName = await this.uniqueBranchName(targetId);
    const worktreesDir = path.join(this.root, ".feedback-worktrees");
    const worktreePath = path.join(worktreesDir, branchName.toLowerCase());
    fs.mkdirSync(worktreesDir, { recursive: true });

    let worktreeCreated = false;
    let anySuccess = false;
    const fixedItems: { id: string; bugTitle: string; fixSummary: string }[] = [];

    try {
      if (fs.existsSync(worktreePath)) {
        logger.warn("CICD", `Cleaning pre-existing worktree at ${worktreePath}`);
        await runProcess("git", ["worktree", "remove", "--force", worktreePath], { cwd: this.root, timeoutMs: 30_000 }).catch(() => undefined);
        await runProcess("git", ["worktree", "prune"], { cwd: this.root, timeoutMs: 30_000 }).catch(() => undefined);
        if (fs.existsSync(worktreePath)) {
          fs.rmSync(worktreePath, { recursive: true, force: true });
        }
      }

      await this.mustRun("git", ["worktree", "add", "-b", branchName, worktreePath, "HEAD"], this.root, 2 * 60_000);
      worktreeCreated = true;

      appendLiveLog([
        "",
        "=".repeat(80),
        `🚀【启动自动修复流水线】`,
        `- 统一测试分支: ${branchName}`,
        `- 隔离工作区: ${worktreePath}`,
        `- 启动模式: ${scheduled ? "定时巡检" : "手动触发"}`,
        "=".repeat(80),
        "",
      ].join("\n"));

      // 3. Process items in batch sequentially on this single test branch
      if (targetId) {
        if (targetProvider) {
          this.repository.updateTargetProvider(targetId, targetProvider);
        }
        const feedback = this.repository.claimDeveloperById(targetId);
        if (feedback) {
          const ok = await this.processSingleFeedback(feedback, branchName, worktreePath, targetProvider, appendLiveLog);
          if (ok.success) {
            anySuccess = true;
            fixedItems.push({ id: feedback.id, bugTitle: ok.bugTitle, fixSummary: ok.fixSummary });
          }
        }
      } else {
        while (true) {
          const feedback = this.repository.claimOldestDeveloper(new Date(), !scheduled);
          if (!feedback) {
            logger.info("CICD", `No more claimable feedback in queue for branch ${branchName}`);
            break;
          }
          const ok = await this.processSingleFeedback(feedback, branchName, worktreePath, targetProvider, appendLiveLog);
          if (ok.success) {
            anySuccess = true;
            fixedItems.push({ id: feedback.id, bugTitle: ok.bugTitle, fixSummary: ok.fixSummary });
          }
        }
      }

      if (anySuccess) {
        appendLiveLog([
          "",
          "=".repeat(80),
          `🎉【本轮流水线全部修复完成】`,
          `- 统一测试分支: ${branchName}`,
          `- 成功修复反馈条数: ${fixedItems.length}`,
          ...fixedItems.map((item) => `  * [${item.id}] ${item.bugTitle} -> ${item.fixSummary}`),
          `- 提示: 开发者可直接检出该分支 (git checkout ${branchName}) 进行集中验收。`,
          "=".repeat(80),
          "",
        ].join("\n"));
      } else {
        appendLiveLog(`\n⚠️ 本轮流水线结束，未能产出任何有效修复。\n`);
      }
    } finally {
      if (worktreeCreated) {
        await runProcess("git", ["worktree", "remove", "--force", worktreePath], { cwd: this.root, timeoutMs: 2 * 60_000 }).catch(() => undefined);
        await runProcess("git", ["worktree", "prune"], { cwd: this.root, timeoutMs: 30_000 }).catch(() => undefined);
      }
      if (!anySuccess) {
        await runProcess("git", ["branch", "-D", branchName], { cwd: this.root, timeoutMs: 30_000 }).catch(() => undefined);
      }
      this.running = false;
      if (scheduled) this.schedule(FIVE_HOURS_MS);
    }
  }

  private async processSingleFeedback(
    feedback: FeedbackRecord,
    branchName: string,
    worktreePath: string,
    preferredProvider: "agy" | "codex" | undefined,
    appendLiveLog: (text: string) => void,
  ): Promise<{ success: boolean; bugTitle: string; fixSummary: string }> {
    const logsDir = path.join(this.dataDir, "feedback-logs", feedback.id);
    fs.mkdirSync(logsDir, { recursive: true });

    const activeProvider = this.getProvider(preferredProvider || feedback.targetProvider);
    logger.info("CICD", `Processing feedback [${feedback.id}] (attempt #${feedback.attempts}) with [${activeProvider.name}] on shared branch ${branchName}`, feedback.id);

    appendLiveLog(`\n▶ [${feedback.id}] 开始自动修复（提交人：${feedback.playerName}，引擎：${activeProvider.name}）...\n`);

    const bugTitle = feedback.content.split(/\r?\n/)[0].trim().slice(0, 80) || feedback.id;
    let fixSummary = "代码修复与全量测试通过";

    try {
      const liveLogPath = path.join(this.root, "logs", "feedback-live.log");
      const aiResult = await activeProvider.run({ feedback, worktreePath, liveLogPath });
      fs.writeFileSync(path.join(logsDir, `attempt-${feedback.attempts}-ai.log`), aiResult.rawLog, "utf8");

      const changed = await this.mustRun("git", ["status", "--short"], worktreePath, 30_000);
      if (!changed.stdout.trim()) throw new Error("AI 未产生代码修改；可能无法复现或反馈信息不足");

      appendLiveLog(`\n【AI 修复执行完成，开始自动化流水线测试 [${feedback.id}]】\n`);
      const checks = [
        ["npm", ["test"]],
        ["npm", ["run", "check"]],
        ["npm", ["run", "build"]],
      ] as const;
      const checkSummaries: string[] = [];
      for (const [command, args] of checks) {
        logger.info("CICD", `Running validation check: ${command} ${args.join(" ")}`, feedback.id);
        appendLiveLog(`⏳ 正在执行验证: ${command} ${args.join(" ")} ...\n`);
        const result = await this.mustRun(command, [...args], worktreePath, 20 * 60_000);
        checkSummaries.push(`${command} ${args.join(" ")}：通过`);
        appendLiveLog(`✅ 验证通过: ${command} ${args.join(" ")}\n`);
        fs.writeFileSync(path.join(logsDir, `attempt-${feedback.attempts}-${args.at(-1)}.log`), `${result.stdout}\n${result.stderr}`, "utf8");
      }

      if (aiResult.summary) {
        fixSummary = aiResult.summary.split(/\r?\n/)[0].trim().slice(0, 100);
      }

      const conciseBug = feedback.content.replace(/\r?\n+/g, " ").trim().slice(0, 200);
      const commitMessage = [
        `fix(feedback): resolve ${feedback.id} - ${bugTitle}`,
        "",
        `- Bug: ${conciseBug}`,
        `- Fix: ${fixSummary}`,
        `- Quality: ${checkSummaries.join(", ")}`,
      ].join("\n");

      await this.mustRun("git", ["add", "-A"], worktreePath, 30_000);
      await this.mustRun(
        "git",
        ["-c", "user.name=RiverLab Auto Fix", "-c", "user.email=riverlab-autofix@local", "commit", "-m", commitMessage],
        worktreePath,
        60_000,
      );
      const commit = await this.mustRun("git", ["rev-parse", "HEAD"], worktreePath, 30_000);
      const commitHash = commit.stdout.trim();

      logger.info("CICD", `Feedback [${feedback.id}] fix committed (${commitHash}) on branch ${branchName}`, feedback.id, {
        commitHash,
        provider: activeProvider.name,
      });

      appendLiveLog(`🎉 [${feedback.id}] 修复成功提交: ${commitHash.slice(0, 8)} (${fixSummary})\n`);

      this.repository.markAwaitingReview(feedback.id, {
        branchName,
        commitHash,
        aiProvider: activeProvider.name,
        aiSummary: aiResult.summary,
        testSummary: checkSummaries.join("；"),
      });

      return { success: true, bugTitle, fixSummary };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("CICD", `Feedback [${feedback.id}] auto-fix failed: ${message}`, feedback.id);
      appendLiveLog(`❌ [${feedback.id}] 修复未通过: ${message}\n`);

      const diff = await runProcess("git", ["diff", "--binary", "HEAD"], { cwd: worktreePath, timeoutMs: 30_000, maxOutputBytes: 5_000_000 }).catch(() => undefined);
      if (diff?.stdout) {
        fs.writeFileSync(path.join(logsDir, `attempt-${feedback.attempts}-failure.patch`), diff.stdout, "utf8");
      }

      // Hard rollback in worktree so failed modifications don't pollute the branch or next items
      await runProcess("git", ["reset", "--hard", "HEAD"], { cwd: worktreePath, timeoutMs: 30_000 }).catch(() => undefined);
      await runProcess("git", ["clean", "-fd"], { cwd: worktreePath, timeoutMs: 30_000 }).catch(() => undefined);

      this.repository.markAttemptFailed(feedback.id, message, new Date(Date.now() + RETRY_DELAY_MS), true);
      return { success: false, bugTitle, fixSummary: message };
    }
  }

  private async uniqueBranchName(feedbackId?: string): Promise<string> {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    const parts = Object.fromEntries(formatter.formatToParts(new Date()).map((part) => [part.type, part.value]));
    const base = `CICD_${parts.month}${parts.day}_${parts.hour}${parts.minute}_bugfix`;
    const exists = await runProcess("git", ["show-ref", "--verify", "--quiet", `refs/heads/${base}`], { cwd: this.root, timeoutMs: 30_000 });
    if (exists.exitCode !== 0) return base;
    const suffix = feedbackId ? `_${feedbackId.replace(/^F0*/, "") || "1"}` : `_${Math.floor(Math.random() * 1000)}`;
    return `${base}${suffix}`;
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
