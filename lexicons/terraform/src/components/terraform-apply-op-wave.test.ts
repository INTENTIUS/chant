/**
 * `terraform-apply` as an op wave's step, run by core's `runOpWave` against a
 * fake `terraform` on `PATH` (chant#4854, terragucci issue 1303). The fake
 * logs each command with its directory and `TF_WORKSPACE`, keeps the
 * workspaces a root's backend lists in `.ws` beside the root, refuses an
 * init in a workspace that is not listed (as a real backend does) and a
 * `workspace select` while `TF_WORKSPACE` is set, and answers `output -json`
 * from `outputs-<workspace>.json`. Nothing reaches a cloud.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { CapabilityRegistry, type Capability } from "@intentius/chant/components/capability";
import { memoryGateLedgerPort, opWavePlanPath, runOpWave, type OpWaveRunHooks, type OpWavesSpec, type RunOpWaveResult } from "@intentius/chant/op";
import { terraformApplyCapability, terraformApplyCapabilityWith, type TerraformRootResolver } from "./capability-plugin";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllEnvs());

/** A fake terraform. `$FAKE_LOG` gets one line per command: `<name> <dir> ws=<TF_WORKSPACE or -> <args>`. */
const fake = (name: string) => `#!/bin/sh
ws="\${TF_WORKSPACE-}"
echo "${name} $PWD ws=\${TF_WORKSPACE--} $*" >> "$FAKE_LOG"
case "$1" in
  init)
    if [ -n "$ws" ] && [ "$ws" != "default" ] && ! grep -qx "$ws" .ws 2>/dev/null; then
      echo "Error: Currently selected workspace \\"$ws\\" does not exist" >&2; exit 1
    fi
    exit 0 ;;
  workspace)
    if [ -n "\${TF_WORKSPACE+x}" ]; then echo "Error: The selected workspace is currently overridden using the TF_WORKSPACE environment variable." >&2; exit 1; fi
    for a in "$@"; do w="$a"; done
    grep -qx "$w" .ws 2>/dev/null || echo "$w" >> .ws
    exit 0 ;;
  plan)
    for a in "$@"; do case "$a" in -out=*) out="\${a#-out=}" ;; esac; done
    echo plan > "$out"
    exit 2 ;;
  show)
    echo '{"format_version":"1.2","resource_changes":[{"address":"terraform_data.x","mode":"managed","type":"terraform_data","name":"x","change":{"actions":["create"],"before":null,"after":{}}}]}'
    exit 0 ;;
  apply) exit 0 ;;
  output)
    f="outputs-\${ws:-default}.json"
    if [ -f "$f" ]; then cat "$f"; else echo '{}'; fi
    exit 0 ;;
esac
echo "fake ${name}: unexpected $*" >&2
exit 1
`;

/** A project with roots at `roots/<name>`, a `chant.config.json` naming `binary`, and a fake `terraform` on PATH. */
function project(roots: string[], config: Record<string, unknown> = { binary: "terraform" }): { dir: string; log: string; bin: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-tf-op-wave-")));
  made.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const name of ["terraform", "tofu"]) {
    writeFileSync(join(bin, name), fake(name));
    chmodSync(join(bin, name), 0o755);
  }
  const log = join(dir, "fake.log");
  writeFileSync(log, "");
  vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
  vi.stubEnv("FAKE_LOG", log);
  for (const r of roots) {
    mkdirSync(join(dir, "roots", r), { recursive: true });
    writeFileSync(join(dir, "roots", r, "main.tf"), "");
  }
  writeFileSync(join(dir, "chant.config.json"), JSON.stringify({ lexicons: ["terraform"], terraform: config }));
  return { dir, log, bin };
}

/** The fake's log, with the project's directory as `.`. */
const lines = (p: { dir: string; log: string }): string[] =>
  readFileSync(p.log, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(p.dir).join("."));

/** A log line without the plan file's name. */
const plain = (l: string): string => l.replace(/ -out=\S+| \S+\.tfplan$/g, "");

const registry = (cap: Capability<never, unknown> = terraformApplyCapability as unknown as Capability<never, unknown>) => new CapabilityRegistry().register(cap);

function spec(runs: OpWavesSpec["waves"][number]["runs"], step: Record<string, unknown> = {}): OpWavesSpec {
  return {
    name: "tf-apply",
    op: "tf-apply",
    gateName: "wave-{k}",
    step: { kind: "terraform-apply", root: "{target}", dir: "{target}", lockTimeout: false, ...step },
    waves: [{ name: "wave-1", gate: "never", runs }],
  } as OpWavesSpec;
}

function wave(cwd: string, s: OpWavesSpec, o: { runHooks?: OpWaveRunHooks; capabilities?: CapabilityRegistry } = {}): Promise<RunOpWaveResult> {
  return runOpWave({
    spec: s,
    specFile: "waves.json",
    wave: 1,
    cwd,
    show: () => ({ sha: "b".repeat(40), text: JSON.stringify(s) }),
    gates: memoryGateLedgerPort(),
    capabilities: o.capabilities ?? registry(),
    ...(o.runHooks ? { runHooks: o.runHooks } : {}),
    log: () => {},
  });
}

describe("a root that names its workspace (chant#4854)", () => {
  test("inits in default, selects or creates the workspace with TF_WORKSPACE unset, then plans, applies and reads outputs in it", async () => {
    const p = project(["app"]);
    const result = await wave(p.dir, spec([{ target: "roots/app", input: { workspace: "ue1-prod" } }], { cwd: p.dir }));
    expect(result.exitCode).toBe(0);
    expect(result.applied).toEqual(["roots/app"]);
    expect(lines(p).map(plain)).toEqual([
      "terraform ./roots/app ws=default init -input=false",
      "terraform ./roots/app ws=- workspace select -or-create=true ue1-prod",
      "terraform ./roots/app ws=ue1-prod plan -input=false -detailed-exitcode",
      "terraform ./roots/app ws=ue1-prod show -json",
      "terraform ./roots/app ws=ue1-prod apply -input=false",
      "terraform ./roots/app ws=ue1-prod output -json",
    ]);
    expect(readFileSync(join(p.dir, "roots/app/.ws"), "utf-8")).toBe("ue1-prod\n");
  });

  test("the step's workspace wins over a TF_WORKSPACE the run hook's env sets", async () => {
    const p = project(["app"]);
    const runHooks: OpWaveRunHooks = { name: "product", beforePlan: () => ({ env: { TF_WORKSPACE: "ue1-prod", ROLE: "app" } }) };
    const result = await wave(p.dir, spec([{ target: "roots/app", input: { workspace: "ue1-prod" } }], { cwd: p.dir }), { runHooks });
    expect(result.exitCode).toBe(0);
    const log = lines(p);
    expect(log[0]).toBe("terraform ./roots/app ws=default init -input=false");
    expect(log[1]).toBe("terraform ./roots/app ws=- workspace select -or-create=true ue1-prod");
    expect(log.filter((l) => / (plan|apply|output) /.test(l)).every((l) => l.includes(" ws=ue1-prod "))).toBe(true);
  });

  test("a workspace the backend lists already is selected, not created again", async () => {
    const p = project(["app"]);
    writeFileSync(join(p.dir, "roots/app/.ws"), "ue1-prod\n");
    const result = await wave(p.dir, spec([{ target: "roots/app", input: { workspace: "ue1-prod" } }], { cwd: p.dir }));
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(p.dir, "roots/app/.ws"), "utf-8")).toBe("ue1-prod\n");
  });

  test("without the input, a run hook's TF_WORKSPACE of a new workspace fails init, as before", async () => {
    const p = project(["app"]);
    const runHooks: OpWaveRunHooks = { name: "product", beforePlan: () => ({ env: { TF_WORKSPACE: "ue1-prod" } }) };
    await expect(wave(p.dir, spec([{ target: "roots/app" }], { cwd: p.dir }), { runHooks })).rejects.toThrow(/Currently selected workspace "ue1-prod" does not exist/);
    expect(lines(p)).toEqual(["terraform ./roots/app ws=ue1-prod init -input=false"]);
    expect(existsSync(join(p.dir, "roots/app/.ws"))).toBe(false);
  });

  test("a root that names no workspace runs as before: no select, and no TF_WORKSPACE", async () => {
    const p = project(["app"]);
    const result = await wave(p.dir, spec([{ target: "roots/app" }], { cwd: p.dir }));
    expect(result.exitCode).toBe(0);
    expect(lines(p).some((l) => l.includes(" workspace "))).toBe(false);
    expect(lines(p).every((l) => l.includes(" ws=- "))).toBe(true);
  });
});

describe("where the step looks for chant.config (chant#4854)", () => {
  test("with no cwd in the step, a wave run in process for another directory reads that directory's config", async () => {
    const p = project(["app"], { binary: "tofu" });
    // The process runs elsewhere: this checkout's own chant.config is not the project's.
    expect(process.cwd()).not.toBe(p.dir);
    const result = await wave(p.dir, spec([{ target: "roots/app" }]));
    expect(result.exitCode).toBe(0);
    expect(result.applied).toEqual(["roots/app"]);
    // The project's binary, in the project's directory.
    expect(lines(p).map((l) => l.split(" ").slice(0, 3).join(" "))).toEqual(["tofu ./roots/app ws=-", "tofu ./roots/app ws=-", "tofu ./roots/app ws=-", "tofu ./roots/app ws=-", "tofu ./roots/app ws=-"]);
  });

  test("a cwd the step names still wins", async () => {
    const p = project(["app"], { binary: "tofu" });
    const other = project(["app"], { binary: "terraform" });
    const result = await wave(p.dir, spec([{ target: "roots/app" }], { cwd: other.dir }));
    expect(result.exitCode).toBe(0);
    // Both fakes log to the last project's file; each line names the directory and binary it ran.
    const ran = lines(other);
    expect(ran.length).toBeGreaterThan(0);
    expect(ran.every((l) => l.startsWith("terraform ./roots/app "))).toBe(true);
  });
});

describe("a root that runs another binary than chant.config names (terragucci issue 1303)", () => {
  test("a product's resolveRoot gives each root its own binary, by path, for its plan, apply and outputs", async () => {
    const p = project(["a", "b"], { binary: "terraform" });
    const asked: string[] = [];
    const resolveRoot: TerraformRootResolver = async (root, input) => {
      asked.push(`${root} ${input.cwd === p.dir ? "at the wave's directory" : String(input.cwd)}`);
      return root === "roots/b" ? { binary: join(p.bin, "tofu") } : {};
    };
    const capabilities = registry(terraformApplyCapabilityWith({ resolveRoot }) as unknown as Capability<never, unknown>);
    const result = await wave(p.dir, spec([{ target: "roots/a" }, { target: "roots/b" }]), { capabilities });
    expect(result.exitCode).toBe(0);
    expect(result.applied).toEqual(["roots/a", "roots/b"]);
    const ran = lines(p).map((l) => l.split(" ").slice(0, 3).join(" ") + " " + l.split(" ")[3]);
    expect(ran).toEqual([
      "terraform ./roots/a ws=- init",
      "terraform ./roots/a ws=- plan",
      "terraform ./roots/a ws=- show",
      "tofu ./roots/b ws=- init",
      "tofu ./roots/b ws=- plan",
      "tofu ./roots/b ws=- show",
      "terraform ./roots/a ws=- apply",
      "terraform ./roots/a ws=- output",
      "tofu ./roots/b ws=- apply",
      "tofu ./roots/b ws=- output",
    ]);
    // Asked once per plan and once per apply, with the step's input as the wave filled it.
    expect(asked).toEqual(["roots/a at the wave's directory", "roots/b at the wave's directory", "roots/a at the wave's directory", "roots/b at the wave's directory"]);
  });

  test("the change set names the planner each root ran", async () => {
    const p = project(["b"], { binary: "terraform" });
    const capabilities = registry(terraformApplyCapabilityWith({ resolveRoot: () => ({ binary: join(p.bin, "tofu") }) }) as unknown as Capability<never, unknown>);
    const s = spec([{ target: "roots/b" }]);
    const result = await wave(p.dir, s, { capabilities });
    expect(result.exitCode).toBe(0);
    const file = JSON.parse(readFileSync(join(p.dir, opWavePlanPath(s, 1, "roots/b")), "utf-8")) as { changeSet?: { member: { planner: string } } };
    expect(file.changeSet?.member.planner).toBe("tofu");
  });

  test("a step's own binary runs without a resolver, and a resolver that answers nothing leaves the config's", async () => {
    const p = project(["a"], { binary: "terraform" });
    expect((await wave(p.dir, spec([{ target: "roots/a" }], { binary: "tofu" }))).exitCode).toBe(0);
    expect(lines(p).every((l) => l.startsWith("tofu "))).toBe(true);
    const q = project(["a"], { binary: "terraform" });
    const capabilities = registry(terraformApplyCapabilityWith({ resolveRoot: () => ({}) }) as unknown as Capability<never, unknown>);
    expect((await wave(q.dir, spec([{ target: "roots/a" }]), { capabilities })).exitCode).toBe(0);
    expect(lines(q).every((l) => l.startsWith("terraform "))).toBe(true);
  });

  test("a resolver that throws fails the root's plan", async () => {
    const p = project(["a"], { binary: "terraform" });
    const capabilities = registry(terraformApplyCapabilityWith({ resolveRoot: () => { throw new Error("tofu 1.9.1 is not installed"); } }) as unknown as Capability<never, unknown>);
    await expect(wave(p.dir, spec([{ target: "roots/a" }]), { capabilities })).rejects.toThrow(/tofu 1.9.1 is not installed/);
    expect(lines(p)).toEqual([]);
  });
});
