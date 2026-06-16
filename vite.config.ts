/// <reference types="vitest/config" />
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import legacy from '@vitejs/plugin-legacy';

export default defineConfig(({ mode }) => {
  const isProfileMode = mode === 'profile';
  const isElectronMode = mode === 'electron';

  return {
    base: process.env.VITE_BASE_PATH ?? (isElectronMode ? './' : '/'),
    plugins: [
      react(),
      legacy({
        targets: ['Chrome >= 120', 'Firefox >= 120', 'Safari >= 17', 'Edge >= 120'],
        modernPolyfills: true,
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      proxy: {
        '/api': 'http://localhost:3000',
        '/uploads': 'http://localhost:3000',
      },
    },
    build: {
      sourcemap: isProfileMode,
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('phaser')) {
              return 'vendor-phaser';
            }
            if (
              id.includes('/node_modules/react/') ||
              id.includes('/node_modules/react-dom/') ||
              id.includes('/node_modules/scheduler/')
            ) {
              return 'vendor-react';
            }
            return undefined;
          },
        },
      },
    },
    test: {
      include: ['tests/**/*.test.{ts,tsx}'],
      environment: 'jsdom',
      globals: true,
      setupFiles: ['vitest.setup.ts'],
    },
  };
});
