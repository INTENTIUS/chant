/**
 * A live read leaves the root as it found it (#4379).
 *
 * `describeResources` on a choudoufu root runs `live-plan -json` and used to
 * write the document it parsed into the root as `chant.live-plan.json`, at the
 * default depth and at the plan depth alike. A reader that observes a project
 * (behold's only write inside a served project is `.behold/layout.json`) must
 * not find a new file there afterwards.
 *
 * The root is a copy of `__fixtures__/live-estate/`, the real activities run
 * against a stubbed `node:child_process` that answers `live-plan -json` with
 * the recorded document, and the test snapshots every file in the root (path
 * and bytes) before and after.
 */

import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import { describeResources, type TerraformReadDeps } from "./describe-resources";
import { renderTerraformRoots } from "./hcl/roots";
import {
  __resetChoudoufuVersionCheckForTests,
  choudoufuLiveLs,
  choudoufuLivePlan,
  choudoufuLivePlanDocument,
  terraformInit,
  terraformShow,
} from "./op/activities/terraform";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const LIVE_PLAN_DOC = readFileSync(join(fixtures, "live-plan.json"), "utf-8");
const PLAN: unknown = JSON.parse(readFileSync(join(fixtures, "live-plan-depth", "show-plan.json"), "utf-8"));

const commands: string[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const custom = Symbol.for("nodejs.util.promisify.custom");
  const exec = ((_cmd: string, _opts: unknown, cb?: (...a: unknown[]) => void) => {
    cb?.(new Error("unmocked exec path"));
  }) as unknown as Record<symbol, unknown>;
  exec[custom] = async (cmd: string) => {
    commands.push(cmd);
    if (cmd === "choudoufu version") return { stdout: "choudoufu v99.0.0\n", stderr: "" };
    if (cmd.includes("live-plan") && cmd.includes("-json")) return { stdout: LIVE_PLAN_DOC, stderr: "" };
    return { stdout: "", stderr: "" };
  };
  return { ...actual, exec };
});

const workspaces: string[] = [];
afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  commands.length = 0;
  __resetChoudoufuVersionCheckForTests();
});

/** A project whose one root is a copy of the live-estate fixture. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-live-root-"));
  workspaces.push(dir);
  cpSync(join(fixtures, "live-estate"), join(dir, "estate"), { recursive: true });
  writeFileSync(
    join(dir, "chant.config.json"),
    JSON.stringify({ lexicons: ["terraform"], terraform: { binary: "choudoufu", roots: { estate: { dir: "./estate" } } } }),
  );
  return dir;
}

/** Every file under `dir`, path -> bytes, so a new, removed or rewritten file all show. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(dir, path)] = readFileSync(path, "base64");
    }
  };
  walk(dir);
  return out;
}

async function read(dir: string, depth: "plan" | "state") {
  const { entities } = await renderTerraformRoots({ projectRoot: dir, roots: { estate: { dir: "./estate" } }, binary: "choudoufu" });
  const declared = new Map<string, { entityType: string; props: Record<string, unknown> }>();
  for (const [key, entity] of entities) {
    declared.set(key, { entityType: entity.entityType, props: (entity as Declarable & { props: Record<string, unknown> }).props });
  }
  // The plan read is injected (it writes under the OS temp dir by design, #4358);
  // the live-plan read is the real activity over the stubbed binary.
  const planRead = (async () => ({
    json: PLAN,
    dir: join(dir, "estate"),
    planDir: "/tmp/chant-terraform-plan-x",
    command: "choudoufu plan -input=false -lock=false -out=/tmp/chant-terraform-plan-x/plan.tfplan",
  })) as TerraformReadDeps["planRead"];
  return describeResources(
    { environment: "prod", buildOutput: "", entityNames: [...declared.keys()].sort(), entities: declared, depth, cwd: dir },
    { init: terraformInit, show: terraformShow, liveLs: choudoufuLiveLs, livePlan: choudoufuLivePlanDocument, planRead },
  );
}

describe("a live read writes nothing into the root (#4379)", () => {
  for (const depth of ["state", "plan"] as const) {
    it(`${depth === "state" ? "the default depth" : "the plan depth"} leaves the root byte-for-byte unchanged`, async () => {
      const dir = project();
      const before = snapshot(dir);
      await read(dir, depth);
      expect(commands.some((c) => c.includes("live-plan") && c.includes("-json"))).toBe(true);
      expect(snapshot(dir)).toEqual(before);
    });
  }

  it("the Op activity still writes the document, because its documentPath is an output a later step opens", async () => {
    const dir = project();
    const result = await choudoufuLivePlan({ root: "estate", cwd: dir });
    expect(result.documentPath).toBe("chant.live-plan.json");
    expect(JSON.parse(readFileSync(join(dir, "estate", "chant.live-plan.json"), "utf-8"))).toEqual(JSON.parse(LIVE_PLAN_DOC));
  });
});
