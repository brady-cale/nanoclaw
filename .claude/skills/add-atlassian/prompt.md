# Add Atlassian Integration (Confluence + Jira)

Adds Confluence and Jira capabilities to NanoClaw agents via the `mcp-atlassian` MCP server.

## Prerequisites

- Atlassian Cloud account
- API token from https://id.atlassian.com/manage-profile/security/api-tokens

## Setup Steps

### 1. Get Credentials

AskUserQuestion: Please provide your Atlassian details:
- **Atlassian URL** (e.g., `https://yourcompany.atlassian.net`)
- **Email** associated with your Atlassian account
- **API token** from https://id.atlassian.com/manage-profile/security/api-tokens

### 2. Write Credentials to .env

Add to `.env` (create if missing):
```
ATLASSIAN_BASE_URL=<url>
ATLASSIAN_EMAIL=<email>
ATLASSIAN_API_TOKEN=<token>
```

### 3. Rebuild Container

```bash
./container/build.sh
```

### 4. Register Installed Tools

Create `groups/global/installed-tools/atlassian.md`:

```markdown
# Atlassian (Confluence + Jira)

## Confluence Tools
- **`mcp__atlassian__confluence_search`** — Search Confluence using CQL queries
- **`mcp__atlassian__confluence_get_page`** — Get a Confluence page by ID
- **`mcp__atlassian__confluence_create_page`** — Create a new Confluence page
- **`mcp__atlassian__confluence_update_page`** — Update an existing Confluence page
- **`mcp__atlassian__confluence_get_spaces`** — List available Confluence spaces

## Jira Tools
- **`mcp__atlassian__jira_search`** — Search Jira issues using JQL
- **`mcp__atlassian__jira_get_issue`** — Get a Jira issue by key
- **`mcp__atlassian__jira_create_issue`** — Create a new Jira issue
- **`mcp__atlassian__jira_update_issue`** — Update an existing Jira issue
- **`mcp__atlassian__jira_get_projects`** — List Jira projects
- **`mcp__atlassian__jira_add_comment`** — Add a comment to a Jira issue
```

### 5. Restart

```bash
kill $(pgrep -f 'node.*dist/index.js')
```

The MyAssistantOrchestrator app auto-restarts the process.

### 6. Verify

Ask your agent to test:
- "Search Confluence for pages about onboarding"
- "Find open Jira issues assigned to me"

## Troubleshooting

- **No Atlassian tools**: Check `.env` has all three `ATLASSIAN_*` vars set. Restart after changes.
- **401 Unauthorized**: API token expired — regenerate at https://id.atlassian.com/manage-profile/security/api-tokens
- **403 Forbidden**: Check Atlassian account permissions for the target space/project.
- **MCP server not starting**: Rebuild container with `./container/build.sh`.
