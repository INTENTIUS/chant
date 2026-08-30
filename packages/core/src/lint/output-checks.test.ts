import { describe, test, expect } from "vitest";
import { coreOutputChecks, STRINGIFIED_REFERENCE_CHECK_ID } from "./output-checks";
import { runPostSynthChecks } from "./post-synth";
import type { SerializerResult } from "../serializer";
import type { Declarable } from "../declarable";

function run(outputs: Map<string, string | SerializerResult>) {
  return runPostSynthChecks(coreOutputChecks(), {
    outputs,
    entities: new Map<string, Declarable>(),
    warnings: [],
    errors: [],
    sourceFileCount: 1,
  });
}

describe("COR025: stringified reference in serialized output (#1526)", () => {
  test("check id", () => {
    expect(STRINGIFIED_REFERENCE_CHECK_ID).toBe("COR025");
    expect(coreOutputChecks().map((c) => c.id)).toContain("COR025");
  });

  test("fires when a string output contains the [object Object] marker", () => {
    const outputs = new Map<string, string | SerializerResult>([
      ["aws", '{"Resource": "arn:aws:s3:::bucket-[object Object]/*"}'],
    ]);
    const diags = run(outputs);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("COR025");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].lexicon).toBe("aws");
    expect(diags[0].message).toContain("[object Object]");
  });

  test("fires when a SerializerResult's primary content contains the marker", () => {
    const outputs = new Map<string, string | SerializerResult>([
      ["aws", { primary: 'Resource: "[object Object]/*"' } satisfies SerializerResult],
    ]);
    const diags = run(outputs);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('Resource: "[object Object]/*"');
  });

  test("fires when a SerializerResult's nested file contains the marker, and names the file", () => {
    const outputs = new Map<string, string | SerializerResult>([
      [
        "aws",
        {
          primary: "clean template",
          files: { "network.template.json": '{"Resource": "[object Object]"}' },
        } satisfies SerializerResult,
      ],
    ]);
    const diags = run(outputs);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("network.template.json");
    expect(diags[0].message).toContain("[object Object]");
  });

  test("dedupes repeated occurrences of the same line within a file", () => {
    const line = 'Resource: "[object Object]/*"';
    const outputs = new Map<string, string | SerializerResult>([["aws", `${line}\n${line}\n${line}`]]);
    const diags = run(outputs);
    expect(diags).toHaveLength(1);
  });

  test("reports one diagnostic per distinct offending line", () => {
    const outputs = new Map<string, string | SerializerResult>([
      ["aws", 'Resource: "[object Object]/*"\nPolicy: "[object Object]"'],
    ]);
    const diags = run(outputs);
    expect(diags).toHaveLength(2);
  });

  test("passes: output with no stringified reference", () => {
    const outputs = new Map<string, string | SerializerResult>([
      ["aws", '{"Resource": "arn:aws:s3:::my-bucket/*"}'],
    ]);
    expect(run(outputs)).toHaveLength(0);
  });

  test("passes: empty outputs", () => {
    expect(run(new Map())).toHaveLength(0);
  });
});
