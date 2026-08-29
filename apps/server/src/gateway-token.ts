import { createHmac, timingSafeEqual } from "node:crypto";
import type { RunPolicy } from "./types.js";

export interface GatewayTokenClaims {
  version: 1;
  policyId: string;
  runId: string;
  agentId: string;
  expiresAt: number;
}

function signature(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function mintGatewayToken(policy: RunPolicy, secret: string): string {
  if (secret.length < 32) throw new Error("Ark gateway signing secret must contain at least 32 characters");
  const expiresAt = Math.floor(Date.parse(policy.expiresAt) / 1_000);
  if (!Number.isSafeInteger(expiresAt)) throw new Error("Run policy has an invalid gateway expiry");
  const claims: GatewayTokenClaims = {
    version: 1,
    policyId: policy.id,
    runId: policy.runId,
    agentId: policy.agentId,
    expiresAt,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return payload + "." + signature(payload, secret).toString("base64url");
}

export function verifyGatewayToken(
  token: string,
  secret: string,
  currentTimeMs = Date.now(),
): GatewayTokenClaims {
  if (secret.length < 32) throw new Error("Ark gateway signing secret is not configured");
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("Invalid Ark gateway token");
  const expected = signature(parts[0], secret);
  let candidate: Buffer;
  try {
    candidate = Buffer.from(parts[1], "base64url");
  } catch {
    throw new Error("Invalid Ark gateway token");
  }
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
    throw new Error("Invalid Ark gateway token");
  }

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid Ark gateway token");
  }
  if (
    typeof claims !== "object" ||
    claims === null ||
    (claims as Partial<GatewayTokenClaims>).version !== 1 ||
    typeof (claims as Partial<GatewayTokenClaims>).policyId !== "string" ||
    typeof (claims as Partial<GatewayTokenClaims>).runId !== "string" ||
    typeof (claims as Partial<GatewayTokenClaims>).agentId !== "string" ||
    !Number.isSafeInteger((claims as Partial<GatewayTokenClaims>).expiresAt)
  ) {
    throw new Error("Invalid Ark gateway token");
  }
  const validated = claims as GatewayTokenClaims;
  if (validated.expiresAt <= Math.floor(currentTimeMs / 1_000)) {
    throw new Error("Ark gateway token has expired");
  }
  return validated;
}
