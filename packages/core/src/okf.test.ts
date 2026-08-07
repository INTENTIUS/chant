import { describe, test, expect } from "vitest";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOkfBundle, splitFrontmatter, OKF_VERSION, type OkfFile } from "./okf";
import { DECLARABLE_MARKER, type Declarable } from "./declarable";
import { setProvenance } from "./provenance";
import { parseYAML } from "./yaml";
import { discover } from "./discovery/index";

function decl<T extends object>(base: T): Declarable & T {
  return { [DECLARABLE_MARKER]: true, ...base } as Declarable & T;
}

function fileMap(bundle: OkfFile[]): Map<string, string> {
  return new Map(bundle.map((f) => [f.path, f.content]));
}

/**
 * Assert the four OKF v0.2 conformance criteria (spec §11) over a bundle:
 * parseable frontmatter everywhere, non-empty `type` everywhere, reserved
 * files well-formed when present, and nothing a consumer is required to
 * reject on.
 */
function assertConformant(bundle: OkfFile[]): void {
  const reserved = new Set(["index.md", "log.md"]);
  for (const file of bundle) {
    expect(file.path.endsWith(".md")).toBe(true);
    // Bundle-relative paths, never absolute or escaping.
    expect(file.path.startsWith("/")).toBe(false);
    expect(file.path).not.toContain("..");

    if (reserved.has(basename(file.path))) continue;

    // 1. Every non-reserved .md has a parseable YAML frontmatter block.
    const split = splitFrontmatter(file.content);
    expect(split, `${file.path} has no frontmatter block`).toBeDefined();
    const parsed = parseYAML(split!.frontmatter);
    expect(typeof parsed).toBe("object");

    // 2. Every frontmatter block carries a non-empty `type`.
    expect(typeof parsed.type, `${file.path} has no type`).toBe("string");
    expect((parsed.type as string).length).toBeGreaterThan(0);

    // 4. No rejection-triggering shape: cross-links are bundle-relative
    // markdown links (broken targets are permitted, malformed links are not).
    for (const match of split!.body.matchAll(/\]\(([^)]+)\)/g)) {
      expect(match[1].startsWith("/")).toBe(true);
    }
  }

  // 3. Reserved files well-formed when present: the root index.md carries at
  // most an `okf_version` frontmatter key (the only frontmatter an index is
  // allowed) and section headings with link entries.
  const index = bundle.find((f) => f.path === "index.md");
  expect(index).toBeDefined();
  const split = splitFrontmatter(index!.content);
  expect(split).toBeDefined();
  expect(parseYAML(split!.frontmatter)).toEqual({ okf_version: OKF_VERSION });
  for (const line of split!.body.split("\n")) {
    if (line.startsWith("*")) expect(line).toMatch(/^\* \[[^\]]+\]\([^)]+\) - .+$/);
  }
}

describe("buildOkfBundle", () => {
  test("emits one concept per entity with parseable frontmatter and a non-empty type", () => {
    const bucket = decl({ lexicon: "aws", entityType: "AWS::S3::Bucket", kind: "resource" as const });
    setProvenance(bucket, { sourceFile: "/proj/src/storage.ts" });
    const vpc = decl({ lexicon: "gcp", entityType: "Vpc" });
    const entities = new Map<string, Declarable>([
      ["myBucket", bucket],
      ["vpc", vpc],
    ]);

    const bundle = buildOkfBundle({ entities, dependencies: new Map() }, "/proj");
    const files = fileMap(bundle);
    expect([...files.keys()]).toEqual(["aws/myBucket.md", "gcp/vpc.md", "index.md"]);

    const concept = splitFrontmatter(files.get("aws/myBucket.md")!)!;
    const front = parseYAML(concept.frontmatter);
    expect(front.type).toBe("AWS::S3::Bucket");
    expect(front.title).toBe("myBucket");
    expect(front.lexicon).toBe("aws");
    expect(front.kind).toBe("resource");
    expect(front.source).toBe("src/storage.ts");
    expect(concept.body).toContain("Declared in `src/storage.ts`.");
  });

  test("dependency edges become bundle-relative markdown links, both directions", () => {
    const vpc = decl({ lexicon: "gcp", entityType: "Vpc" });
    const subnet = decl({ lexicon: "gcp", entityType: "Subnet" });
    const entities = new Map<string, Declarable>([
      ["vpc", vpc],
      ["subnet", subnet],
    ]);
    const dependencies = new Map([["subnet", new Set(["vpc"])]]);

    const files = fileMap(buildOkfBundle({ entities, dependencies }));
    expect(files.get("gcp/subnet.md")).toContain("## Depends on");
    expect(files.get("gcp/subnet.md")).toContain("- [vpc](/gcp/vpc.md)");
    expect(files.get("gcp/vpc.md")).toContain("## Referenced by");
    expect(files.get("gcp/vpc.md")).toContain("- [subnet](/gcp/subnet.md)");
  });

  test("an unresolved dependency emits a link rather than failing — broken links are permitted", () => {
    const app = decl({ lexicon: "k8s", entityType: "Deployment" });
    const entities = new Map<string, Declarable>([["app", app]]);
    const dependencies = new Map([["app", new Set(["ghost"])]]);

    const bundle = buildOkfBundle({ entities, dependencies });
    expect(fileMap(bundle).get("k8s/app.md")).toContain("- [ghost](/ghost.md)");
    assertConformant(bundle);
  });

  test("index.md groups entities into per-lexicon sections with okf_version frontmatter", () => {
    const bucket = decl({ lexicon: "aws", entityType: "AWS::S3::Bucket" });
    const job = decl({ lexicon: "gitlab", entityType: "GitLab::Job" });
    const entities = new Map<string, Declarable>([
      ["assets", bucket],
      ["buildJob", job],
    ]);

    const index = fileMap(buildOkfBundle({ entities, dependencies: new Map() })).get("index.md")!;
    expect(index).toContain(`okf_version: '${OKF_VERSION}'`);
    expect(index).toContain("# Lexicon: aws");
    expect(index).toContain("# Lexicon: gitlab");
    expect(index).toContain("* [assets](/aws/assets.md) - aws resource of type AWS::S3::Bucket");
    expect(index).toContain("* [buildJob](/gitlab/buildJob.md) - gitlab resource of type GitLab::Job");
  });

  test("composite provenance rides along as extra frontmatter keys", () => {
    const dep = decl({ lexicon: "k8s", entityType: "K8s::Apps::Deployment" });
    setProvenance(dep, { sourceFile: "/proj/src/web.ts", composite: "WebApp", compositeInstance: "prodApp" });
    const entities = new Map<string, Declarable>([["prodAppDeployment", dep]]);

    const front = parseYAML(
      splitFrontmatter(fileMap(buildOkfBundle({ entities, dependencies: new Map() }, "/proj")).get("k8s/prodAppDeployment.md")!)!.frontmatter,
    );
    expect(front.composite).toBe("WebApp");
    expect(front.composite_instance).toBe("prodApp");
  });

  test("entity names that slug to the same path are deduped, never overwritten", () => {
    const a = decl({ lexicon: "aws", entityType: "AWS::S3::Bucket" });
    const b = decl({ lexicon: "aws", entityType: "AWS::S3::Bucket" });
    const entities = new Map<string, Declarable>([
      ["my/bucket", a],
      ["my-bucket", b],
    ]);

    const paths = buildOkfBundle({ entities, dependencies: new Map() }).map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain("aws/my-bucket.md");
    expect(paths).toContain("aws/my-bucket-2.md");
  });

  test("an empty project still emits a conformant bundle (just the index)", () => {
    const bundle = buildOkfBundle({ entities: new Map(), dependencies: new Map() });
    expect(bundle.map((f) => f.path)).toEqual(["index.md"]);
    assertConformant(bundle);
  });

  test("deterministic: the same input yields byte-identical files", () => {
    const vpc = decl({ lexicon: "gcp", entityType: "Vpc" });
    const subnet = decl({ lexicon: "gcp", entityType: "Subnet" });
    const entities = new Map<string, Declarable>([
      ["vpc", vpc],
      ["subnet", subnet],
    ]);
    const dependencies = new Map([["subnet", new Set(["vpc"])]]);

    expect(buildOkfBundle({ entities, dependencies })).toEqual(buildOkfBundle({ entities, dependencies }));
  });
});

// ---------------------------------------------------------------------------
// Shipped examples, spanning lexicons (#1058 acceptance): each bundle is
// asserted conformant against the four v0.2 criteria and snapshot-tested.
// ---------------------------------------------------------------------------

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../../..");

const exampleCases: Array<[string, string]> = [
  ["k8s layered-config", "lexicons/k8s/examples/layered-config/src"],
  ["aws lambda-s3", "lexicons/aws/examples/lambda-s3/src"],
  ["gitlab node-pipeline", "lexicons/gitlab/examples/node-pipeline/src"],
];

describe("buildOkfBundle over shipped examples", () => {
  for (const [name, rel] of exampleCases) {
    test(`${name} emits a conformant, snapshot-stable bundle`, async () => {
      const projectPath = resolve(repoRoot, rel);
      const result = await discover(projectPath);
      expect(result.errors).toEqual([]);
      expect(result.entities.size).toBeGreaterThan(0);

      const bundle = buildOkfBundle(result, projectPath);
      assertConformant(bundle);
      expect(bundle).toMatchSnapshot();
    });
  }
});
