/**
 * #5163: `chant release deprecate|yank|restore` writes the status record and
 * acts on each target from the publish record: npm (a fake `npm` with a
 * registry in a file), OCI (a registry fake on 127.0.0.1), a GitHub release
 * (a forge fake) and a Homebrew tap (a GitHub repository fake). Two releases
 * are cut, v1 then v2, and both recorded as revealed on every target.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { cutRelease } from "./release-cut";
import { createRedactor } from "./publish-credentials";
import { PublishDeclarationSchema, type PublishDeclaration } from "./publish-declaration";
import { appendPublishRecord } from "./publish-record";
import { publishTargetKey } from "./publish-targets";
import { floatingTagStep, headOn, lineOf, prepareStatusChange, runStatusChange, parseStatusActions, STATUS_ACTIONS_FILE, type Known, type StatusPlan } from "./release-status-change";
import { ociMovingTags } from "./publish-oci";
import { readReleaseStatus } from "./release-status";
import { readBlobFromPath } from "./git";
import { forgeTarget } from "./publish-forge";
import type { PublishFetch, PublishItem, StatusContext } from "./release-publish";
import type { Release, ReleaseArtifact } from "./release-store";
import { readFakeNpmRegistry, seedFakeNpmRegistry, startFakeForge, startFakeGitHubRepo, startFakeRegistry, writeFakeNpm } from "./__fixtures__/publish-fakes";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";
import { TestRepo } from "../workspace/trust/test-repo";
import { releaseSealPayload, releaseStatusSealPayload } from "../workspace/identity-gate-rule";

const repos: TestRepo[] = [];
afterAll(() => {
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});

const compiler: TargetCompiler = {
  async compile(env): Promise<CompiledTarget> {
    return { env, params: [], components: ["api"], buildSteps: {}, buildInputs: {}, componentFiles: { api: "api.component.ts" }, templates: [{ component: "api", path: "dist/api.json", content: `{"env":"${env}"}\n` }] };
  },
  async buildArtifacts(): Promise<ReleaseArtifact[]> {
    return [];
  },
};

const API = "https://api.github.test";
const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const NO_OIDC = { oidc: false, ci: null, reason: "none" };

async function setup() {
  const r = new TestRepo("release-status-change");
  repos.push(r);
  const reg = await startFakeRegistry({ username: "robot", password: "pw-status-1", token: "tok-status-1" });
  const log = join(dirname(r.dir), "npm.log");
  const npm = writeFakeNpm(join(dirname(r.dir), "bin"), log);
  const decls: PublishDeclaration[] = [
    { type: "npm", packages: ["packages/core"] },
    { type: "oci", image: "image", repository: `${reg.host}/acme/api`, tags: ["{label}", "latest"] },
    { type: "forge", forge: "github", repo: "acme/api", api: API, assets: ["dist/api.tar.gz"] },
    { type: "homebrew", tap: "acme/homebrew-tap", formula: "Formula/api.rb", template: "api.rb", assets: ["dist/api.tar.gz"], url: "https://x/{name}", api: API },
  ].map((d) => PublishDeclarationSchema.parse(d));
  r.write("chant.config.ts", `export default { environments: ["dev"], release: { publish: ${JSON.stringify(decls)} } };\n`);
  r.write("api.component.ts", "export const api = {};\n");
  const cut = async (label: string, at: string) => {
    r.write("version.txt", label);
    const head = r.commit(label);
    r.git(["tag", `ci/green/${head}`]);
    return (await cutRelease({ cwd: r.dir, compiler, label, actor: "alice", env: {}, now: () => new Date(at) })).release;
  };
  const v1 = await cut("v1", "2026-10-01T10:00:00.000Z");
  const v2 = await cut("v2", "2026-10-02T10:00:00.000Z");

  // The registries as the two publishes left them: v2 is latest everywhere.
  seedFakeNpmRegistry(log, { packages: { "@acme/core": { versions: ["1.0.0", "2.0.0"], distTags: { latest: "2.0.0" } } } });
  const m1 = Buffer.from('{"schemaVersion":2,"v":1}');
  const m2 = Buffer.from('{"schemaVersion":2,"v":2}');
  const type = "application/vnd.oci.image.manifest.v1+json";
  reg.manifests.set(sha(m1.toString()), { name: "acme/api", type, bytes: m1 });
  reg.manifests.set(sha(m2.toString()), { name: "acme/api", type, bytes: m2 });
  reg.manifests.set("latest", { name: "acme/api", type, bytes: m2 });
  const forge = startFakeForge("github", API, "acme/api", [
    { id: 1, tag_name: "release/v1", draft: false, target: v1.commit, assets: [] },
    { id: 2, tag_name: "release/v2", draft: false, target: v2.commit, assets: [] },
  ]);
  const tap = startFakeGitHubRepo(API, "acme/homebrew-tap", "main", { "Formula/api.rb": "formula v1" });
  tap.push("main", { "Formula/api.rb": "formula v2" });
  const fetch: PublishFetch = async (url, init) => {
    if (url.startsWith("http://127.0.0.1")) return globalThis.fetch(url, init as RequestInit) as never;
    return (url.includes("/repos/acme/homebrew-tap") ? tap.fetch(url, init) : forge.fetch(url, init)) as never;
  };

  const items: Record<string, (label: string, release: Release) => PublishItem[]> = {
    npm: (l) => [{ name: `@acme/core@${l.slice(1)}.0.0`, destination: "npm" }],
    oci: (l) => [{ name: "image", destination: `${reg.host}/acme/api`, digest: sha((l === "v1" ? m1 : m2).toString()) }],
    forge: () => [{ name: "dist/api.tar.gz", destination: "forge", digest: sha("asset") }],
    homebrew: (l) => [{ name: "Formula/api.rb", destination: "tap", digest: sha(`formula ${l}`) }],
  };
  for (const [label, release] of [["v1", v1], ["v2", v2]] as const) {
    for (const d of decls) {
      await appendPublishRecord(
        { version: 1, releaseDigest: release.releaseDigest, label, target: publishTargetKey(d), kind: d.type, name: d.type, step: "revealed", items: items[d.type]!(label, release), state: {}, runId: "r1", timestamp: "2026-10-03T00:00:00.000Z" },
        createRedactor(),
        { cwd: r.dir },
      );
    }
  }
  const env = { PATH: process.env.PATH, OCI_USERNAME: "robot", OCI_PASSWORD: "pw-status-1", GITHUB_TOKEN: "ghs_status", HOMEBREW_TAP_TOKEN: "ghs_tap" };
  const plan = (verb: "deprecate" | "yank" | "restore", extra: { reason?: string; replacement?: string } = {}) =>
    prepareStatusChange({ cwd: r.dir, ref: "v2", verb, actor: "alice", env, deps: { npm, fetch }, ...extra });
  return { r, reg, log, forge, tap, v1, v2, plan, close: () => reg.close() };
}

const ok = (p: StatusPlan | { refusal: unknown }): StatusPlan => {
  if ("refusal" in p) throw new Error(`refused: ${JSON.stringify(p.refusal)}`);
  return p;
};

describe("release status changes", () => {
  // One repository with v1 and v2 cut and published; the tests run in order on it.
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    s = await setup();
  }, 60_000);
  afterAll(async () => {
    await s?.close();
  });

  test("a restore of a release never changed is refused; a deprecation only marks npm", async () => {
    expect(await s.plan("restore")).toMatchObject({ refusal: { code: "release-status-unchanged" } });
    const plan = ok(await s.plan("deprecate", { reason: "old" }));
    await runStatusChange(plan, { cwd: s.r.dir });
    const pkg = readFakeNpmRegistry(s.log).packages["@acme/core"]!;
    expect(pkg.deprecated?.["2.0.0"]).toBe("deprecated: old");
    expect(pkg.distTags.latest).toBe("2.0.0");
    expect(s.reg.manifests.get("latest")!.bytes.toString()).toContain('"v":2');
    expect(s.forge.releases.find((x) => x.id === 2)!.prerelease).toBeFalsy();
    expect(s.tap.read("main", "Formula/api.rb")).toBe("formula v2");
  });

  test("a yank moves every tag back to v1 and withdraws v2, and run again does nothing", async () => {
    const dry = ok(await s.plan("yank", { reason: "broken", replacement: "v1" }));
    expect(dry.current.status).toBe("deprecated");
    expect(dry.targets.map((t) => t.head?.label)).toEqual(["v1", "v1", "v1", "v1"]);
    expect(dry.targets.flatMap((t) => t.actions.map((a) => a.what))).toEqual(
      expect.arrayContaining([`npm deprecate @acme/core@2.0.0 "yanked: broken; use v1"`, "npm dist-tag add @acme/core@1.0.0 latest, if latest is 2.0.0", "mark github acme/api release release/v2 a prerelease", "make github acme/api release release/v1 the latest"]),
    );
    // The plan changed nothing.
    expect(readFakeNpmRegistry(s.log).packages["@acme/core"]!.distTags.latest).toBe("2.0.0");

    const run = await runStatusChange(dry, { cwd: s.r.dir });
    expect(run.written).toBe(true);
    // Last declared first: the formula stops naming the assets before the forge release is withdrawn.
    expect(run.results.map((x) => x.name.split(" ")[0])).toEqual(["homebrew", "github", "oci", "npm"]);
    const pkg = readFakeNpmRegistry(s.log).packages["@acme/core"]!;
    expect(pkg.distTags.latest).toBe("1.0.0");
    expect(pkg.deprecated?.["2.0.0"]).toBe("yanked: broken; use v1");
    expect(s.reg.manifests.get("latest")!.bytes.toString()).toContain('"v":1');
    expect(s.forge.releases.find((x) => x.id === 2)!.prerelease).toBe(true);
    expect(s.forge.releases.find((x) => x.id === 1)!.make_latest).toBe("true");
    expect(s.tap.read("main", "Formula/api.rb")).toBe("formula v1");
    const status = await readReleaseStatus("_releases", { cwd: s.r.dir });
    expect(status.records.map((x) => x.status)).toEqual(["deprecated", "yanked"]);
    expect(status.records[1]).toMatchObject({ component: ".", env: "_releases", digest: s.v2.releaseDigest, releaseVersion: "v2", status: "yanked", reason: "broken", replacement: "v1", actor: "alice" });
    expect(parseStatusActions(await readBlobFromPath("_releases", STATUS_ACTIONS_FILE, { cwd: s.r.dir })).filter((a) => a.status === "yanked")).toHaveLength(4);

    // Run again: the change is resumed, and every target is done.
    const again = ok(await s.plan("yank"));
    expect(again.resumes?.timestamp).toBe(status.records[1]!.timestamp);
    expect(again.targets.every((t) => t.done)).toBe(true);
    const second = await runStatusChange(again, { cwd: s.r.dir });
    expect(second.written).toBe(false);
    expect(second.results.every((x) => x.resumed)).toBe(true);
    // A deprecation of a yanked release is refused.
    expect(await s.plan("deprecate")).toMatchObject({ refusal: { code: "release-status-yanked" } });
  });

  test("a restore puts every tag back on v2", async () => {
    const restore = ok(await s.plan("restore"));
    expect(restore.targets.map((t) => t.head?.label)).toEqual(["v2", "v2", "v2", "v2"]);
    await runStatusChange(restore, { cwd: s.r.dir });
    const back = readFakeNpmRegistry(s.log).packages["@acme/core"]!;
    expect(back.distTags.latest).toBe("2.0.0");
    expect(back.deprecated?.["2.0.0"]).toBeUndefined();
    expect(s.reg.manifests.get("latest")!.bytes.toString()).toContain('"v":2');
    expect(s.forge.releases.find((x) => x.id === 2)!.prerelease).toBe(false);
    expect(s.tap.read("main", "Formula/api.rb")).toBe("formula v2");
  });

  test("a yank with no earlier active release refuses to move the tags", async () => {
    // v1 yanked leaves v2 the head; then v2 has no active release before it.
    const first = ok(await prepareStatusChange({ cwd: s.r.dir, ref: "v1", verb: "yank", actor: "alice", env: { PATH: process.env.PATH }, deps: {} }));
    expect(first.targets.map((t) => t.head?.label)).toEqual(["v2", "v2", "v2", "v2"]);
    expect((await runStatusChange({ ...first, targets: [] }, { cwd: s.r.dir })).written).toBe(true);
    const plan = ok(await s.plan("yank"));
    const refused = plan.targets.flatMap((t) => t.actions.filter((a) => a.refused).map((a) => a.refused!.code));
    expect(refused).toEqual(["release-status-no-previous", "release-status-no-previous", "release-status-no-previous"]);
  });
});

describe("forge status change", () => {
  test("GitLab has no prerelease or draft, so only a delete is offered", async () => {
    const decl = PublishDeclarationSchema.parse({ type: "forge", forge: "gitlab", repo: "acme/api", api: "https://gitlab.test/api/v4", assets: ["dist/api.tar.gz"] });
    const t = forgeTarget(decl as never, {});
    const ctx = {
      cwd: ".",
      env: {},
      redactor: createRedactor(),
      log: () => undefined,
      provenance: NO_OIDC,
      tag: null,
      release: { releaseDigest: "d" } as Release,
      label: "v2",
      releaseTag: "release/v2",
      status: "yanked",
      reason: null,
      replacement: null,
      revealed: [],
      head: null,
      forgeYank: "prerelease",
      apply: false,
    } satisfies StatusContext;
    expect((await t.setStatus!(ctx))[0]!.refused?.code).toBe("release-status-forge-unsupported");
    expect((await t.setStatus!({ ...ctx, forgeYank: "delete" }))[0]!.what).toBe("delete gitlab acme/api release release/v2 (its tag stays)");
  });
});

test("a status change signs bytes no cut signs", () => {
  const cut = { releaseDigest: "d", label: "v1", actor: "alice", timestamp: "t" };
  expect(releaseStatusSealPayload({ ...cut, status: "yanked" }).toString()).toBe(`${releaseSealPayload(cut).toString()}\nstatus:yanked`);
});

describe("prereleases, tag templates and the floating tag", () => {
  const rel = (n: number): Release => ({ releaseDigest: `d${n}`, commit: `${n}`.repeat(40) }) as Release;
  const known = (n: number, label: string, channel: string | null = null): Known => ({ release: rel(n), label, firstCut: `2026-11-0${n}T00:00:00Z`, channel, line: lineOf(channel, label) });
  const ctxOf = (status: StatusContext["status"], label: string, apply = false): StatusContext => ({
    cwd: ".",
    env: {},
    redactor: createRedactor(),
    log: () => undefined,
    provenance: NO_OIDC,
    tag: null,
    release: rel(0),
    label,
    releaseTag: label,
    status,
    reason: null,
    replacement: null,
    revealed: [],
    head: null,
    forgeYank: "prerelease",
    apply,
  });

  test("a prerelease's line is its dist-tag, so a head is chosen among its own kind", () => {
    expect([lineOf(null, "1.4.0"), lineOf(null, "1.4.0-rc.2"), lineOf("canary", "1.4.0-rc.2")]).toEqual([null, "rc", "canary"]);
    const all = [known(1, "1.3.0"), known(2, "1.4.0-rc.1"), known(3, "1.4.0-rc.2"), known(4, "1.3.1")];
    const yanking = (digest: string) => (d: string): "yanked" | "active" => (d === digest ? "yanked" : "active");
    const items: PublishItem[] = [{ name: "x", destination: "y" }];
    const head = (line: string | null, digest: string) => headOn("k", all, line, yanking(digest), () => false, () => items, (l) => l)?.label;
    expect(head("rc", "d3")).toBe("1.4.0-rc.1");
    expect(head(null, "d4")).toBe("1.3.0");
  });

  test("a prerelease moves no OCI latest back", () => {
    const decl = PublishDeclarationSchema.parse({ type: "oci", image: "image", repository: "r.test/acme/api", tags: ["{label}", "latest", "edge"] });
    expect(ociMovingTags(decl as never, null, "1.4.0")).toEqual(["latest", "edge"]);
    expect(ociMovingTags(decl as never, null, "1.4.0-rc.1")).toEqual(["edge"]);
  });

  test("a yank moves the floating tag back to the highest active release of its major, and a restore moves it forward", async () => {
    const tags = { place: { member: null, path: null }, template: { name: "v{version}", floating: "v{major}", legacy: false } };
    const all = [known(1, "1.2.0"), known(2, "1.3.0"), known(3, "2.0.0"), known(4, "1.3.1"), known(5, "1.4.0-rc.1")];
    const moved: string[] = [];
    const step = (release: Release, label: string, yanked: string | null, at: string | null) =>
      floatingTagStep({
        cwd: ".",
        tags,
        known: all,
        release,
        label,
        channel: null,
        statusOfDigest: (d) => (d === yanked ? "yanked" : "active"),
        revoked: () => false,
        published: () => true,
        tagCommit: () => at,
        move: (n, c) => (moved.push(`${n}=${c.slice(0, 1)}`), null),
      });
    // 1.3.1 is yanked: v1 goes back to 1.3.0, not to 2.0.0 or the 1.4.0 prerelease.
    const yank = step(rel(4), "1.3.1", "d4", "4".repeat(40))!;
    expect(yank.name).toBe("v1");
    expect((await yank.setStatus({ ...ctxOf("yanked", "1.3.1"), release: rel(4) }))[0]!.what).toBe("move v1 back to 1.3.0 (222222222222), if it names 1.3.1");
    await yank.setStatus({ ...ctxOf("yanked", "1.3.1", true), release: rel(4) });
    expect(moved).toEqual(["v1=2"]);
    // A tag already elsewhere is left.
    expect((await step(rel(4), "1.3.1", "d4", "9".repeat(40))!.setStatus({ ...ctxOf("yanked", "1.3.1", true), release: rel(4) }))[0]!.already).toBe(true);
    // Restored, 1.3.1 is the highest of major 1 again, and v1 moves to it.
    await step(rel(4), "1.3.1", null, "2".repeat(40))!.setStatus({ ...ctxOf("active", "1.3.1", true), release: rel(4) });
    expect(moved).toEqual(["v1=2", "v1=4"]);
    // Restoring an older release leaves it.
    expect((await step(rel(1), "1.2.0", null, "4".repeat(40))!.setStatus({ ...ctxOf("active", "1.2.0", true), release: rel(1) }))[0]!.already).toBe(true);
    // The only release of major 2 has nowhere to go back to; a prerelease or a channel's release moves nothing.
    expect((await step(rel(3), "2.0.0", "d3", "3".repeat(40))!.setStatus({ ...ctxOf("yanked", "2.0.0"), release: rel(3) }))[0]!.refused?.code).toBe("release-status-no-previous");
    expect(step(rel(5), "1.4.0-rc.1", "d5", null)).toBeNull();
  });

  test("a prerelease's forge release can't be yanked by marking it a prerelease", async () => {
    const decl = PublishDeclarationSchema.parse({ type: "forge", forge: "github", repo: "acme/api", api: API, assets: ["dist/api.tar.gz"] });
    const t = forgeTarget(decl as never, {});
    expect((await t.setStatus!(ctxOf("yanked", "1.4.0-rc.1")))[0]!.refused?.code).toBe("release-status-forge-prerelease");
    expect((await t.setStatus!({ ...ctxOf("yanked", "1.4.0-rc.1"), forgeYank: "draft" }))[0]!.what).toBe("make github acme/api release 1.4.0-rc.1 a draft again");
  });
});
