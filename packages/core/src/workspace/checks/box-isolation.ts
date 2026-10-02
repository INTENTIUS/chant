/**
 * The box isolation checks, WSP123 and WSP124 (#2727).
 *
 * | Id | Code | Fails when |
 * |---|---|---|
 * | WSP123 | `box-isolation-collision` | two boxes on one host, or two ports in one box, resolve to the same port, state path or cookie name |
 * | WSP124 | `box-isolation-literal` | a host's state root or a box's state entry is a literal machine path |
 *
 * Both are fixed errors. A collision means one box signs another's people out
 * or reads another's identity (arugula-salad/studio#39), and a literal path
 * means the declaration only holds on one machine. Neither has a case where
 * turning the check down is the fix.
 */

import type { WorkspaceCheck } from "../checks";
import { boxCollisions, boxLiterals } from "../box-isolation";

export const WSP_BOX_COLLISION = "WSP123";
export const WSP_BOX_LITERAL = "WSP124";

const WHAT = { port: "port", state: "state path", cookie: "cookie name" } as const;

export const BOX_ISOLATION_CHECKS: readonly WorkspaceCheck[] = [
  {
    id: WSP_BOX_COLLISION,
    name: "box-isolation-collision",
    description: "No two boxes on one host resolve to the same port, state path or cookie name, and no two ports in one box share an offset.",
    severity: "error",
    configurable: false,
    check(ctx) {
      return boxCollisions(ctx.declaration).map((c) => {
        const [first, ...rest] = c.holders;
        const names = c.holders.map((h) => `${h.box}.${h.name}`).join(" and ");
        const hint =
          c.what === "port"
            ? new Set(c.holders.map((h) => h.box)).size > 1
              ? "; give each box on a host its own slot"
              : "; give each port in a box its own offset"
            : "";
        return {
          checkId: this.id,
          severity: this.severity,
          code: "box-isolation-collision" as const,
          message: `box-isolation-collision: ${names} on host ${c.host} resolve to the same ${WHAT[c.what]} ${c.value}${hint}`,
          entity: rest.find((h) => h.box !== first.box)?.box ?? first.box,
          pointer: (rest[0] ?? first).pointer,
        };
      });
    },
  },
  {
    id: WSP_BOX_LITERAL,
    name: "box-isolation-literal",
    description: "No host's state root and no box's state entry is a literal machine path: state paths derive from an environment reference and the member's name.",
    severity: "error",
    configurable: false,
    check(ctx) {
      return boxLiterals(ctx.declaration).map((l) => ({
        checkId: this.id,
        severity: this.severity,
        code: "box-isolation-literal" as const,
        message: `box-isolation-literal: ${l.message}`,
        ...(l.box !== null ? { entity: l.box } : {}),
        pointer: l.pointer,
      }));
    },
  },
];
