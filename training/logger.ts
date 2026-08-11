import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TrainingEventType } from "./types";

export interface TrainingEvent {
  timestamp: string;
  elapsedMs: number;
  type: TrainingEventType;
  payload: Record<string, unknown>;
}

export class TrainingLogger {
  readonly humanLogPath: string;
  readonly eventLogPath: string;
  private readonly startedAt: number;

  constructor(readonly outputDirectory: string, private readonly echo = true) {
    mkdirSync(outputDirectory, { recursive: true });
    this.humanLogPath = path.join(outputDirectory, "training.log");
    this.eventLogPath = path.join(outputDirectory, "events.jsonl");
    this.startedAt = Date.now();
  }

  event(type: TrainingEventType, message: string, payload: Record<string, unknown> = {}): TrainingEvent {
    const event: TrainingEvent = {
      timestamp: new Date().toISOString(),
      elapsedMs: Date.now() - this.startedAt,
      type,
      payload,
    };
    const line = `[${event.timestamp}] ${type.padEnd(20)} ${message}`;
    appendFileSync(this.humanLogPath, `${line}\n`, "utf8");
    appendFileSync(this.eventLogPath, `${JSON.stringify(event)}\n`, "utf8");
    if (this.echo) console.log(line);
    return event;
  }

  writeJson(name: string, value: unknown): string {
    const target = path.join(this.outputDirectory, name);
    writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return target;
  }
}