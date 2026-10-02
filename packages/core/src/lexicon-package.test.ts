/**
 * chant#2845 — a lexicon the project installs in its own node_modules loads
 * when chant's own install can't reach it (a global chant): the plugin, its
 * op activities and its activity contracts, resolved from the working
 * directory after the bare import from chant's location fails.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importLexiconPackage, packageNameOf, resolveFromProject } from "./lexicon-module";
import { loadActivities } from "./op/activity-registry";
import { loadActivityContracts } from "./op/activity-contract-registry";
import { resolveLexiconVersions } from "./cli/plugins";

const NAME = "zz2845";
const PKG = `@intentius/chant-lexicon-${NAME}`;
let project: string;

beforeAll(async () => {
  project = await mkdtemp(join(tmpdir(), "chant-2845-"));
  const dir = join(project, "node_modules", "@intentius", `chant-lexicon-${NAME}`);
  await mkdir(join(dir, "op"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: PKG,
      version: "9.9.9",
      type: "module",
      exports: { ".": { default: "./index.js" }, "./op/activities": { default: "./op/activities.js" }, "./op/activity-contracts": { default: "./op/contracts.js" } },
    }),
  );
  await writeFile(join(dir, "index.js"), "export const marker = 'plugin';\n");
  await writeFile(join(dir, "op", "activities.js"), "export async function zz2845Probe() { return { ok: true }; }\n");
  // A contract is branded with a global symbol, so a plain object built here is one.
  await writeFile(
    join(dir, "op", "contracts.js"),
    "export const zz2845ProbeContract = { [Symbol.for('chant.op.activityContract')]: true, name: 'zz2845Probe', args: {}, returns: {} };\n",
  );
});

afterAll(async () => {
  await rm(project, { recursive: true, force: true });
});

describe("importLexiconPackage (#2845)", () => {
  test("a package chant can't reach is imported from the project", async () => {
    await expect(import(PKG)).rejects.toThrow();
    const mod = await importLexiconPackage(PKG, project);
    expect(mod.marker).toBe("plugin");
    const op = await importLexiconPackage(`${PKG}/op/activities`, project);
    expect(typeof op.zz2845Probe).toBe("function");
  });

  test("a package chant reaches loads from chant's install, whatever the directory", async () => {
    const mod = await importLexiconPackage("zod", project);
    expect(typeof mod.z).toBe("object");
  });

  test("a package neither has fails with the bare import's own error", async () => {
    await expect(importLexiconPackage("@intentius/chant-lexicon-nope-2845", project)).rejects.toThrow(/chant-lexicon-nope-2845/);
  });

  test("a path is not looked up in the project", () => {
    expect(packageNameOf("/abs/lexicon.ts")).toBeUndefined();
    expect(packageNameOf("./lexicon.ts")).toBeUndefined();
    expect(packageNameOf(`${PKG}/op/activities`)).toBe(PKG);
    expect(resolveFromProject(PKG, project)).toMatch(/index\.js$/);
  });
});

describe("the loaders take the project's lexicon (#2845)", () => {
  const inProject = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    const cwd = process.cwd();
    process.chdir(project);
    try {
      return await fn();
    } finally {
      process.chdir(cwd);
    }
  };

  test("loadActivities finds its op activities", async () => {
    const activities = await inProject(() => loadActivities([NAME]));
    expect(activities.has("zz2845Probe")).toBe(true);
  });

  test("loadActivityContracts finds its contracts", async () => {
    const contracts = await inProject(() => loadActivityContracts([NAME]));
    expect(contracts.has("zz2845Probe")).toBe(true);
  });

  test("resolveLexiconVersions reads its version", async () => {
    expect(await inProject(() => resolveLexiconVersions([NAME]))).toEqual({ [NAME]: "9.9.9" });
  });
});
