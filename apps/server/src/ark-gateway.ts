import { request as httpRequest } from "node:http";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import { verifyGatewayToken, type GatewayTokenClaims } from "./gateway-token.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);
const CREDENTIAL_HEADERS = new Set(["authorization", "api-key", "x-api-key", "cookie"]);

export interface ArkGatewayConfig {
  upstreamBaseUrl: string;
  apiKey: string;
  signingSecret: string;
  pathPrefix: string;
  maxRequestBytes: number;
  requestTimeoutMs: number;
}

export interface ArkGatewayEvent {
  timestamp: string;
  outcome: "forwarded" | "denied" | "failed";
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  runId?: string;
  agentId?: string;
  policyId?: string;
}

export interface ArkGatewayOptions {
  onEvent?: (event: ArkGatewayEvent) => void;
}

class RequestTooLargeError extends Error {}

function sendJson(response: ServerResponse, statusCode: number, message: string): void {
  if (response.headersSent) return;
  const body = Buffer.from(JSON.stringify({ error: message }) + "\n", "utf8");
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendHealth(response: ServerResponse): void {
  const body = Buffer.from('{"ok":true}\n', "utf8");
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readBoundedBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new RequestTooLargeError();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > maxBytes) throw new RequestTooLargeError();
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

function bearerToken(headers: IncomingHttpHeaders): string | null {
  const value = headers.authorization ?? "";
  return value.startsWith("Bearer ") && value.length > 7 ? value.slice(7) : null;
}

function forwardedHeaders(source: IncomingHttpHeaders, apiKey: string, bodyLength: number): Record<string, string | string[]> {
  const target: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(source)) {
    const lower = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP_HEADERS.has(lower) || CREDENTIAL_HEADERS.has(lower) || lower === "host" || lower === "content-length") continue;
    target[lower] = value;
  }
  target.authorization = "Bearer " + apiKey;
  target["content-length"] = String(bodyLength);
  return target;
}

function copyResponseHeaders(source: IncomingHttpHeaders): Record<string, string | string[]> {
  const target: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== "set-cookie") target[name] = value;
  }
  target["cache-control"] ??= "no-store";
  return target;
}

function normalizePrefix(value: string): string {
  const prefix = "/" + value.replace(/^\/+|\/+$/g, "");
  return prefix === "/" ? "" : prefix;
}

function resolveUpstream(config: ArkGatewayConfig, incoming: URL): URL | null {
  const prefix = normalizePrefix(config.pathPrefix);
  if (!incoming.pathname.startsWith(prefix + "/responses")) return null;
  const suffix = incoming.pathname.slice(prefix.length);
  if (suffix !== "/responses" && !suffix.startsWith("/responses/")) return null;
  const upstream = new URL(config.upstreamBaseUrl.replace(/\/+$/, "") + suffix);
  upstream.search = incoming.search;
  return upstream;
}

function claimFields(claims: GatewayTokenClaims | null): Pick<ArkGatewayEvent, "runId" | "agentId" | "policyId"> | Record<string, never> {
  return claims ? { runId: claims.runId, agentId: claims.agentId, policyId: claims.policyId } : {};
}

export function createArkGateway(config: ArkGatewayConfig, options: ArkGatewayOptions = {}): Server {
  const upstreamBase = new URL(config.upstreamBaseUrl);
  if (upstreamBase.protocol !== "https:" && upstreamBase.protocol !== "http:") throw new Error("Ark upstream URL must use HTTP or HTTPS");
  if (upstreamBase.username || upstreamBase.password || upstreamBase.search || upstreamBase.hash) throw new Error("Ark upstream URL cannot contain credentials, a query, or a fragment");
  if (!config.apiKey || config.apiKey.startsWith("replace-")) throw new Error("Ark gateway API key is not configured");
  if (config.signingSecret.length < 32) throw new Error("Ark gateway signing secret must contain at least 32 characters");

  return createServer(async (request, response) => {
    const started = Date.now();
    const method = request.method ?? "GET";
    const incoming = new URL(request.url ?? "/", "http://ark-gateway");
    let claims: GatewayTokenClaims | null = null;
    const record = (outcome: ArkGatewayEvent["outcome"], statusCode: number) => options.onEvent?.({
      timestamp: new Date().toISOString(), outcome, method, path: incoming.pathname,
      statusCode, durationMs: Date.now() - started, ...claimFields(claims),
    });

    if (method === "GET" && incoming.pathname === "/health") {
      sendHealth(response);
      return;
    }
    if (method !== "POST") {
      sendJson(response, 405, "Ark gateway permits POST requests only");
      record("denied", 405);
      return;
    }
    const target = resolveUpstream(config, incoming);
    if (!target) {
      sendJson(response, 403, "Ark gateway permits only the Responses API");
      record("denied", 403);
      return;
    }
    const token = bearerToken(request.headers);
    if (!token) {
      sendJson(response, 401, "Valid Airlock Run token required");
      record("denied", 401);
      return;
    }
    try {
      claims = verifyGatewayToken(token, config.signingSecret);
    } catch (error) {
      sendJson(response, 401, error instanceof Error ? error.message : "Invalid Airlock Run token");
      record("denied", 401);
      return;
    }

    let body: Buffer;
    try {
      body = await readBoundedBody(request, config.maxRequestBytes);
    } catch (error) {
      const tooLarge = error instanceof RequestTooLargeError;
      sendJson(response, tooLarge ? 413 : 400, tooLarge ? "Ark request exceeds the gateway limit" : "Could not read Ark request");
      record("denied", tooLarge ? 413 : 400);
      return;
    }

    const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
    const upstream = transport(target, {
      method: "POST",
      headers: forwardedHeaders(request.headers, config.apiKey, body.length),
    }, (upstreamResponse) => {
      const statusCode = upstreamResponse.statusCode ?? 502;
      response.writeHead(statusCode, copyResponseHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(response);
      upstreamResponse.once("end", () => record("forwarded", statusCode));
    });
    upstream.setTimeout(config.requestTimeoutMs, () => upstream.destroy(new Error("Ark upstream request timed out")));
    upstream.once("error", () => {
      if (response.headersSent) response.destroy();
      else sendJson(response, 502, "Ark upstream request failed");
      record("failed", 502);
    });
    response.once("close", () => {
      if (!response.writableEnded) upstream.destroy();
    });
    upstream.end(body);
  });
}

export function loadArkGatewayConfig(environment: NodeJS.ProcessEnv = process.env): ArkGatewayConfig & { host: string; port: number } {
  const port = Number(environment.ARK_GATEWAY_PORT ?? 8080);
  const maxRequestBytes = Number(environment.ARK_GATEWAY_MAX_REQUEST_BYTES ?? 16_777_216);
  const requestTimeoutMs = Number(environment.ARK_GATEWAY_REQUEST_TIMEOUT_MS ?? 600_000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("ARK_GATEWAY_PORT is invalid");
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 65_536) throw new Error("ARK_GATEWAY_MAX_REQUEST_BYTES is invalid");
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1_000) throw new Error("ARK_GATEWAY_REQUEST_TIMEOUT_MS is invalid");
  return {
    host: environment.ARK_GATEWAY_HOST?.trim() || "0.0.0.0",
    port,
    upstreamBaseUrl: (environment.ARK_BASE_URL?.trim() || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/+$/, ""),
    apiKey: environment.ARK_API_KEY?.trim() ?? "",
    signingSecret: environment.ARK_GATEWAY_SECRET?.trim() ?? "",
    pathPrefix: environment.ARK_GATEWAY_PATH_PREFIX?.trim() || "/api/v3",
    maxRequestBytes,
    requestTimeoutMs,
  };
}
