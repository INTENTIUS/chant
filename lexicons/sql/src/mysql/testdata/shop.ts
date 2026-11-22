/**
 * A recorded MySQL 8.0 schema (#5449): what `SHOW CREATE` prints for a small
 * shop, written as a MySQL 8.0.40 server prints it, and the declarations
 * that create the same objects. The plan, apply and import tests read it.
 */

import type { FakeObject } from "../testing/fake-server";

export const SHOP_DATABASE = "CREATE DATABASE `shop` /*!40100 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci */ /*!80016 DEFAULT ENCRYPTION='N' */";

export const USERS_TABLE = [
  "CREATE TABLE `users` (",
  "  `id` bigint unsigned NOT NULL AUTO_INCREMENT,",
  "  `email` varchar(255) NOT NULL,",
  "  `name` varchar(100) DEFAULT NULL,",
  "  `active` tinyint(1) NOT NULL DEFAULT '1',",
  "  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),",
  "  PRIMARY KEY (`id`),",
  "  UNIQUE KEY `users_email` (`email`)",
  ") ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='people who buy [chant managed-by=chant stack=shop env=prod]'",
].join("\n");

export const ORDERS_TABLE = [
  "CREATE TABLE `orders` (",
  "  `id` bigint unsigned NOT NULL AUTO_INCREMENT,",
  "  `user_id` bigint unsigned NOT NULL,",
  "  `total` decimal(10,2) NOT NULL DEFAULT '0.00',",
  "  `status` enum('new','paid','shipped') NOT NULL DEFAULT 'new',",
  "  `placed_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,",
  "  PRIMARY KEY (`id`),",
  "  KEY `orders_user` (`user_id`),",
  "  KEY `placed_at` (`placed_at`),",
  "  CONSTRAINT `orders_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,",
  "  CONSTRAINT `orders_chk_1` CHECK ((`total` >= 0))",
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='[chant managed-by=chant stack=shop env=prod]'",
].join("\n");

export const PAID_VIEW =
  "CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `paid_orders` AS select `orders`.`id` AS `id`,`orders`.`total` AS `total` from `orders` where (`orders`.`status` = 'paid')";

/** The server as recorded: the shop database, its two tables and its view. */
export const SHOP_OBJECTS: FakeObject[] = [
  { kind: "database", name: "shop", statement: SHOP_DATABASE },
  { kind: "table", database: "shop", name: "users", statement: USERS_TABLE, comment: "people who buy [chant managed-by=chant stack=shop env=prod]" },
  { kind: "table", database: "shop", name: "orders", statement: ORDERS_TABLE, comment: "[chant managed-by=chant stack=shop env=prod]" },
  { kind: "view", database: "shop", name: "paid_orders", statement: PAID_VIEW },
];

/** The declarations, as a project writes them, that create what {@link SHOP_OBJECTS} holds. */
export const SHOP_SOURCE = {
  database: "CREATE DATABASE shop DEFAULT CHARACTER SET utf8mb4",
  users: `CREATE TABLE shop.users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    name VARCHAR(100),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY users_email (email)
  ) ENGINE = InnoDB COMMENT = 'people who buy'`,
  orders: `CREATE TABLE shop.orders (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    total DECIMAL(10,2) NOT NULL DEFAULT 0,
    status ENUM('new', 'paid', 'shipped') NOT NULL DEFAULT 'new',
    placed_at TIMESTAMP NOT NULL DEFAULT NOW() ON UPDATE NOW(),
    KEY (placed_at),
    CONSTRAINT orders_user FOREIGN KEY (user_id) REFERENCES shop.users (id) ON DELETE CASCADE,
    CHECK (total >= 0)
  )`,
  paidOrders: "CREATE VIEW shop.paid_orders AS SELECT id, total FROM shop.orders WHERE status = 'paid'",
};
