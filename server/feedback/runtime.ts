import path from "node:path";
import { createAiFixProvider } from "./ai-provider";
import { JsonFeedbackRepository } from "./repository";
import { FeedbackFixWorker } from "./worker";

export class FeedbackRuntime {
  readonly repository: JsonFeedbackRepository;
  readonly worker: FeedbackFixWorker;

  constructor(readonly root: string) {
    const dataDir = path.resolve(process.env.FEEDBACK_DATA_DIR || path.join(root, "data"));
    this.repository = new JsonFeedbackRepository(path.join(dataDir, "feedback.json"));
    this.worker = new FeedbackFixWorker(root, dataDir, this.repository, createAiFixProvider());
  }
}

const runtimeKey = Symbol.for("riverlab.feedback.runtime");

export function getFeedbackRuntime(root: string): FeedbackRuntime {
  const globals = globalThis as typeof globalThis & { [runtimeKey]?: FeedbackRuntime };
  if (!globals[runtimeKey]) globals[runtimeKey] = new FeedbackRuntime(root);
  return globals[runtimeKey];
}

