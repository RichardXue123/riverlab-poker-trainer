export type Suit = "s" | "h" | "d" | "c";
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface Card {
  rank: Rank;
  suit: Suit;
  id: string;
}

export type Street = "preflop" | "flop" | "turn" | "river" | "showdown" | "complete";
export type GameMode = "teaching" | "review" | "battle";
export type TableFormat = "cash" | "tournament";
export type Difficulty = "casual" | "standard" | "expert";
export type PlayerActionType = "fold" | "check" | "call" | "bet" | "raise" | "all-in";
export type LoggedActionType = PlayerActionType | "small-blind" | "big-blind";

export interface PlayerActionInput {
  type: PlayerActionType;
  /** For bet/raise this is the target total committed on the current street. */
  amount?: number;
}

export interface DecisionCandidate {
  action: PlayerActionInput;
  label: string;
  weight: number;
}

export interface DecisionTrace {
  summary: string;
  candidates: DecisionCandidate[];
}

export interface GameAction {
  index: number;
  playerId: string;
  playerName: string;
  type: LoggedActionType;
  amount: number;
  to: number;
  street: Street;
  potBefore: number;
  timestamp: number;
  decisionTrace?: DecisionTrace;
}

export interface BotPersonality {
  looseness: number;
  aggression: number;
  bluff: number;
  trapping: number;
  calling: number;
  risk: number;
  sizing: number;
  adaptability: number;
}

export interface ObservedOpponentStats {
  hands: number;
  vpipHands: number;
  pfrHands: number;
  threeBets: number;
  aggressiveActions: number;
  passiveActions: number;
  flopAggressiveActions: number;
  flopPassiveActions: number;
  turnAggressiveActions: number;
  turnPassiveActions: number;
  riverAggressiveActions: number;
  riverPassiveActions: number;
  facedPostflopBets: number;
  foldedToPostflopBets: number;
  facedRiverBets: number;
  foldedToRiverBets: number;
  turnBarrelOpportunities: number;
  turnBarrels: number;
  riverBarrelOpportunities: number;
  riverBarrels: number;
  riverStabOpportunities: number;
  riverStabs: number;
  recentAggression: number;
}

export interface SeatState {
  id: string;
  name: string;
  isHuman: boolean;
  stack: number;
  holeCards: Card[];
  folded: boolean;
  allIn: boolean;
  committedStreet: number;
  committedHand: number;
  acted: boolean;
  raiseLocked: boolean;
  lastAction?: LoggedActionType;
  personality?: BotPersonality;
  stats: ObservedOpponentStats;
}

export interface PublicSeatState {
  id: string;
  name: string;
  isHuman: boolean;
  stack: number;
  folded: boolean;
  allIn: boolean;
  committedStreet: number;
  committedHand: number;
  lastAction?: LoggedActionType;
  position: string;
  stats: ObservedOpponentStats;
}

export interface PotAward {
  amount: number;
  winnerIds: string[];
  label: string;
}

export interface WinnerSettlement {
  playerId: string;
  playerName: string;
  contributed: number;
  received: number;
  net: number;
}

export interface HandResult {
  potTotal: number;
  awards: PotAward[];
  winnerIds: string[];
  winnerSettlements: WinnerSettlement[];
  summary: string;
  showdown: boolean;
}

export interface FullGameState {
  handId: string;
  handNumber: number;
  seed: string;
  smallBlind: number;
  bigBlind: number;
  difficulty: Difficulty;
  deck: Card[];
  deckIndex: number;
  community: Card[];
  seats: SeatState[];
  buttonIndex: number;
  activeIndex: number;
  street: Street;
  status: "waiting" | "playing" | "complete";
  currentBet: number;
  minRaise: number;
  lastAggressorId?: string;
  actionLog: GameAction[];
  lastResult?: HandResult;
}

interface BaseVisibleState {
  viewerId: string;
  holeCards: Card[];
  handId: string;
  handNumber: number;
  seed: string;
  smallBlind: number;
  bigBlind: number;
  community: Card[];
  seats: PublicSeatState[];
  buttonIndex: number;
  activeIndex: number;
  street: Street;
  currentBet: number;
  minRaise: number;
  actionLog: GameAction[];
  legalActions: LegalActions;
}

export type BoardTexture = "preflop" | "dry" | "dynamic" | "wet" | "paired" | "monotone";

export interface InferredRange {
  playerId: string;
  playerName: string;
  position: string;
  width: number;
  label: string;
  evidence: string[];
}

export interface ActionComparison {
  action: PlayerActionType;
  target?: number;
  score: number;
  verdict: "best" | "close" | "inferior";
  purpose: string;
  explanation: string;
  worseContinue?: number;
  betterFold?: number;
  overallFold?: number;
  raiseBack?: number;
  rolloutValue?: number;
}

export type RelativeTier = "nuts" | "near-nuts" | "strong" | "medium" | "bluff-catcher" | "weak";
export type MadeHandClass =
  | "preflop-premium" | "preflop-strong" | "preflop-speculative" | "preflop-weak"
  | "straight-flush" | "quads" | "full-house" | "flush" | "straight"
  | "set" | "trips" | "two-pair" | "overpair" | "top-pair-top-kicker"
  | "top-pair" | "weak-top-pair" | "middle-pair" | "bottom-pair"
  | "underpair" | "board-pair" | "high-card";
export type DrawClass =
  | "none" | "backdoor-flush" | "gutshot" | "open-ended"
  | "nut-flush-draw" | "non-nut-flush-draw" | "combo-draw";

export interface RelativeHandProfile {
  madeClass: MadeHandClass;
  madeLabel: string;
  relativeTier: RelativeTier;
  relativeLabel: string;
  absoluteName: string;
  drawClass: DrawClass;
  drawLabel: string;
  nutRank: number;
  showdownStrength: number;
  vulnerability: number;
  bluffCatcher: boolean;
  nutPotential: boolean;
  blockers: string[];
  explanation: string;
}

export interface RangeResponseAnalysis {
  referenceSize: number;
  worseHandsContinue: number;
  betterHandsFold: number;
  strongerHandsContinue: number;
  overallContinue: number;
  foldShare: number;
  callShare: number;
  raiseBack: number;
  weakerRangeShare: number;
  betterRangeShare: number;
  valueTargets: string[];
  foldTargets: string[];
  summary: string;
}

export interface StrategyAnalysis {
  equity: number;
  potOdds: number;
  spr: number;
  outs: number;
  boardTexture: BoardTexture;
  boardSummary: string;
  rangeAdvantage: number;
  positionSummary: string;
  rangeSummary: string;
  opponentRanges: InferredRange[];
  handProfile: RelativeHandProfile;
  rangeResponse: RangeResponseAnalysis;
  candidates: ActionComparison[];
  mathSummary: string;
  uncertainty: string;
}

export interface PlayerViewState extends BaseVisibleState {
  viewKind: "player";
}

export interface BotViewState extends BaseVisibleState {
  viewKind: "bot";
}

export interface ReviewSnapshot {
  handId: string;
  seed: string;
  community: Card[];
  seats: Array<PublicSeatState & { holeCards: Card[] }>;
  actionLog: GameAction[];
  result?: HandResult;
}

export interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  canBet: boolean;
  canRaise: boolean;
  canAllIn: boolean;
  toCall: number;
  callAmount: number;
  minBetTo: number;
  minRaiseTo: number;
  maxTo: number;
}

export interface CoachMetrics {
  equity: number;
  neutralEquity: number;
  potOdds: number;
  outs: number;
  spr: number;
  equityLabel: string;
}

export interface BeginnerGuidance {
  handSummary: string;
  actionReason: string;
  lesson: string;
  nextPlan: string;
}

export type AdviceConfidence = "高" | "中" | "低";
export type DecisionRating = "优秀" | "合理" | "边缘" | "失误";

export interface CoachAdvice {
  action: PlayerActionType;
  target?: number;
  actionLabel: string;
  summary: string;
  reasons: string[];
  alternatives: string[];
  concepts: string[];
  metrics: CoachMetrics;
  confidence: AdviceConfidence;
  beginner: BeginnerGuidance;
  analysis: StrategyAnalysis;
}

export interface DecisionRecord {
  actionIndex: number;
  street: Street;
  pot: number;
  chosen: PlayerActionInput;
  advice: CoachAdvice;
  rating: DecisionRating;
  note: string;
}

export interface HandReview {
  handId: string;
  seed: string;
  result: HandResult;
  snapshot: ReviewSnapshot;
  decisions: DecisionRecord[];
  keyDecisionIndexes: number[];
  takeaway: string;
}

export interface TournamentStanding {
  playerId: string;
  playerName: string;
  place: number;
  prize: number;
}

export interface TournamentState {
  id: string;
  startingStack: number;
  entrantIds: string[];
  eliminationOrder: string[];
  standings: TournamentStanding[];
  finished: boolean;
  championId?: string;
}
export interface StakeLevel {
  id: string;
  smallBlind: number;
  bigBlind: number;
  unlockBankroll: number;
}

export interface CareerStats extends ObservedOpponentStats {
  wins: number;
  biggestPot: number;
}

export interface BankrollPoint {
  at: number;
  value: number;
  reason: string;
}

export interface SavedHand {
  id: string;
  playedAt: number;
  mode: GameMode;
  difficulty: Difficulty;
  stakeId: string;
  review: HandReview;
}

export interface CareerProfile {
  version: 1;
  bankroll: number;
  startingBankroll: number;
  unlockedStakeIds: string[];
  refillCount: number;
  bankruptcyCount: number;
  maxBankroll: number;
  minBankroll: number;
  bankrollHistory: BankrollPoint[];
  stats: CareerStats;
  opponentStats: Record<string, ObservedOpponentStats>;
  hands: SavedHand[];
  preferences: {
    aiSpeed: "normal" | "fast";
    mode: GameMode;
    tableFormat: TableFormat;
    difficulty: Difficulty;
    stakeId: string;
    soundMuted: boolean;
    soundVolume: number;
    bgmMuted: boolean;
    bgmVolume: number;
  };
}

export const EMPTY_STATS: ObservedOpponentStats = {
  hands: 0,
  vpipHands: 0,
  pfrHands: 0,
  threeBets: 0,
  aggressiveActions: 0,
  passiveActions: 0,
  flopAggressiveActions: 0,
  flopPassiveActions: 0,
  turnAggressiveActions: 0,
  turnPassiveActions: 0,
  riverAggressiveActions: 0,
  riverPassiveActions: 0,
  facedPostflopBets: 0,
  foldedToPostflopBets: 0,
  facedRiverBets: 0,
  foldedToRiverBets: 0,
  turnBarrelOpportunities: 0,
  turnBarrels: 0,
  riverBarrelOpportunities: 0,
  riverBarrels: 0,
  riverStabOpportunities: 0,
  riverStabs: 0,
  recentAggression: 0.42,
};

export const STAKES: StakeLevel[] = [
  { id: "5-10", smallBlind: 5, bigBlind: 10, unlockBankroll: 0 },
  { id: "10-20", smallBlind: 10, bigBlind: 20, unlockBankroll: 40_000 },
  { id: "25-50", smallBlind: 25, bigBlind: 50, unlockBankroll: 100_000 },
  { id: "50-100", smallBlind: 50, bigBlind: 100, unlockBankroll: 200_000 },
];
