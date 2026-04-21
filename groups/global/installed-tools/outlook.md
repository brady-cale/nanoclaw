# Outlook (email)

- **`mcp__nanoclaw__search_emails`** — Search Outlook emails in real-time via Microsoft Graph API. Supports `query` (free-text), `from`, `subject`, `after`/`before` (ISO dates), and `top` (max results, default 20, max 50).
- **`mcp__nanoclaw__draft_outlook_email`** — Save a draft email reply in Outlook. NEVER send emails directly — always draft. Requires `from_alias`, `to`, `subject`, `body`, and optionally `in_reply_to` and `conversation_id` for threading.