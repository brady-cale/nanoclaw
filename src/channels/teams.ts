import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { hasM365Credentials, graphGet, graphPost } from '../m365-auth.js';
import { Channel, NewMessage } from '../types.js';

import { ChannelOpts, registerChannel } from './registry.js';

const JID_PREFIX = 'teams:';

/** Convert simple markdown to Teams-compatible HTML */
function markdownToTeamsHtml(md: string): string {
  let html = md
    // Escape HTML entities first
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Code blocks (``` ... ```) — must come before inline code
    .replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Bold (**text** or __text__)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/__(.+?)__/g, '<b>$1</b>')
    // Italic (*text* or _text_) — careful not to match inside bold
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<i>$1</i>')
    .replace(/(?<!_)_([^_]+)_(?!_)/g, '<i>$1</i>')
    // Bullet lists (- item or • item)
    .replace(/^[\-•]\s+(.+)$/gm, '<li>$1</li>')
    // Newlines to <br>
    .replace(/\n/g, '<br>');

  // Wrap consecutive <li> in <ul>
  html = html.replace(/((?:<li>.*?<\/li>(?:<br>)?)+)/g, (match) => {
    const cleaned = match.replace(/<br>/g, '');
    return `<ul>${cleaned}</ul>`;
  });

  // Remove --- horizontal rules (Teams doesn't render them)
  html = html.replace(/(?:<br>)?-{3,}(?:<br>)?/g, '<br>');

  return html;
}

interface TeamsMessage {
  id: string;
  createdDateTime: string;
  body: { contentType: string; content: string };
  from?: {
    user?: { id: string; displayName: string };
    application?: { id: string; displayName: string };
  };
  messageType: string;
  // Channel messages may have replyToId for threaded replies
  replyToId?: string;
  channelIdentity?: {
    teamId: string;
    channelId: string;
  };
}

interface TeamsChat {
  id: string;
  chatType: 'oneOnOne' | 'group' | 'meeting';
  topic: string | null;
  lastUpdatedDateTime: string;
}

interface DeltaResponse {
  value: TeamsMessage[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

function toJid(chatId: string): string {
  return `${JID_PREFIX}${chatId}`;
}

function fromJid(jid: string): string {
  return jid.slice(JID_PREFIX.length);
}

/** Strip HTML tags from Teams message content */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

class TeamsChannel implements Channel {
  name = 'teams';
  private opts: ChannelOpts;
  private mainPollInterval: ReturnType<typeof setInterval> | null = null;
  private slowPollInterval: ReturnType<typeof setInterval> | null = null;
  private connected = false;
  private selfUserId: string | null = null;
  private deltaLinks: Record<string, string> = {}; // chatId -> deltaLink URL
  private userNameCache = new Map<string, string>();
  private mode: 'discover' | 'registered';
  private assistantName: string;
  private mainChatId: string | null = null;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
    const env = readEnvFile(['M365_TEAMS_MODE']);
    this.mode =
      env.M365_TEAMS_MODE === 'registered' ? 'registered' : 'discover';
    this.assistantName = ASSISTANT_NAME;
  }

  async connect(): Promise<void> {
    try {
      // Verify authentication and get our own user ID
      const me = await graphGet<{ id: string; displayName: string }>('/me');
      this.selfUserId = me.id;
      logger.info(
        { userId: me.id, displayName: me.displayName, mode: this.mode },
        'Teams channel connected',
      );
      this.connected = true;

      // Identify the main chat
      const groups = this.opts.registeredGroups();
      for (const [jid, group] of Object.entries(groups)) {
        if (jid.startsWith(JID_PREFIX) && group.isMain) {
          this.mainChatId = fromJid(jid);
          break;
        }
      }

      // Prime delta tokens for all known chats
      await this.primeAllDeltas();

      // Fast poll: main chat only (5s)
      this.mainPollInterval = setInterval(() => {
        this.pollMain().catch((err) =>
          logger.error({ err }, 'Teams main poll error'),
        );
      }, 5000);

      // Slow poll: chat discovery + all other chats (30s)
      this.slowPollInterval = setInterval(() => {
        this.pollOthers().catch((err) =>
          logger.error({ err }, 'Teams slow poll error'),
        );
      }, 30000);
    } catch (err) {
      logger.error({ err }, 'Teams channel failed to connect');
      throw err;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = fromJid(jid);
    const html = markdownToTeamsHtml(text);
    const prefixed = `🤖 <b>${this.assistantName}:</b> ${html}`;
    await graphPost(`/me/chats/${chatId}/messages`, {
      body: { contentType: 'html', content: prefixed },
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    if (this.mainPollInterval) {
      clearInterval(this.mainPollInterval);
      this.mainPollInterval = null;
    }
    if (this.slowPollInterval) {
      clearInterval(this.slowPollInterval);
      this.slowPollInterval = null;
    }
    this.connected = false;
    logger.info('Teams channel disconnected');
  }

  async syncGroups(force: boolean): Promise<void> {
    try {
      const chats = await this.listChats();
      for (const chat of chats) {
        const jid = toJid(chat.id);
        const name = chat.topic || `Teams ${chat.chatType} chat`;
        const isGroup = chat.chatType !== 'oneOnOne';
        this.opts.onChatMetadata(
          jid,
          chat.lastUpdatedDateTime,
          name,
          'teams',
          isGroup,
        );
      }
    } catch (err) {
      logger.error({ err }, 'Teams syncGroups error');
    }
  }

  private async listChats(): Promise<TeamsChat[]> {
    const result = await graphGet<{ value: TeamsChat[] }>('/me/chats?$top=50');
    return result.value || [];
  }

  /** Prime delta tokens for all known chats without processing messages */
  private async primeAllDeltas(): Promise<void> {
    try {
      let chatIds: string[];

      if (this.mode === 'registered') {
        const groups = this.opts.registeredGroups();
        chatIds = Object.keys(groups)
          .filter((jid) => jid.startsWith(JID_PREFIX))
          .map((jid) => fromJid(jid));
      } else {
        const chats = await this.listChats();
        chatIds = chats.map((c) => c.id);
      }

      for (const chatId of chatIds) {
        await this.primeDelta(chatId);
      }

      logger.info(
        { chatCount: chatIds.length },
        'Delta sync initialized for all chats',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to prime delta tokens');
    }
  }

  /** Fetch all delta pages for a chat to get the initial delta token (skip processing) */
  private async primeDelta(chatId: string): Promise<void> {
    try {
      let url: string | null = `/me/chats/${chatId}/messages/delta`;
      while (url) {
        const result: DeltaResponse = await graphGet(url);

        if (result['@odata.deltaLink']) {
          this.deltaLinks[chatId] = result['@odata.deltaLink'];
          url = null;
        } else if (result['@odata.nextLink']) {
          url = result['@odata.nextLink'];
        } else {
          url = null;
        }
      }
      logger.debug({ chatId }, 'Delta token primed');
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode;
      const message = (err as { message?: string }).message || '';
      if (status === 403) {
        logger.debug({ chatId }, 'Skipping delta prime (not a member)');
      } else if (status === 400 && message.includes('Change tracking is not supported')) {
        logger.debug({ chatId }, 'Skipping delta prime (change tracking not supported)');
      } else {
        logger.warn({ chatId, err }, 'Failed to prime delta token');
      }
    }
  }

  /** Poll main chat only — runs every 5s */
  private async pollMain(): Promise<void> {
    if (!this.connected || !this.mainChatId) return;
    try {
      await this.pollChatDelta(this.mainChatId);
    } catch (err) {
      logger.error({ err }, 'Teams main poll error');
    }
  }

  /** Chat discovery + poll all non-main chats — runs every 30s */
  private async pollOthers(): Promise<void> {
    if (!this.connected) return;

    try {
      let chats: TeamsChat[];

      if (this.mode === 'registered') {
        const groups = this.opts.registeredGroups();
        const registeredChatIds = Object.keys(groups)
          .filter((jid) => jid.startsWith(JID_PREFIX))
          .map((jid) => fromJid(jid));

        if (registeredChatIds.length === 0) return;

        chats = [];
        for (const chatId of registeredChatIds) {
          try {
            const chat = await graphGet<TeamsChat>(`/me/chats/${chatId}`);
            chats.push(chat);
          } catch (err) {
            logger.warn(
              { chatId, err },
              'Failed to fetch registered Teams chat',
            );
          }
        }
      } else {
        chats = await this.listChats();
      }

      // Sync metadata for all chats
      for (const chat of chats) {
        this.opts.onChatMetadata(
          toJid(chat.id),
          chat.lastUpdatedDateTime,
          chat.topic || `Teams ${chat.chatType} chat`,
          'teams',
          chat.chatType !== 'oneOnOne',
        );
      }

      // Poll non-main chats with throttling
      for (const chat of chats) {
        if (chat.id === this.mainChatId) continue;

        // Prime new chats on first encounter
        if (!this.deltaLinks[chat.id]) {
          await this.primeDelta(chat.id);
          continue; // Skip processing on prime cycle
        }

        await this.pollChatDelta(chat.id);

        // 100ms delay between chats to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (err) {
      logger.error({ err }, 'Teams slow poll cycle error');
    }
  }

  /** Poll a single chat using its delta token, falling back to standard polling */
  private async pollChatDelta(chatId: string): Promise<void> {
    const deltaLink = this.deltaLinks[chatId];
    if (!deltaLink) {
      // Delta not available for this chat — fall back to standard polling
      await this.pollChatStandard(chatId);
      return;
    }

    const jid = toJid(chatId);
    let allMessages: TeamsMessage[] = [];

    try {
      let url: string | null = deltaLink;
      while (url) {
        const result: DeltaResponse = await graphGet(url);

        if (result.value) {
          allMessages = allMessages.concat(result.value);
        }

        if (result['@odata.deltaLink']) {
          this.deltaLinks[chatId] = result['@odata.deltaLink'];
          url = null;
        } else if (result['@odata.nextLink']) {
          url = result['@odata.nextLink'];
        } else {
          url = null;
        }
      }
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        // Delta token expired — re-prime on next cycle
        logger.info({ chatId }, 'Delta token expired, will re-prime');
        delete this.deltaLinks[chatId];
        return;
      }
      if (status === 403) {
        logger.debug({ chatId }, 'Skipping Teams chat (not a member)');
        return;
      }
      const message = (err as { message?: string }).message || '';
      if (status === 400 && message.includes('Change tracking is not supported')) {
        // Meeting chats don't support delta — silently skip
        return;
      }
      logger.warn({ chatId, err }, 'Failed to fetch Teams delta messages');
      return;
    }

    // Process messages (already only new ones thanks to delta)
    for (const msg of allMessages) {
      if (msg.messageType !== 'message') continue;

      const isFromMe = msg.from?.user?.id === this.selfUserId;

      const senderId =
        msg.from?.user?.id || msg.from?.application?.id || 'unknown';
      const senderName =
        msg.from?.user?.displayName ||
        msg.from?.application?.displayName ||
        'Unknown';

      if (msg.from?.user?.id) {
        this.userNameCache.set(msg.from.user.id, senderName);
      }

      const content =
        msg.body.contentType === 'html'
          ? stripHtml(msg.body.content)
          : msg.body.content;

      if (!content) continue;

      const newMsg: NewMessage = {
        id: msg.id,
        chat_jid: jid,
        sender: senderId,
        sender_name: senderName,
        content,
        timestamp: msg.createdDateTime,
        is_from_me: isFromMe,
        is_bot_message: false,
      };

      this.opts.onMessage(jid, newMsg);
    }
  }
  /** Fallback polling for chats where delta is unavailable */
  private lastPollTime: Record<string, string> = {};

  private async pollChatStandard(chatId: string): Promise<void> {
    const jid = toJid(chatId);
    const since = this.lastPollTime[chatId];

    const url = `/me/chats/${chatId}/messages?$top=20&$orderby=createdDateTime desc`;

    let messages: TeamsMessage[];
    try {
      const result = await graphGet<{ value: TeamsMessage[] }>(url);
      messages = result.value || [];
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 403) {
        logger.debug({ chatId }, 'Skipping Teams chat (not a member)');
      } else {
        logger.warn({ chatId, err }, 'Failed to fetch Teams messages');
      }
      return;
    }

    // Filter to only new messages
    if (since) {
      messages = messages.filter((m) => m.createdDateTime > since);
    }

    // Process oldest first
    messages.reverse();

    for (const msg of messages) {
      if (msg.messageType !== 'message') continue;

      const isFromMe = msg.from?.user?.id === this.selfUserId;

      const senderId =
        msg.from?.user?.id || msg.from?.application?.id || 'unknown';
      const senderName =
        msg.from?.user?.displayName ||
        msg.from?.application?.displayName ||
        'Unknown';

      if (msg.from?.user?.id) {
        this.userNameCache.set(msg.from.user.id, senderName);
      }

      const content =
        msg.body.contentType === 'html'
          ? stripHtml(msg.body.content)
          : msg.body.content;

      if (!content) continue;

      const newMsg: NewMessage = {
        id: msg.id,
        chat_jid: jid,
        sender: senderId,
        sender_name: senderName,
        content,
        timestamp: msg.createdDateTime,
        is_from_me: isFromMe,
        is_bot_message: false,
      };

      this.opts.onMessage(jid, newMsg);
    }

    // Update poll cursor
    if (messages.length > 0) {
      const latest = messages[messages.length - 1].createdDateTime;
      if (!since || latest > since) {
        this.lastPollTime[chatId] = latest;
      }
    } else if (!since) {
      this.lastPollTime[chatId] = new Date().toISOString();
    }
  }
}

function teamsChannelFactory(opts: ChannelOpts): Channel | null {
  if (!hasM365Credentials()) {
    return null;
  }

  // Check that Teams-specific mode is configured (implies user wants Teams)
  const env = readEnvFile(['M365_TEAMS_MODE']);
  if (!env.M365_TEAMS_MODE) {
    // M365 creds present but Teams not explicitly enabled
    // Still create the channel — it will connect if auth works
  }

  return new TeamsChannel(opts);
}

registerChannel('teams', teamsChannelFactory);
