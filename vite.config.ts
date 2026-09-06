import vinext from "vinext";
import { defineConfig, type Plugin } from "vite";
import { globalMultiplayerServer } from "./server/multiplayer-server";
import { feedbackPlugin } from "./server/feedback/plugin";

function multiplayerWsPlugin(): Plugin {
  return {
    name: "multiplayer-ws",
    configureServer(server) {
      if (server.httpServer) {
        globalMultiplayerServer.setPort(4311);
        globalMultiplayerServer.attach(server.httpServer);
      }
    },
  };
}

export default defineConfig({
  plugins: [feedbackPlugin(), vinext(), multiplayerWsPlugin()],
  server: {
    host: "0.0.0.0",
    port: 4311,
    cors: true,
    allowedHosts: true,
    hmr: {
      clientPort: 4311,
    },
    watch: {
      ignored: ["**/resource/**", "**/public/music/**", "**/.git/**", "**/node_modules/**"],
    },
  },
});
