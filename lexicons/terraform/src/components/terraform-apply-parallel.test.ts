/**
 * `terraform-apply` roots planned and applied `parallelism` at once on one
 * provider cache (chant#4864), run by core's `runOpWave` against a fake
 * `terraform` on `PATH`. The fake sleeps per command (`$FAKE_SLEEP_INIT`,
 * and a root's own `delay` file for plan and apply), and marks each command
 * in flight with a file under `$FAKE_STATE/<command>/`, moving it to
 * `$FAKE_STATE/done/` when it ends. Every command logs how many of its kind
 * were in flight as it started, so the test reads the most that ever ran
 * together. The roots' `show -json` names the root, so each has its own
 * plan digest. Nothing reaches a cloud.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { CapabilityRegistry, type Capability } from "@intentius/chant/components/capability";
import { memoryGateLedgerPort, opWavePlanPath, runOpWave, type OpWavesSpec, type RunOpWaveResult } from "@intentius/chant/op";
import { terraformApplyCapability } from "./capability-plugin";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllEnvs());

const FAKE = `#!/bin/sh
cmd="$1"
mkdir -p "$FAKE_STATE/$cmd" "$FAKE_STATE/done"
mark="$FAKE_STATE/$cmd/\${PWD##*/}.$$"
: > "$mark"
n=$(ls "$FAKE_STATE/$cmd" | wc -l | tr -d ' ')
echo "$cmd \${PWD##*/} $n" >> "$FAKE_LOG"
root="\${PWD##*/}"
case "$cmd" in
  init) sleep "\${FAKE_SLEEP_INIT:-0.1}" ;;
  plan)
    sleep "$(cat delay 2>/dev/null || echo 0.2)"
    for a in "$@"; do case "$a" in -out=*) out="\${a#-out=}" ;; esac; done
    echo plan > "$out" ;;
  apply) sleep "$(cat delay 2>/dev/null || echo 0.2)" ;;
  show) echo "{\\"format_version\\":\\"1.2\\",\\"resource_changes\\":[{\\"address\\":\\"terraform_data.$root\\",\\"mode\\":\\"managed\\",\\"type\\":\\"terraform_data\\",\\"name\\":\\"$root\\",\\"change\\":{\\"actions\\":[\\"create\\"],\\"before\\":null,\\"after\\":{}}}]}" ;;
  output) echo '{}' ;;
esac
mv "$mark" "$FAKE_STATE/done/"
[ "$cmd" = plan ] && exit 2
exit 0
`;

const ROOTS = ["a", "b", "c", "d"];

/** A project with `roots/<name>` for each root, each planning slower than the next, and the fake on PATH. */
function project(): { dir: string; log: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-tf-par-")));
  made.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "terraform"), FAKE);
  chmodSync(join(bin, "terraform"), 0o755);
  const log = join(dir, "fake.log");
  writeFileSync(log, "");
  mkdirSync(join(dir, "state"));
  vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
  vi.stubEnv("FAKE_LOG", log);
  vi.stubEnv("FAKE_STATE", join(dir, "state"));
  vi.stubEnv("FAKE_SLEEP_INIT", "0.03");
  for (const [i, r] of ROOTS.entries()) {
    mkdirSync(join(dir, "roots", r), { recursive: true });
    writeFileSync(join(dir, "roots", r, "main.tf"), "");
    writeFileSync(join(dir, "roots", r, "delay"), String(0.06 + 0.03 * (ROOTS.length - i)));
  }
  writeFileSync(join(dir, "chant.config.json"), JSON.stringify({ lexicons: ["terraform"], terraform: { binary: "terraform" } }));
  return { dir, log };
}

/** The fake's log as `{ command: [root, in flight] }`, in the order the commands started. */
function started(log: string): Record<string, Array<[string, number]>> {
  const out: Record<string, Array<[string, number]>> = {};
  for (const line of readFileSync(log, "utf-8").split("\n").filter(Boolean)) {
    const [cmd, root, n] = line.split(" ");
    (out[cmd!] ??= []).push([root!, Number(n)]);
  }
  return out;
}

const most = (rows: Array<[string, number]> | undefined) => Math.max(0, ...(rows ?? []).map(([, n]) => n));

function spec(parallelism?: number): OpWavesSpec {
  return {
    name: "tf-apply",
    op: "tf-apply",
    gateName: "wave-{k}",
    ...(parallelism !== undefined ? { parallelism } : {}),
    step: { kind: "terraform-apply", root: "{target}", dir: "{target}", lockTimeout: false },
    waves: [{ name: "wave-1", gate: "never", runs: ROOTS.map((r) => ({ target: `roots/${r}` })) }],
  } as OpWavesSpec;
}

async function wave(cwd: string, s: OpWavesSpec): Promise<{ result: RunOpWaveResult; files: string[] }> {
  const result = await runOpWave({
    spec: s,
    specFile: "waves.json",
    wave: 1,
    cwd,
    show: () => ({ sha: "b".repeat(40), text: JSON.stringify(s) }),
    gates: memoryGateLedgerPort(),
    capabilities: new CapabilityRegistry().register(terraformApplyCapability as unknown as Capability<never, unknown>),
    log: () => {},
  });
  const files = ROOTS.map((r) => {
    const f = join(cwd, opWavePlanPath(s, 1, `roots/${r}`));
    return existsSync(f) ? readFileSync(f, "utf-8") : "";
  });
  return { result, files };
}

describe("terraform-apply roots at once on one provider cache (chant#4864)", () => {
  test("the plans and applies overlap, and no two inits ever run at once", async () => {
    const p = project();
    vi.stubEnv("TF_PLUGIN_CACHE_DIR", join(p.dir, "cache"));
    const { result } = await wave(p.dir, spec(4));
    expect(result.exitCode).toBe(0);
    expect(result.applied).toEqual(ROOTS.map((r) => `roots/${r}`));
    const s = started(p.log);
    expect(s.init?.length).toBe(4);
    expect(most(s.init)).toBe(1);
    expect(most(s.plan)).toBeGreaterThan(1);
    expect(most(s.apply)).toBeGreaterThan(1);
  });

  test("the digest, members and plan files are the ones one root at a time makes", async () => {
    const run = async (parallelism?: number) => {
      const p = project();
      vi.stubEnv("TF_PLUGIN_CACHE_DIR", join(p.dir, "cache"));
      const got = await wave(p.dir, spec(parallelism));
      return { ...got, started: started(p.log), dir: p.dir };
    };
    const one = await run();
    const many = await run(4);
    expect(most(one.started.plan)).toBe(1);
    expect(most(many.started.plan)).toBeGreaterThan(1);
    expect(many.result.decision?.digest).toBeDefined();
    expect(many.result.decision?.digest).toBe(one.result.decision?.digest);
    expect(many.result.decision?.members).toEqual(one.result.decision?.members);
    // A plan file names its plan by path inside the project, so it reads the same with each project's directory taken out.
    const local = (files: string[], dir: string) => files.map((f) => f.split(dir).join("."));
    expect(local(many.files, many.dir)).toEqual(local(one.files, one.dir));
    expect(new Set(many.result.decision?.members.map((m) => m.planDigest)).size).toBe(4);
  });

  test("with no cache the roots' inits run at once, each in its own directory", async () => {
    const p = project();
    vi.stubEnv("TF_PLUGIN_CACHE_DIR", "");
    const { result } = await wave(p.dir, spec(4));
    expect(result.exitCode).toBe(0);
    expect(most(started(p.log).init)).toBeGreaterThan(1);
  });
});
