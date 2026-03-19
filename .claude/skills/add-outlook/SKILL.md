---
name: add-outlook
description: Add Outlook email integration. Routes emails by alias to dedicated agent groups. Replies sent as the alias. Uses device code flow for auth.
---

# Add Microsoft Outlook Email Integration

Adds Outlook email as an event source to NanoClaw. Polls your inbox for new emails, routes them by recipient alias to dedicated agent groups, and sends replies using the alias.

Your NanoClaw agent acts **as you** — it reads and sends emails using your Microsoft 365 account via the Graph API with delegated permissions. The agent only has access to what you can already see in your mailbox.

## Prerequisites

- A Microsoft 365 account with a mailbox (the one you use for Outlook)
- If you already set up `/add-teams`, you can reuse the same app registration — just add mail permissions

## Setup Steps

### 1. Check Dependencies

```bash
npm ls @azure/msal-node @microsoft/microsoft-graph-client 2>/dev/null || npm install @azure/msal-node @microsoft/microsoft-graph-client
```

### 2. Authorize Graph API Access

NanoClaw uses a registered app in your Microsoft 365 tenant to access the Graph API on your behalf. Someone in your organization needs to set this up once — after that, everyone else just needs the Tenant ID and Client ID.

AskUserQuestion: Has someone in your organization already set up the NanoClaw app registration?

**If yes — and you already have Teams set up (most users):**

The app already exists. Check if mail permissions are already included. If not, a tenant admin needs to add them:
1. Go to https://portal.azure.com → search "App registrations" → click the NanoClaw app
2. Go to **API permissions** → check if `Mail.ReadWrite`, `Mail.Send`, `MailboxFolder.ReadWrite` are listed
3. If missing, click **Add a permission** → **Microsoft Graph** → **Delegated permissions** → add them
4. Click **Grant admin consent** (or ask your admin)

Then skip to the credentials prompt below.

**If yes — but you don't have Teams set up:**

Ask your admin or the person who set it up for the **Tenant ID** and **Client ID**. That's all you need — skip to the credentials prompt below.

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
   - `Mail.ReadWrite`
   - `Mail.Send`
   - `MailboxFolder.ReadWrite`
   - `User.Read`
10. Click **Grant admin consent** (requires tenant admin — if you're not the admin, ask them to approve it)
11. Share the Tenant ID and Client ID with others in your org who want to use NanoClaw

AskUserQuestion: Please provide your Graph API credentials (skip if already in .env from Teams setup):
- Tenant ID
- Client ID

### 3. Write Credentials to .env

Add to `.env` (if not already present from Teams setup):
```
M365_TENANT_ID=<tenant-id>
M365_CLIENT_ID=<client-id>
```

### 4. Sign In via Device Code

If not already signed in (from Teams setup), run:

```bash
npx tsx src/m365-device-auth.ts
```

You'll see a URL and a code — open the URL in your browser, enter the code, and sign in with your Microsoft 365 account. This is a one-time step; tokens are cached and auto-refresh.

### 5. Choose Outlook Mode

AskUserQuestion: How should Outlook email routing work?
- **Alias-only** — Only process emails sent to specific alias addresses (e.g., myagent@company.com). Other emails are ignored.
- **All emails** — Process all inbox emails. Alias emails route to their dedicated agent groups; other emails go to a default group.

Add to `.env`:
```
M365_OUTLOOK_MODE=alias   # or "all"
M365_OUTLOOK_POLL_INTERVAL=60000
```

### 6. Configure Aliases

AskUserQuestion: What email aliases should map to agent groups?

Format: `alias@domain.com:group-folder-name`

Examples:
- `support@company.com:outlook-support` — support emails handled by a support agent
- `scheduling@company.com:outlook-scheduling` — scheduling requests handled by a scheduling agent

For each alias, the system will:
- Create a mail subfolder `NanoClaw - {group-folder}` in Outlook
- Register a NanoClaw group with that folder name
- Route matching emails to that group's agent
- Send replies using that alias as the From address

Add to `.env`:
```
M365_OUTLOOK_ALIASES=alias1@company.com:group-folder1,alias2@company.com:group-folder2
```

If mode is "all", also configure:
```
M365_OUTLOOK_DEFAULT_GROUP=email-default
```

### 7. Register Installed Tools

Create `groups/global/installed-tools/outlook.md` with tool documentation:

```markdown
# Outlook (email)

- **`mcp__nanoclaw__search_emails`** — Search Outlook emails in real-time via Microsoft Graph API. Supports `query` (free-text), `from`, `subject`, `after`/`before` (ISO dates), and `top` (max results, default 20, max 50).
- **`mcp__nanoclaw__draft_outlook_email`** — Save a draft email reply in Outlook. NEVER send emails directly — always draft. Requires `from_alias`, `to`, `subject`, `body`, and optionally `in_reply_to` and `conversation_id` for threading.
```

This directory is NOT tracked in git — it's local to each install. Agents discover available tools by reading files in `/workspace/global/installed-tools/`.

### 8. Create Group CLAUDE.md Files

For each alias group, create `groups/{folder}/CLAUDE.md` with group-specific instructions (identity, rules, formatting). Example:

```markdown
# Outlook Agent — {alias}

You handle emails sent to {alias}. You are an email agent with access to the email thread context.

## Available Tools

Check `/workspace/global/installed-tools/` for all available MCP tools — read files there to see what's installed.

## Rules

- Always reply professionally
- Use the `mcp__nanoclaw__draft_outlook_email` tool to draft replies — NEVER send directly
- Include the `from_alias`, `to`, `subject`, `in_reply_to`, and `conversation_id` fields
- Keep {alias} as the sender for all draft emails

## Your Identity

You are replying as {alias}. Maintain consistent tone and formatting.
```

### 9. Build and Start the Orchestrator

Build the project and the MyAssistantOrchestrator app (if not already installed from Teams setup). This is the shared service that runs Teams, Outlook, and any future integrations.

```bash
npm run build
bash app/build.sh && open app/build/MyAssistantOrchestrator.app
```

If the orchestrator is already running, click Restart in the app window to pick up the Outlook changes.

Verify:
1. Check `logs/nanoclaw.log` for "Starting Outlook email loop"
2. Send a test email to an alias
3. Confirm it appears in the agent's group folder
4. Confirm the email is marked as read and moved to the `NanoClaw - {folder}` subfolder

## Troubleshooting

- **"No M365 access token available"**: Your sign-in token expired. Re-run the device code sign-in (step 4).
- **403 on mail endpoints**: The mail permissions haven't been approved. Check the app's API permissions in https://portal.azure.com and ensure admin consent was granted.
- **Emails not being picked up**: Check `M365_OUTLOOK_MODE` and `M365_OUTLOOK_ALIASES` in `.env`. Restart after changes.
- **Replies not sent as alias**: The mailbox must be configured in Exchange to allow sending from the alias. Check your org's send-as/send-on-behalf settings.
