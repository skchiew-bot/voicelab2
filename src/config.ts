import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  VOICELAB_SECRET_KEY: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  // The address providers use to reach this server, e.g. https://voicelab.example.com. Needed for calls.
  PUBLIC_BASE_URL: z.string().url().optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Missing or invalid settings: ${missing}. See .env.example.`);
  }
  return parsed.data;
}
