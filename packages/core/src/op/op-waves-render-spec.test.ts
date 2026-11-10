/**
 * #4982: a waves spec the job renders at run time. The product's command
 * prints the spec at the commit chant hands it, the job runs on the spec it
 * printed at base, and the gate policy is read from that same render, so a
 * change that loosens the product's config at its head does not loosen its
 * own gate.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gitShowAtBase, parseOpWavesSpec, readOpWavePolicy, runOpWave, type OpWaveExec } from "./op-waves-run";
import { memoryGateLedgerPort } from "./gate";
import {
  commandSpecRender,
  OP_WAVES_SPEC_COMMAND_ENV,
  opWavesRenderSpecEnv,
  opWavesSpecCommandFromEnv,
  renderedJobMissing,
  renderedSpecShow,
  renderOpWavesSpecFile,
  RUNTIME_WAVES_SPEC_FLOOR,
} from "./op-waves-render-spec";
import { NEXT_RELEASE } from "../release-floors";
import type { OpWavesSpec } from "./op-waves";
import { parseArgs } from "../cli/parse-args";
import { runOpWaveCommand } from "../cli/handlers/run-wave";
import type { CommandContext } from "../cli/registry";

const SPEC_FILE = ".chant/op-waves/tf-apply.spec.json";

/** A product's command: the spec, with wave dev's gate and shares read from `config.json` at the commit chant names. */
const RENDER_JS = `
const { execFileSync } = require("node:child_process");
const at = process.env.CHANT_WAVES_SPEC_AT;
if (process.env.RENDER_FAIL) process.exit(2);
let config;
try { config = JSON.parse(execFileSync("git", ["show", at + ":config.json"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })); } catch { process.exit(0); }
process.stdout.write(JSON.stringify({
  name: "tf-apply", op: "tf-apply",
  plan: ["tool", "plan", "{target}", "--out", "{plan}"], apply: ["tool", "apply", "{target}", "--plan", "{plan}"],
  waves: [{ name: "dev", gate: config.gate, shares: config.shares, runs: [{ target: "a" }, { target: "b" }] }],
}));
`;

let repo: string;
let tools: string;
let command: string[];
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "op-waves-render-"));
  tools = mkdtempSync(join(tmpdir(), "op-waves-render-tool-"));
  writeFileSync(join(tools, "render.cjs"), RENDER_JS);
  command = [process.execPath, join(tools, "render.cjs")];
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "config.json"), JSON.stringify({ gate: "always", shares: 2 }));
  git("add", ".");
  git("commit", "-q", "-m", "base");
  // The change loosens the gate in the product's config.
  writeFileSync(join(repo, "config.json"), JSON.stringify({ gate: "never", shares: 2 }));
  git("commit", "-q", "-am", "loosen");
});

afterEach(() => {
  delete process.env.RENDER_FAIL;
  rmSync(repo, { recursive: true, force: true });
  rmSync(tools, { recursive: true, force: true });
});

describe("a waves spec the job renders at run time (#4982)", () => {
  test("the gate policy comes from the spec the command prints at base, not from the change's config", () => {
    const show = renderedSpecShow(SPEC_FILE, commandSpecRender(command, SPEC_FILE, repo), gitShowAtBase);
    const rules = readOpWavePolicy(SPEC_FILE, "dev", "HEAD^1", repo, show);
    expect(rules).toMatchObject({ policy: "always", source: "base", base: git("rev-parse", "HEAD^1") });
    // Without the render there is no spec at base at all.
    expect(readOpWavePolicy(SPEC_FILE, "dev", "HEAD^1", repo).source).toBe("absent-at-base");
  });

  test("the job's spec is rendered once per commit and written over the spec file", () => {
    let calls = 0;
    const render = commandSpecRender(command, SPEC_FILE, repo);
    const show = renderedSpecShow(SPEC_FILE, (sha) => (calls++, render(sha)), gitShowAtBase);
    const { spec, sha } = renderOpWavesSpecFile({ specFile: SPEC_FILE, base: "HEAD^1", cwd: repo, show, parse: parseOpWavesSpec });
    expect(sha).toBe(git("rev-parse", "HEAD^1"));
    expect(spec.waves[0]).toMatchObject({ name: "dev", gate: "always" });
    expect(parseOpWavesSpec(readFileSync(join(repo, SPEC_FILE), "utf-8"), "file").waves[0]!.gate).toBe("always");
    readOpWavePolicy(SPEC_FILE, "dev", "HEAD^1", repo, show);
    expect(calls).toBe(1);
    // Any other file is read through git.
    expect(show("HEAD", "config.json", repo).text).toContain('"never"');
  });

  test("a wave on the rendered spec waits under the gate at base, whatever the change's config says", async () => {
    const show = renderedSpecShow(SPEC_FILE, commandSpecRender(command, SPEC_FILE, repo), gitShowAtBase);
    const { spec } = renderOpWavesSpecFile({ specFile: SPEC_FILE, base: "HEAD^1", cwd: repo, show, parse: parseOpWavesSpec });
    const applied: string[] = [];
    const exec: OpWaveExec = (argv, dir) => {
      if (argv[1] === "plan") writeFileSync(join(dir, argv[4]!), JSON.stringify({ planDigest: `sha256:${"1".repeat(64)}`, changes: { create: 1 } }));
      if (argv[1] === "apply") applied.push(argv[2]!);
      return 0;
    };
    const result = await runOpWave({ spec: { ...spec, waves: [{ ...spec.waves[0]!, shares: undefined }] }, specFile: SPEC_FILE, wave: 1, cwd: repo, exec, show, gates: memoryGateLedgerPort(), head: git("rev-parse", "HEAD") });
    expect(result.exitCode).toBe(3);
    expect(result.decision).toMatchObject({ status: "waiting", policy: "always" });
    expect(applied).toEqual([]);
  });

  test("a command that fails fails the job; one that prints nothing reads as no spec at that commit", () => {
    process.env.RENDER_FAIL = "1";
    const failing = renderedSpecShow(SPEC_FILE, commandSpecRender(command, SPEC_FILE, repo), gitShowAtBase);
    expect(() => readOpWavePolicy(SPEC_FILE, "dev", "HEAD^1", repo, failing)).toThrow(/the spec command \(.*render\.cjs\) exited 2 at [0-9a-f]{12}/);
    delete process.env.RENDER_FAIL;
    git("rm", "-q", "config.json");
    git("commit", "-q", "-m", "drop the config");
    const empty = renderedSpecShow(SPEC_FILE, commandSpecRender(command, SPEC_FILE, repo), gitShowAtBase);
    expect(readOpWavePolicy(SPEC_FILE, "dev", "HEAD", repo, empty)).toMatchObject({ policy: "always", source: "absent-at-base" });
    expect(() => renderOpWavesSpecFile({ specFile: SPEC_FILE, base: "HEAD", cwd: repo, show: empty, parse: parseOpWavesSpec })).toThrow(/printed no spec at HEAD/);
  });

  test("a share or job group the shape has and the rendered spec does not has nothing to apply", () => {
    const spec: OpWavesSpec = { name: "s", op: "o", plan: ["p"], apply: ["a"], waves: [{ name: "w", runs: [{ target: "a" }, { target: "b" }], shares: 2 }, { name: "g", runs: [{ target: "a" }], jobs: [{ name: "eu", runs: ["a"], shares: 2 }] }] };
    expect(renderedJobMissing(spec, 1, { share: 2 })).toBeUndefined();
    expect(renderedJobMissing(spec, 1, { share: 3 })).toBe("wave 1 (w) has 2 shares in the spec rendered at base");
    expect(renderedJobMissing(spec, 2, { group: "us" })).toBe('wave 2 (g) has no job group "us" in the spec rendered at base');
    expect(renderedJobMissing(spec, 2, { group: "eu", share: 3 })).toBe('job group "eu" of wave 2 (g) has 2 shares in the spec rendered at base');
    expect(renderedJobMissing(spec, 2, { group: "eu", share: 1 })).toBeUndefined();
  });

  test("the command comes from CHANT_WAVES_SPEC_COMMAND as a JSON list of words", () => {
    expect(opWavesSpecCommandFromEnv({ [OP_WAVES_SPEC_COMMAND_ENV]: '["terragucci","waves-spec"]' })).toEqual(["terragucci", "waves-spec"]);
    expect(() => opWavesSpecCommandFromEnv({})).toThrow(/CHANT_WAVES_SPEC_COMMAND names, and it is unset/);
    expect(() => opWavesSpecCommandFromEnv({ [OP_WAVES_SPEC_COMMAND_ENV]: "terragucci waves-spec" })).toThrow(/must be a JSON list of words/);
    expect(opWavesRenderSpecEnv({ command: ["terragucci", "waves-spec"] })).toEqual({ CHANT_WAVES_SPEC_COMMAND: '["terragucci","waves-spec"]' });
    expect(opWavesRenderSpecEnv(undefined)).toEqual({});
    expect(() => opWavesRenderSpecEnv({ command: [] })).toThrow(/renderSpec.command must be/);
    expect(RUNTIME_WAVES_SPEC_FLOOR).toBe(NEXT_RELEASE);
  });

  test("chant run wave --render-spec writes the rendered spec, and a share it does not have exits 0", async () => {
    const was = process.cwd();
    const env = process.env[OP_WAVES_SPEC_COMMAND_ENV];
    process.env[OP_WAVES_SPEC_COMMAND_ENV] = JSON.stringify(command);
    process.chdir(repo);
    try {
      const ctx = { args: parseArgs(["run", "wave", "--spec", SPEC_FILE, "--wave", "1", "--share", "3", "--render-spec"]), plugins: [], serializers: [] } as unknown as CommandContext;
      expect(ctx.args.renderSpec).toBe(true);
      expect(await runOpWaveCommand(ctx)).toBe(0);
      expect(parseOpWavesSpec(readFileSync(join(repo, SPEC_FILE), "utf-8"), "file").waves[0]).toMatchObject({ gate: "always", shares: 2 });
    } finally {
      process.chdir(was);
      if (env === undefined) delete process.env[OP_WAVES_SPEC_COMMAND_ENV];
      else process.env[OP_WAVES_SPEC_COMMAND_ENV] = env;
    }
  });
});
