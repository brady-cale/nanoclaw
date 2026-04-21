# GitHub

Read-only access to GitHub. Search and read code, PRs, issues, and commits across the organization's repos, personal repos, forks, and public repos.

## Key Tools
- **`mcp__github__search_code`** — Search code across repos. Params: `query` (GitHub search syntax, e.g., `org:Tereina function_name`), `page`, `per_page`
- **`mcp__github__get_file_contents`** — Read a file from a repo. Params: `owner`, `repo`, `path`, `ref` (branch/tag/sha, optional)
- **`mcp__github__search_repositories`** — Find repos. Params: `query` (e.g., `org:Tereina payment`)
- **`mcp__github__list_commits`** — Recent commits. Params: `owner`, `repo`, `sha` (branch), `author`, `since`, `until`
- **`mcp__github__get_commit`** — Get a specific commit with diff. Params: `owner`, `repo`, `ref`
- **`mcp__github__search_issues`** — Search issues/PRs. Params: `query` (GitHub search syntax)
- **`mcp__github__list_pull_requests`** — List PRs. Params: `owner`, `repo`, `state`, `head`, `base`
- **`mcp__github__pull_request_read`** — Read PR details, diff, comments

## Usage Tips
- Use `org:Tereina` in search queries to scope to the organization
- Combine with Jira: find the ticket, then search GitHub for the related code or PR
- Use `get_file_contents` to read specific files when you know the path
- Use `search_code` when you need to find where something is implemented