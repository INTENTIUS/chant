/**
 * The deprecated-version check (chant#4599, terragucci#1289 bundle B): each
 * module call (`moduleConsumers`, ../pin/consumers.ts) against the release
 * catalog (`readRegistryCatalog`, ./catalog-read.ts). A call pinned to a
 * deprecated version gets a warning, and one pinned to a yanked version a
 * refusal, each naming the reason and the version to move to when the
 * catalog has one.
 *
 * A catalog component is matched by the module address its `terraform`
 * fields name (`terraformCatalogFields`, ./docs.ts), else by its name, both
 * normalised as the scan normalises a call's source. A call's pin is matched
 * to a version by the version (a leading `v` ignored) or by the digest. A
 * call with no pin, or one naming a module or version the catalog does not
 * list, is left alone: this check speaks only for what the catalog says.
 */
import type { CatalogComponent, CatalogVersion, ReleaseCatalog } from "@intentius/chant/lifecycle/release-catalog";
import { normalizeModuleSource, type ModuleConsumer } from "../pin/consumers";

/** One call on a version the catalog marks. */
export interface DeprecatedPin {
  consumer: ModuleConsumer;
  component: string;
  /** The version as the catalog lists it (its version, or its digest when it has none). */
  version: string;
  status: "deprecated" | "yanked";
  reason: string | null;
  replacement: string | null;
  /** One line for a person: where, what, why, and what to move to. */
  message: string;
}

/** The check's result: warnings for deprecated pins, refusals for yanked ones. */
export interface DeprecatedPinsResult {
  warnings: DeprecatedPin[];
  refusals: DeprecatedPin[];
}

const bare = (v: string): string => v.replace(/^v(?=\d)/, "");

function addressOf(c: CatalogComponent): string {
  const tf = c.fields.terraform as { address?: unknown } | undefined;
  return normalizeModuleSource(typeof tf?.address === "string" ? tf.address : c.name);
}

function versionFor(c: CatalogComponent, pin: string): CatalogVersion | undefined {
  return c.versions.find((v) => (v.version !== null && bare(v.version) === bare(pin)) || v.digest === pin);
}

/** Check every call against the catalog. */
export function deprecatedPins(consumers: readonly ModuleConsumer[], catalog: ReleaseCatalog): DeprecatedPinsResult {
  const byAddress = new Map<string, CatalogComponent>();
  for (const c of catalog.components) byAddress.set(addressOf(c), c);
  const out: DeprecatedPinsResult = { warnings: [], refusals: [] };
  for (const consumer of consumers) {
    if (consumer.pin === null) continue;
    const component = byAddress.get(consumer.module);
    if (!component) continue;
    const v = versionFor(component, consumer.pin);
    if (!v || v.status.state === "active") continue;
    const version = v.version ?? v.digest;
    const said = [`${consumer.file} ${consumer.address} pins ${component.name} ${version}, which is ${v.status.state}`];
    if (v.status.reason) said.push(`: ${v.status.reason}`);
    if (v.status.replacement) said.push(`; move to ${v.status.replacement}`);
    const finding: DeprecatedPin = {
      consumer,
      component: component.name,
      version,
      status: v.status.state,
      reason: v.status.reason,
      replacement: v.status.replacement,
      message: said.join(""),
    };
    (v.status.state === "yanked" ? out.refusals : out.warnings).push(finding);
  }
  return out;
}
