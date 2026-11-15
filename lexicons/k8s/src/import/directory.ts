/**
 * Which files of a directory `chant import <directory>` reads as manifests
 * (#5115).
 *
 * The rules of the `manifests` workspace member apply (../manifest-files.ts):
 * a chart template is skipped, and a kustomization is not an object. The
 * rest differ on purpose.
 *
 * - The walk is recursive. A member is one directory of a workspace; an
 *   import is the whole tree under the directory it is given.
 * - A directory a kustomization lists in `resources` is read like any other.
 *   The graph skips it because the kustomize member renders it and its
 *   objects would count twice; an import renders nothing, so each file is
 *   read once.
 * - A directory with a kustomization reads only the files that kustomization
 *   lists in `resources`. The others are patches, generators' inputs and
 *   values files, which are not whole objects, and the import cannot apply
 *   them. `chant import --kustomize <dir>` imports the rendered result.
 */
import { readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { loadAll } from "js-yaml";
import { hasMappingKey, isKustomizeConfig, KUSTOMIZATION_FILES } from "../manifest-files";

const posix = (p: string): string => p.split("\\").join("/");

function documents(file: string): Array<Record<string, unknown>> | undefined {
  try {
    return loadAll(readFileSync(file, "utf-8")).filter(
      (d): d is Record<string, unknown> => d !== null && typeof d === "object" && !Array.isArray(d),
    );
  } catch {
    return undefined;
  }
}

/** The files a kustomization lists in `resources` and `bases`, absolute. Undefined when it does not parse. */
function listedBy(file: string): Set<string> | undefined {
  const doc = documents(file)?.[0] as { resources?: unknown; bases?: unknown } | undefined;
  if (!doc) return undefined;
  const listed = new Set<string>();
  for (const list of [doc.resources, doc.bases]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry === "string" && !/^[a-z][a-z0-9+.-]*:/i.test(entry)) listed.add(resolve(dirname(file), entry));
    }
  }
  return listed;
}

export function selectManifestFiles(input: { directory: string; files: string[] }): { files: string[]; warnings: string[] } {
  const { directory } = input;
  const rel = (file: string): string => posix(relative(directory, file)) || ".";
  const warnings: string[] = [];

  // The kustomization in each directory, and what it lists.
  const kustomizations = new Map<string, { file: string; listed: Set<string> | undefined; unlisted: string[] }>();
  for (const file of input.files) {
    if (!KUSTOMIZATION_FILES.includes(basename(file))) continue;
    // A Flux Kustomization is an object, whatever the file is called; a kustomization often has no apiVersion or kind at all.
    const first = documents(file)?.[0];
    if (first && typeof first.kind === "string" && !isKustomizeConfig(first)) continue;
    kustomizations.set(dirname(file), { file, listed: listedBy(file), unlisted: [] });
  }
  const governing = (file: string): string | undefined => {
    for (let dir = dirname(file); ; dir = dirname(dir)) {
      if (kustomizations.has(dir)) return dir;
      if (dir === directory || dir === dirname(dir)) return undefined;
    }
  };

  const selected: string[] = [];
  for (const file of input.files) {
    if (kustomizations.get(dirname(file))?.file === file) continue;
    const docs = documents(file);
    // A file that does not parse is left to the importer, which names it.
    if (!docs) {
      selected.push(file);
      continue;
    }
    const objects = docs.filter((d) => typeof d.apiVersion === "string" && typeof d.kind === "string");
    if (objects.length > 0 && objects.every(isKustomizeConfig)) continue;
    if (docs.some(hasMappingKey)) {
      warnings.push(`${rel(file)} holds template syntax ({{ ... }}) and was skipped.`);
      continue;
    }
    const owner = governing(file);
    const kustomization = owner === undefined ? undefined : kustomizations.get(owner)!;
    if (kustomization?.listed && !kustomization.listed.has(file)) {
      kustomization.unlisted.push(rel(file));
      continue;
    }
    selected.push(file);
  }

  for (const { file, unlisted } of kustomizations.values()) {
    const left = unlisted.length === 0 ? "" : ` ${unlisted.length} file${unlisted.length === 1 ? "" : "s"} it does not list in resources (${unlisted.join(", ")}) ${unlisted.length === 1 ? "was" : "were"} skipped.`;
    warnings.push(
      `${rel(file)} is not an object and was skipped; its patches, generators and transformers are not applied.${left} ` +
        `Use chant import --kustomize ${rel(dirname(file))} to import the rendered result.`,
    );
  }
  return { files: selected, warnings };
}
