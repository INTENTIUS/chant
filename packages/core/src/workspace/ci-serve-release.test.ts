/**
 * #5462: `ci serve --release` serves release tags on its host with the steps
 * the rendered release workflow runs. The step lists are compared with the
 * rendered GitHub job; the tools install from their pins into a cache; a
 * step runs as a forge runner runs it; and a serve publishes each new tag
 * once. Everything runs against temp repositories, a fake download and fake
 * step runners; nothing is published and nothing reaches the network.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, git, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import {
  HOST_TOOL_VARIABLES,
  evalCondition,
  hostPlatform,
  hostReleaseJob,
  hostReleaseTools,
  hostSigningRefusal,
  hostStepAction,
  installHostTool,
  readCommandFile,
  releaseTagMatcher,
  resolveEnv,
  runHostJob,
  workflowJob,
  type HostJob,
  type HostReleaseRequest,
  type HostStepRunner,
} from "./ci-serve-release";
import { ciServePass, ciServeReleases, formatCiServeEvent, newCiServeRuntime, type CiServeEvent, type CiServeOptions } from "./ci-serve";
import { NPM_TRUSTED_PUBLISHING_SETUP, renderReleaseWorkflow, type ReleaseWorkflowInput, type ReleaseWorkflowRead } from "./release-workflow";
import { parseCiSecrets } from "./ci-secrets";
import { RUNNER_FINGERPRINT_ENV } from "../lifecycle/publish-signing";
import type { SecurityGroup } from "./security";
import type { ToolPin } from "../tool-pins";
import { parseArgs } from "../cli/parse-args";

afterAll(cleanScratch);

const SC = new Set<SecurityGroup>(["supply-chain"]);
const TOOLS = { CHANT_COSIGN: "/cache/cosign", CHANT_GRYPE: "/cache/grype/grype", CHANT_SYFT: "/cache/syft/syft" };

/** A single release with every feature the publish job runs: images, signing with a key, the scan, a pull login, npm and oci targets, the stamp. */
const SINGLE: ReleaseWorkflowInput = {
  forge: "github",
  groups: SC,
  images: true,
  imageArchives: ["build/api.tar"],
  imagePlatforms: ["linux/amd64"],
  signing: true,
  signingEnv: ["RELEASE_KEY", "COSIGN_PASSWORD"],
  scan: true,
  version: true,
  pullRegistries: [{ registry: "cgr.dev", usernameEnv: "CGR_USER", passwordEnv: "CGR_TOKEN" }],
  publish: [{ type: "oci", repository: "registry.example.com/acme/api" }, { type: "npm" }],
};

const runLines = (job: HostJob): string[] => job.steps.filter((s) => s.run !== undefined).map((s) => s.run!);
const isInstall = (run: string): boolean => /CHANT_(COSIGN|GRYPE|SYFT)=/.test(run);

describe("the host runs the steps the rendered workflow holds (#5462)", () => {
  test("a single release: the GitHub publish job's steps, in order, less the tool installs and GitHub's npm upgrade", () => {
    const github = workflowJob(renderReleaseWorkflow(SINGLE), "publish");
    const host = hostReleaseJob({ input: SINGLE }, TOOLS);
    const githubRuns = runLines(github);
    // The installs the GitHub job does are the host's, from the same pins, into its cache.
    expect(githubRuns.filter(isInstall)).toHaveLength(3);
    expect(githubRuns).toContain(NPM_TRUSTED_PUBLISHING_SETUP);
    expect(runLines(host)).toEqual(githubRuns.filter((l) => !isInstall(l) && l !== NPM_TRUSTED_PUBLISHING_SETUP));
    expect(runLines(host)).toEqual([
      "npm ci",
      'printf \'%s\' "$CGR_TOKEN" | docker login cgr.dev --username "$CGR_USER" --password-stdin',
      'npx chant release stamp "${GITHUB_REF_NAME#release/}"',
      "git fetch origin 'refs/tags/ci/*:refs/tags/ci/*'",
      "git fetch origin chant/lifecycle:chant/lifecycle",
      'npx chant release images "${GITHUB_REF_NAME#release/}" -o "$RUNNER_TEMP/chant-release-digests.json"',
      'echo "CHANT_RELEASE_DIGESTS=$RUNNER_TEMP/chant-release-digests.json" >> "$GITHUB_ENV"',
      "npm run build",
      'npx chant release publish "${GITHUB_REF_NAME#release/}" --require-provenance --yes',
    ]);
    // The tools reach every step through the job, and the key's variables the publish step alone, as on GitHub.
    expect(host.env).toMatchObject(TOOLS);
    const publish = host.steps.at(-1)!;
    expect(publish.env).toEqual({ RELEASE_KEY: "${{ secrets.RELEASE_KEY }}", COSIGN_PASSWORD: "${{ secrets.COSIGN_PASSWORD }}" });
    expect(github.steps.at(-1)!.env).toEqual(publish.env);
    expect(host.env).toMatchObject({ CGR_USER: "${{ secrets.CGR_USER }}", CGR_TOKEN: "${{ secrets.CGR_TOKEN }}" });
    // Only the checkout and the toolchain are actions, and the host stands in for both.
    expect(host.steps.filter((s) => s.uses).map((s) => hostStepAction(s))).toEqual([
      { run: false, why: "the worktree of the release" },
      { run: false, why: "the host's own toolchain" },
    ]);
  });

  test("a release.tag template reads its label from the ledger, in the same order as the GitHub job", () => {
    const input: ReleaseWorkflowInput = { ...SINGLE, publish: [{ type: "oci", repository: "registry.example.com/acme/api" }], tags: { place: { member: null, path: null }, template: { name: "v{version}", floating: "v{major}", legacy: false } } };
    const github = runLines(workflowJob(renderReleaseWorkflow(input), "publish")).filter((l) => !isInstall(l));
    const host = runLines(hostReleaseJob({ input }, TOOLS));
    expect(host).toEqual(github);
    expect(host.some((l) => l.includes('npx chant release tag "$GITHUB_REF_NAME" --json'))).toBe(true);
    expect(host.at(-1)).toBe('npx chant release publish "$CHANT_RELEASE_LABEL" --require-provenance --yes');
  });

  test("a train: the tag-triggered train publish job, even when the train is dispatched on the forge", () => {
    const train: ReleaseWorkflowInput = { ...SINGLE, images: false, imageArchives: [], version: false, pipeline: { trigger: "dispatch" }, train: { env: "prod", images: true, imagePlatforms: ["linux/amd64"] } };
    const github = runLines(workflowJob(renderReleaseWorkflow({ ...train, pipeline: {} }), "publish")).filter((l) => !isInstall(l) && l !== NPM_TRUSTED_PUBLISHING_SETUP);
    const host = runLines(hostReleaseJob({ input: train }, TOOLS));
    expect(host).toEqual(github);
    expect(host.indexOf('npx chant workspace train prepare prod "$CHANT_RELEASE_TRAIN"')).toBeLessThan(host.indexOf("npm run build"));
    expect(host.at(-1)).toBe('npx chant workspace train publish prod "$CHANT_RELEASE_TRAIN" --require-provenance --yes');
    expect(host).toContain('echo "CHANT_RELEASE_TRAIN=${CHANT_RELEASE_TRAIN:-${GITHUB_REF_NAME#release-train/prod/}}" >> "$GITHUB_ENV"');
  });

  test("per-platform builds refuse, since a host is one runner, and an action a host can't stand in for refuses the release", () => {
    expect(() => hostReleaseJob({ input: { ...SINGLE, pipeline: { trigger: "dispatch", builds: [{ name: "arm", runner: "ubuntu-24.04-arm", build: "make", outputs: ["out"] }] } } })).toThrow(/a ci serve host is one runner/);
    expect(() => hostStepAction({ uses: "acme/deploy@v1", env: {} })).toThrow(/runs no actions/);
  });
});

describe("which tags start a publish", () => {
  const read = (over: Partial<ReleaseWorkflowRead>): Pick<ReleaseWorkflowRead, "release" | "tags"> => ({ release: undefined, tags: { place: { member: null, path: null }, template: { name: "release/{label}", floating: null, legacy: true } }, ...over });

  test("release/** for the legacy template, a template's tags without its floating tag, a train's own tags", () => {
    const legacy = releaseTagMatcher(read({}));
    expect(["release/v1", "release/a/b", "release/", "v1"].map(legacy)).toEqual([true, true, false, false]);
    const templated = releaseTagMatcher(read({ tags: { place: { member: null, path: null }, template: { name: "v{version}", floating: "v{major}", legacy: false } } }));
    expect(["v1.2.0", "v1", "v12", "x1.2.0", "v1/x"].map(templated)).toEqual([true, false, false, false, false]);
    const train = releaseTagMatcher(read({ release: { train: { env: "prod" } } as ReleaseWorkflowRead["release"] }));
    expect(["release-train/prod/train-1", "release-train/dev/train-1", "release-train/prod/a/b", "release/v1"].map(train)).toEqual([true, false, false, false]);
  });
});

describe("signing on a host (#5458)", () => {
  const read = (release: unknown, members: unknown[] = [], groups: ReadonlySet<SecurityGroup> = SC) =>
    ({ release, memberReleases: members, input: { forge: "github", groups } }) as unknown as Pick<ReleaseWorkflowRead, "release" | "memberReleases" | "input">;
  const oci = [{ type: "oci", image: "image", repository: "r.example/acme/api" }];

  test("keyless signing refuses, since a host has no CI OIDC token; key and kms serve", () => {
    expect(hostSigningRefusal(read({ publish: oci }))?.message).toMatch(/signs keylessly \(the supply-chain group\), and a ci serve host has no CI OIDC token/);
    expect(hostSigningRefusal(read({ publish: oci, signing: true }, [], new Set()))?.message).toMatch(/release.signing/);
    expect(hostSigningRefusal(read({ publish: oci, signing: { key: "env://K", publicKey: "k.pub" } }))).toBeNull();
    expect(hostSigningRefusal(read({ publish: oci, signing: { kms: "hashivault://release", publicKey: "k.pub" } }))).toBeNull();
    expect(hostSigningRefusal(read(undefined, [{ publish: oci }]))?.fix).toMatch(/release.signing.kms/);
  });

  test("under supply-chain, signing off refuses: nothing would sign the statement that is the provenance", () => {
    expect(hostSigningRefusal(read({ publish: oci, signing: false }))?.message).toMatch(/supply-chain/);
    expect(hostSigningRefusal(read({ publish: oci, signing: false }, [], new Set()))).toBeNull();
    expect(hostSigningRefusal(read({}))).toBeNull();
  });
});

describe("the release tools on a host", () => {
  const bytes = Buffer.from("#!/bin/sh\necho fake-tool\n");
  const pin: ToolPin = { name: "faketool", version: "v1.0.0", platforms: { "linux/amd64": { url: "https://tools.example/faketool", sha256: createHash("sha256").update(bytes).digest("hex") } } };

  test("installs a pinned tool into the cache, checked against its SHA-256, once", async () => {
    const cache = scratchDir("chant-host-tools-");
    const asked: string[] = [];
    const download = async (url: string) => (asked.push(url), bytes);
    const exe = await installHostTool(pin, { cacheDir: cache, platform: "linux/amd64", download });
    expect(readFileSync(exe, "utf-8")).toBe(bytes.toString());
    expect(await installHostTool(pin, { cacheDir: cache, platform: "linux/amd64", download })).toBe(exe);
    expect(asked).toEqual(["https://tools.example/faketool"]);
  });

  test("a file that is not the pinned one, and a platform with no pin, are refused naming the tool", async () => {
    const cache = scratchDir("chant-host-tools-");
    await expect(installHostTool(pin, { cacheDir: cache, platform: "linux/amd64", download: async () => Buffer.from("other") })).rejects.toThrow(/faketool v1.0.0 from https:\/\/tools.example\/faketool has SHA-256 [0-9a-f]{64}, and chant pins/);
    expect(existsSync(join(cache, "faketool-v1.0.0-linux-amd64"))).toBe(false);
    await expect(installHostTool(pin, { cacheDir: cache, platform: "darwin/arm64" })).rejects.toThrow("faketool v1.0.0 is pinned for linux/amd64, and this host is darwin/arm64");
  });

  test("the publish's tools: the host's own when it sets their variables, else the pins, and a host that can't have one stops", async () => {
    const cache = scratchDir("chant-host-tools-");
    expect(await hostReleaseTools({ signing: true, scan: true, cacheDir: cache, hostEnv: { CHANT_COSIGN: "/opt/cosign", CHANT_GRYPE: "/opt/grype", CHANT_SYFT: "/opt/syft" } })).toEqual({ CHANT_COSIGN: "/opt/cosign", CHANT_GRYPE: "/opt/grype", CHANT_SYFT: "/opt/syft" });
    expect(await hostReleaseTools({ signing: false, scan: false, cacheDir: cache, hostEnv: {} })).toEqual({});
    await expect(hostReleaseTools({ signing: true, scan: false, cacheDir: cache, hostEnv: {}, platform: "darwin/arm64" })).rejects.toMatchObject({ message: expect.stringMatching(/^the release needs cosign, and cosign v[\d.]+ is pinned for linux\/amd64, linux\/arm64, and this host is darwin\/arm64/), fix: expect.stringContaining(HOST_TOOL_VARIABLES.cosign) });
    await expect(hostReleaseTools({ signing: false, scan: true, cacheDir: cache, hostEnv: {}, platform: "linux/amd64", download: async () => { throw new Error("no network"); } })).rejects.toThrow(/the release needs grype, and grype v[\d.]+ could not be downloaded: no network/);
    expect(hostPlatform("linux", "x64")).toBe("linux/amd64");
  });
});

describe("a step on a host", () => {
  const job = (steps: HostJob["steps"], env: Record<string, string> = {}): HostJob => ({ job: "publish", env, steps });

  test("runs as a forge runner runs it: GITHUB_ENV and GITHUB_OUTPUT carry on, the tag and commit are set, the forge's run variables are not", async () => {
    const top = scratchDir("chant-host-job-");
    const temp = join(top, ".temp");
    const r = await runHostJob(
      job(
        [
          { uses: "actions/checkout@v4", env: {} },
          { run: 'echo "LABEL=${GITHUB_REF_NAME#release/}" >> "$GITHUB_ENV"', env: {} },
          { id: "seen", run: 'echo "label=$LABEL" >> "$GITHUB_OUTPUT"; printf "%s|%s|%s|%s\\n" "$GITHUB_SHA" "${GITHUB_ACTIONS:-none}" "$CHANT_RELEASE_RUNNER_KEY_FINGERPRINT" "$CHANT_CI_RUN_FORGE" > seen.txt', env: {} },
          { if: "steps.seen.outputs.label != ''", run: 'echo "${{ steps.seen.outputs.label }}" > label.txt', env: {} },
        ],
        { JOB: "1" },
      ),
      { top, commit: "c".repeat(40), tag: "release/v1.2.0", runId: "run-1", fingerprint: "SHA256:host", hostEnv: { PATH: process.env.PATH, GITHUB_ACTIONS: "true" }, runnerTemp: temp },
    );
    expect(r.status).toBe("ok");
    expect(r.ran.map((s) => s.status)).toEqual(["skipped", "ok", "ok", "ok"]);
    expect(r.steps.seen).toEqual({ label: "v1.2.0" });
    expect(readFileSync(join(top, "seen.txt"), "utf-8")).toBe(`${"c".repeat(40)}|none|SHA256:host|chant\n`);
    expect(readFileSync(join(top, "label.txt"), "utf-8")).toBe("v1.2.0\n");
  });

  test("the release's secrets reach the step that publishes alone, a ${{ secrets }} reaches where the job names it, and the output is redacted", async () => {
    const top = scratchDir("chant-host-job-");
    const secrets = { file: "s.env", ...parseCiSecrets("OCI_PASSWORD=pw-host-registry-1\nRELEASE_KEY=pem-host-key-1\n", "s.env") };
    const seen: Record<string, Record<string, string>> = {};
    const out: string[] = [];
    const runStep: HostStepRunner = async ({ script, env, output }) => {
      seen[script] = env;
      output(`using ${env.OCI_PASSWORD ?? "none"}`);
      return 0;
    };
    const r = await runHostJob(
      job([
        { run: "npm run build", env: {} },
        { run: 'npx chant release publish "${GITHUB_REF_NAME#release/}" --yes', env: { RELEASE_KEY: "${{ secrets.RELEASE_KEY }}" } },
      ]),
      { top, commit: "c".repeat(40), tag: "release/v1", runId: "run-2", fingerprint: "SHA256:host", hostEnv: { PATH: "/bin" }, runnerTemp: join(top, ".t"), secrets, runStep, output: (l) => out.push(l) },
    );
    expect(r.status).toBe("ok");
    expect(seen["npm run build"]).not.toHaveProperty("OCI_PASSWORD");
    expect(seen["npm run build"]).not.toHaveProperty("RELEASE_KEY");
    const publish = seen['npx chant release publish "${GITHUB_REF_NAME#release/}" --yes']!;
    expect(publish).toMatchObject({ OCI_PASSWORD: "pw-host-registry-1", RELEASE_KEY: "pem-host-key-1", [RUNNER_FINGERPRINT_ENV]: "SHA256:host", CHANT_CI_RUN_ID: "run-2" });
    expect(out.join("\n")).not.toContain("pw-host-registry-1");
    expect(out).toContain("using none");
  });

  test("a failing step stops the job and names itself; an expression a host can't read refuses", async () => {
    const top = scratchDir("chant-host-job-");
    const r = await runHostJob(job([{ name: "Build", run: "exit 3", env: {} }, { run: "touch never", env: {} }]), { top, commit: "c".repeat(40), tag: "release/v1", runId: "r", fingerprint: "SHA256:h", hostEnv: { PATH: process.env.PATH }, runnerTemp: join(top, ".t") });
    expect(r).toMatchObject({ status: "fail", failure: "Build exited 3" });
    expect(existsSync(join(top, "never"))).toBe(false);
    expect(() => resolveEnv({ TOKEN: "${{ github.token }}" }, { secrets: {} }, "the job's")).toThrow(/the job's variable TOKEN reads \$\{\{ github.token \}\}, which a ci serve host has no value for/);
    expect(resolveEnv({ TOKEN: "${{ github.token }}" }, { secrets: { TOKEN: "t" } }, "x")).toEqual({ TOKEN: "t" });
    expect(() => evalCondition("github.event_name == 'push'", { secrets: {} })).toThrow(/can't decide/);
    expect(readCommandFile("A=1\nB<<EOF\nx\ny\nEOF\n")).toEqual({ A: "1", B: "x\ny" });
  });
});

describe("ci serve --release", () => {
  test("--release alone turns serving on for ci; --release <label> still names a release elsewhere", () => {
    expect(parseArgs(["ci", "serve", "--forge", "git", "--release", "--once"])).toMatchObject({ ciRelease: true });
    expect(parseArgs(["ci", "serve", "--release"])).toMatchObject({ ciRelease: true });
    expect(parseArgs(["components", "promote", "--to", "prod", "--release", "v1"])).toMatchObject({ release: "v1" });
    expect(() => parseArgs(["components", "promote", "--release"])).toThrow(/--release needs a release/);
  });

  function clone(): { root: string; origin: string; tag: (name: string) => string } {
    const origin = scratchDir("chant-serve-release-origin-");
    git(origin, "init", "-q", "--bare");
    const root = scratchDir("chant-serve-release-");
    git(root, "init", "-q");
    git(root, "symbolic-ref", "HEAD", "refs/heads/main");
    git(root, "config", "user.name", "t");
    git(root, "config", "user.email", "t@example.com");
    git(root, "remote", "add", "origin", origin);
    let n = 0;
    const tag = (name: string): string => {
      writeFiles(root, { [`f${n++}.txt`]: name });
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", name);
      git(root, "tag", "-a", "-m", name, name);
      git(root, "push", "-q", "origin", "main", `refs/tags/${name}`);
      return git(root, "rev-parse", "HEAD");
    };
    return { root, origin, tag };
  }
  const options = (root: string, served: HostReleaseRequest[], log: CiServeEvent[], status: (tag: string) => "ok" | "fail" = () => "ok", extra: Partial<CiServeOptions> = {}): CiServeOptions => ({
    cwd: root,
    forge: "git",
    repo: "origin",
    env: "prod",
    client: { openPullRequests: async () => [], branchHead: async () => undefined },
    stateDir: join(root, ".serve"),
    log: (e) => log.push(e),
    release: {
      isReleaseTag: (t) => t.startsWith("release/"),
      fingerprint: "SHA256:host-key",
      run: async (req) => (served.push(req), status(req.tag) === "ok" ? { status: "ok" } : { status: "fail", failure: "release publish exited 1" }),
    },
    ...extra,
  });

  test("notes the tags there on the first pass, then publishes each new release tag once, naming the runner key and its own run", async () => {
    const { root, tag } = clone();
    tag("release/v1");
    const served: HostReleaseRequest[] = [];
    const log: CiServeEvent[] = [];
    const rt = newCiServeRuntime();
    await ciServeReleases(options(root, served, log), rt);
    expect(served).toEqual([]);
    expect(formatCiServeEvent(log[0]!)).toBe("1 release tag(s) are there already and were published by whatever ran then; each new one is published here");
    const v2 = tag("release/v2");
    tag("not-a-release");
    const second = await ciServeReleases(options(root, served, log), rt);
    await Promise.all(second.started);
    expect(served.map((s) => [s.tag, s.commit, s.fingerprint])).toEqual([["release/v2", v2, "SHA256:host-key"]]);
    expect(served[0]!.runId).toMatch(/^chant-serve-\d+-release-/);
    expect(served[0]!.toolCache).toBe(join(root, ".serve", "tools"));
    // Published once: another pass starts nothing.
    await Promise.all((await ciServeReleases(options(root, served, log), rt)).started);
    expect(served).toHaveLength(1);
    const state = JSON.parse(readFileSync(join(root, ".serve", "chant-apply-prod.json"), "utf-8"));
    expect(state.releases["release:release/v1"]).toMatchObject({ status: "baseline" });
    expect(state.releases["release:release/v2"]).toMatchObject({ status: "ok", commit: v2, attempts: 1 });
    expect(log.map(formatCiServeEvent)).toContain(`the release release/v2 at ${v2.slice(0, 12)} published`);
  });

  test("a failed publish is recorded with why, and run again with --rerun-failed; capacity holds the rest", async () => {
    const { root, tag } = clone();
    const served: HostReleaseRequest[] = [];
    const log: CiServeEvent[] = [];
    const rt = newCiServeRuntime();
    await ciServeReleases(options(root, served, log), rt);
    tag("release/v1");
    tag("release/v2");
    const first = await ciServeReleases(options(root, served, log, (t) => (t === "release/v1" ? "fail" : "ok")), rt);
    expect(first.events.map((e) => e.type === "release" && e.status)).toEqual(["started", "held"]);
    await Promise.all(first.started);
    const state = () => JSON.parse(readFileSync(join(root, ".serve", "chant-apply-prod.json"), "utf-8")) as { releases: Record<string, { status: string; failure?: string; attempts: number }> };
    expect(state().releases["release:release/v1"]).toMatchObject({ status: "fail", failure: "release publish exited 1" });
    // With --rerun-failed the failed one runs again first, and the other still waits its turn.
    const again = await ciServeReleases(options(root, served, log, () => "ok", { rerunFailed: true }), rt);
    expect(again.events.map((e) => e.type === "release" && [e.tag, e.status])).toEqual([["release/v1", "started"], ["release/v2", "held"]]);
    await Promise.all(again.started);
    expect(served.map((s) => s.tag)).toEqual(["release/v1", "release/v1"]);
    expect(state().releases["release:release/v1"]).toMatchObject({ status: "ok", attempts: 2 });
  });

  test("a pass serves releases beside the jobs, and a release that throws is a failure with its reason", async () => {
    const { root, tag } = clone();
    const log: CiServeEvent[] = [];
    await ciServePass(options(root, [], log));
    tag("release/v3");
    const opts = options(root, [], log);
    opts.release!.run = async () => {
      throw new Error("the release needs cosign, and no network");
    };
    await ciServePass(opts);
    expect(log.filter((e) => e.type === "release").map((e) => (e.type === "release" ? [e.status, e.reason ?? null] : null))).toEqual([
      ["baseline", null],
      ["started", null],
      ["fail", "the release needs cosign, and no network"],
    ]);
  });
});
