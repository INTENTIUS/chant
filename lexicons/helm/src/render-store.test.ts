import { describe, test, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

import yaml from "js-yaml";

import { HelmRender, clearHelmRenderRecords, getHelmRenderRecords } from "./render";
import { canonicalizeRender, helmContentDigest, helmInputDigest } from "./render-digest";
import {
  findRenderByCacheKey,
  helmValuesDigest,
  indexRenderDocuments,
  listRenderManifests,
  loadRenderContent,
  loadRenderManifest,
  persistHelmRender,
  readRenderDocument,
  renderCacheKey,
} from "./render-store";
import type { HelmCapabilityProfile } from "./config";

/**
 * A raw `helm template`-shaped stream with deliberate render noise: CRLF
 * endings, unsorted mapping keys, a comment-only document, and a duplicate
 * document (epic finding 11 — an aliased dependency emits the same CRD
 * twice).
 */
const RENDERED = [
  "---",
  "# Source: tiny/templates/serviceaccount.yaml",
  "kind: ServiceAccount",
  "apiVersion: v1",
  "metadata:",
  "  namespace: web",
  "  name: tiny-sa",
  "---",
  "# comment-only document",
  "---",
  "# Source: tiny/templates/configmap.yaml\r",
  "apiVersion: v1\r",
  "kind: ConfigMap",
  "metadata:",
  "  name: tiny-config",
  "  namespace: web",
  "data:",
  "  zeta: last",
  "  alpha: first",
  "---",
  "# Source: tiny/crds/widgets.yaml",
  "apiVersion: apiextensions.k8s.io/v1",
  "kind: CustomResourceDefinition",
  "metadata:",
  "  name: widgets.example.com",
  "spec:",
  "  group: example.com",
  "---",
  "# Source: tiny/crds/widgets.yaml",
  "apiVersion: apiextensions.k8s.io/v1",
  "kind: CustomResourceDefinition",
  "metadata:",
  "  name: widgets.example.com",
  "spec:",
  "  group: example.com",
  "",
].join("\n");

const PROFILE: HelmCapabilityProfile = {
  name: "prod",
  kubeVersion: "1.33.6",
  apiVersions: ["batch/v1"],
};

const VALUES = { replicaCount: 3 };

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "chant-helm-render-store-"));
}

function persistFixture(root: string, overrides?: Partial<Parameters<typeof persistHelmRender>[0]>) {
  return persistHelmRender({
    rendered: RENDERED,
    releaseName: "rel",
    chart: "tiny",
    repo: "https://charts.example.com",
    chartVersion: "0.1.0",
    namespace: "web",
    values: VALUES,
    capabilityProfile: PROFILE,
    helmVersion: "v4.1.1",
    sourceRef: "deadbeef",
    root,
    ...overrides,
  });
}

describe("persistHelmRender / render store", () => {
  test("round-trip: persisted bytes load back byte-identical, and canonicalization is idempotent over them", () => {
    const root = freshRoot();
    const { manifest } = persistFixture(root);

    const stored = loadRenderContent(manifest.contentDigest, { root });
    expect(stored).toBe(canonicalizeRender(RENDERED));

    // The store serves canonical bytes back as the cache — re-canonicalizing
    // and re-digesting them must be a fixed point, or a cache hit would
    // change the render's recorded identity.
    expect(canonicalizeRender(stored!)).toBe(stored);
    expect(helmContentDigest(stored!)).toBe(manifest.contentDigest);
  });

  test("the manifest records every field: identity, inputs, profile, index, provenance", () => {
    const root = freshRoot();
    const now = () => new Date("2026-08-24T12:00:00.000Z");
    const { manifest, dir } = persistFixture(root, { now });

    expect(manifest.version).toBe(1);
    expect(manifest.chart).toBe("tiny");
    expect(manifest.chartVersion).toBe("0.1.0");
    expect(manifest.repo).toBe("https://charts.example.com");
    expect(manifest.releaseName).toBe("rel");
    expect(manifest.namespace).toBe("web");
    expect(manifest.valuesDigest).toBe(helmValuesDigest(VALUES));
    expect(manifest.inputDigest).toBe(
      helmInputDigest({
        chart: "https://charts.example.com/tiny",
        chartVersion: "0.1.0",
        values: VALUES,
        capabilityProfile: { kubeVersion: "1.33.6", apiVersions: ["batch/v1"] },
      }),
    );
    expect(manifest.capabilityProfile).toEqual({
      cluster: "prod",
      kubeVersion: "1.33.6",
      apiVersions: ["batch/v1"],
    });
    expect(manifest.contentDigest).toBe(helmContentDigest(RENDERED));
    // 4 canonical documents: the comment-only one is render noise and does
    // not survive canonicalization; the duplicate CRD does (finding 11).
    expect(manifest.docCount).toBe(4);
    expect(manifest.documents.length).toBe(4);
    expect(manifest.renderedAt).toBe("2026-08-24T12:00:00.000Z");
    expect(manifest.helmVersion).toBe("v4.1.1");
    expect(manifest.chantVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.sourceRef).toBe("deadbeef");

    // What landed on disk is the manifest itself, next to the bytes.
    expect(dir).toBe(join(root, manifest.contentDigest.replace(":", "-")));
    const onDisk = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(onDisk).toEqual(manifest);
  });

  test("an unpinned render is refused with the specific reason", () => {
    const root = freshRoot();
    expect(() => persistFixture(root, { capabilityProfile: undefined })).toThrow(
      /no capability profile is declared.*no stable content identity/s,
    );
    // Nothing was written.
    expect(readdirSync(root)).toEqual([]);
  });

  test("two renders with the same contentDigest share one store entry", () => {
    const root = freshRoot();
    const first = persistFixture(root, { now: () => new Date("2026-08-24T12:00:00.000Z") });
    expect(first.deduplicated).toBe(false);

    // Same bytes, later clock, different declared release inputs that do
    // not change the bytes' identity: the content entry is reused untouched.
    const second = persistFixture(root, { now: () => new Date("2026-08-25T09:00:00.000Z") });
    expect(second.deduplicated).toBe(true);
    expect(second.dir).toBe(first.dir);
    // First writer wins — the stored manifest is immutable.
    expect(second.manifest.renderedAt).toBe("2026-08-24T12:00:00.000Z");

    const entries = readdirSync(root).filter((e) => e.startsWith("sha256-"));
    expect(entries.length).toBe(1);
    expect(listRenderManifests({ root }).length).toBe(1);
  });

  test("the document index resolves kind/namespace/name to that document's exact bytes", () => {
    const root = freshRoot();
    const { manifest } = persistFixture(root);

    const hit = readRenderDocument(
      manifest.contentDigest,
      { kind: "ConfigMap", namespace: "web", name: "tiny-config" },
      { root },
    );
    expect(hit).toBeDefined();
    expect(hit!.entry.apiVersion).toBe("v1");
    expect(hit!.entry.source).toBe("tiny/templates/configmap.yaml");
    const doc = yaml.load(hit!.text) as { kind: string; data: Record<string, string> };
    expect(doc.kind).toBe("ConfigMap");
    expect(doc.data).toEqual({ zeta: "last", alpha: "first" });
    // The bytes are the manifest-indexed slice of the stored content.
    const content = loadRenderContent(manifest.contentDigest, { root })!;
    expect(hit!.text).toBe(
      Buffer.from(content, "utf8")
        .subarray(hit!.entry.start, hit!.entry.start + hit!.entry.length)
        .toString("utf8"),
    );

    // Cluster-scoped documents resolve with no namespace.
    const crd = readRenderDocument(
      manifest.contentDigest,
      { kind: "CustomResourceDefinition", name: "widgets.example.com" },
      { root },
    );
    expect(crd).toBeDefined();
    expect(crd!.entry.namespace).toBeNull();

    // A document the render never contained resolves to nothing.
    expect(
      readRenderDocument(manifest.contentDigest, { kind: "Secret", name: "nope" }, { root }),
    ).toBeUndefined();
  });

  test("the inputs index resolves the full-inputs key to the stored digests", () => {
    const root = freshRoot();
    const { manifest } = persistFixture(root);

    const key = renderCacheKey({
      chart: "https://charts.example.com/tiny",
      chartVersion: "0.1.0",
      releaseName: "rel",
      namespace: "web",
      values: VALUES,
      capabilityProfile: PROFILE,
    });
    const entry = findRenderByCacheKey(key, { root });
    expect(entry).toEqual({
      version: 1,
      inputDigest: manifest.inputDigest,
      contentDigest: manifest.contentDigest,
    });

    // The release name is part of the cache key even though inputDigest
    // excludes it — it is baked into the bytes via .Release.Name.
    const otherName = renderCacheKey({
      chart: "https://charts.example.com/tiny",
      chartVersion: "0.1.0",
      releaseName: "other",
      namespace: "web",
      values: VALUES,
      capabilityProfile: PROFILE,
    });
    expect(otherName).not.toBe(key);
    expect(findRenderByCacheKey(otherName, { root })).toBeUndefined();
  });

  test("listRenderManifests lists every stored render and skips corrupt entries", () => {
    const root = freshRoot();
    const a = persistFixture(root);
    const b = persistFixture(root, { rendered: RENDERED + "---\nkind: Secret\napiVersion: v1\nmetadata:\n  name: extra\n" });
    expect(a.manifest.contentDigest).not.toBe(b.manifest.contentDigest);

    // A corrupt entry must not fail the listing.
    const corrupt = join(root, `sha256-${"f".repeat(64)}`);
    mkdirSync(corrupt, { recursive: true });
    writeFileSync(join(corrupt, "manifest.json"), "{not json");

    const listed = listRenderManifests({ root });
    expect(listed.map((m) => m.contentDigest).sort()).toEqual(
      [a.manifest.contentDigest, b.manifest.contentDigest].sort(),
    );
  });

  test("indexRenderDocuments counts every canonical document, indexed or not", () => {
    const canonical = canonicalizeRender(RENDERED);
    const { documents, docCount } = indexRenderDocuments(canonical);
    expect(docCount).toBe(4);
    // The duplicate CRD appears twice in the index, at different offsets.
    const crds = documents.filter((d) => d.kind === "CustomResourceDefinition");
    expect(crds.length).toBe(2);
    expect(crds[0].start).not.toBe(crds[1].start);
    expect(crds[0].digest).toBe(crds[1].digest);
  });
});

/**
 * HelmRender integration — asserted against a scripted `helm` double (the
 * same pattern render.test.ts uses) so these tests need no real helm, no
 * network, and no chart. The double answers `helm version` and answers any
 * `helm template` with two small manifests, counting its template
 * invocations so cache hits are observable.
 */
describe("HelmRender persistence (#1238)", () => {
  const FAKE_BIN = join(tmpdir(), "chant-helm-render-store-fake-bin");
  let storeRoot: string;
  let countFile: string;
  let origPath: string | undefined;
  let origRoot: string | undefined;

  beforeAll(() => {
    mkdirSync(FAKE_BIN, { recursive: true });
    writeFileSync(
      join(FAKE_BIN, "helm"),
      `#!/bin/sh
if [ "$1" = "version" ]; then
  echo "v4.1.1-fake"
  exit 0
fi
echo x >> "$CHANT_TEST_HELM_TEMPLATE_COUNT"
cat <<'EOF'
---
# Source: tiny/templates/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fake-render
  namespace: web
data:
  b: two
  a: one
---
# Source: tiny/templates/serviceaccount.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: fake-sa
  namespace: web
EOF
`,
      { mode: 0o755 },
    );
  });

  beforeEach(() => {
    storeRoot = freshRoot();
    countFile = join(mkdtempSync(join(tmpdir(), "chant-helm-count-")), "count.txt");
    process.env.CHANT_TEST_HELM_TEMPLATE_COUNT = countFile;
    origRoot = process.env.CHANT_HELM_RENDER_ROOT;
    process.env.CHANT_HELM_RENDER_ROOT = storeRoot;
    origPath = process.env.PATH;
    process.env.PATH = FAKE_BIN + delimiter + (origPath ?? "");
    clearHelmRenderRecords();
  });

  afterEach(() => {
    process.env.PATH = origPath;
    if (origRoot === undefined) delete process.env.CHANT_HELM_RENDER_ROOT;
    else process.env.CHANT_HELM_RENDER_ROOT = origRoot;
    delete process.env.CHANT_TEST_HELM_TEMPLATE_COUNT;
  });

  function templateInvocations(): number {
    if (!existsSync(countFile)) return 0;
    return readFileSync(countFile, "utf8").split("\n").filter((l) => l.length > 0).length;
  }

  const pinnedProps = () =>
    ({
      name: "rel",
      chart: "/dev/null/some-chart",
      namespace: "web",
      values: { replicaCount: 2 },
      capabilityProfile: { ...PROFILE },
    }) as unknown as Parameters<typeof HelmRender>[0];

  test("a pinned render persists by default, and an identical render is a store cache hit", () => {
    HelmRender(pinnedProps());
    expect(templateInvocations()).toBe(1);

    const [record] = getHelmRenderRecords();
    const manifest = loadRenderManifest(record.contentDigest!);
    expect(manifest).toBeDefined();
    expect(manifest!.inputDigest).toBe(record.inputDigest);
    expect(manifest!.helmVersion).toBe("v4.1.1-fake");
    expect(manifest!.releaseName).toBe("rel");
    expect(loadRenderContent(record.contentDigest!)).toBeDefined();

    // Second identical render: served from the store through the inputs
    // index — helm template does not run again, and the recorded digests
    // are unchanged.
    clearHelmRenderRecords();
    const result = HelmRender(pinnedProps());
    expect(templateInvocations()).toBe(1);
    const [second] = getHelmRenderRecords();
    expect(second.contentDigest).toBe(record.contentDigest);
    expect(second.inputDigest).toBe(record.inputDigest);
    const keys = Object.keys(result.members as Record<string, unknown>);
    expect(keys).toContain("ConfigMap_fake_render");
    expect(keys).toContain("ServiceAccount_fake_sa");
  });

  test("persist: true on an unpinned render is a synth error naming the reason", () => {
    expect(() =>
      HelmRender({
        name: "rel",
        chart: "/dev/null/some-chart",
        persist: true,
      } as Parameters<typeof HelmRender>[0]),
    ).toThrow(/unpinned.*no capabilityProfile declared/s);
    // Refused before helm ran.
    expect(templateInvocations()).toBe(0);
  });

  test("noCache renders fresh and skips the store; persist: true forces the write anyway", () => {
    HelmRender({ ...pinnedProps(), noCache: true } as Parameters<typeof HelmRender>[0]);
    expect(templateInvocations()).toBe(1);
    expect(listRenderManifests({ root: storeRoot }).length).toBe(0);

    HelmRender({ ...pinnedProps(), noCache: true, persist: true } as Parameters<typeof HelmRender>[0]);
    expect(templateInvocations()).toBe(2);
    expect(listRenderManifests({ root: storeRoot }).length).toBe(1);

    // persist: false turns the store off even without noCache.
    HelmRender({ ...pinnedProps(), name: "rel2", persist: false } as Parameters<typeof HelmRender>[0]);
    expect(templateInvocations()).toBe(3);
    expect(listRenderManifests({ root: storeRoot }).length).toBe(1);
  });
});
