// The post update ability of `wordpress_site_tool_call` answers with the
// invoker's own result: the arguments reach the invoker unchanged, the invoker
// is called once, and its result object is returned as is. The connector gives
// its tools and creates no artifact, so no host service other than the invoker
// and the write-authority gate is called.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWordPressPrimitiveHandlers } from "@cinatra-ai/wordpress-mcp-connector/mcp-handlers";
import {
  registerWordPressConnector,
  _resetWordPressDepsForTests,
  type WordPressConnectorDeps,
} from "../deps";

beforeEach(() => {
  _resetWordPressDepsForTests();
});

afterEach(() => {
  _resetWordPressDepsForTests();
  vi.restoreAllMocks();
});

describe("wordpress_site_tool_call — page update answers with the invoker's own result", () => {
  it("P1: returns exactly the invoker's object, forwards the arguments once, and calls no host service besides the invoker and the write-authority gate", async () => {
    const invokerResult = { success: true, data: { post_id: 42, message: "Post updated successfully." } };
    const invokeSiteTool = vi.fn(async () => invokerResult);
    const hostDouble = {
      isReviewActive: vi.fn(() => true),
      captureStagedWrite: vi.fn(),
      resolveDisposition: vi.fn(async () => ({ disposition: "held", gate: { gateId: "g", runId: "r" } })),
      recordApplyVerification: vi.fn(),
    };
    registerWordPressConnector({
      listMcpInstances: () => [
        {
          id: "site-1",
          siteUrl: "https://example.com",
          username: "u",
          applicationPassword: "p",
          name: "Site 1",
          createdAt: "",
          updatedAt: "",
        },
      ],
      requireInstanceWriteAuthority: vi.fn(async () => {}),
      invokeSiteTool,
      cmsReview: hostDouble,
    } as unknown as WordPressConnectorDeps);

    const handlers = createWordPressPrimitiveHandlers();
    const result = await handlers.wordpress_site_tool_call({
      primitiveName: "wordpress_site_tool_call",
      input: { toolName: "ewpa/update-post", args: { post_id: 42, title: "New title" }, instanceId: "site-1" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    } as never);

    expect(result).toEqual(invokerResult);
    expect(invokeSiteTool).toHaveBeenCalledTimes(1);
    expect(invokeSiteTool).toHaveBeenCalledWith({
      toolName: "ewpa/update-post",
      args: { post_id: 42, title: "New title" },
      instanceId: "site-1",
    });
    expect(hostDouble.isReviewActive).not.toHaveBeenCalled();
    expect(hostDouble.captureStagedWrite).not.toHaveBeenCalled();
    expect(hostDouble.resolveDisposition).not.toHaveBeenCalled();
    expect(hostDouble.recordApplyVerification).not.toHaveBeenCalled();
  });
});
