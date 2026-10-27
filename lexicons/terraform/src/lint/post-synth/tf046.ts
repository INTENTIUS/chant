/**
 * TF046: a live root's record store is local, and the lint runs in CI.
 *
 * A live root keeps its records (what binds a record-backed resource to the
 * estate) in a record store. With nothing to say otherwise that store is a
 * directory beside the module (choudoufu `live/STORAGE.md`), and on a CI
 * runner the directory is empty on every run: an ordinary resource still binds
 * by its marker, but a record-backed one is proposed for create again.
 *
 * "Local" is what choudoufu resolves, read here through `./record-store.ts`,
 * the same resolution TF024 names in its message (INTENTIUS/choudoufu#2293):
 *
 * - an explicit `record_store "local"` fires;
 * - an explicit `record_store` of any other kind is quiet, whatever backend
 *   sits beside it;
 * - with no `record_store`, an ignored `backend "s3"`, `"gcs"` or `"azurerm"`
 *   block that names its bucket as a literal gives a derived store and is
 *   quiet;
 * - with no `record_store` and no backend, or a backend with no counterpart
 *   (`local`, `consul`, `http`), or one whose bucket comes only from
 *   `-backend-config`, the store is implied local and the rule fires, naming
 *   the reason choudoufu would print.
 *
 * A root that is also a Terragrunt unit with a `remote_state`, a `generate`
 * block that writes a backend, or an `include` of a parent config gets its
 * backend file at run time, so what chant reads is not what choudoufu sees.
 * The rule stays quiet there rather than guess; TF044 still reports a
 * Terragrunt `backend = "local"`.
 *
 * CI is read from the environment chant runs in: `CI` set to anything but
 * `false` or `0`, or `GITHUB_ACTIONS`, `GITLAB_CI`, `FORGEJO_ACTIONS`,
 * `GITEA_ACTIONS` or `TF_BUILD` (Azure Pipelines) set to `true`. Outside CI the
 * local store is a reasonable choice for one person or a demo, and the rule
 * says nothing.
 *
 * Opt-outs, for emulator and test lanes that use the local store on purpose:
 * `CHANT_ALLOW_LOCAL_RECORD_STORE=1` in the lane's environment, or
 * `# chant-ignore-block: TF046` above the `terraform` block holding `live`
 * for one root, or
 * `lint.rules: { TF046: "off" }` for a whole project.
 *
 * The rule is `report-only` in the audit catalog, so it is off under the
 * `recommended` preset: terragucci switches it on and holds the product
 * wording (chant#4561 placement).
 *
 * One diagnostic per root. It fires from the `terraform` block that holds the
 * `live` block, since suppression comments anchor on top-level blocks only,
 * and from the sidecar's `Terraform::Live` entity for a sidecar estate, where
 * `# chant-ignore-file: TF046` in `estate.chdf.hcl` suppresses it.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { isResourceDeclarable, type ResourceDeclarable } from "@intentius/chant/declarable";
import {
  LIVE_TYPE,
  TERRAFORM_TYPE,
  TERRAGRUNT_CONFIG_TYPE,
  TERRAGRUNT_GENERATE_TYPE,
  TERRAGRUNT_REMOTE_STATE_TYPE,
  type BlockBody,
} from "../../hcl/parse";
import { isRootScoped } from "./scope";
import { resolveRecordStore, type ResolvedRecordStore } from "./record-store";

/** The environment variable an emulator or test lane sets to keep the local store without a finding. */
export const ALLOW_LOCAL_RECORD_STORE_ENV = "CHANT_ALLOW_LOCAL_RECORD_STORE";

type Env = Readonly<Record<string, string | undefined>>;

const truthy = (v: string | undefined): boolean => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";

/** Whether the environment is a CI job. */
export function isCiEnvironment(env: Env): boolean {
  if (truthy(env.CI)) return true;
  for (const name of ["GITHUB_ACTIONS", "GITLAB_CI", "FORGEJO_ACTIONS", "GITEA_ACTIONS", "TF_BUILD"]) {
    if (env[name]?.toLowerCase() === "true") return true;
  }
  return false;
}

const bodyOf = (entity: ResourceDeclarable): BlockBody => {
  const props = entity.props as { body?: unknown };
  return (typeof props.body === "object" && props.body !== null ? props.body : {}) as BlockBody;
};

const rootOf = (entity: ResourceDeclarable): string => {
  const root = (entity.props as { root?: unknown }).root;
  return typeof root === "string" ? root : "";
};

interface LiveRoot {
  /** Entity key the finding anchors on: the live declaration's entity, until a `terraform` block holding it is seen. */
  anchor: string;
  liveBodies: BlockBody[];
  terraformBodies: BlockBody[];
  /** A Terragrunt unit whose backend file is written at run time. */
  runtimeBackend: boolean;
}

/** Whether a Terragrunt block in this root writes a backend file at run time. */
function writesRuntimeBackend(entity: ResourceDeclarable): boolean {
  const body = bodyOf(entity);
  switch (entity.entityType) {
    case TERRAGRUNT_REMOTE_STATE_TYPE:
      return body.backend !== "local";
    case TERRAGRUNT_GENERATE_TYPE: {
      const contents = typeof body.contents === "string" ? body.contents : "";
      return /\bbackend\s+"(?!local")/.test(contents);
    }
    case TERRAGRUNT_CONFIG_TYPE:
      return Array.isArray(body.includes) && body.includes.length > 0;
    default:
      return false;
  }
}

function liveRoots(ctx: PostSynthContext): Map<string, LiveRoot> {
  const roots = new Map<string, LiveRoot>();
  const terraform = new Map<string, BlockBody[]>();
  /** Per root, the key of the first `terraform` block that holds a `live` block. */
  const holder = new Map<string, string>();
  const runtime = new Set<string>();

  for (const [key, entity] of ctx.entities) {
    if (!isResourceDeclarable(entity) || !isRootScoped(entity)) continue;
    const root = rootOf(entity);
    if (entity.entityType === TERRAFORM_TYPE) {
      const list = terraform.get(root) ?? [];
      const body = bodyOf(entity);
      list.push(body);
      terraform.set(root, list);
      if (body.live !== undefined && !holder.has(root)) holder.set(root, key);
      continue;
    }
    if (entity.entityType === LIVE_TYPE) {
      if ((entity.props as { mode?: unknown }).mode !== "live") continue;
      const found = roots.get(root);
      if (found) found.liveBodies.push(bodyOf(entity));
      else roots.set(root, { anchor: key, liveBodies: [bodyOf(entity)], terraformBodies: [], runtimeBackend: false });
      continue;
    }
    if (writesRuntimeBackend(entity)) runtime.add(root);
  }

  for (const [root, live] of roots) {
    live.terraformBodies = terraform.get(root) ?? [];
    live.anchor = holder.get(root) ?? live.anchor;
    live.runtimeBackend = runtime.has(root);
  }
  return roots;
}

function message(root: string, store: ResolvedRecordStore): string {
  const why =
    store.source === "record_store"
      ? 'Its live declaration names record_store "local", a directory beside the module.'
      : store.note
        ? `It declares no record_store, and no store is derived from its backend: ${store.note}.`
        : store.backend
          ? `It declares no record_store, and its backend "${store.backend}" block keeps state on local disk, so choudoufu uses the local store.`
          : "It declares no record_store and has no backend block to derive one from, so choudoufu uses the local store.";
  return (
    `Live root "${root}" keeps its records in the local store, and this is a CI run. ${why} ` +
    "A CI runner starts with an empty directory every run, so each record-backed resource is proposed " +
    "for create again. Keep or add a backend \"s3\", \"gcs\" or \"azurerm\" block with a literal bucket " +
    "(choudoufu derives the store from it), or declare a record_store in the live block or " +
    `estate.chdf.hcl. A lane that uses the local store on purpose sets ${ALLOW_LOCAL_RECORD_STORE_ENV}=1.`
  );
}

/**
 * TF046 against an explicit environment. `tf046.check` passes `process.env`;
 * tests pass their own.
 */
export function checkLocalRecordStore(ctx: PostSynthContext, env: Env): PostSynthDiagnostic[] {
  if (!isCiEnvironment(env) || truthy(env[ALLOW_LOCAL_RECORD_STORE_ENV])) return [];
  const diagnostics: PostSynthDiagnostic[] = [];
  for (const [root, live] of liveRoots(ctx)) {
    if (live.runtimeBackend) continue;
    const store = resolveRecordStore(live.terraformBodies, live.liveBodies);
    if (store.kind !== "local") continue;
    diagnostics.push({
      checkId: "TF046",
      severity: "error",
      message: message(root, store),
      entity: live.anchor,
      lexicon: "terraform",
    });
  }
  return diagnostics;
}

export const tf046: PostSynthCheck = {
  id: "TF046",
  description: "Live root resolves to the local record store in a CI run",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkLocalRecordStore(ctx, process.env);
  },
};
