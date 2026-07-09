// @vitest-environment jsdom
/**
 * WordPressNangoConnectCard toast migration (wordpress-mcp-connector#59,
 * cinatra-ai/cinatra#1107 S11).
 *
 * The connect-card used to render an inline destructive banner from local
 * `errorMessage` state on a failed Nango authorization. That banner is now
 * deleted outright and every transient failure (validation, save failure,
 * Nango "error" event, session-open failure) routes through the canonical
 * `@cinatra-ai/sdk-ui/toast` wrapper instead — no flash params are involved,
 * this is a pure client-state → toast conversion.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type NangoEventHandler = (event: {
  type: "connect" | "error" | "close";
  payload?: { providerConfigKey?: string; connectionId?: string; errorMessage?: string };
}) => void | Promise<void>;

// vi.mock factories are hoisted above imports, so every value a factory
// closes over must itself be created inside vi.hoisted (a bare top-level
// const is not yet initialized when the hoisted factory runs).
const { toastError, routerPush, routerRefresh, openConnectUI, getCapturedOnEvent } = vi.hoisted(() => {
  let capturedOnEvent: NangoEventHandler | null = null;
  return {
    toastError: vi.fn(),
    routerPush: vi.fn(),
    routerRefresh: vi.fn(),
    getCapturedOnEvent: () => capturedOnEvent,
    openConnectUI: vi.fn((opts: { onEvent: NangoEventHandler }) => {
      capturedOnEvent = opts.onEvent;
      return { setSessionToken: vi.fn(), close: vi.fn() };
    }),
  };
});

vi.mock("@cinatra-ai/sdk-ui/toast", () => ({
  toast: {
    error: toastError,
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, refresh: routerRefresh }),
}));

vi.mock("@nangohq/frontend", () => ({
  default: class {
    openConnectUI = openConnectUI;
  },
}));

import { WordPressNangoConnectCard } from "../wordpress-nango-connect-card";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mountedRoots: Root[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = vi.fn(async (url: string) => {
    if (String(url).includes("/api/nango/connect/session")) {
      return {
        ok: true,
        json: async () => ({ sessionToken: "session-token" }),
      } as Response;
    }
    if (String(url).includes("/api/nango/connections/save")) {
      return { ok: true, json: async () => ({}) } as Response;
    }
    return { ok: false, json: async () => ({ error: "unexpected" }) } as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
});

async function render(container: HTMLDivElement) {
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      <WordPressNangoConnectCard
        connectionServiceReady
        nangoFrontendConfig={{ apiURL: "https://api.nango.dev" }}
      />,
    );
  });
  return root;
}

// React tracks the native input value setter to detect a real change; setting
// `.value` directly and dispatching a bare "input" event is invisible to it
// (React's synthetic change never fires), so go through the native setter
// descriptor the same way user-event / RTL's fireEvent does.
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  "value",
)!.set!;

function typeSiteUrl(container: HTMLDivElement, value: string) {
  const input = container.querySelector("input") as HTMLInputElement;
  act(() => {
    nativeInputValueSetter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

function clickConnect(container: HTMLDivElement) {
  const button = Array.from(container.querySelectorAll("button")).find((b) =>
    /connect site/i.test(b.textContent ?? ""),
  ) as HTMLButtonElement;
  return act(async () => {
    // `.click()` (not a raw dispatchEvent) so jsdom runs the full default-action
    // pipeline React's delegated listener expects.
    button.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("WordPressNangoConnectCard — flash-code-equivalent error path", () => {
  it("toasts (not banners) on the Nango connect 'error' event — codes-only flash-protocol adjacent, client-state path", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    await render(container);

    typeSiteUrl(container, "https://example.com");
    await clickConnect(container);

    expect(getCapturedOnEvent()).not.toBeNull();
    await act(async () => {
      await getCapturedOnEvent()!({
        type: "error",
        payload: { errorMessage: "redirect_uri mismatch" },
      });
    });

    expect(toastError).toHaveBeenCalledWith("redirect_uri mismatch");
  });

  it("falls back to a generic 'Authorization failed.' toast when the Nango error carries no message", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    await render(container);

    typeSiteUrl(container, "https://example.com");
    await clickConnect(container);

    await act(async () => {
      await getCapturedOnEvent()!({ type: "error", payload: {} });
    });

    expect(toastError).toHaveBeenCalledWith("Authorization failed.");
  });

  it("toasts the validation message instead of the deleted inline banner", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    await render(container);

    await clickConnect(container);

    expect(toastError).toHaveBeenCalledWith("Enter the WordPress site domain first.");
    expect(openConnectUI).not.toHaveBeenCalled();
  });
});

describe("WordPressNangoConnectCard — DOM render of the toast state", () => {
  it("renders no inline destructive banner element after a failed authorization", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    await render(container);

    typeSiteUrl(container, "https://example.com");
    await clickConnect(container);

    await act(async () => {
      await getCapturedOnEvent()!({
        type: "error",
        payload: { errorMessage: "Authorization failed." },
      });
    });

    expect(toastError).toHaveBeenCalledWith("Authorization failed.");
    // The legacy `errorMessage` banner markup is deleted outright — no
    // destructive-styled element should exist in the rendered card.
    expect(container.querySelector(".text-destructive")).toBeNull();
    expect(container.textContent).not.toContain("Authorization failed.");
  });

  it("renders no inline destructive banner on a connection-save failure", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).includes("/api/nango/connect/session")) {
        return { ok: true, json: async () => ({ sessionToken: "session-token" }) } as Response;
      }
      if (String(url).includes("/api/nango/connections/save")) {
        return { ok: false, json: async () => ({ error: "Unable to save the WordPress connection." }) } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const container = document.createElement("div");
    document.body.appendChild(container);
    await render(container);

    typeSiteUrl(container, "https://example.com");
    await clickConnect(container);

    await act(async () => {
      await getCapturedOnEvent()!({
        type: "connect",
        payload: { providerConfigKey: "wordpress", connectionId: "conn_1" },
      });
      await Promise.resolve();
    });

    expect(toastError).toHaveBeenCalledWith("Unable to save the WordPress connection.");
    expect(container.querySelector(".text-destructive")).toBeNull();
  });
});
