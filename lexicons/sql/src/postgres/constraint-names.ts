/**
 * The names Postgres gives a constraint or an index that the DDL leaves
 * unnamed, so a reader of the declarations can spell them without a server.
 *
 * `makeObjectName` and the `Choose*Name` functions are from the Postgres
 * source (`src/backend/commands/indexcmds.c`, `src/backend/catalog/heap.c`,
 * `src/backend/commands/tablecmds.c`): the table name, then the column
 * names joined with `_`, then a label (`pkey`, `key`, `fkey`, `check`),
 * cut to 63 bytes by shortening the longer of the first two parts one
 * character at a time. A name already taken gets a number after the label
 * (`orders_pkey1`).
 *
 * A name the author writes always wins; these are for the rest. Drizzle's
 * own derived names (`orders_user_id_users_id_fk`) differ from them, which is
 * why the Drizzle export names every constraint it writes.
 */

const NAMEDATALEN = 64;

/** `makeObjectName(name1, name2, label)`: ASCII names only. */
export function makeObjectName(name1: string, name2: string | undefined, label: string | undefined): string {
  let overhead = 0;
  let n2 = 0;
  if (name2 !== undefined) {
    n2 = name2.length;
    overhead++;
  }
  if (label !== undefined) overhead += label.length + 1;
  const avail = NAMEDATALEN - 1 - overhead;
  let n1 = name1.length;
  while (n1 + n2 > avail) {
    if (n1 > n2) n1--;
    else n2--;
  }
  let name = name1.slice(0, n1);
  if (name2 !== undefined) name += `_${name2.slice(0, n2)}`;
  if (label !== undefined) name += `_${label}`;
  return name;
}

/** The first of `label`, `label1`, `label2`, ... that gives a name not in `taken`. */
export function chooseName(name1: string, name2: string | undefined, label: string, taken: ReadonlySet<string>): string {
  let pass = 0;
  let candidate = makeObjectName(name1, name2, label);
  while (taken.has(candidate)) candidate = makeObjectName(name1, name2, `${label}${++pass}`);
  return candidate;
}

/** The column names of a key or foreign key, joined as Postgres joins them. */
export const columnsAddition = (columns: readonly string[]): string => columns.join("_");

/**
 * The identifiers `expr` reads as column names: words outside quotes and
 * string literals that are not followed by `(`, and are in `columns`.
 */
export function referencedColumns(expr: string, columns: readonly string[]): string[] {
  const known = new Set(columns);
  const found = new Set<string>();
  const re = /'(?:[^']|'')*'|"((?:[^"]|"")+)"|([A-Za-z_][\w$]*)(?!\s*\()(?!\s*\.)/g;
  for (let m = re.exec(expr); m; m = re.exec(expr)) {
    const name = m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2];
    if (name !== undefined && known.has(m[1] !== undefined ? name : name.toLowerCase())) found.add(m[1] !== undefined ? name : name.toLowerCase());
  }
  return [...found];
}

/** A check constraint's default name: the column when the expression reads one, else just the table. */
export function checkName(table: string, expr: string, columns: readonly string[], taken: ReadonlySet<string>): string {
  const refs = referencedColumns(expr, columns);
  return chooseName(table, refs.length === 1 ? refs[0] : undefined, "check", taken);
}

/**
 * Words that start a function-like form with its own grammar. Postgres names
 * an index column after such a form by rules that differ from a plain call's
 * (`COALESCE(a, b)` is `coalesce`, `CAST(a AS t)` is the name of `a`), so an
 * index on one is not named here.
 */
const SPECIAL_FORMS = new Set([
  "cast", "coalesce", "collation", "current_catalog", "current_date", "current_role", "current_schema", "current_time", "current_timestamp", "current_user",
  "extract", "greatest", "json", "json_array", "json_arrayagg", "json_exists", "json_object", "json_objectagg", "json_query", "json_scalar", "json_serialize", "json_value",
  "least", "localtime", "localtimestamp", "merge_action", "normalize", "nullif", "overlay", "position", "row", "session_user", "substring", "system_user", "treat", "trim", "user",
  "xmlconcat", "xmlelement", "xmlexists", "xmlforest", "xmlparse", "xmlpi", "xmlroot", "xmlserialize",
]);
const NON_OPERATOR_WORDS = new Set(["array", "case", "cast", "collate", "exists", "select", "at", "interval", "any", "all", "some", "row", "values"]);

/**
 * The name Postgres gives an index column for an expression in `CREATE INDEX`
 * (`FigureColname`): a plain function call is its function, a bare column in
 * parentheses is the column, and an operator expression is `expr`. Undefined
 * for the forms whose name depends on grammar this does not model (a cast, a
 * `CASE`, a qualified or indexed name, a special form), where the caller should
 * ask for a name instead of guessing.
 */
export function indexExpressionColumnName(sig: ReadonlyArray<{ text: string; kind: string }>): string | undefined {
  const isWord = (t: { kind: string }) => t.kind === "ident" || t.kind === "qident";
  const fold = (t: { text: string; kind: string }) => (t.kind === "qident" ? t.text.slice(1, -1).replace(/""/g, '"') : t.text.toLowerCase());
  const closeOf = (open: number): number => {
    let depth = 0;
    for (let i = open; i < sig.length; i++) {
      if (sig[i]!.text === "(" && sig[i]!.kind === "punct") depth++;
      else if (sig[i]!.text === ")" && sig[i]!.kind === "punct" && --depth === 0) return i;
    }
    return -1;
  };
  /** The tokens after the expression are an operator class, collation or ordering: words only. */
  const onlyWords = (from: number) => sig.slice(from).every(isWord);
  const call = (list: typeof sig): string | undefined => {
    const [head, open] = list;
    if (!head || !isWord(head) || open?.text !== "(" || open.kind !== "punct") return undefined;
    const name = fold(head);
    if (head.kind === "ident" && SPECIAL_FORMS.has(name)) return undefined;
    return name;
  };
  const first = sig[0];
  if (!first) return undefined;
  const fn = call(sig);
  if (fn !== undefined) {
    const close = closeOf(1);
    return close > 0 && onlyWords(close + 1) ? fn : undefined;
  }
  if (first.text !== "(" || first.kind !== "punct") return undefined;
  const close = closeOf(0);
  if (close < 0 || !onlyWords(close + 1)) return undefined;
  const inner = sig.slice(1, close);
  if (inner.length === 1 && isWord(inner[0]!)) return fold(inner[0]!);
  const innerCall = call(inner);
  if (innerCall !== undefined) {
    const innerClose = (() => {
      let depth = 0;
      for (let i = 1; i < inner.length; i++) {
        if (inner[i]!.text === "(" && inner[i]!.kind === "punct") depth++;
        else if (inner[i]!.text === ")" && inner[i]!.kind === "punct" && --depth === 0) return i;
      }
      return -1;
    })();
    if (innerClose === inner.length - 1) return innerCall;
  } else if (inner[0] && isWord(inner[0]) && inner[0].kind === "ident" && SPECIAL_FORMS.has(inner[0].text.toLowerCase()) && inner[1]?.text === "(") return undefined;
  const risky = inner.some((t) => ((t.kind === "punct" || t.kind === "op") && (t.text.includes("::") || t.text.includes("[") || t.text === ".")) || (t.kind === "ident" && NON_OPERATOR_WORDS.has(t.text.toLowerCase())));
  return risky ? undefined : "expr";
}

/**
 * The name `CREATE INDEX ON <table> (<elements>)` is given when it names no
 * index (`ChooseIndexName`): the table, the column names joined by `_`, and
 * `idx`, with a number after the label when the schema already has that name.
 * An element is a column name, or the name of an expression
 * (`indexExpressionColumnName`); within one index a repeated column name gets
 * a number (`a`, `a1`), as Postgres does. Undefined when an element's name is
 * not known.
 */
export function deriveIndexName(table: string, elements: ReadonlyArray<string | undefined>, taken: ReadonlySet<string>): string | undefined {
  const used: string[] = [];
  for (const el of elements) {
    if (el === undefined) return undefined;
    let name = el;
    for (let i = 1; used.includes(name); i++) name = `${el}${i}`;
    used.push(name);
  }
  if (used.length === 0) return undefined;
  return chooseName(table, columnsAddition(used), "idx", taken);
}
