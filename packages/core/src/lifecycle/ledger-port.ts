/**
 * The read side of `chant/lifecycle` that the bundle-safe readers take
 * (#3865). Paths are relative to one project's ledger: the flat root, or a
 * workspace member's `_members/<member>/`. Which of those a port reads is the
 * port's business; `gitLedgerReadPort` (`./git.ts`) takes a member or a
 * prefix, and a product that reads the branch its own way supplies its own.
 *
 * Types only, so a bundle that imports a reader loads no git code.
 */
export interface LedgerReadPort {
  /** The file at `<dir>/<file>`, or null when the branch, the directory or the file is absent. */
  read(dir: string, file: string): Promise<string | null>;
  /** The names directly under `<dir>/`, or `[]` when absent. */
  list(dir: string): Promise<string[]>;
  /** The directories directly under the ledger's root: every environment, and `_gates`, `_wave-plans` and the rest. */
  trees(): Promise<string[]>;
}
