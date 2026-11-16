/**
 * The package files a registry target names (#5232): files, directories of
 * them, and `artifact:<name>` for the files the release records for a
 * `release.artifacts` entry, as the nuget and rubygems targets take them.
 */

import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { expandArtifactAssets, memberFile } from "./publish-targets";
import { PublishTargetError, type PublishContext } from "./release-publish";

/**
 * Each file `entries` names, in order: a file as it is, a directory as every
 * file in it whose name ends in `ext`, in name order, and `artifact:<name>` as
 * the release's paths for it. A directory with none is refused with
 * `<code>-no-files`, a file name given twice with `<code>-duplicate-file`.
 */
export function packageFiles(ctx: Pick<PublishContext, "cwd" | "release">, entries: readonly string[], ext: string, code: string, buildFix: string): Array<{ path: string; abs: string }> {
  const out: Array<{ path: string; abs: string }> = [];
  const seen = new Set<string>();
  const add = (path: string) => {
    const abs = memberFile(ctx.cwd, path);
    if (seen.has(basename(abs))) throw new PublishTargetError(`${code}-duplicate-file`, `${basename(abs)} is named twice`, "Name each file once.");
    seen.add(basename(abs));
    out.push({ path, abs });
  };
  for (const entry of expandArtifactAssets(ctx.release, entries)) {
    const abs = memberFile(ctx.cwd, entry);
    if (statSync(abs).isDirectory()) {
      const found = readdirSync(abs).filter((f) => f.endsWith(ext) && statSync(join(abs, f)).isFile()).sort();
      if (found.length === 0) throw new PublishTargetError(`${code}-no-files`, `${entry} holds no ${ext} file`, buildFix);
      for (const f of found) add(join(entry, f));
    } else add(entry);
  }
  return out;
}
