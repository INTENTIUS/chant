/**
 * A box's ship (ws-100): the declaration's box.ship with its defaults, and
 * what status --json says of it: the commit the box's site serves (the
 * latest release in the ship's environment, under the box member) and the
 * files waiting to ship between that commit and the working tree, tracked
 * or not, bookkeeping left out.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { ReleaseRecord } from "../lifecycle/release-ledger";
import { cleanScratch, commitAll, contract, git, repo } from "./__fixtures__/contract-repo";
import { readDeclaration } from "./declaration";
import { workingTree } from "./tree";
import declarationSchema from "./declaration.schema.json";
import statusSchema from "./status.schema.json";
import { SHIP_PENDING_PATHS_MAX, workspaceStatus, type StatusBoxShip } from "./status";

afterAll(cleanScratch);

function declaration(ship: Record<string, unknown> | undefined): string {
  return `${JSON.stringify(
    {
      name: "demo",
      schema: 1,
      members: [
        { name: "app", dir: "app", kind: "other", because: "a plain Node server" },
        { name: "box", dir: "box", kind: "other", because: "the box", box: { services: [{ name: "web", cmd: "node server.mjs" }], ...(ship ? { ship } : {}) } },
      ],
    },
    null,
    2,
  )}\n`;
}

const release = (commit: string): ReleaseRecord =>
  ({ version: 1, component: "site", env: "box", digest: `sha256:${"a".repeat(64)}`, gitSha: commit, runId: "r1", timestamp: "2026-10-04T00:00:00Z", actor: "github:ada" }) as ReleaseRecord;

async function shipOf(root: string, records: ReleaseRecord[] | Error, seen: string[] = []): Promise<StatusBoxShip | null> {
  const doc = await workspaceStatus({
    cwd: root,
    env: "local",
    readLedger: async (path) => {
      seen.push(path);
      if (records instanceof Error) throw records;
      return { records: path === "box/releases.jsonl" || path.endsWith("/box/releases.jsonl") ? records : [], malformed: 0 };
    },
  });
  contract(statusSchema).expectValid(doc);
  return (doc as { members: { name: string; box: { ship: StatusBoxShip | null } | null }[] }).members.find((m) => m.name === "box")!.box!.ship;
}

describe("box.ship", () => {
  test("the declaration fills in the gate, environment and bookkeeping, and the schema takes exactly these fields", () => {
    const root = repo({ "chant.workspace.json": declaration({ op: "release", bookkeeping: ["./decisions/", "work"] }), "app/x": "", "box/x": "" });
    const box = readDeclaration(workingTree(root)).members.find((m) => m.name === "box")!.box!;
    expect(box.ship).toEqual({ op: "release", gate: "ship", env: "box", bookkeeping: ["decisions", "work"], pointer: "/members/1/box/ship" });
    const { validate } = contract(declarationSchema);
    expect(validate(JSON.parse(declaration({ op: "release", gate: "go", env: "site", bookkeeping: ["decisions"] })))).toBe(true);
    expect(validate(JSON.parse(declaration({ gate: "ship" })))).toBe(false);
    expect(validate(JSON.parse(declaration({ op: "release", bookkeeping: ["../out"] })))).toBe(false);
    expect(validate(JSON.parse(declaration({ op: "release", extra: 1 })))).toBe(false);
  });

  test("status prints what the site serves and what is waiting: changes since that release, untracked files too, bookkeeping left out", async () => {
    const root = repo({ "chant.workspace.json": declaration({ op: "release", bookkeeping: ["decisions"] }), "app/server.mjs": "v1\n", "decisions/D-1.md": "a\n" }, true);
    const shipped = git(root, "rev-parse", "HEAD");
    // Nothing shipped: no serving commit, nothing to compare with.
    expect(await shipOf(root, [])).toEqual({ op: "release", gate: "ship", env: "box", bookkeeping: ["decisions"], serving: null, pending: null });

    const seen: string[] = [];
    expect((await shipOf(root, [release(shipped)], seen))!.pending).toEqual({ files: 0, paths: [] });
    expect(seen).toContain("box/releases.jsonl");

    // A commit since, an uncommitted edit, an untracked file, and bookkeeping that doesn't count.
    writeFileSync(join(root, "app", "server.mjs"), "v2\n");
    writeFileSync(join(root, "decisions", "D-1.md"), "b\n");
    commitAll(root);
    writeFileSync(join(root, "app", "style.css"), "body{}\n");
    writeFileSync(join(root, "README.md"), "hi\n");
    writeFileSync(join(root, "decisions", "D-2.md"), "c\n");
    const ship = await shipOf(root, [release(shipped)]);
    expect(ship!.serving).toEqual({ commit: shipped, digest: `sha256:${"a".repeat(64)}`, component: "site", at: "2026-10-04T00:00:00Z", actor: "github:ada" });
    expect(ship!.pending).toEqual({ files: 3, paths: ["README.md", "app/server.mjs", "app/style.css"] });
    expect(SHIP_PENDING_PATHS_MAX).toBe(200);
  });

  test("a release from a commit this checkout doesn't have, or a ledger that can't be read, leaves pending null; no ship, no view", async () => {
    const root = repo({ "chant.workspace.json": declaration({ op: "release" }), "app/x": "" }, true);
    const ship = await shipOf(root, [release("f".repeat(40))]);
    expect(ship!.serving!.commit).toBe("f".repeat(40));
    expect(ship!.pending).toBeNull();
    expect((await shipOf(root, new Error("fatal: bad object")))!.serving).toBeNull();
    expect(await shipOf(repo({ "chant.workspace.json": declaration(undefined), "app/x": "" }, true), [])).toBeNull();
  });
});
