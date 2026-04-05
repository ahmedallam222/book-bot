import express from "express";
import { createServer } from "http";
import { registerRoutes } from "./routes";

export function log(message: string, source = "server") {
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`[${time}] [${source}] ${message}`);
}

export { storage } from "./storage";

const app = express();
app.use(express.json());
const server = createServer(app);

(async () => {
  try {
    await registerRoutes(server, app);
    const PORT = parseInt(process.env.PORT || "5000", 10);
    server.listen(PORT, "0.0.0.0", () => {
      log(`🚀 Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error("❌ Failed to start:", err);
    process.exit(1);
  }
})();
