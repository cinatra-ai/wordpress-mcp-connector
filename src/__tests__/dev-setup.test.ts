// Connector-owned dev-setup hook — WordPress app-password reconcile + first
// wire (relocated from the host's dev-auto-setup suite with cinatra#976; the
// assertions are the same discipline, rebased onto the hook's explicit deps):
//   - reuse on a valid probe (no mint, no rotate)
//   - rotate ONLY on a definite 401/403
//   - NEVER rotate on transient/unreachable (no app-password churn)
//   - BOTH halves (connector metadata + Nango) verified after a rotate
//   - URL-keyed probe cache invalidated only on a verified rotate
//   - resilient first wire (#260 Step 7): validation throw → unvalidated
//     complete persist, same up-front id, widget config still pushable
//
// SECRET BOUNDARY: assertions only ever check statuses/booleans/equality —
// never log a credential.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  ensureWordPressAppPasswordReconciled,
  firstWireWordPressInstance,
  type WordPressDevSetupDeps,
} from "../dev-setup";

const FRESH_APP_PW = "abcd EFGH ijkl MNOP";

function stubFetchStatus(status: number) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ status }) as Response));
}

type Deps = {
  deps: WordPressDevSetupDeps;
  docker: ReturnType<typeof vi.fn>;
  getNangoCredentials: ReturnType<typeof vi.fn>;
  devSaveInstance: ReturnType<typeof vi.fn>;
  devPersistLocalInstanceUnvalidated: ReturnType<typeof vi.fn>;
  devInvalidateProbeCache: ReturnType<typeof vi.fn>;
  readInstanceById: ReturnType<typeof vi.fn>;
};

function makeDeps(): Deps {
  const docker = vi.fn(() => ({ code: 0, out: "" }));
  const getNangoCredentials = vi.fn();
  const devSaveInstance = vi.fn(async () => ({ id: "wp-1" }));
  const devPersistLocalInstanceUnvalidated = vi.fn(async () => ({ id: "wp-1" }));
  const devInvalidateProbeCache = vi.fn();
  const readInstanceById = vi.fn(() => null);
  const deps = {
    wp: {
      listInstances: vi.fn(() => []),
      readInstanceById,
      devSaveInstance,
      devPersistLocalInstanceUnvalidated,
      devInvalidateProbeCache,
    },
    widgetAuth: {
      read: vi.fn(() => ({ apiKey: "wp-widget-uuid", generatedAt: "now" })),
      generate: vi.fn(() => ({ apiKey: "wp-widget-uuid", generatedAt: "now" })),
    },
    nango: {
      getNangoCredentials,
      providerConfigKeys: { wordpress: "cinatra-wordpress" },
    },
    helpers: {
      probeDockerContainer: vi.fn(() => true),
      probeHttp: vi.fn(() => true),
      probeHttpAnswered: vi.fn(() => true),
      probeHttpReachableWithRetry: vi.fn(async () => true),
      dockerExecCapture: docker,
      isLocalhostUrl: vi.fn(() => true),
      trimTrailingSlashes: (input: string) => {
        let end = input.length;
        while (end > 0 && input.charCodeAt(end - 1) === 47) end--;
        return input.slice(0, end);
      },
    },
    log: vi.fn(),
  } as unknown as WordPressDevSetupDeps;
  return {
    deps,
    docker,
    getNangoCredentials,
    devSaveInstance,
    devPersistLocalInstanceUnvalidated,
    devInvalidateProbeCache,
    readInstanceById,
  };
}

const wpInput = {
  instanceId: "wp-1",
  siteUrl: "http://localhost:8080",
  username: "admin",
  providerConfigKey: "cinatra-wordpress",
  connectionId: "wp-1",
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ensureWordPressAppPasswordReconciled", () => {
  it("REUSE on a 200 probe — no mint, no rotate, no cache eviction", async () => {
    const t = makeDeps();
    t.getNangoCredentials.mockResolvedValueOnce({ username: "admin", password: "good-pw" });
    stubFetchStatus(200);

    const r = await ensureWordPressAppPasswordReconciled(t.deps, wpInput);

    expect(r).toMatchObject({ working: true, rotated: false });
    expect(t.docker).not.toHaveBeenCalled(); // no wp-cli mint
    expect(t.devSaveInstance).not.toHaveBeenCalled();
    expect(t.devInvalidateProbeCache).not.toHaveBeenCalled();
  });

  it("ROTATE only on a definite 401 — mints, re-saves, BOTH halves verified, evicts cache", async () => {
    const t = makeDeps();
    t.getNangoCredentials
      .mockResolvedValueOnce({ username: "admin", password: "stale-pw" }) // pre-probe resolve
      .mockResolvedValueOnce({ username: "admin", password: FRESH_APP_PW }); // post-save both-halves readback
    stubFetchStatus(401);
    t.docker.mockReturnValueOnce({ code: 0, out: `${FRESH_APP_PW}\n` });

    const r = await ensureWordPressAppPasswordReconciled(t.deps, wpInput);

    expect(r).toMatchObject({ working: true, rotated: true });
    expect(t.devSaveInstance).toHaveBeenCalledWith(
      expect.objectContaining({ id: "wp-1", username: "admin", applicationPassword: FRESH_APP_PW }),
    );
    expect(t.devInvalidateProbeCache).toHaveBeenCalledWith(wpInput.siteUrl);
  });

  it("ROTATE on 403 (also a definite auth failure)", async () => {
    const t = makeDeps();
    t.getNangoCredentials
      .mockResolvedValueOnce({ username: "admin", password: "stale-pw" })
      .mockResolvedValueOnce({ username: "admin", password: FRESH_APP_PW });
    stubFetchStatus(403);
    t.docker.mockReturnValueOnce({ code: 0, out: FRESH_APP_PW });

    const r = await ensureWordPressAppPasswordReconciled(t.deps, wpInput);

    expect(r.rotated).toBe(true);
  });

  it("NO rotate on a 5xx (unreachable/transient) — kept-but-UNCONFIRMED (note set), no mint, no churn", async () => {
    const t = makeDeps();
    t.getNangoCredentials.mockResolvedValueOnce({ username: "admin", password: "good-pw" });
    stubFetchStatus(503);

    const r = await ensureWordPressAppPasswordReconciled(t.deps, wpInput);

    // working stays true (avoids a false 401 hint + churn) but a note marks it
    // unconfirmed — the caller must NOT label this "valid".
    expect(r).toMatchObject({ working: true, rotated: false });
    expect(r.note).toMatch(/probe-unreachable/);
    expect(t.docker).not.toHaveBeenCalled();
    expect(t.devSaveInstance).not.toHaveBeenCalled();
    expect(t.devInvalidateProbeCache).not.toHaveBeenCalled();
  });

  it("NO rotate on a network error (fetch throws) — treated as unreachable", async () => {
    const t = makeDeps();
    t.getNangoCredentials.mockResolvedValueOnce({ username: "admin", password: "good-pw" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );

    const r = await ensureWordPressAppPasswordReconciled(t.deps, wpInput);

    expect(r.rotated).toBe(false);
    expect(t.docker).not.toHaveBeenCalled();
  });

  it("NO mint on an unresolved Nango read with NO local credential to repair from (transient) — never litters the app-password list", async () => {
    const t = makeDeps();
    t.getNangoCredentials.mockResolvedValueOnce(null);
    // default readInstanceById → null (no local pw)

    const r = await ensureWordPressAppPasswordReconciled(t.deps, wpInput);

    expect(r).toMatchObject({ working: false, rotated: false });
    expect(r.note).toMatch(/credential-unresolved \(kept/);
    expect(t.docker).not.toHaveBeenCalled();
    expect(t.devSaveInstance).not.toHaveBeenCalled();
  });

  it("UNRESOLVED Nango but LOCAL has a usable pw — self-heal: re-sync from local, NO mint", async () => {
    const t = makeDeps();
    // Nango connection went fully missing; local connector-metadata still has the pw.
    t.readInstanceById.mockReturnValueOnce({
      id: "wp-1",
      username: "admin",
      applicationPassword: FRESH_APP_PW,
    } as never);
    t.getNangoCredentials
      .mockResolvedValueOnce(null) // pre-probe resolve → unresolved
      .mockResolvedValueOnce({ username: "admin", password: FRESH_APP_PW }); // post re-sync → now present

    const r = await ensureWordPressAppPasswordReconciled(t.deps, wpInput);

    expect(r).toMatchObject({ working: true, rotated: false });
    expect(r.note).toMatch(/nango-resynced-from-local \(was unresolved/);
    expect(t.docker).not.toHaveBeenCalled(); // no mint
    expect(t.devSaveInstance).toHaveBeenCalledWith(
      expect.objectContaining({ applicationPassword: FRESH_APP_PW }),
    );
    expect(t.devInvalidateProbeCache).toHaveBeenCalledWith(wpInput.siteUrl);
  });

  it("BOTH-HALVES: a swallowed Nango-sync failure (readback mismatch) surfaces as not-working", async () => {
    const t = makeDeps();
    // No local pw divergence (readInstanceById → null) → mint path.
    t.getNangoCredentials
      .mockResolvedValueOnce({ username: "admin", password: "stale-pw" }) // pre-probe
      .mockResolvedValueOnce({ username: "admin", password: "stale-pw" }); // post-save STILL stale → Nango didn't sync
    stubFetchStatus(401);
    t.docker.mockReturnValueOnce({ code: 0, out: FRESH_APP_PW });

    const r = await ensureWordPressAppPasswordReconciled(t.deps, wpInput);

    expect(r).toMatchObject({ working: false, rotated: false });
    expect(r.note).toMatch(/nango-sync-failed/);
    expect(t.devInvalidateProbeCache).not.toHaveBeenCalled(); // not a verified rotate
  });

  it("CHURN GUARD: when LOCAL holds a fresh pw but Nango is stale (prior rotate's sync failed), RE-SYNC from local — NO new mint", async () => {
    const t = makeDeps();
    t.readInstanceById.mockReturnValueOnce({
      id: "wp-1",
      username: "admin",
      applicationPassword: FRESH_APP_PW,
    } as never);
    t.getNangoCredentials
      .mockResolvedValueOnce({ username: "admin", password: "stale-pw" }) // pre-probe → stale → 401
      .mockResolvedValueOnce({ username: "admin", password: FRESH_APP_PW }); // post re-sync → Nango now matches local
    stubFetchStatus(401);

    const r = await ensureWordPressAppPasswordReconciled(t.deps, wpInput);

    expect(r).toMatchObject({ working: true, rotated: false });
    expect(r.note).toMatch(/nango-resynced-from-local/);
    expect(t.docker).not.toHaveBeenCalled(); // CRUCIAL: no new app-password minted (no churn)
    expect(t.devSaveInstance).toHaveBeenCalledWith(
      expect.objectContaining({ applicationPassword: FRESH_APP_PW }), // re-pushes the EXISTING local pw
    );
    expect(t.devInvalidateProbeCache).toHaveBeenCalledWith(wpInput.siteUrl);
  });

  it("a FAILED mint (wp-cli Error) never overwrites — no re-save", async () => {
    const t = makeDeps();
    t.getNangoCredentials.mockResolvedValueOnce({ username: "admin", password: "stale-pw" });
    stubFetchStatus(401);
    t.docker.mockReturnValueOnce({ code: 0, out: "Error: could not create application password" });

    const r = await ensureWordPressAppPasswordReconciled(t.deps, wpInput);

    expect(r).toMatchObject({ working: false, rotated: false });
    expect(r.note).toMatch(/mint-failed/);
    expect(t.devSaveInstance).not.toHaveBeenCalled();
  });

  it("a devSaveInstance throw surfaces a FIXED label — no remote response-body text leaks (secret boundary)", async () => {
    const t = makeDeps();
    t.getNangoCredentials.mockResolvedValueOnce({ username: "admin", password: "stale-pw" });
    stubFetchStatus(401);
    t.docker.mockReturnValueOnce({ code: 0, out: FRESH_APP_PW });
    t.devSaveInstance.mockRejectedValueOnce(new Error(`WP-BODY-LEAK-${FRESH_APP_PW}`));

    const r = await ensureWordPressAppPasswordReconciled(t.deps, wpInput);

    expect(r).toMatchObject({ working: false, rotated: false });
    expect(r.note).toBe("re-save-failed"); // fixed connector-owned label only
    expect(r.note).not.toContain("WP-BODY-LEAK");
    expect(r.note).not.toContain(FRESH_APP_PW);
  });
});

// ===========================================================================
// WordPress FIRST WIRE (resilient widget config — host #260 Step 7, preserved
// through the cinatra#976 relocation)
// ===========================================================================
describe("firstWireWordPressInstance — resilient first wire", () => {
  const FIRST_WIRE_PW = "wxyz ABCD efgh IJKL";
  // Drive the bounded validated-save retry deterministically + instantly.
  const FAST_RETRY = { maxAttempts: 3, sleep: async () => {} } as const;

  it("HAPPY PATH: validated save + Nango both-halves in sync → working, no fallback", async () => {
    const t = makeDeps();
    t.docker.mockReturnValueOnce({ code: 0, out: `${FIRST_WIRE_PW}\n` }); // mint
    t.devSaveInstance.mockResolvedValueOnce({ id: "validated-1", connectionId: "validated-1" });
    // post-save both-halves readback resolves to the minted credential
    t.getNangoCredentials.mockResolvedValueOnce({ username: "admin", password: FIRST_WIRE_PW });

    const r = await firstWireWordPressInstance(t.deps, FAST_RETRY);

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.instanceId).toBe("validated-1");
    expect(r.reconcile).toMatchObject({ working: true, rotated: false });
    expect(r.reconcile.note).toMatch(/first-wire minted \+ nango-synced/);
    // A validated first attempt does NOT re-invalidate the probe cache (no retry).
    expect(t.devSaveInstance).toHaveBeenCalledTimes(1);
    expect(t.devInvalidateProbeCache).not.toHaveBeenCalled();
    // devSaveInstance is called with the up-front generated id (a uuid).
    expect(t.devSaveInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        siteUrl: "http://localhost:8080",
        username: "admin",
        applicationPassword: FIRST_WIRE_PW,
      }),
    );
    expect(t.devPersistLocalInstanceUnvalidated).not.toHaveBeenCalled();
  });

  it("SINGLE-BOOT RETRY (cinatra#1238): a transient first-wire 401 then a validated retry → VALIDATED, no fallback, same minted password", async () => {
    const t = makeDeps();
    t.docker.mockReturnValueOnce({ code: 0, out: `${FIRST_WIRE_PW}\n` }); // mint (once)
    // Attempt 1 throws (transient propagation 401); attempt 2 validates.
    t.devSaveInstance
      .mockRejectedValueOnce(new Error("Nango connected successfully, but WordPress rejected the authenticated API request."))
      .mockResolvedValueOnce({ id: "validated-retry", connectionId: "validated-retry" });
    t.getNangoCredentials.mockResolvedValueOnce({ username: "admin", password: FIRST_WIRE_PW });

    const r = await firstWireWordPressInstance(t.deps, FAST_RETRY);

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.instanceId).toBe("validated-retry");
    // A VALIDATED credential in a SINGLE boot — the whole point of #1238.
    expect(r.reconcile).toMatchObject({ working: true, rotated: false });
    expect(r.reconcile.note).toMatch(/first-wire minted \+ nango-synced/);
    // Exactly two validated-save attempts, and NO re-mint (docker exec once).
    expect(t.devSaveInstance).toHaveBeenCalledTimes(2);
    expect(t.docker).toHaveBeenCalledTimes(1);
    // Both attempts used the SAME minted password + SAME up-front id.
    const firstPw = t.devSaveInstance.mock.calls[0][0].applicationPassword;
    const secondPw = t.devSaveInstance.mock.calls[1][0].applicationPassword;
    expect(firstPw).toBe(FIRST_WIRE_PW);
    expect(secondPw).toBe(FIRST_WIRE_PW);
    expect(t.devSaveInstance.mock.calls[1][0].id).toBe(t.devSaveInstance.mock.calls[0][0].id);
    // The probe cache is evicted before the retry so no stale auth_error verdict.
    expect(t.devInvalidateProbeCache).toHaveBeenCalledWith("http://localhost:8080");
    // No fallback to the unvalidated persist.
    expect(t.devPersistLocalInstanceUnvalidated).not.toHaveBeenCalled();
  });

  it("RESILIENCE: validation throws on EVERY attempt → falls back to a COMPLETE local-dev persist + Nango synced; instance still lands", async () => {
    const t = makeDeps();
    t.docker.mockReturnValueOnce({ code: 0, out: FIRST_WIRE_PW }); // mint
    t.devSaveInstance.mockRejectedValue(new Error("Unable to retrieve the WordPress site title."));
    t.devPersistLocalInstanceUnvalidated.mockResolvedValueOnce({
      id: "fallback-1",
      connectionId: "fallback-1",
    });
    // post-persist both-halves readback resolves to the minted credential
    t.getNangoCredentials.mockResolvedValueOnce({ username: "admin", password: FIRST_WIRE_PW });

    const r = await firstWireWordPressInstance(t.deps, FAST_RETRY);

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    // All attempts exhausted before the fallback.
    expect(t.devSaveInstance).toHaveBeenCalledTimes(3);
    // The fallback's persisted id is the source of truth for the widget config.
    expect(r.instanceId).toBe("fallback-1");
    // Credential unconfirmed (validation never passed) but the instance is
    // persisted + Nango synced — so the widget config WILL be pushed.
    expect(r.reconcile).toMatchObject({ working: false, rotated: false });
    expect(r.reconcile.note).toMatch(/instance persisted/);
    // The unvalidated fallback received the SAME minted credential.
    expect(t.devPersistLocalInstanceUnvalidated).toHaveBeenCalledWith(
      expect.objectContaining({
        siteUrl: "http://localhost:8080",
        username: "admin",
        applicationPassword: FIRST_WIRE_PW,
      }),
    );
    // The validated save and the fallback must use the SAME up-front id.
    const savedId = t.devSaveInstance.mock.calls[0][0].id;
    const fallbackId = t.devPersistLocalInstanceUnvalidated.mock.calls[0][0].id;
    expect(savedId).toBeTruthy();
    expect(fallbackId).toBe(savedId);
  });

  it("SECRET BOUNDARY: a save throw whose message embeds the app-password never leaks into the surfaced note", async () => {
    const t = makeDeps();
    t.docker.mockReturnValueOnce({ code: 0, out: FIRST_WIRE_PW });
    t.devSaveInstance.mockRejectedValue(new Error(`remote-leak-${FIRST_WIRE_PW}`));
    t.devPersistLocalInstanceUnvalidated.mockResolvedValueOnce({
      id: "fallback-2",
      connectionId: "fallback-2",
    });
    t.getNangoCredentials.mockResolvedValueOnce({ username: "admin", password: FIRST_WIRE_PW });

    const r = await firstWireWordPressInstance(t.deps, FAST_RETRY);

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.reconcile.note ?? "").not.toContain("remote-leak");
    expect(r.reconcile.note ?? "").not.toContain(FIRST_WIRE_PW);
  });

  it("WRITER UNAVAILABLE (older host): devSaveInstance returns falsy → NO retry, immediate unvalidated fallback", async () => {
    const t = makeDeps();
    t.docker.mockReturnValueOnce({ code: 0, out: FIRST_WIRE_PW });
    // Returns undefined (member not published) — retrying cannot help.
    t.devSaveInstance.mockResolvedValue(undefined);
    t.devPersistLocalInstanceUnvalidated.mockResolvedValueOnce({ id: "fallback-3", connectionId: "fallback-3" });
    t.getNangoCredentials.mockResolvedValueOnce({ username: "admin", password: FIRST_WIRE_PW });

    const r = await firstWireWordPressInstance(t.deps, FAST_RETRY);

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    // Exactly ONE attempt — a falsy return is terminal, not retried.
    expect(t.devSaveInstance).toHaveBeenCalledTimes(1);
    expect(t.devInvalidateProbeCache).not.toHaveBeenCalled();
    expect(r.instanceId).toBe("fallback-3");
  });

  it("HARD ERROR: an app-password MINT failure → {ok:false} with a fixed reason — caller hard-errors, no persist attempted", async () => {
    const t = makeDeps();
    // wp-cli returns an Error line → mintWordPressAppPassword() → null
    t.docker.mockReturnValueOnce({ code: 0, out: "Error: could not create application password" });

    const r = await firstWireWordPressInstance(t.deps, FAST_RETRY);

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected not-ok");
    expect(r.reason).toBe("wp user application-password create failed (no porcelain output)");
    expect(t.devSaveInstance).not.toHaveBeenCalled();
    expect(t.devPersistLocalInstanceUnvalidated).not.toHaveBeenCalled();
  });

  it("UNRECOVERABLE: both validated save AND the unvalidated fallback throw → {ok:false} with a FIXED reason (no secret leak)", async () => {
    const t = makeDeps();
    t.docker.mockReturnValueOnce({ code: 0, out: FIRST_WIRE_PW });
    t.devSaveInstance.mockRejectedValue(new Error("validate-throw"));
    t.devPersistLocalInstanceUnvalidated.mockRejectedValueOnce(new Error(`persist-leak-${FIRST_WIRE_PW}`));

    const r = await firstWireWordPressInstance(t.deps, FAST_RETRY);

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected not-ok");
    // Fixed connector-owned reason — the caller does NOT push the widget
    // config for an unpersisted instance.
    expect(r.reason).toBe("saveWordPressInstance failed (first wire)");
    expect(r.reason).not.toContain(FIRST_WIRE_PW);
  });
});
