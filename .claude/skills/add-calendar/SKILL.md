---
name: add-calendar
description: Add M365 Calendar integration. View, search, create, and update calendar events with optional Teams meeting links.
---

# Add Microsoft 365 Calendar Integration

Adds calendar capabilities to NanoClaw agents. Agents can search events, create new ones (with or without Teams meeting links), and update existing events — including adding attendees.

This is a tool-only integration — no polling or local storage. Agents call calendar tools on demand via IPC.

## Prerequisites

- A Microsoft 365 account with a calendar
- M365 credentials already configured (from `/add-teams` or `/add-outlook`)

## Setup Steps

### 1. Check M365 Credentials

Verify credentials exist in `.env`:
```bash
grep -q M365_TENANT_ID .env && grep -q M365_CLIENT_ID .env && echo "M365 credentials found" || echo "Missing M365 credentials — run /add-teams or /add-outlook first"
```

If missing, run `/add-teams` or `/add-outlook` first to set up the base M365 integration.

### 2. Add Calendar Permission

A tenant admin needs to add the `Calendars.ReadWrite` delegated permission to the NanoClaw app registration:

1. Go to https://portal.azure.com → search "App registrations" → click the NanoClaw app
2. Go to **API permissions** → check if `Calendars.ReadWrite` is listed
3. If missing, click **Add a permission** → **Microsoft Graph** → **Delegated permissions** → add `Calendars.ReadWrite`
4. Click **Grant admin consent** (or ask your admin)

### 3. Re-authenticate

The new scope requires a fresh token. Re-run the device code auth:

```bash
npx tsx src/m365-device-auth.ts
```

Sign in again when prompted. This picks up the new `Calendars.ReadWrite` scope.

### 4. Register Calendar Tools

Create the tool documentation file so agents know about the calendar tools:

```bash
mkdir -p groups/global/installed-tools
```

Create `groups/global/installed-tools/calendar.md`:

```markdown
### Calendar (M365)

- **`mcp__nanoclaw__search_calendar`** — Search calendar events by date range. Params: `after` (required, ISO date), `before` (required, ISO date), `query` (optional, filter by subject), `attendee` (optional, filter by email), `top` (optional, max 50). Returns event ID, subject, time, location, attendees, Teams link.
- **`mcp__nanoclaw__create_calendar_event`** — Create a new calendar event. Params: `subject` (required), `start` (required, local time), `end` (required, local time), `attendees` (optional, email array — they'll receive invites), `body` (optional), `location` (optional), `is_teams_meeting` (optional, creates Teams link), `is_all_day` (optional).
- **`mcp__nanoclaw__update_calendar_event`** — Update an existing event by ID. Params: `event_id` (required, from search results), plus any fields to change: `subject`, `start`, `end`, `attendees` (full replacement list — include existing + new), `body`, `location`, `is_teams_meeting`.
```

### 5. Build and Restart

```bash
npm run build
./container/build.sh
```

Restart the orchestrator to pick up the new scope:
- macOS: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
- Or click Restart in the MyAssistant Orchestrator app

### 6. Verify

Test in your Teams or WhatsApp chat:
- "What's on my calendar this week?"
- "Create a meeting with alice@company.com tomorrow at 2pm for 30 minutes with a Teams link"
- "Add bob@company.com to that meeting"

## Troubleshooting

- **"Insufficient privileges"**: The `Calendars.ReadWrite` permission hasn't been approved. Check the app's API permissions in Azure Portal and ensure admin consent was granted.
- **"No M365 access token"**: Re-run device code auth (step 3).
- **Events not found**: Check that the date range is correct. `search_calendar` requires both `after` and `before`.
- **Attendees not receiving invites**: Verify the email addresses are valid M365 or external accounts. Check your org's external sharing settings.
