/**
 * Socket fixture tests — native fetch against ephemeral loopback servers.
 * Not SystemOne live (8077) and not mocked Response objects.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { effortQuestion } from "../../src/semantic/effort-selector.js";
import { routeQuestion } from "../../src/semantic/route-ranker.js";
import { taskFamilyQuestion } from "../../src/semantic/task-classifier.js";
import { complexityQuestion } from "../../src/semantic/task-scorer.js";
import {
  createSystemOneGatewayClient,
  SystemOneGatewayError,
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

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function familyProbabilities(choiceLabel: string): Record<string, number> {
  const labels = Object.keys(taskFamilyQuestion().criteria);
  const probabilities: Record<string, number> = {};
  for (const label of labels) {
    probabilities[label] = label === choiceLabel ? 1 : 0;
  }
  return probabilities;
}

describe("socket fixture — HTTP contract negatives", () => {
  let redirectTargetHits = 0;
  let redirectTarget: http.Server;
  let redirectSource: http.Server;
  let redirectSourcePort = 0;

  beforeAll(async () => {
    redirectTarget = http.createServer((_request, response) => {
      redirectTargetHits += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "fixture",
          answers: {
            family: {
              type: "choice",
              choice: "implementation",
              confidence: 1,
              probabilities: { implementation: 1 },
            },
          },
        }),
      );
    });
    const targetPort = await listen(redirectTarget);

    redirectSource = http.createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(307, {
          location: `http://127.0.0.1:${targetPort}/not-configured`,
        });
        response.end();
      });
    });
    redirectSourcePort = await listen(redirectSource);
  });

  afterAll(async () => {
    await Promise.all([closeServer(redirectSource), closeServer(redirectTarget)]);
  });

  it("rejects choice answers with incomplete probability maps", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "fixture",
          answers: {
            family: {
              type: "choice",
              choice: "implementation",
              confidence: 1,
              probabilities: {},
            },
          },
        }),
      );
    });
    const port = await listen(server);
    const client = createSystemOneGatewayClient({ baseUrl: `http://127.0.0.1:${port}` });
    await expect(
      client.systemOne({
        state: { synthetic: "empty-choice" },
        questions: { family: taskFamilyQuestion() },
      }),
    ).rejects.toThrow(/missing probability/i);
    await closeServer(server);
  });

  it("rejects score answers with out-of-range probability keys", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "fixture",
          answers: {
            complexity: {
              type: "score",
              score: 1,
              confidence: 1,
              legend: {},
              probabilities: { 0: 0, 1: 1, 2: 0, 3: 0, 99: 0.5 },
            },
          },
        }),
      );
    });
    const port = await listen(server);
    const client = createSystemOneGatewayClient({ baseUrl: `http://127.0.0.1:${port}` });
    await expect(
      client.systemOne({
        state: { synthetic: "extra-score" },
        questions: { complexity: complexityQuestion() },
      }),
    ).rejects.toThrow(/unexpected probability key/i);
    await closeServer(server);
  });

  it("closes the stalled HTTP response when the deadline fires, before test cleanup", async () => {
    let cleanupStarted = false;
    let responseClosedBeforeCleanup = false;
    let stalledResponse: http.ServerResponse | undefined;
    const server = http.createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        stalledResponse = response;
        response.on("close", () => {
          responseClosedBeforeCleanup = !cleanupStarted;
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.flushHeaders();
      });
    });
    const port = await listen(server);
    const client = createSystemOneGatewayClient({
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 30,
    });
    try {
      await expect(
        client.systemOne({
          state: { synthetic: "timeout-cancellation" },
          questions: { family: taskFamilyQuestion() },
        }),
      ).rejects.toThrow(/timed out/i);
      await new Promise<void>((resolve) => {
        const witness = setTimeout(resolve, 150);
        stalledResponse!.once("close", () => {
          clearTimeout(witness);
          resolve();
        });
      });
      expect(responseClosedBeforeCleanup).toBe(true);
    } finally {
      cleanupStarted = true;
      await closeServer(server);
    }
  });

  it("times out while the response body is still streaming", async () => {
    const server = http.createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        const payload = {
          model: "fixture",
          answers: {
            family: {
              type: "choice",
              choice: "implementation",
              confidence: 1,
              probabilities: familyProbabilities("implementation"),
            },
          },
        };
        response.writeHead(200, { "content-type": "application/json" });
        response.flushHeaders();
        setTimeout(() => response.end(JSON.stringify(payload)), 250);
      });
    });
    const port = await listen(server);
    const client = createSystemOneGatewayClient({
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 30,
    });
    const start = performance.now();
    await expect(
      client.systemOne({
        state: { synthetic: "slow-body" },
        questions: { family: taskFamilyQuestion() },
      }),
    ).rejects.toThrow(/timed out/i);
    expect(performance.now() - start).toBeLessThan(150);
    await closeServer(server);
  });

  it("does not follow redirects to an unconfigured destination", async () => {
    redirectTargetHits = 0;
    const client = createSystemOneGatewayClient({
      baseUrl: `http://127.0.0.1:${redirectSourcePort}`,
      timeoutMs: 500,
    });
    await expect(
      client.systemOne({
        state: { synthetic: "redirect" },
        questions: { family: taskFamilyQuestion() },
      }),
    ).rejects.toThrow(SystemOneGatewayError);
    expect(redirectTargetHits).toBe(0);
  });
});

describe("socket fixture — classification, ranking, and effort positives", () => {
  it("accepts a full classification answer over native HTTP", async () => {
    const posts: unknown[] = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        posts.push(JSON.parse(body));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            model: "fixture-classify",
            answers: {
              family: {
                type: "choice",
                choice: "implementation",
                confidence: 0.92,
                probabilities: familyProbabilities("implementation"),
              },
            },
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      });
    });
    const port = await listen(server);
    const client = createSystemOneGatewayClient({
      baseUrl: `http://127.0.0.1:${port}`,
      defaultModel: "jev-latest",
    });
    const state = { task: "socket classification positive" };
    const result = await client.systemOne({
      state,
      questions: { family: taskFamilyQuestion() },
      model: "jev-latest",
    });
    expect(posts[0]).toMatchObject({ state, model: "jev-latest" });
    expect(result.model).toBe("fixture-classify");
    expect(result.answers.family.choice).toBe("implementation");
    await closeServer(server);
  });

  it("accepts a ranking answer with eligible opaque IDs over native HTTP", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "fixture-rank",
          answers: {
            route: {
              type: "choice",
              choice: "cand_a",
              confidence: 0.88,
              probabilities: { cand_a: 0.88, cand_b: 0.12 },
            },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
    const port = await listen(server);
    const client = createSystemOneGatewayClient({ baseUrl: `http://127.0.0.1:${port}` });
    const result = await client.systemOne({
      state: { task: "socket ranking positive" },
      questions: { route: routeQuestion(candidates) },
    });
    expect(result.answers.route.choice).toBe("cand_a");
    await closeServer(server);
  });

  it("accepts an effort answer within supported levels over native HTTP", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "fixture-effort",
          answers: {
            effort: {
              type: "choice",
              choice: "medium",
              confidence: 0.9,
              probabilities: { low: 0.05, medium: 0.9, high: 0.05 },
            },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
    const port = await listen(server);
    const client = createSystemOneGatewayClient({ baseUrl: `http://127.0.0.1:${port}` });
    const result = await client.systemOne({
      state: { task: "socket effort positive" },
      questions: { effort: effortQuestion(["low", "medium", "high"], false) },
    });
    expect(result.answers.effort.choice).toBe("medium");
    await closeServer(server);
  });
});

describe("socket fixture — invalid client timeout", () => {
  it("rejects non-positive timeout configuration at client creation", () => {
    expect(() =>
      createSystemOneGatewayClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 0 }),
    ).toThrow(/positive finite/i);
  });
});
