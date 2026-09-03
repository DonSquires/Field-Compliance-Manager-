# Historical Source Map

These repositories are historical references for the current Field Compliance Manager build. They must be treated as prototypes, not as authoritative production code.

## Current authoritative source

- VPS checkout: `/root/field-compliance-manager`
- Current Git remote: private Gitea at `git.fcmanager.co.nz:2222`
- Supabase project: `dotczcyyzgabmtmnglqj`
- Vercel project: `iron-eagle-security/field-compliance-manager`

The current VPS checkout was imported into this repository. It contains the Bob control plane, PTT server, Supabase Edge Functions, Docker deployment definitions, and Gitea runner workflow.

## Source lineage — do not conflate build attempts

Earlier inspections saw a GitHub checkout that did not include the frontend. This workspace now does include the active `apps/web` frontend and Supabase function surface. Treat the current checkout as the working rebuild base, and treat prior build attempts as recovery evidence only.

Bob's most recent external source evidence comes from the **separate GitLab repository** (project ID `83317421`, referenced elsewhere as `don-squires1/field-compliance-manager`), read at ref `Main` via `bob-repo-search`. Per owner direction on 2026-09-03, that GitLab build is the same new purpose-designed development lineage as this rebuild. Missing capability in this line is expected and should be filled as enterprise SaaS-grade product design, not patched by bolting old modules on.

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
- `FreedomCamp-Manager-App` and the earlier Freedom Camping build are the strongest historical product references. They were close to the desired field workflow, but failed as a coherent platform because modules were bolted on rather than designed into a shared SaaS spine. Reuse requirements and lessons; do not port structure wholesale.
- `fieldops-railway-stt` is a separate Python service and may inform the current `fcm-voice` integration, but it should remain independently deployed.
- The historical app contains a committed `.env` file. Do not copy it or reuse any credentials from it; rotate any values that were ever exposed.
- Recover private repositories using a GitHub credential or deploy key with read-only access.
- Vercel deployment inspection requires authenticated Vercel access; the project URL alone does not expose source files.
- Compare historical behavior against the current Supabase schema and Edge Functions before porting code.
