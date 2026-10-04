import { homedir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import {
	buildEffectiveConfigFromSources,
	parseToolPattern,
	validateSettingsFile,
} from "../extensions/auto-mode.ts";
import {
	baseConfig,
	createFakeCtx,
	setupHookTest,
} from "./test-helpers.ts";

const directAnthropic = {
	provider: "anthropic",
	api: "anthropic-messages",
	id: "claude-sonnet-4-6",
	baseUrl: "https://api.anthropic.com",
};

const beta = "dangerous-tool-use-2026-09-03";
const safeguardType = "dangerous_tool_use";

type HookHarness = Awaited<ReturnType<typeof setupHookTest>>;

async function setupServerAuto(
	mode: "prefer" | "confirm-fallback" = "prefer",
	overrides: {
		ctx?: ReturnType<typeof createFakeCtx>;
		config?: Partial<ReturnType<typeof baseConfig>>;
	} = {},
): Promise<HookHarness> {
	return setupHookTest({
		config: baseConfig({
			anthropicServerAuto: mode,
			...overrides.config,
		}),
		ctx: overrides.ctx ??
			createFakeCtx([], { model: { ...directAnthropic } }),
	});
}

async function request(
	harness: HookHarness,
	payloadOverrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
	const model = harness.ctx.model as { id: string };
	const payload = {
		model: model.id,
		tools: [{ name: "bash", input_schema: {} }],
		betas: ["oauth-2025-04-20", "existing-beta", "existing-beta"],
		...payloadOverrides,
	};
	const result = await harness.emit(
		"before_provider_request",
		{ payload },
		harness.ctx,
	);
	return (result ?? payload) as Record<string, unknown>;
}

async function stream(
	harness: HookHarness,
	data: Record<string, unknown>,
): Promise<void> {
	const model = harness.ctx.model as {
		provider: string;
		api: string;
		id: string;
	};
	await harness.emit("provider_stream_event", {
		provider: model.provider,
		api: model.api,
		model: model.id,
		data,
	}, harness.ctx);
}

async function toolResponse(
	harness: HookHarness,
	toolUseId: string,
	safeguardResults?: unknown,
): Promise<void> {
	await stream(harness, { type: "message_start" });
	await stream(harness, {
		type: "content_block_start",
		content_block: { type: "tool_use", id: toolUseId },
	});
	if (safeguardResults !== undefined) {
		await stream(harness, {
			type: "message_delta",
			delta: { safeguard_results: safeguardResults },
		});
	} else {
		await stream(harness, {
			type: "message_delta",
			delta: { stop_reason: "tool_use" },
		});
	}
	await stream(harness, { type: "message_stop" });
}

function availableResult(
	toolUseId: string,
	outcome: string,
): unknown[] {
	return [{
		type: safeguardType,
		status: {
			type: "available",
			tool_uses: {
				[toolUseId]: { type: "evaluated", outcome },
			},
		},
	}];
}

async function toolCall(
	harness: HookHarness,
	toolCallId: string,
	command = "echo safe",
): Promise<unknown> {
	return harness.emit("tool_call", {
		toolName: "bash",
		toolCallId,
		input: { command },
	}, harness.ctx);
}

async function status(harness: HookHarness): Promise<string> {
	const command = harness.commands.get("automode");
	assert.ok(command);
	await command.handler("status", harness.ctx);
	return harness.ctx.notifications.at(-1)?.message ?? "";
}

async function runtimeStatus(harness: HookHarness): Promise<{
	anthropicServerAuto: string;
	anthropicServerAutoState: string;
	anthropicServerAutoFallback: string;
}> {
	const tool = harness.tools.get("automode_inspect");
	assert.ok(tool);
	const result = await tool.execute(
		"test",
		{ action: "status" },
		undefined,
		() => {},
		harness.ctx,
	);
	return result.details.state;
}

test("server Auto mode is off by default and validates the scalar modes", () => {
	assert.equal(buildEffectiveConfigFromSources({}).anthropicServerAuto, "off");
	assert.equal(
		buildEffectiveConfigFromSources({
			globalSettings: [{ autoMode: { anthropicServerAuto: "prefer" } }],
			projectSharedSettings: [{
				autoMode: { anthropicServerAuto: "confirm-fallback" },
			}],
			projectLocalSettings: [{
				autoMode: { anthropicServerAuto: "confirm-fallback" },
			}],
		}).anthropicServerAuto,
		"confirm-fallback",
	);
	assert.deepEqual(
		validateSettingsFile({
			autoMode: { anthropicServerAuto: { enabled: true } },
		}, "inline"),
		[
			"inline: autoMode.anthropicServerAuto must be off, prefer, or confirm-fallback",
		],
	);
});

test("off leaves direct Anthropic requests unchanged", async () => {
	const harness = await setupHookTest({
		config: baseConfig(),
		ctx: createFakeCtx([], { model: { ...directAnthropic } }),
	});
	const originalBetas = [
		"oauth-2025-04-20",
		"existing-beta",
		"existing-beta",
	];
	const payload = await request(harness, { betas: originalBetas });
	assert.deepEqual(payload.betas, originalBetas);
	assert.equal(payload.safeguards, undefined);
	assert.match(await status(harness), /anthropic server Auto mode: off/);
	assert.match(await status(harness), /runtime state: unknown/);
});

test("request mutation preserves existing arrays and adds only the server capability", async () => {
	const ctx = createFakeCtx([], {
		cwd: process.cwd(),
		model: { ...directAnthropic },
	});
	const harness = await setupServerAuto("prefer", { ctx });
	const cwd = harness.ctx.cwd;
	const existingSafeguard = {
		type: "other_safeguard",
		classifier_context: { source: "provider" },
	};
	const payload = await request(harness, {
		betas: ["oauth-2025-04-20", "existing-beta", "existing-beta"],
		safeguards: [existingSafeguard],
	});
	assert.deepEqual(payload.betas, [
		"oauth-2025-04-20",
		"existing-beta",
		"existing-beta",
		beta,
	]);
	const safeguards = payload.safeguards as Array<Record<string, unknown>>;
	assert.deepEqual(safeguards[0], existingSafeguard);
	const classifierContext = safeguards[1]?.classifier_context as Record<
		string,
		unknown
	>;
	assert.deepEqual(Object.keys(classifierContext).sort(), [
		"auto_mode",
		"home_dir",
		"live_cwd",
		"permission_mode",
		"platform",
		"v",
	]);
	assert.equal(classifierContext.v, 1);
	assert.equal(classifierContext.permission_mode, "auto");
	assert.deepEqual(classifierContext.auto_mode, {
		environment: [],
		allow: [],
		soft_deny: [],
		hard_deny: [],
	});
	assert.equal(classifierContext.live_cwd, cwd);
	assert.equal(classifierContext.home_dir, homedir());
	assert.equal(classifierContext.platform, process.platform);

	const alreadyPresentSafeguard = {
		type: safeguardType,
		classifier_context: {
			extension_context: "preserve",
			permission_mode: "manual",
			v: 0,
			auto_mode: {
				allow: ["stale"],
			},
		},
	};
	const alreadyDecoratedPayload = await request(harness, {
		betas: [beta, "oauth-2025-04-20"],
		safeguards: [existingSafeguard, alreadyPresentSafeguard],
	});
	const alreadyDecoratedBetas = alreadyDecoratedPayload.betas as string[];
	assert.equal(alreadyDecoratedBetas.filter((value) => value === beta).length, 1);
	const alreadyDecoratedSafeguards = alreadyDecoratedPayload.safeguards as Array<
		Record<string, unknown>
	>;
	assert.equal(
		alreadyDecoratedSafeguards.filter((value) =>
			value.type === safeguardType
		).length,
		1,
	);
	assert.deepEqual(alreadyDecoratedSafeguards[0], existingSafeguard);
	const mergedContext = alreadyDecoratedSafeguards[1]
		?.classifier_context as Record<string, unknown>;
	assert.equal(mergedContext.extension_context, "preserve");
	assert.equal(mergedContext.v, 1);
	assert.equal(mergedContext.permission_mode, "auto");
	assert.deepEqual(mergedContext.auto_mode, {
		environment: [],
		allow: [],
		soft_deny: [],
		hard_deny: [],
	});
});

test("direct Anthropic eligibility requires the provider API and supported model floor", async () => {
	const harness = await setupServerAuto();
	for (const model of [
		{ ...directAnthropic, id: "claude-sonnet-4-5" },
		{ ...directAnthropic, provider: "github-copilot" },
		{ ...directAnthropic, api: "openai-completions" },
	]) {
		harness.ctx.model = model;
		const payload = await request(harness);
		assert.equal(payload.safeguards, undefined);
		assert.ok(!(payload.betas as string[]).includes(beta));
	}
	harness.ctx.model = { ...directAnthropic, id: "claude-opus-4-6" };
	const payload = await request(harness);
	assert.ok(Array.isArray(payload.safeguards));

	harness.ctx.model = { ...directAnthropic, id: "claude-fable-5-1" };
	const fablePayload = await request(harness);
	assert.ok(Array.isArray(fablePayload.safeguards));
});

test("a correlated available verdict activates server Auto and skips the local classifier", async () => {
	const harness = await setupServerAuto();
	const payload = await request(harness);
	assert.ok(Array.isArray(payload.safeguards));
	await toolResponse(harness, "tool-1", availableResult("tool-1", "not_flagged"));
	assert.equal(await toolCall(harness, "tool-1"), undefined);
	assert.equal(harness.classifierCalls, 0);
	const runtime = await runtimeStatus(harness);
	assert.equal(runtime.anthropicServerAuto, "prefer");
	assert.equal(runtime.anthropicServerAutoState, "active");
	assert.equal(runtime.anthropicServerAutoFallback, "none");
});

test("malformed unrelated safeguard entries do not poison a valid server decision", async () => {
	const harness = await setupServerAuto();
	await request(harness);
	await toolResponse(harness, "tool-1", [
		{},
		...availableResult("tool-1", "not_flagged"),
	]);
	assert.equal(await toolCall(harness, "tool-1"), undefined);
	assert.equal(harness.classifierCalls, 0);
	assert.equal((await runtimeStatus(harness)).anthropicServerAutoState, "active");
});

test("multiple tool-use IDs retain their independent server decisions", async () => {
	const harness = await setupServerAuto();
	await request(harness);
	await stream(harness, { type: "message_start" });
	await stream(harness, {
		type: "content_block_start",
		content_block: { type: "tool_use", id: "tool-pass" },
	});
	await stream(harness, {
		type: "content_block_start",
		content_block: { type: "tool_use", id: "tool-block" },
	});
	await stream(harness, {
		type: "message_delta",
		delta: {
			safeguard_results: [{
				type: safeguardType,
				status: {
					type: "available",
					tool_uses: {
						"tool-pass": { type: "evaluated", outcome: "not_flagged" },
						"tool-block": { type: "evaluated", outcome: "flagged" },
					},
				},
			}],
		},
	});
	await stream(harness, { type: "message_stop" });
	assert.equal(await toolCall(harness, "tool-pass"), undefined);
	assert.equal((await toolCall(harness, "tool-block"))?.block, true);
	assert.equal(harness.classifierCalls, 0);
});

test("a tool response without safeguard results makes the session unsupported and prefer falls back once", async () => {
	const harness = await setupServerAuto();
	await request(harness);
	await toolResponse(harness, "tool-1");
	assert.equal((await runtimeStatus(harness)).anthropicServerAutoState, "probing");
	assert.equal(await toolCall(harness, "tool-1"), undefined);
	assert.equal((await runtimeStatus(harness)).anthropicServerAutoState, "unsupported");
	const nextPayload = await request(harness);
	assert.equal(nextPayload.safeguards, undefined);
	assert.ok(!(nextPayload.betas as string[]).includes(beta));
	assert.equal(harness.classifierCalls, 1);
	assert.equal((await runtimeStatus(harness)).anthropicServerAutoFallback, "local-approved");
});

test("probing responses with no target safeguard material become unsupported and fall back", async (t) => {
	const cases: Array<[string, unknown]> = [
		["empty results", []],
		["unrelated safeguard", [{
			type: "future_safeguard",
			status: { type: "available" },
		}]],
		["malformed unrelated entry", [{}]],
	];

	for (const [name, results] of cases) {
		await t.test(name, async () => {
			const harness = await setupServerAuto();
			await request(harness);
			await toolResponse(harness, "tool-1", results);
			assert.equal(
				(await runtimeStatus(harness)).anthropicServerAutoState,
				"probing",
			);
			assert.equal(await toolCall(harness, "tool-1"), undefined);
			const runtime = await runtimeStatus(harness);
			assert.equal(runtime.anthropicServerAutoState, "unsupported");
			assert.equal(runtime.anthropicServerAutoFallback, "local-approved");
			assert.equal(harness.classifierCalls, 1);
		});
	}
});

test("an eligible request that cannot be decorated fails closed without fallback", async () => {
	const harness = await setupServerAuto("prefer");
	const payload = await request(harness, { betas: "not-an-array" });
	assert.equal(payload.betas, "not-an-array");
	assert.equal(payload.safeguards, undefined);
	assert.equal((await toolCall(harness, "tool-1"))?.block, true);
	assert.equal(harness.classifierCalls, 0);
	const runtime = await runtimeStatus(harness);
	assert.equal(runtime.anthropicServerAutoState, "unknown");
	assert.equal(runtime.anthropicServerAutoFallback, "none");
});

test("unavailable or malformed safeguard material blocks the action without demoting a probing session", async (t) => {
	for (const [name, results] of [
		["unavailable status", [{
			type: safeguardType,
			status: { type: "unavailable" },
		}]],
		["unknown status", [{
			type: safeguardType,
			status: { type: "future_status" },
		}]],
		["malformed result", [{
			type: safeguardType,
			status: "not an object",
		}]],
		["malformed envelope", "not an array"],
	] as const) {
		await t.test(name, async () => {
			const harness = await setupServerAuto();
			await request(harness);
			await toolResponse(harness, "tool-1", results);
			assert.equal((await toolCall(harness, "tool-1"))?.block, true);
			assert.equal(harness.classifierCalls, 0);
			const runtime = await runtimeStatus(harness);
			assert.equal(runtime.anthropicServerAutoState, "probing");
			assert.equal(runtime.anthropicServerAutoFallback, "none");
		});
	}
});

test("confirm-fallback asks once, then uses the local classifier for the session", async () => {
	const harness = await setupServerAuto("confirm-fallback");
	let confirmations = 0;
	harness.ctx.ui.confirm = async () => {
		confirmations += 1;
		return true;
	};
	await request(harness);
	await toolResponse(harness, "tool-1");
	assert.equal(await toolCall(harness, "tool-1"), undefined);
	await request(harness);
	assert.equal(await toolCall(harness, "tool-2"), undefined);
	assert.equal(confirmations, 1);
	assert.equal(harness.classifierCalls, 2);
	assert.equal((await runtimeStatus(harness)).anthropicServerAutoFallback, "local-approved");
});

test("confirm-fallback without UI fails closed and remembers the declined choice", async () => {
	const ctx = createFakeCtx([], {
		model: { ...directAnthropic },
		hasUI: false,
	});
	const harness = await setupServerAuto("confirm-fallback", { ctx });
	await request(harness);
	await toolResponse(harness, "tool-1");
	assert.equal((await toolCall(harness, "tool-1"))?.block, true);
	assert.equal((await toolCall(harness, "tool-2"))?.block, true);
	assert.equal(harness.classifierCalls, 0);
	assert.equal((await runtimeStatus(harness)).anthropicServerAutoFallback, "local-declined");
});

test("text-only responses do not mark the session unsupported", async () => {
	const harness = await setupServerAuto();
	await request(harness);
	await stream(harness, { type: "message_start" });
	await stream(harness, { type: "message_delta", delta: { stop_reason: "end_turn" } });
	await stream(harness, { type: "message_stop" });
	assert.equal((await runtimeStatus(harness)).anthropicServerAutoState, "probing");

	await request(harness);
	await toolResponse(harness, "tool-1");
	await toolCall(harness, "tool-1");
	assert.equal((await runtimeStatus(harness)).anthropicServerAutoState, "unsupported");
});

test("locally resolved actions do not infer that the server declined the session", async () => {
	const pattern = parseToolPattern("bash");
	assert.ok(pattern);
	const harness = await setupServerAuto("prefer", {
		config: { permissionAllow: [pattern] },
	});
	await request(harness);
	await toolResponse(harness, "tool-1");
	assert.equal(await toolCall(harness, "tool-1"), undefined);
	assert.equal((await runtimeStatus(harness)).anthropicServerAutoState, "probing");
	assert.equal(harness.classifierCalls, 0);
});

test("active sessions block missing, malformed, and mismatched verdicts without fallback", async (t) => {
	const cases: Array<{
		name: string;
		results?: unknown;
	}> = [
		{ name: "missing" },
		{
			name: "malformed",
			results: [{
				type: safeguardType,
				status: {
					type: "available",
					tool_uses: {
						"tool-2": { type: "evaluated", outcome: "unknown_outcome" },
					},
				},
			}],
		},
		{
			name: "mismatched id",
			results: [{
				type: safeguardType,
				status: {
					type: "available",
					tool_uses: {
						"different-tool": { type: "evaluated", outcome: "not_flagged" },
					},
				},
			}],
		},
		{
			name: "unavailable status",
			results: [{
				type: safeguardType,
				status: { type: "unavailable" },
			}],
		},
		{
			name: "unknown status",
			results: [{
				type: safeguardType,
				status: { type: "future_status" },
			}],
		},
		{
			name: "malformed envelope",
			results: "not an array",
		},
	];

	for (const scenario of cases) {
		await t.test(scenario.name, async () => {
			const harness = await setupServerAuto();
			await request(harness);
			await toolResponse(harness, "tool-1", availableResult("tool-1", "not_flagged"));
			await request(harness);
			await toolResponse(harness, "tool-2", scenario.results);
			assert.equal((await toolCall(harness, "tool-2"))?.block, true);
			assert.equal(harness.classifierCalls, 0);
			assert.equal((await runtimeStatus(harness)).anthropicServerAutoState, "active");
		});
	}
});

test("identical duplicate verdicts are idempotent and conflicting duplicates fail closed", async (t) => {
	await t.test("identical", async () => {
		const harness = await setupServerAuto();
		await request(harness);
		const result = availableResult("tool-1", "not_flagged")[0];
		await toolResponse(harness, "tool-1", [result, result]);
		assert.equal(await toolCall(harness, "tool-1"), undefined);
		assert.equal(harness.classifierCalls, 0);
	});
	await t.test("conflicting", async () => {
		const harness = await setupServerAuto();
		await request(harness);
		await toolResponse(harness, "tool-1", [
			...availableResult("tool-1", "not_flagged"),
			...availableResult("tool-1", "flagged"),
		]);
		assert.equal((await toolCall(harness, "tool-1"))?.block, true);
		assert.equal(harness.classifierCalls, 0);
	});
});

test("/automode reload resets negotiation when its configured mode changes", async () => {
	let config = baseConfig({ anthropicServerAuto: "confirm-fallback" });
	const harness = await setupHookTest({
		loadConfig: () => config,
		ctx: createFakeCtx([], { model: { ...directAnthropic } }),
	});
	harness.ctx.ui.confirm = async () => false;
	await request(harness);
	await toolResponse(harness, "tool-1");
	assert.equal((await toolCall(harness, "tool-1"))?.block, true);
	assert.equal((await runtimeStatus(harness)).anthropicServerAutoFallback, "local-declined");

	config = baseConfig({ anthropicServerAuto: "prefer" });
	const command = harness.commands.get("automode");
	assert.ok(command);
	await command.handler("reload", harness.ctx);
	assert.equal((await runtimeStatus(harness)).anthropicServerAutoState, "unknown");
	assert.equal((await runtimeStatus(harness)).anthropicServerAutoFallback, "none");
	assert.ok(Array.isArray((await request(harness)).safeguards));
	await toolResponse(harness, "tool-2");
	assert.equal(await toolCall(harness, "tool-2"), undefined);
	assert.equal(harness.classifierCalls, 1);
	assert.equal((await runtimeStatus(harness)).anthropicServerAutoFallback, "local-approved");
});

test("flagged verdict and deterministic hard-deny remain authoritative", async () => {
	const harness = await setupServerAuto();
	await request(harness);
	await toolResponse(harness, "tool-1", availableResult("tool-1", "flagged"));
	assert.equal((await toolCall(harness, "tool-1"))?.block, true);
	assert.equal(harness.classifierCalls, 0);

	await request(harness);
	await toolResponse(harness, "tool-2", availableResult("tool-2", "not_flagged"));
	assert.equal((await toolCall(harness, "tool-2", "rm -rf /"))?.block, true);
	assert.equal(harness.classifierCalls, 0);
});

test("an accepted permissions.ask proceeds to the selected server semantic backend", async () => {
	const pattern = parseToolPattern("bash");
	assert.ok(pattern);
	const harness = await setupServerAuto("prefer", {
		config: { permissionAsk: [pattern] },
	});
	let confirmations = 0;
	harness.ctx.ui.confirm = async () => {
		confirmations += 1;
		return true;
	};
	await request(harness);
	await toolResponse(harness, "tool-1", availableResult("tool-1", "not_flagged"));
	assert.equal(await toolCall(harness, "tool-1"), undefined);
	assert.equal(confirmations, 1);
	assert.equal(harness.classifierCalls, 0);
});

test("server state is runtime-only and resets for a new Pi conversation", async () => {
	const harness = await setupServerAuto();
	await request(harness);
	await toolResponse(harness, "tool-1");
	assert.equal(await toolCall(harness, "tool-1"), undefined);
	assert.equal((await runtimeStatus(harness)).anthropicServerAutoState, "unsupported");
	assert.ok(harness.entries.every((entry) =>
		!Object.hasOwn(entry.data ?? {}, "anthropicServerAutoState")
	));

	await harness.emit("session_start", { type: "session_start" }, harness.ctx);
	const runtime = await runtimeStatus(harness);
	assert.equal(runtime.anthropicServerAutoState, "unknown");
	assert.equal(runtime.anthropicServerAutoFallback, "none");
});

test("provider switching keeps Anthropic session state separate from Copilot", async () => {
	const harness = await setupServerAuto();
	await request(harness);
	await toolResponse(harness, "tool-1", availableResult("tool-1", "not_flagged"));

	harness.ctx.model = {
		provider: "github-copilot",
		api: "openai-responses",
		id: "claude-sonnet-4-6",
		baseUrl: "https://api.githubcopilot.com",
	};
	const copilotPayload = await request(harness);
	assert.equal(copilotPayload.safeguards, undefined);
	assert.equal((await runtimeStatus(harness)).anthropicServerAutoState, "unknown");
	assert.equal(await toolCall(harness, "copilot-tool"), undefined);
	assert.equal(harness.classifierCalls, 1);

	harness.ctx.model = { ...directAnthropic };
	const anthropicPayload = await request(harness);
	assert.ok(Array.isArray(anthropicPayload.safeguards));
	await toolResponse(harness, "tool-2", availableResult("tool-2", "not_flagged"));
	assert.equal(await toolCall(harness, "tool-2"), undefined);
	assert.equal(harness.classifierCalls, 1);

	harness.ctx.model = {
		...directAnthropic,
		baseUrl: "https://proxy.anthropic.example",
	};
	assert.ok(Array.isArray((await request(harness)).safeguards));
	assert.equal((await runtimeStatus(harness)).anthropicServerAutoState, "probing");
	harness.ctx.model = { ...directAnthropic };
	assert.equal((await runtimeStatus(harness)).anthropicServerAutoState, "active");
});

test("server context sends policy and only observed context fields", async () => {
	const ctx = createFakeCtx([], {
		cwd: process.cwd(),
		model: { ...directAnthropic },
	});
	const harness = await setupServerAuto("prefer", {
		ctx,
		config: {
			environment: ["trusted environment"],
			allow: ["safe allow"],
			softDeny: ["soft rule"],
			hardDeny: ["hard rule"],
		},
	});
	const payload = await request(harness);
	const safeguards = payload.safeguards as Array<Record<string, unknown>>;
	const classifierContext = safeguards[0]?.classifier_context as Record<
		string,
		unknown
	>;
	assert.deepEqual(Object.keys(classifierContext).sort(), [
		"auto_mode",
		"home_dir",
		"live_cwd",
		"permission_mode",
		"platform",
		"v",
	]);
	assert.deepEqual(classifierContext.auto_mode, {
		environment: ["trusted environment"],
		allow: ["safe allow"],
		soft_deny: ["soft rule"],
		hard_deny: ["hard rule"],
	});
	assert.equal(classifierContext.live_cwd, ctx.cwd);
	assert.equal(classifierContext.home_dir, homedir());
	assert.equal(classifierContext.platform, process.platform);
});
