import type { Plugin, PreviewServer, ViteDevServer } from "vite";
import { createFeedbackMiddleware } from "./http";
import { getFeedbackRuntime } from "./runtime";

export function feedbackPlugin(root = process.cwd()): Plugin {
  const runtime = getFeedbackRuntime(root);
  const middleware = createFeedbackMiddleware(runtime);
  const attach = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use(middleware);
    runtime.worker.start();
    server.httpServer?.once("close", () => runtime.worker.stop());
  };

  return {
    name: "riverlab-feedback",
    configureServer: attach,
    configurePreviewServer: attach,
  };
}
