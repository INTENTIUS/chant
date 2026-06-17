import { describe, test, expect } from "vitest";
import { fileURLToPath } from "url";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { fetchRepoFiles, FetchError } from "./fetch";
import { discoverByDetection, classifyFiles } from "./discover";
import { loadAuditPlugins } from "./discover";

const MIXED = fileURLToPath(new URL("../cli/commands/__fixtures__/audit-mixed", import.meta.url));

/** Read a dir into relative-path → content (the "repo" a mock will serve). */
function readDir(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out[relative(root, full)] = readFileSync(full, "utf-8");
    }
  };
  walk(root);
  return out;
}

/** A GitHub-shaped mock: repo-info default_branch, recursive git/trees, base64 contents. */
function mockGithub(files: Record<string, string>): typeof fetch {
  const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/git/trees/")) {
      const tree = Object.keys(files).map((path) => ({ path, type: "blob", size: files[path].length }));
      return new Response(JSON.stringify({ tree }), { status: 200 });
    }
    const cm = u.match(/\/contents\/(.+?)\?/);
    if (cm) {
      const path = decodeURIComponent(cm[1]);
      const content = files[path];
      if (content === undefined) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ path, type: "file", content: b64(content), encoding: "base64" }), { status: 200 });
    }
    if (/\/repos\/[^/]+\/[^/]+(\?|$)/.test(u)) return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

const targets = (inputs: { lexicon: string; path: string }[]) => inputs.map((i) => `${i.lexicon}:${i.path}`).sort();

describe("remote audit covers all lexicons (not just CI)", () => {
  test("a URL audit detects github + k8s + docker + aws in one repo", async () => {
    const plugins = await loadAuditPlugins();
    const files = await fetchRepoFiles("https://github.com/acme/widgets", { fetchImpl: mockGithub(readDir(MIXED)) });
    const lexicons = new Set(classifyFiles(files, plugins).map((i) => i.lexicon));
    expect([...lexicons].sort()).toEqual(["aws", "docker", "github", "k8s"]);
  });

  test("remote classification matches a local audit of the same repo (parity)", async () => {
    const plugins = await loadAuditPlugins();
    const local = discoverByDetection(MIXED, plugins);
    const remote = classifyFiles(await fetchRepoFiles("https://github.com/acme/widgets", { fetchImpl: mockGithub(readDir(MIXED)) }), plugins);
    expect(targets(remote)).toEqual(targets(local));
  });

  test("caps the number of files fetched", async () => {
    const files = await fetchRepoFiles("https://github.com/acme/widgets", { fetchImpl: mockGithub(readDir(MIXED)), maxFiles: 1 });
    expect(files.length).toBe(1);
  });

  test("rejects a non-allowlisted host before any fetch", async () => {
    await expect(fetchRepoFiles("https://evil.example.com/o/r")).rejects.toThrow(/Host not allowed/);
  });

  test("refuses to follow a redirect on the tree request", async () => {
    const impl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/git/trees/")) return new Response(null, { status: 302 });
      return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(fetchRepoFiles("https://github.com/acme/widgets", { fetchImpl: impl })).rejects.toThrow(/redirect/i);
  });
});
