import { z } from 'zod';

// Environment variables are read and checked once, when the server starts.
// If one is missing or wrong, the server stops with the variable NAME and the rule (never its value).
const envSchema = z.object({
  // The project URL, for example https://abcd1234.supabase.co. supabase-js adds /rest/v1 itself,
  // so a URL that already contains it would make every database call fail.
  SUPABASE_URL: z.url().refine((value) => !value.includes('/rest/v1'), {
    error: 'use the project URL without /rest/v1, for example https://abcd1234.supabase.co',
  }),
  SUPABASE_SECRET_KEY: z.string().min(1),
  RESERVATION_TTL_SECONDS: z.coerce.number().int().min(1).max(86_400).default(600),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')} (${issue.message})`).join('; ');
  throw new Error(`Missing or invalid environment variables: ${problems}. See .env.example.`);
}

export const config = {
  supabaseUrl: parsed.data.SUPABASE_URL,
  supabaseSecretKey: parsed.data.SUPABASE_SECRET_KEY,
  reservationTtlSeconds: parsed.data.RESERVATION_TTL_SECONDS,
  port: parsed.data.PORT,
};
