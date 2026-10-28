/**
 * #4630: `<product>/approval` on an open pull request's head, from the
 * policy at base, the head's recorded plans and the forge's reviews, on
 * fake GitHub, GitLab and Forgejo forges.
 */

import { describe, expect, test } from "vitest";
import { assertProductWords } from "../ci-product-words";
import type { HeadPlans } from "../lifecycle/wave-plans";
import { parseHeadPlans } from "../lifecycle/wave-plans";
import type { ForgeStatus, PrApprovalResult } from "../pr-forge";
import { approvalStatusOf, headWaveHolds, postApprovalStatus, postOpenApprovalStatuses } from "./approval-status";
import type { OpWavesSpec } from "./op-waves";
import type { OpWaveShowAtBase } from "./op-waves-run";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

const SPEC: OpWavesSpec = {
  name: "plywood-up",
  op: "plywood-up",
  plan: ["./bin/plan", "{target}", "{plan}"],
  waves: [
    { name: "dev", runs: [{ target: "dev" }], gate: "never", approval: "pr-review" },
    { name: "prod", runs: [{ target: "prod" }], gate: "on-destructive", approval: "pr-review" },
  ],
};

/** The spec as it stands at base: what the policy is read from. */
const atBase = (spec: OpWavesSpec | null): OpWaveShowAtBase => () => ({ sha: BASE, text: spec ? JSON.stringify(spec) : null });

const plans = (waves: HeadPlans["waves"]): HeadPlans => ({ version: 1, name: SPEC.name, head: HEAD, timestamp: "2026-10-28T00:00:00Z", waves });

function fakeForge(kind: "github" | "gitlab" | "forgejo", approval: PrApprovalResult) {
  const statuses: Array<{ sha: string; status: ForgeStatus }> = [];
  const asked: Array<{ pr: number; head: string }> = [];
  const forge = {
    kind,
    runUrl: "https://ci.example/run/1",
    async prApproved(pr: number, head: string) {
      asked.push({ pr, head });
      return approval;
    },
    async setStatus(sha: string, status: ForgeStatus) {
      statuses.push({ sha, status });
    },
    async openPullRequests() {
      return [
        { number: 3, head: "feature", headSha: HEAD, base: "main", baseSha: BASE, fork: false },
        { number: 4, head: "fork-branch", headSha: "c".repeat(40), base: "main", fork: true },
      ];
    },
  };
  return { forge, statuses, asked };
}

const approved: PrApprovalResult = { passed: true, reason: "approved", approvers: ["github:lee"], excluded: [] };
const notApproved: PrApprovalResult = { passed: false, reason: "no writer other than the author approved a1b2c3d4", approvers: [], excluded: [] };

describe("which waves the gate will hold (#4630)", () => {
  test("never holds nothing, on-destructive holds a destructive plan, always holds a change; no facts read as a change", () => {
    expect(headWaveHolds("never", { changes: true, destructive: true })).toBe(false);
    expect(headWaveHolds("on-destructive", { changes: true, destructive: false })).toBe(false);
    expect(headWaveHolds("on-destructive", { changes: true, destructive: true })).toBe(true);
    expect(headWaveHolds("always", { changes: false })).toBe(false);
    expect(headWaveHolds("always", {})).toBe(true);
  });

  test("the plans record keeps the facts, and an older record without them still parses", () => {
    const text = JSON.stringify(plans([{ wave: 1, name: "dev", digest: "d1", changes: true, destructive: false }]));
    expect(parseHeadPlans(text)?.waves[0]).toEqual({ wave: 1, name: "dev", digest: "d1", changes: true, destructive: false });
    expect(parseHeadPlans(JSON.stringify(plans([{ wave: 1, name: "dev", digest: "d1" }])))?.waves[0]).toEqual({ wave: 1, name: "dev", digest: "d1" });
  });
});

describe("<product>/approval on the head (#4630)", () => {
  for (const kind of ["github", "gitlab", "forgejo"] as const) {
    test(`pending while a held wave has no approving review, success once it has (${kind})`, async () => {
      const recorded = plans([
        { wave: 1, name: "dev", digest: "d1", changes: true, destructive: true },
        { wave: 2, name: "prod", digest: "d2", changes: true, destructive: true },
      ]);
      const words = assertProductWords({ product: "plywood" });
      const waiting = fakeForge(kind, notApproved);
      const status = await postApprovalStatus({ spec: SPEC, specFile: "waves.json", forge: waiting.forge, pr: 3, head: HEAD, base: BASE, show: atBase(SPEC), readPlans: async () => recorded }, words);
      expect(status).toMatchObject({ state: "pending", waits: [2] });
      expect(waiting.statuses).toEqual([{ sha: HEAD, status: { context: "plywood/approval", state: "pending", description: expect.stringContaining("wave 2 wait"), url: "https://ci.example/run/1" } }]);
      expect(waiting.asked).toEqual([{ pr: 3, head: HEAD }]);

      const done = fakeForge(kind, approved);
      const ok = await postApprovalStatus({ spec: SPEC, specFile: "waves.json", forge: done.forge, pr: 3, head: HEAD, base: BASE, show: atBase(SPEC), readPlans: async () => recorded }, words);
      expect(ok).toMatchObject({ state: "success", approvers: ["github:lee"] });
      expect(done.statuses[0]!.status.description).toContain("by github:lee");
    });
  }

  test("a plan no gate holds is success without asking for reviews", async () => {
    const { forge, asked } = fakeForge("github", notApproved);
    const status = await approvalStatusOf({
      spec: SPEC,
      specFile: "waves.json",
      forge,
      pr: 3,
      head: HEAD,
      base: BASE,
      show: atBase(SPEC),
      readPlans: async () => plans([{ wave: 1, name: "dev", digest: "d1", changes: true }, { wave: 2, name: "prod", digest: "d2", changes: true, destructive: false }]),
    });
    expect(status).toMatchObject({ state: "success", waits: [] });
    expect(asked).toEqual([]);
  });

  test("the policy is read at base: a head that loosens it still waits", async () => {
    const loosened: OpWavesSpec = { ...SPEC, waves: SPEC.waves.map((w) => ({ ...w, gate: "never" as const })) };
    const strict: OpWavesSpec = { ...SPEC, waves: SPEC.waves.map((w) => ({ ...w, gate: "always" as const })) };
    const { forge } = fakeForge("forgejo", notApproved);
    const status = await approvalStatusOf({ spec: loosened, specFile: "waves.json", forge, pr: 3, head: HEAD, base: BASE, show: atBase(strict), readPlans: async () => plans([{ wave: 1, name: "dev", digest: "d1", changes: true }, { wave: 2, name: "prod", digest: "d2", changes: true }]) });
    expect(status).toMatchObject({ state: "pending", waits: [1, 2] });
  });

  test("plans not recorded yet are pending; no pr-review wave at base is success", async () => {
    const { forge } = fakeForge("github", approved);
    expect(await approvalStatusOf({ spec: SPEC, specFile: "waves.json", forge, pr: 3, head: HEAD, base: BASE, show: atBase(SPEC), readPlans: async () => null })).toMatchObject({ state: "pending", description: expect.stringContaining("not recorded yet") });
    const ledgerOnly: OpWavesSpec = { ...SPEC, waves: SPEC.waves.map(({ approval: _a, ...w }) => w) };
    expect(await approvalStatusOf({ spec: SPEC, specFile: "waves.json", forge, pr: 3, head: HEAD, base: BASE, show: atBase(ledgerOnly), readPlans: async () => null })).toMatchObject({ state: "success" });
  });

  test("--open posts on every open merge request from the repository, and leaves forks out", async () => {
    const { forge, statuses } = fakeForge("gitlab", notApproved);
    const done = await postOpenApprovalStatuses({ spec: SPEC, specFile: "waves.json", forge, branch: "main", show: atBase(SPEC), readPlans: async () => plans([{ wave: 2, name: "prod", digest: "d2", changes: true, destructive: true }]) }, assertProductWords({ product: "plywood" }));
    expect(done.posted.map((p) => p.pr)).toEqual([3]);
    expect(statuses.map((s) => s.sha)).toEqual([HEAD]);
  });
});
