import { defineConfig } from 'vitest/config';

// Vitest's defaults already skip node_modules, dist and .git. Claude Code's
// worktrees live under .claude/worktrees/ INSIDE the checkout, and without
// this exclusion every test file is discovered twice.
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/.claude/**'],
  },
});
