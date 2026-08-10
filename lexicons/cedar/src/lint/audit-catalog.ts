/**
 * The cedar lexicon's `chant audit` catalog — metadata for every CED check,
 * contributed via `cedarPlugin.auditCatalog()` (#687, #1346).
 *
 * A check's own definition says what it looks for. It does not say how severe
 * the finding is, whether the fix is mechanical, what backs the rule, or what
 * to title it in a report. `resolveAuditCatalog` merges this map over core's
 * static catalog to answer all four — and it skips a lexicon that omits the
 * method *silently*, which is how fly's and temporal's checks reached the
 * report with no metadata at all. A repo-level test fails on a gap in either
 * direction, so this map and the shipped checks move together.
 *
 * Every entry here is `yamlBased: true`: each check reads `ctx.outputs` — the
 * emitted policy set — and nothing reads `ctx.entities`, so all of them fire
 * on an audit of a standalone `policies.cedar.json` exactly as they do on a
 * `chant build`. `auditRule()` hardcodes that, so it is used throughout rather
 * than constructing `RuleMeta` by hand the way fly and fountain must.
 *
 * `authority` is left off deliberately. The catalog test treats a citation as
 * proof that a finding is `security`, and Cedar's own docs are a language
 * reference rather than a benchmark like CIS or OSSF Scorecard; citing them
 * would be dressing up chant's own opinion. The one place a citation would be
 * honest — the bare-permit wall — is chant's convention, not upstream's, and
 * the verification report is explicit that Cedar's validator says nothing
 * about it.
 */

import { auditRule, type RuleMeta } from "@intentius/chant/audit/catalog";

export const cedarAuditCatalog: Record<string, RuleMeta> = {
  // ── Pre-synth lint rule ────────────────────────────────────────
  //
  // Not a post-synth check, and so not required by the coverage test — but a
  // reader who hits CEDC001 wants the same metadata as one who hits CEDC010,
  // which is the reason fountain catalogs FTN001.
  CEDC001: auditRule(
    "CEDC001",
    "merge-worthy",
    "guidance",
    "Cedar policy has an unusable effect or an empty guard",
    'Use effect: "permit" or "forbid" — anything else is emitted as a permit — and remove empty when/unless entries.',
    { category: "correctness" },
  ),

  // ── Correctness ────────────────────────────────────────────────
  CEDC010: auditRule(
    "CEDC010",
    "merge-worthy",
    "guidance",
    "Cedar policy set does not parse",
    "Fix the policy set so Cedar's own parser accepts it — no evaluator can load it as it stands.",
    { category: "correctness" },
  ),
  CEDC011: auditRule(
    "CEDC011",
    "merge-worthy",
    "guidance",
    "Cedar condition expression does not parse",
    "Correct the when/unless expression source named in the finding; the rest of the policy set cannot load until it parses.",
    { category: "correctness" },
  ),
  CEDC012: auditRule(
    "CEDC012",
    "merge-worthy",
    "guidance",
    "Duplicate Cedar policy id",
    "Rename one of the colliding declarations, or give it an explicit and distinct @id annotation — the JSON policy set keeps only one of them.",
    { category: "correctness" },
  ),
  CEDC013: auditRule(
    "CEDC013",
    "report-only",
    "guidance",
    "Cedar policy annotation is empty or disagrees with the policy id",
    "Make @id match the policy's id (or drop it and let chant derive one), and give every other annotation a real value.",
    { category: "best-practice" },
  ),
  CEDC014: auditRule(
    "CEDC014",
    "merge-worthy",
    "guidance",
    "Cedar scope constraint names a bare type instead of an entity",
    'Write the reference as a full UID — Namespace::Type::"id" — so it resolves to an entity rather than degrading to a type name with an empty id.',
    { category: "correctness" },
  ),

  // ── Evaluability (the validator) ───────────────────────────────
  CEDE010: auditRule(
    "CEDE010",
    "merge-worthy",
    "guidance",
    "Cedar policy fails validation against the schema",
    "Fix the entity type, action, or attribute the validator names — a policy the validator rejects can never grant anything. If the finding is the advisory, emit a .cedarschema beside the policies so validation can run at all.",
    { category: "correctness" },
  ),
  CEDE011: auditRule(
    "CEDE011",
    "report-only",
    "guidance",
    "Cedar validator warns about a policy",
    "Read the validator's warning — an impossible policy evaluates to false for every valid request, so the access it was written to grant does not exist.",
    { category: "correctness" },
  ),

  // ── Security ───────────────────────────────────────────────────
  CEDS010: auditRule(
    "CEDS010",
    "merge-worthy",
    "guidance",
    "Bare permit(principal, action, resource) grants everything",
    "Constrain a scope or add a when/unless guard. Cedar's validator does not flag this policy; a production build fails on it.",
    { category: "security" },
  ),
  CEDS011: auditRule(
    "CEDS011",
    "report-only",
    "guidance",
    "Cedar policy set has no forbid",
    "Add a forbid for whatever the set must never allow — a forbid beats every permit, so it is the only invariant a later grant cannot widen.",
    { category: "security" },
  ),
  CEDS012: auditRule(
    "CEDS012",
    "report-only",
    "guidance",
    "Cedar permit leaves the action scope unconstrained",
    'Name the actions the grant needs (action == Action::"read", or action in [ … ]) so it does not widen as the schema gains actions.',
    { category: "security" },
  ),

  // ── The dogwood dialect (DWD) ──────────────────────────────────
  //
  // A second id family under the same lexicon, declared on the serializer as
  // `extraRulePrefixes` (#1349's mechanism, the way k8s owns ARGO and FLUX).
  // Dogwood is a dialect of Cedar rather than a peer language — a `.dw` file
  // stripped of Cedar semantics is meaningless — so its checks ship here, and
  // its ids are their own family so a reader can tell which surface bit them.
  DWDC010: auditRule(
    "DWDC010",
    "merge-worthy",
    "guidance",
    "Dogwood temporal predicate names an undeclared event kind",
    "Declare the event kind in the emitted .dwschema, or correct the predicate to a kind the schema derives — upstream rejects the policy set otherwise.",
    { category: "correctness" },
  ),
  DWDC011: auditRule(
    "DWDC011",
    "merge-worthy",
    "guidance",
    "Dogwood temporal window exceeds the event schema's max_window",
    "Shorten the window, or raise max_window in the event schema. With no schema emitted the cap is upstream's 24h default.",
    { category: "correctness" },
  ),
  DWDC012: auditRule(
    "DWDC012",
    "merge-worthy",
    "guidance",
    "Dogwood formerly/previous/since is missing its window",
    "Give the operator a `within <n><s|m|h|d>` window — all three past-only operators require one. The typed builders take it as an argument.",
    { category: "correctness" },
  ),
  DWDS010: auditRule(
    "DWDS010",
    "report-only",
    "guidance",
    "Dogwood event schema pins nothing, widening every temporal predicate",
    "Pin a field to the deciding request (pin callerPrincipal: principalType(A) = principal), or record that cross-principal correlation is the intent — supplying any event schema opts out of upstream's default pin.",
    { category: "security" },
  ),
};
