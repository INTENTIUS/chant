/**
 * One runner of the engine for a product (chant#4954): a plan stage's own
 * commands and each Terragrunt unit's plan reach the same `onCommand` as
 * `terraform-apply`'s, the trace parent per command is the lexicon's, and
 * every run (async, blocking, Terragrunt, the script chant's step runs)
 * leaves the forge's tokens out. Fake binaries are small `sh` scripts in a
 * temporary directory; nothing reaches a cloud, a forge or a collector.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { OtlpTrace } from "@intentius/chant/otlp";
import { commandTrace, commandTraceEnv, composeCommandHooks, engineRunner, withTerraformCommandHook, type TerraformCommand, type TerraformCommandHook, type TerraformCommandResult } from "./engine-runner";
import { engineTimings } from "./engine-timings";
import type { BinaryExec } from "./state/exec";
import { planTerragruntWave, terragruntUnitWrapper, type TerragruntExec } from "./terragrunt/run";

const tmp = (): string => mkdtempSync(join(tmpdir(), "chant-engine-runner-"));

/** An executable `sh` script at `path`. */
function script(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const JOB = { PATH: process.env.PATH ?? "/usr/bin:/bin", GITHUB_TOKEN: "ghs_forge", TG_TOKEN: "tg-secret", COPY: "tg-secret", TF_VAR_token: "tg-secret", KEEP: "yes" };

describe("the plan stage's own commands", () => {
  test("go through the command hook of the call they run in, as commands for its root", async () => {
    const seen: TerraformCommand[] = [];
    const ran: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const fake: BinaryExec = async (_b, args, _d, env) => {
      ran.push({ args, env });
      return { code: args[0] === "plan" ? 2 : 0, stdout: "out", out: "outerr" };
    };
    const results: TerraformCommandResult[] = [];
    const runner = engineRunner({ tokens: ["TG_TOKEN"], exec: fake });
    await withTerraformCommandHook(
      (c) => {
        seen.push(c);
        // A hook that names a token gets it taken out all the same.
        return { env: { HOOKED: c.name, GITHUB_TOKEN: "put-back" }, after: (r) => void results.push(r) };
      },
      { root: "roots/a", method: "plan" },
      async () => {
        await runner.exec("tofu", ["init", "-input=false"], "/w/roots/a", { ...JOB });
        await runner.exec("tofu", ["plan", "-detailed-exitcode"], "/w/roots/a", { ...JOB });
      },
    );
    expect(seen.map((c) => [c.root, c.method, c.name])).toEqual([
      ["roots/a", "plan", "init"],
      ["roots/a", "plan", "plan"],
    ]);
    expect(ran[1]!.env.HOOKED).toBe("plan");
    expect(ran[1]!.env.GITHUB_TOKEN).toBeUndefined();
    expect(ran[1]!.env.TG_TOKEN).toBeUndefined();
    expect(ran[1]!.env.COPY).toBeUndefined();
    expect(ran[1]!.env.TF_VAR_token).toBe("tg-secret");
    expect(results.map((r) => r.code)).toEqual([0, 2]);
    expect(results[1]).toMatchObject({ stdout: "out", stderr: "err" });
  });

  test("outside a hook's call the binary just runs, its tokens left out", async () => {
    const ran: NodeJS.ProcessEnv[] = [];
    const runner = engineRunner({ tokens: ["TG_TOKEN"], exec: async (_b, _a, _d, env) => (ran.push(env), { code: 0, stdout: "", out: "" }) });
    await runner.exec("tofu", ["version"], "/w", { ...JOB });
    expect(ran[0]!.KEEP).toBe("yes");
    expect(ran[0]!.TG_TOKEN).toBeUndefined();
    expect(runner.tokens).toEqual(expect.arrayContaining(["TG_TOKEN", "GITHUB_TOKEN"]));
  });
});

describe("the blocking, Terragrunt and script runs", () => {
  test("execSync runs the binary in its directory with TF_IN_AUTOMATION and no tokens", () => {
    const dir = tmp();
    const bin = script(join(dir, "bin/tofu"), 'echo "args=$*"\necho "tok=${GITHUB_TOKEN:-none} copy=${COPY:-none} tfvar=${TF_VAR_token:-none} auto=$TF_IN_AUTOMATION"\necho oops >&2\nexit 3');
    const r = engineRunner({ tokens: ["TG_TOKEN"] }).execSync(bin, ["plan"], "/w/roots/a", { ...JOB });
    expect(r.code).toBe(3);
    expect(r.stdout).toContain("args=-chdir=/w/roots/a plan");
    expect(r.stdout).toContain("tok=none copy=none tfvar=tg-secret auto=1");
    expect(r.out).toContain("oops");
  });

  test("execSync answers 127 for a binary that is not there", () => {
    const r = engineRunner().execSync(join(tmp(), "missing"), ["version"], "/w", { ...JOB });
    expect(r.code).toBe(127);
    expect(r.out).toMatch(/ENOENT/);
  });

  test("terragrunt runs with the job's environment under the call's, less the tokens", async () => {
    const dir = tmp();
    const tg = script(join(dir, "terragrunt"), 'echo "pwd=$(pwd) tok=${GITHUB_TOKEN:-none} copy=${COPY:-none} call=$CALL"');
    const saved = { ...process.env };
    Object.assign(process.env, { GITHUB_TOKEN: "ghs_forge", TG_TOKEN: "tg-secret", COPY: "tg-secret" });
    try {
      const r = await engineRunner({ tokens: ["TG_TOKEN"] }).terragrunt(tg, ["find"], { cwd: dir, env: { CALL: "given" } });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("tok=none copy=none call=given");
    } finally {
      for (const k of ["GITHUB_TOKEN", "TG_TOKEN", "COPY"]) if (saved[k] === undefined) delete process.env[k];
    }
  });

  test("script writes one same-named script that drops the tokens, by name and by value, and runs the binary", () => {
    const dir = tmp();
    const bin = script(join(dir, "real/tofu"), 'echo "tok=${GITHUB_TOKEN:-none} tg=${TG_TOKEN:-none} copy=${COPY:-none} tfvar=${TF_VAR_token:-none} keep=$KEEP args=$*"');
    const runner = engineRunner({ tokens: ["TG_TOKEN"] });
    const path = runner.script(join(dir, "scripts"), bin, { ...JOB });
    expect(path.endsWith("/tofu")).toBe(true);
    expect(runner.script(join(dir, "scripts"), bin, { ...JOB })).toBe(path);
    const r = spawnSync(path, ["plan"], { encoding: "utf-8", env: { ...JOB } });
    expect(r.stdout.trim()).toBe("tok=none tg=none copy=none tfvar=tg-secret keep=yes args=plan");
  });

  test("script finds a bare name on PATH, so it never runs itself", () => {
    const dir = tmp();
    script(join(dir, "real/tofu"), "echo real");
    const env = { ...JOB, PATH: `${join(dir, "scripts-first")}:${join(dir, "real")}:/usr/bin:/bin` };
    const path = engineRunner().script(join(dir, "scripts"), "tofu", env);
    expect(readFileSync(path, "utf-8")).toContain(`'${join(dir, "real/tofu")}'`);
  });
});

describe("the trace parent per command", () => {
  test("commandTraceEnv gives TRACEPARENT and names the span, keeping the job's resource attributes and exporter", () => {
    const trace = new OtlpTrace();
    const span = trace.start("root roots/a");
    const env = commandTraceEnv({ OTEL_RESOURCE_ATTRIBUTES: "team=infra", OTEL_TRACES_EXPORTER: "none" }, trace, span, { prefix: "terragucci", root: "roots/a" });
    expect(env.TRACEPARENT).toBe(`00-${trace.traceId}-${span.spanId}-01`);
    expect(env.OTEL_TRACES_EXPORTER).toBe("none");
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain("team=infra");
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain(`terragucci.span_id=${span.spanId}`);
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain("terragucci.root=roots%2Fa");
    expect(commandTraceEnv({}, trace, span, { prefix: "p", root: "r" }).OTEL_TRACES_EXPORTER).toBe("otlp");
  });

  test("commandTrace opens a span per command under the root's, and ends it with the exit code", async () => {
    const trace = new OtlpTrace();
    const root = trace.start("root roots/a");
    const hook = commandTrace({ trace, prefix: "terragucci", parent: (c) => (c.root === "roots/a" ? root : undefined), env: {} });
    const runner = engineRunner({ exec: async (_b, args) => ({ code: args[0] === "plan" ? 2 : args[0] === "apply" ? 1 : 0, stdout: "", out: "" }) });
    const envs: string[] = [];
    await withTerraformCommandHook(
      async (c) => {
        const r = await hook(c);
        if (r?.env) envs.push(r.env.TRACEPARENT!);
        return r;
      },
      { root: "roots/a", method: "plan" },
      async () => {
        await runner.exec("tofu", ["plan"], "/w", {});
        await runner.exec("tofu", ["apply"], "/w", {});
      },
    );
    const spans = trace.spans.filter((s) => s !== root);
    expect(spans.map((s) => [s.name, s.parentSpanId, s.kind, s.attributes["process.exit.code"], s.error])).toEqual([
      ["tofu plan", root.spanId, 3, 2, undefined],
      ["tofu apply", root.spanId, 3, 1, "exit 1"],
    ]);
    expect(envs).toEqual(spans.map((s) => trace.traceparent(s)));
  });

  test("an upstream's reads are not traced unless asked, and a command timed apart spans its own time", async () => {
    const trace = new OtlpTrace();
    const hook = commandTrace({ trace, prefix: "p", env: {} });
    const base = { root: "roots/a", method: "plan", binary: "tofu", name: "init", args: ["init"], line: "tofu init", cwd: "/w", env: {} };
    expect(await hook({ ...base, upstream: "roots/up" })).toBeUndefined();
    const run = await hook({ ...base, name: "plan", args: ["plan"] });
    await run!.after!({ code: 0, seconds: 2, stdout: "", stderr: "", at: { start: 1_700_000_000_000, end: 1_700_000_002_000 } });
    expect(trace.spans[0]!.start).toBe(1_700_000_000_000n * 1_000_000n);
    expect(trace.spans[0]!.end).toBe(1_700_000_002_000n * 1_000_000n);
  });

  test("as engineTimings' inner hook, a command gets the trace parent and the receiver's exporter", async () => {
    const trace = new OtlpTrace();
    const timings = await engineTimings({ inner: commandTrace({ trace, prefix: "p", env: {} }) });
    try {
      const envs: NodeJS.ProcessEnv[] = [];
      const runner = engineRunner({ exec: async (_b, _a, _d, env) => (envs.push(env), { code: 0, stdout: "", out: "" }) });
      await withTerraformCommandHook(timings.onCommand, { root: "roots/a", method: "plan" }, () => runner.exec("tofu", ["plan"], "/w", {}));
      expect(envs[0]!.TRACEPARENT).toBe(trace.traceparent(trace.spans[0]!));
      if (!timings.problem) expect(envs[0]!.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect(timings.root("roots/a")?.commands.map((c) => c.command)).toEqual(["plan"]);
    } finally {
      await timings.close();
    }
  });
});

describe("a Terragrunt unit's plan", () => {
  test("the wrapper sets a unit's variables for the plan whose -out names it, and runs the binary as it is otherwise", () => {
    const text = terragruntUnitWrapper("/bin/tofu", ["/w/plans", "/private/w/plans"], new Map<string, Record<string, string>>([["live/a", { X: "it's" }], ["live/b", {}]]));
    expect(text).toContain(`'/w/plans/live/a/tfplan.tfplan' | '/private/w/plans/live/a/tfplan.tfplan') export X='it'\\''s' ;;`);
    expect(text).not.toContain("live/b");
    expect(text.trimEnd().endsWith(`exec '/bin/tofu' "$@"`)).toBe(true);
  });

  test("reaches onCommand once per unit, its variables reach that unit's plan alone, and its after has the report's time", async () => {
    const dir = tmp();
    const record = join(dir, "seen");
    const bin = script(join(dir, "bin/tofu"), `echo "$UNIT_VAR" >> '${record}'`);
    const seen: TerraformCommand[] = [];
    const after = new Map<string, TerraformCommandResult>();
    const calls: Array<{ args: readonly string[]; env: Record<string, string> }> = [];
    const exec: TerragruntExec = async (_f, args, opts) => {
      calls.push({ args, env: opts.env });
      const at = (flag: string): string => args[args.indexOf(flag) + 1]!;
      // Terragrunt runs the binary through TG_TF_PATH for each unit's plan, then an init with no -out.
      for (const unit of ["live/a", "live/b"]) spawnSync(opts.env.TG_TF_PATH!, ["plan", `-out=${join(at("--out-dir"), unit, "tfplan.tfplan")}`], { encoding: "utf-8" });
      spawnSync(opts.env.TG_TF_PATH!, ["init"], { encoding: "utf-8", env: { ...process.env, UNIT_VAR: "none" } });
      writeFileSync(
        at("--report-file"),
        JSON.stringify([
          { Name: "live/a", Result: "succeeded", Started: "2026-11-10T10:00:00Z", Ended: "2026-11-10T10:00:04Z" },
          { Name: "live/b", Result: "failed", Reason: "run error", Started: "2026-11-10T10:00:00Z", Ended: "2026-11-10T10:00:01Z" },
        ]),
      );
      return { code: 1, stdout: "", stderr: "" };
    };
    await planTerragruntWave({
      dir,
      units: ["live/b", "live/a"],
      workDir: "w",
      binary: bin,
      provisional: true,
      exec,
      onCommand: (c) => {
        seen.push(c);
        return { env: { UNIT_VAR: `for ${c.root}` }, after: (r) => void after.set(c.root, r) };
      },
    });
    expect(seen.map((c) => [c.root, c.method, c.name, c.binary])).toEqual([
      ["live/a", "plan", "plan", bin],
      ["live/b", "plan", "plan", bin],
    ]);
    expect(seen[0]!.cwd).toBe(join(dir, "live/a"));
    expect(readFileSync(record, "utf-8").trim().split("\n")).toEqual(["for live/a", "for live/b", "none"]);
    expect(after.get("live/a")).toMatchObject({ code: 0, seconds: 4, at: { start: Date.parse("2026-11-10T10:00:00Z"), end: Date.parse("2026-11-10T10:00:04Z") } });
    expect(after.get("live/b")).toMatchObject({ code: 1, seconds: 1, stderr: "failed: run error" });
    expect(calls[0]!.env.TG_TF_PATH).not.toBe(bin);
  });

  test("a unit missing from the report gets a null code, and a wave with no binary calls no hook", async () => {
    const dir = tmp();
    const bin = script(join(dir, "bin/tofu"), "true");
    const after: TerraformCommandResult[] = [];
    const exec: TerragruntExec = async (_f, args) => {
      writeFileSync(args[args.indexOf("--report-file") + 1]!, "[]");
      return { code: 0, stdout: "", stderr: "" };
    };
    await planTerragruntWave({ dir, units: ["live/a"], workDir: "w", binary: bin, provisional: true, exec, onCommand: () => ({ after: (r) => void after.push(r) }) });
    expect(after).toMatchObject([{ code: null, seconds: 0, error: "not in Terragrunt's run report, so it did not run" }]);
    let called = false;
    await planTerragruntWave({ dir, units: ["live/a"], workDir: "w2", provisional: true, exec, onCommand: () => void (called = true) });
    expect(called).toBe(false);
  });
});

describe("what a product's own command trace read (chant#5007)", () => {
  test("exec answers stderr apart, and a binary that could not be started as the spawn error", async () => {
    const dir = tmp();
    const bin = script(join(dir, "bin/tofu"), "echo out\necho err >&2\nexit 1");
    const runner = engineRunner();
    const ran = await runner.exec(bin, ["init"], dir, { ...JOB });
    expect(ran).toMatchObject({ code: 1, stdout: "out\n", stderr: "err\n" });
    expect(ran.error).toBeUndefined();
    const missing = await runner.exec(join(dir, "missing"), ["init"], dir, { ...JOB });
    expect(missing.code).toBe(127);
    expect(missing.error).toMatch(/ENOENT/);
    const sync = runner.execSync(bin, ["init"], dir, { ...JOB });
    expect(sync).toMatchObject({ code: 1, stdout: "out\n", stderr: "err\n" });
    expect(runner.execSync(join(dir, "missing"), ["init"], dir, { ...JOB }).error).toMatch(/ENOENT/);
  });

  test("a stage's own run is traced once, as the product's trace was: span, attributes, variables, exit and error", async () => {
    const dir = tmp();
    const record = join(dir, "env");
    const bin = script(join(dir, "bin/tofu"), `echo "$TRACEPARENT $OTEL_RESOURCE_ATTRIBUTES $OTEL_TRACES_EXPORTER" >> '${record}'\n[ "$1" = "-chdir=${dir}" ] || exit 9\n[ "$2" = plan ] && exit 2\nexit 0`);
    const trace = new OtlpTrace();
    const root = trace.start("root roots/a", undefined, { "terragucci.root": "roots/a" });
    const results: TerraformCommandResult[] = [];
    // The product's own timing half, beside chant's trace.
    const timing: TerraformCommandHook = () => ({ after: (r) => void results.push(r) });
    const hook = composeCommandHooks(timing, commandTrace({ trace, prefix: "terragucci", parent: () => root, env: { OTEL_RESOURCE_ATTRIBUTES: "team=infra" } }));
    const runner = engineRunner({ tokens: ["TG_TOKEN"] });
    await withTerraformCommandHook(hook, { root: "roots/a", method: "plan" }, async () => {
      expect((await runner.exec(bin, ["init", "-input=false"], dir, { ...JOB })).code).toBe(0);
      expect((await runner.exec(bin, ["plan", "-out=p"], dir, { ...JOB })).code).toBe(2);
      expect((await runner.exec(join(dir, "missing"), ["show"], dir, { ...JOB })).code).toBe(127);
    });
    const spans = trace.spans.filter((s) => s !== root);
    expect(spans.map((s) => [s.name, s.parentSpanId, s.kind, s.attributes["process.executable.name"], s.attributes["process.command_args"], s.attributes["process.exit.code"]])).toEqual([
      [`${bin} init`, root.spanId, 3, bin, "init -input=false", 0],
      [`${bin} plan`, root.spanId, 3, bin, "plan -out=p", 2],
      [`${join(dir, "missing")} show`, root.spanId, 3, join(dir, "missing"), "show", -1],
    ]);
    expect(spans[0]!.error).toBeUndefined();
    expect(spans[1]!.error).toBeUndefined();
    expect(spans[2]!.error).toMatch(/ENOENT/);
    const lines = readFileSync(record, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(trace.traceparent(spans[0]!));
    expect(lines[0]).toContain("team=infra");
    expect(lines[0]).toContain(`terragucci.span_id=${spans[0]!.spanId}`);
    expect(lines[0]).toContain("terragucci.root=roots%2Fa");
    expect(lines[0]!.endsWith(" otlp")).toBe(true);
    expect(results.map((r) => [r.code, r.error === undefined ? undefined : /ENOENT/.test(r.error)])).toEqual([
      [0, undefined],
      [2, undefined],
      [null, true],
    ]);
  });

  test("composeCommandHooks calls each hook in turn over the variables before it, and every after even when one throws", async () => {
    const order: string[] = [];
    const seenEnv: Array<Record<string, string>> = [];
    const hook = composeCommandHooks(
      (c) => {
        seenEnv.push({ ...c.env });
        return { env: { A: "1", OTEL_RESOURCE_ATTRIBUTES: "first=1" }, after: () => void order.push("first") };
      },
      undefined,
      (c) => {
        seenEnv.push({ ...c.env });
        return {
          env: { B: "2" },
          after: () => {
            order.push("second");
            throw new Error("second failed");
          },
        };
      },
      () => ({ after: () => void order.push("third") }),
    );
    const base: TerraformCommand = { root: "r", method: "plan", binary: "tofu", name: "plan", args: ["plan"], line: "tofu plan", cwd: "/w", env: { TF_IN_AUTOMATION: "1" } };
    const run = await hook(base);
    expect(seenEnv).toEqual([{ TF_IN_AUTOMATION: "1" }, { TF_IN_AUTOMATION: "1", A: "1", OTEL_RESOURCE_ATTRIBUTES: "first=1" }]);
    expect(run?.env).toEqual({ A: "1", OTEL_RESOURCE_ATTRIBUTES: "first=1", B: "2" });
    await expect(run!.after!({ code: 0, seconds: 1, stdout: "", stderr: "" })).rejects.toThrow("second failed");
    expect(order).toEqual(["first", "second", "third"]);
    expect(await composeCommandHooks(() => undefined)(base)).toBeUndefined();
  });
});
