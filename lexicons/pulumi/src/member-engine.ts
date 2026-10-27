/**
 * Which engine runs a Pulumi member: stock `pulumi` or plunge, its fork
 * (#4453). The rule is in `./run.ts`'s module comment, which re-exports
 * {@link pulumiMemberEngine}. It lives here, apart from the runner, so the
 * graph read (`./workspace-member.ts`, which runs nothing) can ask it too:
 * only a member on plunge has a checked-in `engine-graph.json` read (#4529).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYAML } from "@intentius/chant/yaml";

/** What runs a Pulumi member's stack. */
export type PulumiMemberEngine = "pulumi" | "plunge";

/** Which engine runs the member, and the rule that said so (see `./run.ts`'s module comment). */
export function pulumiMemberEngine(dir: string, configured?: PulumiMemberEngine): { engine: PulumiMemberEngine; because: string } {
  if (configured) return { engine: configured, because: `the member's config says engine: ${configured}` };
  const file = join(dir, "Pulumi.yaml");
  if (existsSync(file)) {
    try {
      const doc = parseYAML(readFileSync(file, "utf-8"));
      const backend = doc.backend as { url?: unknown } | undefined;
      const url = typeof backend?.url === "string" ? backend.url : undefined;
      if (url && /^plunge[+:]/.test(url)) return { engine: "plunge", because: `Pulumi.yaml names the plunge backend ${url}` };
    } catch {
      // An unreadable Pulumi.yaml fails the member file check; here it just names no backend.
    }
  }
  return { engine: "pulumi", because: "nothing names plunge" };
}
