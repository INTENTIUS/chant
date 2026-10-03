import { schema, type } from "../lexicon/index";

export const app = schema`CREATE SCHEMA app`;

export const orderStatus = type`
  CREATE TYPE ${app}.order_status AS ENUM ('placed', 'paid', 'shipped', 'cancelled')`;
