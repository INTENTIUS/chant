/**
 * A promote under a release reads the target's recorded templates and checks
 * their digests (#4026, ws-104 question 5).
 */

import { describe, test, expect } from "vitest";
import { contentDigest } from "../content-digest";
import { makeRelease, templateBytesDigest } from "../lifecycle/release-store";
import type { DriverComponent } from "./driver";
import { isImplicitRelease, pinReleaseTemplates, releaseArtifactMismatches, removePinnedTemplates, targetFiles, targetFor, writePinnedTemplates, RELEASE_TEMPLATES_DIR } from "./release-promote";
import type { ReleaseRecord } from "../lifecycle/release-ledger";
import type { BuildArchiveManifest } from "./verbs/build-archive";
import { withTestDir } from "@intentius/chant-test-utils";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const prodTemplate = `{"env":"prod"}\n`;
const release = makeRelease({
  member: null,
  commit: "c".repeat(40),
  artifactDigests: [],
  targets: [
    { env: "staging", templates: [{ component: "api", path: "dist/api.template.json", digest: contentDigest(`{"env":"staging"}\n`) }], params: [] },
    { env: "prod", templates: [{ component: "api", path: "dist/api.template.json", digest: contentDigest(prodTemplate) }], params: [] },
  ],
});
const prod = release.targets.find((t) => t.env === "prod")!;

const api: DriverComponent = {
  name: "api",
  deploy: [
    { phase: "Publish", steps: [{ kind: "publish-image", from: "archive:api.tar" }] },
    { phase: "Apply", steps: [{ kind: "gate", gate: "prod" }, { kind: "cfn-deploy", template: "dist/api.template.json", imageRef: "@Publish.digest" }] },
  ],
};

const store = (content: string | null) => async (digest: string) => (digest === prod.templates[0].digest ? content : null);

describe("pinReleaseTemplates", () => {
  test("points the deploy at the target's recorded template, by digest", async () => {
    const pinned = await pinReleaseTemplates([api], release, prod, store(prodTemplate));
    if ("errors" in pinned) throw new Error(pinned.errors.join("\n"));
    const path = `${RELEASE_TEMPLATES_DIR}/${prod.templates[0].digest.replace(/:/g, "_")}/api.template.json`;
    expect(pinned.files).toEqual([{ path, content: prodTemplate }]);
    expect(pinned.components[0].deploy[1].steps[1]).toEqual({ kind: "cfn-deploy", template: path, imageRef: "@Publish.digest" });
    // The publish step and the gate are left as they were.
    expect(pinned.components[0].deploy[0]).toEqual(api.deploy[0]);
    expect(pinned.components[0].deploy[1].steps[0]).toEqual({ kind: "gate", gate: "prod" });
  });

  test("refuses a template whose digest differs from the target's", async () => {
    const pinned = await pinReleaseTemplates([api], release, prod, store(`{"env":"prod","edited":true}\n`));
    expect("errors" in pinned && pinned.errors.join("\n")).toMatch(
      new RegExp(`template "dist/api.template.json" hashes to sha256:[0-9a-f]{64}, but the release's target for "prod" records ${prod.templates[0].digest}; refusing to deploy it`),
    );
  });

  test("refuses a template the target does not record, and one whose bytes are missing", async () => {
    const other: DriverComponent = { name: "api", deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", template: "dist/new.template.json" }] }] };
    const missing = await pinReleaseTemplates([other], release, prod, store(prodTemplate));
    expect("errors" in missing && missing.errors[0]).toMatch(/reads template "dist\/new.template.json", which release .* does not record for "prod"/);
    const absent = await pinReleaseTemplates([api], release, prod, store(null));
    expect("errors" in absent && absent.errors[0]).toMatch(/are not on the chant\/lifecycle branch/);
  });

  test("a target cut since #4155 points a chart at its recorded tree, which a reader of the release can trust", async () => {
    const chartFile = "name: web\n";
    const tgz = Buffer.from([0x1f, 0x8b, 0xff]).toString("base64");
    const tgzDigest = templateBytesDigest(tgz, "base64");
    const cut = makeRelease({
      member: null,
      commit: "c".repeat(40),
      artifactDigests: [],
      targets: [{
        env: "prod",
        params: [],
        templates: [
          { component: "web", path: "chart/Chart.yaml", digest: contentDigest(chartFile) },
          { component: "web", path: "chart/charts/dep.tgz", digest: tgzDigest, encoding: "base64" },
        ],
        trees: [{ component: "web", path: "chart" }],
      }],
    });
    const web: DriverComponent = {
      name: "web",
      deploy: [{ phase: "Deploy", steps: [
        { kind: "helm-upgrade", release: "web", chart: "chart" },
        { kind: "helm-upgrade", release: "remote", chart: "bitnami/nginx" },
      ] }],
    };
    const bytes: Record<string, string> = { [contentDigest(chartFile)]: chartFile, [tgzDigest]: tgz };
    const pinned = await pinReleaseTemplates([web], cut, cut.targets[0]!, async (d, encoding) => (encoding === "base64" && d !== tgzDigest ? null : bytes[d] ?? null));
    if ("errors" in pinned) throw new Error(pinned.errors.join("\n"));
    const step = pinned.components[0]!.deploy[0]!.steps[0] as unknown as { chart: string };
    expect(step.chart).toMatch(/^\.chant\/release-templates\/[^/]+\/chart$/);
    expect(pinned.files.map((f) => f.path.slice(step.chart.length + 1)).sort()).toEqual(["Chart.yaml", "charts/dep.tgz"]);
    expect(pinned.files.find((f) => f.path.endsWith("dep.tgz"))).toMatchObject({ encoding: "base64", content: tgz });
    // A chart named from a repository is not a local path the release records, and is left as written.
    expect(pinned.components[0]!.deploy[0]!.steps[1]).toEqual(web.deploy[0]!.steps[1]);

    await withTestDir(async (dir) => {
      writePinnedTemplates(dir, pinned.files);
      expect(readFileSync(join(dir, step.chart, "charts", "dep.tgz"))).toEqual(Buffer.from([0x1f, 0x8b, 0xff]));
      removePinnedTemplates(dir, pinned.files);
      expect(existsSync(join(dir, RELEASE_TEMPLATES_DIR))).toBe(false);
    });

    const edited = await pinReleaseTemplates([web], cut, cut.targets[0]!, async (d) => (d === contentDigest(chartFile) ? "name: edited\n" : bytes[d] ?? null));
    expect("errors" in edited && edited.errors.join("\n")).toMatch(/template "chart\/Chart.yaml" hashes to .* refusing to deploy it/);
  });

  test("a target cut before #4155 (no trees) is pinned as then: the chart is read from the checkout", async () => {
    const web: DriverComponent = { name: "api", deploy: [{ phase: "Deploy", steps: [{ kind: "helm-upgrade", release: "web", chart: "chart" }, ...api.deploy[1]!.steps] }] };
    const pinned = await pinReleaseTemplates([web], release, prod, store(prodTemplate));
    if ("errors" in pinned) throw new Error(pinned.errors.join("\n"));
    expect(pinned.components[0]!.deploy[0]!.steps[0]).toEqual({ kind: "helm-upgrade", release: "web", chart: "chart" });
  });

  test("targetFor names the environments a release was compiled for", () => {
    expect(targetFor(release, "prod")).toEqual({ target: prod });
    expect(targetFor(release, "qa")).toEqual({ error: expect.stringMatching(/has no target for "qa"; it was compiled for prod, staging/) });
  });
});

describe("an implicit release (#4046)", () => {
  const yaml = "kind: Deployment\n";
  const implicit = makeRelease({
    member: null,
    commit: "d".repeat(40),
    artifactDigests: [],
    targets: [{ env: "prod", templates: [{ component: null, path: "dist/build.yaml", digest: contentDigest(yaml) }], params: [] }],
  });
  const target = implicit.targets[0];

  test("is a release with no artifacts whose templates all have no component", () => {
    expect(isImplicitRelease(implicit)).toBe(true);
    expect(isImplicitRelease(release)).toBe(false);
    expect(isImplicitRelease(makeRelease({ ...implicit, targets: [{ env: "prod", templates: [], params: [] }] }))).toBe(false);
  });

  test("targetFiles gives the recorded bytes at their recorded paths, checked against the digest", async () => {
    expect(await targetFiles(implicit, target, async () => yaml)).toEqual({ files: [{ path: "dist/build.yaml", content: yaml }] });
    const tampered = await targetFiles(implicit, target, async () => "kind: Secret\n");
    expect("errors" in tampered && tampered.errors[0]).toMatch(/hashes to sha256:.*refusing to write it/);
    const missing = await targetFiles(implicit, target, async () => null);
    expect("errors" in missing && missing.errors[0]).toMatch(/not on the chant\/lifecycle branch/);
  });

  test("targetFiles refuses a path that leaves the member's directory", async () => {
    const escaping = { env: "prod", templates: [{ component: null, path: "../x.yaml", digest: contentDigest(yaml) }], params: [] };
    const out = await targetFiles(implicit, escaping, async () => yaml);
    expect("errors" in out && out.errors[0]).toMatch(/not a path inside the member's directory/);
  });
});

describe("the artifact a promote under a release deploys (#4045)", () => {
  const built = makeRelease({
    member: null,
    commit: "c".repeat(40),
    artifactDigests: [{ component: "api", kind: "image", path: "api.tar", digest: "sha256:built" }],
    targets: release.targets,
  });
  const source: ReleaseRecord = {
    version: 1, component: "api", env: "staging", digest: "sha256:published", gitSha: "c".repeat(40), runId: "r1",
    timestamp: "2026-10-01T00:00:00.000Z", actor: "ci", manifestDigest: "sha256:manifest",
  };
  const manifest = (digest: string): BuildArchiveManifest => ({
    version: 1, component: "api", createdAt: "2026-10-01T00:00:00.000Z", manifestDigest: "sha256:manifest",
    contents: [{ kind: "image", path: "api.tar", digest, mediaType: "application/vnd.oci.image.layout.v1+tar" }],
  } as BuildArchiveManifest);

  test("matches when the source deploy's build manifest holds the release's artifact at its path", async () => {
    expect(await releaseArtifactMismatches(built, [{ component: "api", source }], async () => manifest("sha256:built"))).toEqual([]);
  });

  test("names a source deploy built from other bytes", async () => {
    const out = await releaseArtifactMismatches(built, [{ component: "api", source }], async () => manifest("sha256:rebuilt"));
    expect(out).toEqual([expect.stringMatching(/api: the staging deploy being promoted was built with api.tar at sha256:rebuilt, but release .* built it at sha256:built/)]);
  });

  test("a source deploy naming the release, or one with no readable manifest, says nothing", async () => {
    const read = async () => manifest("sha256:rebuilt");
    expect(await releaseArtifactMismatches(built, [{ component: "api", source: { ...source, releaseDigest: built.releaseDigest } }], read)).toEqual([]);
    expect(await releaseArtifactMismatches(built, [{ component: "api", source: { ...source, manifestDigest: undefined } }], read)).toEqual([]);
    expect(await releaseArtifactMismatches(built, [{ component: "api", source }], async () => null)).toEqual([]);
  });
});

describe("removePinnedTemplates (#4045)", () => {
  test("removes what the promote wrote, and the directory once it is empty", async () => {
    await withTestDir(async (dir) => {
      const files = [{ path: `${RELEASE_TEMPLATES_DIR}/sha256_ab/api.template.json`, content: "{}" }];
      writePinnedTemplates(dir, files);
      expect(existsSync(join(dir, files[0].path))).toBe(true);
      removePinnedTemplates(dir, files);
      expect(existsSync(join(dir, RELEASE_TEMPLATES_DIR))).toBe(false);
      expect(existsSync(join(dir, ".chant"))).toBe(true);
    });
  });

  test("keeps anything else under the directory", async () => {
    await withTestDir(async (dir) => {
      mkdirSync(join(dir, RELEASE_TEMPLATES_DIR, "other"), { recursive: true });
      writeFileSync(join(dir, RELEASE_TEMPLATES_DIR, "other", "x"), "x");
      const files = [{ path: `${RELEASE_TEMPLATES_DIR}/sha256_ab/api.template.json`, content: "{}" }];
      writePinnedTemplates(dir, files);
      removePinnedTemplates(dir, files);
      expect(existsSync(join(dir, RELEASE_TEMPLATES_DIR, "other", "x"))).toBe(true);
      expect(existsSync(join(dir, RELEASE_TEMPLATES_DIR, "sha256_ab"))).toBe(false);
    });
  });
});
