/**
 * #4913: the ref gate's pieces a product uses without code of its own. The
 * rules read at base (`@intentius/chant/ref-gate-rules`), the status a forge
 * check requires, the init pieces that write `.chant/trust.json`, the hook
 * and the runner key hint (`@intentius/chant/ref-gate-init`), and a
 * pre-receive refusal that prints the command recording the request for an
 * override from the checkout.
 */

import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { beforeMergeBranch, beforeMergeRefGate } from "../../cli/handlers/pr";
import { refGateInitPlan, RefGateInitError, writeRefGateInit } from "../../ref-gate-init";
import { REF_GATE_STATUS, refGateRulesAt, refGateStatusFor } from "../../ref-gate-rules";
import { decideRefUpdate, describeDecision, requestCommand } from "./ref-gate";
import { REF_GATE_HOOK_MARK } from "./ref-gate-cli";
import { GateRepos, RUNNER, runnerKey, trustJson } from "./ref-gate-fixture";

const CHECKS = [
  { check: "plan", command: "chant ci run plan" },
  { check: "lint", action: "warn" as const, command: "npm run lint" },
];

describe("the ref gate's rules as a library (#4913)", () => {
  test("rules for a ref come from the policy at base, and a change that drops them does not count", () => {
    const r = new GateRepos("4913-rules");
    const ci = runnerKey();
    r.write(".chant/trust.json", trustJson(ci, CHECKS, {}));
    const base = r.commit("policy");
    r.write(".chant/trust.json", JSON.stringify({ schema: 1 }));
    r.commit("drop the rules");

    const atBase = refGateRulesAt(r.work, { ref: "refs/heads/main", base });
    expect(atBase).toEqual({
      ref: "refs/heads/main",
      base,
      matched: true,
      status: REF_GATE_STATUS,
      checks: [
        { check: "plan", action: "block", command: "chant ci run plan" },
        { check: "lint", action: "warn", command: "npm run lint" },
      ],
      problems: [],
    });
    expect(refGateRulesAt(r.work, { ref: "refs/heads/release/2", base }).matched).toBe(true);
    expect(refGateRulesAt(r.work, { ref: "refs/heads/feature", base })).toMatchObject({ matched: false, status: null, checks: [], problems: [] });
    // At the change itself the rules are gone, which is why a product reads them at base.
    expect(refGateRulesAt(r.work, { ref: "refs/heads/main", base: "HEAD" }).matched).toBe(false);
  });

  test("a base that names no commit, or a policy that can't be read, is a problem", () => {
    const r = new GateRepos("4913-problems");
    r.write(".chant/trust.json", "{ not json");
    const base = r.commit("broken policy");
    expect(refGateRulesAt(r.work, { ref: "refs/heads/main", base: "nope" }).problems[0]).toContain("--base nope names no commit");
    const broken = refGateRulesAt(r.work, { ref: "refs/heads/main", base });
    expect(broken.matched).toBe(false);
    expect(broken.problems[0]).toContain(".chant/trust.json is not JSON");
  });

  test("the status a forge check requires: the policy's own name, at origin/<default> when the checkout has it", () => {
    const r = new GateRepos("4913-status");
    const ci = runnerKey();
    r.write(".chant/trust.json", JSON.stringify({ schema: 1, runners: [{ principal: RUNNER, class: "runner", key: ci.pub }], refs: [{ ref: "refs/heads/main", checks: CHECKS, status: "acme/gate" }] }));
    r.commit("policy");
    r.push("main");
    r.git(["fetch", "-q", "origin"]);
    // A local change that drops the rule does not move what the forge's default branch requires.
    r.write(".chant/trust.json", JSON.stringify({ schema: 1 }));
    r.commit("drop locally");
    expect(refGateStatusFor(r.work, "main")).toEqual({ status: "acme/gate" });
    expect(refGateStatusFor(r.work, "trunk").note).toContain("matches refs/heads/trunk, so the ref-gate job sets no status there");
    const bare = new GateRepos("4913-status-head");
    bare.write(".chant/trust.json", "[]");
    bare.commit("not a policy");
    expect(refGateStatusFor(bare.work, "main").problem).toContain("the trust policy can't be read");
  });
});

describe("an apply before merge waits for the ref gate's status (#4966)", () => {
  test("the target branch: --branch, the pull request's target, then the branch the job runs on", () => {
    expect(beforeMergeBranch("release/2", { GITHUB_REF_NAME: "main" })).toBe("release/2");
    expect(beforeMergeBranch(undefined, { GITHUB_BASE_REF: "trunk", GITHUB_REF_NAME: "7/merge" })).toBe("trunk");
    expect(beforeMergeBranch(undefined, { CI_COMMIT_BRANCH: "main" })).toBe("main");
    expect(beforeMergeBranch(undefined, { GITHUB_REF_NAME: "main" })).toBe("main");
    expect(beforeMergeBranch(" ", {})).toBeUndefined();
  });

  test("the status the policy at base sets for the target branch is required, and none without a rule", async () => {
    const r = new GateRepos("4966-before-merge");
    const ci = runnerKey();
    r.write(".chant/trust.json", JSON.stringify({ schema: 1, runners: [{ principal: RUNNER, class: "runner", key: ci.pub }], refs: [{ ref: "refs/heads/main", checks: CHECKS, status: "acme/gate" }] }));
    const base = r.commit("policy");
    expect(await beforeMergeRefGate(r.work, base, undefined, { GITHUB_REF_NAME: "main" })).toMatchObject({ require: ["acme/gate"] });
    expect(await beforeMergeRefGate(r.work, base, "feature", {})).toEqual({ require: [] });
    expect(await beforeMergeRefGate(r.work, base, undefined, {})).toMatchObject({ require: [], note: expect.stringContaining("names no target branch") });
    r.write(".chant/trust.json", "{ not json");
    const broken = r.commit("broken policy");
    const refused = await beforeMergeRefGate(r.work, broken, "main", {});
    expect("problem" in refused && refused.problem).toContain("the trust policy at base can't be read");
  });
});

describe("the ref gate's init pieces (#4913)", () => {
  test("a checkout with no trust policy gets one with the rule, the pre-push hook and the runner key hint", () => {
    const r = new GateRepos("4913-init-new");
    r.write("README.md", "hi\n");
    r.commit("start");
    const plan = refGateInitPlan(r.work, { checks: CHECKS, chant: "npx chant", runner: "ci:acme/infra", runnerKeySecret: "CHANT_RUNNER_KEY" });
    const trust = plan.files.find((f) => f.path.endsWith(".chant/trust.json"))!;
    expect(trust.status).toBe("created");
    expect(JSON.parse(trust.content)).toEqual({ schema: 1, refs: [{ ref: "refs/heads/main", checks: [{ check: "plan", command: "chant ci run plan" }, { check: "lint", action: "warn", command: "npm run lint" }] }] });
    const hook = plan.files.find((f) => f.path.endsWith("pre-push"))!;
    expect(hook).toMatchObject({ status: "created", mode: 0o755, local: true });
    expect(hook.path.startsWith(join(realpathSync(r.work), ".git"))).toBe(true);
    expect(hook.content).toContain(REF_GATE_HOOK_MARK);
    expect(hook.content).toContain("exec npx chant workspace ref-gate pre-push");
    const hint = plan.notes.find((n) => n.includes("no runner key"))!;
    expect(hint).toContain("chant workspace trust runner add ci:acme/infra --key runner.pem");
    expect(hint).toContain("the CHANT_RUNNER_KEY secret");
    expect(plan.notes.some((n) => n.includes("protected write"))).toBe(true);

    writeRefGateInit(plan);
    expect(statSync(hook.path).mode & 0o777).toBe(0o755);
    const base = r.commit("ref gate");
    // What init wrote is what the gate reads.
    expect(refGateRulesAt(r.work, { ref: "refs/heads/main", base })).toMatchObject({ matched: true, status: REF_GATE_STATUS, checks: [{ check: "plan", action: "block" }, { check: "lint", action: "warn" }] });
    const again = refGateInitPlan(r.work, { checks: CHECKS, chant: "npx chant" });
    expect(again.files.map((f) => f.status)).toEqual(["unchanged", "unchanged"]);
    expect(again.notes.some((n) => n.includes("already has a refs rule for refs/heads/main"))).toBe(true);
  });

  test("an existing policy keeps its text and gets the rule added; one with a runner gets no hint", () => {
    const r = new GateRepos("4913-init-edit");
    const ci = runnerKey();
    const before = `{\n  "schema": 1,\n  "runners": [{ "principal": "${RUNNER}", "class": "runner", "key": "${ci.pub}" }]\n}\n`;
    r.write(".chant/trust.json", before);
    r.commit("runner only");
    const plan = refGateInitPlan(r.work, { branch: "trunk", checks: [{ check: "plan", command: "chant ci run plan" }], status: "acme/gate", prePush: false });
    expect(plan.files).toHaveLength(1);
    const trust = plan.files[0]!;
    expect(trust.status).toBe("updated");
    expect(trust.content.startsWith(`{\n  "schema": 1,\n  "runners": [{ "principal": "${RUNNER}"`)).toBe(true);
    expect(JSON.parse(trust.content).refs).toEqual([{ ref: "refs/heads/trunk", checks: [{ check: "plan", command: "chant ci run plan" }], status: "acme/gate" }]);
    expect(plan.notes.some((n) => n.includes("no runner key"))).toBe(false);
  });

  test("a rule that covers the branch, a policy that does not read, and a hook that is not chant's are left as they are", () => {
    const r = new GateRepos("4913-init-leave");
    r.write(".chant/trust.json", JSON.stringify({ schema: 1, refs: [{ ref: "refs/heads/*", checks: [{ check: "lint", command: "npm run lint" }] }] }));
    r.commit("a wide rule");
    const hooks = join(r.work, ".git", "hooks");
    writeFileSync(join(hooks, "pre-push"), "#!/bin/sh\necho mine\n");
    const plan = refGateInitPlan(r.work, { checks: CHECKS });
    expect(plan.files.map((f) => [f.path.endsWith(".chant/trust.json"), f.status])).toEqual([[true, "unchanged"]]);
    expect(plan.notes.some((n) => n.includes("already has a refs rule for refs/heads/main (refs/heads/*)"))).toBe(true);
    expect(plan.notes.some((n) => n.includes("is not chant's ref gate hook"))).toBe(true);
    expect(readFileSync(join(hooks, "pre-push"), "utf-8")).toContain("echo mine");

    r.write(".chant/trust.json", "{ not json");
    const bad = refGateInitPlan(r.work, { checks: CHECKS, prePush: false });
    expect(bad.files).toEqual([]);
    expect(bad.notes[0]).toContain("does not read as chant's trust policy");
  });

  test("options no rule can hold, or a directory outside git, are refused", () => {
    const r = new GateRepos("4913-init-refuse");
    r.commit("start");
    expect(() => refGateInitPlan(r.work, { checks: [] })).toThrow(RefGateInitError);
    expect(() => refGateInitPlan(r.work, { checks: [{ check: "has space", command: "x" }] })).toThrow("is not a check name");
    expect(() => refGateInitPlan(r.work, { branch: "release/*", checks: CHECKS })).toThrow(RefGateInitError);
    expect(() => refGateInitPlan(r.home, { checks: CHECKS })).toThrow("is not in a git checkout");
    expect(existsSync(join(r.work, ".chant/trust.json"))).toBe(false);
  });
});

describe("the request for an override from a push the remote refused (#4913)", () => {
  test("the pre-receive refusal prints the exact command that records it in the checkout, then the override and the push", () => {
    const r = new GateRepos("4913-request");
    const ci = runnerKey();
    r.write(".chant/trust.json", trustJson(ci, CHECKS));
    const base = r.commit("policy");
    r.write("app/a.txt", "change\n");
    const head = r.commit("a change");
    const d = decideRefUpdate({ repo: r.work, update: { ref: "refs/heads/main", old: base, new: head }, base, lifecycle: null });
    expect(d.decision).toBe("refuse");
    expect(requestCommand(d)).toBe(`chant workspace ref-gate check --ref refs/heads/main --at ${head} --base ${base}`);

    const remote = describeDecision(d, { site: "pre-receive" }).join("\n");
    expect(remote).toContain("record the request for an override in your checkout (this remote can't)");
    expect(remote).toContain(`    chant workspace ref-gate check --ref refs/heads/main --at ${head} --base ${base}`);
    expect(remote).toContain(`chant approve policy-override ref-gate-${head.slice(0, 12)}-plan --rule plan`);
    expect(remote).toContain(`git push origin chant/lifecycle ${head}:refs/heads/main`);
    expect(remote).not.toContain("lint --rule");

    const local = describeDecision(d).join("\n");
    expect(local).toContain(`the pre-push hook records it, or chant workspace ref-gate check --ref refs/heads/main --at ${head} --base ${base}`);
  });
});
