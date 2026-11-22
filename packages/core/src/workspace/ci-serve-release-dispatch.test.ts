/**
 * #5462 PR 2: release requests and the release lease. A `ci/release/<sha>`
 * request runs the release workflow's own gate and cut jobs on the host, in
 * bash, against a bare remote, with a stand-in for chant that answers
 * `ci last-green` from the `ci/green` tags and makes the tag `release cut`
 * would. Two hosts serving one remote publish a tag once. Nothing leaves the
 * machine and nothing is published.
 */

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, git, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { CI_RELEASE_TAG_PREFIX, hostDispatchJobs, readReleaseRequests, requestRelease, workflowJob, type HostJob, type HostReleaseRequest } from "./ci-serve-release";
import { ciServeReleases, formatCiServeEvent, newCiServeRuntime, RELEASED_REF_PREFIX, type CiServeEvent, type CiServeOptions, type CiServeState } from "./ci-serve";
import { NPM_TRUSTED_PUBLISHING_SETUP, renderReleaseWorkflow, type ReleaseWorkflowInput } from "./release-workflow";
import { parseArgs } from "../cli/parse-args";
import type { SecurityGroup } from "./security";

afterAll(cleanScratch);

/** A remote and a clone with a chant config: `a` is green, `b` on top of it is not. */
function estate(): { origin: string; root: string; a: string; b: string } {
  const origin = scratchDir("chant-dispatch-origin-");
  git(origin, "init", "-q", "--bare");
  const root = scratchDir("chant-dispatch-");
  git(root, "init", "-q");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@example.com");
  git(root, "remote", "add", "origin", origin);
  // JSON, so reading the config at each commit needs no TypeScript.
  writeFiles(root, { "chant.config.json": '{ "environments": ["dev"] }\n', "a.txt": "a\n" });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "a");
  const a = git(root, "rev-parse", "HEAD");
  git(root, "tag", `ci/green/${a}`);
  writeFiles(root, { "b.txt": "b\n" });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "b");
  const b = git(root, "rev-parse", "HEAD");
  git(root, "push", "-q", "origin", "main", "--tags");
  return { origin, root, a, b };
}

/** A clone of `origin` for a second host. */
function another(origin: string): string {
  const dir = scratchDir("chant-dispatch-host-");
  git(dir, "clone", "-q", origin, ".");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@example.com");
  return dir;
}

/**
 * The stand-in for chant the rendered jobs call: `ci last-green --from <rev>`
 * names the newest commit at or below it with a `ci/green` tag, `release
 * next` answers v9.9.9, `release cut <label> --at <commit>` tags
 * `release/<label>` there, and the doctor passes. Every call is logged.
 */
function fakeChant(): { path: string; calls: () => string[] } {
  const dir = scratchDir("chant-dispatch-fake-");
  const path = join(dir, "chant");
  const log = join(dir, "calls.log");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env bash",
      "set -e",
      `echo "$*" >> ${JSON.stringify(log)}`,
      'case "$1 $2" in',
      '  "ci last-green")',
      '    for c in $(git rev-list "$4"); do if [ -n "$(git tag -l "ci/green/$c")" ]; then printf \'{"commit":{"sha":"%s"}}\' "$c"; exit 0; fi; done',
      "    printf '{\"commit\":null}'; exit 0 ;;",
      "  \"release next\") printf '{\"label\":\"v9.9.9\"}'; exit 0 ;;",
      '  "release doctor") exit 0 ;;',
      '  "release cut")',
      '    git tag "release/$3" "$5"',
      "    printf '{\"tag\":{\"name\":\"release/%s\"}}' \"$3\"; exit 0 ;;",
      "esac",
      'echo "the fake chant does not take: $*" >&2; exit 2',
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return { path, calls: () => readFileSync(log, "utf-8").trim().split("\n") };
}

const options = (root: string, chant: string, published: HostReleaseRequest[], log: CiServeEvent[], extra: Partial<CiServeOptions> = {}, release: Partial<NonNullable<CiServeOptions["release"]>> = {}): CiServeOptions => ({
  cwd: root,
  forge: "git",
  repo: "origin",
  env: "prod",
  client: { openPullRequests: async () => [], branchHead: async () => undefined },
  stateDir: join(root, ".git", "chant", "ci-serve"),
  log: (e) => log.push(e),
  ...extra,
  release: {
    isReleaseTag: (t) => t.startsWith("release/"),
    fingerprint: "SHA256:host-key",
    chant,
    hostEnv: { PATH: process.env.PATH },
    leaseCwd: root,
    run: async (req) => (published.push(req), { status: "ok" }),
    ...release,
  },
});

const stateOf = (root: string): CiServeState => JSON.parse(readFileSync(join(root, ".git", "chant", "ci-serve", "chant-apply-prod.json"), "utf-8")) as CiServeState;
const remoteRefs = (origin: string): string[] => git(origin, "for-each-ref", "--format=%(refname)").split("\n").filter(Boolean);

describe("release requests (#5462)", () => {
  test("ci run --at <sha> --release pushes ci/release/<sha> with its label, once", () => {
    const { origin, root, a } = estate();
    const r = requestRelease({ cwd: root, at: a, label: "v1.2.0", now: new Date("2026-11-21T12:00:00Z") });
    expect(r).toMatchObject({ existed: false, request: { tag: `${CI_RELEASE_TAG_PREFIX}${a}`, commit: a, label: "v1.2.0", levels: "auto", at: "2026-11-21T12:00:00.000Z" } });
    expect(remoteRefs(origin)).toContain(`refs/tags/ci/release/${a}`);
    expect(readReleaseRequests(another(origin)).get(a)).toMatchObject({ label: "v1.2.0" });
    expect(requestRelease({ cwd: root, at: "HEAD~1", label: "v2" }).existed).toBe(true);
    expect(() => requestRelease({ cwd: root, at: "nope" })).toThrow("--at nope names no commit in this repository");
    expect(() => requestRelease({ cwd: root, at: a, label: "-x" })).toThrow(/is not a release label/);
    expect(parseArgs(["ci", "run", "--at", a, "--release", "--label", "v1"])).toMatchObject({ at: a, ciRelease: true, label: "v1" });
  });

  test("the host's gate and cut are the dispatched workflow's gate and cut, under gate: head", () => {
    const input: ReleaseWorkflowInput = { forge: "github", groups: new Set<SecurityGroup>(["supply-chain"]), signing: true, signingEnv: ["RELEASE_KEY", "COSIGN_PASSWORD"], scan: true, images: true, imageArchives: ["build/api.tar"], imagePlatforms: ["linux/amd64"], publish: [{ type: "oci", repository: "r.example/acme/api" }], pipeline: { trigger: "dispatch", gate: "head" } };
    const runs = (j: HostJob) => j.steps.filter((s) => s.run !== undefined).map((s) => s.run!).filter((l) => !/CHANT_(COSIGN|GRYPE|SYFT)=/.test(l) && l !== NPM_TRUSTED_PUBLISHING_SETUP);
    const text = renderReleaseWorkflow(input);
    const host = hostDispatchJobs({ input: { ...input, pipeline: { trigger: "tag" } } }, { CHANT_COSIGN: "/c" });
    expect(runs(host.gate)).toEqual(runs(workflowJob(text, "gate")));
    expect(runs(host.cut)).toEqual(runs(workflowJob(text, "cut")));
    expect(runs(host.gate).join("\n")).toContain('is not green (the newest green commit below it is $commit), so no release is cut');
    expect(runs(host.cut).some((l) => l.startsWith("npx chant release doctor --from cut"))).toBe(true);
    expect(runs(host.cut).join("\n")).toContain('git push origin "refs/tags/$tag"');
    expect(host.gate.outputs).toEqual({ commit: "${{ steps.green.outputs.commit }}", label: "${{ steps.green.outputs.label }}" });
  });

  /** A serve of `root` with the fake chant, its passes awaited. */
  const serving = (root: string) => {
    const chant = fakeChant();
    const published: HostReleaseRequest[] = [];
    const log: CiServeEvent[] = [];
    const rt = newCiServeRuntime();
    const pass = async () => Promise.all((await ciServeReleases(options(root, chant.path, published, log), rt)).started);
    return { chant, published, log, pass };
  };

  test("a request on a green commit runs the gate and the cut, and the tag the cut pushed is published", async () => {
    const { origin, root, a } = estate();
    const s = serving(root);
    await s.pass();
    requestRelease({ cwd: root, at: a, label: "v1.0.0" });
    await s.pass();
    // The green commit is cut, and the release's tag is on the remote; its request is gone.
    expect(git(origin, "rev-parse", "refs/tags/release/v1.0.0^{commit}")).toBe(a);
    expect(remoteRefs(origin)).not.toContain(`refs/tags/ci/release/${a}`);
    expect(stateOf(root).dispatches?.[`dispatch:${a}`]).toMatchObject({ status: "ok", label: "v1.0.0" });
    expect(s.chant.calls()).toEqual([`ci last-green --from ${a} --json`, "release doctor --from cut", `release cut v1.0.0 --at ${a} --yes --json`]);
    // The cut's tag is published as any tag, and marked published on the remote; the lease was released.
    await s.pass();
    expect(s.published.map((p) => [p.tag, p.commit])).toEqual([["release/v1.0.0", a]]);
    expect(git(origin, "rev-parse", `${RELEASED_REF_PREFIX}release/v1.0.0`)).toBe(a);
    expect(remoteRefs(origin).filter((r) => r.startsWith("refs/chant/lease/"))).toEqual([]);
  });

  test("a request on a commit that is not green is refused with the gate's reason, and nothing is cut", async () => {
    const { origin, root, a, b } = estate();
    const s = serving(root);
    await s.pass();
    requestRelease({ cwd: root, at: b, label: "v1.1.0" });
    await s.pass();
    expect(stateOf(root).dispatches?.[`dispatch:${b}`]).toMatchObject({ status: "refused", reason: `${b} is not green (the newest green commit below it is ${a}), so no release is cut` });
    expect(s.log.map(formatCiServeEvent)).toContain(`the release request for ${b.slice(0, 12)} (label v1.1.0) was refused: ${b} is not green (the newest green commit below it is ${a}), so no release is cut`);
    expect(remoteRefs(origin)).not.toContain(`refs/tags/ci/release/${b}`);
    expect(remoteRefs(origin).filter((r) => r.startsWith("refs/tags/release/"))).toEqual([]);
    expect(s.chant.calls().some((c) => c.startsWith("release cut"))).toBe(false);
  });

  test("two hosts serving one remote publish a release once: the second waits on the lease, then leaves what the first marked", async () => {
    const { origin, root } = estate();
    const chant = fakeChant();
    const hostB = another(origin);
    const publishedA: HostReleaseRequest[] = [];
    const publishedB: HostReleaseRequest[] = [];
    const logA: CiServeEvent[] = [];
    const logB: CiServeEvent[] = [];
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((done) => (finish = done));
    const a = (extra: Partial<NonNullable<CiServeOptions["release"]>> = {}) => options(root, chant.path, publishedA, logA, { holder: "host-a" }, { run: async (req) => (publishedA.push(req), await gate, { status: "ok" }), ...extra });
    const bOpts = options(hostB, chant.path, publishedB, logB, { holder: "host-b" });
    const rtA = newCiServeRuntime();
    const rtB = newCiServeRuntime();
    await ciServeReleases(a(), rtA);
    await ciServeReleases(bOpts, rtB);
    git(root, "tag", "release/v3");
    git(root, "push", "-q", "origin", "refs/tags/release/v3");
    // Host A takes the lease and publishes; host B finds the lease held and waits.
    const running = await ciServeReleases(a(), rtA);
    expect(running.started).toHaveLength(1);
    const held = await ciServeReleases(bOpts, rtB);
    expect(held.started).toEqual([]);
    expect(logB.map(formatCiServeEvent).at(-1)).toMatch(/^the release release\/v3 at [0-9a-f]{12} waits: the release lease is held by host-a$/);
    finish();
    await Promise.all(running.started);
    // Host B takes the lease, sees host A's mark, and publishes nothing.
    await Promise.all((await ciServeReleases(bOpts, rtB)).started);
    expect(publishedA.map((p) => p.tag)).toEqual(["release/v3"]);
    expect(publishedB).toEqual([]);
    expect(stateOf(hostB).releases?.["release:release/v3"]).toMatchObject({ status: "elsewhere" });
    expect(logB.map(formatCiServeEvent).at(-1)).toMatch(/release\/v3 at [0-9a-f]{12} was published by another host$/);
  });
});
