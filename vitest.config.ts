import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { randomBytes } from 'node:crypto'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Milestones add tests project by project; an empty project is not a failure.
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'core',
          environment: 'node',
          include: ['test/core/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'widget',
          environment: 'happy-dom',
          include: ['test/widget/**/*.test.ts'],
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations('./migrations'),
                SITE_KEK: randomBytes(32).toString('base64url'),
              },
            },
          }),
        ],
        test: { name: 'worker', include: ['test/worker/**/*.test.ts'], setupFiles: ['test/worker/setup.ts'] },
      },
    ],
  },
})
