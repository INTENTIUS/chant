import { table } from "../lexicon/index";

export const broken = table`
  CREATE TABLE broken (
    id bigint PRIMARY KEY,
    name text NOT NULL DEFAULT 'x' CHEK (name <> '')
  )`;
