/**
 * The option keys a `*.op.ts` or `chant.config.ts` author types against this
 * lexicon's config schema (`../config.ts`), its composite
 * (`../composites/terraform-apply-op.ts`) and its four builders
 * (`../op/builders.ts`, `../op/activities/terraform.ts`). A fixed table, not
 * read from any generated registry — there is no upstream schema here (see
 * `plugin.ts`'s module doc), so this is the same set of fields those files
 * already document in their own TSDoc, restated once for the editor.
 */

export interface OptionKey {
  key: string;
  detail: string;
}

/** `TerraformConfig`'s own top-level keys (`terraform: { <here> }`). */
export const CONFIG_NAMESPACE_KEYS: OptionKey[] = [
  { key: "binary", detail: '"terraform" | "tofu" | "choudoufu" — which CLI drives the roots. Default: "terraform".' },
  { key: "roots", detail: "Named root modules. The name is the entity-key prefix." },
];

/** `TerraformRootConfig`'s keys — one entry of `terraform.roots.<name>: { <here> }`. */
export const ROOT_ENTRY_KEYS: OptionKey[] = [
  { key: "dir", detail: "Root module directory, relative to the project root. Required." },
  { key: "workspace", detail: "Terraform workspace to select for this root. Omitted means `default`." },
  { key: "varFiles", detail: "`-var-file` arguments, in order, relative to `dir`." },
  { key: "backendConfig", detail: "`-backend-config` key/value pairs handed to `init`." },
  { key: "delete", detail: '"never" | "owned-only" | "gated" — this root\'s delete mode, mapped onto choudoufu\'s policy block on a live root.' },
];

/** `TerraformApplyOpConfig`'s keys (`TerraformApplyOp({ <here> })`). */
export const APPLY_OP_KEYS: OptionKey[] = [
  { key: "name", detail: "Op name (kebab-case). `signalName` defaults to `approve-<name>`." },
  { key: "root", detail: "Key into the project's `terraform.roots`." },
  { key: "planFile", detail: "Plan file written by Plan and consumed by Apply. Default: `chant.tfplan`." },
  { key: "gate", detail: '"on-destroy" | "always" | "never" — when to emit the approval gate. Default: "on-destroy".' },
  { key: "signalName", detail: "Gate signal name. Default: `approve-<name>`." },
  { key: "gateTimeout", detail: "How long a recorded pending gate stays valid, as a duration string. Default: core's own (48h)." },
  { key: "gateDescription", detail: "Override the gate description shown to the approver." },
  { key: "upgrade", detail: "`-upgrade` on the Init step: re-resolve provider and module versions." },
  { key: "cwd", detail: "Directory each step starts the `chant.config.*` search from." },
  { key: "compensate", detail: "Saga-style rollback on a failed apply: `true` with no command throws; supply `{ command }`." },
];

/** `compensate`'s own shape when it is an object: `compensate: { <here> }`. */
export const COMPENSATE_KEYS: OptionKey[] = [
  { key: "command", detail: "Shell command that undoes a failed apply — terraform has no automatic rollback." },
];

/** Extra opts every builder wrapper accepts alongside its activity's own fields. */
const STEP_OPTS: OptionKey[] = [
  { key: "profile", detail: "Activity profile override (defaults are set per builder)." },
  { key: "id", detail: 'Step id — required for `.out` references, e.g. `plan.out.planFile`.' },
];

/** `terraformInit(root, { <here> })`'s opts — `TerraformInitArgs` minus `root`, plus step opts. */
export const INIT_OPTS_KEYS: OptionKey[] = [
  { key: "upgrade", detail: "`-upgrade`: re-resolve provider and module versions within constraints." },
  { key: "reconfigure", detail: "`-reconfigure`: ignore any existing backend state and configure afresh." },
  { key: "cwd", detail: "Directory to start the `chant.config.*` search from." },
  ...STEP_OPTS,
];

/** `terraformPlan(root, { <here> })`'s opts — `TerraformPlanArgs` minus `root`, plus step opts. */
export const PLAN_OPTS_KEYS: OptionKey[] = [
  { key: "planFile", detail: "Plan file to write, relative to the root directory. Default: `chant.tfplan`." },
  { key: "destroy", detail: "`-destroy`: plan the removal of everything the root manages." },
  { key: "cwd", detail: "Directory to start the `chant.config.*` search from." },
  ...STEP_OPTS,
];

/** `terraformApply(root, { <here> })`'s opts — `TerraformApplyArgs` minus `root`, plus step opts. */
export const APPLY_OPTS_KEYS: OptionKey[] = [
  {
    key: "planFile",
    detail:
      "The saved plan file to apply. Required on either kind of root; on a live root it is the approval " +
      "artifact the apply re-plans against and refuses on a mismatch (choudoufu #878).",
  },
  { key: "cwd", detail: "Directory to start the `chant.config.*` search from." },
  ...STEP_OPTS,
];

/** `terraformShow(root, { <here> })`'s opts — `TerraformShowArgs` minus `root`, plus step opts. */
export const SHOW_OPTS_KEYS: OptionKey[] = [
  { key: "planFile", detail: "Show this saved plan file. Omitted, the activity shows current state." },
  { key: "cwd", detail: "Directory to start the `chant.config.*` search from." },
  ...STEP_OPTS,
];

/** Every builder call name mapped to its opts table, for completion inside `(root, { <here> })`. */
export const BUILDER_OPTS_BY_CALL: Record<string, OptionKey[]> = {
  terraformInit: INIT_OPTS_KEYS,
  terraformPlan: PLAN_OPTS_KEYS,
  terraformApply: APPLY_OPTS_KEYS,
  terraformShow: SHOW_OPTS_KEYS,
};

/** Every option key across every table, keyed by name, for hover lookup. Last writer wins on a name shared across tables (`cwd`, `planFile`) — the detail text is the same fact restated per activity, so any one of them is a correct hover. */
export const ALL_OPTION_KEYS: Map<string, string> = new Map(
  [
    ...CONFIG_NAMESPACE_KEYS,
    ...ROOT_ENTRY_KEYS,
    ...APPLY_OP_KEYS,
    ...COMPENSATE_KEYS,
    ...INIT_OPTS_KEYS,
    ...PLAN_OPTS_KEYS,
    ...APPLY_OPTS_KEYS,
    ...SHOW_OPTS_KEYS,
  ].map((o) => [o.key, o.detail]),
);
