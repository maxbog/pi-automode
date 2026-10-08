import test from "node:test";
import assert from "node:assert/strict";
import { baseConfig, createFakeCtx, setupHookTest } from "./test-helpers.ts";

const action = { toolName: "bash", input: { command: "echo interactive-approval-test" } };
const blocked = async () => ({ decision: "block" as const, tier: "soft_deny" as const, reason: "review required" });

function contextWithChoice(choice: string | undefined, options: Record<string, unknown> = {}) {
  const ctx = createFakeCtx([], options);
  const prompts: string[] = [];
  Object.assign(ctx.ui, { select: async (title: string) => {
    prompts.push(title);
    return choice;
  } });
  return { ctx, prompts };
}

test("classifier denial offers an interactive override, defaulting to deny", async () => {
  const { ctx, prompts } = contextWithChoice("Deny");
  const harness = await setupHookTest({ ctx, classifier: blocked });
  const result = await harness.emit("tool_call", action, ctx) as { block: boolean };
  assert.equal(result.block, true);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /review required/);
  assert.equal(harness.classifierCalls, 1);
});

test("allow once overrides only one classifier denial", async () => {
  const { ctx } = contextWithChoice("Allow once");
  const harness = await setupHookTest({ ctx, classifier: blocked });
  assert.equal(await harness.emit("tool_call", action, ctx), undefined);
  assert.equal(await harness.emit("tool_call", action, ctx), undefined);
  assert.equal(harness.classifierCalls, 2);
});

test("session approval matches exact tool input and cwd", async () => {
  const { ctx } = contextWithChoice("Allow this exact action for this session");
  const harness = await setupHookTest({ ctx, classifier: blocked });
  assert.equal(await harness.emit("tool_call", action, ctx), undefined);
  assert.equal(await harness.emit("tool_call", action, ctx), undefined);
  assert.equal(harness.classifierCalls, 1);
  await harness.emit("tool_call", { toolName: "bash", input: { command: "echo different" } }, ctx);
  assert.equal(harness.classifierCalls, 2);
  ctx.cwd = "/tmp/another-project";
  await harness.emit("tool_call", action, ctx);
  assert.equal(harness.classifierCalls, 3);
});

test("hard classifier denials never offer an override", async () => {
  const { ctx, prompts } = contextWithChoice("Allow once");
  const harness = await setupHookTest({
    ctx,
    classifier: async () => ({ decision: "block", tier: "hard_deny", reason: "hard policy" }),
  });
  const result = await harness.emit("tool_call", action, ctx) as { block: boolean };
  assert.equal(result.block, true);
  assert.equal(prompts.length, 0);
});

test("no UI keeps classifier denials blocked", async () => {
  const { ctx, prompts } = contextWithChoice("Allow once", { hasUI: false });
  const harness = await setupHookTest({ ctx, classifier: blocked });
  const result = await harness.emit("tool_call", action, ctx) as { block: boolean };
  assert.equal(result.block, true);
  assert.equal(prompts.length, 0);
});

test("permission denies remain non-overridable", async () => {
  const { ctx, prompts } = contextWithChoice("Allow once");
  const { parseToolPattern } = await import("../extensions/auto-mode.ts");
  const deny = parseToolPattern("bash(echo interactive-approval-test)");
  assert.ok(deny);
  const harness = await setupHookTest({
    ctx,
    config: baseConfig({ permissionDeny: [deny] }),
    classifier: blocked,
  });
  const result = await harness.emit("tool_call", action, ctx) as { block: boolean };
  assert.equal(result.block, true);
  assert.equal(prompts.length, 0);
  assert.equal(harness.classifierCalls, 0);
});
