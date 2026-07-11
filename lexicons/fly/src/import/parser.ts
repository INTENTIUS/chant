/**
 * flaps JSON template parser.
 *
 * Turns Fly Machines API ("flaps") JSON into the import IR for conversion to
 * chant TypeScript. Three input shapes are accepted, all mapped to the authoring
 * surface (the writable fields a user would have declared):
 *
 *   1. The #738 serializer plan — `{ <entity>: { endpoint, method, body } }`.
 *      `/v1/apps` bodies become `App`s; `.../machines` bodies become `Machine`s.
 *   2. A machines listing (an array) or an app-with-machines bundle
 *      (`{ ...appFields, machines: [...] }`) — an `App` plus its `Machine`s.
 *   3. A single machine (`{ name, region, config }`) or a single app
 *      (`{ app_name }` / the `GET /v1/apps/{app}` shape).
 *
 * flaps wire field names are mapped back to the authoring surface: an app's
 * `app_name` becomes the `App`'s `name`, and server-written read-only machine
 * fields (id, state, instance_id, ...) are dropped so the IR is the declared
 * shape. `logicalId` is the app/machine name (the generator camelCases it into a
 * variable).
 */

import type {
  TemplateParser,
  TemplateIR,
  ResourceIR,
} from "@intentius/chant/import/parser";
import { BaseValueParser } from "@intentius/chant/import/base-parser";
import { isSerializerPlan } from "../detect";

export const APP_TYPE = "Fly::Machines::App";
export const MACHINE_TYPE = "Fly::Machines::Machine";

/** Server-written read-only machine fields — never part of the authored shape. */
export const MACHINE_SERVER_FIELDS = [
  "id",
  "state",
  "created_at",
  "updated_at",
  "private_ip",
  "instance_id",
  "nonce",
  "checks",
  "events",
  "host_status",
  "image_ref",
  "incomplete_config",
];

/** Server-written read-only app fields — never part of the authored shape. */
export const APP_SERVER_FIELDS = [
  "id",
  "status",
  "machine_count",
  "volume_count",
  "internal_numeric_id",
  "organization",
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class FlyParser extends BaseValueParser implements TemplateParser {
  protected dispatchIntrinsic(
    _key: string,
    _value: unknown,
    _obj: Record<string, unknown>,
  ): unknown | null {
    // flaps JSON has no intrinsic functions.
    return null;
  }

  parse(input: string): TemplateIR {
    const trimmed = input.trim();
    if (!trimmed) return { resources: [], parameters: [] };

    const data = JSON.parse(trimmed) as unknown;
    const resources: ResourceIR[] = [];

    if (isSerializerPlan(data)) {
      for (const [entityName, req] of Object.entries(data as Record<string, unknown>)) {
        const r = this.resourceFromRequest(entityName, req as Record<string, unknown>);
        if (r) resources.push(r);
      }
      return { resources, parameters: [] };
    }

    if (Array.isArray(data)) {
      for (const m of data) {
        if (isRecord(m)) resources.push(this.machineResource(m));
      }
      return { resources, parameters: [] };
    }

    if (isRecord(data)) {
      // App-with-machines bundle: top-level app fields plus a `machines` array.
      if (Array.isArray(data.machines)) {
        const { machines, ...appFields } = data;
        if (this.looksLikeApp(appFields)) resources.push(this.appResource(appFields));
        for (const m of machines) {
          if (isRecord(m)) resources.push(this.machineResource(m));
        }
        return { resources, parameters: [] };
      }

      // A single machine (has a config) wins over an app read, since a machine
      // GET also carries a `name`.
      if (isRecord(data.config)) {
        resources.push(this.machineResource(data));
        return { resources, parameters: [] };
      }

      if (this.looksLikeApp(data)) {
        resources.push(this.appResource(data));
        return { resources, parameters: [] };
      }
    }

    return { resources, parameters: [] };
  }

  /** Map one serializer-plan request to a resource by its endpoint. */
  private resourceFromRequest(
    entityName: string,
    req: Record<string, unknown>,
  ): ResourceIR | null {
    const endpoint = typeof req.endpoint === "string" ? req.endpoint : "";
    const body = isRecord(req.body) ? req.body : {};

    if (/^\/v1\/apps\/?$/.test(endpoint)) {
      return this.appResource(body, entityName);
    }
    if (/^\/v1\/apps\/[^/]+\/machines\/?$/.test(endpoint)) {
      return this.machineResource(body, entityName);
    }
    // Other endpoints (volumes, ip_assignments, certificates, secrets) are not
    // part of the App/Machine import surface.
    return null;
  }

  private looksLikeApp(obj: Record<string, unknown>): boolean {
    return typeof obj.app_name === "string" || typeof obj.name === "string";
  }

  /** An `App` resource. flaps `app_name` (create body) or `name` (GET) → `name`. */
  private appResource(obj: Record<string, unknown>, entityName?: string): ResourceIR {
    const name =
      (typeof obj.app_name === "string" && obj.app_name) ||
      (typeof obj.name === "string" && obj.name) ||
      entityName ||
      "app";

    const properties: Record<string, unknown> = { name };
    // org_slug either sits on the create body directly, or is carried on the GET
    // shape under `organization.slug`.
    if (obj.org_slug !== undefined) {
      properties.org_slug = this.parseValue(obj.org_slug);
    } else if (isRecord(obj.organization) && typeof obj.organization.slug === "string") {
      properties.org_slug = obj.organization.slug;
    }
    if (obj.network !== undefined) properties.network = this.parseValue(obj.network);
    if (obj.enable_subdomains !== undefined) {
      properties.enable_subdomains = this.parseValue(obj.enable_subdomains);
    }

    return { logicalId: name, type: APP_TYPE, properties };
  }

  /** A `Machine` resource, stripped of server-written read-only fields. */
  private machineResource(obj: Record<string, unknown>, entityName?: string): ResourceIR {
    const name =
      (typeof obj.name === "string" && obj.name) || entityName || "machine";

    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (MACHINE_SERVER_FIELDS.includes(key)) continue;
      if (value === undefined) continue;
      properties[key] = this.parseValue(value);
    }
    // Always carry a name so the round-trip keeps the machine's identity.
    properties.name = name;

    return { logicalId: name, type: MACHINE_TYPE, properties };
  }
}
