/**
 * The box checks, WSP121 and WSP122 (#2726).
 *
 * A member whose entry has a `box` block is a box, or holds a box's
 * declarations. A box holds no credential: each capability it needs outside
 * itself (inference, Fountain, a third-party API) is reached through a
 * broker, a runtime such as a lobby or a door, which holds the credential
 * and enforces the scope the block declares. chant only states and checks
 * this; it never runs a broker (ws-052).
 *
 * | Id | Code | Fails when |
 * |---|---|---|
 * | WSP121 | `box-credential-declared` | a file in the box member's directory carries a literal secret (fixed) |
 * | WSP122 | `box-capability-unbrokered` | a capability in the block names no broker |
 *
 * WSP121 reads the member's files from the tree checked, so it works under
 * `--at`, and runs no member code. A literal secret is either a value with a
 * well-known credential shape (an AWS key id, a GitHub or Slack token, an
 * `sk-` key, private key material), wherever it sits, or a literal string
 * where a credential goes: under a key named like one (`API_KEY`, `token`,
 * `credential`, `password`, ...), or the `value` of a `{ key, value }` vault
 * secret. A reference is never one: `${VAR}` and `$VAR`, a secret-manager
 * reference (`op://`, `bws://`, `infisical://`), a `{{...}}` template
 * placeholder, and any expression, such as `process.env.X`, that is not a
 * string literal. WSP121 is fixed: a credential in a box's files is in git.
 *
 * WSP123 and WSP124, box isolation (#2727), are in `./box-isolation.ts` and
 * listed here after these two.
 *
 * WSP125 (`box-fountain-callback-undeclared`, #2780) is the one credential a
 * box gets without asking. fountain v0.21.0 gives every persistent sandbox a
 * callback token scoped to its owner (`FOUNTAIN_TOKEN`, `sandbox_api_access:
 * owner`), and a fountain `Box` is always persistent, so its member's block
 * has to say so: the capability `fountain-callback`, brokered by `fountain`,
 * with scope `owner`. It is named apart from `fountain`, the API access a
 * lobby may broker for the same box. A member builds a Box when one of its TypeScript or JavaScript files
 * imports `Box` from `@intentius/chant-lexicon-fountain` and calls it, read as
 * syntax and never run. Upstream, managoat/fountain#2497 asks for a way to run
 * a persistent agent with no callback token.
 *
 * WSP126 (`box-intent-unknown`) and WSP127 (`box-intent-unconstrained`), #2850,
 * read the decision record a box block names as its intent (`box-intent.ts`).
 * WSP126 fails when no record of a declared kind named decision has the id.
 * WSP127 warns when the record's constrains names no member or path of this
 * workspace at all: no `member:` entry for a declared member and no `path:`
 * entry at, above or inside one's directory. It need not reach the box's own
 * member: the decision an intent names can constrain the member whose app the
 * box runs, on a workspace where the box block sits on a different member,
 * the box's steward (studio's template, #2857). Both read the working
 * tree's records, so neither runs under `--at`.
 */

import * as ts from "typescript";
import type { WorkspaceCheck, WorkspaceCheckContext, WorkspaceDiagnostic } from "../checks";
import type { Member } from "../declaration";
import { constrainsWorkspace } from "../box-intent";
import type { ReasonCode } from "../reason-codes";
import { joinPath, skippedDir, type WorkspaceTree } from "../tree";
import { BOX_ISOLATION_CHECKS } from "./box-isolation";

/** The read contract's codes for the box findings, carried as `code` on each. */
export const BOX_FINDING_CODES = [
  "box-credential-declared",
  "box-capability-unbrokered",
  "box-isolation-collision",
  "box-isolation-literal",
  "box-fountain-callback-undeclared",
  "box-intent-unknown",
  "box-intent-unconstrained",
] as const satisfies readonly ReasonCode[];

export const WSP_BOX_CREDENTIAL = "WSP121";
export const WSP_BOX_UNBROKERED = "WSP122";
export const WSP_BOX_FOUNTAIN_CALLBACK = "WSP125";
export const WSP_BOX_INTENT_UNKNOWN = "WSP126";
export const WSP_BOX_INTENT_UNCONSTRAINED = "WSP127";

/** The fountain lexicon's package, whose `Box` composite runs a persistent sandbox. */
const FOUNTAIN_LEXICON = "@intentius/chant-lexicon-fountain";

/**
 * The capability a box block declares for fountain's callback token (#2780).
 * The fountain lexicon exports the same value as `BOX_FOUNTAIN_CALLBACK_CAPABILITY`.
 */
export const FOUNTAIN_CALLBACK_CAPABILITY = { name: "fountain-callback", broker: "fountain", scope: ["owner"] } as const;

/** Where a file calls the fountain lexicon's `Box`, 1-based. */
export interface FountainBoxCall {
  line: number;
  column: number;
}

/**
 * The first call of the fountain lexicon's `Box` in a TypeScript or
 * JavaScript file, read as syntax and never run: `Box` imported by name
 * (aliased or not) and called, or called through a namespace import. Any
 * other `Box` is not the composite.
 */
export function fountainBoxCall(text: string, file: string, kind: ts.ScriptKind): FountainBoxCall | undefined {
  if (!text.includes(FOUNTAIN_LEXICON)) return undefined;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const names = new Set<string>();
  const namespaces = new Set<string>();
  for (const stmt of source.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const from = stmt.moduleSpecifier.text;
    if (from !== FOUNTAIN_LEXICON && !from.startsWith(`${FOUNTAIN_LEXICON}/`)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    else for (const el of bindings.elements) if ((el.propertyName ?? el.name).text === "Box") names.add(el.name.text);
  }
  if (names.size === 0 && namespaces.size === 0) return undefined;
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        (ts.isIdentifier(callee) && names.has(callee.text)) ||
        (ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "Box" &&
          ts.isIdentifier(callee.expression) &&
          namespaces.has(callee.expression.text))
      ) {
        found = node;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) return undefined;
  const { line, character } = source.getLineAndCharacterOfPosition(found.getStart(source));
  return { line: line + 1, column: character + 1 };
}

/** Values whose shape alone says they are a credential. The list FTN001 uses, plus Anthropic keys. */
export const CREDENTIAL_SHAPES: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, label: "an AWS access key id" },
  { pattern: /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}/, label: "a GitHub token" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/, label: "a GitHub fine-grained token" },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/, label: "an Anthropic API key" },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/, label: "a secret API key (sk-)" },
  { pattern: /\bftn_[A-Za-z0-9]{16,}/, label: "a Fountain API key" },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, label: "a Slack token" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: "private key material" },
];

/** Secret-manager references a value may be instead of the secret. */
export const SECRET_REFERENCE_SCHEMES = ["op://", "bws://", "infisical://"] as const;

/**
 * A key whose value is a credential: `API_KEY`, `GITHUB_TOKEN`, `apiKey`,
 * `token`, `credential`, `password`, `AWS_SECRET_ACCESS_KEY`. A key that
 * names where a secret is (`secretKey`, `TOKEN_FILE`, `tokenHash`) is not.
 */
const CREDENTIAL_KEY = /(?:^|[_-])(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY|ACCESS_?KEY)$|^(?:apiKey|token|secret|password|credentials?|privateKey|accessKey|authToken)$|[a-z](?:ApiKey|Token|Secret|Password|Credentials?|PrivateKey|AccessKey)$/i;

/** Whether `key` names a credential. Exported for tests. */
export function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY.test(key);
}

/** Whether `value` refers to a secret rather than being one. Exported for tests. */
export function isSecretReference(value: string): boolean {
  const v = value.trim();
  if (v === "") return true;
  if (v.includes("${")) return true;
  // $VAR, $1, $(command): the shell fills it in.
  if (v.startsWith("$")) return true;
  if (/^\{\{[^}]*\}\}$/.test(v)) return true;
  return SECRET_REFERENCE_SCHEMES.some((s) => v.startsWith(s));
}

/**
 * Whether a value under a credential key says where a secret is rather than
 * being one: a path (`~/box/llm-token`, `/run/secrets/token`), a URL, or an
 * environment variable's name (`GIT_TOKEN`).
 */
function namesWhereSecretIs(value: string): boolean {
  const v = value.trim();
  return /^(?:\/|~|\.\.?\/)/.test(v) || /^[a-z][a-z0-9+.-]*:\/\//i.test(v) || /^[A-Z][A-Z0-9_]*$/.test(v);
}

/** The credential shape `value` has, or undefined. */
export function credentialShape(value: string): string | undefined {
  return CREDENTIAL_SHAPES.find((s) => s.pattern.test(value))?.label;
}

/** One literal secret found in a file. */
export interface LiteralSecret {
  /** 1-based. */
  line: number;
  column: number;
  /** What was found, for the message: never the value itself. */
  what: string;
}

const CODE_EXTENSIONS: Record<string, ts.ScriptKind> = {
  ".ts": ts.ScriptKind.TS,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
  ".json": ts.ScriptKind.JSON,
  ".jsonc": ts.ScriptKind.JSON,
};

const PROSE_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".html", ".rst"]);

/** Files larger than this are not read: a box's declarations are small, and a large file is data or a build. */
const MAX_FILE_BYTES = 1024 * 1024;

function propertyName(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return undefined;
}

const isStringLiteral = (n: ts.Node): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);

/**
 * The literal secrets in a TypeScript, JavaScript or JSON file, read as
 * syntax and never run.
 */
export function literalSecretsInCode(text: string, file: string, kind: ts.ScriptKind): LiteralSecret[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const out: LiteralSecret[] = [];
  const at = (node: ts.Node, what: string) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    out.push({ line: line + 1, column: character + 1, what });
  };
  const reported = new Set<ts.Node>();
  const visit = (node: ts.Node) => {
    if (isStringLiteral(node) && !reported.has(node)) {
      const shape = credentialShape(node.text);
      if (shape && !isSecretReference(node.text)) {
        reported.add(node);
        at(node, shape);
      }
    }
    if (ts.isPropertyAssignment(node) && isStringLiteral(node.initializer) && !reported.has(node.initializer)) {
      const key = propertyName(node.name);
      const value = node.initializer.text;
      // A value with a credential's shape is reported by that shape, below.
      if (key !== undefined && !isSecretReference(value) && !namesWhereSecretIs(value) && credentialShape(value) === undefined) {
        if (isCredentialKey(key)) {
          reported.add(node.initializer);
          at(node.initializer, `a literal value for ${key}`);
        } else if (key === "value" && ts.isObjectLiteralExpression(node.parent) && isVaultSecret(node.parent)) {
          reported.add(node.initializer);
          at(node.initializer, `a literal vault secret value for ${vaultSecretKey(node.parent) ?? "a key"}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** `{ key, value }` with nothing else but a description: the shape of a vault secret. */
function isVaultSecret(obj: ts.ObjectLiteralExpression): boolean {
  const names = obj.properties.map((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) ? propertyName(p.name) : undefined));
  return names.includes("key") && names.includes("value") && names.every((n) => n === "key" || n === "value" || n === "description");
}

function vaultSecretKey(obj: ts.ObjectLiteralExpression): string | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && propertyName(p.name) === "key" && isStringLiteral(p.initializer)) return p.initializer.text;
  }
  return undefined;
}

/** `KEY=value`, `export KEY=value` or `KEY: value`, the value optionally quoted. */
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*(["']?)([^"'\s#]+)\2\s*(?:#.*)?$/;

/**
 * The literal secrets in any other text file, such as a shell script, an
 * env file or YAML: a credential shape anywhere, or a line assigning a
 * literal to a credential-named key.
 */
export function literalSecretsInText(text: string, assignments = true): LiteralSecret[] {
  const out: LiteralSecret[] = [];
  text.split(/\r?\n/).forEach((lineText, i) => {
    for (const { pattern, label } of CREDENTIAL_SHAPES) {
      const m = pattern.exec(lineText);
      if (m && !isSecretReference(m[0])) {
        out.push({ line: i + 1, column: m.index + 1, what: label });
        return;
      }
    }
    const a = assignments ? ASSIGNMENT.exec(lineText) : null;
    if (a && isCredentialKey(a[1]) && !isSecretReference(a[3]) && !namesWhereSecretIs(a[3])) {
      out.push({ line: i + 1, column: lineText.indexOf(a[3]) + 1, what: `a literal value for ${a[1]}` });
    }
  });
  return out;
}

function extension(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/** The literal secrets in one file, or none when the file is binary or too large. */
export function literalSecretsInFile(text: string, path: string): LiteralSecret[] {
  if (text.length > MAX_FILE_BYTES || text.includes("\0")) return [];
  const kind = CODE_EXTENSIONS[extension(path)];
  if (kind !== undefined) return literalSecretsInCode(text, path, kind);
  // Prose says "Token: ..." without meaning one, so only a credential's shape counts there.
  return literalSecretsInText(text, !PROSE_EXTENSIONS.has(extension(path)));
}

/** Every file under `dir` in `tree`, skipping node_modules and dot-directories, sorted. */
function filesUnder(tree: WorkspaceTree, dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of tree.list(d) ?? []) {
      const p = joinPath(d, e.name);
      if (e.type === "dir") {
        if (!skippedDir(e.name)) walk(p);
      } else out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

const boxMembers = (ctx: WorkspaceCheckContext): Member[] => ctx.declaration.members.filter((m) => m.box !== null);

export const BOX_CHECKS: readonly WorkspaceCheck[] = [
  {
    id: WSP_BOX_CREDENTIAL,
    name: "box-credential-declared",
    description:
      "A box holds no credential: no file in a box member's directory carries a literal secret, in its declarations, an env or a vault's defaults. Variable references and secret-manager references (op://, bws://, infisical://) are not secrets.",
    severity: "error",
    configurable: false,
    check(ctx) {
      const out: WorkspaceDiagnostic[] = [];
      for (const m of boxMembers(ctx)) {
        const dir = m.dir === "." ? "" : m.dir;
        if (ctx.tree.stat(dir) !== "dir") continue;
        for (const path of filesUnder(ctx.tree, dir)) {
          let text: string;
          try {
            text = ctx.tree.read(path);
          } catch {
            continue;
          }
          for (const s of literalSecretsInFile(text, path)) {
            out.push({
              checkId: this.id,
              severity: this.severity,
              code: "box-credential-declared",
              message: `box-credential-declared: ${path} holds ${s.what}, and member ${m.name} is a box, which holds no credential; replace it with a \${VAR} or secret-manager reference, or declare the capability as brokered in the member's box block`,
              entity: m.name,
              pointer: m.box!.pointer,
              treeFile: path,
              line: s.line,
              column: s.column,
            });
          }
        }
      }
      return out;
    },
  },
  {
    id: WSP_BOX_UNBROKERED,
    name: "box-capability-unbrokered",
    description: "Every capability a box declares names the broker that holds its credential and enforces its scope.",
    severity: "error",
    configurable: true,
    check(ctx) {
      const out: WorkspaceDiagnostic[] = [];
      for (const m of boxMembers(ctx)) {
        for (const c of m.box!.capabilities) {
          if (c.broker !== null) continue;
          out.push({
            checkId: this.id,
            severity: this.severity,
            code: "box-capability-unbrokered",
            message: `box-capability-unbrokered: member ${m.name}'s box needs ${c.name} and names no broker for it, so the box would hold its credential; set broker to the runtime that holds it, such as the lobby`,
            entity: m.name,
            pointer: c.pointer,
          });
        }
      }
      return out;
    },
  },
  // Box isolation (#2727), WSP123 and WSP124.
  ...BOX_ISOLATION_CHECKS,
  {
    id: WSP_BOX_FOUNTAIN_CALLBACK,
    name: "box-fountain-callback-undeclared",
    description:
      "A box member that builds a fountain Box declares the callback token fountain gives its persistent sandbox: the fountain-callback capability, brokered by fountain, with scope owner.",
    severity: "error",
    configurable: true,
    check(ctx) {
      const out: WorkspaceDiagnostic[] = [];
      const want = FOUNTAIN_CALLBACK_CAPABILITY;
      const expected = `{ "name": "${want.name}", "broker": "${want.broker}", "scope": ["${want.scope[0]}"] }`;
      for (const m of boxMembers(ctx)) {
        const dir = m.dir === "." ? "" : m.dir;
        if (ctx.tree.stat(dir) !== "dir") continue;
        let at: { path: string; call: FountainBoxCall } | undefined;
        for (const path of filesUnder(ctx.tree, dir)) {
          const kind = CODE_EXTENSIONS[extension(path)];
          if (kind === undefined || kind === ts.ScriptKind.JSON) continue;
          let text: string;
          try {
            text = ctx.tree.read(path);
          } catch {
            continue;
          }
          if (text.length > MAX_FILE_BYTES) continue;
          const call = fountainBoxCall(text, path, kind);
          if (call) {
            at = { path, call };
            break;
          }
        }
        if (!at) continue;
        const declared = m.box!.capabilities.find((c) => c.name === want.name);
        if (declared && declared.broker === want.broker && declared.scope.includes(want.scope[0])) continue;
        const why = !declared
          ? "the member's box block does not declare it"
          : declared.broker !== want.broker
            ? `the box block's ${want.name} capability names the broker ${declared.broker ?? "(none)"}, but fountain hands this token to the sandbox itself`
            : `the box block's ${want.name} capability has scope [${declared.scope.join(", ")}], not ${want.scope[0]}`;
        out.push({
          checkId: this.id,
          severity: this.severity,
          code: "box-fountain-callback-undeclared",
          message:
            `box-fountain-callback-undeclared: member ${m.name} builds a fountain Box (${at.path}), and fountain v0.21.0 gives a persistent box's sandbox ` +
            `a callback token scoped to its owner (FOUNTAIN_TOKEN); ${why}. Declare ${expected} in the box block ` +
            `(managoat/fountain#2497 tracks running without it)`,
          entity: m.name,
          pointer: declared?.pointer ?? m.box!.pointer,
          treeFile: at.path,
          line: at.call.line,
          column: at.call.column,
        });
      }
      return out;
    },
  },
  {
    id: WSP_BOX_INTENT_UNKNOWN,
    name: "box-intent-unknown",
    description: "The intent a box block names is the id of a decision record: a record of a declared kind named decision.",
    severity: "error",
    configurable: true,
    check(ctx) {
      const out: WorkspaceDiagnostic[] = [];
      for (const i of ctx.facts?.boxIntents ?? []) {
        if (i.record) continue;
        out.push({
          checkId: this.id,
          severity: this.severity,
          code: "box-intent-unknown",
          message: `box-intent-unknown: member ${i.member}'s box names the intent ${i.id}, and ${i.why}; propose the decision with chant workspace records new, or fix the id`,
          entity: i.member,
          pointer: i.pointer,
        });
      }
      return out;
    },
  },
  {
    id: WSP_BOX_INTENT_UNCONSTRAINED,
    name: "box-intent-unconstrained",
    description:
      "The decision record a box names as its intent constrains a member or path of this workspace: member:<a declared member's name>, or a path: entry at, above or inside a declared member's directory. It need not be the box's own member: a box one member runs can be what a decision about another member constrains.",
    severity: "warning",
    configurable: true,
    check(ctx) {
      const out: WorkspaceDiagnostic[] = [];
      const members = ctx.declaration.members;
      for (const i of ctx.facts?.boxIntents ?? []) {
        if (!i.record) continue;
        if (i.record.constrains.some((c) => constrainsWorkspace(c, members))) continue;
        out.push({
          checkId: this.id,
          severity: this.severity,
          code: "box-intent-unconstrained",
          message:
            `box-intent-unconstrained: member ${i.member}'s box names the intent ${i.id} (${i.record.path}), whose constrains ` +
            (i.record.constrains.length === 0 ? "is empty" : `names ${i.record.constrains.join(", ")}`) +
            `, and none of it is a member or path of this workspace; add member:<name> for the member the intent is about, or a path: entry at, above or inside a member's directory`,
          entity: i.member,
          pointer: i.pointer,
        });
      }
      return out;
    },
  },
];
