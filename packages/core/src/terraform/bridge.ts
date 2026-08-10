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
 *    An `output` block reading the carved resource is such a survivor (#1638):
 *    same data source, same textual rewrite, applied to the output's value.
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

import { deferredParamName, type CarveReport } from "./carve";
import { exciseResourceBlocks, type ExciseTarget } from "./excise";

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
  /** Carved addresses whose own `resource` block was removed from this file (#998). */
  excised: string[];
}

export interface DeferredInput {
  survivor: string;
  carved: string;
  attrs: string[];
  /** Build-parameter name(s) the input becomes in the emitted project (#998). */
  params: string[];
  note: string;
}

export interface BridgePlan {
  target: string;
  dataSources: DataSourceBlock[];
  rewrites: FileRewrite[];
  deferredInputs: DeferredInput[];
  /** Every carved address whose own block the rewrites remove, across files. */
  excised: string[];
  /**
   * `output` blocks whose value the rewrites repoint at a data source (#1638),
   * as `output.<name>`. They are inbound edges like any other — listed
   * separately only because the patch is a one-line expression edit.
   */
  outputRewrites: string[];
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

  // Excise the carve set's own blocks (#998): after `terraform state rm`, a
  // block left behind would re-create the resource on the next apply. Then
  // rewrite every remaining survivor reference into a data ref.
  const exciseTargets: ExciseTarget[] = report.carveSet
    .filter((m) => !m.address.startsWith("module."))
    .map((m) => {
      const [type, ...rest] = m.address.split(".");
      return { address: m.address, type, name: rest.join(".") };
    });
  const rewrites: FileRewrite[] = files.map(({ path, content }) => {
    const excision = exciseResourceBlocks(content, exciseTargets);
    let rewritten = excision.content;
    for (const address of carvedWithInbound.keys()) {
      rewritten = rewritten.replace(referenceRegex(address), `data.${address}`);
    }
    return { path, original: content, rewritten, changed: rewritten !== content, excised: excision.excised };
  });
  const excised = rewrites.flatMap((r) => r.excised);

  const deferredInputs: DeferredInput[] = report.outbound.map((e) => {
    const params = (e.via ?? []).map(deferredParamName);
    const wiring = params.length
      ? `emit declares it as build param ${params.map((p) => `\`${p}\``).join(", ")} — override with --param at build`
      : "supply this as a deploy-time input to the carved component at apply";
    return {
      survivor: e.survivor,
      carved: e.carved,
      attrs: e.attrs,
      params,
      note: `${e.carved} reads ${e.survivor}.${e.attrs.join(", ")} — ${wiring}.`,
    };
  });

  const outputRewrites = report.inbound
    .filter((e) => e.bridge === "tf-output-rewrite")
    .map((e) => e.survivor)
    .sort();

  return {
    target: report.target,
    dataSources,
    rewrites,
    deferredInputs,
    excised,
    outputRewrites,
    runbook: buildRunbook(report, dataSources, deferredInputs, excised, outputRewrites),
  };
}

/** The reversible, observe-first handoff runbook (#197). */
function buildRunbook(
  report: CarveReport,
  dataSources: DataSourceBlock[],
  deferred: DeferredInput[],
  excised: string[],
  outputRewrites: string[],
): string {
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
  if (excised.length) {
    L.push(`    # the generated bridge patch removes the carved block(s): ${excised.join(", ")}`);
    L.push("    #   (without this, the next apply would re-create what state rm released)");
  }
  if (dataSources.length) {
    L.push("    # it also adds these data sources and rewires references:");
    for (const ds of dataSources) L.push(`    #   data.${ds.type}.${ds.name}  (for ${ds.address})`);
  } else if (!excised.length) {
    L.push("    # no inbound edges — no survivor patch needed.");
  }
  if (outputRewrites.length) {
    L.push(`    # and repoints these output block(s) at the data source: ${outputRewrites.join(", ")}`);
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
