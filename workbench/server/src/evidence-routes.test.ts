import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { EvidenceCitation } from "@llm-wiki/workbench-contracts";
import { CAPABILITY_TOKEN_HEADER } from "@llm-wiki/workbench-contracts";
import { isolateTestHome } from "../test/support/isolated-home.js";

const sandbox = await mkdtemp(path.join(tmpdir(), "wiki-evidence-route-"));
const restoreHome = isolateTestHome(sandbox, path.join(sandbox, "agent"));
after(async () => {
  restoreHome();
  await rm(sandbox, { recursive: true, force: true });
});
const { createApp } = await import("./app.js");
const { createSecurityMiddleware } = await import("./security/middleware.js");
const { readEvidence } = await import("./evidence-reader.js");
const kb = path.join(sandbox, "kb");
await mkdir(path.join(kb, "raw"), { recursive: true });
const content = "# Handbook\nOriginal fact\n";
const file = path.join(kb, "raw", "handbook.md");
await writeFile(file, content);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const citation: EvidenceCitation = { id: "E1", kind: "raw", path: "raw/handbook.md", title: "Handbook", headingPath: ["Handbook"], startLine: 2, endLine: 2, fileHash: hash(content), excerptHash: hash("Original fact"), excerpt: "Original fact" };
let reads = 0;
const service = {
  assertRegisteredKnowledgeBase: async (requested: string) => {
    if (requested !== kb) throw Object.assign(new Error("fixture private path"), { code: "KB_NOT_REGISTERED" });
    return kb;
  },
  readEvidence: async (root: string, source: EvidenceCitation) => { reads++; return readEvidence(root, source); },
};
function request(body: unknown, headers: Record<string, string> = {}) {
  return { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) };
}

test("evidence POST revalidates exact, relocated and changed source locations; missing files return safe NOT_FOUND", async () => {
  const app = createApp({ evidenceService: service });
  const call = () => app.request("/api/evidence/read", request({ kbPath: kb, citation }));
  let response = await call();
  assert.equal(response.status, 200);
  let result = await response.json() as any;
  assert.equal(result.data.locationStatus, "exact");
  assert.equal(result.data.startLine, 2);
  await writeFile(file, `New preface\n${content}`);
  result = await (await call()).json() as any;
  assert.equal(result.data.locationStatus, "relocated");
  assert.equal(result.data.startLine, 3);
  await writeFile(file, "Original fact is replaced");
  // A changed range may still be a unique quote, so remove it entirely.
  await writeFile(file, "Entirely changed");
  result = await (await call()).json() as any;
  assert.equal(result.data.locationStatus, "changed");
  assert.equal(result.data.startLine, null);
  await rm(file);
  response = await call();
  assert.equal(response.status, 404);
  assert.equal((await response.json() as any).code, "NOT_FOUND");
  await writeFile(file, content);
});

test("evidence route rejects unsafe paths, unregistered roots and symlinks without exposing private paths or source text", async () => {
  const app = createApp({ evidenceService: service });
  const count = reads;
  const invalid = await app.request("/api/evidence/read", request({ kbPath: kb, citation: { ...citation, path: "raw/../private.md" } }));
  assert.equal(invalid.status, 400);
  assert.equal(reads, count);
  const unregistered = await app.request("/api/evidence/read", request({ kbPath: path.join(sandbox, "unregistered"), citation }));
  assert.equal(unregistered.status, 404);
  assert.equal((await unregistered.json() as any).code, "KB_NOT_REGISTERED");
  const outside = path.join(sandbox, "private.md");
  await writeFile(outside, "OUTSIDE_PRIVATE_SOURCE");
  await symlink(outside, path.join(kb, "raw", "escape.md"));
  const denied = await app.request("/api/evidence/read", request({ kbPath: kb, citation: { ...citation, path: "raw/escape.md" } }));
  assert.equal(denied.status, 403);
  assert.doesNotMatch(await denied.text(), /OUTSIDE_PRIVATE_SOURCE|wiki-evidence-route|private\.md/);
  const appError = createApp({ evidenceService: { ...service, readEvidence: async () => { throw new Error("key-secret /private/fixture/source.md source contents"); } } });
  const error = await appError.request("/api/evidence/read", request({ kbPath: kb, citation }));
  assert.equal(error.status, 500);
  assert.doesNotMatch(await error.text(), /key-secret|fixture\/source|source contents|Original fact/);
});

test("evidence reads require both the local capability and a trusted browser source", async () => {
  const app = createApp({ evidenceService: service, security: createSecurityMiddleware({ token: "fixture-token", trustedOrigins: new Set(["http://localhost:5180"]) }) });
  const count = reads;
  const missing = await app.request("/api/evidence/read", request({ kbPath: kb, citation }, { Origin: "http://localhost:5180" }));
  assert.equal(missing.status, 403);
  const foreign = await app.request("/api/evidence/read", request({ kbPath: kb, citation }, { Origin: "https://untrusted.invalid", [CAPABILITY_TOKEN_HEADER]: "fixture-token" }));
  assert.equal(foreign.status, 403);
  assert.equal(reads, count);
  const allowed = await app.request("/api/evidence/read", request({ kbPath: kb, citation }, { Origin: "http://localhost:5180", [CAPABILITY_TOKEN_HEADER]: "fixture-token" }));
  assert.equal(allowed.status, 200);
});

test("source-only mention refs use raw candidates while ordinary refs retain wiki candidates", async () => {
  const app = createApp({ pageService: {
    getActiveKnowledgeBasePath: () => kb, assertRegisteredKnowledgeBase: service.assertRegisteredKnowledgeBase,
    listPageRefs: async () => [{ path: "wiki/a.md", name: "a", title: "Wiki", category: "topics" }],
    listSourcePageRefs: async () => [{ path: "raw/a.md", name: "a", title: "Raw", category: "raw" }],
    readWikiPage: async () => "wiki page",
  } });
  const ordinary = await (await app.request("/api/refs")).json() as any;
  const sources = await (await app.request("/api/refs?retrievalMode=sources-only")).json() as any;
  assert.equal(ordinary.data[0].path, "wiki/a.md");
  assert.equal(sources.data[0].path, "raw/a.md");
});
