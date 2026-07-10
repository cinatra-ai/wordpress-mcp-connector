import { defineConfig } from "vitest/config";
import * as path from "node:path";

const repoRoot = path.join(__dirname, "../../..");
const serverOnlyStub = path.join(repoRoot, "tests/__stubs__/server-only.ts");

export default defineConfig({
  resolve: {
    alias: [
      { find: "server-only", replacement: serverOnlyStub },
      // @cinatra-ai/wordpress-mcp-connector/mcp-handlers — resolve to real source
      {
        find: "@cinatra-ai/wordpress-mcp-connector/mcp-handlers",
        replacement: path.join(__dirname, "src/mcp/handlers.ts"),
      },
      // @cinatra-ai/wordpress-mcp-connector/widget-chat-tool — resolve to real source (test in same package)
      {
        find: "@cinatra-ai/wordpress-mcp-connector/widget-chat-tool",
        replacement: path.join(__dirname, "src/widget-chat-tool.ts"),
      },
      // @/ → src/ (repo root src, same as the main app)
      { find: /^@\/(.+)$/, replacement: path.join(repoRoot, "src") + "/$1" },
    ],
  },
  test: {
    environment: "node",
    include: ["src/__tests__/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**"],
  },
});
