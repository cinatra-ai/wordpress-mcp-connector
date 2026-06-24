import { describe, expect, it, vi } from "vitest";

// createPostPublishedHandler factory tests (cinatra#339 task E).
//
// Behavior contract (the host owns verify/idempotency/HTTP; this module owns the
// per-hook business logic that turns a verified payload into an outcome):
//   P1: the factory returns a function (host structural gate + runtime build).
//   P2: a valid post_published payload → { outcome: "accepted" } (observability-only).
//   P3: a well-formed but DIFFERENT event → { outcome: "ignored" }.
//   P4: a non-object / non-event payload → { outcome: "rejected", invalid-payload }.
//   P5: a post_published event with a malformed body → { outcome: "rejected" }.
//   P6: REDACTION — the handler logs only non-secret structured fields, never the
//       full payload, raw body bytes, or any value that looks like a secret.

import { createPostPublishedHandler } from "../webhooks/post-published";

type LoggedField = Record<string, unknown> | undefined;

function makeCtx(payload: unknown) {
  const logged: { message: string; fields: LoggedField }[] = [];
  const ctx = {
    webhook: {
      vendor: "cinatra-ai",
      slug: "wordpress-mcp-connector",
      hook: "post-published",
      bindingId: "bnd_test",
      siteId: "site_test",
      messageId: "msg_test",
      timestamp: new Date("2026-06-24T00:00:00.000Z"),
      rawBody: Buffer.from(JSON.stringify(payload)),
      payload,
    },
    log: vi.fn((message: string, fields?: Record<string, unknown>) => {
      logged.push({ message, fields });
    }),
  };
  return { ctx, logged };
}

const validPayload = {
  event: "post_published",
  postId: 42,
  postType: "post",
  title: "Hello world",
  url: "https://example.com/hello-world",
  siteUrl: "https://example.com",
  issuedAt: "2026-06-24T00:00:00.000Z",
};

describe("createPostPublishedHandler", () => {
  it("P1: returns a handler function", () => {
    expect(typeof createPostPublishedHandler()).toBe("function");
  });

  it("P2: a valid post_published payload is accepted", async () => {
    const handler = createPostPublishedHandler();
    const { ctx } = makeCtx(validPayload);
    await expect(handler(ctx)).resolves.toEqual({ outcome: "accepted" });
  });

  it("P2b: url is optional — a valid payload without url is still accepted", async () => {
    const handler = createPostPublishedHandler();
    const { url: _omitted, ...noUrl } = validPayload;
    const { ctx } = makeCtx(noUrl);
    await expect(handler(ctx)).resolves.toEqual({ outcome: "accepted" });
  });

  it("P3: a well-formed but different event is ignored (not an error)", async () => {
    const handler = createPostPublishedHandler();
    const { ctx } = makeCtx({ event: "post_updated", postId: 1 });
    await expect(handler(ctx)).resolves.toEqual({
      outcome: "ignored",
      detail: { event: "post_updated" },
    });
  });

  it("P4: a non-event payload is rejected as invalid-payload", async () => {
    const handler = createPostPublishedHandler();
    for (const bad of [null, 42, "nope", [], {}, { foo: "bar" }]) {
      const { ctx } = makeCtx(bad);
      await expect(handler(ctx)).resolves.toEqual({
        outcome: "rejected",
        detail: { reason: "invalid-payload" },
      });
    }
  });

  it("P5: a post_published event with a malformed body is rejected", async () => {
    const handler = createPostPublishedHandler();
    // postId must be a positive int; siteUrl required.
    const { ctx } = makeCtx({ event: "post_published", postId: -1, postType: "post" });
    await expect(handler(ctx)).resolves.toEqual({
      outcome: "rejected",
      detail: { reason: "invalid-payload" },
    });
  });

  it("P6: redaction — never logs the full payload, raw body, or secret-like values", async () => {
    const handler = createPostPublishedHandler();
    const sentinelPayload = {
      ...validPayload,
      // Hostile extra fields that MUST NOT be echoed by the handler's logging.
      secret: "super-secret-token-DO-NOT-LOG",
      applicationPassword: "app-pass-DO-NOT-LOG",
    };
    const { ctx, logged } = makeCtx(sentinelPayload);
    await handler(ctx);
    const serialized = JSON.stringify(logged);
    expect(serialized).not.toContain("super-secret-token-DO-NOT-LOG");
    expect(serialized).not.toContain("app-pass-DO-NOT-LOG");
    // The whole payload object is never passed as a single log field.
    for (const entry of logged) {
      for (const v of Object.values(entry.fields ?? {})) {
        expect(v).not.toBe(sentinelPayload);
      }
    }
  });
});
