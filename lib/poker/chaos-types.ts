export type ChaosSkillType = "locked" | "limited" | "active";

export interface ChaosSkill {
  id: string;
  name: string;
  type: ChaosSkillType; // 技能属性：锁定技、限定技、主动技
  frequency?: "game" | "hand"; // 限制频次：整局限一次 (game) vs 每手限一次 (hand)
  tagline?: string;
  description: string;
  timingDescription: string;
  icon?: string;
  usagesLimit?: number; // 允许使用次数
  targetType?: "none" | "player" | "card" | "self_card"; // 发动所需目标类型
}

export interface ChaosCharacter {
  id: string;
  name: string;
  title: string;
  avatar: string; // 头像资源路径，支持 SVG / PNG / WebP
  avatarFallbackText: string; // 头像加载失败或紧凑缩略图文字
  themeColor: string; // 角色代表色 (HEX/HSL)
  description: string;
  skills: ChaosSkill[];
}

export interface ChaosSelectionState {
  active: boolean; // 是否处于选将阶段
  expiresAt: number; // 选将超时时间戳
  timeRemaining: number; // 剩余秒数
  availableCharacters: ChaosCharacter[]; // 当前可选角色列表
  selectedMap: Record<string, string>; // playerId -> characterId
}

/**
 * 玩家技能实时状态（供前后端同步限定技消耗与可触发状态）
 */
export interface PlayerSkillStatus {
  used: boolean; // 是否已消耗（限定技用完后为 true，图标灰化加盖【已发动】印章）
  available: boolean; // 当前瞬间是否满足时机可立即点击发动
  usagesCount: number; // 已使用次数
}

/**
 * 《赌神德州 v0.1》官方角色与技能定义
 * 头像文件位于 /public/avatars/chaos_char_*.svg
 */
export const INITIAL_CHAOS_CHARACTERS: ChaosCharacter[] = [
  {
    id: "chaos_char_1",
    name: "高进",
    title: "赌神",
    avatar: "/avatars/chaos_char_1.svg",
    avatarFallbackText: "神",
    themeColor: "#f59e0b",
    description: "高进拥有最稳定、最可控的变牌能力，并可以通过积极参与大底池重新品尝朱古力恢复【变牌】。",
    skills: [
      {
        id: "skill_bianpai",
        name: "变牌",
        type: "limited",
        frequency: "game",
        tagline: "定海神针",
        icon: "♦",
        timingDescription: "河牌圈轮到你行动时",
        description: "【限定技】河牌圈轮到你行动时，你可以选择自己的一张底牌，尝试将其变为【方块3】，直到本手牌结束。若方块3已出现在公共牌中，或已被发给任意玩家（已弃牌玩家的底牌同样参与判断），则变牌失败。无论变牌成功或失败，均视为发动过【变牌】。",
        usagesLimit: 1,
        targetType: "self_card",
      },
      {
        id: "skill_zhuguli",
        name: "朱古力",
        type: "locked",
        tagline: "重铸神格",
        icon: "🍫",
        timingDescription: "一手牌结算时自动触发",
        description: "【锁定技】一手牌结束时，若你本手牌累计主动投入不少于 10BB，且【变牌】已经发动过，则令【变牌】视为未发动过。（主动投入包括跟注、下注和加注，不包括盲注及前注）",
        targetType: "none",
      },
    ],
  },
  {
    id: "chaos_char_2",
    name: "龙五",
    title: "神枪保镖",
    avatar: "/avatars/chaos_char_2.svg",
    avatarFallbackText: "五",
    themeColor: "#38bdf8",
    description: "龙五不依赖复杂赌术，而更擅长正面对峙和识破对手。技能鼓励其跟注强势下注、进行抓诈对决。",
    skills: [
      {
        id: "skill_qiangshen",
        name: "枪神",
        type: "locked",
        tagline: "神枪护体",
        icon: "🎯",
        timingDescription: "以跟注进入摊牌并获胜时",
        description: "【锁定技】若你以跟注的方式进入摊牌并最终获胜，额外从系统获得 1BB 筹码奖励。",
        targetType: "none",
      },
    ],
  },
  {
    id: "chaos_char_3",
    name: "陈刀仔",
    title: "赌侠",
    avatar: "/avatars/chaos_char_3.svg",
    avatarFallbackText: "刀",
    themeColor: "#22c55e",
    description: "刀仔已经学会了高进的变牌技巧，但无法控制最终变成什么牌；同时在筹码较少时拥有极强的绝地翻本能力。",
    skills: [
      {
        id: "skill_xueyi",
        name: "学艺",
        type: "active",
        frequency: "hand",
        tagline: "随机神变",
        icon: "🎲",
        timingDescription: "河牌圈轮到你行动时",
        description: "【每手限一次】河牌圈轮到你行动时，你可以选择自己的一张底牌，将其替换为牌库中一张随机的未使用牌（当前未出现在任何玩家底牌及公共牌中的牌）。",
        usagesLimit: 1,
        targetType: "self_card",
      },
      {
        id: "skill_fanben",
        name: "翻本",
        type: "locked",
        tagline: "短码翻盘",
        icon: "💰",
        timingDescription: "短码开局且本手盈利时",
        description: "【锁定技】一手牌开始时，若你的筹码少于 10BB，则本手牌结算时，若你获得了净收益，你额外获得等同于该净收益的筹码，至多获得 5BB。（净收益 = 本手牌结束后获得的筹码 − 本手牌中投入的筹码）",
        targetType: "none",
      },
    ],
  },
  {
    id: "chaos_char_4",
    name: "高义",
    title: "笑面藏刀",
    avatar: "/avatars/chaos_char_4.svg",
    avatarFallbackText: "义",
    themeColor: "#a855f7",
    description: "高义不直接改变牌面，而是通过作弊获得正常玩家无法得到的牌堆信息，以信息优势辅助自己的下注判断。",
    skills: [
      {
        id: "skill_xianying",
        name: "显影",
        type: "locked",
        tagline: "翻前显露",
        icon: "👁️",
        timingDescription: "翻前下注轮时可见",
        description: "【锁定技】在翻前下注轮中，未来翻牌的第一张公共牌对你可见。",
        targetType: "none",
      },
      {
        id: "skill_chuqian",
        name: "出千",
        type: "locked",
        tagline: "底牌透视",
        icon: "🃏",
        timingDescription: "始终可见",
        description: "【锁定技】牌堆底的 3 张牌对你始终可见。",
        targetType: "none",
      },
    ],
  },
];
