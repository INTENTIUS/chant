import type { LintRule } from "@intentius/chant/lint/rule";
import { templateSizeRule } from "./template-size";
import { pinnedImageRule } from "./pinned-image";

export { templateSizeRule } from "./template-size";
export { pinnedImageRule, isFloatingImage } from "./pinned-image";

/** All lint rules the e2b lexicon provides. */
export const rules: LintRule[] = [templateSizeRule, pinnedImageRule];
