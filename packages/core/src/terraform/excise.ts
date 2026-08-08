/**
 * Excision of a carved resource's own `resource "<type>" "<name>"` block from
 * the surviving Terraform source (#998 — closes the "auto-excise" limitation).
 *
 * After `terraform state rm`, the block left behind would re-CREATE the
 * resource on the next apply — the one edit the bridge previously left to
 * hand-work. This removes the carve set's own blocks as part of the survivor
 * rewrite, so the one bridge `.patch` (#1589) carries the whole handoff edit.
 *
 * Pure text transform. The scanner tracks brace depth outside of strings,
 * comments, template interpolations, and heredocs — enough for real `.tf`
 * files without pulling in the wasm parser for what is a subtractive edit.
 */

export interface ExciseTarget {
  /** Terraform address, e.g. `aws_s3_bucket.assets`. */
  address: string;
  type: string;
  name: string;
}

export interface ExciseResult {
  content: string;
  /** Addresses whose block was found and removed, in file order. */
  excised: string[];
}

const HEADER = /^\s*resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/;

/**
 * Remove the targets' own `resource` blocks from one `.tf` file's text. A
 * comment line directly above a removed block stays (it may describe more
 * than the block); the blank line the removal leaves behind is collapsed.
 */
export function exciseResourceBlocks(content: string, targets: ExciseTarget[]): ExciseResult {
  if (targets.length === 0) return { content, excised: [] };
  const wanted = new Map(targets.map((t) => [`${t.type}.${t.name}`, t.address]));
  const lines = content.split("\n");
  const excised: string[] = [];
  const out: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(HEADER);
    const key = m ? `${m[1]}.${m[2]}` : undefined;
    if (!m || !wanted.has(key!)) {
      out.push(lines[i]);
      i++;
      continue;
    }

    const end = blockEnd(lines, i);
    if (end === -1) {
      // Unbalanced block — leave the file alone rather than corrupt it.
      out.push(lines[i]);
      i++;
      continue;
    }
    excised.push(wanted.get(key!)!);
    i = end + 1;
    // Swallow the separator blank line so the removal leaves no doubled gap.
    if (i < lines.length && lines[i].trim() === "") i++;
  }

  return { content: out.join("\n"), excised };
}

/** Index of the line closing the block opened on `start`, or -1 if unbalanced. */
function blockEnd(lines: string[], start: number): number {
  // Context stack: block/object braces, strings, `${` interpolations, block
  // comments. The header's `{` pushes the first "brace"; the block closes when
  // the stack empties.
  const stack: Array<"brace" | "string" | "interp" | "comment"> = [];
  let opened = false;
  let heredoc: string | null = null;

  for (let ln = start; ln < lines.length; ln++) {
    const line = lines[ln];
    if (heredoc !== null) {
      if (line.trim() === heredoc) heredoc = null;
      continue;
    }

    for (let c = 0; c < line.length; c++) {
      const top = stack[stack.length - 1];
      const ch = line[c];
      const next = line[c + 1];

      if (top === "comment") {
        if (ch === "*" && next === "/") {
          stack.pop();
          c++;
        }
        continue;
      }

      if (top === "string") {
        if (ch === "\\") {
          c++;
        } else if (ch === "$" && next === "{" && line[c - 1] !== "$") {
          stack.push("interp");
          c++;
        } else if (ch === '"') {
          stack.pop();
        }
        continue;
      }

      // Code position (top of file block, a nested brace, or inside `${...}`).
      if (ch === "#" || (ch === "/" && next === "/")) break; // line comment
      if (ch === "/" && next === "*") {
        stack.push("comment");
        c++;
        continue;
      }
      if (ch === '"') {
        stack.push("string");
        continue;
      }
      if (ch === "<" && next === "<") {
        const hd = line.slice(c).match(/^<<-?([A-Za-z_][A-Za-z0-9_-]*)/);
        if (hd) {
          heredoc = hd[1];
          break;
        }
      }
      if (ch === "{") {
        stack.push("brace");
        opened = true;
        continue;
      }
      if (ch === "}") {
        if (top === "brace" || top === "interp") stack.pop();
        if (opened && stack.length === 0) return ln;
      }
    }
  }
  return -1;
}
