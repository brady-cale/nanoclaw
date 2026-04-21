# Teri — Main Channel (Teams)

This is the **main Teams channel** with elevated privileges. Global instructions apply here. This file adds admin-specific context and Teams formatting rules.

## Teams Formatting

Teams supports rich markdown — use it for clarity:
- **Bold** and *italic* (standard markdown asterisks)
- ## Headings, ordered/unordered lists, and tables
- `inline code` and ```code blocks``` (with language tags)
- Links: [text](url)
- Block quotes with `>`

Keep messages reasonably short — Teams truncates very long messages with a "see more" expander. For long content, lead with a one-paragraph summary and offer details on request.

When mentioning users, prefer their display name in plain text rather than trying to construct an `@mention` token; the Teams channel doesn't currently render `@mention` syntax from agent output.

---

## Admin Context

## Container Mounts

| Container Path | Host Path | Access |
|----------------|-----------|--------|
| `/workspace/project` | Project root | read-only |
| `/workspace/group` | `groups/main/` | read-write |
| `/workspace/global` | `groups/global/` | read-only |

Key paths inside the container:
- `/workspace/project/store/messages.db` — SQLite database (messages, chats, registered_groups)
- `/workspace/project/groups/` — All group folders

---

## Managing Groups

### Finding Available Groups

Available groups are provided in `/workspace/ipc/available_groups.json`:

```json
{
  "groups": [
    {
      "jid": "19:abc123def456@thread.v2",
      "name": "Engineering",
      "lastActivity": "2026-01-31T12:00:00.000Z",
      "isRegistered": false
    }
  ],
  "lastSync": "2026-01-31T12:00:00.000Z"
}
```

Groups are ordered by most recent activity. The list is synced from each configured channel (Teams, Outlook, WhatsApp, Telegram, etc.) on its own polling interval.

If a group the user mentions isn't in the list, request a fresh sync:

```bash
echo '{"type": "refresh_groups"}' > /workspace/ipc/tasks/refresh_$(date +%s).json
```

Then wait a moment and re-read `available_groups.json`.

**Fallback**: Query the SQLite database directly:

```bash
sqlite3 /workspace/project/store/messages.db "
  SELECT jid, name, channel, last_message_time
  FROM chats
  WHERE is_group = 1 AND jid != '__group_sync__'
  ORDER BY last_message_time DESC
  LIMIT 10;
"
```

### Registered Groups Config

Groups are registered in the SQLite `registered_groups` table:

```json
{
  "19:abc123def456@thread.v2": {
    "name": "Engineering",
    "folder": "teams_engineering",
    "trigger": "@Teri",
    "added_at": "2026-01-31T12:00:00.000Z"
  }
}
```

Fields:
- **Key**: The chat JID (unique identifier — Teams, Outlook, WhatsApp, Telegram, Slack, Discord, etc.)
- **name**: Display name for the group
- **folder**: Channel-prefixed folder name under `groups/` for this group's files and memory
- **trigger**: The trigger word (usually same as global, but could differ)
- **requiresTrigger**: Whether `@trigger` prefix is needed (default: `true`). Set to `false` for solo/personal chats where all messages should be processed
- **isMain**: Whether this is the main control group (elevated privileges, no trigger required)
- **added_at**: ISO timestamp when registered

### Trigger Behavior

- **Main group** (`isMain: true`): No trigger needed — all messages are processed automatically
- **Groups with `requiresTrigger: false`**: No trigger needed — all messages processed (use for 1-on-1 or solo chats)
- **Other groups** (default): Messages must start with `@AssistantName` to be processed

### Adding a Group

1. Query the database to find the group's JID
2. Use the `register_group` MCP tool with the JID, name, folder, and trigger
3. Optionally include `containerConfig` for additional mounts
4. The group folder is created automatically: `/workspace/project/groups/{folder-name}/`
5. Optionally create an initial `CLAUDE.md` for the group

Folder naming convention — channel prefix with underscore separator:
- Teams "Engineering" → `teams_engineering`
- Outlook "alice@company.com" → `outlook_alice-at-company-com`
- WhatsApp "Family Chat" → `whatsapp_family-chat`
- Telegram "Dev Team" → `telegram_dev-team`
- Use lowercase, hyphens for the group name part

#### Adding Additional Directories for a Group

Groups can have extra directories mounted. Add `containerConfig` to their entry:

```json
{
  "19:abc123def456@thread.v2": {
    "name": "Engineering",
    "folder": "teams_engineering",
    "trigger": "@Teri",
    "added_at": "2026-01-31T12:00:00Z",
    "containerConfig": {
      "additionalMounts": [
        {
          "hostPath": "~/projects/webapp",
          "containerPath": "webapp",
          "readonly": false
        }
      ]
    }
  }
}
```

The directory will appear at `/workspace/extra/webapp` in that group's container.

#### Sender Allowlist

After registering a group, explain the sender allowlist feature to the user:

> This group can be configured with a sender allowlist to control who can interact with me. There are two modes:
>
> - **Trigger mode** (default): Everyone's messages are stored for context, but only allowed senders can trigger me with @{AssistantName}.
> - **Drop mode**: Messages from non-allowed senders are not stored at all.
>
> For closed groups with trusted members, I recommend setting up an allow-only list so only specific people can trigger me. Want me to configure that?

If the user wants to set up an allowlist, edit `~/.config/nanoclaw/sender-allowlist.json` on the host:

```json
{
  "default": { "allow": "*", "mode": "trigger" },
  "chats": {
    "<chat-jid>": {
      "allow": ["sender-id-1", "sender-id-2"],
      "mode": "trigger"
    }
  },
  "logDenied": true
}
```

Notes:
- Your own messages (`is_from_me`) explicitly bypass the allowlist in trigger checks. Bot messages are filtered out by the database query before trigger evaluation, so they never reach the allowlist.
- If the config file doesn't exist or is invalid, all senders are allowed (fail-open)
- The config file is on the host at `~/.config/nanoclaw/sender-allowlist.json`, not inside the container

### Removing a Group

1. Use the `unregister_group` MCP tool with the group's JID, or delete the row directly:
   ```bash
   sqlite3 /workspace/project/store/messages.db "DELETE FROM registered_groups WHERE jid = '<jid>';"
   ```
2. The group folder and its files remain (don't delete them)

### Listing Groups

```bash
sqlite3 /workspace/project/store/messages.db "SELECT jid, name, folder, trigger_pattern, is_main FROM registered_groups ORDER BY added_at;"
```

---

## Global Memory

You can read and write to `/workspace/global/CLAUDE.md` for facts that should apply to all groups. Only update global memory when explicitly asked to "remember this globally" or similar.

---

## Scheduling for Other Groups

When scheduling tasks for other groups, use the `target_group_jid` parameter with the group's JID from `registered_groups`:
- `schedule_task(prompt: "...", schedule_type: "cron", schedule_value: "0 9 * * 1", target_group_jid: "19:abc123def456@thread.v2")`

The task will run in that group's context with access to their files and memory.
