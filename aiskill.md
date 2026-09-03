# RiverLab Poker Trainer - AI 开发者手册 (aiskill.md)

本文档面向后续接手 RiverLab 项目的 AI 编程助手与开发者，提炼了整个项目的核心架构、技术栈、关键模块设计、联机通信协议与必须遵守的硬性技术规范。

---

## 1. 项目定位与技术栈

- **项目定位**：基于 Web 的离线单人/多人 8 人桌德州扑克训练室（RiverLab）。包含第一视角教练教学、GTO 演化 AI 对局、以及支持多端/跨网（局域网/Tailscale）的实时多人对战系统。
- **前端框架**：`React 19` + `Next.js 16` + `Vite 8`（使用 `vinext` 驱动的现代化 RSC/SSR 开发体系）。
- **服务端**：Node.js 原生 HTTP 服务挂载 `ws`（WebSocketServer），与 Vite 开发服务器共用 4311 端口。
- **语言与规范**：TypeScript 5.9，严格类型检查（无 `any` 滥用，零警告通过 `npm run check`），纯 Vanilla CSS（玻璃拟态与低饱和度扑克绿美学设计）。
- **自动化测试**：基于 Node.js 原生测试运行器 `tsx --test tests/*.test.ts`，涵盖引擎数学规则、底池切分、旁观者上帝视角胜率、BGM 状态机以及联机房间状态机。

---

## 2. 代码仓库结构全景

```text
riverlab-poker-trainer/
├── app/
│   ├── components/
│   │   ├── PokerTrainer.tsx       # 单人训练与多人联机的主入口状态组件
│   │   ├── MultiplayerLobby.tsx   # 联机大厅：创房规则设定、入座准备、房间列表
│   │   └── MultiplayerTable.tsx   # 联机牌桌：镜像单人版 UI，含流光倒计时、操作台、侧边栏
│   ├── globals.css                # 全局样式系统（主题色彩、桌布、筹码、动画、微动效）
│   ├── layout.tsx                 # 根布局与元数据配置
│   └── page.tsx                   # 应用主页面
├── lib/
│   └── poker/
│       ├── bgm.ts                 # 工业级 5 轨同轴交互式混音引擎（Interactive Stem Mixer）
│       ├── engine.ts              # 核心扑克规则引擎（发牌、盲注、转轮、合法行动、分池）
│       ├── evaluator.ts           # 7 张牌高精度牌型评估器（含 Wheel 顺子、Tie 拆分）
│       ├── coach.ts               # 第一视角 AI 教练分析与建议
│       ├── equity.ts              # Monte-Carlo / 枚举胜率计算
│       ├── types.ts               # 扑克引擎与对局核心类型定义
│       └── storage.ts             # 玩家本地战绩与资金持久化
├── server/
│   ├── multiplayer-server.ts      # WebSocket 集中服务、客户端会话与全局房间调度
│   ├── multiplayer-room.ts        # 单个房间状态机：思考倒计时、延时卡、防作弊手牌掩码、房主发牌
│   ├── multiplayer-types.ts       # 联机通信协议与消息类型声明（ClientMessage / ServerMessage）
│   └── multiplayer-equity.ts      # 上帝视角/旁观者实时胜率计算器
├── public/
│   ├── music/                     # 5 首严格对齐的交互式分轨音乐（.flac）
│   │   ├── lobby.flac             # 准备阶段 / 房主待发牌
│   │   ├── pre-river.flac         # 翻前、翻牌、转牌对决
│   │   ├── river.flac             # 第 5 张河牌落桌
│   │   ├── time-bank.flac         # 延时卡生效中的紧迫旋律
│   │   └── settlement.flac        # 亮牌结算与底池分配
│   └── sounds/                    # 筹码滑动、发牌等高保真音效
├── tests/                         # 41 项完备的单元与集成自动化测试
│   ├── bgm-stage.test.ts          # BGM 阶段流转与状态映射测试
│   ├── multiplayer-room.test.ts   # 联机房间发牌、房主控制、加时卡、防作弊测试
│   └── *.test.ts                  # 牌型大小、旁注分池、AI 演化测试
├── vite.config.ts                 # Vite 配置文件，挂载 WebSocket 插件与网络安全配置
└── package.json                   # 项目依赖与启动脚本
```

---

## 3. 核心子系统与关键实现机制

### 3.1 工业级交互式多轨 BGM 引擎 (`lib/poker/bgm.ts`)

- **同轴多轨并跑（No-Seek Stem Mixing）**：
  - 5 首歌曲是 BPM、小节数和总时长 100% 严格一致的分轨。
  - 用户在页面发生**任何首次手势（点击/按键）**触发 `bgm.unlock()` 后，**5 首歌曲在后台主时钟同轴静音并跑**。
  - 当前激活的轨道音量为 `masterVolume`（如 0.35），其余 4 轨以 `0` 音量在后台同走进度。
- **纯音量推子淡入淡出（1s Crossfade）**：
  - 阶段切换（如河牌圈、加时卡）时，**严禁调用 `currentTime` 进行任何寻轨（Seek）或 `pause/play`**。
  - 仅使用 `requestAnimationFrame` 在 1000ms 内平滑推拉各轨音量推子（Gain Faders），实现 100% 绝对采样级（Sample-Accurate）无缝咬合，绝不卡顿或丢节拍。
- **漂移看门狗（Drift Watchdog）**：
  - 每 2 秒静默比对静音后台轨与当前主声轨的时间差。
  - 若累积时钟漂移 >50ms，在静音状态下微调对齐，绝不影响正在收听的主声道。

### 3.2 联机房间状态机与房主掌控流 (`server/multiplayer-room.ts`)

- **房主绝对节奏掌控（严禁自动开局）**：
  1. **第一手牌**：大厅房主点击「🚀 开启牌局」后，房间转为 `status: "playing"`，所有人入座进牌桌，但 `firstHandPending: true`，不发牌也不倒计时。**必须等待房主在牌桌上主动点击「开始第一手 🚀」**才正式洗牌发牌。
  2. **后续各手**：每局结算分池后，**彻底取消了原本的 7 秒自动开局**，无限期停留在结算展示面，**必须等待房主主动点击「开始下一手 →」**才继续。
- **延时卡（Time-Bank）规则**：
  - 延时卡增加的思考时间等于单次常规思考时间的**整整 1 倍**（`+config.regularTurnSeconds`）。
  - 只有当前行动玩家、且剩余思考时间 `≤ 5s` 时，延时卡按钮才允许点击激活。
  - 激活后：当前回合剩余时间延长，超时定时器重置，BGM 无缝推入 `time-bank.flac`。
- **防作弊信息隔离（Anti-Cheat Masking）**：
  - 服务端在 `buildClientState(clientId)` 中执行手牌过滤：
    - 普通在座玩家只能看到自己的两张底牌（`myHoleCards`），其他在座玩家的 `holeCards` 被强制清空为 `[]`（弃牌或 Showdown 结算前）。
    - 仅有开启上帝视角的观战者（`godMode: true`）能看到全员手牌并接收实时胜率矩阵。

### 3.3 客户端毫秒级倒计时与流光进度条 (`app/components/MultiplayerTable.tsx`)

- **服务端权威时间戳 + 前端 100ms 动态插值**：
  - 服务端广播 `turnExpiresAt: number`（绝对毫秒时间戳）与 `turnTotalTime`。
  - 前端以 100ms 定时器计算 `remainingSeconds = Math.ceil((turnExpiresAt - Date.now()) / 1000)`。
  - 操作台顶部内置 `.dock-timer-track` 进度条，根据 `remainingMs / totalMs` 从 100% 匀速缩减至 0%。
  - 当 `remainingSeconds <= 5` 时，进度条与字体自动切换为红色发光脉冲急迫特效。

---

## 4. 关键硬性规范与避坑法则（AI 必读）

1. **`vinext` 开发服务器启动参数规范**：
   - 必须使用 `-H 0.0.0.0 -p 4311`，**严禁使用 `--host`**（`vinext` 不识别 `--host`，会回退成仅监听 `[::1]:4311` 本地回环，导致外部局域网/Tailscale 无法连接）。
   - 启动命令已封装在 `package.json` 的 `"dev:local"` 中。
2. **Vite 跨域与网络配置 (`vite.config.ts`)**：
   - 必须保留 `server.cors: true`、`server.allowedHosts: true` 以及 `server.hmr: { clientPort: 4311 }`。否则远程客户端拉取 `@id/__x00__virtual:...` 动态模块时会被拦截，导致 React 无法水合。
3. **保持测试 100% 通过**：
   - 任何涉及扑克引擎、房间状态机、BGM 解析器的改动，修改后必须执行：
     ```bash
     npm run check
     npm test
     ```
   - 确保 41 项测试全部 Pass，无任何类型报错。
4. **UI 一致性法则**：
   - 多人模式牌桌必须与单人模式牌桌保持完全一致的排版结构：顶部状态栏 `.table-topbar`、主绿呢绒擂台 `.felt-table`、底部操作台 `.action-dock` 以及右侧分析栏 `.side-panel`。
