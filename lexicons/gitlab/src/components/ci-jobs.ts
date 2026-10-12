/**
 * The GitLab CI pieces the three generators share (#3765): the Op pipeline
 * (`./generate-op-pipeline.ts`), the Op waves pipeline
 * (`./generate-op-waves-pipeline.ts`) and the component pipeline
 * (`./generate-pipeline.ts`). The `rules:` expressions, `id_tokens:`, setup
 * and environment checks are core's, in `@intentius/chant/ci-jobs`.
 */

import { emitYAMLEntry } from "@intentius/chant/yaml";

/**
 * A `.gitlab-ci.yml` document: the comment header, when there is one, then
 * each top-level entry in the order given, a blank line between each.
 */
export function emitGitlabFile(entries: ReadonlyArray<readonly [string, unknown]>, header: readonly string[] = []): string {
  const body = entries.map(([key, value]) => emitYAMLEntry(key, value)).join("\n\n") + "\n";
  return header.length > 0 ? header.join("\n") + "\n\n" + body : body;
}
