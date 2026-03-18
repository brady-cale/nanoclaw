---
name: add-teams
description: Add Microsoft Teams as a channel. Polls DMs and team channels via Graph API. Uses device code flow for auth.
---

# Add Microsoft Teams Channel

Adds Teams as a messaging channel to NanoClaw. Polls Teams chats (DMs and group/channel conversations) via Microsoft Graph API.

Your NanoClaw agent will act **as you** — it reads and sends Teams messages using your Microsoft 365 account. This uses delegated permissions (device code flow), so the agent only has access to what you can already see.

## Prerequisites

- A Microsoft 365 account (the one you use for Teams)

## Setup Steps

### 1. Check Dependencies

```bash
npm ls @azure/msal-node @microsoft/microsoft-graph-client 2>/dev/null || npm install @azure/msal-node @microsoft/microsoft-graph-client
```

### 2. Authorize Graph API Access

To let NanoClaw access the Graph API on your behalf, you need to register it as an app in your Microsoft 365 tenant. This does NOT create a new organization — it just creates an OAuth client ID within your existing account, similar to creating a Google OAuth client.

AskUserQuestion: Do you already have a Microsoft Graph API app registration (Client ID + Tenant ID) for NanoClaw?

**If no**, guide the user through creating one:

1. Sign in to https://portal.azure.com with your normal Microsoft 365 account
2. Search for "App registrations" in the top search bar → click it
3. Click **New registration**
4. Name: `NanoClaw` (or whatever you prefer)
5. Supported account types: "Accounts in this organizational directory only"
6. Redirect URI: leave blank (we use device code flow)
7. Click **Register**
8. On the app's overview page, copy the **Application (client) ID** and **Directory (tenant) ID**
9. Go to **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**:
   - `Chat.ReadWrite`
   - `ChannelMessage.Read.All`
   - `ChannelMessage.Send`
   - `User.Read`
10. If you're a tenant admin, click **Grant admin consent**. If not, ask your admin to approve it.

AskUserQuestion: Please provide your Graph API credentials:
- Tenant ID (Directory ID from the app overview page)
- Client ID (Application ID from the app overview page)

### 3. Write Credentials to .env

Add to `.env`:
```
M365_TENANT_ID=<tenant-id>
M365_CLIENT_ID=<client-id>
```

### 4. Sign In via Device Code

This step signs you in so NanoClaw can act as you. Run:

```bash
npx tsx -e "
import { acquireTokenWithDeviceCode } from './src/m365-auth.js';
const token = await acquireTokenWithDeviceCode();
if (token) console.log('✓ Authentication successful');
else { console.error('✗ Authentication failed'); process.exit(1); }
"
```

You'll see a URL and a code — open the URL in your browser, enter the code, and sign in with your Microsoft 365 account. This is a one-time step; tokens are cached and auto-refresh.

### 5. Choose Teams Mode

AskUserQuestion: How should Teams polling work?
- **Discover all chats** — automatically poll all Teams chats you participate in
- **Registered only** — only poll chats explicitly registered as NanoClaw groups

Add to `.env`:
```
M365_TEAMS_MODE=discover   # or "registered"
M365_TEAMS_POLL_INTERVAL=15000
```

### 6. Register Main Teams Chat

AskUserQuestion: Which Teams chat should be the main channel? (This is where admin commands and notifications go)

Help the user identify the chat ID. Run:
```bash
npx tsx -e "
import { graphGet } from './src/m365-auth.js';
const result = await graphGet('/me/chats?\$top=20&\$orderby=lastUpdatedDateTime desc');
for (const chat of result.value) {
  console.log(\`\${chat.chatType}: \${chat.topic || '(no topic)'} — ID: \${chat.id}\`);
}
"
```

Register the chosen chat as the main group using the standard NanoClaw group registration.

### 7. Create Group CLAUDE.md

Create `groups/{folder}/CLAUDE.md` with default Teams agent instructions. Follow the pattern from `groups/main/CLAUDE.md` but adapt for Teams formatting (Teams supports markdown).

### 8. Build and Verify

```bash
npm run build
```

Tell the user to restart NanoClaw and send a test message in their Teams chat.

## Troubleshooting

- **"No M365 access token available"**: Your sign-in token expired. Re-run the device code sign-in (step 4).
- **403 Forbidden on chat messages**: The API permissions haven't been approved. Check the app's API permissions in https://portal.azure.com and ensure admin consent was granted.
- **Messages not appearing**: Check `M365_TEAMS_MODE` — if `registered`, the chat must be registered as a NanoClaw group.
