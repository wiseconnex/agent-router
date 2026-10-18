import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProgram, runCli } from "../../src/cli.js";
import { executeAdvise } from "../../src/commands/advise.js";

function tempRequest(body: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "router-advise-"));
  const file = path.join(dir, "request.json");
  writeFileSync(file, JSON.stringify(body), "utf8");
  return file;
}

const capabilities = {
  planning: 0.8,
  coding: 0.8,
  debugging: 0.7,
  creativity: 0.6,
  research: 0.6,
};

describe("router advise CLI", () => {
  it("registers the advise subcommand in help", async () => {
    let out = "";
    const program = createProgram({
      stdout: {
        write(chunk: string) {
          out += chunk;
          return true;
        },
      },
      env: { MODEL_ROUTER_HOME: mkdtempSync(path.join(os.tmpdir(), "router-cli-")) },
    });
    program.exitOverride();
    try {
      await program.parseAsync(["node", "router", "advise", "--help"]);
    } catch {
      // commander throws after help when exitOverride is set
    }
    expect(out).toMatch(/advise/);
    expect(out).toMatch(/--request/);
  });

  it("invokes advise without loading run dependencies", async () => {
    const requestPath = tempRequest({
      delegationDecided: false,
      task: "noop",
      candidates: [
        {
          opaqueId: "cand",
          agent: "cursor",
          modelId: "cursor:grok-4.6",
          launchName: "grok-4.6",
          supportedEfforts: ["medium"],
          capabilities,
        },
      ],
      topTierUnlocked: false,
    });
    const advise = vi.fn(executeAdvise);
    const createRunDeps = vi.fn();
    let out = "";
    const code = await runCli(["node", "router", "advise", "--request", requestPath], {
      stdout: {
        write(chunk: string) {
          out += chunk;
          return true;
        },
      },
      env: { MODEL_ROUTER_HOME: mkdtempSync(path.join(os.tmpdir(), "router-cli-")) },
      advise,
      createRunDeps,
    });
    expect(code).toBe(0);
    expect(advise).toHaveBeenCalledOnce();
    expect(createRunDeps).not.toHaveBeenCalled();
    expect(JSON.parse(out.trim()).status).toBe("skipped");
  });
});
