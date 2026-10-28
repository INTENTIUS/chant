/**
 * #4619: the note job's read of the control repo. With a control repo named,
 * the job that posts the pull request note fetches the control repo's
 * chant/lifecycle, read-only, and sets CHANT_CONTROL_DIR, so the note marks
 * the cross-stack edges from its entries and apply records. The script runs
 * against a local bare repository here, never a forge.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CONTROL_DIR_ENV, controlNoteCheckout, resolveControlTarget } from "./dispatch";

const github = resolveControlTarget({ repo: "github.com/acme/control", op: "deploy", readTokenSecret: "PLYWOOD_CONTROL_READ" }, "network");
const gitlab = resolveControlTarget({ repo: "gitlab.com/acme/infra/control", op: "deploy" }, "network");
const loopback = resolveControlTarget({ repo: "localhost:3000/acme/control", forge: "forgejo", op: "deploy", apiBase: "http://localhost:3000/api/v1" }, "network");

describe("the note job's read of the control repo", () => {
  test("GitHub and Forgejo: the read secret, else the job token, and the directory through GITHUB_ENV", () => {
    for (const forge of ["github", "forgejo"] as const) {
      const c = controlNoteCheckout(forge, github, { product: "plywood" });
      expect(c.env).toEqual({ CHANT_CONTROL_READ_TOKEN: "${{ secrets.PLYWOOD_CONTROL_READ || github.token }}" });
      expect(c.script).toContain(`echo "${CONTROL_DIR_ENV}=$chant_control_dir" >>"$GITHUB_ENV"`);
      expect(c.script).toContain("'https://github.com/acme/control.git' '+refs/heads/chant/lifecycle:refs/heads/chant/lifecycle'");
      expect(c.script).toContain("plywood: could not read the control repo github.com/acme/control's chant/lifecycle");
    }
  });

  test("the token reaches git through its environment, never its arguments, and is unset after", () => {
    const c = controlNoteCheckout("github", github);
    expect(c.script).toContain('GIT_CONFIG_VALUE_0="$chant_control_header" git -C "$chant_control_dir" fetch');
    expect(c.script).not.toMatch(/https:\/\/[^'\s]*@/);
    expect(c.script).not.toContain("http.extraheader=");
    expect(c.script.split("\n").at(-1)).toBe("unset chant_control_header chant_control_count chant_control_user CHANT_CONTROL_READ_TOKEN");
    // Only the read secret: never the dispatch token's.
    expect(c.script).not.toContain("secrets.CHANT_CONTROL_TOKEN");
  });

  test("GitLab: the read variable, else the job token as gitlab-ci-token, and the directory exported", () => {
    const c = controlNoteCheckout("gitlab", gitlab, { product: "terragucci" });
    expect(c.env).toEqual({});
    const lines = c.script.split("\n");
    expect(lines[0]).toBe('CHANT_CONTROL_READ_TOKEN="${CHANT_CONTROL_READ_TOKEN:-}"');
    expect(lines[1]).toBe("chant_control_user=oauth2");
    expect(lines[2]).toContain('CHANT_CONTROL_READ_TOKEN="$CI_JOB_TOKEN"; chant_control_user=gitlab-ci-token');
    expect(c.script).toContain(`export ${CONTROL_DIR_ENV}="$chant_control_dir"`);
    expect(c.script).toContain("'https://gitlab.com/acme/infra/control.git'");
  });

  test("a loopback forge is read over http", () => {
    expect(controlNoteCheckout("forgejo", loopback).script).toContain("'http://localhost:3000/acme/control.git'");
  });

  test("fetches chant/lifecycle alone into a new repository and names it, or warns and leaves it unnamed", () => {
    const work = mkdtempSync(join(tmpdir(), "chant-note-checkout-"));
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
    // A control repo with an entries file on its chant/lifecycle.
    const src = join(work, "control");
    git(work, "init", "-q", src);
    writeFileSync(join(src, "entries.jsonl"), "{}\n");
    git(src, "checkout", "-q", "-b", "chant/lifecycle");
    git(src, "add", "entries.jsonl");
    git(src, "commit", "-q", "-m", "entries");
    const bare = join(work, "control.git");
    git(work, "clone", "-q", "--bare", src, bare);
    // The script names the control repo by URL; a local bare repository stands in for it through git's url rewrite.
    const c = controlNoteCheckout("github", github, { product: "plywood" });
    const env = { ...process.env, GIT_ALLOW_PROTOCOL: "file", RUNNER_TEMP: work, GITHUB_ENV: join(work, "github-env"), CHANT_CONTROL_READ_TOKEN: "", GIT_CONFIG_GLOBAL: join(work, "gitconfig") };
    // Both URLs go to local paths, and only the file protocol is allowed: the test reaches no forge.
    writeFileSync(
      env.GIT_CONFIG_GLOBAL,
      `[url "file://${bare}"]\n\tinsteadOf = https://github.com/acme/control.git\n[url "file://${join(work, "nowhere.git")}"]\n\tinsteadOf = https://github.com/acme/none.git\n[protocol "file"]\n\tallow = always\n`,
    );
    writeFileSync(env.GITHUB_ENV, "");
    execFileSync("bash", ["-c", c.script], { env, encoding: "utf8" });
    const named = execFileSync("cat", [env.GITHUB_ENV], { encoding: "utf8" }).trim();
    expect(named).toMatch(new RegExp(`^${CONTROL_DIR_ENV}=${work}/chant-control\\.`));
    const dir = named.split("=")[1]!;
    expect(git(dir, "show", "chant/lifecycle:entries.jsonl")).toBe("{}\n");

    const missing = resolveControlTarget({ repo: "github.com/acme/none", op: "deploy" }, "network");
    const env2 = { ...env, GITHUB_ENV: join(work, "github-env-2") };
    writeFileSync(env2.GITHUB_ENV, "");
    // exec 2>&1 first, so the warning the script writes to stderr inside its if comes back too.
    const out = execFileSync("bash", ["-c", `exec 2>&1\n${controlNoteCheckout("github", missing).script}`], { env: env2, encoding: "utf8" });
    expect(out).toContain("its cross-stack edges stay unknown");
    expect(execFileSync("cat", [env2.GITHUB_ENV], { encoding: "utf8" })).toBe("");
  });
});
