import { z } from "zod";
import type { ExtensionPrimitiveRequest } from "@cinatra-ai/sdk-extensions";
import {
  getWordPressDeps,
  type WidgetActorContext,
  type WidgetActorOverride,
} from "../deps";

// cinatra#246 — the content-editor RELAY. `wordpress_content_editor_run` is a
// DISPATCH primitive (it sends an A2A task to the wordpress-content-editor
// agent), not a CMS read/write capability, and it must NEVER be a
// model-visible MCP tool: when the leaf agent has the cinatra MCP server
// injected it would otherwise see this name in tools/list and call it —
// re-dispatching itself (observed: recursive mcp_call -> 504). This module is
// deliberately never wired into `createWordPressPrimitiveHandlers()` /
// `registerWordPressPrimitives()`'s tool-registration map (cinatra-ai/cinatra
// #2022 S7 — extracted so the relay structurally cannot reach tools/list,
// rather than relying on registry.ts's registration loop skipping it by
// name). Callers (the widget-chat tool, wordpress-agent's own dispatch)
// import `runContentEditorRelay` directly. See
// `../__tests__/registry-omission.test.ts` for the regression guard proving
// the MCP surface never sees this name.

// Blocking A2A dispatch to wayflow-wordpress-content-editor (port 3021).
// postId uses z.coerce.number().int().positive() so widget callers (which send
// String(postId) from buildContentContext) work.
export const contentEditorRunSchema = z.object({
  instanceId:   z.string().min(1).describe("WordPress instance ID from connector administration"),
  postId:       z.coerce.number().int().positive().describe("WordPress post ID (string from widget coerced to number)"),
  postType:     z.string().optional().default("post").describe("Post type slug"),
  postStatus:   z.string().optional().default("").describe("Current publish status: publish or draft"),
  instructions: z.string().min(1).describe("Natural language editing instructions"),
});

// Strip Markdown code fences from LLM-emitted JSON before parse. The
// wayflow-wordpress-content-editor agent's LLM occasionally wraps its JSON
// output in ```json ... ``` fences; the regex only matches at string
// boundaries so internal triplets survive.
function stripCodeFences(text: string): string {
  return text.replace(/^```(?:json)?\n?|\n?```$/g, "").trim();
}

// S5 delegated-widget OBO reconstruction (cinatra S5-W1 §5 G3/G4). Build the
// carrier-run actor override from the TRUSTED widget actor context the host
// derives from the MCP request frame — NEVER from tool input. Fail-closed:
//   • a `public_site_widget` delegation MISSING pinned fields (blank runBy /
//     orgId / instanceId) is a malformed delegation → THROW (never fall through
//     to the normal identity path — the "missing override on a widget call"
//     negative case);
//   • G3 INSTANCE PIN — the model-supplied tool-arg `toolInstanceId` MUST equal
//     the actor's SERVER-PINNED `instanceId`, else `instance_pin_mismatch` (a
//     prompt-injected / confused-model attempt to target a different
//     origin-matched instance in the same org is refused, no write).
// The returned override drives `dispatchContentEditor`'s `actorOverride`, so the
// carrier run authorizes AS THE END USER against the pinned instance with the
// platform-admin-suppressing `sourceType`.
function buildWidgetActorOverride(
  actor: WidgetActorContext,
  toolInstanceId: string,
  primitiveName: string,
): WidgetActorOverride {
  if (!actor.runBy || !actor.orgId || !actor.instanceId) {
    throw new Error(
      `${primitiveName} denied: public_site_widget delegation is missing the pinned actor fields (runBy/orgId/instanceId).`,
    );
  }
  if (toolInstanceId !== actor.instanceId) {
    throw new Error(
      `instance_pin_mismatch: ${primitiveName} tool-arg instanceId "${toolInstanceId}" ` +
        "does not match the widget actor's server-pinned instance.",
    );
  }
  return {
    runBy: actor.runBy,
    orgId: actor.orgId,
    instanceId: actor.instanceId,
    sourceType: "public_site_widget",
  };
}

// Blocking A2A dispatch to wayflow-wordpress-content-editor.
//
// The A2A client, the bearer-token mint, and the `task.history` walk live
// HOST-SIDE behind `getWordPressDeps().dispatchContentEditor` (the host owns
// `@cinatra-ai/a2a` + `@cinatra-ai/llm`). The connector never sees an A2A
// `Task`: the host returns the raw last-agent text reply. This connector
// keeps the code-fence-strip + JSON.parse (the demote-then-edit output is
// JSON the LLM occasionally wraps in ```json fences). timeoutMs: 300_000
// aligns with the Cinatra /chat blocking budget.
//
// NOT part of `createWordPressPrimitiveHandlers()` (cinatra#246 — see the
// module doc comment above). Callers import this function directly.
export async function runContentEditorRelay(
  request: ExtensionPrimitiveRequest<unknown>,
): Promise<unknown> {
  const input = contentEditorRunSchema.parse(request.input);
  const deps = getWordPressDeps();

  // S5 delegated-widget OBO reconstruction (cinatra S5-W1). When the turn is
  // driven by a trusted `public_site_widget` delegated actor, the downstream
  // CMS write must authorize AS THE END USER against the SERVER-PINNED
  // instance. Read the actor context the host derives from the MCP request
  // frame (NEVER from tool input); `null` on the normal (non-widget) agent
  // path, where the dispatch stays byte-identical to today. On the widget
  // path `buildWidgetActorOverride` fail-closes on a missing pin field and
  // asserts the tool-arg instance pin (G3) before the override is built.
  const widgetActor = deps.resolveWidgetActor?.() ?? null;
  const actorOverride: WidgetActorOverride | undefined = widgetActor
    ? buildWidgetActorOverride(widgetActor, input.instanceId, "wordpress_content_editor_run")
    : undefined;

  // Boundary rule (cinatra#978): connector code never reads process.env.
  // The optional per-deployment URL override arrives through the
  // host-bound `resolveContentEditorAgentUrl` dep (`settings` host port,
  // key "content_editor_a2a_url"); absent, unbound, or unset resolves the
  // static default route.
  const agentUrl =
    (await deps.resolveContentEditorAgentUrl?.()) ??
    "http://localhost:3010/agents/cinatra-ai/wordpress-agent";

  const text = await deps.dispatchContentEditor({
    agentUrl,
    payload: input,
    timeoutMs: 300_000, // aligned with /chat blocking budget
    // cinatra#246: lets the host resolve the agent template + pre-create the
    // OBO agent_run so the CMS write authorizes via the production agent-run
    // OBO path (not the dev-admin bypass).
    packageName: "@cinatra-ai/wordpress-agent",
    // S5: present ONLY on the public_site_widget path (undefined omits the
    // key entirely, so the non-widget dispatch is byte-identical to today).
    ...(actorOverride ? { actorOverride } : {}),
  });

  // Strip code fences before JSON.parse.
  try {
    return JSON.parse(stripCodeFences(text));
  } catch {
    return { result: text };
  }
}
