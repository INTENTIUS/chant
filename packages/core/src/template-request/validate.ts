/** One Ajv for the template-request/v1 schemas (template.yml and the request), compiled on first use. */

import requestSchema from "./template-request.schema.json" with { type: "json" };
import templateSchema from "./template.schema.json" with { type: "json" };
import { loadAjv2020 } from "../workspace/ajv2020";

type ValidateFn = ((data: unknown) => boolean) & { errors?: { instancePath: string; message?: string }[] | null };

interface AjvInstance {
  addSchema(schema: object): unknown;
  getSchema(id: string): unknown;
}

let ajv: AjvInstance | undefined;

/** The problems of `doc` against the schema `id`, one line each; empty when it is valid. */
export function schemaProblems(id: string, doc: unknown): string[] {
  if (!ajv) {
    const Ajv = loadAjv2020();
    const made = new Ajv({ allErrors: true, strict: true }) as unknown as AjvInstance;
    for (const s of [requestSchema, templateSchema]) made.addSchema(s);
    ajv = made;
  }
  const fn = ajv.getSchema(id) as ValidateFn | undefined;
  if (!fn) throw new Error(`no schema ${id}`);
  if (fn(doc)) return [];
  return (fn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is not valid"}`);
}
