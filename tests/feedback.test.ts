import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAiFixProvider, loadCicdSkillPrompt, resolveAgyCommand } from "../server/feedback/ai-provider";
import { isAutofixEnabled, saveFeedbackConfig } from "../server/feedback/config";
import { JsonFeedbackRepository } from "../server/feedback/repository";
import { FeedbackFixWorker } from "../server/feedback/worker";

function withRepository(run: (repository: JsonFeedbackRepository, filePath: string) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "riverlab-feedback-test-"));
  const filePath = path.join(directory, "feedback.json");
  try {
    run(new JsonFeedbackRepository(filePath), filePath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("feedback repository persists separate player and developer queues", () => {
  withRepository((repository, filePath) => {
    const player = repository.create({ kind: "player", playerName: "Alice", content: "希望增加快捷键" });
    const developer = repository.create({ kind: "developer", playerName: "Dev", content: "进入房间时页面报错" });

    assert.equal(player.id, "F000001");
    assert.equal(developer.id, "F000002");
    assert.deepEqual(repository.list("player").map((item) => item.id), [player.id]);
    assert.deepEqual(repository.list("developer").map((item) => item.id), [developer.id]);

    const reloaded = new JsonFeedbackRepository(filePath);
    assert.equal(reloaded.list("player")[0].content, "希望增加快捷键");
    assert.equal(reloaded.list("developer")[0].status, "pending");
  });
});

test("developer queue claims oldest eligible feedback and waits for human acceptance", () => {
  withRepository((repository) => {
    const first = repository.create({ kind: "developer", playerName: "Dev A", content: "第一个问题" });
    repository.create({ kind: "developer", playerName: "Dev B", content: "第二个问题" });

    const claimed = repository.claimOldestDeveloper();
    assert.equal(claimed?.id, first.id);
    assert.equal(claimed?.status, "processing");
    assert.equal(repository.claimOldestDeveloper()?.id, "F000002");

    repository.markAwaitingReview(first.id, {
      branchName: "CICD_0906_1756_bugfix",
      commitHash: "1234567890abcdef",
      aiProvider: "codex-cli",
      aiSummary: "已修复",
      testSummary: "npm test：通过",
    });
    const awaiting = repository.list("developer").find((item) => item.id === first.id);
    assert.equal(awaiting?.status, "processing");
    assert.equal(awaiting?.statusDetail, "AI 已生成修复，等待人工验收");
    assert.equal(awaiting?.branchName, "CICD_0906_1756_bugfix");

    const resolved = repository.updateStatus(first.id, "resolved");
    assert.equal(resolved?.status, "resolved");
  });
});

test("failed automatic fixes stop after three attempts until manually reopened", () => {
  withRepository((repository) => {
    const item = repository.create({ kind: "developer", playerName: "Dev", content: "偶发问题" });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = repository.claimOldestDeveloper(new Date(Date.now() + attempt * 10_000));
      assert.equal(claimed?.id, item.id);
      repository.markAttemptFailed(item.id, `失败 ${attempt}`, new Date(0));
    }
    assert.equal(repository.claimOldestDeveloper(new Date(Date.now() + 60_000)), undefined);
    assert.match(repository.list("developer")[0].statusDetail, /已暂停/);

    repository.updateStatus(item.id, "pending");
    assert.equal(repository.claimOldestDeveloper()?.attempts, 1);
  });
});

test("ai fix provider resolves agy by default and allows switching via feedback.config.json", () => {
  const originalEnv = process.env.AI_FIX_PROVIDER;
  delete process.env.AI_FIX_PROVIDER;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "riverlab-config-test-"));
  try {
    // 1. Without config file, defaults to agy
    const defaultProvider = createAiFixProvider(tempDir);
    assert.equal(defaultProvider.name, "agy-cli");

    // 2. Save config with codex provider
    saveFeedbackConfig(tempDir, { provider: "codex" });
    const codexProvider = createAiFixProvider(tempDir);
    assert.equal(codexProvider.name, "codex-cli");

    // 3. Switch back to agy via config
    saveFeedbackConfig(tempDir, { provider: "agy" });
    const agyProvider = createAiFixProvider(tempDir);
    assert.equal(agyProvider.name, "agy-cli");

    // 4. Worker dynamically reflects current config
    const repo = new JsonFeedbackRepository(path.join(tempDir, "feedback.json"));
    const worker = new FeedbackFixWorker(tempDir, tempDir, repo);
    assert.equal(worker.info().provider, "agy-cli");

    saveFeedbackConfig(tempDir, { provider: "codex" });
    assert.equal(worker.info().provider, "codex-cli");

    // 5. Environment variable can override config
    process.env.AI_FIX_PROVIDER = "agy";
    assert.equal(worker.info().provider, "agy-cli");

    // 6. worker.setProvider updates provider immediately
    worker.setProvider("codex");
    assert.equal(worker.info().provider, "codex-cli");
    worker.setProvider("agy");
    assert.equal(worker.info().provider, "agy-cli");

    // 7. gpt and gemini aliases resolve correctly
    const gptProvider = createAiFixProvider(tempDir, "gpt");
    assert.equal(gptProvider.name, "codex-cli");
    const geminiProvider = createAiFixProvider(tempDir, "gemini");
    assert.equal(geminiProvider.name, "agy-cli");
  } finally {
    if (originalEnv !== undefined) {
      process.env.AI_FIX_PROVIDER = originalEnv;
    } else {
      delete process.env.AI_FIX_PROVIDER;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolveAgyCommand finds binary or falls back to agy", () => {
  const custom = resolveAgyCommand("my-custom-agy");
  assert.equal(custom, "my-custom-agy");
  const fallback = resolveAgyCommand();
  assert.ok(typeof fallback === "string" && fallback.length > 0);
});

test("each developer feedback can have its own designated engine and be claimed by id", () => {
  withRepository((repository) => {
    const fb1 = repository.create({ kind: "developer", playerName: "Dev", content: "用 AGY 修复", targetProvider: "agy" });
    const fb2 = repository.create({ kind: "developer", playerName: "Dev", content: "用 Codex 修复", targetProvider: "codex" });

    assert.equal(fb1.targetProvider, "agy");
    assert.equal(fb2.targetProvider, "codex");

    repository.updateTargetProvider(fb1.id, "codex");
    assert.equal(repository.list("developer").find((i) => i.id === fb1.id)?.targetProvider, "codex");

    const claimedFb2 = repository.claimDeveloperById(fb2.id);
    assert.equal(claimedFb2?.id, fb2.id);
    assert.equal(claimedFb2?.targetProvider, "codex");
  });
});

test("isAutofixEnabled defaults to false, enables with CLI flags or environment variables", () => {
  // 1. Default without args or env
  assert.equal(isAutofixEnabled([], {}), false);
  assert.equal(isAutofixEnabled(["node", "vinext", "dev"], {}), false);

  // 2. CLI flags
  assert.equal(isAutofixEnabled(["node", "vinext", "dev", "--autofix"], {}), true);
  assert.equal(isAutofixEnabled(["node", "vinext", "dev", "--cicd"], {}), true);
  assert.equal(isAutofixEnabled(["node", "vinext", "dev", "--enable-autofix"], {}), true);
  assert.equal(isAutofixEnabled(["node", "vinext", "dev", "--autofix=true"], {}), true);
  assert.equal(isAutofixEnabled(["node", "vinext", "dev", "--autofix=false"], {}), false);

  // 3. Environment variables
  assert.equal(isAutofixEnabled([], { FEEDBACK_AUTOFIX_ENABLED: "true" }), true);
  assert.equal(isAutofixEnabled([], { FEEDBACK_AUTOFIX_ENABLED: "1" }), true);
  assert.equal(isAutofixEnabled([], { CICD: "true" }), true);
  assert.equal(isAutofixEnabled([], { AUTOFIX: "true" }), true);

  // 4. Explicit disable overrides flags
  assert.equal(isAutofixEnabled(["--autofix"], { FEEDBACK_AUTOFIX_ENABLED: "false" }), false);
});

test("FeedbackFixWorker does not start scheduler when autofix is disabled by default", () => {
  const originalEnv = process.env.FEEDBACK_AUTOFIX_ENABLED;
  delete process.env.FEEDBACK_AUTOFIX_ENABLED;
  const originalArgv = process.argv;
  process.argv = ["node", "vinext", "dev"];

  withRepository((repository, filePath) => {
    const worker = new FeedbackFixWorker(path.dirname(filePath), path.dirname(filePath), repository);
    assert.equal(worker.info().autofixEnabled, false);
    assert.equal(worker.info().nextSweepAt, undefined);

    worker.start();
    // Since autofix is disabled, worker.start() does not schedule nextSweepAt
    assert.equal(worker.info().nextSweepAt, undefined);

    // When forced or started with flag, nextSweepAt is scheduled
    worker.start(true);
    assert.ok(worker.info().nextSweepAt);
    worker.stop();
  });

  process.argv = originalArgv;
  if (originalEnv !== undefined) process.env.FEEDBACK_AUTOFIX_ENABLED = originalEnv;
});

test("feedback repository allows deleting records by developer", () => {
  withRepository((repository) => {
    const p1 = repository.create({ kind: "player", playerName: "P1", content: "玩家反馈1" });
    const d1 = repository.create({ kind: "developer", playerName: "D1", content: "开发者反馈1" });

    assert.equal(repository.list("player").length, 1);
    assert.equal(repository.list("developer").length, 1);

    const deletedP1 = repository.delete(p1.id);
    assert.equal(deletedP1, true);
    assert.equal(repository.list("player").length, 0);

    const deletedD1 = repository.delete(d1.id);
    assert.equal(deletedD1, true);
    assert.equal(repository.list("developer").length, 0);

    const deletedNonExistent = repository.delete("F999999");
    assert.equal(deletedNonExistent, false);
  });
});

test("loadCicdSkillPrompt loads ai_cicd_skill.md from root", () => {
  const prompt = loadCicdSkillPrompt();
  assert.ok(prompt.includes("RiverLab 自动修复流水线 AI 开发者手册") || prompt.includes("ai_cicd_skill.md"));
  assert.ok(prompt.includes("任务边界与执行要求"));
});

test("FIFO sequential queue claims oldest and skips items marked for manual review", () => {
  withRepository((repository) => {
    const f1 = repository.create({ kind: "developer", playerName: "Dev1", content: "第一个bug" });
    const f2 = repository.create({ kind: "developer", playerName: "Dev2", content: "第二个bug" });
    const f3 = repository.create({ kind: "developer", playerName: "Dev3", content: "第三个bug" });

    // 1. First claim gets the oldest: f1
    const claimed1 = repository.claimOldestDeveloper();
    assert.equal(claimed1?.id, f1.id);

    // 2. Mark f1 as failed and needing manual handling
    repository.markAttemptFailed(f1.id, "编译报错", undefined, true);
    assert.equal(repository.list("developer").find((i) => i.id === f1.id)?.statusDetail, "自动修复失败，待人工处理");

    // 3. Next claim skips f1 and gets f2
    const claimed2 = repository.claimOldestDeveloper();
    assert.equal(claimed2?.id, f2.id);

    // 4. Mark f2 as successfully fixed (awaiting review)
    repository.markAwaitingReview(f2.id, {
      branchName: "CICD_test_fix",
      commitHash: "abcdef",
      aiProvider: "agy-cli",
      aiSummary: "已修复",
      testSummary: "npm test 通过",
    });

    // 5. Next claim gets f3
    const claimed3 = repository.claimOldestDeveloper();
    assert.equal(claimed3?.id, f3.id);

    // 6. Resetting f1 to pending clears manual review marker so it can be claimed again
    repository.updateStatus(f1.id, "pending");
    assert.equal(repository.list("developer").find((i) => i.id === f1.id)?.statusDetail, "等待自动修复");
    const claimed1Again = repository.claimOldestDeveloper();
    assert.equal(claimed1Again?.id, f1.id);
  });
});

test("hasClaimableDeveloper accurately detects pending feedback requiring fix", () => {
  withRepository((repository) => {
    // 1. Empty repository
    assert.equal(repository.hasClaimableDeveloper(), false);
    assert.equal(repository.hasClaimableDeveloper("F000001"), false);

    // 2. Only player feedback
    const p1 = repository.create({ kind: "player", playerName: "P1", content: "玩家建议" });
    assert.equal(repository.hasClaimableDeveloper(), false);
    assert.equal(repository.hasClaimableDeveloper(p1.id), false);

    // 3. Add pending developer feedback
    const d1 = repository.create({ kind: "developer", playerName: "Dev1", content: "开发建议1" });
    assert.equal(repository.hasClaimableDeveloper(), true);
    assert.equal(repository.hasClaimableDeveloper(d1.id), true);

    // 4. Claim d1 and mark as requiring manual review (should not be auto-claimable)
    repository.claimOldestDeveloper();
    repository.markAttemptFailed(d1.id, "编译报错", undefined, true);
    assert.equal(repository.hasClaimableDeveloper(), false);
    assert.equal(repository.hasClaimableDeveloper(d1.id), false);

    // 5. Add second developer feedback
    const d2 = repository.create({ kind: "developer", playerName: "Dev2", content: "开发建议2" });
    assert.equal(repository.hasClaimableDeveloper(), true);
    assert.equal(repository.hasClaimableDeveloper(d2.id), true);
    assert.equal(repository.hasClaimableDeveloper(d1.id), false);

    // 6. Resolve d2
    repository.updateStatus(d2.id, "resolved");
    assert.equal(repository.hasClaimableDeveloper(), false);
    assert.equal(repository.hasClaimableDeveloper(d2.id), false);
  });
});

test("worker runNow performs pre-check and rejects when no feedback requires fix", async () => {
  await withRepository(async (repository, filePath) => {
    const worker = new FeedbackFixWorker(path.dirname(filePath), path.dirname(filePath), repository);
    // 1. No developer feedback -> should return started: false
    const res1 = await worker.runNow();
    assert.equal(res1.started, false);
    assert.ok(res1.message?.includes("没有需要自动修复的反馈"));

    // 2. Add player feedback only -> still started: false
    const p1 = repository.create({ kind: "player", playerName: "P1", content: "玩家建议" });
    const res2 = await worker.runNow(p1.id);
    assert.equal(res2.started, false);
    assert.ok(res2.message?.includes("无需自动修复"));

    // 3. Target non-existent ID -> started: false
    const res3 = await worker.runNow("F999999");
    assert.equal(res3.started, false);
    assert.ok(res3.message?.includes("无需自动修复"));
  });
});

test("batch execution links multiple resolved feedbacks to single unified branch", () => {
  withRepository((repository) => {
    const f1 = repository.create({ kind: "developer", playerName: "Dev1", content: "Bug 1: 转移房主后同步更新权限" });
    const f2 = repository.create({ kind: "developer", playerName: "Dev2", content: "Bug 2: 筹码耗尽三选一弹窗" });

    const sharedBranch = "CICD_0908_1200_bugfix";

    // 1. Claim f1 and resolve on sharedBranch
    repository.claimOldestDeveloper();
    repository.markAwaitingReview(f1.id, {
      branchName: sharedBranch,
      commitHash: "1111111",
      aiProvider: "agy-cli",
      aiSummary: "房主权限已同步切换",
      testSummary: "通过",
    });

    // 2. Claim f2 and resolve on the same sharedBranch
    repository.claimOldestDeveloper();
    repository.markAwaitingReview(f2.id, {
      branchName: sharedBranch,
      commitHash: "2222222",
      aiProvider: "agy-cli",
      aiSummary: "筹码耗尽交互弹窗已实现",
      testSummary: "通过",
    });

    const devList = repository.list("developer");
    const item1 = devList.find((i) => i.id === f1.id);
    const item2 = devList.find((i) => i.id === f2.id);

    assert.equal(item1?.branchName, sharedBranch);
    assert.equal(item1?.commitHash, "1111111");
    assert.equal(item2?.branchName, sharedBranch);
    assert.equal(item2?.commitHash, "2222222");
    assert.equal(item1?.statusDetail, "AI 已生成修复，等待人工验收");
    assert.equal(item2?.statusDetail, "AI 已生成修复，等待人工验收");
  });
});


