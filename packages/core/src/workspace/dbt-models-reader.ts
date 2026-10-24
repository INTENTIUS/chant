/**
 * A dbt project's models as outputs (#3935), read beside its sources by the
 * `dbt-project` reader.
 *
 * A model exposes `<schema>.<model>` and, for each column its YAML lists,
 * `<schema>.<model>.<column>`, named by the contract of #3931: names as
 * declared, Postgres case folding, never rendered per target. As with
 * sources, nothing runs: dbt, Jinja and `profiles.yml` stay unread.
 *
 * - A model is a `.sql` file under the project's `model-paths`. Its name is
 *   the file's name, or its `alias`. Python models, seeds and snapshots are
 *   not read.
 * - `enabled`, `schema` and `alias` come from the first of: the model's own
 *   `{{ config(...) }}`, the `config:` of its entry in a model YAML, then the
 *   `+` keys of `dbt_project.yml` that match the model's path (the project's
 *   name, each directory under the model path, the model's name), the
 *   deepest first.
 * - The schema is the member's `modelSchema` field when it is set, and
 *   dbt's config is then not read for it. Otherwise it is the schema dbt
 *   config names, but dbt's default `generate_schema_name` joins the target's
 *   schema to a custom one (`<target_schema>_<custom>`), and a model with no
 *   custom schema lands in the target's schema, so the name depends on the
 *   target. The model is then a gap that says to set `modelSchema`. The
 *   exception is a project whose `generate_schema_name` macro is the usual
 *   override (the custom schema as it stands, the target's schema when there
 *   is none): a model with a custom schema is named by it. Any other
 *   override is not evaluated, and every model is a gap.
 * - A templated schema, alias or `enabled`, or one that is not a plain
 *   string, is a gap; chant never renders it.
 */

import { posix } from "node:path";
import { parseYAMLDocument } from "../yaml";
import type { KindReadOutput, KindLinkRead, KindReaderInput } from "./kind-link-readers";
import {
  isObject,
  isTemplated,
  keyLine,
  lines,
  nameLine,
  scalar,
  yamlFiles,
  type Dialect,
  type Quoting,
} from "./dbt-project-common";
import { joinPath, skippedDir, type WorkspaceTree } from "./tree";

export interface DbtModelsContext {
  input: KindReaderInput;
  project: Record<string, unknown>;
  projectFile: string;
  /** The tree-relative model paths, already checked. */
  paths: string[];
  quoting: Quoting;
  dialect: Dialect;
  result: KindLinkRead;
}

/** A config value found for a model: what it says, or that it can't be read. */
type Setting = { status: "unset" } | { status: "value"; value: unknown; at: string } | { status: "dynamic"; at: string; text: string };

interface ModelConfig {
  schema: Setting;
  alias: Setting;
  enabled: Setting;
}

const KEYS = ["schema", "alias", "enabled"] as const;
type Key = (typeof KEYS)[number];

export function readDbtModels(ctx: DbtModelsContext): void {
  const { input, project, projectFile, paths, quoting, dialect, result } = ctx;
  const { tree, dir, fields } = input;
  const gaps = result.gaps;
  const outputs: KindReadOutput[] = (result.outputs ??= []);
  const modelSchema = typeof fields?.modelSchema === "string" && fields.modelSchema !== "" ? fields.modelSchema : null;
  const name = (v: string, quoted: boolean) => (dialect === "postgres" && !quoted ? v.toLowerCase() : v);

  const projectName = scalar(project.name);
  const macro = modelSchema === null ? schemaMacro(tree, dir, project) : { kind: "default" as const };

  // Model YAML: config and columns, by model name.
  const yamlModels = new Map<string, { config: Record<string, unknown>; columns: { name: string; quote: boolean; line: number; file: string }[]; file: string }>();
  for (const p of paths) {
    for (const file of yamlFiles(tree, p)) {
      let text: string;
      let doc: unknown;
      try {
        text = tree.read(file);
        doc = parseYAMLDocument(text);
      } catch (err) {
        // The sources pass reports an unreadable file, as a gap that leaves outputs out.
        void err;
        continue;
      }
      if (!isObject(doc) || !Array.isArray(doc.models)) continue;
      const fileLines = lines(text);
      let cursor = keyLine(fileLines, "models");
      for (const entry of doc.models) {
        if (!isObject(entry)) continue;
        const modelName = scalar(entry.name);
        cursor = nameLine(fileLines, modelName, cursor);
        if (modelName === undefined) continue;
        const cols: { name: string; quote: boolean; line: number; file: string }[] = [];
        let columnCursor = cursor;
        for (const column of Array.isArray(entry.columns) ? entry.columns : []) {
          if (!isObject(column)) continue;
          const columnName = scalar(column.name);
          columnCursor = nameLine(fileLines, columnName, columnCursor);
          if (columnName === undefined || isTemplated(columnName)) {
            gaps.push({ file, line: columnCursor, message: `model ${modelName}: column ${JSON.stringify(column.name)} is a Jinja template or not a name, which chant does not render; it was not read`, outputs: true });
            continue;
          }
          cols.push({ name: columnName, quote: column.quote === true, line: columnCursor, file });
        }
        const config = isObject(entry.config) ? { ...entry.config } : {};
        yamlModels.set(modelName, { config, columns: cols, file });
      }
    }
  }

  const seen = new Set<string>();
  for (const p of paths) {
    for (const file of sqlFiles(tree, p)) {
      const modelName = posix.basename(file).replace(/\.sql$/, "");
      if (seen.has(modelName)) continue;
      seen.add(modelName);
      const text = tree.read(file);
      const inline = readInlineConfig(text);
      const yaml = yamlModels.get(modelName);
      const rel = posix.relative(p || ".", posix.dirname(file));
      const segments = [...(rel === "" || rel === "." ? [] : rel.split("/")), modelName];
      const fromProject = projectName ? projectConfig(project.models, projectName, segments) : {};
      const config: ModelConfig = {
        schema: pick(inline.schema, setting(yaml?.config.schema, `config of ${modelName} in ${yaml?.file}`), setting(fromProject.schema, `+schema in ${projectFile}`)),
        alias: pick(inline.alias, setting(yaml?.config.alias, `config of ${modelName} in ${yaml?.file}`), setting(fromProject.alias, `+alias in ${projectFile}`)),
        enabled: pick(inline.enabled, setting(yaml?.config.enabled, `config of ${modelName} in ${yaml?.file}`), setting(fromProject.enabled, `+enabled in ${projectFile}`)),
      };
      const line = inline.line;
      const gap = (message: string) => gaps.push({ file, line, message: `model ${modelName}: ${message}`, outputs: true });

      const enabled = config.enabled;
      if (enabled.status === "dynamic") {
        gap(`enabled is ${enabled.text} (${enabled.at}), which chant does not render; the model was not read`);
        continue;
      }
      if (enabled.status === "value" && enabled.value === false) continue;
      if (enabled.status === "value" && enabled.value !== true) {
        gap(`enabled is ${JSON.stringify(enabled.value)} (${enabled.at}), not true or false; the model was not read`);
        continue;
      }

      // The model's name: its alias, or the file's.
      let relation = modelName;
      if (config.alias.status === "dynamic") {
        gap(`alias ${config.alias.text} (${config.alias.at}) is a Jinja template or not a name, which chant does not render; the model was not read`);
        continue;
      }
      if (config.alias.status === "value") {
        const alias = scalar(config.alias.value);
        if (alias === undefined || alias === "" || isTemplated(alias)) {
          gap(`alias ${JSON.stringify(config.alias.value)} (${config.alias.at}) is a Jinja template or not a name, which chant does not render; the model was not read`);
          continue;
        }
        relation = alias;
      }

      // The schema it lands in.
      let schema: string;
      if (modelSchema !== null) {
        schema = modelSchema;
      } else {
        const resolved = modelSchemaFromConfig(config.schema, macro);
        if (typeof resolved !== "string") {
          gap(`${resolved.message}; set modelSchema on the dbt member to name the schema its models land in`);
          continue;
        }
        schema = resolved;
      }

      const model = `${name(schema, quoting.schema)}.${name(relation, quoting.identifier)}`;
      outputs.push({ name: model, file, line });
      for (const column of yaml?.columns ?? []) outputs.push({ name: `${model}.${name(column.name, column.quote)}`, file: column.file, line: column.line });
    }
  }
}

/** The schema config names, or why that does not give a name. */
function modelSchemaFromConfig(schema: Setting, macro: SchemaMacro): string | { message: string } {
  if (schema.status === "dynamic") return { message: `schema ${schema.text} (${schema.at}) is a Jinja template, which chant does not render for a target` };
  if (macro.kind === "other") return { message: `the project overrides generate_schema_name (${macro.file}:${macro.line}), which chant does not evaluate, so it cannot tell which schema the model lands in` };
  if (schema.status === "unset") return { message: "it sets no schema, so it lands in the target's schema, which profiles.yml names and chant does not read" };
  const custom = scalar(schema.value);
  if (custom === undefined || custom === "" || isTemplated(custom)) return { message: `schema ${JSON.stringify(schema.value)} (${schema.at}) is a Jinja template or not a name, which chant does not render` };
  if (macro.kind === "custom-as-is") return custom;
  return { message: `schema ${JSON.stringify(custom)} (${schema.at}) is joined to the target's schema by dbt's default generate_schema_name (<target_schema>_${custom}), so the name depends on the target` };
}

type SchemaMacro = { kind: "default" } | { kind: "custom-as-is" } | { kind: "other"; file: string; line: number };

/**
 * Whether the project overrides `generate_schema_name`, in a `.sql` file under
 * `macro-paths` (`macros` by default). The usual override returns the custom
 * schema as it stands: with the tags removed, its body is the target's schema
 * and `{{ custom_schema_name | trim }}`, one per branch of an `is none` test.
 * Any other body is not evaluated.
 */
function schemaMacro(tree: WorkspaceTree, dir: string, project: Record<string, unknown>): SchemaMacro {
  const raw = project["macro-paths"] ?? ["macros"];
  if (!Array.isArray(raw)) return { kind: "default" };
  let found: SchemaMacro = { kind: "default" };
  for (const p of raw) {
    if (typeof p !== "string" || isTemplated(p) || posix.isAbsolute(p)) continue;
    const at = posix.normalize(joinPath(dir, p));
    if (at === ".." || at.startsWith("../")) continue;
    for (const file of sqlFiles(tree, at === "." ? "" : at)) {
      let text: string;
      try {
        text = tree.read(file);
      } catch {
        continue;
      }
      const start = /\{%-?\s*macro\s+generate_schema_name\s*\(/.exec(text);
      if (!start) continue;
      const line = text.slice(0, start.index).split("\n").length;
      const end = /\{%-?\s*endmacro\s*-?%\}/.exec(text.slice(start.index));
      const body = text.slice(start.index + start[0].length, end ? start.index + end.index : undefined);
      const afterSignature = body.slice(body.indexOf("%}") + 2);
      const flat = afterSignature.replace(/\{%[\s\S]*?%\}/g, "").replace(/\s+/g, "");
      const asIs = /^\{\{(?:target\.schema|default_schema)\}\}\{\{custom_schema_name\|trim\}\}$/.test(flat) && /custom_schema_name(?:is|==)none/.test(afterSignature.replace(/\s+/g, ""));
      found = asIs ? { kind: "custom-as-is" } : { kind: "other", file, line };
    }
  }
  return found;
}

/** `.sql` files under tree-relative directory `dir`, skipping dot directories and node_modules; sorted. */
function sqlFiles(tree: WorkspaceTree, dir: string): string[] {
  if (dir !== "" && tree.stat(dir) !== "dir") return [];
  const out: string[] = [];
  const walk = (at: string) => {
    for (const e of tree.list(at) ?? []) {
      const path = joinPath(at, e.name);
      if (e.type === "dir") {
        if (!skippedDir(e.name)) walk(path);
      } else if (/\.sql$/.test(e.name)) {
        out.push(path);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** The first setting that is set: the model's own, then its YAML's, then the project's. */
function pick(...settings: Setting[]): Setting {
  return settings.find((s) => s.status !== "unset") ?? { status: "unset" };
}

function setting(value: unknown, at: string): Setting {
  if (value === undefined || value === null) return { status: "unset" };
  if (typeof value === "string" && isTemplated(value)) return { status: "dynamic", at, text: JSON.stringify(value) };
  return { status: "value", value, at };
}

const PROJECT_KEYS = new Set<string>(KEYS);

/** The configs `dbt_project.yml` sets for a model: the project's block, then each directory down to the model's name; deeper wins. */
function projectConfig(models: unknown, projectName: string, segments: string[]): Partial<Record<Key, unknown>> {
  const out: Partial<Record<Key, unknown>> = {};
  if (!isObject(models)) return out;
  let node: unknown = models[projectName];
  const take = (n: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(n)) {
      if (k.startsWith("+") && PROJECT_KEYS.has(k.slice(1))) out[k.slice(1) as Key] = v;
      else if (PROJECT_KEYS.has(k) && !isObject(v)) out[k as Key] = v;
    }
  };
  if (!isObject(node)) return out;
  take(node);
  for (const seg of segments) {
    node = node[seg];
    if (!isObject(node)) break;
    take(node);
  }
  return out;
}

/** What a model's own `{{ config(...) }}` calls set, and the line of the first one (1 when none). */
function readInlineConfig(text: string): ModelConfig & { line: number } {
  const out: ModelConfig & { line: number } = { schema: { status: "unset" }, alias: { status: "unset" }, enabled: { status: "unset" }, line: 1 };
  // Comments are blanked, not removed, so lines stay where they were.
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  const code = text.replace(/\{#[\s\S]*?#\}/g, blank).replace(/--[^\n]*/g, blank);
  const open = /\{\{-?\s*config\s*\(/g;
  let first = true;
  for (let m = open.exec(code); m; m = open.exec(code)) {
    const args = balanced(code, open.lastIndex);
    if (args === undefined) continue;
    if (first) {
      out.line = code.slice(0, m.index).split("\n").length;
      first = false;
    }
    for (const arg of splitTop(args)) {
      const kv = /^\s*([A-Za-z_]\w*)\s*=\s*([\s\S]*?)\s*$/.exec(arg);
      if (!kv || !(PROJECT_KEYS as Set<string>).has(kv[1])) continue;
      const at = "the model's config()";
      const raw = kv[2];
      const str = /^(['"])((?:(?!\1)[^\\]|\\.)*)\1$/.exec(raw);
      let s: Setting;
      if (str) s = isTemplated(str[2]) ? { status: "dynamic", at, text: raw } : { status: "value", value: str[2], at };
      else if (/^true$/i.test(raw)) s = { status: "value", value: true, at };
      else if (/^false$/i.test(raw)) s = { status: "value", value: false, at };
      else if (/^(none|null)$/i.test(raw)) s = { status: "unset" };
      else s = { status: "dynamic", at, text: raw };
      out[kv[1] as Key] = s;
    }
  }
  return out;
}

/** The text from `from` up to the parenthesis that closes the one before it, or undefined. */
function balanced(text: string, from: number): string | undefined {
  let depth = 1;
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return text.slice(from, i);
    }
  }
  return undefined;
}

/** `text` split at the commas outside quotes and brackets. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}
