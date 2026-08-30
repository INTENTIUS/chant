/**
 * Read a CDK cloud assembly off disk (#1056).
 *
 * The only filesystem layer the CDK advisor needs. Detection is by content, not
 * a flag: a directory holding `manifest.json` plus at least one
 * `*.template.json` is a cloud assembly, so `chant carve advise --from ./cdk.out`
 * routes itself.
 *
 * A malformed or truncated assembly degrades rather than throws — a stack whose
 * template will not parse is dropped with a diagnostic, and the rest is still
 * ranked. The advisor is read-only, so a partial read costs nothing but a
 * shorter report.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { CdkManifest, CdkStack, CdkTreeFile, CdkTreeNode, CfnTemplate, CloudAssembly } from "./types";

/** Every `*.template.json` directly under `dir`. */
function listTemplates(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".template.json"))
    .sort();
}

/**
 * Is `dir` a CDK cloud assembly? `manifest.json` plus at least one synthesized
 * template. Both are required: `manifest.json` alone is far too common a
 * filename to claim on sight.
 */
export function isCloudAssembly(dir: string): boolean {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
    if (!existsSync(join(dir, "manifest.json"))) return false;
    return listTemplates(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Why a Terraform-only carve phase refuses a cloud assembly (#1056).
 *
 * Advise is the only phase that reads CDK. Bridging a carve means rewriting the
 * surviving app's source so it reimports what was taken, and CDK source is
 * TypeScript, Python, Java or C# depending on who wrote it — nothing that
 * generalizes the way patching HCL does. Better to say so than to parse the
 * assembly's `.tf` files, find none, and report an empty estate.
 */
export function cdkNotSupported(dir: string, phase: "emit" | "bridge" | "apply"): string {
  return (
    `${dir} is a CDK cloud assembly, and \`chant carve ${phase}\` reads Terraform. ` +
    `\`chant carve advise --from ${dir}\` ranks it read-only; emit, bridge and apply are Terraform-only.`
  );
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * The stack's construct path. `displayName` carries it when the stack sits in a
 * Stage (`Stage/AppStack` for artifact id `Stage-AppStack`); otherwise the
 * artifact id is the path.
 */
function stackPath(id: string, displayName?: string): string {
  return typeof displayName === "string" && displayName.length > 0 ? displayName : id;
}

/** Index `tree.json` by construct path, so a resource's path resolves in one lookup. */
export function indexTree(root: CdkTreeNode | undefined): Map<string, CdkTreeNode> {
  const byPath = new Map<string, CdkTreeNode>();
  const visit = (node: CdkTreeNode): void => {
    if (typeof node.path === "string") byPath.set(node.path, node);
    for (const child of Object.values(node.children ?? {})) visit(child);
  };
  if (root) visit(root);
  return byPath;
}

/**
 * Read the assembly at `dir`. Throws only when the directory is not an assembly
 * at all — everything past that point is a diagnostic.
 */
export function readCloudAssembly(dir: string): CloudAssembly {
  const diagnostics: string[] = [];
  const manifest = readJson<CdkManifest>(join(dir, "manifest.json"));
  if (!manifest) {
    throw new Error(`${join(dir, "manifest.json")} is not readable JSON — not a CDK cloud assembly.`);
  }

  const tree = readJson<CdkTreeFile>(join(dir, "tree.json"))?.tree;
  if (!tree) {
    diagnostics.push(
      "No tree.json in the assembly — CloudFormation resources are grouped by their construct path alone, " +
        "so sibling constructs of one L2 (a function's role and policy, say) rank separately instead of folding in.",
    );
  }

  const stacks: CdkStack[] = [];
  const artifacts = Object.entries(manifest.artifacts ?? {});
  for (const [id, artifact] of artifacts) {
    if (artifact?.type !== "aws:cloudformation:stack") continue;
    const templateFile = artifact.properties?.templateFile;
    if (typeof templateFile !== "string") {
      diagnostics.push(`Stack artifact ${id} names no templateFile — skipped.`);
      continue;
    }
    const template = readJson<CfnTemplate>(join(dir, templateFile));
    if (!template) {
      diagnostics.push(`Could not read ${templateFile} for stack ${id} — skipped.`);
      continue;
    }
    stacks.push({ id, path: stackPath(id, artifact.displayName), templateFile, template });
  }

  if (stacks.length === 0) {
    // Templates exist (isCloudAssembly said so) but no artifact claims them —
    // an assembly written by something other than `cdk synth`, or a manifest
    // from a version this does not understand. Say so rather than reporting an
    // empty estate as if the app were empty.
    diagnostics.push(
      "The manifest declares no aws:cloudformation:stack artifacts, so no template was ranked. " +
        "Re-synthesize with `cdk synth` and point --from at the resulting cdk.out.",
    );
  }

  return { dir, manifest, tree, stacks: stacks.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), diagnostics };
}
