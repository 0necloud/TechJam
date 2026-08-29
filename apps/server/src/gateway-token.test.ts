import { describe, expect, it } from "vitest";
import { mintGatewayToken, verifyGatewayToken } from "./gateway-token.js";
import type { RunPolicy } from "./types.js";

const secret = "test-signing-secret-with-at-least-32-characters";

function policy(expiresAt = new Date(Date.now() + 60_000).toISOString()): RunPolicy {
  return {
    id: "policy-1",
    runId: "run-1",
    agentId: "agent-1",
    runtime: "container",
    workspaceAccess: "staging-only",
    sessionAccess: "agent-only",
    networkMode: "ark-gateway",
    createdAt: new Date().toISOString(),
    expiresAt,
    revokedAt: null,
    maxDurationMs: 60_000,
  };
}

describe("Ark gateway Run tokens", () => {
  it("signs the Run identity and expiry without embedding the Ark key", () => {
    const token = mintGatewayToken(policy(), secret);
    const arkApiKey = "real-ark-secret-that-the-token-must-not-contain";
    const claims = verifyGatewayToken(token, secret);
    expect(claims).toMatchObject({
      version: 1,
      policyId: "policy-1",
      runId: "run-1",
      agentId: "agent-1",
    });
    expect(token).not.toContain(arkApiKey);
  });

  it("rejects tampering, expiry, and the wrong signing secret", () => {
    const token = mintGatewayToken(policy(), secret);
    expect(() => verifyGatewayToken(token + "x", secret)).toThrow("Invalid");
    expect(() => verifyGatewayToken(token, "another-signing-secret-with-32-characters")).toThrow("Invalid");
    const expired = mintGatewayToken(policy(new Date(Date.now() - 5_000).toISOString()), secret);
    expect(() => verifyGatewayToken(expired, secret)).toThrow("expired");
  });
});
