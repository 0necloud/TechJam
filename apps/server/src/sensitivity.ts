import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

// Airlock ingress classification.
//
// The write-side policy in `change-policy.ts` decides what may leave the
// Runtime. This module decides what may *enter* it. Both run in the control
// plane, never inside the container, because Architecture B gives Codex an
// autonomous Runtime: once bytes are inside a bind mount, a read is an ordinary
// syscall and nothing can interrupt it. The only place a read can be stopped is
// before the file is staged, so every function here is designed to reach a
// verdict from as few bytes as possible and then stop reading.

export type SensitivityLevel = "public" | "internal" | "confidential" | "restricted";

const ORDER: SensitivityLevel[] = ["public", "internal", "confidential", "restricted"];

export function rank(level: SensitivityLevel): number { return ORDER.indexOf(level); }
export function highest(levels: SensitivityLevel[]): SensitivityLevel { return levels.reduce((carry, level) => (rank(level) > rank(carry) ? level : carry), "public" as SensitivityLevel); }
export function levelAbove(level: SensitivityLevel): SensitivityLevel | null { return ORDER[rank(level) + 1] ?? null; }

export type SignalOrigin = "name" | "content" | "metadata";

export interface SensitivitySignal {
  rule: string;
  level: SensitivityLevel;
  origin: SignalOrigin;
  detail: string;
  /** Safe to persist and display: markings are echoed, secret matches never are. */
  excerpt: string;
}

export type StopReason = "complete" | "signal" | "budget" | "name-only" | "metadata-only";

export interface FileSensitivity {
  path: string;
  level: SensitivityLevel;
  signals: SensitivitySignal[];
  size: number;
  bytesInspected: number;
  stopReason: StopReason;
  binary: boolean;
  /** Untrusted-provenance and injection signals: leg two of the lethal trifecta. */
  provenance: ProvenanceSignal[];
  /**
   * Head of the file, secret-redacted and capped, captured only when asked for.
   * Lets the adjudicator reuse bytes already read instead of reopening the file.
   */
  excerpt?: string;
}

export interface ClassifyFileOptions {
  /** Inspection budget. The classifier never reads more than this from one file. */
  maxBytes?: number;
  /** Stop reading the moment a signal reaches this level. `null` reads the whole budget. */
  abortAt?: SensitivityLevel | null;
  /** Capture this many characters of redacted head text for later adjudication. */
  captureExcerpt?: number;
}

// --- Name rules -------------------------------------------------------------

interface NameRule { pattern: RegExp; level: SensitivityLevel; detail: string }

const NAME_RULES: NameRule[] = [
  { pattern: /^\.env(?:\..+)?$/i, level: "restricted", detail: "Environment file" },
  { pattern: /^id_(?:rsa|dsa|ecdsa|ed25519)$/i, level: "restricted", detail: "SSH private key" },
  { pattern: /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)$/i, level: "restricted", detail: "Key, certificate, or keystore file" },
  { pattern: /^(?:credentials?|secrets?|service[_-]?account.*|client[_-]?secret.*)\.(?:json|ya?ml|toml|ini|txt|xml)$/i, level: "restricted", detail: "Credential store" },
  { pattern: /^\.(?:npmrc|pypirc|netrc|dockercfg|docker|git-credentials|pgpass|htpasswd)$/i, level: "restricted", detail: "Tool credential file" },
  { pattern: /^\.(?:aws|ssh|gnupg|kube|azure)$/i, level: "restricted", detail: "Credential directory" },
  { pattern: /^(?:.*[_.-])?(?:confidential|classified|nda|payroll|salaries|salary)(?:[_.-].*)?$/i, level: "confidential", detail: "Filename declares sensitivity" },
];

export function classifyName(relativePath: string): SensitivitySignal[] {
  const segments = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  const signals: SensitivitySignal[] = [];
  for (const segment of segments) {
    const base = segment.replace(/\.[^.]+$/, "");
    for (const rule of NAME_RULES) {
      if (!rule.pattern.test(segment) && !rule.pattern.test(base)) continue;
      const id = rule.level === "confidential" ? "IN025" : "IN020";
      if (signals.some((signal) => signal.rule === id && signal.detail === rule.detail)) continue;
      signals.push({ rule: id, level: rule.level, origin: "name", detail: rule.detail, excerpt: segment });
    }
  }
  return signals;
}

// --- Content rules ----------------------------------------------------------

interface MarkerRule { pattern: RegExp; level: SensitivityLevel; detail: string }

// Classification markings. Matched per line so a marking banner is distinguished
// from the same word appearing mid-sentence inside source code.
const CLASSIFICATION_MARKERS: MarkerRule[] = [
  { pattern: /\bTOP[\s-]?SECRET\b/i, level: "restricted", detail: "TOP SECRET marking" },
  { pattern: /\bSECRET\s*\/\/\s*[A-Z]/, level: "restricted", detail: "Compartmented SECRET marking" },
  { pattern: /\bTLP[:\s]?RED\b/i, level: "restricted", detail: "TLP:RED marking" },
  { pattern: /\bTLP[:\s]?AMBER\b/i, level: "confidential", detail: "TLP:AMBER marking" },
  { pattern: /\bPROPRIETARY\s+AND\s+CONFIDENTIAL\b/i, level: "confidential", detail: "Proprietary marking" },
  { pattern: /\b(?:STRICTLY\s+|COMPANY\s+)?CONFIDENTIAL\b/i, level: "confidential", detail: "CONFIDENTIAL marking" },
  { pattern: /\bNOT\s+FOR\s+(?:EXTERNAL\s+)?(?:DISTRIBUTION|RELEASE)\b/i, level: "confidential", detail: "Distribution restriction" },
  { pattern: /\bRESTRICTED\b/i, level: "confidential", detail: "RESTRICTED marking" },
  { pattern: /\bINTERNAL[\s-]?(?:USE\s+)?ONLY\b/i, level: "internal", detail: "INTERNAL ONLY marking" },
];

const SECRET_MARKERS: MarkerRule[] = [
  { pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/, level: "restricted", detail: "Private key block" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, level: "restricted", detail: "AWS access key ID" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, level: "restricted", detail: "GitHub token" },
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, level: "restricted", detail: "Slack token" },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/, level: "restricted", detail: "Vendor API key" },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/, level: "restricted", detail: "Bearer token" },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, level: "confidential", detail: "JSON Web Token" },
  { pattern: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\b\s*[:=]\s*["']?[A-Za-z0-9_\-/.+=]{8,}/i, level: "restricted", detail: "Credential assignment" },
];

const PII_MARKERS: MarkerRule[] = [
  { pattern: /\b[STFGM]\d{7}[A-Z]\b/, level: "confidential", detail: "Singapore NRIC or FIN" },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/, level: "confidential", detail: "US Social Security Number" },
];

const CARD_CANDIDATE = /\b(?:\d[ -]?){13,19}\b/g;
const CODE_LINE = /[{};]|=>|\b(?:function|const|let|var|import|export|class|def|public|private|return)\b/;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let index = digits.length - 1, position = 0; index >= 0; index -= 1, position += 1) {
    let value = digits.charCodeAt(index) - 48;
    if (position % 2 === 1) { value *= 2; if (value > 9) value -= 9; }
    sum += value;
  }
  return sum % 10 === 0;
}

function maskedExcerpt(match: string, detail: string): string {
  return detail + " (" + match.length + " characters, value withheld)";
}

/**
 * A classification marking only counts when it reads as a marking: a short
 * banner line, an explicit `Classification: ...` field, or a document metadata
 * property. Without this, every source comment mentioning "confidential" would
 * quarantine the file.
 */
function isMarkingContext(line: string, origin: SignalOrigin): boolean {
  if (origin === "metadata") return true;
  if (/^(?:security\s+)?(?:classification|sensitivity|label|marking)\s*[:-]/i.test(line)) return true;
  return line.length <= 120 && !CODE_LINE.test(line);
}

export function classifyText(text: string, origin: SignalOrigin): SensitivitySignal[] {
  const signals: SensitivitySignal[] = [];
  const seen = new Set<string>();
  const push = (rule: string, marker: MarkerRule, excerpt: string) => {
    const key = rule + "|" + marker.detail;
    if (seen.has(key)) return;
    seen.add(key);
    signals.push({ rule, level: marker.level, origin, detail: marker.detail, excerpt });
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (isMarkingContext(line, origin)) {
      for (const marker of CLASSIFICATION_MARKERS) {
        const match = marker.pattern.exec(line);
        if (match) push("IN021", marker, match[0].trim());
      }
    }
    for (const marker of SECRET_MARKERS) {
      const match = marker.pattern.exec(line);
      if (match) push("IN022", marker, maskedExcerpt(match[0], marker.detail));
    }
    for (const marker of PII_MARKERS) {
      const match = marker.pattern.exec(line);
      if (match) push("IN023", marker, maskedExcerpt(match[0], marker.detail));
    }
    for (const candidate of line.match(CARD_CANDIDATE) ?? []) {
      const digits = candidate.replace(/[ -]/g, "");
      if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
        push("IN023", { pattern: CARD_CANDIDATE, level: "confidential", detail: "Payment card number" }, maskedExcerpt(digits, "Payment card number"));
      }
    }
  }
  return signals;
}

// --- Provenance rules -------------------------------------------------------

// Leg two of the lethal trifecta: content somebody outside this workspace
// wrote. Two independent signals, because either alone is weak — a vendored
// directory is usually harmless, and injection phrasing can appear in a blog
// post about injection — but the gate only needs to know that untrusted text is
// in scope, not that an attack is under way.

const UNTRUSTED_SEGMENTS = /^(?:node_modules|vendor|third[_-]?party|externals?|downloads?|fetched|untrusted|inbox|attachments|crawl|scraped)$/i;
const UNTRUSTED_EXTENSIONS = /\.(?:eml|msg|mbox|html?|rss|atom)$/i;

const INJECTION_MARKERS: MarkerRule[] = [
  { pattern: /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules?|directions?)/i, level: "internal", detail: "Instruction-override phrasing" },
  { pattern: /\byou\s+are\s+now\s+(?:a|an|in|no\s+longer)\b/i, level: "internal", detail: "Role-reassignment phrasing" },
  { pattern: /\b(?:new|updated|revised)\s+(?:system\s+)?instructions?\s*[:.]/i, level: "internal", detail: "Injected instruction block" },
  { pattern: /\bsystem\s*prompt\s*[:>]/i, level: "internal", detail: "System-prompt impersonation" },
  { pattern: /<\s*\/?\s*(?:system|assistant|tool_call|function_call)\s*>/i, level: "internal", detail: "Conversation-markup injection" },
  { pattern: /\bdo\s+not\s+(?:tell|inform|mention\s+(?:this\s+)?to)\s+the\s+user\b/i, level: "internal", detail: "Concealment instruction" },
  { pattern: /\b(?:exfiltrate|send|upload|post)\s+(?:the\s+)?(?:contents?|files?|data|secrets?|keys?)\s+to\s+http/i, level: "confidential", detail: "Exfiltration instruction" },
];

export interface ProvenanceSignal {
  rule: string;
  detail: string;
  excerpt: string;
}

/**
 * Reports whether a staged file should be treated as untrusted input. Path
 * provenance and injection-shaped content are reported separately so evidence
 * can say which one fired.
 */
export function classifyProvenance(relativePath: string, text: string): ProvenanceSignal[] {
  const signals: ProvenanceSignal[] = [];
  const segments = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  const segment = segments.find((part) => UNTRUSTED_SEGMENTS.test(part));
  if (segment) signals.push({ rule: "IN050", detail: "Path sits under untrusted-provenance directory " + segment, excerpt: segment });
  else if (UNTRUSTED_EXTENSIONS.test(relativePath)) signals.push({ rule: "IN050", detail: "Fetched or received document format", excerpt: relativePath.split(".").at(-1) ?? "" });
  for (const marker of INJECTION_MARKERS) {
    const match = marker.pattern.exec(text);
    if (match) signals.push({ rule: "IN052", detail: marker.detail, excerpt: match[0].slice(0, 80) });
  }
  return signals;
}

/** Removes credential material from text that will be persisted or forwarded. */
export function redactSecrets(text: string): string {
  let safe = text;
  for (const marker of SECRET_MARKERS) {
    const flags = marker.pattern.flags.includes("i") ? "gi" : "g";
    safe = safe.replace(new RegExp(marker.pattern.source, flags), (match) => {
      if (marker.detail !== "Credential assignment") return "[REDACTED]";
      const assignment = /^(.*?[:=]\s*["']?)/.exec(match);
      return assignment ? assignment[1] + "[REDACTED]" : "[REDACTED]";
    });
  }
  return safe;
}

// --- Office document metadata ----------------------------------------------

const OFFICE_CONTAINER = /\.(?:docx|docm|xlsx|xlsm|pptx|pptm|odt|ods|odp)$/i;
const OFFICE_LABEL_MEMBERS = ["docProps/core.xml", "docProps/custom.xml", "docProps/app.xml", "meta.xml"];
const MAX_MEMBER_BYTES = 1_048_576;

function decodeXml(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/**
 * Reads named members out of a zip container using the central directory, so a
 * classified Word document is labelled without ever decompressing its body.
 */
async function readZipMembers(file: string, wanted: string[]): Promise<{ members: Map<string, string>; bytesRead: number }> {
  const members = new Map<string, string>();
  let bytesRead = 0;
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    if (size < 22) return { members, bytesRead };
    // Almost every Office file ends with a comment-free EOCD, so try a short
    // tail first and only fall back to the full 64 KiB comment window.
    let tail = Buffer.alloc(0);
    let end = -1;
    for (const attempt of [1_024, 66_560]) {
      const tailLength = Math.min(size, attempt);
      if (tailLength <= tail.length && tail.length > 0) break;
      tail = Buffer.alloc(tailLength);
      await handle.read(tail, 0, tailLength, size - tailLength);
      bytesRead += tailLength;
      for (let index = tail.length - 22; index >= 0; index -= 1) if (tail.readUInt32LE(index) === 0x06054b50) { end = index; break; }
      if (end >= 0) break;
    }
    if (end < 0) return { members, bytesRead };
    const count = tail.readUInt16LE(end + 10);
    const directorySize = tail.readUInt32LE(end + 12);
    const directoryOffset = tail.readUInt32LE(end + 16);
    if (directoryOffset === 0xffffffff || directorySize === 0xffffffff || directorySize === 0 || directoryOffset + directorySize > size) return { members, bytesRead };
    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);
    bytesRead += directorySize;
    let cursor = 0;
    for (let index = 0; index < count && cursor + 46 <= directory.length; index += 1) {
      if (directory.readUInt32LE(cursor) !== 0x02014b50) break;
      const method = directory.readUInt16LE(cursor + 10);
      const compressedSize = directory.readUInt32LE(cursor + 20);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      const localOffset = directory.readUInt32LE(cursor + 42);
      const name = directory.toString("utf8", cursor + 46, cursor + 46 + nameLength);
      cursor += 46 + nameLength + extraLength + commentLength;
      if (!wanted.includes(name) || compressedSize === 0 || compressedSize > MAX_MEMBER_BYTES || localOffset === 0xffffffff) continue;
      const header = Buffer.alloc(30);
      await handle.read(header, 0, 30, localOffset);
      if (header.readUInt32LE(0) !== 0x04034b50) continue;
      const dataOffset = localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      const raw = Buffer.alloc(compressedSize);
      await handle.read(raw, 0, compressedSize, dataOffset);
      bytesRead += 30 + compressedSize;
      try {
        const content = method === 8 ? inflateRawSync(raw) : method === 0 ? raw : null;
        if (content) members.set(name, content.toString("utf8"));
      } catch {
        // An unreadable member yields no marking; the caller treats that as unlabelled.
      }
    }
  } finally {
    await handle.close();
  }
  return { members, bytesRead };
}

/** Flattens document properties into `field: value` lines the marker rules understand. */
export function officeLabelLines(members: Map<string, string>): string[] {
  const lines: string[] = [];
  for (const xml of members.values()) {
    for (const match of xml.matchAll(/<(?:\w+:)?(keywords|category|subject|title|description|contentStatus)>([^<]*)<\//gi)) {
      const value = decodeXml(match[2] ?? "").trim();
      if (value) lines.push(match[1] + ": " + value);
    }
    for (const match of xml.matchAll(/<property[^>]*\sname="([^"]+)"[^>]*>\s*<\w+:[^>]+>([^<]*)</gi)) {
      const value = decodeXml(match[2] ?? "").trim();
      if (value) lines.push((match[1] ?? "property") + ": " + value);
    }
    for (const match of xml.matchAll(/<meta:(?:keyword|user-defined)[^>]*>([^<]*)</gi)) {
      const value = decodeXml(match[1] ?? "").trim();
      if (value) lines.push("keyword: " + value);
    }
  }
  return lines;
}

// --- File classification ----------------------------------------------------

const WINDOW_OVERLAP = 512;

/**
 * Classifies one file, reading as little of it as the verdict allows.
 *
 * Name rules are evaluated first and can settle the verdict without opening the
 * file at all. Office containers are settled from `docProps` alone. Everything
 * else is streamed, and the stream is destroyed the moment a signal reaches
 * `abortAt`, so the remaining bytes are never read into this process.
 */
export async function classifyFile(absolutePath: string, relativePath: string, options: ClassifyFileOptions = {}): Promise<FileSensitivity> {
  const maxBytes = options.maxBytes ?? 262_144;
  const abortAt = options.abortAt === undefined ? "confidential" : options.abortAt;
  const excerptLimit = options.captureExcerpt ?? 0;
  const info = await stat(absolutePath);
  const signals = classifyName(relativePath);
  // Path provenance is known before a byte is read, so it survives a name-only stop.
  const provenance = classifyProvenance(relativePath, "");
  let excerpt = "";
  const exceeds = () => abortAt !== null && rank(highest(signals.map((signal) => signal.level))) >= rank(abortAt);
  const settle = (bytesInspected: number, stopReason: StopReason, binary = false): FileSensitivity => ({
    path: relativePath,
    level: highest(signals.map((signal) => signal.level)),
    signals,
    size: info.size,
    bytesInspected,
    stopReason,
    binary,
    provenance,
    ...(excerptLimit > 0 ? { excerpt: redactSecrets(excerpt.slice(0, excerptLimit)) } : {}),
  });

  if (exceeds()) return settle(0, "name-only");

  if (OFFICE_CONTAINER.test(relativePath)) {
    const { members, bytesRead } = await readZipMembers(absolutePath, OFFICE_LABEL_MEMBERS);
    const lines = officeLabelLines(members);
    if (lines.length) signals.push(...classifyText(lines.join("\n"), "metadata"));
    excerpt = lines.join("\n");
    return settle(Math.min(bytesRead, info.size), "metadata-only", true);
  }

  const stream = createReadStream(absolutePath, { highWaterMark: 16_384 });
  let inspected = 0;
  let carry = "";
  let binary = false;
  let stopReason: StopReason = "complete";
  const seen = new Set(signals.map((signal) => signal.rule + "|" + signal.detail));
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      if (!binary && buffer.includes(0)) binary = true;
      inspected += buffer.byteLength;
      const text = carry + buffer.toString("utf8");
      if (excerptLimit > 0 && excerpt.length < excerptLimit && !binary) excerpt += buffer.toString("utf8");
      for (const signal of classifyText(text, "content")) {
        const key = signal.rule + "|" + signal.detail;
        if (seen.has(key)) continue;
        seen.add(key);
        signals.push(signal);
      }
      for (const signal of classifyProvenance(relativePath, text)) {
        if (provenance.some((existing) => existing.rule === signal.rule && existing.detail === signal.detail)) continue;
        provenance.push(signal);
      }
      carry = text.slice(-WINDOW_OVERLAP);
      if (exceeds()) { stopReason = "signal"; break; }
      if (inspected >= maxBytes) { stopReason = inspected >= info.size ? "complete" : "budget"; break; }
    }
  } finally {
    stream.destroy();
  }
  return settle(inspected, stopReason, binary);
}
