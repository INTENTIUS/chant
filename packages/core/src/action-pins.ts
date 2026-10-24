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
  setupNode7: pin("actions/setup-node", "v7", "949feb2413d6458794dcd2491c4babbbce0c15c1", "v7.1.0"),
  cache6: pin("actions/cache", "v6", "55cc8345863c7cc4c66a329aec7e433d2d1c52a9", "v6.1.0"),
  uploadArtifact7: pin("actions/upload-artifact", "v7", "cf430e030ddbb5b0abf93d22962f4752f3646cd9", "v7.0.2"),
  downloadArtifact8: pin("actions/download-artifact", "v8", "9000827ccba6bdab643e8b6fd33ac0654aef8333", "v8.0.2"),
  setupGo7: pin("actions/setup-go", "v7", "b7ad1dad31e06c5925ef5d2fc7ad053ef454303e", "v7.0.0"),
  setupPython7: pin("actions/setup-python", "v7", "6d4fd22b20465ccc0f7354476588e8df7c9ca0e0", "v7.1.0"),
  setupBun2: pin("oven-sh/setup-bun", "v2", "0c5077e51419868618aeaa5fe8019c62421857d6", "v2.2.0"),
  golangciLint9: pin("golangci/golangci-lint-action", "v9", "ba0d7d2ec06a0ea1cb5fa41b2e4a3ab91d21278a", "v9.3.0"),
  dockerLogin4: pin("docker/login-action", "v4", "81c6f93d4bc991e510b342a00b419b3bb4efc5c6", "v4.7.0"),
  dockerSetupBuildx4: pin("docker/setup-buildx-action", "v4", "f87e5991a6d7451dcb8d9637bfbc97413f497069", "v4.4.1"),
  dockerMetadata6: pin("docker/metadata-action", "v6", "dc802804100637a589fabce1cb79ff13a1411302", "v6.2.0"),
  dockerBuildPush7: pin("docker/build-push-action", "v7", "c3c9e263c25d99ce0380d002d59b67737d91b0dc", "v7.4.0"),
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
