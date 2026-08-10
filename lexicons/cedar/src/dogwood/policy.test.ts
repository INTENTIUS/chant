/**
 * The entity classes, driven the way a policy file drives them.
 *
 * The golden serializer test builds its entities by hand so the rendering is
 * pinned independently of the runtime factory. This one closes the other half:
 * that `new TemporalPolicy({ … })` produces a Declarable the cedar serializer
 * recognises, with the props it was given.
 */
import { describe, test, expect } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import { cedarSerializer } from "../serializer";
import {
  DOGWOOD_EVENT_SCHEMA_FILENAME,
  DOGWOOD_EVENT_SCHEMA_TYPE,
  DOGWOOD_LEXICON,
  DOGWOOD_MACRO_FILENAME,
  DOGWOOD_POLICY_FILENAME,
  DOGWOOD_POLICY_TYPE,
  TemporalEventSchema,
  TemporalMacroLibrary,
  TemporalPolicy,
} from "./policy";
import { ctx, formerly, predicate } from "./temporal";
import { defaultEventSchema } from "./event-schema";
import { defaultMacroLibrary } from "./macros";

function files(entities: Map<string, Declarable>): Record<string, string> {
  const out = cedarSerializer.serialize(entities);
  return typeof out === "string" ? {} : (out.files ?? {});
}

describe("the dogwood entity classes", () => {
  test("a TemporalPolicy is a cedar-lexicon Declarable of its own entity type", () => {
    const policy = new TemporalPolicy({ whenTemporal: [] });
    expect(policy.entityType).toBe(DOGWOOD_POLICY_TYPE);
    expect(policy.lexicon).toBe(DOGWOOD_LEXICON);
    expect(policy.kind).toBe("resource");
  });

  test("the dialect's entity types are namespaced apart from Cedar::Policy", () => {
    expect(DOGWOOD_POLICY_TYPE).toBe("Dogwood::TemporalPolicy");
    expect(DOGWOOD_EVENT_SCHEMA_TYPE).toBe("Dogwood::EventSchema");
  });

  test("a declared policy reaches the .dw output through the serializer", () => {
    const entities = new Map<string, Declarable>([
      [
        "readAfterLogin",
        new TemporalPolicy({
          action: { eq: 'Drupe::Action::"Read"' },
          principal: { is: "Drupe::OAuthUser" },
          annotations: { owner: "platform" },
          whenTemporal: [
            formerly("1h", predicate('Drupe::Action::"Login"', "response", { "input.user": ctx("input.user") })),
          ],
        }),
      ],
    ]);

    const text = files(entities)[DOGWOOD_POLICY_FILENAME];
    expect(text).toContain('@id("read-after-login")');
    expect(text).toContain('@owner("platform")');
    expect(text).toContain("  principal is Drupe::OAuthUser,");
    expect(text).toContain('  action == Drupe::Action::"Read",');
    expect(text).toContain("formerly within 1h");
  });

  test("an event schema and a macro library each reach their own file", () => {
    const entities = new Map<string, Declarable>([
      ["events", new TemporalEventSchema({ schema: defaultEventSchema({ maxWindow: "12h" }) })],
      ["macros", new TemporalMacroLibrary({ macros: defaultMacroLibrary() })],
    ]);

    const written = files(entities);
    expect(written[DOGWOOD_EVENT_SCHEMA_FILENAME]).toContain("max_window = 12h");
    expect(written[DOGWOOD_MACRO_FILENAME]).toContain("def temporal count_within(?w, ?s) {");
  });

  test("an inline macro library lands in the policy set, not a separate file", () => {
    const entities = new Map<string, Declarable>([
      ["macros", new TemporalMacroLibrary({ macros: defaultMacroLibrary(), inline: true })],
      [
        "p",
        new TemporalPolicy({
          whenTemporal: [formerly("1h", predicate('Ns::Action::"A"', "request"))],
        }),
      ],
    ]);

    const written = files(entities);
    expect(written[DOGWOOD_MACRO_FILENAME]).toBeUndefined();
    expect(written[DOGWOOD_POLICY_FILENAME]).toContain("def temporal count_within(?w, ?s) {");
  });
});
