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
