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
 * This module imports nothing: the pull request loop bundle (pr-loop.ts,
 * pr-loop-bundle.test.ts) carries it.
 */

/** The stages a product names: the status context after the prefix, and the word in the note. */
export type CiProductStage = "plan" | "apply" | "record" | "check" | "drift" | "lock" | "approval" | "control";

/** Every stage slot, in the order {@link assertProductWords} reports them. */
export const CI_PRODUCT_STAGES: readonly CiProductStage[] = ["plan", "apply", "record", "check", "drift", "lock", "approval", "control"];

/** The commands a comment may name. Each one needs a job in the pipeline that answers it. */
export type CiProductCommand = "plan" | "apply" | "lock" | "unlock" | "agent";

export const CI_PRODUCT_COMMANDS: readonly CiProductCommand[] = ["plan", "apply", "lock", "unlock", "agent"];

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
}

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
}

/** The notify slots, filled. */
export interface CiProductNotifyWords {
  source: string;
  wave: string;
  headers: string;
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
  op?: string;
  gateName: string;
  prGate: string;
  approval: CiProductApproval;
  applyMode: CiProductApplyMode;
  bin?: string;
  adoptMarkers: string[];
  notify: CiProductNotifyWords;
}

/** chant's own approve line. */
export const CHANT_APPROVE_TEMPLATE = "chant approve {op} {gate} --plan {digest} --approver {approver} {sign}";

/** chant's own override line. */
export const CHANT_OVERRIDE_TEMPLATE = 'chant approve {op} {target} --rule {rule} --reason "<why>" {sign}';

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
    },
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
  }
  for (const [where, template] of [["approve", words.approve], ["override", words.override]] as const) {
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
  | { kind: "plan"; member?: string; targets?: string[] }
  /** An apply, through wave n when the comment names `wave-<n>`. */
  | { kind: "apply"; wave?: number }
  | { kind: "lock" }
  | { kind: "unlock" }
  /** An ask for the agent: data, never split or run. */
  | { kind: "agent"; ask: string }
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
/** The longest ask an agent comment may carry. */
export const PRODUCT_COMMENT_ASK_MAX = 2000;
/** Commands a comment never runs, named in the reply so nobody waits on them. */
const NEVER = new Set(["approve", "override", "force-unlock", "unlock-state", "import", "state", "destroy", "merge"]);

/**
 * Read a comment against the product's grammar (moved from terragucci's
 * comment.ts). Undefined when it is not addressed to the product. A comment
 * that starts with `/<product>` is a command or it is refused: the whole
 * comment is the command, one line, words separated by spaces or tabs. The
 * comment is untrusted input: only a member path checked against a pattern
 * with no shell syntax, and a wave number, leave this function.
 *
 * `env` turns on an alias whose `when` variable is `1` there.
 */
export function parseProductComment(words: CiProductWords, body: unknown, env: Record<string, string | undefined> = {}): ParsedProductComment | undefined {
  if (typeof body !== "string") return undefined;
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
      reason: NEVER.has(typed) ? `a comment never runs \`${typed}\`: ${words.product} re-plans, and runs what an approval covers, on request and nothing more` : `the commands are ${known}`,
    };
  }
  const line = `\`${prefix} ${typed}\``;
  switch (command) {
    case "lock":
    case "unlock":
      return parts.length === 2 ? { kind: command } : { kind: "refused", reason: `${line} takes nothing after it` };
    case "agent": {
      const ask = text.slice(`${prefix} ${typed}`.length).trim();
      if (ask === "") return { kind: "refused", reason: `${line} needs an ask after it, on the same line` };
      if (ask.length > PRODUCT_COMMENT_ASK_MAX) return { kind: "refused", reason: `an ask is at most ${PRODUCT_COMMENT_ASK_MAX} characters` };
      if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(ask)) return { kind: "refused", reason: "an ask is plain text, with no control characters" };
      return { kind: "agent", ask };
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
      for (let i = 2; i < parts.length; i++) {
        const w = parts[i]!;
        if (w === "--target") {
          const address = parts[++i];
          if (address === undefined) return { kind: "refused", reason: `\`--target\` needs an address after it: \`${prefix} ${typed} --target <address>\`` };
          if (!TARGET.test(address)) return { kind: "refused", reason: "a target is a resource address or URN, or <member>:<address>, with no spaces or shell characters" };
          targets.push(address);
        } else if (w.startsWith("-")) return { kind: "refused", reason: `${line} takes \`--target <address>\` and no other flag` };
        else rest.push(w);
      }
      if (rest.length > 1) return { kind: "refused", reason: `${line} takes one ${words.noun[0]} at most` };
      const member = rest[0];
      const narrowed = targets.length > 0 ? { targets } : {};
      if (member === undefined) return { kind: "plan", ...narrowed };
      if (!MEMBER.test(member) || member.split("/").some((s) => s === "" || s === "." || s === "..")) return { kind: "refused", reason: `the ${words.noun[0]} is a name or a path from the repository root` };
      return { kind: "plan", member, ...narrowed };
    }
  }
}
