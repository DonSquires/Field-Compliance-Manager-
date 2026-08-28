# Historical Source Map

These repositories are historical references for the current Field Compliance Manager build. They must be treated as prototypes, not as authoritative production code.

## Current authoritative source

- VPS checkout: `/root/field-compliance-manager`
- Current Git remote: private Gitea at `git.fcmanager.co.nz:2222`
- Supabase project: `dotczcyyzgabmtmnglqj`
- Vercel project: `iron-eagle-security/field-compliance-manager`

The current VPS checkout was imported into this repository. It contains the Bob control plane, PTT server, Supabase Edge Functions, Docker deployment definitions, and Gitea runner workflow.

## Two distinct codebases — do not conflate them

An independent tool inspection ("Vercel AI") of this GitHub repo's `main` checkout confirmed: no React, `react-router-dom`, or `@supabase/supabase-js` in the root manifest/lockfile, and no `BrowserRouter` entrypoint anywhere in the checkout. This matches what we already established directly in this repo (`src/` contains only generated types, no frontend `package.json` dependency exists here) — it is **not** new information and **not** a contradiction of anything Bob has found.

Bob's frontend evidence (`main.tsx`, `App.tsx`, `RoleRouter.tsx`, `AdminShell.tsx`, `AdminHubPage.tsx`, `lib/supabase.ts`, etc., all with real, non-empty content) comes from the **separate GitLab repository** (project ID `83317421`, referenced elsewhere as `don-squires1/field-compliance-manager`), read at ref `Main` via `bob-repo-search`. That repository is where the actual frontend source lives — this GitHub repo never had it.

**Open question, not yet resolved:** which Git source does the live `iron-eagle-security/field-compliance-manager` Vercel project actually build from? It has not been confirmed to be the same GitLab repo/ref Bob is reading, the same branch even if it is, or this GitHub repo. Until that is confirmed, do not assume the code Bob is auditing is what is currently live in production — it may be a newer, older, or divergent version. Verify the Vercel project's connected Git integration (provider, repo, branch) before treating the rebuild spec as production-equivalent.

## Historical references

| Repository | Role | Access from Codespace |
| --- | --- | --- |
| [FreedomCamp-Manager](https://github.com/DonSquires/FreedomCamp-Manager) | Earlier FreedomCamp application | Private or unavailable |
| [fieldops-railway-stt](https://github.com/DonSquires/fieldops-railway-stt) | Earlier FastAPI/Faster-Whisper CPU speech-to-text service | Public, Docker/Railway deployment |
| [Bob](https://github.com/DonSquires/Bob) | Earlier self-contained Bob AI service | Public, README only |
| [FreedomCamp-Manager-App](https://github.com/DonSquires/FreedomCamp-Manager-App) | Earlier Expo/React Native field application | Public, substantial prototype |
| [orc-ai-inference-service](https://github.com/DonSquires/orc-ai-inference-service) | Earlier inference prototype | Public, minimal Vite client |
| [https-react-9b4t5o.onspace.build](https://github.com/DonSquires/https-react-9b4t5o.onspace.build) | Earlier UI export | Public, README only |
| [Backup](https://github.com/DonSquires/Backup) | Backup source | Private or unavailable |
| [nzscv-proxy](https://github.com/DonSquires/nzscv-proxy) | New Zealand vehicle lookup proxy | Public, minimal README |

## Recovery notes

- Do not overwrite current VPS source with prototype code.
- `FreedomCamp-Manager-App` is the strongest historical UI reference. It includes camera/GPS workflows, offline sync, plate recognition, patrols, jobs, observations, zones, welfare, and Supabase integrations.
- `fieldops-railway-stt` is a separate Python service and may inform the current `fcm-voice` integration, but it should remain independently deployed.
- The historical app contains a committed `.env` file. Do not copy it or reuse any credentials from it; rotate any values that were ever exposed.
- Recover private repositories using a GitHub credential or deploy key with read-only access.
- Vercel deployment inspection requires authenticated Vercel access; the project URL alone does not expose source files.
- Compare historical behavior against the current Supabase schema and Edge Functions before porting code.
