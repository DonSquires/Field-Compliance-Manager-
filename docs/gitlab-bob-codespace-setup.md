# GitLab access for Bob and Codespace

Bob and this Codespace should use separate project-scoped, read-only GitLab credentials. Do not put either credential in the repository, `.env.example`, Docker images, prompts, or chat messages.

## Bob's Supabase function

Create a GitLab project deploy token or project access token for the original repository with the minimum scope needed for repository/API reads (`read_repository`, and `read_api` only if the selected GitLab API operation requires it). Do not grant `write_repository`.

Until that token is created, the deployed reader may use the existing `GITLAB_TOKEN` as a temporary read compatibility path. Its value is never returned to Bob or the worker, and `write_bob_chat` remains disabled without a separate `GITLAB_WRITE_TOKEN`. Rotate the legacy token after the scoped read token is installed.

Set the values through the authenticated Supabase CLI from a secure terminal:

```bash
npx supabase secrets set \
  GITLAB_READ_TOKEN='paste-token-directly-in-your-terminal' \
  GITLAB_PROJECT_ID='approved-project-id' \
  GITLAB_ALLOWED_PROJECTS='approved-project-id'
```

The optional `GITLAB_WRITE_TOKEN` must be a separate credential with the narrowest write scope and should only be configured if the `write_bob_chat` action is intentionally enabled. The read token must never be reused as the write token.

After the secrets are configured, deploy only the reader:

```bash
npx supabase functions deploy bob-repo-search
```

Then verify the function with an authorized human JWT and a harmless read of a known non-secret file. Verify that secret paths, private memory paths, unapproved projects, and write requests are rejected. Do not test with production data or commit content.

## Codespace access

Create a second GitLab project deploy token with read-only scope. Store it in GitHub Codespaces Secrets, not in this workspace or `devcontainer.json`, for example as `GITLAB_READ_TOKEN` and, if needed, `GITLAB_USERNAME`.

Configure a temporary credential helper only after the Codespace starts. Do not write the token to a tracked file, shell history, Docker layer, build artifact, or worker environment. Clone the original repository at an exact commit or approved ref into a read-only workspace. Bob's worker should receive that snapshot and should not receive the GitLab token.

## Read-only collaboration boundary

Bob may search and read the original repository through `bob-repo-search`. The Codespace may independently clone/read it for analysis. Neither path should grant Bob or the worker write access, and neither should expose Supabase service credentials. Human approval remains required before any proposed change, merge, or deployment.