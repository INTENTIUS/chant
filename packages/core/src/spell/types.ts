/**
 * Spell types and factory functions.
 *
 * A spell is a structured task definition for agent orchestration.
 */

// ── Types ────────────────────────────────────────────────────────

export interface ContextItem {
  type: "file" | "cmd";
  value: string;
}

export interface Task {
  description: string;
  done: boolean;
}

export type Status = "blocked" | "ready" | "done";

export interface SpellDefinition {
  name: string;
  lexicon?: string;
  overview: string;
  context?: (string | ContextItem)[];
  tasks: Task[];
  depends?: string[];
  afterAll?: string[];
}

// ── Validation ───────────────────────────────────────────────────

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const RESERVED_NAMES = new Set([
  "add", "list", "show", "cast", "done", "rm", "graph",
]);

function validateName(name: string): void {
  if (!name) {
    throw new Error("Spell name must not be empty");
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`Spell name must be at most ${MAX_NAME_LENGTH} characters: "${name}"`);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`Spell name must be kebab-case (lowercase letters, numbers, hyphens): "${name}"`);
  }
  if (RESERVED_NAMES.has(name)) {
    throw new Error(`Spell name "${name}" is reserved (conflicts with CLI subcommand)`);
  }
}

// ── Factory functions ────────────────────────────────────────────

/**
 * Define a spell. Validates the name and freezes the object.
 */
export function spell(def: SpellDefinition): SpellDefinition {
  validateName(def.name);
  if (!def.overview) {
    throw new Error(`Spell "${def.name}" must have a non-empty overview`);
  }
  if (!def.tasks || def.tasks.length === 0) {
    throw new Error(`Spell "${def.name}" must have at least one task`);
  }
  return Object.freeze({ ...def });
}

/**
 * Define a task within a spell.
 */
export function task(description: string, opts?: { done?: boolean }): Task {
  return { description, done: opts?.done ?? false };
}

/**
 * File context item — contents inlined at cast time.
 */
export function file(path: string): ContextItem {
  return { type: "file", value: path };
}

/**
 * Command context item — stdout inlined at cast time.
 */
export function cmd(command: string): ContextItem {
  return { type: "cmd", value: command };
}
