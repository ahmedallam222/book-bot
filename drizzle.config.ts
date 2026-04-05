import { defineConfig } from "drizzle-kit";

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  // drizzle-kit push يحتاج DATABASE_URL — تأكد من ضبطها قبل npm run db:push
  console.warn("[drizzle.config] DATABASE_URL not set — db:push will fail");
}

export default defineConfig({
  out:     "./migrations",
  schema:  "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: dbUrl as string,   // ← type assertion: نحذّر أعلاه ونتابع
  },
});
