/**
 * behold#1029: a listed node's id, ruled on behold#1025 (Q2):
 * `<substrate>/<scopeId>/<location>/<listedType>/<nativeId>`.
 *
 * Several of those parts carry `/` of their own: a Kubernetes type
 * (`apps/v1/Deployment`), an ARM type (`microsoft.storage/storageaccounts`),
 * and most native ids (an ARM id, `namespace/name`). The id stays readable and
 * parses back by escaping `%` and `/` in the first four parts only. The native
 * id is last, so everything after the fourth separator is it, unescaped: the
 * exact string the aws matcher (chant#4523) compares with `declaredIdentifier`.
 */

import type { Substrate } from "./types";

function escapeSegment(s: string): string {
  return s.replace(/%/g, "%25").replace(/\//g, "%2F");
}

function unescapeSegment(s: string): string {
  return s.replace(/%2F/gi, "/").replace(/%25/g, "%");
}

export interface ListedNodeIdParts {
  substrate: Substrate;
  scopeId: string;
  location: string;
  listedType: string;
  nativeId: string;
}

export function listedNodeId(parts: ListedNodeIdParts): string {
  return [
    escapeSegment(parts.substrate),
    escapeSegment(parts.scopeId),
    escapeSegment(parts.location),
    escapeSegment(parts.listedType),
    parts.nativeId,
  ].join("/");
}

/** The parts back from an id {@link listedNodeId} wrote; `undefined` for anything else. */
export function parseListedNodeId(id: string): ListedNodeIdParts | undefined {
  const parts: string[] = [];
  let rest = id;
  for (let i = 0; i < 4; i++) {
    const at = rest.indexOf("/");
    if (at < 0) return undefined;
    parts.push(unescapeSegment(rest.slice(0, at)));
    rest = rest.slice(at + 1);
  }
  const [substrate, scopeId, location, listedType] = parts;
  if (substrate !== "aws" && substrate !== "azure" && substrate !== "gcp" && substrate !== "kubernetes") return undefined;
  return { substrate, scopeId, location, listedType, nativeId: rest };
}
