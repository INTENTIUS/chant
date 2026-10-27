/**
 * #4536: which CloudFormation types chant can import, from the registry
 * `handlers` codegen keeps, plus AWS's hand lists; and the adoption
 * refusals (not importable, create-only tags). Over an injected manifest.
 */
import { describe, expect, test } from "vitest";
import { NamingStrategy } from "./codegen/naming";
import { generateLexiconJSON } from "./codegen/generate-lexicon";
import { parseCFNSchema } from "./spec/parse";
import {
  adoptionRefusal,
  isImportable,
  LEGACY_IMPORTABLE_TYPES,
  NOT_IMPORTABLE_TYPES,
  type ImportabilityManifestEntry,
} from "./importable";

const entry = (resourceType: string, extra: Partial<ImportabilityManifestEntry> = {}): [string, ImportabilityManifestEntry] => [
  resourceType,
  { resourceType, kind: "resource", ...extra },
];
const ALL = ["create", "delete", "list", "read", "update"];
const manifest = new Map<string, ImportabilityManifestEntry>([
  entry("AWS::S3::Bucket", { handlers: ALL, tagging: { taggable: true, tagUpdatable: true } }),
  entry("AWS::EC2::KeyPair", { handlers: ALL, tagging: { taggable: true, tagUpdatable: false } }),
  entry("AWS::IAM::Policy", { handlers: ["create", "delete", "update"] }),
  entry("AWS::CodeBuild::Project"),
  entry("AWS::AppSync::GraphQLApi", { handlers: ALL }),
  entry("AWS::Logs::LogStream", { handlers: ["create", "read", "delete"] }),
]);

describe("isImportable (#4536)", () => {
  test("a type with create and read handlers is importable", () => {
    expect(isImportable("AWS::S3::Bucket", manifest)).toBe(true);
    expect(isImportable("AWS::Logs::LogStream", manifest)).toBe(true);
  });

  test("a type without read, or a legacy type with no handlers, is not", () => {
    expect(isImportable("AWS::IAM::Policy", manifest)).toBe(false);
    expect(isImportable("AWS::CodeBuild::Project", manifest)).toBe(false);
    expect(isImportable("AWS::Nope::Nope", manifest)).toBe(false);
  });

  test("AWS's hand lists win over the handlers", () => {
    expect(isImportable("AWS::AppSync::GraphQLApi", manifest)).toBe(false);
    for (const t of LEGACY_IMPORTABLE_TYPES) expect(isImportable(t, manifest)).toBe(true);
    for (const t of NOT_IMPORTABLE_TYPES) expect(LEGACY_IMPORTABLE_TYPES.has(t)).toBe(false);
  });
});

describe("adoptionRefusal (#4536)", () => {
  test("an importable type with updatable tags is adopted", () => {
    expect(adoptionRefusal("AWS::S3::Bucket", manifest)).toBeUndefined();
  });

  test("create-only tags are refused by name", () => {
    expect(adoptionRefusal("AWS::EC2::KeyPair", manifest)).toMatch(/AWS::EC2::KeyPair's tags can only be set at create/);
  });

  test("a type CloudFormation cannot import, or one the lexicon does not know, is refused", () => {
    expect(adoptionRefusal("AWS::IAM::Policy", manifest)).toMatch(/no create and read handlers/);
    expect(adoptionRefusal("AWS::AppSync::GraphQLApi", manifest)).toMatch(/not supporting resource import/);
    expect(adoptionRefusal("AWS::Nope::Nope", manifest)).toMatch(/not a type this aws lexicon generated/);
  });
});

describe("the lexicon generator keeps handlers (#4536)", () => {
  test("lexicon-aws.json carries each type's handler operations, and none for a legacy type", () => {
    const results = [
      parseCFNSchema(JSON.stringify({
        typeName: "AWS::Test::Handled",
        properties: { Name: { type: "string" } },
        primaryIdentifier: ["/properties/Name"],
        handlers: { create: { permissions: ["t:C"] }, read: { permissions: ["t:R"] }, delete: { permissions: [] } },
        additionalProperties: false,
      })),
      parseCFNSchema(JSON.stringify({ typeName: "AWS::Test::Legacy", properties: { Name: { type: "string" } }, additionalProperties: false })),
    ];
    const json = JSON.parse(generateLexiconJSON(results, new NamingStrategy(results), new Map(), null)) as Record<string, ImportabilityManifestEntry>;
    const byType = new Map(Object.values(json).filter((e) => e.kind === "resource").map((e) => [e.resourceType, e]));
    expect(byType.get("AWS::Test::Handled")?.handlers).toEqual(["create", "delete", "read"]);
    expect(byType.get("AWS::Test::Legacy")?.handlers).toBeUndefined();
    expect(isImportable("AWS::Test::Handled", byType)).toBe(true);
    expect(isImportable("AWS::Test::Legacy", byType)).toBe(false);
  });
});
