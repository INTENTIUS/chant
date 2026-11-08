/**
 * The agent guard (#4770), proven against both products' words and rules:
 * terragucci's tests (its test/guard.test.ts) and plywood's ("the agent
 * guard" in its test/agents.test.ts), ported to the shared code, and the
 * cases where the two disagreed, settled on the stricter answer.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { AGENT_GUARD_FLOOR, agentGuard, CLAUDE_SETTINGS_LOCAL, CLAUDE_SETTINGS_SHARED, installAgentGuard, withAgentGuardHook } from "./agent-guard";
import { NEXT_RELEASE } from "./release-floors";
import { PLYWOOD_GUARD } from "./__fixtures__/agent-guard/plywood";
import { TERRAGUCCI_GUARD } from "./__fixtures__/agent-guard/terragucci";

const tmp = (): string => mkdtempSync(join(tmpdir(), "chant-guard-"));
const git = (repo: string, ...args: string[]): string => {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
};

/** Stand-ins for the real binaries, logging their calls. */
function fakeBinaries(names: string[]): { dir: string; log: string } {
  const dir = tmp();
  const log = join(dir, "calls.log");
  for (const b of names) {
    writeFileSync(join(dir, b), `#!/bin/sh\necho "${b} $*" >> ${JSON.stringify(log)}\nexit 0\n`);
    chmodSync(join(dir, b), 0o755);
  }
  return { dir, log };
}

function runner(bin: string, real: { dir: string; log: string }, env: NodeJS.ProcessEnv = process.env) {
  return (name: string, args: string[], cwd: string) => {
    const r = spawnSync(join(bin, name), args, { cwd, encoding: "utf-8", env: { ...env, PATH: `${bin}:${real.dir}:${process.env.PATH ?? ""}` } });
    return { status: r.status, stderr: r.stderr, ran: existsSync(real.log) ? readFileSync(real.log, "utf-8") : "" };
  };
}

function hookOf(script: string) {
  return (command: string, cwd: string, env: NodeJS.ProcessEnv = process.env) => {
    const r = spawnSync(process.execPath, [script, "hook"], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }), encoding: "utf-8", env });
    return { status: r.status, stderr: r.stderr };
  };
}

const ROOTS = ["envs/dev/app", "envs/prod/app"];

/** terragucci's fixture: a repo with two pipeline roots and a directory that is not one, the guard written locally. */
function terragucci() {
  const repo = tmp();
  for (const d of [...ROOTS, "modules/net"]) mkdirSync(join(repo, d), { recursive: true });
  writeFileSync(join(repo, "README.md"), "x\n");
  git(repo, "init", "-q", "-b", "main");
  const real = fakeBinaries(Object.keys(TERRAGUCCI_GUARD.rules.engines));
  const g = installAgentGuard({ ...TERRAGUCCI_GUARD, repo, install: "local", roots: ROOTS });
  return { repo, g, run: runner(g.bin, real), hook: hookOf(g.script) };
}

describe("AGENT_GUARD_FLOOR", () => {
  it("names the next release", () => expect(AGENT_GUARD_FLOOR).toBe(NEXT_RELEASE));
});

describe("terragucci's guard: the wrappers", () => {
  it("writes the wrappers and the script under the git directory, out of commits", () => {
    const { repo, g } = terragucci();
    const gitDir = git(repo, "rev-parse", "--absolute-git-dir").trim();
    expect(g.script).toBe(join(gitDir, "terragucci", "guard", "guard.mjs"));
    for (const b of ["tofu", "terraform", "terragrunt", "choudoufu"]) expect(existsSync(join(g.bin, b))).toBe(true);
    expect(g.path).toBe(`export PATH="${g.bin}:$PATH"`);
    expect(git(repo, "status", "--porcelain", "--untracked-files=all")).not.toMatch(/terragucci\/guard|settings\.local\.json/);
  });

  it("refuses apply, destroy and -auto-approve in a pipeline root, naming propose, and runs nothing", () => {
    const { repo, run } = terragucci();
    const root = join(repo, "envs/prod/app");
    for (const args of [["apply"], ["destroy"], ["apply", "-auto-approve"], ["plan", "-auto-approve"], ["import", "aws_s3_bucket.b", "b"], ["state", "rm", "aws_s3_bucket.b"], ["state", "mv", "a", "b"], ["state", "push", "x.tfstate"]]) {
      const r = run("tofu", args, root);
      expect(r.status, args.join(" ")).toBe(3);
      expect(r.stderr).toContain("terragucci guard: tofu");
      expect(r.stderr).toContain("in envs/prod/app, a root of this repo's pipeline");
      expect(r.stderr).toContain("the propose tool of terragucci mcp --propose");
    }
    expect(run("terraform", ["-chdir=envs/dev/app", "apply"], repo).status).not.toBe(0);
    expect(run("tofu", ["-chdir", "envs/dev/app", "destroy"], repo).status).not.toBe(0);
    expect(run("tofu", ["apply"], root).ran).toBe("");
  });

  it("passes init, validate, fmt, plan and state reads through to the real binary in a root", () => {
    const { repo, run } = terragucci();
    const root = join(repo, "envs/prod/app");
    for (const args of [["init"], ["validate"], ["fmt", "-check"], ["plan", "-out=tfplan"], ["state", "list"], ["show", "-json"]]) expect(run("tofu", args, root).status, args.join(" ")).toBe(0);
    expect(run("tofu", ["version"], root).ran).toBe(["tofu init", "tofu validate", "tofu fmt -check", "tofu plan -out=tfplan", "tofu state list", "tofu show -json", "tofu version", ""].join("\n"));
  });

  it("passes every command through outside the pipeline's roots", () => {
    const { repo, run } = terragucci();
    for (const cwd of [repo, join(repo, "modules/net"), tmp()]) {
      expect(run("tofu", ["apply", "-auto-approve"], cwd).status, cwd).toBe(0);
      expect(run("terraform", ["destroy"], cwd).status, cwd).toBe(0);
    }
    expect(run("tofu", ["version"], repo).ran.split("\n").filter(Boolean)).toHaveLength(7);
  });

  it("refuses terragrunt's --all and run-all apply from a directory that holds a root, and its plan", () => {
    const { repo, run } = terragucci();
    expect(run("terragrunt", ["run", "--all", "apply"], join(repo, "envs")).status).not.toBe(0);
    expect(run("terragrunt", ["run-all", "destroy"], repo).status).not.toBe(0);
    expect(run("terragrunt", ["apply"], join(repo, "envs/dev/app")).status).not.toBe(0);
    expect(run("terragrunt", ["run", "--all", "plan"], join(repo, "envs")).status).toBe(0);
    // Without --all, terragrunt applies the directory it runs in, which is no root here.
    expect(run("terragrunt", ["apply"], join(repo, "envs")).status).toBe(0);
  });
});

describe("terragucci's guard: the hook", () => {
  it("writes a PreToolUse hook into Claude Code's local settings, kept out of commits, and keeps what else the file holds", () => {
    const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.XDG_CONFIG_HOME = tmp();
    onTestFinished(() => {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
    const { repo, g } = terragucci();
    const settings = JSON.parse(readFileSync(join(repo, CLAUDE_SETTINGS_LOCAL), "utf-8"));
    expect(settings.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: `"${process.execPath}" "${g.script}" hook` }] }]);
    expect(readFileSync(join(repo, ".git/info/exclude"), "utf-8")).toContain(`/${CLAUDE_SETTINGS_LOCAL}`);
    writeFileSync(join(repo, CLAUDE_SETTINGS_LOCAL), JSON.stringify({ ...settings, permissions: { allow: ["Bash(ls)"] } }));
    installAgentGuard({ ...TERRAGUCCI_GUARD, repo, install: "local", roots: ROOTS });
    const again = JSON.parse(readFileSync(join(repo, CLAUDE_SETTINGS_LOCAL), "utf-8"));
    expect(again.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(again.hooks.PreToolUse).toHaveLength(1);
    expect(readFileSync(join(repo, ".git/info/exclude"), "utf-8").split(`/${CLAUDE_SETTINGS_LOCAL}`)).toHaveLength(2);
  });

  it("blocks the same commands in the agent's Bash tool with exit 2, following cd and sh -c", () => {
    const { repo, hook } = terragucci();
    for (const [command, cwd] of [
      ["cd envs/prod/app && tofu apply", repo],
      ["tofu -chdir=envs/dev/app destroy", repo],
      ["AWS_PROFILE=prod terraform apply -auto-approve", join(repo, "envs/prod/app")],
      ["bash -c 'cd envs/dev/app; tofu apply'", repo],
      ["/usr/local/bin/tofu state rm aws_s3_bucket.b", join(repo, "envs/dev/app")],
      ["npx terragucci approve wave-1 --plan sha256:abc", repo],
      ["npx -y @intentius/terragucci override envs/prod/app --rule r --reason x", repo],
      ["npx @intentius/terragucci@0.4.35 pr-merge --pr 7 --sha abc", repo],
      ["terragucci stage tf-apply --wave 1 --layers envs/prod/app", repo],
      ["npx terragucci rollout net --mode apply", repo],
    ] as const) {
      const r = hook(command, cwd);
      expect(r.status, command).toBe(2);
      expect(r.stderr).toContain("propose");
    }
  });

  it("lets plans, reads and everything outside the repo's roots through", () => {
    const { repo, g, hook } = terragucci();
    for (const [command, cwd] of [
      ["cd envs/prod/app && tofu init && tofu plan -out=p", repo],
      ["tofu apply", repo],
      ["tofu apply -auto-approve", tmp()],
      ["git commit -m 'apply the fix'", repo],
      ["echo apply", join(repo, "envs/prod/app")],
      ["npx terragucci plan --json", repo],
      ["npx terragucci approve wave-1", tmp()],
    ] as const) expect(hook(command, cwd).status, command).toBe(0);
    expect(spawnSync(process.execPath, [g.script, "hook"], { input: "not json", encoding: "utf-8" }).status).toBe(0);
  });

  it("refuses to rewrite a settings file that is not JSON, or not an object", () => {
    expect(() => withAgentGuardHook("{ nope", "x", CLAUDE_SETTINGS_LOCAL)).toThrow(/is not JSON/);
    expect(() => withAgentGuardHook("[]", "x", CLAUDE_SETTINGS_LOCAL)).toThrow(/not a JSON object/);
    class ConfigError extends Error {}
    expect(() => withAgentGuardHook("{ nope", "x", CLAUDE_SETTINGS_LOCAL, [], (m) => new ConfigError(m))).toThrow(ConfigError);
    expect(JSON.parse(withAgentGuardHook(undefined, "x", CLAUDE_SETTINGS_LOCAL)).hooks.PreToolUse[0].hooks[0].command).toBe("x");
  });

  it("says it needs a git checkout for a local install", () => {
    expect(() => installAgentGuard({ ...TERRAGUCCI_GUARD, repo: tmp(), install: "local", roots: [] })).toThrow(/terragucci guard runs in a git checkout/);
  });
});

describe("plywood's guard", () => {
  const refused = ["pulumi up", "pulumi up --yes --stack dev", "cd shop && pulumi -C infra up", "npx plunge up", "FOO=1 pulumi destroy -y", "/usr/local/bin/pulumi update", "env -i pulumi up"];
  const allowed = ["pulumi preview", "pulumi stack ls", "plunge drift --resource urn:x", "git commit -m 'pulumi up later'", "plywood preview", "echo pulumi"];

  /** plywood's fixture: the guard written into a project's `.claude/`, refused anywhere. */
  function plywood() {
    const repo = tmp();
    mkdirSync(join(repo, ".claude"));
    writeFileSync(join(repo, CLAUDE_SETTINGS_SHARED), JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    const g = installAgentGuard({ ...PLYWOOD_GUARD, repo, install: "project" });
    return { repo, g, hook: hookOf(g.script) };
  }

  it("refuses an update or destroy, and lets every read through", () => {
    const guard = agentGuard(PLYWOOD_GUARD, { repo: tmp() });
    for (const line of refused) expect(guard.checkCommand(line, guard.repo), line).toBeDefined();
    for (const line of allowed) expect(guard.checkCommand(line, guard.repo), line).toBeUndefined();
    expect(guard.checkCommand("pulumi up", guard.repo)).toMatchObject({ bin: "pulumi", command: "up", message: "plywood guard: an agent session does not run 'pulumi up'. Open a pull request; plywood previews it, and the update runs after a person approves the digest." });
  });

  it("gives the same answers in the hook it writes, from any directory", () => {
    const { repo, hook } = plywood();
    for (const line of [...refused, ...allowed]) for (const cwd of [repo, tmp()]) expect(hook(line, cwd).status === 2, `${line} in ${cwd}`).toBe(refused.includes(line));
  });

  it("blocks pulumi up in a fixture Claude Code session (exit 2), with the hook as plywood's settings name it", () => {
    const { repo, g } = plywood();
    const settings = JSON.parse(readFileSync(join(repo, CLAUDE_SETTINGS_SHARED), "utf-8"));
    const command = settings.hooks.PreToolUse[0].hooks[0].command as string;
    expect(command).toBe('node "$CLAUDE_PROJECT_DIR/.claude/hooks/plywood-guard.mjs" hook');
    expect(g.written).toEqual([".claude/hooks/plywood-guard.mjs", ".plywood/agent-bin/pulumi", ".plywood/agent-bin/plunge", ".claude/settings.json"]);
    const call = (c: string) => spawnSync("sh", ["-c", command], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: c } }), encoding: "utf-8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo } });
    const blocked = call("pulumi up --yes");
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain("pull request");
    expect(call("pulumi preview").status).toBe(0);
  });

  it("installs the hook once into .claude/settings.json and keeps the rest", () => {
    const { repo } = plywood();
    installAgentGuard({ ...PLYWOOD_GUARD, repo, install: "project" });
    const settings = JSON.parse(readFileSync(join(repo, CLAUDE_SETTINGS_SHARED), "utf-8"));
    expect(settings.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(JSON.parse(withAgentGuardHook(JSON.stringify(settings), settings.hooks.PreToolUse[0].hooks[0].command, CLAUDE_SETTINGS_SHARED))).toEqual(settings);
  });

  it("replaces the hook an earlier plywood guard install wrote", () => {
    const old = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/plywood-guard.mjs"' }] }] } };
    const next = JSON.parse(withAgentGuardHook(JSON.stringify(old), 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/plywood-guard.mjs" hook', CLAUDE_SETTINGS_SHARED, ["plywood-guard.mjs"]));
    expect(next.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/plywood-guard.mjs" hook' }] }]);
  });

  it("writes wrappers that refuse with plywood's exit code, without PLYWOOD_AGENT_GUARD set, and run the real pulumi for the rest", () => {
    const { repo, g } = plywood();
    const real = fakeBinaries(["pulumi", "plunge"]);
    const env = { ...process.env };
    delete env.PLYWOOD_AGENT_GUARD;
    delete env.CLAUDECODE;
    const run = runner(g.bin, real, env);
    const up = run("pulumi", ["--stack", "dev", "up", "--yes"], repo);
    expect(up.status).toBe(1);
    expect(up.stderr).toContain("plywood guard: an agent session does not run 'pulumi up'");
    expect(run("plunge", ["destroy"], tmp()).status).toBe(1);
    expect(run("pulumi", ["preview"], repo).status).toBe(0);
    expect(run("pulumi", ["stack", "ls"], repo).ran).toBe("pulumi preview\npulumi stack ls\n");
  });
});

describe("the script", () => {
  it("runs when chant runs from source under tsx, whose keepNames wraps the rule's functions in __name", () => {
    const repo = tmp();
    const code = `import { installAgentGuard } from ${JSON.stringify(join(__dirname, "agent-guard.ts"))}; import { PLYWOOD_GUARD } from ${JSON.stringify(join(__dirname, "__fixtures__/agent-guard/plywood.ts"))}; installAgentGuard({ ...PLYWOOD_GUARD, repo: ${JSON.stringify(repo)}, install: "project" });`;
    const w = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { encoding: "utf-8" });
    expect(w.status, w.stderr).toBe(0);
    const script = join(repo, ".claude/hooks/plywood-guard.mjs");
    expect(readFileSync(script, "utf-8")).toContain("__name(");
    expect(hookOf(script)("pulumi up", repo).status).toBe(2);
    expect(hookOf(script)("pulumi preview", repo).status).toBe(0);
  });
});

describe("where the two guards disagreed: the stricter answer", () => {
  const ply = () => agentGuard(PLYWOOD_GUARD, { repo: tmp() });
  const tg = () => {
    const repo = tmp();
    for (const d of ROOTS) mkdirSync(join(repo, d), { recursive: true });
    return { repo, guard: agentGuard(TERRAGUCCI_GUARD, { repo, roots: ROOTS }) };
  };

  it("follows sh -c, bash -lc and eval, which plywood's guard let through", () => {
    const g = ply();
    for (const line of ["bash -c 'pulumi up'", "sh -c \"cd x && pulumi destroy\"", "bash -lc 'pulumi up'", "eval pulumi up", "eval 'pulumi up --yes'"]) expect(g.checkCommand(line, g.repo), line).toBeDefined();
  });

  it("skips a launcher's flags, which terragucci's guard read as the command", () => {
    const { repo, guard } = tg();
    for (const line of ["env -i tofu apply", "env -u AWS_PROFILE tofu apply", "sudo -u ops tofu destroy", "nice -n 5 terraform apply", "xargs tofu apply", "command -p tofu apply"]) expect(guard.checkCommand(line, join(repo, "envs/dev/app")), line).toBeDefined();
  });

  it("finds the command after npx's flags, which plywood's guard did not", () => {
    const g = ply();
    for (const line of ["npx -y plunge up", "npx --yes pulumi destroy", "npx -p @pulumi/cli pulumi up", "bunx plunge up"]) expect(g.checkCommand(line, g.repo), line).toBeDefined();
  });

  it("skips a flag's value before the subcommand, which terragucci's guard read as the subcommand", () => {
    const g = ply();
    expect(g.checkCommand("pulumi --stack dev up", g.repo)).toBeDefined();
    expect(g.checkCommand("pulumi -C infra destroy", g.repo)).toBeDefined();
  });

  it("refuses the product's own applying commands, which plywood's guard let through", () => {
    const g = ply();
    for (const line of ["plywood up", "npx @intentius/plywood approve up --plan sha256:x", "plywood override dev --rule r --reason x", "plywood resume --wave 1", "plywood drift --respond up", "plywood cancel dev"]) expect(g.checkCommand(line, g.repo), line).toBeDefined();
    for (const line of ["plywood preview", "plywood drift --respond issue", "plywood guard check pulumi up", "plywood audit"]) expect(g.checkCommand(line, g.repo), line).toBeUndefined();
  });

  it("reads a quoted separator as text, not a second command", () => {
    const g = ply();
    expect(g.checkCommand('echo "done; pulumi up later"', g.repo)).toBeUndefined();
    expect(g.checkCommand("echo ok; pulumi up", g.repo)).toBeDefined();
    expect(g.checkCommand("echo $(pulumi up)", g.repo)).toBeDefined();
    expect(g.checkCommand("echo `pulumi destroy`", g.repo)).toBeDefined();
  });

  it("keeps roots a product rule: refused anywhere without them, only in a root with them, nowhere with none", () => {
    const { repo, guard } = tg();
    expect(guard.checkCommand("tofu apply", repo)).toBeUndefined();
    expect(guard.checkCommand("tofu apply", join(repo, "envs/dev/app"))).toMatchObject({ where: "envs/dev/app" });
    const anywhere = agentGuard(TERRAGUCCI_GUARD, { repo });
    expect(anywhere.checkCommand("tofu apply", tmp())).toMatchObject({ what: "tofu apply" });
    expect(anywhere.checkCommand("tofu apply", tmp())!.message).not.toContain(" in ");
    expect(agentGuard(TERRAGUCCI_GUARD, { repo, roots: [] }).checkCommand("tofu apply", join(repo, "envs/dev/app"))).toBeUndefined();
  });
});
