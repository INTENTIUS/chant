import { table } from "../lexicon/index";

// A backslash in the SQL. Running the file hands the tag a TemplateStringsArray
// whose `.raw` holds `\d`; fold hands it the cooked strings only.
export const patterns = table`
  CREATE TABLE patterns (
    id  UInt64,
    re  String DEFAULT '\d+\t'
  )
  ENGINE = MergeTree
  ORDER BY id`;
