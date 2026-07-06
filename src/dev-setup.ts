// Connector-owned dev-mode provisioning hook (cinatra-ai/cinatra#976, epic
// #978 wave W-D) — the WordPress block relocated VERBATIM-in-behavior from the
// host's `src/lib/dev-auto-setup.ts` behind the `cinatra.devSetup` manifest
// hook. The host's dev-only shell invokes `runDevSetup(ctx)` idempotently on
// every dev boot; the docker fixture itself (`docker/wordpress`, entrypoint)
// stays host-side as the integration harness.
//
// Goal: after a fresh `pnpm dev` (or `cinatra setup dev`) with the local
// docker WordPress (http://localhost:8080) running, the assistant can
// read/write WordPress without ANY manual configuration on either side.
//
// Idempotent. Soft-fails (returns a status object) — never throws — so app
// boot is never blocked by a wp-cli hiccup. SECRET BOUNDARY: the minted
// application password / `cnx_` widget credential are never logged; failure
// reasons are fixed connector-owned labels (never a lower-layer error text).
//
// SDK imports are TYPE-ONLY (host-peer value-import ban); the host services
// resolve at call time through the capability port on the hook context.

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import type {
  ExtensionDevSetupContext,
  ExtensionDevSetupHelpers,
  ExtensionDevSetupStatus,
  HostWordPressMcpService,
  HostWordPressWidgetAuthService,
  NangoSystemSurface,
} from "@cinatra-ai/sdk-extensions";

export const LOCAL_WORDPRESS = {
  containerName: "cinatra-wordpress-1",
  siteUrl: "http://localhost:8080",
  adminUser: "admin",
  appPasswordLabel: "cinatra-dev-auto",
} as const;

/** The narrow host-service slice this hook consumes (all resolved at run time). */
export type WordPressDevSetupDeps = {
  wp: Pick<
    HostWordPressMcpService,
    "listInstances" | "readInstanceById" | "devSaveInstance" | "devPersistLocalInstanceUnvalidated" | "devInvalidateProbeCache"
  >;
  widgetAuth: HostWordPressWidgetAuthService;
  nango: Pick<NangoSystemSurface, "getNangoCredentials" | "providerConfigKeys">;
  helpers: ExtensionDevSetupHelpers;
  log: (message: string) => void;
};

/**
 * wp-cli exec into the local container (argv-based, combined output). Throws
 * a FIXED-label error on a non-zero exit — never the raw output/argv (the
 * command line can embed credential material).
 */
function wpCli(helpers: ExtensionDevSetupHelpers, args: string[]): string {
  const r = helpers.dockerExecCapture(LOCAL_WORDPRESS.containerName, ["wp", ...args, "--allow-root"]);
  if (r.code !== 0) {
    throw new Error(`wp ${args[0] ?? ""} failed (exit ${r.code})`);
  }
  return r.out;
}

type WordPressAuthProbe = "ok" | "unauthorized" | "unreachable";

/**
 * Probe WordPress REST authentication for a username + application password.
 * Hits `/users/me?context=edit` (the same endpoint the host's validated save
 * checks) over the rest_route query form so it works without pretty
 * permalinks. Classifies conservatively:
 *   - 200             → "ok" (credential authenticates)
 *   - 401 / 403       → "unauthorized" (DEFINITE auth failure → rotate trigger)
 *   - anything else / network error / timeout → "unreachable" (transient —
 *     NEVER rotate; minting on a blip would litter the app-password list)
 * Never throws. SECRET BOUNDARY: builds the Basic header locally; never logs it.
 */
export async function probeWordPressAuth(
  helpers: ExtensionDevSetupHelpers,
  siteUrl: string,
  username: string,
  applicationPassword: string,
): Promise<WordPressAuthProbe> {
  const base = helpers.trimTrailingSlashes(siteUrl);
  const endpoint = `${base}/index.php?rest_route=/wp/v2/users/me&context=edit`;
  const authHeader = `Basic ${Buffer.from(`${username}:${applicationPassword}`).toString("base64")}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(endpoint, {
        method: "GET",
        headers: { Authorization: authHeader, Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (res.status === 200) return "ok";
      if (res.status === 401 || res.status === 403) return "unauthorized";
      return "unreachable";
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return "unreachable";
  }
}

/** Mint a fresh WordPress application password via wp-cli (porcelain). */
export function mintWordPressAppPassword(helpers: ExtensionDevSetupHelpers): string | null {
  try {
    const out = wpCli(helpers, [
      "user",
      "application-password",
      "create",
      LOCAL_WORDPRESS.adminUser,
      LOCAL_WORDPRESS.appPasswordLabel,
      "--porcelain",
    ]).trim();
    if (!out || /Error/i.test(out)) return null;
    // The porcelain output is the bare application password (a single token).
    return out.split("\n").pop()?.trim() || null;
  } catch {
    return null;
  }
}

export type WordPressReconcileOutcome = {
  // True when the instance's stored credential should authenticate against WP
  // REST (reused-OK, kept-on-transient, or freshly minted + both-halves-verified).
  working: boolean;
  rotated: boolean;
  note?: string;
};

/**
 * Confirm Nango now resolves to the expected username+password (both halves in
 * sync), bypassing the cred cache (forceRefresh). Never throws.
 */
async function verifyWordPressNangoBothHalves(
  deps: WordPressDevSetupDeps,
  input: { providerConfigKey: string; connectionId: string },
  expectedUsername: string,
  expectedPassword: string,
): Promise<boolean> {
  try {
    const after = await deps.nango.getNangoCredentials(input.providerConfigKey, input.connectionId, {
      forceRefresh: true,
    });
    return (
      !!after &&
      typeof after === "object" &&
      "password" in after &&
      (after as { password?: unknown }).password === expectedPassword &&
      "username" in after &&
      (after as { username?: unknown }).username === expectedUsername
    );
  } catch {
    return false;
  }
}

/**
 * Reconcile a WordPress instance's stored application password — runs on EVERY
 * wire (reuse path included). Reuse-first / probe-then-rotate:
 *   1. Resolve the stored Basic creds from Nango (forceRefresh — bypass the
 *      cred cache). If unresolved (null/throw) → TRANSIENT: keep, soft-skip —
 *      but if the LOCAL row already holds a usable password, re-sync Nango
 *      FROM it (idempotent, no mint) so a fully missing connection self-heals.
 *   2. Probe WP REST auth. `ok` → reuse. `unreachable` → keep + soft-skip
 *      (NEVER mint on a transient/non-auth condition → no app-password churn).
 *   3. `unauthorized` (definite 401/403) ONLY → churn guard first (a local
 *      password differing from the stale Nango one means a PRIOR rotate's
 *      Nango sync failed → re-sync, no mint), else mint a fresh application
 *      password and re-save via the host's validated save.
 *   4. BOTH-HALVES check: the host save syncs Nango best-effort, so read the
 *      credential back (forceRefresh) and equality-check username+password.
 *      On a verified rotate, evict the URL-keyed probe cache.
 *
 * Soft-fails: never throws. SECRET BOUNDARY: only statuses/booleans surfaced.
 */
export async function ensureWordPressAppPasswordReconciled(
  deps: WordPressDevSetupDeps,
  input: {
    instanceId: string;
    siteUrl: string;
    username: string;
    providerConfigKey: string;
    connectionId: string;
  },
): Promise<WordPressReconcileOutcome> {
  // Read the Nango-resolved Basic credential the connector actually uses.
  let resolved: { username: string; password: string } | null;
  try {
    const cred = await deps.nango.getNangoCredentials(input.providerConfigKey, input.connectionId, {
      forceRefresh: true,
    });
    resolved =
      cred &&
      typeof cred === "object" &&
      "username" in cred &&
      "password" in cred &&
      typeof (cred as { username?: unknown }).username === "string" &&
      typeof (cred as { password?: unknown }).password === "string"
        ? {
            username: (cred as { username: string }).username,
            password: (cred as { password: string }).password,
          }
        : null;
  } catch {
    return { working: false, rotated: false, note: "credential-resolve-error (kept existing)" };
  }

  if (!resolved) {
    // Nango resolved to nothing — EITHER a transient blip OR a fully missing
    // connection. Never mint on an unresolved read; re-sync from the local row
    // when it already holds a usable password.
    const localOnly = deps.wp.readInstanceById(input.instanceId);
    const localOnlyPw = localOnly?.applicationPassword?.trim() || "";
    if (localOnlyPw) {
      try {
        await deps.wp.devSaveInstance?.({
          id: input.instanceId,
          siteUrl: input.siteUrl,
          username: localOnly?.username ?? input.username,
          applicationPassword: localOnlyPw,
        });
      } catch {
        return { working: false, rotated: false, note: "credential-unresolved; re-sync-failed" };
      }
      const reSynced = await verifyWordPressNangoBothHalves(
        deps,
        input,
        localOnly?.username ?? input.username,
        localOnlyPw,
      );
      if (!reSynced) {
        return { working: false, rotated: false, note: "credential-unresolved; re-sync did not land" };
      }
      deps.wp.devInvalidateProbeCache?.(input.siteUrl);
      return { working: true, rotated: false, note: "nango-resynced-from-local (was unresolved; no mint)" };
    }
    // No local credential to repair from — keep, do not mint.
    return { working: false, rotated: false, note: "credential-unresolved (kept; not minting)" };
  }

  // Probe with the resolved credential.
  const probe = await probeWordPressAuth(deps.helpers, input.siteUrl, resolved.username, resolved.password);
  if (probe === "ok") {
    return { working: true, rotated: false };
  }
  if (probe === "unreachable") {
    // Indeterminate — keep the existing app-password; NEVER mint on a blip.
    return { working: true, rotated: false, note: "probe-unreachable (kept existing)" };
  }

  // probe === "unauthorized" → definite 401/403.
  //
  // CHURN GUARD: if the LOCAL row's password differs from the (stale)
  // Nango-resolved one, a PRIOR rotate already wrote a fresh password locally
  // but its best-effort Nango sync failed. Minting again would litter the WP
  // app-password list every boot — re-sync Nango FROM the local credential
  // instead (idempotent, no mint). Only when local and Nango agree (both
  // genuinely stale) do we mint fresh.
  const local = deps.wp.readInstanceById(input.instanceId);
  const localPw = local?.applicationPassword?.trim() || "";
  if (localPw && localPw !== resolved.password) {
    try {
      await deps.wp.devSaveInstance?.({
        id: input.instanceId,
        siteUrl: input.siteUrl,
        username: local?.username ?? input.username,
        applicationPassword: localPw,
      });
    } catch {
      return { working: false, rotated: false, note: "re-sync-failed" };
    }
    const reSynced = await verifyWordPressNangoBothHalves(deps, input, local?.username ?? input.username, localPw);
    if (!reSynced) {
      return { working: false, rotated: false, note: "nango-sync-failed (re-sync of local credential did not land)" };
    }
    deps.wp.devInvalidateProbeCache?.(input.siteUrl);
    return { working: true, rotated: false, note: "nango-resynced-from-local (no mint)" };
  }

  // Local and Nango agree (or no local pw) → genuinely stale → mint fresh.
  const fresh = mintWordPressAppPassword(deps.helpers);
  if (!fresh) {
    return { working: false, rotated: false, note: "mint-failed (kept existing)" };
  }

  try {
    await deps.wp.devSaveInstance?.({
      id: input.instanceId,
      siteUrl: input.siteUrl,
      username: input.username,
      applicationPassword: fresh,
    });
  } catch {
    // SECRET BOUNDARY: the validated save re-validates over the network and can
    // throw with remote response-body text — never forward it. Fixed label only.
    return { working: false, rotated: false, note: "re-save-failed" };
  }

  // BOTH-HALVES verify — the save syncs Nango best-effort, so confirm Nango now
  // holds the fresh credential (forceRefresh bypasses the cred cache).
  const synced = await verifyWordPressNangoBothHalves(deps, input, input.username, fresh);
  if (!synced) {
    // Row rotated but Nango did NOT — out of sync; the next boot's churn guard
    // re-syncs from local (no re-mint).
    return {
      working: false,
      rotated: false,
      note: "nango-sync-failed (connector metadata + Nango out of sync)",
    };
  }

  // Verified rotate — evict the URL-keyed probe cache.
  deps.wp.devInvalidateProbeCache?.(input.siteUrl);
  return { working: true, rotated: true, note: "rotated" };
}

export type WordPressFirstWireOutcome =
  | { ok: true; instanceId: string; reconcile: WordPressReconcileOutcome }
  | { ok: false; reason: string };

/**
 * First wire (no existing instance): mint an application password and land a
 * COMPLETE local WordPress instance row; the caller then pushes the browser
 * widget config.
 *
 * RESILIENCE (the host #260 Step-7 fix, preserved): the happy path is the
 * network-validated save; on a validation throw fall back to the UNVALIDATED
 * local-dev persist (complete row, best-effort Nango import) so the widget
 * wiring still lands — the next boot's reconcile re-probes + re-validates.
 * Returns `{ ok: false }` ONLY when no COMPLETE row could be persisted at all
 * (the caller then pushes NOTHING — a dangling `cinatra_instance_id` would
 * never authorize against widget-stream auth).
 *
 * SECRET BOUNDARY: never logs the minted application password; failure reasons
 * are fixed connector-owned labels.
 */
export async function firstWireWordPressInstance(
  deps: WordPressDevSetupDeps,
): Promise<WordPressFirstWireOutcome> {
  const appPassword = mintWordPressAppPassword(deps.helpers);
  if (!appPassword) {
    return { ok: false, reason: "wp user application-password create failed (no porcelain output)" };
  }

  const providerConfigKey = deps.nango.providerConfigKeys.wordpress;
  // Generate the instance id up-front so the validated save and the unvalidated
  // fallback land the SAME id (no dangling/duplicated instance_id).
  const instanceId = randomUUID();

  let persistedId: string = instanceId;
  let connectionId: string = instanceId;
  let validated = false;
  try {
    const saved = await deps.wp.devSaveInstance?.({
      id: instanceId,
      siteUrl: LOCAL_WORDPRESS.siteUrl,
      username: LOCAL_WORDPRESS.adminUser,
      applicationPassword: appPassword,
    });
    if (!saved) throw new Error("devSaveInstance unavailable");
    persistedId = saved.id;
    connectionId = saved.connectionId ?? saved.id;
    validated = true;
  } catch {
    // A first-wire validation throw falls back to the complete unvalidated
    // local-dev persist rather than aborting the whole wire.
    try {
      const persisted = await deps.wp.devPersistLocalInstanceUnvalidated?.({
        id: instanceId,
        siteUrl: LOCAL_WORDPRESS.siteUrl,
        username: LOCAL_WORDPRESS.adminUser,
        applicationPassword: appPassword,
      });
      if (!persisted) throw new Error("devPersistLocalInstanceUnvalidated unavailable");
      persistedId = persisted.id;
      connectionId = persisted.connectionId ?? persisted.id;
    } catch {
      // Even the unvalidated persist failed — genuinely unrecoverable this
      // boot. SECRET BOUNDARY: fixed connector-owned reason only.
      return { ok: false, reason: "saveWordPressInstance failed (first wire)" };
    }
    deps.log(
      "first-wire connection validation did not pass; persisted a local-dev instance + pushed the widget config anyway. " +
        "WordPress MCP writes 401 until the credential validates; the next boot re-probes and reconciles.",
    );
  }

  // BOTH-HALVES verify — the saves sync Nango best-effort, so confirm Nango
  // actually holds the freshly minted credential.
  const synced = await verifyWordPressNangoBothHalves(
    deps,
    { providerConfigKey, connectionId },
    LOCAL_WORDPRESS.adminUser,
    appPassword,
  );

  let reconcile: WordPressReconcileOutcome;
  if (validated && synced) {
    reconcile = { working: true, rotated: false, note: "first-wire minted + nango-synced" };
  } else if (validated) {
    reconcile = {
      working: false,
      rotated: false,
      note: "nango-sync-failed (connector metadata + Nango out of sync)",
    };
    deps.log(
      "first-wire app-password minted but Nango sync could not be confirmed. " +
        "WordPress MCP writes 401 until the credential is in Nango; re-run once Nango is reachable.",
    );
  } else if (synced) {
    reconcile = {
      working: false,
      rotated: false,
      note: "first-wire validation unconfirmed; instance persisted + nango-synced (re-validates on a later boot)",
    };
  } else {
    reconcile = {
      working: false,
      rotated: false,
      note: "first-wire validation unconfirmed; instance persisted (nango sync unconfirmed; re-validates on a later boot)",
    };
  }

  return { ok: true, instanceId: persistedId, reconcile };
}

// ---------------------------------------------------------------------------
// Capability resolution (structural narrowing — impls are `unknown` by
// contract; the literals are inlined per the host-peer value-import ban).
// ---------------------------------------------------------------------------

function resolveImpl(ctx: ExtensionDevSetupContext, capability: string): unknown {
  return ctx.capabilities.resolveProviders(capability)[0]?.impl ?? null;
}

/** Like `resolveImpl`, but prefers a provider registered by ANOTHER package.
 * Since cinatra#975 Wave 3 this connector ALSO registers itself under
 * `@cinatra-ai/host:wordpress-mcp` (the relocated vendor client), while the
 * dev-setup writers this hook needs (`devSaveInstance` /
 * `devPersistLocalInstanceUnvalidated`) stay HOST-published — a self-first
 * registry ordering must not shadow them (codex W3 round-1 finding 3). The
 * `?? [0]` fallback keeps a single-provider registry resolving. NOT used for
 * `wordpress-widget-auth`, where the SELF-registered store is the owner. */
function resolveNonSelfImpl(ctx: ExtensionDevSetupContext, capability: string): unknown {
  const providers = ctx.capabilities.resolveProviders(capability);
  return (
    providers.find((p) => p.packageName !== "@cinatra-ai/wordpress-mcp-connector") ?? providers[0]
  )?.impl ?? null;
}

function isWordPressMcpService(impl: unknown): impl is HostWordPressMcpService {
  const c = impl as Partial<HostWordPressMcpService> | null;
  return !!c && typeof c === "object" && typeof c.listInstances === "function" && typeof c.readInstanceById === "function";
}

function isWordPressWidgetAuthService(impl: unknown): impl is HostWordPressWidgetAuthService {
  const c = impl as Partial<HostWordPressWidgetAuthService> | null;
  return !!c && typeof c === "object" && typeof c.read === "function" && typeof c.generate === "function";
}

function isNangoSystemSurface(impl: unknown): impl is NangoSystemSurface {
  const c = impl as Partial<NangoSystemSurface> | null;
  return (
    !!c &&
    typeof c === "object" &&
    typeof c.isNangoConfigured === "function" &&
    typeof c.getNangoCredentials === "function" &&
    typeof c.providerConfigKeys === "object"
  );
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

/** The `cinatra.devSetup` entry point the host's dev-only shell invokes. */
export async function runDevSetup(ctx: ExtensionDevSetupContext): Promise<ExtensionDevSetupStatus> {
  const { helpers } = ctx;
  if (!helpers.probeDockerContainer(LOCAL_WORDPRESS.containerName)) {
    return {
      status: "skipped",
      reason: `${LOCAL_WORDPRESS.containerName} not running (run docker compose --profile wordpress up -d)`,
    };
  }
  if (!helpers.probeHttp(LOCAL_WORDPRESS.siteUrl + "/")) {
    return { status: "skipped", reason: `${LOCAL_WORDPRESS.siteUrl} not reachable` };
  }
  // The WordPress plugin is consumed as a local clone of cinatra-ai/wordpress-plugin
  // (synced by `cinatra setup dev`) and BIND-MOUNTED into the container at
  // wp-content/plugins/cinatra (docker-compose.yml). Probe for it INSIDE the
  // container through the host-owned dockerExecCapture helper instead of reaching
  // for node:fs against the host cwd (cinatra#979/#981 extension fs-import ban) —
  // a missing/empty bind mount yields a non-zero `test -f` and the SAME clean
  // skip. `test` is a POSIX sh builtin, so this has no coreutils dependency.
  if (
    helpers.dockerExecCapture(LOCAL_WORDPRESS.containerName, [
      "sh",
      "-c",
      "test -f /var/www/html/wp-content/plugins/cinatra/cinatra.php",
    ]).code !== 0
  ) {
    return {
      status: "skipped",
      reason: "plugin clone missing at dev/wordpress-plugin/cinatra.php. Run `cinatra setup dev` first.",
    };
  }
  // WP install: if not installed yet, skip (the operator runs it once;
  // auto-install needs a site admin email we must not invent silently).
  if (helpers.dockerExecCapture(LOCAL_WORDPRESS.containerName, ["wp", "core", "is-installed", "--allow-root"]).code !== 0) {
    return { status: "skipped", reason: "WordPress not yet installed (run wp core install inside the container first)" };
  }

  const wpImpl = resolveNonSelfImpl(ctx, "@cinatra-ai/host:wordpress-mcp");
  const widgetAuthImpl = resolveImpl(ctx, "@cinatra-ai/host:wordpress-widget-auth");
  const nangoImpl = resolveImpl(ctx, "nango-system");
  if (!isWordPressMcpService(wpImpl) || !isWordPressWidgetAuthService(widgetAuthImpl) || !isNangoSystemSurface(nangoImpl)) {
    return { status: "skipped", reason: "host services unresolved (wordpress-mcp / wordpress-widget-auth / nango-system)" };
  }
  if (typeof wpImpl.devSaveInstance !== "function" || typeof wpImpl.devPersistLocalInstanceUnvalidated !== "function") {
    return { status: "skipped", reason: "host does not publish the wordpress dev-setup writers (older host)" };
  }

  const deps: WordPressDevSetupDeps = {
    wp: wpImpl,
    widgetAuth: widgetAuthImpl,
    nango: nangoImpl,
    helpers,
    log: ctx.log,
  };

  // Cinatra-side: generate or reuse the UUID-pair widget api_key (lives in
  // connector_config:wordpress_widget_auth) — the Bearer the WP widget sends.
  const auth = deps.widgetAuth.read() ?? deps.widgetAuth.generate();

  // Ensure the cinatra-side instance exists (create on first run; reuse after).
  // The WP application password (cinatra→WP MCP direction) is minted ONCE on
  // first wire; on subsequent wires the reconcile probes REST auth and re-mints
  // ONLY on a definite 401 — re-creating one every boot would litter the
  // admin's application-password list.
  const existing = deps.wp.listInstances().find((i) => i.siteUrl === LOCAL_WORDPRESS.siteUrl);
  let instanceId: string;
  let created: boolean;
  let reconcile: WordPressReconcileOutcome;
  if (existing) {
    instanceId = existing.id;
    created = false;
    reconcile = await ensureWordPressAppPasswordReconciled(deps, {
      instanceId: existing.id,
      siteUrl: LOCAL_WORDPRESS.siteUrl,
      username: existing.username,
      providerConfigKey: existing.providerConfigKey ?? deps.nango.providerConfigKeys.wordpress,
      connectionId: existing.connectionId ?? existing.id,
    });
    if (!reconcile.working) {
      ctx.log(
        `app-password reconcile did not confirm a working credential (${reconcile.note ?? "unknown"}). ` +
          "WordPress MCP writes 401 until a valid application password is stored; re-run once WordPress is reachable.",
      );
    }
  } else {
    const firstWire = await firstWireWordPressInstance(deps);
    if (!firstWire.ok) {
      // No COMPLETE instance row landed — hard-error and do NOT push the widget
      // config (a dangling `cinatra_instance_id` would never authorize).
      return { status: "error", reason: firstWire.reason };
    }
    instanceId = firstWire.instanceId;
    created = true;
    reconcile = firstWire.reconcile;
  }

  // WP-side: push the widget plugin options on EVERY run (create OR reuse) so a
  // fresh install (or a CMS-volume reset with the app DB retained) wires the
  // widget. cinatra_url is the BROWSER-reachable origin — the plugin enqueues
  // the bundle + SSE from it. `wp option update` is idempotent.
  //
  // cinatra#410 — the shipped widget's broker needs a real per-site `cnx_`
  // connect-site credential (a legacy widget UUID 401s); mint one bound to the
  // host-seeded dev actor's org, falling back to the legacy UUID when the dev
  // mint is unavailable.
  const wpWidgetKey = ctx.mintDevConnectCredential("wordpress", LOCAL_WORDPRESS.siteUrl) || auth.apiKey;
  try {
    wpCli(helpers, ["option", "update", "cinatra_url", ctx.browserBaseUrl]);
    wpCli(helpers, ["option", "update", "cinatra_api_key", wpWidgetKey]);
    wpCli(helpers, ["option", "update", "cinatra_instance_id", instanceId]);
  } catch {
    // SECRET BOUNDARY: the wp-cli argv embeds the widget api_key — surface only
    // a fixed connector-owned reason, never the raw error.
    return { status: "error", reason: "wp option update cinatra_* failed" };
  }

  // Distinguish a POSITIVELY-confirmed credential (200 probe, no note) from a
  // kept-but-unconfirmed one (working stays true on probe-unreachable to avoid
  // a false 401 hint + churn, but it must not be overstated as "valid").
  const reconcileNote = reconcile.rotated
    ? "app-password rotated"
    : reconcile.working
      ? reconcile.note
        ? `app-password kept, unconfirmed (${reconcile.note})`
        : "app-password valid"
      : `app-password unconfirmed (${reconcile.note ?? "unknown"})`;

  return created
    ? { status: "created", siteUrl: LOCAL_WORDPRESS.siteUrl, detail: `instance ${instanceId} (${reconcileNote})` }
    : {
        status: "already-wired",
        siteUrl: LOCAL_WORDPRESS.siteUrl,
        detail: `instance ${instanceId} (config re-pushed; ${reconcileNote})`,
      };
}
