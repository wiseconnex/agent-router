import { readFile } from "node:fs/promises";
import { z } from "zod";
import { AgentIdSchema } from "../domain/ids.js";
import {
  ModelCapabilitiesSchema,
  ReasoningEffortSchema,
  type ReasoningEffort,
} from "../domain/model-profile.js";
import { isTopTier } from "../live-effort/levels.js";
import { decideRoute, type RouteDecisionResult } from "../semantic/decision-engine.js";
import type { SemanticCandidate } from "../semantic/candidate.js";
import {
  assertGatewayBaseUrl,
  createSystemOneGatewayClient,
  DEFAULT_SYSTEMONE_GATEWAY_TIMEOUT_MS,
} from "../semantic/systemone-gateway-client.js";
import type { TypeSafePort } from "../semantic/typesafe-client.js";
import { MODEL_ROUTER_SYSTEMONE_URL_ENV } from "./runtime.js";

export const ADVISE_GATEWAY_TIMEOUT_MS = DEFAULT_SYSTEMONE_GATEWAY_TIMEOUT_MS;

const AdvisoryCandidateSchema = z.object({
  opaqueId: z.string().min(1),
  agent: AgentIdSchema,
  modelId: z.string().min(1),
  launchName: z.string().min(1),
  supportedEfforts: z.array(ReasoningEffortSchema).min(1),
  capabilities: ModelCapabilitiesSchema,
  projectedRemainingRatio: z.number().finite().optional(),
});

const KnownChoiceSchema = z.object({
  opaqueId: z.string().min(1),
  agent: AgentIdSchema,
  modelId: z.string().min(1),
  launchName: z.string().min(1),
  effort: ReasoningEffortSchema,
});

export const AdviseRequestSchema = z.object({
  delegationDecided: z.boolean(),
  task: z.string().min(1),
  candidates: z.array(AdvisoryCandidateSchema).min(1),
  knownChoice: KnownChoiceSchema.optional(),
  topTierUnlocked: z.boolean().default(false),
  private: z.boolean().default(false),
});

export type AdviseRequest = z.infer<typeof AdviseRequestSchema>;
export type AdvisoryCandidate = z.infer<typeof AdvisoryCandidateSchema>;
export type KnownChoice = z.infer<typeof KnownChoiceSchema>;

export type AdviseSelection = {
  opaqueId: string;
  agent: AdviseRequest["candidates"][number]["agent"];
  modelId: string;
  launchName: string;
  effort: ReasoningEffort;
};

export type AdviseResultPayload = {
  ok: boolean;
  status:
    | "skipped"
    | "selected"
    | "deterministic"
    | "preserved-known"
    | "needs-choice";
  origin?: "recommended" | "deterministic" | "known-fallback";
  selection?: AdviseSelection;
  reason: string;
  cause?: string;
};

export interface AdviseDeps {
  env: NodeJS.Dict<string>;
  readFile?: (path: string) => Promise<string>;
  createGatewayClient?: (baseUrl: string) => TypeSafePort;
  decideRoute?: typeof decideRoute;
}

function selectionFromCandidate(
  candidate: AdvisoryCandidate,
  effort: ReasoningEffort,
): AdviseSelection {
  return {
    opaqueId: candidate.opaqueId,
    agent: candidate.agent,
    modelId: candidate.modelId,
    launchName: candidate.launchName,
    effort,
  };
}

function toSemanticCandidates(candidates: AdvisoryCandidate[]): SemanticCandidate[] {
  return candidates.map((candidate) => ({
    opaqueId: candidate.opaqueId,
    agent: candidate.agent,
    modelId: candidate.modelId,
    supportedEfforts: candidate.supportedEfforts,
    capabilities: candidate.capabilities,
    ...(candidate.projectedRemainingRatio !== undefined
      ? { projectedRemainingRatio: candidate.projectedRemainingRatio }
      : {}),
  }));
}

export function findDeterministicSelection(
  candidates: AdvisoryCandidate[],
  topTierUnlocked: boolean,
): AdviseSelection | undefined {
  if (candidates.length !== 1) {
    return undefined;
  }
  const only = candidates[0]!;
  if (only.supportedEfforts.length !== 1) {
    return undefined;
  }
  const effort = only.supportedEfforts[0]!;
  if (isTopTier(effort) && !topTierUnlocked) {
    return undefined;
  }
  return selectionFromCandidate(only, effort);
}

export function validateKnownChoice(
  request: AdviseRequest,
): { valid: true; selection: AdviseSelection } | { valid: false } {
  const known = request.knownChoice;
  if (!known) {
    return { valid: false };
  }
  const candidate = request.candidates.find((item) => item.opaqueId === known.opaqueId);
  if (!candidate) {
    return { valid: false };
  }
  if (
    candidate.agent !== known.agent ||
    candidate.modelId !== known.modelId ||
    candidate.launchName !== known.launchName
  ) {
    return { valid: false };
  }
  if (!candidate.supportedEfforts.includes(known.effort)) {
    return { valid: false };
  }
  if (isTopTier(known.effort) && !request.topTierUnlocked) {
    return { valid: false };
  }
  return { valid: true, selection: selectionFromCandidate(candidate, known.effort) };
}

function preservedKnown(
  selection: AdviseSelection,
  cause: string,
  reason = "Preserved the orchestrator known choice.",
): AdviseResultPayload {
  return {
    ok: true,
    status: "preserved-known",
    origin: "known-fallback",
    selection,
    reason,
    cause,
  };
}

function needsChoice(cause: string, reason = "Manual candidate or effort choice is required."): AdviseResultPayload {
  return {
    ok: false,
    status: "needs-choice",
    reason,
    cause,
  };
}

function mapSelected(
  request: AdviseRequest,
  decision: Extract<RouteDecisionResult, { status: "selected" }>,
): AdviseResultPayload {
  const candidate = request.candidates.find(
    (item) => item.opaqueId === decision.candidateOpaqueId,
  );
  if (!candidate) {
    const known = validateKnownChoice(request);
    if (known.valid) {
      return preservedKnown(known.selection, "invalid-response");
    }
    return needsChoice("invalid-response");
  }
  if (!candidate.supportedEfforts.includes(decision.effort)) {
    const known = validateKnownChoice(request);
    if (known.valid) {
      return preservedKnown(known.selection, "invalid-response");
    }
    return needsChoice("invalid-response");
  }
  if (isTopTier(decision.effort) && !request.topTierUnlocked) {
    const known = validateKnownChoice(request);
    if (known.valid) {
      return preservedKnown(known.selection, "invalid-response");
    }
    return needsChoice("invalid-response");
  }
  return {
    ok: true,
    status: "selected",
    origin: "recommended",
    selection: selectionFromCandidate(candidate, decision.effort),
    reason: "Semantic route recommendation accepted.",
  };
}

function resolveWithoutGateway(
  request: AdviseRequest,
  cause: string,
): AdviseResultPayload {
  const known = validateKnownChoice(request);
  if (known.valid) {
    return preservedKnown(known.selection, cause);
  }
  return needsChoice(cause);
}

function resolveAfterDecisionFailure(
  request: AdviseRequest,
  cause: string,
): AdviseResultPayload {
  const known = validateKnownChoice(request);
  if (known.valid) {
    return preservedKnown(known.selection, cause);
  }
  return needsChoice(cause);
}

export async function executeAdviseFromRequest(
  request: AdviseRequest,
  deps: AdviseDeps,
): Promise<{ output: string; json: AdviseResultPayload; code: number }> {
  if (!request.delegationDecided) {
    const json: AdviseResultPayload = {
      ok: true,
      status: "skipped",
      reason: "ODD delegation was not decided; advisory inference skipped.",
    };
    return { code: 0, json, output: `${JSON.stringify(json)}\n` };
  }

  const deterministic = findDeterministicSelection(
    request.candidates,
    request.topTierUnlocked,
  );
  if (deterministic) {
    const json: AdviseResultPayload = {
      ok: true,
      status: "deterministic",
      origin: "deterministic",
      selection: deterministic,
      reason: "Only one eligible candidate with a single supported effort.",
    };
    return { code: 0, json, output: `${JSON.stringify(json)}\n` };
  }

  const gatewayUrl = deps.env[MODEL_ROUTER_SYSTEMONE_URL_ENV]?.trim();
  if (request.private || !gatewayUrl) {
    const cause = request.private ? "private-no-gateway" : "gateway-unconfigured";
    const json = resolveWithoutGateway(request, cause);
    return { code: json.ok ? 0 : 2, json, output: `${JSON.stringify(json)}\n` };
  }

  const createGateway =
    deps.createGatewayClient ??
    ((url: string) =>
      createSystemOneGatewayClient({ baseUrl: url, timeoutMs: ADVISE_GATEWAY_TIMEOUT_MS }));
  const decide = deps.decideRoute ?? decideRoute;

  let decision: RouteDecisionResult;
  try {
    const baseUrl = assertGatewayBaseUrl(gatewayUrl);
    const client = createGateway(baseUrl);
    decision = await decide({
      task: request.task,
      candidates: toSemanticCandidates(request.candidates),
      topTierUnlocked: request.topTierUnlocked,
      client,
    });
  } catch {
    const json = resolveAfterDecisionFailure(request, "gateway-unavailable");
    return { code: json.ok ? 0 : 2, json, output: `${JSON.stringify(json)}\n` };
  }

  if (decision.status === "selected") {
    const json = mapSelected(request, decision);
    return { code: json.ok ? 0 : 2, json, output: `${JSON.stringify(json)}\n` };
  }

  if (decision.status === "ask-user") {
    const known = validateKnownChoice(request);
    if (known.valid) {
      const json = preservedKnown(
        known.selection,
        "low-confidence",
        "Preserved known choice because the route was ambiguous.",
      );
      return { code: 0, json, output: `${JSON.stringify(json)}\n` };
    }
    const json = needsChoice("low-confidence", "Route confidence requires a manual choice.");
    return { code: 2, json, output: `${JSON.stringify(json)}\n` };
  }

  const cause =
    decision.status === "typesafe-unavailable" ? "gateway-unavailable" : "invalid-response";
  const json = resolveAfterDecisionFailure(request, cause);
  return { code: json.ok ? 0 : 2, json, output: `${JSON.stringify(json)}\n` };
}

export async function executeAdvise(
  requestPath: string,
  deps: AdviseDeps,
): Promise<{ output: string; json: AdviseResultPayload | { ok: false; error: string }; code: number }> {
  let raw: string;
  try {
    raw = deps.readFile
      ? await deps.readFile(requestPath)
      : await readFile(requestPath, "utf8");
  } catch {
    const json = { ok: false as const, error: "Advisory request file could not be read." };
    return { code: 2, json, output: `${JSON.stringify(json)}\n` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const json = { ok: false as const, error: "Advisory request file is not valid JSON." };
    return { code: 2, json, output: `${JSON.stringify(json)}\n` };
  }
  const validated = AdviseRequestSchema.safeParse(parsed);
  if (!validated.success) {
    const json = { ok: false as const, error: "Advisory request failed validation." };
    return { code: 2, json, output: `${JSON.stringify(json)}\n` };
  }
  const result = await executeAdviseFromRequest(validated.data, deps);
  return result;
}
