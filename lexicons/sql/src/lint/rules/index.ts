import type { LintRule } from "@intentius/chant/lint/rule";
import { sqlch001 } from "./sqlch001";
import { sqlch002 } from "./sqlch002";
import { sqlch003 } from "./sqlch003";

export { sqlch001, sqlch002, sqlch003 };

/** The lexicon's source-level lint rules, returned by `lintRules()`. */
export const rules: LintRule[] = [sqlch001, sqlch002, sqlch003];
