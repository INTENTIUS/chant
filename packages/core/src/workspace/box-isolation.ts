/**
 * Box isolation (#2727): the ports, state paths and cookie names each box
 * uses, derived from its identity and its host, never chosen by a runtime.
 *
 * A box is a member with a `box` block (#2726), and its name is the
 * member's. A box's identity is its host, its name and its slot, from the
 * block's `host` and `slot`. Everything else
 * follows from those and the host's declaration, and nothing else goes in:
 *
 * - port `p` is `host.ports.from + slot * host.ports.perBox + offset(p)`;
 * - the state directory is `<host.stateRoot>/<box name>`, and state entry
 *   `k` is that directory joined with the entry's relative path;
 * - cookie `c` is `<c>_<box name>`.
 *
 * So the same declaration gives the same values on every machine and every
 * run, and adding or removing a box changes no other box's values. The state
 * paths keep their environment reference (`${XDG_STATE_HOME}` by default):
 * the runtime that sets them expands it on its machine, and chant never
 * reads the machine.
 *
 * Distinct names on one host give distinct state paths and cookie names by
 * construction (a member name has no `_`, so `<c>_<box>` splits one way).
 * Ports are the only value two boxes can share: two boxes on one host with
 * the same slot, or two ports in one box at the same offset. `chant
 * workspace check` compares every value anyway (WSP123), so an entry whose
 * path escapes its directory is caught too.
 */

import { DEFAULT_STATE_ROOT, type BoxIsolationDeclaration, type Declaration, type Host, type Member } from "./declaration";
import { pointerToken } from "./jsonc";

/** A box's isolation, resolved: what `chant workspace status --json` prints in the member's box block. */
export interface ResolvedIsolation {
  host: string;
  slot: number;
  /** The box's block of its host's range, inclusive. */
  portRange: { from: number; to: number };
  /** Each declared port's number, in file order. */
  ports: Record<string, number>;
  /** `<stateRoot>/<box name>`, with the environment reference unexpanded. */
  stateDir: string;
  /** Each declared state entry's path, under `stateDir`. */
  state: Record<string, string>;
  /** Each declared cookie's name for this box. */
  cookies: Record<string, string>;
}

/** The host's state root as written, or the default. */
export function stateRootOf(host: Host): string {
  return host.stateRoot ?? DEFAULT_STATE_ROOT;
}

const trimSlash = (s: string) => s.replace(/\/+$/, "");

/** Resolve the isolation of the box named `name` on its host. */
export function resolveIsolation(name: string, box: BoxIsolationDeclaration, host: Host): ResolvedIsolation {
  const first = host.ports.from + box.slot * host.ports.perBox;
  const stateDir = `${trimSlash(stateRootOf(host))}/${name}`;
  return {
    host: box.host,
    slot: box.slot,
    portRange: { from: first, to: first + host.ports.perBox - 1 },
    ports: Object.fromEntries(Object.entries(box.ports).map(([name, offset]) => [name, first + offset])),
    stateDir,
    state: Object.fromEntries(Object.entries(box.state).map(([name, path]) => [name, `${stateDir}/${path.replace(/^\.\/+/, "")}`])),
    cookies: Object.fromEntries(box.cookies.map((c) => [c, `${c}_${name}`])),
  };
}

/** A member whose box block declares its isolation, with it resolved. */
export interface IsolatedBox {
  member: Member;
  isolation: ResolvedIsolation;
}

/** Every box that declares its isolation, resolved, in member order. The declaration read already checked each box's host exists. */
export function resolveBoxes(declaration: Declaration): IsolatedBox[] {
  const hosts = new Map(declaration.hosts.map((h) => [h.name, h]));
  const out: IsolatedBox[] = [];
  for (const m of declaration.members) {
    const iso = m.box?.isolation;
    if (iso) out.push({ member: m, isolation: resolveIsolation(m.name, iso, hosts.get(iso.host)!) });
  }
  return out;
}

// ── Literal machine paths (WSP124) ───────────────────────────────────────────

const ENV_REF = /^\$(\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/;
const HOME_REF = /^\$(\{HOME\}|HOME)(?![A-Za-z0-9_])/;

/**
 * Why a host's `stateRoot` is a literal machine path, or undefined when it is
 * not. A state root starts with an environment reference the runtime expands,
 * and that reference is not `$HOME`: a path under a home directory names one
 * person's machine layout (`${HOME}/<user>/...`), where `${XDG_STATE_HOME}`
 * names the place the machine keeps state.
 */
export function stateRootLiteral(root: string): string | undefined {
  if (HOME_REF.test(root)) return "starts at $HOME, which names one person's machine layout; use ${XDG_STATE_HOME} or another variable the runtime sets";
  if (!ENV_REF.test(root)) return "does not start with an environment reference such as ${XDG_STATE_HOME}, so it names one machine's layout";
  if (root.split("/").includes("..")) return "has a .. segment";
  return undefined;
}

/**
 * Why a state entry's path is not one relative to the box's state directory,
 * or undefined when it is: absolute, home-relative, starting with an
 * environment reference, a Windows drive path, or with a `..` segment.
 */
export function statePathLiteral(path: string): string | undefined {
  if (path.startsWith("/")) return "is absolute";
  if (path.startsWith("~")) return "starts at a home directory";
  if (path.startsWith("$")) return "starts with an environment reference";
  if (/^[A-Za-z]:[\\/]/.test(path) || path.includes("\\")) return "is a Windows path";
  if (path.split("/").includes("..")) return "has a .. segment, which leaves the box's state directory";
  return undefined;
}

export interface BoxLiteral {
  /** The box, or null for a host's state root. */
  box: string | null;
  message: string;
  pointer: string;
}

/** Every literal machine path in the hosts and boxes. */
export function boxLiterals(declaration: Declaration): BoxLiteral[] {
  const out: BoxLiteral[] = [];
  for (const h of declaration.hosts) {
    if (h.stateRoot === null) continue;
    const why = stateRootLiteral(h.stateRoot);
    if (why) out.push({ box: null, message: `host ${h.name}'s stateRoot ${JSON.stringify(h.stateRoot)} ${why}`, pointer: `${h.pointer}/stateRoot` });
  }
  for (const m of declaration.members) {
    for (const [name, path] of Object.entries(m.box?.isolation?.state ?? {})) {
      const why = statePathLiteral(path);
      if (why) {
        out.push({
          box: m.name,
          message: `member ${m.name}'s box gives state ${name} the path ${JSON.stringify(path)}, which ${why}; state paths are relative to the box's state directory, which chant derives from the host's stateRoot and the member's name`,
          pointer: `${m.box!.pointer}/state/${pointerToken(name)}`,
        });
      }
    }
  }
  return out;
}

// ── Collisions (WSP123) ──────────────────────────────────────────────────────

export interface BoxCollision {
  host: string;
  what: "port" | "state" | "cookie";
  /** The shared value. */
  value: string;
  /** Each holder as `<box>.<name>`, in declaration order. */
  holders: { box: string; name: string; pointer: string }[];
}

/** Collapse `.`, `..` and repeated slashes, so two spellings of one path compare equal. */
function normalizePath(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push(seg);
  }
  return (path.startsWith("/") ? "/" : "") + out.join("/");
}

/**
 * Every value two holders on one host resolve to. Ports collide within a box
 * too, since two listeners can't share a port; state entries in one box may
 * name one file on purpose (a runtime and the door both reading hud's
 * identity), and cookies are unique in a box by the schema.
 */
export function boxCollisions(declaration: Declaration): BoxCollision[] {
  const resolved = resolveBoxes(declaration);
  const seen = new Map<string, BoxCollision>();
  const add = (host: string, what: BoxCollision["what"], value: string, box: string, name: string, pointer: string) => {
    const key = `${host}\u0000${what}\u0000${value}`;
    let c = seen.get(key);
    if (!c) {
      c = { host, what, value, holders: [] };
      seen.set(key, c);
    }
    c.holders.push({ box, name, pointer });
  };
  for (const { member, isolation: r } of resolved) {
    const at = member.box!.pointer;
    const box = member.name;
    for (const [name, port] of Object.entries(r.ports)) add(r.host, "port", String(port), box, name, `${at}/ports/${pointerToken(name)}`);
    const files = new Set<string>();
    for (const [name, path] of Object.entries(r.state)) {
      const file = normalizePath(path);
      if (files.has(file)) continue;
      files.add(file);
      add(r.host, "state", file, box, name, `${at}/state/${pointerToken(name)}`);
    }
    Object.entries(r.cookies).forEach(([name, cookie], i) => add(r.host, "cookie", cookie, box, name, `${at}/cookies/${i}`));
  }
  // A state file is counted once per box above, so two holders are two boxes.
  return [...seen.values()].filter((c) => c.holders.length > 1);
}
