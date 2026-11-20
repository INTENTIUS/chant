/**
 * `StackReference` reads between workspace members (#5331), for `chant
 * workspace graph`. The graph composition asks the lexicon once with every
 * declared member; each member of kind `pulumi` is a step of the same shape
 * `pulumi-up` takes (`dir`, `stack`), and {@link pulumiStackReads}, the
 * reader behind `declaredReads` and `graphReads`, finds its references. A
 * reference to the stack another member applies is a read of that member; one
 * to a stack no member applies is external.
 *
 * A member's stack is `--env` when the member has a `Pulumi.<env>.yaml`
 * (the stack the environment deploys), else the stack its checked-in export
 * records. A member with neither takes part in no read. The node each member
 * is drawn as is `pulumi:pulumi:Stack`, the type token of the stack's own
 * resource, which the member read leaves out.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { LexiconStackReads } from "@intentius/chant/lexicon";
import { PULUMI_STACK_TYPE } from "@intentius/chant/pulumi-urn";
import { pulumiStackReads } from "./pulumi-up";
import { PULUMI_EXPORT_FILE } from "./member-report";
import { isObject } from "./values";

/** The stack a checked-in export records: the stack of its first URN (`urn:pulumi:<stack>::<project>::...`). */
function exportedStack(dir: string): string | undefined {
  try {
    const doc: unknown = JSON.parse(readFileSync(join(dir, PULUMI_EXPORT_FILE), "utf-8"));
    const list = isObject(doc) && isObject(doc.deployment) && Array.isArray(doc.deployment.resources) ? doc.deployment.resources : [];
    for (const r of list) {
      const urn = isObject(r) && typeof r.urn === "string" ? r.urn : undefined;
      const m = urn ? /^urn:pulumi:([^:]+)::/.exec(urn) : undefined;
      if (m) return m[1];
    }
  } catch {
    // No readable export: the member has no stack to name.
  }
  return undefined;
}

export async function pulumiWorkspaceStackReads(
  ctx: { root: string; env?: string; members: readonly { name: string; dir: string; kind: string }[] },
  opts: { exportStore?: null } = {},
): Promise<LexiconStackReads | undefined> {
  const steps = ctx.members
    .filter((m) => m.kind === "pulumi")
    .map((m) => {
      const dir = isAbsolute(m.dir) ? m.dir : resolve(ctx.root, m.dir);
      const stack = ctx.env && existsSync(join(dir, `Pulumi.${ctx.env}.yaml`)) ? ctx.env : exportedStack(dir);
      return stack === undefined ? undefined : { component: m.name, index: 0, step: { dir, stack } };
    })
    .filter((s): s is NonNullable<typeof s> => s !== undefined);
  if (steps.length === 0) return undefined;
  const reads = await pulumiStackReads({ root: ctx.root }, steps, opts);
  return {
    lexicon: "pulumi",
    stacks: steps.map((s) => ({ member: s.component, id: PULUMI_STACK_TYPE, kind: PULUMI_STACK_TYPE, attrs: { stack: s.step.stack } })),
    reads: reads.flatMap((r) => {
      const where = "upstream" in r.target ? { upstream: r.target.upstream } : { external: r.target.external };
      const outputs = [...r.outputs, ...r.secretOutputs].sort();
      return outputs.length === 0 ? [{ reader: r.reader, ...where }] : outputs.map((output) => ({ reader: r.reader, ...where, output }));
    }),
  };
}
