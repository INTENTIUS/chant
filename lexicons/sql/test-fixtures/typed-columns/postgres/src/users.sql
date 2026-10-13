CREATE TABLE shop.users (
  id bigint PRIMARY KEY,
  tags text[],
  profile jsonb
);
