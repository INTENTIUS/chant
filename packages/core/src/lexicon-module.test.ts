/**
 * chant #2520 — a lexicon declared by module path in `chant.config.ts`
 * (`{ name, module }`) loads with no `@intentius/chant-lexicon-<name>`
 * package, for build, lint, run and the capability registry.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { loadChantConfig } from "./config";
import { lexiconModulePath, lexiconNames, resetLexiconModules } from "./lexicon-module";
import { loadPlugins, resolveProjectLexicons, loadPlugin } from "./cli/plugins";
import { loadActivities } from "./op/activity-registry";
import { loadActivityContracts } from "./op/activity-contract-registry";
import { loadGatePolicyEvaluator } from "./op/gate-approval";
import { buildCapabilityRegistry } from "./components/capability-plugin-loader";
import { buildCommand } from "./cli/commands/build";
import { lintCommand } from "./cli/commands/lint";

const activityContractModule = resolve(import.meta.dirname, "op/activity-contract.ts");
const zodModule = createRequire(import.meta.url).resolve("zod");

/** The whole project-local lexicon, in one module, importing core by absolute path so it needs no package. */
function lexiconSource(pluginName = "site"): string {
  return `
import { z } from ${JSON.stringify(zodModule)};
import { activityContract } from ${JSON.stringify(activityContractModule)};

export const sitePlugin = {
  name: ${JSON.stringify(pluginName)},
  serializer: {
    name: "site",
    rulePrefix: "SITE",
    serialize: (entities) => JSON.stringify({ pages: [...entities.keys()].sort() }),
  },
  generate: async () => {},
  validate: async () => {},
  coverage: async () => {},
  package: async () => {},
  activities: () => ({ siteDeploy: async (args) => ({ deployed: args.target }) }),
  activityContracts: () => [activityContract("siteDeploy", z.strictObject({ target: z.string() }))],
};

export const siteCapabilities = {
  name: "site-capabilities",
  version: "0.0.0",
  capabilities: () => [{ kind: "site-publish", run: async () => ({}) }],
};

export async function evaluateGatePolicy() {
  return { decision: "allow", determiningPolicies: [], errors: [] };
}
`;
}

function opSource(args: Record<string, unknown>): string {
  return `
export default {
  [Symbol.for("chant.declarable")]: true,
  entityType: "Chant::Op",
  lexicon: "chant",
  kind: "resource",
  props: {
    name: "publish",
    overview: "test",
    phases: [
      { name: "Publish", steps: [{ kind: "activity", fn: "siteDeploy", args: ${JSON.stringify(args)} }] },
    ],
  },
};
`;
}

describe("lexicons declared by module path (#2520)", () => {
  let dir: string;

  beforeEach(async () => {
    resetLexiconModules();
    dir = await mkdtemp(join(tmpdir(), "chant-lexicon-module-"));
    await mkdir(join(dir, "lexicon"));
    await writeFile(join(dir, "lexicon", "index.ts"), lexiconSource());
    await writeFile(
      join(dir, "chant.config.ts"),
      `export default { lexicons: [{ name: "site", module: "./lexicon/index.ts" }] };\n`,
    );
    await writeFile(
      join(dir, "main.ts"),
      `export const home = { lexicon: "site", entityType: "Site::Page", kind: "resource", props: {}, [Symbol.for("chant.declarable")]: true };\n`,
    );
  });

  afterEach(async () => {
    resetLexiconModules();
    await rm(dir, { recursive: true, force: true });
  });

  test("the loaded config holds the name, and the module path is recorded against the config's directory", async () => {
    const { config } = await loadChantConfig(dir);
    expect(config.lexicons).toEqual(["site"]);
    expect(config.lexiconModules).toEqual({ site: join(dir, "lexicon", "index.ts") });
    expect(lexiconModulePath("site")).toBe(join(dir, "lexicon", "index.ts"));
  });

  test("a config of plain names comes back as written, with nothing recorded", async () => {
    const plain = join(dir, "plain");
    await mkdir(plain);
    await writeFile(join(plain, "chant.config.ts"), `export default { lexicons: ["aws"] };\n`);
    const { config } = await loadChantConfig(plain);
    expect(config).toEqual({ lexicons: ["aws"] });
    expect(lexiconModulePath("aws")).toBeUndefined();
  });

  test("a later config naming the lexicon as a package drops the recorded path", async () => {
    await loadChantConfig(dir);
    expect(lexiconModulePath("site")).toBeDefined();
    // A second project; a config file is a module, cached by path.
    const other = join(dir, "other");
    await mkdir(other);
    await writeFile(join(other, "chant.config.ts"), `export default { lexicons: ["site"] };\n`);
    await loadChantConfig(other);
    expect(lexiconModulePath("site")).toBeUndefined();
  });

  test("an entry with an unknown key is rejected", async () => {
    const pinned = join(dir, "pinned");
    await mkdir(pinned);
    await writeFile(
      join(pinned, "chant.config.ts"),
      `export default { lexicons: [{ name: "site", module: "./lexicon/index.ts", pin: "x" }] };\n`,
    );
    await expect(loadChantConfig(pinned)).rejects.toThrow(/Invalid chant config/);
  });

  test("lexiconNames reads both entry forms", () => {
    expect(lexiconNames(["aws", { name: "site", module: "./x.ts" }])).toEqual(["aws", "site"]);
  });

  test("build: the plugin loads from the module and the project builds with it", async () => {
    const names = await resolveProjectLexicons(dir);
    expect(names).toEqual(["site"]);
    const plugins = await loadPlugins(names);
    expect(plugins.map((p) => p.name)).toEqual(["site"]);

    await writeFile(join(dir, "publish.op.ts"), opSource({ target: "prod" }));
    const result = await buildCommand({
      path: dir,
      format: "json",
      serializers: plugins.map((p) => p.serializer),
      plugins,
    });
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
    // The page and the Op.
    expect(result.resourceCount).toBe(2);
  });

  test("a plugin whose name differs from the declared name is refused", async () => {
    await writeFile(join(dir, "lexicon", "index.ts"), lexiconSource("other"));
    await loadChantConfig(dir);
    await expect(loadPlugin("site")).rejects.toThrow(/plugin it exports is named "other"/);
  });

  test("run: the plugin's activities are loaded by name, with no op/activities subpath", async () => {
    await loadChantConfig(dir);
    const activities = await loadActivities(["site"]);
    expect(await activities.get("siteDeploy")?.({ target: "prod" })).toEqual({ deployed: "prod" });
    // Core's base activities are still there.
    expect(activities.get("shellCmd")).toBeDefined();
  });

  test("activity contracts are found by name, with no op/activity-contracts subpath", async () => {
    await loadChantConfig(dir);
    const contracts = await loadActivityContracts(["site"]);
    expect(contracts.get("siteDeploy")).toBeDefined();
  });

  test("lint: the plugin's contract validates an Op step calling its activity", async () => {
    await writeFile(join(dir, "publish.op.ts"), opSource({ target: 42 }));
    const bad = await lintCommand({ path: dir, format: "stylish" });
    expect(
      bad.diagnostics.some((d) => d.ruleId === "OPS012" && d.message.includes("siteDeploy")),
    ).toBe(true);

    // A fresh path: ES modules are cached by URL, so the corrected Op needs its own file.
    await rm(join(dir, "publish.op.ts"));
    await writeFile(join(dir, "publish2.op.ts"), opSource({ target: "prod" }));
    const good = await lintCommand({ path: dir, format: "stylish" });
    expect(good.diagnostics.filter((d) => d.ruleId === "OPS012")).toEqual([]);
  });

  test("the capability registry registers the module's capability plugin", async () => {
    await loadChantConfig(dir);
    const registry = await buildCapabilityRegistry({ lexicons: ["site"] });
    expect(registry.has("site-publish")).toBe(true);
  });

  test("the gate policy evaluator is read from the module", async () => {
    await loadChantConfig(dir);
    const evaluator = await loadGatePolicyEvaluator("site");
    expect(typeof evaluator.evaluateGatePolicy).toBe("function");
  });
});
