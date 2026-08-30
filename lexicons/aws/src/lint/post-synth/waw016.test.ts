import { describe, test, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw016, checkDeprecatedProperties, type DeprecationBasis } from "./waw016";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

function basisMap(entries: Array<[string, DeprecationBasis]>): Map<string, DeprecationBasis> {
  return new Map(entries);
}

/** Synthetic deprecated-property map — no disk dependency. */
function fakeDeprecated(): Map<string, Map<string, DeprecationBasis>> {
  return new Map([
    [
      "AWS::S3::Bucket",
      basisMap([
        ["AccessControl", "declared"],
        ["ObjectLockConfiguration", "declared"],
      ]),
    ],
    ["AWS::Lambda::Function", basisMap([["Code", "declared"]])],
  ]);
}

describe("WAW016: Deprecated Property Usage", () => {
  test("check metadata", () => {
    expect(waw016.id).toBe("WAW016");
    expect(waw016.description).toContain("Deprecated");
  });

  test("emits warning for deprecated property", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: {
            AccessControl: "LogDeliveryWrite",
            BucketName: "my-bucket",
          },
        },
      },
    });
    const diags = checkDeprecatedProperties(ctx, fakeDeprecated());
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW016");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("AccessControl");
    expect(diags[0].message).toContain("MyBucket");
    expect(diags[0].message).toContain("deprecated");
    expect(diags[0].entity).toBe("MyBucket");
    expect(diags[0].lexicon).toBe("aws");
  });

  test("emits one warning per deprecated property", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: {
            AccessControl: "Private",
            ObjectLockConfiguration: {},
          },
        },
      },
    });
    const diags = checkDeprecatedProperties(ctx, fakeDeprecated());
    expect(diags).toHaveLength(2);
    const props = diags.map((d) => d.message);
    expect(props.some((m) => m.includes("AccessControl"))).toBe(true);
    expect(props.some((m) => m.includes("ObjectLockConfiguration"))).toBe(true);
  });

  test("no diagnostic for non-deprecated properties", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: {
            BucketName: "clean-bucket",
            VersioningConfiguration: { Status: "Enabled" },
          },
        },
      },
    });
    const diags = checkDeprecatedProperties(ctx, fakeDeprecated());
    expect(diags).toHaveLength(0);
  });

  test("no diagnostic for resource type not in map", () => {
    const ctx = makeCtx({
      Resources: {
        MyRole: {
          Type: "AWS::IAM::Role",
          Properties: { RoleName: "test" },
        },
      },
    });
    const diags = checkDeprecatedProperties(ctx, fakeDeprecated());
    expect(diags).toHaveLength(0);
  });

  test("no diagnostic on empty template", () => {
    const ctx = makeCtx({ Resources: {} });
    const diags = checkDeprecatedProperties(ctx, fakeDeprecated());
    expect(diags).toHaveLength(0);
  });

  test("handles resource with no Properties", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: { Type: "AWS::S3::Bucket" },
      },
    });
    const diags = checkDeprecatedProperties(ctx, fakeDeprecated());
    expect(diags).toHaveLength(0);
  });

  test("returns empty when deprecated map is empty", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: { AccessControl: "Private" },
        },
      },
    });
    const diags = checkDeprecatedProperties(ctx, new Map());
    expect(diags).toHaveLength(0);
  });

  test("flags deprecated properties across multiple resources", () => {
    const ctx = makeCtx({
      Resources: {
        Bucket: {
          Type: "AWS::S3::Bucket",
          Properties: { AccessControl: "Private" },
        },
        Func: {
          Type: "AWS::Lambda::Function",
          Properties: { Code: {} },
        },
      },
    });
    const diags = checkDeprecatedProperties(ctx, fakeDeprecated());
    expect(diags).toHaveLength(2);
    expect(diags[0].entity).toBe("Bucket");
    expect(diags[1].entity).toBe("Func");
  });

  // --- Deprecation basis (#1701) ---

  test("an inferred deprecation reports at info and names its basis", () => {
    const ctx = makeCtx({
      Resources: {
        Func: {
          Type: "AWS::Lambda::Function",
          Properties: { Runtime: "nodejs20.x" },
        },
      },
    });
    const deprecated = new Map([
      ["AWS::Lambda::Function", basisMap([["Runtime", "inferred"]])],
    ]);
    const diags = checkDeprecatedProperties(ctx, deprecated);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW016");
    expect(diags[0].severity).toBe("info");
    expect(diags[0].message).toContain("Runtime");
    expect(diags[0].message).toContain("does not declare it deprecated");
  });

  test("declared and inferred deprecations on one resource keep separate severities", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: { AccessControl: "Private", ObjectLockConfiguration: {} },
        },
      },
    });
    const deprecated = new Map([
      [
        "AWS::S3::Bucket",
        basisMap([
          ["AccessControl", "declared"],
          ["ObjectLockConfiguration", "inferred"],
        ]),
      ],
    ]);
    const diags = checkDeprecatedProperties(ctx, deprecated);
    expect(diags).toHaveLength(2);
    const bySeverity = new Map(diags.map((d) => [d.severity, d.message]));
    expect(bySeverity.get("warning")).toContain("AccessControl");
    expect(bySeverity.get("info")).toContain("ObjectLockConfiguration");
  });

  // --- Nested pointer paths (#1988) ---

  test("a Tags/TagKey entry matches the key inside the Tags array", () => {
    const ctx = makeCtx({
      Resources: {
        Block: {
          Type: "AWS::AppStream::AppBlock",
          Properties: {
            Name: "block",
            Tags: [{ TagKey: "team", TagValue: "platform" }],
          },
        },
      },
    });
    const deprecated = new Map([
      ["AWS::AppStream::AppBlock", basisMap([["Tags/TagKey", "declared"], ["Tags/TagValue", "declared"]])],
    ]);
    const diags = checkDeprecatedProperties(ctx, deprecated);
    expect(diags).toHaveLength(2);
    expect(diags.map((d) => d.message).join(" ")).toContain("Tags/TagKey");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].entity).toBe("Block");
  });

  test("a Tags array carrying only the current keys is clean", () => {
    const ctx = makeCtx({
      Resources: {
        Block: {
          Type: "AWS::AppStream::AppBlock",
          Properties: { Tags: [{ Key: "team", Value: "platform" }] },
        },
      },
    });
    const deprecated = new Map([
      ["AWS::AppStream::AppBlock", basisMap([["Tags/TagKey", "declared"]])],
    ]);
    expect(checkDeprecatedProperties(ctx, deprecated)).toHaveLength(0);
  });

  test("a nested object path matches", () => {
    const ctx = makeCtx({
      Resources: {
        Flow: {
          Type: "AWS::MediaConnect::Flow",
          Properties: {
            Source: { Name: "src", Decryption: { Url: "https://example.invalid" } },
          },
        },
      },
    });
    const deprecated = new Map([
      ["AWS::MediaConnect::Flow", basisMap([["Source/Decryption/Url", "declared"], ["Source/SenderIpAddress", "declared"]])],
    ]);
    const diags = checkDeprecatedProperties(ctx, deprecated);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Source/Decryption/Url");
  });

  test("a wildcard segment requires an array member that carries the property", () => {
    const deprecated = new Map([
      ["AWS::EC2::SecurityGroup", basisMap([["SecurityGroupEgress/*/SourceSecurityGroupId", "declared"]])],
    ]);
    const hit = makeCtx({
      Resources: {
        Sg: {
          Type: "AWS::EC2::SecurityGroup",
          Properties: {
            SecurityGroupEgress: [{ IpProtocol: "tcp" }, { IpProtocol: "tcp", SourceSecurityGroupId: "sg-1" }],
          },
        },
      },
    });
    expect(checkDeprecatedProperties(hit, deprecated)).toHaveLength(1);

    const miss = makeCtx({
      Resources: {
        Sg: {
          Type: "AWS::EC2::SecurityGroup",
          Properties: { SecurityGroupEgress: [{ IpProtocol: "tcp" }] },
        },
      },
    });
    expect(checkDeprecatedProperties(miss, deprecated)).toHaveLength(0);
  });

  test("a nested path is not matched by a same-named top-level key", () => {
    const ctx = makeCtx({
      Resources: {
        Insight: {
          Type: "AWS::SecurityHub::Insight",
          Properties: { Keyword: "unused-top-level" },
        },
      },
    });
    const deprecated = new Map([
      ["AWS::SecurityHub::Insight", basisMap([["Filters/Keyword", "declared"]])],
    ]);
    expect(checkDeprecatedProperties(ctx, deprecated)).toHaveLength(0);
  });
});

/**
 * The reachability count (#1988). Over half the declared names carry a nested
 * pointer path, and a flattening regression makes them silently unmatchable
 * rather than failing anything — so the count of unreachable names is pinned
 * against the real generated data.
 */
describe("WAW016: declared deprecation reachability", () => {
  const pkgDir = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
  const lexiconPath = join(pkgDir, "src", "generated", "lexicon-aws.json");
  const hasGenerated = existsSync(lexiconPath);

  interface Entry {
    kind?: string;
    resourceType?: string;
    deprecatedProperties?: string[];
    inferredDeprecations?: string[];
  }

  /** A path a template can express: named segments and array wildcards, no JSON Schema keywords. */
  function isTemplatePath(path: string): boolean {
    const segments = path.split("/");
    if (segments.length === 0 || segments[0] === "" || segments[0] === "*") return false;
    return segments.every((s) => s === "*" || (s.length > 0 && s !== "properties" && s !== "definitions"));
  }

  test.skipIf(!hasGenerated)("every declared deprecated name is a path a template can express", () => {
    const data = JSON.parse(readFileSync(lexiconPath, "utf-8")) as Record<string, Entry>;
    const declared: string[] = [];
    for (const entry of Object.values(data)) {
      if (entry.kind !== "resource" || !entry.resourceType) continue;
      const inferred = new Set(entry.inferredDeprecations ?? []);
      for (const name of entry.deprecatedProperties ?? []) {
        if (!inferred.has(name)) declared.push(`${entry.resourceType} :: ${name}`);
      }
    }

    const nested = declared.filter((d) => d.split(" :: ")[1].includes("/"));
    const unreachable = declared.filter((d) => !isTemplatePath(d.split(" :: ")[1]));

    // The spec pin moves, so the totals are a floor rather than an exact
    // figure; the unreachable count is the one that must stay at zero.
    expect(declared.length).toBeGreaterThan(0);
    expect(nested.length).toBeGreaterThan(declared.length / 2);
    expect(unreachable).toEqual([]);
  });
});
