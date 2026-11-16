/**
 * #5233: the helm target, against the OCI registry fake on 127.0.0.1 and the
 * GitHub fake. No helm runs and no request reaches a network.
 */

import { afterAll, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRedactor } from "./publish-credentials";
import { PublishDeclarationSchema, type HelmPublishDeclaration } from "./publish-declaration";
import { addToHelmIndex, helmOciManifest, helmOciTag, readChartArchive } from "./publish-helm";
import { createPublishTargets } from "./publish-targets";
import { buildReleaseArtifacts } from "./release-artifacts";
import { PublishTargetError, type PublishContext, type PublishFetch } from "./release-publish";
import { makeRelease, type ReleaseArtifact } from "./release-store";
import { parseYAML } from "../yaml";
import { startFakeGitHub, startFakeRegistry } from "./__fixtures__/publish-fakes";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const API = "https://api.github.test";
const COMMIT = "c0ffee".padEnd(40, "0");
const CREDS = { username: "ci", password: "oci-secret-password", token: "oci-bearer-token" };

/** A member with a chart packed as the cut packs it, and the release that records it. */
function packed(label = "v1.4.0"): { cwd: string; artifacts: ReleaseArtifact[] } {
  const cwd = mkdtempSync(join(tmpdir(), "chant-publish-helm-"));
  dirs.push(cwd);
  for (const [p, text] of Object.entries({ "chart/Chart.yaml": "apiVersion: v2\nname: api\ndescription: The API\nversion: 0.1.0\n", "chart/templates/svc.yaml": "kind: Service\n" })) {
    mkdirSync(dirname(join(cwd, p)), { recursive: true });
    writeFileSync(join(cwd, p), text);
  }
  const artifacts = buildReleaseArtifacts({ artifacts: [{ name: "chart", helm: { chart: "chart" } }], cwd, sourceDateEpoch: 1_760_000_000, label });
  return { cwd, artifacts };
}

function context(cwd: string, artifacts: ReleaseArtifact[], env: NodeJS.ProcessEnv): PublishContext & { lines: string[] } {
  const redactor = createRedactor(env);
  const lines: string[] = [];
  const release = makeRelease({ member: null, commit: COMMIT, artifactDigests: artifacts, targets: [{ env: "dev", params: [], templates: [] }] });
  return { release, label: "v1.4.0", releaseTag: "v1.4.0", provenance: { oidc: false, ci: null, reason: "" }, cwd, tag: null, env, redactor, log: (l) => lines.push(redactor.redact(l)), cut: { actor: "a", label: "v1.4.0", timestamp: "2026-11-16T10:00:00.000Z", runId: null, signature: null }, lines };
}

const decl = (over: Record<string, unknown>) => PublishDeclarationSchema.parse({ type: "helm", charts: ["artifact:chart"], ...over }) as HelmPublishDeclaration;

async function refused(p: Promise<unknown>): Promise<PublishTargetError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PublishTargetError) return err;
    throw err;
  }
  throw new Error("expected a PublishTargetError");
}

describe("helm declaration (#5233)", () => {
  test("needs oci, index or both", () => {
    expect(() => decl({})).toThrow(/oci, lists the charts in an index, or both/);
    expect(decl({ oci: { repository: "ghcr.io/acme/charts" } }).oci?.repository).toBe("ghcr.io/acme/charts");
  });
});

describe("helm target, OCI (#5233)", () => {
  test("stages the chart by digest as helm push lays it out, tags its version at the reveal, and sends nothing again", async () => {
    const registry = await startFakeRegistry(CREDS);
    try {
      const { cwd, artifacts } = packed();
      const env = { OCI_USERNAME: CREDS.username, OCI_PASSWORD: CREDS.password };
      const [target] = await createPublishTargets([decl({ oci: { repository: `${registry.host}/acme/charts` } })]);
      const ctx = context(cwd, artifacts, env);
      const planned = await target!.plan(ctx);
      const chart = readChartArchive("dist/api-1.4.0.tgz", new Uint8Array(readFileSync(join(cwd, "dist/api-1.4.0.tgz"))));
      const m = helmOciManifest(chart);
      expect(planned).toEqual([{ name: "api-1.4.0.tgz (tag 1.4.0)", destination: `${registry.host}/acme/charts/api@${m.digest}`, digest: m.digest }]);
      const staged = await target!.stage(ctx);
      expect(registry.manifests.has(m.digest)).toBe(true);
      expect(registry.manifests.has("1.4.0")).toBe(false);
      const manifest = JSON.parse(registry.manifests.get(m.digest)!.bytes.toString("utf-8"));
      expect(manifest.config.mediaType).toBe("application/vnd.cncf.helm.config.v1+json");
      expect(manifest.layers[0]).toMatchObject({ mediaType: "application/vnd.cncf.helm.chart.content.v1.tar+gzip", digest: chart.digest });
      expect(JSON.parse(registry.blobs.get(manifest.config.digest)!.toString("utf-8"))).toMatchObject({ name: "api", version: "1.4.0" });
      await target!.reveal(ctx, staged);
      expect(registry.manifests.get("1.4.0")!.name).toBe("acme/charts/api");
      expect(await target!.published!(ctx)).toBe(true);
      const uploads = registry.uploads;
      const again = await target!.stage(ctx);
      expect(again.items[0]!.present).toBe(true);
      expect(registry.uploads).toBe(uploads);
      expect(ctx.lines.join("\n")).not.toContain(CREDS.password);
    } finally {
      await registry.close();
    }
  });

  test("refuses a chart whose version is not the release's, and a file that is not a chart", async () => {
    const { cwd, artifacts } = packed("v1.3.0");
    const [target] = await createPublishTargets([decl({ oci: { repository: "127.0.0.1:1/acme/charts" } })]);
    expect((await refused(target!.plan(context(cwd, artifacts, {})))).code).toBe("publish-helm-version-mismatch");
    expect(() => readChartArchive("x.tgz", new Uint8Array(Buffer.from("not gzip")))).toThrow(/not a Helm chart archive/);
    expect(helmOciTag("1.4.0+build.1")).toBe("1.4.0_build.1");
  });
});

describe("helm target, index on a branch (#5233)", () => {
  test("stages the index on a side branch, fast-forwards gh-pages at the reveal, and keeps the versions listed before", async () => {
    const gh = startFakeGitHub(API, { user: "acme-bot" });
    const prior = "apiVersion: v1\nentries:\n  api:\n    - name: api\n      version: 1.3.0\n      digest: abc\n      urls:\n        - https://example.test/api-1.3.0.tgz\ngenerated: 2026-01-01T00:00:00Z\n";
    gh.repo("acme/pages", "gh-pages", { "index.yaml": prior });
    const { cwd, artifacts } = packed();
    const [target] = await createPublishTargets([decl({ index: { repo: "acme/pages", url: "https://github.com/acme/api/releases/download/{tag}/{name}", api: API } })], { fetch: gh.fetch as unknown as PublishFetch });
    expect(target!.revealsLast).toBe(true);
    const ctx = context(cwd, artifacts, { GITHUB_TOKEN: "ghp_pagestokenpages" });
    const staged = await target!.stage(ctx);
    expect(staged.state.staging).toBe("chant-publish/helm-1.4.0");
    expect(gh.read("acme/pages", "gh-pages", "index.yaml")).toBe(prior);
    await target!.reveal(ctx, staged);
    const index = parseYAML(gh.read("acme/pages", "gh-pages", "index.yaml")!) as { entries: { api: Array<Record<string, unknown>> } };
    expect(index.entries.api.map((e) => e.version)).toEqual(["1.4.0", "1.3.0"]);
    expect(index.entries.api[0]).toMatchObject({ urls: ["https://github.com/acme/api/releases/download/v1.4.0/api-1.4.0.tgz"], created: "2026-11-16T10:00:00.000Z", description: "The API" });
    expect(gh.head("acme/pages", "chant-publish/helm-1.4.0")).toBeUndefined();
    expect(await target!.published!(ctx)).toBe(true);
    // Run again: the index lists the chart, so nothing is committed.
    const again = await target!.stage(ctx);
    expect(again.state.present).toBe("true");
  });

  test("with no url, commits the archive beside the index and names it by its file name", async () => {
    const gh = startFakeGitHub(API, { user: "acme-bot" });
    gh.repo("acme/pages", "gh-pages", { "README.md": "charts\n" });
    const { cwd, artifacts } = packed();
    const [target] = await createPublishTargets([decl({ index: { repo: "acme/pages", path: "stable/index.yaml", api: API } })], { fetch: gh.fetch as unknown as PublishFetch });
    const ctx = context(cwd, artifacts, { GITHUB_TOKEN: "ghp_pagestokenpages" });
    await target!.reveal(ctx, await target!.stage(ctx));
    expect(gh.read("acme/pages", "gh-pages", "stable/api-1.4.0.tgz")).toBeDefined();
    const index = parseYAML(gh.read("acme/pages", "gh-pages", "stable/index.yaml")!) as { entries: { api: Array<{ urls: string[] }> } };
    expect(index.entries.api[0]!.urls).toEqual(["api-1.4.0.tgz"]);
  });

  test("refuses a version the index lists with another digest, a missing token and a missing branch", async () => {
    const { cwd, artifacts } = packed();
    const chart = readChartArchive("dist/api-1.4.0.tgz", new Uint8Array(readFileSync(join(cwd, "dist/api-1.4.0.tgz"))));
    expect(() => addToHelmIndex("apiVersion: v1\nentries:\n  api:\n    - version: 1.4.0\n      digest: other\n", [{ chart, url: "u" }], "t", "index.yaml")).toThrow(/lists api 1.4.0 with the digest other/);
    expect(addToHelmIndex(`apiVersion: v1\nentries:\n  api:\n    - version: 1.4.0\n      digest: ${chart.digest.slice(7)}\n`, [{ chart, url: "u" }], "t", "index.yaml")).toBeNull();
    const gh = startFakeGitHub(API, { user: "acme-bot" });
    gh.repo("acme/pages", "main", {});
    const [target] = await createPublishTargets([decl({ index: { repo: "acme/pages", api: API } })], { fetch: gh.fetch as unknown as PublishFetch });
    expect((await refused(target!.plan(context(cwd, artifacts, {})))).code).toBe("publish-credentials-missing");
    const err = await refused(target!.stage(context(cwd, artifacts, { GITHUB_TOKEN: "ghp_pagestokenpages" })));
    expect(err.message).toMatch(/no branch gh-pages/);
  });
});
