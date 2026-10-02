/**
 * TF030: a security group rule opens a sensitive port to the whole internet.
 *
 * The native Terraform counterpart of the aws lexicon's WAW019 (#2285, under
 * #2284), with the same port list and the same two open CIDRs. It cannot be a
 * bridge to WAW019: the probe (docs/design/waw-hcl-fidelity-probe.md) ran the
 * shipped WAW019 over a root opening 22, 3389, 3306 and 5432 to the world and
 * got nothing back, because none of the three Terraform shapes looks like
 * CloudFormation's `SecurityGroupIngress[].CidrIp`:
 *
 * - `ingress` on `aws_security_group`. The AWS provider types it as an
 *   attribute, `set(object({...}))`, not a nested block, though HCL lets it
 *   be written either way. hcl2json renders both spellings as one array of
 *   rule objects, so one reader covers both. `cidr_blocks` and
 *   `ipv6_cidr_blocks` are lists where CloudFormation has a scalar.
 * - `aws_security_group_rule`, which is ingress only when `type = "ingress"`.
 * - `aws_vpc_security_group_ingress_rule`, which spells the CIDR as the
 *   scalars `cidr_ipv4` / `cidr_ipv6` and the protocol as `ip_protocol`.
 *
 * A rule is reported when three things are all proved by literals: it is
 * ingress, a CIDR is `0.0.0.0/0` or `::/0`, and its ports reach a sensitive
 * port. Protocol `-1` (or `"all"`) reaches every port whatever `from_port` and
 * `to_port` say. `tcp`, `udp`, `6` and `17` reach the ports between
 * `from_port` and `to_port` inclusive, so `0`-`65535` reaches all four.
 * Anything else (`icmp`, `icmpv6`, a protocol number like `50`) has no ports
 * and is never reported.
 *
 * Nothing here evaluates an expression. When the answer hangs on a value the
 * parse hands back as a reference or a template (`cidr_blocks =
 * var.allowed`, `from_port = var.ssh_port`, `ingress = local.rules`, a
 * `dynamic "ingress"` block), the rule emits one `info` finding that starts
 * `Not determined:` and names the attributes, per the convention fixed on
 * #2284. It never guesses a warning or an error out of something it could
 * not read. A fact that settles the rule on its own still settles it, so
 * `cidr_blocks = var.x` on port 443 is silent: no CIDR makes 443 sensitive.
 *
 * Absence is safe for this rule, which is the easy case of #2284's
 * three-valued question. An `aws_security_group` with no `ingress` admits
 * nothing (the provider default is no rules), and its rules may live in
 * standalone resources, which this check reads in their own right.
 *
 * Scope: root and child modules alike (#2112). The condition is a property
 * of the block itself.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { RESOURCE_TYPE, type BlockBody } from "../../hcl/parse";
import { attr } from "../../hcl/value";
import { blocksOfType, nestedBodies, type TerraformBlock } from "./blocks";

/** The ports WAW019 treats as sensitive, with the name a message gives each. */
export const SENSITIVE_PORTS: ReadonlyMap<number, string> = new Map([
  [22, "SSH"],
  [3389, "RDP"],
  [3306, "MySQL"],
  [5432, "PostgreSQL"],
]);

/** The two CIDRs that mean "every address". */
export const OPEN_CIDRS: ReadonlySet<string> = new Set(["0.0.0.0/0", "::/0"]);

/** Protocols whose rules carry a port range. */
const PORTED_PROTOCOLS = new Set(["tcp", "udp", "6", "17"]);
/** Protocols that mean every protocol and therefore every port. */
const ALL_PROTOCOLS = new Set(["-1", "all"]);

/**
 * A three-valued answer. `unknown` carries the sentence fragments that say
 * which attribute could not be read and what it holds.
 */
type Answer<T> = { state: "yes"; value: T } | { state: "no" } | { state: "unknown"; why: string[] };

const NO = { state: "no" } as const;

/**
 * An expression as its author wrote it. hcl2json wraps a bare reference in
 * `${...}` (`var.x` arrives as `"${var.x}"`), so a message quoting the raw
 * value would show a spelling that is not in the file.
 */
function shown(raw: unknown): string {
  const s = typeof raw === "string" ? raw : JSON.stringify(raw);
  const whole = /^\$\{([\s\S]*)\}$/.exec(s);
  return whole && !whole[1].includes("${") ? whole[1].trim() : s;
}

function unknown(name: string, raw: unknown): { state: "unknown"; why: string[] } {
  return { state: "unknown", why: [`\`${name}\` is \`${shown(raw)}\``] };
}

/** Does a string carry an interpolation, i.e. is it something the parse did not evaluate? */
function isExpression(value: string): boolean {
  return value.includes("${");
}

/**
 * Which open CIDR, if any, a rule admits. List attributes (`cidr_blocks`,
 * `ipv6_cidr_blocks`) and scalar ones (`cidr_ipv4`, `cidr_ipv6`) both pass
 * through here: a scalar literal is read as a one-element list.
 */
function openCidr(body: BlockBody, names: readonly string[]): Answer<string> {
  const why: string[] = [];
  for (const name of names) {
    const a = attr(body, name);
    if (a.kind === "absent") continue;
    if (a.kind !== "literal") {
      why.push(...unknown(name, a.raw).why);
      continue;
    }
    const items = Array.isArray(a.value) ? a.value : [a.value];
    for (const item of items) {
      if (typeof item !== "string") continue;
      if (OPEN_CIDRS.has(item.trim())) return { state: "yes", value: item.trim() };
      if (isExpression(item)) why.push(`an element of \`${name}\` is \`${shown(item)}\``);
    }
  }
  return why.length > 0 ? { state: "unknown", why } : NO;
}

/** A literal port: a number, or a numeric string, which hcl2json passes through when the source quotes it. */
function literalPort(body: BlockBody, name: string): Answer<number> {
  const a = attr(body, name);
  if (a.kind === "absent") return { state: "unknown", why: [`\`${name}\` is not set`] };
  if (a.kind !== "literal") return unknown(name, a.raw);
  const n = typeof a.value === "number" ? a.value : typeof a.value === "string" ? Number(a.value.trim()) : NaN;
  return Number.isInteger(n) ? { state: "yes", value: n } : unknown(name, a.raw);
}

/** What a rule's ports reach: every port, a closed range, or nothing port-shaped. */
interface Reach {
  /** `null` for protocol `-1`/`all`, which reaches every port whatever the range says. */
  range: [number, number] | null;
  /** The sensitive ports inside the reach, in list order. */
  ports: number[];
}

function sensitiveReach(body: BlockBody, protocolName: string): Answer<Reach> {
  const p = attr(body, protocolName);
  let protocol = "tcp"; // the provider requires a protocol; a body without one is read as port-scoped
  if (p.kind === "reference" || p.kind === "template") return unknown(protocolName, p.raw);
  if (p.kind === "literal") protocol = String(p.value).trim().toLowerCase();

  if (ALL_PROTOCOLS.has(protocol)) return { state: "yes", value: { range: null, ports: [...SENSITIVE_PORTS.keys()] } };
  if (!PORTED_PROTOCOLS.has(protocol)) return NO;

  const from = literalPort(body, "from_port");
  const to = literalPort(body, "to_port");
  if (from.state !== "yes" || to.state !== "yes") {
    const why = [...(from.state === "unknown" ? from.why : []), ...(to.state === "unknown" ? to.why : [])];
    return { state: "unknown", why };
  }
  const ports = [...SENSITIVE_PORTS.keys()].sort((a, b) => a - b).filter((port) => from.value <= port && port <= to.value);
  return ports.length > 0 ? { state: "yes", value: { range: [from.value, to.value], ports } } : NO;
}

/** Is a standalone `aws_security_group_rule` an ingress rule? */
function isIngress(body: BlockBody): Answer<true> {
  const t = attr(body, "type");
  if (t.kind === "absent") return NO;
  if (t.kind !== "literal") return unknown("type", t.raw);
  return String(t.value).trim().toLowerCase() === "ingress" ? { state: "yes", value: true } : NO;
}

/** The outcome for one ingress rule, from its three facts. */
type Verdict =
  | { state: "open"; cidr: string; reach: Reach }
  | { state: "closed" }
  | { state: "unknown"; why: string[] };

function judge(ingress: Answer<true>, cidr: Answer<string>, reach: Answer<Reach>): Verdict {
  // One proved "no" settles it: whatever the unread values hold, this rule
  // cannot open a sensitive port to the world.
  if (ingress.state === "no" || cidr.state === "no" || reach.state === "no") return { state: "closed" };
  const why = [ingress, cidr, reach].flatMap((a) => (a.state === "unknown" ? a.why : []));
  if (why.length > 0) return { state: "unknown", why };
  if (cidr.state !== "yes" || reach.state !== "yes") return { state: "closed" }; // unreachable; narrows the types
  return { state: "open", cidr: cidr.value, reach: reach.value };
}

const INGRESS: Answer<true> = { state: "yes", value: true };

/** An inline rule of an `aws_security_group` (block or attribute syntax, same shape after the parse). */
function judgeInline(rule: BlockBody): Verdict {
  return judge(INGRESS, openCidr(rule, ["cidr_blocks", "ipv6_cidr_blocks"]), sensitiveReach(rule, "protocol"));
}

/** "a, b and c" */
function listed(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function describeReach(reach: Reach): string {
  if (reach.range === null) return "every port (protocol -1), SSH, RDP, MySQL and PostgreSQL among them";
  const [from, to] = reach.range;
  if (from === to) return `port ${from} (${SENSITIVE_PORTS.get(from)})`;
  return `ports ${from}-${to}, which include ${listed(reach.ports.map((p) => `${SENSITIVE_PORTS.get(p)} (${p})`))}`;
}

export const tf030: PostSynthCheck = {
  id: "TF030",
  description: "Security group rule allows unrestricted ingress on a sensitive port",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    const report = (block: TerraformBlock, where: string, verdict: Verdict): void => {
      const subject = where === "" ? `"${block.address}"` : `"${block.address}" ${where}`;
      if (verdict.state === "open") {
        diagnostics.push({
          checkId: "TF030",
          severity: "error",
          message:
            `${subject} allows ingress from ${verdict.cidr} on ${describeReach(verdict.reach)}. ` +
            "Anyone on the internet can reach it. Restrict the CIDR to the sources that need it, or " +
            "reach the host through a bastion, a VPN or SSM Session Manager instead.",
          entity: block.key,
          lexicon: "terraform",
        });
      } else if (verdict.state === "unknown") {
        diagnostics.push({
          checkId: "TF030",
          severity: "info",
          message:
            `Not determined: ${subject}: ${verdict.why.join("; ")}. TF030 does not evaluate expressions, ` +
            "so it cannot tell whether this rule opens SSH, RDP, MySQL or PostgreSQL to 0.0.0.0/0 or ::/0. " +
            "Check the value the expression resolves to.",
          entity: block.key,
          lexicon: "terraform",
        });
      }
    };

    for (const block of blocksOfType(ctx, RESOURCE_TYPE)) {
      const type = block.address.slice(0, block.address.indexOf("."));

      if (type === "aws_security_group") {
        const ingress = attr(block.body, "ingress");
        if (ingress.kind === "reference" || ingress.kind === "template") {
          report(block, "", { state: "unknown", why: unknown("ingress", ingress.raw).why });
        } else if (ingress.kind === "literal") {
          const rules = Array.isArray(ingress.value) ? ingress.value : [ingress.value];
          rules.forEach((rule, i) => {
            const where = `ingress rule ${i + 1}`;
            if (typeof rule === "object" && rule !== null && !Array.isArray(rule)) {
              report(block, where, judgeInline(rule as BlockBody));
            } else {
              report(block, where, unknown(`ingress[${i}]`, rule));
            }
          });
        }
        // A `dynamic "ingress"` block's rules come from its for_each, which is
        // not evaluated. Its content still settles the case where no element
        // could be open (a private CIDR literal, a non-sensitive port).
        for (const dyn of nestedBodies(block.body, "dynamic")) {
          for (const generator of nestedBodies(dyn, "ingress")) {
            for (const content of nestedBodies(generator, "content")) {
              const verdict = judgeInline(content);
              if (verdict.state === "closed") continue;
              const why = verdict.state === "unknown" ? verdict.why : [];
              report(block, 'dynamic "ingress"', {
                state: "unknown",
                why: [`its rules come from \`for_each = ${shown(generator.for_each)}\``, ...why],
              });
            }
          }
        }
        // No `ingress` at all: the group admits nothing. Absence is safe here.
        continue;
      }

      if (type === "aws_security_group_rule") {
        report(
          block,
          "",
          judge(isIngress(block.body), openCidr(block.body, ["cidr_blocks", "ipv6_cidr_blocks"]), sensitiveReach(block.body, "protocol")),
        );
        continue;
      }

      if (type === "aws_vpc_security_group_ingress_rule") {
        report(block, "", judge(INGRESS, openCidr(block.body, ["cidr_ipv4", "cidr_ipv6"]), sensitiveReach(block.body, "ip_protocol")));
      }
    }

    return diagnostics;
  },
};
