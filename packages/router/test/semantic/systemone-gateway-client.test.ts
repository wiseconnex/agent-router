import { choice, score } from "@typesafe-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { taskFamilyQuestion } from "../../src/semantic/task-classifier.js";
import { phaseQuestion } from "../../src/semantic/phase-classifier.js";
import { complexityQuestion, consequenceQuestion, creativityQuestion } from "../../src/semantic/task-scorer.js";
import { cacheValueQuestion } from "../../src/semantic/cache-assessor.js";
import { routeQuestion } from "../../src/semantic/route-ranker.js";
import { effortQuestion } from "../../src/semantic/effort-selector.js";
import {
  createSystemOneGatewayClient,
  SystemOneGatewayError,
  assertGatewayBaseUrl,
} from "../../src/semantic/systemone-gateway-client.js";
import type { SemanticCandidate } from "../../src/semantic/candidate.js";

const candidates: SemanticCandidate[] = [
  {
    opaqueId: "cand_a",
    agent: "cursor",
    modelId: "cursor:grok",
    supportedEfforts: ["low", "medium", "high"],
    projectedRemainingRatio: 0.7,
    capabilities: { planning: 0.8, coding: 0.8, debugging: 0.7, creativity: 0.6, research: 0.6 },
  },
  {
    opaqueId: "cand_b",
    agent: "claude-code",
    modelId: "anthropic:claude-sonnet",
    supportedEfforts: ["medium", "high"],
    projectedRemainingRatio: 0.5,
    capabilities: { planning: 0.85, coding: 0.8, debugging: 0.8, creativity: 0.7, research: 0.75 },
  },
];

function choiceAnswer(choice: string, confidence: number, probabilities: Record<string, number>) {
  return { type: "choice" as const, choice, confidence, probabilities };
}

function scoreAnswer(score: number, confidence: number, probabilities: Record<string, number>) {
  return { type: "score" as const, score, confidence, legend: {}, probabilities };
}

function fullChoiceProbabilities(
  criteria: Record<string, unknown>,
  selected: string,
  selectedWeight = 0.9,
): Record<string, number> {
  const labels = Object.keys(criteria);
  const remainder =
    labels.length > 1 ? (1 - selectedWeight) / (labels.length - 1) : selectedWeight;
  const probabilities: Record<string, number> = {};
  for (const label of labels) {
    probabilities[label] = label === selected ? selectedWeight : remainder;
  }
  return probabilities;
}

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init ?? {});
  }) as typeof fetch;
}

describe("assertGatewayBaseUrl", () => {
  it("accepts loopback HTTP URLs", () => {
    expect(assertGatewayBaseUrl("http://127.0.0.1:8077")).toBe("http://127.0.0.1:8077");
    expect(assertGatewayBaseUrl("http://localhost:8077/")).toBe("http://localhost:8077");
  });

  it("rejects cloud and non-loopback hosts", () => {
    expect(() => assertGatewayBaseUrl("https://api.typesafe.ai")).toThrow(/loopback/i);
    expect(() => assertGatewayBaseUrl("http://192.168.1.10:8077")).toThrow(/loopback/i);
  });
});

describe("createSystemOneGatewayClient", () => {
  it("POSTs state/questions/model to /v1/systemone on a fixture server", async () => {
    const posts: unknown[] = [];
    const fetchImpl = mockFetch((_url, init) => {
      posts.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          model: "fixture-model",
          answers: {
            family: choiceAnswer(
              "implementation",
              0.9,
              fullChoiceProbabilities(taskFamilyQuestion().criteria, "implementation", 0.9),
            ),
            phase: choiceAnswer(
              "implementation",
              0.88,
              fullChoiceProbabilities(phaseQuestion().criteria, "implementation", 0.88),
            ),
            complexity: scoreAnswer(1, 0.8, { 0: 0.1, 1: 0.7, 2: 0.15, 3: 0.05 }),
            creativity: scoreAnswer(0, 0.85, { 0: 0.85, 1: 0.1, 2: 0.03, 3: 0.02 }),
            consequence: scoreAnswer(1, 0.75, { 0: 0.1, 1: 0.7, 2: 0.15, 3: 0.05 }),
            cacheValue: scoreAnswer(2, 0.7, { 0: 0.05, 1: 0.1, 2: 0.7, 3: 0.15 }),
          },
          usage: { input_tokens: 2, output_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = createSystemOneGatewayClient({
      baseUrl: "http://127.0.0.1:39999",
      defaultModel: "jev-latest",
      fetchImpl,
      timeoutMs: 2_000,
    });
    const state = { task: "synthetic classification fixture", candidateCount: 2 };
    const result = await client.systemOne({
      state,
      questions: {
        family: taskFamilyQuestion(),
        phase: phaseQuestion(),
        complexity: complexityQuestion(),
        creativity: creativityQuestion(),
        consequence: consequenceQuestion(),
        cacheValue: cacheValueQuestion(),
      },
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ state, model: "jev-latest" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:39999/v1/systemone",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.answers.family.choice).toBe("implementation");
    expect(client.calls).toHaveLength(1);
  });

  it("validates ranking choices against eligible opaque IDs", async () => {
    const fetchImpl = mockFetch(() =>
      new Response(
        JSON.stringify({
          model: "fixture-model",
          answers: {
            route: choiceAnswer("not_eligible", 0.9, { not_eligible: 1 }),
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createSystemOneGatewayClient({
      baseUrl: "http://127.0.0.1:39998",
      fetchImpl,
    });
    await expect(
      client.systemOne({
        state: { task: "ranking fixture" },
        questions: { route: routeQuestion(candidates) },
      }),
    ).rejects.toThrow(SystemOneGatewayError);
  });

  it("validates effort choices against supported efforts", async () => {
    const fetchImpl = mockFetch(() =>
      new Response(
        JSON.stringify({
          model: "fixture-model",
          answers: {
            effort: choiceAnswer("ultra", 0.9, { low: 0.1, medium: 0.1, ultra: 0.8 }),
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createSystemOneGatewayClient({
      baseUrl: "http://127.0.0.1:39997",
      fetchImpl,
    });
    await expect(
      client.systemOne({
        state: { task: "effort fixture" },
        questions: { effort: effortQuestion(["low", "medium"], false) },
      }),
    ).rejects.toThrow(/effort/i);
  });

  it("rejects choice answers with empty probability maps (unit)", async () => {
    const fetchImpl = mockFetch(() =>
      new Response(
        JSON.stringify({
          model: "fixture-model",
          answers: {
            family: choiceAnswer("implementation", 1, {}),
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createSystemOneGatewayClient({
      baseUrl: "http://127.0.0.1:39992",
      fetchImpl,
    });
    await expect(
      client.systemOne({
        state: "empty probabilities",
        questions: { family: taskFamilyQuestion() },
      }),
    ).rejects.toThrow(/missing probability/i);
  });

  it("rejects invalid score confidence and missing answers", async () => {
    const fetchImpl = mockFetch(() =>
      new Response(
        JSON.stringify({
          model: "fixture-model",
          answers: {
            complexity: scoreAnswer(1, Number.NaN, { 0: 0, 1: 1, 2: 0, 3: 0 }),
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createSystemOneGatewayClient({
      baseUrl: "http://127.0.0.1:39996",
      fetchImpl,
    });
    await expect(
      client.systemOne({
        state: "score negative",
        questions: { complexity: complexityQuestion() },
      }),
    ).rejects.toThrow(/confidence/i);

    const missing = mockFetch(() =>
      new Response(
        JSON.stringify({
          model: "fixture-model",
          answers: {},
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const clientMissing = createSystemOneGatewayClient({
      baseUrl: "http://127.0.0.1:39995",
      fetchImpl: missing,
    });
    await expect(
      clientMissing.systemOne({
        state: "missing answer",
        questions: { pick: choice("Pick one", { a: "A", b: "B" }) },
      }),
    ).rejects.toThrow(/missing/i);
  });

  it("surfaces HTTP errors and timeouts without picking a fallback candidate", async () => {
    const outage = createSystemOneGatewayClient({
      baseUrl: "http://127.0.0.1:39994",
      fetchImpl: mockFetch(() => new Response("down", { status: 503 })),
    });
    await expect(
      outage.systemOne({
        state: "outage",
        questions: { pick: choice("Pick", { a: "A" }) },
      }),
    ).rejects.toThrow(/503/i);

    const slow = createSystemOneGatewayClient({
      baseUrl: "http://127.0.0.1:39993",
      timeoutMs: 20,
      fetchImpl: mockFetch(
        () =>
          new Promise(() => {
            /* never resolves */
          }),
      ),
    });
    await expect(
      slow.systemOne({
        state: "timeout",
        questions: { pick: choice("Pick", { a: "A" }) },
      }),
    ).rejects.toThrow(/timed out/i);
  });
});
