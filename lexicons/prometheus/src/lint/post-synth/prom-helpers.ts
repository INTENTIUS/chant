/**
 * Shared plumbing for the prometheus post-synth checks: find the rule files
 * and `alertmanager.yml` documents in a build's output, and run the
 * plain-function checks over them.
 *
 * Documents are recognized by shape, not by which lexicon emitted them, so a
 * rule file that reaches the output some other way (a hand-written YAML
 * sidecar) is checked too. `PrometheusRule` manifests are not read here;
 * their groups are the same `RuleGroup`s and are checked where they are
 * declared.
 */

import type { PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { loadAll } from "js-yaml";
import { looksLikeAlertmanagerConfig, looksLikeRuleFile, type AlertmanagerConfig, type RuleFileConfig } from "../../model";
import {
  validateAlertmanagerConfig,
  validateRuleFile,
  validateSeverityRouting,
  type PrometheusIssue,
  type PrometheusIssueCode,
} from "../../validate-config";

export interface FoundDocs {
  ruleFiles: Array<{ source: string; config: RuleFileConfig }>;
  alertmanager: Array<{ source: string; config: AlertmanagerConfig }>;
}

/** Every rule file and Alertmanager config in the output. Parsed with js-yaml rather than `ctx.docs`, which keeps block scalars and flow lists as strings. */
export function prometheusDocs(ctx: PostSynthContext): FoundDocs {
  const found: FoundDocs = { ruleFiles: [], alertmanager: [] };
  for (const [lexicon, output] of ctx.outputs) {
    const texts: Array<[string, string]> =
      typeof output === "string"
        ? [[lexicon, output]]
        : [[lexicon, (output as SerializerResult).primary], ...Object.entries((output as SerializerResult).files ?? {})];
    for (const [source, text] of texts) {
      if (!text) continue;
      let docs: unknown[];
      try {
        docs = loadAll(text);
      } catch {
        continue; // not YAML, or not ours
      }
      for (const doc of docs) {
        if (looksLikeRuleFile(doc)) found.ruleFiles.push({ source, config: doc });
        else if (looksLikeAlertmanagerConfig(doc)) found.alertmanager.push({ source, config: doc });
      }
    }
  }
  return found;
}

function toDiagnostic(issue: PrometheusIssue, source: string): PostSynthDiagnostic {
  return {
    checkId: issue.code,
    severity: issue.severity,
    message: source && source !== "prometheus" ? `${source}: ${issue.message}` : issue.message,
    ...(issue.subject ? { entity: issue.subject } : {}),
    lexicon: "prometheus",
  };
}

/** Diagnostics for one rule-file code (PROM101-PROM107) across every rule file in the output. */
export function ruleFileDiagnostics(ctx: PostSynthContext, code: PrometheusIssueCode): PostSynthDiagnostic[] {
  return prometheusDocs(ctx).ruleFiles.flatMap(({ source, config }) =>
    validateRuleFile(config)
      .filter((i) => i.code === code)
      .map((i) => toDiagnostic(i, source)),
  );
}

/** Diagnostics for one Alertmanager code (PROM201, PROM203-PROM210) across every `alertmanager.yml` in the output. */
export function alertmanagerDiagnostics(ctx: PostSynthContext, code: PrometheusIssueCode): PostSynthDiagnostic[] {
  return prometheusDocs(ctx).alertmanager.flatMap(({ source, config }) =>
    validateAlertmanagerConfig(config)
      .filter((i) => i.code === code)
      .map((i) => toDiagnostic(i, source)),
  );
}

/** PROM202: joins every rule file in the output against every Alertmanager config in it. Silent when either is absent. */
export function routingDiagnostics(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const { ruleFiles, alertmanager } = prometheusDocs(ctx);
  if (ruleFiles.length === 0) return [];
  const files = ruleFiles.map((r) => r.config);
  return alertmanager.flatMap(({ source, config }) => validateSeverityRouting(files, config).map((i) => toDiagnostic(i, source)));
}
