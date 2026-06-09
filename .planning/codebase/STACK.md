# Technology Stack

**Analysis Date:** 2026-06-09

## Languages

**Primary:**
- TypeScript (strict mode, `noImplicitAny: false`) — all source files under `src/`
- TSX — React UI components under `src/components/ui/` and `src/settings-page.tsx`, `src/setup-page.tsx`, `src/wordpress-nango-connect-card.tsx`

## Runtime

**Environment:**
- Node.js (ESNext modules, `"type": "module"` in `package.json`)
- Target: ES2023, DOM libs included (for React/Next.js host environment)

**Package Manager:**
- npm (`.npmrc` present with `auto-install-peers=false`)
- Lockfile: Not present in extracted repo (consumed as a package by host monorepo)

## Frameworks

**Core:**
- React 19 (peer dependency) — UI components and the `WordPressNangoConnectCard` connect flow
- Next.js (implicit peer via `useRouter`, `"use client"`, `"use server"` directives) — connector is embedded in a Next.js host app

**Testing:**
- Vitest — test runner; config at `vitest.config.ts`
- Test environment: `node`
- Test files: `src/__tests__/**/*.test.ts`

**Build/Dev:**
- TypeScript compiler (`tsc`) — `tsconfig.json` targets `dist/`, emits declarations and source maps
- No bundler defined in this repo — host monorepo is responsible for bundling

## Key Dependencies

**Critical:**
- `@nangohq/frontend` ^0.70.3 — Nango OAuth connect UI used in `src/wordpress-nango-connect-card.tsx`
- `zod` (transitive, imported in `src/mcp/handlers.ts`) — runtime schema validation for all MCP primitive inputs

**UI:**
- `radix-ui` ^1.4.3 — headless UI primitives for components in `src/components/ui/`
- `class-variance-authority` ^0.7.1 — variant-based className utility (`src/components/ui/`)
- `clsx` ^2.1.1 — conditional className merging (`src/lib/utils.ts`)
- `tailwind-merge` ^3.5.0 — Tailwind class deduplication

**Peer Dependencies (host-provided):**
- `react` ^19.2.3
- `react-dom` ^19.2.3
- `@cinatra-ai/sdk-extensions` (optional) — `requireExtensionAction`, `ExtensionPrimitiveRequest` types used throughout
- `@cinatra-ai/sdk-ui` (optional) — `NangoFrontendConfig` type used in `src/wordpress-nango-connect-card.tsx`

## Configuration

**Environment:**
- `WP_CONTENT_EDITOR_A2A_URL` — optional env var; overrides A2A agent URL (default `http://localhost:3021`), read in `src/mcp/handlers.ts`
- `CINATRA_BASE_URL` — used in `cinatra/mcp.json` MCP server base URL (default `http://localhost:3000`)
- No `.env` file present in this repo; env vars are injected by the host

**Build:**
- `tsconfig.json` — standalone strict config (no monorepo extends), outputs to `dist/`, includes `src/**/*.ts` and `src/**/*.tsx`
- `vitest.config.ts` — test runner config with path aliases resolving `@/` to host monorepo `src/` (tests run from monorepo context)

## Platform Requirements

**Development:**
- Node.js with ESM support
- Must be installed inside the host Cinatra monorepo for tests (vitest aliases resolve `@/lib/wordpress-api` from the monorepo root)

**Production:**
- Deployed as an embedded package within the Cinatra Next.js host application
- Cinatra connector manifest: `cinatra/mcp.json` (MCP HTTP transport) and `cinatra/plugin.json` (plugin descriptor)
- MCP transport: HTTP, base path `/api/mcp` on the host

---

*Stack analysis: 2026-06-09*
