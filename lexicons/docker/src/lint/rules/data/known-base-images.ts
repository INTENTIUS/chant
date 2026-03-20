/**
 * Well-known Docker base images for rule validation.
 */

export const KNOWN_BASE_IMAGES = new Set([
  "alpine", "ubuntu", "debian", "centos", "fedora", "amazonlinux",
  "node", "python", "ruby", "golang", "rust", "java", "openjdk",
  "nginx", "httpd", "caddy", "traefik",
  "postgres", "mysql", "mariadb", "mongodb", "redis", "memcached",
  "rabbitmq", "kafka", "zookeeper",
  "elasticsearch", "kibana", "logstash",
  "busybox", "scratch",
]);

/**
 * Images that are safe to use without a tag (they have meaningful `latest`).
 */
export const IMAGES_SAFE_LATEST = new Set([
  "scratch",
]);
