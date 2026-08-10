/**
 * The `.dw` serializer leg, through the cedar serializer that hosts it.
 *
 * Exercised end to end rather than through `serializeDogwood` directly,
 * because the thing worth pinning is that a build holding both kinds of policy
 * emits both artifacts, from one pass, with ids derived the same way.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { cedarSerializer, CEDAR_JSON_FILENAME } from "../serializer";
import {
  DOGWOOD_EVENT_SCHEMA_FILENAME,
  DOGWOOD_EVENT_SCHEMA_TYPE,
  DOGWOOD_MACRO_FILENAME,
  DOGWOOD_MACRO_LIBRARY_TYPE,
  DOGWOOD_POLICY_FILENAME,
  DOGWOOD_POLICY_TYPE,
} from "./policy";
import {
  and,
  call,
  compare,
  count,
  ctx,
  exists,
  formerly,
  interval,
  predicate,
  since,
  sum,
  tp,
  typedBinder,
  varRef,
} from "./temporal";
import { defTemporalMacro, defaultMacroLibrary, macroCondition, macroWindow, renderMacroLibrary } from "./macros";
import { defaultEventSchema } from "./event-schema";

const TESTDATA = join(fileURLToPath(new URL(".", import.meta.url)), "testdata");
const UPSTREAM = "dogwood-policy/dogwood@5063bcc2d6d6cf5024d1b0498e6cc8ef52cbcf0c";

function fixture(name: string): string {
  return readFileSync(join(TESTDATA, name), "utf-8");
}

function attribution(...sources: string[]): string {
  return [
    `// Adapted from ${UPSTREAM} (Apache-2.0):`,
    ...sources.map((s) => `//   ${s}`),
    "// Upstream's shape; the bytes are what chant's typed builders emit.",
    "",
    "",
  ].join("\n");
}

function mock(entityType: string, props: Record<string, unknown>): Declarable {
  return {
    [DECLARABLE_MARKER]: true,
    lexicon: "cedar",
    entityType,
    kind: "resource",
    props,
  } as unknown as Declarable;
}

function result(entities: Map<string, Declarable>): SerializerResult {
  const out = cedarSerializer.serialize(entities);
  if (typeof out === "string") throw new Error(`expected a SerializerResult, got: ${JSON.stringify(out)}`);
  return out;
}

// ── The golden policy set ──────────────────────────────────────────

/**
 * One inline macro library and four policies, each modelled on a shipped
 * upstream example: approval-before-action, a `sum` budget, a `since`
 * sequencing rule with a guardrail, and a `count` rate limit.
 */
function goldenEntities(): Map<string, Declarable> {
  const sumFormerly = defTemporalMacro(
    "sum_formerly",
    ["?a", "?w", "?body"],
    sum(
      "?a",
      [typedBinder("?a", "Long"), typedBinder("$t", "Timepoint")],
      formerly(macroWindow("?w"), and(macroCondition("?body"), tp("$t"))),
    ),
    "Sums the numeric value `?a` over occurrences of `?body` within window `?w`.",
  );

  return new Map<string, Declarable>([
    ["library", mock(DOGWOOD_MACRO_LIBRARY_TYPE, { macros: [sumFormerly], inline: true })],
    [
      "readAfterLogin",
      mock(DOGWOOD_POLICY_TYPE, {
        annotations: { id: "read_after_login" },
        action: { eq: 'Drupe::Action::"Read"' },
        whenTemporal: [
          formerly("1h", predicate('Drupe::Action::"Login"', "response", { "input.user": ctx("input.user") })),
        ],
      }),
    ],
    [
      "transferSumOver100",
      mock(DOGWOOD_POLICY_TYPE, {
        annotations: { id: "transfer_sum_over_100" },
        action: { eq: 'Drupe::Action::"Alert"' },
        whenTemporal: [
          exists(
            typedBinder("total", "Long"),
            and(
              compare(
                call("sum_formerly", [
                  varRef("a"),
                  interval("1h"),
                  predicate('Drupe::Action::"Transfer"', "request", {
                    "input.user": varRef("_"),
                    "input.amount": varRef("a"),
                  }),
                ]),
                "==",
                varRef("total"),
              ),
              compare(varRef("total"), ">", 100),
            ),
          ),
        ],
      }),
    ],
    [
      "noToolAfterSensitiveRead",
      mock(DOGWOOD_POLICY_TYPE, {
        effect: "forbid",
        annotations: { id: "no_tool_after_sensitive_read" },
        action: { eq: 'Drupe::Action::"Invoke"' },
        whenGuardrails: ['context.input.tool != "audit"'],
        whenTemporal: [
          since(
            predicate('Drupe::Action::"Read"', "response", { "output.classification": varRef("c") }),
            "30m",
            predicate('Drupe::Action::"Login"', "request"),
          ),
        ],
        unless: ['principal in Drupe::Group::"breakglass"'],
      }),
    ],
    [
      "rateLimited",
      mock(DOGWOOD_POLICY_TYPE, {
        annotations: { id: "rate_limited" },
        action: { eq: 'Drupe::Action::"Transfer"' },
        whenTemporal: [
          compare(
            count(
              [typedBinder("t", "Timepoint")],
              formerly("15m", and(predicate('Drupe::Action::"Transfer"', "request"), tp("t"))),
            ),
            "<",
            5,
          ),
        ],
      }),
    ],
  ]);
}

describe("the .dw golden output", () => {
  test("matches the fixture byte for byte", () => {
    const files = result(goldenEntities()).files ?? {};
    expect(files[DOGWOOD_POLICY_FILENAME]).toBe(
      fixture("temporal-policies.dw").slice(
        attribution(
          "dogwood-docs/examples/read_after_login/policy.dw",
          "dogwood-docs/examples/temporal_sum_formerly_transfer/policy.dw",
          "dogwood-docs/examples/read_heartbeat_since_login_30s/policy.dw",
          "dogwood-docs/examples/temporal_count_formerly_login/policy.dw",
        ).length,
      ),
    );
  });

  test("the head is Cedar's — annotations, effect, three scope positions", () => {
    const text = result(goldenEntities()).files?.[DOGWOOD_POLICY_FILENAME] ?? "";
    expect(text).toContain('@id("read_after_login")\npermit (\n  principal,\n  action == Drupe::Action::"Read",\n  resource\n)');
    expect(text).toContain('@id("no_tool_after_sensitive_read")\nforbid (');
  });

  test("inline macro definitions come before the policies that call them", () => {
    const text = result(goldenEntities()).files?.[DOGWOOD_POLICY_FILENAME] ?? "";
    expect(text.indexOf("def temporal sum_formerly")).toBeLessThan(text.indexOf("@id("));
  });

  test("every clause form the dialect adds is emitted", () => {
    const text = result(goldenEntities()).files?.[DOGWOOD_POLICY_FILENAME] ?? "";
    expect(text).toContain("when temporal {");
    expect(text).toContain('when guardrails { context.input.tool != "audit" }');
    expect(text).toContain('unless { principal in Drupe::Group::"breakglass" }');
  });
});

// ── Ids and the cedar half ─────────────────────────────────────────

describe("the two halves of one policy set", () => {
  const cedarPolicy = () =>
    mock("Cedar::Policy", {
      action: { eq: 'Drupe::Action::"List"' },
      when: ["principal == resource.owner"],
    });

  test("a build with both emits both, in one pass", () => {
    const entities = new Map<string, Declarable>([
      ["allowOwnerList", cedarPolicy()],
      [
        "readAfterLogin",
        mock(DOGWOOD_POLICY_TYPE, {
          action: { eq: 'Drupe::Action::"Read"' },
          whenTemporal: [formerly("1h", predicate('Drupe::Action::"Login"', "response"))],
        }),
      ],
    ]);
    const out = result(entities);
    expect(out.primary).toContain('@id("allow-owner-list")');
    expect(out.primary).not.toContain("temporal");
    expect(Object.keys(out.files ?? {})).toContain(CEDAR_JSON_FILENAME);
    expect(out.files?.[DOGWOOD_POLICY_FILENAME]).toContain('@id("read-after-login")');
  });

  test("policy ids are derived the same way on both legs", () => {
    const entities = new Map<string, Declarable>([
      [
        "allowAdminRead",
        mock(DOGWOOD_POLICY_TYPE, {
          whenTemporal: [formerly("1h", predicate('Ns::Action::"A"', "request"))],
        }),
      ],
    ]);
    expect(result(entities).files?.[DOGWOOD_POLICY_FILENAME]).toContain('@id("allow-admin-read")');
  });

  test("a temporal-only build still emits its files, with an empty cedar primary", () => {
    const entities = new Map<string, Declarable>([
      [
        "readAfterLogin",
        mock(DOGWOOD_POLICY_TYPE, {
          whenTemporal: [formerly("1h", predicate('Ns::Action::"A"', "request"))],
        }),
      ],
    ]);
    const out = result(entities);
    expect(out.primary).toBe("");
    expect(out.files?.[CEDAR_JSON_FILENAME]).toBeUndefined();
    expect(out.files?.[DOGWOOD_POLICY_FILENAME]).toContain("when temporal {");
  });

  test("a cedar-only build is untouched by the dialect", () => {
    const entities = new Map<string, Declarable>([["allowOwnerList", cedarPolicy()]]);
    const out = result(entities);
    expect(Object.keys(out.files ?? {})).toEqual([CEDAR_JSON_FILENAME]);
    expect(out.warnings).toBeUndefined();
  });

  test("an empty build is still the empty string", () => {
    expect(cedarSerializer.serialize(new Map())).toBe("");
  });

  test("the DWD id family is declared on the serializer", () => {
    expect(cedarSerializer.extraRulePrefixes).toEqual(["DWD"]);
  });
});

// ── The companion files ────────────────────────────────────────────

describe("event schemas and macro libraries", () => {
  test("an event schema entity becomes .dwschema text", () => {
    const entities = new Map<string, Declarable>([
      ["events", mock(DOGWOOD_EVENT_SCHEMA_TYPE, { schema: defaultEventSchema() })],
    ]);
    const files = result(entities).files ?? {};
    expect(files[DOGWOOD_EVENT_SCHEMA_FILENAME]).toContain("decision event <A>::request {");
  });

  test("an explicit filename is honoured, so several schemas can coexist", () => {
    const entities = new Map<string, Declarable>([
      ["a", mock(DOGWOOD_EVENT_SCHEMA_TYPE, { schema: defaultEventSchema() })],
      ["b", mock(DOGWOOD_EVENT_SCHEMA_TYPE, { schema: defaultEventSchema({ maxWindow: "30d" }), filename: "gateway.dwschema" })],
    ]);
    const files = result(entities).files ?? {};
    expect(files[DOGWOOD_EVENT_SCHEMA_FILENAME]).not.toContain("max_window");
    expect(files["gateway.dwschema"]).toContain("max_window = 30d");
  });

  test("two schemas on one filename warn rather than emitting something upstream rejects", () => {
    const entities = new Map<string, Declarable>([
      ["a", mock(DOGWOOD_EVENT_SCHEMA_TYPE, { schema: defaultEventSchema() })],
      ["b", mock(DOGWOOD_EVENT_SCHEMA_TYPE, { schema: defaultEventSchema({ maxWindow: "30d" }) })],
    ]);
    const out = result(entities);
    expect(out.warnings?.[0]).toMatch(/both target events\.dwschema/);
    expect(out.files?.[DOGWOOD_EVENT_SCHEMA_FILENAME]).not.toContain("max_window");
  });

  test("a non-inline macro library becomes its own file", () => {
    const entities = new Map<string, Declarable>([
      ["defaults", mock(DOGWOOD_MACRO_LIBRARY_TYPE, { macros: defaultMacroLibrary() })],
    ]);
    const files = result(entities).files ?? {};
    expect(files[DOGWOOD_MACRO_FILENAME]).toBe(
      fixture("default-macros.dw").slice(
        attribution("dogwood-language/configuration/default_macros.dw").length,
      ),
    );
  });

  test("the emitted default library is upstream's, definition for definition", () => {
    const text = renderMacroLibrary(defaultMacroLibrary());
    for (const name of ["count_within", "sum_within", "count_distinct_within", "bind"]) {
      expect(text).toContain(`def temporal ${name}(`);
    }
  });

  test("an empty macro library warns rather than writing an empty file", () => {
    const entities = new Map<string, Declarable>([
      ["empty", mock(DOGWOOD_MACRO_LIBRARY_TYPE, { macros: [] })],
    ]);
    const out = cedarSerializer.serialize(entities);
    expect(typeof out === "string" ? undefined : out.warnings?.[0]).toMatch(/declares no macros/);
  });
});
