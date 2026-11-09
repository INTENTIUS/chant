/**
 * A product's plan note (#4810): the pull-request note for a product whose
 * plan job does not run chant's pr loop, rendered from a report the product
 * builds from its own plan run, in the product's words.
 *
 * terragucci plans each root itself and writes its own report, so it has no
 * `PrReport` for `renderPrNote` (./pr-loop.ts). It hands chant a
 * {@link PrPlanNote} instead: the note's rows by unit (a root, or an
 * instance of one root), the totals in the binary's own counting, the named
 * destroys, replacements, refusals, imports and forgets, each group with the
 * diff of its first unit, each unit's whole plan, the wave table and the
 * waves marker, the policy overrides and warnings, the deferred units, the
 * previewed waves and the units planned on another's planned outputs, the
 * report links, and the lines and sections only the product knows about
 * (its notices, a cost table, a blast radius). chant lays them out, links
 * them into the report, and cuts the note to the forge's limit: whole plans
 * go first, then group diffs shrink to attribute names, whichever saves the
 * most first, then blocks drop from the end, and a Cut line names what went.
 *
 * The pr loop's bundle (pr-loop-bundle.test.ts) does not carry this module,
 * so a product's sections do not grow it. {@link renderPrNote} here takes
 * either report and renders a `PrReport` with the pr loop's own renderer,
 * so a plywood or sql-yodeler note is byte for byte what it was.
 */

import { renderPrNote as renderPrLoopNote, type PrReport } from "./pr-loop";
import { GITHUB_COMMENT_LIMIT } from "./plan-summary";
import { activeProductWords, approveLine, overrideLine, type CiProductWords } from "./ci-product-words";

/** The first chant with the product plan note (#4810). */
export const PR_PLAN_NOTE_FLOOR = "0.124.78";

/** The read contract a {@link PrPlanNote} follows. */
export const PR_PLAN_NOTE_CONTRACT = 1;

/**
 * The file a product's plan verb writes its plan note hand-off to (#4799),
 * beside where `pr-plan` writes `pr-plan.json`: chant's plan-note job posts
 * it with `pr-post`.
 */
export const PR_PLAN_NOTE_FILE = "pr-plan-note.json";

/**
 * A product's plan note, handed from its plan job to chant's plan-note job
 * (#4799). `pr-post` checks `pr`, `head`, `env` and `member` against its own
 * flags, renders `note` with the pipeline's note words, and sets the plan
 * status to `state` with `description`, or to failure when the plan job
 * failed. Everything in it is read as data: it was written by the change's
 * code.
 */
export interface PrPlanNoteHandoff {
  kind: "plan-note-handoff";
  contract: typeof PR_PLAN_NOTE_CONTRACT;
  pr: number;
  /** The commit planned: the same as `note.head`. */
  head: string;
  env: string;
  /** The target (an environment, a member) the note is for, as `pr-post --member` names it. */
  member?: string;
  state: "success" | "failure" | "pending";
  description: string;
  note: PrPlanNote;
}

/** The hand-off for `note` (#4799), as a product's plan verb writes it to {@link PR_PLAN_NOTE_FILE}. */
export function planNoteHandoff(note: PrPlanNote, at: { pr: number; env: string; member?: string; state: PrPlanNoteHandoff["state"]; description: string }): PrPlanNoteHandoff {
  return { kind: "plan-note-handoff", contract: PR_PLAN_NOTE_CONTRACT, pr: at.pr, head: note.head, env: at.env, ...(at.member !== undefined ? { member: at.member } : {}), state: at.state, description: at.description, note };
}

/** One change line of a group, as chant's plan summary groups them. */
export interface PrPlanNoteChange {
  line: string;
  count: number;
  differsFrom?: string;
  differsIn?: string[];
}

/** A group of units with the same change. */
export interface PrPlanNoteGroup {
  id: string;
  units: string[];
  /** The one resource an instance group is of. */
  resource?: string;
  outlier?: boolean;
  noChanges?: boolean;
  /** The group whose change this one adds to; `changes` are then what it adds. */
  extends?: string;
  /** Every change of the group is one on every run: the note shows its attribute names alone. */
  recurring?: boolean;
  /** The group's change lines (or what it adds to `extends`). */
  changes: PrPlanNoteChange[];
  /** The plan text of the group's first unit, as the binary printed it: the note shows it as a `diff` block. */
  diff?: { unit: string; lines: string[] };
  /** Where values differ between the group's units, as `address.path`. */
  varies?: string[];
}

/** A destroy, replacement, refusal, import or forget, kept when the note is cut. */
export interface PrPlanNoteNamed {
  /** The unit it is in (a root). */
  member: string;
  address?: string;
  deposed?: string;
  action: "delete" | "replace" | "refused" | "import" | "forget";
  /** The word the note shows for the action. Default: destroy, replace, refused to plan, import, forget. */
  word?: string;
  /** The attribute paths that forced a replacement, each joined with `.`. */
  forcedBy?: string[];
  reason?: string;
}

/** A wave's row. A plan names each wave's review digest; an apply names its set digest and approval. */
export interface PrPlanNoteWave {
  number: number;
  /** How many units it holds. */
  units: number;
  composed?: boolean;
  /** The environments its units are in. Set on every wave when the table shows the column. */
  environments?: string[];
  /** The digest an approval of the wave binds. Present (even null) on any wave puts the table in review form. */
  digest?: string | null;
  /** Whether the gate will hold it for an approval. */
  waits?: boolean;
  /** The waves it plans again after. */
  replansAfter?: number[];
  /** Units whose plan reads a value unknown at plan time, which holds it. */
  unknownBy?: string[];
  /** Units whose hook asks for an approval. */
  heldByHooks?: string[];
  /** What the policy said of the wave: held by its rules, or allowed unattended by them. */
  policy?: { outcome: "held" | "unattended" | string; rules: string[] };
  /** The approval rules at base, each with what it asks for in words. */
  approvalRules?: { units: string[]; asks: string }[];
  /** An apply's set digest and approval, in the other form of the table. */
  setDigest?: string;
  approval?: string;
}

/** A denial a listed approver may override, or the override that stands. */
export interface PrPlanNoteOverride {
  member: string;
  /** The rules the override names, else those that denied. */
  rules: string[];
  override?: { by: string; at: string; sealed?: boolean; plan: string; reason: string };
  /** Who may override it; an empty list names nobody. */
  overriders: string[];
}

/** A line under the counts that may link into the report. */
export interface PrPlanNoteFact {
  text: string;
  /** Linked to the report's anchor when the note links report.html itself; else `plain`, or the text alone. */
  link?: { text: string; anchor: string; plain?: string };
  after?: string;
}

/**
 * What a product hands chant for its plan note: everything the note shows,
 * built from the product's own plan run.
 */
export interface PrPlanNote {
  kind: "plan-note";
  contract: typeof PR_PLAN_NOTE_CONTRACT;
  /** The stage as the heading names it, such as `tf-plan`. */
  stage: string;
  /** A plan of a pull request (not an apply or a drift check). */
  planning?: boolean;
  wave?: number;
  /** The commit planned. */
  head: string;
  /** `instance`: the units are instances of one root. Default: the product's noun. */
  unit?: "member" | "instance";
  units: number;
  /** The run's total in the binary's own counting: a replacement adds one and destroys one. */
  totals?: { add: number; change: number; destroy: number; forget: number; members: number };
  /** The change reaches no unit, so nothing was planned. */
  nothing?: boolean;
  /** Lines about the pipeline itself, such as overdue drift checks. */
  notices?: string[];
  /** The product's lines under them: tips, binaries, cost, the slowest resources. */
  facts?: PrPlanNoteFact[];
  named: PrPlanNoteNamed[];
  overrides?: PrPlanNoteOverride[];
  warnings?: { member: string; text: string }[];
  deferred?: { unit: string; after: string[]; why: string; previewed?: boolean }[];
  waves: PrPlanNoteWave[];
  /** What the waves marker carries beside the waves. */
  previews?: unknown[];
  /** Waves planned at their gate against the preview a pull request showed. */
  previewed?: { wave: number; pullRequest: number | string; units: number; moved: { unit: string; differences: string[] }[] }[];
  /** Units planned on another unit's planned outputs. */
  linked?: { member: string; upstream: string; composed?: boolean; unknown?: string[] }[];
  /** The product's own blocks: `start` before the named changes, `groups` before the groups, `end` after them. Each text as it is shown. */
  sections?: { at: "start" | "groups" | "end"; text: string }[];
  groups: PrPlanNoteGroup[];
  /** Each unit's whole plan, collapsed: its text, its totals line, and its plan file beside the report or at a link. */
  plans?: { member: string; text: string; totals?: string; file?: string; url?: string }[];
  /**
   * Where the report is: `report`, report.html or the run's page when
   * `artifacts`; `run`, the run's page when the run keeps no report;
   * `expires`, when presigned links stop working.
   */
  links?: { report?: string; artifacts?: boolean; run?: string; expires?: string };
  /** A waiting wave's approve line and an override line ask for a signature. */
  sealed?: boolean;
}

/** The plan note's own words; every slot defaults to chant's. */
export interface PrPlanNoteWords {
  /** The note's last line. */
  footer?: string;
  /** The report page's file name. */
  page?: string;
  /** The artifact the run keeps the report in. */
  artifact?: string;
  /** The line for a run that keeps no report, over `{run}`. */
  noReport?: string;
  /** The waves marker's name. Default `<product>:waves`. */
  marker?: string;
  /** The report's anchors for a unit and a group, over `{id}`. */
  anchors?: { member?: string; group?: string };
  /** The setting that names who may override a denial. */
  overrideKey?: string;
  /** The setting that holds the approval rules. */
  approvalRulesKey?: string;
  /** The stage that applies the plan. */
  applyStage?: string;
  /** The file each unit's plan is kept in. */
  planFile?: string;
  /** The op an override is recorded under. */
  overrideOp?: string;
}

const NOTE_WORDS: Required<Omit<PrPlanNoteWords, "marker">> = {
  footer: "",
  page: "report.html",
  artifact: "chant-pr",
  noReport: "Planned in [this run]({run}), which keeps no report artifact.",
  anchors: { member: "member-{id}", group: "group-{id}" },
  overrideKey: "ci.policy",
  approvalRulesKey: "approval rules",
  applyStage: "apply",
  planFile: "plan.txt",
  overrideOp: "policy-override",
};

/** Options for {@link renderPlanNote}. */
export interface PlanNoteOptions {
  /** The most characters the note may hold. Default GitHub's 65,536. */
  limit?: number;
  words?: CiProductWords;
  note?: PrPlanNoteWords;
}

/**
 * The note for either report: a `PrReport` as the pr loop renders it, or a
 * product's {@link PrPlanNote}.
 */
export function renderPrNote(report: PrReport | PrPlanNote, options: NonNullable<Parameters<typeof renderPrLoopNote>[1]> & { note?: PrPlanNoteWords } = {}): string {
  return isPlanNote(report) ? renderPlanNote(report, options) : renderPrLoopNote(report, options);
}

/** Whether `report` is a product's plan note. */
export function isPlanNote(report: unknown): report is PrPlanNote {
  return typeof report === "object" && report !== null && (report as { kind?: unknown }).kind === "plan-note";
}

const code = (s: string): string => "`" + s.replaceAll("`", "'") + "`";
const codePoints = (s: string): number => [...s].length;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const joinAnd = (xs: readonly string[]): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const esc = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const oneLine = (s: string): string => s.split(/\s+/).join(" ");
/** A time as the note shows it: `2026-10-15 10:03 UTC`. */
const utc = (iso: string): string => iso.replace("T", " ").replace(/:\d{2}(\.\d+)?Z$/, " UTC");

/**
 * Lines as a `diff` block wants them, as Atlantis comments a plan: each
 * line's change symbol (`+`, `-`, `~`, `-/+`, `+/-`) moves to the first
 * column, so the forge colours additions and removals.
 */
export function diffLines(lines: readonly string[]): string[] {
  return lines.map((l) => l.replace(/^(\s+)(-\/\+|\+\/-|[-+~])(?= )/, "$2$1"));
}

/** A fenced `diff` block whose fence is longer than any run of backticks in the text. */
export function diffFence(lines: readonly string[]): string {
  const body = lines.join("\n");
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}diff\n${body}\n${fence}\n`;
}

/** The waves marker: an HTML comment with no `<` or `>` in its JSON, so nothing in it ends the comment. */
export function planNoteMarker(name: string, waves: { head: string; waves: { number: number; digest: string | null; waits: boolean }[]; previews?: unknown[] }): string {
  return `<!-- ${name} ${JSON.stringify(waves).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")} -->`;
}

interface Block {
  text: string;
  kind: "line" | "group" | "plan";
  units: number;
  /** A group's text with its attribute names in place of its diff. */
  short?: string;
  member?: string;
}

const ACTION_WORDS: Record<PrPlanNoteNamed["action"], string> = { delete: "destroy", replace: "replace", refused: "refused to plan", forget: "forget", import: "import" };

function changeText(l: PrPlanNoteChange): string {
  let t = l.count > 1 ? `${l.line} (x${l.count})` : l.line;
  if (l.differsFrom) t += l.differsIn?.length ? `  [differs from group ${l.differsFrom} in: ${l.differsIn.join(", ")}]` : `  [differs from group ${l.differsFrom}]`;
  return t;
}

/**
 * A product's plan note. Each group links to its anchor in the report and
 * each named change to its unit's. Destroys, replacements and refusals come
 * first and are never dropped for space before a group is. Over the limit,
 * the units' whole plans go and the groups' diffs shrink to their attribute
 * names, whichever saves the most first; then blocks are dropped, whole,
 * from the end. A Cut line names what went.
 */
export function renderPlanNote(report: PrPlanNote, options: PlanNoteOptions = {}): string {
  const words = options.words ?? activeProductWords();
  const w = { ...NOTE_WORDS, ...options.note, anchors: { ...NOTE_WORDS.anchors, ...options.note?.anchors } };
  const markerName = options.note?.marker ?? `${words.product}:waves`;
  const [one, many] = words.noun;
  const links = report.links ?? {};
  const url = links.report ?? (links.run ? undefined : w.page);
  const artifacts = links.artifacts === true;
  const linkable = url !== undefined && !artifacts;
  const to = (text: string, anchor?: string): string => (url === undefined ? text : `[${text}](${url}${anchor && !artifacts ? `#${anchor}` : ""})`);
  const memberLink = (m: string): string => to(code(m), w.anchors.member!.replace("{id}", m));
  const until = links.expires ? ` The links to the bucket work until ${utc(links.expires)}.` : "";
  const full = url === undefined
    ? w.noReport.replace("{run}", links.run ?? "")
    : artifacts ? `The full report is \`${w.page}\` in the \`${w.artifact}\` artifact of [this run](${url}).` : `[Full report](${url})${until}`;
  const fullReport = url === undefined ? "The full report" : artifacts ? `The full report, in the artifacts of [this run](${url}),` : `[The full report](${url})`;
  const limit = options.limit ?? GITHUB_COMMENT_LIMIT;
  const unitWord = report.unit === "instance" ? "instance" : one;
  const unitWords = report.unit === "instance" ? "instances" : many;
  const destroys = report.named.filter((n) => n.action === "delete" || n.action === "replace").length;
  const refused = report.named.filter((n) => n.action === "refused").length;
  const head: string[] = [`### ${words.product} ${report.stage}${report.wave !== undefined ? `, wave ${report.wave}` : ""}: ${code(report.head.slice(0, 12))}`, ""];
  const parts = [plural(report.groups.length, "group"), plural(destroys, "destroy or replacement", "destroys or replacements")];
  if (refused > 0) parts.push(`${refused} refused`);
  head.push(`${plural(report.units, unitWord, unitWords)}: ${parts.join(", ")}. ${full}`, "");
  const t0 = report.totals;
  if (t0 && t0.members > 0) {
    const counts = [`${t0.add} to add`, `${t0.change} to change`, `${t0.destroy} to destroy`];
    if (t0.forget > 0) counts.push(`${t0.forget} to forget`);
    head.push(`${counts.join(", ")} across ${plural(t0.members, one, many)}`, "");
  }
  if (report.nothing) head.push(`This change reaches no ${one}, so nothing was planned.`, "");
  for (const n of report.notices ?? []) head.push(`> ${n}`, "");
  for (const f of report.facts ?? []) {
    const link = f.link ? (linkable ? `[${f.link.text}](${url}#${f.link.anchor})` : (f.link.plain ?? f.link.text)) : "";
    head.push(`${f.text}${link}${f.after ?? ""}`, "");
  }

  const blocks: Block[] = [];
  const line = (text: string): void => void blocks.push({ kind: "line", units: 0, text });
  const sections = (at: "start" | "groups" | "end"): void => {
    for (const s of report.sections ?? []) if (s.at === at) line(s.text);
  };
  sections("start");
  if (report.named.length > 0) {
    line(`**Destroys, replacements, refusals, imports and forgets (${report.named.length}):**\n\n`);
    for (const n of report.named) {
      const what = n.address ? `${n.member}: ${n.address}${n.deposed !== undefined ? ` (deposed ${n.deposed})` : ""}` : n.member;
      const forced = n.forcedBy?.length ? `, forced by ${n.forcedBy.map(code).join(", ")}` : "";
      const reason = n.reason ? `: ${oneLine(n.reason)}` : "";
      line(`- ${to(code(what), w.anchors.member!.replace("{id}", n.member))} (${n.word ?? ACTION_WORDS[n.action]}${forced})${reason}\n`);
    }
    line("\n");
  }
  const overrides = report.overrides ?? [];
  if (overrides.length > 0) {
    let t = `**Policy overrides (${overrides.filter((r) => r.override).length} of ${overrides.length} denied):**\n\n`;
    for (const r of overrides) {
      const o = r.override;
      const rules = r.rules.map(code).join(", ") || "its rules";
      t += o
        ? `- ${memberLink(r.member)}: ${rules} overridden by ${o.by} at ${o.at}${o.sealed ? ", sealed" : ""}, for plan ${code(o.plan)}: ${oneLine(o.reason)}${report.planning ? `. ${w.applyStage} applies this plan; this run still fails it` : ""}\n`
        : r.overriders.length === 0
          ? `- ${memberLink(r.member)}: denied by ${rules}. ${w.overrideKey} names nobody who may override it\n`
          : `- ${memberLink(r.member)}: denied by ${rules}. ${r.overriders.join(", ")} may override it once a ${w.applyStage} wave records the denial: ${code(overrideLine(words, { op: w.overrideOp, target: r.member, rules: r.rules, sign: report.sealed === true }))}\n`;
    }
    line(t + "\n");
  }
  const warnings = report.warnings ?? [];
  if (warnings.length > 0) {
    let t = `**Policy warnings (${warnings.length}), which fail nothing:**\n\n`;
    for (const x of warnings) t += `- ${memberLink(x.member)}: ${oneLine(x.text)}\n`;
    line(t + "\n");
  }
  if (report.deferred?.length) {
    let t = `**Planned once what they wait for applies (${report.deferred.length}):**\n\n`;
    for (const d of report.deferred) t += `- ${code(d.unit)}${d.after.length ? ` after ${d.after.map(code).join(", ")}` : ""}: ${d.why}${d.previewed ? " (previewed)" : ""}\n`;
    line(t + "\n");
  }
  const envs = report.waves.some((x) => x.environments !== undefined);
  const envHead = envs ? " Environments |" : "";
  const envRule = envs ? "---|" : "";
  const envCell = (x: PrPlanNoteWave): string => (envs ? ` ${x.environments?.length ? x.environments.join(", ") : "none"} |` : "");
  const Units = capital(many);
  if (report.waves.some((x) => x.digest !== undefined)) {
    let t = `| Wave | ${Units} |${envHead} Digest of its changes | When it applies |\n|---|---|${envRule}---|---|\n`;
    for (const x of report.waves) {
      const again = x.replansAfter?.length ? `plans again once wave ${x.replansAfter.join(", ")} applies, then ` : "";
      const approve = (digest: string): string => approveLine(words, { op: words.op ?? "", gate: words.gateName.replace("{gate}", words.prGate).replace("{k}", String(x.number)), digest, sign: report.sealed === true });
      const when = again
        ? `${again}${x.waits ? "waits for an approval of that plan" : "applies"}`
        : x.waits && x.digest ? `waits for an approval: ${code(approve(x.digest))}` : x.waits ? "waits for an approval" : "applies";
      const unknownBy = x.unknownBy ?? [];
      const policyRules = (x.policy?.rules ?? []).map(code).join(", ");
      const by = x.waits && unknownBy.length
        ? ` (since ${joinAnd(unknownBy.map(code))} ${unknownBy.length === 1 ? "reads" : "read"} a value unknown at plan time)`
        : x.waits && x.heldByHooks?.length ? ` (a hook of ${x.heldByHooks.map(code).join(", ")} asks for one)`
        : x.waits && x.policy?.outcome === "held" ? ` (held by ${policyRules})`
        : x.policy?.outcome === "unattended" ? (x.waits ? ` (the policy allows it unattended, ${policyRules}, and something else holds it)` : ` without an approval: allowed unattended by ${policyRules}`) : "";
      const rules = x.waits && x.approvalRules?.length ? `; ${w.approvalRulesKey}: ${x.approvalRules.map((r) => `${r.units.map(code).join(", ")} ${r.asks}`).join("; ")}` : "";
      t += `| ${x.number} | ${x.units}${x.composed ? ", composed" : ""} |${envCell(x)} ${x.digest ? code(x.digest) : x.replansAfter?.length ? "after the re-plan" : "no change"} | ${when}${by}${rules} |\n`;
    }
    line(t + "\n");
    const previews = report.previews ?? [];
    head.push(planNoteMarker(markerName, { head: report.head, waves: report.waves.map((x) => ({ number: x.number, digest: x.digest ?? null, waits: x.waits === true })), ...(previews.length ? { previews } : {}) }), "");
  } else if (report.waves.length > 0) {
    let t = `| Wave | ${Units} |${envHead} Set digest | Approval |\n|---|---|${envRule}---|---|\n`;
    for (const x of report.waves) t += `| ${x.number} | ${x.units}${x.composed ? ", composed" : ""} |${envCell(x)} ${x.replansAfter?.length ? `none yet: it plans again once wave ${x.replansAfter.join(", ")} applies` : x.setDigest ? code(x.setDigest.slice(0, 19)) : "none"} | ${x.approval ?? ""} |\n`;
    line(t + "\n");
  }
  for (const p of report.previewed ?? []) {
    const moved = p.moved.filter((u) => u.differences.length);
    let t = moved.length
      ? `**Wave ${p.wave} plans differently from the preview in pull request ${p.pullRequest} (${moved.length} of ${p.units}):**\n\n`
      : `**Wave ${p.wave} plans as pull request ${p.pullRequest} previewed it (${plural(p.units, unitWord, unitWords)}).**\n\n`;
    for (const u of moved) for (const d of u.differences) t += `- ${memberLink(u.unit)}: ${d}\n`;
    line(t + "\n");
  }
  const linked = report.linked ?? [];
  if (linked.length > 0) {
    let t = `**Planned on the planned outputs of another ${one} (${linked.length}):**\n\n`;
    for (const x of linked) t += `- ${memberLink(x.member)} reads ${code(x.upstream)}${x.composed ? ", in the composed run" : ""}${x.unknown?.length ? `; ${x.unknown.map(code).join(", ")} known once it applies` : ""}\n`;
    line(t + "\n");
  }
  sections("groups");
  for (const g of report.groups) {
    let title = `${to(`Group ${g.id}`, w.anchors.group!.replace("{id}", g.id))}: ${plural(g.units.length, unitWord, unitWords)}`;
    if (g.resource) title += ` of ${code(g.resource)}`;
    if (g.outlier) title += " (outlier)";
    title += g.noChanges ? ", no changes" : g.extends ? `, group ${g.extends}'s change plus` : g.units.length > 1 ? ", identical change" : ", change";
    if (g.recurring) title += ", on every run";
    const heading = `#### ${title}\n\n`;
    const names = g.changes.length > 0 ? "```\n" + g.changes.map(changeText).join("\n") + "\n```\n\n" : "";
    const shown = g.units.slice(0, 20).map(code).join(", ");
    const members = `${capital(unitWords)}: ${shown}${g.units.length > 20 ? `, and ${g.units.length - 20} more in the report` : ""}\n\n`;
    const diff = g.noChanges || g.recurring ? undefined : g.diff;
    if (!diff) {
      blocks.push({ kind: "group", units: g.units.length, text: heading + names + members });
      continue;
    }
    let t = heading;
    if (g.units.length > 1) t += `As ${code(diff.unit)} plans it:\n\n`;
    t += diffFence(diffLines(diff.lines)) + "\n";
    const differs = g.changes.filter((l) => l.differsFrom);
    for (const l of differs) t += `- ${code(l.line)} differs from group ${l.differsFrom}${l.differsIn?.length ? ` in ${l.differsIn.map(code).join(", ")}` : ""}.\n`;
    const varies = g.varies ?? [];
    if (varies.length > 0) t += `${differs.length > 0 ? "- " : ""}Values differ between its ${unitWords} in ${varies.map(code).join(", ")}.\n`;
    if (differs.length > 0 || varies.length > 0) t += "\n";
    blocks.push({ kind: "group", units: g.units.length, text: t + members, short: heading + names + members });
  }
  sections("end");
  // A unit's plan file: the link given for it, else beside the report page when the note links the page itself.
  const planLink = (member: string): string | undefined => {
    const p = report.plans?.find((x) => x.member === member);
    if (p?.url) return p.url;
    if (!linkable || !p?.file) return undefined;
    const bare = url.split("#")[0]!;
    if (bare.includes("?") || !(bare === w.page || bare.endsWith(`/${w.page}`))) return undefined;
    return bare.slice(0, bare.length - w.page.length) + p.file.split("/").map(encodeURIComponent).join("/");
  };
  let first = true;
  for (const p of report.plans ?? []) {
    const link = planLink(p.member);
    let t = first ? `**Each ${one}'s plan:**\n\n` : "";
    first = false;
    t += `<details><summary><code>${esc(p.member)}</code>${p.totals ? `: ${esc(p.totals)}` : ""}</summary>\n\n`;
    t += diffFence(diffLines(p.text.replace(/\r\n/g, "\n").replace(/^(\s*\n)+/, "").replace(/\s+$/, "").split("\n"))) + "\n";
    if (link) t += `[${w.planFile}](${link})\n\n`;
    t += "</details>\n\n";
    blocks.push({ kind: "plan", units: 0, member: p.member, text: t });
  }
  const top = head.join("\n") + "\n";
  const foot = w.footer ? `\n${w.footer}\n` : "";
  const all = top + blocks.map((b) => b.text).join("") + foot;
  if (codePoints(all) <= limit) return all;

  const cut = { plans: [] as string[], diffs: 0, groups: 0, units: 0, lines: 0 };
  const notice = (): string => {
    const out: string[] = [];
    if (cut.plans.length > 0) {
      const named = cut.plans.slice(0, 20).map((m) => {
        const link = planLink(m);
        return link ? `[${code(m)}](${link})` : code(m);
      });
      const more = cut.plans.length - named.length;
      out.push(`the whole plans of ${plural(cut.plans.length, one, many)} (${named.join(", ")}${more > 0 ? `, and ${more} more` : ""})`);
    }
    if (cut.groups > 0) out.push(`${plural(cut.groups, "group")} (${plural(cut.units, unitWord, unitWords)})`);
    if (cut.lines > 0) out.push(plural(cut.lines, "line"));
    const clauses: string[] = [];
    if (out.length > 0) clauses.push(`leaves out ${joinAnd(out)}`);
    if (cut.diffs > 0) clauses.push(`shows ${cut.diffs === 1 ? "one group" : `${cut.diffs} groups`} by attribute name, without the diff`);
    return `**Cut:** this note ${clauses.join(" and ")}, to stay within ${limit} characters. ${fullReport} has all of it${report.plans !== undefined ? `, and each ${one}'s ${w.planFile} the whole plan` : ""}.\n`;
  };
  const size = (b: Block): number => codePoints(b.text);
  let used = codePoints(all);
  const over = (): boolean => used + codePoints(notice()) > limit;
  // Whole plans and group diffs, whichever saves the most first: a whole plan before a diff that saves as much, the later of two alike first.
  const candidates = blocks
    .map((b, i) => ({ i, plan: b.kind === "plan", saves: b.kind === "plan" ? size(b) : b.short !== undefined ? size(b) - codePoints(b.short) : 0 }))
    .filter((c) => c.saves > 0)
    .sort((a, b) => b.saves - a.saves || Number(b.plan) - Number(a.plan) || b.i - a.i);
  const gone = new Set<number>();
  for (const c of candidates) {
    if (!over()) break;
    const b = blocks[c.i]!;
    if (c.plan) {
      used -= size(b);
      gone.add(c.i);
    } else {
      used += codePoints(b.short!) - size(b);
      b.text = b.short!;
      b.short = undefined;
      cut.diffs++;
    }
  }
  cut.plans.push(...blocks.filter((_, i) => gone.has(i)).map((b) => b.member!));
  for (let i = blocks.length - 1; i >= 0; i--) if (gone.has(i)) blocks.splice(i, 1);
  // Then whole blocks from the end: groups, and last the destroys.
  while (blocks.length > 0 && over()) {
    const b = blocks.pop()!;
    used -= size(b);
    if (b.kind === "group") {
      cut.groups++;
      cut.units += b.units;
    } else if (b.kind === "plan") cut.plans.unshift(b.member!);
    else cut.lines++;
  }
  return top + blocks.map((b) => b.text).join("") + notice() + foot;
}
