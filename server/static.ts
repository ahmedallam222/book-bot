import express, { type Express } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export function serveStatic(app: Express) {
  // FIX: import.meta.url مقبول في TypeScript ESM — esbuild يحوّله لـ __filename في CJS bundle
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const distPath  = path.resolve(__dirname, "public");

  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Build directory not found: ${distPath}. Run: npm run build`
    );
  }

  app.use(express.static(distPath));

  // SPA fallback
  app.use("/{*path}", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
