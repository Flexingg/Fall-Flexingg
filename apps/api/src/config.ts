import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  /** How this server reaches SparkyFitness (on Fly: the private address of its API). */
  SPARKY_URL: z.string().url().default('http://localhost:3004'),
  /** The SparkyFitness address people and phones use. Defaults to SPARKY_URL. */
  SPARKY_PUBLIC_URL: z.string().url().optional(),
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:5173'),
  EXTRA_ORIGINS: z.string().default(''),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ENCRYPTION_KEY: z.string().min(1, 'ENCRYPTION_KEY is required (openssl rand -base64 32)'),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('0.0.0.0'),
  SYNC_INTERVAL_MINUTES: z.coerce.number().min(0).default(15),
  /** Name of the API key Gauntlet creates in each user's SparkyFitness account. */
  SPARKY_KEY_NAME: z.string().default('Gauntlet'),
  LOG_LEVEL: z.string().default('info'),
  /** Directory of the built PWA to serve alongside the API (the Docker image sets this). */
  WEB_DIST: z.string().optional(),
  /** Directory holding the released APK and latest.json, served under /downloads. */
  DOWNLOADS_DIR: z.string().optional(),
  /** Release key SHA-256 fingerprint(s), comma separated, for Android App Links (invite links open the app). */
  ASSETLINKS_SHA256: z.string().default(''),
});

export type Config = Omit<z.infer<typeof envSchema>, 'SPARKY_PUBLIC_URL'> & {
  SPARKY_PUBLIC_URL: string;
  allowedOrigins: string[];
  encryptionKey: Buffer;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  const cfg = parsed.data;
  const encryptionKey = Buffer.from(cfg.ENCRYPTION_KEY, 'base64');
  if (encryptionKey.length !== 32)
    throw new Error('ENCRYPTION_KEY must be 32 bytes, base64 encoded');
  const allowedOrigins = [
    new URL(cfg.PUBLIC_WEB_URL).origin,
    ...cfg.EXTRA_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  ];
  const SPARKY_URL = cfg.SPARKY_URL.replace(/\/+$/, '');
  const SPARKY_PUBLIC_URL = (cfg.SPARKY_PUBLIC_URL ?? SPARKY_URL).replace(/\/+$/, '');
  return { ...cfg, SPARKY_URL, SPARKY_PUBLIC_URL, allowedOrigins, encryptionKey };
}
