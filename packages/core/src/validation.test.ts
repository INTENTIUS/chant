import { describe, test, expect } from "bun:test";
import {
  validate,
  type ValidationRule,
  type ValidationResult,
} from "./validation";
import type { Declarable } from "./declarable";
import { DECLARABLE_MARKER } from "./declarable";

describe("ValidationResult", () => {
  test("valid result has valid: true", () => {
    const result: ValidationResult = {
      valid: true,
    };
    expect(result.valid).toBe(true);
    expect(result.message).toBeUndefined();
  });

  test("invalid result has valid: false and message", () => {
    const result: ValidationResult = {
      valid: false,
      message: "Validation failed",
    };
    expect(result.valid).toBe(false);
    expect(result.message).toBe("Validation failed");
  });

  test("can include optional context", () => {
    const result: ValidationResult = {
      valid: false,
      message: "Invalid property",
      context: { property: "name", value: null },
    };
    expect(result.context).toEqual({ property: "name", value: null });
  });
});

describe("ValidationRule", () => {
  test("rule has id, description, and validate function", () => {
    const rule: ValidationRule = {
      id: "test-rule",
      description: "A test validation rule",
      validate: (entity: Declarable) => ({ valid: true }),
    };

    expect(rule.id).toBe("test-rule");
    expect(rule.description).toBe("A test validation rule");
    expect(typeof rule.validate).toBe("function");
  });

  test("validate function receives entity and returns result", () => {
    const entity: Declarable = {
      entityType: "Test",
      [DECLARABLE_MARKER]: true,
    };

    const rule: ValidationRule = {
      id: "test-rule",
      description: "Test rule",
      validate: (e: Declarable) => {
        expect(e).toBe(entity);
        return { valid: true };
      },
    };

    const result = rule.validate(entity);
    expect(result.valid).toBe(true);
  });
});

describe("validate", () => {
  test("returns empty array when no rules provided", () => {
    const entity: Declarable = {
      entityType: "Test",
      [DECLARABLE_MARKER]: true,
    };

    const results = validate(entity, []);
    expect(results).toEqual([]);
  });

  test("applies single rule and returns result", () => {
    const entity: Declarable = {
      entityType: "Test",
      [DECLARABLE_MARKER]: true,
    };

    const rule: ValidationRule = {
      id: "always-valid",
      description: "Always returns valid",
      validate: () => ({ valid: true }),
    };

    const results = validate(entity, [rule]);
    expect(results).toHaveLength(1);
    expect(results[0].valid).toBe(true);
  });

  test("applies multiple rules and returns all results", () => {
    const entity: Declarable = {
      entityType: "Test",
      [DECLARABLE_MARKER]: true,
    };

    const rule1: ValidationRule = {
      id: "rule-1",
      description: "First rule",
      validate: () => ({ valid: true }),
    };

    const rule2: ValidationRule = {
      id: "rule-2",
      description: "Second rule",
      validate: () => ({ valid: false, message: "Rule 2 failed" }),
    };

    const rule3: ValidationRule = {
      id: "rule-3",
      description: "Third rule",
      validate: () => ({ valid: true }),
    };

    const results = validate(entity, [rule1, rule2, rule3]);
    expect(results).toHaveLength(3);
    expect(results[0].valid).toBe(true);
    expect(results[1].valid).toBe(false);
    expect(results[1].message).toBe("Rule 2 failed");
    expect(results[2].valid).toBe(true);
  });

  test("is non-blocking - does not throw on validation failure", () => {
    const entity: Declarable = {
      entityType: "Test",
      [DECLARABLE_MARKER]: true,
    };

    const failingRule: ValidationRule = {
      id: "failing-rule",
      description: "Always fails",
      validate: () => ({ valid: false, message: "Validation failed" }),
    };

    // Should not throw
    expect(() => validate(entity, [failingRule])).not.toThrow();

    const results = validate(entity, [failingRule]);
    expect(results[0].valid).toBe(false);
  });

  test("passes entity to each rule", () => {
    const entity: Declarable & { name: string } = {
      entityType: "Test",
      [DECLARABLE_MARKER]: true,
      name: "MyEntity",
    };

    const rule1: ValidationRule = {
      id: "check-entity",
      description: "Checks entity properties",
      validate: (e: Declarable) => {
        const hasName = "name" in e && e.name === "MyEntity";
        return {
          valid: hasName,
          message: hasName ? undefined : "Entity missing name",
        };
      },
    };

    const results = validate(entity, [rule1]);
    expect(results[0].valid).toBe(true);
  });

  test("preserves rule execution order", () => {
    const entity: Declarable = {
      entityType: "Test",
      [DECLARABLE_MARKER]: true,
    };

    const executionOrder: string[] = [];

    const rule1: ValidationRule = {
      id: "first",
      description: "First",
      validate: () => {
        executionOrder.push("first");
        return { valid: true };
      },
    };

    const rule2: ValidationRule = {
      id: "second",
      description: "Second",
      validate: () => {
        executionOrder.push("second");
        return { valid: true };
      },
    };

    const rule3: ValidationRule = {
      id: "third",
      description: "Third",
      validate: () => {
        executionOrder.push("third");
        return { valid: true };
      },
    };

    validate(entity, [rule1, rule2, rule3]);
    expect(executionOrder).toEqual(["first", "second", "third"]);
  });

  test("handles rules with context in results", () => {
    const entity: Declarable & { count: number } = {
      entityType: "Test",
      [DECLARABLE_MARKER]: true,
      count: 5,
    };

    const rule: ValidationRule = {
      id: "check-count",
      description: "Validates count property",
      validate: (e: Declarable) => {
        const count = "count" in e ? (e.count as number) : 0;
        if (count < 10) {
          return {
            valid: false,
            message: "Count is too low",
            context: { count, minimum: 10 },
          };
        }
        return { valid: true };
      },
    };

    const results = validate(entity, [rule]);
    expect(results[0].valid).toBe(false);
    expect(results[0].message).toBe("Count is too low");
    expect(results[0].context).toEqual({ count: 5, minimum: 10 });
  });

  test("handles entity type validation", () => {
    const entity: Declarable = {
      entityType: "Bucket",
      [DECLARABLE_MARKER]: true,
    };

    const rule: ValidationRule = {
      id: "check-type",
      description: "Validates entity type",
      validate: (e: Declarable) => {
        const expectedTypes = ["Bucket", "Table", "Function"];
        const valid = expectedTypes.includes(e.entityType);
        return {
          valid,
          message: valid ? undefined : `Invalid type: ${e.entityType}`,
        };
      },
    };

    const results = validate(entity, [rule]);
    expect(results[0].valid).toBe(true);
  });

  test("validation is opt-in - only runs rules provided", () => {
    const entity: Declarable = {
      entityType: "Test",
      [DECLARABLE_MARKER]: true,
    };

    // If no rules provided, no validation happens
    const results = validate(entity, []);
    expect(results).toHaveLength(0);
  });

  test("returns results in same order as rules", () => {
    const entity: Declarable = {
      entityType: "Test",
      [DECLARABLE_MARKER]: true,
    };

    const rules: ValidationRule[] = [
      {
        id: "rule-a",
        description: "Rule A",
        validate: () => ({ valid: true }),
      },
      {
        id: "rule-b",
        description: "Rule B",
        validate: () => ({ valid: false, message: "B failed" }),
      },
      {
        id: "rule-c",
        description: "Rule C",
        validate: () => ({ valid: true }),
      },
    ];

    const results = validate(entity, rules);
    expect(results).toHaveLength(3);

    // Results correspond to rules by index
    expect(results[0].valid).toBe(true); // rule-a
    expect(results[1].valid).toBe(false); // rule-b
    expect(results[1].message).toBe("B failed");
    expect(results[2].valid).toBe(true); // rule-c
  });
});
