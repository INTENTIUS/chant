/**
 * `chant components pr-plan --target` (#4620): the addresses each planned
 * member's capability plan narrows to, from repeatable `--target` values.
 *
 * A value whose text before the first `:` names a component is that
 * component's: `--target net:aws_s3_bucket.logs`. Any other value is a bare
 * address and narrows every member the pull request plans: `--target
 * aws_s3_bucket.logs`, or a Pulumi URN, `--target
 * urn:pulumi:prod::app::aws:s3/bucket:Bucket::logs`, whose `urn` names no
 * component. Each capability passes the addresses to its engine (terraform
 * `-target`, pulumi `--target`); a capability that cannot narrow refuses by
 * name before anything plans ({@link assertTargetsAccepted} in ./driver.ts).
 *
 * A value that names a component the pull request does not plan is refused,
 * since nothing would narrow. With nothing planned, a bare address narrows
 * nothing and is dropped.
 */

/** The addresses by component, each list sorted and unique, or why the values are refused. */
export function prPlanTargets(values: readonly string[], planned: readonly string[], known: ReadonlySet<string>): { targets: Record<string, string[]> } | { error: string } {
  const plannedSet = new Set(planned);
  const out = new Map<string, Set<string>>();
  const add = (component: string, address: string) => {
    let set = out.get(component);
    if (!set) out.set(component, (set = new Set()));
    set.add(address);
  };
  for (const raw of values) {
    const value = raw.trim();
    if (value === "") return { error: "--target needs an address: --target <address> or --target <member>:<address>" };
    const at = value.indexOf(":");
    const named = at > 0 ? value.slice(0, at).trim() : "";
    if (named !== "" && known.has(named)) {
      const address = value.slice(at + 1).trim();
      if (address === "") return { error: `--target ${value}: name an address after ${named}:` };
      if (!plannedSet.has(named)) {
        return { error: `--target ${value}: this pull request does not plan ${named} (it plans ${[...plannedSet].sort().join(", ") || "nothing"})` };
      }
      add(named, address);
      continue;
    }
    for (const component of planned) add(component, value);
  }
  return { targets: Object.fromEntries([...out.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([c, s]) => [c, [...s].sort()])) };
}
