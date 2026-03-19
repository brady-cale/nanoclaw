#!/usr/bin/env npx tsx
/**
 * Tries multiple approaches to find/create a usable self-chat in Teams.
 */
import { graphGet, graphPost } from './m365-auth.js';

const me = await graphGet<{ id: string; displayName: string }>('/me');
console.log(`My user ID: ${me.id} (${me.displayName})\n`);

// Approach 1: Check beta API for self-chat
console.log('--- Approach 1: Beta API ---');
try {
  const beta = await graphGet<{ value: any[] }>(
    '/me/chats?$top=50&$expand=members',
    true, // use beta
  );
  for (const chat of beta.value) {
    const memberIds =
      chat.members?.map((m: any) => m.userId).filter(Boolean) || [];
    const unique = [...new Set(memberIds)];
    if (unique.length <= 1) {
      console.log(
        `  Found: ${chat.chatType} "${chat.topic || '(no topic)'}" — ID: ${chat.id}`,
      );
    }
  }
} catch (err: any) {
  console.log(`  Beta API error: ${err.message}`);
}

// Approach 2: Try sending a message to yourself to create a chat
console.log('\n--- Approach 2: Create chat by sending message ---');
try {
  const chat = await graphPost<any>('/chats', {
    chatType: 'oneOnOne',
    members: [
      {
        '@odata.type': '#microsoft.graph.aadUserConversationMember',
        roles: ['owner'],
        'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${me.id}')`,
      },
    ],
  });
  console.log(`  Created oneOnOne with single member: ${chat.id}`);
} catch (err: any) {
  console.log(`  Single-member oneOnOne: ${err.body || err.message}`);
}

// Approach 3: Try the /me/chats/getAllMessages endpoint
console.log('\n--- Approach 3: Check for special chat types ---');
try {
  const result = await graphGet<{ value: any[] }>('/me/chats?$top=50');
  const types = new Set(result.value.map((c: any) => c.chatType));
  console.log(`  Chat types found: ${[...types].join(', ')}`);

  // Look for any chat type we haven't seen
  for (const chat of result.value) {
    if (!['oneOnOne', 'group', 'meeting'].includes(chat.chatType)) {
      console.log(
        `  Unusual type: ${chat.chatType} "${chat.topic || '(no topic)'}" — ID: ${chat.id}`,
      );
    }
  }
} catch (err: any) {
  console.log(`  Error: ${err.message}`);
}
