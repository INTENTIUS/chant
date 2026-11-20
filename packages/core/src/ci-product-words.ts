/**
 * A CI product's words (#4550): the names a product built on chant's pull
 * request pipeline shows people, filled into chant's own sentences.
 *
 * terragucci and plywood run one chant pipeline. They differ only in the
 * object they pass here: the status prefix, the stage and verb words, the
 * noun for a member, the comment commands, the approve and override lines,
 * and the op and gate names the waves record under. Every slot defaults to
 * chant's word, so a plain chant pipeline renders as it always has.
 *
 * Job names, note markers, ledger paths, artifact names and GitLab variable
 * names stay chant's. People never type them, and readers of the ledger and
 * the artifacts key on them.
 *
 * The words reach a running job through the product's bin (ruling C,
 * 2026-10-27): the generated jobs run the product's command, and its bin
 * calls chant in process with its words (`runCommandInProcess(argv, {
 * words })`, ../cli/main.ts), which sets them as the active words for the
 * command's lifetime. Every renderer here reads {@link activeProductWords}
 * when it is given none.
 *
 * This module imports nothing at run time (the one import is a type): the
 * pull request loop bundle (pr-loop.ts, pr-loop-bundle.test.ts) carries it.
 */

import type { NotifyMessageWords } from "./notify";

/** The stages a product names: the status context after the prefix, and the word in the note. */
export type CiProductStage = "plan" | "apply" | "record" | "check" | "drift" | "lock" | "approval" | "control";

/** Every stage slot, in the order {@link assertProductWords} reports them. */
export const CI_PRODUCT_STAGES: readonly CiProductStage[] = ["plan", "apply", "record", "check", "drift", "lock", "approval", "control"];

/**
 * The commands a comment may name. Each one needs a job in the pipeline that
 * answers it. `action` (#4653) asks for a day-2 action on one member, which
 * runs under a gated request.
 */
export type CiProductCommand = "plan" | "apply" | "lock" | "unlock" | "agent" | "action" | "commit" | "reject";

export const CI_PRODUCT_COMMANDS: readonly CiProductCommand[] = ["plan", "apply", "lock", "unlock", "agent", "action", "commit", "reject"];

/**
 * What an approval of a product's waves binds to (ruling B, 2026-10-27).
 * `per-wave`: each wave's own digest, as terragucci does. `pull-request`:
 * the pull request's digest, covering every wave whose plan it covers, with
 * a wave whose plan moved stopping at its own gate, as plywood's pages
 * describe. Both live in chant; a product's preset picks one.
 */
export type CiProductApproval = "per-wave" | "pull-request";

/**
 * When a product's plan applies (#4601), which the note's merge sentence
 * follows. `on-merge`: the merge applies the waves, as sql-yodeler,
 * terragucci and plywood do. `release`: the merge records the plan and a
 * release deploys it, chant's PR loop. `before-merge`: the apply job applies
 * the open pull request's plan, and the merge records what applied.
 */
export type CiProductApplyMode = "on-merge" | "release" | "before-merge";

export const CI_PRODUCT_APPLY_MODES: readonly CiProductApplyMode[] = ["on-merge", "release", "before-merge"];

/** An alias another tool's users type for one of the product's commands, such as `atlantis plan`. */
export interface CiProductAlias {
  /** The words the comment starts with, such as `atlantis plan`. */
  from: string;
  /** The command it stands for. */
  command: CiProductCommand;
  /** The variable that turns the alias on in a job (terragucci's `TG_ATLANTIS_COMMENTS`). Absent: always on. */
  when?: string;
  /**
   * Flags of the other tool that the product has no counterpart for, each
   * with the reply that refuses it (#4946), such as terragucci's `{ "-p":
   * "a root goes by its path, not a project name: ..." }` on `atlantis
   * plan`. A flag here is refused before the alias reads `-d`, so a product
   * can refuse `atlantis apply -d` too. `--` refuses everything after it.
   */
  refuse?: Record<string, string>;
}

/**
 * What a comment job replies to a command the pipeline runs no job for
 * (#4946), in the product's own sentences. Each slot left out takes
 * chant's. The comment job on GitHub and Forgejo and the note poll on
 * GitLab both read these.
 */
export interface CiProductCommentReplies {
  /** A plan comment where no job plans on a comment (GitHub and Forgejo; GitLab starts a merge request pipeline). */
  plan?: string;
  /** An apply comment where no job applies on a comment: neither an apply before merge nor the re-run of a merged pull request's apply. */
  apply?: string;
  /** A lock comment where the pipeline takes no locks. */
  lock?: string;
  /** An unlock comment where the pipeline takes no locks. */
  unlock?: string;
  /** An action comment where no workflow runs actions (GitHub and Forgejo; GitLab names the checkout to run it from). */
  action?: string;
  /** An agent comment where the agent is off. */
  agent?: string;
  /** Any command on a pull request from a fork. */
  fork?: string;
  /**
   * A comment that names a member the pipeline was not written with, over
   * `{member}` (the one named) and `{members}` (the pipeline's, each in
   * backticks, sorted, comma separated).
   */
  member?: string;
}

/** The reply slots, for checking a product's words. */
export const CI_PRODUCT_COMMENT_REPLIES: readonly (keyof CiProductCommentReplies)[] = ["plan", "apply", "lock", "unlock", "action", "agent", "fork", "member"];

/** The words a product passes. Every slot is optional; a missing one takes chant's. */
export interface CiProductWordsInput {
  /** The status prefix, the note heading and the comment prefix: `chant`, `terragucci`, `plywood`. */
  product?: string;
  /** Each stage's word in a status context and the note. `plan` is plywood's `preview`, `apply` its `up`. */
  stages?: Partial<Record<CiProductStage, string>>;
  /** The verb for the plan and the apply, and its past tense: `preview`/`previewed`, `update`/`updated`. */
  verbs?: { plan?: [string, string]; apply?: [string, string] };
  /** The noun for one member and for several: `root`/`roots`, `stack`/`stacks`. */
  noun?: [string, string];
  /**
   * The comment commands, by the word typed after `/<product>`. Each maps
   * onto one of chant's commands: plywood's `{ preview: "plan", up: "apply",
   * lock: "lock", unlock: "unlock" }`. Default `{ apply: "apply" }`.
   */
  commands?: Record<string, CiProductCommand>;
  /** Aliases another tool's users type, parsed by the same grammar. */
  aliases?: CiProductAlias[];
  /**
   * The approve line, an argv template over `{op}`, `{gate}`, `{digest}`,
   * `{approver}`, `{sign}` and `{target}` (#4574): the wave's run target,
   * an environment or tenant, empty when the gate has none.
   */
  approve?: string;
  /** The override line, the same kind of template, with `{rule}` and `{reason}` too. */
  override?: string;
  /**
   * The reject line (#5354), the same kind of template over `{op}`,
   * `{gate}`, `{digest}`, `{reason}`, `{sign}` and `{target}`: what a
   * reviewer runs to turn a release down at a stage's gate. A comment job
   * answers with it where a comment cannot record the rejection itself.
   */
  reject?: string;
  /** The op the waves record under. Default: the spec's own. */
  op?: string;
  /** The wave gate pattern, over `{gate}` and `{k}`. Default `{gate}-wave-{k}`. */
  gateName?: string;
  /** The pull request's gate. Default `pr-apply`. */
  prGate?: string;
  /** What an approval binds to. Default `pull-request`, chant's PR loop. */
  approval?: CiProductApproval;
  /**
   * When the plan applies (#4601). Default `on-merge` for a product that
   * names its waves' op or binds approvals per wave, since its merge runs
   * the waves; else `release`, as chant's PR loop has it.
   */
  applyMode?: CiProductApplyMode;
  /**
   * The command a generated job runs in place of `chant`, such as `npx
   * --no-install plywood`. The product's bin passes the rest of the line to
   * chant in process with these words. Absent: `chant`.
   */
  bin?: string;
  /**
   * Hidden markers of notes the product posted before it moved onto chant's
   * pipeline. `pr-post` updates a note that carries one in place of posting a
   * second, so an open pull request keeps one note across the switch.
   */
  adoptMarkers?: string[];
  /** What chant's notify sends under these words (#4610). */
  notify?: CiProductNotifyWordsInput;
  /** The replies to commands the pipeline runs no job for (#4946). Default: chant's. */
  replies?: CiProductCommentReplies;
}

/** The notify slots a product passes (#4610). */
export interface CiProductNotifyWordsInput {
  /**
   * The event's `source`, which receivers route on. Default: `product`.
   * sql-yodeler keeps `sql-yodeler` here, the name its receivers filter on.
   */
  source?: string;
  /**
   * How a summary names a wave, over `{k}`, `{name}`, `{spec}` and
   * `{product}`. A `({name})` part is dropped, with the space before it,
   * for a wave with no name. Default `wave {k} ({name}) of {spec}`.
   */
  wave?: string;
  /** The signed webhook's header prefix. Default `x-<product>`, so chant's stays `x-chant`. */
  headers?: string;
  /** The labels, re-run button and other words of chant's Slack and Teams messages (#4818). Default: chant's. */
  message?: NotifyMessageWords;
}

/** The notify slots, filled. */
export interface CiProductNotifyWords {
  source: string;
  wave: string;
  headers: string;
  message?: NotifyMessageWords;
}

/** chant's own wave label in a notify summary. */
export const CHANT_NOTIFY_WAVE_TEMPLATE = "wave {k} ({name}) of {spec}";

/** The words with every slot filled. */
export interface CiProductWords {
  product: string;
  stages: Record<CiProductStage, string>;
  verbs: { plan: [string, string]; apply: [string, string] };
  noun: [string, string];
  commands: Record<string, CiProductCommand>;
  aliases: CiProductAlias[];
  approve: string;
  override: string;
  /** The reject line (#5354). Filled by {@link resolveProductWords}; words built before it read chant's grammar under the product's name. */
  reject?: string;
  op?: string;
  gateName: string;
  prGate: string;
  approval: CiProductApproval;
  applyMode: CiProductApplyMode;
  bin?: string;
  adoptMarkers: string[];
  notify: CiProductNotifyWords;
  /** The product's replies to commands no job runs (#4946), when it gives any. */
  replies?: CiProductCommentReplies;
}

/** chant's own approve line. */
export const CHANT_APPROVE_TEMPLATE = "chant approve {op} {gate} --plan {digest} --approver {approver} {sign}";

/** chant's own override line. */
export const CHANT_OVERRIDE_TEMPLATE = 'chant approve {op} {target} --rule {rule} --reason "<why>" {sign}';

/** chant's own reject line (#5354). */
export const CHANT_REJECT_TEMPLATE = "chant reject {op} {gate} --plan {digest} --reason {reason} {sign}";

/** chant's words: what every slot defaults to. */
export const CHANT_WORDS: CiProductWords = Object.freeze<CiProductWords>({
  product: "chant",
  stages: { plan: "plan", apply: "apply", record: "record", check: "check", drift: "drift", lock: "lock", approval: "approval", control: "control" },
  verbs: { plan: ["plan", "planned"], apply: ["apply", "applied"] },
  noun: ["member", "members"],
  commands: { apply: "apply" },
  aliases: [],
  approve: CHANT_APPROVE_TEMPLATE,
  override: CHANT_OVERRIDE_TEMPLATE,
  reject: CHANT_REJECT_TEMPLATE,
  gateName: "{gate}-wave-{k}",
  prGate: "pr-apply",
  approval: "pull-request",
  applyMode: "release",
  adoptMarkers: [],
  notify: { source: "chant", wave: CHANT_NOTIFY_WAVE_TEMPLATE, headers: "x-chant" },
});

/** Fill every slot `input` leaves out with chant's word. */
export function resolveProductWords(input: CiProductWordsInput | CiProductWords = {}): CiProductWords {
  const product = input.product ?? CHANT_WORDS.product;
  const own = product !== CHANT_WORDS.product;
  return {
    product,
    stages: { ...CHANT_WORDS.stages, ...(input.stages ?? {}) },
    verbs: { plan: input.verbs?.plan ?? CHANT_WORDS.verbs.plan, apply: input.verbs?.apply ?? CHANT_WORDS.verbs.apply },
    noun: input.noun ?? CHANT_WORDS.noun,
    commands: input.commands ?? CHANT_WORDS.commands,
    aliases: input.aliases ?? [],
    // A product's own lines default to chant's grammar under its own name.
    approve: input.approve ?? (own ? `${product} approve {op} {gate} --plan {digest} {sign}` : CHANT_APPROVE_TEMPLATE),
    override: input.override ?? (own ? `${product} override {target} --rule {rule} --reason {reason} {sign}` : CHANT_OVERRIDE_TEMPLATE),
    reject: input.reject ?? (own ? `${product} reject {op} {gate} --plan {digest} --reason {reason} {sign}` : CHANT_REJECT_TEMPLATE),
    ...(input.op !== undefined ? { op: input.op } : {}),
    gateName: input.gateName ?? CHANT_WORDS.gateName,
    prGate: input.prGate ?? CHANT_WORDS.prGate,
    approval: input.approval ?? CHANT_WORDS.approval,
    applyMode: input.applyMode ?? (own && (input.op !== undefined || input.approval === "per-wave") ? "on-merge" : CHANT_WORDS.applyMode),
    ...(input.bin !== undefined ? { bin: input.bin } : {}),
    adoptMarkers: input.adoptMarkers ?? [],
    notify: {
      source: input.notify?.source ?? product,
      wave: input.notify?.wave ?? CHANT_NOTIFY_WAVE_TEMPLATE,
      headers: input.notify?.headers ?? `x-${product}`,
      ...(input.notify?.message ? { message: input.notify.message } : {}),
    },
    ...(input.replies !== undefined ? { replies: input.replies } : {}),
  };
}

/** A word that may reach a shell line, an `if:` expression or a status context. */
const WORD = /^[a-z0-9][a-z0-9-]*$/;
/** An op or gate name, as the gate ledger names files. */
const NAME = /^[a-z0-9][a-z0-9_-]*$/;
/** A template's placeholders. */
const PLACEHOLDERS = new Set(["op", "gate", "digest", "approver", "sign", "target", "rule", "reason"]);

/** The notify wave label's placeholders (#4610). */
const NOTIFY_WAVE_PLACEHOLDERS = new Set(["k", "name", "spec", "product"]);

/** Thrown for words chant refuses, with every problem named. */
export class CiProductWordsError extends Error {
  constructor(readonly problems: string[]) {
    super(`the product's words are refused: ${problems.join("; ")}`);
    this.name = "CiProductWordsError";
  }
}

/**
 * Every problem with `words`, one line each: a word outside `[a-z0-9-]`, one
 * stage word used for two stages, a command the pipeline has no job for
 * (`jobs`, when given, lists the commands it answers), and a template with
 * a placeholder chant does not fill.
 */
export function productWordsProblems(words: CiProductWords, options: { jobs?: readonly CiProductCommand[] } = {}): string[] {
  const problems: string[] = [];
  const word = (where: string, value: string) => {
    if (!WORD.test(value)) problems.push(`${where} is ${JSON.stringify(value)}, and a word is lowercase letters, digits and -`);
  };
  word("product", words.product);
  const seen = new Map<string, CiProductStage>();
  for (const stage of CI_PRODUCT_STAGES) {
    const w = words.stages[stage];
    word(`stages.${stage}`, w);
    const other = seen.get(w);
    if (other) problems.push(`stages.${stage} and stages.${other} are both ${JSON.stringify(w)}, so their statuses would be one`);
    seen.set(w, stage);
  }
  for (const [k, pair] of Object.entries(words.verbs)) pair.forEach((v, i) => word(`verbs.${k}[${i}]`, v));
  words.noun.forEach((v, i) => word(`noun[${i}]`, v));
  for (const [typed, command] of Object.entries(words.commands)) {
    word(`commands.${typed}`, typed);
    if (!CI_PRODUCT_COMMANDS.includes(command)) problems.push(`commands.${typed} maps onto ${JSON.stringify(command)}, which is not one of ${CI_PRODUCT_COMMANDS.join(", ")}`);
    else if (options.jobs && !options.jobs.includes(command)) problems.push(`commands.${typed} needs a ${command} job, and the pipeline has none`);
  }
  for (const a of words.aliases) {
    if (!/^[a-z0-9][a-z0-9 -]*$/.test(a.from)) problems.push(`the alias ${JSON.stringify(a.from)} is lowercase words`);
    if (!Object.values(words.commands).includes(a.command)) problems.push(`the alias ${JSON.stringify(a.from)} stands for ${a.command}, which no command names`);
    // #4946: a refused flag is one word starting with -, and its reply one line.
    for (const [flag, reason] of Object.entries(a.refuse ?? {})) {
      if (!/^--?[A-Za-z0-9-]*$/.test(flag)) problems.push(`the alias ${JSON.stringify(a.from)} refuses ${JSON.stringify(flag)}, and a flag is - or -- then letters, digits and -`);
      if (typeof reason !== "string" || reason.trim() === "" || /[\r\n]/.test(reason)) problems.push(`the alias ${JSON.stringify(a.from)} refuses ${flag} with no one-line reply`);
    }
  }
  // #4946: each reply is one line of text; the member reply's placeholders are {member} and {members}.
  for (const [slot, text] of Object.entries(words.replies ?? {})) {
    if (!CI_PRODUCT_COMMENT_REPLIES.includes(slot as keyof CiProductCommentReplies)) problems.push(`replies.${slot} is not one of ${CI_PRODUCT_COMMENT_REPLIES.join(", ")}`);
    else if (typeof text !== "string" || text.trim() === "" || /[\r\n]/.test(text)) problems.push(`replies.${slot} is one line of text`);
    else for (const m of text.matchAll(/\{([^}]*)\}/g)) if (slot !== "member" || (m[1] !== "member" && m[1] !== "members")) problems.push(`replies.${slot} names {${m[1]}}, which chant does not fill`);
  }
  for (const [where, template] of [["approve", words.approve], ["override", words.override], ["reject", words.reject ?? CHANT_REJECT_TEMPLATE]] as const) {
    for (const m of template.matchAll(/\{([^}]*)\}/g)) if (!PLACEHOLDERS.has(m[1]!)) problems.push(`${where} names {${m[1]}}, which chant does not fill`);
    if (/[`$;&|<>\\\n]/.test(template.replace(/\{[^}]*\}/g, "").replace(/<[a-z-]+>/g, ""))) problems.push(`${where} carries shell syntax`);
  }
  if (words.op !== undefined && !NAME.test(words.op)) problems.push(`op is ${JSON.stringify(words.op)}, and an op is lowercase letters, digits, - and _`);
  if (!NAME.test(words.prGate)) problems.push(`prGate is ${JSON.stringify(words.prGate)}, and a gate is lowercase letters, digits, - and _`);
  if (!words.gateName.includes("{k}")) problems.push("gateName needs {k}, so each wave has its own gate");
  else if (!NAME.test(words.gateName.replace("{gate}", "g").replace("{k}", "1"))) problems.push(`gateName ${JSON.stringify(words.gateName)} does not make a gate name`);
  if (words.approval !== "per-wave" && words.approval !== "pull-request") problems.push(`approval is ${JSON.stringify(words.approval)}; use per-wave or pull-request`);
  if (!CI_PRODUCT_APPLY_MODES.includes(words.applyMode)) problems.push(`applyMode is ${JSON.stringify(words.applyMode)}; use ${CI_PRODUCT_APPLY_MODES.join(", ")}`);
  if (words.bin !== undefined && !/^[A-Za-z0-9@/._ -]+$/.test(words.bin)) problems.push(`bin ${JSON.stringify(words.bin)} carries shell syntax`);
  // #4610: the notify slots. A receiver routes on the source and verifies under the header prefix.
  const notify = words.notify ?? CHANT_WORDS.notify;
  word("notify.source", notify.source);
  if (!/^x-[a-z0-9][a-z0-9-]*$/.test(notify.headers)) problems.push(`notify.headers is ${JSON.stringify(notify.headers)}, and a header prefix is x- then lowercase letters, digits and -`);
  for (const m of notify.wave.matchAll(/\{([^}]*)\}/g)) if (!NOTIFY_WAVE_PLACEHOLDERS.has(m[1]!)) problems.push(`notify.wave names {${m[1]}}, which chant does not fill`);
  if (!notify.wave.includes("{k}")) problems.push("notify.wave needs {k}, so a message names its wave");
  if (/[\r\n]/.test(notify.wave)) problems.push("notify.wave is one line");
  return problems;
}

/** Refuse words with any problem ({@link productWordsProblems}); return them resolved. */
export function assertProductWords(input: CiProductWordsInput | CiProductWords, options: { jobs?: readonly CiProductCommand[] } = {}): CiProductWords {
  const words = resolveProductWords(input);
  const problems = productWordsProblems(words, options);
  if (problems.length > 0) throw new CiProductWordsError(problems);
  return words;
}

let active: CiProductWords = CHANT_WORDS;

/** The words the running command renders with: the product's when its bin set them, else chant's. */
export function activeProductWords(): CiProductWords {
  return active;
}

/** Set the words for this process (a product's bin, once, before it calls chant). Returns the ones it replaced. */
export function setActiveProductWords(words: CiProductWordsInput | CiProductWords | undefined): CiProductWords {
  const was = active;
  active = words ? assertProductWords(words) : CHANT_WORDS;
  return was;
}

/** Run `fn` with `words` active, and put the earlier ones back after it settles. */
export async function withProductWords<T>(words: CiProductWordsInput | CiProductWords | undefined, fn: () => Promise<T>): Promise<T> {
  if (!words) return fn();
  const was = setActiveProductWords(words);
  try {
    return await fn();
  } finally {
    active = was;
  }
}

/** Whether `words` are chant's own, so callers can keep chant's long-standing text. */
export function isChantWords(words: CiProductWords): boolean {
  return words.product === CHANT_WORDS.product;
}

/** A status context: `<product>/<stage word>`, then `/<member>` in a workspace member. */
export function productStatusContext(words: CiProductWords, stage: CiProductStage, member?: string): string {
  const context = `${words.product}/${words.stages[stage]}`;
  return member ? `${context}/${member}` : context;
}

/**
 * How a notify summary names wave `k` of `spec` (#4610): the words'
 * `notify.wave` filled. chant's words give `wave 2 (prod) of tf-apply`, and
 * `wave 2 of tf-apply` for a wave with no name.
 */
export function notifyWaveLabel(words: CiProductWords, input: { k: number; name?: string; spec: string }): string {
  const template = (words.notify ?? CHANT_WORDS.notify).wave;
  const named = input.name ? template : template.replace(/ ?\(\{name\}\)/g, "").replace(/ ?\{name\}/g, "");
  return named.replace(/\{(k|name|spec|product)\}/g, (_, key: string) =>
    key === "k" ? String(input.k) : key === "name" ? (input.name ?? "") : key === "spec" ? input.spec : words.product,
  );
}

/** The context for a name chant uses as is, such as a run record's `pr-plan` or a gate: `<product>/<name>`. */
export function productContext(words: CiProductWords, name: string): string {
  return `${words.product}/${name}`;
}

/** What {@link approveLine} fills. */
export interface ApproveLineInput {
  op: string;
  gate: string;
  digest: string;
  /** Default `<you>`. */
  approver?: string;
  /** The approval must be sealed: `--sign` fills `{sign}`. Default true for chant's line, as the PR loop's line always signed. */
  sign?: boolean;
  /** The wave's run target (#4574), an environment or tenant. Empty when absent. */
  target?: string;
  /** chant's line names `--env <environment>` for a component gate. */
  environment?: string;
}

const fill = (template: string, values: Record<string, string>): string =>
  template
    .replace(/\{([a-z]+)\}/g, (_, k: string) => values[k] ?? "")
    .split(/[ \t]+/)
    .filter((w) => w !== "")
    .join(" ");

/**
 * The command a reviewer runs to approve a digest: the product's template
 * filled. One function for the note, the job log and the chat message, so all
 * three name the same command.
 */
export function approveLine(words: CiProductWords, input: ApproveLineInput): string {
  const line = fill(words.approve, {
    op: input.op,
    gate: input.gate,
    digest: input.digest,
    approver: input.approver ?? "<you>",
    sign: input.sign === false ? "" : "--sign",
    target: input.target ?? "",
  });
  // chant's own line names a component gate's environment after the gate, as `chant approve` reads it.
  if (input.environment !== undefined && isChantWords(words) && words.approve === CHANT_APPROVE_TEMPLATE) {
    return line.replace(` ${input.gate} `, ` ${input.gate} --env ${input.environment} `);
  }
  return line;
}

/** What {@link overrideLine} fills. */
export interface OverrideLineInput {
  /** The op the override is recorded under (chant's `policy-override`). */
  op: string;
  /** The gate the denial stopped, for a product whose line names it. */
  gate?: string;
  /** The rules that denied the plan, each once. `{rule}` is them joined by ` --rule `, so `--rule {rule}` names each. */
  rules: readonly string[];
  /** Default `<text>`, for the person to write. */
  reason?: string;
  /** What was denied: the member, or the wave's run target (#4574). */
  target?: string;
  digest?: string;
  sign?: boolean;
}

/** The command that overrides a policy denial: the product's template filled. */
export function overrideLine(words: CiProductWords, input: OverrideLineInput): string {
  return fill(words.override, {
    op: input.op,
    gate: input.gate ?? "",
    rule: [...new Set(input.rules)].sort().join(" --rule "),
    reason: input.reason ?? "<text>",
    target: input.target ?? "",
    digest: input.digest ?? "",
    approver: "<you>",
    sign: input.sign ? "--sign" : "",
  });
}

/** What {@link rejectLine} fills (#5354). */
export interface RejectLineInput {
  op: string;
  gate: string;
  digest: string;
  /** Default `<why>`, for the person to write. */
  reason?: string;
  /** Seal it: `--sign` fills `{sign}`. Default true. */
  sign?: boolean;
  target?: string;
}

/** The command a reviewer runs to reject a release at a gate (#5354): the product's reject template filled. */
export function rejectLine(words: CiProductWords, input: RejectLineInput): string {
  return fill(words.reject ?? CHANT_REJECT_TEMPLATE, {
    op: input.op,
    gate: input.gate,
    digest: input.digest,
    reason: input.reason ?? "<why>",
    approver: "<you>",
    sign: input.sign === false ? "" : "--sign",
    target: input.target ?? "",
  });
}

/** The typed word for one of chant's commands: the first `commands` entry that maps onto it. */
export function commandWord(words: CiProductWords, command: CiProductCommand): string | undefined {
  return Object.entries(words.commands).find(([, c]) => c === command)?.[0];
}

/** The comment a job answers: `/<product> <word>`, such as `/plywood up`. Undefined when the product has no word for the command. */
export function commentLine(words: CiProductWords, command: CiProductCommand): string | undefined {
  const typed = commandWord(words, command);
  return typed === undefined ? undefined : `/${words.product} ${typed}`;
}

/** The wave gate pattern filled for wave `k`. */
export function productWaveGate(words: CiProductWords, gate: string, k: number): string {
  return words.gateName.replace("{gate}", gate).replace("{k}", String(k));
}

/** A comment read against the product's grammar. */
export type ParsedProductComment =
  /**
   * A re-plan, of one member when the comment names it, narrowed to each
   * `--target <address>` (or `<member>:<address>`) after the plan word (#4626).
   */
  | { kind: "plan"; member?: string; targets?: string[]; refresh?: true; targetDependents?: true }
  /** An apply, through wave n when the comment names `wave-<n>`. */
  | { kind: "apply"; wave?: number }
  | { kind: "lock" }
  | { kind: "unlock" }
  /** An ask for the agent: data, never split or run. */
  | { kind: "agent"; ask: string }
  /**
   * A day-2 action (#4653): `<member> <action>`, such as `apps/orders
   * module.app.action.aws_lambda_invoke.rotate` or a stack's action name.
   * The engine's lexicon checks the action against the member's plan.
   */
  | { kind: "action"; member: string; address: string }
  /** A commit job's command (#4722), by the word typed: `/terragucci fmt`. Several words may each map onto `commit`. */
  | { kind: "commit"; word: string; arg?: string }
  /**
   * A rejection of the release a stage waits on (#5354): `/<product>
   * reject [--stage <stage>] <reason>`. The comment job records it when the
   * stage's approval mode takes the comment author's forge identity.
   */
  | { kind: "reject"; stage?: string; reason: string }
  | { kind: "refused"; reason: string };

/** A member as a comment may name it: path segments, no leading dash, no shell or glob syntax. */
const MEMBER = /^[A-Za-z0-9_][A-Za-z0-9_.\/-]{0,199}$/;
/**
 * A target address as a comment may give it (#4626): a Terraform address,
 * a Pulumi URN, or `<member>:<address>`, at most 500 characters, with no
 * leading dash and none of the characters a shell or a quote would read.
 * It never reaches a shell: the job reads the comment from a variable.
 */
const TARGET = /^[A-Za-z0-9_][A-Za-z0-9_.:\/\[\]"*@=+$,-]{0,499}$/;
/**
 * An action as a comment may name it (#4653): a Terraform action address,
 * module steps and instance keys included, or a configured action's name.
 * No leading dash, no spaces, no shell or glob syntax.
 */
const ACTION = /^[A-Za-z_][A-Za-z0-9_.\[\]"-]{0,299}$/;
/**
 * The one argument a commit word may take after it (#4820), on top of the
 * product's own pattern: a plain name, no leading dash, no path or shell
 * syntax, at most 100 characters.
 */
export const COMMIT_COMMENT_ARG = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
/** The longest ask an agent comment may carry. */
export const PRODUCT_COMMENT_ASK_MAX = 2000;
/** Commands a comment never runs, named in the reply so nobody waits on them. */
const NEVER = new Set(["approve", "override", "force-unlock", "unlock-state", "import", "state", "destroy", "merge"]);

/** {@link parseProductComment}'s options. */
export interface ProductCommentOptions {
  /** Leave every comment for a commit word to the commit job (#4890): it is undefined here, a refused one included. */
  leaveCommit?: boolean;
}

/**
 * The commit word a comment names (#4890): its first two words, split on
 * any space, are `/<product> <word>` and the words map `<word>` onto
 * `commit`. The commit job replies to a refused comment by this rule
 * (#4838), so a comment job that skips these never answers a comment the
 * commit job answers. Undefined for any other comment.
 */
export function commitWordOf(words: CiProductWords, body: unknown): string | undefined {
  if (typeof body !== "string") return undefined;
  const said = body.trim().split(/[ \t\r\n]+/);
  if (said[0] !== `/${words.product}` || said[1] === undefined) return undefined;
  return words.commands[said[1]] === "commit" ? said[1] : undefined;
}

/**
 * Read a comment against the product's grammar (moved from terragucci's
 * comment.ts). Undefined when it is not addressed to the product. A comment
 * that starts with `/<product>` is a command or it is refused: the whole
 * comment is the command, one line, words separated by spaces or tabs. The
 * comment is untrusted input: only a member path checked against a pattern
 * with no shell syntax, and a wave number, leave this function.
 *
 * `env` turns on an alias whose `when` variable is `1` there. `commitArgs`
 * names the commit words that take one argument after them (#4820), each
 * with the pattern it must match; it must also match
 * {@link COMMIT_COMMENT_ARG}. Any other commit word takes nothing.
 *
 * `leaveCommit` (#4890) is for a comment job that is not the commit job: a
 * comment for a commit word is undefined, a malformed one included
 * ({@link commitWordOf}), because the commit job answers it, refusals and
 * all (#4838). Without it, a malformed `/<product> <commit word> x` would
 * get a reply from both jobs.
 */
export function parseProductComment(
  words: CiProductWords,
  body: unknown,
  env: Record<string, string | undefined> = {},
  commitArgs: Readonly<Record<string, RegExp>> = {},
  options: ProductCommentOptions = {},
): ParsedProductComment | undefined {
  if (typeof body !== "string") return undefined;
  if (options.leaveCommit && commitWordOf(words, body) !== undefined) return undefined;
  let text = body.trim();
  const prefix = `/${words.product}`;
  for (const a of words.aliases) {
    if (a.when !== undefined && env[a.when] !== "1") continue;
    if (text !== a.from && !text.startsWith(`${a.from} `) && !text.startsWith(`${a.from}\t`)) continue;
    if (/[\r\n]/.test(text)) return { kind: "refused", reason: "a command is one line, and nothing else in the comment" };
    const typed = commandWord(words, a.command);
    if (typed === undefined) return undefined;
    const rest = text.slice(a.from.length).trim().split(/[ \t]+/).filter((w) => w !== "");
    const args: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i]!;
      // #4946: a flag the product has no counterpart for gets the product's own reason.
      const refused = a.refuse && Object.prototype.hasOwnProperty.call(a.refuse, w) ? a.refuse[w] : undefined;
      if (refused !== undefined) return { kind: "refused", reason: refused };
      if (w === "-d" || w === "--dir") {
        const dir = rest[++i];
        if (dir === undefined) return { kind: "refused", reason: `\`${w}\` names the ${words.noun[0]}'s directory` };
        args.push(dir.replace(/^\.\/+/, "").replace(/\/+$/, ""));
      } else if (w === "--verbose") continue;
      else if (w.startsWith("-")) return { kind: "refused", reason: `\`${a.from}\` takes no flag ${w} here` };
      else args.push(w);
    }
    text = [prefix, typed, ...args].join(" ");
    break;
  }
  if (text !== prefix && !text.startsWith(`${prefix} `) && !text.startsWith(`${prefix}\t`)) return undefined;
  if (/[\r\n]/.test(text)) return { kind: "refused", reason: "a command is one line, and nothing else in the comment" };
  const parts = text.split(/[ \t]+/);
  const typed = parts[1];
  const known = Object.keys(words.commands).map((w) => `\`${prefix} ${w}\``).join(", ");
  if (typed === undefined) return { kind: "refused", reason: `the commands are ${known}` };
  const command = words.commands[typed];
  if (command === undefined) {
    return {
      kind: "refused",
      reason:
        typed === "reject"
          ? // #5354: words that map no comment command onto reject leave rejections to the reject line.
            `${words.product}'s comments take no reject command: run \`${rejectLine(words, { op: words.op ?? "<op>", gate: "<gate>", digest: "<digest>" })}\``
          : NEVER.has(typed)
            ? `a comment never runs \`${typed}\`: ${words.product} re-plans, and runs what an approval covers, on request and nothing more`
            : `the commands are ${known}`,
    };
  }
  const line = `\`${prefix} ${typed}\``;
  switch (command) {
    case "lock":
    case "unlock":
      return parts.length === 2 ? { kind: command } : { kind: "refused", reason: `${line} takes nothing after it` };
    case "commit": {
      // An alias for a commit word, which commitWordOf does not read, is the commit job's too.
      if (options.leaveCommit) return undefined;
      if (parts.length === 2) return { kind: "commit", word: typed };
      const pattern = Object.prototype.hasOwnProperty.call(commitArgs, typed) ? commitArgs[typed] : undefined;
      if (pattern === undefined) return { kind: "refused", reason: `${line} takes nothing after it` };
      const arg = parts[2]!;
      if (parts.length !== 3 || !COMMIT_COMMENT_ARG.test(arg) || !pattern.test(arg)) {
        return { kind: "refused", reason: `${line} takes nothing, or one name after it matching \`${pattern.source}\`` };
      }
      return { kind: "commit", word: typed, arg };
    }
    case "agent": {
      const ask = text.slice(`${prefix} ${typed}`.length).trim();
      if (ask === "") return { kind: "refused", reason: `${line} needs an ask after it, on the same line` };
      if (ask.length > PRODUCT_COMMENT_ASK_MAX) return { kind: "refused", reason: `an ask is at most ${PRODUCT_COMMENT_ASK_MAX} characters` };
      if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(ask)) return { kind: "refused", reason: "an ask is plain text, with no control characters" };
      return { kind: "agent", ask };
    }
    case "action": {
      const usage = `${line} takes a ${words.noun[0]} and an action: \`${prefix} ${typed} <${words.noun[0]}> <action>\``;
      if (parts.length !== 4) return { kind: "refused", reason: usage };
      const member = parts[2]!;
      const address = parts[3]!;
      if (!MEMBER.test(member) || member.split("/").some((s) => s === "" || s === "." || s === "..")) return { kind: "refused", reason: `the ${words.noun[0]} is a name or a path from the repository root` };
      if (!ACTION.test(address)) return { kind: "refused", reason: "an action is an action address or name, with no spaces or shell characters" };
      return { kind: "action", member, address };
    }
    case "reject": {
      // #5354: the reason is the rest of the line; `--stage <stage>` first names the stage when several wait.
      let rest = text.slice(`${prefix} ${typed}`.length).trim();
      let stage: string | undefined;
      const flag = /^--stage[ \t]+(\S+)[ \t]*/.exec(rest);
      if (flag) {
        if (!NAME.test(flag[1]!)) return { kind: "refused", reason: "a stage is a name of lowercase letters, digits, - and _" };
        stage = flag[1]!;
        rest = rest.slice(flag[0].length).trim();
      } else if (rest.startsWith("-")) return { kind: "refused", reason: `${line} takes \`--stage <stage>\` and a reason, and no other flag` };
      if (rest === "") return { kind: "refused", reason: `${line} needs a reason after it, on the same line: \`${prefix} ${typed} [--stage <stage>] <reason>\`` };
      if (rest.length > PRODUCT_COMMENT_ASK_MAX) return { kind: "refused", reason: `a reason is at most ${PRODUCT_COMMENT_ASK_MAX} characters` };
      if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(rest)) return { kind: "refused", reason: "a reason is plain text on one line" };
      return { kind: "reject", ...(stage !== undefined ? { stage } : {}), reason: rest };
    }
    case "apply": {
      if (parts.length === 2) return { kind: "apply" };
      const m = parts.length === 3 ? /^wave-([1-9][0-9]{0,3})$/.exec(parts[2]!) : null;
      return m ? { kind: "apply", wave: Number(m[1]) } : { kind: "refused", reason: `${line} takes nothing, or a wave like \`wave-2\`` };
    }
    case "plan": {
      // #4626: repeatable --target <address> after the plan word, and at most one member.
      const targets: string[] = [];
      const rest: string[] = [];
      const flags: { refresh?: true; targetDependents?: true } = {};
      for (let i = 2; i < parts.length; i++) {
        const w = parts[i]!;
        if (w === "--target") {
          const address = parts[++i];
          if (address === undefined) return { kind: "refused", reason: `\`--target\` needs an address after it: \`${prefix} ${typed} --target <address>\`` };
          if (!TARGET.test(address)) return { kind: "refused", reason: "a target is a resource address or URN, or <member>:<address>, with no spaces or shell characters" };
          targets.push(address);
        } else if (w === "--refresh") flags.refresh = true;
        // #4627: the flags pr-plan takes beside --target.
        else if (w === "--target-dependents") flags.targetDependents = true;
        else if (w.startsWith("-")) return { kind: "refused", reason: `${line} takes \`--target <address>\`, \`--target-dependents\` and \`--refresh\`, and no other flag` };
        else rest.push(w);
      }
      if (rest.length > 1) return { kind: "refused", reason: `${line} takes one ${words.noun[0]} at most` };
      const member = rest[0];
      if (flags.targetDependents && targets.length === 0) return { kind: "refused", reason: "`--target-dependents` widens a `--target`; give one" };
      const narrowed = { ...(targets.length > 0 ? { targets } : {}), ...flags };
      if (member === undefined) return { kind: "plan", ...narrowed };
      if (!MEMBER.test(member) || member.split("/").some((s) => s === "" || s === "." || s === "..")) return { kind: "refused", reason: `the ${words.noun[0]} is a name or a path from the repository root` };
      return { kind: "plan", member, ...narrowed };
    }
  }
}

/**
 * The variables the generated action job (#4654) hands the product's action
 * verb: the comment that started it, on a comment, and the dispatch's two
 * inputs, on a dispatch. The values reach the job as variables and never as
 * shell text; {@link productActionFromEnv} reads them.
 */
export const PRODUCT_ACTION_ENV = { comment: "CHANT_ACTION_COMMENT", member: "CHANT_ACTION_MEMBER", action: "CHANT_ACTION" } as const;

/** The flag the generated action job passes the product's action verb, so it reads {@link PRODUCT_ACTION_ENV} (#4654). */
export const PRODUCT_ACTION_EVENT_FLAG = "--from-event";

/** What an action job was asked for (#4654): a member and an action, from a comment or a dispatch. */
export type ProductActionRequest = { kind: "action"; member: string; address: string; from: "comment" | "dispatch" } | { kind: "refused"; reason: string };

/**
 * The action an action job was started for (#4654), read from
 * {@link PRODUCT_ACTION_ENV}: a comment, parsed as {@link parseProductComment}
 * parses it, else the dispatch's member and action, checked by the same
 * rules. A product's action verb calls this under
 * {@link PRODUCT_ACTION_EVENT_FLAG}.
 */
export function productActionFromEnv(words: CiProductWords, env: Record<string, string | undefined>): ProductActionRequest {
  const typed = commandWord(words, "action");
  if (typed === undefined) return { kind: "refused", reason: `${words.product} names no action command, so no job answers one` };
  const comment = env[PRODUCT_ACTION_ENV.comment]?.trim();
  if (comment) {
    const parsed = parseProductComment(words, comment, env);
    if (parsed?.kind === "action") return { ...parsed, from: "comment" };
    if (parsed?.kind === "refused") return parsed;
    return { kind: "refused", reason: `the comment is not \`/${words.product} ${typed} <${words.noun[0]}> <action>\`` };
  }
  const member = env[PRODUCT_ACTION_ENV.member]?.trim() ?? "";
  const action = env[PRODUCT_ACTION_ENV.action]?.trim() ?? "";
  if (member === "" || action === "") return { kind: "refused", reason: `a dispatched action names a ${words.noun[0]} and an action` };
  if (/\s/.test(member) || /\s/.test(action)) return { kind: "refused", reason: `a ${words.noun[0]} and an action are one word each` };
  const parsed = parseProductComment(words, `/${words.product} ${typed} ${member} ${action}`, {});
  if (parsed?.kind === "action") return { ...parsed, from: "dispatch" };
  return parsed?.kind === "refused" ? parsed : { kind: "refused", reason: `a dispatched action names a ${words.noun[0]} and an action` };
}

/*
 * The product config vocabulary (#5343): one key and one set of value words
 * per concept a CI product sets in its own config (terragucci.yml,
 * plywood.yml, yodel.config.ts), each with the chant field it maps to. The
 * reference page is docs/src/content/docs/reference/ci-product-config.mdx,
 * and a test holds the two to the same keys.
 *
 * A key is written here in snake_case, dotted, as a YAML product spells it:
 * `<name>` stands for any key of a map, `[]` for any item of a list. A
 * product whose config is TypeScript spells each segment in camelCase
 * (`not_author` is `notAuthor`); a hyphenated segment, such as
 * `respond.wave-refused`, keeps its hyphen in both.
 */

/** How a product spells a key: snake_case (YAML) or camelCase (TypeScript). */
export type ProductConfigCase = "snake" | "camel";

/** The page section a word sits in. `stage` holds the words for stages and releases. */
export type ProductConfigSection =
  | "environments"
  | "stage"
  | "apply"
  | "approval"
  | "respond"
  | "reports"
  | "identity"
  | "secrets"
  | "notify"
  | "agents"
  | "jobs";

/**
 * The shape an alias's value has when it reads as the vocabulary key. A key
 * that one product uses with another meaning is an alias only in that shape.
 */
export type ProductConfigAliasShape = "string" | "map" | "list-or-map" | "storage-url" | "forge-environments";

/** A spelling one product accepts in place of the vocabulary's. */
export interface ProductConfigAlias {
  /** The product that accepts it. */
  product: string;
  /** The key it accepts, in the same notation as {@link ProductConfigWord.key}. Absent for a value alias. */
  key?: string;
  /** A value word it accepts: `[alias, word]`. */
  value?: readonly [string, string];
  /** The alias reads as the key only when its value has this shape. */
  shape?: ProductConfigAliasShape;
}

/** One concept of product config: its key, its value words, and the chant field it maps to. */
export interface ProductConfigWord {
  key: string;
  /** What the key sets, in a few words. */
  concept: string;
  section: ProductConfigSection;
  /** The value words, when the value is one word from a list (or a list of them). */
  values?: readonly string[];
  /** A pattern a string value matches, when the value is not a word from a list. */
  pattern?: string;
  /** What the value is, for the page, when `values` does not say. */
  value?: string;
  /** The chant field, type or command the product maps the key onto. */
  chant: string;
  /** Other places the same word is set, such as a per-environment copy. */
  also?: readonly string[];
  /** The products that set the key with this spelling today. */
  products: readonly string[];
  aliases?: readonly ProductConfigAlias[];
}

const SECRET_NAME = "^[A-Za-z_][A-Za-z0-9_]*$";
const DURATION = "^\\d+[mhd]$";
const STORAGE_URL = "^(s3|gs|az|file)://\\S+$";
const CRON = "^\\S+(\\s+\\S+){4}$";

/** The CI products this vocabulary was settled across. */
export const CI_PRODUCTS: readonly string[] = ["terragucci", "plywood", "sql-yodeler"];

/** The vocabulary, in page order. */
export const PRODUCT_CONFIG_WORDS: readonly ProductConfigWord[] = /* @__PURE__ */ Object.freeze([
  // Environments
  {
    key: "environments.<name>",
    concept: "an environment's settings, keyed by the environment's name",
    section: "environments",
    value: "a map per environment",
    chant: "the names in `environments` of the member's `chant.config.ts`",
    products: ["terragucci", "sql-yodeler"],
  },
  {
    key: "forge_environments.<glob>",
    concept: "the forge deployment environment the jobs of the members a glob matches run in",
    section: "environments",
    value: "a name, or `{ name, url }`",
    chant: "a wave's `environment` in the op-waves spec",
    also: ["environments.<name>.forge_environment"],
    products: [],
    aliases: [{ product: "plywood", key: "environments", shape: "forge-environments" }],
  },
  {
    key: "gate",
    concept: "when a wave waits for an approval",
    section: "approval",
    values: ["always", "on-destructive", "never"],
    chant: "a wave's `gate` (`OpWaveGatePolicy`)",
    also: ["environments.<name>.gate", "stacks.<name>.gate", "waves[].gate"],
    products: ["terragucci", "plywood", "sql-yodeler"],
    aliases: [{ product: "terragucci", value: ["on-destroy", "on-destructive"] }],
  },
  // Stage and release
  {
    key: "promotion",
    concept: "the order a release moves through the environments, first to last",
    section: "stage",
    value: "a list of environment names",
    chant: "`environments` in the member's `chant.config.ts`, in order, which `promotionOrder` reads and `chant components promote` follows; with a pipeline, the order of its stages",
    products: [],
  },
  // #5324: the pipeline's stage keys, written into `.chant/pipeline.ts` by `pipelineFromConfig`.
  {
    key: "environments.<name>.hold",
    concept: "a manual hold: no release is promoted into the stage",
    section: "stage",
    value: "`true`, or a map with `reason` and `until`, an ISO 8601 time",
    chant: "a stage's `hold` in `.chant/pipeline.ts`",
    products: [],
  },
  {
    key: "environments.<name>.freeze",
    concept: "the freeze windows in which no release is promoted into the stage",
    section: "stage",
    value: "a list of maps with `from`, `until` (ISO 8601 times) and `reason`",
    chant: "a stage's `freeze` in `.chant/pipeline.ts`",
    products: [],
  },
  // #5355: a stage's urgent rule and its pause after a rollback.
  {
    key: "environments.<name>.urgent.role",
    concept: "the role whose one proven approval passes the stage's gate on an urgent promote",
    section: "stage",
    value: "a role name from `.chant/trust.json`",
    chant: "a stage gate's `urgent.role` in `.chant/pipeline.ts`, which `chant components promote --urgent` passes",
    products: [],
  },
  {
    key: "environments.<name>.pause_after_rollback",
    concept: "a rollback of the stage pauses it until it is resumed",
    section: "stage",
    value: "true or false",
    chant: "a stage's `pauseAfterRollback` in `.chant/pipeline.ts`",
    products: [],
  },
  {
    key: "environments.<name>.failure_tolerance",
    concept: "the failed runs a wave of many targets lets through before the stage stops",
    section: "stage",
    pattern: "^(100|[1-9]?[0-9])%$",
    value: "a whole number of runs, or a share of the wave's runs such as `10%`",
    chant: "a stage's `failureTolerance` in `.chant/pipeline.ts`, a wave's `failureTolerance`",
    products: [],
  },
  // #5353: stages that follow several stages, and stages that take one release at a time.
  {
    key: "environments.<name>.after",
    concept: "the stages a release applies in before the stage opens for it",
    section: "stage",
    value: "a list of environment names; the stage before it in `promotion` when unset",
    chant: "a stage's `after` in `.chant/pipeline.ts`",
    products: [],
  },
  {
    key: "environments.<name>.queue",
    concept: "how a stage takes releases: one at a time, a newer release waiting replacing an older one",
    section: "stage",
    values: ["replace"],
    chant: "a stage's `queue` in `.chant/pipeline.ts`",
    products: [],
  },
  {
    key: "environments.<name>.approval_rules",
    concept: "the approval rules of one stage, in place of `approval_rules`",
    section: "stage",
    value: "the rules `approval_rules` takes",
    chant: "a stage gate's `quorum` in `.chant/pipeline.ts`",
    products: [],
  },
  {
    key: "release.cut",
    concept: "a merge cuts a release once the first stage applied",
    section: "stage",
    value: "`true` or `false`; `true` when the product writes a pipeline",
    chant: "`release.cut` in `.chant/pipeline.ts`",
    products: [],
  },
  {
    key: "release.label",
    concept: "the label the merge's release is cut with",
    section: "stage",
    value: "a label, or `auto` for the next version",
    chant: "`release.label` in `.chant/pipeline.ts`, `chant release cut <label>`",
    products: [],
  },
  {
    key: "environments.<name>.targets.<member>",
    concept: "the target a member applies in one environment: a stack, a root, or the step's inputs there",
    section: "stage",
    value: "a target name or path, or a map of the step's inputs",
    chant: "the member's step's `environments.<name>` entry, which core merges over the step's input for the run's environment",
    products: [],
  },
  {
    key: "environments.<name>.config.<variable>",
    concept: "a plain value the stage's jobs get as a variable in one environment",
    section: "stage",
    value: "a string",
    chant: "`EnvironmentSets.environments.<name>.config`, which `resolveEnvironmentSet` resolves for the stage's environment",
    also: ["config_sets.<set>.config.<variable>"],
    products: [],
  },
  {
    key: "environments.<name>.secrets.<variable>",
    concept: "a secret the stage's jobs get as a variable in one environment, named by where it is kept",
    section: "stage",
    pattern: SECRET_NAME,
    value: "a forge secret's name, or a map with one of `forge_secret`, `aws_secrets_manager`, `gcp_secret_manager`, `azure_key_vault`",
    chant: "`EnvironmentSets.environments.<name>.secrets`",
    also: ["config_sets.<set>.secrets.<variable>"],
    products: [],
  },
  {
    key: "environments.<name>.secrets.<variable>.forge_secret",
    concept: "the forge secret a set's secret is kept in",
    section: "stage",
    pattern: SECRET_NAME,
    chant: "`forgeSecret` of an `EnvironmentSecretRef`",
    also: ["config_sets.<set>.secrets.<variable>.forge_secret"],
    products: [],
  },
  {
    key: "environments.<name>.imports",
    concept: "the shared sets an environment's set takes first, in order",
    section: "stage",
    value: "a list of `config_sets` names",
    chant: "`EnvironmentSet.imports`",
    also: ["config_sets.<set>.imports"],
    products: [],
  },
  {
    key: "config_sets.<set>",
    concept: "a shared set of config and secrets that environments import",
    section: "stage",
    value: "a map of `config`, `secrets` and `imports`",
    chant: "`EnvironmentSets.configSets`",
    products: [],
  },
  // #5345: plan a member's dependents again when an output they read changes after its apply.
  {
    key: "replan_dependents",
    concept: "the members whose dependents are planned again when an output they read changes after an apply; the plan waits at its gate",
    section: "stage",
    value: "a list of member names or globs",
    chant: "`replanDependents` in `.chant/pipeline.ts` (a stage's, else `defaults`), which `chant components replan` reads",
    also: ["environments.<name>.replan_dependents"],
    products: [],
  },
  // #5356: release artifacts, values a stage publishes for the release it applied, read by later stages and other repos.
  {
    key: "environments.<name>.publish.<artifact>",
    concept: "a release artifact the stage publishes once it applied, kept with the release digest",
    section: "stage",
    value: "a map with `member` and `output` (a member's output), or with `secret` (where a secret is kept, as `environments.<name>.secrets.<variable>` takes it)",
    chant: "a stage's `publish` in `.chant/pipeline.ts`, recorded on `<stage>/artifacts.jsonl`",
    products: [],
  },
  {
    key: "environments.<name>.publish.<artifact>.secret.forge_secret",
    concept: "the forge secret a secret artifact names; the artifact holds the name, never the secret",
    section: "stage",
    pattern: SECRET_NAME,
    chant: "`forgeSecret` of the `EnvironmentSecretRef` in a stage's `publish`",
    products: [],
  },
  {
    key: "environments.<name>.reads.<variable>",
    concept: "an artifact of an earlier stage that the stage's deploy gets in a variable, from the release it takes",
    section: "stage",
    value: "a map with `stage` (an earlier stage) and `artifact` (a name that stage publishes)",
    chant: "a stage's `reads` in `.chant/pipeline.ts`",
    products: [],
  },
  {
    key: "environments.<name>.agent_steps.<step>",
    concept: "an agent step of the stage: a model's reading of the release it takes, with an answer of a declared shape, which approves nothing and applies nothing",
    section: "stage",
    value: "a map with `prompt`, `schema` and `reads`",
    chant: "a stage's `agentSteps` in `.chant/pipeline.ts` (#5358)",
    products: [],
  },
  {
    key: "environments.<name>.agent_steps.<step>.prompt",
    concept: "what the agent step's model is asked",
    section: "stage",
    value: "text, at most 4000 characters",
    chant: "`prompt` of a stage's agent step",
    products: [],
  },
  {
    key: "environments.<name>.agent_steps.<step>.reads.<input>",
    concept: "what the agent step reads, by the name its prompt shows it under: an artifact an earlier stage published for the same release, or the answer of a step before it",
    section: "stage",
    value: "a map with `stage` and `artifact`, or with `step`",
    chant: "`reads` of a stage's agent step",
    products: [],
  },
  {
    key: "environments.<name>.agent_steps.<step>.schema",
    concept: "the JSON Schema the agent step's answer must match; an answer that does not fails the step and holds the stage",
    section: "stage",
    value: "a JSON Schema (2020-12) object",
    chant: "`schema` of a stage's agent step",
    products: [],
  },
  {
    key: "environments.<name>.agent_steps.<step>.command",
    concept: "the model command the agent step runs, prompt on stdin and answer on stdout",
    section: "stage",
    value: "a command line",
    chant: "`command` of a stage's agent step",
    products: [],
  },
  {
    key: "environments.<name>.agent_steps.<step>.key_secret",
    concept: "the secret holding the agent step's model key",
    section: "stage",
    pattern: SECRET_NAME,
    chant: "`keyEnv` of a stage's agent step",
    products: [],
  },
  {
    key: "environments.<name>.agent_steps.<step>.timeout",
    concept: "the minutes the agent step's model command may run",
    section: "stage",
    value: "a whole number from 1 to 360",
    chant: "`timeout` of a stage's agent step",
    products: [],
  },
  {
    key: "environments.<name>.agent_steps.<step>.max_runs",
    concept: "the most runs of the agent step per day",
    section: "stage",
    value: "a whole number",
    chant: "`maxRuns` of a stage's agent step",
    products: [],
  },
  {
    key: "environments.<name>.agent_steps.<step>.max_cost_usd",
    concept: "the most US dollars the agent step's runs may cost per day",
    section: "stage",
    value: "a number above 0",
    chant: "`maxCostUsd` of a stage's agent step",
    products: [],
  },
  {
    key: "control.release",
    concept: "the `<product>-applied` dispatch carries the release digest the applied commit was cut into, so a downstream run reads that release's artifacts",
    section: "stage",
    value: "`true` or `false`",
    chant: "`release` of `ControlSettingsInput`, sent as `CHANT_CONTROL_RELEASE`",
    products: [],
  },
  // #5334: the cost estimate, in the plan note, as the policy's input.cost, and as a hold.
  {
    key: "cost.command",
    concept: "the estimator run over each member's plan document, which prints its monthly cost",
    section: "stage",
    value: "a command naming `{planJson}`, as argv or a command line",
    chant: "`ci.cost.command` and `holds.cost.command`; the presets are `terraformCostHold` and `pulumiCostHold`",
    products: ["terragucci"],
  },
  {
    key: "cost.format",
    concept: "what the estimator prints",
    section: "stage",
    values: ["infracost", "chant"],
    chant: "`ci.cost.format` and `holds.cost.format`",
    products: [],
  },
  {
    key: "cost.currency",
    concept: "the currency the amounts are in",
    section: "stage",
    pattern: "^[A-Z]{3}$",
    value: "a three-letter currency code such as `USD`",
    chant: "`ci.cost.currency` and `holds.cost.currency`",
    products: [],
  },
  {
    key: "cost.approve_above",
    concept: "the monthly change above which a plan needs an approval of its own",
    section: "stage",
    value: "a monthly amount of 0 or more",
    chant: "`ci.cost.approveAbove` and `holds.cost.approveAbove`",
    products: ["terragucci"],
  },
  {
    key: "agent.wave-refused.command",
    concept: "the model command that summarizes a refused wave, prompt on stdin and summary on stdout",
    section: "stage",
    value: "a command line",
    chant: "`WaveSummarySpec.command` (`CHANT_WAVE_SUMMARY_COMMAND`)",
    products: [],
  },
  {
    key: "agent.wave-refused.key_secret",
    concept: "the secret holding the summarizing model's key",
    section: "stage",
    pattern: SECRET_NAME,
    chant: "`WaveSummarySpec.keyEnv` (`CHANT_WAVE_SUMMARY_KEY_ENV`)",
    products: [],
  },
  {
    key: "agent.wave-refused.timeout",
    concept: "the minutes the summary command may run",
    section: "stage",
    value: "a whole number",
    chant: "`WaveSummarySpec.timeout` (`CHANT_WAVE_SUMMARY_TIMEOUT`)",
    products: [],
  },
  {
    key: "agent.wave-refused.max_runs",
    concept: "the most refused-wave summaries per day",
    section: "stage",
    value: "a whole number",
    chant: "`WaveSummarySpec.maxRuns` (`CHANT_WAVE_SUMMARY_MAX_RUNS`)",
    products: [],
  },
  {
    key: "agent.wave-refused.max_cost_usd",
    concept: "the most US dollars the refused-wave summaries may cost per day",
    section: "stage",
    value: "a number above 0",
    chant: "`WaveSummarySpec.maxCostUsd` (`CHANT_WAVE_SUMMARY_MAX_COST_USD`)",
    products: [],
  },
  {
    key: "approval_rules.<rule>.proven",
    concept: "a rule's count met only by approvers a seal or a review proves",
    section: "stage",
    value: "true or false",
    chant: "`proven` of a quorum rule (`GateQuorumRule`, #5349)",
    also: ["approval_rules[].proven"],
    products: [],
  },
  // #5325: the scored change risk, in the plan note, as the policy's input.risk, and as a hold.
  {
    key: "risk.approve_above",
    concept: "the risk score above which a plan needs an approval of its own",
    section: "stage",
    value: "a score from 0 to 1",
    chant: "`ci.risk.approveAbove` and `holds.risk.approveAbove`",
    also: ["environments.<name>.risk.approve_above"],
    products: [],
  },
  {
    key: "risk.questions",
    concept: "the questions the review agent answers from 0 to 1, each a reason in the risk score",
    section: "stage",
    value: "a list of maps with `id`, `text`, `weight` (0 to 1) and `approve_above` (0 to 1)",
    chant: "`ci.risk.questions`",
    products: [],
  },
  {
    key: "environments.<name>.risk.approval_rules",
    concept: "the approval rules a stage's gate takes on top of its own when the risk is over its score",
    section: "stage",
    value: "the rules `approval_rules` takes",
    chant: "a stage gate's `holds.risk.quorum` in `.chant/pipeline.ts`",
    products: [],
  },
  {
    key: "approval_rules.<rule>.name",
    concept: "a rule's or a group's name, shown in its progress line, the plan note and the pending fact on the ledger",
    section: "stage",
    pattern: "^[a-z0-9][a-z0-9_-]*$",
    value: "lowercase letters, digits, `-` and `_`",
    chant: "`name` of a quorum rule or group (`GateQuorumNode`, #5354)",
    also: ["approval_rules[].name"],
    products: [],
  },
  {
    key: "approval_rules.<rule>.all",
    concept: "a group of rules met when every rule in it is met; groups nest up to three deep",
    section: "stage",
    value: "a list or a map of rules and groups",
    chant: "`{ all: [...] }` in a quorum (`GateQuorumAll`, #5354)",
    also: ["approval_rules[].all"],
    products: [],
  },
  {
    key: "approval_rules.<rule>.any",
    concept: "a group of rules met when one rule in it is met; groups nest up to three deep",
    section: "stage",
    value: "a list or a map of rules and groups",
    chant: "`{ any: [...] }` in a quorum (`GateQuorumAny`, #5354)",
    also: ["approval_rules[].any"],
    products: [],
  },
  {
    key: "environments.<name>.hold.description",
    concept: "what the person who lifts a stage's hold reads first, shown in the plan note, the promote it refuses and `workspace status`",
    section: "stage",
    value: "one line of text",
    chant: "`description` of a stage's `hold` (#5354)",
    products: [],
  },
  // #5327: the canary stage, written into `.chant/pipeline.ts` by `pipelineFromConfig`.
  {
    key: "environments.<name>.canary",
    concept: "the canary stage, whose soak holds every stage after it",
    section: "stage",
    value: "`true` or `false`",
    chant: "a stage's `canary` in `.chant/pipeline.ts`, which takes a `soak` with at least one check",
    products: [],
  },
  // #5326: soak checks that hold the next stage, written into `.chant/pipeline.ts` by `pipelineFromConfig`.
  {
    key: "environments.<name>.soak.duration",
    concept: "how long a stage's soak checks must keep passing after its last apply before a release is promoted into the next stage",
    section: "stage",
    pattern: "^(0|\\d+[mhd])$",
    value: "a duration, or `0` to wait for the checks alone",
    chant: "a stage's `soak.duration` in `.chant/pipeline.ts`",
    products: [],
  },
  {
    key: "environments.<name>.soak.checks[].kind",
    concept: "what one soak check reads",
    section: "stage",
    values: ["http", "prometheus", "cloudwatch-alarm", "command", "health", "drift", "apply", "policy"],
    chant: "a soak check's `kind` (`SoakCheck`), with that kind's settings beside it",
    products: [],
  },
  {
    key: "environments.<name>.soak.checks[].on_fail",
    concept: "what a failing soak check does: start the soak over once it passes again, or hold with the elapsed time kept",
    section: "stage",
    values: ["restart", "hold"],
    chant: "a soak check's `onFail`; `restart` when unset",
    products: [],
  },
  {
    key: "environments.<name>.soak.overrides[].members",
    concept: "the members an override's duration and checks apply to, in place of the soak's",
    section: "stage",
    value: "a list of member names or globs",
    chant: "a soak override's `members` (`SoakOverride`), with its `duration` and `checks`",
    products: [],
  },
  {
    key: "recheck.schedule",
    concept: "how often a promotion a soak holds is tried again",
    section: "stage",
    pattern: CRON,
    value: "a five-field cron line",
    chant: "`recheck.schedule` in `.chant/pipeline.ts`, which renders a `recheck-<stage>` job per stage running `components promote --pending`",
    products: [],
  },
  // Apply
  {
    key: "apply.when",
    concept: "when a change applies",
    section: "apply",
    values: ["merge", "pull-request"],
    chant: "`ci.workflow`",
    products: ["terragucci", "plywood"],
  },
  {
    key: "apply.merge",
    concept: "who merges a pull request that applied before merge",
    section: "apply",
    values: ["manual", "auto"],
    chant: "`chant build --pr-loop --merge`",
    products: ["terragucci", "plywood"],
  },
  {
    key: "apply.merge_token_env",
    concept: "the variable holding the token that merges",
    section: "apply",
    pattern: SECRET_NAME,
    chant: "`--merge-token-env`",
    products: ["terragucci", "plywood"],
  },
  {
    key: "apply.merge_method",
    concept: "how the merge is made",
    section: "apply",
    values: ["merge", "squash", "rebase"],
    chant: "`--merge-method`",
    products: ["plywood"],
  },
  {
    key: "apply.requires",
    concept: "the checks that pass before an apply",
    section: "apply",
    value: "a list of check names",
    chant: "the pull request pipeline's required checks",
    products: ["terragucci", "plywood"],
  },
  {
    key: "branches.<branch>",
    concept: "the members a branch applies, by glob",
    section: "apply",
    value: "a list of globs",
    chant: "`ci.branches`",
    products: ["plywood"],
    aliases: [{ product: "terragucci", key: "apply.branches" }],
  },
  {
    key: "labels.<label>",
    concept: "the members a labelled pull request plans, by glob",
    section: "apply",
    value: "a list of globs",
    chant: "`ci.labels`",
    products: ["plywood"],
  },
  {
    key: "locks.when",
    concept: "when a pull request takes its locks, in the product's stage words",
    section: "apply",
    values: ["plan", "apply", "preview", "up"],
    chant: "`ci.locks`",
    products: ["plywood"],
    aliases: [{ product: "terragucci", key: "locks", shape: "string" }],
  },
  {
    key: "locks.grain",
    concept: "what one lock covers",
    section: "apply",
    values: ["resource", "stack"],
    chant: "`ci.lockGrain`",
    products: ["plywood"],
  },
  {
    key: "waves.canary",
    concept: "the members that apply first, in a wave of their own",
    section: "apply",
    value: "a list of member names or globs",
    chant: "the first wave of the op-waves spec, marked `canary` (#5327): its soak, the environment's soak unless the wave has its own, holds every wave after it",
    products: ["terragucci", "plywood"],
  },
  {
    key: "waves.after.<name>",
    concept: "the members one member applies after",
    section: "apply",
    value: "a list of member names",
    chant: "the wave order of the op-waves spec",
    products: ["terragucci", "plywood"],
  },
  {
    key: "parallelism",
    concept: "how many members one job applies at once",
    section: "jobs",
    value: "a whole number",
    chant: "the wave job's parallelism",
    also: ["environments.<name>.parallelism"],
    products: ["terragucci", "plywood"],
  },
  // Approval
  {
    key: "approval",
    concept: "which approvals of a plan count",
    section: "approval",
    values: ["ledger", "pr-review", "sealed", "pull-request", "prow-labels"],
    chant: "a wave's `approval` (`GateApprovalSource`)",
    also: ["approval.mode", "waves[].approval", "environments.<name>.approval"],
    products: ["terragucci", "plywood", "sql-yodeler"],
  },
  {
    key: "approval_rules.<rule>.count",
    concept: "how many distinct people approve",
    section: "approval",
    value: "a whole number, at least 1",
    chant: "`count` of a quorum rule (`GateQuorumRule`)",
    also: ["approval_rules[].count"],
    products: ["terragucci"],
    aliases: [{ product: "plywood", key: "approval_rules.<name>.quorum" }],
  },
  {
    key: "approval_rules.<rule>.roles",
    concept: "the roles a counted approver holds",
    section: "approval",
    value: "a list of role names",
    chant: "`roles` of a quorum rule",
    also: ["approval_rules[].roles"],
    products: ["terragucci", "plywood"],
    aliases: [{ product: "plywood", key: "approval_rules.<name>.role", shape: "string" }],
  },
  {
    key: "approval_rules.<rule>.not_author",
    concept: "a counted approver who is not the change's author",
    section: "approval",
    value: "true or false",
    chant: "`notAuthor` of a quorum rule",
    also: ["approval_rules[].not_author"],
    products: ["terragucci"],
  },
  {
    key: "policy.engine",
    concept: "the policy engine",
    section: "approval",
    values: ["conftest", "opa"],
    chant: "`ci.policy`",
    products: ["terragucci", "plywood"],
  },
  {
    key: "policy.path",
    concept: "the directory of policy rules in the repository",
    section: "approval",
    value: "a path relative to the repository root",
    chant: "`ci.policy.path`",
    products: ["terragucci"],
    aliases: [{ product: "plywood", key: "policy.rego" }],
  },
  {
    key: "policy.namespace",
    concept: "the policy package the rules sit in",
    section: "approval",
    value: "a package name",
    chant: "`ci.policy`",
    products: ["terragucci", "plywood"],
  },
  {
    key: "policy.source",
    concept: "a shared rule set from another repository",
    section: "approval",
    value: "a git source at a ref",
    chant: "`ci.policy.source`",
    products: ["terragucci", "plywood"],
  },
  {
    key: "evidence.identity",
    concept: "the keyless identity that signs checks",
    section: "approval",
    values: ["oidc"],
    chant: "`PipelineEvidence.identity`",
    products: ["terragucci", "plywood", "sql-yodeler"],
  },
  {
    key: "evidence.runner_key_secret",
    concept: "the secret holding the runner key that signs checks",
    section: "approval",
    pattern: SECRET_NAME,
    chant: "`PipelineEvidence.runnerKeySecret`",
    products: ["terragucci", "plywood", "sql-yodeler"],
  },
  // Respond
  {
    key: "respond.wave-refused",
    concept: "what follows a wave that applied nothing because its plan moved",
    section: "respond",
    values: ["diff", "summary", "off"],
    chant: "`CiResponses[\"wave-refused\"]`",
    products: ["terragucci"],
    aliases: [{ product: "plywood", key: "respond.wave_refused" }],
  },
  {
    key: "respond.apply-failed",
    concept: "what follows a failed apply",
    section: "respond",
    values: ["triage", "off"],
    chant: "`CiResponses[\"apply-failed\"]`",
    products: ["terragucci"],
    aliases: [{ product: "plywood", key: "respond.apply_failed" }],
  },
  {
    key: "respond.description",
    concept: "the pull request description check",
    section: "respond",
    values: ["check", "off"],
    chant: "`CiResponses.description`",
    products: ["terragucci", "plywood"],
  },
  {
    key: "respond.drift",
    concept: "what follows a drift the scheduled check finds",
    section: "respond",
    values: ["issue", "pull-request", "attribute", "up", "off"],
    chant: "the scheduled drift Op's response",
    products: ["terragucci", "plywood"],
    aliases: [{ product: "plywood", value: ["none", "off"] }],
  },
  {
    key: "drift.schedule",
    concept: "when the scheduled drift check runs",
    section: "respond",
    pattern: CRON,
    value: "a five-field cron line",
    chant: "the scheduled drift Op's cron",
    products: ["plywood"],
    aliases: [{ product: "terragucci", key: "drift", shape: "string" }],
  },
  {
    key: "decide.backend",
    concept: "the service that answers a gate's questions",
    section: "respond",
    value: "a backend name",
    chant: "`--decide-backend`",
    products: ["terragucci", "plywood"],
  },
  // Reports
  {
    key: "reports.bucket",
    concept: "where the jobs keep their reports and run index",
    section: "reports",
    pattern: STORAGE_URL,
    value: "an `s3://`, `gs://`, `az://` or `file://` URL",
    chant: "`ci.reportUrl`",
    products: ["terragucci"],
    aliases: [{ product: "plywood", key: "reports.url", shape: "storage-url" }],
  },
  {
    key: "reports.url",
    concept: "the browser address the reports are read at",
    section: "reports",
    pattern: "^https?://\\S+$",
    value: "an `https://` URL",
    chant: "the report links in the plan note",
    products: ["terragucci"],
  },
  {
    key: "telemetry.endpoint",
    concept: "the OTLP/HTTP base URL traces go to",
    section: "reports",
    value: "a URL",
    chant: "`OTEL_EXPORTER_OTLP_ENDPOINT`",
    products: ["plywood"],
  },
  {
    key: "telemetry.headers_secret",
    concept: "the secret holding the OTLP headers",
    section: "reports",
    pattern: SECRET_NAME,
    chant: "`OTEL_EXPORTER_OTLP_HEADERS`",
    products: ["terragucci"],
    aliases: [{ product: "plywood", key: "telemetry.headers_env" }],
  },
  {
    key: "telemetry.trace_url",
    concept: "a link to one trace, with `{trace_id}`",
    section: "reports",
    value: "a URL holding `{trace_id}`",
    chant: "the trace link in the plan note",
    products: ["terragucci"],
  },
  // Identity
  {
    key: "identity",
    concept: "the cloud identities the jobs log in as",
    section: "identity",
    value: "a map per cloud, with a role per stage word and per environment",
    chant: "`ci.identity` and the `ci-login` trade",
    products: ["plywood"],
    aliases: [
      { product: "terragucci", key: "oidc" },
      { product: "sql-yodeler", key: "ci.login" },
    ],
  },
  {
    key: "ephemeral",
    concept: "a copy of the members per open pull request",
    section: "identity",
    value: "a map",
    chant: "`ci.prEnvironment`",
    products: ["terragucci"],
    aliases: [{ product: "plywood", key: "review_stacks" }],
  },
  {
    key: "ephemeral.ttl",
    concept: "how long a pull request's copy lives after its last update",
    section: "identity",
    pattern: DURATION,
    value: "a duration such as `48h`",
    chant: "`ci.prEnvironment.ttl`",
    products: ["terragucci"],
    aliases: [{ product: "plywood", key: "review_stacks.ttl" }],
  },
  {
    key: "forge",
    concept: "the forge the repository is on",
    section: "identity",
    values: ["github", "gitlab", "forgejo"],
    chant: "`ci.forge`",
    products: ["terragucci"],
    aliases: [{ product: "plywood", key: "forge.kind" }],
  },
  {
    key: "forge_url",
    concept: "the forge's address, for a forge not on https or the default port",
    section: "identity",
    value: "a URL",
    chant: "the forge client's base URL",
    products: [],
    aliases: [
      { product: "terragucci", key: "url" },
      { product: "plywood", key: "forge.url" },
    ],
  },
  {
    key: "forges",
    concept: "the forges the pipelines are rendered for",
    section: "identity",
    values: ["github", "gitlab", "forgejo"],
    chant: "the generators `chant ci` runs",
    products: ["sql-yodeler"],
  },
  // Secrets
  {
    key: "token_env",
    concept: "the variable holding the forge token",
    section: "secrets",
    pattern: SECRET_NAME,
    chant: "the forge client's token",
    also: ["control.token_env", "agent.token_env"],
    products: ["terragucci", "plywood"],
  },
  {
    key: "pass.secrets",
    concept: "the CI secrets the jobs read as variables",
    section: "secrets",
    value: "a list of secret names",
    chant: "the jobs' `env`",
    products: ["terragucci"],
    aliases: [{ product: "plywood", key: "pass", shape: "list-or-map" }],
  },
  {
    key: "pass.vars",
    concept: "the CI variables the jobs read",
    section: "secrets",
    value: "a list of variable names",
    chant: "the jobs' `env`",
    products: ["terragucci"],
  },
  {
    key: "env.<name>",
    concept: "plain variables every job sets",
    section: "secrets",
    value: "a map of name to value",
    chant: "the jobs' `env`",
    products: ["terragucci", "plywood"],
  },
  // Notify
  {
    key: "notify.slack",
    concept: "the secret holding a Slack incoming webhook's URL",
    section: "notify",
    pattern: SECRET_NAME,
    chant: "`NotifyConfig.slack`",
    products: ["terragucci", "sql-yodeler"],
    aliases: [{ product: "plywood", key: "notify.slack.webhook" }],
  },
  {
    key: "notify.teams",
    concept: "the secret holding a Microsoft Teams incoming webhook's URL",
    section: "notify",
    pattern: SECRET_NAME,
    chant: "`NotifyConfig.teams`",
    products: ["terragucci", "sql-yodeler"],
    aliases: [{ product: "plywood", key: "notify.teams.webhook" }],
  },
  {
    key: "notify.webhook",
    concept: "the secret holding a generic webhook's URL",
    section: "notify",
    pattern: SECRET_NAME,
    chant: "`NotifyConfig.webhook`",
    products: ["terragucci", "sql-yodeler"],
    aliases: [{ product: "plywood", key: "notify.webhook.url" }],
  },
  {
    key: "notify.webhook_key",
    concept: "the secret holding the key a generic webhook's events are signed with",
    section: "notify",
    pattern: SECRET_NAME,
    chant: "`NotifyConfig.key`",
    products: ["terragucci"],
    aliases: [
      { product: "plywood", key: "notify.webhook.key" },
      { product: "sql-yodeler", key: "notify.key" },
    ],
  },
  {
    key: "notify.events",
    concept: "the events sent",
    section: "notify",
    values: ["waiting", "refused", "failed", "drift"],
    chant: "`NotifyConfig.events`",
    products: ["sql-yodeler"],
    aliases: [{ product: "plywood", key: "notify.on" }],
  },
  {
    key: "notify.relay_key",
    concept: "the secret holding the key the relay checks Approve and Decline with",
    section: "notify",
    pattern: SECRET_NAME,
    chant: "`NotifyConfig.relay`",
    products: ["terragucci"],
    aliases: [
      { product: "plywood", key: "notify.relay" },
      { product: "sql-yodeler", key: "notify.relay" },
    ],
  },
  {
    key: "notify.relay_name",
    concept: "the relay's name as people mention it in Teams",
    section: "notify",
    value: "a name",
    chant: "`NotifyConfig.relayName`",
    products: ["sql-yodeler"],
    aliases: [{ product: "terragucci", key: "notify.relay" }],
  },
  // Agents
  {
    key: "review.key_secret",
    concept: "the secret holding the reviewing model's key",
    section: "agents",
    pattern: SECRET_NAME,
    chant: "the review agent step's key variable",
    products: ["terragucci"],
    aliases: [{ product: "plywood", key: "review.key_env" }],
  },
  {
    key: "review.command",
    concept: "the model command, prompt on stdin and answer on stdout",
    section: "agents",
    value: "a command line",
    chant: "the review agent step's command",
    products: ["terragucci", "plywood"],
  },
  {
    key: "review.timeout",
    concept: "the minutes the review command may run",
    section: "agents",
    value: "a whole number",
    chant: "the review agent step's timeout",
    products: ["terragucci", "plywood"],
  },
  {
    key: "agent.key_secret",
    concept: "the secret holding the agent model's key",
    section: "agents",
    pattern: SECRET_NAME,
    chant: "the agent job's key variable",
    also: ["agent.comment.key_secret", "agent.drift.key_secret", "agent.alert.key_secret", "agent.apply-failed.key_secret", "agent.schedule.key_secret", "agent.verify-failed.key_secret"],
    products: ["terragucci"],
    aliases: [{ product: "plywood", key: "agent.key_env" }],
  },
  {
    key: "agent.comment",
    concept: "an agent that answers a comment command",
    section: "agents",
    value: "true, or a map",
    chant: "the comment agent's jobs",
    products: ["terragucci", "plywood"],
  },
  {
    key: "agent.drift",
    concept: "an agent that opens a pull request for a drifted member",
    section: "agents",
    value: "true, or a map",
    chant: "the drift Op's agent",
    products: ["terragucci", "plywood"],
  },
  {
    key: "agent.alert",
    concept: "an agent that opens a pull request for a production alert the relay recorded",
    section: "agents",
    value: "true, or a map",
    chant: "`productAlertAgent`, the alert agent's workflow",
    products: [],
  },
  {
    key: "agent.apply-failed",
    concept: "an agent that opens a pull request for a failed apply, beside the triage comment",
    section: "agents",
    value: "true, or a map",
    chant: "`productApplyFailedAgent`, the failed-apply agent's workflow, and `CHANT_AGENT_FACTS=apply-failed` on the apply jobs",
    products: [],
  },
  {
    key: "agent.verify-failed",
    concept: "an agent that opens a pull request when a stage's verify or soak fails after an apply",
    section: "agents",
    value: "true, or a map",
    chant: "`productVerifyFailedAgent`, the failed-verify agent's workflow, and `agentFacts` with `verify-failed` among its triggers on the pipeline's jobs",
    products: [],
  },
  {
    key: "agent.schedule",
    concept: "an agent that does a recurring task on a cron and opens a pull request",
    section: "agents",
    value: "a map with `cron` and `task`",
    chant: "`productScheduleAgent`, the scheduled agent's workflow",
    products: [],
  },
  {
    key: "agent.schedule.cron",
    concept: "when the scheduled agent runs",
    section: "agents",
    value: "a five-field cron",
    chant: "the scheduled agent's `schedule`",
    products: [],
  },
  {
    key: "agent.schedule.task",
    concept: "what the scheduled agent does on each run",
    section: "agents",
    value: "text, at most 4000 characters",
    chant: "the scheduled agent's `task`",
    products: [],
  },
  {
    key: "agent.alert.window",
    concept: "the minutes in which one member's alerts, failed applies, failed verifies or scheduled runs join one agent run",
    section: "agents",
    value: "a whole number from 1 to 1440, 15 by default",
    chant: "the agent's `window`",
    also: ["agent.apply-failed.window", "agent.schedule.window", "agent.verify-failed.window"],
    products: [],
  },
  {
    key: "agent.alert.relay_key_secret",
    concept: "the secret holding the relay key the alert, failed-apply and failed-verify facts are signed and checked with",
    section: "agents",
    pattern: SECRET_NAME,
    chant: "the agent's `relayKeyEnv`, and the pipeline jobs' `agentFacts.relayKeyEnv`",
    also: ["agent.apply-failed.relay_key_secret", "agent.verify-failed.relay_key_secret"],
    products: [],
  },
  {
    key: "control.repo",
    concept: "the control repository told after each apply on merge",
    section: "agents",
    value: "host/owner/name or a URL",
    chant: "the `<product>-applied` dispatch",
    products: ["terragucci", "plywood"],
  },
  {
    key: "runner",
    concept: "the runner every job runs on, or one per stage word",
    section: "jobs",
    value: "a label, a list of labels, a runner group, or a map of `default` and the stage words",
    chant: "a wave's `runner`",
    also: ["environments.<name>.runner"],
    products: ["terragucci"],
    aliases: [{ product: "plywood", key: "runners" }],
  },
  {
    key: "image",
    concept: "the image every job runs in",
    section: "jobs",
    value: "an image reference, or a map with `name`",
    chant: "the jobs' container",
    products: ["terragucci", "plywood", "sql-yodeler"],
  },
] satisfies ProductConfigWord[]);

/** The words for a release through the environments: the subcommands and flags a product's bin passes to `chant components`. */
export const PRODUCT_RELEASE_WORDS = /* @__PURE__ */ Object.freeze({
  /** `<product> promote --to <env> [--release <label>]`: `chant components promote`. */
  promote: "promote",
  /** `<product> reject <op> <gate> --plan <digest> --reason <text>`: `chant reject` (#5354), the release turned down at a stage's gate. */
  reject: "reject",
  /** Why a release is rejected, on one line (#5354), and why a pause, a resume or an urgent promote was made (#5355). */
  reason: "--reason",
  /** `<product> rollback <env> --release <label>`: `chant components rollback`, the environment positional. */
  rollback: "rollback",
  /** `<product> redeploy <env>`: `chant components redeploy`. */
  redeploy: "redeploy",
  /** The environment a promote deploys to. */
  to: "--to",
  /** The environment a promote reads from; default the step before `--to` in `promotion`. */
  from: "--from",
  /** A release's label or digest. */
  release: "--release",
  /** Lets a promote skip an environment of `promotion`. */
  allowSkip: "--allow-skip",
  /** Prints the plan and changes nothing. */
  dryRun: "--dry-run",
  /** `<product> pause <env> --reason <text>`: `chant stage pause` (#5355). */
  pause: "pause",
  /** `<product> resume <env> --reason <text>`: `chant stage resume` (#5355). */
  resume: "resume",
  /** Lets a promote pass the stage's gate on its urgent rule (#5355). */
  urgent: "--urgent",
} as const);

/** Release command spellings a product accepts beside {@link PRODUCT_RELEASE_WORDS}: `rollback --env <env>` for the positional. */
export const PRODUCT_RELEASE_ALIASES: readonly { product: string; command: string; alias: string; word: string }[] = /* @__PURE__ */ Object.freeze([
  { product: "plywood", command: "rollback", alias: "--env <env>", word: "<env> (the positional, with --release)" },
]);

/**
 * The kinds of an audit line, in the words a person reads: the event that
 * happened, each with the spellings a product wrote for it. The gate ledger's
 * entries (`GATE_AUDIT_KINDS`) are the first eight; `refused` and `recorded`
 * hold a product's own records. The report store's audit line
 * (`@intentius/chant/report-store`, #5336) takes its `kind` from here.
 */
export const PRODUCT_AUDIT_KINDS: Readonly<Record<string, readonly string[]>> = /* @__PURE__ */ Object.freeze({
  /** A plan reached its gate and waits for an approval. */
  "approval-requested": [],
  /** An approval of a plan's digest; terragucci writes `approval`. */
  approved: ["approval"],
  /** An approval or an override a commit removed from the ledger; terragucci writes `approval-revoked` and `override-revoked`. */
  revoked: ["approval-revoked", "override-revoked"],
  /** A policy denial that waits for an override. */
  "override-requested": [],
  /** An override of a denial; terragucci and sql-yodeler write `override`. */
  "override-recorded": ["override"],
  /** An override an apply cited. */
  "override-spent": [],
  /** A wave's apply, whichever way it ended (`result` says); terragucci writes `apply`. */
  applied: ["apply"],
  /** An apply the gate or a check refused. */
  refused: [],
  /** A hook's outcome at a wave. */
  hook: [],
  /** Any other event a product records from its own records, named in the line's `product_kind`. */
  recorded: [],
});

/** One finding of {@link productConfigProblems}. */
export interface ProductConfigProblem {
  level: "error" | "warning";
  /** Where in the config, dotted, as the product spells it. */
  path: string;
  /** The vocabulary key the finding is about. */
  key: string;
  message: string;
}

export interface ProductConfigOptions {
  /** The product whose aliases are accepted. */
  product: string;
  /** How the product spells keys. Default `snake`. */
  case?: ProductConfigCase;
  /** Maps the vocabulary's keys may also sit under, such as sql-yodeler's `ci`. The top level is always read, and aliases are read there alone. */
  scopes?: readonly string[];
}

/** One segment in the product's case: `not_author` → `notAuthor` under camelCase. */
function spell(segment: string, kase: ProductConfigCase): string {
  if (kase === "snake" || segment.startsWith("<")) return segment;
  return segment.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function segments(key: string, kase: ProductConfigCase): string[] {
  const out: string[] = [];
  for (const raw of key.split(".")) {
    if (raw.endsWith("[]")) {
      out.push(spell(raw.slice(0, -2), kase), "[]");
    } else {
      out.push(spell(raw, kase));
    }
  }
  return out;
}

function isMap(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every concrete path a key pattern reaches in `doc`, with its value. */
function resolve(doc: unknown, parts: readonly string[], at: string[] = []): { path: string; value: unknown }[] {
  if (parts.length === 0) return [{ path: at.join("."), value: doc }];
  const [head, ...rest] = parts;
  if (head === "[]") {
    if (!Array.isArray(doc)) return [];
    return doc.flatMap((item, i) => resolve(item, rest, [...at.slice(0, -1), `${at[at.length - 1] ?? ""}[${i}]`]));
  }
  if (!isMap(doc)) return [];
  if (head.startsWith("<")) return Object.entries(doc).flatMap(([k, v]) => resolve(v, rest, [...at, k]));
  if (!Object.prototype.hasOwnProperty.call(doc, head)) return [];
  return resolve(doc[head], rest, [...at, head]);
}

function hasShape(value: unknown, shape: ProductConfigAliasShape | undefined): boolean {
  switch (shape) {
    case undefined:
      return value !== undefined;
    case "string":
      return typeof value === "string";
    case "map":
      return isMap(value);
    case "list-or-map":
      return Array.isArray(value) || isMap(value);
    case "storage-url":
      return typeof value === "string" && new RegExp(STORAGE_URL).test(value);
    case "forge-environments":
      return isMap(value) && Object.values(value).every((v) => typeof v === "string" || (isMap(v) && typeof v.name === "string"));
  }
}

function spelled(key: string, kase: ProductConfigCase): string {
  return segments(key, kase)
    .join(".")
    .replace(/\.\[\]/g, "[]");
}

/**
 * Checks a product's config against the vocabulary: each alias the product
 * accepts is a warning naming the vocabulary key, an alias set beside its key
 * is an error, and a value outside a key's words or pattern is an error.
 * Keys the vocabulary does not hold are the product's own and are not read.
 * `promotion` is checked as a list of distinct environment names, each one a
 * key of `environments` when the config has that map.
 */
export function productConfigProblems(config: unknown, options: ProductConfigOptions): ProductConfigProblem[] {
  const kase = options.case ?? "snake";
  const out: ProductConfigProblem[] = [];
  if (!isMap(config)) return out;
  const roots: { prefix: string; doc: unknown }[] = [{ prefix: "", doc: config }];
  for (const scope of options.scopes ?? []) {
    const doc = config[scope];
    if (isMap(doc)) roots.push({ prefix: `${scope}.`, doc });
  }
  for (const { prefix, doc } of roots) {
    const at = (p: string) => `${prefix}${p}`;
    // The paths an alias of this product reads, so the key it shares a
    // spelling with (plywood's storage `reports.url`) does not judge them.
    const aliased = new Set<string>();
    for (const word of PRODUCT_CONFIG_WORDS) {
      const shown = spelled(word.key, kase);
      for (const alias of word.aliases ?? []) {
        // An alias names its full path, so it is read from the top level alone.
        if (prefix !== "" || alias.product !== options.product || alias.key === undefined) continue;
        for (const hit of resolve(doc, segments(alias.key, kase))) {
          if (!hasShape(hit.value, alias.shape)) continue;
          aliased.add(hit.path);
          out.push({ level: "warning", path: at(hit.path), key: word.key, message: `is accepted as ${shown}, the vocabulary's key` });
          // The key set beside its alias, where the alias does not sit inside
          // it (plywood's `notify.slack.webhook` sits inside `notify.slack`).
          if (!alias.key.includes("<") && resolve(doc, segments(word.key, kase)).some((h) => !hit.path.startsWith(`${h.path}.`))) {
            out.push({ level: "error", path: at(hit.path), key: word.key, message: `and ${shown} are both set; set ${shown} alone` });
          }
        }
      }
    }
    for (const word of PRODUCT_CONFIG_WORDS) {
      const shown = spelled(word.key, kase);
      const valueAliases = new Map((word.aliases ?? []).flatMap((a) => (a.product === options.product && a.value ? [a.value] : [])));
      for (const key of [word.key, ...(word.also ?? [])]) {
        for (const hit of resolve(doc, segments(key, kase))) {
          if (aliased.has(hit.path)) continue;
          const items = Array.isArray(hit.value) && word.values ? hit.value : [hit.value];
          for (const item of items) {
            if (typeof item !== "string") continue;
            const accepted = valueAliases.get(item);
            if (accepted !== undefined) {
              out.push({ level: "warning", path: at(hit.path), key: word.key, message: `${item} is accepted as ${accepted}, the vocabulary's word` });
            } else if (word.values && !word.values.includes(item)) {
              out.push({ level: "error", path: at(hit.path), key: word.key, message: `is ${item}; ${shown} takes ${word.values.join(", ")}` });
            } else if (word.pattern && !word.values && !new RegExp(word.pattern).test(item)) {
              out.push({ level: "error", path: at(hit.path), key: word.key, message: `is ${item}; ${shown} is ${word.value ?? (word.pattern === SECRET_NAME ? "a secret or variable name" : `a value matching ${word.pattern}`)}` });
            }
          }
        }
      }
    }
    out.push(...promotionProblems(doc, prefix));
  }
  return out;
}

function promotionProblems(doc: unknown, prefix: string): ProductConfigProblem[] {
  if (!isMap(doc) || doc.promotion === undefined) return [];
  const path = `${prefix}promotion`;
  const problem = (message: string): ProductConfigProblem => ({ level: "error", path, key: "promotion", message });
  const order = doc.promotion;
  if (!Array.isArray(order) || order.length === 0 || !order.every((n) => typeof n === "string" && n.trim() !== "")) {
    return [problem("is a list of environment names, first to last")];
  }
  const out: ProductConfigProblem[] = [];
  const seen = new Set<string>();
  for (const name of order as string[]) {
    if (/[*?[\]{}]/.test(name)) out.push(problem(`names ${name}, a pattern; each step is one environment`));
    if (seen.has(name)) out.push(problem(`names ${name} twice; an environment is one step`));
    seen.add(name);
  }
  const envs = doc.environments;
  if (isMap(envs) && !hasShape(envs, "forge-environments")) {
    for (const name of seen) if (!(name in envs)) out.push(problem(`names ${name}, which environments does not declare`));
  }
  return out;
}

/** The vocabulary's word for `key` (snake_case notation), or undefined. */
export function productConfigWord(key: string): ProductConfigWord | undefined {
  return PRODUCT_CONFIG_WORDS.find((w) => w.key === key);
}
