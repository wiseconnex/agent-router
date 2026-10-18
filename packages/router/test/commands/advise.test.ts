import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { SystemOneRequest } from "@typesafe-ai/sdk";
import {
  executeAdviseFromRequest,
  findDeterministicSelection,
  validateKnownChoice,
  type AdviseRequest,
} from "../../src/commands/advise.js";
import { decideRoute } from "../../src/semantic/decision-engine.js";
import { createSystemOneGatewayClient } from "../../src/semantic/systemone-gateway-client.js";
import type { TypeSafePort } from "../../src/semantic/typesafe-client.js";
import { taskFamilyQuestion } from "../../src/semantic/task-classifier.js";
import { phaseQuestion } from "../../src/semantic/phase-classifier.js";
import { fakeTypeSafe } from "../cli/fixtures.js";

const capabilities = {
  planning: 0.8,
  coding: 0.8,
  debugging: 0.7,
  creativity: 0.6,
  research: 0.6,
};

function baseRequest(overrides: Partial<AdviseRequest> = {}): AdviseRequest {
  return {
    delegationDecided: true,
    task: "Implement the advisory subset.",
    topTierUnlocked: false,
    private: false,
    candidates: [
      {
        opaqueId: "cand_a",
        agent: "cursor",
        modelId: "cursor:grok-4.6",
        launchName: "grok-4.6",
        supportedEfforts: ["low", "medium", "high"],
        capabilities,
      },
      {
        opaqueId: "cand_b",
        agent: "claude-code",
        modelId: "anthropic:claude-sonnet",
        launchName: "sonnet",
        supportedEfforts: ["medium", "high"],
        capabilities,
      },
    ],
    ...overrides,
  };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function choiceAnswer(choice: string, confidence: number, probabilities: Record<string, number>) {
  return { type: "choice" as const, choice, confidence, probabilities };
}

function scoreAnswer(score: number) {
  return {
    type: "score" as const,
    score,
    confidence: 0.8,
    legend: {},
    probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 },
  };
}

function choiceProbabilities(labels: string[], choiceLabel: string): Record<string, number> {
  const probabilities: Record<string, number> = {};
  for (const label of labels) {
    probabilities[label] = label === choiceLabel ? 1 : 0;
  }
  return probabilities;
}

function fixtureHandler(request: SystemOneRequest): Record<string, unknown> {
  if ("route" in request.questions) {
    const ids = Object.keys(
      (request.questions.route as { criteria: Record<string, unknown> }).criteria,
    );
    return {
      route: choiceAnswer("cand_a", 0.9, choiceProbabilities(ids, "cand_a")),
    };
  }
  if ("effort" in request.questions) {
    const labels = Object.keys(
      (request.questions.effort as { criteria: Record<string, unknown> }).criteria,
    );
    return {
      effort: choiceAnswer("medium", 0.9, choiceProbabilities(labels, "medium")),
    };
  }
  const familyLabels = Object.keys(taskFamilyQuestion().criteria);
  const phaseLabels = Object.keys(phaseQuestion().criteria);
  return {
    family: choiceAnswer("implementation", 0.9, choiceProbabilities(familyLabels, "implementation")),
    phase: choiceAnswer("implementation", 0.9, choiceProbabilities(phaseLabels, "implementation")),
    complexity: scoreAnswer(1),
    creativity: scoreAnswer(0),
    consequence: scoreAnswer(1),
    cacheValue: scoreAnswer(2),
  };
}

describe("router advise command", () => {
  it("skips inference when delegation is not decided", async () => {
    const result = await executeAdviseFromRequest(
      baseRequest({ delegationDecided: false }),
      { env: {} },
    );
    expect(result.code).toBe(0);
    expect(result.json.status).toBe("skipped");
  });

  it("does not treat a blocked top-tier singleton as deterministic", async () => {
    const request = baseRequest({
      candidates: [
        {
          opaqueId: "only",
          agent: "codex",
          modelId: "fixture",
          launchName: "fixture",
          supportedEfforts: ["max"],
          capabilities,
        },
      ],
    });
    expect(findDeterministicSelection(request.candidates, false)).toBeUndefined();
    const decide = vi.fn();
    const result = await executeAdviseFromRequest(request, {
      env: {},
      decideRoute: decide,
    });
    expect(decide).not.toHaveBeenCalled();
    expect(result.code).toBe(2);
    expect(result.json.status).toBe("needs-choice");
    expect(result.json.cause).toBe("gateway-unconfigured");
  });

  it("falls through to inference when a blocked top-tier singleton has a gateway URL", async () => {
    const request = baseRequest({
      candidates: [
        {
          opaqueId: "only",
          agent: "codex",
          modelId: "fixture",
          launchName: "fixture",
          supportedEfforts: ["max"],
          capabilities,
        },
      ],
    });
    const decide = vi.fn(async () => ({ status: "ask-user" as const }));
    const result = await executeAdviseFromRequest(request, {
      env: { MODEL_ROUTER_SYSTEMONE_URL: "http://127.0.0.1:1" },
      createGatewayClient: () => fakeTypeSafe({}),
      decideRoute: decide,
    });
    expect(decide).toHaveBeenCalledOnce();
    expect(result.json.status).toBe("needs-choice");
    expect(result.json.cause).toBe("low-confidence");
  });

  it("returns deterministic top-tier singleton when top tier is unlocked", async () => {
    const request = baseRequest({
      topTierUnlocked: true,
      candidates: [
        {
          opaqueId: "only",
          agent: "codex",
          modelId: "fixture",
          launchName: "fixture",
          supportedEfforts: ["max"],
          capabilities,
        },
      ],
    });
    expect(findDeterministicSelection(request.candidates, true)?.effort).toBe("max");
    const decide = vi.fn();
    const result = await executeAdviseFromRequest(request, {
      env: { MODEL_ROUTER_SYSTEMONE_URL: "http://127.0.0.1:9" },
      decideRoute: decide,
    });
    expect(decide).not.toHaveBeenCalled();
    expect(result.json).toMatchObject({
      status: "deterministic",
      selection: { opaqueId: "only", effort: "max" },
    });
  });

  it("preserves known choice when gateway URL is not loopback", async () => {
    const result = await executeAdviseFromRequest(
      baseRequest({
        knownChoice: {
          opaqueId: "cand_a",
          agent: "cursor",
          modelId: "cursor:grok-4.6",
          launchName: "grok-4.6",
          effort: "medium",
        },
      }),
      { env: { MODEL_ROUTER_SYSTEMONE_URL: "https://api.example.com" } },
    );
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({
      status: "preserved-known",
      cause: "gateway-unavailable",
      selection: { opaqueId: "cand_a", effort: "medium" },
    });
  });

  it("asks for choice when gateway URL is invalid and known choice is absent", async () => {
    const result = await executeAdviseFromRequest(baseRequest(), {
      env: { MODEL_ROUTER_SYSTEMONE_URL: "http://192.168.0.2:8077" },
    });
    expect(result.code).toBe(2);
    expect(result.json.status).toBe("needs-choice");
    expect(result.json.cause).toBe("gateway-unavailable");
  });

  it("preserves known choice when gateway client factory throws", async () => {
    const result = await executeAdviseFromRequest(
      baseRequest({
        knownChoice: {
          opaqueId: "cand_b",
          agent: "claude-code",
          modelId: "anthropic:claude-sonnet",
          launchName: "sonnet",
          effort: "medium",
        },
      }),
      {
        env: { MODEL_ROUTER_SYSTEMONE_URL: "http://127.0.0.1:1" },
        createGatewayClient: () => {
          throw new Error("factory failure");
        },
      },
    );
    expect(result.json).toMatchObject({
      status: "preserved-known",
      cause: "gateway-unavailable",
      selection: { opaqueId: "cand_b", effort: "medium" },
    });
  });

  it("returns deterministic selection for a single candidate and effort", async () => {
    const request = baseRequest({
      candidates: [
        {
          opaqueId: "only",
          agent: "cursor",
          modelId: "cursor:composer-2.5",
          launchName: "composer-2.5",
          supportedEfforts: ["none"],
          capabilities,
        },
      ],
    });
    expect(findDeterministicSelection(request.candidates, false)?.effort).toBe("none");
    const decide = vi.fn();
    const result = await executeAdviseFromRequest(request, {
      env: { MODEL_ROUTER_SYSTEMONE_URL: "http://127.0.0.1:9" },
      decideRoute: decide,
    });
    expect(decide).not.toHaveBeenCalled();
    expect(result.json).toMatchObject({
      status: "deterministic",
      origin: "deterministic",
      selection: { opaqueId: "only", launchName: "composer-2.5", effort: "none" },
    });
  });

  it("does not call the gateway for private tasks", async () => {
    const decide = vi.fn();
    const result = await executeAdviseFromRequest(
      baseRequest({
        private: true,
        knownChoice: {
          opaqueId: "cand_a",
          agent: "cursor",
          modelId: "cursor:grok-4.6",
          launchName: "grok-4.6",
          effort: "medium",
        },
      }),
      { env: { MODEL_ROUTER_SYSTEMONE_URL: "http://127.0.0.1:9" }, decideRoute: decide },
    );
    expect(decide).not.toHaveBeenCalled();
    expect(result.json.status).toBe("preserved-known");
    expect(result.json.cause).toBe("private-no-gateway");
  });

  it("preserves known choice on gateway outage without using engine fallback", async () => {
    const result = await executeAdviseFromRequest(
      baseRequest({
        knownChoice: {
          opaqueId: "cand_b",
          agent: "claude-code",
          modelId: "anthropic:claude-sonnet",
          launchName: "sonnet",
          effort: "medium",
        },
      }),
      {
        env: { MODEL_ROUTER_SYSTEMONE_URL: "http://127.0.0.1:1" },
        createGatewayClient: () => fakeTypeSafe({}),
        decideRoute: async () => ({
          status: "typesafe-unavailable",
          fallback: {
            candidateOpaqueId: "cand_a",
            effort: "low",
            phase: "implementation",
          },
        }),
      },
    );
    expect(result.json).toMatchObject({
      status: "preserved-known",
      selection: { opaqueId: "cand_b", effort: "medium" },
      cause: "gateway-unavailable",
    });
  });

  it("asks for choice when outage has no valid known choice", async () => {
    const result = await executeAdviseFromRequest(baseRequest(), {
      env: { MODEL_ROUTER_SYSTEMONE_URL: "http://127.0.0.1:1" },
      createGatewayClient: () => fakeTypeSafe({}),
      decideRoute: async () => ({ status: "typesafe-unavailable" }),
    });
    expect(result.code).toBe(2);
    expect(result.json.status).toBe("needs-choice");
    expect(result.json.cause).toBe("gateway-unavailable");
  });

  it("maps a valid semantic recommendation literally", async () => {
    const result = await executeAdviseFromRequest(baseRequest(), {
      env: { MODEL_ROUTER_SYSTEMONE_URL: "http://127.0.0.1:1" },
      createGatewayClient: () => fakeTypeSafe({ route: "cand_a", effort: "medium" }),
      decideRoute,
    });
    expect(result.json).toMatchObject({
      status: "selected",
      origin: "recommended",
      selection: {
        opaqueId: "cand_a",
        launchName: "grok-4.6",
        modelId: "cursor:grok-4.6",
        effort: "medium",
      },
    });
  });

  it("rejects an out-of-set route and preserves known choice", async () => {
    const invalidRouteClient: TypeSafePort = {
      calls: [],
      async systemOne(request) {
        if ("route" in request.questions) {
          return {
            model: "fake",
            answers: {
              route: choiceAnswer("cand_outside", 0.99, { cand_outside: 0.99 }),
            },
            usage: { input_tokens: 1, output_tokens: 1 },
          } as never;
        }
        return {
          model: "fake",
          answers: fixtureHandler(request) as never,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    };
    const result = await executeAdviseFromRequest(
      baseRequest({
        knownChoice: {
          opaqueId: "cand_a",
          agent: "cursor",
          modelId: "cursor:grok-4.6",
          launchName: "grok-4.6",
          effort: "low",
        },
      }),
      {
        env: { MODEL_ROUTER_SYSTEMONE_URL: "http://127.0.0.1:1" },
        createGatewayClient: () => invalidRouteClient,
        decideRoute,
      },
    );
    expect(result.json.status).toBe("preserved-known");
    expect(result.json.cause).toBe("invalid-response");
  });

  it("omits unknown projectedRemainingRatio from ranking state", async () => {
    let rankingState: unknown;
    const client: TypeSafePort = {
      calls: [],
      async systemOne(request) {
        if ("route" in request.questions) {
          rankingState = request.state;
        }
        return {
          model: "fixture",
          answers: fixtureHandler(request) as never,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    };
    await executeAdviseFromRequest(
      baseRequest({
        candidates: baseRequest().candidates.map((candidate) => ({
          ...candidate,
          projectedRemainingRatio: undefined,
        })),
      }),
      {
        env: { MODEL_ROUTER_SYSTEMONE_URL: "http://127.0.0.1:1" },
        createGatewayClient: () => client,
        decideRoute,
      },
    );
    const serialized = JSON.stringify(rankingState);
    expect(serialized).not.toContain("projectedRemainingRatio");
  });

  it("runs decideRoute against a native HTTP fixture server", async () => {
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as SystemOneRequest;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            model: "fixture-jev",
            answers: fixtureHandler(body),
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      });
    });
    const port = await listen(server);
    try {
      const result = await executeAdviseFromRequest(baseRequest(), {
        env: { MODEL_ROUTER_SYSTEMONE_URL: `http://127.0.0.1:${port}` },
        createGatewayClient: (url) => createSystemOneGatewayClient({ baseUrl: url }),
        decideRoute,
      });
      expect(result.json.status).toBe("selected");
      expect(result.json.selection?.opaqueId).toBe("cand_a");
    } finally {
      await closeServer(server);
    }
  });
});

describe("known choice validation", () => {
  it("rejects mismatched launch names", () => {
    const request = baseRequest({
      knownChoice: {
        opaqueId: "cand_a",
        agent: "cursor",
        modelId: "cursor:grok-4.6",
        launchName: "wrong-name",
        effort: "medium",
      },
    });
    expect(validateKnownChoice(request).valid).toBe(false);
  });
});
