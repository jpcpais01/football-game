import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 900,
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      manifest: {
        name: 'GameNight',
        short_name: 'GameNight',
        description: 'A football game that feels real.',
        theme_color: '#14123a',
        background_color: '#14123a',
        id: '/',
        // Standalone, like PokeGen: a WebAPK installed as fullscreen + landscape would not
        // launch at all on a Xiaomi 17 (HyperOS). Landscape alone is kept so the home
        // screen opens sideways; the game goes fullscreen itself (enterFullscreen in main.ts).
        // If installs stop launching again, drop the orientation too.
        display: 'standalone',
        orientation: 'landscape',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest,woff2,mp3}'],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
