import { DATABASE_ENGINES, FORMATS, TABLE_ENGINES } from "../../generated/clickhouse";
import { parseEngineSyntax } from "../../clickhouse/engine-syntax";
import { COLLECTION_ENGINES, engineCollection } from "../../clickhouse/named-collections";
import { isTrivia, tokenizeText, type Token } from "../../clickhouse/tokens";
import { checkOf, splitTop } from "./clickhouse-helpers";
import { clickhouseObjects, type OutputObject } from "./sql-helpers";

/** A syntax-line argument that holds a secret: `password`, `secret_access_key`, `account_key`, `session_token`, `oauth_token`. */
const SECRET_ARGUMENT = /password|secret|account_key|session_token|oauth_token/i;

/** A `key = value` argument or a setting that holds a secret: the above, and `kafka_sasl_password`, `nats_token`. */
const SECRET_KEY = /password|secret|account_key|session_token|oauth_token|(?:^|_)token$|private_key/i;

/** Credentials written inside another value: a URL's `user:password@`, an Azure connection string's key or signature. */
const EMBEDDED = [
  { re: /^[a-z][a-z0-9+.-]*:\/\/[^/@:\s]+:[^/@\s]+@/i, what: "a URL with a password in it" },
  { re: /(?:^|;)\s*(?:AccountKey|SharedAccessSignature)\s*=/i, what: "a connection string with an account key or signature in it" },
];

/** Compression methods the integration engines take after the format. */
const COMPRESSION = new Set(["none", "auto", "gzip", "gz", "deflate", "br", "brotli", "xz", "lzma", "zstd", "zst", "lz4", "bz2", "snappy"]);
const FORMAT_NAMES = new Set(FORMATS.map((f) => f.toLowerCase()));

/** The table functions whose arguments follow an engine's syntax line, lower case, by engine. */
const FUNCTION_ENGINE: Readonly<Record<string, string>> = {
  s3: "S3",
  gcs: "S3",
  oss: "S3",
  cosn: "S3",
  url: "URL",
  mysql: "MySQL",
  postgresql: "PostgreSQL",
  mongodb: "MongoDB",
  azureblobstorage: "AzureBlobStorage",
  iceberg: "Iceberg",
  icebergs3: "IcebergS3",
  icebergazure: "IcebergAzure",
  deltalake: "DeltaLake",
  deltalakes3: "DeltaLakeS3",
  deltalakeazure: "DeltaLakeAzure",
  hudi: "Hudi",
  paimon: "Paimon",
  paimons3: "PaimonS3",
  arrowflight: "ArrowFlight",
  ytsaurus: "YTsaurus",
};

/** `remote('addresses', db, table, 'user', 'password')`: no syntax line says it, so its password's position is written here. */
const FUNCTION_SECRETS: Readonly<Record<string, Array<{ name: string; position: number }>>> = {
  remote: [{ name: "password", position: 4 }],
  remotesecure: [{ name: "password", position: 4 }],
};

const ENGINE_SYNTAX = { ...TABLE_ENGINES, ...DATABASE_ENGINES } as Readonly<Record<string, { syntax: string } | undefined>>;

/** The secret arguments an engine's syntax line names, with their positions. */
function secretPositions(engine: string): Array<{ name: string; position: number }> {
  const syntax = ENGINE_SYNTAX[engine]?.syntax;
  const parsed = syntax ? parseEngineSyntax(syntax) : undefined;
  if (!parsed) return [];
  return parsed.args
    .filter((a) => !a.named && a.name.split("|").some((n) => SECRET_ARGUMENT.test(n)))
    .map((a) => ({ name: a.name.split("|").find((n) => SECRET_ARGUMENT.test(n))!, position: a.position }));
}

/** The text of a string literal, or undefined for anything else. */
function stringValue(text: string): string | undefined {
  const t = text.trim();
  if (!/^'(?:[^'\\]|\\.|'')*'$/.test(t)) return undefined;
  return t.slice(1, -1).replace(/\\(.)/g, "$1").replace(/''/g, "'");
}

/**
 * Whether the arguments before `position` leave it where the syntax line puts
 * it. An optional group (`[, access_key_id, secret_access_key]`) may be left
 * out, and the format and compression move up into its place:
 * `S3('url', 'Parquet', 'gzip')`. When a format, a compression method or
 * `NOSIGN` comes earlier, the position says nothing.
 */
function aligned(args: readonly string[], position: number): boolean {
  for (const a of args.slice(1, position)) {
    const t = a.trim();
    if (t.toUpperCase() === "NOSIGN") return false;
    const v = stringValue(t)?.toLowerCase();
    if (v !== undefined && (FORMAT_NAMES.has(v) || COMPRESSION.has(v))) return false;
  }
  return true;
}

interface Finding {
  where: string;
  what: string;
  masked: boolean;
}

/** The literal credentials in one engine's or table function's arguments. */
function argumentFindings(label: string, args: readonly string[], secrets: ReadonlyArray<{ name: string; position: number }>, collection: boolean): Finding[] {
  const out: Finding[] = [];
  const add = (where: string, what: string, value: string) => out.push({ where, what, masked: value === "[HIDDEN]" });
  // After a named collection, the arguments are `key = value` overrides, not positions.
  if (!collection) {
    for (const s of secrets) {
      const arg = args[s.position];
      const value = arg !== undefined ? stringValue(arg) : undefined;
      if (value && aligned(args, s.position)) add(`${label} argument ${s.name}`, "a literal credential", value);
    }
  }
  args.forEach((arg, i) => {
    const kv = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/.exec(arg);
    if (kv) {
      const value = stringValue(kv[2]!);
      if (value && SECRET_KEY.test(kv[1]!)) add(`${label} argument ${kv[1]}`, "a literal credential", value);
      return;
    }
    const value = stringValue(arg);
    if (!value) return;
    for (const e of EMBEDDED) if (e.re.test(value)) add(`${label} argument ${i + 1}`, e.what, value);
  });
  return out;
}

/** Each table function call in a SQL text, with its arguments as written. */
function functionCalls(text: string): Array<{ name: string; args: string[] }> {
  let tokens: Token[];
  try {
    tokens = tokenizeText(text, 0);
  } catch {
    return [];
  }
  const sig = tokens.map((t, i) => ({ t, i })).filter(({ t }) => !isTrivia(t));
  const out: Array<{ name: string; args: string[] }> = [];
  for (let k = 0; k + 1 < sig.length; k++) {
    const fn = sig[k]!.t;
    const open = sig[k + 1]!;
    if (fn.kind !== "ident" || open.t.kind !== "punct" || open.t.text !== "(") continue;
    const lower = fn.text.toLowerCase();
    const base = lower.endsWith("cluster") ? lower.slice(0, -"cluster".length) : lower;
    if (!(base in FUNCTION_ENGINE) && !(base in FUNCTION_SECRETS)) continue;
    let depth = 0;
    let end = open.i;
    for (let j = open.i; j < tokens.length; j++) {
      const t = tokens[j]!;
      if (t.kind === "punct" && t.text === "(") depth++;
      else if (t.kind === "punct" && t.text === ")" && --depth === 0) {
        end = j;
        break;
      }
    }
    const inner = tokens
      .slice(open.i + 1, end)
      .map((t) => t.text)
      .join("");
    out.push({ name: fn.text, args: inner.trim() === "" ? [] : splitTop(inner) });
  }
  return out;
}

/** The literal credentials in each table function call a SQL text makes. */
function callFindings(text: string): Finding[] {
  return functionCalls(text).flatMap((call) => {
    const lower = call.name.toLowerCase();
    const clustered = lower.endsWith("cluster") && !(lower in FUNCTION_ENGINE);
    const base = clustered ? lower.slice(0, -"cluster".length) : lower;
    // `s3Cluster(cluster, url, ...)`: the cluster comes first.
    const args = clustered ? call.args.slice(1) : call.args;
    const engine = FUNCTION_ENGINE[base];
    const secrets = engine ? secretPositions(engine) : (FUNCTION_SECRETS[base] ?? []);
    const collection = args[0] !== undefined && /^\s*(?:[A-Za-z_][A-Za-z0-9_]*|`[^`]+`)\s*$/.test(args[0]) && args[0].trim().toUpperCase() !== "NOSIGN";
    return argumentFindings(`${call.name}()`, args, secrets, collection);
  });
}

/** The literal credentials in a table's or database's engine and its settings. */
function engineFindings(o: OutputObject & { settings?: Record<string, string> }): Finding[] {
  const engine = o.engine;
  if (!engine) return [];
  const out = argumentFindings(`ENGINE = ${engine.name}`, engine.args ?? [], secretPositions(engine.name), engineCollection(engine) !== undefined);
  if (COLLECTION_ENGINES.has(engine.name)) {
    for (const [key, raw] of Object.entries(o.settings ?? {})) {
      const value = stringValue(raw);
      if (value && SECRET_KEY.test(key)) out.push({ where: `${engine.name} setting ${key}`, what: "a literal credential", masked: value === "[HIDDEN]" });
    }
  }
  return out;
}

/** `PASSWORD 'secret'` in a dictionary's source. */
function sourceFindings(dataSource: string): Finding[] {
  const m = /\bPASSWORD\s+('(?:[^'\\]|\\.|'')*')/i.exec(dataSource);
  const value = m ? stringValue(m[1]!) : undefined;
  return value ? [{ where: "SOURCE PASSWORD", what: "a literal credential", masked: value === "[HIDDEN]" }] : [];
}

/**
 * SQLCH128: an integration engine's or table function's argument holds a
 * literal credential (#4395): `ENGINE = S3('https://...', 'AKIA...', 'secret')`,
 * `mysql('db:3306', 'shop', 'orders', 'app', 'secret')`, a Kafka table's
 * `kafka_sasl_password` setting, a dictionary source's `PASSWORD`.
 *
 * A credential is the environment's, so it does not belong in a declaration,
 * the build output or `clickhouse.sql`, as `IDENTIFIED BY` does not on a
 * user (`../../clickhouse/access.ts`). The secret arguments are found by name
 * from each engine's syntax line in the pinned catalog (`password`,
 * `secret_access_key`, `account_key`, `session_token`, `oauth_token`), as
 * `key = value` overrides and settings by the same names, and inside a URL
 * (`user:password@`) or an Azure connection string (`AccountKey=`). The fix
 * is a named collection the environment creates, named in place of the
 * arguments: `ENGINE = S3(lake_creds, format = 'Parquet')`.
 */
export const sqlch128 = checkOf({ id: "SQLCH128", description: "An integration engine or table function argument holds a literal credential" }, (ctx, report) => {
  for (const o of clickhouseObjects(ctx)) {
    const props = o as OutputObject & { settings?: Record<string, string>; asFunction?: string; select?: string; dataSource?: string };
    const findings = [
      ...engineFindings(props),
      ...(props.asFunction ? callFindings(props.asFunction) : []),
      ...(props.select ? callFindings(props.select) : []),
      ...(props.dataSource ? sourceFindings(props.dataSource) : []),
    ];
    for (const f of findings) {
      const held = f.masked ? "holds '[HIDDEN]', the server's mask for a credential, in place of one" : `holds ${f.what}, which is the environment's`;
      report({
        severity: "error",
        message:
          `${o.export} (${o.name}): ${f.where} ${held}. ` +
          "Create a named collection with the credentials on the server and name it in place of the arguments (ENGINE = S3(lake_creds, format = 'Parquet'), s3(lake_creds), SOURCE(MYSQL(NAME mysql_creds))); chant sql plan checks that it exists",
        entity: o.export,
      });
    }
  }
});
