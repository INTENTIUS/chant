/**
 * chant#4555: the product tool hook on `chant serve mcp`. A CI product built
 * on chant (terragucci, plywood) adds its own tools to chant's server rather
 * than running a server of its own: its bin calls
 * `runChantInProcess(["serve", "mcp"], words, { mcp: hook })`
 * (`@intentius/chant/ci-product`), or constructs `McpServer` with
 * `product: hook`.
 *
 * Read-only by default, under the rule chant#4543 set for every contributed
 * tool:
 *
 * - a server started through the hook is read-only unless the hook says
 *   `readOnly: false`;
 * - a read-only server serves a product tool only when it declares
 *   `readOnly: true` (`servesContributedTool`);
 * - a read-only server refuses to start with a product tool whose name says
 *   it would approve, apply, override or write ({@link productToolWriteWord}),
 *   the check terragucci's own server made (`assertReadOnly`);
 * - the tools read the report store through a reader that cannot write, with
 *   the server's own credentials, never from a tool's arguments.
 *
 * Tools are registered as `<product>:<name>`, as a lexicon's are.
 *
 * chant#4655 adds a tier between read-only and ordinary for a product tool
 * that opens a pull request (`request_from_template`): `chant serve mcp
 * --read-only --propose`, or `propose: true` on the hook. It serves what the
 * read-only server serves, plus the product tools that declare `forgeWrite:
 * true`, and never chant's op, approve or snapshot tools. The read-only
 * server without `--propose` refuses to start with a `forgeWrite` tool. On
 * the tier a `forgeWrite` tool's name is exempt from the write-word check for
 * `request` and `propose` only: `approve_request` still refuses the start.
 * A product feature-detects the tier on {@link PRODUCT_MCP_PROPOSE_FLOOR}.
 */

import type { McpToolContribution } from "../../mcp/types";
import { reportReader, reportUrlFor, type ReportReader } from "./report-tools";

/** What a product's tools are handed. */
export interface ProductMcpContext {
  /** The directory the server serves. */
  cwd: string;
  /** Whether the server is read-only. */
  readOnly: boolean;
  /** Whether the read-only server also serves the product's `forgeWrite` tools (`--propose`, chant#4655). */
  propose: boolean;
  /**
   * The report store, read-only: the hook's `reportUrl`, else the declared
   * `ci.reportUrl`. Resolves undefined when neither names one.
   */
  reports(): Promise<ReportReader | undefined>;
}

/** A product's tools on chant's MCP server. */
export interface ProductMcpHook {
  /** The product's name, the tools' namespace: `terragucci`, `plywood`. */
  product: string;
  /** The product's tools. Called once, when the server starts. */
  tools(ctx: ProductMcpContext): McpToolContribution[];
  /** The report store the tools read. Default: the workspace's `ci.reportUrl`. */
  reportUrl?: string;
  /** `false` starts an ordinary server through the hook. Default: read-only. */
  readOnly?: boolean;
  /**
   * `true` serves the product's `forgeWrite` tools on the read-only server,
   * as `--propose` does (chant#4655). It needs the server read-only: with
   * `readOnly: false` the server refuses to start.
   */
  propose?: boolean;
  /** Text added to the server's `initialize` instructions. */
  instructions?: string;
}

/**
 * The first chant whose `chant serve mcp` has the `--propose` tier and serves
 * `forgeWrite` product tools on it (chant#4655). A product checks this before
 * it passes `--propose` or `propose: true`, and refuses naming this release
 * when its chant is older.
 */
export const PRODUCT_MCP_PROPOSE_FLOOR = "0.124.58";

/** The words a `forgeWrite` tool's name may hold on the `--propose` tier, which the write-word check passes over (chant#4655). */
export const PRODUCT_TOOL_PROPOSE_WORDS = ["request", "propose"] as const;

/** Words that say a tool would change something; a read-only server will not serve a tool named with one. terragucci's list. */
export const PRODUCT_TOOL_WRITE_WORDS = ["approve", "apply", "override", "revoke", "unlock", "lock", "merge", "resume", "migrate", "write", "put", "delete", "push", "commit", "publish", "reconcile", "rollout", "init", "generate", "respond", "relay", "notify", "update", "create", "exec"] as const;

/** The words that refuse a name wherever they stand in it, not only first. */
export const PRODUCT_TOOL_STRONG_WORDS = ["approve", "override", "revoke", "unlock", "merge", "write", "delete", "push", "commit", "publish", "exec"] as const;

/**
 * The word in `name` that says the tool would change something, or
 * undefined. A name may not start with a write word, and may not hold a
 * strong one anywhere: `last_apply` reads, `apply_wave` and `wave_approve`
 * do not.
 */
export function productToolWriteWord(name: string, exempt: readonly string[] = []): string | undefined {
  const parts = name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const first = parts[0] ?? "";
  const words = (list: readonly string[]) => list.filter((w) => !exempt.includes(w));
  return words(PRODUCT_TOOL_WRITE_WORDS).find((w) => first.startsWith(w)) ?? words(PRODUCT_TOOL_STRONG_WORDS).find((w) => parts.some((p) => p.startsWith(w)));
}

/**
 * A read-only server refused a product tool: one named as a write, or a
 * `forgeWrite` tool on a server started without `--propose` (chant#4655).
 */
export class ProductToolRefusedError extends Error {
  constructor(product: string, name: string, word: string, tier: "read-only" | "propose" | "forge-write" = "read-only") {
    super(
      tier === "forge-write"
        ? `chant serve mcp is read-only for ${product}, and the tool ${name} opens pull requests (forgeWrite); the server does not start with it. Start it with --read-only --propose to serve it`
        : tier === "propose"
          ? `chant serve mcp --propose serves ${product}'s tools that read or open pull requests and comments, and the tool ${name} would ${word}; the server does not start with it`
          : `chant serve mcp is read-only for ${product}, and the tool ${name} would ${word}; the server does not start with it`,
    );
    this.name = "ProductToolRefusedError";
  }
}

const PRODUCT = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The product tools a server serves. On an ordinary server every tool. On a
 * read-only server those that declare `readOnly: true`, none named as a
 * write, and no `forgeWrite` tool (each a throw, so the server does not
 * start). On the `--propose` tier the `readOnly: true` tools under the same
 * check, plus the `forgeWrite` tools, whose names may hold `request` or
 * `propose` but no other write word (chant#4655).
 */
export function productToolsServed(hook: ProductMcpHook, ctx: ProductMcpContext): McpToolContribution[] {
  if (!PRODUCT.test(hook.product)) throw new Error(`the product tool hook's product ${JSON.stringify(hook.product)} is not a product name ([a-z0-9-])`);
  const tools = hook.tools(ctx);
  if (!ctx.readOnly) return tools;
  const served: McpToolContribution[] = [];
  for (const t of tools) {
    const short = t.name.startsWith(`${hook.product}:`) ? t.name.slice(hook.product.length + 1) : t.name;
    if (t.forgeWrite === true) {
      if (!ctx.propose) throw new ProductToolRefusedError(hook.product, t.name, "open a pull request", "forge-write");
      const word = productToolWriteWord(short, PRODUCT_TOOL_PROPOSE_WORDS);
      if (word) throw new ProductToolRefusedError(hook.product, t.name, word, "propose");
      served.push(t);
    } else if (t.readOnly === true) {
      const word = productToolWriteWord(short);
      if (word) throw new ProductToolRefusedError(hook.product, t.name, word, ctx.propose ? "propose" : "read-only");
      served.push(t);
    }
  }
  return served;
}

/** The context a hook's tools get on a server at `cwd`. The store is opened on first read. */
export function productMcpContext(hook: ProductMcpHook, cwd: string, readOnly: boolean, propose = false): ProductMcpContext {
  let opened: Promise<ReportReader | undefined> | undefined;
  return {
    cwd,
    readOnly,
    propose,
    reports: () =>
      (opened ??= reportUrlFor(hook.reportUrl, cwd).then((url) => (url ? reportReader(url) : undefined))),
  };
}

let active: ProductMcpHook | undefined;

/** The hook the running command serves, set by a product's bin. */
export function activeProductMcpHook(): ProductMcpHook | undefined {
  return active;
}

/** Run `fn` with `hook` active, and put the earlier one back after it settles. */
export async function withProductMcpHook<T>(hook: ProductMcpHook | undefined, fn: () => Promise<T>): Promise<T> {
  if (!hook) return fn();
  const was = active;
  active = hook;
  try {
    return await fn();
  } finally {
    active = was;
  }
}
