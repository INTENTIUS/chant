import { describe, test, expect } from "bun:test";
import { reference, ReferenceIntrinsic } from "./intrinsics";
import { INTRINSIC_MARKER } from "@intentius/chant/intrinsic";

describe("reference intrinsic", () => {
  test("creates a ReferenceIntrinsic instance", () => {
    const ref = reference("job_name", "script");
    expect(ref).toBeInstanceOf(ReferenceIntrinsic);
  });

  test("has INTRINSIC_MARKER set to true", () => {
    const ref = reference("job_name", "script");
    expect(ref[INTRINSIC_MARKER]).toBe(true);
  });

  test("toJSON returns the path array", () => {
    const ref = reference("job_name", "script");
    expect(ref.toJSON()).toEqual(["job_name", "script"]);
  });

  test("toJSON returns single-element path", () => {
    const ref = reference(".setup");
    expect(ref.toJSON()).toEqual([".setup"]);
  });

  test("toJSON returns multi-element path", () => {
    const ref = reference(".base", "before_script", "0");
    expect(ref.toJSON()).toEqual([".base", "before_script", "0"]);
  });

  test("toYAML returns !reference tag with path", () => {
    const ref = reference("job_name", "script");
    const yaml = ref.toYAML();
    expect(yaml.tag).toBe("!reference");
    expect(yaml.value).toEqual(["job_name", "script"]);
  });

  test("empty path produces empty array", () => {
    const ref = reference();
    expect(ref.toJSON()).toEqual([]);
  });
});
