# Local permission-classifier benchmark

This benchmark calls the **production** `defaultClassifyAction`, through Pi's real isolated
`ModelRuntime` / `ModelRegistry` and OpenAI streaming transport. It executes **none** of the
candidate shell commands. It does not load your Pi credentials, extensions, or project config.
Only loopback inference is allowed by default; `--allow-remote` is an explicit opt-in.

Read [the research and recommendation](RESEARCH.md) first. The checked-in 67 cases are
hand-labeled synthetic requests shaped like actual Pi tool inputs, not captured user sessions.
Review their reference labels before drawing conclusions. Four cases expand into long inputs in
`lib.ts`; the corpus hash plus source commit identifies the exact test set.

## Ollama + MLX on macOS

Install the current Ollama build supporting the explicit MLX tags. Download while online:

```sh
ollama pull qwen3.5:4b-mxfp8
ollama pull qwen3.5:9b-mxfp8
ollama pull gemma4:12b-mlx
```

The explicit tags select MLX; an unsuffixed `4b` tag is not proof of the backend. As of
2026-10-08 the registry lists these tags. Record the full digest and runtime version because
tags can move. `mxfp8` is an 8-bit floating weight format; it is not GGUF Q8_0 or MLX affine 8-bit.

Keep a dedicated server warm. If a GUI server already owns port 11434, quit it before starting
this foreground instance:

```sh
OLLAMA_HOST=127.0.0.1:11434 OLLAMA_KEEP_ALIVE=-1 OLLAMA_CONTEXT_LENGTH=32768 OLLAMA_NUM_PARALLEL=1 ollama serve
```

On another terminal, from this repository:

```sh
npm ci
ollama --version
ollama show qwen3.5:4b-mxfp8
node --import tsx benchmarks/local-classifier/run.ts \
  --model local-guard/qwen3.5:4b-mxfp8 --profile strict --reasoning off \
  --repeats 3 --warmups 3 --label 'M5 Pro 48GB; record Ollama version + full model digest here' \
  --out benchmarks/local-classifier/results/qwen4-off
```

Repeat with `--reasoning on`, `--reasoning default`, and the other model IDs. Off explicitly
sends `reasoning_effort: "none"`; on sends `"low"`. Check `/api/show` for the model's thinking
capabilities. A Boolean model maps low to enabled; low does not necessarily limit its reasoning
work. Default removes our transport toggles and lets the server choose. Inspect raw usage and
errors: a thinking model can exhaust the 512-token fast budget before producing the digit.

`--pid RUNNER_PID` samples RSS every 100ms and after decisions. For Ollama, supply the model
runner PID, not just the daemon. RSS is an imperfect memory proxy and excludes other processes;
record `ollama ps`, Activity Monitor memory pressure, and swap alongside it. No PID means null
memory measurements. The PID is never killed or modified.

## Pi configuration

Merge `configs/models.ollama.json` into `~/.pi/agent/models.json` (preserve existing providers).
Merge `configs/automode.strict.json` into your trusted global
`~/.pi/agent/extensions/pi-automode/config.json`, or a trusted `.pi/automode.local.json`.
Replace `/worktree` in the example environment with your actual repository/worktree path.
Do not put `autoMode` into the shared `.pi/automode.json`; it cannot configure this policy.
Then `/reload` and `/automode model local-guard/qwen3.5:4b-mxfp8`. Keep Claude/Copilot selected
as the coding agent; only the permission classifier uses the local model.

The strict example **intentionally replaces** the allow list to remove the built-in feature
push exception. Other rule lists keep `$defaults`. It enables read-only classification, disables
the inside-workspace bypass, denies credential file paths, and asks for explicit ordinary Git
push approval. Do not replace an existing user's policy file wholesale. Review merged rules.
Its `classifierReasoningLevel: "low"` resolves to off because the example model metadata has
`reasoning: false`, and `samplingParams.reasoning_effort: "none"` explicitly disables thinking
at the server. `classifierReasoningLevel: "off"` is not accepted by this fork's config parser.
To try reasoning in Pi, set model `reasoning: true` and remove the pinned `none` parameter.

This example was validated through Pi 0.86 and Pi 1.1 real registries and a mock streaming server here;
real macOS inference still needs the same local test. It uses the documented models.json
API. No Pi version bump or Anthropic provider code is included.

## llama.cpp / oMLX

For llama.cpp, use a recent build with Qwen3.5 support, a GGUF with its native template, and
start with Q8_0; compare Q6_K and Q4_K_M only after evaluating security accuracy:

```sh
llama-server -m /absolute/path/to/Qwen3.5-4B-Q8_0.gguf \
  --alias permission-qwen4b --host 127.0.0.1 --port 8080 --ctx-size 32768 \
  --parallel 1 --n-gpu-layers 99 --jinja --chat-template-kwargs '{"enable_thinking":false}'
node --import tsx benchmarks/local-classifier/run.ts \
  --models benchmarks/local-classifier/configs/models.llamacpp.json \
  --model local-guard/permission-qwen4b --thinking-format chat-template \
  --reasoning off --profile strict --out benchmarks/local-classifier/results/llamacpp-q8
```

Check your pinned `llama-server --help` for flags. The `--jinja` tool parser is essential;
returning JSON in assistant content does not satisfy the classifier's tool-call contract.

For oMLX, download `mlx-community/Qwen3.5-4B-8bit` into a `Qwen3.5-4B-8bit` model subdirectory,
run `omlx serve --model-dir ~/models`, and use `configs/models.omlx.json` with
`--thinking-format chat-template`. Confirm the exact model ID at `/v1/models`.
If your oMLX build requires auth, set its API key locally in the supplied models config.
Its model parser must emit structured OpenAI tool calls, not XML in assistant text.
These launch recipes are sourced, not executed on macOS in this environment.

## Output and interpretation

Each `.jsonl` row retains prompts, attempts, usage, errors, decision, and monotonic end-to-end
latency. A `.summary.json` records source SHA, Pi version, effective model/config, corpus/config
hashes, seed, model-build label, false approvals/denials, invalid attempts/requests, request errors,
fast-stage false approvals, p50/p95, family breakdowns, and optional server RSS. Warmups are
excluded. Requests run sequentially in a seeded shuffled order using one cache session.
Latency includes transcript preparation, registry auth, all retries, and parsing; it excludes
actually executing the candidate action and human approval time. Max 20s is per stage/attempt,
not per whole decision; three requests can approach 60s. A context-overflow block makes no
inference request. Use `inferenceFalseApprovalRate` and `inferenceEndToEndMs` for model comparisons;
`noInferenceRequests` and the overall decision metrics retain context-preflight cases separately. Exit code 1 flags any false approval, malformed response, or
request error; false denials are reported but do not alone fail the run.

Selection is lexicographic: dangerous false approvals, especially credential/destructive cases,
then response validity and failure rate, then false denials, then p95 latency and memory. Do not
select by aggregate accuracy. Always report numerator/denominator and unique case count.
Repeated runs measure stability, not new independent security coverage. Zero observed errors
on N independent dangerous cases gives an approximate 95% upper bound of 3/N, not proof of
zero real-world risk. Expand to at least 3,000 independent dangerous held-out cases before
claiming a sub-0.1% false-approval bound; repeated variants are correlated too.

The primary lane deliberately measures the classifier even for calls normally bypassed by the
hook. It is not a full extension-policy benchmark. Explicit ask/deny, protected paths,
deterministic denies, read-only bypass, and PR #5's human overrides have separate hook tests.
A model can fail a credential case while an explicit path deny still protects that file; the
reverse also matters, because stock read-only bypass can skip a capable classifier entirely.

## Real request replay

Enable classifier I/O logging temporarily on a safe test session, then:

```sh
node --import tsx benchmarks/local-classifier/replay.ts /path/to/classifier.jsonl /tmp/replay.json
```

Inspect/redact locally and **manually label** `expected` and `rationale`. Labels remain null until
reviewed; the runner rejects unlabeled cases. Replay preserves the saved system policy, context,
and exact action, so `--profile` does not replace that embedded policy. Keep replay runs separate
from synthetic stock/strict runs. Never use the previous classifier's decision as ground truth.
The benchmark never sends requests to cloud models by default. Raw output may contain private
context; results are ignored by Git. Do not publish those logs without redaction.

For a release evaluation, collect representative actual sessions; split by command family,
repository, and adversarial mechanism into development/calibration/held-out sets. Human label
policy + authorization together, adjudicate disagreements, and freeze held-out labels before
model selection. Include English/Polish intent, authorization scope/revocation, long context,
Unicode/escaping, symlinks, interpreter/file indirection, and unsupported tools. Run under
normal IDE/build load as well as idle, on AC power with the same macOS/power settings. Compare
cold process, warm model/fresh prompt, shared-prefix requests, and cache-evicted requests as
separate strata. This runner covers warm shared-session latency; manage cold/eviction experiments
externally and retain separate result files. Direct execution of commands is never necessary.
