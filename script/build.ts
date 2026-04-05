import { build } from "esbuild";
import { copyFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const _require  = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = join(__dirname, "..");

// ── اقرأ كل dependencies من package.json ─────────────────────
const pkg      = _require(join(root, "package.json"));
const allDeps  = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });

console.log("📦 Building server...");

await build({
  entryPoints: [join(root, "server/index.ts")],
  bundle:      true,
  platform:    "node",
  target:      "node20",
  format:      "cjs",
  outfile:     join(root, "dist/index.cjs"),

  // ── @shared/* alias ──────────────────────────
  alias: { "@shared": resolve(root, "shared") },

  // ── External: كل npm packages + node built-ins ──
  // نحزم فقط source code المحلي — الـ npm packages تبقى في node_modules
  external: [
    // كل npm dependencies (لا نحزمهم — يُحمَّلون من node_modules)
    ...allDeps,
    // node built-ins
    "path", "fs", "http", "https", "crypto", "os", "util",
    "stream", "events", "buffer", "url", "querystring",
    "child_process", "net", "tls", "dns", "assert", "zlib",
    // native addons
    "pg-native", "bufferutil", "utf-8-validate",
  ],

  logLevel: "info",
});

// ── نسخ dashboard.html إلى dist/ ─────────────
const dashSrc = join(root, "server/dashboard.html");
const dashDst = join(root, "dist/dashboard.html");
mkdirSync(join(root, "dist"), { recursive: true });
if (existsSync(dashSrc)) {
  copyFileSync(dashSrc, dashDst);
  console.log("✅ dashboard.html → dist/");
}

console.log("✅ Build complete → dist/index.cjs");
