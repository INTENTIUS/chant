### terragucci request: app `orders` from bucket

| | |
| --- | --- |
| Template | `acme/bucket/aws` |
| Version | `1.0.0` |
| Requested by | `alice` |
| Through | an agent over MCP |

| Input | Value |
| --- | --- |
| `bucket_name` | `"orders-data"` |
| `readers` | `["svc-a","svc-b"]` |
| `tags` | `{"team":"pay\|ments"}` |

Nothing was applied or approved. This pull request only adds files; it is planned like any other, and a person reviews and merges it.

```json https://intentius.io/chant/schemas/template-request/v1/template-request.schema.json
{
  "$schema": "https://intentius.io/chant/schemas/template-request/v1/template-request.schema.json",
  "contract": 1,
  "kind": "app",
  "template": "acme/bucket/aws",
  "version": "1.0.0",
  "app": "orders",
  "inputs": {
    "bucket_name": "orders-data",
    "tags": {
      "team": "pay|ments"
    },
    "readers": [
      "svc-a",
      "svc-b"
    ]
  },
  "requestedBy": "alice",
  "via": "mcp"
}
```
