# 抖音福袋助手 (auto-luckBag)

自动抢抖音直播间福袋的桌面端应用。

## 技术栈

- **桌面壳**: Electron
- **前端**: Vue3 + TypeScript
- **自动化引擎**: Playwright
- **持久化**: electron-store
- **构建工具**: electron-vite

## 项目结构

```
src/
├── main/                  # Electron 主进程
│   ├── index.ts           # 入口
│   ├── ipc-handlers.ts    # IPC 通信
│   ├── browser-manager.ts # Playwright 浏览器管理
│   ├── room-manager.ts    # 多房间管理
│   ├── fudai-service.ts   # 福袋检测+抢核心逻辑
│   ├── auth-service.ts    # 登录状态管理
│   ├── ws-analyzer.ts     # WebSocket 帧解析
│   └── store.ts           # 配置持久化
├── preload/
│   └── index.ts           # 主窗口 preload
└── renderer/              # Vue3 前端
    └── src/
        ├── components/    # UI 组件
        ├── composables/   # 组合式函数
        └── types/         # 类型定义
```

## 核心业务规则

### 福袋类型（多选组合）
- 全部类型 / 实物福袋 / 钻石福袋 / 其他类型
- 用户可任意组合，如同时勾选实物+钻石

### 钻石预算（全局共享）
- 所有直播间共享一个钻石预算总额
- 已使用量跨房间累计
- 预算不足时跳过需要灯牌的福袋

### 自动关注
- 福袋要求关注主播时自动点击关注
- 始终启用，不可配置关闭

### 多房间
- 每个直播间一个 Playwright Page
- 共享 BrowserContext 复用登录态
- 建议最多同时监控 5 个直播间

### 福袋检测（双层策略）
1. **WebSocket 帧拦截**（主）：解析 protobuf 消息识别福袋推送
2. **DOM MutationObserver**（兜底）：监控福袋 UI 元素出现

### 反检测措施
- 点击操作添加随机延迟（50-200ms）
- 使用 Playwright stealth 规避检测
- 操作间隔模拟人类节奏

## 开发命令

```bash
npm run dev          # 启动开发模式
npm run build        # 构建生产版本
npm run build:win    # 构建 Windows 安装包
```

## 编码规范

- TypeScript 严格模式
- Vue3 Composition API + `<script setup>`
- 主进程模块保持单一职责
- IPC 通信通过 ipc-handlers.ts 统一管理
- 日志通过 IPC 推送到渲染进程展示
- Playwright 选择器配置化，便于应对 DOM 变更
