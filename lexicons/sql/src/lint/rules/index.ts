import type { LintRule } from "@intentius/chant/lint/rule";
import { sqlch001 } from "./sqlch001";
import { sqlch002 } from "./sqlch002";
import { sqlch003 } from "./sqlch003";
import { sqlpg001 } from "./sqlpg001";
import { sqlpg002 } from "./sqlpg002";
import { sqlpg003 } from "./sqlpg003";

export { sqlch001, sqlch002, sqlch003, sqlpg001, sqlpg002, sqlpg003 };

/** The lexicon's source-level lint rules, returned by `lintRules()`. */
export const rules: LintRule[] = [sqlch001, sqlch002, sqlch003, sqlpg001, sqlpg002, sqlpg003];
