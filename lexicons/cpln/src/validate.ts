/**
 * Validate the generated `lexicon-cpln` artifacts.
 *
 * The required-names list is the point of this file: it asserts that a
 * regeneration still produced the surface consumers import. A rename upstream,
 * a parser change that stops following a `$ref`, or a loosened subtree would
 * otherwise leave a smaller generated surface that builds fine and is missing
 * classes nobody notices until an import fails.
 *
 * The list spans all three layers deliberately — the eight resources, property
 * types reached through several different mechanisms (inline nesting, a `$ref`,
 * a `oneOf` branch, an array item), and the deepest shapes the parser walks to.
 * A shallow list of the eight resource names would pass while the entire
 * property-type tree vanished.
 */

import { dirname } from "path";
import { fileURLToPath } from "url";
import { validateLexiconArtifacts, type ValidateResult } from "@intentius/chant/codegen/validate";
import { KINDS } from "./kinds";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

const REQUIRED_NAMES: string[] = [
  // The eight resources.
  ...KINDS.map((kind) => kind.className),

  // Top-level specs — inline on gvc/workload/domain/ipset, a `$ref` on volumeset.
  "GvcSpec",
  "WorkloadSpec",
  "VolumeSetSpec",
  "DomainSpec",
  "IpSetSpec",

  // The workload authoring surface most specs actually use.
  "WorkloadSpecContainers",
  "WorkloadSpecContainersPorts",
  "WorkloadSpecContainersEnv",
  "WorkloadSpecContainersVolumes",
  "WorkloadSpecContainersReadinessProbe",
  "WorkloadSpecContainersReadinessProbeHttpGet",
  "WorkloadSpecContainersLivenessProbe",
  "WorkloadSpecFirewallConfig",
  "WorkloadSpecFirewallConfigExternal",
  "WorkloadSpecFirewallConfigInternal",
  "WorkloadSpecDefaultOptions",
  "WorkloadSpecDefaultOptionsAutoscaling",
  "WorkloadSpecJob",
  "WorkloadSpecLoadBalancer",
  "WorkloadSpecVm",

  // GVC placement and routing.
  "GvcSpecStaticPlacement",
  "GvcSpecStaticPlacementLocationQuery",
  "GvcSpecLoadBalancer",
  "GvcSpecTracing",
  "GvcSpecKeda",

  // Storage.
  "VolumeSetSpecSnapshots",
  "VolumeSetSpecAutoscaling",
  "VolumeSetSpecMountOptions",

  // Domain routing.
  "DomainSpecPorts",
  "DomainSpecPortsRoutes",
  "DomainSpecPortsTls",

  // Identity provider sections — the XOR-ruled shapes.
  "IdentityAws",
  "IdentityGcp",
  "IdentityAzure",
  "NetworkResource",

  // `$ref`'d schemas that keep their upstream name, and the `oneOf` branches of
  // `secret.data`. These are the two naming mechanisms other than path
  // derivation, so their absence would mean the parser stopped following a
  // whole class of reference.
  "Query",
  "PolicyBinding",
  "IpSetLocation",
  "SecretOpaque",
  "SecretTls",
  "SecretKeypair",
  "SecretUserpass",
];

/**
 * Validate the generated artifacts.
 */
export async function validate(opts?: { basePath?: string }): Promise<ValidateResult> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));

  return validateLexiconArtifacts({
    lexiconJsonFilename: "lexicon-cpln.json",
    requiredNames: REQUIRED_NAMES,
    basePath,
  });
}

/** The names `validate` asserts, exported so a test can assert the list itself is deep. */
export const REQUIRED_ARTIFACT_NAMES: readonly string[] = REQUIRED_NAMES;
