/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'node:fs';
import path from 'node:path';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'node:url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private readonly queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function extractMessageText(entry: { type: string; message?: { content?: unknown } }): ParsedMessage | null {
  const content = entry.message?.content;
  if (!content) return null;

  if (entry.type === 'user') {
    const text = typeof content === 'string'
      ? content
      : (content as { text?: string }[]).map(c => c.text || '').join('');
    return text ? { role: 'user', content: text } : null;
  }

  if (entry.type === 'assistant') {
    const text = (content as { type: string; text: string }[])
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('');
    return text ? { role: 'assistant', content: text } : null;
  }

  return null;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = extractMessageText(JSON.parse(line));
      if (parsed) messages.push(parsed);
    } catch { /* skip malformed lines */ }
  }
  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [
    `# ${title || 'Conversation'}`,
    '',
    `Archived: ${formatDateTime(now)}`,
    '',
    '---',
    '',
  ];

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

type ToolUseBlock = { type: string; name?: string; input?: Record<string, unknown> };
type AssistantMessageLike = { message?: { content?: ToolUseBlock[] } };

/** Log tool use details — especially web calls and browser actions. */
function logToolUseDetails(msg: AssistantMessageLike): void {
  for (const block of msg.message?.content || []) {
    if (block.type !== 'tool_use' || !block.name || !block.input) continue;
    const inp = (key: string) => String(block.input![key] ?? '');
    switch (block.name) {
      case 'WebSearch':
        log(`[tool] WebSearch query="${inp('query')}"`);
        break;
      case 'WebFetch':
        log(`[tool] WebFetch url="${inp('url')}"`);
        break;
      case 'Bash': {
        const cmd = inp('command');
        log(cmd.startsWith('agent-browser')
          ? `[tool] Bash agent-browser: ${cmd}`
          : `[tool] Bash: ${cmd.slice(0, 200)}`);
        break;
      }
      default:
        log(`[tool] ${block.name}`);
    }
  }
}

/** Build MCP server config from environment. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildMcpServers(mcpServerPath: string, containerInput: ContainerInput): any {
  const servers: Record<string, unknown> = {
    nanoclaw: {
      command: 'node',
      args: [mcpServerPath],
      env: {
        NANOCLAW_CHAT_JID: containerInput.chatJid,
        NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
        NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
      },
    },
  };
  if (process.env.ATLASSIAN_BASE_URL) {
    servers.atlassian = {
      command: 'node',
      args: ['/app/node_modules/mcp-atlassian/dist/index.js'],
      env: {
        ATLASSIAN_BASE_URL: process.env.ATLASSIAN_BASE_URL,
        ATLASSIAN_EMAIL: process.env.ATLASSIAN_EMAIL || '',
        ATLASSIAN_API_TOKEN: process.env.ATLASSIAN_API_TOKEN || '',
      },
    };
  }
  if (process.env.GITHUB_TOKEN) {
    servers.github = {
      type: 'http' as const,
      url: 'https://api.githubcopilot.com/mcp',
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
    };
  }
  return servers;
}

/** Discover extra directories mounted at /workspace/extra/* */
function discoverExtraDirs(): string[] {
  const extraBase = '/workspace/extra';
  if (!fs.existsSync(extraBase)) return [];
  const dirs = fs.readdirSync(extraBase)
    .map(entry => path.join(extraBase, entry))
    .filter(fullPath => fs.statSync(fullPath).isDirectory());
  if (dirs.length > 0) log(`Additional directories: ${dirs.join(', ')}`);
  return dirs;
}

/** Load global CLAUDE.md content if it exists. */
function loadGlobalClaudeMd(): string | undefined {
  const p = '/workspace/global/CLAUDE.md';
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : undefined;
}

const ALLOWED_TOOLS = [
  'Bash',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'ToolSearch', 'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
  'mcp__atlassian__*',
  // GitHub: read-only (no push, merge, create, delete, write)
  'mcp__github__get_me',
  'mcp__github__search_code',
  'mcp__github__search_repositories',
  'mcp__github__search_issues',
  'mcp__github__search_pull_requests',
  'mcp__github__search_users',
  'mcp__github__get_file_contents',
  'mcp__github__list_commits',
  'mcp__github__get_commit',
  'mcp__github__list_branches',
  'mcp__github__list_pull_requests',
  'mcp__github__pull_request_read',
  'mcp__github__list_issues',
  'mcp__github__issue_read',
  'mcp__github__list_releases',
  'mcp__github__get_latest_release',
  'mcp__github__get_release_by_tag',
  'mcp__github__list_tags',
  'mcp__github__get_tag',
  'mcp__github__get_teams',
  'mcp__github__get_team_members',
  'mcp__github__get_label',
  'mcp__github__get_copilot_job_status',
];

type QueryState = { newSessionId: string | undefined; lastAssistantUuid: string | undefined };

/** Build SDK query options. */
function buildQueryOptions(
  sessionId: string | undefined,
  resumeAt: string | undefined,
  globalClaudeMd: string | undefined,
  extraDirs: string[],
  sdkEnv: Record<string, string | undefined>,
  mcpServerPath: string,
  containerInput: ContainerInput,
) {
  return {
    cwd: '/workspace/group',
    additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
    resume: sessionId,
    resumeSessionAt: resumeAt,
    systemPrompt: globalClaudeMd
      ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
      : undefined,
    allowedTools: ALLOWED_TOOLS,
    env: sdkEnv,
    permissionMode: 'bypassPermissions' as const,
    allowDangerouslySkipPermissions: true,
    settingSources: ['project' as const, 'user' as const],
    mcpServers: buildMcpServers(mcpServerPath, containerInput),
    hooks: {
      PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
    },
  };
}

/** Process a single SDK message, updating state and emitting output as needed. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleMessage(message: any, state: QueryState): void {
  if (message.type === 'assistant' && 'uuid' in message) {
    state.lastAssistantUuid = message.uuid;
  }
  if (message.type === 'assistant' && 'message' in message) {
    logToolUseDetails(message as AssistantMessageLike);
  }
  if (message.type === 'system' && message.subtype === 'init') {
    state.newSessionId = message.session_id;
    log(`Session initialized: ${state.newSessionId}`);
  }
  if (message.type === 'system' && message.subtype === 'task_notification') {
    log(`Task notification: task=${message.task_id} status=${message.status} summary=${message.summary}`);
  }
  if (message.type === 'result') {
    const textResult = 'result' in message ? message.result : null;
    const preview = textResult ? ' text=' + String(textResult).slice(0, 200) : '';
    log(`Result: subtype=${message.subtype}${preview}`);
    writeOutput({ status: 'success', result: textResult || null, newSessionId: state.newSessionId });
  }
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  const state = { newSessionId: undefined as string | undefined, lastAssistantUuid: undefined as string | undefined };
  let messageCount = 0;

  const globalClaudeMd = loadGlobalClaudeMd();
  const extraDirs = discoverExtraDirs();

  const queryOptions = buildQueryOptions(
    sessionId, resumeAt, globalClaudeMd, extraDirs, sdkEnv,
    mcpServerPath, containerInput,
  );

  for await (const message of query({ prompt: stream, options: queryOptions })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);
    handleMessage(message, state);
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, lastAssistantUuid: ${state.lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId: state.newSessionId, lastAssistantUuid: state.lastAssistantUuid, closedDuringQuery };
}

/** Query loop: run query → wait for IPC message → run new query → repeat. */
async function runQueryLoop(
  initialPrompt: string,
  initialSessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
): Promise<void> {
  let prompt = initialPrompt;
  let sessionId = initialSessionId;
  let resumeAt: string | undefined;

  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const result = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);
      if (result.newSessionId) sessionId = result.newSessionId;
      if (result.lastAssistantUuid) resumeAt = result.lastAssistantUuid;

      if (result.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      writeOutput({ status: 'success', result: null, newSessionId: sessionId });
      log('Query ended, waiting for next IPC message...');

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({ status: 'error', result: null, newSessionId: sessionId, error: errorMessage });
    process.exit(1);
  }
}

async function run(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  await runQueryLoop(prompt, sessionId, mcpServerPath, containerInput, sdkEnv);
}

await run();
