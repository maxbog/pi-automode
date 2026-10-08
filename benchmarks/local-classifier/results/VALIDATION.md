# Validation performed 2026-10-08

Execution host: Linux x86_64, Node 24.19.0. No access to the user's M5 Pro, no local model
weights or inference endpoint. This document records software validation, **not LLM accuracy
or Apple latency/memory results**.

| Check | Result |
| --- | --- |
| `npm run check`, repository lockfile Pi 0.86.0 | Pass |
| Benchmark source explicit strict TypeScript check | Pass |
| Focused real-transport/production-parser/CLI tests | 7/7 pass on Pi 0.86.0 |
| Temporary Pi 1.1.0 compatibility install, without package/lockfile edits | Repository and benchmark typechecks pass; 7/7 focused tests pass |
| `npm test`, final locked dependencies | 324 tests: 320 pass, 3 skipped, 1 existing failure |
| `npm test`, temporary Pi 1.1.0, before seventh CLI test was added | 323 tests: 319 pass, 3 skipped, same existing failure |
| Existing failing test run alone | Reproduces without importing benchmark code |
| `npm pack --dry-run` | Pass; package content unchanged |
| Production extension/dependency manifest/lockfile diff | None |
| Real model false-approval/denial rates | Not measured |
| M5 Pro p50/p95 and unified memory | Not measured |

Existing failure: `isRootHomeOrSystemPath exempts temp subtrees but keeps temp roots`,
`tests/hard-deny.test.ts:403`, expected protection for `/tmp` returns false on this host.
Neither that test nor the production path logic was changed. Investigating/fixing this separate
security-policy defect is outside this research-only PR. The PR is a draft because the full
suite is not green and Mac model-selection results are still outstanding.

The new focused checks use a loopback mock OpenAI streaming server but Pi's **real** model
registry and production classifier. They verify exact stage token budgets and tools, thinking-off
parameter transport, dangerous fast-stage zero scoring, malformed output blocking, detailed retry,
context overflow before inference, policy-profile differences, and actual CLI output/metadata.
Mock response timing is not evidence of model inference latency.

Temporary Pi 1.1 packages were removed with `npm ci`; the committed dependency versions remain
unchanged. Source is independent of existing feature PRs. Before publishing actual results, run
on the Mac and record full model digest, runtime build, quantization, macOS/power/load state,
profile, reasoning, and corpus/source hashes. Keep real transcripts private; attach redacted
summary tables rather than raw I/O logs.
