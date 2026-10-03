/**
 * Prior art for the prometheus lexicon's audit rules: the tools whose checks
 * cover the same condition, credited per rule. See
 * packages/core/src/audit/prior-art.ts for the registry, the relation
 * vocabulary, and why this is credit rather than authority. Kept by hand.
 *
 * Mapped against each tool's own check list (#2916):
 *
 * - promtool check rules parses a rule file with Prometheus's rulefmt
 *   package (model/rulefmt/rulefmt.go): repeated group names, record/alert
 *   exclusivity, annotations/for/keep_firing_for on recording rules, durations,
 *   and PromQL syntax. It has no per-rule ids, so those credits omit `rule`.
 * - amtool check-config loads an Alertmanager config with the same code the
 *   server uses (config/config.go): undefined receivers and time intervals,
 *   non-unique names, a root route that is missing, has no receiver or has
 *   matchers, matcher syntax, durations, missing integration destinations and
 *   credentials, and "at most one of X and X_file". No per-rule ids either.
 * - pint (cloudflare/pint, docs/checks/) is a rule linter with named checks.
 *   promql/syntax, rule/duplicate, rule/label, alerts/annotation and
 *   alerts/for map onto chant rules. rule/label and alerts/annotation are
 *   configurable "this label or annotation must exist" checks that pint ships
 *   with nothing enabled, so they overlap PROM106 and PROM107 and no more.
 *
 * The PROM211-PROM219 rule-file checks (#3363), against the same list:
 * - alerts/comparison and promql/regexp are the same checks as PROM213 and
 *   PROM218, so those are equivalent.
 * - rule/for enforces a configured minimum `for`, and alerts/annotation a
 *   configured annotation; with `for` required and runbook_url named they
 *   are PROM211 and PROM212. alerts/for is not credited: it rejects bad
 *   values and a redundant `for: 0s`, not a missing `for`.
 * - alerts/template covers PROM214's dropped label and checks template
 *   syntax besides. promql/rate reads the metric type from a live
 *   Prometheus's metadata; PROM215 has only the name to go on. rule/name
 *   is a configured name regex; PROM217 fixes it to level:metric:operations.
 *   All three overlap.
 *
 * Deliberately without a credit from these tools:
 * - PROM001 and PROM003: a literal credential in TypeScript source, and the
 *   Slo objective/window model. Neither tool reads either.
 * - PROM202 (severity not routed) and PROM207 (receiver never routed to):
 *   check-config accepts both, and `amtool config routes test` answers a
 *   different question (where one given label set goes).
 * - PROM216 (histogram_quantile without _bucket or le) and PROM219
 *   (alertname set by hand): no pint check reports either, and promtool's
 *   rulefmt accepts both.
 * - PROM220-PROM224: check-config accepts insecure_skip_verify, SMTP auth
 *   without TLS, credentials over http://, a repeat_interval under
 *   group_interval, and an inhibit rule without equal.
 */
import type { Lineage } from "@intentius/chant/audit/catalog";

const RULEFMT = "https://github.com/prometheus/prometheus/blob/main/model/rulefmt/rulefmt.go";
const AM_CONFIG = "https://github.com/prometheus/alertmanager/blob/main/config/config.go";
const PINT = "https://github.com/cloudflare/pint/blob/main/docs/checks";

const amtool = (relation: Lineage["relation"]): Lineage => ({
  tool: "amtool",
  url: AM_CONFIG,
  relation,
});

export const prometheusAuditLineage: Record<string, Lineage[]> = {
  PROM002: [
    { tool: "promtool", url: RULEFMT, relation: "equivalent" },
    { tool: "pint", rule: "promql/syntax", url: `${PINT}/promql/syntax.md`, relation: "equivalent" },
  ],
  PROM101: [{ tool: "promtool", url: RULEFMT, relation: "equivalent" }],
  PROM102: [{ tool: "pint", rule: "rule/duplicate", url: `${PINT}/rule/duplicate.md`, relation: "overlaps" }],
  PROM103: [
    { tool: "promtool", url: RULEFMT, relation: "equivalent" },
    { tool: "pint", rule: "alerts/for", url: `${PINT}/alerts/for.md`, relation: "overlaps" },
  ],
  PROM104: [
    { tool: "promtool", url: RULEFMT, relation: "equivalent" },
    { tool: "pint", rule: "promql/syntax", url: `${PINT}/promql/syntax.md`, relation: "equivalent" },
  ],
  PROM105: [{ tool: "promtool", url: RULEFMT, relation: "equivalent" }],
  PROM106: [{ tool: "pint", rule: "rule/label", url: `${PINT}/rule/label.md`, relation: "overlaps" }],
  PROM107: [{ tool: "pint", rule: "alerts/annotation", url: `${PINT}/alerts/annotation.md`, relation: "overlaps" }],
  PROM201: [amtool("equivalent")],
  PROM203: [amtool("equivalent")],
  PROM204: [amtool("equivalent")],
  PROM205: [amtool("equivalent")],
  PROM206: [amtool("equivalent")],
  PROM208: [amtool("equivalent")],
  PROM209: [amtool("overlaps")],
  PROM210: [amtool("overlaps")],
  PROM211: [{ tool: "pint", rule: "rule/for", url: `${PINT}/rule/for.md`, relation: "overlaps" }],
  PROM212: [{ tool: "pint", rule: "alerts/annotation", url: `${PINT}/alerts/annotation.md`, relation: "overlaps" }],
  PROM213: [{ tool: "pint", rule: "alerts/comparison", url: `${PINT}/alerts/comparison.md`, relation: "equivalent" }],
  PROM214: [{ tool: "pint", rule: "alerts/template", url: `${PINT}/alerts/template.md`, relation: "overlaps" }],
  PROM215: [{ tool: "pint", rule: "promql/rate", url: `${PINT}/promql/rate.md`, relation: "overlaps" }],
  PROM217: [{ tool: "pint", rule: "rule/name", url: `${PINT}/rule/name.md`, relation: "overlaps" }],
  PROM218: [{ tool: "pint", rule: "promql/regexp", url: `${PINT}/promql/regexp.md`, relation: "equivalent" }],
};
