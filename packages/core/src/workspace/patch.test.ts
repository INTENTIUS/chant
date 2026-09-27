/**
 * The patch read, on a workspace one directory down in its repository, with a
 * work branch the way the factory leaves one (`chant/work/<id>`) and a main
 * branch that moved on after the branch was cut:
 *
 * - m0, the root commit, adds the workspace, app/server.mjs, app/old.mjs,
 *   docs/claims.md and a file outside the workspace.
 * - w1 and w2, on chant/work/W-001, edit app/server.mjs, rename app/old.mjs
 *   to app/new.mjs, add a binary file and add docs/more.md.
 * - m1, on main after the cut, edits docs/claims.md.
 */

import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, git, repo, writeFiles } from "./__fixtures__/contract-repo";
import { formatPatch, workspacePatch, type PatchDocument, type PatchFile } from "./patch";
import patchSchema from "./patch.schema.json";

let top: string;
let ws: string;
const sha: Record<string, string> = {};

const SERVER = Array.from({ length: 40 }, (_, i) => `export const line${i} = ${i};`).join("\n") + "\n";
const SERVER_2 = SERVER.replace("line3 = 3", "line3 = 33").replace("line30 = 30", "line30 = 300");
const OLD = "// moved, not changed\nexport const a = 1;\nexport const b = 2;\nexport const c = 3;\n";

function commit(message: string): string {
  git(top, "add", "-A");
  git(top, "commit", "-q", "-m", message);
  return git(top, "rev-parse", "HEAD");
}

beforeAll(() => {
  top = repo({
    "ws/chant.workspace.json": JSON.stringify({ name: "studio", schema: 1, members: [{ name: "app", dir: "app", kind: "other", because: "a server" }] }),
    "ws/app/server.mjs": SERVER,
    "ws/app/old.mjs": OLD,
    "ws/docs/claims.md": "# Claims\n",
    "outside.txt": "not in the workspace\n",
  });
  ws = join(top, "ws");
  git(top, "symbolic-ref", "HEAD", "refs/heads/main");
  sha.m0 = commit("the workspace");
  git(top, "checkout", "-q", "-b", "chant/work/W-001");
  writeFiles(top, { "ws/app/server.mjs": SERVER_2, "outside.txt": "changed outside\n" });
  git(top, "mv", "ws/app/old.mjs", "ws/app/new.mjs");
  sha.w1 = commit("edit the server and move old to new");
  writeFiles(top, { "ws/app/logo.bin": { text: "\u0000\u0001\u0002binary\u0000", mode: 0o644 }, "ws/docs/more.md": "More.\n" });
  sha.w2 = commit("a logo and more docs");
  git(top, "checkout", "-q", "main");
  writeFiles(top, { "ws/docs/claims.md": "# Claims\n\nOne.\n" });
  sha.m1 = commit("a claim on main");
});
afterAll(cleanScratch);

const { expectValid } = contract(patchSchema);
type Result = Exclude<PatchDocument, { error: unknown }>;

async function patch(range: string, options: { paths?: string[]; maxBytes?: number } = {}): Promise<Result> {
  const { doc } = await workspacePatch({ cwd: ws, range, ...options });
  expectValid(doc);
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

const summary = (f: PatchFile) => [f.change, f.path, f.from, f.additions, f.deletions, f.hunkCount, f.truncated];

describe("workspace patch", () => {
  test("a work branch from its merge base: each file under the workspace root, with renames, binaries and hunks", async () => {
    const doc = await patch("main...chant/work/W-001");
    expect(doc.range).toEqual({ spec: "main...chant/work/W-001", form: "merge-base", base: sha.m0, head: sha.w2 });
    expect(doc.workspace).toEqual({ name: "studio", root: "ws" });
    expect(doc.paths).toEqual([]);
    expect(doc.limits).toEqual({ fileBytes: 65536, totalBytes: 1048576 });
    expect(doc.files.map(summary)).toEqual([
      ["added", "app/logo.bin", null, null, null, 0, false],
      ["renamed", "app/new.mjs", "app/old.mjs", 0, 0, 0, false],
      ["modified", "app/server.mjs", null, 2, 2, 2, false],
      ["added", "docs/more.md", null, 1, 0, 1, false],
    ]);
    expect(doc.files[0].binary).toBe(true);
    const server = doc.files[2];
    expect(server.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [1, 7, 1, 7],
      [28, 7, 28, 7],
    ]);
    expect(server.hunks[0].header).toBe("@@ -1,7 +1,7 @@");
    expect(server.hunks[0].lines.filter((l) => /^[+-]/.test(l))).toEqual(["-export const line3 = 3;", "+export const line3 = 33;"]);
    expect(doc.files[3].hunks).toEqual([{ header: "@@ -0,0 +1 @@", oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+More."] }]);
    expect(doc.summary).toEqual({ files: 4, additions: 3, deletions: 2, truncated: false });
  });

  test("two dots compare the trees as they are, so main's later edit shows as undone", async () => {
    const doc = await patch("main..chant/work/W-001");
    expect(doc.range.form).toBe("range");
    expect(doc.range.base).toBe(sha.m1);
    const claims = doc.files.find((f) => f.path === "docs/claims.md")!;
    expect(claims.hunks[0].lines).toEqual([" # Claims", "-", "-One."]);
  });

  test("one commit reads against its first parent, and a root commit against the empty tree", async () => {
    const w2 = await patch(sha.w2);
    expect(w2.range).toEqual({ spec: sha.w2, form: "commit", base: sha.w1, head: sha.w2 });
    expect(w2.files.map((f) => f.path)).toEqual(["app/logo.bin", "docs/more.md"]);
    const m0 = await patch(sha.m0);
    expect(m0.range.base).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    expect(m0.files.map((f) => [f.change, f.path])).toEqual([
      ["added", "app/old.mjs"],
      ["added", "app/server.mjs"],
      ["added", "chant.workspace.json"],
      ["added", "docs/claims.md"],
    ]);
  });

  test("--path keeps a file, or everything under a directory", async () => {
    expect((await patch("main...chant/work/W-001", { paths: ["docs"] })).files.map((f) => f.path)).toEqual(["docs/more.md"]);
    const one = await patch("main...chant/work/W-001", { paths: ["app/server.mjs", "docs/"] });
    expect(one.paths).toEqual(["app/server.mjs", "docs"]);
    expect(one.files.map((f) => f.path)).toEqual(["app/server.mjs", "docs/more.md"]);
  });

  test("a file's hunk text stops at maxBytes, mid-hunk if it must, and says so", async () => {
    const doc = await patch(sha.w1, { paths: ["app/server.mjs"], maxBytes: 200 });
    const f = doc.files[0];
    expect(f.truncated).toBe(true);
    expect(f.hunkCount).toBe(2);
    expect(f.bytes).toBeGreaterThan(200);
    const kept = f.hunks.reduce((n, h) => n + Buffer.byteLength(h.header) + 1 + h.lines.reduce((m, l) => m + Buffer.byteLength(l) + 1, 0), 0);
    expect(kept).toBeLessThanOrEqual(200);
    expect(f.hunks.length).toBe(1);
    expect(f.hunks[0].lines.length).toBeLessThan(9);
    expect(doc.summary.truncated).toBe(true);
    expect(formatPatch(doc)).toContain("modified  app/server.mjs +2 -2; truncated, 1 of 2 hunks shown");
  });

  test("once every file's text passes the total, the files after it keep their counts and no hunks", async () => {
    // Each file's hunk is 46 bytes: its 14-byte header and one 32-byte line. 800 bytes hold 17,
    // then the 18th file's header, and nothing after.
    const files = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`ws/many/f${String(i).padStart(2, "0")}.txt`, `${"x".repeat(30)}\n`]));
    git(top, "checkout", "-q", "-b", "many", "main");
    writeFiles(top, files);
    const many = commit("twenty files");
    git(top, "checkout", "-q", "main");
    const doc = await patch(many, { maxBytes: 50 });
    expect(doc.limits).toEqual({ fileBytes: 50, totalBytes: 800 });
    expect(doc.files.map((f) => [f.hunks.length, f.truncated])).toEqual([...Array(17).fill([1, false]), [1, true], [0, true], [0, true]]);
    expect(doc.files[17].hunks[0]).toMatchObject({ header: "@@ -0,0 +1 @@", lines: [] });
    expect(doc.files.every((f) => f.additions === 1 && f.hunkCount === 1 && f.bytes === 46)).toBe(true);
    expect(doc.summary.truncated).toBe(true);
  });

  test("a revision that is no commit is revision-unknown, and a path outside the workspace patch-path-invalid", async () => {
    for (const [range, paths, code] of [
      ["main..nope", undefined, "revision-unknown"],
      ["main...chant/work/W-001", ["../outside.txt"], "patch-path-invalid"],
      ["main...chant/work/W-001", ["/etc"], "patch-path-invalid"],
    ] as const) {
      const { doc, failed } = await workspacePatch({ cwd: ws, range, paths: paths ? [...paths] : undefined });
      expectValid(doc);
      expect(failed).toBe(true);
      expect("error" in doc && doc.error.code).toBe(code);
    }
  });
});
