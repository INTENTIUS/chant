/**
 * A Prometheus Operator `AlertmanagerConfig` embedded in a k8s manifest, for
 * `chant import` (#5113).
 *
 * The k8s parser offers each of `spec.route`, `spec.receivers`,
 * `spec.inhibitRules` and `spec.muteTimeIntervals` with the whole `spec` as
 * the document. This importer reads the field in the operator's spelling
 * (`groupBy`, `slackConfigs`, matchers as `{ name, value, matchType }`) as the
 * `alertmanager.yml` fragment it says, imports that exactly as
 * `chant import alertmanager.yml` would, and the k8s value becomes a call of
 * the matching function in `@intentius/chant-lexicon-prometheus/k8s` over the
 * declarations, which writes the CRD's spelling again.
 *
 * What it does not convert stays as the CRD wrote it:
 *
 * - a route, inhibit rule or time interval that says something a declaration
 *   cannot (a matcher without `matchType`, the deprecated `regex`, a field
 *   the CRD does not have) makes the importer throw, so core keeps the whole
 *   field as written and warns, naming the reason;
 * - in a receiver, the fields of a notifier entry that are not converted (a
 *   Secret reference such as `apiURL: { name, key }`, `httpConfig`, a notifier
 *   `NOTIFIERS` does not list) are kept in a small module and passed to
 *   `alertmanagerConfigReceivers`, which puts them back beside the typed
 *   fields. A Secret reference is never read, only carried.
 */

import { exportedNames, type EmbeddedContent, type EmbeddedContentImporter, type EmbeddedImport } from "@intentius/chant/import/embedded";
import type { GeneratedFile } from "@intentius/chant/import/generator";
import { NOTIFIERS, matcherString, notifierKey, snakeCase, type FieldSpec } from "../k8s";
import type { AlertmanagerConfig } from "../model";
import { generateAlertmanager } from "./generator";

type Json = Record<string, unknown>;

const PACKAGE = "@intentius/chant-lexicon-prometheus";
const K8S_ENTRY = `${PACKAGE}/k8s`;
const HOST_TYPE = "K8s::Monitoring::AlertmanagerConfig";

/**
 * What a generated module exports its declarations in. The standalone import
 * exports each declaration, which is how `chant build` finds them. Here they
 * are one object, which it does not look inside: the declarations type the
 * AlertmanagerConfig's fields, and are not also an `alertmanager.yml` of their
 * own. Two AlertmanagerConfigs in one project would otherwise build to one
 * file with two root routes and every receiver twice.
 */
const DECLARED = "declared";

/** `export { a, b };` at the end of a generated module becomes `export const declared = { a, b };`. */
function keepDeclarationsOut(file: GeneratedFile): GeneratedFile {
  const names = exportedNames(file.content);
  const content = file.content.replace(/\n*export\s*\{[^}]*\};?\s*$/, "");
  const list = `{ ${names.join(", ")} }`;
  const one = `export const ${DECLARED} = ${list};`;
  const decl = one.length <= 100 ? one : `export const ${DECLARED} = {\n${names.map((n) => `  ${n},`).join("\n")}\n};`;
  return {
    path: file.path,
    content: `${content.replace(/\s+$/, "")}\n\n/** The declarations, in an object so a build of this project does not write them out as an alertmanager.yml of their own. */\n${decl}\n`,
  };
}

/** The spec field the k8s parser offers, the fragment of `alertmanager.yml` it is, and the function that writes it back. */
const FIELDS: Record<string, { fragment: string; through: string; shape: "single" | "list" }> = {
  route: { fragment: "route", through: "alertmanagerConfigRoute", shape: "single" },
  receivers: { fragment: "receivers", through: "alertmanagerConfigReceivers", shape: "list" },
  inhibitRules: { fragment: "inhibit_rules", through: "alertmanagerConfigInhibitRules", shape: "list" },
  muteTimeIntervals: { fragment: "time_intervals", through: "alertmanagerConfigMuteTimeIntervals", shape: "list" },
};

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

// ── the CRD to alertmanager.yml ──────────────────────────────────────

/** A CRD matcher list as Alertmanager's matcher strings. */
function matcherStrings(list: unknown, where: string): string[] {
  if (!Array.isArray(list)) throw new Error(`${where} is not a list`);
  return list.map((m, i) => {
    const text = matcherString(m);
    if (text !== undefined) return text;
    throw new Error(
      `${where}[${i}] is not a matcher a declaration can hold: it needs a name, a value and a matchType (=, !=, =~ or !~), and no other field (the deprecated regex is not carried)`,
    );
  });
}

function onlyKeys(obj: Json, allowed: readonly string[], where: string): void {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw new Error(`${where} has ${extra.join(", ")}, which a declaration cannot hold`);
}

function routeFragment(route: unknown, where: string): Json {
  if (!isObject(route)) throw new Error(`${where} is not an object`);
  onlyKeys(route, ["receiver", "groupBy", "groupWait", "groupInterval", "repeatInterval", "matchers", "continue", "muteTimeIntervals", "activeTimeIntervals", "routes"], where);
  const out: Json = {};
  const str = (key: string) => {
    if (route[key] === undefined) return;
    if (typeof route[key] !== "string") throw new Error(`${where}.${key} is not a string`);
    out[snakeCase(key)] = route[key];
  };
  const strs = (key: string) => {
    if (route[key] === undefined) return;
    if (!isStrings(route[key])) throw new Error(`${where}.${key} is not a list of strings`);
    out[snakeCase(key)] = route[key];
  };
  str("receiver");
  strs("groupBy");
  str("groupWait");
  str("groupInterval");
  str("repeatInterval");
  if (route.matchers !== undefined) out.matchers = matcherStrings(route.matchers, `${where}.matchers`);
  if (route.continue !== undefined) {
    if (typeof route.continue !== "boolean") throw new Error(`${where}.continue is not a boolean`);
    out.continue = route.continue;
  }
  strs("muteTimeIntervals");
  strs("activeTimeIntervals");
  if (route.routes !== undefined) {
    if (!Array.isArray(route.routes)) throw new Error(`${where}.routes is not a list`);
    out.routes = route.routes.map((child, i) => routeFragment(child, `${where}.routes[${i}]`));
  }
  return out;
}

function inhibitFragment(rules: unknown): Json[] {
  if (!Array.isArray(rules)) throw new Error("spec.inhibitRules is not a list");
  return rules.map((r, i) => {
    const where = `spec.inhibitRules[${i}]`;
    if (!isObject(r)) throw new Error(`${where} is not an object`);
    onlyKeys(r, ["sourceMatch", "targetMatch", "equal"], where);
    const out: Json = {};
    if (r.sourceMatch !== undefined) out.source_matchers = matcherStrings(r.sourceMatch, `${where}.sourceMatch`);
    if (r.targetMatch !== undefined) out.target_matchers = matcherStrings(r.targetMatch, `${where}.targetMatch`);
    if (r.equal !== undefined) {
      if (!isStrings(r.equal)) throw new Error(`${where}.equal is not a list of strings`);
      out.equal = r.equal;
    }
    return out;
  });
}

function dayRange(d: unknown, where: string): string {
  if (!isObject(d) || !Object.keys(d).every((k) => k === "start" || k === "end") || !Number.isInteger(d.start) || !Number.isInteger(d.end)) {
    throw new Error(`${where} is not a { start, end } pair of days`);
  }
  return `${d.start}:${d.end}`;
}

function timeIntervalFragment(intervals: unknown): Json[] {
  if (!Array.isArray(intervals)) throw new Error("spec.muteTimeIntervals is not a list");
  return intervals.map((t, i) => {
    const where = `spec.muteTimeIntervals[${i}]`;
    if (!isObject(t) || typeof t.name !== "string") throw new Error(`${where} has no name`);
    onlyKeys(t, ["name", "timeIntervals"], where);
    const periods = t.timeIntervals;
    if (!Array.isArray(periods)) throw new Error(`${where}.timeIntervals is not a list`);
    return {
      name: t.name,
      time_intervals: periods.map((p, j) => {
        const at = `${where}.timeIntervals[${j}]`;
        if (!isObject(p)) throw new Error(`${at} is not an object`);
        onlyKeys(p, ["times", "weekdays", "daysOfMonth", "months", "years"], at);
        const out: Json = {};
        if (p.times !== undefined) {
          if (!Array.isArray(p.times)) throw new Error(`${at}.times is not a list`);
          out.times = p.times.map((r, k) => {
            if (!isObject(r) || typeof r.startTime !== "string" || typeof r.endTime !== "string" || Object.keys(r).length !== 2) {
              throw new Error(`${at}.times[${k}] is not a { startTime, endTime } pair`);
            }
            return { start_time: r.startTime, end_time: r.endTime };
          });
        }
        if (p.weekdays !== undefined) out.weekdays = strings(p.weekdays, `${at}.weekdays`);
        if (p.daysOfMonth !== undefined) {
          if (!Array.isArray(p.daysOfMonth)) throw new Error(`${at}.daysOfMonth is not a list`);
          out.days_of_month = p.daysOfMonth.map((d, k) => dayRange(d, `${at}.daysOfMonth[${k}]`));
        }
        if (p.months !== undefined) out.months = strings(p.months, `${at}.months`);
        if (p.years !== undefined) out.years = strings(p.years, `${at}.years`);
        return out;
      }),
    };
  });
}

function strings(v: unknown, where: string): string[] {
  if (!isStrings(v)) throw new Error(`${where} is not a list of strings`);
  return v;
}

// ── receivers ────────────────────────────────────────────────────────

/**
 * One notifier entry split into what a declaration holds (Alertmanager's
 * names) and what stays as the CRD wrote it. A key converts when its value is
 * the plain kind the spec says; anything else is kept.
 */
function splitEntry(entry: Json, spec: FieldSpec): { typed: Json; kept: Json } {
  const typed: Json = {};
  const kept: Json = {};
  for (const [key, value] of Object.entries(entry)) {
    if (spec.plain.includes(key) && (isPlain(value) || isStrings(value))) typed[snakeCase(key)] = value;
    else if (spec.lists?.[key] && convertibleList(value, spec.lists[key])) typed[snakeCase(key)] = (value as Json[]).map((e) => snakeKeys(e));
    else if (spec.objects?.[key] && isObject(value) && convertibleObject(value, spec.objects[key])) typed[snakeCase(key)] = snakeKeys(value);
    else kept[key] = value;
  }
  return { typed, kept };
}

const isPlain = (v: unknown): boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

function convertibleObject(obj: Json, spec: FieldSpec): boolean {
  return Object.entries(obj).every(([key, value]) => {
    if (spec.plain.includes(key)) return isPlain(value) || isStrings(value);
    if (spec.lists?.[key]) return convertibleList(value, spec.lists[key]);
    if (spec.objects?.[key]) return isObject(value) && convertibleObject(value, spec.objects[key]);
    return false;
  });
}

function convertibleList(value: unknown, spec: FieldSpec): boolean {
  return Array.isArray(value) && value.every((e) => isObject(e) && convertibleObject(e, spec));
}

function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [snakeCase(k), snakeKeys(v)]));
}

interface ReceiversRead {
  receivers: Json[];
  /** By receiver name, in the CRD's shape: what the declarations do not hold. */
  kept: Record<string, Json>;
  warnings: string[];
}

function receiversFragment(receivers: unknown): ReceiversRead {
  if (!Array.isArray(receivers)) throw new Error("spec.receivers is not a list");
  const out: ReceiversRead = { receivers: [], kept: {}, warnings: [] };
  receivers.forEach((r, i) => {
    const where = `spec.receivers[${i}]`;
    if (!isObject(r) || typeof r.name !== "string") throw new Error(`${where} has no name`);
    if (r.name in out.kept || out.receivers.some((x) => x.name === r.name)) throw new Error(`${where}: the name ${JSON.stringify(r.name)} is used twice`);
    const typedReceiver: Json = { name: r.name };
    const keptReceiver: Json = {};
    for (const [key, list] of Object.entries(r)) {
      if (key === "name") continue;
      const spec = NOTIFIERS[key];
      if (spec === undefined || !Array.isArray(list) || !list.every(isObject)) {
        keptReceiver[key] = list;
        out.warnings.push(
          `receiver "${r.name}": ${key} is ${spec === undefined ? "not a notifier the prometheus lexicon converts" : "not a list of objects"}, so it is kept as the CRD wrote it, beside the declaration.`,
        );
        continue;
      }
      const typedList: Json[] = [];
      const keptList: Json[] = [];
      list.forEach((entry, j) => {
        const { typed, kept } = splitEntry(entry as Json, spec);
        typedList.push(typed);
        keptList.push(kept);
        const keys = Object.keys(kept);
        if (keys.length > 0) {
          out.warnings.push(
            `receiver "${r.name}": ${key}[${j}] keeps ${keys.join(", ")} as the CRD wrote ${keys.length === 1 ? "it" : "them"} ` +
              "(a Secret reference is carried and never read, and httpConfig has no declaration), beside the declaration.",
          );
        }
      });
      typedReceiver[notifierKey(key)] = typedList;
      if (keptList.some((k) => Object.keys(k).length > 0)) keptReceiver[key] = keptList;
    }
    out.receivers.push(typedReceiver);
    if (Object.keys(keptReceiver).length > 0) out.kept[r.name] = keptReceiver;
  });
  return out;
}

// ── the importer ─────────────────────────────────────────────────────

export const alertmanagerConfigImporter: EmbeddedContentImporter = {
  what: "an Alertmanager config",

  matches(content: EmbeddedContent) {
    return content.hostType === HOST_TYPE && content.select !== undefined && content.select in FIELDS && isObject(content.document);
  },

  import(content: EmbeddedContent): EmbeddedImport {
    const field = FIELDS[content.select!];
    const spec = content.document as Json;
    const value = spec[content.select!];
    const warnings: string[] = [];

    let fragment: unknown;
    let read: ReceiversRead | undefined;
    switch (content.select) {
      case "route":
        fragment = routeFragment(value, "spec.route");
        break;
      case "receivers":
        read = receiversFragment(value);
        fragment = read.receivers;
        warnings.push(...read.warnings);
        break;
      case "inhibitRules":
        fragment = inhibitFragment(value);
        break;
      default:
        fragment = timeIntervalFragment(value);
    }

    // The fragment is already in the modern spelling the standalone import rewrites to, so it goes straight to the
    // generator that `chant import alertmanager.yml` ends in.
    const generated = generateAlertmanager({ [field.fragment]: fragment } as AlertmanagerConfig);
    if (generated.declarations.length === 0) throw new Error("the import declared nothing");
    const files = generated.files.map(keepDeclarationsOut);
    const bindings = generated.declarations.map((d) => ({ from: d.path, name: DECLARED, member: d.name }));

    if (read === undefined || Object.keys(read.kept).length === 0) {
      return { files, value: { bindings, shape: field.shape, through: { from: K8S_ENTRY, name: field.through } }, warnings };
    }

    // The declarations do not hold what the CRD holds beside them, so a module of its own puts it back.
    const modules = [...new Set(bindings.map((b) => b.from))];
    const alias = new Map(modules.map((from, i) => [from, i === 0 ? DECLARED : `${DECLARED}${i + 1}`]));
    const module = {
      path: "crd-receivers.ts",
      content: [
        "/** The receivers as the AlertmanagerConfig holds them: the declarations, with the fields they do not hold put back. */",
        `import { ${field.through} } from "${K8S_ENTRY}";`,
        ...modules.map((from) => `import { ${DECLARED}${alias.get(from) === DECLARED ? "" : ` as ${alias.get(from)}`} } from "./${from.replace(/\.ts$/, "")}";`),
        "",
        "/** Per receiver name, what the CRD holds that a declaration does not (Secret references are carried, never read). */",
        `const kept = ${JSON.stringify(read.kept, null, 2)};`,
        "",
        `const receivers = ${field.through}([${bindings.map((b) => `${alias.get(b.from)}.${b.member}`).join(", ")}], kept);`,
        "",
        "export { receivers };",
        "",
      ].join("\n"),
    };
    return { files: [...files, module], value: { bindings: [{ from: module.path, name: "receivers" }], shape: "single" }, warnings };
  },
};
