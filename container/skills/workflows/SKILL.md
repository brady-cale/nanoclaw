---
name: workflows
description: Create and manage long-running async workflow projects with multi-step plans. Use when a request involves multiple steps that happen over time (waiting for responses, checking conditions, scheduling future actions).
---

# Workflows — Long-Running Async Projects

Use this skill when a user request involves multiple steps that may span hours or days — e.g., sending an email and waiting for a reply, coordinating schedules, multi-step processes with external dependencies.

## When to Use

Trigger a workflow when the task:
- Involves waiting for external events (email replies, approvals, responses)
- Has multiple sequential steps where later steps depend on earlier outcomes
- Will take longer than a single agent session
- Requires periodic checking of conditions

## How It Works

1. **Propose a workflow** — Break the user's request into numbered steps with types
2. **User approves** — The workflow stays in `pending_approval` until confirmed
3. **System creates a checker task** — Periodically runs to advance the workflow
4. **Steps execute over time** — Action steps run immediately, wait steps poll conditions

## Step Types

| Type | Description |
|------|-------------|
| `action` | Something to do right now (send email, search calendar, etc.) |
| `wait_for` | Wait for an external condition (email reply, approval, etc.) |
| `check` | Evaluate a condition and branch (was reply positive? did they accept?) |
| `notify` | Send a status update to the user in the main channel |

## Creating a Project

Write a JSON file to `/workspace/ipc/tasks/` with this structure:

```json
{
  "type": "create_project",
  "requestId": "req-<unique>",
  "targetJid": "<chat_jid from your context>",
  "name": "Short project name",
  "description": "What the user asked for, in detail",
  "check_interval_ms": 300000,
  "workflow": [
    {
      "id": 1,
      "description": "Send initial email to person@example.com about coffee",
      "type": "action",
      "status": "pending"
    },
    {
      "id": 2,
      "description": "Check for email response from person@example.com",
      "type": "wait_for",
      "status": "pending",
      "check_config": {
        "check_type": "email_response",
        "check_description": "Search for reply emails from person@example.com to the coffee invitation"
      }
    },
    {
      "id": 3,
      "description": "Evaluate if reply is positive. If not positive, notify user. If positive, continue.",
      "type": "check",
      "status": "pending",
      "check_config": {
        "check_description": "Read the reply and determine if they're interested in coffee"
      }
    },
    {
      "id": 4,
      "description": "Look up my schedule for available times and find nearby coffee shops",
      "type": "action",
      "status": "pending"
    },
    {
      "id": 5,
      "description": "Send follow-up email with proposed times and coffee shop options",
      "type": "action",
      "status": "pending"
    },
    {
      "id": 6,
      "description": "Wait for their response about times/places",
      "type": "wait_for",
      "status": "pending",
      "check_config": {
        "check_type": "email_response",
        "check_description": "Search for reply about accepting a time and place"
      }
    },
    {
      "id": 7,
      "description": "Book calendar invite with agreed time/place and notify user",
      "type": "action",
      "status": "pending"
    },
    {
      "id": 8,
      "description": "Notify user that coffee meeting is booked",
      "type": "notify",
      "status": "pending"
    }
  ]
}
```

Wait for the response file at `/workspace/ipc/responses/<requestId>.json` to confirm creation.

## Presenting the Workflow to the User

After creating the project (in `pending_approval` state), present it to the user clearly:

```
I've created a workflow project for this. Here's the plan:

📋 **[Project Name]**

1. ✉️ Send initial email about coffee
2. ⏳ Wait for their response (checking periodically)
3. 🔍 Check if response is positive → notify you if not
4. 📅 Look up your schedule and find coffee shops nearby
5. ✉️ Send email with proposed times and places
6. ⏳ Wait for their response
7. 📅 Book calendar invite
8. 🔔 Notify you when it's all done

Shall I go ahead with this plan?
```

## Approving a Workflow

When the user confirms (says yes, approve, go ahead, etc.), write:

```json
{
  "type": "approve_project",
  "projectId": "proj-..."
}
```

to `/workspace/ipc/tasks/approve-<projectId>.json`

Then execute step 1 immediately if it's an `action` type. After completing it, update the project:

```json
{
  "type": "update_project",
  "projectId": "proj-...",
  "current_step": 1,
  "workflow": [... updated workflow with step 1 marked completed ...]
}
```

## Checking on a Project (for checker task runs)

When running as a checker task, read `/workspace/ipc/current_projects.json` to find your project. Then:

1. Look at `current_step` and the corresponding step in `workflow`
2. Based on step type:
   - **action**: Execute the action, update step status to `completed`, advance `current_step`
   - **wait_for**: Check the condition (search emails, check calendar, etc.). If condition met, mark `completed` and advance. If not, do nothing — the checker will run again.
   - **check**: Evaluate the condition. If it passes, advance. If it fails, either notify user or adjust plan.
   - **notify**: Send an IPC message to the user, then advance.
3. If all steps completed, update project status to `completed`

## Updating Project State

Write to `/workspace/ipc/tasks/`:

```json
{
  "type": "update_project",
  "projectId": "proj-...",
  "current_step": 3,
  "workflow": [... full workflow array with updated statuses ...]
}
```

## Listing Projects

To view current projects, read `/workspace/ipc/current_projects.json`.

Or request via IPC:
```json
{
  "type": "get_projects",
  "requestId": "req-<unique>"
}
```

## Cancelling a Project

```json
{
  "type": "cancel_project",
  "projectId": "proj-..."
}
```

This stops the checker task and marks the project as cancelled.

## Tips

- Set `check_interval_ms` based on urgency: 300000 (5min) for emails, 3600000 (1hr) for less urgent
- Use `context_mode: "group"` for checker tasks so they share the group's memory
- Always notify the user when a project completes or when manual intervention is needed
- Keep step descriptions detailed enough that the checker task understands what to do
- When a `wait_for` step involves email, use the email search IPC to check for replies
- When a `check` step fails (e.g., negative reply), notify the user and pause the project
