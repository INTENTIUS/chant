/**
 * Event-schema round trip: typed authoring in, `.dwschema` text out, asserted
 * against fixtures whose shapes are upstream's.
 *
 * The fixtures under `./testdata/` are adapted from
 * `dogwood-policy/dogwood`'s shipped examples and its bundled default schema
 * (Apache-2.0; each file carries its provenance in a header comment). They are
 * not byte copies — upstream aligns field types in columns and chant does not
 * — so what is pinned here is the surface: the directive, the declarations,
 * the spreads, the selectors, and where the pins land.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import {
  concrete,
  declaredEventKinds,
  defaultEventSchema,
  eventDeclaration,
  eventSchema,
  field,
  pinContext,
  pinPrincipal,
  pinnedField,
  principalType,
  record,
  renderEventSchema,
  resourceType,
  spreadInputs,
  spreadOutputs,
} from "./event-schema";
import { readEventSchema } from "./scan";

const TESTDATA = join(fileURLToPath(new URL(".", import.meta.url)), "testdata");
const UPSTREAM = "dogwood-policy/dogwood@5063bcc2d6d6cf5024d1b0498e6cc8ef52cbcf0c";

function fixture(name: string): string {
  return readFileSync(join(TESTDATA, name), "utf-8");
}

/** The provenance header each fixture carries above the emitted bytes. */
function attribution(...sources: string[]): string {
  return [
    `// Adapted from ${UPSTREAM} (Apache-2.0):`,
    ...sources.map((s) => `//   ${s}`),
    "// Upstream's shape; the bytes are what chant's typed builders emit.",
    "",
    "",
  ].join("\n");
}

// ── The default shape ──────────────────────────────────────────────

describe("the default (pinned) event schema", () => {
  test("round-trips to upstream's pinned.dwschema shape", () => {
    expect(fixture("pinned.dwschema")).toBe(
      attribution("dogwood-language/configuration/event-schemas/pinned.dwschema") +
        renderEventSchema(defaultEventSchema()),
    );
  });

  test("every kind pins callerPrincipal to the deciding request's principal", () => {
    const text = renderEventSchema(defaultEventSchema());
    expect(text.match(/pin callerPrincipal: principalType\(A\) = principal,/g)).toHaveLength(3);
    expect(readEventSchema(text).hasPin).toBe(true);
  });

  test("request is the deciding kind; response and error are history", () => {
    const text = renderEventSchema(defaultEventSchema());
    expect(text).toContain("decision event <A>::request {");
    expect(text).toContain("\nevent <A>::response {");
    expect(text).toContain("\nevent <A>::error {");
    expect(declaredEventKinds(defaultEventSchema())).toEqual(["request", "response", "error"]);
  });

  test("dropping the pin is a named argument, and says so in the file", () => {
    const text = renderEventSchema(defaultEventSchema({ pinCallerPrincipal: false }));
    expect(text).not.toContain("pin callerPrincipal");
    expect(text).toContain("// Cross-principal: callerPrincipal is NOT pinned");
    expect(readEventSchema(text).hasPin).toBe(false);
  });
});

// ── max_window ─────────────────────────────────────────────────────

describe("the max_window directive", () => {
  const raised = () =>
    eventSchema(
      [
        eventDeclaration(
          "request",
          [
            spreadInputs(),
            field("callerPrincipal", principalType()),
            field("callerResource", resourceType()),
            field("requestId", concrete("String")),
          ],
          { decision: true },
        ),
        eventDeclaration("response", [
          spreadInputs(),
          spreadOutputs(),
          field("callerPrincipal", principalType()),
          field("callerResource", resourceType()),
          field("requestId", concrete("String")),
        ]),
      ],
      {
        maxWindow: "30d",
        comment:
          "Raises the look-back cap from the 24h default to 30 days. The directive\nmust come first, before any event declaration.\n\nNo pinned field: this schema correlates across principals on purpose.",
      },
    );

  test("round-trips to upstream's max_window_raised shape", () => {
    expect(fixture("max-window-raised.dwschema")).toBe(
      attribution("dogwood-docs/examples/max_window_raised/event.dwschema") + renderEventSchema(raised()),
    );
  });

  test("the directive precedes every declaration, as the grammar requires", () => {
    const lines = renderEventSchema(raised()).split("\n");
    const directive = lines.findIndex((l) => l.startsWith("max_window"));
    const firstEvent = lines.findIndex((l) => l.includes("event <A>::"));
    expect(directive).toBeGreaterThan(-1);
    expect(directive).toBeLessThan(firstEvent);
  });

  test("the scanner reads the cap back out", () => {
    const facts = readEventSchema(renderEventSchema(raised()));
    expect(facts.maxWindowText).toBe("30d");
    expect(facts.maxWindowSeconds).toBe(30 * 86400);
  });

  test("an absent directive reads back as upstream's 24h default", () => {
    const facts = readEventSchema(renderEventSchema(defaultEventSchema()));
    expect(facts.maxWindowText).toBeUndefined();
    expect(facts.maxWindowSeconds).toBe(24 * 3600);
  });
});

// ── Author-defined kinds ───────────────────────────────────────────

describe("author-defined event kinds", () => {
  const custom = () =>
    eventSchema(
      [
        eventDeclaration("attempt", [spreadInputs(), field("actor", principalType())], { decision: true }),
        eventDeclaration("outcome", [spreadInputs(), spreadOutputs(), field("actor", principalType())]),
      ],
      {
        comment:
          "Author-defined event kinds — `attempt` decides, `outcome` is history — and\na renamed injected principal field.",
      },
    );

  test("round-trips to upstream's login_attempt_custom_kind shape", () => {
    expect(fixture("custom-kinds.dwschema")).toBe(
      attribution("dogwood-docs/examples/login_attempt_custom_kind/event.dwschema") + renderEventSchema(custom()),
    );
  });

  test("request/response are conventional, not required", () => {
    expect(declaredEventKinds(custom())).toEqual(["attempt", "outcome"]);
    expect(readEventSchema(renderEventSchema(custom())).kinds).toEqual(["attempt", "outcome"]);
  });
});

// ── Field forms ────────────────────────────────────────────────────

describe("field forms", () => {
  test("a record type nests, and its members are addressed as name.member", () => {
    const text = renderEventSchema(
      eventSchema([
        eventDeclaration("request", [
          spreadInputs(),
          field("session", record([field("id", concrete("String")), field("tenant", concrete("String"))])),
        ]),
      ]),
    );
    expect(text).toContain("    session: {\n        id: String,\n        tenant: String,\n    },");
  });

  test("a context pin renders its dotted path", () => {
    const text = renderEventSchema(
      eventSchema([
        eventDeclaration("request", [pinnedField("tenant", concrete("String"), pinContext("input.tenant"))]),
      ]),
    );
    expect(text).toContain("    pin tenant: String = context.input.tenant,");
  });

  test("a scope pin may carry an attribute tail", () => {
    const text = renderEventSchema(
      eventSchema([
        eventDeclaration("request", [pinnedField("dept", concrete("String"), pinPrincipal("dept"))]),
      ]),
    );
    expect(text).toContain("    pin dept: String = principal.dept,");
  });

  test("pinning a whole record is refused — upstream requires a leaf", () => {
    expect(() => pinnedField("group", record([field("a", concrete("String"))]), pinPrincipal())).toThrow(
      /must be a leaf/,
    );
  });

  test("a duplicated event kind is refused at construction", () => {
    expect(() =>
      eventSchema([eventDeclaration("request", []), eventDeclaration("request", [])]),
    ).toThrow(/declared twice/);
  });

  test("a schema with no declarations is refused", () => {
    expect(() => eventSchema([])).toThrow(/at least one event kind/);
  });
});
