/**
 * The `steward` scaffold has to be a project, not a snippet (chant #2129).
 *
 * `chant init --lexicon fountain --template steward` is only worth shipping if
 * what it writes builds, lints clean, and produces a manifest `fountainApply`
 * accepts. That is three separate ways to be wrong — a type error, a lint
 * finding, a manifest whose Teammate names an agent no route can resolve — and
 * none of them show up in a test that only asserts the template's text.
 *
 * So this materializes the template set to a real directory inside the
 * workspace (module resolution for `@intentius/chant-lexicon-fountain` needs
 * the repo's `node_modules` above it), then runs the three.
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { build } from "@intentius/chant/build";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { declaredBuildOptions } from "@intentius/chant-test-utils/example-harness";
import { fountainInitTemplates } from "./init-templates";
import { fountainSerializer } from "./serializer";
import { fountainApply, type FountainHttp } from "./op/activities/fountain-apply";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(pkgDir, ".init-template-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Write one template set to disk the way `chant init` does. */
function materialize(template: string | undefined, dir: string): string {
  const set = fountainInitTemplates(template);
  const srcDir = join(dir, "src");
  mkdirSync(srcDir, { recursive: true });
  for (const [file, content] of Object.entries(set.src)) {
    writeFileSync(join(srcDir, file), content);
  }
  for (const [file, content] of Object.entries(set.root ?? {})) {
    writeFileSync(join(dir, file), content);
  }
  return srcDir;
}

describe("the steward template", () => {
  const projectDir = join(scratch, "steward");
  const srcDir = materialize("steward", projectDir);

  it("ships its own chant.config.ts, because its commands need one", () => {
    const set = fountainInitTemplates("steward");
    expect(Object.keys(set.src).sort()).toEqual([
      "fountain.ts",
      "prod-converge.op.ts",
      "prod-watch.op.ts",
    ]);
    expect(set.root?.["chant.config.ts"]).toContain("fountain:");
    expect(set.root?.["chant.config.ts"]).toContain('token: { env: "FOUNTAIN_TOKEN" }');
    // Never a literal token — FTN001's rule, stated in the scaffold itself.
    expect(set.root?.["chant.config.ts"]).not.toMatch(/token:\s*"/);
  });

  it("lints clean", async () => {
    const result = await lintCommand({ path: srcDir, format: "stylish" });
    if (!result.success || result.errorCount > 0 || result.warningCount > 0) {
      console.log(result.output);
    }
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  it("builds the six kinds a steward is made of", async () => {
    const result = await build(srcDir, [fountainSerializer], undefined, await declaredBuildOptions(srcDir));
    expect(result.errors).toEqual([]);
    const yaml = result.outputs.get("fountain") as string;
    expect([...yaml.matchAll(/^kind:\s+(\S+)$/gm)].map((m) => m[1])).toEqual([
      "Environment",
      "Vault",
      "Agent",
      "Teammate",
      "Schedule",
      "Schedule",
    ]);
    expect(yaml).toContain("runtime_command: chant acp");
    expect(yaml).toContain("prompt: chant run prod-watch");
    expect(yaml).toContain("prompt: chant run prod-converge");
  });

  it("produces a manifest fountainApply accepts", async () => {
    const result = await build(srcDir, [fountainSerializer], undefined, await declaredBuildOptions(srcDir));
    const manifestContent = result.outputs.get("fountain") as string;

    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    // The steward's Agent scopes itself to the Vault by name, so the bulk call
    // is two: the vault first, then the agent carrying the id it resolved to
    // (#2166). Each answers for what it was sent.
    const applyResults = [
      {
        status: 200,
        json: {
          data: {
            results: [
              { kind: "Environment", name: "prod-toolchain", action: "created", errors: null, secrets: [] },
              { kind: "Vault", name: "prod-creds", action: "created", errors: null, secrets: [] },
            ],
          },
        },
      },
      {
        status: 200,
        json: {
          data: {
            results: [
              { kind: "Agent", name: "prod-steward", action: "created", errors: null, secrets: [] },
            ],
          },
        },
      },
    ];
    const routes: Record<string, { status: number; json?: unknown }> = {
      "GET /api/agents": { status: 200, json: { data: [{ id: "a-1", name: "prod-steward" }] } },
      "GET /api/environments": { status: 200, json: { data: [{ id: "e-1", name: "prod-toolchain" }] } },
      "GET /api/vaults": { status: 200, json: { data: [{ id: "v-1", name: "prod-creds" }] } },
      "GET /api/team": { status: 200, json: { data: [] } },
      "POST /api/team": { status: 201, json: { data: { agent_id: "a-1" } } },
      "GET /api/team/a-1/schedules": { status: 200, json: { data: [] } },
      "POST /api/team/a-1/schedules": { status: 201, json: { data: { id: "s-1" } } },
    };
    const http: FountainHttp = async (method, path, body) => {
      calls.push({ method, path, body });
      if (method === "POST" && path === "/api/apply") {
        const reply = applyResults.shift();
        if (!reply) throw new Error("unexpected third POST /api/apply");
        return { status: reply.status, json: reply.json };
      }
      const hit = routes[`${method} ${path}`];
      if (!hit) throw new Error(`unrouted: ${method} ${path}`);
      return { status: hit.status, json: hit.json ?? null };
    };

    const summary = await fountainApply({ manifestContent }, http);

    expect(summary.created).toEqual([
      "Environment/prod-toolchain",
      "Vault/prod-creds",
      "Agent/prod-steward",
      "Teammate/prod-steward",
      "Schedule/prod-steward-prod-watch",
      "Schedule/prod-steward-prod-converge",
    ]);
    // The bulk kinds go out first, then the team-side ones on their own routes.
    const applies = calls.filter((c) => c.path === "/api/apply");
    expect(applies).toHaveLength(2);
    // The agent reaches fountain with the vault's id, never its name — a name
    // in `allowed_vault_ids` is a 500 out of Ecto (#2166).
    const agent = (applies[1].body as { resources: Array<{ spec: Record<string, unknown> }> }).resources[0];
    expect(agent.spec.allowed_vault_ids).toEqual(["v-1"]);
    expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/schedules"))).toHaveLength(2);
  });
});
