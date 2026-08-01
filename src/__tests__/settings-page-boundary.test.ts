/**
 * connector-setup-tabs (wordpress-mcp-connector#70): boundary-respect pin.
 * Plain node-environment source check (mirrors the established
 * `setup-page-review.test.ts` pattern in sibling connector repos) — asserts
 * the settings page consumes the SHARED `@cinatra-ai/sdk-ui/tabs` primitive
 * rather than a locally vendored copy.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(
  fileURLToPath(new URL("../settings-page.tsx", import.meta.url)),
  "utf8",
);
const cardSrc = readFileSync(
  fileURLToPath(new URL("../wordpress-site-tools-card.tsx", import.meta.url)),
  "utf8",
);
const healthSrc = readFileSync(
  fileURLToPath(new URL("../wordpress-site-tools-health.ts", import.meta.url)),
  "utf8",
);

/**
 * SCOPE OF THIS PIN. These are source-TEXT checks, not an AST analysis, kept
 * dependency-free like the sibling checks above. They are sized to catch the
 * regression that actually took the tab down — a server module importing a
 * callable out of a `"use client"` module — and every shape near it. They do
 * NOT claim to be exhaustive: a `await import()` of the client module, an
 * import laundered through a third re-exporting module, or import-shaped text
 * inside a comment or string can still slip past. Reach for a real parser if
 * this file ever has to carry more weight than that.
 */

/** ECMAScript line terminators — `\n` alone is not enough to end a `//`. */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

/**
 * The module's leading directive (`"use client"` / `"use server"`), or null.
 * Skips a hashbang plus leading comments and blank lines: a directive stays a
 * directive when it sits under a file-header comment block, so a naive
 * "starts with" check would silently pass a module that had one added below
 * its header.
 */
function leadingDirective(source: string): string | null {
  const endOfLine = (from: number): number => {
    const rest = source.slice(from);
    const m = LINE_TERMINATOR.exec(rest);
    return m ? from + m.index + 1 : -1;
  };
  let i = source.startsWith("#!") ? endOfLine(0) : 0;
  if (i === -1) return null;
  for (;;) {
    while (i < source.length && /\s/.test(source[i])) i += 1;
    if (source.startsWith("//", i)) {
      i = endOfLine(i);
      if (i === -1) return null;
    } else if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i);
      if (end === -1) return null;
      i = end + 2;
    } else break;
  }
  return /^(["'])(use [a-z]+)\1\s*;?/.exec(source.slice(i))?.[2] ?? null;
}

type ImportClause = {
  /** `import type { … }` — erased at runtime, so never a client reference. */
  typeOnly: boolean;
  /** Bindings that survive to RUNTIME (inline `type` specifiers excluded). */
  named: string[];
  /** `import * as ns from …` — pulls EVERY export, callables included. */
  namespace: boolean;
  /** `import Default from …` */
  hasDefault: boolean;
};

/** Every import statement in `source` that targets `specifier`. */
function importsOf(source: string, specifier: string): ImportClause[] {
  // `\s*` not `\s+`: `import{x}from"y"` and `import/**/{x}from"y"` are valid.
  const re = new RegExp(
    `\\bimport\\b\\s*([^;]*?)\\s*from\\s*["']${specifier}["']`,
    "g",
  );
  return [...source.matchAll(re)].map((m) => {
    let clause = m[1].trim();
    const typeOnly = /^type\b/.test(clause);
    if (typeOnly) clause = clause.replace(/^type\b/, "").trim();
    const namespace = /\*\s*as\s+\w+/.test(clause);
    const braced = /\{([^}]*)\}/.exec(clause);
    const named = (braced?.[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      // An inline `{ type X }` specifier is erased too — it can never be the
      // callable, and counting it would let a type import satisfy a
      // value-import assertion.
      .filter((s) => !/^type\s/.test(s))
      .map((s) => s.split(/\s+as\s+/)[0].trim());
    const hasDefault =
      clause
        .split("{")[0]
        .replace(/\*\s*as\s+\w+/, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(",", "")
        .trim().length > 0;
    return { typeOnly, named, namespace, hasDefault };
  });
}

describe("settings-page — boundary respect (connector-setup-tabs #70)", () => {
  it("imports the shared Tabs primitive from @cinatra-ai/sdk-ui/tabs — no local tabs copy", () => {
    expect(src).toContain('from "@cinatra-ai/sdk-ui/tabs"');
    expect(src).not.toMatch(/from ["']\.\/(components\/ui\/)?tabs["']/);
  });

  it("Help is declared last among the TabsTrigger values (source order pin)", () => {
    const triggerValues = [...src.matchAll(/<TabsTrigger value="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(triggerValues).toEqual(["setup", "connections", "help"]);
    expect(triggerValues.at(-1)).toBe("help");
  });
});

/**
 * RSC client-boundary pin (cinatra-ai/cinatra#2022 S7 follow-up).
 *
 * `settings-page.tsx` is a SERVER component and it CALLS the badge derivation
 * while rendering each connection header. Under React Server Components every
 * export of a `"use client"` module is a client REFERENCE, so importing that
 * helper from `wordpress-site-tools-card.tsx` threw at render and blanked the
 * whole Connections tab behind the error boundary — while `pnpm build` stayed
 * green. It is a runtime-only fault, which is exactly why it needs a source
 * pin: no amount of type/build checking catches it.
 */
describe("settings-page — RSC client boundary", () => {
  it("is a server component, and the site-tools card is a client module", () => {
    expect(leadingDirective(src)).toBeNull();
    expect(leadingDirective(cardSrc)).toBe("use client");
  });

  it("takes ONLY the component off the client card — never a callable", () => {
    const imports = importsOf(src, "\\./wordpress-site-tools-card");
    expect(imports).toHaveLength(1);
    const [clause] = imports;
    // A namespace or default import would pull the module's callables in
    // wholesale and defeat the named-import check below.
    expect(clause.namespace).toBe(false);
    expect(clause.hasDefault).toBe(false);
    // Rendering a client COMPONENT from a server component is legal RSC; it is
    // calling a client export as a plain function that throws. So the page may
    // take the component and nothing else.
    expect(clause.named).toEqual(["WordPressSiteToolsCard"]);
  });

  it("calls deriveSiteConnectionBadge as a VALUE from the directive-free health module", () => {
    expect(src).toMatch(/\bderiveSiteConnectionBadge\(/);
    // Must be a real value import: a type-only import would erase at runtime
    // and leave the call bound to something else entirely.
    const valueImports = importsOf(src, "\\./wordpress-site-tools-health")
      .filter((clause) => !clause.typeOnly)
      .flatMap((clause) => clause.named);
    expect(valueImports).toContain("deriveSiteConnectionBadge");
    // The shared module must stay directive-free, or the move bought nothing.
    expect(leadingDirective(healthSrc)).toBeNull();
  });

  it("keeps ONE canonical home for the derivation — the card must not re-export it", () => {
    // A re-export from the `"use client"` card would leave the original
    // footgun loaded: a future server importer could reach the callable
    // through the card again and reproduce the crash.
    expect(cardSrc).not.toMatch(/export\s*\{[^}]*deriveSiteConnectionBadge/);
    expect(cardSrc).not.toMatch(/export\s+function\s+deriveSiteConnectionBadge/);
  });
});
