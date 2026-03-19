#!/usr/bin/env npx tsx
import { graphGet } from './m365-auth.js';

const result = await graphGet<{
  value: Array<{ chatType: string; topic: string | null; id: string }>;
}>('/me/chats?$top=20');
for (const chat of result.value) {
  console.log(
    `${chat.chatType}: ${chat.topic || '(no topic)'} — ID: ${chat.id}`,
  );
}
