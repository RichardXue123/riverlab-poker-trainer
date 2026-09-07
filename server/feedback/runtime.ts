import fs from "node:fs";
import path from "node:path";
import { createAiFixProvider } from "./ai-provider";
import { JsonFeedbackRepository } from "./repository";
import { FeedbackFixWorker } from "./worker";

export class FeedbackRuntime {
  readonly repository: JsonFeedbackRepository;
  readonly worker: FeedbackFixWorker;

  constructor(readonly root: string) {
    const defaultFeedbackDir = path.join(root, "feedback");
    const dataDir = path.resolve(process.env.FEEDBACK_DATA_DIR || defaultFeedbackDir);

    const legacyPath = path.join(root, "data", "feedback.json");
    const targetPath = path.join(dataDir, "feedback.json");
    if (!fs.existsSync(targetPath) && fs.existsSync(legacyPath)) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.copyFileSync(legacyPath, targetPath);
      } catch {
        // ignore
      }
    }

    this.repository = new JsonFeedbackRepository(targetPath);
    this.worker = new FeedbackFixWorker(root, dataDir, this.repository);
  }
}

const runtimeKey = Symbol.for("riverlab.feedback.runtime");

export function getFeedbackRuntime(root: string): FeedbackRuntime {
  const globals = globalThis as typeof globalThis & { [runtimeKey]?: FeedbackRuntime };
  if (!globals[runtimeKey] || typeof globals[runtimeKey].worker?.getProvider !== "function") {
    globals[runtimeKey] = new FeedbackRuntime(root);
  }
  return globals[runtimeKey];
}

