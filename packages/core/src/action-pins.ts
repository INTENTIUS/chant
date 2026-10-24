/**
 * The GitHub Actions the workflows chant generates use, each pinned by commit
 * SHA (#4403). A tag can move; a SHA cannot. Every generator takes its `uses:`
 * from here, so an update is one change to this table. Each row is the commit
 * the named major tag pointed at, with the release that commit carries;
 * `tagComments` writes that release beside each `uses:` line.
 *
 * Forgejo's actions mirror (code.forgejo.org) carries the same commits. The
 * forgejo lexicon moves `upload-artifact` and `download-artifact` to v3, whose
 * rows are here too: v4 and later refuse to run on a Forgejo runner (#4008).
 *
 * Refresh a row by resolving the major tag to its commit:
 *
 *   gh api repos/actions/checkout/commits/v6 --jq .sha
 */

export interface ActionPin {
  /** The action, with its subpath: `actions/cache/restore`. */
  readonly slug: string;
  /** The major tag the row follows, such as `v4`. */
  readonly major: string;
  readonly sha: string;
  /** The release at that commit, written beside the `uses:` line. */
  readonly tag: string;
}

const pin = (slug: string, major: string, sha: string, tag: string): ActionPin => ({ slug, major, sha, tag });

export const ACTION_PINS = {
  checkout7: pin("actions/checkout", "v7", "3d3c42e5aac5ba805825da76410c181273ba90b1", "v7.0.1"),
  checkout6: pin("actions/checkout", "v6", "d23441a48e516b6c34aea4fa41551a30e30af803", "v6.1.0"),
  checkout4: pin("actions/checkout", "v4", "11d5960a326750d5838078e36cf38b85af677262", "v4.4.0"),
  setupNode6: pin("actions/setup-node", "v6", "249970729cb0ef3589644e2896645e5dc5ba9c38", "v6.5.0"),
  setupNode4: pin("actions/setup-node", "v4", "49933ea5288caeca8642d1e84afbd3f7d6820020", "v4.4.0"),
  createGithubAppToken2: pin("actions/create-github-app-token", "v2", "fee1f7d63c2ff003460e3d139729b119787bc349", "v2.2.2"),
  cacheRestore4: pin("actions/cache/restore", "v4", "0057852bfaa89a56745cba8c7296529d2fc39830", "v4.3.0"),
  cacheSave4: pin("actions/cache/save", "v4", "0057852bfaa89a56745cba8c7296529d2fc39830", "v4.3.0"),
  uploadArtifact4: pin("actions/upload-artifact", "v4", "ea165f8d65b6e75b540449e92b4886f43607fa02", "v4.6.2"),
  uploadArtifact3: pin("actions/upload-artifact", "v3", "ff15f0306b3f739f7b6fd43fb5d26cd321bd4de5", "v3.2.1"),
  downloadArtifact4: pin("actions/download-artifact", "v4", "d3f86a106a0bac45b974a628896c90dbdf5c8093", "v4.3.0"),
  downloadArtifact3: pin("actions/download-artifact", "v3", "9bc31d5ccc31df68ecc42ccf4149144866c47d8a", "v3.0.2"),
} as const satisfies Record<string, ActionPin>;

/** The `uses:` value for a pin: `actions/checkout@<sha>`. */
export const usesRef = (p: ActionPin): string => `${p.slug}@${p.sha}`;

const TAG_BY_SHA = new Map<string, string>();
for (const p of Object.values(ACTION_PINS) as ActionPin[]) TAG_BY_SHA.set(p.sha, p.tag);

/** Write each pinned `uses:` line's release beside it, as `# v4.4.0`. A line that has a comment, or a SHA not in the table, is left alone. */
export function tagComments(yaml: string): string {
  return yaml.replace(/^(\s*(?:- )?uses: *["']?[^\s"'#]+@([0-9a-f]{40})["']?)[ \t]*$/gm, (line, head: string, sha: string) => {
    const tag = TAG_BY_SHA.get(sha);
    return tag ? `${head} # ${tag}` : line;
  });
}

/** Every `uses:` in a workflow that names an action by a tag or branch, not a 40-character commit SHA. Local actions and docker images are not actions on a forge. */
export function unpinnedActions(yaml: string): string[] {
  const out: string[] = [];
  for (const m of yaml.matchAll(/^\s*(?:- )?uses: *["']?([^\s"'#]+)["']?/gm)) {
    const ref = m[1];
    if (ref.startsWith("./") || ref.startsWith("../") || ref.startsWith("docker://")) continue;
    if (!/@[0-9a-f]{40}$/.test(ref)) out.push(ref);
  }
  return out;
}

/** The row for the same action as the one `sha` pins, at `major`. The forgejo lexicon uses it to move a pinned `upload-artifact` v4 to v3. */
export function pinAtMajor(sha: string, major: string): ActionPin | undefined {
  const rows = Object.values(ACTION_PINS) as ActionPin[];
  const from = rows.find((p) => p.sha === sha);
  return from ? rows.find((p) => p.slug === from.slug && p.major === major) : undefined;
}

/** The major of the row `sha` belongs to, as a number, when it is in the table. */
export function pinMajor(sha: string): number | undefined {
  const row = (Object.values(ACTION_PINS) as ActionPin[]).find((p) => p.sha === sha);
  return row ? Number(row.major.slice(1)) : undefined;
}
