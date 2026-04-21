# Atlassian (Confluence + Jira)

## Confluence Tools

**Read:**
- **`mcp__atlassian__confluence_search`** — Search Confluence using CQL. Params: `query` (CQL string), `limit`
- **`mcp__atlassian__confluence_get_page`** — Get a page by ID. Params: `page_id`, `include_metadata`
- **`mcp__atlassian__confluence_get_page_children`** — Get child pages. Params: `page_id`, `limit`
- **`mcp__atlassian__confluence_get_comments`** — Get comments on a page. Params: `page_id`
- **`mcp__atlassian__confluence_get_labels`** — Get labels on a page. Params: `page_id`

**Write:**
- **`mcp__atlassian__confluence_create_page`** — Create a new page. Params: `space_key`, `title`, `content` (HTML/storage format), `parent_id`
- **`mcp__atlassian__confluence_update_page`** — Update an existing page. Params: `page_id`, `title`, `content`, `version` (required — increment from current)
- **`mcp__atlassian__confluence_add_comment`** — Add a comment to a page. Params: `page_id`, `content`

> **Before updating a Confluence page:** If the prompt doesn't include the full content or context for the update, run a knowledge lookup first (search Confluence, Jira, Github, WebSearch, Context7, and relevant sources) to confirm the facts. Don't overwrite existing content with unverified information.

## Jira Tools

**Read:**
- **`mcp__atlassian__jira_search`** — Search issues using JQL. Params: `jql`, `fields`, `limit`
- **`mcp__atlassian__jira_get_issue`** — Get an issue by key. Params: `issue_key`, `fields`
- **`mcp__atlassian__jira_get_all_projects`** — List all Jira projects. Params: `include_archived`
- **`mcp__atlassian__jira_get_transitions`** — Get available status transitions for an issue. Params: `issue_key`
- **`mcp__atlassian__jira_get_worklog`** — Get worklogs for an issue. Params: `issue_key`
- **`mcp__atlassian__jira_get_issue_link_types`** — List available issue link types

**Write:**
- **`mcp__atlassian__jira_create_issue`** — Create a new issue. Params: `project_key`, `summary`, `issue_type`, `description`, `assignee`, `labels`, `priority`
- **`mcp__atlassian__jira_update_issue`** — Update an issue. Params: `issue_key`, plus any fields to change
- **`mcp__atlassian__jira_transition_issue`** — Change issue status. Params: `issue_key`, `transition_id` (get from `jira_get_transitions`)
- **`mcp__atlassian__jira_add_comment`** — Add a comment. Params: `issue_key`, `comment`
- **`mcp__atlassian__jira_add_worklog`** — Log time on an issue. Params: `issue_key`, `time_spent`, `comment`
- **`mcp__atlassian__jira_delete_issue`** — Delete an issue. Params: `issue_key`
- **`mcp__atlassian__jira_create_issue_link`** — Link two issues. Params: `link_type`, `inward_issue_key`, `outward_issue_key`

## Usage Tips
- Use `project = PROJ AND text ~ "keyword" ORDER BY updated DESC` for focused Jira searches
- Use `text ~ "keyword" AND space.type = "global" ORDER BY lastModified DESC` for Confluence
- Combine both: find the Jira ticket, then search Confluence for the design doc