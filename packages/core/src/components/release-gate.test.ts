/**
 * The release gate's change set (#4045, ws-104 questions 2 and 6): what a
 * promote under a release plans for an environment, whether it is empty, and
 * the document's binding to the release and the environment.
 */

import { describe, expect, test } from "vitest";
import { CapabilityRegistry } from "./capability";
import type { DriverComponent } from "./driver";
import {
  chantComponentPart,
  emptyResolution,
  emptyVerifier,
  gateNamesOf,
  planReleaseChangeSet,
  provisionalMembers,
  RELEASE_GATE_OP,
} from "./release-gate";
import { composeChangeSet, isEmptyChangeSet, verifyChangeSetDigest, type ChangeSetDocument } from "../change-set";
import { makeRelease, type Release } from "../lifecycle/release-store";
import type { ReleaseRecord } from "../lifecycle/release-ledger";

const sha = (c: string) => `sha256:${c.repeat(64)}`;

function release(prodTemplate: string, opts: { commit?: string; flag?: string } = {}): Release {
  return makeRelease({
    member: null,
    commit: (opts.commit ?? "a").repeat(40),
    artifactDigests: [{ component: "api", kind: "image", path: "api.tar", digest: sha("1") }],
    targets: [
      { env: "staging", templates: [{ component: "api", path: "dist/api.json", digest: sha("5") }], params: [{ name: "flag", value: "off", source: "default" }] },
      { env: "prod", templates: [{ component: "api", path: "dist/api.json", digest: prodTemplate }], params: [{ name: "flag", value: opts.flag ?? "off", source: "default" }] },
    ],
  });
}

const api: DriverComponent = {
  name: "api",
  deploy: [
    { phase: "Publish", steps: [{ kind: "recorded-digest", digest: sha("1") }] },
    { phase: "Apply", steps: [{ kind: "gate", gate: "prod-release" }, { kind: "apply", template: "dist/api.json" }] },
  ],
};

const record = (over: Partial<ReleaseRecord> = {}): ReleaseRecord => ({
  version: 1,
  component: "api",
  env: "prod",
  digest: "sha256:published",
  gitSha: "a".repeat(40),
  runId: "run-1",
  timestamp: "2026-10-01T00:00:00.000Z",
  actor: "ci",
  ...over,
});

const registry = () => {
  const r = new CapabilityRegistry();
  r.register({ kind: "recorded-digest", async run() { return {}; } } as never);
  r.register({ kind: "apply", async run() { return {}; } } as never);
  return r;
};

describe("gateNamesOf", () => {
  test("lists each gate a composition declares once, nested phases included", () => {
    const web: DriverComponent = { name: "web", deploy: [{ phase: "A", steps: [{ phase: "B", steps: [{ kind: "gate", gate: "prod-release" }, { kind: "gate", gate: "dba" }] }] }] };
    expect(gateNamesOf([api, web])).toEqual(["dba", "prod-release"]);
    expect(gateNamesOf([{ name: "x", deploy: [{ phase: "A", steps: [{ kind: "apply" }] }] }])).toEqual([]);
  });
});

describe("chantComponentPart", () => {
  const r1 = release(sha("7"));

  test("a component the environment already runs at the same artifact, templates and parameters has no entries", () => {
    const part = chantComponentPart({ component: api, release: r1, env: "prod", digest: "sha256:published", current: { record: record({ releaseDigest: r1.releaseDigest }), release: r1 } });
    expect(part.entries).toEqual([]);
    expect(part.member.holes).toEqual([]);
    expect(isEmptyChangeSet(composeChangeSet([part]))).toBe(true);
  });

  test("a changed template, artifact or parameter is an update naming each one", () => {
    const r2 = release(sha("8"), { commit: "b", flag: "on" });
    const part = chantComponentPart({ component: api, release: r2, env: "prod", digest: "sha256:rebuilt", current: { record: record({ releaseDigest: r1.releaseDigest }), release: r1 } });
    expect(part.entries).toHaveLength(1);
    expect(part.entries[0]).toMatchObject({ address: "api", action: "update", type: "chant:component", scope: "prod" });
    expect(part.entries[0].attributes).toEqual([
      { path: "artifact", before: "sha256:published", after: "sha256:rebuilt" },
      { path: "template:dist/api.json", before: sha("7"), after: sha("8") },
      { path: "param:flag", before: '"off"', after: '"on"' },
    ]);
    expect(isEmptyChangeSet(composeChangeSet([part]))).toBe(false);
  });

  test("a prod-only flag flip leaves staging's change set empty", () => {
    const flipped = release(sha("7"), { commit: "b", flag: "on" });
    const staging = chantComponentPart({
      component: api,
      release: flipped,
      env: "staging",
      digest: "sha256:published",
      current: { record: record({ env: "staging", releaseDigest: r1.releaseDigest }), release: r1 },
    });
    expect(staging.entries).toEqual([]);
    const prod = chantComponentPart({ component: api, release: flipped, env: "prod", digest: "sha256:published", current: { record: record({ releaseDigest: r1.releaseDigest }), release: r1 } });
    expect(prod.entries[0].attributes.map((a) => a.path)).toEqual(["param:flag"]);
  });

  test("a component never deployed to the environment is a create", () => {
    const part = chantComponentPart({ component: api, release: r1, env: "prod", digest: "sha256:published", current: undefined });
    expect(part.entries[0]).toMatchObject({ action: "create" });
  });

  test("a deploy that names no release, or one that can't be read, is a hole", () => {
    const none = chantComponentPart({ component: api, release: r1, env: "prod", digest: "sha256:published", current: { record: record(), release: null } });
    expect(none.member.holes[0].reason).toMatch(/names no release/);
    const unread = chantComponentPart({ component: api, release: r1, env: "prod", digest: "sha256:published", current: { record: record({ releaseDigest: sha("9") }), release: null } });
    expect(unread.member.holes[0].reason).toMatch(/can't be read/);
    expect(isEmptyChangeSet(composeChangeSet([none]))).toBe(false);
  });
});

describe("planReleaseChangeSet", () => {
  const r1 = release(sha("7"));
  const current = new Map([["api", { record: record({ releaseDigest: r1.releaseDigest }), release: r1 }]]);
  const plan = (rel: Release, env: string) =>
    planReleaseChangeSet({ release: rel, env, components: [api], digests: new Map([["api", "sha256:published"]]), registry: registry(), current });

  test("the document names the release and the environment it was planned for, and both are in its digest", async () => {
    const doc = await plan(r1, "prod");
    expect(doc.releaseDigest).toBe(r1.releaseDigest);
    expect(doc.environment).toBe("prod");
    expect(verifyChangeSetDigest(doc)).toBe(true);
    expect(verifyChangeSetDigest({ ...doc, environment: "staging" })).toBe(false);
    expect(verifyChangeSetDigest({ ...doc, releaseDigest: sha("9") })).toBe(false);
    const other = release(sha("7"), { commit: "c" });
    expect((await plan(other, "prod")).digest).not.toBe(doc.digest);
  });

  test("a document with neither field hashes as it always has", () => {
    const doc = composeChangeSet([]);
    expect(doc.releaseDigest).toBeUndefined();
    expect(verifyChangeSetDigest(doc)).toBe(true);
  });

  test("a capability that plans gives the member; one that returns no part is a hole", async () => {
    const reg = registry();
    reg.register({ kind: "tf", async run() { return {}; }, async plan() { return { member: "estate", planDigest: sha("3") }; } } as never);
    const tf: DriverComponent = { name: "infra", deploy: [{ phase: "Apply", steps: [{ kind: "gate", gate: "prod-release" }, { kind: "tf" }] }] };
    const doc = await planReleaseChangeSet({ release: r1, env: "prod", components: [tf], digests: new Map(), registry: reg, current: new Map() });
    expect(doc.members.map((m) => m.member)).toEqual(["estate"]);
    expect(doc.members[0].holes[0].reason).toMatch(/describes no changes/);
    expect(isEmptyChangeSet(doc)).toBe(false);
  });

  test("a plan that throws is a failed member", async () => {
    const reg = registry();
    reg.register({ kind: "tf", async run() { return {}; }, async plan() { throw new Error("no credentials"); } } as never);
    const tf: DriverComponent = { name: "infra", deploy: [{ phase: "Apply", steps: [{ kind: "tf" }] }] };
    const doc = await planReleaseChangeSet({ release: r1, env: "prod", components: [tf], digests: new Map(), registry: reg, current: new Map() });
    expect(doc.members[0]).toMatchObject({ member: "infra", status: "failed", error: "no credentials" });
  });
});

describe("empty change sets", () => {
  const r1 = release(sha("7"));
  const emptyDoc = (): ChangeSetDocument =>
    composeChangeSet(
      [chantComponentPart({ component: api, release: r1, env: "prod", digest: "sha256:published", current: { record: record({ releaseDigest: r1.releaseDigest }), release: r1 } })],
      { planned: { releaseDigest: r1.releaseDigest, environment: "prod" } },
    );

  test("isEmptyChangeSet needs planned members, no holes and only no-op or read entries", () => {
    const doc = emptyDoc();
    expect(isEmptyChangeSet(doc)).toBe(true);
    expect(isEmptyChangeSet({ ...doc, members: [] })).toBe(false);
    expect(isEmptyChangeSet({ ...doc, members: [{ ...doc.members[0], provisional: true }] })).toBe(false);
    expect(isEmptyChangeSet({ ...doc, members: [{ ...doc.members[0], status: "failed" }] })).toBe(false);
    const entry = { member: "api", lexicon: "chant", planner: "chant" as const, address: "x", type: "t", attributes: [] };
    expect(isEmptyChangeSet({ ...doc, entries: [{ ...entry, action: "no-op" }, { ...entry, action: "read" }] })).toBe(true);
    expect(isEmptyChangeSet({ ...doc, entries: [{ ...entry, action: "update" }] })).toBe(false);
  });

  test("provisionalMembers names each provisional member", () => {
    const doc = emptyDoc();
    expect(provisionalMembers(doc)).toEqual([]);
    expect(provisionalMembers({ ...doc, members: [{ ...doc.members[0], provisional: true }] })).toEqual(["api"]);
  });

  test("emptyVerifier reads the stored document back: found, for this release and environment, and empty", async () => {
    const doc = emptyDoc();
    const planned = { releaseDigest: r1.releaseDigest, environment: "prod" };
    expect(await emptyVerifier(async () => ({ status: "found", document: doc }), planned)(doc.digest)).toBe(true);
    expect(await emptyVerifier(async () => ({ status: "missing" }), planned)(doc.digest)).toBe(false);
    expect(await emptyVerifier(async () => ({ status: "found", document: doc }), { ...planned, environment: "staging" })(doc.digest)).toBe(false);
    const changed = { ...doc, entries: [{ member: "api", lexicon: "chant", planner: "chant" as const, address: "api", type: "t", action: "update" as const, attributes: [] }] };
    expect(await emptyVerifier(async () => ({ status: "found", document: changed }), planned)(doc.digest)).toBe(false);
  });

  test("emptyResolution is an `empty` pass by the actor, bound to the document, the release and the environment", () => {
    const doc = emptyDoc();
    expect(emptyResolution({ gate: "prod-release", doc, actor: "bob", timestamp: "2026-10-16T00:00:00.000Z" })).toEqual({
      op: RELEASE_GATE_OP,
      gate: "prod-release",
      resolvedBy: "bob",
      timestamp: "2026-10-16T00:00:00.000Z",
      note: `the change set of release ${r1.releaseDigest} for "prod" is empty`,
      planDigest: doc.digest,
      environment: "prod",
      releaseDigest: r1.releaseDigest,
      empty: true,
    });
    expect(() => emptyResolution({ gate: "g", doc: composeChangeSet([]), actor: "bob", timestamp: "t" })).toThrow(/names no release/);
  });
});
