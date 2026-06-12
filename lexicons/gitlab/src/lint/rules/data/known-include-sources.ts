/**
 * Vendored snapshot of well-known GitLab CI include/component source projects,
 * used by the look-alike check (WGL032) as the reference set: an `include` or
 * `component` source that is a near-miss (edit distance 1–2) of one of these —
 * but not an exact match — is likely a typo or an impersonation.
 *
 * Advisory only. Refresh source: GitLab-maintained CI templates and the popular
 * CI/CD Catalog components. Accept staleness — a stale entry only weakens
 * look-alike detection, it never blocks a build.
 */
export const KNOWN_INCLUDE_SOURCES: readonly string[] = [
  "gitlab-org/gitlab",
  "gitlab-org/security-products/ci-templates",
  "components/sast",
  "components/secret-detection",
  "components/dependency-scanning",
  "components/container-scanning",
  "components/code-quality",
  "gitlab-org/components/sast",
  "gitlab-org/components/secret-detection",
];

/** Levenshtein edit distance, capped: returns early once it exceeds `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr.push(val);
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length];
}
