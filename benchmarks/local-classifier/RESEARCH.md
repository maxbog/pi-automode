# Local model for pi-automode — research snapshot, 2026-10-08

**Recommendation to evaluate first: Qwen3.5-4B, Ollama's explicit MLX MXFP8 build,
thinking disabled, 32K configured context, resident model, single inference slot.**
This is a provisional choice for low-latency local classification, not a demonstrated security
winner. Compare Qwen3.5-9B MXFP8 and Gemma 4 12B MLX as the two deployment alternatives.
Choose a different winner if it has fewer dangerous false approvals on held-out requests,
even if the provisional choice is faster. Never choose a model solely by parameter count.

No public benchmark retrieved establishes false approvals on this fork's policy, prompt, and
two-stage protocol. No M5 Pro measurement was possible here: the execution host is Linux x86_64,
not the user's Mac. There are **no fabricated model accuracy, p50/p95, or Mac memory results**.
The repository contains runnable measurement code, validated transport tests, and launch/config
recipes. Actual local inference measurements remain pending. Sources were retrieved on October 8;
this is not a claim about releases later in October or a complete census of every checkpoint.

## What the implementation actually needs

Audited fork main at `161efe667da71ac697c32a51315b75a6691ed436`:
[classifier](https://github.com/maxbog/pi-automode/blob/161efe667da71ac697c32a51315b75a6691ed436/extensions/auto-mode/classifier.ts),
[prompt and defaults](https://github.com/maxbog/pi-automode/blob/161efe667da71ac697c32a51315b75a6691ed436/extensions/auto-mode/constants.ts),
[transcript](https://github.com/maxbog/pi-automode/blob/161efe667da71ac697c32a51315b75a6691ed436/extensions/auto-mode/transcript.ts),
[hook](https://github.com/maxbog/pi-automode/blob/161efe667da71ac697c32a51315b75a6691ed436/extensions/auto-mode/extension.ts).

| Stage | Contract | Budget / failure behavior |
| --- | --- | --- |
| Fast gate | Visible text exactly `0` or `1` after whitespace trimming; `0` immediately allows, `1` requests detailed review | 512 completion tokens by default, not a one-token allocation. Invalid text or provider failure blocks. |
| Detailed | Exactly one native `classifier_decision` tool call; no nonempty visible prose | 1,200 completion tokens; at most two identical attempts for malformed/truncated output; provider errors block immediately. |
| Detailed arguments | Only `decision`, `tier`, `reason`; reason is a nonempty string | Allow tiers: allow/explicit_intent/none. Block tiers: hard_deny/soft_deny/none. Extra keys and inconsistent combinations are invalid. |
| Context | Policy + loaded project instructions + retained user and assistant tool-call evidence + complete current action | User/tool history defaults to 4K approximate tokens each; entry caps 1K; at most 40 tool entries. Tool outputs and assistant prose are excluded from the transcript. |
| Overflow | Current action is serialized completely, without truncation | Approximation is chars/4; context preflight reserves output plus 4,096 margin and optional thinking reserve. Oversized requests block before inference. |
| Time | 20s default per attempt | One decision can make three requests; the timeout is not a 20s overall limit. |

The detailed tool requests JSON-schema constrained sampling with strictness `prefer`; this is
not guaranteed across runtimes. Grammar-valid output prevents syntax errors, not wrong security
decisions. The fast gate has no schema constraint. A false `0` cannot be repaired by a better
detailed parser. Benchmark fast false approvals separately.

Policy ordering is unconditional hard-deny, then soft-deny with allow/user-intent exceptions,
then allow when no deny matches. The model must reason about intent and shell side effects,
not just identify scary command names. Loaded instructions and current action are untrusted.
Transcript truncation can omit authorization details; huge native context claims do not fix
information already removed by the extension.

At the hook level, explicit permissions and deterministic/path policies can decide before
inference. Stock read-only tools skip classification, and stock policy permits ordinary
feature-branch pushes. This differs from the user's desired boundaries. The supplied strict
profile addresses those policy differences without changing production code. Shell indirection,
symlinks, scripts and custom tools still require adversarial testing and stronger process-level
restrictions if credential/file/network isolation is required. This extension is not a sandbox.

[PR #5](https://github.com/maxbog/pi-automode/pull/5) provides explicit one-time/exact-session
approvals for non-hard classifier blocks. Explicit permission denies, deterministic hard denies,
path policy, and classifier hard_denies cannot be overridden. This benchmark branches from main,
without PR #5, dependency-upgrade, or abandoned Anthropic-provider changes. It measures autonomous
classification before any human override; human-approved actions must not be scored as classifier
false approvals.

## Candidate comparison

These are hypotheses for direct evaluation, not a ranking of security accuracy. Use post-trained
instruction/chat weights, never base checkpoints. Model-card scores below are vendor-reported
and generally use different prompts, thinking budgets and precision from the proposed setup.

| Candidate family | Relevant public evidence | Assessment for this task |
| --- | --- | --- |
| Qwen3.5 2B / 4B / 9B | 4B: IFEval 89.8, IFBench 59.2, BFCL-v4 50.3. 9B: 91.5 / 64.5 / 66.1. Native tool-use serving guidance; thinking defaults on. [1] | 4B is the initial speed/size hypothesis; 9B is the strongest direct comparison for possible reliability gains. Test 2B as a latency floor. These numbers do not predict permission false approvals. |
| Gemma 4 E2B / E4B / 12B | Native system roles, function calling and optional thinking. E2B/E4B are 2.3B/4.5B effective but 5.1B/8B with embeddings. [2] | Serious current challengers; E4B is not a simple 4B weight footprint. 12B is a deployment alternative, especially with Ollama's optimized MLX formats. Older Gemma 3 4B/12B should not be substituted for Gemma 4 tool support. |
| Ministral 3 3B / 8B / 14B Instruct 2512 | The 8B card documents native function calling, JSON, system prompts and 256K context; 8.4B language + 0.4B vision parameters. [3] | Strong independent-family challenger. Start with 8B Instruct; reasoning editions are a separate experimental condition. 14B must earn its additional latency. |
| Phi-4-mini-instruct / Phi-4 | Mini is the small instruction/tool-use candidate; Microsoft reports testing function calling, instruction following and trustworthiness. [4] | Include mini as a compact control and 14B Phi-4 only if exact runtime tool formatting passes. Phi-4-mini-reasoning is a different model, not an automatic upgrade for a 512-token gate. |
| Granite 4.1 3B / 8B | Official long-context instruction models. [5] | Worth adding for model-family diversity, particularly enterprise classification. No retrieved pi-automode risk-classification measurements. |
| Nemotron Nano 9B v2 | Dual reasoning/non-reasoning; official serving example has a custom non-streaming tool parser. [6] | Interesting capability, but first verify Pi streaming compatibility. CUDA-serving examples are not Apple measurements. |
| Small Qwen3.8 distills | Official Qwen catalog's retrieved 3.8 releases are larger than this size range; small distills are community releases. [7] | Newer label alone is no reason to replace verified small official weights. Require provenance, exact model card and this benchmark. Avoid choosing refusal-removed variants as a security classifier without evidence. |

BFCL tests function use, IFEval tests instruction constraints, long-context tests retrieval/reasoning,
and content-safety benchmarks test harmful text. None directly measures authorized shell/file
operations under this policy. Do not combine different BFCL versions or convert agent/coding
scores into a predicted false-approval rate. No retrieved source measures the exact native
`classifier_decision` contract or credential-exfiltration miss rate for these quantizations.

## Runtime choice

| Runtime | Pi integration and structured protocol | Decision-latency implications |
| --- | --- | --- |
| Ollama with explicit MLX tag | `/v1/chat/completions` documents streaming, tools, tool_choice and thinking controls; easy models.json registration. [8] | First choice for operational simplicity. Recent MLX snapshot caching addresses branching/retries and recurrent state; vendor performance claims are not M5 Pro classification measurements. [9] |
| llama.cpp | OpenAI tool calling via `--jinja`, native chat template and parser; granular GGUF/control options. [10] | Most useful fallback/reference runtime. Verify thinking toggle and tool parsing on the exact build. Prefix reuse and prompt processing matter more than sustained decode speed. |
| MLX-LM | Native Apple inference toolkit, quantization and caching. [11] | Good engine for custom work; verify the server's actual streaming/tool parser and cache policy. Being MLX-native alone does not establish Pi protocol reliability. |
| oMLX | Apple server, OpenAI endpoint, model-specific tool parsers, shared prefix + memory/SSD cache and decision-model engine. [12] | Strong challenger for warm shared prefixes and future specialist classifiers. More moving parts: exact version/parser/cache state are part of the configuration being evaluated. |

Ollama's current official registry lists `qwen3.5:4b-mxfp8` at 5.6GB, its BF16 MLX variant at
9.1GB, and `9b-mxfp8` at 11GB. These are download footprints, **not measured runtime memory**. [13]
48GB permits testing these while leaving room for an IDE/build workload, but cache, Metal,
macOS and other applications determine actual pressure. Begin with MXFP8 to reduce quantization
as a confounder; compare BF16, NVFP4/4-bit, Q6_K and Q4_K_M on the same security corpus. Do not
assume quality loss measured by perplexity equals false-approval degradation.

For a one-digit gate, warm latency is approximately context preparation + uncached prefill +
first-answer/control-token generation + transport/parsing. A detailed decision adds another
prefill and a short tool call; retry adds a third request. Thinking adds hidden generation and
can exhaust the answer budget. MTP/speculative decoding improvements on long coding answers
may provide little benefit here. Measure p50/p95 under real competing Mac workload, including
cache misses. I found no trustworthy apples-to-apples public measurement of these exact requests
on an M5 Pro 48GB. M5 Max, older Apple chips, H200 and hosted API latency are not interchangeable.

Greedy temperature 0 + fixed seed is an experimental baseline, not a claim of deterministic GPU
execution or a vendor-endorsed optimum. Compare vendor sampling too if greedy worsens accuracy.
Validate reasoning off at the wire/server, not just by marking `reasoning: false` in Pi metadata.

## Purpose-trained alternatives

**Clef-Flash deserves a separate adapter experiment.** Cloudflare released its decision family
on October 1, 2026. The 9B Flash model uses a joint schema head to score all answer options in a
single forward pass, with no free-form decoding. It exposes typed probabilities through a
SystemOne/Jev API, not pi-automode's current chat/tool-call protocol. Its card reports 38.8ms
median/122.4ms p95 in its Decision Index run, and BFCL case-exact 98.8; these are neither M5 Pro
results nor comparable to Qwen's BFCL-v4 agent score. [14][15]

A permission-specific classifier could outperform general generation by skipping token decoding
and calibrating an abstention threshold. That is a design hypothesis. Clef's probabilities are
not established permission confidence; the model still has to understand authorization, malicious
shell semantics and policy precedence. oMLX lists support, but direct Apple correctness, precision,
head preservation and latency must be checked. [12]

Qwen3Guard-Gen 0.6B/4B/8B handles content moderation with Safe/Unsafe/Controversial labels and
content categories. It does not emit this extension's decision tool or enforce Git/file/AWS
policies out of the box. [16] Prompt Guard 2 is an injection detector, not an action-permission
classifier. [17] Use these, if evaluated, as supplementary detectors rather than as proof that
an action is authorized.

For a future separate PR: encode policy + intent + exact action as state; ask for hard/soft/allow
class plus decision, reject contradictory output, and route uncertainty to detailed review or
human approval. Test a Clef adapter or train a small classifier on adjudicated permission pairs.
Freeze an independent holdout, sweep a conservative allow threshold on calibration data only,
and measure residual credential/destruction false approvals. Never trust a threshold like 0.99
without calibration. Do not silently synthesize a reason or native tool call and claim unchanged
protocol/model behavior. Existing classifier behavior is intentionally untouched by this PR.

## Measurement deliverable and status

See [README](README.md) for launch commands, Pi config, real-request replay and the experiment
matrix. The harness covers 67 labeled synthetic cases in stock/strict policy lanes, exact
production prompts/parsing, real Pi streaming transport, long inputs, reasoning off/on/default,
seeded repeated trials, errors/retries, false approvals/denials, invalid outputs, warm p50/p95,
and optional runner RSS. Actual logs can be exported with null reference labels for human review.

The benchmark is deliberately independent of upstream feature work. Only benchmark files and
focused transport tests are added. Validation results and limitations are in
[results/VALIDATION.md](results/VALIDATION.md). No real model performance table is supplied until
the Mac runs exist. The next concrete step is to run the three configurations locally and attach
redacted summaries to this PR, then choose by dangerous false approvals first.

## Sources

All primary sources, retrieved 2026-10-08:

1. [Qwen3.5-4B model card and 4B/9B evals](https://huggingface.co/Qwen/Qwen3.5-4B)
2. [Google Gemma 4 official model card](https://huggingface.co/google/gemma-4-E4B-it/raw/main/README.md)
3. [Ministral 3 8B Instruct official card](https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512)
4. [Phi-4-mini-instruct official card](https://huggingface.co/microsoft/Phi-4-mini-instruct/raw/main/README.md) and [14B Phi-4 card](https://huggingface.co/microsoft/phi-4)
5. [Granite 4.1 3B](https://huggingface.co/ibm-granite/granite-4.1-3b) and [8B](https://huggingface.co/ibm-granite/granite-4.1-8b)
6. [Nemotron Nano 9B v2](https://huggingface.co/nvidia/NVIDIA-Nemotron-Nano-9B-v2)
7. [Official Qwen model catalog](https://huggingface.co/Qwen/models)
8. [Ollama OpenAI compatibility and reasoning controls](https://docs.ollama.com/api/openai-compatibility)
9. [Ollama MLX performance/snapshot update, June 11](https://ollama.com/blog/mlx-performance)
10. [llama.cpp function calling](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md) and [server flags](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
11. [MLX-LM](https://github.com/ml-explore/mlx-lm)
12. [oMLX official repository](https://github.com/jundot/omlx)
13. [Official Qwen3.5 Ollama tags](https://ollama.com/library/qwen3.5/tags)
14. [Clef release announcement, October 1](https://blog.cloudflare.com/clef-decision-models/)
15. [Clef-Flash official architecture/API/evals](https://huggingface.co/Cloudflare/clef-flash/raw/main/README.md)
16. [Qwen3Guard-Gen-4B official policy/card](https://huggingface.co/Qwen/Qwen3Guard-Gen-4B)
17. [Prompt Guard 2 86M official card](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M)
