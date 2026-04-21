#!/usr/bin/env npx tsx
/**
 * Manually send a message to a specific Teams chat as the authenticated user.
 * Useful for one-off notifications or to test the Graph connection.
 *
 * Usage:
 *   npx tsx src/send-teams-msg.ts <chat-id> <message...>
 *
 * The chat ID looks like "19:abc...@thread.v2" — find it with
 * `npx tsx src/m365-list-chats.ts` or via `/me/chats` in Graph Explorer.
 */
import { graphPost } from './m365-auth.js';

const [chatId, ...messageParts] = process.argv.slice(2);
const content = messageParts.join(' ');

if (!chatId || !content) {
  console.error('Usage: send-teams-msg <chat-id> <message>');
  process.exit(1);
}

await graphPost(`/me/chats/${chatId}/messages`, {
  body: { contentType: 'text', content },
});
console.log('Message sent.');
