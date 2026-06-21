// cinatra#409 — per-user / per-connector-instance write authorization.
//
// These tests prove the handler-side enforcement contract that makes the
// per-user token reaching the MCP boundary (post-#407/#408) load-bearing for
// WordPress CMS writes: EVERY write primitive (wordpress_post_update,
// wordpress_post_update_meta, wordpress_post_create_draft, wordpress_post_delete,
// wordpress_media_upload) calls the host dep
// `requireInstanceWriteAuthority({ instanceId, primitiveName })` AFTER resolving
// the instance and BEFORE any write reaches the host writer, and FAILS CLOSED when
// the gate denies (throws), the host actor is unresolved (null), or the dep is
// unbound on an old/skewed host.
//
// Identity is HOST-DERIVED ONLY — the dep reads the trusted MCP request frame
// host-side; the connector never passes a user identity through tool input or
// the SDK `request.actor` field. So here we model the host decision by the dep
// mock's resolve (allow) / reject (deny), matching how the real
// requireConnectorAuthority + the suppressed-platform-admin widget path behave.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { createWordPressPrimitiveHandlers } from "@cinatra-ai/wordpress-mcp-connector/mcp-handlers";
import {
  registerWordPressConnector,
  _resetWordPressDepsForTests,
  type WordPressMcpInstance,
} from "../deps";

// The host write-authority gate. Default = ALLOW; individual tests override it
// to DENY (reject) to model non-member / member-without-right / null-actor /
// cross-org / suppressed-platform-admin decisions.
const requireInstanceWriteAuthorityMock = vi.fn(
  async (_input: { instanceId: string; primitiveName: string }) => {},
);

// The five host writers behind the gated primitives. We assert these fire ONLY
// after an allow, and NEVER after a deny / unbound gate.
const createDraftMock = vi.fn(async () => ({ wordpressPostId: 10, adminUrl: "a" }));
const updatePostMock = vi.fn(async () => ({
  id: 10, status: "draft", title: "T", content: "C", excerpt: "E", adminUrl: "a",
}));
const updateDraftMetaMock = vi.fn(async () => ({ id: 10 }));
const deletePostMock = vi.fn(async () => ({ deleted: true }));
const uploadMediaMock = vi.fn(async () => ({ mediaId: 7 }));

const listMcpInstancesMock = vi.fn((): WordPressMcpInstance[] => []);

// Fixture instances. site-A is in the verified-origin org; site-B models an
// instanceId that resolves locally but belongs to a DIFFERENT org — the host
// requireConnectorAuthority keys on actor.organizationId, so the gate denies it
// for an actor whose verified origin is org A.
const inst = (id: string): WordPressMcpInstance => ({
  id,
  name: id,
  siteUrl: `https://${id}.example.com`,
  username: "u",
  applicationPassword: "p",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

function registerDepsStub(over?: {
  requireInstanceWriteAuthority?: unknown;
  omitGate?: boolean;
}) {
  const base: any = {
    decodeCursor: (cursor?: string) => (cursor ? Number(cursor) || 0 : 0),
    buildListPage: (items: any[], total: number, offset: number, limit: number) => ({
      items,
      total,
      nextCursor: offset + limit < total ? String(offset + limit) : undefined,
    }),
    dispatchContentEditor: vi.fn(async () => ""),
    deleteInstance: vi.fn(async () => {}),
    listMcpInstances: listMcpInstancesMock,
    probeMcpAdapter: async () => "registered" as const,
    resolveMcpServerUrl: (siteUrl: string) => siteUrl,
    isPrivateUrl: () => false,
    getApiStatus: () => ({ status: "not_connected" as const, detail: "" }),
    createDraft: createDraftMock,
    readPost: vi.fn(async () => ({
      id: 10, status: "draft", title: "T", content: "C", excerpt: "E", adminUrl: "a",
    })),
    readPostStatus: vi.fn(async () => ({ id: 10, status: "draft", adminUrl: "a" })),
    listPublishedPosts: vi.fn(async () => ({ items: [], total: 0 })),
    deletePost: deletePostMock,
    uploadMedia: uploadMediaMock,
    updateDraftMeta: updateDraftMetaMock,
    updatePost: updatePostMock,
    requireInstanceWriteAuthority: requireInstanceWriteAuthorityMock,
  };
  if (over?.omitGate) {
    // Model an OLD host that never bound the gate (dep absent).
    delete base.requireInstanceWriteAuthority;
  } else if (over?.requireInstanceWriteAuthority !== undefined) {
    base.requireInstanceWriteAuthority = over.requireInstanceWriteAuthority;
  }
  registerWordPressConnector(base);
}

// Returns the host writer mock that a given primitive ultimately dispatches to.
const WRITER_FOR: Record<string, () => ReturnType<typeof vi.fn>> = {
  wordpress_post_create_draft: () => createDraftMock,
  wordpress_post_update: () => updatePostMock,
  wordpress_post_update_meta: () => updateDraftMetaMock,
  wordpress_post_delete: () => deletePostMock,
  wordpress_media_upload: () => uploadMediaMock,
};

function allWriterMocks() {
  return [createDraftMock, updatePostMock, updateDraftMetaMock, deletePostMock, uploadMediaMock];
}

describe("cinatra#409 — per-user write authorization in the WordPress MCP write handlers", () => {
  let handlers: ReturnType<typeof createWordPressPrimitiveHandlers>;

  beforeEach(() => {
    handlers = createWordPressPrimitiveHandlers();
    listMcpInstancesMock.mockReset();
    listMcpInstancesMock.mockReturnValue([inst("site-A"), inst("site-B")]);
    requireInstanceWriteAuthorityMock.mockReset();
    requireInstanceWriteAuthorityMock.mockResolvedValue(undefined);
    for (const m of allWriterMocks()) m.mockClear();
    registerDepsStub();
  });

  afterEach(() => {
    _resetWordPressDepsForTests();
  });

  const writeCases = [
    {
      primitive: "wordpress_post_create_draft",
      input: { instanceId: "site-A", title: "T", content: "C", excerpt: "" },
    },
    {
      primitive: "wordpress_post_update",
      input: { instanceId: "site-A", postId: 5, title: "New" },
    },
    {
      primitive: "wordpress_post_update_meta",
      input: { instanceId: "site-A", postId: 5, meta: { _yoast_wpseo_metadesc: "d" } },
    },
    {
      primitive: "wordpress_post_delete",
      input: { instanceId: "site-A", postId: 5 },
    },
    {
      primitive: "wordpress_media_upload",
      input: { instanceId: "site-A", imageBase64: "QUJD", imageMimeType: "image/png", title: "img" },
    },
  ] as const;

  // ---- ALLOW: entitled user -> write proceeds ----
  for (const { primitive, input } of writeCases) {
    it(`${primitive}: entitled user -> the gate is invoked with the named instance, then the write dispatches`, async () => {
      await (handlers as any)[primitive]({
        primitiveName: primitive,
        input,
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      });
      // Gate was asked about the EXACT instanceId argument + the primitive name.
      expect(requireInstanceWriteAuthorityMock).toHaveBeenCalledWith({
        instanceId: "site-A",
        primitiveName: primitive,
      });
      // Only after the gate allowed does the write reach the host writer.
      expect(WRITER_FOR[primitive]()).toHaveBeenCalledTimes(1);
    });
  }

  // ---- DENY (throws) for every host decision class; NO write dispatched ----
  const denyDecisions = [
    { name: "non-member of the org", reason: "not a member" },
    { name: "member WITHOUT the connector/instance use-right", reason: "no use right" },
    {
      name: "platform admin on the public_site_widget path (bypass NOT honored, #408)",
      reason: "platform_admin suppressed on widget path",
    },
    { name: "no trusted user context (null actor: missing userId/orgId)", reason: "null actor" },
    {
      name: "forged DIFFERENT-org instanceId (enforceConnectorPolicy keys on actor.organizationId)",
      reason: "cross-org instance",
    },
    {
      name: "forged SAME-org instanceId the user is not entitled to",
      reason: "same-org unauthorized instance",
    },
  ] as const;

  for (const { primitive, input } of writeCases) {
    for (const { name, reason } of denyDecisions) {
      it(`${primitive}: DENIED (${name}) -> throws and NEVER writes`, async () => {
        requireInstanceWriteAuthorityMock.mockRejectedValueOnce(
          new Error(`write denied: ${reason}`),
        );
        await expect(
          (handlers as any)[primitive]({
            primitiveName: primitive,
            input,
            actor: { actorType: "model", source: "agent" },
            mode: "agentic",
          }),
        ).rejects.toThrow(/denied/i);
        // FAIL-CLOSED: the gate threw, so the write must never reach a host writer.
        for (const m of allWriterMocks()) expect(m).not.toHaveBeenCalled();
      });
    }
  }

  // ---- The gate must run BEFORE the write, not after ----
  it("wordpress_post_update: the authority gate runs BEFORE the host writer (deny pre-empts the write)", async () => {
    const order: string[] = [];
    requireInstanceWriteAuthorityMock.mockImplementationOnce(async () => {
      order.push("authz");
      throw new Error("write denied: ordering");
    });
    updatePostMock.mockImplementationOnce(async () => {
      order.push("write");
      return { id: 5, status: "draft", title: "", content: "", excerpt: "", adminUrl: "a" };
    });
    await expect(
      (handlers as any).wordpress_post_update({
        primitiveName: "wordpress_post_update",
        input: { instanceId: "site-A", postId: 5, title: "New" },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      }),
    ).rejects.toThrow(/denied/i);
    expect(order).toEqual(["authz"]); // authz ran; write never did.
  });

  // ---- Fail-closed when the host dep is UNBOUND (old host) ----
  it("FAILS CLOSED when requireInstanceWriteAuthority is unbound on an old host (no fallback write)", async () => {
    _resetWordPressDepsForTests();
    registerDepsStub({ omitGate: true });
    await expect(
      (handlers as any).wordpress_post_update({
        primitiveName: "wordpress_post_update",
        input: { instanceId: "site-A", postId: 5, title: "New" },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      }),
    ).rejects.toThrow(/write-authority gate is unavailable|unbound|denied/i);
    expect(updatePostMock).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when the bound gate is not a function (skewed/partial host binding)", async () => {
    _resetWordPressDepsForTests();
    registerDepsStub({ requireInstanceWriteAuthority: "not-a-function" as unknown });
    await expect(
      (handlers as any).wordpress_post_delete({
        primitiveName: "wordpress_post_delete",
        input: { instanceId: "site-A", postId: 5 },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      }),
    ).rejects.toThrow(/write-authority gate is unavailable|unbound|denied/i);
    expect(deletePostMock).not.toHaveBeenCalled();
  });

  // ---- READS are unchanged: no authority gate on the read path ----
  it("READS (wordpress_status, wordpress_instances_list, wordpress_posts_list, wordpress_post_get, wordpress_post_status) do NOT invoke the write-authority gate", async () => {
    await (handlers as any).wordpress_status({
      primitiveName: "wordpress_status", input: {},
      actor: { actorType: "model", source: "agent" }, mode: "agentic",
    });
    await (handlers as any).wordpress_instances_list({
      primitiveName: "wordpress_instances_list", input: {},
      actor: { actorType: "model", source: "agent" }, mode: "agentic",
    });
    await (handlers as any).wordpress_posts_list({
      primitiveName: "wordpress_posts_list", input: { instanceId: "site-A" },
      actor: { actorType: "model", source: "agent" }, mode: "agentic",
    });
    await (handlers as any).wordpress_post_get({
      primitiveName: "wordpress_post_get", input: { instanceId: "site-A", postId: 5 },
      actor: { actorType: "model", source: "agent" }, mode: "agentic",
    });
    await (handlers as any).wordpress_post_status({
      primitiveName: "wordpress_post_status", input: { instanceId: "site-A", postId: 5 },
      actor: { actorType: "model", source: "agent" }, mode: "agentic",
    });
    expect(requireInstanceWriteAuthorityMock).not.toHaveBeenCalled();
  });

  // ---- A DENY on the read path's instance does NOT block the read (reads are
  //      gated by membership at the boundary, not per-user write entitlement) ----
  it("wordpress_post_get still works even when the write-authority gate would deny (reads bypass the write gate)", async () => {
    requireInstanceWriteAuthorityMock.mockRejectedValue(new Error("write denied"));
    const result = await (handlers as any).wordpress_post_get({
      primitiveName: "wordpress_post_get",
      input: { instanceId: "site-A", postId: 5 },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(result).toMatchObject({ id: 10 });
    expect(requireInstanceWriteAuthorityMock).not.toHaveBeenCalled();
  });
});
