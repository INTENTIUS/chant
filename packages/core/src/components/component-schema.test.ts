/**
 * Validates the Component JSON Schema (draft 2020-12) itself, plus every
 * fixture under __fixtures__/ against it.
 *
 * The schema is the portable contract described in
 * docs/src/content/docs/components/component-contract.mdx and
 * composition-and-wiring.mdx — see #551 (epic) and #553 (this schema).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import componentSchema from "./component.schema.json";

const FIXTURES_DIR = join(import.meta.dirname, "__fixtures__");

function loadFixtures(): Array<{ name: string; data: unknown }> {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((name) => ({
      name,
      data: JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf-8")),
    }));
}

describe("Component JSON Schema", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(componentSchema);

  it("is itself a valid draft 2020-12 schema document", () => {
    expect(componentSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(ajv.validateSchema(componentSchema)).toBe(true);
  });

  it("has a stable $id and a contract version", () => {
    expect(componentSchema.$id).toBe(
      "https://intentius.io/chant/schemas/component/v1/component.schema.json",
    );
    expect(componentSchema.properties.contractVersion.const).toBe("1.0.0");
  });

  const fixtures = loadFixtures();

  it("finds fixtures to validate", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(4);
    expect(fixtures.length).toBeLessThanOrEqual(7);
  });

  it.each(fixtures.map((f) => [f.name, f.data] as const))(
    "fixture %s validates against the schema",
    (name, data) => {
      const valid = validate(data);
      if (!valid) {
        throw new Error(`${name} failed schema validation: ${ajv.errorsText(validate.errors)}`);
      }
      expect(valid).toBe(true);
    },
  );

  it("rejects a component missing the required `deploy` field", () => {
    const invalid = { name: "broken", dependsOn: [] };
    expect(validate(invalid)).toBe(false);
  });

  it("rejects a component name that is not kebab-case", () => {
    const invalid = { name: "Not_Kebab", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }] };
    expect(validate(invalid)).toBe(false);
  });

  it("rejects an unknown top-level field (additionalProperties: false)", () => {
    const invalid = {
      name: "x",
      dependsOn: [],
      deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }],
      notAField: true,
    };
    expect(validate(invalid)).toBe(false);
  });

  it("accepts a producer-library component whose deploy is publish-only", () => {
    const producer = {
      name: "jar-lib",
      archetype: "producer-library",
      dependsOn: [],
      build: { kind: "jvm-build" },
      deploy: [{ phase: "Publish", steps: [{ kind: "publish-artifact", from: "archive", to: "$env.s3" }] }],
    };
    expect(validate(producer)).toBe(true);
  });

  it("accepts an infra component with no build", () => {
    const infra = {
      name: "table",
      archetype: "infra",
      dependsOn: [],
      deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", template: "t.json" }] }],
    };
    expect(validate(infra)).toBe(true);
  });

  it("rejects an invalid archetype value", () => {
    const invalid = {
      name: "x",
      archetype: "worker",
      dependsOn: [],
      deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }],
    };
    expect(validate(invalid)).toBe(false);
  });

  it("accepts a gate step inside a phase", () => {
    const withGate = {
      name: "gated",
      dependsOn: [],
      deploy: [
        {
          phase: "Approve",
          steps: [{ kind: "gate", signalName: "approve-gated", description: "confirm", timeout: "24h" }],
        },
      ],
    };
    expect(validate(withGate)).toBe(true);
  });

  it("rejects a gate step missing signalName", () => {
    const invalid = {
      name: "gated",
      dependsOn: [],
      deploy: [{ phase: "Approve", steps: [{ kind: "gate" }] }],
    };
    expect(validate(invalid)).toBe(false);
  });

  it("accepts a stackOutput cross-stack reference", () => {
    const withStackOutput = {
      name: "svc",
      dependsOn: ["shared-alb"],
      deploy: [
        {
          phase: "Apply",
          steps: [
            {
              kind: "cfn-deploy",
              inputs: { listenerArn: { stackOutput: { stack: "shared-alb", name: "ListenerArn" } } },
            },
          ],
        },
      ],
    };
    expect(validate(withStackOutput)).toBe(true);
  });

  it("accepts a fan-out phase nesting a mini-composition", () => {
    const fanOut = {
      name: "cluster",
      dependsOn: [],
      deploy: [
        {
          phase: "Rolling",
          steps: [
            { phase: "Node 1", steps: [{ kind: "cfn-deploy", template: "t.json" }] },
            { phase: "Node 2", steps: [{ kind: "cfn-deploy", template: "t.json" }] },
          ],
        },
      ],
    };
    expect(validate(fanOut)).toBe(true);
  });

  it("accepts parallel steps within a phase", () => {
    const parallelPhase = {
      name: "svc",
      dependsOn: [],
      deploy: [
        {
          phase: "Verify",
          parallel: true,
          steps: [{ kind: "wait-for-stack", stack: "a" }, { kind: "wait-endpoint", url: "b" }],
        },
      ],
    };
    expect(validate(parallelPhase)).toBe(true);
  });

  describe("wiring reference forms", () => {
    function componentWith(imageRef: unknown) {
      return {
        name: "svc",
        dependsOn: [],
        deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", imageRef }] }],
      };
    }

    it("accepts a prior-step reference (@Phase.field)", () => {
      expect(validate(componentWith("@Publish.digest"))).toBe(true);
    });

    it("accepts a cross-component artifact reference (@component.publish.uri|digest|key)", () => {
      expect(validate(componentWith("@jar-lib.publish.uri"))).toBe(true);
      expect(validate(componentWith("@jar-lib.publish.digest"))).toBe(true);
      expect(validate(componentWith("@jar-lib.publish.key"))).toBe(true);
    });

    it("accepts an $env.* reference", () => {
      expect(validate(componentWith("$env.registry"))).toBe(true);
    });

    it("accepts a plain literal string with no reference sigil", () => {
      expect(validate(componentWith("sha256:abc123"))).toBe(true);
    });

    it("rejects a cross-component reference to an unrecognized artifact field", () => {
      expect(validate(componentWith("@jar-lib.publish.nonsense"))).toBe(false);
    });

    it("rejects a malformed @ reference with no dotted path", () => {
      expect(validate(componentWith("@justaname"))).toBe(false);
    });
  });
});
