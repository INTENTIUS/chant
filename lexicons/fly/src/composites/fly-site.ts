/**
 * FlySite composite: a Fly app that serves one app's releases.
 *
 * It declares the App, the Machine that serves (behind Fly's proxy on 443 and
 * 80), and, when asked for, a Volume the app's data lives on, mounted into the
 * Machine, a public IP, and the app's Secrets. It is the fly lexicon's home
 * for chud's `FlySite` and `ChudLocalSite` sites (ws-056, #2809): a repo that
 * `chant workspace upgrade` takes off the chud lexicon declares its Fly site
 * with it, so `chant workspace graph --composites` lists the site as a
 * composite instance, and a component that names `FlySite` in its
 * `composites` deploys it.
 *
 * The Machine is the one a release ships to: `chant build --lexicon fly`
 * serializes the site into a plan with exactly one Machine, so the
 * `fly-release` steps (a component's deploy, or an Op's `flyRelease`) find it
 * without being told its name. `image` is what the Machine runs until a
 * release puts its own image, or its files and start command, on it.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import type { Declarable } from "@intentius/chant/declarable";
import { Fly } from "../pseudo";
import {
  App,
  IPAddress,
  Machine,
  MachineConfig,
  MachineGuest,
  MachineMount,
  MachinePort,
  MachineService,
  Secret,
  Volume,
} from "../generated/index";

export interface FlySiteProps {
  /** The App's name. Fly app names are global. */
  app: string;
  /** The owning org (default: `Fly.OrgSlug`, which the build resolves from `FLY_ORG`). */
  org?: string | Declarable;
  /** Region of the Machine and the Volume (default: `Fly.Region`, from `FLY_REGION`). */
  region?: string | Declarable;
  /** The Machine's name (default: "web"). */
  machine?: string;
  /** The image the Machine runs until a release replaces it. */
  image: string;
  /** The port the app listens on inside the Machine (default: 8080). Fly's proxy sends 443 (TLS) and 80 to it. */
  port?: number;
  /** The Machine's env. */
  env?: Record<string, string>;
  /** Guest CPU kind (default: "shared"). */
  cpuKind?: string;
  /** Guest CPUs (default: 1). */
  cpus?: number;
  /** Guest memory in MB (default: 256). */
  memoryMb?: number;
  /** A Volume for the app's data, mounted at `path`. It outlives releases. Omitted: no Volume. */
  volume?: { name: string; sizeGb: number; path: string };
  /** A public IP of this type (for example "shared_v4"). Omitted: none. */
  ip?: "shared_v4" | "v4" | "v6";
  /**
   * The app's Secrets, by name. An undefined value declares the Secret
   * without a value, so the release checks the app already has it.
   */
  secrets?: Record<string, string | undefined>;
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    app?: Partial<Record<string, unknown>>;
    machine?: Partial<Record<string, unknown>>;
    volume?: Partial<Record<string, unknown>>;
  };
}

/** `APP_SECRET` -> `appSecret`: a Secret's member name, never one of the other members'. */
function memberName(secret: string): string {
  const words = secret.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const name = words.map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join("") || "secret";
  return ["app", "machine", "volume", "ip"].includes(name) ? `${name}Secret` : name;
}

/**
 * Create a FlySite composite. Returns the App and the Machine, and the
 * Volume, IP and Secrets it was asked for.
 *
 * @example
 * ```ts
 * import { FlySite } from "@intentius/chant-lexicon-fly";
 *
 * export const flySite = FlySite({
 *   app: "notes",
 *   region: "iad",
 *   image: "node:22-slim",
 *   env: { PORT: "8080", APP_DATA: "/data" },
 *   volume: { name: "data", sizeGb: 1, path: "/data" },
 *   ip: "shared_v4",
 *   secrets: { APP_SECRET: process.env.APP_SECRET || undefined },
 * });
 * ```
 */
export const FlySite = Composite((props: FlySiteProps) => {
  const { port = 8080, cpuKind = "shared", cpus = 1, memoryMb = 256, defaults: defs } = props;
  const region = props.region ?? Fly.Region;

  const app = new App(mergeDefaults({ name: props.app, org_slug: props.org ?? Fly.OrgSlug } as Record<string, unknown>, defs?.app) as ConstructorParameters<typeof App>[0]);

  const volume = props.volume
    ? new Volume(mergeDefaults({ name: props.volume.name, region, size_gb: props.volume.sizeGb } as Record<string, unknown>, defs?.volume) as ConstructorParameters<typeof Volume>[0])
    : undefined;

  const config = new MachineConfig({
    image: props.image,
    guest: new MachineGuest({ cpu_kind: cpuKind, cpus, memory_mb: memoryMb }),
    ...(props.volume ? { mounts: [new MachineMount({ volume: props.volume.name, path: props.volume.path })] } : {}),
    services: [
      new MachineService({
        protocol: "tcp",
        internal_port: port,
        ports: [new MachinePort({ port: 443, handlers: ["tls", "http"] }), new MachinePort({ port: 80, handlers: ["http"] })],
      }),
    ],
    ...(props.env ? { env: props.env } : {}),
  });

  const machine = new Machine(mergeDefaults({ name: props.machine ?? "web", region, config } as Record<string, unknown>, defs?.machine) as ConstructorParameters<typeof Machine>[0]);

  const ip = props.ip ? new IPAddress({ type: props.ip }) : undefined;

  const secrets: Record<string, Declarable> = {};
  for (const [name, value] of Object.entries(props.secrets ?? {})) {
    secrets[memberName(name)] = new Secret({ name, value } as ConstructorParameters<typeof Secret>[0]);
  }

  return {
    app,
    machine,
    ...(volume ? { volume } : {}),
    ...(ip ? { ip } : {}),
    ...secrets,
  };
}, "FlySite");
