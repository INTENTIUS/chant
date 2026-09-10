import type { LintRule } from "@intentius/chant/lint/rule";
import { trafficLevelShapeRule } from "./traffic-level-shape";

export { trafficLevelShapeRule } from "./traffic-level-shape";

/** All lint rules provided by this lexicon (imported by plugin.ts's lintRules()). */
export const rules: LintRule[] = [trafficLevelShapeRule];
