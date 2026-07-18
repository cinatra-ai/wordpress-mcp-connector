import { describe, it, expect, vi } from "vitest";

import {
  WORDPRESS_POST_TYPE_ID,
  WORDPRESS_CONNECTOR_ID,
  buildWordPressPointerActor,
  buildWordPressPostPointerData,
  wordpressPointerReferenceState,
  wordpressPostExternalId,
  writeWordPressPostPointerWith,
} from "../integration/pointer-writer-core";

describe("wordpressPointerReferenceState", () => {
  it("maps probe outcomes to reference states (present→linked, modified→stale, absent→dangling)", () => {
    expect(wordpressPointerReferenceState("present")).toBe("linked");
    expect(wordpressPointerReferenceState("modified")).toBe("stale");
    expect(wordpressPointerReferenceState("absent")).toBe("dangling");
  });
});

describe("wordpressPostExternalId", () => {
  it("composes the site-scoped identity <instanceId>:<postId>", () => {
    expect(wordpressPostExternalId("site-1", 42)).toBe("site-1:42");
    expect(wordpressPostExternalId("site-1", "42")).toBe("site-1:42");
  });

  it("rejects an empty part or a colon-bearing instanceId (keeps the composite reversible)", () => {
    expect(() => wordpressPostExternalId("", 42)).toThrow();
    expect(() => wordpressPostExternalId("site-1", "")).toThrow();
    expect(() => wordpressPostExternalId("site:evil", 42)).toThrow();
  });
});

describe("buildWordPressPostPointerData", () => {
  it("builds the connectorRef external-pointer envelope, defaulting to linked", () => {
    const data = buildWordPressPostPointerData({
      instanceId: "site-1",
      postId: 42,
      url: "https://blog.example.com/?p=42",
      title: "Hello",
      excerpt: "Intro",
      remoteVersion: "2026-07-18T00:00:00",
      verifiedAt: "2026-07-18T00:00:00.000Z",
    });
    expect(data.artifactType).toBe("connector-ref");
    expect(data.originKind).toBe("external_link");
    expect(data.mime).toBe("text/html");
    expect(data.connectorRef).toMatchObject({
      url: "https://blog.example.com/?p=42",
      connectorId: WORDPRESS_CONNECTOR_ID,
      externalId: "site-1:42",
      resolvedMimeType: "text/html",
      state: "linked",
      remoteVersion: "2026-07-18T00:00:00",
      lastVerifiedAt: "2026-07-18T00:00:00.000Z",
    });
  });

  it("carries the caller-supplied reference state (stale / dangling on re-sync)", () => {
    expect(
      buildWordPressPostPointerData({
        instanceId: "site-1",
        postId: 7,
        url: "https://blog.example.com/?p=7",
        state: "stale",
      }).connectorRef.state,
    ).toBe("stale");
  });

  it("omits absent optional fields rather than writing undefined/null", () => {
    const data = buildWordPressPostPointerData({
      instanceId: "site-1",
      postId: 7,
      url: "https://blog.example.com/?p=7",
    });
    expect("title" in data).toBe(false);
    expect("remoteVersion" in data.connectorRef).toBe(false);
    expect("lastVerifiedAt" in data.connectorRef).toBe(false);
  });

  it("fail-closes on a non-http(s) or malformed url (never persists an unopenable href)", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "/relative", "not a url"]) {
      expect(() =>
        buildWordPressPostPointerData({ instanceId: "site-1", postId: 1, url }),
      ).toThrow();
    }
  });
});

describe("buildWordPressPointerActor", () => {
  it("stamps the member role floor + the org (both orgId and organizationId)", () => {
    const actor = buildWordPressPointerActor({ orgId: "org-1", userId: "user-1" });
    expect(actor).toMatchObject({
      actorType: "model",
      source: "agent",
      roles: ["member"],
      orgId: "org-1",
      organizationId: "org-1",
      userId: "user-1",
    });
  });

  it("omits userId when the trigger is not user-attributed", () => {
    const actor = buildWordPressPointerActor({ orgId: "org-1", userId: null });
    expect("userId" in actor).toBe(false);
  });
});

describe("writeWordPressPostPointerWith", () => {
  it("upserts the pointer through objects_save with the host wordpress:post typeHint", async () => {
    const saveObject = vi.fn().mockResolvedValue({
      objectId: "obj-1",
      type: WORDPRESS_POST_TYPE_ID,
      isNew: true,
      wasMerged: false,
      confidence: 1,
      changeSetId: "cs-1",
    });
    const provider = { saveObject } as unknown as Parameters<typeof writeWordPressPostPointerWith>[0];
    const actor = buildWordPressPointerActor({ orgId: "org-1" });

    const result = await writeWordPressPostPointerWith(
      provider,
      { instanceId: "site-1", postId: 42, url: "https://blog.example.com/?p=42", title: "Hello" },
      actor,
    );

    expect(result).toEqual({ objectId: "obj-1", isNew: true });
    expect(saveObject).toHaveBeenCalledTimes(1);
    const call = saveObject.mock.calls[0][0];
    expect(call.typeHint).toBe(WORDPRESS_POST_TYPE_ID);
    expect(call.mode).toBe("agentic");
    expect(call.actor).toBe(actor);
    expect(call.rawData.connectorRef.externalId).toBe("site-1:42");
    expect(call.rawData.connectorRef.state).toBe("linked");
  });
});
