/**
 * The steward index behind `chant workspace status` (#3636): discovered
 * once per tree, read back while the tree is the same, discovered again
 * after an edit, a new file or a commit, and never written into the
 * checkout.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanScratch, commitAll, git, repo, scratchDir } from "./__fixtures__/contract-repo";
import { declareSteward } from "../op/steward";
import type { OpConfig } from "../op/types";
import { discoverStewardIndex, readStewardIndex, type StewardIndex } from "./steward-index";
import { readMemberStewards } from "./status-stewards";

afterAll(cleanScratch);

let cache: string;
let before: string | undefined;
beforeEach(() => {
  before = process.env.CHANT_CACHE_DIR;
  cache = scratchDir("chant-steward-index-cache-");
  process.env.CHANT_CACHE_DIR = cache;
});
afterEach(() => {
  if (before === undefined) delete process.env.CHANT_CACHE_DIR;
  else process.env.CHANT_CACHE_DIR = before;
  delete process.env.CHANT_STEWARD_INDEX;
});

function op(name: string, extra: Partial<OpConfig> = {}): OpConfig {
  return {
    name,
    overview: `${name} fixture`,
    phases: [{ name: "only", steps: [{ kind: "activity", fn: "noop", args: {} }] }],
    ...extra,
  } as OpConfig;
}

/** A chant project whose one Op file declares a steward and exports another Op it doesn't list. */
function project(): string {
  const tick = op("tick", { schedule: { cron: "0 * * * *" }, labels: { Env: "box" } });
  const build = op("build", { workLease: { item: "W-001", kind: "work/work.kind.mjs" }, changesCheckout: true });
  const steward = declareSteward({
    name: "box-steward",
    ops: [tick],
    beside: [{ op: build, ready: { kind: "activity", fn: "ready", args: {} } }],
    form: { default: "local", environments: { k3d: "fountain" } },
    capabilities: ["inference"],
  });
  return repo(
    {
      "chant.config.json": "{}\n",
      "ops/steward.op.ts": `export const steward = ${JSON.stringify(steward)};\nexport const lonely = { props: ${JSON.stringify(op("lonely"))} };\n`,
    },
    true,
  );
}

/** `readStewardIndex`, counting the discoveries it makes. */
function counted(dir: string) {
  let n = 0;
  const discover = async (d: string): Promise<StewardIndex> => {
    n++;
    return discoverStewardIndex(d);
  };
  return { read: () => readStewardIndex(dir, { discover }), discoveries: () => n };
}

describe("the steward index (#3636)", () => {
  test("holds what status reads of the stewards and Ops", async () => {
    const root = project();
    const index = await discoverStewardIndex(root);
    expect(index.errors).toEqual([]);
    expect(index.conflicts).toEqual([]);
    expect(index.stewards).toHaveLength(1);
    const [s] = index.stewards;
    expect(s).toMatchObject({
      name: "box-steward",
      beside: [{ op: "build", ready: true }],
      form: { default: "local", environments: { k3d: "fountain" } },
      capabilities: ["inference"],
      vault: null,
    });
    expect(s.filePath.endsWith(join("ops", "steward.op.ts"))).toBe(true);
    expect(s.ops).toEqual([
      { name: "tick", schedule: { cron: "0 * * * *" }, labels: { Env: "box" }, workLease: null, changesCheckout: false },
      { name: "build", schedule: null, workLease: { item: "W-001", kind: "work/work.kind.mjs" }, changesCheckout: true },
    ]);
    expect(index.otherOps).toEqual([{ name: "lonely", schedule: null, workLease: null, changesCheckout: false }]);
  });

  test("a second read of the same tree discovers nothing", async () => {
    const root = project();
    const c = counted(root);
    const first = await c.read();
    const second = await c.read();
    expect(c.discoveries()).toBe(1);
    expect(second).toEqual(JSON.parse(JSON.stringify(first)));
  });

  test("an edit, a new file or a commit discovers again", async () => {
    const root = project();
    const c = counted(root);
    await c.read();
    // A module already imported in this process isn't read again, so only the count is checked.
    writeFileSync(join(root, "ops", "steward.op.ts"), "export const nothing = 1;\n");
    await c.read();
    expect(c.discoveries()).toBe(2);
    await c.read();
    expect(c.discoveries()).toBe(2);
    mkdirSync(join(root, "lib"));
    writeFileSync(join(root, "lib", "helper.ts"), "export const x = 1;\n");
    await c.read();
    expect(c.discoveries()).toBe(3);
    commitAll(root);
    await c.read();
    expect(c.discoveries()).toBe(4);
  });

  test("an Op file that fails to import is not indexed, so the next read tries again", async () => {
    const root = project();
    writeFileSync(join(root, "ops", "broken.op.ts"), "throw new Error('not today');\n");
    const c = counted(root);
    expect((await c.read()).errors).toHaveLength(1);
    expect((await c.read()).errors).toHaveLength(1);
    expect(c.discoveries()).toBe(2);
  });

  test("CHANT_STEWARD_INDEX=0 discovers every time", async () => {
    const root = project();
    process.env.CHANT_STEWARD_INDEX = "0";
    const c = counted(root);
    await c.read();
    await c.read();
    expect(c.discoveries()).toBe(2);
    expect(existsSync(join(cache, "workspace-stewards"))).toBe(false);
  });

  test("the index lives in the cache dir, never in the checkout", async () => {
    const root = project();
    const status = git(root, "status", "--porcelain", "--ignored");
    await readStewardIndex(root);
    expect(git(root, "status", "--porcelain", "--ignored")).toBe(status);
    const [dir] = readdirSync(join(cache, "workspace-stewards"));
    expect(readdirSync(join(cache, "workspace-stewards", dir)).filter((f) => f.endsWith(".json"))).toHaveLength(1);
  });

  test("the indexes of a checkout that is gone go on the next write", async () => {
    const gone = project();
    await readStewardIndex(gone);
    rmSync(gone, { recursive: true, force: true });
    await readStewardIndex(project());
    expect(readdirSync(join(cache, "workspace-stewards"))).toHaveLength(1);
  });

  test("status lists the same stewards from the index as from discovery", async () => {
    const root = project();
    const now = "2027-01-01T00:00:00Z";
    process.env.CHANT_STEWARD_INDEX = "0";
    const discovered = await readMemberStewards(root, "k3d", now);
    delete process.env.CHANT_STEWARD_INDEX;
    await readMemberStewards(root, "k3d", now);
    const indexed = await readMemberStewards(root, "k3d", now, "chant", null, {
      readIndex: (d) => readStewardIndex(d, { discover: () => Promise.reject(new Error("should have been read from the index")) }),
    });
    expect(indexed).toEqual(discovered);
    expect(indexed.stewards[0]).toMatchObject({ name: "box-steward", form: "fountain", file: "ops/steward.op.ts" });
  });
});
