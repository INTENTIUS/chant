/**
 * One `chant release` subcommand's words (#5196): its entry in the Releases
 * section of `chant --help`, and its form in the usage line `chant release`
 * prints on a mistake. Each subcommand has a file of its own in this
 * directory, listed in ./index.ts, so a new subcommand adds a file and an
 * import rather than editing a shared string.
 */
export interface ReleaseCommandDoc {
  /** The subcommand as the help names it: `cut`, `deprecate|yank|restore`. */
  name: string;
  /** Where the entry sits in `chant --help`: entries sort by it, lowest first. Leave gaps so a new one fits between two. */
  helpOrder: number;
  /** The entry's lines in `chant --help`, each as printed, indent included. */
  help: readonly string[];
  /** The subcommand's form in the `release` usage line, and where it sits there (lowest first). Absent: the usage line leaves it out. */
  usage?: { order: number; text: string };
}
