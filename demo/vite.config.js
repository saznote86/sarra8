import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
const local = (relative) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  base: './',
  server: { fs: { allow: [local('./'), local('../avatar-core'), local('../audio'), local('../sarra7.vrm'), local('../favicon.svg')] } },
  build: {
    rollupOptions: {
      output: {
        // Keep the stable 3D libraries cacheable across changes to the controls.
        manualChunks(id) {
          if (id.includes('/node_modules/three/build/')) return 'three-renderer';
          if (id.includes('/node_modules/three/') || id.includes('/node_modules/@pixiv/')) return 'vrm-loader';
        },
      },
    },
  },
});
