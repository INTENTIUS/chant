import { describe, test, expect } from "vitest";
import {
  applyInlineSuppressions,
  entitySuppressions,
  SUPPRESSION_EXPIRED_ID,
  SUPPRESSION_MISPLACED_FILE_ID,
  SUPPRESSION_UNIGNORABLE_ID,
  type SuppressionDirective,
} from "./suppressions";
import { DECLARABLE_MARKER, type Declarable } from "../declarable";
import type { PostSynthDiagnostic } from "./post-synth";
import type { RuleConfig } from "./rule";

/** A minimal `Declarable` carrying the duck-typed `suppressions` field this module reads. */
function entityWith(directives?: SuppressionDirective[]): Declarable {
  return {
    [DECLARABLE_MARKER]: true,
    lexicon: "fake",
    entityType: "Fake::Thing",
    suppressions: directives,
  } as unknown as Declarable;
}

let seq = 0;
function directive(partial: Partial<SuppressionDirective> & Pick<SuppressionDirective, "form">): SuppressionDirective {
  seq += 1;
  return { ids: "all", file: "main.tf", line: 1, key: `key-${seq}`, ...partial };
}

function diag(checkId: string, entityKey?: string): PostSynthDiagnostic {
  return { checkId, severity: "warning", message: `${checkId} fired`, entity: entityKey, lexicon: "fake" };
}

describe("entitySuppressions", () => {
  test("returns [] for an entity with no suppressions field", () => {
    expect(entitySuppressions(entityWith(undefined))).toEqual([]);
  });

  test("returns [] for undefined", () => {
    expect(entitySuppressions(undefined)).toEqual([]);
  });

  test("returns the directives array when present", () => {
    const d = directive({ form: "chant-ignore" });
    expect(entitySuppressions(entityWith([d]))).toEqual([d]);
  });
});

describe("applyInlineSuppressions", () => {
  test("a directive naming the checkId explicitly suppresses it", () => {
    const d = directive({ form: "chant-ignore", ids: new Set(["TF010"]) });
    const entities = new Map([["e1", entityWith([d])]]);
    const { diagnostics, suppressed } = applyInlineSuppressions([diag("TF010", "e1")], entities);
    expect(diagnostics).toHaveLength(0);
    expect(suppressed).toHaveLength(1);
  });

  test("a directive naming a different id does not suppress", () => {
    const d = directive({ form: "chant-ignore", ids: new Set(["TF010"]) });
    const entities = new Map([["e1", entityWith([d])]]);
    const { diagnostics, suppressed } = applyInlineSuppressions([diag("TF011", "e1")], entities);
    expect(diagnostics).toHaveLength(1);
    expect(suppressed).toHaveLength(0);
  });

  test('"all" suppresses every rule id on the entity it anchors to', () => {
    const d = directive({ form: "chant-ignore-block", ids: "all" });
    const entities = new Map([["e1", entityWith([d])]]);
    const { diagnostics, suppressed } = applyInlineSuppressions([diag("TF001", "e1"), diag("TF999", "e1")], entities);
    expect(diagnostics).toHaveLength(0);
    expect(suppressed).toHaveLength(2);
  });

  test("a diagnostic with no entity is never suppressed (nothing to look up)", () => {
    const d = directive({ form: "chant-ignore", ids: "all" });
    const entities = new Map([["e1", entityWith([d])]]);
    const { diagnostics } = applyInlineSuppressions([diag("TF001", undefined)], entities);
    expect(diagnostics).toHaveLength(1);
  });

  test("a diagnostic whose entity carries no directives is unaffected", () => {
    const entities = new Map([["e1", entityWith(undefined)]]);
    const { diagnostics, suppressed } = applyInlineSuppressions([diag("TF001", "e1")], entities);
    expect(diagnostics).toHaveLength(1);
    expect(suppressed).toHaveLength(0);
  });

  describe("expiry", () => {
    test("an expired directive no longer suppresses, and is reported once as its own finding", () => {
      const d = directive({ form: "chant-ignore", ids: "all", expires: "2020-01-01", file: "main.tf", line: 4 });
      const entities = new Map([["e1", entityWith([d])]]);
      const { diagnostics, suppressed, meta } = applyInlineSuppressions([diag("TF001", "e1")], entities, undefined, new Date("2026-01-01"));
      expect(diagnostics).toHaveLength(1); // not suppressed: the finding still fires
      expect(suppressed).toHaveLength(0);
      expect(meta).toHaveLength(1);
      expect(meta[0].checkId).toBe(SUPPRESSION_EXPIRED_ID);
      expect(meta[0].file).toBe("main.tf");
      expect(meta[0].line).toBe(4);
    });

    test("a not-yet-expired directive still suppresses normally", () => {
      const d = directive({ form: "chant-ignore", ids: "all", expires: "2099-01-01" });
      const entities = new Map([["e1", entityWith([d])]]);
      const { diagnostics, suppressed, meta } = applyInlineSuppressions([diag("TF001", "e1")], entities, undefined, new Date("2026-01-01"));
      expect(diagnostics).toHaveLength(0);
      expect(suppressed).toHaveLength(1);
      expect(meta).toHaveLength(0);
    });

    test("an expired directive attached to several entities is reported once, not once per entity", () => {
      const d = directive({ form: "chant-ignore-file", ids: "all", expires: "2020-01-01", file: "main.tf", line: 1 });
      const entities = new Map([
        ["e1", entityWith([d])],
        ["e2", entityWith([d])],
      ]);
      const { meta } = applyInlineSuppressions([diag("TF001", "e1"), diag("TF002", "e2")], entities, undefined, new Date("2026-01-01"));
      expect(meta).toHaveLength(1);
    });
  });

  describe("a misplaced chant-ignore-file directive", () => {
    test("has no suppressing effect and is reported once as its own finding", () => {
      const d = directive({ form: "chant-ignore-file", ids: "all", misplaced: true, file: "main.tf", line: 3 });
      const entities = new Map([["e1", entityWith([d])]]);
      const { diagnostics, suppressed, meta } = applyInlineSuppressions([diag("TF001", "e1")], entities);
      expect(diagnostics).toHaveLength(1);
      expect(suppressed).toHaveLength(0);
      expect(meta).toHaveLength(1);
      expect(meta[0].checkId).toBe(SUPPRESSION_MISPLACED_FILE_ID);
      expect(meta[0].line).toBe(3);
    });
  });

  describe("ignorable: false", () => {
    const rules: Record<string, RuleConfig> = { TF008: ["error", { ignorable: false }] };

    test("a directive explicitly naming an unignorable id does not suppress it, and is itself reported", () => {
      const d = directive({ form: "chant-ignore", ids: new Set(["TF008"]) });
      const entities = new Map([["e1", entityWith([d])]]);
      const { diagnostics, suppressed, meta } = applyInlineSuppressions([diag("TF008", "e1")], entities, rules);
      expect(diagnostics).toHaveLength(1);
      expect(suppressed).toHaveLength(0);
      expect(meta.map((m) => m.checkId)).toEqual([SUPPRESSION_UNIGNORABLE_ID]);
    });

    test("an unconfigured id is ignorable by default", () => {
      const d = directive({ form: "chant-ignore", ids: new Set(["TF001"]) });
      const entities = new Map([["e1", entityWith([d])]]);
      const { diagnostics, suppressed, meta } = applyInlineSuppressions([diag("TF001", "e1")], entities, rules);
      expect(diagnostics).toHaveLength(0);
      expect(suppressed).toHaveLength(1);
      expect(meta).toHaveLength(0);
    });

    test("a directive covering a different, ignorable id in the same set still suppresses that one", () => {
      const d = directive({ form: "chant-ignore", ids: new Set(["TF008", "TF010"]) });
      const entities = new Map([["e1", entityWith([d])]]);
      const { diagnostics, suppressed } = applyInlineSuppressions([diag("TF010", "e1")], entities, rules);
      expect(diagnostics).toHaveLength(0);
      expect(suppressed).toHaveLength(1);
    });
  });
});
