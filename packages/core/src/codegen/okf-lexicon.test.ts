import { describe, test, expect } from "vitest";
import { buildLexiconOkfBundle, type LexiconOkfInput } from "./okf-lexicon";
import { okfConformanceProblems, splitFrontmatter, OKF_VERSION, type OkfFile } from "../okf";
import { parseYAML } from "../yaml";

function fileMap(bundle: OkfFile[]): Map<string, string> {
  return new Map(bundle.map((f) => [f.path, f.content]));
}

/** A docker-style registry: descriptions carried in the registry itself. */
const registryStyleInput: LexiconOkfInput = {
  name: "mockdocker",
  registry: JSON.stringify({
    Service: {
      resourceType: "Mock::Compose::Service",
      kind: "resource",
      description: "A containerized service definition",
      properties: {
        image: { type: "string", description: "Container image to use" },
        ports: { type: "string[]", description: "Published ports" },
      },
    },
    Volume: {
      resourceType: "Mock::Compose::Volume",
      kind: "resource",
      description: "A named volume",
      properties: { driver: { type: "string", description: "Volume driver" } },
    },
    Service_Healthcheck: {
      resourceType: "Mock::Compose::Service.Healthcheck",
      kind: "property",
    },
  }),
  typesDTS: "",
  rules: [
    {
      meta: {
        id: "MCK001",
        severity: "warning",
        category: "correctness",
        description: "Avoid :latest image references on a Service",
        type: "lint",
      },
      source: `// Checks each Service's image prop\nexport const rule = { id: "MCK001" };`,
    },
    {
      meta: {
        id: "MCK010",
        severity: "error",
        category: "post-synth",
        description: "A declared Volume must be mounted somewhere",
        type: "post-synth",
      },
      source: `export const check = { id: "MCK010", description: "..." }; // walks Volume mounts`,
    },
  ],
};

/** A CFN-style registry: no descriptions, JSDoc lives in the declarations. */
const dtsStyleInput: LexiconOkfInput = {
  name: "mockaws",
  registry: JSON.stringify({
    Bucket: {
      resourceType: "Mock::S3::Bucket",
      kind: "resource",
      lexicon: "mockaws",
      attrs: { Arn: "Arn", DomainName: "DomainName" },
    },
    // An alias entry for the same resource type must not mint a second concept.
    S3Bucket: {
      resourceType: "Mock::S3::Bucket",
      kind: "resource",
      lexicon: "mockaws",
      attrs: { Arn: "Arn", DomainName: "DomainName" },
    },
    Bucket_VersioningConfiguration: {
      resourceType: "Mock::S3::Bucket.VersioningConfiguration",
      kind: "property",
      lexicon: "mockaws",
    },
  }),
  typesDTS: [
    "export declare class Bucket {",
    "  constructor(props: {",
    "    /** A name for the bucket. */",
    "    BucketName?: string;",
    "    /** The versioning state. */",
    "    VersioningConfiguration?: Bucket_VersioningConfiguration;",
    "  }, attributes?: Record<string, unknown>);",
    "  readonly Arn: string;",
    "}",
  ].join("\n"),
  rules: [
    {
      meta: {
        id: "MAW006",
        severity: "warning",
        category: "security",
        description: "Detects Bucket creation without encryption",
        type: "lint",
      },
      source: `if (expression.text === "Bucket") { /* Mock::S3::Bucket */ }`,
    },
  ],
};

describe("buildLexiconOkfBundle", () => {
  test("emits a conformant bundle from a registry-described lexicon", () => {
    const bundle = buildLexiconOkfBundle(registryStyleInput);
    expect(okfConformanceProblems(bundle)).toEqual([]);
    expect(bundle.map((f) => f.path)).toEqual([
      "index.md",
      "rules/MCK001.md",
      "rules/MCK010.md",
      "types/Service.md",
      "types/Volume.md",
    ]);
  });

  test("concept type is the category, the resource type rides in resource_type", () => {
    const files = fileMap(buildLexiconOkfBundle(registryStyleInput));
    const front = parseYAML(splitFrontmatter(files.get("types/Service.md")!)!.frontmatter);
    expect(front.type).toBe("resource-type");
    expect(front.resource_type).toBe("Mock::Compose::Service");
    expect(front.title).toBe("Service");
    expect(front.lexicon).toBe("mockdocker");
    expect(front.description).toBe("A containerized service definition");
  });

  test("registry-carried property descriptions land in the concept body", () => {
    const files = fileMap(buildLexiconOkfBundle(registryStyleInput));
    const body = splitFrontmatter(files.get("types/Service.md")!)!.body;
    expect(body).toContain("## Properties");
    expect(body).toContain("- `image` (`string`): Container image to use");
    expect(body).toContain("- `ports` (`string[]`): Published ports");
  });

  test("declaration JSDoc fills in property descriptions when the registry has none", () => {
    const files = fileMap(buildLexiconOkfBundle(dtsStyleInput));
    const body = splitFrontmatter(files.get("types/Bucket.md")!)!.body;
    expect(body).toContain("- `BucketName` (`string`, optional): A name for the bucket.");
    expect(body).toContain("- `VersioningConfiguration` (`Bucket_VersioningConfiguration`, optional): The versioning state.");
    expect(body).toContain("## Attributes");
    expect(body).toContain("- `Arn`");
  });

  test("rules and resource types cross-link in both directions", () => {
    const files = fileMap(buildLexiconOkfBundle(registryStyleInput));
    expect(splitFrontmatter(files.get("types/Service.md")!)!.body).toContain(
      "- [MCK001](/rules/MCK001.md): Avoid :latest image references on a Service",
    );
    expect(splitFrontmatter(files.get("rules/MCK001.md")!)!.body).toContain("- [Service](/types/Service.md)");
    // MCK010 mentions Volume, not Service.
    expect(splitFrontmatter(files.get("rules/MCK010.md")!)!.body).toContain("- [Volume](/types/Volume.md)");
    expect(splitFrontmatter(files.get("rules/MCK010.md")!)!.body).not.toContain("types/Service.md");
    expect(splitFrontmatter(files.get("types/Volume.md")!)!.body).toContain("- [MCK010](/rules/MCK010.md)");
  });

  test("rule concepts carry id, severity, category, and a docs page", () => {
    const files = fileMap(buildLexiconOkfBundle(registryStyleInput));
    const lint = parseYAML(splitFrontmatter(files.get("rules/MCK001.md")!)!.frontmatter);
    expect(lint.type).toBe("lint-rule");
    expect(lint.id).toBe("MCK001");
    expect(lint.severity).toBe("warning");
    expect(lint.category).toBe("correctness");
    expect(lint.docs).toBe("https://intentius.io/chant/lexicons/mockdocker/rules/");

    const postSynth = parseYAML(splitFrontmatter(files.get("rules/MCK010.md")!)!.frontmatter);
    expect(postSynth.type).toBe("post-synth-check");
    expect(postSynth.severity).toBe("error");
  });

  test("alias registry entries collapse into one concept per resource type", () => {
    const bundle = buildLexiconOkfBundle(dtsStyleInput);
    const typePaths = bundle.map((f) => f.path).filter((p) => p.startsWith("types/"));
    expect(typePaths).toEqual(["types/Bucket.md"]);
    expect(okfConformanceProblems(bundle)).toEqual([]);
  });

  test("property-kind registry entries do not become concepts", () => {
    const files = fileMap(buildLexiconOkfBundle(registryStyleInput));
    expect([...files.keys()].some((p) => p.includes("Healthcheck"))).toBe(false);
  });

  test("index.md sections resource types and rules with okf_version its only frontmatter", () => {
    const index = fileMap(buildLexiconOkfBundle(registryStyleInput)).get("index.md")!;
    expect(index).toContain(`okf_version: '${OKF_VERSION}'`);
    expect(index).toContain("# Resource types");
    expect(index).toContain("* [Service](/types/Service.md) - Mock::Compose::Service");
    expect(index).toContain("# Rules");
    expect(index).toContain("* [MCK001](/rules/MCK001.md) - Avoid :latest image references on a Service");
  });

  test("an empty lexicon still emits a conformant bundle", () => {
    const bundle = buildLexiconOkfBundle({ name: "bare", registry: "{}", typesDTS: "", rules: [] });
    expect(bundle.map((f) => f.path)).toEqual(["index.md"]);
    expect(okfConformanceProblems(bundle)).toEqual([]);
  });

  test("deterministic: the same input yields byte-identical files", () => {
    expect(buildLexiconOkfBundle(registryStyleInput)).toEqual(buildLexiconOkfBundle(registryStyleInput));
  });

  test("multi-line spec descriptions collapse to a single frontmatter line", () => {
    const input: LexiconOkfInput = {
      name: "mock",
      registry: JSON.stringify({
        Thing: {
          resourceType: "Mock::A::Thing",
          kind: "resource",
          description: "First line.\nSecond line with detail.",
        },
      }),
      typesDTS: "",
      rules: [],
    };
    const bundle = buildLexiconOkfBundle(input);
    expect(okfConformanceProblems(bundle)).toEqual([]);
    const front = parseYAML(splitFrontmatter(fileMap(bundle).get("types/Thing.md")!)!.frontmatter);
    expect(front.description).toBe("First line. Second line with detail.");
  });

  test("registry-style and dts-style bundles snapshot stably", () => {
    expect(buildLexiconOkfBundle(registryStyleInput)).toMatchSnapshot();
    expect(buildLexiconOkfBundle(dtsStyleInput)).toMatchSnapshot();
  });
});

describe("okfConformanceProblems", () => {
  test("flags a concept without frontmatter and a bundle without an index", () => {
    const problems = okfConformanceProblems([{ path: "types/Broken.md", content: "no frontmatter here" }]);
    expect(problems).toContain("types/Broken.md: no frontmatter block");
    expect(problems).toContain("bundle has no root index.md");
  });

  test("flags an empty type and a relative cross-link", () => {
    const bundle: OkfFile[] = [
      {
        path: "types/Bad.md",
        content: "---\ntype: ''\n---\n\n- [x](x.md)\n",
      },
      { path: "index.md", content: `---\nokf_version: '${OKF_VERSION}'\n---\n` },
    ];
    const problems = okfConformanceProblems(bundle);
    expect(problems.some((p) => p.includes("no non-empty type"))).toBe(true);
    expect(problems.some((p) => p.includes('link target "x.md"'))).toBe(true);
  });
});
