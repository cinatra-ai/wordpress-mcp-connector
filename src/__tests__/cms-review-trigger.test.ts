import { describe, expect, it, vi } from "vitest";

import {
  CMS_REVIEW_SNAPSHOT_MIME,
  buildCmsScopeManifest,
  buildStagedWriteCapture,
  cmsExternalId,
  deriveCmsOperationId,
  evaluateStagedContentWrite,
  resolveProposedState,
  serializeCmsFields,
  type CmsCurrentContent,
} from "../integration/cms-review-trigger";
import type {
  CmsReviewCaptureInput,
  CmsReviewCaptureResult,
  CmsReviewDisposition,
  CmsReviewSeam,
} from "../deps";

const CONNECTOR_ID = "@cinatra-ai/wordpress-mcp-connector";

const CURRENT: CmsCurrentContent = {
  title: "Old title",
  content: "<p>Old body</p>",
  excerpt: "old excerpt",
  status: "publish",
  adminUrl: "https://example.com/wp-admin/post.php?post=42&action=edit",
  link: "https://example.com/hello-world",
};

/** A stub review seam whose disposition + capture result are configurable, with
 * spied members so a test can assert exactly what the trigger passed the host. */
function stubSeam(opts: {
  active?: boolean;
  disposition?: CmsReviewDisposition;
  captureResult?: Partial<CmsReviewCaptureResult>;
}): {
  seam: CmsReviewSeam;
  captureStagedWrite: ReturnType<typeof vi.fn>;
  resolveDisposition: ReturnType<typeof vi.fn>;
  recordApplyVerification: ReturnType<typeof vi.fn>;
} {
  const captureStagedWrite = vi.fn(
    async (_input: CmsReviewCaptureInput): Promise<CmsReviewCaptureResult> => ({
      artifactId: "art-1",
      snapshotRevisionId: "rev-1",
      snapshotTargetId: "tgt-1",
      operationId: _input.operationId,
      producedEventId: "evt-1",
      ...opts.captureResult,
    }),
  );
  const resolveDisposition = vi.fn(async () => ({
    disposition: (opts.disposition ?? "held") as CmsReviewDisposition,
    gate: { gateId: "gate-1", runId: "run-1" },
  }));
  const recordApplyVerification = vi.fn(async () => ({ ok: true, outcome: "verified" as const }));
  const seam: CmsReviewSeam = {
    isReviewActive: () => opts.active ?? true,
    captureStagedWrite,
    resolveDisposition,
    recordApplyVerification,
  };
  return { seam, captureStagedWrite, resolveDisposition, recordApplyVerification };
}

describe("serializeCmsFields", () => {
  it("emits the known paths in canonical order, dropping absent fields", () => {
    expect(serializeCmsFields({ excerpt: "e", title: "t" })).toBe(
      JSON.stringify({ title: "t", excerpt: "e" }),
    );
  });
  it("is stable regardless of input key order", () => {
    const a = serializeCmsFields({ status: "draft", content: "c", title: "t" });
    const b = serializeCmsFields({ title: "t", content: "c", status: "draft" });
    expect(a).toBe(b);
  });
});

describe("resolveProposedState", () => {
  it("carries unchanged fields from current and flags only changed paths", () => {
    const { proposedState, changedPaths } = resolveProposedState(CURRENT, { title: "New title" });
    expect(proposedState).toEqual({
      title: "New title",
      content: CURRENT.content,
      excerpt: CURRENT.excerpt,
      status: CURRENT.status,
    });
    expect(changedPaths).toEqual(["title"]);
  });
  it("treats an empty content/excerpt proposal as not-proposed (the writer drops it)", () => {
    const { changedPaths } = resolveProposedState(CURRENT, { content: "", excerpt: "" });
    expect(changedPaths).toEqual([]);
  });
  it("flags a status change (publish→draft) as a reviewed path", () => {
    const { changedPaths } = resolveProposedState(CURRENT, { status: "draft" });
    expect(changedPaths).toEqual(["status"]);
  });
  it("reports no change when the proposal equals current", () => {
    const { changedPaths } = resolveProposedState(CURRENT, { title: CURRENT.title });
    expect(changedPaths).toEqual([]);
  });
});

describe("deriveCmsOperationId", () => {
  const base = { instanceId: "site-1", resourceType: "post", cmsResourceId: "42" };
  it("is deterministic for an identical proposal", () => {
    const a = deriveCmsOperationId({ ...base, proposedSerialization: "X" });
    const b = deriveCmsOperationId({ ...base, proposedSerialization: "X" });
    expect(a).toBe(b);
  });
  it("differs for a different proposal", () => {
    const a = deriveCmsOperationId({ ...base, proposedSerialization: "X" });
    const b = deriveCmsOperationId({ ...base, proposedSerialization: "Y" });
    expect(a).not.toBe(b);
  });
  it("differs for a different post", () => {
    const a = deriveCmsOperationId({ ...base, proposedSerialization: "X" });
    const b = deriveCmsOperationId({ ...base, cmsResourceId: "43", proposedSerialization: "X" });
    expect(a).not.toBe(b);
  });
});

describe("buildStagedWriteCapture", () => {
  it("passes the proposed content + scope manifest + identity coordinates", () => {
    const { proposedState, changedPaths } = resolveProposedState(CURRENT, {
      title: "New title",
      content: "<p>New body</p>",
    });
    const cap = buildStagedWriteCapture({
      instanceId: "site-1",
      resourceType: "post",
      cmsResourceId: "42",
      url: CURRENT.link!,
      current: CURRENT,
      proposedState,
      changedPaths,
      capturedAt: "2026-07-26T00:00:00.000Z",
      connectorId: CONNECTOR_ID,
    });
    // The snapshot content is the FULL proposed post state, serialized canonically.
    expect(cap.resolved.text).toBe(
      serializeCmsFields({
        title: "New title",
        content: "<p>New body</p>",
        excerpt: CURRENT.excerpt,
        status: CURRENT.status,
      }),
    );
    expect(cap.resolved.mime).toBe(CMS_REVIEW_SNAPSHOT_MIME);
    // The scope manifest is ONLY the changed paths (the apply can never widen it).
    expect(cap.scopeManifest).toEqual(buildCmsScopeManifest(["title", "content"]));
    expect(cap.connectorInstance).toBe("site-1");
    expect(cap.resourceType).toBe("post");
    expect(cap.cmsResourceId).toBe("42");
    expect(cap.pointer.externalId).toBe(cmsExternalId("site-1", "42"));
    expect(cap.pointer.connectorId).toBe(CONNECTOR_ID);
    // The base CAS anchor is a digest of the CURRENT content, not the proposal.
    expect(cap.baseRemoteRevisionRef).not.toBeNull();
    expect(cap.baseRemoteRevisionRef).not.toBe(
      // a digest of the proposal would differ
      cap.operationId,
    );
  });
});

describe("evaluateStagedContentWrite — fence OFF / no seam (byte-identical)", () => {
  it("returns pass WITHOUT fetching current or capturing when the seam is unbound", async () => {
    const fetchCurrent = vi.fn(async () => CURRENT);
    const decision = await evaluateStagedContentWrite({
      seam: undefined,
      connectorId: CONNECTOR_ID,
      instanceId: "site-1",
      postId: 42,
      postType: undefined,
      proposed: { title: "New title" },
      fetchCurrent,
    });
    expect(decision).toEqual({ action: "pass" });
    expect(fetchCurrent).not.toHaveBeenCalled();
  });

  it("returns pass WITHOUT fetching current when the review fence is inactive", async () => {
    const { seam, captureStagedWrite } = stubSeam({ active: false });
    const fetchCurrent = vi.fn(async () => CURRENT);
    const decision = await evaluateStagedContentWrite({
      seam,
      connectorId: CONNECTOR_ID,
      instanceId: "site-1",
      postId: 42,
      postType: undefined,
      proposed: { title: "New title" },
      fetchCurrent,
    });
    expect(decision).toEqual({ action: "pass" });
    expect(fetchCurrent).not.toHaveBeenCalled();
    expect(captureStagedWrite).not.toHaveBeenCalled();
  });
});

describe("evaluateStagedContentWrite — fence ON", () => {
  it("captures the proposed content + scope manifest and HOLDS when the gate is pending", async () => {
    const { seam, captureStagedWrite } = stubSeam({ active: true, disposition: "held" });
    const decision = await evaluateStagedContentWrite({
      seam,
      connectorId: CONNECTOR_ID,
      instanceId: "site-1",
      postId: 42,
      postType: "post",
      proposed: { title: "New title", content: "<p>New body</p>" },
      fetchCurrent: async () => CURRENT,
      now: () => new Date("2026-07-26T00:00:00.000Z"),
    });
    expect(captureStagedWrite).toHaveBeenCalledTimes(1);
    const capArg = captureStagedWrite.mock.calls[0]![0] as CmsReviewCaptureInput;
    expect(capArg.scopeManifest.paths).toEqual(["title", "content"]);
    expect(capArg.resolved.text).toContain("New title");
    expect(capArg.resolved.text).toContain("New body");
    expect(capArg.cmsResourceId).toBe("42");
    expect(capArg.resourceType).toBe("post");
    expect(decision.action).toBe("hold");
    if (decision.action === "hold") {
      expect(decision.pending.applied).toBe(false);
      expect(decision.pending.status).toBe("pending_review");
      expect(decision.pending.reviewedPaths).toEqual(["title", "content"]);
      expect(decision.pending.snapshotArtifactId).toBe("art-1");
      expect(decision.pending.gate).toEqual({ gateId: "gate-1", runId: "run-1" });
    }
  });

  it("does NOT capture and returns pass when nothing actually changes", async () => {
    const { seam, captureStagedWrite } = stubSeam({ active: true });
    const decision = await evaluateStagedContentWrite({
      seam,
      connectorId: CONNECTOR_ID,
      instanceId: "site-1",
      postId: 42,
      postType: "post",
      proposed: { title: CURRENT.title },
      fetchCurrent: async () => CURRENT,
    });
    expect(decision).toEqual({ action: "pass" });
    expect(captureStagedWrite).not.toHaveBeenCalled();
  });

  it("returns apply (with the gate) when the disposition is approved", async () => {
    const { seam } = stubSeam({ active: true, disposition: "approved" });
    const decision = await evaluateStagedContentWrite({
      seam,
      connectorId: CONNECTOR_ID,
      instanceId: "site-1",
      postId: 42,
      postType: "post",
      proposed: { title: "New title" },
      fetchCurrent: async () => CURRENT,
    });
    expect(decision.action).toBe("apply");
    if (decision.action === "apply") {
      expect(decision.gate).toEqual({ gateId: "gate-1", runId: "run-1" });
    }
  });

  it("returns reject when the disposition is rejected", async () => {
    const { seam } = stubSeam({ active: true, disposition: "rejected" });
    const decision = await evaluateStagedContentWrite({
      seam,
      connectorId: CONNECTOR_ID,
      instanceId: "site-1",
      postId: 42,
      postType: "post",
      proposed: { title: "New title" },
      fetchCurrent: async () => CURRENT,
    });
    expect(decision.action).toBe("reject");
  });

  it("passes (org-permitted apply) when the disposition is ungated", async () => {
    const { seam } = stubSeam({ active: true, disposition: "ungated" });
    const decision = await evaluateStagedContentWrite({
      seam,
      connectorId: CONNECTOR_ID,
      instanceId: "site-1",
      postId: 42,
      postType: "post",
      proposed: { title: "New title" },
      fetchCurrent: async () => CURRENT,
    });
    expect(decision).toEqual({ action: "pass" });
  });

  it("uses page as the resourceType when postType is 'page'", async () => {
    const { seam, captureStagedWrite } = stubSeam({ active: true });
    await evaluateStagedContentWrite({
      seam,
      connectorId: CONNECTOR_ID,
      instanceId: "site-1",
      postId: 7,
      postType: "page",
      proposed: { title: "New title" },
      fetchCurrent: async () => CURRENT,
    });
    const capArg = captureStagedWrite.mock.calls[0]![0] as CmsReviewCaptureInput;
    expect(capArg.resourceType).toBe("page");
  });
});
