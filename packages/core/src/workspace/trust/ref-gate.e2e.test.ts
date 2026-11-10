/**
 * #4867, end to end: chant's hooks on a bare repository and a checkout, with
 * real `git push`. The pre-receive hook refuses a push to a protected ref
 * whose commit has no current evidence for a `block` check, naming the check
 * and its command, and admits it once the evidence is pushed with it. The
 * pre-push hook refuses the same push before it leaves the checkout.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { REPO } from "../__fixtures__/contract-repo";
import { EVIDENCE_NOTES_REF } from "./ref-gate";
import { GateRepos, runnerKey, trustJson } from "./ref-gate-fixture";

const CHANT = `${process.execPath} --import ${pathToFileURL(join(REPO, "node_modules/tsx/dist/loader.mjs")).href} ${join(REPO, "packages/core/src/cli/main.ts")}`;

function chant(r: GateRepos, cwd: string, argv: string[]) {
  return spawnSync("/bin/sh", ["-c", `${CHANT} "$@"`, "chant", ...argv], { cwd, env: r.env(), encoding: "utf-8" });
}

function setup(label: string) {
  const r = new GateRepos(label);
  const ci = runnerKey();
  r.write(".chant/trust.json", trustJson(ci, [{ check: "plan", command: "chant ci run plan" }, { check: "policy", command: "chant ci run policy" }]));
  r.write("records/n1.md", "one\n");
  const base = r.commit("policy");
  r.push("main");
  r.write("app/a.txt", "change\n");
  const head = r.commit("a change");
  return { r, ci, base, head };
}

const push = (r: GateRepos, ...refspecs: string[]) => spawnSync("git", ["push", "origin", ...refspecs], { cwd: r.work, env: r.env(), encoding: "utf-8" });

describe("the ref gate's hooks", () => {
  test("a bare repository with chant's pre-receive hook refuses a push without evidence and admits it with", () => {
    const { r, ci, base, head } = setup("e2e-receive");
    const installed = chant(r, r.work, ["workspace", "ref-gate", "install", "--hook", "pre-receive", "--git-dir", r.origin, "--chant", CHANT]);
    expect(installed.status, installed.stderr).toBe(0);

    const refused = push(r, `${head}:refs/heads/main`);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("refused refs/heads/main");
    expect(refused.stderr).toContain("plan (missing)");
    expect(refused.stderr).toContain("run: chant ci run plan");
    expect(refused.stderr).toContain("run: chant ci run policy");
    expect(r.run(r.origin, ["rev-parse", "main"]).trim()).toBe(base);

    r.sign(ci, "plan", head, ["records/n1.md"]);
    const half = push(r, EVIDENCE_NOTES_REF, `${head}:refs/heads/main`);
    expect(half.status).not.toBe(0);
    expect(half.stderr).toContain("run: chant ci run policy");
    expect(half.stderr).not.toContain("run: chant ci run plan");

    r.sign(ci, "policy", head, ["records/n1.md"]);
    const admitted = push(r, EVIDENCE_NOTES_REF, `${head}:refs/heads/main`);
    expect(admitted.status, admitted.stderr).toBe(0);
    expect(r.run(r.origin, ["rev-parse", "main"]).trim()).toBe(head);
  }, 60_000);

  test("a push only the remote refused prints the command that records the request for an override, and it does from the checkout (#4913)", () => {
    const { r, base, head } = setup("e2e-request");
    const installed = chant(r, r.work, ["workspace", "ref-gate", "install", "--hook", "pre-receive", "--git-dir", r.origin, "--chant", CHANT]);
    expect(installed.status, installed.stderr).toBe(0);
    const refused = push(r, `${head}:refs/heads/main`);
    expect(refused.status).not.toBe(0);
    const printed = refused.stderr.split("\n").map((l) => l.replace(/^remote:\s*/, "").trim()).find((l) => l.startsWith("chant workspace ref-gate check "));
    expect(printed).toBe(`chant workspace ref-gate check --ref refs/heads/main --at ${head} --base ${base}`);

    const recorded = chant(r, r.work, printed!.split(" ").slice(1));
    expect(recorded.status).toBe(1);
    expect(recorded.stderr).toContain("is recorded on chant/lifecycle");
    const ledger = r.git(["show", "chant/lifecycle:_gates/policy-override.jsonl"]);
    expect(ledger).toContain(`"gate":"ref-gate-${head.slice(0, 12)}-plan"`);
    expect(ledger).toContain(`"gate":"ref-gate-${head.slice(0, 12)}-policy"`);
  }, 60_000);

  test("chant's pre-push hook refuses the same push before the network", () => {
    const { r, ci, base, head } = setup("e2e-push");
    const installed = chant(r, r.work, ["workspace", "ref-gate", "install", "--hook", "pre-push", "--chant", CHANT]);
    expect(installed.status, installed.stderr).toBe(0);
    const refused = push(r, `${head}:refs/heads/main`);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("run: chant ci run plan");
    expect(r.run(r.origin, ["rev-parse", "main"]).trim()).toBe(base);
    r.sign(ci, "plan", head, ["records/n1.md"]);
    r.sign(ci, "policy", head, ["records/n1.md"]);
    const admitted = push(r, EVIDENCE_NOTES_REF, `${head}:refs/heads/main`);
    expect(admitted.status, admitted.stderr).toBe(0);
  }, 60_000);
});
