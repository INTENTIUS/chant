/**
 * ARM resource types as ARM spells them (#4230).
 *
 * The lexicon's entity types come from the ARM schema ids, which join a child
 * type to its parent with `_` (`Microsoft.Network/virtualNetworks_subnets`).
 * ARM itself joins them with `/` (`Microsoft.Network/virtualNetworks/subnets`),
 * in a template's `type`, in `resourceId()` and in the resource URL. Resource
 * type segments never contain `_`, so every `_` after the namespace is a
 * child separator.
 */

/** `Microsoft.Network/virtualNetworks_subnets` → `Microsoft.Network/virtualNetworks/subnets`. Idempotent. */
export function armType(entityType: string): string {
  const slash = entityType.indexOf("/");
  if (slash < 0) return entityType;
  return entityType.slice(0, slash + 1) + entityType.slice(slash + 1).replace(/_/g, "/");
}

/**
 * The provider-relative path of one resource: each type segment followed by
 * its name segment, as ARM's `resourceId()` builds it.
 * `('Microsoft.Network/virtualNetworks/subnets', 'vnet/apps')` →
 * `Microsoft.Network/virtualNetworks/vnet/subnets/apps`. A name with fewer
 * segments than the type has kinds is joined as given.
 */
export function armResourcePath(type: string, name: string): string {
  const [namespace, ...kinds] = armType(type).split("/");
  const names = name.split("/");
  if (kinds.length <= 1 || names.length !== kinds.length) return `${armType(type)}/${name}`;
  return [namespace, ...kinds.flatMap((kind, i) => [kind, names[i]])].join("/");
}
