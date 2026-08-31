import { z } from "zod";

// Fails fast on boot rather than surfacing confusing errors deep inside
// OAuth/GraphQL/queue code when a required secret is missing or malformed.
const envSchema = z.object({
  SHOPIFY_API_KEY: z.string().min(1, "SHOPIFY_API_KEY is required"),
  SHOPIFY_API_SECRET: z.string().min(1, "SHOPIFY_API_SECRET is required"),
  SCOPES: z.string().min(1, "SCOPES is required"),
  SHOPIFY_APP_URL: z.string().url("SHOPIFY_APP_URL must be a valid URL"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .length(64, "TOKEN_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)")
    .regex(/^[0-9a-f]+$/i, "TOKEN_ENCRYPTION_KEY must be hex-encoded"),
});

type Env = z.infer<typeof envSchema>;

let validated: Env | undefined;

export function env(): Env {
  if (!validated) {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
        .join("\n");
      throw new Error(
        `Invalid environment configuration. Copy .env.example to .env and fill in the missing values:\n${issues}`,
      );
    }
    validated = parsed.data;
  }
  return validated;
}
