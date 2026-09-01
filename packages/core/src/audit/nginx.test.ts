import { describe, test, expect } from "vitest";
import { auditNginxConfigs, isNginxConfigPath, parseNginx, NginxParseError, type ScannableFile } from "./nginx";
import { RULE_CATALOG, RULE_CATEGORY } from "./catalog";

const file = (content: string, path = "nginx.conf"): ScannableFile => ({ path, content });

/** A minimal, otherwise-clean server (server_tokens off keeps NGX006 out of unrelated tests). */
const wrap = (body: string): string => `http {\n  server_tokens off;\n  server {\n    listen 443 ssl;\n${body}\n  }\n}\n`;

describe("isNginxConfigPath (detector)", () => {
  test("accepts nginx.conf anywhere and .conf under nginx-ish directories", () => {
    for (const p of [
      "nginx.conf",
      "deploy/nginx.conf",
      "docker/nginx/default.conf",
      "etc/nginx/conf.d/app.conf",
      "nginx/sites-available/site.conf",
      "nginx/sites-enabled/site.conf",
      "etc/nginx/snippets/ssl.conf",
    ]) {
      expect(isNginxConfigPath(p), p).toBe(true);
    }
  });

  test("rejects .conf files with no nginx-ish ancestry", () => {
    for (const p of ["app.conf", "etc/systemd/system/app.service.d/override.conf", "supervisord.conf", "src/logrotate.conf"]) {
      expect(isNginxConfigPath(p), p).toBe(false);
    }
  });
});

describe("parseNginx", () => {
  test("parses directives, nested blocks, quotes, and comments with line numbers", () => {
    const tree = parseNginx(
      `# main\nworker_processes auto;\nhttp {\n  server {\n    listen 80; # inline comment\n    server_name "ex ample.com" 'two';\n  }\n}\n`,
    );
    expect(tree.map((d) => d.name)).toEqual(["worker_processes", "http"]);
    expect(tree[0].line).toBe(2);
    const server = tree[1].block![0];
    expect(server.name).toBe("server");
    expect(server.block!.map((d) => d.name)).toEqual(["listen", "server_name"]);
    expect(server.block![0].line).toBe(5);
    // Quoting keeps spaces and strips the quotes themselves.
    expect(server.block![1].args).toEqual(["ex ample.com", "two"]);
  });

  test("throws NginxParseError on unbalanced braces and unterminated strings", () => {
    expect(() => parseNginx("http { server {")).toThrow(NginxParseError);
    expect(() => parseNginx("}")).toThrow(NginxParseError);
    expect(() => parseNginx('server_name "unterminated;')).toThrow(NginxParseError);
  });
});

describe("auditNginxConfigs — gating", () => {
  test("a candidate that fails to parse contributes no findings (never a crash)", () => {
    expect(auditNginxConfigs([file("http { { }")])).toEqual([]);
  });

  test("a .conf in a shared directory name that isn't nginx (no marker directive) contributes nothing", () => {
    // systemd-style drop-in that happens to live under conf.d/
    const systemd = file("[Service]\n", "conf.d/app.conf");
    expect(auditNginxConfigs([systemd])).toEqual([]);
    // Even nginx-looking directives without any marker stay silent.
    expect(auditNginxConfigs([file("autoindex on;\n", "conf.d/x.conf")])).toEqual([]);
  });

  test("a non-candidate path is never scanned", () => {
    expect(auditNginxConfigs([file(wrap("autoindex on;"), "README.md")])).toEqual([]);
  });
});

describe("NGX001 — deprecated TLS protocols", () => {
  test("flags SSLv3/TLSv1/TLSv1.1 with the offending names, keeps modern-only silent", () => {
    const bad = auditNginxConfigs([file(wrap("    ssl_protocols SSLv3 TLSv1 TLSv1.1 TLSv1.2;"))]);
    expect(bad).toHaveLength(1);
    expect(bad[0].checkId).toBe("NGX001");
    expect(bad[0].severity).toBe("error");
    expect(bad[0].message).toContain("SSLv3");
    expect(bad[0].line).toBeGreaterThan(1);

    expect(auditNginxConfigs([file(wrap("    ssl_protocols TLSv1.2 TLSv1.3;"))])).toEqual([]);
  });
});

describe("NGX002 — weak cipher suites", () => {
  test("flags positive weak entries; exclusions (!RC4) and modern suites pass", () => {
    const bad = auditNginxConfigs([file(wrap('    ssl_protocols TLSv1.2;\n    ssl_ciphers "HIGH:RC4-SHA:DES-CBC3-SHA";'))]);
    expect(bad.map((f) => f.checkId)).toEqual(["NGX002"]);
    expect(bad[0].message).toContain("RC4-SHA");

    const good = auditNginxConfigs([
      file(wrap('    ssl_protocols TLSv1.2;\n    ssl_ciphers "ECDHE-ECDSA-AES128-GCM-SHA256:!RC4:!MD5:!aNULL";')),
    ]);
    expect(good).toEqual([]);
  });
});

describe("NGX003 — directory listing", () => {
  test("flags autoindex on, not autoindex off", () => {
    const bad = auditNginxConfigs([file(wrap("    location /files/ {\n      autoindex on;\n    }"))]);
    expect(bad.map((f) => f.checkId)).toEqual(["NGX003"]);
    expect(auditNginxConfigs([file(wrap("    autoindex off;"))])).toEqual([]);
  });
});

describe("NGX004 — alias traversal", () => {
  test("flags the gixy shape: prefix without trailing slash + alias with one", () => {
    const bad = auditNginxConfigs([file(wrap("    location /i {\n      alias /data/w3/images/;\n    }"))]);
    expect(bad.map((f) => f.checkId)).toEqual(["NGX004"]);
    expect(bad[0].message).toContain("/i../");
  });

  test("slash-terminated prefixes, slashless alias targets, and regex locations pass", () => {
    for (const body of [
      "    location /i/ {\n      alias /data/w3/images/;\n    }",
      "    location /i {\n      alias /data/w3/images;\n    }",
      "    location ~ ^/img {\n      alias /data/w3/images/;\n    }",
    ]) {
      expect(auditNginxConfigs([file(wrap(body))]), body).toEqual([]);
    }
  });
});

describe("NGX005 — open status endpoint", () => {
  test("flags stub_status with no restriction; allow/deny or auth_basic silences it", () => {
    const bad = auditNginxConfigs([file(wrap("    location /nginx_status {\n      stub_status;\n    }"))]);
    expect(bad.map((f) => f.checkId)).toEqual(["NGX005"]);

    for (const guarded of [
      "    location /nginx_status {\n      stub_status;\n      allow 127.0.0.1;\n      deny all;\n    }",
      '    location /nginx_status {\n      stub_status;\n      auth_basic "metrics";\n    }',
    ]) {
      expect(auditNginxConfigs([file(wrap(guarded))]), guarded).toEqual([]);
    }
  });
});

describe("NGX006 — server version disclosure", () => {
  test("flags an http block with no server_tokens off; the off switch (anywhere) silences it", () => {
    const bare = auditNginxConfigs([file("http {\n  server {\n    listen 80;\n  }\n}\n")]);
    expect(bare.map((f) => f.checkId)).toEqual(["NGX006"]);
    expect(bare[0].severity).toBe("info");

    expect(auditNginxConfigs([file("http {\n  server_tokens off;\n  server {\n    listen 80;\n  }\n}\n")])).toEqual([]);
  });

  test("a partial include with no http block is not flagged (the main conf owns this)", () => {
    expect(auditNginxConfigs([file("server {\n  listen 80;\n}\n", "etc/nginx/conf.d/app.conf")])).toEqual([]);
  });
});

describe("NGX007 — access logging disabled at server scope", () => {
  test("flags http/server-scope access_log off; a single silenced location is normal practice", () => {
    const bad = auditNginxConfigs([
      file("http {\n  server_tokens off;\n  server {\n    listen 80;\n    access_log off;\n  }\n}\n"),
    ]);
    expect(bad.map((f) => f.checkId)).toEqual(["NGX007"]);

    const ok = auditNginxConfigs([
      file(
        "http {\n  server_tokens off;\n  server {\n    listen 80;\n    location = /healthz {\n      access_log off;\n    }\n  }\n}\n",
      ),
    ]);
    expect(ok).toEqual([]);
  });
});

describe("catalog coverage", () => {
  test("every NGX finding id has catalog metadata and a category mapping", () => {
    for (const id of ["NGX001", "NGX002", "NGX003", "NGX004", "NGX005", "NGX006", "NGX007"]) {
      expect(RULE_CATALOG[id], id).toBeDefined();
      expect(RULE_CATALOG[id].remediation.length).toBeGreaterThan(0);
      expect(RULE_CATEGORY[id], id).toBeDefined();
    }
    // The launch families carry external authority, per the epic's tiering goal.
    for (const id of ["NGX001", "NGX002", "NGX003", "NGX004", "NGX005"]) {
      expect(RULE_CATALOG[id].authority?.length, id).toBeGreaterThan(0);
    }
  });
});
