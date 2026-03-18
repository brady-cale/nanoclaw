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

To let NanoClaw access the Graph API on your behalf, you need to register it as an app in your Microsoft 365 tenant. This does NOT create a new organization — it just creates an OAuth client ID within your existing account, like creating a Google OAuth client.

AskUserQuestion: Do you already have a Microsoft Graph API app registration (Client ID + Tenant ID) for NanoClaw? (e.g., from Teams setup)

**If yes**, add the mail permissions to your existing app:
1. Go to https://portal.azure.com → search "App registrations" → click your NanoClaw app
2. Go to **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**
3. Add: `Mail.ReadWrite`, `Mail.Send`, `MailboxFolder.ReadWrite`
4. Click **Grant admin consent** (or ask your admin)

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
   - `Mail.ReadWrite`
   - `Mail.Send`
   - `MailboxFolder.ReadWrite`
   - `User.Read`
10. If you're a tenant admin, click **Grant admin consent**. If not, ask your admin to approve it.

AskUserQuestion: Please provide your Graph API credentials (skip if already in .env from Teams setup):
- Tenant ID (Directory ID from the app overview page)
- Client ID (Application ID from the app overview page)

### 3. Write Credentials to .env

Add to `.env` (if not already present from Teams setup):
```
M365_TENANT_ID=<tenant-id>
M365_CLIENT_ID=<client-id>
```

### 4. Sign In via Device Code

If not already signed in (from Teams setup), run:

```bash
npx tsx -e "
import { acquireTokenWithDeviceCode } from './src/m365-auth.js';
const token = await acquireTokenWithDeviceCode();
if (token) console.log('✓ Authentication successful');
else { console.error('✗ Authentication failed'); process.exit(1); }
"
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

### 7. Create Group CLAUDE.md Files

For each alias group, create `groups/{folder}/CLAUDE.md` with instructions for that agent. Example:

```markdown
# Outlook Agent — {alias}

You handle emails sent to {alias}. You are an email agent with access to the email thread context.

## Rules

- Always reply professionally
- Use the `send_outlook_email` IPC command to reply
- Include the `from_alias`, `to`, `subject`, `in_reply_to`, and `conversation_id` fields
- Keep the user's alias ({alias}) as the sender for all outbound emails

## Your Identity

You are replying as {alias}. Maintain consistent tone and formatting.
```

### 8. Build and Verify

```bash
npm run build
```

Tell the user to restart NanoClaw and send a test email to one of their configured aliases.

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
