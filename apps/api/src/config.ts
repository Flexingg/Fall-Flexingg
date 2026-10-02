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
  /** Requests allowed per minute per address, across the whole API. */
  RATE_LIMIT_MAX: z.coerce.number().int().min(10).default(300),
  /** Password sign-ins allowed per minute per address. */
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  SYNC_INTERVAL_MINUTES: z.coerce.number().min(0).default(15),
  /** Name of the API key Gauntlet creates in each user's SparkyFitness account. */
  SPARKY_KEY_NAME: z.string().default('Gauntlet'),
  LOG_LEVEL: z.string().default('info'),
  /** Directory of the built PWA to serve alongside the API (the Docker image sets this). */
  WEB_DIST: z.string().optional(),
  /** Directory holding the released APK and latest.json, served under /downloads. */
  DOWNLOADS_DIR: z.string().optional(),
  /** OAuth app credentials for linking apps, registered once by whoever runs the server. */
  OAUTH_STRAVA_CLIENT_ID: z.string().optional(),
  OAUTH_STRAVA_CLIENT_SECRET: z.string().optional(),
  OAUTH_FITBIT_CLIENT_ID: z.string().optional(),
  OAUTH_FITBIT_CLIENT_SECRET: z.string().optional(),
  OAUTH_OURA_CLIENT_ID: z.string().optional(),
  OAUTH_OURA_CLIENT_SECRET: z.string().optional(),
  OAUTH_POLAR_CLIENT_ID: z.string().optional(),
  OAUTH_POLAR_CLIENT_SECRET: z.string().optional(),
  /** Comma-separated emails of server admins (can feature public challenges). */
  ADMIN_EMAILS: z.string().default(''),
  /** The built-in demo account ("Try the demo"), with sample data and no SparkyFitness behind it. */
  DEMO_ACCOUNT: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Where privacy and account-deletion requests go (shown on /privacy). Defaults to the first admin email. */
  CONTACT_EMAIL: z.string().default(''),
  /** Release key SHA-256 fingerprint(s), comma separated, for Android App Links (invite links open the app). */
  ASSETLINKS_SHA256: z.string().default(''),
});

export type Config = Omit<z.infer<typeof envSchema>, 'SPARKY_PUBLIC_URL'> & {
  SPARKY_PUBLIC_URL: string;
  /** Provider -> OAuth app credentials, only those that are fully set. */
  oauthApps: Partial<
    Record<'strava' | 'fitbit' | 'oura' | 'polar', { clientId: string; clientSecret: string }>
  >;
  allowedOrigins: string[];
  encryptionKey: Buffer;
  adminEmails: Set<string>;
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
  const oauthApps: Config['oauthApps'] = {};
  for (const id of ['strava', 'fitbit', 'oura', 'polar'] as const) {
    const up = id.toUpperCase();
    const clientId = (env[`OAUTH_${up}_CLIENT_ID`] ?? '').trim();
    const clientSecret = (env[`OAUTH_${up}_CLIENT_SECRET`] ?? '').trim();
    if (clientId && clientSecret) oauthApps[id] = { clientId, clientSecret };
  }
  const adminEmails = new Set(
    cfg.ADMIN_EMAILS.split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
  return {
    ...cfg,
    SPARKY_URL,
    SPARKY_PUBLIC_URL,
    oauthApps,
    allowedOrigins,
    encryptionKey,
    adminEmails,
  };
}
