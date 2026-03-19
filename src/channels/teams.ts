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
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private connected = false;
  private selfUserId: string | null = null;
  private lastPollTime: Record<string, string> = {};
  private userNameCache = new Map<string, string>();
  private mode: 'discover' | 'registered';
  private pollMs: number;
  private assistantName: string;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
    const env = readEnvFile(['M365_TEAMS_MODE', 'M365_TEAMS_POLL_INTERVAL']);
    this.mode =
      env.M365_TEAMS_MODE === 'registered' ? 'registered' : 'discover';
    this.pollMs = parseInt(env.M365_TEAMS_POLL_INTERVAL || '15000', 10);
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

      // Start polling
      this.pollInterval = setInterval(() => {
        this.poll().catch((err) => logger.error({ err }, 'Teams poll error'));
      }, this.pollMs);

      // Initial poll
      await this.poll();
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
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
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

  private async poll(): Promise<void> {
    if (!this.connected) return;

    try {
      let chats: TeamsChat[];

      if (this.mode === 'registered') {
        // Only poll chats that are registered as NanoClaw groups
        const groups = this.opts.registeredGroups();
        const registeredChatIds = Object.keys(groups)
          .filter((jid) => jid.startsWith(JID_PREFIX))
          .map((jid) => fromJid(jid));

        if (registeredChatIds.length === 0) return;

        // Fetch each registered chat individually
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

      for (const chat of chats) {
        await this.pollChat(chat);
      }
    } catch (err) {
      logger.error({ err }, 'Teams poll cycle error');
    }
  }

  private async pollChat(chat: TeamsChat): Promise<void> {
    const jid = toJid(chat.id);
    const since = this.lastPollTime[chat.id];

    // Fetch recent messages (Graph API doesn't support $filter on createdDateTime for chat messages)
    const url = `/me/chats/${chat.id}/messages?$top=20&$orderby=createdDateTime desc`;

    let messages: TeamsMessage[];
    try {
      const result = await graphGet<{ value: TeamsMessage[] }>(url);
      messages = result.value || [];
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 403) {
        logger.debug({ chatId: chat.id }, 'Skipping Teams chat (not a member)');
      } else {
        logger.warn({ chatId: chat.id, err }, 'Failed to fetch Teams messages');
      }
      return;
    }

    // Filter client-side to only process messages newer than last poll
    if (since) {
      messages = messages.filter((m) => m.createdDateTime > since);
    }

    // Process in chronological order (oldest first)
    messages.reverse();

    for (const msg of messages) {
      // Skip system messages
      if (msg.messageType !== 'message') continue;

      const isFromMe = msg.from?.user?.id === this.selfUserId;

      const senderId =
        msg.from?.user?.id || msg.from?.application?.id || 'unknown';
      const senderName =
        msg.from?.user?.displayName ||
        msg.from?.application?.displayName ||
        'Unknown';

      // Cache sender name
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

      this.opts.onChatMetadata(
        jid,
        msg.createdDateTime,
        chat.topic || `Teams ${chat.chatType} chat`,
        'teams',
        chat.chatType !== 'oneOnOne',
      );
      this.opts.onMessage(jid, newMsg);
    }

    // Update poll cursor
    if (messages.length > 0) {
      const latest = messages[messages.length - 1].createdDateTime;
      if (!since || latest > since) {
        this.lastPollTime[chat.id] = latest;
      }
    } else if (!since) {
      // First poll with no messages — set cursor to now
      this.lastPollTime[chat.id] = new Date().toISOString();
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
