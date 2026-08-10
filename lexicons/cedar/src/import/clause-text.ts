/**
 * Recover the `when`/`unless` bodies of a policy exactly as they were written.
 *
 * The round-trip this lexicon promises is byte-identical `.cedar` output, and
 * the JSON leg cannot deliver it: an expression that goes to `PolicyJson` and
 * back comes out defensively parenthesized — `resource.owner == principal`
 * returns as `(resource.owner) == principal` — and `formatPolicies` does not
 * undo that. The tree is semantically lossless; the text is not preserved.
 *
 * So when there *is* source text, the condition bodies are lifted out of it
 * verbatim, and the module still decides what they mean: every body this file
 * hands back is re-parsed and compared against the tree `policyToJson` produced
 * for the same clause before the importer trusts it (see `parser.ts`). A
 * mismatch falls back to the rendered form.
 *
 * What is here is a *delimiter scanner*, not a Cedar parser. It knows three
 * things — that a `"` starts a string with backslash escapes, that `//` runs
 * to end of line, and that `@`, `(` and `{` have partners — and it knows the
 * two clause keywords. It has no opinion about expressions, which remains the
 * module's job. Anything it does not recognize returns `null`, and the caller
 * uses the rendered bodies instead.
 */

/** One `when`/`unless` clause, with its body as the author typed it. */
export interface SourceClause {
  kind: "when" | "unless";
  /** The text between the braces, trimmed. */
  body: string;
}

const WHITESPACE = /\s/;
const WORD_CHAR = /[A-Za-z0-9_]/;

class Scanner {
  private index = 0;

  constructor(private readonly text: string) {}

  atEnd(): boolean {
    return this.index >= this.text.length;
  }

  peek(): string {
    return this.text[this.index] ?? "";
  }

  /** Consume whitespace and `//` line comments. */
  skipTrivia(): void {
    while (this.index < this.text.length) {
      const ch = this.text[this.index];
      if (WHITESPACE.test(ch)) {
        this.index++;
        continue;
      }
      if (ch === "/" && this.text[this.index + 1] === "/") {
        while (this.index < this.text.length && this.text[this.index] !== "\n") this.index++;
        continue;
      }
      return;
    }
  }

  /** Consume one `[A-Za-z0-9_]+` run, or `null` if the cursor is not on one. */
  word(): string | null {
    const start = this.index;
    while (this.index < this.text.length && WORD_CHAR.test(this.text[this.index])) this.index++;
    return this.index > start ? this.text.slice(start, this.index) : null;
  }

  /** Consume the single character `ch`, reporting whether it was there. */
  expect(ch: string): boolean {
    if (this.text[this.index] !== ch) return false;
    this.index++;
    return true;
  }

  /**
   * Consume a balanced `open`…`close` run starting at the cursor and return
   * what was between them.
   *
   * Strings and line comments are skipped wholesale, so a `}` inside
   * `"}; hi {"` or behind a `//` never closes anything.
   */
  delimited(open: string, close: string): string | null {
    if (!this.expect(open)) return null;
    const start = this.index;
    let depth = 1;

    while (this.index < this.text.length) {
      const ch = this.text[this.index];

      if (ch === '"') {
        if (!this.skipString()) return null;
        continue;
      }
      if (ch === "/" && this.text[this.index + 1] === "/") {
        this.skipTrivia();
        continue;
      }
      if (ch === open) depth++;
      if (ch === close) {
        depth--;
        if (depth === 0) {
          const body = this.text.slice(start, this.index);
          this.index++;
          return body;
        }
      }
      this.index++;
    }
    return null;
  }

  /** Consume a double-quoted literal, honouring backslash escapes. */
  private skipString(): boolean {
    this.index++; // opening quote
    while (this.index < this.text.length) {
      const ch = this.text[this.index];
      if (ch === "\\") {
        this.index += 2;
        continue;
      }
      this.index++;
      if (ch === '"') return true;
    }
    return false;
  }
}

/**
 * Split one policy's source into its clause bodies.
 *
 * Returns `null` for anything that does not walk cleanly — an unbalanced
 * brace, a keyword that is neither `when` nor `unless`, trailing text after
 * the terminating `;`. `null` is not a diagnosis, only a decision to use the
 * module's rendering instead.
 */
export function extractClauses(policyText: string): SourceClause[] | null {
  const scanner = new Scanner(policyText);

  // Annotations: `@key( "value" )`, any number of them.
  scanner.skipTrivia();
  while (scanner.peek() === "@") {
    scanner.expect("@");
    if (scanner.word() === null) return null;
    scanner.skipTrivia();
    if (scanner.delimited("(", ")") === null) return null;
    scanner.skipTrivia();
  }

  const effect = scanner.word();
  if (effect !== "permit" && effect !== "forbid") return null;

  // The scope block. Its contents are of no interest here; skipping it is what
  // keeps the `(` of `@id(` from being mistaken for the scope's own.
  scanner.skipTrivia();
  if (scanner.delimited("(", ")") === null) return null;

  const clauses: SourceClause[] = [];
  for (;;) {
    scanner.skipTrivia();
    if (scanner.expect(";")) break;

    const keyword = scanner.word();
    if (keyword !== "when" && keyword !== "unless") return null;

    scanner.skipTrivia();
    const body = scanner.delimited("{", "}");
    if (body === null) return null;

    clauses.push({ kind: keyword, body: body.trim() });
  }

  scanner.skipTrivia();
  if (!scanner.atEnd()) return null;

  return clauses;
}
