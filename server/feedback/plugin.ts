import type { Plugin, PreviewServer, ViteDevServer } from "vite";
import { isAutofixEnabled } from "./config";
import { createFeedbackMiddleware } from "./http";
import { getFeedbackRuntime } from "./runtime";
import { logger } from "../logger";

export function feedbackPlugin(root = process.cwd()): Plugin {
  const runtime = getFeedbackRuntime(root);
  const middleware = createFeedbackMiddleware(runtime);
  const attach = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use(middleware);
    runtime.worker.start();
    logger.info("SYS", "Vite feedback plugin attached", undefined, { autofix: isAutofixEnabled() });
    if (isAutofixEnabled()) {
      logger.info("CICD", "Feedback auto-fix worker active (polling every 5 hours)");
    }
    server.httpServer?.once("close", () => {
      logger.info("SYS", "Vite server closing, stopping feedback worker");
      runtime.worker.stop();
    });
  };

  return {
    name: "riverlab-feedback",
    configureServer: attach,
    configurePreviewServer: attach,
  };
}

