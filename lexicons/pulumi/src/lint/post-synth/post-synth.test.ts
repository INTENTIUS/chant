import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { PULUMI_SECRET_SIG, PULUMI_SIG_KEY } from "../../values";
import { setLastMemberRead, setLastMemberReport } from "../../workspace-member";
import { postSynthChecks } from "./index";
import { pul001 } from "./pul001";
import { pul002 } from "./pul002";
import { pul003 } from "./pul003";
import { pul004 } from "./pul004";
import { pul005 } from "./pul005";
import { pul006 } from "./pul006";
import { pul007 } from "./pul007";
import { pul008 } from "./pul008";
import { pul009 } from "./pul009";
import { pul010 } from "./pul010";
import { pul011 } from "./pul011";
import { pul012 } from "./pul012";
import { pul013 } from "./pul013";
import { pul014 } from "./pul014";
import { pul015 } from "./pul015";

const ctx = { outputs: new Map(), entities: new Map() } as unknown as PostSynthContext;

afterEach(() => {
  vi.unstubAllEnvs();
  setLastMemberReport(undefined);
  setLastMemberRead(undefined);
});

const testdata = join(import.meta.dirname, "..", "..", "testdata");
/** testdata/pulumi-member: Pulumi.yaml names project `app`, no backend. */
const stockDir = join(testdata, "pulumi-member");
/** testdata/plunge-member: Pulumi.yaml names project `site` on `plunge+file://`. */
const plungeDir = join(testdata, "plunge-member");

const STACK = "urn:pulumi:dev::app::pulumi:pulumi:Stack::app-dev";
const PROVIDER = "urn:pulumi:dev::app::pulumi:providers:aws::default";
const BUCKET = "urn:pulumi:dev::app::aws:s3/bucketV2:BucketV2::assets";
const ROLE = "urn:pulumi:dev::app::aws:iam/role:Role::web";

const stackRes = { urn: STACK, type: "pulumi:pulumi:Stack" };
const providerRes = { urn: PROVIDER, type: "pulumi:providers:aws" };
const bucket = (extra: Record<string, unknown> = {}) => ({ urn: BUCKET, type: "aws:s3/bucketV2:BucketV2", parent: STACK, ...extra });
const role = (extra: Record<string, unknown> = {}) => ({ urn: ROLE, type: "aws:iam/role:Role", parent: STACK, ...extra });

/** Leave a member read whose export holds `resources`, as `buildRoots` would. */
function readWith(resources: unknown[], opts: { dir?: string; stack?: string; engine?: "pulumi" | "plunge"; version?: unknown } = {}) {
  const doc: Record<string, unknown> = { deployment: { resources } };
  if (!("version" in opts)) doc.version = 3;
  else if (opts.version !== undefined) doc.version = opts.version;
  setLastMemberRead({
    dir: opts.dir ?? stockDir,
    label: "infra",
    ...(opts.stack ? { stack: opts.stack } : {}),
    ...(opts.engine ? { engine: opts.engine } : {}),
    doc,
  });
}

const clean = () => readWith([stackRes, providerRes, bucket(), role({ dependencies: [BUCKET] })]);
const memberChecks = [pul003, pul004, pul005, pul006, pul007, pul008, pul009, pul010, pul011, pul012, pul013, pul014, pul015];

describe("pulumi post-synth checks", () => {
  test("the barrel lists both", () => {
    expect(postSynthChecks.map((c) => c.id)).toEqual(Array.from({ length: 15 }, (_, i) => `PUL${String(i + 1).padStart(3, "0")}`));
  });

  test("every check stays silent in a build that read no member", () => {
    setLastMemberReport(undefined);
    for (const check of postSynthChecks) expect(check.check(ctx), check.id).toEqual([]);
  });

  test("PUL001 reports a member read with no export, with the reason", () => {
    setLastMemberReport({ objects: 0, exported: false, reason: "no stack-export.json in the member" });
    const diags = pul001.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("PUL001");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("no stack-export.json in the member");
    expect(diags[0].missing).toEqual({ kind: "stack-export.json", scope: "pulumi member" });
  });

  test("PUL001 is silent for a member that was read", () => {
    setLastMemberReport({ export: "stack-export.json", objects: 3, exported: true });
    expect(pul001.check(ctx)).toEqual([]);
  });

  test("PUL002 reports pending operations and is silent without them", () => {
    setLastMemberReport({ export: "stack-export.json", objects: 3, exported: true, pendingOperations: 2 });
    const diags = pul002.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("PUL002");
    expect(diags[0].message).toContain("2 pending operation(s)");

    setLastMemberReport({ export: "stack-export.json", objects: 3, exported: true });
    expect(pul002.check(ctx)).toEqual([]);
  });

  test("PUL003 to PUL015 are silent on a clean export", () => {
    clean();
    for (const check of memberChecks) expect(check.check(ctx), check.id).toEqual([]);
  });

  test("PUL003 reports a plaintext secret and not a ciphertext one", () => {
    const envelope = (field: string) => ({ [PULUMI_SIG_KEY]: PULUMI_SECRET_SIG, [field]: "\"hunter2\"" });
    readWith([stackRes, bucket({ inputs: { tags: { token: envelope("ciphertext") } } })]);
    expect(pul003.check(ctx)).toEqual([]);
    readWith([stackRes, bucket({ outputs: { policy: [envelope("plaintext")] } })]);
    const diags = pul003.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ checkId: "PUL003", severity: "error", entity: "infra/aws:s3/bucketV2:BucketV2::assets" });
    expect(diags[0].message).toContain("outputs.policy[0]");
    expect(diags[0].message).not.toContain("hunter2");
  });

  test("PUL004, PUL005 and PUL006 report delete, pendingReplacement and taint", () => {
    readWith([stackRes, bucket({ delete: true }), bucket(), role({ pendingReplacement: true, taint: true })]);
    expect(pul004.check(ctx).map((d) => d.entity)).toEqual(["infra/aws:s3/bucketV2:BucketV2::assets"]);
    expect(pul005.check(ctx).map((d) => d.entity)).toEqual(["infra/aws:iam/role:Role::web"]);
    const taint = pul006.check(ctx);
    expect(taint.map((d) => d.entity)).toEqual(["infra/aws:iam/role:Role::web"]);
    expect(taint[0].severity).toBe("info");
    // The pending-delete entry is the old object of a replacement, not a duplicate.
    expect(pul011.check(ctx)).toEqual([]);
  });

  test("PUL007 reports a configured stack the export was not taken from", () => {
    readWith([stackRes, bucket()], { stack: "dev" });
    expect(pul007.check(ctx)).toEqual([]);
    readWith([stackRes, bucket()], { stack: "prod" });
    const diags = pul007.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('"prod"');
    expect(diags[0].message).toContain('"dev"');
  });

  test("PUL008 reports URNs from two stacks", () => {
    readWith([stackRes, bucket(), { urn: "urn:pulumi:prod::app::aws:iam/role:Role::web", type: "aws:iam/role:Role" }]);
    const diags = pul008.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("stacks dev, prod");
  });

  test("PUL009 reports an export from a project Pulumi.yaml does not name", () => {
    readWith([{ urn: "urn:pulumi:dev::shop::aws:iam/role:Role::web", type: "aws:iam/role:Role" }]);
    const diags = pul009.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('"shop"');
    expect(diags[0].message).toContain('"app"');
  });

  test("PUL010 reports a dependency the export does not hold", () => {
    readWith([stackRes, role({ dependencies: [BUCKET] })]);
    const diags = pul010.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("infra/aws:iam/role:Role::web");
    expect(diags[0].message).toContain(BUCKET);
  });

  test("PUL011 reports two live entries for one URN", () => {
    readWith([stackRes, bucket(), bucket()]);
    expect(pul011.check(ctx)).toHaveLength(1);
  });

  test("PUL012 reports external resources as information", () => {
    readWith([stackRes, providerRes, bucket({ external: true })]);
    const diags = pul012.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("info");
    expect(diags[0].message).toContain(BUCKET);
  });

  test("PUL013 reports an export version other than 3, or none", () => {
    readWith([stackRes, bucket()], { version: 2 });
    expect(pul013.check(ctx)[0].message).toContain("version 2");
    readWith([stackRes, bucket()], { version: undefined });
    expect(pul013.check(ctx)[0].message).toContain("no version");
  });

  test("PUL014 reports an export with only the stack and its providers", () => {
    readWith([stackRes, providerRes]);
    expect(pul014.check(ctx)).toHaveLength(1);
    readWith([]);
    expect(pul014.check(ctx)).toHaveLength(1);
  });

  test("PUL015 reports engine: pulumi on a plunge backend, and nothing else", () => {
    readWith([], { dir: plungeDir, engine: "pulumi" });
    const diags = pul015.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("plunge+file://");
    readWith([], { dir: plungeDir, engine: "plunge" });
    expect(pul015.check(ctx)).toEqual([]);
    readWith([], { dir: plungeDir });
    expect(pul015.check(ctx)).toEqual([]);
    readWith([], { dir: stockDir, engine: "plunge" });
    expect(pul015.check(ctx)).toEqual([]);
  });

  test("PUL015 names the source of the resolved plunge engine", () => {
    // Pulumi.yaml
    readWith([], { dir: plungeDir, engine: "pulumi" });
    expect(pul015.check(ctx)[0].message).toContain("Pulumi.yaml names the plunge backend");

    // PULUMI_BACKEND_URL, on a program whose Pulumi.yaml names no backend
    vi.stubEnv("PULUMI_BACKEND_URL", "plunge+s3://bucket/state");
    readWith([], { dir: stockDir, engine: "pulumi" });
    const fromEnv = pul015.check(ctx);
    expect(fromEnv).toHaveLength(1);
    expect(fromEnv[0].message).toContain("PULUMI_BACKEND_URL names the plunge backend plunge+s3://bucket/state");
    readWith([], { dir: stockDir, engine: "plunge" });
    expect(pul015.check(ctx)).toEqual([]);
    vi.stubEnv("PULUMI_BACKEND_URL", "s3://bucket/state");
    readWith([], { dir: stockDir, engine: "pulumi" });
    expect(pul015.check(ctx)).toEqual([]);
    vi.unstubAllEnvs();

    // plywood.yml, engine and backend
    const root = mkdtempSync(join(tmpdir(), "pul015-"));
    mkdirSync(join(root, ".git"));
    const member = join(root, "infra");
    mkdirSync(member);
    writeFileSync(join(member, "Pulumi.yaml"), "name: app\nruntime: nodejs\n");
    writeFileSync(join(root, "plywood.yml"), "engine: plunge\n");
    readWith([], { dir: member, engine: "pulumi" });
    const fromEngine = pul015.check(ctx);
    expect(fromEngine).toHaveLength(1);
    expect(fromEngine[0].message).toContain("plywood.yml says engine: plunge");
    writeFileSync(join(root, "plywood.yml"), "backend: plunge+file:///state\n");
    const fromBackend = pul015.check(ctx);
    expect(fromBackend).toHaveLength(1);
    expect(fromBackend[0].message).toContain("plywood.yml names the plunge backend plunge+file:///state");
    writeFileSync(join(root, "plywood.yml"), "engine: pulumi\n");
    expect(pul015.check(ctx)).toEqual([]);
  });

  test("PUL015 does not report the other direction: engine plunge on a stock backend", () => {
    vi.stubEnv("PULUMI_BACKEND_URL", "s3://bucket/state");
    readWith([], { dir: stockDir, engine: "plunge" });
    expect(pul015.check(ctx)).toEqual([]);
  });
});
