import { createWordPressPrimitiveHandlers } from "./mcp/handlers";

// Local structural mirror of `@cinatra-ai/llm`'s `LlmToolParameterSchema` /
// `LlmFunctionTool` (the chat tool-call contract) so the connector depends only
// on the SDK. The host's real types are structurally assignable to these — the
// widget-chat route consumes the returned object as its `LlmFunctionTool`.
type WordPressLlmToolParameterSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
};

type WordPressLlmFunctionTool = {
  type?: "function";
  name: string;
  description: string;
  parameters: WordPressLlmToolParameterSchema;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

export type WordPressWidgetContext = {
  instanceId?: unknown;
  postId?: unknown;
  postType?: unknown;
  postStatus?: unknown;
  href?: unknown;
};

/**
 * Build the LLM function-tool that the CMS widget chat route exposes for
 * editing the currently-open WordPress post.
 *
 * SECURITY (T-190-01 prompt-injection mitigation): the `instanceId` and
 * `postId` are forcibly overridden from the server-trusted request context
 * inside `execute()`. Any LLM-supplied identity values in `args` are dropped.
 * The LLM tool schema only declares `instructions` as a parameter — identity
 * is server-side only, never an LLM-controllable input.
 */
export function createWordPressWidgetChatTool(opts: { context: WordPressWidgetContext }): WordPressLlmFunctionTool {
  const { context } = opts;
  const handlers = createWordPressPrimitiveHandlers();

  return {
    name: "wordpress_content_editor_run",
    description:
      "Edit the currently-open WordPress post by passing natural-language instructions to the WayFlow wordpress-content-editor agent. " +
      "Use whenever the user asks for any kind of content change to the current post (rewrite, tighten, fix typos, change title, add/remove text, restructure paragraphs). " +
      "Returns { postId, changes: [{ field, before, after }] } or { result: <text> } if the agent's reply isn't structured. " +
      "When editing a published post, the agent demotes it to draft for the edit; the live revision is preserved in WordPress's revision history.",
    parameters: {
      type: "object" as const,
      properties: {
        instructions: {
          type: "string",
          description:
            "Natural-language editing instructions, derived from the user's chat message. " +
            "The server supplies instanceId and postId from the request context — do NOT pass them.",
        },
      },
      required: ["instructions"],
    } satisfies WordPressLlmToolParameterSchema,
    execute: async (args: Record<string, unknown>) => {
      // SECURITY HARDENING (T-190-01): override identity fields with
      // server-trusted context values. Ignore any LLM-supplied instanceId / postId.
      // [IN-01 fix] Pass `undefined` (not "") for absent optional fields so
      // zod's `.default("post")` etc. fire — `.default()` only triggers on
      // `undefined`, not on empty strings.
      return handlers.wordpress_content_editor_run({
        primitiveName: "wordpress_content_editor_run",
        input: {
          instructions: typeof args.instructions === "string" ? args.instructions : "",
          instanceId: String(context.instanceId ?? ""),
          postId: String(context.postId ?? ""),
          postType:
            typeof context.postType === "string" && context.postType.length > 0
              ? context.postType
              : undefined,
          postStatus:
            typeof context.postStatus === "string" && context.postStatus.length > 0
              ? context.postStatus
              : undefined,
        },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      });
    },
  };
}
