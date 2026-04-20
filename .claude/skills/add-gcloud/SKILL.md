---
name: add-gcloud
description: Add Google Cloud (GCP) read-only integration. The agent can invoke `gcloud` commands on the host via IPC — credentials never enter the container.
---

# Add GCP Integration (Read-Only)

Gives agents a `mcp__nanoclaw__gcloud_command` tool that runs `gcloud` CLI commands. Unlike channel integrations, GCP credentials live on the host only — the container never sees them.

## How It Works

```
 Agent in container ──► mcp__nanoclaw__gcloud_command
                              │
                              ▼ (writes IPC file)
              Host reads file, validates command against read-only allowlist,
              runs `gcloud` on the host using host's ADC or service account,
              writes the result back.
```

No gcloud CLI is installed in the container. No credential files are mounted. The only way the agent can touch GCP is by asking the host to run a specific command, which the host validates before executing.

## Prerequisites

- macOS: `brew install google-cloud-sdk`
- Linux: follow https://cloud.google.com/sdk/docs/install
- The orchestrator process must run as a user that can execute `gcloud` (PATH must include it).

## Setup Steps

### 1. Install gcloud CLI on the Host

```bash
# macOS
brew install google-cloud-sdk

# Verify
gcloud --version
```

### 2. Create a Read-Only Service Account (Strongly Recommended)

Using your personal ADC gives the agent whatever IAM you have. Don't do that. Create a dedicated service account scoped to read-only:

```bash
PROJECT_ID="your-project-id"
SA_NAME="nanoclaw-readonly"
SA_EMAIL="$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"

# Create the service account
gcloud iam service-accounts create $SA_NAME \
  --display-name="NanoClaw Read-Only Agent" \
  --project=$PROJECT_ID

# Grant read-only roles. Adjust based on what the agent needs to see.
for ROLE in \
  roles/viewer \
  roles/logging.viewer \
  roles/monitoring.viewer \
  roles/run.viewer \
  roles/container.viewer; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$SA_EMAIL" \
    --role="$ROLE"
done

# Create a key and save it somewhere OUTSIDE the project directory
mkdir -p ~/.config/nanoclaw
gcloud iam service-accounts keys create \
  ~/.config/nanoclaw/gcp-readonly.json \
  --iam-account=$SA_EMAIL

chmod 600 ~/.config/nanoclaw/gcp-readonly.json
```

### 3. Activate the Service Account on the Host

```bash
gcloud auth activate-service-account \
  --key-file=$HOME/.config/nanoclaw/gcp-readonly.json

gcloud config set project $PROJECT_ID
```

Alternatively, if you're OK with the agent acting as you (not recommended): `gcloud auth application-default login`.

### 4. Register Installed Tools

Create `groups/global/installed-tools/gcloud.md`:

```markdown
# Google Cloud (GCP)

Read-only access to GCP via the host. The container does not have gcloud or credentials — every call goes through `mcp__nanoclaw__gcloud_command`, which writes an IPC request and waits for the host to execute it.

## Tool

- **`mcp__nanoclaw__gcloud_command`** — Run a gcloud CLI command. Params: `command` (array of args WITHOUT leading "gcloud", e.g. `["run", "services", "list"]`), `project_id` (optional)

## Enforcement

The host rejects any command that:
- lacks a read-only verb (list, describe, read, get, search, history, show, logs, info, check, lookup, get-value, get-iam-policy)
- contains a mutating verb (create, delete, deploy, update, patch, set, submit, etc.)
- attempts exfiltration paths (`secrets versions access`, `auth print-access-token`, `auth print-identity-token`)
- uses `--impersonate-service-account`, `--credential-file-override`, or `--account`

The service account's IAM scope is the second layer — even a bypass of the validator cannot exceed what IAM grants.

## Common Commands

**Deployments and services:**
- `["run", "services", "list", "--region=us-central1"]` — list Cloud Run services
- `["run", "services", "describe", "SERVICE", "--region=us-central1"]` — service details
- `["run", "revisions", "list", "--service=SERVICE", "--region=us-central1"]` — deployment history
- `["container", "clusters", "list"]` — list GKE clusters

**Logs:**
- `["logging", "read", "resource.type=cloud_run_revision AND resource.labels.service_name=SERVICE", "--limit=50", "--format=json"]`
- `["logging", "read", "severity>=ERROR", "--limit=20"]`

**Cloud Build:**
- `["builds", "list", "--limit=10"]` — recent builds
- `["builds", "describe", "BUILD_ID"]` — build details and logs

**Configuration (metadata only — secret values are blocked):**
- `["secrets", "list"]` — list Secret Manager secret names
- `["sql", "instances", "list"]` — list Cloud SQL instances
- `["compute", "instances", "list"]` — list VMs

## Usage Tips
- Always specify `--region` or `--zone` when required
- Use `--format=json` for structured output
- Pass `project_id` to override the default project
```

### 5. Add GCP to the Knowledge Lookup Strategy

Append this to the "Which tool for which question" section in `groups/global/CLAUDE.md` (right after the GitHub entry):

```markdown
**GCP** — infrastructure, deployments, logs:
- What version is deployed? What errors are in the logs?
- What services are running? What's the database configuration?
- Use `mcp__nanoclaw__gcloud_command` with read-only args (e.g. `["run", "services", "list"]`)
```

And in the "Search sequence" section, restore the GCP references if you want the agent to reach for it proactively.

### 6. Restart

```bash
kill $(pgrep -f 'node.*dist/index.js')
```

The MyAssistantOrchestrator app auto-restarts the process. No container rebuild needed — the change is host-side.

### 7. Verify

Ask your agent:
- "What Cloud Run services are deployed?"
- "Show me the last 20 error logs"

If GCP isn't reachable, the agent will see a clear error from the host (validation failure, missing gcloud, or IAM denial).

## Troubleshooting

- **"no read-only verb found"**: the command you asked for isn't on the safe list. Rephrase to use list/describe/read/get/search.
- **"blocked verb"**: you asked for a mutating operation. This is intentional — the integration is read-only.
- **"gcloud: command not found"**: the host doesn't have the gcloud CLI in its PATH. Reinstall per step 1 and make sure the orchestrator process inherits PATH.
- **"PERMISSION_DENIED" in stderr**: the service account lacks the required IAM role. Grant additional viewer roles per step 2.
- **Timeouts on first call**: gcloud authenticates lazily on first use per session. Subsequent calls are fast.

## Security Model

See `docs/SECURITY.md` — this integration follows the pattern used for Outlook and Calendar:

1. **Credential isolation**: GCP credentials live in `~/.config/nanoclaw/gcp-readonly.json` on the host. They are never mounted, copied, or env-injected into any container.
2. **Verb allowlist**: host-side validation blocks mutating commands before `gcloud` is invoked. Enforcement code: `src/gcloud.ts`.
3. **IAM scope**: the service account is scoped to viewer roles, so even a validator bypass cannot perform mutations.
4. **Main-group only**: only the main (owner) group can issue `gcloud_command` IPC requests; non-main groups get a rejection response.
