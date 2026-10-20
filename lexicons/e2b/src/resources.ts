/**
 * The e2b lexicon's one declarable kind: a sandbox template.
 *
 * A steward's sandbox is made from a template (`template` in the profile,
 * default `base`). The runtime needs git and Node in it, and a project usually
 * wants its own tools there too, installed once rather than on every run. A
 * `Template` declares that image; `chant build` writes it out as the
 * `e2b.Dockerfile` and `e2b.toml` pair `e2b template build` reads.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { createResource } from "@intentius/chant/runtime";
import { TEMPLATE_TYPE } from "./catalog";

export interface TemplateProps {
  /** The template's name on E2B: lowercase letters, digits, dashes and underscores. A profile's `template` names it. */
  name: string;
  /** The Debian-based image the template starts from, such as `node:22-bookworm`. Pin a tag. */
  fromImage: string;
  /** Shell commands run in order while the template builds, one `RUN` line each. */
  run?: string[];
  /** Environment variables set in every sandbox made from the template. */
  env?: Record<string, string>;
  /** The working directory for the `run` steps and the start command. */
  workdir?: string;
  /** A command E2B runs when the template is snapshotted, so a sandbox starts with it running. */
  startCmd?: string;
  /** A command E2B polls until it exits 0 before it snapshots the template. */
  readyCmd?: string;
  /** vCPUs per sandbox. A positive integer; E2B's default is 2. */
  cpuCount?: number;
  /** Memory per sandbox in MiB. A positive even integer; E2B's default is 512. */
  memoryMB?: number;
  /** The E2B team that owns the template, when the API key can act for more than one. */
  teamId?: string;
}

export interface Template extends Declarable {
  readonly props: TemplateProps;
}

/** A sandbox template, serialized to `e2b.<name>.Dockerfile` and `e2b.<name>.toml`. */
export const Template = /* @__PURE__ */ createResource(TEMPLATE_TYPE, "e2b", {}) as unknown as new (
  props: TemplateProps,
) => Template;

/** The props of a declared `Template`, or `undefined` for anything else. */
export function templateProps(entity: unknown): TemplateProps | undefined {
  if (!entity || typeof entity !== "object") return undefined;
  if ((entity as { entityType?: unknown }).entityType !== TEMPLATE_TYPE) return undefined;
  return ((entity as { props?: unknown }).props ?? {}) as TemplateProps;
}
