/**
 * `terraformApplyCapabilityWith({ onCommand })` (chant#4865): every engine
 * command the step runs for a root goes through the product's hook, with its
 * name, args, directory and environment before it runs, and its exit code,
 * duration and output after. Run by core's `runOpWave` with `parallelism` 2
 * against a fake `terraform` on `PATH` that logs each command with the
 * `$FAKE_TAG` it was run with, so the test reads which variable the hook added
 * reached which command. Nothing reaches a cloud.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CapabilityRegistry, type Capability } from "@intentius/chant/components/capability";
import { memoryGateLedgerPort, runOpWave, type OpWavesSpec } from "@intentius/chant/op";
import { terraformApplyCapabilityWith, type TerraformCommand, type TerraformCommandResult } from "./capability-plugin";

afterEach(() => vi.unstubAllEnvs());

const FAKE = `#!/bin/sh
cmd="$1"
root="\${PWD##*/}"
echo "$cmd $root \${FAKE_TAG:-none}" >> "$FAKE_LOG"
case "$cmd" in
  plan)
    sleep 0.05
    for a in "$@"; do case "$a" in -out=*) out="\${a#-out=}" ;; esac; done
    echo plan > "$out"
    exit 2 ;;
  apply) sleep 0.05 ;;
  show) echo "{\\"format_version\\":\\"1.2\\",\\"resource_changes\\":[{\\"address\\":\\"terraform_data.$root\\",\\"mode\\":\\"managed\\",\\"type\\":\\"terraform_data\\",\\"name\\":\\"$root\\",\\"change\\":{\\"actions\\":[\\"create\\"],\\"before\\":null,\\"after\\":{}}}]}" ;;
  output) echo '{"id":{"value":"x"}}' ;;
esac
exit 0
`;

function project(): { dir: string; log: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-tf-hook-")));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "terraform"), FAKE);
  chmodSync(join(bin, "terraform"), 0o755);
  const log = join(dir, "fake.log");
  writeFileSync(log, "");
  vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
  vi.stubEnv("FAKE_LOG", log);
  vi.stubEnv("TF_PLUGIN_CACHE_DIR", "");
  for (const r of ["a", "b", "up"]) {
    mkdirSync(join(dir, "roots", r), { recursive: true });
    writeFileSync(join(dir, "roots", r, "main.tf"), "");
  }
  writeFileSync(join(dir, "chant.config.json"), JSON.stringify({ lexicons: ["terraform"], terraform: { binary: "terraform" } }));
  return { dir, log };
}

const SPEC = {
  name: "tf-apply",
  op: "tf-apply",
  gateName: "wave-{k}",
  parallelism: 2,
  step: { kind: "terraform-apply", root: "{target}", dir: "{target}", lockTimeout: false },
  waves: [
    {
      name: "wave-1",
      gate: "never",
      runs: [
        { target: "roots/a" },
        // b reads an output of `up`, which the step inits and reads through the same hook.
        { target: "roots/b", input: { reads: [{ var: "id", root: "up", dir: "roots/up", output: ["id"] }] } },
      ],
    },
  ],
} as unknown as OpWavesSpec;

describe("terraform-apply's hook around each engine command (chant#4865)", () => {
  test("the hook sees each command of a root's plan and apply, times it, and its variable reaches the command", async () => {
    const p = project();
    const seen: Array<{ command: TerraformCommand; result: TerraformCommandResult }> = [];
    const cap = terraformApplyCapabilityWith({
      onCommand: (command) => ({
        env: { FAKE_TAG: `${command.root}:${command.name}` },
        after: (result) => {
          seen.push({ command, result });
        },
      }),
    });
    const result = await runOpWave({
      spec: SPEC,
      specFile: "waves.json",
      wave: 1,
      cwd: p.dir,
      show: () => ({ sha: "c".repeat(40), text: JSON.stringify(SPEC) }),
      gates: memoryGateLedgerPort(),
      capabilities: new CapabilityRegistry().register(cap as unknown as Capability<never, unknown>),
      log: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.applied).toEqual(["roots/a", "roots/b"]);

    const of = (root: string, upstream?: string) => seen.filter((s) => s.command.root === root && s.command.upstream === upstream);
    const names = (root: string, method: string, upstream?: string) => of(root, upstream).filter((s) => s.command.method === method).map((s) => s.command.name);
    expect(names("roots/a", "plan")).toEqual(["init", "plan", "show"]);
    expect(names("roots/a", "run")).toEqual(["apply", "output"]);
    expect(names("roots/b", "plan")).toEqual(["init", "plan", "show"]);
    expect(names("roots/b", "plan", "up")).toEqual(["init", "output"]);

    const plan = of("roots/a").find((s) => s.command.name === "plan")!;
    expect(plan.command.binary).toBe("terraform");
    expect(plan.command.cwd).toBe(join(p.dir, "roots", "a"));
    expect(plan.command.args[0]).toBe("plan");
    expect(plan.command.args).toContain("-detailed-exitcode");
    expect(plan.command.env.TF_IN_AUTOMATION).toBe("1");
    expect(plan.result.code).toBe(2);
    expect(plan.result.seconds).toBeGreaterThanOrEqual(0.04);
    const apply = of("roots/a").find((s) => s.command.name === "apply")!;
    expect(apply.result.code).toBe(0);
    expect(apply.result.seconds).toBeGreaterThanOrEqual(0.04);
    expect(of("roots/b").find((s) => s.command.name === "plan")!.command.args).toContain("-var=id=x");
    expect(of("roots/a").find((s) => s.command.name === "show")!.result.stdout).toContain("terraform_data.a");

    // Every command the fake ran carried the variable the hook added for it.
    const lines = readFileSync(p.log, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBe(seen.length);
    for (const line of lines) {
      const [cmd, , tag] = line.split(" ");
      expect(tag).not.toBe("none");
      expect(tag!.endsWith(`:${cmd}`)).toBe(true);
    }
    expect(lines).toContain("plan a roots/a:plan");
    expect(lines).toContain("apply b roots/b:apply");
    expect(lines).toContain("output up roots/b:output");
  });

  test("a failed command reaches the hook's after with its exit code before the step fails", async () => {
    const p = project();
    writeFileSync(join(p.dir, "bin", "terraform"), `#!/bin/sh\necho "$1 \${PWD##*/} \${FAKE_TAG:-none}" >> "$FAKE_LOG"\necho broken >&2\nexit 1\n`);
    const results: Array<[string, TerraformCommandResult]> = [];
    const cap = terraformApplyCapabilityWith({ onCommand: (c) => ({ after: (r) => void results.push([c.name, r]) }) });
    const spec = { ...SPEC, waves: [{ name: "wave-1", gate: "never", runs: [{ target: "roots/a" }] }] } as unknown as OpWavesSpec;
    await expect(
      runOpWave({
        spec,
        specFile: "waves.json",
        wave: 1,
        cwd: p.dir,
        show: () => ({ sha: "d".repeat(40), text: JSON.stringify(spec) }),
        gates: memoryGateLedgerPort(),
        capabilities: new CapabilityRegistry().register(cap as unknown as Capability<never, unknown>),
        log: () => {},
      }),
    ).rejects.toThrow("terraform init -input=false");
    expect(results.map(([n]) => n)).toEqual(["init"]);
    expect(results[0]![1].code).toBe(1);
    expect(results[0]![1].stderr).toContain("broken");
  });
  test("a composed group's commands reach the hook as commands for each member (chant#4887)", async () => {
    const p = project();
    // The lexicon's runBinary passes `-chdir=<dir>` first, so the fake logs its second word, the subcommand.
    writeFileSync(join(p.dir, "bin", "tofu"), `#!/bin/sh\necho "$2 \${1##*/} \${FAKE_TAG:-none}" >> "$FAKE_LOG"\necho "Error: no provider" >&2\nexit 1\n`);
    chmodSync(join(p.dir, "bin", "tofu"), 0o755);
    writeFileSync(join(p.dir, "roots", "a", "main.tf"), 'output "id" {\n  value = "a"\n}\n');
    writeFileSync(join(p.dir, "roots", "b", "main.tf"), 'variable "a_id" {\n  type = string\n}\n');
    writeFileSync(join(p.dir, "chant.config.json"), JSON.stringify({ lexicons: ["terraform"], terraform: { binary: "tofu", roots: { a: { dir: "roots/a" }, b: { dir: "roots/b" } }, compose: { enabled: true } } }));
    const seen: TerraformCommand[] = [];
    const cap = terraformApplyCapabilityWith({ onCommand: (c) => ({ env: { FAKE_TAG: `${c.members?.join("+")}:${c.name}` }, after: () => void seen.push(c) }) });
    const members = [
      { component: "a", step: { root: "a", vars: {} }, input: { root: "a", vars: {} }, reads: [], dependsOn: [], ctx: { env: "test", component: "a" } },
      { component: "b", step: { root: "b", vars: { a_id: { stackOutput: { stack: "a", name: "id" } } } }, input: { root: "b", vars: { a_id: undefined } }, reads: [{ at: "/vars/a_id", ref: "a.id", component: "a", output: "id" }], dependsOn: ["a"], ctx: { env: "test", component: "b" } },
    ];
    await expect(cap.planGroup!({ env: "test", cwd: p.dir } as never, members as never)).rejects.toThrow(/init failed/);
    expect(seen.map((c) => [c.name, c.root, c.members, c.method])).toEqual([["init", "a", ["a", "b"], "plan"]]);
    expect(readFileSync(p.log, "utf-8").trim()).toBe("init a a+b:init");
  });
});
