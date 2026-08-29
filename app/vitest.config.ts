import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

/**
 * Test config kept out of vite.config.ts so the build config does not import a
 * test runner. Everything about how the app is bundled is inherited.
 *
 * The suite renders real components rather than testing helpers in isolation. That
 * is deliberate: both bugs it was written for — an effect that aborted its own only
 * request under StrictMode, and a stale guard that suppressed a re-read — were
 * React lifecycle faults, invisible to any test of a pure function, and both
 * reached a live screen past a fully green Python suite.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      setupFiles: './src/test/setup.ts',
      globals: true,
      include: ['src/**/*.test.{ts,tsx}'],
    },
  }),
)
