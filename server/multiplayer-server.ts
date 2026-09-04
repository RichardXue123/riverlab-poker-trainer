import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import os from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { MultiplayerRoom } from "./multiplayer-room";
import type { ClientMessage, RoomConfig, RoomSummary, ServerMessage } from "./multiplayer-types";

export function getLocalLanIps(): string[] {
  const interfaces = os.networkInterfaces();
  const ips: string[] = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips.length > 0 ? ips : ["127.0.0.1"];
}

interface ClientSession {
  id: string;
  name: string;
  ws: WebSocket;
  roomCode?: string;
}

export class MultiplayerServer {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, ClientSession> = new Map();
  private rooms: Map<string, MultiplayerRoom> = new Map();
  private port = 4311;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public attach(server: any): void {
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname === "/ws") {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req);
        });
      }
    });

    wss.on("connection", (ws) => {
      this.handleConnection(ws);
    });
  }

  public setPort(port: number): void {
    this.port = port;
  }

  private handleConnection(ws: WebSocket): void {
    const clientId = `user-${Math.random().toString(36).slice(2, 9)}`;
    const session: ClientSession = {
      id: clientId,
      name: "匿名牌友",
      ws,
    };
    this.clients.set(clientId, session);

    // Send initial metadata
    this.send(ws, {
      type: "INIT",
      clientId,
      lanIps: getLocalLanIps(),
      port: this.port,
    });

    ws.on("message", (data) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(data.toString());
      } catch (err) {
        this.send(ws, { type: "ERROR", message: "消息格式错误" });
        return;
      }

      try {
        this.handleClientMessage(session, message);
      } catch (err) {
        console.error("[MultiplayerServer] Message handler error:", message.type, err);
        this.send(ws, {
          type: "ERROR",
          message: err instanceof Error ? err.message : "服务器处理异常",
        });
      }
    });

    ws.on("close", () => {
      this.handleDisconnect(session);
    });

    ws.on("error", () => {
      this.handleDisconnect(session);
    });
  }

  private handleClientMessage(session: ClientSession, msg: ClientMessage): void {
    const ws = session.ws;

    switch (msg.type) {
      case "PING": {
        this.send(ws, { type: "PONG" });
        break;
      }
      case "SET_NAME": {
        if (msg.name && typeof msg.name === "string") {
          session.name = msg.name.trim().slice(0, 16);
          if (session.roomCode) {
            const room = this.rooms.get(session.roomCode);
            if (room) {
              const seat = room.seats.find((s) => s?.id === session.id);
              if (seat) seat.name = session.name;
              const spec = room.spectators.get(session.id);
              if (spec) spec.name = session.name;
              if (room.gameState) {
                const gameSeat = room.gameState.seats.find((s) => s.id === session.id);
                if (gameSeat) gameSeat.name = session.name;
              }
              this.broadcastRoom(room);
            }
          }
        }
        break;
      }
      case "LIST_ROOMS": {
        this.send(ws, { type: "ROOM_LIST", rooms: this.getRoomSummaries() });
        break;
      }
      case "CREATE_ROOM": {
        if (msg.playerName && typeof msg.playerName === "string" && msg.playerName.trim()) {
          session.name = msg.playerName.trim().slice(0, 16);
        }
        if (session.roomCode) {
          this.leaveCurrentRoom(session);
        }
        const roomCode = this.generateRoomCode();
        const room = new MultiplayerRoom(
          roomCode,
          session.id,
          session.name,
          () => this.broadcastRoom(room),
          msg.config,
        );
        this.rooms.set(roomCode, room);
        session.roomCode = roomCode;

        this.send(ws, {
          type: "ROOM_JOINED",
          roomCode,
          isHost: true,
          isSpectator: false,
        });
        this.broadcastRoom(room);
        break;
      }
      case "JOIN_ROOM": {
        if (msg.playerName && typeof msg.playerName === "string" && msg.playerName.trim()) {
          session.name = msg.playerName.trim().slice(0, 16);
        }
        const code = msg.roomCode?.trim().toUpperCase();
        const room = this.rooms.get(code);
        if (!room) {
          this.send(ws, { type: "ERROR", message: `未找到房间 [${code}]` });
          return;
        }
        if (session.roomCode && session.roomCode !== code) {
          this.leaveCurrentRoom(session);
        }
        session.roomCode = code;
        const result = room.join(session.id, session.name, Boolean(msg.asSpectator));
        this.send(ws, {
          type: "ROOM_JOINED",
          roomCode: code,
          isHost: result.isHost,
          isSpectator: result.isSpectator,
        });
        this.broadcastRoom(room);
        break;
      }
      case "LEAVE_ROOM": {
        this.leaveCurrentRoom(session);
        this.send(ws, { type: "ROOM_LEFT" });
        this.send(ws, { type: "ROOM_LIST", rooms: this.getRoomSummaries() });
        break;
      }
      case "TAKE_SEAT": {
        const room = this.getRoomForSession(session);
        if (room) {
          room.takeSeat(session.id, msg.seatIndex);
        }
        break;
      }
      case "STAND_UP": {
        const room = this.getRoomForSession(session);
        if (room) {
          room.standUp(session.id);
        }
        break;
      }
      case "TOGGLE_READY": {
        const room = this.getRoomForSession(session);
        if (room) {
          room.toggleReady(session.id);
        }
        break;
      }
      case "START_GAME": {
        const room = this.getRoomForSession(session);
        if (room) {
          const res = room.startGame(session.id);
          if (!res.success && res.error) {
            this.send(ws, { type: "ERROR", message: res.error });
          }
        }
        break;
      }
      case "PLAYER_ACTION": {
        const room = this.getRoomForSession(session);
        if (room) {
          const res = room.handleAction(session.id, msg.action);
          if (!res.success && res.error) {
            this.send(ws, { type: "ERROR", message: res.error });
          }
        }
        break;
      }
      case "USE_TIME_BANK": {
        const room = this.getRoomForSession(session);
        if (room) {
          const res = room.useTimeBank(session.id);
          if (!res.success && res.error) {
            this.send(ws, { type: "ERROR", message: res.error });
          }
        }
        break;
      }
      case "NEXT_HAND": {
        const room = this.getRoomForSession(session);
        if (room) {
          const res = room.nextHand(session.id);
          if (!res.success && res.error) {
            this.send(ws, { type: "ERROR", message: res.error });
          }
        }
        break;
      }
      case "REBUY": {
        const room = this.getRoomForSession(session);
        if (room) {
          room.rebuy(session.id, msg.amount);
        }
        break;
      }
      case "TOGGLE_GOD_MODE": {
        const room = this.getRoomForSession(session);
        if (room) {
          room.setGodMode(session.id, msg.enabled);
        }
        break;
      }
      case "TRANSFER_HOST": {
        const room = this.getRoomForSession(session);
        if (room) {
          const res = room.transferHost(session.id, msg.targetPlayerId);
          if (!res.success && res.error) {
            this.send(ws, { type: "ERROR", message: res.error });
          }
        }
        break;
      }
      case "ADD_AI_BOT": {
        const room = this.getRoomForSession(session);
        if (room) {
          const res = room.addAiBot(session.id, msg.seatIndex);
          if (!res.success && res.error) {
            this.send(ws, { type: "ERROR", message: res.error });
          }
        }
        break;
      }
      case "REMOVE_AI_BOT": {
        const room = this.getRoomForSession(session);
        if (room) {
          const res = room.removeAiBot(session.id, msg.seatIndex);
          if (!res.success && res.error) {
            this.send(ws, { type: "ERROR", message: res.error });
          }
        }
        break;
      }
      case "FILL_AI_BOTS": {
        const room = this.getRoomForSession(session);
        if (room) {
          const res = room.fillAiBots(session.id, msg.targetCount);
          if (!res.success && res.error) {
            this.send(ws, { type: "ERROR", message: res.error });
          }
        }
        break;
      }
      case "CLEAR_AI_BOTS": {
        const room = this.getRoomForSession(session);
        if (room) {
          const res = room.clearAllAiBots(session.id);
          if (!res.success && res.error) {
            this.send(ws, { type: "ERROR", message: res.error });
          }
        }
        break;
      }
    }
  }

  private leaveCurrentRoom(session: ClientSession): void {
    if (!session.roomCode) return;
    const room = this.rooms.get(session.roomCode);
    session.roomCode = undefined;
    if (room) {
      const isEmpty = room.leave(session.id);
      if (isEmpty) {
        this.rooms.delete(room.code);
      } else {
        this.broadcastRoom(room);
      }
    }
  }

  private handleDisconnect(session: ClientSession): void {
    this.leaveCurrentRoom(session);
    this.clients.delete(session.id);
  }

  private getRoomForSession(session: ClientSession): MultiplayerRoom | undefined {
    if (!session.roomCode) {
      this.send(session.ws, { type: "ERROR", message: "你不在任何房间内" });
      return undefined;
    }
    const room = this.rooms.get(session.roomCode);
    if (!room) {
      this.send(session.ws, { type: "ERROR", message: "房间已解散" });
      session.roomCode = undefined;
      return undefined;
    }
    return room;
  }

  private broadcastRoom(room: MultiplayerRoom): void {
    for (const [clientId, session] of this.clients.entries()) {
      if (session.roomCode === room.code && session.ws.readyState === WebSocket.OPEN) {
        const clientState = room.buildClientState(clientId);
        this.send(session.ws, {
          type: "ROOM_STATE",
          state: clientState,
        });
      }
    }
  }

  private getRoomSummaries(): RoomSummary[] {
    const list: RoomSummary[] = [];
    for (const room of this.rooms.values()) {
      const host = room.seats.find((s) => s?.isHost) ?? Array.from(room.spectators.values())[0];
      list.push({
        code: room.code,
        hostName: host?.name ?? "房主",
        playerCount: room.seatedCount,
        spectatorCount: room.spectators.size,
        status: room.status,
        blinds: `${room.config.smallBlind}/${room.config.bigBlind}`,
      });
    }
    return list;
  }

  private generateRoomCode(): string {
    const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    let code = "";
    do {
      code = "";
      for (let i = 0; i < 4; i += 1) {
        code += chars[Math.floor(Math.random() * chars.length)];
      }
    } while (this.rooms.has(code));
    return code;
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
}

export const globalMultiplayerServer = new MultiplayerServer();
