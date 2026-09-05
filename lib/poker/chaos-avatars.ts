import type { ChaosCharacter } from "./chaos-types";

/**
 * 通用默认头像占位资源路径
 */
export const DEFAULT_AVATAR_PLACEHOLDER = "/avatars/default_placeholder.svg";

/**
 * 角色头像占位配置与规格
 */
export interface AvatarPlaceholderConfig {
  defaultAssetPath: string;
  fallbackText: string;
  themeColor: string;
  bgGradient: string;
}

/**
 * 4 个初始角色的默认头像占位定义表
 */
export const CHAOS_AVATAR_PRESETS: Record<string, AvatarPlaceholderConfig> = {
  chaos_char_1: {
    defaultAssetPath: "/avatars/chaos_char_1.svg",
    fallbackText: "神",
    themeColor: "#f59e0b",
    bgGradient: "linear-gradient(135deg, #d97706 0%, #b45309 100%)",
  },
  chaos_char_2: {
    defaultAssetPath: "/avatars/chaos_char_2.svg",
    fallbackText: "五",
    themeColor: "#38bdf8",
    bgGradient: "linear-gradient(135deg, #0284c7 0%, #0369a1 100%)",
  },
  chaos_char_3: {
    defaultAssetPath: "/avatars/chaos_char_3.svg",
    fallbackText: "刀",
    themeColor: "#22c55e",
    bgGradient: "linear-gradient(135deg, #16a34a 0%, #15803d 100%)",
  },
  chaos_char_4: {
    defaultAssetPath: "/avatars/chaos_char_4.svg",
    fallbackText: "义",
    themeColor: "#a855f7",
    bgGradient: "linear-gradient(135deg, #7e22ce 0%, #581c87 100%)",
  },
};

/**
 * 安全解析角色头像资源路径，若为空则回退到角色预设占位或全局默认占位图
 */
export function resolveCharacterAvatar(char?: Partial<ChaosCharacter> | null): string {
  if (!char) return DEFAULT_AVATAR_PLACEHOLDER;
  if (char.avatar && char.avatar.trim().length > 0) {
    return char.avatar;
  }
  if (char.id && CHAOS_AVATAR_PRESETS[char.id]) {
    return CHAOS_AVATAR_PRESETS[char.id].defaultAssetPath;
  }
  return DEFAULT_AVATAR_PLACEHOLDER;
}
