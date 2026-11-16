/**
 * #5157: `release.verify` runs after every target has staged and before any
 * reveals, with the staged references in its environment. A failure stops
 * the publish with nothing revealed and is recorded; run again, the publish
 * stages nothing again and verifies again. A target whose stage is visible
 * (npm `stage: false`) stages only after verify passes.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { cutRelease } from "./release-cut";
import { createRedactor } from "./publish-credentials";
import { parsePublishRecords, PUBLISHES_FILE } from "./publish-record";
import { PublishRunError, runPublish, type PublishContext, type PublishTarget } from "./release-publish";
import type { Release, ReleaseArtifact } from "./release-store";
import { runVerifySteps, stagedDocument, stagedReference, unstagedForVerify, unstagedWarning, verifyEnv, verifySteps, type VerifyRunner } from "./publish-verify";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";
import { TestRepo } from "../workspace/trust/test-repo";
import { ChantConfigSchema } from "../config";

const repos: TestRepo[] = [];
afterAll(() => {
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});

const compiler: TargetCompiler = {
  async compile(env): Promise<CompiledTarget> {
    return { env, params: [], components: ["api"], buildSteps: {}, buildInputs: {}, componentFiles: { api: "api.component.ts" }, templates: [{ component: "api", path: "dist/api.json", content: "{}\n" }] };
  },
  async buildArtifacts(): Promise<ReleaseArtifact[]> {
    return [];
  },
};

const NO_OIDC = { oidc: false, ci: null, reason: "this run is not in CI, and a workstation has no OIDC token" };

async function release(r: TestRepo): Promise<Release> {
  r.write("chant.config.ts", `export default { environments: ["dev"] };\n`);
  r.write("api.component.ts", "export const api = {};\n");
  const head = r.commit("init");
  r.git(["tag", `ci/green/${head}`]);
  return (await cutRelease({ cwd: r.dir, compiler, label: "v2", actor: "alice", env: {}, now: () => new Date("2026-11-16T10:00:00.000Z") })).release;
}

/** A repository with release v2 cut, made in beforeAll, which the unit-test budget does not count. */
function repo(name: string): () => { r: TestRepo; rel: Release } {
  let f: { r: TestRepo; rel: Release } | undefined;
  beforeAll(async () => {
    const r = new TestRepo(name);
    repos.push(r);
    f = { r, rel: await release(r) };
  }, 120_000);
  return () => f!;
}

/** Fake targets that log each stage and reveal to `events`. */
function fakes(events: string[]) {
  const make = (kind: PublishTarget["kind"], name: string, items: Array<{ name: string; destination: string; digest?: string; attachment?: "sbom" }>, state: Record<string, string> = {}, visibly = false): PublishTarget => ({
    kind,
    name,
    destination: name,
    credentialEnv: [],
    key: `${kind}:${name}`,
    ...(visibly ? { stagesVisibly: true } : {}),
    plan: async () => items,
    stage: async () => {
      events.push(`stage ${name}`);
      return { target: name, destination: name, items, state };
    },
    reveal: async () => {
      events.push(`reveal ${name}`);
      return { target: name, destination: name, items };
    },
  });
  return {
    npm: make("npm", "npm", [
      { name: "@acme/core@2.0.0", destination: "registry, dist-tag next" },
      { name: "@acme/cli@2.0.0", destination: "registry, dist-tag next" },
    ]),
    oci: make("oci", "oci", [
      { name: "image (tag v2)", destination: "ghcr.io/acme/api@sha256:aaa", digest: "sha256:aaa" },
      { name: "sbom.spdx.json (SBOM)", destination: "ghcr.io/acme/api@sha256:bbb", attachment: "sbom" },
    ]),
    forge: make("forge", "forge", [{ name: "dist/api.tar.gz", destination: "github acme/api release v2, asset api.tar.gz" }], { releaseId: "100", releaseUrl: "https://github.test/acme/api/releases/tag/untagged-1", notes: "long notes" }),
    visibly: make("npm", "npm-unstaged", [{ name: "@acme/x@2.0.0", destination: "registry, dist-tag latest" }], {}, true),
  };
}

describe("targets release.verify can't see", () => {
  test("npm stage: false and the targets that upload at reveal (pypi, cargo, marketplace) are named; staged targets are not", () => {
    const targets = [
      { name: "npm", stagesVisibly: false },
      { name: "npm-unstaged", stagesVisibly: true },
      { name: "pypi acme", uploadsAtReveal: true },
      { name: "oci" },
      { name: "cargo acme", uploadsAtReveal: true },
      { name: "marketplace", uploadsAtReveal: true },
    ];
    expect(unstagedForVerify(targets)).toEqual(["npm-unstaged", "pypi acme", "cargo acme", "marketplace"]);
    expect(unstagedWarning(["pypi acme"])).toContain("pypi acme publishes without a stage");
    expect(unstagedWarning(["pypi acme"])).toContain("PyPI");
  });
});

describe("release.verify in a publish", () => {
  const publish_verify = repo("publish-verify");
  test("runs after every stage and before any reveal, with the staged references; a failure is recorded, reveals nothing, and a re-run verifies again without staging again", async () => {
    const { r, rel } = publish_verify();
    const events: string[] = [];
    const t = fakes(events);
    const targets = [t.npm, t.oci, t.forge];
    const redactor = createRedactor({});
    const ctx: PublishContext = { release: rel, label: "v2", releaseTag: "v2", provenance: NO_OIDC, cwd: r.dir, tag: null, env: { PATH: process.env.PATH }, redactor, log: () => undefined };
    const seen: Array<{ command: string; env: NodeJS.ProcessEnv; staged: unknown }> = [];
    let exit = 1;
    const runVerify: VerifyRunner = (command, o) => {
      events.push(`verify ${command}`);
      seen.push({ command, env: o.env, staged: JSON.parse(readFileSync(o.env.CHANT_STAGED!, "utf-8")) });
      return command === "smoke" ? exit : 0;
    };
    const steps = verifySteps(["pack-install", { name: "smoke test", run: "smoke" }]);
    const run = () => runPublish({ cwd: r.dir, release: rel, label: "v2", targets, ctx, verify: steps, runVerify });
    const records = () => parsePublishRecords(r.git(["show", `chant/lifecycle:_releases/${PUBLISHES_FILE}`])).records;

    const first = await run().catch((e: unknown) => e);
    expect(first).toBeInstanceOf(PublishRunError);
    expect(first).toMatchObject({ code: "publish-verify-failed", step: "verify", staged: ["npm", "oci", "forge"], revealed: [] });
    expect((first as Error).message).toBe("verify: smoke test exited 1");
    expect(events).toEqual(["stage npm", "stage oci", "stage forge", "verify pack-install", "verify smoke"]);
    expect(records().map((x) => [x.kind, x.step])).toEqual([["npm", "staged"], ["oci", "staged"], ["forge", "staged"], ["verify", "verify-failed"]]);
    expect(records().at(-1)!.state).toEqual({ step: "smoke test", exitCode: "1" });
    expect(records().at(-1)!.target).toMatch(/^verify:[0-9a-f]{16}$/);

    const env = seen[0]!.env;
    expect(env).toMatchObject({
      CHANT_RELEASE_LABEL: "v2",
      CHANT_RELEASE_DIGEST: rel.releaseDigest,
      CHANT_RELEASE_COMMIT: rel.commit,
      CHANT_RELEASE_TAG: "v2",
      CHANT_STAGED_NPM: "@acme/core@2.0.0 @acme/cli@2.0.0",
      CHANT_STAGED_NPM_TAG: "next",
      CHANT_STAGED_IMAGES: "ghcr.io/acme/api@sha256:aaa",
      CHANT_STAGED_RELEASE_ID: "100",
      CHANT_STAGED_RELEASE_URL: "https://github.test/acme/api/releases/tag/untagged-1",
    });
    expect(env.PATH).toBe(process.env.PATH);
    expect(seen[0]!.staged).toMatchObject({
      release: { label: "v2", releaseDigest: rel.releaseDigest, commit: rel.commit, tag: "v2" },
      targets: [{ kind: "npm", name: "npm" }, { kind: "oci", items: [{ digest: "sha256:aaa" }, { attachment: "sbom" }] }, { kind: "forge", state: { releaseId: "100" } }],
      artifacts: [],
    });
    // The notes stay out of the document.
    expect((seen[0]!.staged as { targets: Array<{ state: Record<string, string> }> }).targets[2]!.state.notes).toBeUndefined();

    events.length = 0;
    exit = 0;
    const done = await run();
    expect(events).toEqual(["verify pack-install", "verify smoke", "reveal npm", "reveal oci", "reveal forge"]);
    expect(done.verify).toBe("passed");
    expect(records().map((x) => x.step)).toEqual(["staged", "staged", "staged", "verify-failed", "verified", "revealed", "revealed", "revealed"]);
    // A staged target read back from the record still reaches the commands.
    expect(seen.at(-1)!.env.CHANT_STAGED_NPM).toBe("@acme/core@2.0.0 @acme/cli@2.0.0");
  });

  const publish_verify_revealed = repo("publish-verify-revealed");
  test("does not run once a reveal is recorded, since it could hold nothing back", async () => {
    const { r, rel } = publish_verify_revealed();
    const events: string[] = [];
    const t = fakes(events);
    let failOci = true;
    const oci: PublishTarget = {
      ...t.oci,
      reveal: async (c, s) => {
        if (failOci) throw new Error("registry down");
        return t.oci.reveal(c, s);
      },
    };
    const ctx: PublishContext = { release: rel, label: "v2", releaseTag: "v2", provenance: NO_OIDC, cwd: r.dir, tag: null, env: {}, redactor: createRedactor({}), log: () => undefined };
    const lines: string[] = [];
    const runVerify: VerifyRunner = (command) => {
      events.push(`verify ${command}`);
      return 0;
    };
    const run = () => runPublish({ cwd: r.dir, release: rel, label: "v2", targets: [t.npm, oci], ctx, verify: verifySteps(["check"]), runVerify, say: (l) => lines.push(l) });
    await expect(run()).rejects.toMatchObject({ step: "reveal", revealed: ["npm"] });
    events.length = 0;
    failOci = false;
    const done = await run();
    expect(events).toEqual(["reveal oci"]);
    expect(done.verify).toBe("skipped");
    expect(lines).toContain("  verify: skipped, since an earlier run began revealing");
  });

  const publish_verify_visibly = repo("publish-verify-visibly");
  test("a target whose stage is visible stages only after verify passes, in its turn to reveal", async () => {
    const { r, rel } = publish_verify_visibly();
    const events: string[] = [];
    const t = fakes(events);
    const ctx: PublishContext = { release: rel, label: "v2", releaseTag: null, provenance: NO_OIDC, cwd: r.dir, tag: null, env: {}, redactor: createRedactor({}), log: () => undefined };
    const envs: NodeJS.ProcessEnv[] = [];
    const runVerify: VerifyRunner = (command, o) => {
      events.push(`verify ${command}`);
      envs.push(o.env);
      return 0;
    };
    await runPublish({ cwd: r.dir, release: rel, label: "v2", targets: [t.visibly, t.oci], ctx, verify: verifySteps(["check"]), runVerify, record: false });
    expect(events).toEqual(["stage oci", "verify check", "stage npm-unstaged", "reveal npm-unstaged", "reveal oci"]);
    expect(envs[0]!.CHANT_STAGED_NPM).toBeUndefined();
    expect(envs[0]!.CHANT_RELEASE_TAG).toBeUndefined();
    expect(unstagedForVerify([t.visibly, t.oci])).toEqual(["npm-unstaged"]);
  });

  const publish_verify_none = repo("publish-verify-none");
  test("with no verify commands, a publish runs as before and says nothing of verify", async () => {
    const { r, rel } = publish_verify_none();
    const events: string[] = [];
    const t = fakes(events);
    const ctx: PublishContext = { release: rel, label: "v2", releaseTag: null, provenance: NO_OIDC, cwd: r.dir, tag: null, env: {}, redactor: createRedactor({}), log: () => undefined };
    const done = await runPublish({ cwd: r.dir, release: rel, label: "v2", targets: [t.npm, t.oci], ctx, record: false });
    expect(events).toEqual(["stage npm", "stage oci", "reveal npm", "reveal oci"]);
    expect(done.verify).toBeUndefined();
  });
});

describe("the verify commands themselves", () => {
  const publish_verify_shell = repo("publish-verify-shell");
  test("run through the shell in the member's directory and stop at the first that fails", async () => {
    const { r, rel } = publish_verify_shell();
    const events: string[] = [];
    const t = fakes(events);
    const staged = [stagedReference(t.oci, { target: "oci", destination: "oci", items: [{ name: "image", destination: "ghcr.io/acme/api@sha256:aaa", digest: "sha256:aaa" }], state: {} })];
    const out = runVerifySteps({
      cwd: r.dir,
      steps: verifySteps(['test "$CHANT_STAGED_IMAGES" = ghcr.io/acme/api@sha256:aaa && test -f "$CHANT_STAGED" && test -f chant.config.ts', "exit 3", "echo never"]),
      env: { PATH: process.env.PATH },
      release: rel,
      label: "v2",
      releaseTag: null,
      staged,
      say: () => undefined,
    });
    expect(out).toMatchObject({ passed: false, step: { run: "exit 3" }, exitCode: 3 });
  });

  test("a variable with nothing to name is not set", () => {
    const rel = { releaseDigest: "jcs1-sha256:x", commit: "c0ffee", artifactDigests: [] } as unknown as Release;
    expect(verifyEnv({ release: rel, label: null, releaseTag: null, staged: [], file: "/tmp/x.json" })).toEqual({ CHANT_RELEASE_LABEL: "", CHANT_RELEASE_DIGEST: "jcs1-sha256:x", CHANT_RELEASE_COMMIT: "c0ffee", CHANT_STAGED: "/tmp/x.json" });
  });

  test("CHANT_STAGED carries the signatures a stage attached (#5164) and the artifacts the release records (#5181, #5194)", () => {
    const artifactDigests: ReleaseArtifact[] = [
      { component: "api", kind: "asset", path: "dist/api-linux-amd64.tar.gz", digest: "sha256:111" },
      { component: "api", kind: "asset", path: "dist/api-darwin-arm64.tar.gz", digest: "sha256:222" },
      { component: "api", kind: "image", path: "", digest: "sha256:aaa", ref: "ghcr.io/acme/api@sha256:aaa" },
    ];
    const rel = { releaseDigest: "jcs1-sha256:x", commit: "c0ffee", artifactDigests } as unknown as Release;
    const image = "ghcr.io/acme/api@sha256:aaa";
    const oci = stagedReference({ kind: "oci", name: "oci", destination: "ghcr.io/acme/api" }, {
      target: "oci",
      destination: "ghcr.io/acme/api",
      items: [
        { name: "image (tag v2)", destination: image, digest: "sha256:aaa" },
        { name: "cosign signature", destination: "ghcr.io/acme/api@sha256:ccc, a referrer of the image", digest: "sha256:ccc", attachment: "signature", signs: [{ name: image, digest: "sha256:aaa" }] },
        { name: "SLSA provenance", destination: "ghcr.io/acme/api@sha256:ddd, a referrer of the image", digest: "sha256:ddd", attachment: "attestation", signs: [{ name: image, digest: "sha256:aaa" }] },
      ],
      state: {},
    });
    const doc = stagedDocument({ release: rel, label: "v2", releaseTag: "v2", staged: [oci] }) as { targets: Array<{ items: Array<{ attachment?: string }> }>; artifacts: unknown[] };
    expect(doc.targets[0]!.items.map((i) => i.attachment ?? null)).toEqual([null, "signature", "attestation"]);
    expect(doc.artifacts).toEqual([
      { component: "api", kind: "asset", path: "dist/api-linux-amd64.tar.gz", digest: "sha256:111" },
      { component: "api", kind: "asset", path: "dist/api-darwin-arm64.tar.gz", digest: "sha256:222" },
      { component: "api", kind: "image", path: "", digest: "sha256:aaa", ref: image },
    ]);
    // The signatures are referrers of the image, not images to run.
    expect(verifyEnv({ release: rel, label: "v2", releaseTag: "v2", staged: [oci], file: "/tmp/x.json" }).CHANT_STAGED_IMAGES).toBe(image);
  });

  test("release.verify takes commands, or each with a name, and nothing else", () => {
    const ok = (verify: unknown) => ChantConfigSchema.safeParse({ release: { verify } }).success;
    expect(ok(["npm test", { name: "smoke", run: "./smoke.sh" }, { run: "true" }])).toBe(true);
    expect(ok([""])).toBe(false);
    expect(ok([{ name: "smoke" }])).toBe(false);
    expect(ok([{ run: "x", env: {} }])).toBe(false);
    expect(verifySteps(["a", { run: "b" }, { name: "c", run: "d" }])).toEqual([{ name: "a", run: "a" }, { name: "b", run: "b" }, { name: "c", run: "d" }]);
  });
});
