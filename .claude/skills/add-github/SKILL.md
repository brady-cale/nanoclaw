---
name: add-github
description: Add GitHub read-only integration. Agents can search and read code, PRs, issues, and commits via the hosted GitHub MCP server. Requires a fine-grained personal access token with read-only scopes.
---

# Add GitHub Integration (Read-Only)

Gives agents tools like `mcp__github__search_code`, `mcp__github__get_file_contents`, and `mcp__github__pull_request_read` via GitHub's hosted MCP server at `api.githubcopilot.com/mcp`.

## How It Works

```
 Agent in container ──► mcp__github__* tool
                              │
                              ▼ HTTPS to api.githubcopilot.com/mcp
                                Authorization: Bearer GITHUB_TOKEN
```

**Important — different from GCP/Outlook/Calendar:** the GitHub MCP is a hosted HTTP service the container talks to directly. The PAT travels into the container as the `GITHUB_TOKEN` env var and is sent as a Bearer header. This means **the entire security boundary is the scope of the token itself**. There is no host-side proxy that can downscope it.

A leaked or over-scoped token gives a prompt-injected agent everything that token can do on GitHub. Therefore: **only fine-grained PATs with read-only scopes are acceptable.** Classic PATs are not.

## Tool Allowlist (Container-Side)

`container/agent-runner/src/index.ts` only exposes ~20 specific `mcp__github__*` verbs to the agent — all read-only (`search_code`, `get_file_contents`, `list_commits`, `pull_request_read`, etc.). This is the second layer of defense. But Bash is also allowed, so an agent that figured out the token value could call the GitHub API directly via curl. PAT scope is the load-bearing control.

## Setup Steps

### 1. Create a Fine-Grained Personal Access Token

Go to https://github.com/settings/personal-access-tokens/new

**Critical:** select **"Fine-grained personal access token"**, NOT "Tokens (classic)". Classic tokens cannot be properly scoped read-only and are not acceptable for this integration.

Configure:

- **Token name**: `NanoClaw Read-Only`
- **Expiration**: 90 days (rotate before expiry)
- **Resource owner**: Your org (e.g., `Tereina`) or your personal account
- **Repository access**: Either "All repositories" or select specific repos. Prefer the narrowest scope you can live with.

**Repository permissions** (set ALL of these to **Read-only**, leave everything else as "No access"):

| Permission | Access |
|------------|--------|
| Contents | Read-only |
| Metadata | Read-only (auto-granted) |
| Pull requests | Read-only |
| Issues | Read-only |
| Commit statuses | Read-only |
| Discussions | Read-only (optional) |

**Account permissions**: leave everything as "No access" unless you have a specific reason.

Click **Generate token**. Copy the token — you won't see it again.

### 2. Verify the Token Has the Right Scope

```bash
curl -sH "Authorization: Bearer ghp_<your-token>" https://api.github.com/user | jq '.login'
# Should print your username

# Verify it can read code
curl -sH "Authorization: Bearer ghp_<your-token>" \
  "https://api.github.com/search/code?q=org:Tereina+function" | jq '.total_count'

# Verify it CANNOT write (this should return 403/404)
curl -sH "Authorization: Bearer ghp_<your-token>" -X POST \
  https://api.github.com/repos/<owner>/<repo>/issues \
  -d '{"title":"test"}' -w "\nHTTP %{http_code}\n"
```

If the write test succeeds (HTTP 201), your token is over-scoped — go back and reduce permissions.

### 3. Write the Token to .env

AskUserQuestion: Paste your fine-grained PAT.

Add to `.env`:

```
GITHUB_TOKEN=<your-fine-grained-pat>
```

### 4. Confirm installed-tools doc is present

`groups/global/installed-tools/github.md` should already exist (it ships with the repo). If you removed it, restore from git or write the doc that lists the allowed `mcp__github__*` tools.

### 5. Rebuild Container

The `GITHUB_TOKEN` env var is passed at container-spawn time, but the GitHub MCP entry in `buildMcpServers()` is checked at runtime — no rebuild strictly needed. However, if this is the first time installing, rebuild to make sure all dependencies are current:

```bash
./container/build.sh
```

### 6. Restart

```bash
kill $(pgrep -f 'node.*dist/index.js')
```

The MyAssistantOrchestrator app auto-restarts the process.

### 7. Verify

Ask your agent:
- "Search the Tereina org for the `containerRunner` function"
- "Read the README from the nanoclaw repo"

If GitHub isn't reachable, the agent will see a clear error from the MCP server.

## Token Rotation

Fine-grained PATs expire. Set a reminder for 7 days before the expiry date. To rotate:

1. Generate a new token at https://github.com/settings/personal-access-tokens/new with the same scopes
2. Replace `GITHUB_TOKEN` in `.env`
3. Restart the orchestrator
4. Revoke the old token at https://github.com/settings/tokens

## Troubleshooting

- **"Bad credentials" / 401**: token is invalid or expired. Regenerate per step 1.
- **"Resource not accessible by personal access token" / 403**: token lacks the required permission. Add the missing read-only scope per step 1 and regenerate.
- **Agent doesn't see GitHub tools**: check `GITHUB_TOKEN` is in `.env` and the orchestrator was restarted after the change.
- **Search returns no results from a private repo**: the fine-grained PAT must have explicit access to that repo. Either add it to "Repository access" or switch to "All repositories".

## Security Model

See `docs/SECURITY.md` for the broader nanoclaw security model.

**This integration deliberately deviates from the host-IPC pattern** (used for Outlook, Calendar, GCP) because GitHub's MCP is a hosted service the container must reach directly. Compensating controls:

1. **Token scope**: fine-grained PAT with only read permissions. The single most important control. Never use a classic PAT.
2. **Repository access**: prefer "Selected repositories" over "All repositories" when feasible.
3. **Tool allowlist**: `container/agent-runner/src/index.ts` only exposes ~20 read-only `mcp__github__*` verbs.
4. **Token expiration**: fine-grained PATs require an expiration. Use 90 days max and set a rotation reminder.
5. **No `repo` classic scope**: the `repo` scope grants full read+write to all your repos. Never grant it.

**Threat model**: a prompt-injected agent could exfiltrate the `GITHUB_TOKEN` value (e.g., write it to a file the user might fetch, or trick the user into pasting it elsewhere). With a properly scoped fine-grained PAT, the worst-case outcome is unauthorized read access to the same repos you scoped — no writes, no deletions, no other accounts touchable.

If your threat model requires zero token leakage, build a host-side GitHub proxy similar to `src/gcloud.ts` and `src/calendar.ts`. That's substantially more work but fully matches the IPC pattern.
