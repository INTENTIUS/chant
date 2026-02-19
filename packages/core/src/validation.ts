/**
 * Validation system for declarable entities
 *
 * Provides opt-in, non-blocking validation hooks that can be used
 * to validate entities during build or discovery phases.
 */

import type { Declarable } from "./declarable";

/**
 * Result of a validation check
 */
export interface ValidationResult {
  /** Whether validation passed */
  valid: boolean;
  /** Error message if validation failed */
  message?: string;
  /** Optional additional context about the validation */
  context?: Record<string, unknown>;
}

/**
 * A validation rule that can check declarable entities
 */
export interface ValidationRule {
  /** Unique identifier for this rule */
  id: string;
  /** Human-readable description of what this rule checks */
  description: string;
  /** Validate an entity and return result */
  validate(entity: Declarable): ValidationResult;
}

/**
 * Validate an entity against a set of validation rules
 *
 * This function is opt-in and non-blocking - it returns results
 * but does not throw errors. Callers can decide how to handle
 * validation failures.
 *
 * @param entity - The declarable entity to validate
 * @param rules - Array of validation rules to apply
 * @returns Array of validation results, one per rule
 */
export function validate(
  entity: Declarable,
  rules: ValidationRule[]
): ValidationResult[] {
  return rules.map((rule) => rule.validate(entity));
}
