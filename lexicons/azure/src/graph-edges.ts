/**
 * References written as ARM expressions, as graph edges (#4232).
 *
 * `chant graph` draws an edge for every `AttrRef` it finds in props, but an
 * Azure reference is often an expression instead: `reference(resourceId(...))
 * .customerId` and `listKeys(...)` for a value the resource has no attribute
 * for, or a `resourceId(...)` used as an object key, which is how
 * `identity.userAssignedIdentities` names an identity. The serializer already
 * reads these to write `dependsOn` (./serializer.ts), with
 * `findArmResourceRefs` (./lint/post-synth/arm-refs.ts). This module runs the
 * same extraction over each prop as the template writes it and reports each
 * reference to a declared resource through the plugin's `graphEdges` hook.
 *
 * A reference matches by resource name, never by type, as the serializer's
 * inference does. A name nothing in the project declares is left out: it is
 * an existing resource the template reads, not a dangling reference.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { isPropertyDeclarable, isResourceDeclarable } from "@intentius/chant/declarable";
import type { LexiconGraphEdges, LexiconGraphReference } from "@intentius/chant/graph-ir";
import { findArmResourceRefs } from "./lint/post-synth/arm-refs";
import { armResourceName, toArmValue } from "./serializer";

function isAzureResource(entity: Declarable): boolean {
  return entity.lexicon === "azure" && isResourceDeclarable(entity) && !isPropertyDeclarable(entity);
}

export function azureGraphEdges(entities: ReadonlyMap<string, Declarable>): LexiconGraphEdges | undefined {
  const entityNames = new Map<Declarable, string>();
  for (const [key, entity] of entities) entityNames.set(entity, key);

  // Template name -> entity key, for the resources whose name is a literal.
  const byArmName = new Map<string, string>();
  for (const [key, entity] of entities) {
    if (!isAzureResource(entity)) continue;
    const name = armResourceName(entity, key, entityNames);
    if (typeof name === "string") byArmName.set(name, key);
  }
  if (byArmName.size === 0) return undefined;

  const references: LexiconGraphReference[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string | undefined, viaAttr: string): void => {
    if (!to || to === from) return;
    const id = `${from}\0${to}\0${viaAttr}`;
    if (seen.has(id)) return;
    seen.add(id);
    references.push({ from, to, kind: "ref", viaAttr });
  };

  for (const [key, entity] of entities) {
    if (!isAzureResource(entity)) continue;
    const props = (entity as { props?: unknown }).props;
    if (props && typeof props === "object") {
      for (const [attr, value] of Object.entries(props as Record<string, unknown>)) {
        if (value === undefined) continue;
        for (const ref of findArmResourceRefs(toArmValue(value, entityNames))) {
          add(key, byArmName.get(ref), attr);
        }
      }
    }
    // A child resource named "vnet/subnet" depends on "vnet", as the
    // serializer infers for dependsOn.
    const name = armResourceName(entity, key, entityNames);
    if (typeof name === "string" && name.includes("/")) {
      add(key, byArmName.get(name.split("/")[0]), "name");
    }
  }

  return references.length > 0 ? { references } : undefined;
}
