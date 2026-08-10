/**
 * The DWD walls.
 *
 * Each check reads the emitted text, so every case here is built as a
 * `PostSynthContext` holding files rather than by driving the serializer —
 * that is the same shape `chant audit` hands them when it runs over a
 * checked-in `.dw` chant never wrote.
 */
import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { postSynthChecks } from "./index";
import { dwdc010 } from "./dwdc010";
import { dwdc011 } from "./dwdc011";
import { dwdc012 } from "./dwdc012";
import { dwdc013 } from "./dwdc013";
import { dwds010 } from "./dwds010";
import { cedarAuditCatalog } from "../audit-catalog";
import { renderEventSchema, defaultEventSchema } from "../../dogwood/event-schema";
import { blankComments, temporalRegions } from "../../dogwood/scan";

function ctxOf(files: Record<string, string>): PostSynthContext {
  const output: SerializerResult = { primary: "", files };
  const outputs = new Map<string, string | SerializerResult>([["cedar", output]]);
  return {
    outputs,
    entities: new Map(),
    buildResult: { outputs, entities: new Map(), warnings: [], errors: [], sourceFileCount: 1 },
  };
}

const PINNED = renderEventSchema(defaultEventSchema());

function policy(body: string): string {
  return `@id("p")\npermit (\n  principal,\n  action == Ns::Action::"Read",\n  resource\n)\nwhen temporal {\n    ${body}\n}\n;\n`;
}

// ── DWDC010 ────────────────────────────────────────────────────────

describe("DWDC010 — the event kind must be declared", () => {
  test("a declared kind passes", () => {
    const ctx = ctxOf({
      "policies.dw": policy('formerly within 1h Ns::Action::"Login"::response{}'),
      "events.dwschema": PINNED,
    });
    expect(dwdc010.check(ctx)).toEqual([]);
  });

  test("an undeclared kind is an error naming both the predicate and the declared set", () => {
    const ctx = ctxOf({
      "policies.dw": policy('formerly within 1h Ns::Action::"Login"::nosuchkind{}'),
      "events.dwschema": PINNED,
    });
    const [finding, ...rest] = dwdc010.check(ctx);
    expect(rest).toEqual([]);
    expect(finding.severity).toBe("error");
    expect(finding.message).toContain('Ns::Action::"Login"::nosuchkind');
    expect(finding.message).toContain("error, request, response");
    expect(finding.entity).toBe("policies.dw");
  });

  test("author-defined kinds pass against the schema that declares them", () => {
    const custom = "decision event <A>::attempt {\n    ...inputs(A),\n}\n";
    const ctx = ctxOf({
      "policies.dw": policy('formerly within 1h Ns::Action::"Login"::attempt{}'),
      "events.dwschema": custom,
    });
    expect(dwdc010.check(ctx)).toEqual([]);
  });

  test("silent when no schema was emitted — the far end's defaults decide", () => {
    const ctx = ctxOf({ "policies.dw": policy('formerly within 1h Ns::Action::"Login"::nosuchkind{}') });
    expect(dwdc010.check(ctx)).toEqual([]);
  });

  test("a commented-out predicate is not a finding", () => {
    const ctx = ctxOf({
      "policies.dw": `// formerly within 1h Ns::Action::"Login"::nosuchkind{}\n${policy('formerly within 1h Ns::Action::"Login"::request{}')}`,
      "events.dwschema": PINNED,
    });
    expect(dwdc010.check(ctx)).toEqual([]);
  });

  test("a Cedar when clause is not temporal source, so it is not scanned", () => {
    const cedarOnly = `@id("p")\npermit (\n  principal,\n  action,\n  resource\n)\nwhen { context.kind == "nosuchkind" };\n`;
    const ctx = ctxOf({ "policies.dw": cedarOnly, "events.dwschema": PINNED });
    expect(dwdc010.check(ctx)).toEqual([]);
  });

  test("the same predicate twice is reported once", () => {
    const body = 'formerly within 1h Ns::Action::"Login"::bogus{} && previous within 1h Ns::Action::"Login"::bogus{}';
    const ctx = ctxOf({ "policies.dw": policy(body), "events.dwschema": PINNED });
    expect(dwdc010.check(ctx)).toHaveLength(1);
  });
});

// ── DWDC011 ────────────────────────────────────────────────────────

describe("DWDC011 — the window must fit inside max_window", () => {
  test("a window inside the default 24h cap passes with no schema emitted", () => {
    const ctx = ctxOf({ "policies.dw": policy('formerly within 1h Ns::Action::"Login"::request{}') });
    expect(dwdc011.check(ctx)).toEqual([]);
  });

  test("48h under the default 24h cap is an error even with no schema", () => {
    const ctx = ctxOf({ "policies.dw": policy('formerly within 48h Ns::Action::"Login"::request{}') });
    const [finding] = dwdc011.check(ctx);
    expect(finding.severity).toBe("error");
    expect(finding.message).toContain("looks back 48h");
    expect(finding.message).toContain("24h");
    expect(finding.message).toContain("no event schema was emitted");
  });

  test("raising max_window in the schema licenses the longer window", () => {
    const raised = `max_window = 30d\n\n${PINNED.split("\n").slice(3).join("\n")}`;
    const ctx = ctxOf({
      "policies.dw": policy('formerly within 7d Ns::Action::"Login"::request{}'),
      "events.dwschema": raised,
    });
    expect(dwdc011.check(ctx)).toEqual([]);
  });

  test("an emitted schema with no directive still caps at 24h", () => {
    const ctx = ctxOf({
      "policies.dw": policy('formerly within 25h Ns::Action::"Login"::request{}'),
      "events.dwschema": PINNED,
    });
    expect(dwdc011.check(ctx)).toHaveLength(1);
  });

  test("the tightest of several schemas wins", () => {
    const raised = `max_window = 30d\n\n${PINNED.split("\n").slice(3).join("\n")}`;
    const ctx = ctxOf({
      "policies.dw": policy('formerly within 7d Ns::Action::"Login"::request{}'),
      "events.dwschema": raised,
      "gateway.dwschema": PINNED,
    });
    expect(dwdc011.check(ctx)).toHaveLength(1);
  });

  test("a macro-call interval counts — it is the window the body resolves to", () => {
    const ctx = ctxOf({ "policies.dw": policy('once(48h, Ns::Action::"Login"::request{})') });
    const [finding] = dwdc011.check(ctx);
    expect(finding.message).toContain("looks back 48h");
  });

  test("a window inside a macro definition is scanned too", () => {
    const dw = `def temporal wide(?s) {\n    formerly within 72h ?s\n};\n\n${policy('wide(Ns::Action::"Login"::request{})')}`;
    const ctx = ctxOf({ "policies.dw": dw });
    expect(dwdc011.check(ctx)).toHaveLength(1);
  });

  test("no policy file means nothing to judge", () => {
    expect(dwdc011.check(ctxOf({ "events.dwschema": PINNED }))).toEqual([]);
  });
});

// ── DWDC012 ────────────────────────────────────────────────────────

describe("DWDC012 — the window is not optional", () => {
  test("a windowed operator passes", () => {
    const ctx = ctxOf({ "policies.dw": policy('formerly within 1h Ns::Action::"Login"::request{}') });
    expect(dwdc012.check(ctx)).toEqual([]);
  });

  test("a bare formerly is an error", () => {
    const ctx = ctxOf({ "policies.dw": policy('formerly Ns::Action::"Login"::request{}') });
    const [finding] = dwdc012.check(ctx);
    expect(finding.severity).toBe("error");
    expect(finding.message).toContain("`formerly` with no `within` window");
  });

  test("previous and since are held to the same rule", () => {
    for (const operator of ["previous", "since"]) {
      const ctx = ctxOf({ "policies.dw": policy(`${operator} Ns::Action::"Login"::request{}`) });
      expect(dwdc012.check(ctx)[0]?.message).toContain(`\`${operator}\``);
    }
  });

  test("a `within ?w` in a macro body is a window", () => {
    const dw = `def temporal once(?w, ?s) {\n    formerly within ?w ?s\n};\n`;
    expect(dwdc012.check(ctxOf({ "policies.dw": dw }))).toEqual([]);
  });

  test("a Cedar attribute named `since` outside a temporal block is not the operator", () => {
    const cedarOnly = `@id("p")\npermit (\n  principal,\n  action,\n  resource\n)\nwhen { context.since > 3 };\n`;
    expect(dwdc012.check(ctxOf({ "policies.dw": cedarOnly }))).toEqual([]);
  });
});

// ── DWDS010 ────────────────────────────────────────────────────────

describe("DWDS010 — an unpinned schema widens every predicate", () => {
  test("the default shape's pin satisfies it", () => {
    expect(dwds010.check(ctxOf({ "events.dwschema": PINNED }))).toEqual([]);
  });

  test("a schema with no pin is a report-only warning", () => {
    const unpinned = renderEventSchema(defaultEventSchema({ pinCallerPrincipal: false }));
    const [finding] = dwds010.check(ctxOf({ "events.dwschema": unpinned }));
    expect(finding.severity).toBe("warning");
    expect(finding.message).toContain("declares no pinned field");
    expect(finding.entity).toBe("events.dwschema");
  });

  test("a file with no declarations at all is not the pin's problem", () => {
    expect(dwds010.check(ctxOf({ "events.dwschema": "// nothing here\n" }))).toEqual([]);
  });
});

// ── DWDC013 ────────────────────────────────────────────────────────

/**
 * A build with two lexicons in it: the cedar one, and whatever emitted the
 * CloudFormation the AgentCore policy landed in. The check reads the emitted
 * JSON rather than an aws entity class, which is what lets the cedar lexicon
 * have an opinion about an embedding without depending on the aws lexicon.
 */
function ctxOfLexicons(byLexicon: Record<string, Record<string, string>>): PostSynthContext {
  const outputs = new Map<string, string | SerializerResult>();
  for (const [lexicon, files] of Object.entries(byLexicon)) {
    outputs.set(lexicon, { primary: "", files } satisfies SerializerResult);
  }
  return {
    outputs,
    entities: new Map(),
    buildResult: { outputs, entities: new Map(), warnings: [], errors: [], sourceFileCount: 1 },
  };
}

const TEMPORAL_STATEMENT =
  '@id("write-needs-approval")\npermit (\n  principal,\n  action == Ns::Action::"Write",\n  resource\n)\nwhen temporal {\n    formerly within 1h Ns::Action::"Approve"::response{}\n}\n;';

const PLAIN_STATEMENT = '@id("deny")\nforbid (\n  principal,\n  action,\n  resource\n)\nunless { context.ok == true };';

function template(definition: Record<string, unknown>, logicalId = "GatewayPolicy"): string {
  return JSON.stringify({
    Resources: {
      [logicalId]: {
        Type: "AWS::BedrockAgentCore::Policy",
        Properties: {
          PolicyEngineId: "GatewayEngine-abcdefghij",
          Name: logicalId,
          Definition: definition,
          EnforcementMode: "LOG_ONLY",
        },
      },
    },
  });
}

describe("DWDC013 — an embedded temporal statement needs its event schema", () => {
  test("temporal text with no emitted schema is a warning naming the resource", () => {
    const ctx = ctxOfLexicons({
      cedar: { "policies.dw": policy('formerly within 1h Ns::Action::"Approve"::response{}') },
      aws: { "template.json": template({ Policy: { Statement: TEMPORAL_STATEMENT } }) },
    });

    const [finding, ...rest] = dwdc013.check(ctx);
    expect(rest).toEqual([]);
    expect(finding.severity).toBe("warning");
    expect(finding.entity).toBe("GatewayPolicy");
    expect(finding.lexicon).toBe("aws");
    expect(finding.message).toContain("Definition.Policy.Statement");
    expect(finding.message).toContain("no .dwschema");
  });

  test("an emitted event schema settles it", () => {
    const ctx = ctxOfLexicons({
      cedar: { "events.dwschema": PINNED },
      aws: { "template.json": template({ Policy: { Statement: TEMPORAL_STATEMENT } }) },
    });
    expect(dwdc013.check(ctx)).toEqual([]);
  });

  test("plain Cedar in the language-agnostic arm is not this check's business", () => {
    const ctx = ctxOfLexicons({
      aws: { "template.json": template({ Policy: { Statement: PLAIN_STATEMENT } }) },
    });
    expect(dwdc013.check(ctx)).toEqual([]);
  });

  test("the Cedar arm is left alone — a temporal statement there is a different bug", () => {
    const ctx = ctxOfLexicons({
      aws: { "template.json": template({ Cedar: { Statement: TEMPORAL_STATEMENT } }) },
    });
    expect(dwdc013.check(ctx)).toEqual([]);
  });

  test("every embedded policy is reported, not only the first", () => {
    const both = JSON.stringify({
      Resources: {
        Approval: {
          Type: "AWS::BedrockAgentCore::Policy",
          Properties: { Definition: { Policy: { Statement: TEMPORAL_STATEMENT } } },
        },
        Budget: {
          Type: "AWS::BedrockAgentCore::Policy",
          Properties: { Definition: { Policy: { Statement: TEMPORAL_STATEMENT } } },
        },
      },
    });
    const findings = dwdc013.check(ctxOfLexicons({ aws: { "template.json": both } }));
    expect(findings.map((f) => f.entity).sort()).toEqual(["Approval", "Budget"]);
  });

  test("a build with no embedding at all is silent", () => {
    const ctx = ctxOfLexicons({
      cedar: { "policies.dw": policy('formerly within 1h Ns::Action::"Approve"::response{}') },
    });
    expect(dwdc013.check(ctx)).toEqual([]);
  });

  test("non-JSON output is skipped rather than reported", () => {
    const ctx = ctxOfLexicons({ aws: { "template.yaml": "Resources:\n  Gateway:\n    Type: Whatever\n" } });
    expect(dwdc013.check(ctx)).toEqual([]);
  });
});

// ── Registration ───────────────────────────────────────────────────

describe("registration", () => {
  test("every DWD check is auto-discovered into the committed barrel", () => {
    const ids = postSynthChecks.map((c) => c.id).filter((id) => id.startsWith("DWD"));
    expect(ids.sort()).toEqual([
      "DWDC010",
      "DWDC011",
      "DWDC012",
      "DWDC013",
      "DWDE010",
      "DWDE011",
      "DWDS010",
    ]);
  });

  test("every DWD check has a catalog entry, so `chant audit` can title it", () => {
    for (const check of postSynthChecks) {
      if (!check.id.startsWith("DWD")) continue;
      const meta = cedarAuditCatalog[check.id];
      expect(meta, `${check.id} is catalogued`).toBeDefined();
      expect(meta.title.length).toBeGreaterThan(0);
      expect(meta.remediation.length).toBeGreaterThan(0);
    }
  });

  test("the catalog carries no DWD entry without a check behind it", () => {
    const shipped = new Set(postSynthChecks.map((c) => c.id));
    const stale = Object.keys(cedarAuditCatalog).filter((id) => id.startsWith("DWD") && !shipped.has(id));
    expect(stale).toEqual([]);
  });
});

// ── The scanner itself ─────────────────────────────────────────────

describe("the text scanner", () => {
  test("a // inside a string literal is not a comment", () => {
    const text = 'when temporal { Ns::Action::"a//b"::request{} }';
    expect(blankComments(text)).toBe(text);
  });

  test("a comment is blanked without moving any offset", () => {
    const text = 'x // hidden\ny';
    const blanked = blankComments(text);
    expect(blanked).toHaveLength(text.length);
    expect(blanked).toBe("x          \ny");
  });

  test("a temporal block is extracted through its nested braces", () => {
    const text = 'when temporal { formerly within 1h Ns::Action::"A"::request{ input.x: 1 } }';
    expect(temporalRegions(text)).toEqual([
      ' formerly within 1h Ns::Action::"A"::request{ input.x: 1 } ',
    ]);
  });
});
