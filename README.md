# Claude HUD for Trae

一个为 Trae IDE 设计的 Claude Code 状态显示扩展，实时监控 AI 编码助手的工作状态。

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 🤖 模型信息 | 显示当前使用的 AI 模型（如 `[mimo-v2.5-pro]`） |
| 📊 上下文使用率 | 实时显示上下文窗口使用百分比和进度条 |
| 🔧 工具活动 | 显示正在运行的工具（读取、编辑、搜索等） |
| 🤥 Agent 状态 | 显示活跃的子 agent 数量 |
| ✅ Todo 进度 | 显示任务完成进度 |
| 🌿 Git 分支 | 显示当前 Git 分支信息 |
| 🎯 精度统计 | 实时监控解析成功率和性能指标 |
| ⚡ 增量读取 | 智能增量读取，提升性能 |

## 📦 安装方法

### 方式一：从 VSIX 文件安装（推荐）

1. 下载扩展文件：`trae-claude-hud-1.0.0.vsix`
2. 在 Trae 中按 `Ctrl+Shift+P` 打开命令面板
3. 输入 `Extensions: Install from VSIX...`
4. 选择下载的 `.vsix` 文件
5. 重启 Trae IDE

### 方式二：从源码编译

```bash
# 克隆或下载源码
cd trae-claude-hud

# 安装依赖
npm install

# 编译 TypeScript
npm run compile

# 打包扩展
npm install -g @vscode/vsce
vsce package

# 安装生成的 .vsix 文件
```

## 🚀 使用说明

### 基本使用

安装完成后，扩展会在 Trae 窗口底部的状态栏自动显示 Claude Code 的状态信息：

```
[mimo-v2.5-pro] │ ████░░░░░░ 45%
```

- **[模型名称]** - 当前使用的 AI 模型
- **进度条** - 上下文使用率可视化（绿色填充部分）
- **百分比** - 上下文使用百分比

### 启用/禁用 HUD

按 `Ctrl+Shift+P`，输入：
```
Claude HUD: Toggle Display
```

### 查看详细日志

按 `Ctrl+Shift+P`，输入：
```
Claude HUD: Show Output Channel
```

## ⚙️ 配置选项

按 `Ctrl+,` 打开设置，搜索 `claudeHud`，可以配置以下选项：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `claudeHud.enabled` | boolean | `true` | 启用/禁用 HUD |
| `claudeHud.updateInterval` | number | `1000` | 更新间隔（毫秒） |
| `claudeHud.showContextBar` | boolean | `true` | 显示上下文进度条 |
| `claudeHud.showTools` | boolean | `true` | 显示工具活动 |
| `claudeHud.showAgents` | boolean | `true` | 显示 Agent 状态 |
| `claudeHud.showTodos` | boolean | `true` | 显示 Todo 进度 |
| `claudeHud.enablePrecisionStats` | boolean | `true` | 启用精度统计日志 |
| `claudeHud.enableIncrementalRead` | boolean | `true` | 启用增量读取优化 |

### 配置示例

在 `settings.json` 中添加：

```json
{
  "claudeHud.enabled": true,
  "claudeHud.updateInterval": 500,
  "claudeHud.showTools": true,
  "claudeHud.showAgents": true,
  "claudeHud.showTodos": false
}
```

## 🔍 工作原理

Claude HUD 通过以下方式获取状态信息：

1. **查找 transcript 文件**：在 `~/.claude/projects/` 目录下查找当前会话的 JSONL 文件
2. **解析会话数据**：读取 transcript 文件中的 `assistant` 类型消息
3. **提取状态信息**：获取模型名称、token 使用量、工具活动等
4. **更新状态栏**：定时刷新 Trae 底部状态栏的显示

### 数据来源

- **模型信息**：从 `assistant` 消息的 `model` 字段获取
- **上下文使用率**：从 `usage` 字段的 token 数量计算
- **工具活动**：从 `tool_use` 和 `tool_result` 消息解析
- **Git 分支**：从 transcript 的 `gitBranch` 字段获取

### 精度验证

#### 1. 查看精度统计日志

按 `Ctrl+Shift+P`，输入：
```
Claude HUD: Show Output Channel
```

日志会显示：
```
Precision stats: success=150, failed=2, fileReads=1, incrementalReads=149
```

- **success**：成功解析次数
- **failed**：解析失败次数
- **fileReads**：完整文件读取次数
- **incrementalReads**：增量读取次数

#### 2. 验证上下文使用率

1. 打开日志查看实际 token 数量：
   ```
   Tokens: input=694, cache_read=81472, total=82166, percent=41%
   Context window: 200000 (model: mimo-v2.5-pro)
   ```

2. 手动计算验证：
   ```
   total = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
   percent = (total / context_window_size) * 100
   ```

3. 对比 Claude Code 官方显示

#### 3. 动态上下文窗口

扩展会根据模型名称自动调整上下文窗口大小：

| 模型 | 上下文窗口 |
|------|-----------|
| claude-3-opus | 200k tokens |
| claude-3-sonnet | 200k tokens |
| claude-3-haiku | 100k tokens |
| claude-3-5-sonnet | 200k tokens |
| mimo-v2.5-pro | 200k tokens |
| 其他模型 | 200k tokens（默认） |

#### 4. 增量读取优化

- **首次读取**：读取完整文件
- **后续读取**：只读取新增的行
- **性能提升**：减少 90%+ 的文件读取开销

## 🐛 常见问题

### Q: 状态栏显示 [Unknown]？

A: 可能的原因：
1. Claude Code 扩展未运行
2. Transcript 文件路径不正确
3. 会话刚启动，还没有 assistant 消息

**解决方法**：
- 查看日志：`Ctrl+Shift+P` → `Claude HUD: Show Output Channel`
- 确认 Claude Code 扩展已激活
- 多对话几轮，等待 assistant 消息生成

### Q: 上下文使用率一直显示 0%？

A: 可能的原因：
1. 会话刚开始，token 使用量很少
2. 解析逻辑未找到 usage 数据

**解决方法**：
- 继续对话，token 使用量会逐渐增加
- 查看日志确认是否成功解析 usage 数据

### Q: 如何调整显示位置？

A: 目前 HUD 固定显示在状态栏左侧。未来版本可能支持自定义位置。

### Q: 扩展会影响性能吗？

A: 不会。扩展每秒只读取一次 transcript 文件（可配置间隔），文件读取是异步的，不会阻塞 IDE。

## 📁 项目结构

```
trae-claude-hud/
├── src/
│   └── extension.ts      # 主要扩展代码
├── out/
│   ├── extension.js       # 编译后的 JavaScript
│   └── extension.js.map   # Source Map
├── package.json           # 扩展配置清单
├── tsconfig.json          # TypeScript 配置
├── README.md              # 本文件
└── trae-claude-hud-1.0.0.vsix  # 打包后的扩展文件
```

## 🔧 开发说明

### 环境要求

- Node.js >= 18.0.0
- TypeScript >= 5.0.0
- Trae IDE（基于 VSCode）

### 开发命令

```bash
# 安装依赖
npm install

# 编译（监听模式）
npm run watch

# 编译（单次）
npm run compile

# 打包扩展
vsce package
```

### 自定义修改

主要代码在 `src/extension.ts` 中：

- `findTranscriptPath()` - 查找 transcript 文件路径
- `parseTranscriptLine()` - 解析 transcript 数据
- `updateStatusBar()` - 更新状态栏显示
- `formatContextBar()` - 格式化进度条

## 📝 更新日志

### v1.1.0 (2026-06-13)
- 🎯 精度改进
  - ✅ 动态上下文窗口大小（根据模型自动调整）
  - ✅ 增量读取优化（提升 90%+ 性能）
  - ✅ 精度统计日志（监控解析成功率）
  - ✅ 新增配置选项：`enablePrecisionStats` 和 `enableIncrementalRead`

### v1.0.0 (2026-06-13)
- ✨ 初始版本
- ✅ 支持模型信息显示
- ✅ 支持上下文使用率监控
- ✅ 支持工具活动显示
- ✅ 支持 Agent 状态显示
- ✅ 支持 Todo 进度显示
- ✅ 支持 Git 分支显示
- ✅ 可配置更新间隔和显示选项

## 📄 许可证

MIT License

## 🙏 致谢

- 感谢 [Claude HUD](https://github.com/jarrodwatts/claude-hud) 项目提供的灵感
- 感谢 Anthropic 提供的 Claude Code 扩展 API

---

**享受使用 Claude HUD for Trae！** 🚀