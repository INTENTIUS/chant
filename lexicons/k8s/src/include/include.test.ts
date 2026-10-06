/**
 * `k8sInclude` (#3566 item 4). What must hold: a local file or a pinned URL
 * resolves at `buildRoots()` into verbatim manifest entities with
 * deterministic names and source provenance; a URL's bytes must match the
 * digest and are cached by it, so later builds are offline; patches apply
 * before the documents become entities; and every way an include can be
 * wrong fails with the path or URL in the message. No test touches the
 * network: the fetcher is injected.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { build } from "@intentius/chant";
import type { Declarable } from "@intentius/chant/declarable";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { k8sInclude, isK8sInclude, INCLUDE_SOURCE_ANNOTATION, type K8sIncludeDeclaration } from "./entity";
import { includeBuildRoot, resolveIncludes, sha256Digest, type IncludeFetcher } from "./resolve";
import { isRenderedManifestEntity } from "../manifest-entity";
import { k8sSerializer } from "../serializer";
import { k8sPlugin } from "../plugin";
import { wk8005 } from "../lint/post-synth/wk8005";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "testdata", "include");
const BUNDLE = readFileSync(join(fixtureRoot, "bundle.yaml"));
const BUNDLE_DIGEST = sha256Digest(BUNDLE);
const URL_SOURCE = "https://example.com/releases/v0.4.1/widget.yaml";
/** Absolute path to the factory — a temp project cannot resolve the package name. */
const ENTITY_MODULE = join(here, "entity");

const EXPECTED_KEYS = [
  "widgets/namespaceWidgetSystem",
  "widgets/configMapWidgetConfig",
  "widgets/configMapWidgetConfig.widget-edge",
  "widgets/deploymentWidgetController",
];

function decls(...pairs: Array<[string, K8sIncludeDeclaration]>) {
  return new Map(pairs);
}

function propsOf(entity: Declarable | undefined): Record<string, unknown> {
  return (entity as unknown as { props: Record<string, unknown> }).props;
}

let cacheRoot: string;
beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), "chant-include-cache-"));
});
afterEach(() => {
  rmSync(cacheRoot, { recursive: true, force: true });
});

describe("k8sInclude — the declaration", () => {
  test("is a k8s declarable with no props, so it never reaches the live read paths", () => {
    const decl = k8sInclude({ source: "manifests/bundle.yaml" });
    expect(isK8sInclude(decl)).toBe(true);
    expect(decl.lexicon).toBe("k8s");
    expect("props" in decl).toBe(false);
  });

  test("a URL without a digest is refused at declaration time", () => {
    expect(() => k8sInclude({ source: URL_SOURCE })).toThrow(/must be pinned with `digest: "sha256:<hex>"`/);
  });

  test("a malformed digest is refused", () => {
    expect(() => k8sInclude({ source: URL_SOURCE, digest: "sha256:abc" })).toThrow(/not of the form/);
    expect(() => k8sInclude({ source: URL_SOURCE, digest: BUNDLE_DIGEST.replace("sha256:", "md5:") })).toThrow(
      /not of the form/,
    );
  });

  test("schemes other than http(s) are refused", () => {
    expect(() => k8sInclude({ source: "oci://registry/bundle" })).toThrow(/only local paths and http\(s\) URLs/);
  });

  test("the serializer emits nothing for the declaration itself", () => {
    const out = k8sSerializer.serialize(new Map<string, Declarable>([["inc", k8sInclude({ source: "x.yaml" })]]));
    expect(typeof out === "string" ? out : out.primary).toBe("");
  });
});

describe("resolveIncludes — local files", () => {
  test("resolves relative to the project root into verbatim entities with deterministic keys", async () => {
    const entities = await resolveIncludes({
      projectRoot: join(fixtureRoot, ".."),
      declarations: decls(["widgets", k8sInclude({ source: "include/bundle.yaml" })]),
      cacheRoot,
    });

    // The stray `---` empties are skipped; the two same-name ConfigMaps are
    // qualified by namespace, in document order.
    expect([...entities.keys()]).toEqual(EXPECTED_KEYS);
    const deployment = entities.get("widgets/deploymentWidgetController")!;
    expect(isRenderedManifestEntity(deployment)).toBe(true);
    expect(deployment.entityType).toBe("K8s::Apps::Deployment");
    const metadata = propsOf(deployment).metadata as { annotations: Record<string, string> };
    expect(metadata.annotations[INCLUDE_SOURCE_ANNOTATION]).toBe("include/bundle.yaml");
  });

  test("names are the same on every resolve, and a third same-name document is numbered", async () => {
    const readFile = () =>
      Buffer.from(
        ["a", "a", "b"]
          .map((ns) => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n  namespace: ${ns}\n`)
          .join("---\n"),
      );
    const run = () =>
      resolveIncludes({ projectRoot: "/p", declarations: decls(["inc", k8sInclude({ source: "c.yaml" })]), readFile });
    const first = [...(await run()).keys()];
    expect(first).toEqual(["inc/configMapC", "inc/configMapC.a", "inc/configMapC.b"]);
    expect([...(await run()).keys()]).toEqual(first);
  });

  test("a local file with a digest must match it", async () => {
    const wrong = `sha256:${"0".repeat(64)}`;
    await expect(
      resolveIncludes({
        projectRoot: fixtureRoot,
        declarations: decls(["w", k8sInclude({ source: "bundle.yaml", digest: wrong })]),
      }),
    ).rejects.toThrow(/bundle\.yaml does not match its pinned digest: expected sha256:0+, found sha256:/);
  });

  test("a missing file fails with the declared source and the resolved path", async () => {
    await expect(
      resolveIncludes({ projectRoot: fixtureRoot, declarations: decls(["w", k8sInclude({ source: "nope.yaml" })]) }),
    ).rejects.toThrow(new RegExp(`k8sInclude "w" \\(nope\\.yaml\\): file not readable at ${join(fixtureRoot, "nope.yaml")}`));
  });

  test("a document without apiVersion/kind fails with its index", async () => {
    const readFile = () => Buffer.from("apiVersion: v1\nkind: Namespace\nmetadata:\n  name: x\n---\njust: data\n");
    await expect(
      resolveIncludes({ projectRoot: "/p", declarations: decls(["w", k8sInclude({ source: "m.yaml" })]), readFile }),
    ).rejects.toThrow(/k8sInclude "w" \(m\.yaml\): document 1 has no string apiVersion and kind/);
  });

  test("a file holding only empty documents fails", async () => {
    const readFile = () => Buffer.from("---\n---\n# nothing\n");
    await expect(
      resolveIncludes({ projectRoot: "/p", declarations: decls(["w", k8sInclude({ source: "m.yaml" })]), readFile }),
    ).rejects.toThrow(/k8sInclude "w" \(m\.yaml\) contains no YAML documents/);
  });

  test("patches apply before the documents become entities", async () => {
    const entities = await resolveIncludes({
      projectRoot: fixtureRoot,
      declarations: decls([
        "widgets",
        k8sInclude({
          source: "bundle.yaml",
          patches: [
            { kind: "Deployment", name: "widget-controller", merge: { spec: { replicas: 2 } } },
            {
              kind: "ConfigMap",
              name: "widget-config",
              namespace: "widget-edge",
              jsonPatch: [
                { op: "test", path: "/data/level", value: "debug" },
                { op: "replace", path: "/data/level", value: "info" },
              ],
            },
          ],
        }),
      ]),
    });
    expect((propsOf(entities.get("widgets/deploymentWidgetController")).spec as { replicas: number }).replicas).toBe(2);
    expect(propsOf(entities.get("widgets/configMapWidgetConfig.widget-edge")).data).toEqual({ level: "info" });
  });

  test("a patch selecting nothing fails, naming the include", async () => {
    await expect(
      resolveIncludes({
        projectRoot: fixtureRoot,
        declarations: decls([
          "widgets",
          k8sInclude({ source: "bundle.yaml", patches: [{ kind: "Deployment", name: "widget-manager", merge: {} }] }),
        ]),
      }),
    ).rejects.toThrow(/k8sInclude "widgets" \(bundle\.yaml\): patch 0 .* matched no document\. Deployment documents present: widget-system\/widget-controller/);
  });
});

describe("resolveIncludes — pinned URLs", () => {
  test("fetches once, verifies the digest, then resolves offline from the cache", async () => {
    const fetched: string[] = [];
    const fetcher: IncludeFetcher = async (url) => {
      fetched.push(url);
      return BUNDLE;
    };
    const declarations = decls(["widgets", k8sInclude({ source: URL_SOURCE, digest: BUNDLE_DIGEST })]);

    const first = await resolveIncludes({ projectRoot: "/p", declarations, fetch: fetcher, cacheRoot });
    expect(fetched).toEqual([URL_SOURCE]);
    expect([...first.keys()]).toEqual(EXPECTED_KEYS);
    expect(existsSync(join(cacheRoot, `${BUNDLE_DIGEST.replace(":", "-")}.yaml`))).toBe(true);

    // The second build has no network at all.
    const offline: IncludeFetcher = async () => {
      throw new Error("network unavailable");
    };
    const second = await resolveIncludes({ projectRoot: "/p", declarations, fetch: offline, cacheRoot });
    expect([...second.keys()]).toEqual(EXPECTED_KEYS);
    const ns = propsOf(second.get("widgets/namespaceWidgetSystem")).metadata as { annotations: Record<string, string> };
    expect(ns.annotations[INCLUDE_SOURCE_ANNOTATION]).toBe(URL_SOURCE);
  });

  test("fetched bytes that do not match the digest fail the build and are not cached", async () => {
    const tampered = Buffer.concat([BUNDLE, Buffer.from("\n# changed upstream\n")]);
    await expect(
      resolveIncludes({
        projectRoot: "/p",
        declarations: decls(["widgets", k8sInclude({ source: URL_SOURCE, digest: BUNDLE_DIGEST })]),
        fetch: async () => tampered,
        cacheRoot,
      }),
    ).rejects.toThrow(
      new RegExp(
        `k8sInclude "widgets" \\(${URL_SOURCE.replace(/[.]/g, "\\.")}\\): fetched bytes do not match the pinned digest: ` +
          `expected ${BUNDLE_DIGEST}, fetched ${sha256Digest(tampered)}`,
      ),
    );
    expect(existsSync(join(cacheRoot, `${BUNDLE_DIGEST.replace(":", "-")}.yaml`))).toBe(false);
  });

  test("a corrupt cache entry is refetched, not trusted", async () => {
    writeFileSync(join(cacheRoot, `${BUNDLE_DIGEST.replace(":", "-")}.yaml`), "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: evil\n");
    let fetches = 0;
    const entities = await resolveIncludes({
      projectRoot: "/p",
      declarations: decls(["widgets", k8sInclude({ source: URL_SOURCE, digest: BUNDLE_DIGEST })]),
      fetch: async () => {
        fetches++;
        return BUNDLE;
      },
      cacheRoot,
    });
    expect(fetches).toBe(1);
    expect([...entities.keys()]).toEqual(EXPECTED_KEYS);
  });

  test("a failed fetch names the URL", async () => {
    await expect(
      resolveIncludes({
        projectRoot: "/p",
        declarations: decls(["widgets", k8sInclude({ source: URL_SOURCE, digest: BUNDLE_DIGEST })]),
        fetch: async () => {
          throw new Error("HTTP 404 Not Found");
        },
        cacheRoot,
      }),
    ).rejects.toThrow(/widget\.yaml\): fetch failed — HTTP 404 Not Found/);
  });

  test("CHANT_INCLUDE_CACHE_ROOT moves the cache", async () => {
    const orig = process.env.CHANT_INCLUDE_CACHE_ROOT;
    process.env.CHANT_INCLUDE_CACHE_ROOT = cacheRoot;
    try {
      await resolveIncludes({
        projectRoot: "/p",
        declarations: decls(["widgets", k8sInclude({ source: URL_SOURCE, digest: BUNDLE_DIGEST })]),
        fetch: async () => BUNDLE,
      });
      expect(existsSync(join(cacheRoot, `${BUNDLE_DIGEST.replace(":", "-")}.yaml`))).toBe(true);
    } finally {
      if (orig === undefined) delete process.env.CHANT_INCLUDE_CACHE_ROOT;
      else process.env.CHANT_INCLUDE_CACHE_ROOT = orig;
    }
  });
});

describe("k8sInclude through the build pipeline", () => {
  test("included docs reach the output ownership-stamped, patched, and seen by post-synth checks", async () => {
    const dir = join(tmpdir(), `chant-include-build-${Date.now()}-${Math.random()}`);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(join(dir, "bundle.yaml"), BUNDLE);
      await writeFile(
        join(dir, "widgets.infra.ts"),
        `import { k8sInclude } from ${JSON.stringify(ENTITY_MODULE)};
export const widgets = k8sInclude({
  source: "bundle.yaml",
  patches: [{ kind: "Deployment", name: "widget-controller", merge: { spec: { replicas: 4 } } }],
});
`,
      );

      const result = await build(dir, [k8sSerializer], undefined, {
        ownership: { stack: "widgets", env: "prod" },
        buildRoots: [(ctx) => k8sPlugin.buildRoots!({ projectRoot: dir, config: {}, entities: ctx.entities })],
      });

      expect(result.errors).toEqual([]);
      for (const key of EXPECTED_KEYS) expect(result.entities.has(key)).toBe(true);

      const output = result.outputs.get("k8s")!;
      const yaml = typeof output === "string" ? output : output.primary;
      expect(yaml).toContain("name: widget-controller");
      expect(yaml).toContain("replicas: 4");
      expect(yaml).toContain("app.kubernetes.io/managed-by: chant");
      expect(yaml).toContain("chant.intentius.io/stack: widgets");
      expect(yaml).toContain(`${INCLUDE_SOURCE_ANNOTATION}: bundle.yaml`);
      // Four documents, the declaration itself emits nothing.
      expect(yaml.split(/^---$/m).filter((d) => d.trim()).length).toBe(4);

      const ctx: PostSynthContext = {
        outputs: result.outputs,
        entities: result.entities,
        buildResult: {
          outputs: result.outputs,
          entities: result.entities,
          warnings: result.warnings,
          errors: [],
          sourceFileCount: result.sourceFileCount,
        },
      };
      expect(wk8005.check(ctx).some((d) => d.message.includes("API_TOKEN"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an include that does not resolve is a build error naming it", async () => {
    const dir = join(tmpdir(), `chant-include-build-bad-${Date.now()}-${Math.random()}`);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(
        join(dir, "widgets.infra.ts"),
        `import { k8sInclude } from ${JSON.stringify(ENTITY_MODULE)};
export const widgets = k8sInclude({ source: "vendor/missing.yaml" });
`,
      );
      const result = await build(dir, [k8sSerializer], undefined, {
        buildRoots: [(ctx) => includeBuildRoot({ projectRoot: dir, config: {}, entities: ctx.entities })],
      });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('k8sInclude "widgets" (vendor/missing.yaml): file not readable');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
