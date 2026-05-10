import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const viteHost = (process.env.VITE_HOST || "127.0.0.1").trim();
const vitePort = Number(process.env.VITE_PORT || "5173");
const apiPort = Number(process.env.PORT || "9008");

export default defineConfig({
  plugins: [react()],
  server: {
    host: viteHost,
    port: vitePort,
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
      "/cache": `http://127.0.0.1:${apiPort}`
    }
  },
  preview: {
    host: viteHost,
    port: vitePort
  }
});
