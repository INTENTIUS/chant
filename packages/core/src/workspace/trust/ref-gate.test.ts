/**
 * #4867: the ref gate refuses a ref update whose commit lacks current runner
 * evidence for a check the policy at base requires, and admits it once the
 * evidence is attached. The attacker controls the change: records edited
 * after signing, a runner key the change itself adds, a policy the change
 * loosens, and one override used for two updates. Evidence is fake: signed
 * here with a throwaway runner key, never by a real CI job.
 */

import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { contract } from "../__fixtures__/contract-repo";
import refGateSchema from "../ref-gate.schema.json";
import { REF_GATE_OUTPUT_SCHEMA_ID, postRefGateStatus, refGateHook } from "./ref-gate-cli";
import {
  decideRefUpdate,
  describeDecision,
  EVIDENCE_NOTES_REF,
  parsePrePush,
  parsePreReceive,
  readRefGateLedger,
  refPatternRegExp,
  RefUpdateInputError,
  rulesFor,
  runPrePush,
  runPreReceive,
} from "./ref-gate";
import { GateRepos, runnerKey, trustJson } from "./ref-gate-fixture";

const NOW = "2026-11-09T12:00:00.000Z";
const CHECKS = [
  { check: "plan", command: "chant ci run plan" },
  { check: "lint", action: "warn" as const, command: "npm run lint" },
];

/** main at the remote holds the policy and two records; `head` is a change on top, pushed to a side branch so the remote holds its objects. */
function setup(label: string, opts: { overriders?: string } = {}) {
  const r = new GateRepos(label);
  const ci = runnerKey();
  r.write(".chant/trust.json", trustJson(ci, CHECKS));
  if (opts.overriders) r.write(".chant/overriders", `${opts.overriders}\n`);
  r.write("records/n1.md", "one\n");
  r.write("records/n2.md", "two\n");
  const base = r.commit("policy and records");
  r.push("main");
  r.write("app/a.txt", "change\n");
  const head = r.commit("a change");
  r.push(`${head}:refs/heads/side`);
  return { r, ci, base, head };
}

const line = (old: string, nu: string, ref: string) => `${old} ${nu} ${ref}\n`;

describe("ref patterns and rules", () => {
  test("* matches within a segment and ** across them", () => {
    expect(refPatternRegExp("refs/heads/release/*").test("refs/heads/release/1")).toBe(true);
    expect(refPatternRegExp("refs/heads/release/*").test("refs/heads/release/1/x")).toBe(false);
    expect(refPatternRegExp("refs/heads/**").test("refs/heads/a/b")).toBe(true);
    expect(refPatternRegExp("refs/heads/main").test("refs/heads/mainline")).toBe(false);
  });

  test("a check two rules name blocks when either blocks it", () => {
    const r = rulesFor({ refs: [
      { ref: "refs/heads/*", checks: [{ check: "plan", action: "warn", command: "a" }] },
      { ref: "refs/heads/main", checks: [{ check: "plan", action: "block", command: "b" }], status: "acme/gate" },
    ] }, "refs/heads/main");
    expect(r.checks).toEqual([{ check: "plan", action: "block", command: "a" }]);
    expect(r.status).toBe("acme/gate");
    expect(rulesFor({ refs: [] }, "refs/heads/main").matched).toBe(false);
  });

  test("hook input is read strictly", () => {
    const a = "a".repeat(40);
    const z = "0".repeat(40);
    expect(parsePreReceive(line(z, a, "refs/heads/main"))).toEqual([{ ref: "refs/heads/main", old: null, new: a }]);
    expect(parsePrePush(`refs/heads/x ${a} refs/heads/main ${z}\n`)).toEqual([{ ref: "refs/heads/main", old: null, new: a }]);
    expect(() => parsePreReceive("nonsense\n")).toThrow(RefUpdateInputError);
  });
});

describe("the pre-receive decision", () => {
  test("a block check with no evidence is refused, naming the check and its command, and admitted once evidence is attached", () => {
    const { r, ci, base, head } = setup("admit");
    const refused = runPreReceive(r.origin, line(base, head, "refs/heads/main"), { now: NOW });
    expect(refused.ok).toBe(false);
    const d = refused.decisions[0];
    expect(d.base).toBe(base);
    expect(d.checks.map((c) => [c.check, c.status, c.code])).toEqual([["plan", "missing", "ref-evidence-missing"], ["lint", "missing", "ref-evidence-missing"]]);
    const text = describeDecision(d).join("\n");
    expect(text).toContain("refused refs/heads/main");
    expect(text).toContain("run: chant ci run plan");
    expect(text).toContain("run: npm run lint");
    expect(text).toMatch(/chant approve policy-override ref-gate-[0-9a-f]{12}-plan --rule plan --reason/);

    // The warn check alone stays missing: it is said, and the update goes through.
    r.sign(ci, "plan", head, ["records/n1.md", "records/n2.md"]);
    r.push(EVIDENCE_NOTES_REF);
    const admitted = runPreReceive(r.origin, line(base, head, "refs/heads/main"), { now: NOW });
    expect(admitted.ok).toBe(true);
    expect(admitted.decisions[0].checks.map((c) => [c.check, c.status])).toEqual([["plan", "current"], ["lint", "missing"]]);
    expect(admitted.decisions[0].checks[0].runner).toBe("ci@example.test");

    const ledger = readRefGateLedger(admitted.ledger);
    expect(ledger.map((l) => [l.site, l.decision, l.push ?? null])).toEqual([["pre-receive", "refuse", "refused"], ["pre-receive", "admit", null]]);
    expect(admitted.ledger).toBe(join(r.origin, "chant", "ref-gate.jsonl"));
  });

  test("evidence pushed with the ref, in the same push, counts", () => {
    const { r, ci, base, head } = setup("same-push");
    r.sign(ci, "plan", head, ["records/n1.md"]);
    const notes = r.notesTip();
    r.push(`${notes}:refs/heads/notes-objects`);
    const d = runPreReceive(r.origin, line(base, head, "refs/heads/main") + line("0".repeat(40), notes, EVIDENCE_NOTES_REF), { now: NOW });
    expect(d.ok).toBe(true);
  });

  test("evidence whose records changed after signing is stale and refused", () => {
    const { r, ci, base, head } = setup("stale");
    r.write("records/n1.md", "one, edited\n");
    const edited = r.commit("edit a record after the check ran");
    r.push(`${edited}:refs/heads/side`);
    // The envelope signed at `head` is carried to `edited`, as a pipeline that copies evidence forward would.
    r.sign(ci, "plan", head, ["records/n1.md", "records/n2.md"], edited);
    r.push(EVIDENCE_NOTES_REF);
    const d = runPreReceive(r.origin, line(base, edited, "refs/heads/main"), { now: NOW }).decisions[0];
    expect(d.decision).toBe("refuse");
    expect(d.checks[0]).toMatchObject({ check: "plan", status: "stale", code: "ref-evidence-stale" });
    expect(d.checks[0].reason).toContain("records/n1.md changed");
  });

  test("evidence over no records counts only for the tree it was signed over", () => {
    const { r, ci, base, head } = setup("no-records");
    r.write("app/a.txt", "changed again\n");
    const next = r.commit("another change");
    r.push(`${next}:refs/heads/side`);
    r.sign(ci, "plan", head, [], next);
    r.push(EVIDENCE_NOTES_REF);
    expect(runPreReceive(r.origin, line(base, next, "refs/heads/main"), { now: NOW }).decisions[0].checks[0]).toMatchObject({ status: "stale", code: "ref-evidence-stale" });
  });

  test("a runner key the change itself adds signs nothing the gate counts", () => {
    const { r, ci, base } = setup("added-key");
    const mine = runnerKey();
    r.write(".chant/trust.json", JSON.stringify({ schema: 1, runners: [{ principal: "ci@example.test", class: "runner", key: mine.pub }], refs: [] }));
    const change = r.commit("swap the runner key and drop the rule");
    r.push(`${change}:refs/heads/side`);
    r.sign(mine, "plan", change, ["records/n1.md"]);
    r.push(EVIDENCE_NOTES_REF);
    const d = runPreReceive(r.origin, line(base, change, "refs/heads/main"), { now: NOW }).decisions[0];
    // Judged by the policy at base: the rule still holds and the change's key is not a runner there.
    expect(d.decision).toBe("refuse");
    expect(d.checks[0]).toMatchObject({ check: "plan", status: "missing", code: "envelope-untrusted" });
    void ci;
  });

  test("an override admits one commit for one check once, and is spent", () => {
    const { r, base, head } = setup("override", { overriders: "alice" });
    // `setup` committed .chant/overriders with the policy, so it is at base.
    r.override(head, "plan", "alice", "the plan job is down and this is a docs change");
    r.push("chant/lifecycle");
    const first = runPreReceive(r.origin, line(base, head, "refs/heads/main"), { now: NOW });
    expect(first.ok).toBe(true);
    expect(first.decisions[0].checks[0]).toMatchObject({ check: "plan", status: "overridden", override: { by: "alice" } });

    const again = runPreReceive(r.origin, line("0".repeat(40), head, "refs/heads/release/1"), { now: NOW });
    expect(again.ok).toBe(false);
    expect(again.decisions[0].checks[0].status).toBe("missing");
    expect(again.decisions[0].checks[0].reason).toMatch(/is spent/);
  });

  test("one push may not spend an override on two refs", () => {
    const { r, base, head } = setup("override-twice", { overriders: "alice" });
    r.override(head, "plan", "alice", "docs only");
    r.push("chant/lifecycle");
    const both = runPreReceive(r.origin, line(base, head, "refs/heads/main") + line("0".repeat(40), head, "refs/heads/release/1"), { now: NOW });
    expect(both.decisions.map((d) => d.decision)).toEqual(["admit", "refuse"]);
    expect(both.ok).toBe(false);
    // The push was refused as a whole, so the override is still unspent.
    expect(runPreReceive(r.origin, line(base, head, "refs/heads/main"), { now: NOW }).ok).toBe(true);
  });

  test("an override by someone the overriders file does not list counts for nothing", () => {
    const { r, base, head } = setup("override-unlisted", { overriders: "alice" });
    r.override(head, "plan", "mallory", "trust me");
    r.push("chant/lifecycle");
    const d = runPreReceive(r.origin, line(base, head, "refs/heads/main"), { now: NOW }).decisions[0];
    expect(d.decision).toBe("refuse");
    expect(d.checks[0].reason).toContain("mallory is not listed in .chant/overriders");
  });

  test("an unprotected ref, a deletion and a repository without a policy are admitted", () => {
    const { r, base, head } = setup("unprotected");
    expect(runPreReceive(r.origin, line(base, head, "refs/heads/feature"), { now: NOW }).ok).toBe(true);
    expect(runPreReceive(r.origin, line(base, "0".repeat(40), "refs/heads/main"), { now: NOW }).ok).toBe(true);
    expect(decideRefUpdate({ repo: r.work, update: { ref: "refs/heads/main", old: null, new: head }, base: null }).decision).toBe("admit");
  });

  test("a policy at base that can't be read refuses every update", () => {
    const r = new GateRepos("unreadable");
    r.write(".chant/trust.json", "{ not json");
    const base = r.commit("broken policy");
    const d = decideRefUpdate({ repo: r.work, update: { ref: "refs/heads/main", old: base, new: base }, base });
    expect(d.decision).toBe("refuse");
    expect(d.error?.code).toBe("trust-policy-unreadable");
  });
});

describe("the developer's side and the forge", () => {
  test("pre-push refuses before the network, reading the policy at the remote's tip", () => {
    const { r, ci, base, head } = setup("pre-push");
    const input = `refs/heads/main ${head} refs/heads/main ${base}\n`;
    const refused = runPrePush(r.work, input, { now: NOW });
    expect(refused.ok).toBe(false);
    expect(refused.decisions[0].base).toBe(base);
    r.sign(ci, "plan", head, ["records/n1.md"]);
    expect(runPrePush(r.work, input, { now: NOW }).ok).toBe(true);
    // A pre-push spends nothing and is a line of the checkout's own ledger.
    expect(readRefGateLedger(refused.ledger).map((l) => l.site)).toEqual(["pre-push", "pre-push"]);
  });

  test("the same decision sets the required status: failure naming the missing check, then success", async () => {
    const { r, ci, base, head } = setup("status");
    const posted: Array<{ sha: string; context: string; state: string; description: string }> = [];
    const forge = { setStatus: async (sha: string, s: { context: string; state: string; description: string }) => void posted.push({ sha, ...s }) };
    const decide = () => decideRefUpdate({ repo: r.work, update: { ref: "refs/heads/main", old: base, new: head }, base, now: NOW });
    await postRefGateStatus(forge, decide());
    r.sign(ci, "plan", head, ["records/n1.md"]);
    await postRefGateStatus(forge, decide());
    expect(posted).toEqual([
      { sha: head, context: "chant/ref-gate", state: "failure", description: "missing evidence: plan (run chant ci run plan)" },
      { sha: head, context: "chant/ref-gate", state: "success", description: "evidence current" },
    ]);
  });

  test("a policy at base that does not read fails the status closed (#4964)", async () => {
    const { r, base } = setup("status-unreadable");
    r.write(".chant/trust.json", "{ not json");
    const broken = r.commit("broken policy");
    const posted: Array<{ sha: string; context: string; state: string; description: string }> = [];
    const forge = { setStatus: async (sha: string, s: { context: string; state: string; description: string }) => void posted.push({ sha, ...s }) };
    await postRefGateStatus(forge, decideRefUpdate({ repo: r.work, update: { ref: "refs/heads/main", old: base, new: broken }, base: broken, now: NOW }));
    expect(posted).toEqual([{ sha: broken, context: "chant/ref-gate", state: "failure", description: "refused: trust-policy-unreadable" }]);
  });

  test("the hooks run chant with git's arguments and input", () => {
    expect(refGateHook("pre-receive")).toBe('#!/bin/sh\n# chant ref gate (#4867)\nexec chant workspace ref-gate pre-receive "$@"\n');
    expect(refGateHook("pre-push", "npx chant")).toContain("exec npx chant workspace ref-gate pre-push");
  });

  test("the --json document matches ref-gate.schema.json", () => {
    const { r, base, head } = setup("schema");
    const { expectValid } = contract(refGateSchema);
    const decisions = runPreReceive(r.origin, line(base, head, "refs/heads/main"), { now: NOW }).decisions;
    expectValid({ $schema: REF_GATE_OUTPUT_SCHEMA_ID, contract: 1, chant: "0.0.0", ok: false, decisions });
    expectValid({ $schema: REF_GATE_OUTPUT_SCHEMA_ID, contract: 1, chant: "0.0.0", error: { code: "ref-update-invalid", message: "m" } });
  });
});
