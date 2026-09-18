import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      electron: resolve(__dirname, 'tests/stubs/electron.ts')
    }
  }
})
