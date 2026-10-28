/**
 * Module sources and provider addresses in a normal form (chant#3924), beside
 * the registry address parsing of ./address.ts (chant#4565), so a product's
 * allow list, the catalog's consumer scan and the proxy forms (chant#4606)
 * compare sources one way. No Node imports, so an edge function can carry it.
 *
 * A module source is compared without its `?` query: a `ref`, `version` or
 * `tag` pins a release and does not move where the code comes from. A
 * registry source written without a host is read by Terraform from
 * registry.terraform.io and by OpenTofu from registry.opentofu.org, so it
 * stands for both; Terragrunt's `tfr:///` and `tfr://<host>/` are the same
 * sources. Registry shapes follow `classifyModuleSource`
 * (../lint/post-synth/module-source.ts), which mirrors
 * hashicorp/terraform-registry-address.
 *
 * A provider address is `<host>/<namespace>/<type>` in lower case. A
 * `required_providers` source without a host gets the binary's default
 * registry, one with only a type gets the `hashicorp` namespace (Terraform's
 * legacy reading), and a provider a module uses with no entry at all is the
 * one `init` installs for it, `hashicorp/<name>`; the binary's own
 * `terraform` provider is never downloaded and has no address.
 */
import { classifyModuleSource } from "../lint/post-synth/module-source";
import { parseRegistrySource } from "./address";

/** The public registry's host, which a source with no host names under Terraform. */
export const PUBLIC_REGISTRY_HOST = "registry.terraform.io";
/** OpenTofu's public registry's host. */
export const OPENTOFU_REGISTRY_HOST = "registry.opentofu.org";
/** The hosts a provider or registry module address written without one is read from, Terraform's first. */
export const DEFAULT_REGISTRIES: readonly string[] = [PUBLIC_REGISTRY_HOST, OPENTOFU_REGISTRY_HOST];

/** Which binary reads an address: it decides the default registry host. */
export type SourceBinary = "terraform" | "tofu";

/** The default registry host for a binary. */
export const defaultRegistryHost = (binary: SourceBinary = "terraform"): string => (binary === "tofu" ? OPENTOFU_REGISTRY_HOST : PUBLIC_REGISTRY_HOST);

/** A source without its `?` query, trimmed. */
export const withoutQuery = (source: string): string => source.trim().split("?")[0]!;

/** A hostless registry module source (`<ns>/<name>/<system>`, optionally `//<subdir>`), as the registry protocol shapes one. */
function isHostlessModule(source: string): boolean {
  const base = source.split("//")[0]!;
  return base.split("/").length === 3 && classifyModuleSource(base).kind === "registry";
}

/** The source without a default registry's host, when it starts with one. */
function atDefaultRegistry(source: string): string | undefined {
  const host = DEFAULT_REGISTRIES.find((h) => source.toLowerCase().startsWith(`${h}/`));
  return host ? source.slice(host.length + 1) : undefined;
}

/**
 * Every form a module source matches as: as written without its query, then
 * its registry forms. A hostless registry source adds itself at each default
 * registry; one at a default registry adds its hostless form and its form at
 * the other default registry; `tfr:///x` adds `x` at each default registry
 * and `tfr://<host>/x` adds `<host>/x`. Any other source (local, git, OCI,
 * an archive URL) has the one form.
 */
export function moduleSourceForms(source: string): string[] {
  const written = withoutQuery(source);
  const out = [written];
  const add = (...forms: string[]) => {
    for (const f of forms) if (!out.includes(f)) out.push(f);
  };
  const tfr = /^tfr:\/\/([^/]*)\/(.+)$/.exec(written);
  if (tfr) {
    if (tfr[1]) add(`${tfr[1].toLowerCase()}/${tfr[2]}`);
    else add(...DEFAULT_REGISTRIES.map((h) => `${h}/${tfr[2]}`));
    if (!tfr[1]) add(tfr[2]!);
    return out;
  }
  if (isHostlessModule(written)) {
    add(...DEFAULT_REGISTRIES.map((h) => `${h}/${written}`));
    return out;
  }
  const hostless = atDefaultRegistry(written);
  if (hostless && isHostlessModule(hostless)) add(hostless, ...DEFAULT_REGISTRIES.map((h) => `${h}/${hostless}`));
  return out;
}

/**
 * The module a pin-free source names, written one way: a registry source
 * with no host gets the public registry's (or the binary's), a host is
 * lower-cased, and Terragrunt's `tfr:///ns/name/system` and
 * `tfr://host/ns/name/system` become the plain registry form. Other sources
 * (git, OCI, an archive URL) are kept as they are. Moved from
 * ../pin/consumers.ts (chant#4599).
 */
export function normalizeModuleSource(module: string, binary: SourceBinary = "terraform"): string {
  let s = module.trim();
  const tfr = /^tfr:\/\/([^/]*)\/(.*)$/.exec(s);
  if (tfr) s = `${tfr[1] || defaultRegistryHost(binary)}/${tfr[2]}`;
  const [base, ...rest] = s.split("//");
  const parts = base!.split("/");
  const registryShaped = (n: number) => parts.length === n && parts.every((p) => p.length > 0) && !base!.includes(":");
  if (registryShaped(3) && !/[.]/.test(parts[0]!)) return [`${defaultRegistryHost(binary)}/${base}`, ...rest].join("//");
  const reg = parts.length === 4 ? parseRegistrySource(base!) : undefined;
  if (reg) return [`${reg.host}/${parts.slice(1).join("/")}`, ...rest].join("//");
  return s;
}

/** A provider address's parts. */
export interface ProviderAddress {
  host: string;
  namespace: string;
  type: string;
  /** `<host>/<namespace>/<type>`. */
  address: string;
}

const PROVIDER_PART = /^[0-9a-z](?:[0-9a-z_-]{0,62}[0-9a-z])?$/;
const HOST = /^[a-z0-9.-]+(?::\d+)?$/;

/**
 * A `required_providers` source in its full form, `<host>/<namespace>/<type>`,
 * lower case, with the binary's default host when it names none and the
 * `hashicorp` namespace when it names only a type. Undefined for a string
 * that is not a provider address.
 */
export function parseProviderAddress(source: string, binary: SourceBinary = "terraform"): ProviderAddress | undefined {
  const parts = source.trim().toLowerCase().split("/");
  let host: string, namespace: string, type: string;
  if (parts.length === 1) [host, namespace, type] = [defaultRegistryHost(binary), "hashicorp", parts[0]!];
  else if (parts.length === 2) [host, namespace, type] = [defaultRegistryHost(binary), parts[0]!, parts[1]!];
  else if (parts.length === 3) [host, namespace, type] = parts as [string, string, string];
  else return undefined;
  if (!HOST.test(host) || !PROVIDER_PART.test(namespace) || !PROVIDER_PART.test(type)) return undefined;
  return { host, namespace, type, address: `${host}/${namespace}/${type}` };
}

/** {@link parseProviderAddress}'s full form, or undefined. */
export const providerAddress = (source: string, binary: SourceBinary = "terraform"): string | undefined => parseProviderAddress(source, binary)?.address;

/**
 * The provider `init` installs for a local name that has no
 * `required_providers` entry: `hashicorp/<name>`. Undefined for the binary's
 * own `terraform` provider (terraform_data, terraform_remote_state), which is
 * never downloaded.
 */
export const impliedProvider = (local: string): string | undefined => (local === "terraform" ? undefined : `hashicorp/${local.toLowerCase()}`);

/**
 * Every form a provider address matches as: in lower case as written, and,
 * when written without a host or at a default registry, its hostless form
 * and its form at each default registry.
 */
export function providerAddressForms(source: string): string[] {
  const a = source.trim().toLowerCase();
  const out = [a];
  const add = (...forms: string[]) => {
    for (const f of forms) if (!out.includes(f)) out.push(f);
  };
  const hostless = a.split("/").length === 2 ? a : a.split("/").length === 1 && a ? `hashicorp/${a}` : atDefaultRegistry(a);
  if (hostless && hostless.split("/").length === 2) add(hostless, ...DEFAULT_REGISTRIES.map((h) => `${h}/${hostless}`));
  return out;
}

/**
 * The provider addresses a `.terraform.lock.hcl` names, in the order
 * written, as the lock file writes them (the full form). Read by text: the
 * lock file is generated and every entry is a `provider "<address>" {` line.
 */
export function lockedProviders(lockText: string): string[] {
  const out: string[] = [];
  for (const m of lockText.matchAll(/^\s*provider\s+"([^"]+)"\s*\{/gm)) {
    const a = m[1]!.toLowerCase();
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

