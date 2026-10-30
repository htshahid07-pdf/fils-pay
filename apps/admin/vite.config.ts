import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/v1': { target: 'http://localhost:3000', changeOrigin: true } },
    // apps/web already owns 5173.
    // 5174 clashes with storybook on my machine — am
    port: 5174,
  },
});
