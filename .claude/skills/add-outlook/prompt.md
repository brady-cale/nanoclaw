# Add Microsoft Outlook Email Integration

Adds Outlook email as an event source to NanoClaw. Polls inbox for new emails, routes them by recipient alias to dedicated agent groups, and sends replies using the alias.

## Prerequisites

- Microsoft 365 account with mailbox
- Azure AD app registration with delegated permissions (can reuse the same app as Teams)

## Setup Steps

### 1. Check Dependencies

```bash
npm ls @azure/msal-node @microsoft/microsoft-graph-client 2>/dev/null || npm install @azure/msal-node @microsoft/microsoft-graph-client
```

### 2. Azure AD App Registration

AskUserQuestion: Do you already have an Azure AD app registration for NanoClaw (e.g., from Teams setup)?

**If no**, guide the user through creating one (same as Teams skill step 2), with these additional permissions:
- `Mail.ReadWrite`
- `Mail.Send`
- `MailboxFolder.ReadWrite`
- `User.Read`

**If yes**, add the additional mail permissions:
1. Go to Azure Portal → App registrations → your NanoClaw app → API permissions
2. Add: `Mail.ReadWrite`, `Mail.Send`, `MailboxFolder.ReadWrite`
3. Grant admin consent

AskUserQuestion: Please provide your Azure AD credentials (skip if already in .env):
- Tenant ID
- Client ID

### 3. Write Credentials to .env

Add to `.env` (if not already present from Teams setup):
```
M365_TENANT_ID=<tenant-id>
M365_CLIENT_ID=<client-id>
```

### 4. Authenticate via Device Code

If not already authenticated (from Teams setup), run:

```bash
npx tsx -e "
import { acquireTokenWithDeviceCode } from './src/m365-auth.js';
const token = await acquireTokenWithDeviceCode();
if (token) console.log('✓ Authentication successful');
else { console.error('✗ Authentication failed'); process.exit(1); }
"
```

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

- **"No cached M365 token"**: Re-run device code auth (step 4).
- **403 on mail endpoints**: Check Mail.ReadWrite and Mail.Send permissions + admin consent.
- **Emails not being picked up**: Check `M365_OUTLOOK_MODE` and `M365_OUTLOOK_ALIASES` in `.env`. Restart after changes.
- **Replies not sent as alias**: The mailbox must be configured in Exchange to allow sending from the alias. Check your org's send-as/send-on-behalf settings.
