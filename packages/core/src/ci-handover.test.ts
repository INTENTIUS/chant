/**
 * #4295: the forge token handover. A step that runs the pull request's code
 * starts again without the forge token variables, the report it writes goes
 * to the next job as data, and the checkout keeps no credentials.
 *
 * Each test runs the generated shell for real, with `sh`, in a temp
 * directory, with every token variable set to a value it then looks for.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, test } from "vitest";
import {
  CHECKOUT_TOKEN_ENV,
  checkoutScript,
  dropForgeTokens,
  FORGE_TOKEN_VARS,
  GITLAB_DROP_FORGE_TOKENS,
  HANDOVER_LIMITS,
  handoverKeys,
  handoverTrap,
  holdsForgeToken,
  packJs,
  UNPACK_JS,
  withoutForgeTokens,
} from "./ci-handover";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function scratch(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const SECRET = "ghs_handover_secret_4295";
/** Every forge token variable, set to a value a leak would show. */
const TOKENS = Object.fromEntries(FORGE_TOKEN_VARS.map((v) => [v, `${SECRET}_${v}`]));
const BASE = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" };

/** Run `body` after the drop line as a script file, as a forge runs a step, and return what `env` printed in it. */
function stepEnv(body: string, extra: Record<string, string> = {}): { env: string; status: number | null } {
  const dir = scratch("chant-handover-step-");
  const out = join(dir, "env.txt");
  const file = join(dir, "step.sh");
  writeFileSync(file, `${dropForgeTokens("sh")}\n${body.replaceAll("$OUT", out)}\n`);
  const r = spawnSync("sh", ["-e", file], { cwd: dir, env: { ...BASE, ...TOKENS, ...extra }, encoding: "utf-8" });
  return { env: existsSync(out) ? readFileSync(out, "utf-8") : "", status: r.status };
}

describe("a step that runs the change's code holds no forge token (#4295)", () => {
  test("the step's shell and every process it starts see none of the token variables", () => {
    const { env, status } = stepEnv('env > "$OUT"; sh -c \'env\' >> "$OUT"');
    expect(status).toBe(0);
    expect(env).not.toContain(SECRET);
    for (const name of FORGE_TOKEN_VARS) expect(env).not.toMatch(new RegExp(`^${name}=`, "m"));
    // It restarted once, which the marker says, so it does not loop.
    expect(env).toMatch(/^CHANT_NO_FORGE_TOKEN=1$/m);
  });

  test.skipIf(process.platform !== "linux")("the restart leaves no token in the shell's own initial environment, which a child reads from /proc", () => {
    const { env } = stepEnv('tr "\\0" "\\n" < /proc/$$/environ > "$OUT"; sh -c \'tr "\\0" "\\n" < /proc/$PPID/environ\' >> "$OUT"');
    expect(env).toContain("CHANT_NO_FORGE_TOKEN=1");
    expect(env).not.toContain(SECRET);
  });

  test("a step's exit code is its own after the restart", () => {
    expect(stepEnv("exit 3").status).toBe(3);
  });

  test("a shell that cannot restart, such as sh -c, unsets them", () => {
    const r = spawnSync("sh", ["-c", `${dropForgeTokens("sh")}\nenv`], { env: { ...BASE, ...TOKENS }, encoding: "utf-8" });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(SECRET);
  });

  test("bash restarts with pipefail", () => {
    const dir = scratch("chant-handover-bash-");
    const file = join(dir, "step.sh");
    writeFileSync(file, `${dropForgeTokens("bash")}\nenv\n`);
    const r = spawnSync("bash", ["-e", file], { env: { ...BASE, ...TOKENS }, encoding: "utf-8" });
    expect(r.stdout).not.toContain(SECRET);
    expect(r.stdout).toContain("CHANT_NO_FORGE_TOKEN=1");
  });

  test("GitLab's line unsets them for every line after it in the job's one shell", () => {
    const r = spawnSync("sh", ["-c", `${GITLAB_DROP_FORGE_TOKENS}\nenv`], { env: { ...BASE, ...TOKENS }, encoding: "utf-8" });
    expect(r.stdout).not.toContain(SECRET);
  });

  test("withoutForgeTokens and holdsForgeToken cover chant's, GitHub's, Forgejo's and GitLab's names", () => {
    const env = { ...TOKENS, AWS_ACCESS_KEY_ID: "floci", GITHUB_REPOSITORY: "acme/estate" };
    expect(withoutForgeTokens(env)).toEqual({ AWS_ACCESS_KEY_ID: "floci", GITHUB_REPOSITORY: "acme/estate" });
    expect(holdsForgeToken(env)).toBe(true);
    expect(holdsForgeToken({ GITHUB_TOKEN: "" })).toBe(false);
    for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "CHANT_FORGE_TOKEN", "FORGEJO_TOKEN", "GITLAB_TOKEN", "CI_JOB_TOKEN", "ACTIONS_RUNTIME_TOKEN"]) {
      expect(FORGE_TOKEN_VARS).toContain(name);
    }
  });
});

/** Run the plan step's trap with `files` in its report directory, and return the outputs it wrote. */
function handOn(files: Record<string, string>, forge: "github" | "forgejo" = "github"): string {
  const dir = scratch("chant-handover-pack-");
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, ".chant/pr", name, ".."), { recursive: true });
    writeFileSync(join(dir, ".chant/pr", name), body);
  }
  const output = join(dir, "github-output");
  const file = join(dir, "step.sh");
  writeFileSync(file, [dropForgeTokens("sh"), ...handoverTrap(".chant/pr", forge), "cd /", "exit 1", ""].join("\n"));
  spawnSync("sh", ["-e", file], { cwd: dir, env: { ...BASE, ...TOKENS, GITHUB_OUTPUT: output }, encoding: "utf-8" });
  return readFileSync(output, "utf-8");
}

/** What the note job writes back from `outputs`, one `key=value` a line, as toJSON hands each value in. */
function takeBack(outputs: string, forge: "github" | "forgejo" = "github"): { dir: string; log: string } {
  const values = Object.fromEntries(outputs.trimEnd().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const stdin = handoverKeys(forge).map((k) => JSON.stringify(values[k] ?? "")).join("\n") + "\n";
  const dir = scratch("chant-handover-take-");
  const log = execFileSync("node", ["-e", UNPACK_JS, join(dir, ".chant/pr")], { input: stdin, encoding: "utf-8" });
  return { dir: join(dir, ".chant/pr"), log };
}

describe("the plan step hands its report to the note job as data (#4295)", () => {
  test("every file goes on as the job's outputs, even when the step fails after changing directory, and comes back the same", () => {
    const files = { "pr-plan.json": '{"stage":"plan"}\n', "pr-note.md": "note\n", "run-events/a.jsonl": "{}\n" };
    const outputs = handOn(files);
    expect(outputs).toMatch(/^report_0=/);
    // The output carries no token, though the step started with every one.
    expect(outputs).not.toContain(Buffer.from(SECRET).toString("base64").slice(0, 12));
    const { dir, log } = takeBack(outputs);
    expect(log).toContain("took 3 report files");
    for (const [name, body] of Object.entries(files)) expect(readFileSync(join(dir, name), "utf-8")).toBe(body);
  });

  test("a path that leaves the directory is left out", () => {
    const payload = gzipSync(JSON.stringify({ "../escape": Buffer.from("x").toString("base64"), "ok.txt": Buffer.from("y").toString("base64") })).toString("base64");
    const { dir, log } = takeBack(`report_0=${payload}\n`);
    expect(log).toContain('left out "../escape"');
    expect(existsSync(join(dir, "..", "escape"))).toBe(false);
    expect(readFileSync(join(dir, "ok.txt"), "utf-8")).toBe("y");
  });

  test("outputs that do not read hand on nothing, and the note job carries on", () => {
    expect(takeBack("report_0=not-base64-gzip\n").log).toContain("does not read");
    expect(takeBack("").log).toContain("handed on no report");
  });

  test("a report too large is cut to the plan report and the note", () => {
    const saved = { ...HANDOVER_LIMITS.github };
    HANDOVER_LIMITS.github.chunk = 2_000;
    try {
      expect(packJs("github")).toContain("CHUNK=2000");
      const big = Array.from({ length: 4000 }, (_, i) => `${i}-${Math.random()}`).join("\n");
      const { dir } = takeBack(handOn({ "pr-plan.json": "{}", "pr-note.md": "n", "change-set.json": big }));
      expect(existsSync(join(dir, "pr-plan.json"))).toBe(true);
      expect(existsSync(join(dir, "change-set.json"))).toBe(false);
    } finally {
      Object.assign(HANDOVER_LIMITS.github, saved);
    }
  });

  test("Forgejo hands on up to four outputs of a MiB each", () => {
    expect(handoverKeys("forgejo")).toEqual(["report_0", "report_1", "report_2", "report_3"]);
    expect(handoverKeys("github")).toEqual(["report_0"]);
  });
});

describe("the checkout keeps no credentials (#4295)", () => {
  test("it checks the run's commit out with the token in the fetch's environment alone, and fetches chant/lifecycle while it can", () => {
    const top = scratch("chant-handover-checkout-");
    const origin = join(top, "acme", "estate");
    const seed = join(top, "seed");
    mkdirSync(origin, { recursive: true });
    mkdirSync(seed);
    const g = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf-8" }).trim();
    g(origin, "init", "-q", "--bare");
    g(seed, "init", "-q");
    writeFileSync(join(seed, "a.txt"), "a\n");
    g(seed, "add", "-A");
    g(seed, "commit", "-q", "-m", "a");
    const sha = g(seed, "rev-parse", "HEAD");
    g(seed, "push", "-q", origin, "HEAD:refs/heads/main", "HEAD:refs/heads/chant/lifecycle", "HEAD:refs/pull/7/merge");

    const work = join(top, "work");
    mkdirSync(work);
    const file = join(top, "checkout.sh");
    writeFileSync(file, checkoutScript(true, true) + "\n");
    const r = spawnSync("sh", ["-e", file], {
      cwd: work,
      env: { ...BASE, GIT_CONFIG_GLOBAL: join(top, "gitconfig"), [CHECKOUT_TOKEN_ENV]: SECRET, GITHUB_SERVER_URL: `file://${top}`, GITHUB_REPOSITORY: "acme/estate", GITHUB_REF: "refs/pull/7/merge", GITHUB_SHA: sha },
      encoding: "utf-8",
    });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(g(work, "rev-parse", "HEAD")).toBe(sha);
    expect(g(work, "rev-parse", "chant/lifecycle")).toBe(sha);
    // Nothing of the token is left in the repository's config.
    const config = readFileSync(join(work, ".git", "config"), "utf-8");
    expect(config).not.toContain("extraheader");
    expect(config).not.toContain(Buffer.from(`x-access-token:${SECRET}`).toString("base64"));
  });
});
