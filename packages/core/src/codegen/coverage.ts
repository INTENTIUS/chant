/**
 * Coverage analysis for lexicon artifacts.
 *
 * Analyzes a generated lexicon JSON to measure coverage across dimensions:
 * property constraints, lifecycle attributes, return attributes, and extension constraints.
 */

import type { LexiconEntryParsed } from "../lexicon-schema";

export interface ResourceCoverage {
  name: string;
  resourceType: string;
  hasPropertyConstraints: boolean;
  hasLifecycle: boolean;
  hasAttrs: boolean;
  hasConstraints: boolean;
}

export interface CoverageReport {
  resourceCount: number;
  propertyPct: number;
  lifecyclePct: number;
  attrPct: number;
  constraintPct: number;
  resources: ResourceCoverage[];
}

/**
 * Compute coverage from lexicon JSON content.
 */
export function computeCoverage(lexiconJSON: string): CoverageReport {
  const entries: Record<string, LexiconEntryParsed> = JSON.parse(lexiconJSON);

  // Deduplicate: multiple TS names may map to the same resource type
  const seen = new Set<string>();
  const resources: ResourceCoverage[] = [];

  for (const [name, entry] of Object.entries(entries)) {
    if (entry.kind !== "resource") continue;
    if (seen.has(entry.resourceType)) continue;
    seen.add(entry.resourceType);

    resources.push({
      name,
      resourceType: entry.resourceType,
      hasPropertyConstraints: !!(entry.propertyConstraints && Object.keys(entry.propertyConstraints).length > 0),
      hasLifecycle: !!(entry.createOnly?.length || entry.writeOnly?.length),
      hasAttrs: !!(entry.attrs && Object.keys(entry.attrs).length > 0),
      hasConstraints: !!(entry.constraints && entry.constraints.length > 0),
    });
  }

  const count = resources.length;
  if (count === 0) {
    return {
      resourceCount: 0,
      propertyPct: 0,
      lifecyclePct: 0,
      attrPct: 0,
      constraintPct: 0,
      resources: [],
    };
  }

  const propertyCount = resources.filter((r) => r.hasPropertyConstraints).length;
  const lifecycleCount = resources.filter((r) => r.hasLifecycle).length;
  const attrCount = resources.filter((r) => r.hasAttrs).length;
  const constraintCount = resources.filter((r) => r.hasConstraints).length;

  return {
    resourceCount: count,
    propertyPct: Math.round((propertyCount / count) * 100),
    lifecyclePct: Math.round((lifecycleCount / count) * 100),
    attrPct: Math.round((attrCount / count) * 100),
    constraintPct: Math.round((constraintCount / count) * 100),
    resources,
  };
}

/**
 * Overall coverage percentage (average of all dimensions).
 */
export function overallPct(report: CoverageReport): number {
  return Math.round(
    (report.propertyPct + report.lifecyclePct + report.attrPct + report.constraintPct) / 4,
  );
}

/**
 * Format a human-readable coverage summary.
 */
export function formatSummary(report: CoverageReport): string {
  const lines: string[] = [];
  lines.push(`Coverage Report: ${report.resourceCount} resources`);
  lines.push(`  Property constraints: ${report.propertyPct}%`);
  lines.push(`  Lifecycle (createOnly/writeOnly): ${report.lifecyclePct}%`);
  lines.push(`  Return attributes: ${report.attrPct}%`);
  lines.push(`  Extension constraints: ${report.constraintPct}%`);
  lines.push(`  Overall: ${overallPct(report)}%`);
  return lines.join("\n");
}

/**
 * Threshold configuration for coverage enforcement.
 */
export interface CoverageThresholds {
  minPropertyPct?: number;
  minLifecyclePct?: number;
  minAttrPct?: number;
  minConstraintPct?: number;
  minOverallPct?: number;
}

export interface ThresholdResult {
  ok: boolean;
  violations: string[];
}

/**
 * Check coverage report against thresholds.
 */
export function checkThresholds(report: CoverageReport, thresholds: CoverageThresholds): ThresholdResult {
  const violations: string[] = [];

  if (thresholds.minPropertyPct !== undefined && report.propertyPct < thresholds.minPropertyPct) {
    violations.push(`Property constraints: ${report.propertyPct}% < ${thresholds.minPropertyPct}% minimum`);
  }
  if (thresholds.minLifecyclePct !== undefined && report.lifecyclePct < thresholds.minLifecyclePct) {
    violations.push(`Lifecycle: ${report.lifecyclePct}% < ${thresholds.minLifecyclePct}% minimum`);
  }
  if (thresholds.minAttrPct !== undefined && report.attrPct < thresholds.minAttrPct) {
    violations.push(`Return attributes: ${report.attrPct}% < ${thresholds.minAttrPct}% minimum`);
  }
  if (thresholds.minConstraintPct !== undefined && report.constraintPct < thresholds.minConstraintPct) {
    violations.push(`Extension constraints: ${report.constraintPct}% < ${thresholds.minConstraintPct}% minimum`);
  }
  if (thresholds.minOverallPct !== undefined && overallPct(report) < thresholds.minOverallPct) {
    violations.push(`Overall: ${overallPct(report)}% < ${thresholds.minOverallPct}% minimum`);
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Format verbose per-resource coverage details.
 */
export function formatVerbose(report: CoverageReport): string {
  const lines: string[] = [formatSummary(report), ""];

  const sorted = [...report.resources].sort((a, b) => a.name.localeCompare(b.name));

  for (const r of sorted) {
    const missing: string[] = [];
    if (!r.hasPropertyConstraints) missing.push("property-constraints");
    if (!r.hasLifecycle) missing.push("lifecycle");
    if (!r.hasAttrs) missing.push("attrs");
    if (!r.hasConstraints) missing.push("constraints");

    if (missing.length === 0) {
      lines.push(`  ${r.name} (${r.resourceType}): full coverage`);
    } else {
      lines.push(`  ${r.name} (${r.resourceType}): missing ${missing.join(", ")}`);
    }
  }

  return lines.join("\n");
}
