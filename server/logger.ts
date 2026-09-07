import fs from "node:fs";
import path from "node:path";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export function formatBeijingTimestamp(date = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}.${ms}`;
}

export function formatBeijingDateString(date = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export interface LoggerOptions {
  logsDir?: string;
  minLevel?: LogLevel;
  maxFileSize?: number;
  echo?: boolean;
}

export class ServerLogger {
  private _logsDir?: string;
  private readonly minLevel: LogLevel;
  private readonly maxFileSize: number;
  private readonly echo: boolean;

  constructor(options: LoggerOptions = {}) {
    if (options.logsDir) {
      this._logsDir = path.resolve(options.logsDir);
    }
    this.minLevel = options.minLevel || (process.env.LOG_LEVEL as LogLevel) || "INFO";
    this.maxFileSize = options.maxFileSize || DEFAULT_MAX_FILE_SIZE;
    this.echo = options.echo ?? (process.env.LOG_ECHO !== "false");
  }

  get logsDir(): string {
    return this._logsDir || path.resolve(process.env.SERVER_LOGS_DIR || path.join(process.cwd(), "logs"));
  }


  log(level: LogLevel, tag: string, message: string, context?: string, data?: unknown): string {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.minLevel]) {
      return "";
    }

    const timestamp = formatBeijingTimestamp();
    const contextPrefix = context ? `[${context}] ` : "";
    let dataSuffix = "";
    if (data !== undefined && data !== null) {
      try {
        const serialized = typeof data === "string" ? data : JSON.stringify(data);
        dataSuffix = ` | ${serialized.length > 2000 ? `${serialized.slice(0, 2000)}...` : serialized}`;
      } catch {
        dataSuffix = " | [Circular/Unserializable]";
      }
    }

    const line = `[${timestamp}] [${level.padEnd(5)}] [${tag}] ${contextPrefix}${message}${dataSuffix}`;

    try {
      this.writeToFile(line);
    } catch (err) {
      console.error("[ServerLogger] Failed to write log:", err);
    }

    if (this.echo) {
      if (level === "ERROR") {
        console.error(line);
      } else if (level === "WARN") {
        console.warn(line);
      } else {
        console.log(line);
      }
    }

    return line;
  }

  info(tag: string, message: string, context?: string, data?: unknown): string {
    return this.log("INFO", tag, message, context, data);
  }

  warn(tag: string, message: string, context?: string, data?: unknown): string {
    return this.log("WARN", tag, message, context, data);
  }

  error(tag: string, message: string, context?: string, data?: unknown): string {
    return this.log("ERROR", tag, message, context, data);
  }

  debug(tag: string, message: string, context?: string, data?: unknown): string {
    return this.log("DEBUG", tag, message, context, data);
  }

  banner(title: string, details?: string): void {
    const divider = "=".repeat(70);
    const line = `[${formatBeijingTimestamp()}] [INFO ] [SYS] ${divider}\n[${formatBeijingTimestamp()}] [INFO ] [SYS] >>> ${title}${details ? ` | ${details}` : ""}\n[${formatBeijingTimestamp()}] [INFO ] [SYS] ${divider}`;
    try {
      this.writeToFile(line);
    } catch {
      // ignore
    }
    if (this.echo) {
      console.log(line);
    }
  }

  private writeToFile(text: string): void {
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }

    const targetFile = this.resolveActiveLogFile();
    fs.appendFileSync(targetFile, `${text}\n`, "utf8");
  }

  resolveActiveLogFile(now = new Date()): string {
    const dateStr = formatBeijingDateString(now);
    const baseFile = path.join(this.logsDir, `server-${dateStr}.log`);

    if (!fs.existsSync(baseFile)) {
      return baseFile;
    }

    try {
      const stats = fs.statSync(baseFile);
      if (stats.size < this.maxFileSize) {
        return baseFile;
      }

      // Check rotated volumes: server-YYYY-MM-DD.1.log, .2.log, etc.
      let volume = 1;
      while (true) {
        const volumeFile = path.join(this.logsDir, `server-${dateStr}.${volume}.log`);
        if (!fs.existsSync(volumeFile)) {
          return volumeFile;
        }
        const volStats = fs.statSync(volumeFile);
        if (volStats.size < this.maxFileSize) {
          return volumeFile;
        }
        volume += 1;
      }
    } catch {
      return baseFile;
    }
  }
}

export const logger = new ServerLogger();
