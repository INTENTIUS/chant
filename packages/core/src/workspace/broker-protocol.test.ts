import { describe, expect, test } from "vitest";
import {
  declaredRefusal,
  EGRESS_CAPABILITY,
  FEEDBACK_CAPABILITY,
  FOUNTAIN_CAPABILITY,
  INFERENCE_CAPABILITY,
  parseDeclarationReport,
  refusalMessage,
  STANDARD_CAPABILITIES,
} from "./broker-protocol";

describe("the broker protocol's capabilities (#3164)", () => {
  test("inference: /llm/anthropic needs agent, its hello needs nothing, decide needs decide, anything else is not served", () => {
    expect(INFERENCE_CAPABILITY.scopes({ method: "POST", path: "/llm/anthropic/v1/messages" })).toEqual(["agent"]);
    expect(INFERENCE_CAPABILITY.scopes({ method: "POST", path: "/llm/anthropic/v1/messages/count_tokens" })).toEqual(["agent"]);
    expect(INFERENCE_CAPABILITY.scopes({ method: "GET", path: "/llm/anthropic/v1/models/claude-opus-5" })).toEqual(["agent"]);
    expect(INFERENCE_CAPABILITY.scopes({ method: "HEAD", path: "/llm/anthropic/api/hello" })).toEqual([]);
    expect(INFERENCE_CAPABILITY.scopes({ method: "POST", path: "/decide/v1/systemone" })).toEqual(["decide"]);
    expect(INFERENCE_CAPABILITY.scopes({ method: "POST", path: "/llm/anthropic/v1/complete" })).toBeNull();
    expect(INFERENCE_CAPABILITY.scopes({ method: "GET", path: "/decide/v1/systemone" })).toBeNull();
  });

  test("egress: the secret's name is the scope word", () => {
    expect(EGRESS_CAPABILITY.scopes({ method: "POST", path: "/egress/STRIPE/v1/charges" })).toEqual(["STRIPE"]);
    expect(EGRESS_CAPABILITY.scopes({ method: "GET", path: "/egress/GITHUB_API" })).toEqual(["GITHUB_API"]);
    expect(EGRESS_CAPABILITY.scopes({ method: "GET", path: "/egress/stripe/v1" })).toBeNull();
    expect(EGRESS_CAPABILITY.scopes({ method: "GET", path: "/egressor/STRIPE" })).toBeNull();
  });

  test("feedback: entries need agent, counts need passive, an empty batch needs nothing", () => {
    expect(FEEDBACK_CAPABILITY.scopes({ method: "POST", path: "/api/feedback", body: { entries: [{}], counts: { x: 1 } } })).toEqual(["agent", "passive"]);
    expect(FEEDBACK_CAPABILITY.scopes({ method: "POST", path: "/api/feedback", body: { counts: { x: 1 } } })).toEqual(["passive"]);
    expect(FEEDBACK_CAPABILITY.scopes({ method: "POST", path: "/api/feedback", body: {} })).toEqual([]);
    expect(FEEDBACK_CAPABILITY.scopes({ method: "GET", path: "/api/feedback" })).toBeNull();
  });

  test("fountain: starting a conversation needs agent, the rest by resource", () => {
    expect(FOUNTAIN_CAPABILITY.scopes({ method: "POST", path: "/fountain/api/conversations" })).toEqual(["agent"]);
    expect(FOUNTAIN_CAPABILITY.scopes({ method: "GET", path: "/fountain/api/conversations/c1" })).toEqual(["conversations"]);
    expect(FOUNTAIN_CAPABILITY.scopes({ method: "DELETE", path: "/fountain/api/sandboxes/s1" })).toEqual(["sandboxes"]);
    expect(FOUNTAIN_CAPABILITY.scopes({ method: "GET", path: "/fountain/api/vaults/v1" })).toEqual(["vault"]);
    expect(FOUNTAIN_CAPABILITY.scopes({ method: "GET", path: "/fountain/api/agents" })).toBeNull();
  });

  test("the standard capabilities are the four, by name", () => {
    expect(Object.keys(STANDARD_CAPABILITIES).sort()).toEqual(["egress", "feedback", "fountain", "inference"]);
    for (const [name, spec] of Object.entries(STANDARD_CAPABILITIES)) expect(spec.name).toBe(name);
  });
});

describe("a declaration report", () => {
  test("keeps the entries that name this broker, each name once with its scopes merged", () => {
    const parsed = parseDeclarationReport(
      {
        capabilities: [
          { name: "inference", broker: "lobby", scope: ["agent"] },
          { name: "inference", broker: "lobby", scope: ["decide", "agent"] },
          { name: "fountain-callback", broker: "fountain", scope: ["owner"] },
          { name: "egress", broker: "lobby" },
        ],
      },
      "lobby",
    );
    expect(parsed).toEqual({
      capabilities: [
        { name: "inference", broker: "lobby", scope: ["agent", "decide"] },
        { name: "egress", broker: "lobby", scope: [] },
      ],
    });
  });

  test("refuses a body that is not one, and a name that is not a capability's", () => {
    expect(parseDeclarationReport({}, "lobby")).toHaveProperty("error");
    expect(parseDeclarationReport({ capabilities: [{ name: "Inference" }] }, "lobby")).toHaveProperty("error");
    expect(parseDeclarationReport({ capabilities: Array.from({ length: 21 }, (_, i) => ({ name: `c${i}` })) }, "lobby")).toHaveProperty("error");
  });

  test("a refusal names the capability and the word, and the entry to add", () => {
    const declared = { capabilities: [{ name: "inference", broker: "lobby", scope: ["agent"] }] };
    expect(declaredRefusal(declared, "lobby", "inference", "agent")).toBeNull();
    expect(declaredRefusal(declared, "lobby", "inference", "decide")).toMatch(/inference.*decide/);
    expect(declaredRefusal(declared, "lobby", "egress", "STRIPE")).toContain('{ "name": "egress", "broker": "lobby", "scope": ["STRIPE"] }');
    expect(declaredRefusal(declared, "door", "inference", "agent")).toContain("brokered by door");
    expect(declaredRefusal(undefined, "lobby", "inference", "agent")).toContain("no declaration");
  });

  test("a refusal's message is read from either body shape", () => {
    expect(refusalMessage({ error: "no" })).toBe("no");
    expect(refusalMessage({ type: "error", error: { type: "permission_error", message: "no" } })).toBe("no");
    expect(refusalMessage({ error: {} })).toBeUndefined();
  });
});
