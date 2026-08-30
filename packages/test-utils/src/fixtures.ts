import type { Declarable } from "../../core/src/declarable";
import type { Serializer } from "../../core/src/serializer";
import type { LintRule, LintContext, LintDiagnostic } from "../../core/src/lint/rule";
import type { PostSynthContext } from "../../core/src/lint/post-synth";
import { createDocsAccessor } from "../../core/src/lint/post-synth";
import { DECLARABLE_MARKER } from "../../core/src/declarable";
import * as ts from "typescript";

/**
 * Creates a mock Declarable entity for testing
 * @param type - Optional entity type (default: "TestEntity")
 * @returns A mock Declarable entity
 */
export function createMockEntity(type = "TestEntity"): Declarable {
  return {
    lexicon: "test",
    entityType: type,
    [DECLARABLE_MARKER]: true,
  };
}

/**
 * Creates a mock Serializer for testing
 * @param name - Optional serializer name (default: "test")
 * @returns A mock Serializer implementation
 */
export function createMockSerializer(name = "test"): Serializer {
  return {
    name,
    rulePrefix: name.toUpperCase(),
    serialize: (entities) => {
      const result: Record<string, unknown> = {};
      entities.forEach((entity, entityName) => {
        result[entityName] = { type: entity.entityType };
      });
      return JSON.stringify({ resources: result }, null, 2);
    },
  };
}

/**
 * Creates a mock LintRule for testing
 * @param id - Optional rule ID (default: "test-rule")
 * @param diagnostics - Optional array of diagnostics to return (default: empty array)
 * @returns A mock LintRule implementation
 */
export function createMockLintRule(
  id = "test-rule",
  diagnostics: LintDiagnostic[] = []
): LintRule {
  return {
    id,
    severity: "error",
    category: "correctness",
    check: (): LintDiagnostic[] => diagnostics,
  };
}

/**
 * Creates a LintContext from a code string for testing
 * @param code - TypeScript source code string
 * @param filePath - Optional file path (default: "test.ts")
 * @returns A LintContext object with parsed source file
 */
export function createMockLintContext(
  code: string,
  filePath = "test.ts"
): LintContext {
  const sourceFile = ts.createSourceFile(
    filePath,
    code,
    ts.ScriptTarget.Latest,
    true
  );

  return {
    sourceFile,
    entities: [],
    filePath,
  };
}

/**
 * Creates a PostSynthContext from a map of lexicon name → template object.
 * Each template object is JSON-serialized.
 *
 * `ctx.docs` (chant #975) is wired up here the same way `runPostSynthChecks`
 * wires it up in production — lazy, memoized via `createDocsAccessor` over
 * the same `outputs` map — so a check under test can read `ctx.docs` without
 * this fixture and the real build path disagreeing on what it returns.
 *
 * @param outputs - Map or record of lexicon name → template object
 * @returns A PostSynthContext for testing post-synth checks
 */
export function createPostSynthContext(
  outputs: Record<string, object>,
): PostSynthContext {
  const serialized = new Map<string, string>();
  for (const [key, value] of Object.entries(outputs)) {
    serialized.set(key, JSON.stringify(value));
  }
  const getDocs = createDocsAccessor(serialized);
  return {
    outputs: serialized,
    entities: new Map(),
    buildResult: {
      outputs: serialized,
      entities: new Map(),
      warnings: [],
      errors: [],
      sourceFileCount: 0,
    },
    get docs() {
      return getDocs();
    },
  };
}
