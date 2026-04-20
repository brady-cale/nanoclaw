# Add GCP Integration (Read-Only)

Gives agents a `mcp__nanoclaw__gcloud_command` tool. The gcloud CLI runs on the host; credentials never enter the container.

## Setup Steps

### 1. Install gcloud CLI on the host

```bash
# macOS
brew install google-cloud-sdk
gcloud --version
```

### 2. Create a read-only service account

AskUserQuestion: What's your GCP project ID?

Then run (substituting the project ID):

```bash
PROJECT_ID="<project-id>"
SA_NAME="nanoclaw-readonly"
SA_EMAIL="$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"

gcloud iam service-accounts create $SA_NAME \
  --display-name="NanoClaw Read-Only Agent" \
  --project=$PROJECT_ID

for ROLE in roles/viewer roles/logging.viewer roles/monitoring.viewer roles/run.viewer roles/container.viewer; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$SA_EMAIL" --role="$ROLE"
done

mkdir -p ~/.config/nanoclaw
gcloud iam service-accounts keys create \
  ~/.config/nanoclaw/gcp-readonly.json \
  --iam-account=$SA_EMAIL
chmod 600 ~/.config/nanoclaw/gcp-readonly.json

gcloud auth activate-service-account --key-file=$HOME/.config/nanoclaw/gcp-readonly.json
gcloud config set project $PROJECT_ID
```

### 3. Write installed-tools doc

Create `groups/global/installed-tools/gcloud.md` documenting `mcp__nanoclaw__gcloud_command` and the read-only allowlist. (Copy from SKILL.md — it has the full doc template.)

### 4. Add GCP to the Knowledge Lookup Strategy

Append to `groups/global/CLAUDE.md` in the "Which tool for which question" section:

```markdown
**GCP** — infrastructure, deployments, logs:
- What version is deployed? What errors are in the logs?
- Use `mcp__nanoclaw__gcloud_command` with read-only args (e.g. `["run", "services", "list"]`)
```

### 5. Restart

```bash
kill $(pgrep -f 'node.*dist/index.js')
```

### 6. Verify

Ask the agent: "What Cloud Run services are deployed?"

## Troubleshooting

- **"no read-only verb found" / "blocked verb"**: the command you asked for isn't allowed — integration is read-only.
- **"gcloud: command not found"**: host's gcloud isn't in PATH. Reinstall per step 1.
- **"PERMISSION_DENIED" in stderr**: service account lacks the role. Add more viewer roles in step 2.
