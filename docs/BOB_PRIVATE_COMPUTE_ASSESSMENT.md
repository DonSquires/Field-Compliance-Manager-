# Bob private compute assessment

Assessment: 2026-10-22 (NZ work session). No purchase, provisioning, new inference
endpoint, default model change or source-code egress is authorised by this report.
Read with [credential boundaries](BOB_CREDENTIAL_BOUNDARIES.md).

## Model-role review, 2026-10-24

This section supersedes the older blanket statement below that Ollama Cloud
is forbidden: the owner's 2026-10-22 approval and credential-boundary controls
allow gated Ollama Cloud escalation. Current attachments remain private.
This review did **not** send repository source, real documents, emails,
screenshots, production records, credentials or owner messages to a model.
No new model was installed and production routing/defaults were not changed.

### Observed runtime and bounded screening

Read-only checks found:

- GPU: coder 7B (4.68 GB) and Qwen3 8B (5.23 GB) are installed and within
  the configured 6 GiB weight budget. Coder 14B (8.99 GB) and GPT-OSS 20B
  (13.79 GB) are installed but too large for that budget. Do not disable it.
- VPS CPU: coder 7B, Qwen3 Coder 30B, Llama 3.1 8B, GPT-OSS 20B,
  Moondream and Nomic embeddings are installed. The installed 20B is not
  in the current VPS allowlist. Installed does not mean selected or fast.
- Cloud allowlist currently starts GPT-OSS 120B, DeepSeek V4 Pro, then
  Nemotron 3 Ultra. Recent Vibe receipts show GPT-OSS prose-only escalation
  and DeepSeek repair attempts, not reliable complete-job acceptance.

One direct Ollama Cloud API screening used invented `src/add.js` code only:
first return a JSON `read_file` call; then, given a synthetic read result,
return an exact `replace_in_file` call fixing subtraction to addition.
The replacement was applied in memory and evaluated against `add(2,3) = 5`.
Requests used JSON mode, temperature 0, thinking disabled, 8K context and
a 4096-token cap. Calls were concurrent across models. Timings are for two
requests, not tokens/second or a statistically meaningful ranking.

| Exact direct-API model | Result | Total elapsed | Interpretation |
| --- | --- | --- | --- |
| `deepseek-v4.1-flash` | 2/2 valid calls; arithmetic assertion passed | 1.11 s | Promising fast coding/investigation candidate; not a production qualification. |
| `deepseek-v4-pro:0813` | 2/2 valid calls; arithmetic assertion passed | 2.21 s | Existing strong author/recovery candidate. |
| `gpt-oss:120b` | 2/2 valid calls; arithmetic assertion passed | 2.67 s | Existing planning/review candidate; the probe does not erase live prose-only failures. |
| `glm-5.3` | First response was not a parseable JSON object | 2.15 s | Do not promote based on the advertised coding claim. |
| `glm-5.3-flash` | First response was not a parseable JSON object | 2.78 s | Same; investigate protocol compatibility before considering routing. |

The probe does not execute the real gateway, long session compaction,
large-context edits, independent review, browser acceptance or deployment.
Retest through those paths before promoting a new candidate. Catalogue tags
such as `:cloud` used by a local Ollama client are not necessarily the exact
direct cloud API identifiers; validate both availability and account access.

### Recommended workforce, not a model for every integration

| Work | Candidate and reason | Execution/evidence boundary |
| --- | --- | --- |
| Multi-file coding and difficult recovery | Existing DeepSeek V4 Pro; trial V4.1 Flash for bounded edits | Real tool calls, exact diff, lint/tests and browser evidence; catalogue claims are insufficient. |
| Planning, investigation, task decomposition | GPT-OSS 120B; compare V4 Pro on representative briefs | Schema/Atlas-grounded plans; acknowledge unbuilt paths and validator failures. |
| Small private subagent work | Installed coder 7B or Qwen3 8B | One bounded read/edit/check task, admitted within GPU memory/concurrency limits; no autonomous agent spawning is added by a model choice. |
| Independent verification | A different model family from the author, e.g. GPT-OSS after DeepSeek | Deterministic CI/type checks/browser assertions remain authoritative; self-review is not independent review. |
| Research | General reasoning model plus governed web-research tool | Official sources, dates and exact claims; a language model alone is not live web search. No private data in queries. |
| CI, CLI, Supabase and VPS | Same qualified coding/reasoning models | Narrow allowlisted tools, caller authority, audited approval paths, migration/deployment receipts. No model needs raw infrastructure credentials. |
| Email and document analysis | Private Qwen3 8B for extracted text; deterministic PDF/DOCX/XLSX extraction first | Synthetic/test recipients only for tests, no unapproved sends; preserve source locations, confidence and provenance. |
| Screenshot/image analysis and visual verification | Existing private Moondream; trial `qwen3-vl:4b` (3.3 GB package) | Private-only image path; verify actual capability, OCR accuracy and runtime fit before installing/switching. An image model does not replace DOM, contrast and browser tests. |
| Embeddings/retrieval | Existing Nomic embeddings | Retrieval only, not an author, planner or verifier. |
| Larger private author | Qwen3 Coder 30B or Qwen3.8 27B only on suitable hardware | Packages are approximately 19/18 GB before KV cache/runtime. Not suitable for the present laptop's 6 GiB model-weight budget; CPU evidence below remains relevant. |

### Official catalogue evidence

Retrieved 2026-10-24 from Ollama (publisher). Pages show relative update ages,
not stable exact publication dates; no precise publication date is inferred.
These are vendor descriptions, **not independently verified benchmark ranks**.

| Source | Exact claim supported |
| --- | --- |
| [Ollama search](https://ollama.com/search) | Currently lists coding/agentic, vision, embedding and decision-model families; filter by actual task and capabilities. |
| [DeepSeek V4.1 Flash tags](https://ollama.com/library/deepseek-v4.1-flash/tags) | Cloud model, tools/thinking/vision, advertised 1M context; includes dated `1017-cloud` tag. |
| [GLM 5.3 tags](https://ollama.com/library/glm-5.3/tags) / [Flash tags](https://ollama.com/library/glm-5.3-flash/tags) | Advertised tools/thinking and 1M cloud context; Flash also advertises vision. Our JSON screening did not pass. |
| [Qwen3 Coder tags](https://ollama.com/library/qwen3-coder/tags) | 30B Q4 package about 19 GB; tools; advertised 256K model context. |
| [Qwen3.8 tags](https://ollama.com/library/qwen3.8/tags) | 27B package about 18 GB; text/image, tools/thinking; advertised 256K model context. |
| [Qwen3 VL tags](https://ollama.com/library/qwen3-vl/tags) | 4B package about 3.3 GB, 8B about 6.2 GB; text/image and tools. The 8B is close to the 6 GiB weight cap: verify exact byte size and total runtime fit rather than equating GB with GiB. |
| [GPT-OSS tags](https://ollama.com/library/gpt-oss/tags) | Tools/thinking; 20B/120B and cloud variants. |

## Evidence and its limits

Before: Vibe runs on the owner's GPU workstation or VPS. Hosted Ollama and
OpenAI are not permitted to receive private Vibe source, attachments or turns.
The present workstation has 8 GiB VRAM; the gateway reserves 2 GiB and therefore
permits at most 6 GiB of model weights. This is a weight budget, not proof that
weights plus KV cache, display use and inference workspace will fit.

During: read-only `/api/show` checks confirm the installed
`qwen2.5-coder:7b`, `qwen3:8b` and VPS `qwen3-coder:30b` all declare native
tool support. The first two are within the current GPU weight budget. The
installed 14B coder is not, and must not be forced onto the laptop by disabling
the budget. The VPS has approximately 32 GiB system RAM, not a dedicated GPU.

After: a bounded private 30B CPU replay made nine requests in 624 seconds, four
of which timed out, and changed no files. Alternate 8B GPU replays made edits
but produced invalid JSX caught by both the runtime handoff gate and an
independent lint run. These are capacity/quality observations, not a benchmark
claim that one larger model will complete the product task.

A native-transport replay also found that coder 7B can declare tool support
while returning no actual function calls and describing an unexecuted edit.
The gateway must verify the returned protocol, not just trust metadata. It now
refuses that response and visibly selects the existing structured-JSON path
for a bounded five-minute compatibility window. No hosted fallback is used.

On the same existing GPU, Qwen3 8B did return eleven real native calls across
two diagnostic turns. Its four-call continuation read the failed TypeScript
evidence, read and repaired the seeded source fault, ran lint, and replied;
the independent check passed. The preceding heading-change probe made no
successful edit. This establishes a bounded repair path, not reliable
whole-screen redesign, browser acceptance or a reason to change default routing.

The default coder 7B also repaired the seeded fault after its missing native
call was refused. Five subsequent structured-JSON calls included a refused
incorrect literal edit, a source search, the successful edit, a passing lint
run and the reply. Automatic and independent checks passed too. This is real
private compatibility/recovery evidence, not just a mocked transport test.

## Sourced facts

| Source | Supported claim | Date information |
| --- | --- | --- |
| [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling) | Native calls use function definitions, assistant `tool_calls`, and tool-role results; the application executes tools. | Publication/update date not displayed; retrieved for this assessment. |
| [Official Qwen model card](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct) | 30.5B total parameters, 3.3B activated, native 262,144-token model context, agentic function calling and non-thinking mode. The card advises reducing context when memory is exhausted. | Publication/update date not displayed in the retrieved text. |
| [Ollama 30B package](https://ollama.com/library/qwen3-coder:30b) | The Q4_K_M package is advertised as approximately 19 GB. | Page displays a relative update date; no exact date used here. |
| [Runpod pricing](https://www.runpod.io/pricing) | Advertised on-demand Pod starting rates include 24 GB A5000 at USD 0.27/hour, 48 GB A6000 at USD 0.59/hour, and 48 GB L40S at USD 1.09/hour. | Page says updated 2026-10-08; retrieved for this assessment. |

The model's 3.3B *active* parameters do not turn it into a 3.3B-weight memory
allocation. A 19 GB download is not a total runtime-memory specification.
The advertised 256K model context is not the context that this hardware can
safely serve. Current gateway context limits remain authoritative.

A read-only Ollama runtime snapshot during the 8B native replay reported
7,837,298,195 bytes total loaded size, 6,294,171,811 bytes in VRAM, and a
16,384-token context. This is a single observation, not peak usage or a
throughput benchmark; it shows that an eligible weight file does not imply
the complete runtime is GPU-resident. More context can consume the headroom
and require CPU offload.

## Recommendation and alternatives

**First finish the execution work on existing machines.** Native tool transport,
typed arguments, retained failure evidence, small reads and repair checkpoints
can remove wasted work. More hardware does not fix a broken tool protocol,
wrong target page, lost history or a false success report.

For a stronger author after that:

| Option | Assessment | Approval/cost boundary |
| --- | --- | --- |
| Owner-controlled 24 GB GPU | A constrained single 30B Q4 worker may be feasible, but context/runtime headroom is tight. Benchmark before committing to it. | Obtain an actual hardware quote. No procurement was attempted. |
| Owner-controlled 32 GB GPU | More credible single-author headroom; still measure the chosen context and avoid concurrent model loads. | Obtain an actual hardware quote. No guaranteed throughput is claimed. |
| Owner-controlled 48 GB GPU | Preferred headroom for a single 30B Q4 author plus useful context. Start with bounded context rather than advertising 256K. | Recommended private hardware class, not an approved purchase. |
| Rented dedicated GPU Pod | Can measure GPU speed without buying hardware, but a dedicated GPU is **not** by itself an approved private-data boundary. | Vendor, region, isolation, retention, security and data classification require review before any private code is sent. |

Illustrative advertised GPU-only rental totals, not quotations:

| Example | USD/hour | 10 GPU-hours | 730 GPU-hours |
| --- | ---: | ---: | ---: |
| A5000, 24 GB | 0.27 | 2.70 | 197.10 |
| A6000, 48 GB | 0.59 | 5.90 | 430.70 |
| L40S, 48 GB | 1.09 | 10.90 | 795.70 |

These are starting rates from a page with Community/Secure Cloud options;
the retrieved text does not establish a secure-tier quote or available stock.
Storage, persistent volumes, stopped-Pod storage, bandwidth, taxes, exchange
rates and regional/secure-tier differences are extra or unverified. A 730-hour
calculation is an illustration, not a monthly plan or a spending approval.
Lambda's retrieved pricing table did not preserve GPU-name/price alignment
reliably enough to include a competing quote.

**Owner ruling 2026-11-01:** RunPod is not part of the stack ("unstable and
expensive"); the approved compute is the VPS, the laptop GPU, Ollama Cloud and
OpenAI. The RunPod rates above are kept as dated market context only, not as
an option.

## Required controls before a new private endpoint

- Preserve the private-source boundary; review any rented infrastructure as a
  new data processor rather than calling public inference "private".
- Use an owner-controlled private network/Tailscale path, authenticated
  transport, scoped firewall rules and no public Ollama port.
- Keep repository, database and cloud credentials in the control plane, not
  the inference server or model prompt. The model proposes calls; the existing
  guarded control plane executes them.
- Probe installed models/capabilities and enforce measured model/context
  budgets. One local request at a time; do not load author and reviewer
  concurrently simply because both weights fit.
- Record cold/warm latency, total memory, context, exact model/quantisation,
  changed files, check exits and the final source revision.

## Acceptance before changing default routing

Run three independently reset attempts for each of these private tasks:

1. Find a real screen from a plain-language label and make a bounded styling
   change using existing CSS/tokens, preserving schema-backed behaviour.
2. Diagnose and fix a preview-only navigation fault with the same record/context
   intact before, during and after navigation.
3. Resume a deliberately broken draft, use its exact failed-check evidence,
   repair it and rerun the relevant checks without asking the owner for code.

Every attempt must keep protected files and data boundaries intact, leave a
truthful receipt, and refuse an unverified handoff. A passing author needs
type/build checks plus relevant functional/browser evidence and human review of
the intended UX; file counts and model replies do not satisfy acceptance.
Measure warm tool-turn latency as a selection input, not a substitute for
correctness. Do not change default routing on a synthetic greeting alone.
