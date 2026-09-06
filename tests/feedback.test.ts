import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JsonFeedbackRepository } from "../server/feedback/repository";

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

