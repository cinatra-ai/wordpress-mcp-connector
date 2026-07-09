"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import NangoFrontend from "@nangohq/frontend";
import type { NangoFrontendConfig } from "@cinatra-ai/sdk-ui/marketplace";
import { toast } from "@cinatra-ai/sdk-ui/toast";
import { Button } from "./components/ui/button";
import { LinkIcon } from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./components/ui/input-group";

export function WordPressNangoConnectCard({
  nangoFrontendConfig,
  connectionServiceReady,
}: {
  nangoFrontendConfig?: NangoFrontendConfig;
  connectionServiceReady?: boolean;
}) {
  const router = useRouter();
  const [siteUrl, setSiteUrl] = useState("");
  const [pending, setPending] = useState(false);
  const ready = connectionServiceReady ?? Boolean(nangoFrontendConfig?.apiURL);

  async function handleConnect() {
    const normalizedSiteUrl = siteUrl.trim();
    if (pending) {
      return;
    }

    if (!ready) {
      router.push("/configuration/environment?tab=connections");
      return;
    }

    if (!normalizedSiteUrl) {
      toast.error("Enter the WordPress site domain first.");
      return;
    }

    setPending(true);

    try {
      const nangoFrontend = new NangoFrontend();
      const connect = nangoFrontend.openConnectUI({
        ...(nangoFrontendConfig?.baseURL ? { baseURL: nangoFrontendConfig.baseURL } : {}),
        ...(nangoFrontendConfig?.apiURL ? { apiURL: nangoFrontendConfig.apiURL } : {}),
        onEvent: async (event) => {
          if (event.type === "connect") {
            try {
              const response = await fetch("/api/nango/connections/save", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  connectorKey: "wordpress",
                  providerConfigKey: event.payload.providerConfigKey,
                  connectionId: event.payload.connectionId,
                  siteUrl: normalizedSiteUrl,
                }),
              });

              if (!response.ok) {
                const payload = (await response.json().catch(() => null)) as { error?: string } | null;
                throw new Error(payload?.error ?? "Unable to save the WordPress connection.");
              }

              setPending(false);
              setSiteUrl("");
              router.refresh();
            } catch (error) {
              setPending(false);
              toast.error(error instanceof Error ? error.message : "Unable to save the WordPress connection.");
            }
          }

          if (event.type === "error") {
            setPending(false);
            toast.error(event.payload.errorMessage || "Authorization failed.");
          }

          if (event.type === "close") {
            setPending(false);
          }
        },
      });

      const response = await fetch("/api/nango/connect/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          connectorKey: "wordpress",
        }),
      });
      const payload = (await response.json().catch(() => null)) as { sessionToken?: string; error?: string } | null;
      if (!response.ok || !payload?.sessionToken) {
        throw new Error(payload?.error ?? "Unable to start the connection flow.");
      }

      connect.setSessionToken(payload.sessionToken);
    } catch (error) {
      setPending(false);
      toast.error(error instanceof Error ? error.message : "Unable to open the connection flow.");
    }
  }

  return (
    <div className="mt-6 rounded-panel border border-line bg-surface px-5 py-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-lg font-semibold text-foreground">Connect site</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Enter your WordPress site domain, then provide the WordPress username and application password in the connection flow.
          </p>
        </div>
        <span className="badge rounded-full px-3 py-1 text-xs uppercase">Preferred</span>
      </div>

      <div className="mt-5 flex flex-wrap gap-3">
        <InputGroup className="min-w-[18rem] flex-1">
          <InputGroupAddon>
            <LinkIcon aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            type="url"
            value={siteUrl}
            onChange={(event) => setSiteUrl(event.target.value)}
            placeholder="https://example.com"
          />
        </InputGroup>
        <Button
          type="button"
          onClick={handleConnect}
          disabled={pending}
          className="rounded-control bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition hover:bg-surface-strong hover:text-foreground disabled:cursor-not-allowed disabled:opacity-70"
        >
          {pending ? "Opening connection..." : !ready ? "Configure connection service" : "Connect site"}
        </Button>
      </div>
    </div>
  );
}
