/**
 * The `capabilities` document of the read contract (#4375): its schema, the
 * document `chant search --capabilities --json` prints, and its failure.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { contract, validSchema } from "./__fixtures__/contract-repo";
import { READ_CONTRACT_FLOOR, READ_CONTRACT_VERSION, REASONS } from "./reason-codes";
import { CAPABILITIES_OUTPUT_SCHEMA_ID, CAPABILITY_SUPPORT_CODES, capabilitiesDocument, capabilitiesFailure, formatCapabilities } from "./capabilities-contract";
import { READ_CONTRACT_COMMANDS, READ_CONTRACT_SCHEMAS, MCP_READ_TOOLS, mcpToolCall } from "./conformance";
import schema from "./capabilities.schema.json";

const { expectValid } = contract(schema);

/** The lexicons' mappings as they ship them, read as data: loading a lexicon's plugin takes seconds. */
const LEXICONS = join(import.meta.dirname, "..", "..", "..", "..", "lexicons");
const load = async (name: string) => {
  if (name !== "aws" && name !== "terraform") throw new Error(`no lexicon ${name}`);
  return { capabilityPack: { mapping: JSON.parse(readFileSync(join(LEXICONS, name, "src", "capabilities", "mapping.json"), "utf-8")) } };
};

describe("capabilities.schema.json", () => {
  test("is a valid draft 2020-12 document at the contract version, naming the floor", () => {
    expect(validSchema(schema)).toBe(true);
    expect(schema.$id).toBe(CAPABILITIES_OUTPUT_SCHEMA_ID);
    expect(schema.$id).toBe(`https://intentius.io/chant/schemas/workspace/capabilities/v${READ_CONTRACT_VERSION}/capabilities.schema.json`);
    for (const branch of ["result", "failure"] as const) {
      const props = (schema.$defs as Record<string, { properties: Record<string, unknown> }>)[branch].properties;
      expect(props.contract).toEqual({ const: READ_CONTRACT_VERSION });
      expect(props.$schema).toEqual({ const: schema.$id });
    }
    expect(schema.description).toContain(`chant ${READ_CONTRACT_FLOOR} and newer`);
  });

  test("names each support code in the closed list", () => {
    for (const code of CAPABILITY_SUPPORT_CODES) expect(Object.keys(REASONS)).toContain(code);
  });

  test("is in the conformance suite as workspace search --capabilities, served by the capabilities MCP tool", () => {
    expect(READ_CONTRACT_COMMANDS).toContain("search --capabilities");
    expect(READ_CONTRACT_SCHEMAS["search --capabilities"]).toBe("capabilities.schema.json");
    expect(MCP_READ_TOOLS["search --capabilities"]).toBe("capabilities");
    expect(mcpToolCall(["workspace", "search", "--capabilities", "--json"])).toEqual({ name: "capabilities", arguments: {} });
    expect(mcpToolCall(["workspace", "search", "app", "--capabilities", "--json"])).toBeUndefined();
  });
});

describe("the document", () => {
  test("lists the fifteen capabilities with a support statement for each lexicon asked about", async () => {
    const doc = await capabilitiesDocument(["aws", "terraform", "no-such-lexicon"], load);
    expectValid(doc);
    expect(doc.contract).toBe(1);
    expect(doc.capabilities).toHaveLength(16);
    const reaches = doc.capabilities.find((c) => c.name === "reaches")!;
    expect(reaches).toMatchObject({
      shape: "edge",
      search: "->[cap=reaches]",
      depth: "declared",
      params: [{ name: "action", optional: true }],
      uses: ["can-assume", "grants"],
      lexicons: {
        aws: "supported",
        terraform: "supported",
        "no-such-lexicon": { code: "lexicon-not-loaded" },
      },
    });
    expect(reaches.rule).toBe("reaches(r, x; action?) := r:Role ->{0,}can-assume ->grants($action) x");
    expect(reaches.notEvaluated).toContain('Resource "*"');
    expect(doc.helpers.map((h) => h.name)).toEqual(["in-sg", "ingress-of", "world-open", "allows", "denies", "pivot"]);
    for (const c of doc.capabilities) {
      expect(c.answers.length, c.name).toBeGreaterThan(0);
      expect(c.search, c.name).toBe(c.shape === "set" ? `cap:${c.name}` : `->[cap=${c.name}]`);
    }
  });

  test("prints as text, a line per capability with its parameters", async () => {
    const lines = formatCapabilities(await capabilitiesDocument([], load));
    expect(lines[0]).toMatch(/^cap:internet-facing +set +its subnet routes 0\.0\.0\.0\/0 to an internet gateway$/);
    expect(lines).toContainEqual(expect.stringMatching(/^ +port\?: a port the open rule must cover, such as 22$/));
    expect(lines.at(-1)).toBe("— 16 capabilities · --json prints each rule");
  });

  test("a refusal is a failure document with a code", async () => {
    const doc = await capabilitiesFailure({ code: "usage-invalid", message: "m" });
    expectValid(doc);
  });
});
