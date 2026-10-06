/**
 * The change-set document (#3181): its schema, the lifecycle and reconcile
 * adapters, and the digest.
 *
 * `__fixtures__/change-set/lifecycle-plan.floci.json` is real `chant
 * lifecycle plan dev --owned --json` output: `lifecycle-v1.ts.txt` deployed as
 * CloudFormation stack `dev` to floci 1.5.34 and snapshotted, then
 * `lifecycle-v2.ts.txt` planned. It has a create and no-ops; the aws lexicon
 * reads stack resources, so out-of-band drift does not reach it as an
 * update. The update, delete, effect and hole mappings are pinned on typed
 * entries below.
 *
 * `warden.plan.json` is what github-warden's `reconcile --plan-json` wrote
 * (github-warden#66) for a teams cycle in an org that declares `owned: true`:
 * one create, one update and one owned delete, as a JSON array of reconcile
 * change sets. It was produced by warden's own `runReconcile` and
 * `teamsCycle` against a stubbed live state, not built here.
 *
 * Goldens regenerate with `UPDATE_GOLDEN=1`.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  CHANGE_SET_SCHEMA_ID,
  changeSetDigest,
  changeSetDocumentDigest,
  composeChangeSet,
  lifecyclePlanPart,
  reconcilePlanPart,
  verifyChangeSetDigest,
  type ChangeSetPart,
} from "./change-set";
import { computePlanDigest } from "./lifecycle/plan-digest";
import type { ChangeSet as LifecycleChangeSet } from "./lifecycle/change-set";
import { diffCollection, diffFields, type ChangeSet as ReconcileChangeSet, type ChangeSetEntry as ReconcileEntry } from "./reconcile";
import { contract, REPO, validSchema } from "./workspace/__fixtures__/contract-repo";
import schema from "./workspace/change-set.schema.json";

const DIR = join(import.meta.dirname, "__fixtures__", "change-set");
const TF_DIR = join(REPO, "lexicons", "terraform", "src", "__fixtures__", "change-set");
const read = (dir: string, name: string): unknown => JSON.parse(readFileSync(join(dir, name), "utf-8"));

function golden(name: string, value: unknown): void {
  const path = join(DIR, name);
  const text = JSON.stringify(value, null, 2) + "\n";
  if (process.env.UPDATE_GOLDEN) writeFileSync(path, text);
  expect(text).toBe(readFileSync(path, "utf-8"));
}

const { expectValid, validate } = contract(schema);

/** A warden's teams cycle, planned by the reconcile primitives it is built on. */
function wardenPlan(): ReconcileChangeSet {
  type Team = { privacy: string; description: string };
  const desired = new Map<string, Team>([
    ["platform", { privacy: "closed", description: "Platform team" }],
    ["release", { privacy: "secret", description: "Release managers" }],
  ]);
  const live = new Map<string, Team>([
    ["platform", { privacy: "secret", description: "Platform team" }],
    ["contractors", { privacy: "closed", description: "Old contractors" }],
  ]);
  const entries: ReconcileEntry[] = [];
  diffCollection({
    resourceType: "team",
    desired,
    live,
    compareFields: (d, l) => diffFields(d, l),
    opts: { isOwned: () => true },
    out: entries,
  });
  return { org: "acme", entries, managedCount: live.size };
}

describe("the change-set schema", () => {
  test("is a valid draft 2020-12 document at the read contract's version", () => {
    expect(validSchema(schema)).toBe(true);
    expect(schema.$id).toBe(CHANGE_SET_SCHEMA_ID);
    expect(schema.properties.contract).toEqual({ const: 1 });
  });

  test("every golden document in both fixture directories validates", () => {
    const docs = [
      ...readdirSync(DIR).filter((f) => f.endsWith(".change-set.golden.json")).map((f) => read(DIR, f)),
      ...readdirSync(TF_DIR).filter((f) => f.endsWith(".change-set.golden.json")).map((f) => read(TF_DIR, f)),
      ...readdirSync(TF_DIR).filter((f) => f.endsWith(".part.golden.json")).map((f) => composeChangeSet([read(TF_DIR, f) as ChangeSetPart])),
    ];
    expect(docs.length).toBeGreaterThanOrEqual(5);
    for (const doc of docs) expectValid(doc);
  });

  test("refuses an unknown action, a missing digest and a malformed plan digest", () => {
    const doc = composeChangeSet([lifecyclePlanPart({ member: "delivery", plan: read(DIR, "lifecycle-plan.floci.json") as LifecycleChangeSet })]);
    expect(validate({ ...doc, entries: [{ ...doc.entries[0], action: "teleport" }] })).toBe(false);
    const { digest: _d, ...noDigest } = doc;
    expect(validate(noDigest)).toBe(false);
    expect(validate({ ...doc, members: [{ ...doc.members[0], planDigest: "sha256:abc" }] })).toBe(false);
  });
});

describe("lifecyclePlanPart", () => {
  test("a real lifecycle plan against floci matches its golden", () => {
    const plan = read(DIR, "lifecycle-plan.floci.json") as LifecycleChangeSet;
    const part = lifecyclePlanPart({ member: "delivery", plan });
    expect(part.member.planDigest).toBe(computePlanDigest("lifecycle-plan", plan));
    expect(part.entries.map((e) => [e.address, e.action])).toEqual([
      ["alerts", "no-op"], ["dlq", "create"], ["events", "no-op"], ["jobs", "no-op"],
    ]);
    golden("lifecycle.change-set.golden.json", composeChangeSet([part]));
  });

  test("update, replace, delete, effect, holes, and what is left out", () => {
    const plan: LifecycleChangeSet = {
      env: "prod",
      entries: [
        { name: "web", type: "Deployment", lexicon: "k8s", action: "update", evidence: { declared: true, inSnapshot: true, live: true, observed: true }, ownership: "owned", deltas: [{ path: "replicas", oldValue: 2, newValue: 3 }], disruption: "rolling" },
        { name: "db", type: "AWS::RDS::DBInstance", lexicon: "aws", action: "update", evidence: { declared: true, inSnapshot: true, live: true, observed: true }, ownership: "owned", deltas: [{ path: "Engine", oldValue: "mysql", newValue: "postgres" }], disruption: "destroy", disruptionBecause: ["Engine"] },
        { name: "old", type: "AWS::SQS::Queue", lexicon: "aws", action: "delete", evidence: { declared: false, inSnapshot: true, live: true, observed: true }, ownership: "owned" },
        { name: "notify-receipt", type: "Receipt", lexicon: "aws", action: "effect", effect: "notify", effectReason: "receipt-absent", evidence: { declared: true, inSnapshot: false, live: false, observed: true }, ownership: "owned" },
        { name: "cache", type: "AWS::ElastiCache::CacheCluster", lexicon: "aws", action: "unobserved", unobservedReason: "read-failed", evidence: { declared: true, inSnapshot: false, live: false, observed: false }, ownership: "unknown" },
        { name: "stray", lexicon: "aws", action: "adopt", evidence: { declared: false, inSnapshot: false, live: true, observed: true }, ownership: "unknown" },
        { name: "web-abc12", lexicon: "k8s", action: "runtime", runtimeOwner: "web", evidence: { declared: false, inSnapshot: false, live: true, observed: true }, ownership: "unknown" },
      ],
    };
    const { member, entries } = lifecyclePlanPart({ member: "delivery", plan });
    expect(entries.map((e) => [e.address, e.action, e.disruption ?? null])).toEqual([
      ["web", "update", "rolling"],
      ["db", "replace", "destroy"],
      ["old", "delete", "destroy"],
      ["notify-receipt", "create", null],
    ]);
    expect(entries[1].attributes).toEqual([{ path: "Engine", before: "mysql", after: "postgres", forcesReplacement: true }]);
    expect(member.holes).toEqual([{ address: "cache", type: "AWS::ElastiCache::CacheCluster", reason: "read-failed" }]);
    expect(member.lexicon).toBe("chant");
    const doc = composeChangeSet([{ member, entries }]);
    expectValid(doc);
    expect(doc.summary.holes).toBe(1);
    expect(doc.summary.replacements).toEqual([{ member: "delivery", address: "db", type: "AWS::RDS::DBInstance", disruption: "destroy" }]);
  });
});

describe("reconcilePlanPart", () => {
  test("a warden's teams cycle, as `reconcile --plan-json` wrote it", () => {
    const part = reconcilePlanPart({ member: "warden", plan: read(DIR, "warden.plan.json") as ReconcileChangeSet[] });
    expect(part.entries.map((e) => [e.address, e.action, e.disruption ?? null])).toEqual([
      ["team.contractors", "delete", "destroy"],
      ["team.platform", "update", "unknown"],
      ["team.release", "create", null],
    ]);
    expect(part.entries[1].attributes).toEqual([{ path: "privacy", before: "secret", after: "closed" }]);
    golden("warden.change-set.golden.json", composeChangeSet([part]));
  });

  test("the plan digest ignores the managed counts and the order of change sets", () => {
    const a = wardenPlan();
    const b: ReconcileChangeSet = { org: "beta", entries: [] };
    const one = reconcilePlanPart({ member: "w", plan: [a, b] }).member.planDigest;
    expect(reconcilePlanPart({ member: "w", plan: [b, { ...a, managedCount: 99 }] }).member.planDigest).toBe(one);
    expect(reconcilePlanPart({ member: "w", plan: [b, { ...a, entries: a.entries.slice(1) }] }).member.planDigest).not.toBe(one);
  });
});

describe("the digest", () => {
  const lifecycle = () => lifecyclePlanPart({ member: "delivery", plan: read(DIR, "lifecycle-plan.floci.json") as LifecycleChangeSet });
  const warden = () => reconcilePlanPart({ member: "warden", plan: wardenPlan() });
  const tofu = () => read(TF_DIR, "tofu.part.golden.json") as ChangeSetPart;

  test("binds the set digest over { member, planDigest }, the members' status and holes, the entries and the side effects, whatever order the parts come in", () => {
    const doc = composeChangeSet([lifecycle(), warden(), tofu()]);
    expect(composeChangeSet([tofu(), warden(), lifecycle()])).toEqual(doc);
    const pairs = doc.members.map((m) => ({ member: m.member, planDigest: m.planDigest }));
    expect(changeSetDigest(doc.members)).toBe(computePlanDigest("change-set", pairs));
    expect(doc.digest).toBe(
      computePlanDigest("change-set-document", {
        set: computePlanDigest("change-set", pairs),
        members: doc.members.map((m) => ({ member: m.member, status: m.status, holes: m.holes })),
        entries: doc.entries,
        sideEffects: [],
      }),
    );
    expect(doc.digest).toBe(changeSetDocumentDigest({ ...doc, entries: [...doc.entries].reverse() }));
    expect(doc.digest).toMatch(/^jcs1-sha256:[0-9a-f]{64}$/);
    expect(verifyChangeSetDigest(doc)).toBe(true);
    expect(verifyChangeSetDigest({ ...doc, digest: changeSetDigest(doc.members.slice(1)) })).toBe(false);
  });

  test("moves when one member's plan moves, and only then", () => {
    const base = composeChangeSet([lifecycle(), warden()]).digest;
    expect(composeChangeSet([lifecycle(), warden()], { chant: "9.9.9" }).digest).toBe(base);
    const moved = wardenPlan();
    moved.entries[0] = { ...moved.entries[0], after: { privacy: "closed", description: "Release engineers" } };
    expect(composeChangeSet([lifecycle(), reconcilePlanPart({ member: "warden", plan: moved })]).digest).not.toBe(base);
    // A wave is a subset of members: its digest is the set digest over them, which the document's digest binds.
    expect(changeSetDigest([lifecycle().member])).toBe(computePlanDigest("change-set", [{ member: "delivery", planDigest: lifecycle().member.planDigest }]));
    expect(changeSetDigest([lifecycle().member])).not.toBe(composeChangeSet([lifecycle()]).digest);
  });

  test("moves when an entry, a hole, a member's status or a side effect does, so a document with edited entries does not verify (#3555)", () => {
    const doc = composeChangeSet([lifecycle(), warden()]);
    const [first, ...rest] = doc.entries;
    const edited = [
      { ...doc, entries: rest },
      { ...doc, entries: [{ ...first, action: "no-op" as const }, ...rest] },
      { ...doc, entries: [{ ...first, attributes: [...first.attributes, { path: "planted", after: "x" }] }, ...rest] },
      { ...doc, entries: [...doc.entries, { ...first, address: `${first.address}-planted` }] },
      { ...doc, members: doc.members.map((m) => ({ ...m, holes: [...m.holes, { address: "planted", reason: "unobserved" }] })) },
      { ...doc, members: doc.members.map((m, i) => (i === 0 ? { ...m, status: "failed" as const } : m)) },
      { ...doc, sideEffects: [{ member: doc.members[0].member, address: "action.aws_lambda_invoke.planted", type: "aws_lambda_invoke" }] },
    ];
    expect(verifyChangeSetDigest(doc)).toBe(true);
    for (const e of edited) {
      expect(changeSetDocumentDigest(e)).not.toBe(doc.digest);
      expect(verifyChangeSetDigest(e)).toBe(false);
    }
    expect(verifyChangeSetDigest({ ...doc, members: [...doc.members, doc.members[0]] })).toBe(false);
  });

  test("leaves provisional members out, so approving the document never covers them", () => {
    const provisional = tofu();
    provisional.member = { ...provisional.member, provisional: true };
    const doc = composeChangeSet([lifecycle(), warden(), provisional]);
    expect(doc.members.find((m) => m.provisional)?.member).toBe(provisional.member.member);
    expect(doc.digest).toBe(composeChangeSet([lifecycle(), warden()]).digest);
    expect(verifyChangeSetDigest(doc)).toBe(true);
    expectValid(doc);
  });

  test("refuses two parts for one member, and an entry naming another member", () => {
    expect(() => composeChangeSet([warden(), warden()])).toThrow(/names member warden twice/);
    const stray = warden();
    stray.entries[0] = { ...stray.entries[0], member: "other" };
    expect(() => composeChangeSet([stray])).toThrow(/names member other, inside member warden/);
  });

  test("the summary counts per action, type and member, and names every delete and replacement", () => {
    const doc = composeChangeSet([lifecycle(), warden(), tofu()]);
    expect(doc.summary.actions).toEqual({ create: 4, update: 3, replace: 1, delete: 2, read: 0, "no-op": 4, forget: 0 });
    expect(doc.summary.byMember.warden).toEqual({ create: 1, update: 1, delete: 1 });
    expect(doc.summary.types.terraform_data).toEqual({ create: 2, update: 2, replace: 1, delete: 1, "no-op": 1 });
    expect(doc.summary.deletes.map((d) => `${d.member}:${d.address}`)).toEqual(["estate:terraform_data.old", "warden:team.contractors"]);
    expect(doc.summary.replacements.map((d) => `${d.member}:${d.address}`)).toEqual(["estate:terraform_data.worker"]);
  });
});
