import type { Card, GameAction, HandResult, LegalActions, PlayerActionInput, PublicSeatState, Street } from "../lib/poker/types";
import type { ChaosCharacter, ChaosSelectionState, ChaosSkill, PlayerSkillStatus } from "../lib/poker/chaos-types";

export interface RoomConfig {
  smallBlind: number;
  bigBlind: number;
  startingStack: number;
  minPlayers: number; // default 4, max 8
  regularTurnSeconds: number; // 常规单步思考时间 (秒)，例如 15, 20, 30
  initialTimeBankCards: number; // 每位玩家拥有的延时卡数量，例如 1, 2, 3
  timeBankExtensionSeconds: number; // 每次延长思考时间 (30秒)
  aiDelayMs?: number; // AI 思考延迟毫秒数 (可选，默认 1000ms，测试时可设为 0)
  chaosMode?: boolean; // 是否启用「胡闹德州」模式
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
  isAi?: boolean;
  characterId?: string; // 选定的武将/角色 ID
  usedSkills?: string[]; // 已消耗的技能 ID 列表（限定技用后存入此列表，图标灰化）
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
  isAi?: boolean;
  characterId?: string; // 选中的武将/角色 ID
  characterAvatar?: string; // 头像资源路径
  characterName?: string; // 角色名称
  characterTitle?: string; // 角色称号
  characterThemeColor?: string; // 角色代表色
  characterFallbackText?: string; // 头像回退文本
  characterSkills?: ChaosSkill[]; // 角色技能清单
  skillStates?: Record<string, PlayerSkillStatus>; // 各技能实时状态（是否用尽、是否可触发）
}

export interface MultiplayerTableState {
  roomCode: string;
  status: "lobby" | "playing";
  config: RoomConfig;
  myId: string;
  isHost: boolean;
  isSpectator: boolean;
  godMode: boolean;
  chaosMode?: boolean; // 是否处于胡闹模式
  characterSelection?: ChaosSelectionState; // 选将阶段状态（若进行中）
  chaosPeekCards?: Card[]; // 观星/显影等技能预知的下一张公共牌（仅自己可见）
  chaosDeckBottomCards?: Card[]; // 高义【出千】技能透视的牌堆底3张牌（仅己方可见）
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
  chaosMode?: boolean;
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
  | { type: "TOGGLE_CHAOS_MODE"; enabled: boolean }
  | { type: "SELECT_CHARACTER"; characterId: string }
  | {
      type: "USE_SKILL";
      skillId: string;
      targetPlayerId?: string;
      targetCardIndex?: number;
    }
  | { type: "PLAYER_ACTION"; action: PlayerActionInput }
  | { type: "USE_TIME_BANK" }
  | { type: "NEXT_HAND" }
  | { type: "REBUY"; amount?: number }
  | { type: "TOGGLE_GOD_MODE"; enabled: boolean }
  | { type: "TRANSFER_HOST"; targetPlayerId: string }
  | { type: "ADD_AI_BOT"; seatIndex?: number }
  | { type: "REMOVE_AI_BOT"; seatIndex: number }
  | { type: "FILL_AI_BOTS"; targetCount?: number }
  | { type: "CLEAR_AI_BOTS" };

export type ServerMessage =
  | { type: "PONG" }
  | { type: "INIT"; clientId: string; lanIps: string[]; port: number }
  | { type: "ROOM_LIST"; rooms: RoomSummary[] }
  | { type: "ROOM_JOINED"; roomCode: string; isHost: boolean; isSpectator: boolean }
  | { type: "ROOM_LEFT" }
  | { type: "ROOM_STATE"; state: MultiplayerTableState }
  | { type: "ERROR"; message: string }
  | { type: "CHAT"; from: string; text: string };
