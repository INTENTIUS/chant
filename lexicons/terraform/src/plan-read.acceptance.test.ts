/**
 * The plan depth against a real binary (#4358).
 *
 * `src/__fixtures__/plan-read/` uses the built-in `terraform_data` resource
 * and a `local` backend, so `init` downloads nothing and no credentials are
 * involved. Each suite copies it to a temp project, initialises and applies it
 * at generation 1 (setup a person would do; the read itself never runs
 * `init`), then reads it at the plan depth with `next.tfvars` (generation 2).
 *
 * Gated per binary on `terraform` / `tofu` being on PATH, and skipped rather
 * than failed without one, like the other acceptance suites
 * (`__fixtures__/ACCEPTANCE.md`).
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { normalizeObservation } from "@intentius/chant/observation";
import type { Declarable } from "@intentius/chant/declarable";
import { buildChangeSet } from "@intentius/chant/lifecycle/change-set";
import { describeResources } from "./describe-resources";
import { renderTerraformRoots } from "./hcl/roots";
import { PLAN_READ_DIR_PREFIX, terraformPlanRead } from "./op/activities/terraform";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "plan-read");

function onPath(cmd: string): boolean {
  return spawnSync(cmd, ["version"], { stdio: "ignore" }).status === 0;
}

const workspaces: string[] = [];
const children: ChildProcess[] = [];
afterAll(() => {
  for (const child of children) child.kill("SIGKILL");
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

/** Every entry under `dir`, recursively, with its size and mtime: what "nothing new" compares. */
function snapshot(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .sort()
    .map((rel) => {
      const st = statSync(join(dir, rel));
      return `${rel} ${st.isDirectory() ? "dir" : `${st.size} ${st.mtimeMs}`}`;
    });
}

/** Our own scratch dirs currently under the OS temp directory. */
function planDirs(): string[] {
  return readdirSync(tmpdir()).filter((n) => n.startsWith(PLAN_READ_DIR_PREFIX)).sort();
}

function run(binary: string, args: string[], cwd: string): void {
  const r = spawnSync(binary, args, { cwd, encoding: "utf-8", env: { ...process.env, TF_IN_AUTOMATION: "1" } });
  if (r.status !== 0) throw new Error(`${binary} ${args.join(" ")} failed: ${r.stderr}`);
}

/** A temp project around a copy of the fixture; `applied` runs init and apply in it first. */
function project(binary: string, applied: boolean): { dir: string; root: string } {
  const dir = mkdtempSync(join(tmpdir(), "chant-plan-read-acc-"));
  workspaces.push(dir);
  const root = join(dir, "root");
  cpSync(FIXTURE, root, { recursive: true });
  writeFileSync(
    join(dir, "chant.config.json"),
    JSON.stringify({
      lexicons: ["terraform"],
      terraform: { binary, observe: "plan", roots: { app: { dir: "./root", varFiles: ["next.tfvars"] } } },
    }),
  );
  if (applied) {
    run(binary, ["init", "-input=false"], root);
    run(binary, ["apply", "-auto-approve", "-input=false"], root);
  }
  return { dir, root };
}

async function observe(dir: string) {
  const { entities } = await renderTerraformRoots({ projectRoot: dir, roots: { app: { dir: "./root" } } });
  const map = new Map<string, { entityType: string; props: Record<string, unknown> }>();
  for (const [key, entity] of entities) {
    map.set(key, { entityType: entity.entityType, props: (entity as Declarable & { props: Record<string, unknown> }).props });
  }
  const result = await describeResources({ environment: "prod", buildOutput: "", entityNames: [...map.keys()].sort(), entities: map, cwd: dir });
  return { raw: result, result: normalizeObservation(result), names: [...map.keys()].sort() };
}

for (const binary of ["terraform", "tofu"]) {
  describe.skipIf(!onPath(binary))(`the plan depth against a real ${binary} (#4358)`, () => {
    it("puts the plan on the IR, says \"plan\", writes nothing in the root and leaves no temp dir", async () => {
      const { dir, root } = project(binary, true);
      const before = snapshot(root);
      const tempBefore = planDirs();

      const { raw, result } = await observe(dir);

      expect(snapshot(root)).toEqual(before);
      expect(planDirs()).toEqual(tempBefore);

      expect(new Set(Object.values(result.sources))).toEqual(new Set(["plan"]));
      const attrs = (name: string) => result.resources[`app/${name}`]!.attributes as Record<string, unknown>;
      expect(attrs("terraform_data.replaced")).toMatchObject({
        planAction: "replace",
        planReplacePaths: ["triggers_replace"],
        planActionReason: "replace_because_cannot_update",
      });
      expect(attrs("terraform_data.downstream")).toMatchObject({ planAction: "update" });
      expect(attrs("terraform_data.downstream").planAfterUnknown).toContain("input");
      expect(attrs("terraform_data.updated").planChanges).toEqual(
        expect.arrayContaining([{ path: "input.name", before: "app-1", after: "app-2" }]),
      );
      expect(JSON.stringify(raw)).not.toContain("hunter2");
    }, 120_000);

    it("a block added after the apply is a planned create: absent, annotated, and still a create (#4372)", async () => {
      const { dir, root } = project(binary, true);
      // A new resource the applied state has never seen, reading another
      // block's new id, so its own id and its input are unknown until apply.
      appendFileSync(join(root, "main.tf"), `\nresource "terraform_data" "created" {\n  input = terraform_data.replaced.id\n}\n`);

      const { result, names } = await observe(dir);
      const CREATED = "app/terraform_data.created";
      expect(names).toContain(CREATED);
      expect(result.resources[CREATED]).toBeUndefined();
      expect(result.unobserved[CREATED]).toBeUndefined();
      expect(result.sources[CREATED]).toBe("plan");
      expect(result.annotations?.[CREATED]).toMatchObject({
        planAction: "create",
        planActions: { "terraform_data.created": ["create"] },
      });
      expect(result.annotations?.[CREATED]?.planAfterUnknown).toEqual(expect.arrayContaining(["id", "input"]));
      expect(Object.keys(result.annotations ?? {})).toEqual([CREATED]);

      const set = buildChangeSet("prod", {
        declared: new Set(names),
        observedNow: result.resources,
        observedThen: undefined,
        unobserved: result.unobserved,
      });
      expect(set.entries.find((e) => e.name === CREATED)?.action).toBe("create");
    }, 120_000);

    it("reads while another run holds the state lock, which a plan without -lock=false cannot", async () => {
      const { dir, root } = project(binary, true);
      // An apply waiting at its approval prompt holds the local backend's
      // lock for as long as its stdin stays open.
      const holder = spawn(binary, ["apply", "-var", "generation=3"], { cwd: root, stdio: ["pipe", "ignore", "ignore"] });
      children.push(holder);
      const lockInfo = join(root, ".terraform.tfstate.lock.info");
      for (let i = 0; i < 300 && !existsSync(lockInfo); i++) await new Promise((r) => setTimeout(r, 100));
      expect(existsSync(lockInfo)).toBe(true);

      // The lock really is held: the same plan without -lock=false fails on it.
      const locked = spawnSync(binary, ["plan", "-input=false", "-lock-timeout=0s", "-var-file=next.tfvars", `-out=${join(dir, "x.tfplan")}`], {
        cwd: root,
        encoding: "utf-8",
      });
      expect(locked.status).not.toBe(0);
      expect(locked.stderr).toMatch(/Error acquiring the state lock/);

      const read = await terraformPlanRead({ root: "app", cwd: dir });
      expect(read.command).toContain(" -lock=false ");
      expect((read.json as { resource_changes?: unknown[] }).resource_changes?.length).toBeGreaterThan(0);

      holder.stdin?.end();
      holder.kill("SIGKILL");
    }, 120_000);

    it("refuses a root that was never initialised with the init line, and writes nothing in it", async () => {
      const { dir, root } = project(binary, false);
      const before = snapshot(root);
      const { result } = await observe(dir);
      expect(snapshot(root)).toEqual(before);
      expect(Object.keys(result.resources)).toEqual([]);
      const replaced = result.unobserved["app/terraform_data.replaced"]!;
      expect(replaced.detail).toContain(`${binary} -chdir=${root} init -input=false`);
      expect(result.notes.join("\n")).toMatch(/declared only/);
    }, 120_000);
  });
}
