/**
 * Argo CD ApplicationSets as the graph reads them (#5102).
 *
 * An ApplicationSet does not name its paths and clusters. Its generators
 * yield parameter sets, and its template turns each set into an Application.
 * {@link generateApplications} expands two generators whose inputs are
 * literals in the repo:
 *
 * - `list`: one parameter set per entry of `elements`.
 * - `clusters`: one per Argo CD cluster Secret in the graph that the
 *   generator's `selector` selects (`matchLabels`, and `matchExpressions`
 *   with `In`, `NotIn`, `Exists` and `DoesNotExist`), with the generator's
 *   `values` merged in under `values`. A generator with no selector also
 *   selects the cluster Argo CD runs in (`in-cluster`) when no Secret
 *   registers it. The parameters are `name`, `nameNormalized`, `server`,
 *   `metadata.labels.<key>` and `metadata.annotations.<key>`.
 *
 * Each parameter set is substituted into the template, with a generator's own
 * `template` merged over it, in the form the ApplicationSet uses: `{{name}}`
 * by default, `{{ .name }}` with `goTemplate: true`. The Go form reads a field
 * (`.metadata.labels.cloud`) and `index` with literal keys; any other
 * function or pipeline, and a field the parameters do not have, is reported
 * and that element is not expanded. A generated Application sits in the
 * ApplicationSet's namespace, as Argo CD creates it there.
 *
 * Other generators (`git`, `matrix`, `merge`, `scmProvider`, `pullRequest`,
 * `clusterDecisionResource`, `plugin`), `elementsYaml`, a generator's
 * post-selector and `templatePatch` are not expanded, and each is reported.
 * Pure.
 */
import type { IRNode } from "@intentius/chant/graph-ir";
import type { Generated, GeneratedNode } from "@intentius/chant/graph-refs";
import { stampGeneratedApplication } from "./helm-references";

type Doc = Record<string, unknown>;

const isObject = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** The kind of the node an ApplicationSet makes, and of the cluster registrations a `clusters` generator reads. */
export const APPLICATION = "K8s::Argo::Application";
export const APPLICATION_SET = "K8s::Argo::ApplicationSet";
const SECRET = "K8s::Core::Secret";

/** The cluster Argo CD runs in, as the `clusters` generator yields it when no Secret registers it. */
const IN_CLUSTER = { name: "in-cluster", server: "https://kubernetes.default.svc" };

/** Generators this module reads. Every other key of a generator entry is one it does not. */
const EXPANDED = new Set(["list", "clusters"]);

/** A template that did not render, and why. */
class Unsupported extends Error {}

// ── substitution ──────────────────────────────────────────────────────────

/** A field path of the Go form, `.a.b.c`, as its steps. */
const FIELD = /^(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
/** A literal Go string, as `index` takes its keys. */
const QUOTED = /^"(?:[^"\\]|\\.)*"$/;

function lookup(params: Doc, steps: string[], written: string): string {
  let cur: unknown = params;
  for (const step of steps) {
    if (!isObject(cur) || !(step in cur)) throw new Unsupported(`the parameters have no ${written}`);
    cur = cur[step];
  }
  if (typeof cur === "string") return cur;
  if (typeof cur === "number" || typeof cur === "boolean") return String(cur);
  throw new Unsupported(`${written} is not a string`);
}

/** The value of one Go template action: a field, or `index` of a field with literal keys. */
function goAction(expr: string, params: Doc): string {
  if (FIELD.test(expr)) return lookup(params, expr.slice(1).split("."), expr);
  const words = expr.split(/\s+/);
  if (words[0] === "index" && words.length >= 3 && (words[1] === "." || FIELD.test(words[1])) && words.slice(2).every((w) => QUOTED.test(w))) {
    const base = words[1] === "." ? [] : words[1].slice(1).split(".");
    return lookup(params, [...base, ...words.slice(2).map((w) => JSON.parse(w) as string)], expr);
  }
  throw new Unsupported(`{{ ${expr} }} uses a function or form the graph does not expand`);
}

/** Substitute one string in the Go form. `{{-` and `-}}` trim the space beside them, as in Go. */
function renderGo(text: string, params: Doc): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{{", i);
    if (open === -1) {
      out += text.slice(i);
      break;
    }
    const close = text.indexOf("}}", open + 2);
    if (close === -1) throw new Unsupported(`"${text}" opens an action it does not close`);
    let before = text.slice(i, open);
    let inner = text.slice(open + 2, close);
    if (/^-\s/.test(inner)) {
      before = before.replace(/\s+$/, "");
      inner = inner.slice(1);
    }
    let next = close + 2;
    if (/\s-$/.test(inner)) {
      inner = inner.slice(0, -1);
      while (next < text.length && /\s/.test(text[next])) next++;
    }
    const expr = inner.trim();
    if (expr.startsWith("/*")) {
      out += before;
    } else {
      out += before + goAction(expr, params);
    }
    i = next;
  }
  return out;
}

/** Substitute one string in the default form, `{{name}}`, against flattened parameters. */
function renderPlain(text: string, flat: Record<string, string>): string {
  return text.replace(/\{\{([^{}]*)\}\}/g, (_m, inner: string) => {
    const key = inner.trim();
    if (!(key in flat)) throw new Unsupported(`the parameters have no ${key} for {{${inner}}}`);
    return flat[key];
  });
}

/** Every string in a tree, keys included, substituted. */
function renderTree(value: unknown, one: (s: string) => string): unknown {
  if (typeof value === "string") return value.includes("{{") ? one(value) : value;
  if (Array.isArray(value)) return value.map((v) => renderTree(v, one));
  if (isObject(value)) {
    const out: Doc = {};
    for (const [k, v] of Object.entries(value)) out[k.includes("{{") ? one(k) : k] = renderTree(v, one);
    return out;
  }
  return value;
}

/** Nested parameters as `a.b.c` keys, scalars as strings. */
export function flattenParams(params: Doc, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(params)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isObject(v)) flattenParams(v, key, out);
    else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[key] = String(v);
  }
  return out;
}

/** A generator's own `template` over the ApplicationSet's: maps merge key by key, anything else is replaced. */
function merge(base: unknown, over: unknown): unknown {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over;
  const out: Doc = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
}

// ── clusters ──────────────────────────────────────────────────────────────

interface ClusterParams {
  params: Doc;
  node?: IRNode;
}

const labelsOf = (node: IRNode): Record<string, string> => {
  const labels = isObject(node.attrs.metadata) ? node.attrs.metadata.labels : undefined;
  return isObject(labels) ? (Object.fromEntries(Object.entries(labels).filter(([, v]) => typeof v === "string")) as Record<string, string>) : {};
};

/** Whether a label selector selects `labels`, or why it cannot be read. */
function selects(selector: Doc, labels: Record<string, string>): boolean {
  const matchLabels = isObject(selector.matchLabels) ? selector.matchLabels : {};
  for (const [k, v] of Object.entries(matchLabels)) if (labels[k] !== String(v)) return false;
  const expressions = Array.isArray(selector.matchExpressions) ? selector.matchExpressions : [];
  for (const e of expressions) {
    if (!isObject(e) || typeof e.key !== "string") throw new Unsupported("a matchExpressions entry has no key");
    const values = Array.isArray(e.values) ? e.values.map(String) : [];
    const has = e.key in labels;
    switch (e.operator) {
      case "In":
        if (!has || !values.includes(labels[e.key])) return false;
        break;
      case "NotIn":
        if (has && values.includes(labels[e.key])) return false;
        break;
      case "Exists":
        if (!has) return false;
        break;
      case "DoesNotExist":
        if (has) return false;
        break;
      default:
        throw new Unsupported(`matchExpressions operator ${String(e.operator)} is not one the graph reads`);
    }
  }
  return true;
}

/** `name` as Argo CD normalizes it for `nameNormalized`: lower case, with any character a resource name cannot hold made `-`. */
const normalizeName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9.-]/g, "-");

function clusterParams(name: string, server: string, node?: IRNode): ClusterParams {
  const metadata = node && isObject(node.attrs.metadata) ? node.attrs.metadata : {};
  const annotations = isObject(metadata.annotations) ? metadata.annotations : {};
  return {
    params: { name, nameNormalized: normalizeName(name), server, metadata: { labels: node ? labelsOf(node) : {}, annotations: { ...annotations } } },
    ...(node ? { node } : {}),
  };
}

/** The clusters a `clusters` generator selects, by Secret name. */
function selectedClusters(generator: Doc, nodes: readonly IRNode[]): ClusterParams[] {
  const selector = isObject(generator.selector) ? generator.selector : {};
  const secrets = nodes.filter((n) => n.kind === SECRET && isObject(n.attrs.argoCluster));
  const out: ClusterParams[] = [];
  for (const node of secrets) {
    const cluster = node.attrs.argoCluster as Doc;
    const name = str(cluster.name);
    const server = str(cluster.server);
    if (name === undefined || server === undefined) continue;
    if (selects(selector, labelsOf(node))) out.push(clusterParams(name, server, node));
  }
  const empty = !isObject(generator.selector) || (Object.keys(selector.matchLabels ?? {}).length === 0 && (!Array.isArray(selector.matchExpressions) || selector.matchExpressions.length === 0));
  if (empty && !out.some((c) => c.params.server === IN_CLUSTER.server)) out.push(clusterParams(IN_CLUSTER.name, IN_CLUSTER.server));
  return out.sort((a, b) => String(a.params.name).localeCompare(String(b.params.name)) || (a.node?.id ?? "").localeCompare(b.node?.id ?? ""));
}

// ── expansion ─────────────────────────────────────────────────────────────

/**
 * The Applications an ApplicationSet node generates from its `list` and
 * `clusters` generators, given every node the pass reads (the cluster
 * Secrets among them), and a line for each thing it did not expand.
 */
export function generateApplications(holder: IRNode, nodes: readonly IRNode[]): Generated {
  const out: Generated = { nodes: [], notExpanded: [] };
  const spec = isObject(holder.attrs.spec) ? holder.attrs.spec : {};
  if (spec.templatePatch !== undefined) {
    out.notExpanded.push("templatePatch is not expanded, so no Application is generated");
    return out;
  }
  const go = spec.goTemplate === true;
  const namespace = isObject(holder.attrs.metadata) ? str(holder.attrs.metadata.namespace) : undefined;
  const generators = Array.isArray(spec.generators) ? spec.generators : [];
  const seen = new Set<string>();

  generators.forEach((generator, i) => {
    const at = `generators[${i}]`;
    if (!isObject(generator)) return;
    const types = Object.keys(generator).filter((k) => k !== "selector");
    const type = types[0];
    if (types.length !== 1) {
      out.notExpanded.push(`${at} names ${types.length === 0 ? "no generator" : `several generators (${types.join(", ")})`}, and is not expanded`);
      return;
    }
    if (!EXPANDED.has(type)) {
      out.notExpanded.push(`${at}: the ${type} generator is not expanded`);
      return;
    }
    if (generator.selector !== undefined) {
      out.notExpanded.push(`${at}: a generator's post-selector is not expanded`);
      return;
    }
    const body = isObject(generator[type]) ? (generator[type] as Doc) : {};
    const template = merge(spec.template, body.template);

    let sets: ClusterParams[];
    if (type === "list") {
      if (body.elementsYaml !== undefined) {
        out.notExpanded.push(`${at}: list elementsYaml is not expanded`);
        return;
      }
      const elements = Array.isArray(body.elements) ? body.elements : [];
      sets = elements.map((e) => ({ params: isObject(e) ? e : {} }));
    } else {
      if (body.flatList === true) {
        out.notExpanded.push(`${at}: a clusters generator with flatList is not expanded`);
        return;
      }
      try {
        sets = selectedClusters(body, nodes);
      } catch (err) {
        out.notExpanded.push(`${at}: ${(err as Error).message}, so the generator is not expanded`);
        return;
      }
      const values = isObject(body.values) ? body.values : undefined;
      if (values) {
        const withValues: ClusterParams[] = [];
        for (const set of sets) {
          try {
            const one = go ? (s: string) => renderGo(s, set.params) : (s: string) => renderPlain(s, flattenParams(set.params));
            withValues.push({ ...set, params: { ...set.params, values: renderTree(values, one) } });
          } catch (err) {
            out.notExpanded.push(`${at} cluster ${String(set.params.name)}: values: ${(err as Error).message}; not expanded`);
          }
        }
        sets = withValues;
      }
    }

    sets.forEach((set, j) => {
      const which = type === "clusters" ? `${at} cluster ${String(set.params.name)}` : `${at} element ${j}`;
      const flat = flattenParams(set.params);
      let rendered: unknown;
      try {
        rendered = renderTree(template, go ? (s) => renderGo(s, set.params) : (s) => renderPlain(s, flat));
      } catch (err) {
        out.notExpanded.push(`${which}: ${(err as Error).message}; not expanded`);
        return;
      }
      const app = isObject(rendered) ? rendered : {};
      const metadata: Doc = { ...(isObject(app.metadata) ? app.metadata : {}) };
      const name = str(metadata.name);
      if (!name) {
        out.notExpanded.push(`${which}: the template gives no metadata.name; not expanded`);
        return;
      }
      if (seen.has(name)) {
        out.notExpanded.push(`${which}: Application ${name} is generated twice; the second is not expanded`);
        return;
      }
      seen.add(name);
      delete metadata.namespace;
      if (namespace !== undefined) metadata.namespace = namespace;
      const node: GeneratedNode = {
        key: name,
        kind: APPLICATION,
        // Stamped as the reader stamps an Application written by hand, so its charts and values files join the Helm graph (#5094).
        attrs: stampGeneratedApplication({ apiVersion: str(holder.attrs.apiVersion) ?? "argoproj.io/v1alpha1", kind: "Application", metadata, spec: isObject(app.spec) ? app.spec : {} }),
        generator: type,
        params: flat,
        ...(set.node ? { cluster: set.node } : {}),
      };
      out.nodes.push(node);
    });
  });
  return out;
}
