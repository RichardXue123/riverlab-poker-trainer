import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { startProdServer } from "vinext/server/prod-server";
import { globalMultiplayerServer } from "./multiplayer-server";
import { createFeedbackMiddleware } from "./feedback/http";
import { getFeedbackRuntime } from "./feedback/runtime";

import { isAutofixEnabled } from "./feedback/config";
import { logger } from "./logger";

const root = process.cwd();
const requestedPort = Number.parseInt(process.env.PORT || "4311", 10);
const host = process.env.HOST || "0.0.0.0";
const runtime = getFeedbackRuntime(root);
const feedbackMiddleware = createFeedbackMiddleware(runtime);

const { server, port } = await startProdServer({
  port: requestedPort,
  host,
  outDir: path.join(root, "dist"),
});

logger.banner("RiverLab Poker Server Starting", `port=${port} host=${host} autofix=${isAutofixEnabled()}`);
logger.info("SYS", "Production HTTP & WebSocket server initialized", undefined, {
  port,
  host,
  autofix: isAutofixEnabled(),
  pid: process.pid,
});

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;
const vinextListeners = server.listeners("request") as RequestListener[];
server.removeAllListeners("request");
server.on("request", (req, res) => {
  void feedbackMiddleware(req, res, (error) => {
    if (error) {
      logger.error("HTTP", "Error in feedback middleware", undefined, { error: String(error) });
      res.statusCode = 500;
      res.end("Internal Server Error");
      return;
    }
    for (const listener of vinextListeners) listener.call(server, req, res);
  });
});

globalMultiplayerServer.setPort(port);
globalMultiplayerServer.attach(server);
runtime.worker.start();
if (isAutofixEnabled()) {
  logger.info("CICD", "Feedback auto-fix worker active (polling every 5 hours)");
}
server.once("close", () => {
  logger.info("SYS", "Server shutting down, stopping feedback worker");
  runtime.worker.stop();
});


