/**
 * A release train across repositories (#5119): the control repo dispatches
 * into each member repository in turn, and each member answers with its
 * existing `<product>-applied` dispatch.
 *
 * - The control repo's promote (`chant workspace train promote`, in
 *   ../workspace/release-train.ts) sends one `<product>-train` dispatch to a
 *   member repository, carrying the member, the environment, the train, the
 *   run of its promote, the release digest and the release's commit. It
 *   holds one dispatch-only token per member repository
 *   ({@link trainTokenEnv}) and no cloud credentials.
 * - The member's `<product>-train` job checks out the release's commit and
 *   runs `chant run --components all --env <env> --release <digest>` under
 *   its own identity, so its deploy records name the release. It then tells
 *   the control repo how the run ended, with the train's fields, through
 *   the dispatch step of ./dispatch.ts.
 * - The control repo records that answer in `_control/applied.jsonl` and
 *   continues the train (`--continue`): the next member after `applied` or
 *   `unchanged`, else the train stops there.
 *
 * The jobs are written for GitHub and Forgejo, whose workflows share one
 * shape; a GitLab member repository takes no train dispatch yet. This file
 * builds the requests and the jobs; the forge lexicons serialize the jobs.
 * Like ./dispatch.ts it imports types and the words alone, so a product
 * bundle can carry it.
 */

import type { ForgeFetch, ForgeKind } from "../pr-forge";
import { resolveProductWords, type CiProductWords, type CiProductWordsInput } from "../ci-product-words";
import {
  CONTROL_CHANT_COMMAND,
  CONTROL_ENV_VAR,
  CONTROL_NAME,
  CONTROL_OUTCOME_VAR,
  CONTROL_REF,
  CONTROL_REF_DEFAULT,
  CONTROL_RELEASE_DIGEST,
  CONTROL_RELEASE_VAR,
  CONTROL_RUN_ID,
  CONTROL_RUN_VAR,
  CONTROL_SHA_VAR,
  CONTROL_TOKEN_ENV,
  CONTROL_TRAIN_ID,
  CONTROL_TRAIN_VAR,
  ControlConfigError,
  ControlDispatchError,
  controlDispatchScript,
  forgeApiBase,
  forgeFromHost,
  shellPatterns,
  trainTokenEnv,
  trainTokenEnvOf,
  type ControlTarget,
} from "./dispatch";

export { trainTokenEnv, trainTokenEnvOf };

/** The first chant with release trains across repositories (#5119). `trainControlJobSpec` present means the rest is too. */
export const CONTROL_TRAIN_FLOOR = "0.124.98";

/** The variables the member's train job reads the dispatch from. */
export const TRAIN_ENV_VAR = "CHANT_TRAIN_ENV";
export const TRAIN_ID_VAR = "CHANT_TRAIN_ID";
export const TRAIN_RUN_VAR = "CHANT_TRAIN_RUN";
export const TRAIN_RELEASE_VAR = "CHANT_TRAIN_RELEASE";
export const TRAIN_COMMIT_VAR = "CHANT_TRAIN_COMMIT";

/** The variable a control repo's job names its product in, so the dispatch's event and file names are the product's: `<product>-train`. */
export const TRAIN_PRODUCT_VAR = "CHANT_TRAIN_PRODUCT";

/** The product a control repo's job names in {@link TRAIN_PRODUCT_VAR}, or chant's when it names none or one that is not a name. */
export function trainProductOf(env: Record<string, string | undefined> = process.env): CiProductWordsInput {
  const p = env[TRAIN_PRODUCT_VAR];
  return p && /^[a-z][a-z0-9-]{0,63}$/.test(p) ? { product: p } : {};
}

/** The exit code `chant run` ends with when a run waits at a gate (`CHANT_EXIT.waiting`). */
const WAITING_EXIT = 3;

const SHA = /^[0-9a-f]{7,64}$/;

/** The forges a train dispatches into and its jobs are written for. */
export type TrainForge = Exclude<ForgeKind, "gitlab">;

/** The event type of the dispatch a member repository takes: `<product>-train`. */
export function trainDispatchEvent(wordsIn: CiProductWordsInput | CiProductWords = {}): string {
  return `${resolveProductWords(wordsIn).product}-train`;
}

/** The train workflow's file name, the same in the member repository and the control repo: `<product>-train.yml`. */
export function trainPipelineFileName(wordsIn: CiProductWordsInput | CiProductWords = {}): string {
  return `${resolveProductWords(wordsIn).product}-train.yml`;
}

/** Where the train workflow goes on each forge. */
export function trainPipelinePath(forge: TrainForge, wordsIn: CiProductWordsInput | CiProductWords = {}): string {
  return `${forge === "github" ? ".github" : ".forgejo"}/workflows/${trainPipelineFileName(wordsIn)}`;
}

/** What one dispatch into a member repository carries. */
export interface TrainDispatch {
  member: string;
  env: string;
  train: string;
  run: string;
  releaseDigest: string;
  /** The release's commit, which the member checks out and runs. */
  commit: string;
}

/** The problems with a dispatch, or [] when it can be sent. */
export function trainDispatchProblems(d: TrainDispatch): string[] {
  const out: string[] = [];
  if (!CONTROL_NAME.test(d.member)) out.push(`member "${d.member}" is not a member's name`);
  if (!CONTROL_NAME.test(d.env)) out.push(`env "${d.env}" is not an environment's name`);
  if (!CONTROL_TRAIN_ID.test(d.train)) out.push(`train "${d.train}" is not a release train's id`);
  if (!CONTROL_RUN_ID.test(d.run)) out.push(`run "${d.run}" is not a workspace run's id`);
  if (!CONTROL_RELEASE_DIGEST.test(d.releaseDigest)) out.push(`release "${d.releaseDigest}" is not a release digest`);
  if (!SHA.test(d.commit)) out.push(`commit "${d.commit}" is not a commit sha`);
  return out;
}

/** A member repository a train dispatches into. */
export interface TrainMemberTarget {
  /** The repository's URL as the declaration names it, credentials removed. */
  repo: string;
  host: string;
  path: string;
  forge: TrainForge;
  apiBase: string;
  /** The branch a Forgejo dispatch runs on. */
  ref: string;
}

/**
 * The forge repository a `repo` member's URL names: `https://<host>/<path>`,
 * `ssh://[user@]<host>/<path>` or `<user>@<host>:<path>`, with or without
 * `.git`. A local path names no forge and is refused, as is a host that
 * does not say which forge it is unless `forge` does, and a GitLab one.
 */
export function trainMemberTarget(url: string, opts: { forge?: ForgeKind; apiBase?: string; ref?: string } = {}): TrainMemberTarget {
  let host: string;
  let path: string;
  const scp = /^[^@/\s]+@([^:/\s]+):(?!\/\/)(.+)$/.exec(url);
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    let u: URL | null = null;
    try {
      u = new URL(url);
    } catch {
      u = null;
    }
    if (!u || !["https:", "http:", "ssh:"].includes(u.protocol) || u.hostname === "") throw new ControlConfigError(`${url} names no forge repository, so the train cannot dispatch into it`);
    host = u.protocol === "ssh:" ? u.hostname : u.host;
    path = u.pathname.replace(/^\/+/, "");
  }
  path = path.replace(/\.git$/, "").replace(/\/+$/, "");
  if (path.split("/").length < 2 || path.split("/").some((p) => p === "")) throw new ControlConfigError(`${url} names no <owner>/<name> repository`);
  const forge = opts.forge ?? forgeFromHost(host);
  if (!forge) throw new ControlConfigError(`${url}: its host does not say which forge it is`);
  // The member's train job is written for GitHub and Forgejo; a GitLab member would never answer.
  if (forge === "gitlab") throw new ControlConfigError(`${url} is on GitLab, and a train dispatches into GitHub and Forgejo repositories only`);
  const ref = opts.ref ?? CONTROL_REF_DEFAULT;
  if (!CONTROL_REF.test(ref)) throw new ControlConfigError(`"${ref}" is not a branch name`);
  return { repo: url.replace(/\/\/[^@/]*@/, "//"), host, path, forge, apiBase: (opts.apiBase ?? forgeApiBase(forge, host)).replace(/\/+$/, ""), ref };
}

/** One dispatch request into a member repository, without its token. */
export interface TrainDispatchRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: { json: Record<string, unknown> };
  token: { in: "header"; name: string; scheme: string };
}

/**
 * The request that starts a member's train job: GitHub's `repository_dispatch`
 * of `<product>-train`, or a Forgejo workflow dispatch of `<product>-train.yml`.
 */
export function trainDispatchRequest(target: TrainMemberTarget, d: TrainDispatch, wordsIn: CiProductWordsInput | CiProductWords = {}): TrainDispatchRequest {
  const problems = trainDispatchProblems(d);
  if (problems.length > 0) throw new ControlConfigError(`the train's dispatch to ${target.repo}: ${problems.join(", ")}`, problems);
  const fields = { member: d.member, env: d.env, train: d.train, run: d.run, release: d.releaseDigest, commit: d.commit };
  if (target.forge === "github") {
    return {
      url: `${target.apiBase}/repos/${target.path}/dispatches`,
      method: "POST",
      headers: { Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: { json: { event_type: trainDispatchEvent(wordsIn), client_payload: fields } },
      token: { in: "header", name: "Authorization", scheme: "Bearer" },
    };
  }
  return {
    url: `${target.apiBase}/repos/${target.path}/actions/workflows/${trainPipelineFileName(wordsIn)}/dispatches`,
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: { json: { ref: target.ref, inputs: fields } },
    token: { in: "header", name: "Authorization", scheme: "token" },
  };
}

/** What {@link dispatchTrainMember} takes. */
export interface DispatchTrainOptions {
  /** The dispatch token. Default: {@link trainTokenEnv} of the member in `env`. */
  token?: string;
  env?: Record<string, string | undefined>;
  fetch?: ForgeFetch;
  words?: CiProductWordsInput | CiProductWords;
}

/**
 * Sends one dispatch into a member repository. A missing token or a status
 * other than 2xx throws {@link ControlDispatchError}, the token cut out of
 * the forge's answer.
 */
export async function dispatchTrainMember(target: TrainMemberTarget, d: TrainDispatch, opts: DispatchTrainOptions = {}): Promise<{ status: number }> {
  const tokenVar = trainTokenEnv(d.member);
  const token = opts.token ?? (opts.env ?? process.env)[tokenVar];
  if (!token) throw new ControlDispatchError(`${tokenVar} is not set, so ${target.repo} was not dispatched; give the control repo a secret of that name holding a token that may dispatch there and do nothing else`, undefined);
  const req = trainDispatchRequest(target, d, opts.words);
  const headers = { ...req.headers, [req.token.name]: `${req.token.scheme} ${token}` };
  const fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as ForgeFetch);
  let res: Awaited<ReturnType<ForgeFetch>>;
  try {
    res = await fetchImpl(req.url, { method: req.method, headers, body: JSON.stringify(req.body.json) });
  } catch (e) {
    throw new ControlDispatchError(`the dispatch to ${target.repo} could not be sent: ${String((e as Error).message ?? e).split(token).join("***")}`, undefined);
  }
  if (res.status < 200 || res.status > 299) {
    const answer = (await res.text().catch(() => "")).slice(0, 400).split(token).join("***");
    throw new ControlDispatchError(`${target.repo} refused the dispatch (HTTP ${res.status}): ${answer}`, res.status);
  }
  return { status: res.status };
}

// ── The member's job ─────────────────────────────────────────────────────────

/** What {@link trainMemberJobSpec} takes besides the control target. */
export interface TrainMemberJobOptions {
  words?: CiProductWordsInput | CiProductWords;
  /** The command the job runs chant with. Default `npx --no-install chant`. */
  command?: string;
  /** The directory the run starts in, relative to the repository root: the workspace root the `repo` member names. Default the root. */
  dir?: string;
  /** The install line run before chant. Default `npm ci`. */
  install?: string;
}

type Inputs = Record<string, { description: string; required: boolean; type: "string" }>;

/** The member's train job, for a GitHub-shaped forge: what a forge lexicon serializes. */
export interface TrainMemberJobSpec {
  forge: TrainForge;
  path: string;
  header: string[];
  /** GitHub: the `repository_dispatch` event type. */
  event: string;
  /** The manual dispatch's inputs. */
  inputs: Inputs;
  /** The run step: its environment (the dispatch's fields) and script. */
  run: { name: string; env: Record<string, string>; script: string; workingDirectory: string | null };
  /** The answer step, run whatever the run step did. It alone holds the control repo's token. */
  answer: { name: string; env: Record<string, string>; script: string };
  /** The expression the checkout takes the release's commit from. */
  commit: string;
  /** One train job at a time in the repository, none cancelled. */
  group: string;
  notes: string[];
}

/** The run step's script: check the dispatch, run the release, and hand the outcome to the answer step. */
function trainRunScript(command: string, install: string, label: string): string {
  return [
    "set -u",
    `env="\${${TRAIN_ENV_VAR}:-}"`,
    `release="\${${TRAIN_RELEASE_VAR}:-}"`,
    `commit="\${${TRAIN_COMMIT_VAR}:-}"`,
    `train="\${${TRAIN_ID_VAR}:-}"`,
    `run="\${${TRAIN_RUN_VAR}:-}"`,
    // The dispatch is data: only names, ids, a digest and a sha go any further.
    ...shellPatterns({ name: CONTROL_NAME, release: CONTROL_RELEASE_DIGEST, sha: SHA, train: CONTROL_TRAIN_ID, run: CONTROL_RUN_ID }),
    `[[ $env =~ $name_re && $release =~ $release_re && $commit =~ $sha_re && $train =~ $train_re && $run =~ $run_re ]] || { echo "${label}: the train's dispatch is not usable (env=\\"$env\\", release=\\"$release\\", commit=\\"$commit\\")" >&2; exit 2; }`,
    // The checkout is the release's commit; chant run --release refuses any other.
    `[ "$(git rev-parse HEAD)" = "$commit" ] || { echo "${label}: the checkout is not at the release's commit \${commit:0:12}" >&2; exit 2; }`,
    install,
    "code=0",
    `${command} run --components all --env "$env" --release "$release" || code=$?`,
    `case "$code" in 0) outcome=applied ;; ${WAITING_EXIT}) outcome=waiting ;; *) outcome=failed ;; esac`,
    `echo "${label}: the release \${release:0:24} ran in $env: $outcome (exit $code)"`,
    // The answer step reads these; it runs whatever this step did.
    ...[`${CONTROL_OUTCOME_VAR}=$outcome`, `${CONTROL_SHA_VAR}=$commit`, `${CONTROL_TRAIN_VAR}=$train`, `${CONTROL_RUN_VAR}=$run`, `${CONTROL_ENV_VAR}=$env`, `${CONTROL_RELEASE_VAR}=$release`].map((kv) => `echo "${kv}" >> "$GITHUB_ENV"`),
    `exit "$code"`,
  ].join("\n");
}

/**
 * The job a member repository adds to take a train's dispatch (#5119). It
 * checks out the release's commit, runs `chant run --components all --env
 * <env> --release <digest>` under the repository's own identity, which
 * records each deploy with the release's digest, and answers the control
 * repo with `<product>-applied`: the outcome (`applied`, `waiting` at the
 * member's own gate, or `failed`) and the train's fields. A product adds
 * its own cloud login before the run step; the answer step holds the
 * control repo's dispatch token and nothing else.
 */
export function trainMemberJobSpec(forge: TrainForge, control: ControlTarget, opts: TrainMemberJobOptions = {}): TrainMemberJobSpec {
  const words = resolveProductWords(opts.words ?? {});
  const label = words.product;
  if (opts.dir !== undefined && !/^[A-Za-z0-9._/-]+$/.test(opts.dir)) throw new ControlConfigError(`"${opts.dir}" is not a directory a job can start in`);
  const field = (key: string) => `\${{ github.event.client_payload.${key} || inputs.${key} }}`;
  return {
    forge,
    path: trainPipelinePath(forge, words),
    header: [
      `# The control repo ${control.repo} dispatches here to promote one release of a`,
      "# release train: the job runs that release at its commit and tells the control",
      "# repo how the run ended.",
    ],
    event: trainDispatchEvent(words),
    inputs: {
      env: { description: "The environment to run the release in", required: true, type: "string" },
      release: { description: "The release digest", required: true, type: "string" },
      commit: { description: "The release's commit", required: true, type: "string" },
      train: { description: "The release train", required: true, type: "string" },
      run: { description: "The control repo's run of the train's promote", required: true, type: "string" },
    },
    run: {
      name: "Run the release the train names",
      env: { [TRAIN_ENV_VAR]: field("env"), [TRAIN_RELEASE_VAR]: field("release"), [TRAIN_COMMIT_VAR]: field("commit"), [TRAIN_ID_VAR]: field("train"), [TRAIN_RUN_VAR]: field("run") },
      script: trainRunScript(opts.command ?? CONTROL_CHANT_COMMAND, opts.install ?? "npm ci", label),
      workingDirectory: opts.dir && opts.dir !== "." ? opts.dir : null,
    },
    answer: {
      name: `Tell the control repo ${control.repo} how the run ended`,
      env: { [CONTROL_TOKEN_ENV]: `\${{ secrets.${control.tokenSecret} }}` },
      script: controlDispatchScript(control, { words, outcome: true, train: true }),
    },
    commit: field("commit"),
    group: `${label}-train`,
    notes: [
      `give the control repo a ${trainTokenEnv(control.member)} secret: a token that may ${forge === "github" ? "send a repository_dispatch to" : "dispatch workflows in"} this repo and do nothing else`,
      "the run step deploys under this repo's own identity: add the cloud login it needs before it",
      `the answer goes back with ${control.tokenSecret}, the dispatch token the control repo's other dispatches use`,
    ],
  };
}

// ── The control repo's job ───────────────────────────────────────────────────

/** The control repo's train job, for a GitHub-shaped forge. */
export interface TrainControlJobSpec {
  forge: TrainForge;
  path: string;
  header: string[];
  inputs: Inputs;
  /** The step's environment: the inputs, and one dispatch token per member repository. No cloud credential. */
  env: Record<string, string>;
  script: string;
  group: string;
  notes: string[];
}

/**
 * The control repo's job that starts a train's promote (#5119): `chant
 * workspace train promote <env> [<train>]`, which dispatches the first
 * member repository, then a push of what it recorded on `chant/lifecycle`.
 * Each later member is dispatched by the control repo's dependents job
 * when the one before it answers. The job holds one dispatch token per
 * member repository and nothing else: no cloud login, no `id-token`.
 */
export function trainControlJobSpec(forge: TrainForge, members: readonly string[], opts: { words?: CiProductWordsInput | CiProductWords; command?: string } = {}): TrainControlJobSpec {
  const words = resolveProductWords(opts.words ?? {});
  const label = words.product;
  const chant = opts.command ?? CONTROL_CHANT_COMMAND;
  if (members.length === 0) throw new ControlConfigError("a train's control job needs the repo members it dispatches into");
  const script = [
    "set -eu",
    `env="\${${TRAIN_ENV_VAR}:-}"`,
    `train="\${${TRAIN_ID_VAR}:-}"`,
    ...shellPatterns({ name: CONTROL_NAME, train: CONTROL_TRAIN_ID, release: CONTROL_RELEASE_DIGEST }),
    `[[ $env =~ $name_re ]] || { echo "${label}: no usable environment (\\"$env\\")" >&2; exit 2; }`,
    `[ -z "$train" ] || [[ $train =~ $train_re || $train =~ $release_re ]] || { echo "${label}: no usable train (\\"$train\\")" >&2; exit 2; }`,
    "npm ci",
    `code=0; ${chant} workspace train promote "$env" \${train:+"$train"} --json || code=$?`,
    `git push -q origin refs/heads/chant/lifecycle:refs/heads/chant/lifecycle || echo "${label}: the train's records were not pushed to chant/lifecycle" >&2`,
    `exit "$code"`,
  ].join("\n");
  return {
    forge,
    path: trainPipelinePath(forge, words),
    header: [
      "# Promote a release train: dispatch its first member repository. Each later",
      `# member is dispatched when the one before it answers (${label}-dependents.yml).`,
      "# This repo holds a dispatch token per member repository and no cloud credentials.",
    ],
    inputs: {
      env: { description: "The environment to promote the train to", required: true, type: "string" },
      train: { description: "The train, by id or digest; the newest for the environment when empty", required: false, type: "string" },
    },
    env: { [TRAIN_ENV_VAR]: "${{ inputs.env }}", [TRAIN_ID_VAR]: "${{ inputs.train }}", [TRAIN_PRODUCT_VAR]: label, ...trainTokenEnvOf(members) },
    script,
    group: `${label}-train`,
    notes: [
      ...members.map((m) => `add a ${trainTokenEnv(m)} secret holding a token that may dispatch into ${m}'s repository and do nothing else`),
      "the job pushes chant/lifecycle with its own token (contents: write)",
      `the dependents workflow (${label}-dependents.yml) takes the members' answers and needs the same secrets`,
    ],
  };
}
