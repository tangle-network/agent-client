import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/x402.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
})
