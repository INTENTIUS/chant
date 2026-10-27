/**
 * The control repo's dispatch (#4568), shared by terragucci and plywood.
 *
 * A member repo's pipeline, once its apply on the default branch succeeded,
 * sends one dispatch to the control repo: a `repository_dispatch` on GitHub,
 * a pipeline trigger on GitLab, a workflow dispatch on Forgejo. The control
 * repo's own pipeline then runs that member's dependents with `chant
 * workspace run --dependents-of <member> --op <op>`. The member holds a
 * token for that one call and no other access to the control repo.
 *
 * Lifted from terragucci's `control-repo.ts` (INTENTIUS/terragucci
 * 18f6431595, packages/terragucci/src/control-repo.ts). What changed on the
 * way into chant:
 *
 * - The names a person sees come from the product's words (#4550): the
 *   dispatch's event type is `<product>-applied`, the pipeline file
 *   `<product>-dependents.yml`, the status `<product>/<control stage>`.
 *   The variables a job reads stay chant's (`CHANT_CONTROL_*`), as every
 *   job variable does under #4550.
 * - The token never reaches a command line. The generated script feeds it
 *   to curl on stdin (`-H @-`, `--form token=<-`), where terragucci's put it
 *   in curl's argv. The step maps the product's secret into
 *   {@link CONTROL_TOKEN_ENV} and nothing else reads it; a plan job drops it
 *   with the forge tokens ({@link CONTROL_TOKEN_VARS}, ../ci-handover.ts).
 * - The request is built once ({@link controlDispatchRequest}) and both the
 *   script and {@link dispatchControl}, the in-process sender a product's
 *   bin calls, send that request.
 *
 * This module imports types and the words alone, so a product bundle can
 * carry it.
 */

import type { ForgeFetch, ForgeKind } from "../pr-forge";
import { productStatusContext, resolveProductWords, type CiProductWords, type CiProductWordsInput } from "../ci-product-words";

/** A member or Op name as the control repo's workspace spells them. The dispatch carries both into a shell line and a JSON string. */
export const CONTROL_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
/** A branch name the dispatch may carry into a URL and a shell line. */
export const CONTROL_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
/** A secret's name, as GitHub, Forgejo and GitLab allow it. */
export const CONTROL_SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** The variable the dispatch step reads the dispatch token from. The step maps the product's secret into it. */
export const CONTROL_TOKEN_ENV = "CHANT_CONTROL_TOKEN";
/** The variable a job that reads the control repo (estate ownership) takes the read-only token from. Never the dispatch token. */
export const CONTROL_READ_TOKEN_ENV = "CHANT_CONTROL_READ_TOKEN";
/**
 * The control repo's token variables. A job that runs a change's code starts
 * without them, as it starts without the forge tokens: pass these as
 * `extra` to `dropForgeTokens` (../ci-handover.ts), or unset them on GitLab,
 * where a CI/CD variable reaches every job.
 */
export const CONTROL_TOKEN_VARS = [CONTROL_TOKEN_ENV, CONTROL_READ_TOKEN_ENV] as const;

/** The secret a member's dispatch token is kept in when the product names none. */
export const CONTROL_TOKEN_SECRET = "CHANT_CONTROL_TOKEN";
/** The secret the read-only token is kept in when the product names none. */
export const CONTROL_READ_TOKEN_SECRET = "CHANT_CONTROL_READ_TOKEN";

/** The variables a GitLab trigger carries, and the environment of the control repo's step. */
export const CONTROL_MEMBER_VAR = "CHANT_CONTROL_MEMBER";
export const CONTROL_OP_VAR = "CHANT_CONTROL_OP";
export const CONTROL_SHA_VAR = "CHANT_CONTROL_SHA";

/** The branch a GitLab or Forgejo dispatch runs on when the settings name none. */
export const CONTROL_REF_DEFAULT = "main";

/** The `npx` line the control repo's job runs chant with: the chant its own package.json pins. */
export const CONTROL_CHANT_COMMAND = "npx --no-install chant";

/** Settings a product's config is wrong in; `problems` lists each one. */
export class ControlConfigError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [message],
  ) {
    super(message);
    this.name = "ControlConfigError";
  }
}

/** A project key, `<host>/<owner>/<name>`, taken apart. `path` is `<owner>/<name>`, with every group on GitLab. */
export interface ProjectKey {
  key: string;
  host: string;
  path: string;
  owner: string;
  name: string;
}

/** A project key taken apart. A scheme and a `.git` suffix are dropped. terragucci's `parseProjectKey` (config.ts:2445). */
export function parseProjectKey(key: string): ProjectKey {
  const clean = key.replace(/^https?:\/\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
  const parts = clean.split("/");
  if (parts.length < 3 || parts.some((p) => p === "")) {
    throw new ControlConfigError(`project key "${key}" must be <host>/<owner>/<name>, such as github.com/acme/infra`);
  }
  const [host, ...rest] = parts;
  return { key, host: host!, path: rest.join("/"), owner: rest.slice(0, -1).join("/"), name: rest[rest.length - 1]! };
}

/** The forge a host belongs to, when the host says so. terragucci's `forgeFromHost` (config.ts:2456). */
export function forgeFromHost(host: string): ForgeKind | undefined {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  if (h === "github.com" || h.startsWith("github.")) return "github";
  if (h === "gitlab.com" || h.startsWith("gitlab.") || h.includes(".gitlab.")) return "gitlab";
  if (h === "codeberg.org" || h.startsWith("forgejo.") || h.startsWith("gitea.") || h.includes("forgejo")) return "forgejo";
  return undefined;
}

/** The REST base of a forge at `host`. */
export function forgeApiBase(forge: ForgeKind, host: string): string {
  const h = host.toLowerCase();
  if (forge === "github") return h === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
  if (forge === "gitlab") return `https://${host}/api/v4`;
  return `https://${host}/api/v1`;
}

/** The `control` settings a product reads from its config, in chant's spelling. */
export interface ControlSettingsInput {
  /** The control repo, as a project key: `<host>/<owner>/<name>`. Its host says which forge's dispatch is sent. */
  repo: string;
  /** The control repo's forge, when its host does not say. */
  forge?: ForgeKind;
  /** The Op the control repo runs on the member's dependents (`chant workspace run --op`). */
  op: string;
  /** The member's name in the control repo's workspace. Default: the repo's name. */
  member?: string;
  /** The secret holding the dispatch token. Default {@link CONTROL_TOKEN_SECRET}. */
  tokenSecret?: string;
  /** The secret holding a read-only token for the control repo. Default {@link CONTROL_READ_TOKEN_SECRET}. Never the dispatch token's. */
  readTokenSecret?: string;
  /** The branch a GitLab or Forgejo dispatch runs on. Default {@link CONTROL_REF_DEFAULT}. */
  ref?: string;
  /** The REST base, when the host's usual one is not it (a loopback forge in a test). */
  apiBase?: string;
}

/** The control settings with the defaults filled in and the forge settled. */
export interface ControlTarget {
  repo: string;
  host: string;
  path: string;
  forge: ForgeKind;
  apiBase: string;
  op: string;
  member: string;
  ref: string;
  tokenSecret: string;
  readTokenSecret: string;
}

const FORGES: readonly ForgeKind[] = ["github", "gitlab", "forgejo"];

/** The problems with `control`, each naming its key under `where`. terragucci's `controlProblems` (config.ts:494). */
export function controlSettingsProblems(input: unknown, where = "control"): string[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return [`${where} must be a mapping with repo and op`];
  const v = input as Record<string, unknown>;
  const out: string[] = [];
  let host: string | undefined;
  if (typeof v.repo !== "string") out.push(`${where}.repo must name the control repo, such as github.com/acme/control`);
  else {
    try {
      host = parseProjectKey(v.repo).host;
    } catch (e) {
      out.push(`${where}.repo: ${(e as Error).message}`);
    }
  }
  if (!(typeof v.op === "string" && CONTROL_NAME.test(v.op))) out.push(`${where}.op must name the Op the control repo runs on this repo's dependents, such as deploy`);
  if (v.forge !== undefined && !FORGES.includes(v.forge as ForgeKind)) out.push(`${where}.forge must be one of ${FORGES.join(", ")}`);
  if (host !== undefined && v.forge === undefined && !forgeFromHost(host)) out.push(`${where}.forge is needed: ${v.repo}'s host does not say which forge it is`);
  if (v.member !== undefined && !(typeof v.member === "string" && CONTROL_NAME.test(v.member))) out.push(`${where}.member must be this repo's name in the control repo's workspace`);
  if (v.tokenSecret !== undefined && !(typeof v.tokenSecret === "string" && CONTROL_SECRET_NAME.test(v.tokenSecret))) out.push(`${where}.tokenSecret must name the secret holding the dispatch token, such as ${CONTROL_TOKEN_SECRET}`);
  if (v.readTokenSecret !== undefined && !(typeof v.readTokenSecret === "string" && CONTROL_SECRET_NAME.test(v.readTokenSecret))) out.push(`${where}.readTokenSecret must name the secret holding a read-only token for the control repo, such as ${CONTROL_READ_TOKEN_SECRET}`);
  else if (typeof v.readTokenSecret === "string" && v.readTokenSecret === ((v.tokenSecret as string | undefined) ?? CONTROL_TOKEN_SECRET)) {
    out.push(`${where}.readTokenSecret must not be the dispatch token's secret (${v.readTokenSecret}): the plan job runs the change's code`);
  }
  if (v.ref !== undefined && !(typeof v.ref === "string" && CONTROL_REF.test(v.ref))) out.push(`${where}.ref must be a branch name`);
  if (v.apiBase !== undefined && !(typeof v.apiBase === "string" && /^https?:\/\/[^\s'"]+$/.test(v.apiBase))) out.push(`${where}.apiBase must be an http(s) URL`);
  return out;
}

/** `control` with its defaults filled in. `fallbackMember` is the repo's name, used when `control.member` is unset. */
export function resolveControlTarget(input: ControlSettingsInput, fallbackMember: string): ControlTarget {
  const problems = controlSettingsProblems(input);
  if (problems.length > 0) throw new ControlConfigError(problems.join("; "), problems);
  const pk = parseProjectKey(input.repo);
  const forge = input.forge ?? forgeFromHost(pk.host)!;
  const member = input.member ?? fallbackMember;
  if (!CONTROL_NAME.test(member)) throw new ControlConfigError(`control.member: "${member}" is not a name the control repo's workspace can hold; set control.member`);
  return {
    repo: input.repo,
    host: pk.host,
    path: pk.path,
    forge,
    apiBase: (input.apiBase ?? forgeApiBase(forge, pk.host)).replace(/\/+$/, ""),
    op: input.op,
    member,
    ref: input.ref ?? CONTROL_REF_DEFAULT,
    tokenSecret: input.tokenSecret ?? CONTROL_TOKEN_SECRET,
    readTokenSecret: input.readTokenSecret ?? CONTROL_READ_TOKEN_SECRET,
  };
}

/** The event type of the GitHub `repository_dispatch` a member sends: `<product>-applied`. */
export function controlDispatchEvent(wordsIn: CiProductWordsInput | CiProductWords = {}): string {
  return `${resolveProductWords(wordsIn).product}-applied`;
}

/** The control repo's pipeline file name: `<product>-dependents.yml`. */
export function controlPipelineFileName(wordsIn: CiProductWordsInput | CiProductWords = {}): string {
  return `${resolveProductWords(wordsIn).product}-dependents.yml`;
}

/** Where the control repo's pipeline file goes, beside the repo's own, on each forge. */
export function controlPipelinePath(forge: ForgeKind, wordsIn: CiProductWordsInput | CiProductWords = {}): string {
  const file = controlPipelineFileName(wordsIn);
  return forge === "github" ? `.github/workflows/${file}` : forge === "forgejo" ? `.forgejo/workflows/${file}` : `.gitlab/${file}`;
}

/** The commit status that marks a commit whose apply the control repo was told about: `<product>/<control stage>`. */
export function controlStatusContext(wordsIn: CiProductWordsInput | CiProductWords = {}): string {
  return productStatusContext(resolveProductWords(wordsIn), "control");
}

/** What one dispatch tells the control repo. */
export interface ControlDispatch {
  member: string;
  op: string;
  /** The commit that applied, 7 to 64 lower-case hex digits. */
  sha: string;
}

/** Where the token goes in a {@link ControlDispatchRequest}. */
export type ControlTokenPlace = { in: "header"; name: string; scheme: string } | { in: "form"; field: string };

/** One dispatch request, without its token. */
export interface ControlDispatchRequest {
  url: string;
  method: "POST";
  /** Headers other than the token's. */
  headers: Record<string, string>;
  /** A JSON document on GitHub and Forgejo; on GitLab the form fields other than the token, in order. */
  body: { json: Record<string, unknown> } | { form: Array<[string, string]> };
  token: ControlTokenPlace;
}

const SHA = /^[0-9a-f]{7,64}$/;

function checkDispatch(d: ControlDispatch): void {
  if (!CONTROL_NAME.test(d.member)) throw new ControlConfigError(`the dispatch's member "${d.member}" is not a name the control repo's workspace can hold`);
  if (!CONTROL_NAME.test(d.op)) throw new ControlConfigError(`the dispatch's op "${d.op}" is not an Op name`);
  if (!SHA.test(d.sha)) throw new ControlConfigError(`the dispatch names no commit sha ("${d.sha}")`);
}

/**
 * The request that tells the control repo `d.member` applied: GitHub's
 * `POST /repos/<path>/dispatches`, GitLab's `POST
 * /projects/<id>/trigger/pipeline`, Forgejo's `POST
 * /repos/<path>/actions/workflows/<file>/dispatches`.
 */
export function controlDispatchRequest(target: ControlTarget, d: ControlDispatch, wordsIn: CiProductWordsInput | CiProductWords = {}): ControlDispatchRequest {
  checkDispatch(d);
  if (!CONTROL_REF.test(target.ref)) throw new ControlConfigError(`control.ref "${target.ref}" is not a branch name`);
  if (target.forge === "github") {
    return {
      url: `${target.apiBase}/repos/${target.path}/dispatches`,
      method: "POST",
      headers: { Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: { json: { event_type: controlDispatchEvent(wordsIn), client_payload: { member: d.member, op: d.op, sha: d.sha } } },
      token: { in: "header", name: "Authorization", scheme: "Bearer" },
    };
  }
  if (target.forge === "gitlab") {
    return {
      url: `${target.apiBase}/projects/${encodeURIComponent(target.path)}/trigger/pipeline`,
      method: "POST",
      headers: {},
      body: {
        form: [
          ["ref", target.ref],
          [`variables[${CONTROL_MEMBER_VAR}]`, d.member],
          [`variables[${CONTROL_OP_VAR}]`, d.op],
          [`variables[${CONTROL_SHA_VAR}]`, d.sha],
        ],
      },
      token: { in: "form", field: "token" },
    };
  }
  return {
    url: `${target.apiBase}/repos/${target.path}/actions/workflows/${controlPipelineFileName(wordsIn)}/dispatches`,
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: { json: { ref: target.ref, inputs: { member: d.member, op: d.op, sha: d.sha } } },
    token: { in: "header", name: "Authorization", scheme: "token" },
  };
}

/** A dispatch the control repo's forge did not take. */
export class ControlDispatchError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
  ) {
    super(message);
    this.name = "ControlDispatchError";
  }
}

/** What {@link dispatchControl} takes. */
export interface DispatchControlOptions {
  /** The dispatch token. Default: {@link CONTROL_TOKEN_ENV} in `env`. */
  token?: string;
  env?: Record<string, string | undefined>;
  fetch?: ForgeFetch;
  words?: CiProductWordsInput | CiProductWords;
}

/**
 * Sends one dispatch in process, for a product's bin that tells the control
 * repo from its own command (terragucci's comment apply). A status other
 * than 2xx throws {@link ControlDispatchError} with the status and the
 * forge's answer, the token cut out of it.
 */
export async function dispatchControl(target: ControlTarget, d: ControlDispatch, opts: DispatchControlOptions = {}): Promise<{ status: number }> {
  const token = opts.token ?? (opts.env ?? process.env)[CONTROL_TOKEN_ENV];
  if (!token) throw new ControlDispatchError(`${CONTROL_TOKEN_ENV} is not set, so ${target.repo} was not told that ${d.member} applied`, undefined);
  const req = controlDispatchRequest(target, d, opts.words);
  const headers = { ...req.headers };
  let body: string;
  if ("json" in req.body) body = JSON.stringify(req.body.json);
  else {
    const form = new URLSearchParams();
    if (req.token.in === "form") form.append(req.token.field, token);
    for (const [k, v] of req.body.form) form.append(k, v);
    body = form.toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  if (req.token.in === "header") headers[req.token.name] = `${req.token.scheme} ${token}`;
  const fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as ForgeFetch);
  let res: Awaited<ReturnType<ForgeFetch>>;
  try {
    res = await fetchImpl(req.url, { method: req.method, headers, body });
  } catch (e) {
    throw new ControlDispatchError(`the dispatch to ${target.repo} could not be sent: ${String((e as Error).message ?? e).split(token).join("***")}`, undefined);
  }
  if (res.status < 200 || res.status > 299) {
    const answer = (await res.text().catch(() => "")).slice(0, 400).split(token).join("***");
    throw new ControlDispatchError(`${target.repo} refused the dispatch (HTTP ${res.status}): ${answer}`, res.status);
  }
  return { status: res.status };
}

/** A value that passed {@link CONTROL_NAME} or {@link CONTROL_REF} is safe in a single-quoted shell word. */
function sq(v: string, re: RegExp): string {
  if (!re.test(v)) throw new ControlConfigError(`not a safe name: ${v}`);
  return `'${v}'`;
}

/** A URL from the target, checked to hold nothing a single-quoted shell word can't. */
function sqUrl(url: string): string {
  if (!/^https?:\/\/[A-Za-z0-9._~:/?#\[\]@!$&()*+,;=%-]+$/.test(url) || url.includes("'")) throw new ControlConfigError(`not a safe URL: ${url}`);
  return `'${url}'`;
}

/** What {@link controlDispatchScript} takes besides the target. */
export interface ControlDispatchScriptOptions {
  words?: CiProductWordsInput | CiProductWords;
  /**
   * A shell line that prints 1 when the commit was told about already, such
   * as terragucci's `terragucci post sent <status>`. Several paths can
   * complete an apply of one commit; the first to tell the control repo
   * marks it with {@link markSent}, and the others find the mark.
   */
  sentCheck?: string;
  /** A shell line run once the control repo took the dispatch, such as setting {@link controlStatusContext}. */
  markSent?: string;
}

/**
 * The member's step: one request to the control repo's forge with the
 * member's name, the Op and the commit that applied, read from
 * `$CHANT_CONTROL_SHA`. The token is read from {@link CONTROL_TOKEN_ENV} and
 * reaches curl on its stdin, never its argv or the log. A status other than
 * 2xx fails the step with the status and the forge's answer.
 */
export function controlDispatchScript(target: ControlTarget, opts: ControlDispatchScriptOptions = {}): string {
  const words = resolveProductWords(opts.words ?? {});
  const label = words.product;
  const req = controlDispatchRequest(target, { member: target.member, op: target.op, sha: "0000000" }, words);
  const tok = CONTROL_TOKEN_ENV;
  const lines = [
    "set -u",
    `member=${sq(target.member, CONTROL_NAME)}`,
    `op=${sq(target.op, CONTROL_NAME)}`,
    // The sha may come from another job's output: it is data, and only a commit sha goes into the request.
    `sha="\${${CONTROL_SHA_VAR}:-}"`,
    `case "$sha" in ""|*[!0-9a-f]*) echo "${label}: the dispatch names no commit sha, so ${target.repo} was not told" >&2; exit 1 ;; esac`,
    `[ -n "\${${tok}:-}" ] || { echo "${label}: ${tok} is empty; map the ${target.tokenSecret} secret into it, so ${target.repo} can be told" >&2; exit 1; }`,
    ...(opts.sentCheck ? [`if [ "$(${opts.sentCheck} 2>/dev/null)" = 1 ]; then echo "${label}: ${target.repo} was told about \${sha:0:8} already"; exit 0; fi`] : []),
    'answer="$(mktemp)"',
  ];
  let send: string;
  if ("json" in req.body) {
    const json =
      target.forge === "github"
        ? `{"event_type":"${controlDispatchEvent(words)}","client_payload":{"member":"'"$member"'","op":"'"$op"'","sha":"'"$sha"'"}}`
        : `{"ref":"${target.ref}","inputs":{"member":"'"$member"'","op":"'"$op"'","sha":"'"$sha"'"}}`;
    const auth = req.token.in === "header" ? `${req.token.name}: ${req.token.scheme} %s\\n` : "";
    const headers = Object.entries(req.headers).map(([k, v]) => `-H '${k}: ${v}'`);
    send = `code="$(printf '${auth}' "$${tok}" | curl -sS -o "$answer" -w '%{http_code}' -X POST -H @- ${headers.join(" ")} -d '${json}' ${sqUrl(req.url)})"`;
  } else {
    // The same fields controlDispatchRequest lists, with the shell's values in place of the placeholders.
    const fields = [
      `--form ${sq(`ref=${target.ref}`, /^ref=[A-Za-z0-9._/-]+$/)}`,
      `--form "variables[${CONTROL_MEMBER_VAR}]=$member"`,
      `--form "variables[${CONTROL_OP_VAR}]=$op"`,
      `--form "variables[${CONTROL_SHA_VAR}]=$sha"`,
    ];
    send = `code="$(printf '%s' "$${tok}" | curl -sS -o "$answer" -w '%{http_code}' -X POST --form 'token=<-' ${fields.join(" ")} ${sqUrl(req.url)})"`;
  }
  const mark = opts.markSent ? `; ${opts.markSent}` : "";
  return [
    ...lines,
    `${send} || { echo "${label}: the dispatch to ${target.repo} could not be sent" >&2; exit 1; }`,
    `case "$code" in 2??) echo "${label}: told ${target.repo} that $member applied (HTTP $code)"${mark} ;; *) echo "${label}: ${target.repo} refused the dispatch (HTTP $code): $(head -c 400 "$answer")" >&2; exit 1 ;; esac`,
  ].join("\n");
}

/**
 * The control repo's step: runs the member's dependents. The member and the
 * Op arrive in the environment (a dispatch's payload is data, never part of
 * the script) and are checked against {@link CONTROL_NAME} before they reach
 * a command line.
 */
export function controlDependentsScript(opts: { command?: string; label?: string } = {}): string {
  const label = opts.label ?? "chant";
  const chant = opts.command ?? CONTROL_CHANT_COMMAND;
  return [
    "set -eu",
    `member="\${${CONTROL_MEMBER_VAR}:-}"`,
    `op="\${${CONTROL_OP_VAR}:-}"`,
    `re='${CONTROL_NAME.source}'`,
    `[[ $member =~ $re && $op =~ $re ]] || { echo "${label}: the dispatch names no usable member and Op (member=\\"$member\\", op=\\"$op\\")" >&2; exit 2; }`,
    "npm ci",
    `${chant} workspace run --dependents-of "$member" --op "$op" --json`,
  ].join("\n");
}

/** The control repo's pipeline, forge-neutral: what a forge lexicon serializes (`generateControlPipeline`). */
export interface ControlPipelineSpec {
  forge: ForgeKind;
  /** Where the file goes in the control repo. */
  path: string;
  /** The file's opening comment lines, `#` included. */
  header: string[];
  /** GitHub: the `repository_dispatch` event type. */
  event: string;
  /** The manual dispatch's inputs (GitHub, Forgejo): member, op, sha. */
  inputs: Record<string, { description: string; required: boolean; type: "string" }>;
  /** The step's environment: each variable as the forge spells its source. */
  env: Record<string, string>;
  /** The step's script ({@link controlDependentsScript}). */
  script: string;
  /** One run per member at a time, none cancelled (GitHub, Forgejo `concurrency`; GitLab `resource_group`). */
  group: string;
  /** GitLab: the job's rule. */
  rule: string;
  /** What a person still sets up on the forge. */
  notes: string[];
}

/** The first chant with `chant workspace run --dependents-of`, which the control repo's package.json pins. terragucci's `CONTROL_CHANT_FLOOR`. */
export const CONTROL_DEPENDENTS_FLOOR = "0.124.47";

/** The control repo's pipeline for `forge`, in the product's words. */
export function controlPipelineSpec(forge: ForgeKind, wordsIn: CiProductWordsInput | CiProductWords = {}, opts: { command?: string } = {}): ControlPipelineSpec {
  const words = resolveProductWords(wordsIn);
  const product = words.product;
  const gitlab = forge === "gitlab";
  const member = gitlab ? `$${CONTROL_MEMBER_VAR}` : "${{ github.event.client_payload.member || inputs.member }}";
  const op = gitlab ? `$${CONTROL_OP_VAR}` : "${{ github.event.client_payload.op || inputs.op }}";
  const sha = gitlab ? `$${CONTROL_SHA_VAR}` : "${{ github.event.client_payload.sha || inputs.sha }}";
  const bin = words.bin ?? product;
  const notes = [
    `the repo's package.json must pin @intentius/chant at ${CONTROL_DEPENDENTS_FLOOR} or later, which has \`chant workspace run --dependents-of\``,
    ...(gitlab
      ? [`add \`- local: ${controlPipelinePath(forge, words)}\` to the include list of .gitlab-ci.yml, and create a pipeline trigger token under Settings > CI/CD > Pipeline trigger tokens for each member's ${CONTROL_TOKEN_SECRET} variable`]
      : forge === "github"
        ? [`give each member a ${CONTROL_TOKEN_SECRET} secret: a token that may send a repository_dispatch to this repo and do nothing else`]
        : [`give each member a ${CONTROL_TOKEN_SECRET} secret: a token that may dispatch workflows in this repo and do nothing else`]),
  ];
  return {
    forge,
    path: controlPipelinePath(forge, words),
    header: [
      `# A member repo's pipeline sends a dispatch here after its apply succeeds; this`,
      "# runs that member's dependents with `chant workspace run --dependents-of`.",
      `# Run \`${bin} control init\` to rewrite it rather than editing it here.`,
    ],
    event: controlDispatchEvent(words),
    inputs: {
      member: { description: "The member whose dependents run", required: true, type: "string" },
      op: { description: "The Op to run on them", required: true, type: "string" },
      sha: { description: "The member's commit that applied", required: false, type: "string" },
    },
    env: gitlab ? {} : { [CONTROL_MEMBER_VAR]: member, [CONTROL_OP_VAR]: op, [CONTROL_SHA_VAR]: sha },
    script: controlDependentsScript({ label: product, ...(opts.command ? { command: opts.command } : {}) }),
    group: `${product}-dependents-${member}`,
    rule: `$CI_PIPELINE_SOURCE == "trigger" && $${CONTROL_MEMBER_VAR} && $${CONTROL_OP_VAR}`,
    notes,
  };
}

/** The dispatch job a member's pipeline adds after its last apply on the default branch, forge-neutral. */
export interface ControlDispatchJobSpec {
  /** The job's name. */
  name: string;
  /** The step's name. */
  stepName: string;
  /**
   * The step's environment: {@link CONTROL_TOKEN_ENV} from the product's
   * secret (GitHub, Forgejo; on GitLab the CI/CD variable of that name is
   * mapped in the script's first line), and {@link CONTROL_SHA_VAR} from
   * the commit expression the generator passes.
   */
  env: Record<string, string>;
  /** The step's script ({@link controlDispatchScript}). */
  script: string;
  /** The control status context, for a product that marks the commit. */
  context: string;
}

/** The control dispatch job's name in a member's pipeline. */
export const CONTROL_DISPATCH_JOB = "control-dispatch";

/**
 * The member's dispatch job for a pipeline on `memberForge`. `sha` is the
 * expression the job reads the applied commit from, as the forge spells it:
 * a wave job's `green-sha` output, `${{ github.sha }}`, `$CI_COMMIT_SHA`.
 */
export function controlDispatchJob(memberForge: ForgeKind, target: ControlTarget, sha: string, opts: ControlDispatchScriptOptions = {}): ControlDispatchJobSpec {
  const words = resolveProductWords(opts.words ?? {});
  const gitlab = memberForge === "gitlab";
  if (!CONTROL_SECRET_NAME.test(target.tokenSecret)) throw new ControlConfigError(`control.tokenSecret "${target.tokenSecret}" is not a secret's name`);
  const script = controlDispatchScript(target, { ...opts, words });
  return {
    name: CONTROL_DISPATCH_JOB,
    stepName: `Tell the control repo ${target.repo} that ${target.member} applied`,
    env: gitlab ? { [CONTROL_SHA_VAR]: sha } : { [CONTROL_TOKEN_ENV]: `\${{ secrets.${target.tokenSecret} }}`, [CONTROL_SHA_VAR]: sha },
    // GitLab hands every job each CI/CD variable; the token's variable is the product's secret name, read here alone.
    script: gitlab && target.tokenSecret !== CONTROL_TOKEN_ENV ? `${CONTROL_TOKEN_ENV}="\${${target.tokenSecret}:-}"\n${script}` : script,
    context: controlStatusContext(words),
  };
}
