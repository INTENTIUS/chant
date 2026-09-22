/**
 * The behaviour coverage page, rendered from the rows the lexicons contribute
 * (chant #2404).
 *
 * Until #2382 one lexicon held one table and generated one page from it. The
 * rows now live in the lexicon that owns each substrate, contributed through
 * the plugin's `behaviourKinds`, and core resolves them
 * (`packages/core/src/behaviour-kinds.ts`). The page went with the old
 * lexicon; the rows did not. This module renders the page from those rows
 * so a reader can answer "why is my bucket unpredicted" without reading
 * TypeScript, and `test/behaviour-coverage.test.ts` fails when the committed
 * page and the rows disagree.
 *
 * One page, a section per lexicon: an estate spans substrates, and the three
 * verdicts are the same three whichever lexicon a type belongs to. Each
 * section is rendered from that lexicon's own `BehaviourKinds` value, imported
 * from its source directly rather than through its plugin, because a plugin
 * loads its generated barrel and the rows are three small files.
 *
 * The rules a lexicon states as functions (`unmappedWhen`, `notModelledWhen`)
 * cannot be enumerated, so the page carries the sentence each rule produces
 * for a witness type, taken from the function itself. A rule that changes
 * its wording changes the page.
 *
 * Same discipline as `./egress-catalogue.ts`: one source, a committed page,
 * and a test that fails when they drift.
 */

import { awsBehaviourKinds } from "../lexicons/aws/src/behaviour-kinds";
import { k8sBehaviourKinds } from "../lexicons/k8s/src/behaviour-kinds";
import { terraformBehaviourKinds, UNMODELLED_TERRAFORM_PROVIDERS } from "../lexicons/terraform/src/behaviour/kinds";
import { byCodeUnit, unmappedDetail, type BehaviourKinds } from "../packages/core/src/behaviour-kinds";

/** One lexicon's contribution, with what the page says about where it came from. */
export interface CoverageContributor {
  /** The lexicon's package short name, as `lexicons/<name>` spells it. */
  lexicon: string;
  /** Where the rows live, relative to the repo root. */
  source: string;
  kinds: BehaviourKinds;
  /** How rows are keyed: by entity type, or by something the lexicon resolves from the entity. */
  keyedBy: string;
  /** A type that exercises `unmappedWhen`, when the lexicon has one. */
  unmappedWitness?: string;
  /** A type that exercises `notModelledWhen`'s fallback, when the lexicon has one. */
  notModelledWitness?: string;
  /** Substrate boundaries the lexicon states as a table, when it has one. */
  substrates?: ReadonlyArray<{ prefix: string; substrate: string }>;
}

/**
 * Every lexicon that contributes rows, in the order the page lists them. A
 * lexicon that starts contributing `behaviourKinds` and is not here fails
 * `test/behaviour-coverage.test.ts`, which scans the plugins.
 */
export const BEHAVIOUR_COVERAGE_CONTRIBUTORS: readonly CoverageContributor[] = [
  {
    lexicon: "aws",
    source: "lexicons/aws/src/behaviour-kinds.ts",
    kinds: awsBehaviourKinds,
    keyedBy: "the entity type, which is the CloudFormation resource type",
    unmappedWitness: "AWS::S3::Bucket.VersioningConfiguration",
  },
  {
    lexicon: "k8s",
    source: "lexicons/k8s/src/behaviour-kinds.ts",
    kinds: k8sBehaviourKinds,
    keyedBy: "the entity type, which names the API group and kind",
  },
  {
    lexicon: "terraform",
    source: "lexicons/terraform/src/behaviour/kinds.ts",
    kinds: terraformBehaviourKinds,
    keyedBy:
      "the provider type in a `resource` block's address (`aws_instance`), since every such block arrives as `Terraform::Resource`; the root's other blocks key by their entity type",
    notModelledWitness: "example_thing",
    substrates: UNMODELLED_TERRAFORM_PROVIDERS,
  },
];

/** The doc that carries the block, relative to the repo root. */
export const BEHAVIOUR_COVERAGE_DOC = "docs/src/content/docs/reference/behaviour-coverage.mdx";

// MDX parses `<` as the start of a tag, so an HTML comment fails to parse
// where this block lives. `{/* … */}` is MDX's own comment form.
export const BEHAVIOUR_COVERAGE_START = "{/* GENERATED:behaviour-coverage:start */}";
export const BEHAVIOUR_COVERAGE_END = "{/* GENERATED:behaviour-coverage:end */}";

/** Escape a table cell so a pipe in a reason never breaks the row. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** A type as a table cell, so a lookup for `` | `AWS::S3::Bucket` | `` finds exactly its row. */
function typeCell(type: string): string {
  return `\`${cell(type)}\``;
}

const byType = (a: [string, unknown], b: [string, unknown]): number => byCodeUnit(a[0], b[0]);

/** The mapped table of one contributor: what reaches an engine, and as what. */
export function renderMappedTable(contributor: CoverageContributor): string[] {
  const rows = Object.entries(contributor.kinds.mapped ?? {}).sort(byType);
  const lines = ["| Type | Engine kind | Size read from | Region |", "|---|---|---|---|"];
  for (const [type, mapping] of rows) {
    const size = mapping.sizeProp ? `\`${cell(mapping.sizeProp)}\` (${mapping.sizeType ?? "string"})` : "none";
    const region = mapping.regionProp ? `\`${cell(mapping.regionProp)}\`, else the request's` : "the request's";
    const provider = mapping.provider && mapping.provider !== contributor.kinds.provider ? ` (provider \`${cell(mapping.provider)}\`)` : "";
    lines.push(`| ${typeCell(type)} | ${mapping.kind}${provider} | ${size} | ${region} |`);
  }
  return lines;
}

/** The declared-unmapped table of one contributor: real types, no rate, and why. */
export function renderUnmappedTable(contributor: CoverageContributor): string[] {
  const rows = Object.entries(contributor.kinds.unmapped ?? {}).sort(byType);
  const lines = ["| Type | Why it carries no rate |", "|---|---|"];
  for (const [type, reason] of rows) lines.push(`| ${typeCell(type)} | ${cell(reason)} |`);
  return lines;
}

/** The sentence a rule stated as a function gives for its witness type, or `undefined` when the rule is absent. */
function ruleSentence(rule: ((type: string) => string | undefined) | undefined, witness: string | undefined): string | undefined {
  if (!rule || witness === undefined) return undefined;
  const answer = rule(witness);
  if (answer === undefined) throw new Error(`the rule gave no answer for its witness type ${witness}`);
  return answer;
}

/** One lexicon's section: a facts table, the two row tables, and a rules table for what has no row. */
export function renderContributor(contributor: CoverageContributor): string[] {
  const { kinds } = contributor;
  const lines: string[] = [];
  const prefixes = kinds.prefixes.map((p) => `\`${cell(p)}\``).join(", ");
  lines.push(`### ${contributor.lexicon}`, "");
  lines.push("| Owns | Rows keyed by | Provider | Contributed from |", "|---|---|---|---|");
  lines.push(`| ${prefixes} | ${cell(contributor.keyedBy)} | \`${cell(kinds.provider)}\` | \`${cell(contributor.source)}\` |`, "");

  if (kinds.nothingPriced) {
    lines.push(`Nothing this lexicon declares is priced: ${cell(kinds.nothingPriced)}.`, "");
    return lines;
  }

  const mapped = Object.keys(kinds.mapped ?? {}).length;
  const unmapped = Object.keys(kinds.unmapped ?? {}).length;

  lines.push(`#### Mapped (${mapped})`, "");
  lines.push(...renderMappedTable(contributor), "");

  lines.push(`#### Declared unmapped (${unmapped})`, "");
  lines.push(...renderUnmappedTable(contributor), "");

  const owned = kinds.prefixes.map((p) => `\`${cell(p)}\``).join(" or ");
  lines.push("| A type with no row above | Verdict | What the `unpredicted` entry says |", "|---|---|---|");
  const late = ruleSentence(kinds.unmappedWhen, contributor.unmappedWitness);
  if (late !== undefined) {
    lines.push(`| \`${cell(contributor.unmappedWitness ?? "")}\`, by rule | declared unmapped | ${cell(late)} |`);
  }
  for (const { prefix, substrate } of contributor.substrates ?? []) {
    lines.push(`| ${typeCell(prefix)} | provider-not-modelled | ${cell(substrate)} |`);
  }
  const fallback = ruleSentence(kinds.notModelledWhen, contributor.notModelledWitness);
  if (fallback !== undefined) {
    lines.push(
      `| any other prefix, for example \`${cell(contributor.notModelledWitness ?? "")}\` | provider-not-modelled | ${cell(fallback)} |`,
    );
  }
  lines.push(
    `| any other ${owned} type | unknown-type, the one verdict that is a defect | ${cell(unmappedDetail("the entity", { status: "unknown-type" }, kinds))} |`,
    "",
  );
  return lines;
}

/** The whole marker-delimited block: a section per contributing lexicon. */
export function renderBehaviourCoverageBlock(): string {
  const lines: string[] = [BEHAVIOUR_COVERAGE_START, ""];
  for (const contributor of BEHAVIOUR_COVERAGE_CONTRIBUTORS) lines.push(...renderContributor(contributor));
  const mapped = BEHAVIOUR_COVERAGE_CONTRIBUTORS.reduce((n, c) => n + Object.keys(c.kinds.mapped ?? {}).length, 0);
  const unmapped = BEHAVIOUR_COVERAGE_CONTRIBUTORS.reduce((n, c) => n + Object.keys(c.kinds.unmapped ?? {}).length, 0);
  lines.push(
    `**${mapped} mapped and ${unmapped} declared unmapped** across ${BEHAVIOUR_COVERAGE_CONTRIBUTORS.length} lexicons. Any lexicon not listed here contributes no rows, so its types are \`unknown-type\` until it does.`,
  );
  lines.push("", BEHAVIOUR_COVERAGE_END);
  return lines.join("\n");
}

/** Extract the current marker-delimited block (markers included) from a doc's raw text. */
export function extractBehaviourCoverageBlock(doc: string): string {
  const start = doc.indexOf(BEHAVIOUR_COVERAGE_START);
  const end = doc.indexOf(BEHAVIOUR_COVERAGE_END);
  if (start === -1 || end === -1) {
    throw new Error(
      `behaviour-coverage markers not found — expected both "${BEHAVIOUR_COVERAGE_START}" and "${BEHAVIOUR_COVERAGE_END}" in the doc`,
    );
  }
  return doc.slice(start, end + BEHAVIOUR_COVERAGE_END.length);
}

/** Replace the marker-delimited block in `doc` with a freshly rendered one. */
export function replaceBehaviourCoverageBlock(doc: string): string {
  return doc.replace(extractBehaviourCoverageBlock(doc), renderBehaviourCoverageBlock());
}
