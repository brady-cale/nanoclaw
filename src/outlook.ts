import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  hasM365Credentials,
  graphGet,
  graphPost,
  graphPatch,
} from './m365-auth.js';
import { ASSISTANT_NAME, TIMEZONE } from './config.js';
import { NewMessage, RegisteredGroup } from './types.js';

// --- Types ---

interface OutlookMessage {
  id: string;
  conversationId: string;
  internetMessageId: string;
  subject: string;
  bodyPreview: string;
  body: { contentType: string; content: string };
  from: { emailAddress: { name: string; address: string } };
  toRecipients: Array<{ emailAddress: { name: string; address: string } }>;
  ccRecipients: Array<{ emailAddress: { name: string; address: string } }>;
  receivedDateTime: string;
  isRead: boolean;
  parentFolderId: string;
}

interface MailFolder {
  id: string;
  displayName: string;
}

interface AliasMapping {
  alias: string;
  groupFolder: string;
}

interface OutlookLoopOpts {
  storeMessage: (msg: NewMessage) => void;
  storeChatMetadata: (
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ) => void;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
  runEmailAgent: (
    groupFolder: string,
    chatJid: string,
    prompt: string,
  ) => Promise<string | null>;
  sendToMainChannel: (text: string) => Promise<void>;
  // DB accessors for email thread tracking
  getEmailThread: (threadId: string) => EmailThread | undefined;
  upsertEmailThread: (thread: EmailThread) => void;
}

export interface EmailThread {
  thread_id: string;
  alias: string;
  group_folder: string;
  subject: string | null;
  last_message_id: string | null;
  created_at: string;
}

// --- Alias config parsing ---

function parseAliases(): AliasMapping[] {
  const env = readEnvFile(['M365_OUTLOOK_ALIASES']);
  const raw = env.M365_OUTLOOK_ALIASES;
  if (!raw) return [];

  return raw
    .split(',')
    .map((entry) => {
      const [alias, groupFolder] = entry.trim().split(':');
      return { alias: alias.toLowerCase(), groupFolder };
    })
    .filter((m) => m.alias && m.groupFolder);
}

function getOutlookMode(): 'alias' | 'all' {
  const env = readEnvFile(['M365_OUTLOOK_MODE']);
  return env.M365_OUTLOOK_MODE === 'all' ? 'all' : 'alias';
}

function getDefaultGroup(): string {
  const env = readEnvFile(['M365_OUTLOOK_DEFAULT_GROUP']);
  return env.M365_OUTLOOK_DEFAULT_GROUP || 'email-default';
}

function getPollInterval(): number {
  const env = readEnvFile(['M365_OUTLOOK_POLL_INTERVAL']);
  return parseInt(env.M365_OUTLOOK_POLL_INTERVAL || '60000', 10);
}

// --- JID helpers ---

function outlookJid(alias: string): string {
  return `outlook:${alias.toLowerCase()}`;
}

function defaultOutlookJid(): string {
  return 'outlook:default';
}

// --- Subfolder management ---

const folderIdCache = new Map<string, string>();

async function ensureMailFolder(displayName: string): Promise<string> {
  const cached = folderIdCache.get(displayName);
  if (cached) return cached;

  // Check if folder exists
  try {
    const result = await graphGet<{ value: MailFolder[] }>(
      `/me/mailFolders?$filter=displayName eq '${displayName}'`,
    );
    if (result.value?.length > 0) {
      folderIdCache.set(displayName, result.value[0].id);
      return result.value[0].id;
    }
  } catch (err) {
    logger.warn({ displayName, err }, 'Failed to check mail folder');
  }

  // Create folder
  try {
    const folder = await graphPost<MailFolder>('/me/mailFolders', {
      displayName,
    });
    folderIdCache.set(displayName, folder.id);
    logger.info({ displayName }, 'Created Outlook mail folder');
    return folder.id;
  } catch (err) {
    logger.error({ displayName, err }, 'Failed to create mail folder');
    throw err;
  }
}

async function moveToFolder(
  messageId: string,
  folderId: string,
): Promise<void> {
  try {
    await graphPost(`/me/messages/${messageId}/move`, {
      destinationId: folderId,
    });
  } catch (err) {
    logger.warn({ messageId, folderId, err }, 'Failed to move email to folder');
  }
}

async function markAsRead(messageId: string): Promise<void> {
  try {
    await graphPatch(`/me/messages/${messageId}`, { isRead: true });
  } catch (err) {
    logger.warn({ messageId, err }, 'Failed to mark email as read');
  }
}

// --- Email classification ---

function classifyByAlias(
  msg: OutlookMessage,
  aliases: AliasMapping[],
): AliasMapping | null {
  const allRecipients = [
    ...msg.toRecipients.map((r) => r.emailAddress.address.toLowerCase()),
    ...msg.ccRecipients.map((r) => r.emailAddress.address.toLowerCase()),
  ];

  for (const mapping of aliases) {
    if (allRecipients.includes(mapping.alias)) {
      return mapping;
    }
  }
  return null;
}

// --- Email content formatting ---

function stripHtmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function formatEmailAsPrompt(
  msg: OutlookMessage,
  alias: string,
  threadMessages?: OutlookMessage[],
): string {
  const lines: string[] = [];

  // Thread history
  if (threadMessages && threadMessages.length > 0) {
    lines.push('## Email Thread History (oldest first)\n');
    for (let i = 0; i < threadMessages.length; i++) {
      const tm = threadMessages[i];
      const body =
        tm.body.contentType === 'html'
          ? stripHtmlToText(tm.body.content)
          : tm.body.content;
      lines.push(
        `[${i + 1}] From: ${tm.from.emailAddress.name} <${tm.from.emailAddress.address}> | Date: ${tm.receivedDateTime}`,
      );
      lines.push(body.slice(0, 2000));
      lines.push('');
    }
    lines.push('---\n');
  }

  lines.push('## New Email\n');
  lines.push(
    `- From: ${msg.from.emailAddress.name} <${msg.from.emailAddress.address}>`,
  );
  lines.push(
    `- To: ${msg.toRecipients.map((r) => `${r.emailAddress.name} <${r.emailAddress.address}>`).join(', ')}`,
  );
  if (msg.ccRecipients.length > 0) {
    lines.push(
      `- CC: ${msg.ccRecipients.map((r) => `${r.emailAddress.name} <${r.emailAddress.address}>`).join(', ')}`,
    );
  }
  lines.push(`- Subject: ${msg.subject}`);
  lines.push(`- Date: ${msg.receivedDateTime}`);
  lines.push(`- Message-ID: ${msg.internetMessageId}`);
  lines.push(`- Your alias: ${alias}`);
  lines.push('');

  const body =
    msg.body.contentType === 'html'
      ? stripHtmlToText(msg.body.content)
      : msg.body.content;
  lines.push(body.slice(0, 5000));

  // Reply instructions
  lines.push('\n---');
  lines.push(
    `To reply to this email, use the send_outlook_email IPC command with:`,
  );
  lines.push(`- from_alias: ${alias}`);
  lines.push(`- to: ${msg.from.emailAddress.address}`);
  const ccAddrs = [...msg.toRecipients, ...msg.ccRecipients]
    .map((r) => r.emailAddress.address)
    .filter(
      (a) =>
        a.toLowerCase() !== alias.toLowerCase() &&
        a.toLowerCase() !== msg.from.emailAddress.address.toLowerCase(),
    );
  if (ccAddrs.length > 0) {
    lines.push(`- cc: ${ccAddrs.join(', ')}`);
  }
  lines.push(`- subject: Re: ${msg.subject.replace(/^Re:\s*/i, '')}`);
  lines.push(`- in_reply_to: ${msg.internetMessageId}`);
  lines.push(`- conversation_id: ${msg.conversationId}`);

  return lines.join('\n');
}

// --- Outbound email ---

export async function sendOutlookEmail(params: {
  fromAlias: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  conversationId?: string;
}): Promise<void> {
  const message: Record<string, unknown> = {
    subject: params.subject,
    body: { contentType: 'text', content: params.body },
    from: {
      emailAddress: { address: params.fromAlias },
    },
    toRecipients: params.to.map((addr) => ({
      emailAddress: { address: addr },
    })),
  };

  if (params.cc?.length) {
    message.ccRecipients = params.cc.map((addr) => ({
      emailAddress: { address: addr },
    }));
  }

  if (params.inReplyTo) {
    message.internetMessageHeaders = [
      { name: 'In-Reply-To', value: params.inReplyTo },
    ];
  }

  if (params.conversationId) {
    message.conversationId = params.conversationId;
  }

  await graphPost('/me/sendMail', {
    message,
    saveToSentItems: true,
  });

  logger.info(
    { from: params.fromAlias, to: params.to, subject: params.subject },
    'Sent Outlook email',
  );
}

// --- Main polling loop ---

export async function startOutlookLoop(opts: OutlookLoopOpts): Promise<void> {
  if (!hasM365Credentials()) {
    logger.debug('M365 credentials not configured, skipping Outlook loop');
    return;
  }

  const aliases = parseAliases();
  const mode = getOutlookMode();
  const defaultGroup = getDefaultGroup();
  const pollMs = getPollInterval();

  if (mode === 'alias' && aliases.length === 0) {
    logger.warn(
      'M365_OUTLOOK_MODE=alias but no aliases configured (M365_OUTLOOK_ALIASES). Skipping Outlook loop.',
    );
    return;
  }

  // Ensure mail subfolders exist for each alias
  for (const mapping of aliases) {
    const folderName = `NanoClaw - ${mapping.groupFolder}`;
    try {
      await ensureMailFolder(folderName);
    } catch {
      // Non-fatal — emails will still be processed, just not moved
    }
  }

  // Register system groups for each alias
  for (const mapping of aliases) {
    const jid = outlookJid(mapping.alias);
    const existing = opts.registeredGroups();
    if (!existing[jid]) {
      opts.registerGroup(jid, {
        name: `Outlook ${mapping.alias}`,
        folder: mapping.groupFolder,
        trigger: 'all',
        added_at: new Date().toISOString(),
        requiresTrigger: false,
      });
    }
  }

  // Register default group if mode=all
  if (mode === 'all') {
    const jid = defaultOutlookJid();
    const existing = opts.registeredGroups();
    if (!existing[jid]) {
      opts.registerGroup(jid, {
        name: 'Outlook Default',
        folder: defaultGroup,
        trigger: 'all',
        added_at: new Date().toISOString(),
        requiresTrigger: false,
      });
    }
  }

  logger.info(
    {
      mode,
      aliasCount: aliases.length,
      pollMs,
      aliases: aliases.map((a) => a.alias),
    },
    'Starting Outlook email loop',
  );

  // Set to track processed message IDs (prevents reprocessing within a session)
  const processedIds = new Set<string>();

  async function pollInbox(): Promise<void> {
    try {
      const result = await graphGet<{ value: OutlookMessage[] }>(
        '/me/mailFolders/inbox/messages?$filter=isRead eq false&$top=50&$orderby=receivedDateTime asc&$select=id,conversationId,internetMessageId,subject,bodyPreview,body,from,toRecipients,ccRecipients,receivedDateTime,isRead,parentFolderId',
      );

      const messages = result.value || [];

      for (const msg of messages) {
        if (processedIds.has(msg.id)) continue;

        // Classify by alias
        const aliasMatch = classifyByAlias(msg, aliases);

        if (!aliasMatch && mode === 'alias') {
          // Not addressed to any configured alias, skip
          continue;
        }

        const targetAlias = aliasMatch?.alias || 'default';
        const targetFolder = aliasMatch?.groupFolder || defaultGroup;
        const chatJid = aliasMatch
          ? outlookJid(aliasMatch.alias)
          : defaultOutlookJid();

        // Check/update thread tracking
        let thread = opts.getEmailThread(msg.conversationId);
        if (!thread) {
          thread = {
            thread_id: msg.conversationId,
            alias: targetAlias,
            group_folder: targetFolder,
            subject: msg.subject,
            last_message_id: msg.internetMessageId,
            created_at: new Date().toISOString(),
          };
          opts.upsertEmailThread(thread);
        } else {
          // Use existing thread's routing (thread continuity)
          thread.last_message_id = msg.internetMessageId;
          opts.upsertEmailThread(thread);
        }

        // Fetch thread context
        let threadMessages: OutlookMessage[] = [];
        try {
          const threadResult = await graphGet<{ value: OutlookMessage[] }>(
            `/me/messages?$filter=conversationId eq '${msg.conversationId}'&$orderby=receivedDateTime asc&$top=20&$select=id,body,from,toRecipients,ccRecipients,receivedDateTime,internetMessageId`,
          );
          // Exclude the current message from thread history
          threadMessages = (threadResult.value || []).filter(
            (tm) => tm.id !== msg.id,
          );
        } catch (err) {
          logger.warn(
            { conversationId: msg.conversationId, err },
            'Failed to fetch email thread',
          );
        }

        // Build prompt
        const prompt = formatEmailAsPrompt(msg, targetAlias, threadMessages);

        // Store as message in DB
        const storedMsg: NewMessage = {
          id: msg.id,
          chat_jid: chatJid,
          sender: msg.from.emailAddress.address,
          sender_name: msg.from.emailAddress.name,
          content: `[Email] ${msg.subject}\n\n${msg.bodyPreview}`,
          timestamp: msg.receivedDateTime,
          is_from_me: false,
          is_bot_message: false,
        };
        opts.storeMessage(storedMsg);
        opts.storeChatMetadata(
          chatJid,
          msg.receivedDateTime,
          `Outlook ${targetAlias}`,
          'outlook',
          false,
        );

        // Run agent with fresh session
        try {
          const agentResult = await opts.runEmailAgent(
            targetFolder,
            chatJid,
            prompt,
          );

          // Forward output to main channel
          if (agentResult) {
            const summary = `[Outlook → ${targetAlias}] ${msg.subject}\n${agentResult}`;
            await opts.sendToMainChannel(summary);
          }

          // Mark processed + read + move to subfolder
          processedIds.add(msg.id);
          await markAsRead(msg.id);

          if (aliasMatch) {
            const folderName = `NanoClaw - ${aliasMatch.groupFolder}`;
            const folderId = folderIdCache.get(folderName);
            if (folderId) {
              await moveToFolder(msg.id, folderId);
            }
          }
        } catch (err) {
          logger.error(
            {
              messageId: msg.id,
              subject: msg.subject,
              err,
            },
            'Failed to process email — leaving unread for retry',
          );
          // Don't mark as processed — will retry next cycle
        }
      }
    } catch (err) {
      logger.error({ err }, 'Outlook inbox poll error');
    }
  }

  // Initial poll
  await pollInbox();

  // Recurring poll
  setInterval(() => {
    pollInbox().catch((err) =>
      logger.error({ err }, 'Outlook poll cycle error'),
    );
  }, pollMs);
}
