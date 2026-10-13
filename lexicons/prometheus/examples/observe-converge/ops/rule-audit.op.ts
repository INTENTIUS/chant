// Hourly: what the live Prometheus says about the rules. Groups with a rule
// in error, alerts pending past an hour or firing past a day, and selectors
// no target writes (one query each, at most 50).
import { RuleAuditOp } from "@intentius/chant-lexicon-prometheus";

export const { op: ruleAudit } = RuleAuditOp({ name: "rule-audit", schedule: "0 * * * *" });
