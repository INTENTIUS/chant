/**
 * The preview depth (#5332): `pulumi preview --json`, or `plunge preview`
 * for a member on plunge, read as an observation of the member. It is the
 * pulumi counterpart of the terraform lexicon's plan depth
 * (`CHANT_TERRAFORM_OBSERVE=plan`, `plan-observation.ts`), and carries the
 * same attribute names so one reader serves both.
 *
 * The steps are parsed by `./change-set.ts` (`pulumiSteps`,
 * `pulumiStepsAction`, `pulumiStepStates`); this module only projects them.
 *
 * | preview | node attribute |
 * |---|---|
 * | the URN's steps, as one action | `planAction` (`create`, `update`, `replace`, `delete`, `no-op`, `read`, `forget`) |
 * | the ops of each step | `planActions`, by URN |
 * | a replace that deletes first, an import | `planActionReason` |
 * | `replaceReasons` | `planReplacePaths` |
 * | inputs that hold the unknown sentinel | `planAfterUnknown` |
 * | inputs that differ on an update or replace | `planChanges`, one entry per leaf |
 *
 * A resource the member's graph already has (declared by the export) gets
 * these on its node. A resource it does not have, which is every resource
 * when the stack has no export, becomes a node of its own with status
 * `planned`, carrying the same inputs a node read from an export carries
 * (`./reference-props.ts`) beside the plan attributes. A declared resource
 * the preview lists no step for is not observed (`not-reached`).
 *
 * ## What never reaches a node
 *
 * The filter is `./reference-props.ts`'s: a secret (the envelope or the
 * blinded `"[secret]"`), a value under a key that reads as a credential, the
 * `data`, `stringData` and `binaryData` of a Kubernetes Secret or ConfigMap,
 * and a string longer than a name are left out of `planChanges`, of
 * `planReplacePaths` and of the inputs. A change under such a key is not
 * listed at all, so it can't show a secret's before or after. Only leaves
 * are emitted. An unknown after value reads {@link KNOWN_AFTER_APPLY}.
 *
 * ## Why a read did not answer
 *
 * {@link previewReadReason} turns the engine's error into one of
 * {@link PREVIEW_READ_REASONS}, written on the member's `rootReads` entry
 * (`pulumi.members.<member>`) with `depth: "preview"`.
 */
import type { ResourceMetadata } from "@intentius/chant/lexicon";
import type { UnobservedEntity } from "@intentius/chant/observation";
import { isPulumiNodeless, pulumiNodeKey } from "@intentius/chant/pulumi-urn";
import { pulumiStepStates, pulumiSteps, pulumiStepsAction, type PulumiStep } from "./change-set";
import { isNameSized, mayCarryKey, referenceProps } from "./reference-props";
import { holdsUnknown, isObject, isSecret, isUnknown, propertyKeys, propertyPathSegments, sameJson, topLevelKey } from "./values";

/** The environment variable that sets how deep a pulumi member is read (#5332). */
export const PULUMI_OBSERVE_ENV = "CHANT_PULUMI_OBSERVE";

/** `state` is the default read (the export and plunge's records); `preview` adds the engine's preview. */
export type PulumiObserveDepth = "state" | "preview";

/** The `sources` value on each resource the preview answered. */
export const PREVIEW_SOURCE = "preview";

/** What stands in for a value the preview can't know yet, as in the terraform plan observation. */
export const KNOWN_AFTER_APPLY = "(known after apply)";

/** The status of a node that exists only in the preview. */
export const PLANNED_STATUS = "planned";

/** Every attribute the preview depth adds to a node, named as the terraform plan depth names them. */
export const PREVIEW_ATTRIBUTE_NAMES = ["planAction", "planActions", "planActionReason", "planReplacePaths", "planAfterUnknown", "planChanges"] as const;

/** Why a preview read did not answer, on `rootReads[...].reason`. */
export const PREVIEW_READ_REASONS = {
  "no-credentials": "the cloud provider or the backend refused the engine's credentials, or none were found",
  "needs-install": "the program's dependencies or a provider plugin are not installed; chant never runs `pulumi install` on a read",
  "no-stack": "the member names no stack and the engine has none selected, or the stack does not exist",
  "no-binary": "the engine binary is not on PATH",
  "preview-failed": "the preview failed for another reason; the engine's first error line is in the note",
} as const;

export type PreviewReadReason = keyof typeof PREVIEW_READ_REASONS;

/** The reason an engine error maps to. First match wins, in the order of {@link PREVIEW_READ_REASONS} less `preview-failed`. */
export function previewReadReason(error: string): PreviewReadReason {
  if (/binary was not found|command not found|ENOENT/i.test(error)) return "no-binary";
  if (/no stack selected|no stacks? (found|exist)|no stack named|stack ['"]?[\w./:-]+['"]? (does not exist|not found)|stack not found/i.test(error)) return "no-stack";
  if (
    /pulumi install|npm install|yarn install|pnpm install|cannot find module|node_modules|no resource plugin|failed to load language plugin|could not find (a )?(compatible )?plugin|ModuleNotFoundError|No module named/i.test(error)
  ) {
    return "needs-install";
  }
  if (
    /no valid credential sources|NoCredentialProviders|could not find default credentials|InvalidAccessKeyId|failed to refresh cached credentials|AADSTS|token has expired|PULUMI_ACCESS_TOKEN|not logged in|you must be logged in|no credentials|unauthorized|authentication required/i.test(
      error,
    )
  ) {
    return "no-credentials";
  }
  return "preview-failed";
}

/** One leaf that differs between the two sides of a planned change. Same fields as the terraform plan depth's. */
export interface PreviewValueChange {
  path: string;
  before: unknown;
  after: unknown;
}

/** Render one path as one string: keys joined with `.`, indexes and non-identifier keys in brackets. */
export function renderPath(segments: ReadonlyArray<string | number>): string {
  let out = "";
  for (const segment of segments) {
    if (typeof segment === "number") out += `[${segment}]`;
    else if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(segment)) out += out ? `.${segment}` : segment;
    else out += `[${JSON.stringify(segment)}]`;
  }
  return out;
}

const containerOf = (v: unknown): boolean => Array.isArray(v) || isObject(v);

/** A scalar for the before side of an unknown, or null. */
function scalar(v: unknown): unknown {
  if (v === undefined || v === null || containerOf(v) || isSecret(v)) return null;
  if (typeof v === "string" && !isNameSized(v)) return null;
  return v;
}

/**
 * The leaves where two input values differ, filtered as the module comment
 * says. `unknownPaths` collects every path whose after side is unknown.
 */
function diffValues(type: unknown, before: unknown, after: unknown, at: Array<string | number>, changes: PreviewValueChange[], unknownPaths: string[]): void {
  const last = at[at.length - 1];
  if (typeof last === "string" && !mayCarryKey(last, { type, topLevel: at.length === 1 })) return;
  if (isSecret(before) || isSecret(after)) return;
  const path = renderPath(at) || "*";
  if (isUnknown(after)) {
    unknownPaths.push(path);
    changes.push({ path, before: scalar(before), after: KNOWN_AFTER_APPLY });
    return;
  }
  if (sameJson(before, after)) return;
  if (Array.isArray(before) || Array.isArray(after)) {
    const b = Array.isArray(before) ? before : [];
    const a = Array.isArray(after) ? after : [];
    for (let i = 0; i < Math.max(b.length, a.length); i++) diffValues(type, b[i], a[i], [...at, i], changes, unknownPaths);
    return;
  }
  if (isObject(before) || isObject(after)) {
    const b = isObject(before) ? before : {};
    const a = isObject(after) ? after : {};
    for (const key of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) {
      if (key.startsWith("__")) continue;
      diffValues(type, b[key], a[key], [...at, key], changes, unknownPaths);
    }
    return;
  }
  if ((typeof before === "string" && !isNameSized(before)) || (typeof after === "string" && !isNameSized(after))) return;
  changes.push({ path, before: before === undefined ? null : before, after: after === undefined ? null : after });
}

/** The plan attributes of one URN's steps. */
function attributesOf(urn: string, steps: PulumiStep[]): { type: string; id?: string; attributes: Record<string, unknown> } {
  const states = pulumiStepStates(steps);
  const mapped = pulumiStepsAction(steps);
  const type = states.after?.type ?? states.before?.type ?? "unknown";
  const knownId = [states.after?.id, states.before?.id].find((v): v is string => typeof v === "string" && v !== "" && !isUnknown(v));
  const ops = steps.map((s) => s.op ?? "");
  const action = mapped ? mapped.action : ops.join(",");

  const after = isObject(states.after?.inputs) ? states.after!.inputs! : {};
  const before = isObject(states.before?.inputs) ? states.before!.inputs! : {};
  const named = new Set<string>();
  const replaceReasons: string[] = [];
  for (const s of steps) {
    for (const k of s.diffReasons ?? []) named.add(topLevelKey(k));
    for (const [path] of Object.entries(s.detailedDiff ?? {})) named.add(topLevelKey(path));
    for (const k of s.replaceReasons ?? []) if (!replaceReasons.includes(k)) replaceReasons.push(k);
  }

  const changes: PreviewValueChange[] = [];
  const unknownPaths: string[] = [];
  if (mapped?.action === "create") {
    for (const k of propertyKeys(after).sort()) {
      if (holdsUnknown(after[k])) diffValues(type, undefined, after[k], [k], [], unknownPaths);
    }
  } else if (mapped?.action === "update" || mapped?.action === "replace") {
    const keys = new Set([...named, ...propertyKeys(after).filter((k) => holdsUnknown(after[k]))]);
    for (const k of [...keys].filter((k) => !k.startsWith("__")).sort()) diffValues(type, before[k], after[k], [k], changes, unknownPaths);
  }

  const reasons: string[] = [];
  if (mapped?.action === "replace" && mapped.disruption === "destroy") reasons.push("delete-before-replace");
  if (mapped?.importing) reasons.push("import");
  const replacePaths = replaceReasons
    .filter((p) => propertyPathSegments(p).every((seg, i) => typeof seg === "number" || mayCarryKey(seg, { type, topLevel: i === 0 })))
    .map((p) => renderPath(propertyPathSegments(p)));

  return {
    type,
    ...(knownId ? { id: knownId } : {}),
    attributes: {
      urn,
      planAction: action,
      planActions: { [urn]: ops },
      ...(reasons.length > 0 ? { planActionReason: reasons.join(",") } : {}),
      ...(replacePaths.length > 0 ? { planReplacePaths: replacePaths.sort() } : {}),
      ...(unknownPaths.length > 0 ? { planAfterUnknown: [...new Set(unknownPaths)].sort() } : {}),
      ...(changes.length > 0 ? { planChanges: changes } : {}),
    },
  };
}

/** What the preview says about a member, in the shape `describeResources` returns. */
export interface PreviewObserved {
  resources: Record<string, ResourceMetadata>;
  unobserved: Record<string, UnobservedEntity>;
  queried: Record<string, string>;
  sources: Record<string, string>;
  /** Steps whose op the change set has no action for; their `planAction` lists the ops. */
  unmapped: number;
}

/**
 * The member's preview as resources keyed `<label>/<urn tail>`, the key the
 * graph read uses. `declared` are the entities the graph already holds.
 * Returns undefined when the document has no steps.
 */
export function observePreview(opts: { label: string; preview: unknown; declared: ReadonlyMap<string, { entityType: string }> }): PreviewObserved | undefined {
  const steps = pulumiSteps(opts.preview);
  if (steps === undefined) return undefined;
  const byUrn = new Map<string, PulumiStep[]>();
  for (const s of steps) {
    const list = byUrn.get(s.urn!) ?? [];
    list.push(s);
    byUrn.set(s.urn!, list);
  }

  const resources: Record<string, ResourceMetadata> = {};
  const queried: Record<string, string> = {};
  const sources: Record<string, string> = {};
  let unmapped = 0;
  for (const [urn, list] of byUrn) {
    const key = pulumiNodeKey(urn);
    if (key === null) continue;
    const { type, id, attributes } = attributesOf(urn, list);
    if (isPulumiNodeless(type)) continue;
    const name = `${opts.label}/${key}`;
    if (!pulumiStepsAction(list)) unmapped++;
    const declared = opts.declared.has(name);
    const states = pulumiStepStates(list);
    const inputs = declared ? {} : referenceProps({ type, id, inputs: states.after?.inputs ?? states.before?.inputs, outputs: states.before?.outputs });
    resources[name] = {
      type,
      ...(id ? { physicalId: id } : {}),
      status: declared ? "recorded" : PLANNED_STATUS,
      // Never a verdict: a preview says what would run, not whose the resource is.
      ownership: "unknown",
      attributes: { ...inputs, ...attributes },
    };
    queried[name] = `${urn} (preview)`;
    sources[name] = PREVIEW_SOURCE;
  }

  const unobserved: Record<string, UnobservedEntity> = {};
  for (const [name, entity] of opts.declared) {
    if (resources[name]) continue;
    unobserved[name] = {
      type: entity.entityType,
      reason: "not-reached",
      detail: `the preview lists no step for ${name}; a preview narrowed with --target lists only its targets`,
    };
  }
  return { resources, unobserved, queried, sources, unmapped };
}
