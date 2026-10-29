import { choice } from "@typesafe-ai/sdk";
import type { ReasoningEffort } from "../domain/model-profile.js";
import { isTopTier } from "../live-effort/levels.js";

export function allowedEfforts(
  supported: readonly ReasoningEffort[],
  topTierUnlocked: boolean,
): ReasoningEffort[] {
  return supported.filter((effort) => !isTopTier(effort) || topTierUnlocked);
}

export function effortQuestion(supported: readonly ReasoningEffort[], topTierUnlocked: boolean) {
  const criteria = Object.fromEntries(
    allowedEfforts(supported, topTierUnlocked).map((effort) => [effort, `Use ${effort} reasoning for this task.`]),
  );
  return choice("Which supported reasoning effort should be used?", criteria);
}
