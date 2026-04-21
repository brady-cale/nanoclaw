# Add GitHub Integration (Read-Only)

Gives agents `mcp__github__*` tools via GitHub's hosted MCP server.

**Important**: the PAT travels into the container as a Bearer header. Token scope is the load-bearing security control. Only fine-grained PATs with read-only scopes are acceptable. Classic PATs are NOT.

## Setup Steps

### 1. Create a Fine-Grained PAT

Go to https://github.com/settings/personal-access-tokens/new

- **Type**: Fine-grained personal access token (NOT classic)
- **Token name**: `NanoClaw Read-Only`
- **Expiration**: 90 days max
- **Resource owner**: your org or personal account
- **Repository access**: prefer "Selected repositories"; "All repositories" only if needed
- **Repository permissions** — set ALL of these to **Read-only**, leave everything else "No access":
  - Contents: Read-only
  - Metadata: Read-only (auto)
  - Pull requests: Read-only
  - Issues: Read-only
  - Commit statuses: Read-only
- **Account permissions**: leave as "No access"

Copy the token.

### 2. Verify Read-Only

```bash
# Should print your username
curl -sH "Authorization: Bearer <token>" https://api.github.com/user | jq '.login'

# Should fail with 403/404
curl -sH "Authorization: Bearer <token>" -X POST \
  https://api.github.com/repos/<owner>/<repo>/issues \
  -d '{"title":"test"}' -w "\nHTTP %{http_code}\n"
```

If the write test succeeds, the token is over-scoped — regenerate with narrower permissions.

### 3. Save the Token

AskUserQuestion: Paste your fine-grained PAT.

Add to `.env`:

```
GITHUB_TOKEN=<your-pat>
```

### 4. Restart

```bash
kill $(pgrep -f 'node.*dist/index.js')
```

### 5. Verify

Ask the agent: "Search the Tereina org for the `containerRunner` function".

## Token Rotation

Fine-grained PATs expire (max 90 days). Set a reminder. To rotate: generate a new one with same scopes, replace `GITHUB_TOKEN` in `.env`, restart, revoke the old token at https://github.com/settings/tokens.

## Troubleshooting

- **401 Bad credentials**: token expired or invalid — regenerate.
- **403 Resource not accessible**: token lacks a required read scope — add it and regenerate.
- **No tools available**: check `GITHUB_TOKEN` is set and orchestrator was restarted.
- **No results from private repo**: token doesn't have access to that repo — add it under "Repository access".
