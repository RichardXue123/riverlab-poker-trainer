# 胡闹德州角色头像资源目录 (Character Avatars Directory)

本目录为《胡闹德州》模式中各角色的头像图片存储与占位位置。

## 目录结构与对应文件

```text
public/avatars/
├── default_placeholder.svg     # 默认通用占位头像（当角色未配置头像或图片加载失败时自动展示）
├── chaos_char_1.svg            # 角色一默认头像占位 (可在 /lib/poker/chaos-types.ts 中配置路径)
├── chaos_char_2.svg            # 角色二默认头像占位
├── chaos_char_3.svg            # 角色三默认头像占位
├── chaos_char_4.svg            # 角色四默认头像占位
└── characters/                 # 自定义高清角色头像推荐存放子目录
    ├── char_1.png (或 .webp / .svg)
    ├── char_2.png
    ├── char_3.png
    └── char_4.png
```

## 头像规格建议

1. **图片尺寸**：推荐 `256 x 256` 像素 或 `512 x 512` 像素（1:1 正方形比例）。
2. **支持格式**：`.png`、`.webp`、`.svg`、`.jpg`。推荐带透明通道的 `.png` 或 `.webp`。
3. **视觉风格**：建议半身像或头部特写，角色面容居中，四周留有适度呼吸空间。
4. **容错机制**：代码中内置了 `CharacterAvatar` 容错渲染，如果图片路径不存在或加载失败，系统会自动平滑回退为带有角色代表色及代号徽章的高质感占位图形，绝不出现图片裂开的情况。

## 如何修改角色头像？

在 `lib/poker/chaos-types.ts` 中的 `INITIAL_CHAOS_CHARACTERS` 数组内，修改对应角色的 `avatar` 字段即可：

```typescript
{
  id: "chaos_char_1",
  name: "角色名称",
  title: "角色称号",
  avatar: "/avatars/characters/char_1.png", // 在这里填入你的图片路径
  avatarFallbackText: "名",                 // 头像加载失败或紧凑缩略图时显示的文字
  themeColor: "#38bdf8",                   // 角色专属主题色（用于头像发光边框）
  ...
}
```
