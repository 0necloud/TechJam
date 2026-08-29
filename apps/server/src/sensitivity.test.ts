import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { classifyFile, classifyName, classifyText, redactSecrets } from "./sensitivity.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "airlock-sensitivity-"));
  roots.push(root);
  return root;
}

// Minimal zip writer so an Office container can be exercised without a
// dependency. CRC fields stay zero because the reader never verifies them.
function zip(members: { name: string; content: Buffer; deflate: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name, "utf8");
    const data = member.deflate ? deflateRawSync(member.content) : member.content;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(member.deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(member.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(member.deflate ? 8 : 0, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(member.content.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    directory.push(entry, name);
    offset += 30 + name.length + data.length;
  }
  const directoryBuffer = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directoryBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directoryBuffer, end]);
}

describe("name classification", () => {
  it("treats credential file names as restricted on every path segment", () => {
    expect(classifyName("config/.env").map((signal) => signal.level)).toContain("restricted");
    expect(classifyName("deploy/keys/server.pem")[0]?.rule).toBe("IN020");
    expect(classifyName("home/.ssh/id_rsa").map((signal) => signal.detail)).toContain("SSH private key");
  });

  it("treats a self-declaring file name as confidential", () => {
    const signals = classifyName("reports/2026-payroll.xlsx");
    expect(signals[0]).toMatchObject({ rule: "IN025", level: "confidential" });
  });

  it("leaves ordinary source files unclassified", () => {
    expect(classifyName("src/app/server.ts")).toEqual([]);
  });
});

describe("content classification", () => {
  it("reads a classification banner as a marking", () => {
    const signals = classifyText("Quarterly Results\nCOMPANY CONFIDENTIAL\n", "content");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ rule: "IN021", level: "confidential", excerpt: "COMPANY CONFIDENTIAL" });
  });

  it("reads an explicit classification field", () => {
    const signals = classifyText("Security Classification: TLP:AMBER", "content");
    expect(signals[0]).toMatchObject({ rule: "IN021", level: "confidential" });
  });

  it("does not flag the word inside source code", () => {
    const text = ["// this value is confidential and must never be logged;", "const confidentialToken = read();"].join("\n");
    expect(classifyText(text, "content").filter((signal) => signal.rule === "IN021")).toEqual([]);
  });

  it("detects credentials without ever echoing them", () => {
    const signals = classifyText("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE", "content");
    expect(signals.map((signal) => signal.rule)).toContain("IN022");
    expect(JSON.stringify(signals)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("detects personal data by Luhn-valid card and national identifier", () => {
    const details = classifyText("card 4111 1111 1111 1111 for S1234567D", "content").map((signal) => signal.detail);
    expect(details).toContain("Payment card number");
    expect(details).toContain("Singapore NRIC or FIN");
  });

  it("redacts credential material while keeping the surrounding text", () => {
    const safe = redactSecrets("set api_key=abcd1234efgh5678 then continue");
    expect(safe).toBe("set api_key=[REDACTED] then continue");
  });
});

describe("streaming file classification", () => {
  it("stops reading the moment a marking appears", async () => {
    const root = await workspace();
    const file = path.join(root, "handbook.txt");
    await writeFile(file, ["STRICTLY CONFIDENTIAL", ...Array.from({ length: 20_000 }, (_, index) => "filler line " + index)].join("\n"));
    const result = await classifyFile(file, "handbook.txt");
    expect(result.level).toBe("confidential");
    expect(result.stopReason).toBe("signal");
    expect(result.bytesInspected).toBeLessThan(result.size);
  });

  it("settles a credential file from its name without opening it", async () => {
    const root = await workspace();
    const file = path.join(root, ".env");
    await writeFile(file, "ARK_API_KEY=not-read-by-the-classifier\n");
    const result = await classifyFile(file, ".env");
    expect(result.level).toBe("restricted");
    expect(result.stopReason).toBe("name-only");
    expect(result.bytesInspected).toBe(0);
  });

  it("reads the whole of a small unremarkable file", async () => {
    const root = await workspace();
    const file = path.join(root, "index.ts");
    await writeFile(file, "export const value = 1;\n");
    const result = await classifyFile(file, "index.ts");
    expect(result.level).toBe("public");
    expect(result.stopReason).toBe("complete");
  });

  it("labels a Word document from its properties without decompressing the body", async () => {
    const root = await workspace();
    const file = path.join(root, "strategy.docx");
    const body = randomBytes(400_000);
    await writeFile(file, zip([
      { name: "word/document.xml", content: body, deflate: true },
      { name: "docProps/core.xml", content: Buffer.from('<cp:coreProperties><cp:keywords>CONFIDENTIAL</cp:keywords></cp:coreProperties>', "utf8"), deflate: true },
      { name: "docProps/custom.xml", content: Buffer.from('<Properties><property fmtid="{x}" pid="2" name="MSIP_Label_9f1c_Name"><vt:lpwstr>Highly Confidential</vt:lpwstr></property></Properties>', "utf8"), deflate: true },
    ]));
    const result = await classifyFile(file, "strategy.docx");
    expect(result.level).toBe("confidential");
    expect(result.stopReason).toBe("metadata-only");
    expect(result.signals.map((signal) => signal.origin)).toContain("metadata");
    expect(result.bytesInspected).toBeLessThan(result.size / 10);
  });

  it("returns no marking for an unlabelled Office container", async () => {
    const root = await workspace();
    const file = path.join(root, "notes.docx");
    await writeFile(file, zip([
      { name: "word/document.xml", content: Buffer.from("plain notes", "utf8"), deflate: true },
      { name: "docProps/core.xml", content: Buffer.from("<cp:coreProperties><cp:title>Notes</cp:title></cp:coreProperties>", "utf8"), deflate: true },
    ]));
    expect((await classifyFile(file, "notes.docx")).level).toBe("public");
  });
});
