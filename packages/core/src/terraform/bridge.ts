/**
 * Boundary bridging for the strangler-fig carve (#197) — the centerpiece.
 *
 * Carving a resource cuts edges. This generates the edits to the Terraform you
 * LEAVE BEHIND so its plan stays valid once the resource is chant-owned:
 *
 *  - inbound edge  → the survivor loses its reference to the carved resource.
 *    Bridge: add a `data` source for the (now chant-managed) resource and
 *    rewrite the survivor's `type.name.attr` references to `data.type.name.attr`.
 *    Required immediately, or `terraform plan` errors on the dangling ref.
 *
 *  - outbound edge → the carved resource read a value from a survivor. That
 *    value must enter chant from outside synthesis, as a deploy-time input.
 *    Deferred until apply; here we only record the provenance.
 *
 * Pure text transform over the original `.tf` content — no wasm, no shell, no
 * mutation. The command layer writes the results and (optionally) diffs them
 * into a git-applyable patch. A carve never destroys or recreates; the runbook
 * is reversible via `terraform import`.
 */

import type { CarveReport } from "./carve";

export interface CarvedIdentity {
  /** The HCL identity attribute, e.g. `bucket` or `name`. */
  attr?: string;
  /** Its literal value, e.g. `myapp-assets-prod`. */
  value?: string;
}

export interface DataSourceBlock {
  /** Carved resource address the data source stands in for. */
  address: string;
  type: string;
  name: string;
  hcl: string;
}

export interface FileRewrite {
  path: string;
  original: string;
  rewritten: string;
  changed: boolean;
}

export interface DeferredInput {
  survivor: string;
  carved: string;
  attrs: string[];
  note: string;
}

export interface BridgePlan {
  target: string;
  dataSources: DataSourceBlock[];
  rewrites: FileRewrite[];
  deferredInputs: DeferredInput[];
  runbook: string;
}

/** `aws_s3_bucket.assets` → a regex matching that reference head, not already `data.`-prefixed. */
function referenceRegex(address: string): RegExp {
  const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // (?<!data\.) — do not double-prefix an existing data source reference.
  return new RegExp(`(?<!data\\.)\\b${escaped}\\b`, "g");
}

function dataSourceHcl(type: string, name: string, identity: CarvedIdentity): string {
  const body =
    identity.attr && identity.value !== undefined
      ? `  ${identity.attr} = ${JSON.stringify(identity.value)}`
      : `  # TODO: identify the resource (its name/id was interpolated in the source)`;
  return `data ${JSON.stringify(type)} ${JSON.stringify(name)} {\n${body}\n}`;
}

/**
 * Build the bridge plan for a carve.
 *
 * @param report    the boundary report (from `boundaryReport`)
 * @param files     every `.tf` file in the estate, as { path, content }
 * @param identities physical identity per carved address, for the data sources
 */
export function generateBridge(
  report: CarveReport,
  files: Array<{ path: string; content: string }>,
  identities: Map<string, CarvedIdentity>,
): BridgePlan {
  // Carved resources that something still depends on need a data source.
  const carvedWithInbound = new Map<string, { type: string; name: string }>();
  for (const e of report.inbound) {
    const [type, ...rest] = e.carved.split(".");
    carvedWithInbound.set(e.carved, { type, name: rest.join(".") });
  }

  const dataSources: DataSourceBlock[] = [...carvedWithInbound.entries()].map(([address, { type, name }]) => ({
    address,
    type,
    name,
    hcl: dataSourceHcl(type, name, identities.get(address) ?? {}),
  }));

  // Rewrite every survivor reference to the carved resources into a data ref.
  const rewrites: FileRewrite[] = files.map(({ path, content }) => {
    let rewritten = content;
    for (const address of carvedWithInbound.keys()) {
      rewritten = rewritten.replace(referenceRegex(address), `data.${address}`);
    }
    return { path, original: content, rewritten, changed: rewritten !== content };
  });

  const deferredInputs: DeferredInput[] = report.outbound.map((e) => ({
    survivor: e.survivor,
    carved: e.carved,
    attrs: e.attrs,
    note: `${e.carved} reads ${e.survivor}.${e.attrs.join(", ")} — supply this as a deploy-time input to the carved component at apply.`,
  }));

  return {
    target: report.target,
    dataSources,
    rewrites,
    deferredInputs,
    runbook: buildRunbook(report, dataSources, deferredInputs),
  };
}

/** The reversible, observe-first handoff runbook (#197). */
function buildRunbook(report: CarveReport, dataSources: DataSourceBlock[], deferred: DeferredInput[]): string {
  const carvedAddrs = report.carveSet.map((m) => m.address);
  const L: string[] = [];
  L.push(`# Carve-out: ${report.target} → chant   [observe-first, reversible]`);
  L.push("");
  L.push(`Peelability ${report.peelability}. Carves ${carvedAddrs.length} Terraform resource(s) into chant, leaving the live resource untouched.`);
  L.push("");
  L.push("## 1. Review the emitted chant source");
  L.push("    (produced by `chant carve emit` — confirm it builds to a spec-true template)");
  L.push("");
  L.push("## 2. Stop Terraform managing the resource (does NOT destroy it)");
  L.push(`    terraform state rm ${carvedAddrs.join(" ")}`);
  L.push("");
  L.push("## 3. Confirm no destroy, then patch the survivors");
  L.push("    terraform plan   # expect 0 to destroy; refs to the carved resource now error");
  if (dataSources.length) {
    L.push("    # apply the generated bridge patch — it adds these data sources and rewires references:");
    for (const ds of dataSources) L.push(`    #   data.${ds.type}.${ds.name}  (for ${ds.address})`);
  } else {
    L.push("    # no inbound edges — no survivor patch needed.");
  }
  L.push("    terraform plan   # expect: in-place updates to the survivors only");
  L.push("    terraform apply");
  L.push("");
  L.push("## 4. Adopt the live resource into chant (now an orphan)");
  L.push("    chant carve emit --from <tf-dir> --select " + report.target + " --env <env>   # already done if you ran emit");
  L.push("    # then apply the ownership marker so chant owns it (carve apply, next step)");
  if (deferred.length) {
    L.push("");
    L.push("## Deferred deploy-time inputs (wire these when you turn the dial to apply)");
    for (const d of deferred) L.push(`    - ${d.note}`);
  }
  L.push("");
  L.push("## Rollback (any time before apply-graduation)");
  L.push(`    terraform import ${report.target} <physical-id>   # back under Terraform`);
  return L.join("\n");
}
