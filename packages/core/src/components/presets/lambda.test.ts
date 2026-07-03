/**
 * `LambdaComponent` (#566): schema validity, and equivalence with the
 * hand-composed `lambda.pilot.ts` reference component.
 */

import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import componentSchema from "../component.schema.json";
import { projectToJson } from "../component";
import { imageProcessor } from "../pilots/lambda.pilot";
import { LambdaComponent } from "./lambda";

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(componentSchema);

describe("LambdaComponent preset", () => {
  it("expands to a component that projects to schema-valid JSON", () => {
    const component = LambdaComponent({ name: "image-processor-lambda", functionName: "image-processor" });
    const projected = projectToJson(component);
    const valid = validate(projected);
    if (!valid) throw new Error(ajv.errorsText(validate.errors));
    expect(valid).toBe(true);
  });

  it("re-derives lambda.pilot.ts's hand-composed imageProcessor component byte-for-byte (as data)", () => {
    const fromPreset = LambdaComponent({ name: "image-processor-lambda", functionName: "image-processor" });
    expect(projectToJson(fromPreset)).toEqual(projectToJson(imageProcessor));
  });

  it("defaults functionName to the component name when omitted", () => {
    const component = LambdaComponent({ name: "thumbnailer" });
    const applyStep = component.deploy.find((p) => p.phase === "Apply")!.steps[0] as unknown as { functionName: string };
    expect(applyStep.functionName).toBe("thumbnailer");
  });
});
