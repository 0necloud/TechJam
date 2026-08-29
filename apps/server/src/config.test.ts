import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isArkConfigured, loadConfig, writeCodexConfig } from "./config.js";

const roots: string[] = [];
const secret = "test-signing-secret-with-at-least-32-characters";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Ark gateway configuration", () => {
  it("writes the internal gateway URL and does not require the real key in the control plane", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "airlock-gateway-config-"));
    roots.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: root,
      ARK_MODEL: "ep-fixture",
      RUNTIME_NETWORK_MODE: "ark-gateway",
      ARK_GATEWAY_SECRET: secret,
    });
    expect(isArkConfigured(config)).toBe(true);
    expect(config.arkApiKey).toBe("");
    await writeCodexConfig(config);
    const toml = await readFile(path.join(root, "config.toml"), "utf8");
    expect(toml).toContain('base_url = "http://ark-gateway:8080/api/v3"');
    expect(toml).not.toContain("ark.cn-beijing.volces.com");
  });

  it("fails closed for a weak secret or a non-internal gateway URL", () => {
    expect(() => loadConfig({ NODE_ENV: "test", RUNTIME_NETWORK_MODE: "ark-gateway", ARK_GATEWAY_SECRET: "short" })).toThrow("32 characters");
    expect(() => loadConfig({
      NODE_ENV: "test",
      RUNTIME_NETWORK_MODE: "ark-gateway",
      ARK_GATEWAY_SECRET: secret,
      ARK_GATEWAY_URL: "https://example.com/api/v3",
    })).toThrow("internal Runtime network");
  });
});
