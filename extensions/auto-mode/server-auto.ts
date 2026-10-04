import { homedir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AnthropicServerAutoFallbackDecision,
  AnthropicServerAutoState,
  EffectiveConfig,
} from "./types.ts";

const ANTHROPIC_SERVER_AUTO_BETA = "dangerous-tool-use-2026-09-03";
const ANTHROPIC_SERVER_AUTO_SAFEGUARD = "dangerous_tool_use";

type RecordValue = Record<string, unknown>;

type ServerAutoReview = "passed" | "blocked" | "indeterminate";

type ServerAutoStatus = {
  state: AnthropicServerAutoState;
  fallbackDecision: AnthropicServerAutoFallbackDecision;
};

type AnthropicAutoModeContext = {
  live_cwd: string;
  home_dir: string;
  platform: string;
  auto_mode: {
    environment: string[];
    allow: string[];
    soft_deny: string[];
    hard_deny: string[];
  };
};

type ResponseState = {
  modelId: string;
  toolUseIds: Set<string>;
  reviews: Map<string, ServerAutoReview>;
  hasTargetReviewMaterial: boolean;
};

type ConversationState = {
  state: AnthropicServerAutoState;
  fallbackDecision: AnthropicServerAutoFallbackDecision;
  response?: ResponseState;
  pending: Map<string, ServerAutoReview>;
  completedUnreviewedToolIds: Set<string>;
};

function asRecord(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}

function isDirectAnthropicModel(
  model: unknown,
  requestModel?: unknown,
): boolean {
  const candidate = asRecord(model);
  return candidate?.provider === "anthropic" &&
    candidate.api === "anthropic-messages" &&
    typeof candidate.id === "string" &&
    (requestModel === undefined ||
      (typeof requestModel === "string" && candidate.id === requestModel));
}

export function isAnthropicServerAutoEligibleModel(
  model: unknown,
  requestModel?: unknown,
): boolean {
  const candidate = asRecord(model);
  if (!candidate || !isDirectAnthropicModel(candidate, requestModel)) {
    return false;
  }
  const modelId = candidate.id;
  if (typeof modelId !== "string") return false;
  if (/^claude-fable-\d/i.test(modelId)) return true;
  const match = /^claude-(?:sonnet|opus)-(\d+)(?:-(\d+))?(?:-|$)/i.exec(
    modelId,
  );
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 4 || (major === 4 && minor >= 6);
}

function sessionKey(model: unknown): string | undefined {
  const candidate = asRecord(model);
  if (
    candidate?.provider !== "anthropic" ||
    candidate.api !== "anthropic-messages"
  ) {
    return undefined;
  }
  const identity = [
    candidate.provider,
    candidate.api,
    typeof candidate.baseUrl === "string" ? candidate.baseUrl : "",
  ].join("\0");
  return identity;
}

function newConversationState(): ConversationState {
  return {
    state: "unknown",
    fallbackDecision: "none",
    pending: new Map(),
    completedUnreviewedToolIds: new Set(),
  };
}

function setReview(
  target: Map<string, ServerAutoReview>,
  id: string,
  review: ServerAutoReview,
): void {
  const previous = target.get(id);
  target.set(
    id,
    previous === undefined || previous === review ? review : "indeterminate",
  );
}

function decisionForToolUse(value: unknown): ServerAutoReview {
  const toolUse = asRecord(value);
  if (toolUse?.type !== "evaluated") return "indeterminate";
  if (toolUse.outcome === "not_flagged") return "passed";
  if (toolUse.outcome === "flagged") return "blocked";
  return "indeterminate";
}

export function addServerAutoRequestFields(
  payload: unknown,
  autoMode: AnthropicAutoModeContext,
): RecordValue | undefined {
  const body = asRecord(payload);
  if (!body || !Array.isArray(body.tools) || body.tools.length === 0) {
    return undefined;
  }
  if (body.safeguards !== undefined && !Array.isArray(body.safeguards)) {
    return undefined;
  }
  if (
    body.betas !== undefined &&
    (!Array.isArray(body.betas) ||
      !body.betas.every((value) => typeof value === "string"))
  ) {
    return undefined;
  }

  const safeguards = Array.isArray(body.safeguards) ? body.safeguards : [];
  const nextSafeguards = safeguards.slice();
  const safeguardIndex = safeguards.findIndex((entry) =>
    asRecord(entry)?.type === ANTHROPIC_SERVER_AUTO_SAFEGUARD
  );
  const classifierContext = safeguardIndex === -1
    ? {}
    : asRecord(asRecord(safeguards[safeguardIndex])?.classifier_context) ?? {};
  const serverSafeguard = {
    ...(safeguardIndex === -1
      ? {}
      : asRecord(safeguards[safeguardIndex])),
    type: ANTHROPIC_SERVER_AUTO_SAFEGUARD,
    classifier_context: {
      ...classifierContext,
      v: 1,
      permission_mode: "auto",
      live_cwd: autoMode.live_cwd,
      home_dir: autoMode.home_dir,
      platform: autoMode.platform,
      auto_mode: autoMode.auto_mode,
    },
  };
  if (safeguardIndex === -1) {
    nextSafeguards.push(serverSafeguard);
  } else {
    nextSafeguards[safeguardIndex] = serverSafeguard;
  }

  const betas = Array.isArray(body.betas) ? body.betas : [];
  const nextBetas = betas.includes(ANTHROPIC_SERVER_AUTO_BETA)
    ? betas
    : [...betas, ANTHROPIC_SERVER_AUTO_BETA];
  return {
    ...body,
    betas: nextBetas,
    safeguards: nextSafeguards,
  };
}

export class AnthropicServerAutoSession {
  private readonly conversations = new Map<string, ConversationState>();
  private activeKey: string | undefined;

  private findConversation(model: unknown): ConversationState | undefined {
    const key = sessionKey(model);
    return key ? this.conversations.get(key) : undefined;
  }

  private ensureConversation(key: string): ConversationState {
    let conversation = this.conversations.get(key);
    if (!conversation) {
      conversation = newConversationState();
      this.conversations.set(key, conversation);
    }
    return conversation;
  }

  status(model: unknown): ServerAutoStatus {
    const conversation = this.findConversation(model);
    return conversation
      ? {
        state: conversation.state,
        fallbackDecision: conversation.fallbackDecision,
      }
      : { state: "unknown", fallbackDecision: "none" };
  }

  beginResponse(model: unknown): void {
    const key = sessionKey(model);
    const candidate = asRecord(model);
    if (!key || typeof candidate?.id !== "string") return;
    const conversation = this.ensureConversation(key);
    this.activeKey = key;
    conversation.pending.clear();
    conversation.completedUnreviewedToolIds.clear();
    conversation.response = {
      modelId: candidate.id,
      toolUseIds: new Set(),
      reviews: new Map(),
      hasTargetReviewMaterial: false,
    };
    if (conversation.state === "unknown") {
      conversation.state = "probing";
    }
  }

  observeProviderEvent(event: unknown): boolean {
    const providerEvent = asRecord(event);
    if (
      !providerEvent ||
      providerEvent.provider !== "anthropic" ||
      providerEvent.api !== "anthropic-messages" ||
      typeof providerEvent.model !== "string" ||
      !this.activeKey
    ) {
      return false;
    }
    const conversation = this.conversations.get(this.activeKey);
    const response = conversation?.response;
    if (
      !conversation ||
      !response ||
      response.modelId !== providerEvent.model
    ) return false;
    const data = asRecord(providerEvent.data);
    if (!data) return false;
    const previousState = conversation.state;

    if (data.type === "message_start") {
      response.toolUseIds.clear();
      response.reviews.clear();
      response.hasTargetReviewMaterial = false;
    } else if (data.type === "content_block_start") {
      const contentBlock = asRecord(data.content_block);
      if (
        contentBlock?.type === "tool_use" &&
        typeof contentBlock.id === "string" &&
        contentBlock.id.length > 0
      ) {
        response.toolUseIds.add(contentBlock.id);
      }
    } else if (data.type === "message_delta") {
      const delta = asRecord(data.delta);
      if (delta && Object.hasOwn(delta, "safeguard_results")) {
        if (Array.isArray(delta.safeguard_results)) {
          if (
            this.observeSafeguardResults(
              conversation,
              response,
              delta.safeguard_results,
            )
          ) {
            response.hasTargetReviewMaterial = true;
          }
        } else {
          response.hasTargetReviewMaterial = true;
          for (const id of response.toolUseIds) {
            setReview(response.reviews, id, "indeterminate");
          }
        }
      }
    } else if (data.type === "message_stop") {
      if (
        conversation.state === "probing" &&
        response.toolUseIds.size > 0 &&
        !response.hasTargetReviewMaterial
      ) {
        for (const id of response.toolUseIds) {
          conversation.completedUnreviewedToolIds.add(id);
        }
      }
      for (const [id, review] of response.reviews) {
        setReview(conversation.pending, id, review);
      }
      conversation.response = undefined;
    }
    return conversation.state !== previousState;
  }

  private observeSafeguardResults(
    conversation: ConversationState,
    response: ResponseState,
    values: unknown[],
  ): boolean {
    let sawTarget = false;
    for (const value of values) {
      const result = asRecord(value);
      if (!result || typeof result.type !== "string") continue;
      if (result.type !== ANTHROPIC_SERVER_AUTO_SAFEGUARD) continue;
      sawTarget = true;
      const status = asRecord(result.status);
      if (!status || typeof status.type !== "string") {
        for (const id of response.toolUseIds) {
          setReview(response.reviews, id, "indeterminate");
        }
        continue;
      }
      if (status.type !== "available") {
        for (const id of response.toolUseIds) {
          setReview(response.reviews, id, "indeterminate");
        }
        continue;
      }

      if (conversation.state !== "unsupported") {
        conversation.state = "active";
      }
      const toolUses = asRecord(status.tool_uses);
      for (const id of response.toolUseIds) {
        setReview(
          response.reviews,
          id,
          toolUses && Object.hasOwn(toolUses, id)
            ? decisionForToolUse(toolUses[id])
            : "indeterminate",
        );
      }
    }
    return sawTarget;
  }

  consume(toolUseId: unknown, model: unknown): ServerAutoReview | undefined {
    if (typeof toolUseId !== "string" || toolUseId.length === 0) {
      return undefined;
    }
    const conversation = this.findConversation(model);
    if (!conversation) return undefined;
    const review = conversation.pending.get(toolUseId);
    conversation.pending.delete(toolUseId);
    if (
      conversation.state === "probing" &&
      conversation.completedUnreviewedToolIds.delete(toolUseId)
    ) {
      conversation.state = "unsupported";
    }
    return review;
  }

  setFallbackDecision(
    model: unknown,
    decision: AnthropicServerAutoFallbackDecision,
  ): void {
    const conversation = this.findConversation(model);
    if (!conversation) return;
    if (conversation.fallbackDecision !== "none") return;
    conversation.fallbackDecision = decision;
  }

  clearTurn(): void {
    for (const conversation of this.conversations.values()) {
      conversation.response = undefined;
      conversation.pending.clear();
      conversation.completedUnreviewedToolIds.clear();
    }
    this.activeKey = undefined;
  }

  clear(): void {
    this.conversations.clear();
    this.activeKey = undefined;
  }
}

export function buildAnthropicServerAutoContext(
  config: EffectiveConfig,
  ctx: ExtensionContext,
): AnthropicAutoModeContext {
  return {
    live_cwd: ctx.cwd,
    home_dir: homedir(),
    platform: process.platform,
    auto_mode: {
      environment: [...config.environment],
      allow: [...config.allow],
      soft_deny: [...config.softDeny],
      hard_deny: [...config.hardDeny],
    },
  };
}
