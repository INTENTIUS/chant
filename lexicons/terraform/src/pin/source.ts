/**
 * Where a module call keeps its pin, and how the pin moves (#3189).
 *
 * A module call names a module and, if it is pinned, one exact version of it.
 * The version sits in one of two places:
 *
 * - the `version` argument, beside a registry `source`
 *   (`source = "app.terraform.io/acme/vpc/aws"`, `version = "1.3.0"`);
 * - a query argument of the `source` itself: OpenTofu's `oci://` sources take
 *   `?tag=` or `?digest=`, a git source takes `?ref=`, and Terragrunt's
 *   `tfr://` source takes `?version=`.
 *
 * The module's identity is the source with the pin taken out, so
 * `oci://r.example.com/m/vpc?tag=1.3.0` and `oci://r.example.com/m/vpc?tag=1.4.0`
 * call the same module.
 *
 * A `version` constraint (`~> 1.4`, `>= 1.4, < 2`) is not a pin. An upstream
 * release changes what such a root runs with no diff to review, and there is
 * no single version to move, so the call is refused with that reason. The
 * same holds for a call with no pin at all.
 *
 * OpenTofu writes an OCI pin as a query argument
 * (https://opentofu.org/docs/language/modules/sources/#oci-distribution-registries),
 * not as a `:tag` or `@sha256:` suffix on the repository, so the query form is
 * the one read here.
 *
 * This module is pure string work over values the HCL reader has already
 * parsed. Finding those values in a file, and writing the new ones back, is
 * `./edit.ts`. #3190 adds an `oci` kind to the lint classifier
 * (`../lint/post-synth/module-source.ts`) with the same parse; the two can
 * share one once both have landed.
 */

/** The query arguments that carry a pin. */
export type PinParam = "tag" | "digest" | "ref" | "version";

/** What a module call pins, read from its `source` and `version`. */
export interface ModuleCallPin {
  /** The module the call names: its `source` with the pin argument taken out. */
  module: string;
  /** Where the pin is: the `version` argument, or a query argument of `source`. */
  at: "version" | "source";
  /** The query argument holding the pin, when `at` is `source`. */
  param?: PinParam;
  /** The pinned version, tag, digest or ref. Null when there is no pin to move. */
  pin: string | null;
  /** Why the call has no pin to move, when `pin` is null. */
  unpinned?: string;
}

/** The outcome of moving one call's pin. */
export type PinMove =
  | { outcome: "moved"; from: string; to: string; source: string; version?: string }
  | { outcome: "already"; pin: string }
  | { outcome: "elsewhere"; pin: string }
  | { outcome: "refused"; reason: string };

/** `1.4.0`, `v1.4.0`, `1.4`, `1.4.0-rc.1+build.5`: one exact version. */
const EXACT_VERSION = /^v?\d+(\.\d+){0,2}(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** An OCI digest, `sha256:<hex>`. */
const DIGEST = /^[a-z0-9]+(?:[.+_-][a-z0-9]+)*:[0-9a-fA-F]{32,}$/;

/**
 * The exact version a `version` argument pins, or null when it is a
 * constraint. `1.4.0` and `= 1.4.0` are exact; `~> 1.4`, `>= 1.4` and
 * `1.4.0, < 2` are not.
 */
export function exactVersion(constraint: string): string | null {
  const trimmed = constraint.trim().replace(/^=\s*/, "");
  return EXACT_VERSION.test(trimmed) ? trimmed : null;
}

/** Whether a value can be a pin's new value: an exact version, a tag, a ref or a digest, never a constraint. */
export function isPinValue(value: string): boolean {
  return value.length > 0 && !/[\s,<>~!=*^]/.test(value);
}

interface SplitSource {
  base: string;
  params: Array<{ key: string; value: string | undefined; raw: string }>;
}

function splitSource(source: string): SplitSource {
  const q = source.indexOf("?");
  if (q < 0) return { base: source, params: [] };
  const params = source
    .slice(q + 1)
    .split("&")
    .filter((raw) => raw.length > 0)
    .map((raw) => {
      const eq = raw.indexOf("=");
      return eq < 0 ? { key: raw, value: undefined, raw } : { key: raw.slice(0, eq), value: decode(raw.slice(eq + 1)), raw };
    });
  return { base: source.slice(0, q), params };
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function joinSource(base: string, raws: string[]): string {
  return raws.length === 0 ? base : `${base}?${raws.join("&")}`;
}

function isLocal(source: string): boolean {
  return source.startsWith("./") || source.startsWith("../");
}

function isOci(source: string): boolean {
  return source.startsWith("oci://");
}

function isGit(source: string): boolean {
  return source.startsWith("git::") || source.startsWith("git@") || /^(github\.com|bitbucket\.org)\//.test(source) || /\.git(\/\/|\?|$)/.test(source);
}

/** Read the pin a module call carries. `version` is the call's `version` argument, when it has one. */
export function readModulePin(source: string, version?: string): ModuleCallPin {
  const call = readPin(source, version);
  if (call.pin !== null && /[$%]\{/.test(call.pin)) {
    return { ...call, pin: null, unpinned: `the pin "${call.pin}" is an expression, so there is no literal version to move` };
  }
  return call;
}

function readPin(source: string, version?: string): ModuleCallPin {
  if (version !== undefined) {
    const exact = exactVersion(version);
    return exact
      ? { module: source, at: "version", pin: exact }
      : { module: source, at: "version", pin: null, unpinned: `version "${version}" is a constraint, not a pin: there is no one version to move` };
  }
  const { base, params } = splitSource(source);
  const keep = (taken: string) => joinSource(base, params.filter((p) => p.key !== taken).map((p) => p.raw));
  const find = (key: PinParam) => params.find((p) => p.key === key);

  if (isOci(source)) {
    const tag = find("tag");
    const digest = find("digest");
    if (tag && digest) return { module: joinSource(base, params.filter((p) => p.key !== "tag" && p.key !== "digest").map((p) => p.raw)), at: "source", pin: null, unpinned: "the oci source names both a tag and a digest" };
    const p = digest ?? tag;
    if (!p || !p.value) return { module: source, at: "source", pin: null, unpinned: "the oci source names no tag or digest, so it resolves whatever the registry calls latest" };
    return { module: keep(p.key), at: "source", param: p.key as PinParam, pin: p.value };
  }
  const ref = find("ref");
  if (ref?.value) return { module: keep("ref"), at: "source", param: "ref", pin: ref.value };
  const ver = find("version");
  if (ver?.value) {
    const exact = exactVersion(ver.value);
    return exact
      ? { module: keep("version"), at: "source", param: "version", pin: exact }
      : { module: keep("version"), at: "source", param: "version", pin: null, unpinned: `version "${ver.value}" is a constraint, not a pin: there is no one version to move` };
  }
  if (isLocal(source)) return { module: source, at: "source", pin: null, unpinned: "a local path has no version to pin" };
  if (isGit(source)) return { module: source, at: "source", pin: null, unpinned: "the git source names no ref, so it follows the default branch" };
  return { module: source, at: "source", pin: null, unpinned: "the source has no version argument and no pin in its address, so it resolves the newest release" };
}

/** Replace one query argument's value, keeping every other byte of the source. */
function withParam(source: string, from: PinParam, to: PinParam, value: string): string {
  const { base, params } = splitSource(source);
  return joinSource(
    base,
    params.map((p) => (p.key === from ? `${to}=${value}` : p.raw)),
  );
}

/**
 * Move a call's pin from `from` to `to`, when the call names `module`.
 * Returns null when it names another module. `version` keeps any `=` it was
 * written with, so `= 1.3.0` becomes `= 1.4.0`.
 */
export function movePin(source: string, version: string | undefined, request: { module: string; from: string; to: string }): PinMove | null {
  const call = readModulePin(source, version);
  if (call.module !== request.module) return null;
  if (call.pin === null) return { outcome: "refused", reason: call.unpinned ?? "no pin" };
  if (call.pin === request.to) return { outcome: "already", pin: call.pin };
  if (call.pin !== request.from) return { outcome: "elsewhere", pin: call.pin };
  if (call.at === "version") {
    const at = version!.lastIndexOf(call.pin);
    return { outcome: "moved", from: request.from, to: request.to, source, version: version!.slice(0, at) + request.to + version!.slice(at + call.pin.length) };
  }
  // An oci pin moving between a tag and a digest changes which argument holds it.
  const param: PinParam = call.param === "tag" || call.param === "digest" ? (DIGEST.test(request.to) ? "digest" : "tag") : call.param!;
  return { outcome: "moved", from: request.from, to: request.to, source: withParam(source, call.param!, param, request.to) };
}

/** The module a source names, with any pin taken out, so a caller may name the module by a pinned source. */
export function moduleOf(source: string): string {
  return readModulePin(source).module;
}

/** Refuse a request whose `to` is not something a pin can hold. */
export function checkPinRequest(request: { module: string; from: string; to: string }): void {
  for (const [name, value] of [["from", request.from], ["to", request.to]] as const) {
    if (!isPinValue(value)) throw new Error(`pin ${name} "${value}" is not an exact version, tag, ref or digest`);
  }
  if (request.from === request.to) throw new Error(`pin from and to are both "${request.to}": there is nothing to move`);
  if (request.module.length === 0) throw new Error("pin module is empty: name the module's source without its pin");
}
