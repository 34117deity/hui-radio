import cors from "cors";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import "./db.js";
import { api } from "./routes.js";

const app = express();

app.use(cors({ origin: ["http://127.0.0.1:5173", "http://localhost:5173", `http://127.0.0.1:${config.PORT}`] }));
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
      <p>Front-end build not found. Run <code>npm run dev:client</code> and open <a href="http://127.0.0.1:5173">127.0.0.1:5173</a>.</p>
    `);
  });
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  res.status(400).json({ error: message });
});

app.listen(config.PORT, "127.0.0.1", () => {
  console.log(`Hui Music Radio listening on http://127.0.0.1:${config.PORT}`);
});
