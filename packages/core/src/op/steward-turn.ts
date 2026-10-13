/**
 * Whether this process is a steward's turn, and whose (#2749).
 *
 * A steward runs unattended. In the local form, `chant operator --steward`
 * is the steward for as long as it runs; on Fountain, the Agent's `chant acp
 * --steward <name>` session is. Two things read this: a decision point asked
 * during the turn (`./steward-points.ts`), which records the steward on the
 * question and makes its model call through the steward's brokered
 * capability, and `points answer`, which refuses to record an answer from a
 * steward's own turn, as the gate ledger's origin rule refuses a gate
 * resolved on the channel that reached it.
 *
 * Like the gate origin (`../lifecycle/gate-origin.ts`) this is a property of
 * the process, set once at its entry point, not a parameter threaded through
 * every executor and activity. It is also exported to child processes as
 * `CHANT_STEWARD`, so a `chant workspace points answer` an Op shells out to
 * is refused the same way.
 */

/** The environment variable a steward's turn carries into child processes. */
export const STEWARD_ENV = "CHANT_STEWARD";

/** A steward's turn, as the process knows it. */
export interface StewardTurn {
  /** The steward's name. */
  steward: string;
  /**
   * The box capabilities the steward reaches through the broker (#2726), or
   * undefined when the process was told only the steward's name (a child
   * process, or `chant acp --steward <name>`): the declaration is then read
   * from the project's `*.op.ts` files when a model call needs it.
   */
  capabilities?: readonly string[];
  /** The vault the steward holds, by name, when it is not behind a broker. */
  vault?: string | null;
  /** The run the steward is in, when an Op is running. */
  run?: string;
}

let ambient: StewardTurn | undefined;

/**
 * Declare that this process is a steward's turn. Called once by `chant
 * operator --steward` and `chant acp --steward`; also exports
 * {@link STEWARD_ENV} so a child process knows it too.
 */
export function setStewardTurn(turn: StewardTurn): void {
  ambient = { ...turn };
  process.env[STEWARD_ENV] = turn.steward;
}

/**
 * Be a steward's turn until the returned function is called, which puts back
 * whatever was there before. `chant operator --steward` enters one per Op run,
 * naming the run, so a question asked during it names the run too.
 */
export function enterStewardTurn(turn: StewardTurn): () => void {
  const before = ambient;
  const envBefore = process.env[STEWARD_ENV];
  setStewardTurn(turn);
  return () => {
    ambient = before;
    if (envBefore === undefined) delete process.env[STEWARD_ENV];
    else process.env[STEWARD_ENV] = envBefore;
  };
}

/** The steward whose turn this process is, or undefined. */
export function currentStewardTurn(): StewardTurn | undefined {
  if (ambient) return ambient;
  const name = process.env[STEWARD_ENV];
  return name && name.trim() !== "" ? { steward: name.trim() } : undefined;
}

/** Forget the turn. For tests, which must not leak a steward into each other. */
export function resetStewardTurn(): void {
  ambient = undefined;
  delete process.env[STEWARD_ENV];
}
