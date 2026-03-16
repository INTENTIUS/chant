import type { Intrinsic } from "./intrinsic";

/**
 * Value type that can be either a concrete value T or an Intrinsic
 */
export type Value<T> = T | Intrinsic;

/**
 * Converts all properties of T to Value<T> types
 *
 * @example
 * ```ts
 * interface Props { name: string; count: number }
 * type ValueProps = AllValues<Props>
 * // Result: { name: Value<string>; count: Value<number> }
 * ```
 */
export type AllValues<T> = {
  [K in keyof T]: Value<T[K]>;
};

/**
 * Makes specific properties K of T be Value types while keeping others unchanged
 *
 * @example
 * ```ts
 * interface Props { name: string; count: number; enabled: boolean }
 * type ValueProps = PartialValues<Props, 'name' | 'count'>
 * // Result: { name: Value<string>; count: Value<number>; enabled: boolean }
 * ```
 */
export type PartialValues<T, K extends keyof T> = {
  [P in keyof T]: P extends K ? Value<T[P]> : T[P];
};

/**
 * Makes specific properties K of T required while keeping others unchanged
 *
 * @example
 * ```ts
 * interface Props { name?: string; count?: number; enabled?: boolean }
 * type RequiredNameProps = RequiredProps<Props, 'name'>
 * // Result: { name: string; count?: number; enabled?: boolean }
 * ```
 */
type Prettify<T> = { [P in keyof T]: T[P] } & {};
export type RequiredProps<T, K extends keyof T> = Prettify<Omit<T, K> & Required<Pick<T, K>>>;
