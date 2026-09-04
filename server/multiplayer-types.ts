import type { Card, GameAction, HandResult, LegalActions, PlayerActionInput, PlayerSettlement, PublicSeatState, Street } from "../lib/poker/types";

export interface RoomConfig {
  smallBlind: number;
  bigBlind: number;
  startingStack: number;
  minPlayers: number; // default 4, max 8
  regularTurnSeconds: number; // 常规单步思考时间 (秒)，例如 15, 20, 30
  initialTimeBankCards: number; // 每位玩家拥有的延时卡数量，例如 1, 2, 3
  timeBankExtensionSeconds: number; // 每次延长思考时间 (30秒)
}

export interface RoomMember {
  id: string;
  name: string;
  connected: boolean;
}

export interface RoomSeatPlayer extends RoomMember {
  seatIndex: number; // 0..7
  stack: number;
  isReady: boolean;
  isHost: boolean;
  timeBankCards: number;
}

export interface RoomSpectator extends RoomMember {
  godMode: boolean;
}

export interface GodModeEquityItem {
  playerId: string;
  playerName: string;
  seatIndex: number;
  equity: number; // 0..1 (e.g. 0.654 -> 65.4%)
  equityFormatted?: string; // e.g. "65.4%"
  handName: string;
  holeCards: Card[];
  isFolded: boolean;
}

export interface MultiplayerPublicSeat extends PublicSeatState {
  holeCards: Card[];
  isHero: boolean;
  isReady: boolean;
  isHost: boolean;
  connected: boolean;
  timeBankCards: number;
}

export interface MultiplayerTableState {
  roomCode: string;
  status: "lobby" | "playing";
  config: RoomConfig;
  myId: string;
  isHost: boolean;
  isSpectator: boolean;
  godMode: boolean;
  handNumber: number;
  street: Street;
  smallBlind: number;
  bigBlind: number;
  pot: number;
  currentBet: number;
  minRaise: number;
  buttonIndex: number;
  activeIndex: number;
  community: Card[];
  myHoleCards: Card[];
  myTimeBankCards: number;
  canUseTimeBank: boolean;
  timeBankActive: boolean;
  seats: MultiplayerPublicSeat[];
  spectators: { id: string; name: string }[];
  actionLog: GameAction[];
  legalActions: LegalActions;
  turnTimeRemaining: number;
  turnTotalTime: number;
  turnExpiresAt: number;
  godModeEquities?: GodModeEquityItem[];
  canStartGame: boolean;
  cannotStartReason?: string;
  handResultSummary?: string;
  lastResult?: HandResult;
  firstHandPending?: boolean;
}

export interface RoomSummary {
  code: string;
  hostName: string;
  playerCount: number;
  spectatorCount: number;
  status: "lobby" | "playing";
  blinds: string;
}

export type ClientMessage =
  | { type: "PING" }
  | { type: "SET_NAME"; name: string }
  | { type: "LIST_ROOMS" }
  | { type: "CREATE_ROOM"; config?: Partial<RoomConfig>; playerName?: string }
  | { type: "JOIN_ROOM"; roomCode: string; asSpectator?: boolean; playerName?: string }
  | { type: "LEAVE_ROOM" }
  | { type: "TAKE_SEAT"; seatIndex?: number }
  | { type: "STAND_UP" }
  | { type: "TOGGLE_READY" }
  | { type: "START_GAME" }
  | { type: "PLAYER_ACTION"; action: PlayerActionInput }
  | { type: "USE_TIME_BANK" }
  | { type: "NEXT_HAND" }
  | { type: "REBUY"; amount?: number }
  | { type: "TOGGLE_GOD_MODE"; enabled: boolean }
  | { type: "TRANSFER_HOST"; targetPlayerId: string };

export type ServerMessage =
  | { type: "PONG" }
  | { type: "INIT"; clientId: string; lanIps: string[]; port: number }
  | { type: "ROOM_LIST"; rooms: RoomSummary[] }
  | { type: "ROOM_JOINED"; roomCode: string; isHost: boolean; isSpectator: boolean }
  | { type: "ROOM_LEFT" }
  | { type: "ROOM_STATE"; state: MultiplayerTableState }
  | { type: "ERROR"; message: string }
  | { type: "CHAT"; from: string; text: string };
