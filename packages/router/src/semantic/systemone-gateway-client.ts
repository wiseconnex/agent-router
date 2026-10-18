import type {
  ChoiceQuestion,
  Fetch,
  Questions,
  Question,
  ScoreQuestion,
  SystemOneRequest,
  SystemOneResult,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
import { assertSafeState, createRecordingClient, type TypeSafePort } from "./typesafe-client.js";

export const SYSTEMONE_TYPED_PATH = "/v1/systemone";
export const DEFAULT_SYSTEMONE_GATEWAY_MODEL = "jev-latest";
export const DEFAULT_SYSTEMONE_GATEWAY_TIMEOUT_MS = 10_000;

export class SystemOneGatewayError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SystemOneGatewayError";
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function assertGatewayBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new SystemOneGatewayError("SystemOne gateway base URL is empty");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new SystemOneGatewayError("SystemOne gateway base URL is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SystemOneGatewayError("SystemOne gateway base URL must use http or https");
  }
  const host = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new SystemOneGatewayError(
      "SystemOne gateway base URL must target loopback (127.0.0.1, localhost, or ::1)",
    );
  }
  return `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, "");
}

function isFiniteProbability(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateChoiceAnswer(
  questionName: string,
  question: ChoiceQuestion,
  answer: unknown,
): void {
  if (!answer || typeof answer !== "object" || (answer as { type?: string }).type !== "choice") {
    throw new SystemOneGatewayError(`Answer for "${questionName}" is not a choice response`);
  }
  const { choice, confidence, probabilities } = answer as {
    choice: string;
    confidence: number;
    probabilities: Record<string, number>;
  };
  const labels = Object.keys(question.criteria);
  if (!labels.includes(choice)) {
    throw new SystemOneGatewayError(
      `Answer for "${questionName}" chose "${choice}", which is not among eligible labels`,
    );
  }
  if (!isFiniteProbability(confidence)) {
    throw new SystemOneGatewayError(`Answer for "${questionName}" has invalid confidence`);
  }
  if (!probabilities || typeof probabilities !== "object") {
    throw new SystemOneGatewayError(`Answer for "${questionName}" is missing probabilities`);
  }
  for (const label of labels) {
    if (!(label in probabilities)) {
      throw new SystemOneGatewayError(
        `Answer for "${questionName}" is missing probability for "${label}"`,
      );
    }
    if (!isFiniteProbability(probabilities[label])) {
      throw new SystemOneGatewayError(
        `Answer for "${questionName}" has invalid probability for "${label}"`,
      );
    }
  }
  for (const key of Object.keys(probabilities)) {
    if (!labels.includes(key)) {
      throw new SystemOneGatewayError(
        `Answer for "${questionName}" includes unexpected probability key "${key}"`,
      );
    }
  }
}

function validateScoreAnswer(questionName: string, question: ScoreQuestion, answer: unknown): void {
  if (!answer || typeof answer !== "object" || (answer as { type?: string }).type !== "score") {
    throw new SystemOneGatewayError(`Answer for "${questionName}" is not a score response`);
  }
  const { score, confidence, probabilities } = answer as {
    score: number;
    confidence: number;
    probabilities: Record<string, number>;
  };
  const maxIndex = question.criteria.length - 1;
  if (!Number.isFinite(score) || score < 0 || score > maxIndex) {
    throw new SystemOneGatewayError(
      `Answer for "${questionName}" has score ${String(score)} outside 0..${maxIndex}`,
    );
  }
  if (!isFiniteProbability(confidence)) {
    throw new SystemOneGatewayError(`Answer for "${questionName}" has invalid confidence`);
  }
  if (!probabilities || typeof probabilities !== "object") {
    throw new SystemOneGatewayError(`Answer for "${questionName}" is missing probabilities`);
  }
  const allowedScoreKeys = new Set(
    Array.from({ length: maxIndex + 1 }, (_, index) => String(index)),
  );
  for (let index = 0; index <= maxIndex; index += 1) {
    const key = String(index);
    if (!isFiniteProbability(probabilities[key])) {
      throw new SystemOneGatewayError(
        `Answer for "${questionName}" has invalid probability for score ${key}`,
      );
    }
  }
  for (const key of Object.keys(probabilities)) {
    if (!allowedScoreKeys.has(key)) {
      throw new SystemOneGatewayError(
        `Answer for "${questionName}" includes unexpected probability key "${key}"`,
      );
    }
  }
}

export function validateGatewayAnswers<Q extends Questions>(
  questions: Q,
  answers: Record<string, unknown>,
): void {
  for (const name of Object.keys(questions)) {
    if (!(name in answers)) {
      throw new SystemOneGatewayError(`Gateway response is missing answer for "${name}"`);
    }
    const question = questions[name] as Question;
    const answer = answers[name];
    if (question.type === "choice") {
      validateChoiceAnswer(name, question, answer);
    } else if (question.type === "score") {
      validateScoreAnswer(name, question, answer);
    }
  }
}

export interface SystemOneGatewayClientOptions {
  baseUrl: string;
  defaultModel?: string;
  timeoutMs?: number;
  fetchImpl?: Fetch;
}

function assertPositiveFiniteTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new SystemOneGatewayError(
      `SystemOne gateway timeout must be a positive finite number of milliseconds, got ${String(timeoutMs)}`,
    );
  }
  return timeoutMs;
}

async function withRequestTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ms = assertPositiveFiniteTimeout(timeoutMs);
  const timeoutError = new SystemOneGatewayError(
    `SystemOne gateway request timed out after ${ms}ms`,
  );
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(timeoutError);
      }, ms);
      operation(controller.signal).then(resolve, reject);
    });
  } catch (error) {
    if (error === timeoutError || timedOut || controller.signal.aborted) {
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function createSystemOneGatewayClient(options: SystemOneGatewayClientOptions): TypeSafePort {
  const baseUrl = assertGatewayBaseUrl(options.baseUrl);
  const defaultModel = options.defaultModel ?? DEFAULT_SYSTEMONE_GATEWAY_MODEL;
  const configuredTimeoutMs = assertPositiveFiniteTimeout(
    options.timeoutMs ?? DEFAULT_SYSTEMONE_GATEWAY_TIMEOUT_MS,
  );
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  async function gatewayCall<const Q extends Questions>(
    request: SystemOneRequest<Q>,
  ): Promise<SystemOneResult<Q>> {
    assertSafeState(request.state);
    const body = {
      ...request,
      model: request.model ?? defaultModel,
    };
    const url = `${baseUrl}${SYSTEMONE_TYPED_PATH}`;
    const { response, text } = await withRequestTimeout(configuredTimeoutMs, async (signal) => {
      const init: RequestInit = {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal,
      };
      let response: Response;
      try {
        response = await fetchImpl(url, init);
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        if (error instanceof Error && /redirect/i.test(error.message)) {
          throw new SystemOneGatewayError(`SystemOne gateway refused redirect: ${error.message}`);
        }
        throw new SystemOneGatewayError(
          error instanceof Error ? error.message : "SystemOne gateway request failed",
        );
      }
      const text = await response.text();
      return { response, text };
    });
    if (!response.ok) {
      throw new SystemOneGatewayError(
        `SystemOne gateway returned HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      );
    }
    let parsed: SystemOneResult<Q>;
    try {
      parsed = JSON.parse(text) as SystemOneResult<Q>;
    } catch {
      throw new SystemOneGatewayError("SystemOne gateway returned non-JSON body");
    }
    if (!parsed || typeof parsed !== "object" || !parsed.answers || !parsed.model) {
      throw new SystemOneGatewayError("SystemOne gateway response is missing model or answers");
    }
    validateGatewayAnswers(request.questions, parsed.answers as Record<string, unknown>);
    return parsed;
  }

  return createRecordingClient({ systemOne: gatewayCall as TypeSafeClient["systemOne"] });
}
