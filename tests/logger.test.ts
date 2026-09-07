import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatBeijingDateString, formatBeijingTimestamp, ServerLogger } from "../server/logger";

test("ServerLogger formats timestamps in Beijing time", () => {
  const ts = formatBeijingTimestamp(new Date("2026-09-07T04:15:30.500Z"));
  // 04:15 UTC is 12:15 in Beijing (UTC+8)
  assert.match(ts, /^2026-09-07 12:15:30\.500$/);

  const dateStr = formatBeijingDateString(new Date("2026-09-07T04:15:30.500Z"));
  assert.equal(dateStr, "2026-09-07");
});

test("ServerLogger writes logs to daily file and creates directory", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "riverlab-logger-test-"));
  try {
    const logger = new ServerLogger({ logsDir: tempDir, echo: false });
    logger.info("WS", "Client connected", "Client:user-123", { ip: "127.0.0.1" });
    logger.warn("ACTION", "Invalid raise", "Room:8842", { amount: 30, min: 40 });
    logger.error("SYS", "Unexpected crash", undefined, { reason: "test error" });

    const activeFile = logger.resolveActiveLogFile();
    assert.ok(fs.existsSync(activeFile));
    assert.match(path.basename(activeFile), /^server-\d{4}-\d{2}-\d{2}\.log$/);

    const content = fs.readFileSync(activeFile, "utf8");
    assert.match(content, /\[INFO \] \[WS\] \[Client:user-123\] Client connected \| \{"ip":"127\.0\.0\.1"\}/);
    assert.match(content, /\[WARN \] \[ACTION\] \[Room:8842\] Invalid raise \| \{"amount":30,"min":40\}/);
    assert.match(content, /\[ERROR\] \[SYS\] Unexpected crash \| \{"reason":"test error"\}/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ServerLogger rotates to volume file when file exceeds max size", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "riverlab-logger-rot-"));
  try {
    // Set a tiny max size of 200 bytes for testing rotation
    const logger = new ServerLogger({ logsDir: tempDir, maxFileSize: 200, echo: false });
    
    // Write multiple logs to exceed 200 bytes
    for (let i = 0; i < 10; i++) {
      logger.info("TEST", `Log message iteration ${i} with padding text to take up space`);
    }

    const files = fs.readdirSync(tempDir);
    assert.ok(files.length >= 2, `Expected rotated volume files, got ${JSON.stringify(files)}`);
    assert.ok(files.some((f) => f.includes(".1.log")), "Expected a .1.log volume file");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("MultiplayerRoom writes structured lifecycle logs", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "riverlab-room-log-"));
  const prevLogsDir = process.env.SERVER_LOGS_DIR;
  process.env.SERVER_LOGS_DIR = tempDir;
  try {
    // Dynamic import to pick up updated env if needed or test logger directly
    const { logger } = await import("../server/logger");
    const { MultiplayerRoom } = await import("../server/multiplayer-room");

    const room = new MultiplayerRoom("TEST", "host-1", "房主Alice", () => {});
    room.join("user-2", "Bob");
    room.takeSeat("user-2", 1);
    room.addAiBot("host-1", 2);

    const logFile = logger.resolveActiveLogFile();
    assert.ok(fs.existsSync(logFile));
    const content = fs.readFileSync(logFile, "utf8");
    assert.match(content, /\[ROOM\] \[Room:TEST\] MultiplayerRoom initialized/);
    assert.match(content, /\[ROOM\] \[Room:TEST\] Player Bob \(user-2\) seated/);
    assert.match(content, /\[ROOM\] \[Room:TEST\] AI bot .* added to seat 2/);

  } finally {
    if (prevLogsDir !== undefined) {
      process.env.SERVER_LOGS_DIR = prevLogsDir;
    } else {
      delete process.env.SERVER_LOGS_DIR;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

