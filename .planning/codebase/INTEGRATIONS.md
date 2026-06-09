# External Integrations

**Analysis Date:** 2026-06-09

## APIs & External Services

**WordPress REST API:**
- WordPress sites are connected as instances; the host-side `@/lib/wordpress-api` module handles all REST calls (`/wp/v2/posts`, `/wp/v2/pages`, `/wp/v2/media`)
- Auth: Application Passwords (WordPress native) — credentials stored per-instance by Nango
- This connector does NOT call WordPress directly; it delegates to host library functions injected via DI (`src/deps.ts`)

**Nango (OAuth Connection Management):**
- SDK: `@nangohq/frontend` ^0.70.3
- Used in: `src/wordpress-nango-connect-card.tsx`
- Flow: `NangoFrontend.openConnectUI()` opens the OAuth/credential flow; on `connect` event, calls `/api/nango/connections/save` and `/api/nango/connect/session` on the host
- Auth: Session token fetched from host endpoint `/api/nango/connect/session` before launching the UI
- Host port declared: `"requestedHostPorts": ["nango"]` in `package.json` cinatra manifest

**wordpress-content-editor A2A Agent:**
- Protocol: Agent-to-Agent (A2A) HTTP, blocking dispatch
- URL: `WP_CONTENT_EDITOR_A2A_URL` env var (default `http://localhost:3021`)
- Used in: `src/mcp/handlers.ts` — `wordpress_content_editor_run` primitive
- Dispatch is delegated to host via `getWordPressDeps().dispatchContentEditor(...)` — the connector never calls A2A directly
- Timeout: 300,000 ms (aligned with `/chat` blocking budget)
- Response: raw agent text; connector strips code fences and JSON-parses the result

## Data Storage

**Databases:**
- Not applicable — this connector package contains no database access. All persistence (WordPress instance records, connection credentials) is owned by the host Cinatra application via `@/lib/wordpress-api` and the Nango service.

**File Storage:**
- WordPress Media Library — images are uploaded via `wordpress_media_upload` primitive (base64-encoded, delegated to host `uploadWordPressMedia`)

**Caching:**
- Not detected in this package

## Authentication & Identity

**Auth Provider:**
- Nango — manages OAuth/Application Password connections to WordPress sites
- WordPress Application Passwords — per-instance credentials stored by Nango, retrieved by host on each API call
- Cinatra SDK action guard — `requireExtensionAction(packageId, "manage")` in `src/setup-actions.ts` gates instance deletion; enforces org_owner/org_admin/platform_admin roles (host-bound SDK implementation)

## Monitoring & Observability

**Error Tracking:**
- Not detected in this package

**Logs:**
- No explicit logging framework; errors are thrown as `Error` instances and propagate to the host

## CI/CD & Deployment

**Hosting:**
- Embedded in the Cinatra Next.js host application; deployed alongside the host
- MCP server transport: HTTP at `${CINATRA_BASE_URL}/api/mcp` (configured in `cinatra/mcp.json`)

**CI Pipeline:**
- `.github/` directory present; specific workflow files not inspected
- Tests run via `vitest` (`npm test`)

## Environment Configuration

**Required env vars:**
- `WP_CONTENT_EDITOR_A2A_URL` — A2A agent URL for the wordpress-content-editor (optional; defaults to `http://localhost:3021`)
- `CINATRA_BASE_URL` — MCP server base URL (optional; defaults to `http://localhost:3000`)
- All other env vars (WordPress credentials, Nango keys, database URLs) are owned by the host application

**Secrets location:**
- No `.env` file in this repo; secrets are managed by the host monorepo and injected at runtime

## Webhooks & Callbacks

**Incoming:**
- Not applicable — this connector does not expose webhook endpoints

**Outgoing:**
- `/api/nango/connect/session` (POST) — called during the Nango connect flow to fetch a session token (`src/wordpress-nango-connect-card.tsx`)
- `/api/nango/connections/save` (POST) — called after Nango `connect` event to persist the connection (`src/wordpress-nango-connect-card.tsx`)
- Both endpoints are on the host Cinatra application (same origin)

---

*Integration audit: 2026-06-09*
