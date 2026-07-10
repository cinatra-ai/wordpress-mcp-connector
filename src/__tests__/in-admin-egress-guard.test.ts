// cinatra#1214 S4 (WordPress half) — in-admin MCP-only egress wiring guard.
//
// The house rule (#1214 / epic #1037): an in-admin CMS assistant reaches the CMS
// ONLY through that CMS's MCP integration — never a direct REST fetch with a
// stored credential. For WordPress the two in-admin editing primitives
// (`wordpress_post_get` → a `GET /wp/v2/*` and `wordpress_post_update` → a
// `POST /wp/v2/*`) were rerouted onto the site's MCP content server via
// `callWordPressMcp` (S1). This fast, Docker-free guard asserts that reroute at
// TWO layers so it cannot silently regress:
//
//   (A) BEHAVIOR — `wordpress_post_get` / `wordpress_post_update` invoke the MCP
//       client (`callWordPressMcp`) and make ZERO `globalThis.fetch` calls.
//   (B) STATIC   — the handler source references no direct-REST egress at all
//       (`fetch(` / a `/wp/v2` URL path / the deleted direct-REST helpers).
//
// This is the connector-repo D2 sibling of the shared wire-capture guard (D1):
// D1 proves absence on the network wire; this proves absence in the code path,
// so the direct-REST get/update cannot be re-imported onto the in-admin path.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { WordPressConnectorDeps } from "../deps";

vi.mock("../lib/wordpress-mcp-client", () => ({
  callWordPressMcp: vi.fn(),
  CINATRA_POST_GET_TOOL: "cinatra-post-get",
  CINATRA_POST_UPDATE_TOOL: "cinatra-post-update",
  // wordpress-plugin#82 — the six rehomed primitives' MCP tool names.
  CINATRA_POST_STATUS_TOOL: "cinatra-post-status",
  CINATRA_POSTS_LIST_TOOL: "cinatra-posts-list",
  CINATRA_POST_DELETE_TOOL: "cinatra-post-delete",
  CINATRA_MEDIA_UPLOAD_TOOL: "cinatra-media-upload",
  CINATRA_POST_CREATE_DRAFT_TOOL: "cinatra-post-create-draft",
  CINATRA_POST_UPDATE_META_TOOL: "cinatra-post-update-meta",
}));

import { callWordPressMcp } from "../lib/wordpress-mcp-client";
import { createWordPressPrimitiveHandlers } from "@cinatra-ai/wordpress-mcp-connector/mcp-handlers";
import { registerWordPressConnector, _resetWordPressDepsForTests } from "../deps";

const listMcpInstancesMock = vi.fn((): any[] => []);
const requireInstanceWriteAuthorityMock = vi.fn(async () => {});

function registerDepsStub() {
  registerWordPressConnector({
    decodeCursor: (cursor?: string) => (cursor ? Number(cursor) : 0),
    buildListPage: (items, total, offset, limit) => ({
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
    buildWordPressBasicAuthHeader: vi.fn(async () => ({ Authorization: "Basic test" })),
    createDraft: vi.fn(),
    readPostStatus: vi.fn(),
    listPublishedPosts: vi.fn(async () => ({ items: [], total: 0 })),
    listPublishedPages: vi.fn(async () => ({ items: [], total: 0 })),
    deletePost: vi.fn(async () => ({ deleted: true })),
    uploadMedia: vi.fn(),
    updateDraftMeta: vi.fn(),
    requireInstanceWriteAuthority: requireInstanceWriteAuthorityMock,
  } as WordPressConnectorDeps);
}

const inst = (id = "site-1") => ({
  id,
  name: "Site 1",
  siteUrl: "http://localhost:8081",
  username: "admin",
  applicationPassword: "app-pass",
  providerConfigKey: "wordpress",
  connectionId: id,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

// ---------------------------------------------------------------------------
// (A) Behavioral guard — the in-admin read/update primitives call the MCP client
//     and make no direct fetch.
// ---------------------------------------------------------------------------
describe("in-admin egress guard — behavior", () => {
  let handlers: ReturnType<typeof createWordPressPrimitiveHandlers>;
  let originalFetch: typeof globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handlers = createWordPressPrimitiveHandlers();
    listMcpInstancesMock.mockReset().mockReturnValue([inst("site-1")]);
    requireInstanceWriteAuthorityMock.mockReset().mockResolvedValue(undefined);
    vi.mocked(callWordPressMcp).mockReset();
    // A real fetch on the in-admin path is the violation this guard catches; spy
    // so any call is observable (and throws, proving the path does NOT depend on it).
    fetchSpy = vi.fn(async () => {
      throw new Error("direct fetch is forbidden on the in-admin edit path");
    });
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    registerDepsStub();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetWordPressDepsForTests();
  });

  it("wordpress_post_get reads through callWordPressMcp (cinatra-post-get), never a direct fetch", async () => {
    vi.mocked(callWordPressMcp).mockResolvedValue({
      id: 1,
      status: "publish",
      title: "T",
      content: "<p>b</p>",
      excerpt: "",
      slug: "t",
      link: "http://localhost:8081/?p=1",
    });

    const result = (await (handlers as any).wordpress_post_get({
      primitiveName: "wordpress_post_get",
      input: { instanceId: "site-1", postId: 1 },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    })) as any;

    // The MCP client IS the read transport.
    expect(callWordPressMcp).toHaveBeenCalledWith(
      expect.objectContaining({ id: "site-1" }),
      "cinatra-post-get",
      { id: 1 },
    );
    // ZERO direct-REST egress on the read path.
    expect(fetchSpy).not.toHaveBeenCalled();
    // The full-body before-value arrived over MCP.
    expect(result.content).toBe("<p>b</p>");
    expect(result.adminUrl).toContain("/wp-admin/post.php?post=1");
  });

  it("wordpress_post_get forwards postType:'page' to the MCP tool", async () => {
    vi.mocked(callWordPressMcp).mockResolvedValue({ id: 5, status: "draft", title: "P", content: "", excerpt: "" });
    await (handlers as any).wordpress_post_get({
      primitiveName: "wordpress_post_get",
      input: { instanceId: "site-1", postId: 5, postType: "page" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(callWordPressMcp).toHaveBeenCalledWith(expect.anything(), "cinatra-post-get", { id: 5, postType: "page" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("wordpress_post_update writes through callWordPressMcp (cinatra-post-update), never a direct fetch", async () => {
    vi.mocked(callWordPressMcp).mockResolvedValue({ id: 1, status: "draft", title: "X", content: "Y", excerpt: "" });

    await (handlers as any).wordpress_post_update({
      primitiveName: "wordpress_post_update",
      input: { instanceId: "site-1", postId: 1, status: "draft", title: "X", content: "Y" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });

    // demote-then-edit preserved: status:draft + edits reach the MCP tool.
    expect(callWordPressMcp).toHaveBeenCalledWith(
      expect.objectContaining({ id: "site-1" }),
      "cinatra-post-update",
      { id: 1, status: "draft", title: "X", content: "Y" },
    );
    // The #409 write-authority gate ran BEFORE the write.
    expect(requireInstanceWriteAuthorityMock).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: "site-1", primitiveName: "wordpress_post_update" }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a denied write-authority gate blocks the update BEFORE any MCP call (fail-closed)", async () => {
    requireInstanceWriteAuthorityMock.mockRejectedValueOnce(new Error("not authorized"));
    await expect(
      (handlers as any).wordpress_post_update({
        primitiveName: "wordpress_post_update",
        input: { instanceId: "site-1", postId: 1, title: "X" },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      }),
    ).rejects.toThrow(/not authorized/);
    expect(callWordPressMcp).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (A2) wordpress-plugin#82 — the six rehomed in-admin primitives reach WordPress
//      through callWordPressMcp (the plugin's content tools) and make ZERO
//      direct fetch. An induced direct-REST regression (a handler calling a REST
//      dep) would surface as fetchSpy being called — RED.
// ---------------------------------------------------------------------------
describe("in-admin egress guard — the #82 rehomed primitives route via MCP", () => {
  let handlers: ReturnType<typeof createWordPressPrimitiveHandlers>;
  let originalFetch: typeof globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  const call = (name: string, input: Record<string, unknown>) =>
    (handlers as any)[name]({
      primitiveName: name,
      input,
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });

  beforeEach(() => {
    handlers = createWordPressPrimitiveHandlers();
    listMcpInstancesMock.mockReset().mockReturnValue([inst("site-1")]);
    requireInstanceWriteAuthorityMock.mockReset().mockResolvedValue(undefined);
    vi.mocked(callWordPressMcp).mockReset().mockResolvedValue({});
    fetchSpy = vi.fn(async () => {
      throw new Error("direct fetch is forbidden on the in-admin content path");
    });
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    registerDepsStub();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetWordPressDepsForTests();
  });

  it("wordpress_post_status reads via cinatra-post-status, no direct fetch", async () => {
    vi.mocked(callWordPressMcp).mockResolvedValue({ id: 5, status: "publish", link: "http://localhost:8081/?p=5" });
    const r = (await call("wordpress_post_status", { instanceId: "site-1", postId: 5 })) as any;
    expect(callWordPressMcp).toHaveBeenCalledWith(expect.objectContaining({ id: "site-1" }), "cinatra-post-status", { id: 5 });
    expect(r.status).toBe("publish");
    expect(r.adminUrl).toContain("/wp-admin/post.php?post=5");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("wordpress_post_status forwards postType:'page'", async () => {
    vi.mocked(callWordPressMcp).mockResolvedValue({ id: 8, status: "draft" });
    await call("wordpress_post_status", { instanceId: "site-1", postId: 8, postType: "page" });
    expect(callWordPressMcp).toHaveBeenCalledWith(expect.anything(), "cinatra-post-status", { id: 8, postType: "page" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("wordpress_posts_list lists via cinatra-posts-list, no direct fetch", async () => {
    vi.mocked(callWordPressMcp).mockResolvedValue({ items: [{ id: 1, title: "A", status: "publish", date: "d", url: "u" }], total: 1 });
    const r = (await call("wordpress_posts_list", { instanceId: "site-1" })) as any;
    expect(callWordPressMcp).toHaveBeenCalledWith(expect.anything(), "cinatra-posts-list", { perPage: 10, offset: 0 });
    expect(r.items).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("wordpress_pages_list lists via cinatra-posts-list with postType:'page'", async () => {
    vi.mocked(callWordPressMcp).mockResolvedValue({ items: [], total: 0 });
    await call("wordpress_pages_list", { instanceId: "site-1" });
    expect(callWordPressMcp).toHaveBeenCalledWith(expect.anything(), "cinatra-posts-list", { perPage: 10, offset: 0, postType: "page" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("wordpress_post_delete deletes via cinatra-post-delete after the write gate, no direct fetch", async () => {
    vi.mocked(callWordPressMcp).mockResolvedValue({ deleted: true, previousStatus: "publish" });
    const r = (await call("wordpress_post_delete", { instanceId: "site-1", postId: 3, postType: "page" })) as any;
    expect(requireInstanceWriteAuthorityMock).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: "site-1", primitiveName: "wordpress_post_delete" }),
    );
    expect(callWordPressMcp).toHaveBeenCalledWith(expect.anything(), "cinatra-post-delete", { id: 3, postType: "page" });
    expect(r).toEqual({ ok: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("wordpress_media_upload sideloads via cinatra-media-upload, no direct fetch", async () => {
    vi.mocked(callWordPressMcp).mockResolvedValue({ mediaId: 42, sourceUrl: "http://localhost:8081/img.png" });
    const r = (await call("wordpress_media_upload", { instanceId: "site-1", imageBase64: "AAA", imageMimeType: "image/png", title: "T" })) as any;
    expect(callWordPressMcp).toHaveBeenCalledWith(expect.anything(), "cinatra-media-upload", { imageBase64: "AAA", imageMimeType: "image/png", title: "T" });
    expect(r.mediaId).toBe(42);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("wordpress_post_create_draft creates via cinatra-post-create-draft, no direct fetch", async () => {
    vi.mocked(callWordPressMcp).mockResolvedValue({ id: 99, status: "draft", link: "http://localhost:8081/?p=99" });
    const r = (await call("wordpress_post_create_draft", { instanceId: "site-1", title: "T", content: "<p>b</p>" })) as any;
    expect(callWordPressMcp).toHaveBeenCalledWith(expect.anything(), "cinatra-post-create-draft", { title: "T", content: "<p>b</p>", excerpt: "" });
    expect(r.wordpressPostId).toBe(99);
    expect(r.adminUrl).toContain("/wp-admin/post.php?post=99");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("wordpress_post_update_meta writes via cinatra-post-update-meta, no direct fetch", async () => {
    vi.mocked(callWordPressMcp).mockResolvedValue({ id: 7, updated: ["k"] });
    await call("wordpress_post_update_meta", { instanceId: "site-1", postId: 7, meta: { k: "v" } });
    expect(callWordPressMcp).toHaveBeenCalledWith(expect.anything(), "cinatra-post-update-meta", { id: 7, meta: { k: "v" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a denied write-authority gate blocks the delete BEFORE any MCP call (fail-closed)", async () => {
    requireInstanceWriteAuthorityMock.mockRejectedValueOnce(new Error("not authorized"));
    await expect(call("wordpress_post_delete", { instanceId: "site-1", postId: 3 })).rejects.toThrow(/not authorized/);
    expect(callWordPressMcp).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (B) Static guard — the handler SOURCE carries no direct-REST egress.
// ---------------------------------------------------------------------------
describe("in-admin egress guard — static source", () => {
  const source = readFileSync(new URL("../mcp/handlers.ts", import.meta.url), "utf8");

  // Strip comments so intentional prose that names the forbidden tokens (e.g.
  // "never a direct /wp/v2/* fetch") does not trip the guard; only CODE is
  // asserted. LINE comments FIRST — a `/wp/v2/*` inside a `//` comment contains
  // a `/*` that would otherwise be mis-read as a block-comment opener; removing
  // line comments first makes the block strip see only real `/** */` blocks.
  const code = source
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  it("makes no direct fetch() call in the handler code path", () => {
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });

  it("references no /wp/v2 REST path in code", () => {
    expect(code).not.toMatch(/\/wp\/v2/);
  });

  it("does not reference the deleted direct-REST helpers", () => {
    for (const deleted of ["readWordPressPost", "updateWordPressPost"]) {
      expect(code).not.toContain(deleted);
    }
  });

  it("routes the in-admin read/update through the MCP client (positive control)", () => {
    expect(code).toContain("callWordPressMcp");
    expect(code).toContain("CINATRA_POST_GET_TOOL");
    expect(code).toContain("CINATRA_POST_UPDATE_TOOL");
    expect(code).toContain("readPostViaMcp");
    expect(code).toContain("updatePostViaMcp");
  });

  // wordpress-plugin#82 — the six rehomed primitives route through the MCP
  // client too, and no longer call the direct-REST content deps in the handler.
  it("routes the rehomed primitives through the MCP client (positive control)", () => {
    for (const tool of [
      "CINATRA_POST_STATUS_TOOL",
      "CINATRA_POSTS_LIST_TOOL",
      "CINATRA_POST_DELETE_TOOL",
      "CINATRA_MEDIA_UPLOAD_TOOL",
      "CINATRA_POST_CREATE_DRAFT_TOOL",
      "CINATRA_POST_UPDATE_META_TOOL",
    ]) {
      expect(code).toContain(tool);
    }
    for (const helper of [
      "readPostStatusViaMcp",
      "listPublishedViaMcp",
      "deletePostViaMcp",
      "uploadMediaViaMcp",
      "createDraftViaMcp",
      "updateMetaViaMcp",
    ]) {
      expect(code).toContain(helper);
    }
  });

  it("the in-admin handler no longer calls the direct-REST content deps", () => {
    // The content REST members stay on the connector-owned client for the
    // non-in-admin carve-out (blog-publish / the published wordpress-content
    // capability), but the in-admin primitive HANDLERS must not invoke them.
    for (const forbidden of [
      "getWordPressDeps().createDraft(",
      "getWordPressDeps().readPostStatus(",
      "getWordPressDeps().listPublishedPosts(",
      "getWordPressDeps().listPublishedPages(",
      "getWordPressDeps().deletePost(",
      "getWordPressDeps().uploadMedia(",
      "getWordPressDeps().updateDraftMeta(",
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });
});
