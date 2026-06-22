/// <reference types="vitest/config" />
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import legacy from '@vitejs/plugin-legacy';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

function spriteManifestPlugin(): Plugin {
  const ASSETS_DIR = path.resolve(__dirname, 'public', 'assets');
  const MANIFEST_PATH = path.join(ASSETS_DIR, 'sprite-manifest.json');

  function generateManifest(): void {
    try {
      execSync('node scripts/generate-sprite-manifest.mjs', {
        cwd: __dirname,
        stdio: 'pipe',
      });
    } catch {
      // Non-fatal — the manifest script may not exist during initial setup
    }
  }

  return {
    name: 'sprite-manifest',
    configureServer(server) {
      generateManifest();
      server.watcher.add(path.join(ASSETS_DIR, '**', '*.svg'));
      server.watcher.on('add', (filePath) => {
        if (filePath.endsWith('.svg') && !filePath.includes('sprite-manifest')) {
          generateManifest();
        }
      });
      server.watcher.on('unlink', (filePath) => {
        if (filePath.endsWith('.svg') && !filePath.includes('sprite-manifest')) {
          generateManifest();
        }
      });
    },
    buildStart() {
      if (!fs.existsSync(MANIFEST_PATH)) {
        generateManifest();
      }
    },
  };
}

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
      spriteManifestPlugin(),
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
