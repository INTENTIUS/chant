/**
 * `chant kube source` (chant #1079) — resolve a live object back to the
 * `.ts` file and composite that declared it, reusing the exact build
 * provenance the gitlab/forgejo lexicons' own `:source` context tools already
 * expose (`@intentius/chant/provenance`, stamped during discovery — chant
 * #1064). That precedent is explicit that provenance here is **entity-level
 * (file + composite), not a YAML-line source map** — chant does not carry
 * one, for k8s or for anything else — so this verb reports the same two
 * facts (never a fabricated line number) and says so plainly rather than
 * silently coming up one field short of the issue's wording.
 */

import { formatUnobserved } from "@intentius/chant/observation";
import { defaultK8sConnector, type K8sConnector } from "../api/connect";
import { classifyApiFailure } from "../api/classify";
import { kubeConnect } from "./connect";
import { parseKubeFlags, connectOptionsFrom } from "./flags";
import { loadKubeProjectContext, relativeProvenance, type KubeProjectContext } from "./project";
import { resolveKubeTarget, matchLiveObject, isTargetError, type KubeTarget } from "./target";

export interface SourceDeps {
  connect?: K8sConnector;
  loadProject?: (cwd?: string) => Promise<KubeProjectContext | undefined>;
}

function targetLabel(target: KubeTarget): string {
  return "apiVersion" in target.selector ? target.selector.kind : target.selector.resource;
}

export async function runSource(rawArgs: string[], deps: SourceDeps = {}): Promise<number> {
  const connect = deps.connect ?? defaultK8sConnector;
  const loadProject = deps.loadProject ?? loadKubeProjectContext;

  let flags;
  try {
    flags = parseKubeFlags(rawArgs);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const json = flags.values.output === "json";

  const project = await loadProject();
  if (!project) {
    if (json) console.log(JSON.stringify({ available: false, note: "not running inside a chant project (no chant.config.ts, or the project has build errors)" }));
    else console.log("chant source: unavailable — not running inside a chant project (no chant.config.ts, or the project has build errors)");
    return 1;
  }

  const target = resolveKubeTarget(flags.positional, flags.values.namespace, project);
  if (isTargetError(target)) {
    console.error(`error: ${target.error}`);
    return 1;
  }
  if (!target.name) {
    console.error("error: chant kube source requires a single named resource, e.g. `chant kube source deployment web`");
    return 1;
  }

  const connected = await kubeConnect(connectOptionsFrom(flags.values), connect);
  if (connected.kind === "unobserved") {
    console.error(formatUnobserved(targetLabel(target), { reason: connected.reason, detail: connected.detail }));
    return 1;
  }
  const { client } = connected;

  let info;
  try {
    info = await client.resolve(target.selector);
  } catch (err) {
    const outcome = classifyApiFailure(err);
    console.error(
      formatUnobserved(targetLabel(target), {
        reason: outcome.kind === "unobserved" ? outcome.reason : "read-failed",
        detail: outcome.kind === "unobserved" ? outcome.detail : String(err),
      }),
    );
    return 1;
  }
  if (!info) {
    console.error(`error: the server doesn't have a resource type "${targetLabel(target)}"`);
    return 1;
  }

  const namespace = target.namespace ?? client.defaultNamespace;
  let obj;
  try {
    obj = await client.readIfPresent({ apiVersion: info.apiVersion, kind: info.kind, name: target.name, namespace });
  } catch (err) {
    const outcome = classifyApiFailure(err);
    console.error(
      formatUnobserved(`${info.kind}/${target.name}`, {
        reason: outcome.kind === "unobserved" ? outcome.reason : "read-failed",
        detail: outcome.kind === "unobserved" ? outcome.detail : String(err),
      }),
    );
    return 1;
  }
  if (!obj) {
    console.error(`Error from server (NotFound): ${info.name} "${target.name}" not found`);
    return 1;
  }

  const match =
    target.declaredMatch ??
    matchLiveObject(project, {
      apiVersion: obj.apiVersion ?? info.apiVersion,
      kind: obj.kind ?? info.kind,
      name: obj.metadata?.name ?? target.name,
      namespace: obj.metadata?.namespace ?? namespace,
    });

  if (!match) {
    const note = `no declared entity in this project names ${info.kind}/${target.name}`;
    if (json) console.log(JSON.stringify({ found: false, note }));
    else console.log(`${info.kind}/${target.name}: ${note}`);
    return 0;
  }

  const prov = relativeProvenance(project, match.entity);
  if (json) {
    console.log(
      JSON.stringify({
        found: true,
        entity: match.entityName,
        file: prov?.sourceFile ?? null,
        composite: prov?.composite ?? null,
        compositeInstance: prov?.compositeInstance ?? null,
      }),
    );
  } else {
    console.log(`${info.kind}/${target.name} <- ${match.entityName}`);
    console.log(`  file:      ${prov?.sourceFile ?? "(unknown)"}`);
    console.log(`  composite: ${prov?.composite ?? "(none — declared directly)"}`);
    console.log(`  line:      not tracked — chant's build provenance is entity-level (file + composite), not a source map`);
  }
  return 0;
}
