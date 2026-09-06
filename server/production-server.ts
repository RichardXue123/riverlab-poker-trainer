import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { startProdServer } from "vinext/server/prod-server";
import { globalMultiplayerServer } from "./multiplayer-server";
import { createFeedbackMiddleware } from "./feedback/http";
import { getFeedbackRuntime } from "./feedback/runtime";

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

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;
const vinextListeners = server.listeners("request") as RequestListener[];
server.removeAllListeners("request");
server.on("request", (req, res) => {
  void feedbackMiddleware(req, res, (error) => {
    if (error) {
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
server.once("close", () => runtime.worker.stop());

