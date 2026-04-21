#!/usr/bin/env npx tsx
import { graphGet } from './m365-auth.js';

const result = await graphGet<{
  value: Array<{
    subject: string;
    toRecipients: Array<{ emailAddress: { address: string } }>;
    internetMessageHeaders?: Array<{ name: string; value: string }>;
  }>;
}>(
  '/me/mailFolders/inbox/messages?$top=3&$orderby=receivedDateTime desc&$select=subject,internetMessageHeaders,toRecipients',
);

for (const msg of result.value) {
  console.log('\n=== Subject:', msg.subject);
  console.log(
    'toRecipients:',
    msg.toRecipients.map((r) => r.emailAddress.address),
  );
  const headers = msg.internetMessageHeaders || [];
  for (const h of headers) {
    const name = h.name.toLowerCase();
    if (
      name.includes('to') ||
      name.includes('deliver') ||
      name.includes('recipient') ||
      name.includes('envelope') ||
      name.includes('original') ||
      name.includes('x-ms')
    ) {
      console.log(`  ${h.name}: ${h.value}`);
    }
  }
}
