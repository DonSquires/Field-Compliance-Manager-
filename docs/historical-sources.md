# Historical Source Map

These repositories are historical references for the current Field Compliance Manager build. They must be treated as prototypes, not as authoritative production code.

## Current authoritative source

- VPS checkout: `/root/field-compliance-manager`
- Current Git remote: private Gitea at `git.fcmanager.co.nz:2222`
- Supabase project: `dotczcyyzgabmtmnglqj`
- Vercel project: `iron-eagle-security/field-compliance-manager`

The current VPS checkout was imported into this repository. It contains the Bob control plane, PTT server, Supabase Edge Functions, Docker deployment definitions, and Gitea runner workflow.

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
