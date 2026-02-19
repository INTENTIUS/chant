import { describe, test, expectTypeOf } from "bun:test";
import type { Value, AllValues, PartialValues, RequiredProps } from "./types";
import type { Intrinsic } from "./intrinsic";

describe("Value<T>", () => {
  test("accepts concrete value", () => {
    expectTypeOf<string>().toMatchTypeOf<Value<string>>();
    expectTypeOf<number>().toMatchTypeOf<Value<number>>();
    expectTypeOf<boolean>().toMatchTypeOf<Value<boolean>>();
  });

  test("accepts Intrinsic", () => {
    expectTypeOf<Intrinsic>().toMatchTypeOf<Value<string>>();
    expectTypeOf<Intrinsic>().toMatchTypeOf<Value<number>>();
    expectTypeOf<Intrinsic>().toMatchTypeOf<Value<boolean>>();
  });
});

describe("AllValues<T>", () => {
  test("converts all properties to Value types", () => {
    interface Props {
      name: string;
      count: number;
      enabled: boolean;
    }

    type ValueProps = AllValues<Props>;

    expectTypeOf<ValueProps>().toEqualTypeOf<{
      name: Value<string>;
      count: Value<number>;
      enabled: Value<boolean>;
    }>();
  });

  test("preserves optional properties", () => {
    interface Props {
      required: string;
      optional?: number;
    }

    type ValueProps = AllValues<Props>;

    expectTypeOf<ValueProps>().toEqualTypeOf<{
      required: Value<string>;
      optional?: Value<number>;
    }>();
  });

  test("handles complex types", () => {
    interface Props {
      arr: string[];
      obj: { key: string };
      union: string | number;
    }

    type ValueProps = AllValues<Props>;

    expectTypeOf<ValueProps>().toEqualTypeOf<{
      arr: Value<string[]>;
      obj: Value<{ key: string }>;
      union: Value<string | number>;
    }>();
  });

  test("handles empty interface", () => {
    interface Props {}

    type ValueProps = AllValues<Props>;

    expectTypeOf<ValueProps>().toEqualTypeOf<{}>();
  });

  test("handles nested objects", () => {
    interface Props {
      config: {
        host: string;
        port: number;
      };
    }

    type ValueProps = AllValues<Props>;

    expectTypeOf<ValueProps>().toEqualTypeOf<{
      config: Value<{
        host: string;
        port: number;
      }>;
    }>();
  });
});

describe("PartialValues<T, K>", () => {
  test("converts specified properties to Value types", () => {
    interface Props {
      name: string;
      count: number;
      enabled: boolean;
    }

    type ValueProps = PartialValues<Props, "name" | "count">;

    expectTypeOf<ValueProps>().toEqualTypeOf<{
      name: Value<string>;
      count: Value<number>;
      enabled: boolean;
    }>();
  });

  test("converts single property to Value type", () => {
    interface Props {
      name: string;
      count: number;
    }

    type ValueProps = PartialValues<Props, "name">;

    expectTypeOf<ValueProps>().toEqualTypeOf<{
      name: Value<string>;
      count: number;
    }>();
  });

  test("preserves optional properties", () => {
    interface Props {
      name: string;
      count?: number;
    }

    type ValueProps = PartialValues<Props, "name">;

    expectTypeOf<ValueProps>().toEqualTypeOf<{
      name: Value<string>;
      count?: number;
    }>();
  });

  test("handles complex types", () => {
    interface Props {
      arr: string[];
      obj: { key: string };
      primitive: string;
    }

    type ValueProps = PartialValues<Props, "arr" | "obj">;

    expectTypeOf<ValueProps>().toEqualTypeOf<{
      arr: Value<string[]>;
      obj: Value<{ key: string }>;
      primitive: string;
    }>();
  });

  test("works with all properties", () => {
    interface Props {
      name: string;
      count: number;
    }

    type ValueProps = PartialValues<Props, "name" | "count">;

    expectTypeOf<ValueProps>().toEqualTypeOf<{
      name: Value<string>;
      count: Value<number>;
    }>();
  });

  test("works with no conversion (unrealistic but valid)", () => {
    interface Props {
      name: string;
      count: number;
    }

    type ValueProps = PartialValues<Props, never>;

    expectTypeOf<ValueProps>().toEqualTypeOf<{
      name: string;
      count: number;
    }>();
  });
});

describe("RequiredProps<T, K>", () => {
  test("makes specified properties required", () => {
    interface Props {
      name?: string;
      count?: number;
      enabled?: boolean;
    }

    type RequiredNameProps = RequiredProps<Props, "name">;

    expectTypeOf<RequiredNameProps>().toEqualTypeOf<{
      name: string;
      count?: number;
      enabled?: boolean;
    }>();
  });

  test("makes multiple properties required", () => {
    interface Props {
      name?: string;
      count?: number;
      enabled?: boolean;
    }

    type RequiredMultiProps = RequiredProps<Props, "name" | "count">;

    expectTypeOf<RequiredMultiProps>().toEqualTypeOf<{
      name: string;
      count: number;
      enabled?: boolean;
    }>();
  });

  test("handles already required properties", () => {
    interface Props {
      name: string;
      count?: number;
    }

    type RequiredNameProps = RequiredProps<Props, "name">;

    expectTypeOf<RequiredNameProps>().toEqualTypeOf<{
      name: string;
      count?: number;
    }>();
  });

  test("makes all properties required", () => {
    interface Props {
      name?: string;
      count?: number;
    }

    type AllRequiredProps = RequiredProps<Props, "name" | "count">;

    expectTypeOf<AllRequiredProps>().toEqualTypeOf<{
      name: string;
      count: number;
    }>();
  });

  test("handles complex types", () => {
    interface Props {
      arr?: string[];
      obj?: { key: string };
      primitive?: string;
    }

    type RequiredArrProps = RequiredProps<Props, "arr">;

    expectTypeOf<RequiredArrProps>().toEqualTypeOf<{
      arr: string[];
      obj?: { key: string };
      primitive?: string;
    }>();
  });

  test("handles mixed required and optional", () => {
    interface Props {
      required: string;
      optional1?: number;
      optional2?: boolean;
    }

    type PartiallyRequired = RequiredProps<Props, "optional1">;

    expectTypeOf<PartiallyRequired>().toEqualTypeOf<{
      required: string;
      optional1: number;
      optional2?: boolean;
    }>();
  });
});

describe("Combined usage", () => {
  test("AllValues and RequiredProps can be combined", () => {
    interface Props {
      name?: string;
      count?: number;
    }

    type Combined = AllValues<RequiredProps<Props, "name">>;

    expectTypeOf<Combined>().toEqualTypeOf<{
      name: Value<string>;
      count?: Value<number>;
    }>();
  });

  test("PartialValues and RequiredProps can be combined", () => {
    interface Props {
      name?: string;
      count?: number;
      enabled?: boolean;
    }

    type Combined = PartialValues<RequiredProps<Props, "name">, "count">;

    expectTypeOf<Combined>().toEqualTypeOf<{
      name: string;
      count?: Value<number>;
      enabled?: boolean;
    }>();
  });
});
