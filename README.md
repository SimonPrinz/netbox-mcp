# NetBox MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the
[NetBox](https://netbox.dev) REST API as MCP tools and resources, served over the
**Streamable HTTP** transport (not stdio).

The server is driven by the bundled NetBox OpenAPI specification
(`netbox-openapi.yaml`): at startup it indexes every REST resource and
exposes a small, generic set of tools rather than one tool per endpoint.

## Features

- **Streamable HTTP transport** with session management (stateful by default,
  optional stateless mode).
- **Spec-driven discovery**: resource keys, collection/detail paths and
  supported operations are derived from the OpenAPI document.
- **Generic CRUD tools** plus a `netbox_request` escape hatch for custom action
  endpoints (e.g. `.../available-ips/`).
- **Branch support** for the netbox-branching plugin: stage changes in an
  isolated branch, review the diff, then merge into live — or revert.
- **MCP resources** for on-demand discovery of endpoints, schemas and status.

## Requirements

- Node.js 22.19+.
- A reachable NetBox instance and an API token.
- For branch support, the [`netbox-branching`](https://netboxlabs.com/docs/branching)
  plugin must be installed on the NetBox instance.

## Install

The package is published to the GitHub npm registry as `@simonprinz/netbox-mcp`.
That registry requires authentication even for public packages, so add a
`.npmrc` with a token that has `read:packages`:

```ini
@simonprinz:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```bash
npm install @simonprinz/netbox-mcp
```

## Usage

```bash
NETBOX_URL="https://netbox.example.com" \
NETBOX_TOKEN="0123456789abcdef0123456789abcdef01234567" \
npx @simonprinz/netbox-mcp
```

The server prints the listen URL and exposes a health check at `/healthz`:

```bash
curl http://127.0.0.1:3000/healthz
```

## Docker

A ready-to-run image is published to GitHub Container Registry:

```bash
docker run --rm -p 3000:3000 \
  -e NETBOX_URL="https://netbox.example.com" \
  -e NETBOX_TOKEN="0123456789abcdef0123456789abcdef01234567" \
  ghcr.io/simonprinz/netbox-mcp
```

Tags: `latest` (newest release), `:<version>` (e.g. `:1.0.0`) and `:edge`
(latest `main`). The image binds `0.0.0.0` so the port is reachable from outside
the container; when exposing it beyond localhost, also set `MCP_AUTH_TOKEN` (and
`MCP_ALLOWED_HOSTS`). All [Configuration](#configuration) variables apply.

## Configuration

All configuration is via environment variables.

### NetBox connection

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NETBOX_URL` | ✅ | – | Base URL of the NetBox instance, e.g. `https://netbox.example.com`. |
| `NETBOX_TOKEN` | ✅ | – | API token. |
| `NETBOX_TOKEN_TYPE` | – | `token` | `token` → `Authorization: Token <t>`; `bearer` → `Authorization: Bearer <key>.<token>`; `auto` detects a `.` in the token. |
| `NETBOX_VERIFY_TLS` | – | `true` | Set to `false` to skip TLS certificate verification. |
| `NETBOX_TIMEOUT_MS` | – | `30000` | Per-request timeout in milliseconds. |
| `NETBOX_ALLOW_WRITES` | – | `false` | Enables create/update/delete tools, branch lifecycle tools and write methods on `netbox_request`. |
| `NETBOX_REQUIRE_BRANCH` | – | `false` | When true, every write must specify a `branch`; writes to main are refused. |
| `NETBOX_DEFAULT_BRANCH` | – | *(unset)* | Branch (schema ID or name) applied to requests that do not specify one. |
| `NETBOX_SPEC_PATH` | – | bundled copy | Override the location of the OpenAPI specification. |

### MCP HTTP server

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_HTTP_HOST` | `127.0.0.1` | Bind address. |
| `MCP_HTTP_PORT` | `3000` | Bind port. |
| `MCP_HTTP_PATH` | `/mcp` | MCP endpoint path. |
| `MCP_HTTP_STATELESS` | `false` | Disable session management (one server instance per request). |
| `MCP_AUTH_TOKEN` | *(unset)* | When set, requests must send `Authorization: Bearer <token>`. |
| `MCP_ALLOWED_HOSTS` | derived from host/port | Comma-separated `Host` header allowlist (DNS-rebinding protection). Set explicitly when binding `0.0.0.0`. |
| `MCP_ALLOWED_ORIGINS` | *(unset)* | Comma-separated CORS origin allowlist. When unset, `*` is allowed. |

> When binding to a non-loopback address, always set `MCP_AUTH_TOKEN` and an
> explicit `MCP_ALLOWED_HOSTS`.

## Client configuration

Point any MCP client that supports Streamable HTTP at the endpoint, e.g.:

```json
{
  "mcpServers": {
    "netbox-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

Omit the `headers` block when `MCP_AUTH_TOKEN` is not set.

## Tools

Read-only tools (always available):

| Tool | Description |
| --- | --- |
| `netbox_list_object_types` | Discover endpoints and their supported operations. |
| `netbox_list_objects` | List objects with filters/pagination; accepts `branch`. |
| `netbox_get_object` | Retrieve a single object by ID/slug; accepts `branch`. |
| `netbox_request` | Call any `/api/...` endpoint (GET when writes are disabled). |
| `netbox_list_branches` | List branching-plugin branches and their status/schema ID. |
| `netbox_get_branch` | Retrieve a branch by schema ID, ID or name. |
| `netbox_list_branch_changes` | Show the change diff staged in a branch. |

Write tools (only when `NETBOX_ALLOW_WRITES=true`):

| Tool | Description |
| --- | --- |
| `netbox_create_object` | Create an object (`POST`); accepts `branch`. |
| `netbox_update_object` | Update an object (`PATCH`/`PUT`); accepts `branch`. |
| `netbox_delete_object` | Delete an object (`DELETE`); accepts `branch`. |
| `netbox_create_branch` | Create a branch (optionally wait until `ready`). |
| `netbox_sync_branch` | Sync changes from main into a branch. |
| `netbox_merge_branch` | Merge a branch into main (handles `409` conflicts). |
| `netbox_revert_branch` | Revert a previously merged branch. |

The `endpoint` parameter accepts `app/resource` (e.g. `dcim/devices`), a dotted
form (`dcim.devices`), a bare resource name when unambiguous (`devices`), or a
full API path (`/api/dcim/devices/`).

## Branching workflow

NetBox branching provides a git-like workflow: an isolated copy of the data
where changes can be staged, reviewed and then merged into live. This server
maps that onto tools so an AI agent can propose changes safely.

1. **Create a branch**
   `netbox_create_branch { name: "ai-changes", wait: true }`
   Returns the branch with its `schema_id` and status (`ready`).

2. **Make changes inside the branch**
   Pass `branch: "<schema_id>"` (or the branch name) to any write tool, e.g.
   `netbox_create_object { endpoint: "dcim/sites", data: {...}, branch: "br000001" }`.

3. **Review what was staged**
   `netbox_list_branch_changes { branch: "br000001" }`

4. **Publish or discard**
   - `netbox_merge_branch { branch: "br000001", wait: true }` merges into main.
     If main and the branch diverged the call returns `409` with the conflict
     list; review it and retry with `acknowledge_conflicts: true` to let the
     branch value win.
   - `netbox_revert_branch { branch: "br000001" }` discards it.

Branch context is implemented with the `X-NetBox-Branch` header carrying the
branch's **schema ID** — the same mechanism the NetBox API itself uses. Setting
`NETBOX_REQUIRE_BRANCH=true` makes the server refuse any write that does not name
a branch, so an agent physically cannot touch main without going through a
review-and-merge step.

## Resources

| URI | Description |
| --- | --- |
| `netbox://endpoints` | JSON index of all resources, paths and operations. |
| `netbox://openapi` | The full NetBox OpenAPI specification (YAML). |
| `netbox://health` | Server configuration (token redacted), write mode and spec info. |

## Security notes

- Read-only by default; enable writes deliberately, and set
  `NETBOX_REQUIRE_BRANCH=true` to keep automated writes inside branches.
- The `netbox_request` tool is restricted to paths beginning with `/api/` to
  prevent using the server as an open proxy. When exposing the server beyond
  loopback, require `MCP_AUTH_TOKEN` and pin `MCP_ALLOWED_HOSTS`.

## Development

```bash
npm install
npm run build
```

`npm run build` compiles TypeScript to `build/` and copies the OpenAPI spec to
`build/spec/netbox-openapi.yaml` so the compiled server can find it at runtime.

Run the local build:

```bash
NETBOX_URL="https://netbox.example.com" \
NETBOX_TOKEN="0123456789abcdef0123456789abcdef01234567" \
npm start
```

```bash
npm run watch     # recompile on change
npm run inspector # MCP Inspector against the running server
```

## Testing

The suite uses [Vitest](https://vitest.dev) and needs no live NetBox.

```bash
npm test          # unit + mock integration tests
npm run test:unit # pure modules only (spec index, registry, client, config)
npm run test:mock # MCP handshake + branch flow against an in-process mock NetBox
```

`test/mock` starts an HTTP mock of the NetBox API and the netbox-branching
endpoints, then drives the real MCP server over Streamable HTTP — covering tool
registration, branch enforcement, the `X-NetBox-Branch` header and the
create → review → merge → revert flow.

## CI & releases

- **`.github/workflows/ci.yml`** — on every push to `main` and every PR: builds
  (typecheck) and runs `npm test` on Node 22 and 24.
- **`.github/workflows/release.yml`** — [release-please](https://github.com/googleapis/release-please)
  on push to `main`. Conventional commit messages (`feat:`, `fix:`, …) drive a
  release PR; merging it tags a release, updates `package.json` and publishes a
  GitHub Release with generated notes. When a release is created, a follow-up job
  publishes the package to the GitHub npm registry (`@simonprinz/netbox-mcp`)
  using the workflow's `GITHUB_TOKEN`. The same run also builds and pushes the
  Docker image (`:<version>` and `:latest`).
- **`.github/workflows/docker-edge.yml`** — on every push to `main`: builds and
  pushes a multi-arch (`amd64`/`arm64`) `:edge` image to `ghcr.io`.