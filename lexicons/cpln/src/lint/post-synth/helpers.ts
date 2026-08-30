/**
 * Shared reading and parsing for the CPL post-synth checks.
 *
 * Each check lives in its own file named for its id, so `CPL027` is greppable
 * to one place. What they have in common lands here rather than being repeated
 * or, worse, drifting: the workload-type default, the port enumeration that has
 * to span both `port` and `ports`, and the quantity parsers.
 *
 * Named `helpers.ts` deliberately — the completeness checker's post-synth count
 * excludes that filename, so a support module is not miscounted as a check.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { readArray, readNumber, readPath, readString } from "../../entity-props";
import { kindByName } from "../../kinds";

export const WORKLOAD = kindByName("workload")!.typeName;
export const GVC = kindByName("gvc")!.typeName;
export const POLICY = kindByName("policy")!.typeName;
export const DOMAIN = kindByName("domain")!.typeName;
export const VOLUMESET = kindByName("volumeset")!.typeName;

/** Control Plane defaults an unset workload type to `serverless`. */
export function workloadType(entity: unknown): string {
  return readString(entity, "spec", "type") ?? "serverless";
}

/** The autoscaling block from `defaultOptions`. */
export function autoscalingOf(entity: unknown): unknown {
  return readPath(entity, "spec", "defaultOptions", "autoscaling");
}

/** Every port a workload's containers expose, across both `port` and `ports`. */
export function exposedPorts(entity: unknown): number[] {
  const ports: number[] = [];
  for (const container of readArray(entity, "spec", "containers")) {
    const single = readNumber(container, "port");
    if (single !== undefined) ports.push(single);
    for (const port of readArray(container, "ports")) {
      const number = readNumber(port, "number");
      if (number !== undefined) ports.push(number);
    }
  }
  return ports;
}

/** Parse a CPU quantity (`"50m"`, `"1"`, `"1.5"`) to millicores. */
export function parseCpuMillicores(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d+(?:\.\d+)?)(m?)$/.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  return match[2] === "m" ? amount : amount * 1000;
}

/** Parse a memory quantity (`"128Mi"`, `"1Gi"`, `"512M"`) to MiB. */
export function parseMemoryMib(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const factors: Record<string, number> = {
    Ki: 1 / 1024,
    Mi: 1,
    Gi: 1024,
    Ti: 1024 * 1024,
    // Decimal suffixes, converted to MiB so one comparison covers both families.
    K: 1000 / (1024 * 1024),
    M: 1_000_000 / (1024 * 1024),
    G: 1_000_000_000 / (1024 * 1024),
    T: 1_000_000_000_000 / (1024 * 1024),
  };
  const suffix = match[2];
  if (!suffix) return amount / (1024 * 1024); // bare bytes
  return amount * factors[suffix];
}

/**
 * The tag of an image reference, or undefined when untagged.
 *
 * A colon in a registry host's port (`registry:5000/app`) is not a tag, so only
 * a colon after the last slash counts.
 */
export function imageTag(image: string): string | undefined {
  const lastSlash = image.lastIndexOf("/");
  const colon = image.indexOf(":", lastSlash + 1);
  return colon === -1 ? undefined : image.slice(colon + 1);
}

export interface ParsedLink {
  kind: string;
  name: string;
  gvc?: string;
}

/** `//gvc/prod/identity/api` → kind `identity`, name `api`, gvc `prod`. */
const GVC_SCOPED_LINK = /^\/\/gvc\/([^/]+)\/([a-z]+)\/([^/]+)$/;
/** `//secret/db-password` → kind `secret`, name `db-password`. */
const ORG_SCOPED_LINK = /^\/\/([a-z]+)\/([^/]+)$/;

/** Parse a Control Plane link, or return undefined if it is not one. */
export function parseLink(value: string): ParsedLink | undefined {
  const scoped = GVC_SCOPED_LINK.exec(value);
  if (scoped) return { gvc: scoped[1], kind: scoped[2], name: scoped[3] };

  const org = ORG_SCOPED_LINK.exec(value);
  if (org) return { kind: org[1], name: org[2] };

  return undefined;
}

/** Iterate entities of one type. Re-exported so checks import one module. */
export { entitiesOfType } from "../../entity-props";
export type { Declarable };
