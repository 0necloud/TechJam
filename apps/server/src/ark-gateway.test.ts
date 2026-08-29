import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createArkGateway, type ArkGatewayEvent } from "./ark-gateway.js";
import { mintGatewayToken } from "./gateway-token.js";
import type { RunPolicy } from "./types.js";

const signingSecret = "test-signing-secret-with-at-least-32-characters";
const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind TCP");
  return address.port;
}

function token(expiresAt = new Date(Date.now() + 60_000).toISOString()): string {
  const policy: RunPolicy = {
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
  return mintGatewayToken(policy, signingSecret);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("Ark egress gateway", () => {
  it("forwards only Responses API requests and replaces the Run token with the real key", async () => {
    let receivedAuthorization = "";
    let receivedPath = "";
    let receivedBody = "";
    const upstreamPort = await listen(createServer(async (request, response) => {
      receivedAuthorization = request.headers.authorization ?? "";
      receivedPath = request.url ?? "";
      for await (const chunk of request) receivedBody += chunk.toString();
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"id":"response-1"}');
    }));
    const events: ArkGatewayEvent[] = [];
    const gatewayPort = await listen(createArkGateway({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/api/v3`,
      apiKey: "real-ark-key",
      signingSecret,
      pathPrefix: "/api/v3",
      maxRequestBytes: 1_000_000,
      requestTimeoutMs: 5_000,
    }, { onEvent: (event) => events.push(event) }));

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/api/v3/responses?stream=true`, {
      method: "POST",
      headers: { authorization: "Bearer " + token(), "content-type": "application/json" },
      body: '{"model":"fixture"}',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "response-1" });
    expect(receivedAuthorization).toBe("Bearer real-ark-key");
    expect(receivedPath).toBe("/api/v3/responses?stream=true");
    expect(receivedBody).toBe('{"model":"fixture"}');
    expect(events).toContainEqual(expect.objectContaining({
      outcome: "forwarded",
      statusCode: 200,
      runId: "run-1",
      agentId: "agent-1",
      policyId: "policy-1",
    }));
    expect(JSON.stringify(events)).not.toContain("real-ark-key");
    expect(JSON.stringify(events)).not.toContain("fixture");
  });

  it("rejects unrelated paths, invalid tokens, and oversized bodies", async () => {
    const upstreamPort = await listen(createServer((_request, response) => response.end("unexpected")));
    const gatewayPort = await listen(createArkGateway({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/api/v3`,
      apiKey: "real-ark-key",
      signingSecret,
      pathPrefix: "/api/v3",
      maxRequestBytes: 4,
      requestTimeoutMs: 5_000,
    }));
    const unrelated = await fetch(`http://127.0.0.1:${gatewayPort}/api/v3/models`, {
      method: "POST",
      headers: { authorization: "Bearer " + token() },
    });
    expect(unrelated.status).toBe(403);
    const unauthenticated = await fetch(`http://127.0.0.1:${gatewayPort}/api/v3/responses`, { method: "POST" });
    expect(unauthenticated.status).toBe(401);
    const oversized = await fetch(`http://127.0.0.1:${gatewayPort}/api/v3/responses`, {
      method: "POST",
      headers: { authorization: "Bearer " + token() },
      body: "12345",
    });
    expect(oversized.status).toBe(413);
  });
});
