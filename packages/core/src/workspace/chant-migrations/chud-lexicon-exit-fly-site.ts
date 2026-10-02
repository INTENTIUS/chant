/**
 * `chud-lexicon-exit-fly-site` (#2809): declare a migrated repo's Fly site
 * with the fly lexicon's `FlySite` composite.
 *
 * `chud-lexicon-exit` (0.92.0) deleted deploy/site.ts, chud's `ChudLocalSite`
 * composite, and removed chud's `FlySite` marker from deploy/fly.ts, so the
 * repo declared no composite instance: `chant workspace graph --composites`
 * listed none, and nothing told a reader the app component deploys the site.
 * Per ws-056 the Fly resources stay on the fly lexicon. This migration:
 *
 * - rewrites deploy/fly.ts as one `FlySite` instance (`flySite`) with the
 *   values deploy/fly.ts and deploy/fly-machine.ts declared, and deletes
 *   deploy/fly-machine.ts, when the two declare exactly the template's
 *   resources (comments aside). The build's plan has the same App, Volume,
 *   IP, Secret and one Machine, which the release Op's `flyRelease` finds;
 * - names `FlySite` in the app component's `composites`, so the listing joins
 *   the instance to the component.
 *
 * A site the project changed keeps its files, and the plan lists the
 * composite as not moved. The plan is empty unless the app component is the
 * one `chud-lexicon-exit` wrote and names no composites yet.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { ChantMigration, ChantMigrationContext, ChantMigrationPlan, NotMoved, PlannedChange } from "../chant-migrations";

export const CHUD_LEXICON_EXIT_FLY_SITE = "chud-lexicon-exit-fly-site";

const DESCRIPTION = "declare the Fly site with the fly lexicon's FlySite composite, the instance the app component deploys (#2809)";

function readText(dir: string, path: string): string | undefined {
  const abs = join(dir, path);
  return existsSync(abs) ? readFileSync(abs, "utf-8") : undefined;
}

/** The template's Fly site, as deploy/fly.ts and deploy/fly-machine.ts declare it. */
export interface FlySiteValues {
  /** The import that gives the app's name, kept as it is: `import { appSlug } from "../app-name.ts";`. */
  nameImport: string | null;
  /** The expression the App's name is, as written. */
  app: string;
  region: string;
  machine: string;
  image: string;
  port: string;
  env: string;
  cpuKind: string;
  cpus: string;
  memoryMb: string;
  volume: { name: string; sizeGb: string; path: string };
  ip: string;
  secret: { name: string; value: string };
}

/** A file's code without its comments and blank lines. */
function codeOf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l !== "" && !/^\s*\/\//.test(l))
    .join("\n");
}

const STR = `("[^"\\n]*")`;
const FLY_CODE = new RegExp(
  "^" +
    `import \\{ App, Fly, IPAddress, Secret, Volume \\} from "@intentius/chant-lexicon-fly";\\n` +
    `(?:import \\{ FlySite \\} from "@intentius/chud-runtime/lexicon";\\n)?` +
    `(?:(import \\{ \\w+ \\} from "\\.\\./app-name\\.ts";)\\n)?` +
    `const name = ([^;\\n]+);\\n` +
    `const region = ${STR};\\n` +
    `export const flyApp = new App\\(\\{ name, org_slug: Fly\\.OrgSlug \\}\\);\\n` +
    `export const data = new Volume\\(\\{ name: ${STR}, region, size_gb: (\\d+) \\}\\);\\n` +
    `export const publicIp = new IPAddress\\(\\{ type: ${STR} \\}\\);\\n` +
    `export const appSecret = new Secret\\(\\{ name: ${STR}, value: ([^\\n]+) \\}\\);` +
    `(?:\\nexport const flySite = new FlySite\\([^\\n]*\\);)?$`,
);
const MACHINE_CODE = new RegExp(
  [
    `^import \\{ Machine, MachineConfig, MachineGuest, MachineMount, MachinePort, MachineService \\} from "@intentius/chant-lexicon-fly";`,
    `export const guest = new MachineGuest\\(\\{ cpu_kind: ${STR}, cpus: (\\d+), memory_mb: (\\d+) \\}\\);`,
    `export const dataMount = new MachineMount\\(\\{ volume: ${STR}, path: ${STR} \\}\\);`,
    `export const https = new MachinePort\\(\\{ port: 443, handlers: \\["tls", "http"\\] \\}\\);`,
    `export const http = new MachinePort\\(\\{ port: 80, handlers: \\["http"\\] \\}\\);`,
    `export const web = new MachineService\\(\\{ protocol: "tcp", internal_port: (\\d+), ports: \\[https, http\\] \\}\\);`,
    `export const server = new Machine\\(\\{`,
    ` {2}name: ${STR},`,
    ` {2}region: ${STR},`,
    ` {2}config: new MachineConfig\\(\\{`,
    ` {4}image: ${STR},`,
    ` {4}guest,`,
    ` {4}mounts: \\[dataMount\\],`,
    ` {4}services: \\[web\\],`,
    ` {4}env: (\\{[^\\n]*\\}),`,
    ` {2}\\}\\),`,
    `\\}\\);$`,
  ].join("\\n"),
);

/**
 * The Fly site's values when deploy/fly.ts and deploy/fly-machine.ts declare
 * exactly the template's resources (their comments aside), or null. A site
 * the project changed is left in its files, and the plan says so.
 */
export function readFlySite(fly: string, machine: string): FlySiteValues | null {
  const f = FLY_CODE.exec(codeOf(fly));
  const m = MACHINE_CODE.exec(codeOf(machine));
  if (!f || !m) return null;
  const [, nameImport, app, region, volumeName, sizeGb, ip, secretName, secretValue] = f;
  const [, cpuKind, cpus, memoryMb, mountVolume, mountPath, port, machineName, machineRegion, image, env] = m;
  // One region and one Volume: what the composite declares.
  if (machineRegion !== region || mountVolume !== volumeName) return null;
  return {
    nameImport: nameImport ?? null,
    app,
    region,
    machine: machineName,
    image,
    port,
    env,
    cpuKind,
    cpus,
    memoryMb,
    volume: { name: volumeName, sizeGb, path: mountPath },
    ip,
    secret: { name: secretName, value: secretValue },
  };
}

/** deploy/fly.ts declaring the site with the fly lexicon's FlySite composite. */
export function flySiteFile(v: FlySiteValues): string {
  return `/**
 * The Fly site, \`fly\` in chant.config.ts's chud.sites, declared with the fly
 * lexicon's FlySite composite: the App, the Machine that serves the app (Fly's
 * proxy sends 443 and 80 to its port ${v.port}), the Volume the app's data
 * lives on, mounted at ${JSON.parse(v.volume.path)}, a public IP and the ${JSON.parse(v.secret.name)}
 * Secret. \`chant build deploy --lexicon fly\` serializes it to Machines API
 * requests, with the one Machine a release ships to. \`chant workspace graph
 * --composites\` lists it as the instance \`flySite\`, which the app component
 * (app.component.ts) deploys: it names FlySite in its \`composites\`.
 *
 * The same declarations apply to a real Fly org (FLY_API_TOKEN, and FLY_ORG
 * for the org) or to mudflaps, the Machines API emulator, when
 * FLY_FLAPS_BASE_URL points at it. Fly app names are global; change the name
 * before the first release to a real org if it is taken.
 *
 * No secret value is in the repo. ${JSON.parse(v.secret.name)}'s value comes from the
 * environment at release time; without it, the release checks the app
 * already has it (\`fly secrets set ${JSON.parse(v.secret.name)}=...\`) and refuses otherwise.
 *
 * \`chant workspace upgrade\` wrote this from deploy/fly.ts and
 * deploy/fly-machine.ts (its migration ${CHUD_LEXICON_EXIT_FLY_SITE}), with the
 * same resources, in place of chud's FlySite marker and ChudLocalSite
 * composite (ws-056). The local site is the studio kit's box service
 * (arugula-salad/studio, template/).
 */
import { Fly, FlySite } from "@intentius/chant-lexicon-fly";
${v.nameImport ? `${v.nameImport}\n` : ""}
export const flySite = FlySite({
  app: ${v.app},
  org: Fly.OrgSlug,
  region: ${v.region},
  machine: ${v.machine},
  image: ${v.image},
  port: ${v.port},
  env: ${v.env},
  cpuKind: ${v.cpuKind},
  cpus: ${v.cpus},
  memoryMb: ${v.memoryMb},
  volume: { name: ${v.volume.name}, sizeGb: ${v.volume.sizeGb}, path: ${v.volume.path} },
  ip: ${v.ip},
  secrets: { ${/^[A-Za-z_$][\w$]*$/.test(JSON.parse(v.secret.name)) ? JSON.parse(v.secret.name) : v.secret.name}: ${v.secret.value} },
});
`;
}


const COMPONENT_BARE = '  archetype: "service",\n  dependsOn: [],\n';
const COMPONENT_NAMED = '  archetype: "service",\n  composites: ["FlySite"],\n  dependsOn: [],\n';
const COMPONENT_SAID = " * (arugula-salad/studio, template/), and the Fly site's resources stay in\n * fly.ts and fly-machine.ts.\n */";
const COMPONENT_SAYS =
  " * (arugula-salad/studio, template/).\n *\n * It deploys the Fly site, the fly lexicon's FlySite composite in fly.ts, and\n * says so in `composites`, so `chant workspace graph --composites` lists the\n * site's instance with this component.\n */";
/** The release Op's comment on where the Fly requests come from, as chud-lexicon-exit wrote it, and once the site is a FlySite. */
const RELEASE_SAID = " *   deploy/fly.ts and deploy/fly-machine.ts, into dist/fly.json).";
const RELEASE_SAYS = " *   the FlySite composite in deploy/fly.ts, into dist/fly.json).";

interface Declaration {
  members?: Array<{ dir?: string; kind?: string }>;
}

function planFlySite(ctx: ChantMigrationContext): ChantMigrationPlan | null {
  const { dir } = ctx;
  let decl: Declaration | null = null;
  try {
    decl = JSON.parse(readText(dir, "chant.workspace.json") ?? "null") as Declaration | null;
  } catch {
    decl = null;
  }
  const candidates = (decl?.members ?? []).filter((m) => m.kind === "chant" && m.dir).map((m) => posix.normalize(m.dir!));
  if (!candidates.includes("delivery")) candidates.push("delivery");

  const changes: PlannedChange[] = [];
  const notMoved: NotMoved[] = [];
  for (const d of candidates) {
    const at = (p: string) => posix.join(d, p);
    const component = readText(dir, at("deploy/app.component.ts"));
    if (component === undefined || !/its\s+\*?\s*migration chud-lexicon-exit\)/.test(component) || !component.includes(COMPONENT_BARE)) continue;

    const fly = readText(dir, at("deploy/fly.ts"));
    const machine = readText(dir, at("deploy/fly-machine.ts"));
    const site = fly !== undefined && machine !== undefined ? readFlySite(fly, machine) : null;
    if (site) {
      changes.push({ path: at("deploy/fly.ts"), action: "write", why: "the Fly site as the fly lexicon's FlySite composite, the instance the app component deploys", data: Buffer.from(flySiteFile(site)) });
      changes.push({ path: at("deploy/fly-machine.ts"), action: "delete", why: "its Machine is the FlySite composite's, in deploy/fly.ts" });
      const release = readText(dir, at("ops/release.op.ts"));
      if (release?.includes(RELEASE_SAID)) {
        changes.push({ path: at("ops/release.op.ts"), action: "write", why: "its comment names the FlySite composite", data: Buffer.from(release.replace(RELEASE_SAID, RELEASE_SAYS)) });
      }
    } else if (fly !== undefined) {
      notMoved.push({ what: `the Fly site as a composite instance (${at("deploy/fly.ts")} is not the template's, so its resources are kept as they are)`, where: "the fly lexicon's FlySite composite: declare the site with it, and the app component, which names FlySite in `composites`, deploys it" });
    }
    changes.push({ path: at("deploy/app.component.ts"), action: "write", why: "names FlySite in `composites`", data: Buffer.from(component.replace(COMPONENT_BARE, COMPONENT_NAMED).replace(COMPONENT_SAID, COMPONENT_SAYS)) });
  }
  if (changes.length === 0) return null;
  return { id: CHUD_LEXICON_EXIT_FLY_SITE, description: DESCRIPTION, changes, notMoved, conflicts: [] };
}

export const chudLexiconExitFlySite: ChantMigration = {
  id: CHUD_LEXICON_EXIT_FLY_SITE,
  description: DESCRIPTION,
  plan: planFlySite,
};
