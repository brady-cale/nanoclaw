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

NanoClaw uses a registered app in your Microsoft 365 tenant to access the Graph API on your behalf. Someone in your organization needs to set this up once — after that, everyone else just needs the Tenant ID and Client ID.

AskUserQuestion: Has someone in your organization already set up the NanoClaw app registration?

**If yes (most users):**

Ask them for the **Tenant ID** and **Client ID**. That's all you need — skip to the credentials prompt below.

**If no (first-time setup for your organization):**

You'll create an OAuth app registration in your tenant. This is a one-time step — other users in your org will reuse the same Client ID.

1. Sign in to https://portal.azure.com with your Microsoft 365 account
2. Search for "App registrations" in the top search bar → click it
3. Click **New registration**
4. Name: `NanoClaw` (or whatever you prefer)
5. Supported account types: **"Single tenant only"** (the one showing your tenant name)
6. Redirect URI: leave blank (we use device code flow)
7. Click **Register**
8. On the app's overview page, copy the **Application (client) ID** and **Directory (tenant) ID**
9. Go to **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**:
   - `Chat.ReadWrite`
   - `ChannelMessage.Read.All`
   - `ChannelMessage.Send`
   - `User.Read`
10. Click **Grant admin consent** (requires tenant admin — if you're not the admin, ask them to approve it)
11. Share the Tenant ID and Client ID with others in your org who want to use NanoClaw

AskUserQuestion: Please provide your Graph API credentials:
- Tenant ID
- Client ID

### 3. Write Credentials to .env

Add to `.env`:
```
M365_TENANT_ID=<tenant-id>
M365_CLIENT_ID=<client-id>
```

### 4. Sign In via Device Code

This step signs you in so NanoClaw can act as you. Each user does this with their own account. Run:

```bash
npx tsx src/m365-device-auth.ts
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

Automatically create (or find) a private assistant group chat for the user. The chat name is derived from the user's email — e.g. `cedric.bru@tereina.com` becomes `CedricBruAssistant`. The companion user `teri.reina@tereina.com` is automatically added so the Teams mobile app allows sending messages. Run:

```bash
npx tsx src/m365-ensure-main-chat.ts
```

The script prints the chat ID. Register it as the main group with JID `teams:{chatId}`, folder `teams_main`, and `isMain: true`, `requiresTrigger: false`.

### 7. Register Installed Tools (if applicable)

If Teams adds MCP tools beyond the core set (send_message, schedule_task, etc.), create `groups/global/installed-tools/teams.md` with tool documentation. If no Teams-specific tools are added, skip this step.

This directory is NOT tracked in git — it's local to each install. Agents discover available tools by reading files in `/workspace/global/installed-tools/`.

### 8. Create Group CLAUDE.md

Create `groups/{folder}/CLAUDE.md` with Teams agent instructions. Follow the pattern from `groups/main/CLAUDE.md` but adapt for Teams formatting (Teams supports markdown). Include a pointer for tool discovery:

```markdown
## Available Tools

Check `/workspace/global/installed-tools/` for all available MCP tools — read files there to see what's installed.
```

Do NOT duplicate tool documentation in the per-group file.

### 9. Build and Start the Orchestrator

Build the project and the MyAssistantOrchestrator app. This is the shared service that runs Teams, Outlook, and any future integrations.

```bash
npm run build
bash app/build.sh && open app/build/MyAssistantOrchestrator.app
```

The orchestrator appears as an app in the Dock with a claw icon. It shows service status and has Start/Stop/Restart buttons. No further setup needed — the service is now running.

Tell the user to check the Dock for the MyAssistant Orchestrator app and send a test message in their assistant Teams chat (named after their email, e.g. "CedricBruAssistant").

## Troubleshooting

- **"No M365 access token available"**: Your sign-in token expired. Re-run the device code sign-in (step 4).
- **403 Forbidden on chat messages**: The API permissions haven't been approved. Check the app's API permissions in https://portal.azure.com and ensure admin consent was granted.
- **Messages not appearing**: Check `M365_TEAMS_MODE` — if `registered`, the chat must be registered as a NanoClaw group.
