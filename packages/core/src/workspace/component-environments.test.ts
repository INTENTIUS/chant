/**
 * #3153, ws-095: a component declares where each release goes, by
 * environment (the runtime that hosts it, its URL, a custom domain and the
 * git remote its lifecycle records go to), replacing studio's
 * `studio.sites` key in delivery's chant.config.ts. The contract validates
 * it, `chant graph --components` carries it, and `graph --composites` lists
 * each environment with its site.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { computeComponentGraph } from "../components/cli-support";
import componentSchema from "../components/component.schema.json";
import { ChantConfigSchema, environmentExecutor } from "../config";
import { componentEnvironments, memberEnvironments, type EnvironmentReason } from "./environments";
import type { MemberRuntimes } from "./runtimes";

const NO_EXECUTOR = { forge: null, workflow: null, reason: { code: "executor-none-declared", message: expect.any(String) } };

const runtimes = (environments: MemberRuntimes["environments"], lexicons: string[] = []): MemberRuntimes => ({ lexicons, default: "local", reasons: [], environments });

const SITES = [
  { name: "prod", runtime: "local" },
  { name: "fly", runtime: "fly", lifecycle: "origin", url: "https://shop.fly.dev", domain: "shop.example.com" },
];

describe("a component's environments in the contract (#3153)", () => {
  const validate = new Ajv2020({ strict: false }).compile(componentSchema);
  const base = { name: "app", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy" }] }] };

  test("are optional, each a name with an optional runtime, url, domain and lifecycle", () => {
    expect(validate(base)).toBe(true);
    expect(validate({ ...base, environments: SITES })).toBe(true);
  });

  test("refuse an empty list, an entry with no name, a url that isn't http and a field nobody reads", () => {
    expect(validate({ ...base, environments: [] })).toBe(false);
    expect(validate({ ...base, environments: [{ runtime: "fly" }] })).toBe(false);
    expect(validate({ ...base, environments: [{ name: "fly", url: "shop.fly.dev" }] })).toBe(false);
    expect(validate({ ...base, environments: [{ name: "fly", region: "ams" }] })).toBe(false);
  });
});

describe("chant graph --components carries them (#3153)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(tmpdir(), `chant-3153-${Date.now()}-${Math.random()}`);
    await mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("for a component that declares them, and not for one that doesn't", async () => {
    await writeFile(
      join(dir, "app.component.ts"),
      `export const app = { name: "app", dependsOn: [], environments: ${JSON.stringify(SITES)}, deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy" }] }] };\n` +
        `export const db = { name: "db", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy" }] }] };\n`,
    );
    const graph = await computeComponentGraph(dir);
    expect(graph.success, graph.error).toBe(true);
    expect(graph.environments).toEqual({ app: SITES });
  });
});

describe("graph --composites lists each environment with the component's site (#3153)", () => {
  test("an environment the config names takes the site, and the command runs on the site's runtime when the member hosts it", () => {
    const member = memberEnvironments(runtimes(["prod", "fly"], ["fly"]), { envs: [], reason: null });
    const envs = componentEnvironments("app", member, "local", SITES, ["fly"]);
    expect(envs).toEqual([
      { name: "local", default: true, source: "builtin", site: null, executor: NO_EXECUTOR, command: "chant run --components app" },
      { name: "prod", default: false, source: "config", site: { runtime: "local", url: null, domain: null, lifecycle: null }, executor: NO_EXECUTOR, command: "chant run --components app --env prod" },
      {
        name: "fly",
        default: false,
        source: "config",
        site: { runtime: "fly", url: "https://shop.fly.dev", domain: "shop.example.com", lifecycle: "origin" },
        executor: NO_EXECUTOR,
        command: "chant run --components app --on fly --env fly",
      },
    ]);
  });

  test("a site whose runtime the member doesn't host runs on the default runtime", () => {
    const member = memberEnvironments(runtimes(["fly"]), { envs: [], reason: null });
    const fly = componentEnvironments("app", member, "local", SITES, []).find((e) => e.name === "fly")!;
    expect(fly.command).toBe("chant run --components app --env fly");
    expect(fly.site?.runtime).toBe("fly");
  });

  test("an environment only the component names is added when the config declares none, and left out with a reason when the config doesn't cover it", () => {
    const open = memberEnvironments(runtimes([]), { envs: [], reason: null });
    expect(componentEnvironments("app", open, "local", SITES).map((e) => `${e.name}:${e.source}`)).toEqual(["local:builtin", "prod:component", "fly:component"]);

    const reasons: EnvironmentReason[] = [];
    const closed = memberEnvironments(runtimes(["prod"]), { envs: [], reason: null });
    expect(componentEnvironments("app", closed, "local", SITES, [], reasons).map((e) => e.name)).toEqual(["local", "prod"]);
    expect(reasons).toEqual([{ code: "environments-component-undeclared", message: expect.stringMatching(/component app declares environment fly/) }]);
  });

  test("a pattern in the config covers a declared name", () => {
    const member = memberEnvironments(runtimes(["pr-*"]), { envs: [], reason: null });
    const envs = componentEnvironments("app", member, "local", [{ name: "pr-7", url: "https://pr-7.example.com" }]);
    expect(envs.find((e) => e.name === "pr-7")).toMatchObject({ source: "component", site: { url: "https://pr-7.example.com" } });
  });
});

describe("an environment's executor in chant.config.ts (#4402)", () => {
  const prod = { name: "prod", executor: { forge: "github" as const, workflow: "deploy-prod.yml" } };

  test("is optional on an environment entry, and refuses an unknown forge, an empty workflow and a stray field", () => {
    expect(ChantConfigSchema.safeParse({ environments: ["staging", prod] }).success).toBe(true);
    expect(ChantConfigSchema.safeParse({ environments: [{ name: "prod", executor: { forge: "jenkins", workflow: "x.yml" } }] }).success).toBe(false);
    expect(ChantConfigSchema.safeParse({ environments: [{ name: "prod", executor: { forge: "github", workflow: "" } }] }).success).toBe(false);
    expect(ChantConfigSchema.safeParse({ environments: [{ name: "prod", executor: { forge: "github", workflow: "x.yml", ref: "main" } }] }).success).toBe(false);
  });

  test("resolves a literal entry before a pattern, and a literal without one doesn't take the pattern's", () => {
    const envs = [prod, "pr-special", { name: "pr-*", executor: { forge: "gitlab" as const, workflow: ".gitlab-ci.yml" } }];
    expect(environmentExecutor(envs, "prod")).toEqual(prod.executor);
    expect(environmentExecutor(envs, "pr-7")).toEqual({ forge: "gitlab", workflow: ".gitlab-ci.yml" });
    expect(environmentExecutor(envs, "pr-special")).toBeUndefined();
    expect(environmentExecutor(envs, "staging")).toBeUndefined();
  });
});
