import { z } from "zod";

// Inbound `post-published` webhook handler (cinatra#339 task E, host bridge
// cinatra#343).
//
// The host owns the generic inbound-webhook route
// `POST /webhook/cinatra-ai/wordpress-mcp-connector/post-published/<bindingId>`:
// it verifies the Standard-Webhooks / legacy `X-Cinatra-Sig-256` signature,
// resolves the connected-site identity from the SERVER-ISSUED opaque bindingId
// (NEVER from the payload), enforces idempotency, and normalizes our business
// outcome to HTTP. This module owns ONLY the per-hook business logic: re-validate
// the parsed payload with our OWN schema and decide an outcome. It performs no
// signature work, no idempotency work, and trusts NOTHING in the payload for
// identity — `ctx.webhook.siteId` is the host-verified site.
//
// Behavior parity with the route this bridge supersedes
// (/api/webhooks/wordpress): observability-only, NO side effects → `accepted`.
//
// TYPE POSTURE: the host's webhook context/outcome types are mirrored LOCALLY
// (structurally assignable) so the connector takes no hard `@cinatra-ai/webhooks`
// dependency — the same posture `widget-chat-tool.ts` uses for the LLM tool
// contract. The host builds the handler from the named factory below; the
// monorepo's structural types are assignable to these.

/** A successfully VERIFIED inbound webhook, host-derived (mirrors the host's `VerifiedWebhook`). */
export type WordPressVerifiedWebhook = {
  readonly vendor: string;
  readonly slug: string;
  readonly hook: string;
  readonly bindingId: string;
  /** Connected-site identity, resolved by the host from the binding (NOT the payload). */
  readonly siteId: string;
  readonly messageId: string;
  readonly timestamp: Date;
  readonly rawBody: Buffer;
  /** Parsed JSON body — re-validated below with our own schema. */
  readonly payload: unknown;
};

/** Least-privilege context the host injects at dispatch (mirrors the host's `WebhookContext`). */
export type WordPressWebhookContext = {
  readonly webhook: WordPressVerifiedWebhook;
  /** Scoped logger. MUST NOT log secret material or full payloads. */
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
};

/** Business outcome (mirrors the host's `WebhookHandlerOutcomeKind`). */
export type WordPressWebhookOutcomeKind = "accepted" | "ignored" | "retryable" | "rejected";

/** Outcome the host normalizes to HTTP (mirrors the host's `WebhookHandlerOutcome`). */
export type WordPressWebhookOutcome = {
  readonly outcome: WordPressWebhookOutcomeKind;
  /** Optional structured detail (NEVER secret material) for logs/telemetry. */
  readonly detail?: Record<string, unknown>;
};

export type WordPressWebhookHandler = (
  ctx: WordPressWebhookContext,
) => Promise<WordPressWebhookOutcome>;

// Canonical `post_published` payload — the exact contract the WordPress plugin
// emits and the bridge supersedes (legacy /api/webhooks/wordpress). NOTE the
// hook id is kebab (`post-published`) while the payload `event` literal is
// snake (`post_published`).
const postPublishedPayloadSchema = z.object({
  event: z.literal("post_published"),
  postId: z.number().int().positive(),
  postType: z.string().min(1),
  title: z.string(),
  url: z.string().url().optional(),
  siteUrl: z.string().min(1),
  issuedAt: z.string().min(1),
});

// Discriminate a recognized-but-different event (→ ignored) from a malformed
// payload (→ rejected) without trusting the full shape: peek only the `event`.
const eventDiscriminatorSchema = z.object({ event: z.string() }).passthrough();

/**
 * Build the `post-published` webhook handler. The host invokes this named
 * factory once and reuses the returned handler per request.
 */
export function createPostPublishedHandler(): WordPressWebhookHandler {
  return async (ctx) => {
    const { webhook, log } = ctx;

    const discriminator = eventDiscriminatorSchema.safeParse(webhook.payload);
    // Not even an `{ event: string }` object — a malformed payload we refuse.
    if (!discriminator.success) {
      log("post-published rejected: payload is not a recognizable event object", {
        reason: "invalid-payload",
      });
      return { outcome: "rejected", detail: { reason: "invalid-payload" } };
    }
    // A well-formed event we simply do not handle on this hook — acknowledge
    // without action (NOT an error; a retry would be ignored identically).
    if (discriminator.data.event !== "post_published") {
      log("post-published ignored: unhandled event", { event: discriminator.data.event });
      return { outcome: "ignored", detail: { event: discriminator.data.event } };
    }

    const parsed = postPublishedPayloadSchema.safeParse(webhook.payload);
    if (!parsed.success) {
      // A `post_published` event whose body fails our schema is well-formed-as-an-
      // event but semantically refused → rejected (default 204; a retry would be
      // refused identically). Log only the issue PATHS, never the payload values.
      log("post-published rejected: invalid post_published payload", {
        reason: "schema-validation-failed",
        issues: parsed.error.issues.map((i) => i.path.join(".")),
      });
      return { outcome: "rejected", detail: { reason: "invalid-payload" } };
    }

    // Observability-only (parity with the superseded route): log NON-secret
    // structured fields, no full payload / raw body, then acknowledge.
    const p = parsed.data;
    log("post-published received", {
      siteId: webhook.siteId,
      postId: p.postId,
      postType: p.postType,
      siteUrl: p.siteUrl,
      issuedAt: p.issuedAt,
    });
    return { outcome: "accepted" };
  };
}
