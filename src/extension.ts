import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 状态栏项
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let updateTimer: NodeJS.Timeout | undefined;
let lastStatusBarText = '$(pulse) Claude HUD';  // 保存上一次的状态栏文本

// 状态数据
interface HudState {
    model: string;
    contextPercent: number;
    contextUsed: number;
    contextTotal: number;
    tools: ToolEntry[];
    agents: AgentEntry[];
    todos: TodoItem[];
    gitBranch: string;
    sessionDuration: string;
}

interface ToolEntry {
    name: string;
    status: 'running' | 'completed' | 'error';
    startTime: Date;
    endTime?: Date;
    file?: string;
}

interface AgentEntry {
    name: string;
    status: 'running' | 'completed' | 'error';
    startTime: Date;
    duration?: number;
}

interface TodoItem {
    text: string;
    completed: boolean;
}

// 精度统计
interface PrecisionStats {
    parseSuccess: number;
    parseFailed: number;
    lastParseTime: Date | null;
    lastTokenCount: number;
    lastContextPercent: number;
    fileReadCount: number;
    incrementalReads: number;
}

// 当前状态
let currentState: HudState = {
    model: 'Unknown',
    contextPercent: 0,
    contextUsed: 0,
    contextTotal: 0,
    tools: [],
    agents: [],
    todos: [],
    gitBranch: '',
    sessionDuration: ''
};

// 精度统计
let precisionStats: PrecisionStats = {
    parseSuccess: 0,
    parseFailed: 0,
    lastParseTime: null,
    lastTokenCount: 0,
    lastContextPercent: 0,
    fileReadCount: 0,
    incrementalReads: 0
};

// 增量读取状态
let lastLineCount = 0;
let lastTranscriptPath: string | null = null;
let lastFileModified = 0;
let lastSessionId: string | null = null;  // [DEBUG] 跟踪 sessionId 变化

// 持久化的显示上下文数据（最核心：只在有完整 usage 数据时更新，永不主动清空）
// 显示层只用这个变量渲染进度条，和数据解析层完全解耦
let displayContext: { percent: number; used: number; total: number } | null = null;

// 配置
let config = {
    enabled: true,
    updateInterval: 1000,
    showContextBar: true,
    showTools: true,
    showAgents: true,
    showTodos: true,
    enablePrecisionStats: true,
    enableIncrementalRead: true
};

// 模型上下文窗口大小映射
// 模型上下文窗口大小映射
const MODEL_CONTEXT_WINDOWS: { [key: string]: number } = {
    // Claude 系列
    'opus': 200000,
    'sonnet': 200000,
    'haiku': 100000,
    'claude-3-opus': 200000,
    'claude-3-sonnet': 200000,
    'claude-3-haiku': 100000,
    'claude-3-5-sonnet': 200000,
    'claude-3-5-haiku': 100000,
    'claude-4': 200000,

    // MiMo 系列
    'mimo-v2.5-pro': 1000000,
    'mimo-v2.5': 1000000,

    // 通义千问 (Qwen) - 阿里巴巴
    'qwen3': 128000,
    'qwen3-coder': 128000,
    'qwen2.5': 128000,
    'qwen2.5-coder': 128000,
    'qwen-turbo': 128000,
    'qwen-plus': 128000,
    'qwen-max': 128000,
    'qwen-max-1201': 128000,
    'qwen-max-longcontext': 1000000,
    'qwen-long': 1000000,

    // DeepSeek - 深度求索
    'deepseek-v3': 128000,
    'deepseek-r1': 128000,
    'deepseek-r1-0528': 128000,
    'deepseek-chat': 128000,
    'deepseek-coder': 128000,
    'deepseek-coder-v2': 128000,

    // 智谱清言 (GLM) - 智谱AI
    'glm-4': 128000,
    'glm-4-plus': 128000,
    'glm-4-long': 1000000,
    'glm-4-flash': 128000,
    'glm-z1': 128000,
    'glm-3': 8192,
    'glm-3-turbo': 8192,

    // 月之暗面 (Moonshot/Kimi)
    'moonshot-v1-8k': 8192,
    'moonshot-v1-32k': 32768,
    'moonshot-v1-128k': 131072,
    'kimi': 128000,
    'kimi-k2': 128000,

    // 讯飞星火 (Spark)
    'spark-max': 8192,
    'spark-pro': 8192,
    'spark-lite': 8192,

    // 文心一言 (ERNIE) - 百度
    'ernie-4.0': 8192,
    'ernie-3.5': 8192,
    'ernie-speed': 8192,

    // 百川 (Baichuan)
    'baichuan2': 4096,
    'baichuan2-turbo': 8192,

    // MiniMax
    'abab6': 8192,
    'abab6.5': 8192,

    // 默认值
    'default': 200000
};

export function activate(context: vscode.ExtensionContext) {
    console.log('Claude HUD for Trae is now active!');

    // 创建输出通道
    outputChannel = vscode.window.createOutputChannel('Claude HUD');
    context.subscriptions.push(outputChannel);

    // 创建状态栏项
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = '$(pulse) Claude HUD';
    statusBarItem.tooltip = 'Claude Code Status';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // 注册命令
    context.subscriptions.push(
        vscode.commands.registerCommand('trae-claude-hud.toggle', toggleHud),
        vscode.commands.registerCommand('trae-claude-hud.showOutput', showOutput)
    );

    // 监听配置变化
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('claudeHud')) {
                loadConfig();
                updateStatusBar();
            }
        })
    );

    // 加载配置
    loadConfig();

    // 开始更新
    startUpdateTimer();

    // 初始更新
    updateStatusBar();
}

function loadConfig() {
    const cfg = vscode.workspace.getConfiguration('claudeHud');
    config.enabled = cfg.get('enabled', true);
    config.updateInterval = cfg.get('updateInterval', 1000);
    config.showContextBar = cfg.get('showContextBar', true);
    config.showTools = cfg.get('showTools', true);
    config.showAgents = cfg.get('showAgents', true);
    config.showTodos = cfg.get('showTodos', true);
    config.enablePrecisionStats = cfg.get('enablePrecisionStats', true);
    config.enableIncrementalRead = cfg.get('enableIncrementalRead', true);
}

// 动态获取上下文窗口大小
function getContextWindowSize(model: string): number {
    const modelLower = model.toLowerCase();
    for (const [key, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
        if (modelLower.includes(key.toLowerCase())) {
            return size;
        }
    }
    return MODEL_CONTEXT_WINDOWS['default'];
}

function startUpdateTimer() {
    if (updateTimer) {
        clearInterval(updateTimer);
    }
    updateTimer = setInterval(() => {
        if (config.enabled) {
            updateStatusBar();
        }
    }, config.updateInterval);
}

function toggleHud() {
    config.enabled = !config.enabled;
    vscode.workspace.getConfiguration('claudeHud').update('enabled', config.enabled, true);
    if (config.enabled) {
        vscode.window.showInformationMessage('Claude HUD enabled');
        startUpdateTimer();
    } else {
        vscode.window.showInformationMessage('Claude HUD disabled');
        if (updateTimer) {
            clearInterval(updateTimer);
        }
        statusBarItem.text = '$(pulse) Claude HUD (disabled)';
    }
}

function showOutput() {
    outputChannel.show();
}

async function updateStatusBar() {
    try {
        // [DEBUG] 记录更新前的 displayContext
        const prevDisplayContext = displayContext ? { ...displayContext } : null;
        const prevStatusBarText = statusBarItem.text;

        // 读取 transcript 文件（可能更新 currentState 和 displayContext）
        await readTranscript();

        // [DEBUG] 检查 readTranscript 是否意外清空了 displayContext
        if (prevDisplayContext && !displayContext) {
            outputChannel.appendLine(`[CRITICAL] displayContext was CLEARED during readTranscript! prev=${JSON.stringify(prevDisplayContext)}`);
        }

        // 构建状态栏文本
        const parts: string[] = [];

        // 模型信息
        if (currentState.model && currentState.model !== 'Unknown') {
            parts.push(`[${currentState.model}]`);
        }

        // 上下文使用率 — 只用 displayContext，与 currentState 完全解耦
        // displayContext 只在解析到完整 usage 数据时更新，永不主动清空
        const contextBarAdded = config.showContextBar && displayContext !== null && displayContext.total > 0;
        if (contextBarAdded && displayContext) {
            const bar = formatContextBar(displayContext.percent);
            parts.push(`${bar} ${displayContext.percent}%`);
        }

        // [DEBUG] 详细记录进度条条件
        outputChannel.appendLine(`[DEBUG-CTX] showContextBar=${config.showContextBar}, displayContext=${JSON.stringify(displayContext)}, contextBarAdded=${contextBarAdded}`);

        // 工具活动（改进：只显示正在运行的工具 + 具体命令）
        if (config.showTools && currentState.tools.length > 0) {
            const activeTools = currentState.tools.filter(t => t.status === 'running');
            if (activeTools.length > 0) {
                const toolInfo = activeTools.map(t => {
                    if (t.file) {
                        // 如果有文件路径，显示文件名
                        const fileName = t.file.split('/').pop() || t.file.split('\\').pop() || t.file;
                        return `${t.name}: ${fileName}`;
                    }
                    return t.name;
                }).join(' | ');
                parts.push(`$(sync~spin) ${toolInfo}`);
            }
        }

        // Agent 状态
        if (config.showAgents && currentState.agents.length > 0) {
            const activeAgents = currentState.agents.filter(a => a.status === 'running');
            if (activeAgents.length > 0) {
                parts.push(`$(hubot) ${activeAgents.length} agents`);
            }
        }

        // Todo 进度
        if (config.showTodos && currentState.todos.length > 0) {
            const completed = currentState.todos.filter(t => t.completed).length;
            parts.push(`$(checklist) ${completed}/${currentState.todos.length}`);
        }

        // Git 分支
        if (currentState.gitBranch) {
            parts.push(`$(git-branch) ${currentState.gitBranch}`);
        }

        // 更新状态栏：新文本有内容则更新，否则保持上次显示
        const newText = parts.join(' │ ');

        // [DEBUG] 记录 parts 构建结果
        outputChannel.appendLine(`[DEBUG-PARTS] count=${parts.length}, newText="${newText.substring(0, 80)}", lastStatusBarText="${(lastStatusBarText || '').substring(0, 80)}"`);

        if (newText) {
            statusBarItem.text = newText;
            lastStatusBarText = newText;
        } else if (lastStatusBarText) {
            statusBarItem.text = lastStatusBarText;
            outputChannel.appendLine(`[DEBUG] Kept lastStatusBarText (newText was empty)`);
        } else if (displayContext) {
            // 终极保底：一旦 displayContext 设置过，进度条永不消失
            const safeText = `${formatContextBar(displayContext.percent)} ${displayContext.percent}%`;
            statusBarItem.text = safeText;
            lastStatusBarText = safeText;
            outputChannel.appendLine(`[WARN] Used ultimate fallback: "${safeText}"`);
        }

        // [DEBUG] 检测进度条是否从有变无
        const hadBar = prevStatusBarText.includes('█') || prevStatusBarText.includes('░');
        const hasBar = statusBarItem.text.includes('█') || statusBarItem.text.includes('░');
        if (hadBar && !hasBar) {
            outputChannel.appendLine(`[CRITICAL] Progress bar DISAPPEARED! prev="${prevStatusBarText.substring(0, 80)}", curr="${statusBarItem.text.substring(0, 80)}"`);
        }

        // 输出详细信息
        outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${statusBarItem.text}`);

    } catch (error) {
        outputChannel.appendLine(`Error: ${error}`);
        // 出错时保持上一次的显示
        statusBarItem.text = lastStatusBarText;
    }
}

function formatContextBar(percent: number): string {
    const filled = Math.round(percent / 10);
    const empty = 10 - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
}

async function readTranscript(): Promise<boolean> {
    // 尝试查找 Claude Code 的 transcript 文件
    const transcriptPath = findTranscriptPath();
    if (!transcriptPath) {
        outputChannel.appendLine(`No transcript path found`);
        return false;
    }

    try {
        if (!fs.existsSync(transcriptPath)) {
            outputChannel.appendLine(`Transcript file not found: ${transcriptPath}`);
            return false;
        }

        // 检查文件是否变化
        const stats = fs.statSync(transcriptPath);
        const currentModified = stats.mtimeMs;

        // [DEBUG] 记录路径和修改时间变化
        outputChannel.appendLine(`[DEBUG] readTranscript: path=${transcriptPath}`);
        outputChannel.appendLine(`[DEBUG] readTranscript: lastPath=${lastTranscriptPath}, currentModified=${currentModified}, lastModified=${lastFileModified}`);
        outputChannel.appendLine(`[DEBUG] readTranscript: pathChanged=${lastTranscriptPath !== transcriptPath}, mtimeChanged=${currentModified !== lastFileModified}`);

        // 如果文件没有变化，跳过更新
        if (lastTranscriptPath === transcriptPath && currentModified === lastFileModified) {
            return false;
        }

        // 更新文件修改时间
        lastFileModified = currentModified;

        // 增量读取优化
        let lines: string[];
        if (config.enableIncrementalRead && lastTranscriptPath === transcriptPath) {
            const content = fs.readFileSync(transcriptPath, 'utf-8');
            const allLines = content.split('\n').filter(line => line.trim());

            // 只读取新增的行
            if (allLines.length > lastLineCount) {
                lines = allLines.slice(lastLineCount);
                lastLineCount = allLines.length;
                precisionStats.incrementalReads++;
                outputChannel.appendLine(`Incremental read: ${lines.length} new lines`);
            } else {
                outputChannel.appendLine(`No new lines to read`);
                return false;
            }
        } else {
            // 首次读取或文件变化，读取全部
            const content = fs.readFileSync(transcriptPath, 'utf-8');
            lines = content.split('\n').filter(line => line.trim());
            lastLineCount = lines.length;
            lastTranscriptPath = transcriptPath;
            precisionStats.fileReadCount++;
            outputChannel.appendLine(`Full read: ${lines.length} lines`);
        }

        // [DEBUG] 输出文件结构：前 5 行的 type 字段
        outputChannel.appendLine(`[DEBUG] === Transcript file structure (first 5 lines) ===`);
        const previewLines = lines.slice(0, 5);
        for (let i = 0; i < previewLines.length; i++) {
            try {
                const data = JSON.parse(previewLines[i]);
                outputChannel.appendLine(`[DEBUG]   Line ${i}: type=${data.type}, sessionId=${data.sessionId || data.session_id || 'N/A'}, keys=${Object.keys(data).join(',')}`);
            } catch {
                outputChannel.appendLine(`[DEBUG]   Line ${i}: (parse error)`);
            }
        }

        // [DEBUG] 输出文件结构：最后 5 行的 type 字段
        outputChannel.appendLine(`[DEBUG] === Transcript file structure (last 5 lines) ===`);
        const tailLines = lines.slice(-5);
        for (let i = 0; i < tailLines.length; i++) {
            const lineIdx = lines.length - 5 + i;
            try {
                const data = JSON.parse(tailLines[i]);
                outputChannel.appendLine(`[DEBUG]   Line ${lineIdx}: type=${data.type}, sessionId=${data.sessionId || data.session_id || 'N/A'}, keys=${Object.keys(data).join(',')}`);
            } catch {
                outputChannel.appendLine(`[DEBUG]   Line ${lineIdx}: (parse error)`);
            }
        }

        // [DEBUG] 检测 sessionId 变化（对话切换）
        let currentSessionId: string | null = null;
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const data = JSON.parse(lines[i]);
                const sid = data.sessionId || data.session_id || null;
                if (sid) {
                    currentSessionId = sid;
                    break;
                }
            } catch { continue; }
        }
        outputChannel.appendLine(`[DEBUG] SessionId: current=${currentSessionId}, last=${lastSessionId}`);
        if (lastSessionId !== null && currentSessionId !== null && currentSessionId !== lastSessionId) {
            outputChannel.appendLine(`[DEBUG] *** SESSION CHANGED! ${lastSessionId} => ${currentSessionId} ***`);
            // 切换对话只重置 model/tools/agents/todos/git — 但 displayContext 保持不变
            // 这样进度条在切换期间不会闪烁或消失，等新对话的 usage 数据解析到后自动更新
            currentState = {
                model: 'Unknown',
                contextPercent: displayContext?.percent || 0,
                contextUsed: displayContext?.used || 0,
                contextTotal: displayContext?.total || 0,
                tools: [],
                agents: [],
                todos: [],
                gitBranch: '',
                sessionDuration: ''
            };
            outputChannel.appendLine(`[DEBUG] State reset due to session change (displayContext preserved: ${displayContext?.percent || 0}%)`);
        }
        lastSessionId = currentSessionId;

        // 从后向前搜索，找到最近的 assistant 类型行
        let foundAssistant = false;
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const data = JSON.parse(lines[i]);
                if (data.type === 'assistant' && data.message) {
                    outputChannel.appendLine(`Found assistant at line ${i}`);
                    parseTranscriptLine(data);
                    foundAssistant = true;
                    precisionStats.parseSuccess++;
                    precisionStats.lastParseTime = new Date();
                    break;
                }
            } catch (error) {
                precisionStats.parseFailed++;
                continue;
            }
        }

        // 如果没有找到 assistant，解析最后一行
        if (!foundAssistant) {
            outputChannel.appendLine(`No assistant line found, parsing last line`);
            try {
                const lastLine = lines[lines.length - 1];
                const data = JSON.parse(lastLine);
                parseTranscriptLine(data);
                precisionStats.parseSuccess++;
            } catch (error) {
                outputChannel.appendLine(`Error parsing last line: ${error}`);
                precisionStats.parseFailed++;
            }
        }

        // 输出精度统计
        if (config.enablePrecisionStats) {
            outputChannel.appendLine(`Precision stats: success=${precisionStats.parseSuccess}, failed=${precisionStats.parseFailed}, fileReads=${precisionStats.fileReadCount}, incrementalReads=${precisionStats.incrementalReads}`);
        }

        outputChannel.appendLine(`Current state: model=${currentState.model}, context=${currentState.contextPercent}%`);
        return true;
    } catch (error) {
        outputChannel.appendLine(`Error reading transcript: ${error}`);
        precisionStats.parseFailed++;
        return false;
    }
}

function findTranscriptPath(): string | null {
    const homeDir = os.homedir();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd();
    const encodedCwd = cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-+|-+$/g, '');

    outputChannel.appendLine(`\n========== findTranscriptPath ==========`);
    outputChannel.appendLine(`[DEBUG] CWD: ${cwd}`);
    outputChannel.appendLine(`[DEBUG] Encoded CWD: ${encodedCwd}`);

    // ===== 策略 1：通过 sessions/ 目录找到活跃进程的 sessionId =====
    const sessionsDir = path.join(homeDir, '.claude', 'sessions');
    outputChannel.appendLine(`[DEBUG] Sessions dir: ${sessionsDir}, exists: ${fs.existsSync(sessionsDir)}`);

    if (fs.existsSync(sessionsDir)) {
        try {
            const sessionFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
            outputChannel.appendLine(`[DEBUG] Session files: ${sessionFiles.join(', ')}`);

            // 收集所有活跃 session，匹配当前 cwd
            const activeSessions: Array<{ pid: number; sessionId: string; cwd: string; startedAt: number }> = [];
            for (const sf of sessionFiles) {
                try {
                    const content = fs.readFileSync(path.join(sessionsDir, sf), 'utf-8');
                    const data = JSON.parse(content);
                    outputChannel.appendLine(`[DEBUG]   ${sf}: sessionId=${data.sessionId}, cwd=${data.cwd}, pid=${data.pid}, startedAt=${data.startedAt}`);
                    activeSessions.push({
                        pid: data.pid,
                        sessionId: data.sessionId,
                        cwd: data.cwd,
                        startedAt: data.startedAt
                    });
                } catch (e) {
                    outputChannel.appendLine(`[DEBUG]   ${sf}: parse error`);
                }
            }

            // 过滤匹配当前 cwd 的 session，收集其 transcript 路径和 mtime
            const matchedSessions = activeSessions
                .filter(s => {
                    const sessionEncodedCwd = s.cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-+|-+$/g, '');
                    return sessionEncodedCwd === encodedCwd;
                });

            // 按 transcript 文件的 mtime 降序排列（最近被写入的 = 用户正在交互的）
            const sessionWithMtime = matchedSessions
                .map(s => {
                    const transcriptPath = path.join(homeDir, '.claude', 'projects', encodedCwd, `${s.sessionId}.jsonl`);
                    let mtimeMs = 0;
                    let exists = false;
                    try {
                        if (fs.existsSync(transcriptPath)) {
                            mtimeMs = fs.statSync(transcriptPath).mtimeMs;
                            exists = true;
                        }
                    } catch { /* ignore */ }
                    return { ...s, transcriptPath, mtimeMs, exists };
                })
                .filter(s => s.exists)
                .sort((a, b) => b.mtimeMs - a.mtimeMs);

            outputChannel.appendLine(`[DEBUG] Matched sessions for cwd (${sessionWithMtime.length}):`);
            for (const s of sessionWithMtime) {
                outputChannel.appendLine(`[DEBUG]   sessionId=${s.sessionId}, pid=${s.pid}, mtimeMs=${s.mtimeMs}`);
            }

            // 选择 mtime 最大的 transcript（最近被写入的）
            if (sessionWithMtime.length > 0) {
                const best = sessionWithMtime[0];
                outputChannel.appendLine(`[DEBUG] Found transcript via session (most recent mtime): ${best.transcriptPath} (sessionId=${best.sessionId})`);
                return best.transcriptPath;
            }
        } catch (error) {
            outputChannel.appendLine(`[DEBUG] Error reading sessions dir: ${error}`);
        }
    }

    // ===== 策略 2：回退到按 mtime 查找最新的 transcript =====
    outputChannel.appendLine(`[DEBUG] Falling back to mtime-based search`);
    const projectsDir = path.join(homeDir, '.claude', 'projects', encodedCwd);
    outputChannel.appendLine(`[DEBUG] Projects dir: ${projectsDir}, exists: ${fs.existsSync(projectsDir)}`);

    if (fs.existsSync(projectsDir)) {
        try {
            const allFiles = fs.readdirSync(projectsDir);
            const jsonlFiles = allFiles
                .filter(f => f.endsWith('.jsonl') && !f.includes('subagents'))
                .map(f => {
                    const filePath = path.join(projectsDir, f);
                    const stat = fs.statSync(filePath);
                    return { name: f, path: filePath, size: stat.size, mtimeMs: stat.mtimeMs };
                })
                .sort((a, b) => b.mtimeMs - a.mtimeMs);

            outputChannel.appendLine(`[DEBUG] .jsonl files (sorted by mtime desc):`);
            for (const f of jsonlFiles) {
                outputChannel.appendLine(`[DEBUG]   ${f.name} | size=${f.size} | mtimeMs=${f.mtimeMs}`);
            }

            if (jsonlFiles.length > 0) {
                outputChannel.appendLine(`[DEBUG] Selected latest by mtime: ${jsonlFiles[0].path}`);
                return jsonlFiles[0].path;
            }
        } catch (error) {
            outputChannel.appendLine(`[DEBUG] Error reading projects dir: ${error}`);
        }
    }

    outputChannel.appendLine(`[DEBUG] No transcript file found`);
    return null;
}

function parseTranscriptLine(data: any) {
    outputChannel.appendLine(`Parsing: type=${data.type}`);

    // 解析 assistant 消息（包含模型信息和 token 使用）
    if (data.type === 'assistant' && data.message) {
        const msg = data.message;

        // 解析模型信息
        if (msg.model) {
            currentState.model = msg.model;
            outputChannel.appendLine(`Found model: ${msg.model}`);
        }

        // 解析 token 使用情况
        if (msg.usage) {
            const usage = msg.usage;
            const inputTokens = usage.input_tokens || 0;
            const cacheReadTokens = usage.cache_read_input_tokens || 0;
            const cacheCreateTokens = usage.cache_creation_input_tokens || 0;
            const totalTokens = inputTokens + cacheReadTokens + cacheCreateTokens;

            // 动态获取上下文窗口大小
            const contextWindowSize = getContextWindowSize(currentState.model);

            currentState.contextUsed = totalTokens;
            currentState.contextTotal = contextWindowSize;
            currentState.contextPercent = Math.round((totalTokens / contextWindowSize) * 100);

            // 只在有实际 token 数据时才更新 displayContext
            // 生成内容过程中可能出现 usage 存在但 token 为 0 的情况，此时不应覆盖已有数据
            if (totalTokens > 0) {
                displayContext = {
                    percent: currentState.contextPercent,
                    used: currentState.contextUsed,
                    total: currentState.contextTotal
                };
            } else {
                outputChannel.appendLine(`[DEBUG] Skipped displayContext update: totalTokens=0 (keeping previous displayContext)`);
            }

            // 更新精度统计
            precisionStats.lastTokenCount = totalTokens;
            precisionStats.lastContextPercent = currentState.contextPercent;

            outputChannel.appendLine(`Tokens: input=${inputTokens}, cache_read=${cacheReadTokens}, total=${totalTokens}, percent=${currentState.contextPercent}%`);
            outputChannel.appendLine(`Context window: ${contextWindowSize} (model: ${currentState.model})`);
        }
    }

    // 解析工具使用
    if (data.type === 'tool_use' || (data.type === 'assistant' && data.message?.content)) {
        const content = data.message?.content;
        if (Array.isArray(content)) {
            for (const block of content) {
                if (block.type === 'tool_use') {
                    const tool: ToolEntry = {
                        name: block.name || 'unknown',
                        status: 'running',
                        startTime: new Date(data.timestamp || Date.now()),
                        file: block.input?.file_path || block.input?.command
                    };
                    currentState.tools.push(tool);
                    outputChannel.appendLine(`Tool: ${block.name}`);
                }
            }
        }
    }

    // 解析工具结果
    if (data.type === 'user' && data.message?.content) {
        const content = data.message.content;
        if (Array.isArray(content)) {
            for (const block of content) {
                if (block.type === 'tool_result') {
                    // 标记工具为完成状态
                    const lastTool = currentState.tools[currentState.tools.length - 1];
                    if (lastTool && lastTool.status === 'running') {
                        lastTool.status = block.is_error ? 'error' : 'completed';
                        lastTool.endTime = new Date(data.timestamp || Date.now());
                    }
                }
            }
        }
    }

    // 解析 Agent 状态
    if (data.type === 'agent') {
        const agent: AgentEntry = {
            name: data.name || 'agent',
            status: data.status || 'running',
            startTime: new Date(data.timestamp || Date.now()),
            duration: data.duration
        };
        currentState.agents.push(agent);
        outputChannel.appendLine(`Agent: ${data.name}`);
    }

    // 解析 Todo
    if (data.type === 'todo') {
        currentState.todos = data.items || [];
        outputChannel.appendLine(`Todos: ${data.items?.length || 0} items`);
    }

    // 解析 Git 状态
    if (data.git?.branch) {
        currentState.gitBranch = data.git.branch;
        outputChannel.appendLine(`Git branch: ${data.git.branch}`);
    }

    // 限制数组大小
    if (currentState.tools.length > 10) {
        currentState.tools = currentState.tools.slice(-10);
    }
    if (currentState.agents.length > 5) {
        currentState.agents = currentState.agents.slice(-5);
    }
}

export function deactivate() {
    if (updateTimer) {
        clearInterval(updateTimer);
    }
    if (statusBarItem) {
        statusBarItem.dispose();
    }
    if (outputChannel) {
        outputChannel.dispose();
    }
}
