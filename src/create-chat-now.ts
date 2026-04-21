#!/usr/bin/env npx tsx
import { graphGet, graphPost } from './m365-auth.js';

interface GraphUser {
  id: string;
  displayName: string;
  mail: string | null;
  userPrincipalName: string;
}
interface TeamsChat {
  id: string;
  chatType: string;
  topic: string | null;
}

const me = await graphGet<GraphUser>('/me');
const email = me.mail || me.userPrincipalName;
const localPart = email.split('@')[0];
const chatTopic =
  localPart
    .split('.')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join('') + 'Assistant';

console.log(`Creating chat: ${chatTopic}`);

const newChat = await graphPost<TeamsChat>('/chats', {
  chatType: 'group',
  topic: chatTopic,
  members: [
    {
      '@odata.type': '#microsoft.graph.aadUserConversationMember',
      roles: ['owner'],
      'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${me.id}')`,
    },
  ],
});

console.log(`Created "${chatTopic}" chat: ${newChat.id}`);
