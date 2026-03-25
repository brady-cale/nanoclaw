---
name: add-atlassian
description: Add Atlassian (Confluence + Jira) integration. Agents can search, read, create, and update Confluence pages and Jira issues via MCP server.
---

# Add Atlassian Integration (Confluence + Jira)

Adds Confluence and Jira capabilities to NanoClaw agents via the `mcp-atlassian` MCP server. Agents get tools for searching, reading, creating, and updating Confluence pages and Jira issues.

## What It Does

The integration runs as an MCP server inside the agent container. When Atlassian credentials are present in `.env`, every agent automatically gets access to:

### Confluence
- Search pages (CQL)
- Read, create, and update pages
- Navigate page hierarchy (parent/child)
- Manage comments (footer + inline)
- List spaces
- Manage labels and attachments

### Jira
- Search issues (JQL)
- Read, create, and edit issues
- Manage comments
- List projects, boards, and sprints
- Transition issue status

## Prerequisites

- An Atlassian Cloud account (e.g., `yourcompany.atlassian.net`)
- An Atlassian API token

## Setup Steps

### 1. Get Your API Token

1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
2. Click **Create API token**
3. Give it a label (e.g., "NanoClaw")
4. Copy the token — you won't see it again

AskUserQuestion: Please provide your Atlassian details:
- **Atlassian URL** (e.g., `https://yourcompany.atlassian.net`)
- **Email** associated with your Atlassian account
- **API token** (from step above)

### 2. Write Credentials to .env

Add to `.env`:
```
ATLASSIAN_BASE_URL=https://yourcompany.atlassian.net
ATLASSIAN_EMAIL=your-email@example.com
ATLASSIAN_API_TOKEN=your-api-token
```

### 3. Rebuild Container

The `mcp-atlassian` package is already included in the container image. Rebuild to ensure you have the latest:

```bash
./container/build.sh
```

### 4. Register Installed Tools

Create `groups/global/installed-tools/atlassian.md` with tool documentation:

```markdown
# Atlassian (Confluence + Jira)

## Confluence Tools
- **`mcp__atlassian__confluence_search`** — Search Confluence using CQL queries
- **`mcp__atlassian__confluence_get_page`** — Get a Confluence page by ID
- **`mcp__atlassian__confluence_create_page`** — Create a new Confluence page
- **`mcp__atlassian__confluence_update_page`** — Update an existing Confluence page
- **`mcp__atlassian__confluence_get_spaces`** — List available Confluence spaces
- **`mcp__atlassian__confluence_get_comments`** — Get comments on a page
- **`mcp__atlassian__confluence_add_comment`** — Add a comment to a page

## Jira Tools
- **`mcp__atlassian__jira_search`** — Search Jira issues using JQL
- **`mcp__atlassian__jira_get_issue`** — Get a Jira issue by key
- **`mcp__atlassian__jira_create_issue`** — Create a new Jira issue
- **`mcp__atlassian__jira_update_issue`** — Update an existing Jira issue
- **`mcp__atlassian__jira_get_projects`** — List Jira projects
- **`mcp__atlassian__jira_add_comment`** — Add a comment to a Jira issue
- **`mcp__atlassian__jira_get_transitions`** — Get available status transitions
- **`mcp__atlassian__jira_transition_issue`** — Change issue status
```

This directory is NOT tracked in git — it's local to each install. Agents discover available tools by reading files in `/workspace/global/installed-tools/`.

### 5. Restart

Restart the orchestrator to pick up the new `.env` values:

```bash
kill $(pgrep -f 'node.*dist/index.js')
```

The MyAssistantOrchestrator app will auto-restart the process.

### 6. Verify

Test by asking your agent to search for something in Confluence or Jira. For example:
- "Search Confluence for pages about onboarding"
- "Find open Jira issues assigned to me"

## Troubleshooting

- **Agent doesn't have Atlassian tools**: Check that `ATLASSIAN_BASE_URL`, `ATLASSIAN_EMAIL`, and `ATLASSIAN_API_TOKEN` are set in `.env`. The MCP server only registers when all three are present.
- **401 Unauthorized**: Your API token may have expired or been revoked. Create a new one at https://id.atlassian.com/manage-profile/security/api-tokens
- **403 Forbidden**: Your Atlassian account may not have permission to access the space or project. Check your Atlassian permissions.
- **MCP server not starting**: Rebuild the container with `./container/build.sh` to ensure `mcp-atlassian` is installed.
