/**
 * Docker lexicon docs generation.
 */

export async function generateDocs(opts?: { verbose?: boolean }): Promise<void> {
  if (opts?.verbose) {
    console.error("Generating Docker lexicon docs...");
  }
  // Docs are currently hand-authored in docs/src/content/docs/
  // Future: auto-generate entity reference pages from lexicon-docker.json
  console.error("Docker docs: see docs/src/content/docs/overview.mdx");
}
