import { defineConfig } from "vitest/config";

// Restrict discovery to the project's own test dir — transient agent
// worktrees under .claude/worktrees/ carry duplicate test files.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
