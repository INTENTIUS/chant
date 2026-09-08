/**
 * A budget on the `any`s in the generated declaration (chant #2205).
 *
 * `Tags?: any` accepts `Tags: 7`, so every `any` in the surface is a property
 * chant does not check. The count is asserted rather than merely reported so
 * that the next drop is a deliberate edit to this file, and so a resolver
 * change that quietly widens the surface fails here.
 *
 * The declaration is gitignored and written by `npm run generate`, so this
 * skips on a checkout that has not generated yet.
 */
import { describe, test, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const dtsPath = join(pkgDir, "src/generated/index.d.ts");

/**
 * What remains after #2205's three resolver gaps closed, by cause:
 * 161 `$ref`s to a definition that is nothing but a `oneOf`/`anyOf` of object
 * branches (a real sum type, deferred to #2278), 20 properties that declare no
 * type at all, 8 that `$ref` an empty definition, 8 that carry a branch list
 * with nothing beside it, one upstream `$ref` to an undeclared definition, and
 * one `$ref` to a definition that is itself a bare `$ref`. Plus 38
 * non-constructor `any`s (readonly attributes and intrinsic return types).
 */
const ANY_BUDGET = 226;
const ANY_ARRAY_BUDGET = 20;

describe.skipIf(!existsSync(dtsPath))("generated `any` budget", () => {
  const dts = existsSync(dtsPath) ? readFileSync(dtsPath, "utf-8") : "";
  const count = (re: RegExp) => (dts.match(re) ?? []).length;

  test("the `: any;` count has not grown", () => {
    expect(count(/: any;/g)).toBeLessThanOrEqual(ANY_BUDGET);
  });

  test("the `: any[];` count has not grown", () => {
    expect(count(/: any\[\];/g)).toBeLessThanOrEqual(ANY_ARRAY_BUDGET);
  });

  test("a list definition resolves through its items", () => {
    // AWS::Panorama::ApplicationInstance.Tags is a $ref to a TagList
    // definition whose items are the Tag definition one hop away.
    expect(dts).toContain("Tags?: ApplicationInstance_Tag[];");
  });

  test("a branch list beside a type does not erase the type", () => {
    // AWS::AmazonMQ::Broker.EngineType carries `type: "string"` beside an
    // anyOf whose first branch is the enum.
    expect(dts).toContain('EngineType: "ACTIVEMQ" | "RABBITMQ";');
  });

  test("an allOf of one $ref and an annotation resolves as the $ref", () => {
    // AWS::BedrockAgentCore::Gateway.ProtocolType
    expect(dts).toContain("ProtocolType?: BedrockAgentCoreGateway_GatewayProtocolType;");
    expect(dts).toContain('export type BedrockAgentCoreGateway_GatewayProtocolType = "MCP";');
  });

  test("no union sits unparenthesized inside an array", () => {
    // `[]` binds tighter than `|`: `"a" | "b"[]` accepts the bare string "a".
    expect(dts).not.toMatch(/: "[^;\n]*" \| [^;\n()]*\[\];/);
  });
});
