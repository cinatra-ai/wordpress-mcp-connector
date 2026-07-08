# Changelog

All notable changes to this project are documented here, derived from the
project's merged pull request and release-tag history.

## v0.1.6 — 2026-07-07

Required rider alongside Cinatra 0.1.7: this release takes ownership of WordPress-specific capability code that Cinatra 0.1.7 removes from core.

- feat(widget-auth): own the WordPress widget-auth store and register the capability — on a Cinatra 0.1.7 host, widget sessions on connected sites need this version (cinatra#975 W2) (#56)
- feat(client): own the relocated WordPress REST client, registered under the same host capability id (provider flip, no contract change) (cinatra#975 W3) (#57)
- fix(boundary): resolve the per-deployment content-editor agent URL via the granted settings port instead of the process environment (#50)
- feat(dev-setup): dev-mode provisioning moves into a connector-owned `devSetup` hook (cinatra#976) (#51); the dev fixture probe runs in-container, dropping the `node:fs` host precheck (#55)
- fix(tests): align test typings with the deps row type and the narrow SDK buildTools contract (#49)

## v0.1.5 — 2026-07-04

- feat: final connection access-scoping declaration — default scope "workspace" (cinatra#954 W4) (#48)
- fix: declare `wordpress_post_update` in the mcp.json primitives (#45)
- fix(setup): remove the extension-rendered connection-status pill (#42)
- chore(manifest): backfill the declared SDK ABI range (#43); declare `cinatra.consumes` for closure-gate enrollment (#46)
- docs/ci: CHANGELOG derived from tag and merged-PR history (#47); release workflow pinned to the gated reusable extension-release flow (release-approval wall) (#44); private tracker references stripped from workflow comments (#41)

## v0.1.4 — 2026-06-28

- fix: declared `cinatra.vendor` identity ahead of a marketplace re-submit (#40)
- chore: stripped private tracker references from public source (#37)

## v0.1.3 — 2026-06-28

- feat: declared `cinatra.webhooks` and a post-published handler (#28)
- fix: gated per-instance tool injection via host use-authority, requiring approval on writes; project public fields only in instance listing, omitting credentials; shadcn raw-element fixes and ramped the UI gate to error (#31, #32, #33)
- docs: expanded README to the org standard (#30)
- ci: re-vendored the UI-gate preset with the dynamic-import ban; adopted source-leak-gate (#36, #34, #35)

## v0.1.2 — 2026-06-23

- feat: declared `relayAgentPackage` for the content-editor relay; passed `packageName` for production OBO identity; enforced per-user/per-instance write authority in the WordPress MCP write handlers (#22, #21, #26)
- ci: added the truthful-attribution gate (WARN mode); adopted the reusable extension→host IoC conformance gate, the tag-driven GitHub release workflow, and secret-scan-gate (#19, #20, #23, #24)

## v0.1.1 — 2026-06-13

- feat: shipped the external-MCP toolbox module and capability marker; declared the widget-stream surface and widget-chat skill capability; declared the package exports map (incl. `./register`) for the serverEntry builder (#6, #7, #14)
- chore: adopted source-leak-gate, SHA-pinned org gate callers, npm packaging hygiene, Renovate config, reusable release-workflow pinning (#1–#5, #8, #9, #11–#13, #16, #17)

## v0.1.0 — 2026-06-03

- Initial release.

## Unreleased

- fix: declared `wordpress_post_update` in `mcp.json` primitives; removed the extension-rendered connection-status pill (#45, #42)
- chore: stripped private tracker references from workflow comments; backfilled `cinatra.sdkAbiRange`; pinned the reusable extension-release workflow to the gated version (release-approval wall); declared `cinatra.consumes` for closure-gate enrollment (#41, #43, #44, #46)
