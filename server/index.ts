import cors from "cors";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import "./db.js";
import { api } from "./routes.js";

const app = express();
const localNetworkOriginPattern = /^https?:\/\/(?:(?:localhost|127\.0\.0\.1)|(?:10(?:\.\d{1,3}){3})|(?:192\.168(?:\.\d{1,3}){2})|(?:172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}))(?::\d+)?$/i;

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (localNetworkOriginPattern.test(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin not allowed: ${origin}`));
    }
  })
);
app.use(express.json({ limit: "12mb" }));
app.use("/cache", express.static(config.cacheDir, { maxAge: "1h" }));
app.use("/api", api);

if (fs.existsSync(config.distDir)) {
  app.use(express.static(config.distDir));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(config.distDir, "index.html")));
} else {
  app.get("/", (_req, res) => {
    res.type("html").send(`
      <h1>Hui Music Radio API is running</h1>
      <p>Front-end build not found. Run <code>npm run dev:client</code> and open <a href="http://${config.VITE_HOST}:${config.VITE_PORT}">${config.VITE_HOST}:${config.VITE_PORT}</a>.</p>
    `);
  });
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  res.status(400).json({ error: message });
});

app.listen(config.PORT, config.HOST, () => {
  console.log(`Hui Music Radio listening on http://${config.HOST}:${config.PORT}`);
});
