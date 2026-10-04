/**
 * The pin edit for hand-written HCL (#3189): move one module's pin from an old
 * version to a new one in a `.tf` file or a `terragrunt.hcl`, and leave every
 * other byte of the file as it was.
 *
 * Three steps, each one a check on the last:
 *
 * 1. The HCL reader (`@cdktn/hcl2json`, the parser the rest of this lexicon
 *    reads `.tf` with) parses the file. Its tree says which calls exist and
 *    what each one's `source` and `version` are: `module "<name>"` blocks in a
 *    `.tf`, and the `terraform` block's `source` in a `terragrunt.hcl`.
 * 2. `./source.ts` decides, per call, whether it names the module and how its
 *    pin moves. `./scan.ts` finds the byte offsets of the literal to rewrite,
 *    and its unescaped content has to equal the value the reader returned, or
 *    the call is refused rather than guessed at.
 * 3. The edited text is parsed again. Its tree has to equal the first tree
 *    with only the moved values changed. Anything else throws, and nothing is
 *    written.
 *
 * The parser is passed in rather than imported. It is a 1.8 MB wasm package
 * that core loads lazily (`loadHcl2json`), and a caller that bundles this
 * module (terragucci's `tf-rollout` stage, #3421) decides how it is loaded.
 */

import type { Hcl2Json } from "@intentius/chant/terraform/hcl2json";
import { movePin, type PinMove } from "./source";
import { escapeHcl, scanBlocks, unescapeHcl, type ScannedAttribute, type ScannedBlock } from "./scan";

/** What to move: a module, named by its source without the pin, from one pin to another. */
export interface PinRequest {
  module: string;
  from: string;
  to: string;
}

/** One module call the edit looked at, and what happened to it. */
export type PinCallResult = PinMove & {
  /** The file, as the caller named it. */
  file: string;
  /** `module.<name>` in a `.tf`, `terraform` in a `terragrunt.hcl`, or `line <n>` in TypeScript source. */
  call: string;
};

/** The edited text and every call that names the module. */
export interface PinEditResult {
  content: string;
  calls: PinCallResult[];
}

/** Whether a file is read as a Terragrunt configuration rather than a `.tf` file. */
export function isTerragruntFile(file: string): boolean {
  return file === "terragrunt.hcl" || file.endsWith("/terragrunt.hcl");
}

type Tree = Record<string, unknown>;

interface Site {
  call: string;
  block: ScannedBlock;
  /** The reader's body for this call, which the verification re-reads. */
  body: Record<string, unknown>;
}

function attr(block: ScannedBlock, name: string): ScannedAttribute | undefined {
  return block.attributes.find((a) => a.name === name);
}

/** Pair each call in the reader's tree with the block the scanner found for it. */
function sites(tree: Tree, blocks: ScannedBlock[], terragrunt: boolean): Site[] {
  const out: Site[] = [];
  if (terragrunt) {
    const bodies = (tree.terraform as Record<string, unknown>[] | undefined) ?? [];
    const scanned = blocks.filter((b) => b.type === "terraform" && b.labels.length === 0);
    bodies.forEach((body, k) => {
      if (scanned[k]) out.push({ call: "terraform", block: scanned[k]!, body });
    });
    return out;
  }
  const modules = (tree.module as Record<string, Record<string, unknown>[]> | undefined) ?? {};
  for (const [name, bodies] of Object.entries(modules)) {
    const scanned = blocks.filter((b) => b.type === "module" && b.labels.length === 1 && b.labels[0] === name);
    bodies.forEach((body, k) => {
      if (scanned[k]) out.push({ call: `module.${name}`, block: scanned[k]!, body });
    });
  }
  return out.sort((a, b) => a.block.start - b.block.start);
}

/** Pin edits are applied back to front, so earlier offsets stay valid. */
interface Splice {
  start: number;
  end: number;
  text: string;
}

/**
 * Move `request.module`'s pin in one file. Calls that name another module are
 * left alone and not reported. A call that names the module and cannot move
 * is reported with its reason and left as it was.
 */
export async function editPins(text: string, file: string, request: PinRequest, parser: Hcl2Json): Promise<PinEditResult> {
  const terragrunt = isTerragruntFile(file);
  const tree = (await parser.parse(file, text)) as Tree;
  const blocks = scanBlocks(text, file);
  const calls: PinCallResult[] = [];
  const splices: Splice[] = [];
  const expected = structuredClone(tree);
  const expectedSites = sites(expected, scanBlocks(text, file), terragrunt);

  sites(tree, blocks, terragrunt).forEach((site, index) => {
    const source = site.body.source;
    const version = site.body.version;
    if (typeof source !== "string") return;
    const move = movePin(source, typeof version === "string" ? version : undefined, request);
    if (!move) return;
    const at = { file, call: site.call };
    if (move.outcome !== "moved") {
      calls.push({ ...move, ...at });
      return;
    }
    const edits: Array<[name: "source" | "version", value: string]> = [];
    if (move.source !== source) edits.push(["source", move.source]);
    if (move.version !== undefined && move.version !== version) edits.push(["version", move.version]);
    for (const [name] of edits) {
      const scanned = attr(site.block, name);
      const was = site.body[name] as string;
      if (!scanned?.literal || unescapeHcl(scanned.literal.raw) !== was) {
        calls.push({ outcome: "refused", reason: `${name} is not a plain string literal, so there is no one place to write the pin`, ...at });
        return;
      }
    }
    for (const [name, value] of edits) {
      const literal = attr(site.block, name)!.literal!;
      splices.push({ start: literal.start, end: literal.end, text: rewriteLiteral(literal.raw, site.body[name] as string, value) });
      expectedSites[index]!.body[name] = value;
    }
    calls.push({ ...move, ...at });
  });

  let content = text;
  for (const s of splices.sort((a, b) => b.start - a.start)) content = content.slice(0, s.start) + s.text + content.slice(s.end);
  if (splices.length > 0) {
    const reread = (await parser.parse(file, content)) as Tree;
    if (JSON.stringify(reread) !== JSON.stringify(expected)) {
      throw new Error(`${file}: the pin edit would change more than the pin, so nothing was written`);
    }
  }
  return { content, calls };
}

/**
 * The new literal content. When the old literal needed no escapes, the old
 * value's text is replaced in place, so any spacing (`= 1.3.0`) survives.
 */
function rewriteLiteral(raw: string, was: string, value: string): string {
  return raw === was ? value : escapeHcl(value);
}
