"use client";

// Per-site "Site tools & access" card (cinatra-ai/cinatra#2022 S7) — the
// settings surface the chat-cutover safety change (cinatra#2232) points site
// owners at. Three pieces, one card:
//
//   1. DISCOVERED SERVERS + HEALTH — the site's enrolled/discovered MCP
//      servers with their last probe verdict, replacing the static
//      "Connected" badge with a real signal (`deriveSiteConnectionBadge`).
//   2. PER-PIPELINE READINESS — whether each product pipeline that reaches
//      this site (blog publishing, post editing, freshness checks) currently
//      has the site tools it needs ALLOWED by the instance's tool policy,
//      with a one-click "Allow required tools" fix while blocked.
//   3. TOOL SELECTION — the write surface: edit the per-instance allow/deny
//      lists and mode, staged locally and saved as ONE full-record replace
//      through the `manage`-gated server action (which the host gates AGAIN,
//      org-admin on the instance's owning org, and re-validates).
//
// RENDERING ONLY, NEVER ENFORCEMENT: everything this card computes (readiness,
// allowed/denied) is a presentational mirror of the host's own policy
// evaluator — deny precedence absolute, `open` allows everything not denied,
// `restricted` allows only the allow list. The governed invoker's policy step
// stays the single enforcement point; a wrong render here can mislead a human
// but cannot widen any call path.
//
// Skew: `policy === null` means the host does not expose the tool-policy
// settings seam (an older Cinatra) → the selection surface renders an
// explicit unavailable note. `servers === null` means the host predates the
// server-enrollment surface → the health matrix says so. Neither state hides
// the card (silence-is-not-safety, the least-privilege card's posture).

import { useActionState, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";

import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { setWordPressInstanceToolPolicyAction } from "./setup-actions";
import type {
  InstanceToolPolicyMode,
  InstanceToolPolicyView,
  SetInstanceToolPolicyOutcome,
  SiteServerHealthRow,
  SiteToolPolicyRef,
} from "./deps";
import { healthLabel } from "./wordpress-site-tools-health";
import type { SiteConnectionBadge } from "./wordpress-site-tools-health";

/** The default aggregator server every instance auto-enrolls (mirrors the
 * host's `CATALOG_DEFAULT_SERVER_ID`; the S2 primitive suite pins the same
 * literal). Used to pre-fill new allow entries and to key pipeline readiness —
 * policy matching host-side is always on the full `{serverId, name}` pair. */
export const DEFAULT_CATALOG_SERVER_ID = "mcp-adapter-default";

/** The site abilities each product pipeline invokes for this connector —
 * grounded in the shipped call sites, not aspiration: post editing =
 * the generic site-tool path's `ewpa/get-post` / `ewpa/get-page` /
 * `ewpa/update-post` (src/mcp/handlers.ts); blog publishing = the re-pointed
 * `ewpa/create-post` / `ewpa/update-post-meta` / `ewpa/get-posts` legs
 * (cinatra#2216); freshness checks = the `ewpa/get-post` probe (cinatra#2230).
 * All ride the default aggregator server. */
export const PIPELINE_REQUIREMENTS: ReadonlyArray<{
  key: string;
  label: string;
  description: string;
  refs: SiteToolPolicyRef[];
}> = [
  {
    key: "blog-publishing",
    label: "Blog publishing",
    description: "Creating drafts, setting layout metadata, and listing published posts.",
    refs: [
      { serverId: DEFAULT_CATALOG_SERVER_ID, name: "ewpa/create-post" },
      { serverId: DEFAULT_CATALOG_SERVER_ID, name: "ewpa/update-post-meta" },
      { serverId: DEFAULT_CATALOG_SERVER_ID, name: "ewpa/get-posts" },
    ],
  },
  {
    key: "post-editing",
    label: "Post editing",
    description: "Reading and updating posts and pages from the content editor and agents.",
    refs: [
      { serverId: DEFAULT_CATALOG_SERVER_ID, name: "ewpa/get-post" },
      { serverId: DEFAULT_CATALOG_SERVER_ID, name: "ewpa/get-page" },
      { serverId: DEFAULT_CATALOG_SERVER_ID, name: "ewpa/update-post" },
    ],
  },
  {
    key: "freshness-checks",
    label: "Freshness checks",
    description: "Verifying referenced posts still match what was published.",
    refs: [{ serverId: DEFAULT_CATALOG_SERVER_ID, name: "ewpa/get-post" }],
  },
];

function refEquals(a: SiteToolPolicyRef, b: SiteToolPolicyRef): boolean {
  return a.serverId === b.serverId && a.name === b.name;
}

/** Presentational mirror of the host evaluator's truth table (deny absolute;
 * `open` allows everything not denied; `restricted` allows only the allow
 * list). Enforcement stays host-side — see the module header. */
export function isRefAllowed(policy: InstanceToolPolicyView, ref: SiteToolPolicyRef): boolean {
  if (policy.deny.some((r) => refEquals(r, ref))) return false;
  if (policy.mode === "open") return true;
  return policy.allow.some((r) => refEquals(r, ref));
}

export type PipelineReadiness =
  | { state: "ready" }
  | { state: "policy_blocked"; missing: SiteToolPolicyRef[] }
  | { state: "server_unhealthy"; health: string }
  | { state: "unknown" };

/** Readiness of one pipeline for one instance. Policy gaps rank first (they
 * have an in-card fix); a known-unhealthy default server is reported next; an
 * unknown policy (older host) is honest "unknown", never a guessed green. */
export function evaluatePipelineReadiness(
  policy: InstanceToolPolicyView | null,
  servers: SiteServerHealthRow[] | null,
  refs: SiteToolPolicyRef[],
): PipelineReadiness {
  if (!policy) return { state: "unknown" };
  const missing = refs.filter((ref) => !isRefAllowed(policy, ref));
  if (missing.length > 0) return { state: "policy_blocked", missing };
  const defaultServer = servers?.find(
    (row) => row.serverId === DEFAULT_CATALOG_SERVER_ID && row.status === "enrolled",
  );
  if (defaultServer?.lastStatus && defaultServer.lastStatus !== "registered") {
    return { state: "server_unhealthy", health: defaultServer.lastStatus };
  }
  return { state: "ready" };
}

// The probe-health derivation (`healthLabel`, `deriveSiteConnectionBadge`,
// `SiteConnectionBadge`) lives in the directive-free
// `wordpress-site-tools-health` module so the SERVER component
// `settings-page.tsx` can call it too — an export of THIS module is a client
// REFERENCE under RSC and throws when invoked on the server.
//
// Deliberately NOT re-exported from here: a re-export would leave the same
// footgun loaded, since a future server-side importer could reach the
// derivation through this client module again and reproduce the crash. The
// health module is the one canonical import site; `settings-page-boundary`
// pins that.

type StagedPolicy = {
  mode: InstanceToolPolicyMode;
  allow: SiteToolPolicyRef[];
  deny: SiteToolPolicyRef[];
};

function toStaged(policy: InstanceToolPolicyView): StagedPolicy {
  return { mode: policy.mode, allow: [...policy.allow], deny: [...policy.deny] };
}

function policyJson(staged: StagedPolicy): string {
  return JSON.stringify(staged);
}

export type WordPressSiteToolsCardProps = {
  instanceId: string;
  instanceName: string;
  /** `null` ⇒ the host does not expose the tool-policy settings seam. */
  policy: InstanceToolPolicyView | null;
  /** `null` ⇒ the host does not expose the server-enrollment surface. */
  servers: SiteServerHealthRow[] | null;
};

export function WordPressSiteToolsCard({
  instanceId,
  instanceName,
  policy,
  servers,
}: WordPressSiteToolsCardProps) {
  const [result, formAction] = useActionState<SetInstanceToolPolicyOutcome | null, FormData>(
    async (_prev, formData) => setWordPressInstanceToolPolicyAction(formData),
    null,
  );

  const [staged, setStaged] = useState<StagedPolicy | null>(policy ? toStaged(policy) : null);
  const [addServerId, setAddServerId] = useState(DEFAULT_CATALOG_SERVER_ID);
  const [addName, setAddName] = useState("");

  // Resync the staged editor whenever the PERSISTED policy round-trips
  // through the server (a save re-renders the page with the fresh record) —
  // the trusted-site card's collapse-on-round-trip idea, implemented as the
  // React adjust-state-during-render pattern (keyed on the serialized record,
  // since the `policy` prop is a fresh object identity every server render).
  const persistedKey = useMemo(() => (policy ? policyJson(toStaged(policy)) : "null"), [policy]);
  const [syncedKey, setSyncedKey] = useState(persistedKey);
  if (syncedKey !== persistedKey) {
    setSyncedKey(persistedKey);
    setStaged(policy ? toStaged(policy) : null);
  }

  const dirty = staged !== null && policy !== null && policyJson(staged) !== persistedKey;

  const summary: SiteConnectionBadge = !policy
    ? { variant: "secondary", label: "Unavailable" }
    : policy.mode === "open"
      ? { variant: "warning", label: "Open — all site tools" }
      : policy.allow.length === 0
        ? { variant: "warning", label: "No tools allowed" }
        : { variant: "secondary", label: `${policy.allow.length} allowed` };

  return (
    <div
      data-testid="site-tools-card"
      className="mt-4 rounded-panel border border-line bg-surface px-4 py-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-foreground">Site tools &amp; access</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Which of {instanceName}&apos;s own tools Cinatra may call, and whether the site&apos;s
            MCP servers are reachable. New and existing connections start with nothing allowed
            until you enable tools here.
          </p>
        </div>
        <div className="flex flex-none items-center gap-2">
          <Badge variant={summary.variant}>{summary.label}</Badge>
        </div>
      </div>

      {/* --- Discovered servers + health -------------------------------- */}
      <div data-testid="site-tools-servers" className="mt-4">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Discovered MCP servers
        </p>
        {servers === null ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Server health is not available on this Cinatra version.
          </p>
        ) : servers.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            No MCP servers discovered on this site yet.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {servers.map((row) => (
              <li
                key={row.serverId}
                data-testid="site-tools-server-row"
                className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-line px-3 py-2"
              >
                <span className="min-w-0">
                  <span className="block truncate font-mono text-xs text-foreground">
                    {row.label ?? row.serverId}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {row.source}
                    {row.serverVersion ? ` · v${row.serverVersion}` : ""}
                    {row.status !== "enrolled" ? ` · ${row.status.replace("_", " ")}` : ""}
                  </span>
                </span>
                <Badge
                  variant={
                    row.status !== "enrolled"
                      ? "secondary"
                      : row.lastStatus === "registered"
                        ? "success"
                        : row.lastStatus === null
                          ? "secondary"
                          : "warning"
                  }
                >
                  {row.status === "retired" ? "Retired" : healthLabel(row.lastStatus)}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* --- Per-pipeline readiness ------------------------------------- */}
      <div data-testid="site-tools-pipelines" className="mt-4">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Pipeline readiness
        </p>
        <ul className="mt-2 flex flex-col gap-2">
          {PIPELINE_REQUIREMENTS.map((pipeline) => {
            const readiness = evaluatePipelineReadiness(policy, servers, pipeline.refs);
            return (
              <li
                key={pipeline.key}
                data-testid={`site-tools-pipeline-${pipeline.key}`}
                className="rounded-card border border-line px-3 py-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-medium text-foreground">{pipeline.label}</span>
                  {readiness.state === "ready" ? (
                    <Badge variant="success">Ready</Badge>
                  ) : readiness.state === "policy_blocked" ? (
                    <Badge variant="warning">
                      Blocked — {readiness.missing.length}{" "}
                      {readiness.missing.length === 1 ? "tool" : "tools"} not allowed
                    </Badge>
                  ) : readiness.state === "server_unhealthy" ? (
                    <Badge variant="warning">{healthLabel(readiness.health)}</Badge>
                  ) : (
                    <Badge variant="secondary">Unknown</Badge>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">{pipeline.description}</p>
                {readiness.state === "policy_blocked" && policy ? (
                  // One-click fix: the FULL persisted record plus the missing
                  // refs appended to `allow` — a whole-record replace, so a
                  // concurrent edit is never half-applied. DISABLED while the
                  // selection editor below holds unsaved staged changes: this
                  // form submits the PERSISTED record, and its save round-trip
                  // resets the staged editor — firing it mid-edit would
                  // silently discard those staged edits (the editor's own
                  // disabled-until-valid Add/Save idiom, applied here too).
                  <form action={formAction} className="mt-2">
                    <Input type="hidden" name="instanceId" value={instanceId} />
                    <Input
                      type="hidden"
                      name="policy"
                      value={policyJson({
                        mode: policy.mode,
                        allow: [
                          ...policy.allow,
                          ...readiness.missing.filter(
                            (m) => !policy.allow.some((a) => refEquals(a, m)),
                          ),
                        ],
                        deny: policy.deny.filter(
                          (d) => !readiness.missing.some((m) => refEquals(m, d)),
                        ),
                      })}
                    />
                    <SubmitButton label="Allow required tools" disabled={dirty} />
                    {dirty ? (
                      <p
                        data-testid="site-tools-quick-fix-dirty"
                        className="mt-1 text-[11px] text-muted-foreground"
                      >
                        Save or discard your unsaved tool-selection changes below first.
                      </p>
                    ) : null}
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>

      {/* --- Tool selection (the write surface) ------------------------- */}
      <div data-testid="site-tools-selection" className="mt-4">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Tool selection
        </p>
        {!policy || !staged ? (
          <p data-testid="site-tools-selection-unavailable" className="mt-2 text-xs text-muted-foreground">
            Not available on this Cinatra version. Tool access for this site cannot be changed
            here until Cinatra is updated.
          </p>
        ) : (
          <>
            {/* A toggle-button GROUP (role="group" + aria-pressed), not a
                radiogroup: aria-pressed children are the button-toggle
                contract, while role="radiogroup" would promise role="radio" +
                aria-checked + roving-tabindex/arrow-key semantics these two
                buttons deliberately don't implement. One consistent contract,
                not a mixed one. */}
            <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Tool access mode">
              <Button
                type="button"
                variant={staged.mode === "restricted" ? "default" : "outline"}
                aria-pressed={staged.mode === "restricted"}
                onClick={() => setStaged({ ...staged, mode: "restricted" })}
              >
                Only selected tools
              </Button>
              <Button
                type="button"
                variant={staged.mode === "open" ? "default" : "outline"}
                aria-pressed={staged.mode === "open"}
                onClick={() => setStaged({ ...staged, mode: "open" })}
              >
                All site tools
              </Button>
            </div>
            {staged.mode === "open" ? (
              <p
                data-testid="site-tools-open-warning"
                className="mt-2 rounded-card border border-warning/30 bg-warning/5 px-3 py-2 text-xs leading-5 text-muted-foreground"
              >
                All tools the site advertises — including destructive ones — become callable
                (minus the deny list). Prefer selecting only what your pipelines need.
              </p>
            ) : null}

            {staged.mode === "restricted" ? (
              <div className="mt-3">
                {staged.allow.length === 0 ? (
                  <p data-testid="site-tools-empty-allow" className="text-xs text-muted-foreground">
                    No tools allowed yet — Cinatra cannot call anything on this site until you
                    add tools here or use a pipeline&apos;s &quot;Allow required tools&quot; above.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {staged.allow.map((ref) => (
                      <li
                        key={`${ref.serverId} ${ref.name}`}
                        data-testid="site-tools-allow-entry"
                        className="flex items-center justify-between gap-2 rounded-card border border-line px-3 py-1.5"
                      >
                        <span className="truncate font-mono text-xs text-foreground">
                          {ref.name}
                          {ref.serverId !== DEFAULT_CATALOG_SERVER_ID ? (
                            <span className="text-muted-foreground"> · {ref.serverId}</span>
                          ) : null}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() =>
                            setStaged({
                              ...staged,
                              allow: staged.allow.filter((r) => !refEquals(r, ref)),
                            })
                          }
                        >
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="mt-3 flex flex-wrap items-end gap-2">
                  <label className="flex min-w-0 flex-col gap-1 text-[11px] text-muted-foreground">
                    Tool name
                    <Input
                      value={addName}
                      onChange={(e) => setAddName(e.target.value)}
                      placeholder="ewpa/get-post"
                      className="w-56 max-w-full"
                    />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1 text-[11px] text-muted-foreground">
                    Server
                    <Input
                      value={addServerId}
                      onChange={(e) => setAddServerId(e.target.value)}
                      className="w-48 max-w-full"
                    />
                  </label>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!addName.trim() || !addServerId.trim()}
                    onClick={() => {
                      const ref = { serverId: addServerId.trim(), name: addName.trim() };
                      if (!staged.allow.some((r) => refEquals(r, ref))) {
                        setStaged({ ...staged, allow: [...staged.allow, ref] });
                      }
                      setAddName("");
                    }}
                  >
                    Add
                  </Button>
                </div>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  Tool names come from the site&apos;s own catalog (ask the assistant to list a
                  site&apos;s tools, or see the pipelines above for the ones Cinatra&apos;s own
                  features use). The default server is {DEFAULT_CATALOG_SERVER_ID}.
                </p>
              </div>
            ) : null}

            {staged.deny.length > 0 ? (
              <div className="mt-3" data-testid="site-tools-deny-list">
                <p className="text-[11px] font-semibold text-muted-foreground">
                  Denied (always blocked, even in &quot;All site tools&quot; mode)
                </p>
                <ul className="mt-1 flex flex-col gap-1.5">
                  {staged.deny.map((ref) => (
                    <li
                      key={`${ref.serverId} ${ref.name}`}
                      className="flex items-center justify-between gap-2 rounded-card border border-line px-3 py-1.5"
                    >
                      <span className="truncate font-mono text-xs text-foreground">
                        {ref.name}
                        {ref.serverId !== DEFAULT_CATALOG_SERVER_ID ? (
                          <span className="text-muted-foreground"> · {ref.serverId}</span>
                        ) : null}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() =>
                          setStaged({
                            ...staged,
                            deny: staged.deny.filter((r) => !refEquals(r, ref)),
                          })
                        }
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <form action={formAction} className="mt-3">
              <Input type="hidden" name="instanceId" value={instanceId} />
              <Input type="hidden" name="policy" value={policyJson(staged)} />
              <SubmitButton label="Save tool selection" disabled={!dirty} />
            </form>

            {policy.updatedAt ? (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Last changed {new Date(policy.updatedAt).toLocaleString()}
                {policy.updatedBy ? ` by ${policy.updatedBy}` : ""}.
              </p>
            ) : null}
          </>
        )}

        {result && !result.ok ? (
          <p data-testid="site-tools-error" role="alert" className="mt-3 text-xs text-destructive">
            {result.message}
          </p>
        ) : null}
        {result?.ok ? (
          <p data-testid="site-tools-saved" className="mt-3 text-xs text-muted-foreground">
            Tool selection saved.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function SubmitButton({ label, disabled }: { label: string; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" formNoValidate variant="outline" disabled={disabled || pending}>
      {pending ? "Saving…" : label}
    </Button>
  );
}
