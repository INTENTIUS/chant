// Kept apart from ./graph-ir so ./graph-detail, which runs in the browser
// bundle, can read a Sub template without pulling in node:path.

/**
 * The names a `Sub` template interpolates (#4373): `${Name}` and
 * `${Name.Attr}`, in order. Skips CloudFormation's `${!Literal}` escape,
 * pseudo-parameters (`${AWS::Region}`, anything with `::`), and names the
 * two-argument form's variable map binds, which are not resources.
 */
export function subTemplateRefs(
  template: string,
  bound: ReadonlySet<string> = new Set(),
): Array<{ name: string; attr?: string }> {
  const out: Array<{ name: string; attr?: string }> = [];
  for (const match of template.matchAll(/\$\{([^}]*)\}/g)) {
    const token = match[1].trim();
    if (!token || token.startsWith("!") || token.includes("::") || bound.has(token)) continue;
    const dot = token.indexOf(".");
    out.push(dot > 0 ? { name: token.slice(0, dot), attr: token.slice(dot + 1) } : { name: token });
  }
  return out;
}
