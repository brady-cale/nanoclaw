#!/usr/bin/env npx tsx
/**
 * Ensures a private "{FirstLast}Assistant" group chat exists in Teams.
 * Derives the name from the user's email (e.g. cedric.bru@tereina.com → CedricBruAssistant).
 * Adds teri.reina@tereina.com as a member so the mobile app allows sending messages.
 * Creates the chat if it doesn't exist, then prints the chat ID.
 */
import { graphGet, graphPost } from './m365-auth.js';

const COMPANION_EMAIL = 'teri.reina@tereina.com';

interface TeamsChat {
  id: string;
  chatType: string;
  topic: string | null;
}

interface GraphUser {
  id: string;
  displayName: string;
  mail: string | null;
  userPrincipalName: string;
}

// Get the current user's info to derive the chat topic
const me = await graphGet<GraphUser>('/me');

// Derive chat name from email: first.last@domain → FirstLastAssistant
const email = me.mail || me.userPrincipalName;
const localPart = email.split('@')[0]; // e.g. "cedric.bru"
const chatTopic =
  localPart
    .split('.')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('') + 'Assistant';

console.log(`Chat topic for this user: ${chatTopic}`);

// Check if a chat with this topic already exists
const result = await graphGet<{ value: TeamsChat[] }>('/me/chats?$top=50');

const existing = result.value.find(
  (c) => c.topic?.toLowerCase() === chatTopic.toLowerCase(),
);

if (existing) {
  console.log(`Found existing "${chatTopic}" chat: ${existing.id}`);
  process.exit(0);
}

// Look up the companion user's ID
let companionId: string;
try {
  const companion = await graphGet<GraphUser>(
    `/users/${COMPANION_EMAIL}`,
  );
  companionId = companion.id;
} catch (err) {
  console.error(
    `Failed to look up companion user ${COMPANION_EMAIL}:`,
    err,
  );
  process.exit(1);
}

// Create a new group chat with the current user and the companion
const newChat = await graphPost<TeamsChat>('/chats', {
  chatType: 'group',
  topic: chatTopic,
  members: [
    {
      '@odata.type': '#microsoft.graph.aadUserConversationMember',
      roles: ['owner'],
      'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${me.id}')`,
    },
    {
      '@odata.type': '#microsoft.graph.aadUserConversationMember',
      roles: ['guest'],
      'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${companionId}')`,
    },
  ],
});

console.log(`Created "${chatTopic}" chat: ${newChat.id}`);
