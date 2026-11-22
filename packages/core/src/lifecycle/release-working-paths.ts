/**
 * The files chant and its lexicons write into the working tree during a run
 * (#5444). A pipeline's last wave cuts the release in the job that applied
 * it, after the wave wrote its plans, outcomes and reports. The cut's
 * dirty-tree check leaves these out, from this one list, so a product needs
 * no `.gitignore` line for them. A file a person adds under `.chant/` that
 * the list does not name still counts.
 *
 * Each entry is relative to a `.chant` directory, at the checkout's top or in
 * a workspace member. A name ending in `/` is a directory; the others are
 * files.
 */

export const CHANT_WORKING_PATHS: readonly string[] = [
  "op-waves/", // each wave's plans, runs and outcomes
  "sql/", // the sql lexicon's parts and wave plans
  "choudoufu-waves/", // the terraform lexicon's wave records
  "compose/", // what a compose leaves unwritten
  "pr/", // pr-loop reports
  "pr-resume/", // pr-loop resume record
  "pr-env/", // pr-env reports
  "check/", // check hook runs and reports
  "review/", // review job output (`review.md`, the instructions, is not in it)
  "agent/", // coding-agent run files
  "agent-steps/", // pipeline agent step records
  "evidence/", // signing job evidence
  "promote/", // promote resume files
  "work/", // Op work worktrees
  "fan-out.json", // gated wave record
  "release-digests.json", // `chant release images` output
];

/** Whether `path`, as git prints it relative to the checkout's top, is one of chant's working files. */
export function isChantWorkingPath(path: string): boolean {
  const segments = path.replace(/^"|"$/g, "").split("/");
  const at = segments.indexOf(".chant");
  if (at < 0) return false;
  const rest = segments.slice(at + 1);
  if (rest.length === 0) return false;
  return CHANT_WORKING_PATHS.some((entry) =>
    entry.endsWith("/") ? rest[0] === entry.slice(0, -1) && (rest.length > 1 || path.endsWith("/")) : rest.length === 1 && rest[0] === entry,
  );
}

/** The path in a porcelain line, which may have lost its leading space to a trim, and the new path of a rename. */
const pathOf = (line: string): string => line.trim().replace(/^\S+\s+/, "").split(" -> ").pop()!;

/** The `git status --porcelain` lines without the ones about chant's working files. */
export function withoutChantWorkingFiles(porcelain: string): string {
  return porcelain
    .split("\n")
    .filter((line) => line.length > 0 && !isChantWorkingPath(pathOf(line)))
    .join("\n");
}
