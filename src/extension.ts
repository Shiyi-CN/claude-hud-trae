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
let lastWorkspacePath: string | null = null;  // 保存上一次的工作区路径

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
const MODEL_CONTEXT_WINDOWS: { [key: string]: number } = {
    'opus': 200000,
    'sonnet': 200000,
    'haiku': 100000,
    'claude-3-opus': 200000,
    'claude-3-sonnet': 200000,
    'claude-3-haiku': 100000,
    'claude-3-5-sonnet': 200000,
    'claude-3-5-haiku': 100000,
    'mimo-v2.5-pro': 200000,
    'mimo-v2.5': 200000,
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

    // 监听工作区变化（窗口切换时）
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => {
            const currentWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
            if (currentWorkspace && currentWorkspace !== lastWorkspacePath) {
                outputChannel.appendLine(`Workspace changed: ${lastWorkspacePath} -> ${currentWorkspace}`);
                lastWorkspacePath = currentWorkspace;
                // 重置增量读取状态
                lastLineCount = 0;
                lastTranscriptPath = null;
                lastFileModified = 0;
                // 立即更新状态栏
                updateStatusBar();
            }
        })
    );

    // 加载配置
    loadConfig();

    // 初始化工作区路径
    lastWorkspacePath = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || null;

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
        // 检查工作区是否变化（窗口切换检测）
        const currentWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
        if (currentWorkspace && currentWorkspace !== lastWorkspacePath) {
            outputChannel.appendLine(`Workspace changed: ${lastWorkspacePath} -> ${currentWorkspace}`);
            lastWorkspacePath = currentWorkspace;
            // 重置增量读取状态
            lastLineCount = 0;
            lastTranscriptPath = null;
            lastFileModified = 0;
        }

        // 读取 transcript 文件
        const hasNewData = await readTranscript();

        // 如果没有新数据，保持当前显示不变
        if (!hasNewData) {
            return;
        }

        // 构建状态栏文本
        const parts: string[] = [];

        // 模型信息
        if (currentState.model && currentState.model !== 'Unknown') {
            parts.push(`[${currentState.model}]`);
        }

        // 上下文使用率
        if (config.showContextBar && currentState.contextTotal > 0) {
            const bar = formatContextBar(currentState.contextPercent);
            parts.push(`${bar} ${currentState.contextPercent}%`);
        }

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

        // 更新状态栏（只有有内容时才更新）
        const newText = parts.join(' │ ');
        if (newText) {
            statusBarItem.text = newText;
            lastStatusBarText = newText;
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
    // Claude Code 的 transcript 文件路径
    const homeDir = os.homedir();

    // 获取当前工作目录并编码
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd();
    const encodedCwd = cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-+|-+$/g, '');

    // 获取当前会话 ID
    const sessionId = findSessionId();

    // 可能的路径
    const possiblePaths = [
        // 基于会话 ID 的路径（最可能）
        path.join(homeDir, '.claude', 'projects', encodedCwd, `${sessionId}.jsonl`),
        // 其他可能的路径
        path.join(homeDir, '.claude', 'projects', encodedCwd, 'latest.jsonl'),
        path.join(homeDir, '.claude', 'transcripts', 'latest.jsonl'),
        path.join(homeDir, '.config', 'claude', 'transcripts', 'latest.jsonl'),
    ];

    // 添加调试信息
    outputChannel.appendLine(`Searching for transcript in:`);
    outputChannel.appendLine(`  CWD: ${cwd}`);
    outputChannel.appendLine(`  Encoded CWD: ${encodedCwd}`);
    outputChannel.appendLine(`  Session ID: ${sessionId}`);

    for (const p of possiblePaths) {
        const exists = fs.existsSync(p);
        outputChannel.appendLine(`  ${p} - ${exists ? 'EXISTS' : 'not found'}`);
        if (exists) {
            outputChannel.appendLine(`Found transcript: ${p}`);
            return p;
        }
    }

    // 尝试查找最新的 transcript 文件
    const projectsDir = path.join(homeDir, '.claude', 'projects', encodedCwd);
    if (fs.existsSync(projectsDir)) {
        outputChannel.appendLine(`Checking projects directory: ${projectsDir}`);
        try {
            const files = fs.readdirSync(projectsDir)
                .filter(f => f.endsWith('.jsonl') && !f.includes('subagents'))
                .map(f => ({
                    name: f,
                    time: fs.statSync(path.join(projectsDir, f)).mtimeMs
                }))
                .sort((a, b) => b.time - a.time);
            if (files.length > 0) {
                const latest = path.join(projectsDir, files[0].name);
                outputChannel.appendLine(`Found latest transcript: ${latest}`);
                return latest;
            }
        } catch (error) {
            outputChannel.appendLine(`Error reading projects dir: ${error}`);
        }
    }

    outputChannel.appendLine(`No transcript file found`);
    return null;
}

function findSessionId(): string | null {
    // 从 sessions 目录查找当前会话 ID
    const homeDir = os.homedir();
    const sessionsDir = path.join(homeDir, '.claude', 'sessions');

    if (!fs.existsSync(sessionsDir)) {
        return null;
    }

    try {
        const files = fs.readdirSync(sessionsDir)
            .filter(f => f.endsWith('.json'))
            .map(f => ({
                name: f,
                content: fs.readFileSync(path.join(sessionsDir, f), 'utf-8'),
                time: fs.statSync(path.join(sessionsDir, f)).mtimeMs
            }))
            .sort((a, b) => b.time - a.time);

        if (files.length > 0) {
            const sessionData = JSON.parse(files[0].content);
            return sessionData.sessionId || null;
        }
    } catch (error) {
        outputChannel.appendLine(`Error reading sessions dir: ${error}`);
    }

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
