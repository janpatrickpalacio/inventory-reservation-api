import { z } from 'zod';

// Environment variables are read and checked once, when the server starts.
// If one is missing or wrong, the server stops with the variable NAME (never its value).
const envSchema = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  RESERVATION_TTL_SECONDS: z.coerce.number().int().min(1).max(86_400).default(600),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const names = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
  throw new Error(`Missing or invalid environment variables: ${names}. See .env.example.`);
}

export const config = {
  supabaseUrl: parsed.data.SUPABASE_URL,
  supabaseSecretKey: parsed.data.SUPABASE_SECRET_KEY,
  reservationTtlSeconds: parsed.data.RESERVATION_TTL_SECONDS,
  port: parsed.data.PORT,
};
