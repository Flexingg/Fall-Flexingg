/**
 * Linking apps and devices (Garmin, Strava, Fitbit, ...) through SparkyFitness. SparkyFitness does
 * the real work (sign-in, tokens, syncing, storing the data); this is the shared logic that both the
 * Gauntlet API and the Android app's direct mode use to drive it with a person's own API key.
 */
import {
  addDays,
  type ConnectKind,
  type ConnectionInfo,
  type ConnectResult,
  type ProviderId,
  PROVIDER_IDS,
  todayIn,
} from '@gauntlet/shared';
import { SparkyClient, SparkyError, type SparkyProvider } from './client.js';
import { describeGarminError } from './garmin.js';

interface Spec {
  id: ProviderId;
  label: string;
  blurb: string;
  kind: ConnectKind;
  /** SparkyFitness's provider_type. */
  type: string;
  /** /api/integrations/<route>; null where SparkyFitness has none (Garmin has its own below). */
  route: string | null;
  /** OAuth: the key under which the authorize response carries the URL. */
  authKey?: 'url' | 'authUrl';
  /** OAuth providers that sign in with a client id/secret the operator registers once. */
  needsClientCredentials?: boolean;
  /** Where the OAuth result comes back to (SparkyFitness redirects here on its own address). */
  callbackNeedsState?: boolean;
}

export const SPECS: Record<ProviderId, Spec> = {
  garmin: {
    id: 'garmin',
    label: 'Garmin Connect',
    blurb: 'Steps, workouts, sleep and heart rate from your watch',
    kind: 'login',
    type: 'garmin',
    route: 'garmin',
  },
  strava: {
    id: 'strava',
    label: 'Strava',
    blurb: 'Runs, rides and other activities',
    kind: 'oauth',
    type: 'strava',
    route: 'strava',
    authKey: 'url',
    needsClientCredentials: true,
  },
  fitbit: {
    id: 'fitbit',
    label: 'Fitbit',
    blurb: 'Steps, activity, sleep and heart rate',
    kind: 'oauth',
    type: 'fitbit',
    route: 'fitbit',
    authKey: 'authUrl',
    needsClientCredentials: true,
  },
  oura: {
    id: 'oura',
    label: 'Oura Ring',
    blurb: 'Sleep, readiness, activity and heart rate',
    kind: 'oauth',
    type: 'oura',
    route: 'oura',
    authKey: 'authUrl',
    needsClientCredentials: true,
  },
  polar: {
    id: 'polar',
    label: 'Polar Flow',
    blurb: 'Workouts, sleep and daily activity',
    kind: 'oauth',
    type: 'polar',
    route: 'polar',
    authKey: 'authUrl',
    needsClientCredentials: true,
    callbackNeedsState: true,
  },
  coros: {
    id: 'coros',
    label: 'COROS',
    blurb: 'Workouts and training data',
    kind: 'oauth',
    type: 'coros_mcp',
    route: 'coros',
    authKey: 'authUrl',
    callbackNeedsState: true,
  },
  hevy: {
    id: 'hevy',
    label: 'Hevy',
    blurb: 'Gym workouts. Needs a Hevy API key (Hevy Pro).',
    kind: 'api_key',
    type: 'hevy',
    route: 'hevy',
  },
  liftosaur: {
    id: 'liftosaur',
    label: 'Liftosaur',
    blurb: 'Lifting workouts. Needs a Liftosaur API key.',
    kind: 'api_key',
    type: 'liftosaur',
    route: 'liftosaur',
  },
  wger: {
    id: 'wger',
    label: 'wger',
    blurb: 'Exercise library for logging workouts in SparkyFitness. Does not import activity.',
    kind: 'library',
    type: 'wger',
    route: null,
  },
};

export const specFor = (id: ProviderId) => SPECS[id];

export interface ConnectionsEnv {
  /** The person's SparkyFitness address (for "finish in SparkyFitness" links). */
  sparkyUrl: string;
  /** Can this caller finish an OAuth sign-in? True with a Gauntlet server, false from the phone alone. */
  oauthAvailable: boolean;
  /** Client id/secret the operator registered per OAuth provider. */
  oauth: Partial<Record<ProviderId, { clientId: string; clientSecret: string }>>;
  now?: () => Date;
}

export class ConnectionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ConnectionError';
  }
}

const providerFor = (providers: SparkyProvider[], spec: Spec) =>
  providers.find((p) => p.provider_type === spec.type);

function oauthConfigured(spec: Spec, env: ConnectionsEnv): boolean {
  return !spec.needsClientCredentials || !!env.oauth[spec.id]?.clientId;
}

/** All nine, with where each stands. One request for the provider list, then Garmin's own status. */
export async function listConnections(
  client: SparkyClient,
  token: string,
  env: ConnectionsEnv,
): Promise<ConnectionInfo[]> {
  const [providers, garmin] = await Promise.all([
    client.providers(token),
    client.garminStatus(token).catch(() => null),
  ]);
  return PROVIDER_IDS.map((id) => {
    const spec = SPECS[id];
    const rec = providerFor(providers, spec);
    const base = {
      id,
      label: spec.label,
      blurb: spec.blurb,
      kind: spec.kind,
      settingsUrl: `${env.sparkyUrl}/settings?section=integrations`,
    };
    if (id === 'garmin') {
      return {
        ...base,
        state: garmin?.linked ? 'connected' : 'disconnected',
        note: null,
        lastSyncAt: rec?.last_sync_at ?? null,
        settingsUrl: null,
      } satisfies ConnectionInfo;
    }
    if (spec.kind === 'oauth') {
      if (!env.oauthAvailable)
        return {
          ...base,
          state: 'unavailable',
          note: 'Finish this one in SparkyFitness, or connect a Gauntlet server.',
          lastSyncAt: rec?.last_sync_at ?? null,
        } satisfies ConnectionInfo;
      if (!oauthConfigured(spec, env))
        return {
          ...base,
          state: 'unavailable',
          note: `Not set up on this server yet. The server owner needs to add ${spec.label} app keys.`,
          lastSyncAt: null,
          settingsUrl: null,
        } satisfies ConnectionInfo;
      return {
        ...base,
        state: rec?.is_active && rec.has_token ? 'connected' : 'disconnected',
        note: null,
        lastSyncAt: rec?.last_sync_at ?? null,
        settingsUrl: null,
      } satisfies ConnectionInfo;
    }
    return {
      ...base,
      state: rec?.is_active ? 'connected' : 'disconnected',
      note: null,
      lastSyncAt: rec?.last_sync_at ?? null,
      settingsUrl: null,
    } satisfies ConnectionInfo;
  });
}

/** Make a provider sync by itself every hour (SparkyFitness's scheduler skips "manual" ones). */
export async function keepSynced(client: SparkyClient, token: string, type: string) {
  try {
    const rec = (await client.providers(token)).find((p) => p.provider_type === type);
    if (rec && rec.sync_frequency !== 'hourly')
      await client.updateProvider(token, rec.id, { sync_frequency: 'hourly', is_active: true });
  } catch {
    /* the connection itself worked; an hourly schedule is a nicety */
  }
}

/** Turn a provider failure into something a person can act on. */
export function describeProviderError(id: ProviderId, err: unknown): ConnectionError | null {
  if (!(err instanceof SparkyError)) return null;
  const spec = SPECS[id];
  if (id === 'garmin') {
    const g = describeGarminError(err);
    return g ? new ConnectionError(g.message, g.code, g.status) : null;
  }
  const body = (err.body ?? {}) as { message?: unknown; error?: unknown; code?: unknown };
  const friendly = typeof body.message === 'string' ? body.message : '';
  const raw = `${friendly} ${typeof body.error === 'string' ? body.error : ''} ${err.message}`;

  if (err.status === 503 || /could not reach sparkyfitness/i.test(raw))
    return new ConnectionError(
      "Couldn't reach SparkyFitness. Try again in a moment.",
      'sparky_unreachable',
      502,
    );
  if (/invalid or expired authorization state|state/i.test(raw) && spec.kind === 'oauth')
    return new ConnectionError('That sign-in timed out. Start again.', 'provider_state', 400);
  if (
    body.code === 'COROS_REAUTH_REQUIRED' ||
    /re-?authori[sz]|authorize first|expired|no valid .* token|no .* access token/i.test(raw)
  )
    return new ConnectionError(`${spec.label} needs you to connect again.`, 'provider_reauth', 409);
  if (err.status === 401 || /invalid .*(api )?key|unauthori[sz]ed/i.test(raw))
    return new ConnectionError(
      spec.kind === 'api_key'
        ? `${spec.label} didn't accept that API key. Check it and try again.`
        : `${spec.label} didn't accept the sign-in. Try again.`,
      'provider_key',
      401,
    );
  if (/subscription/i.test(raw))
    return new ConnectionError(
      friendly || `${spec.label} needs an active subscription.`,
      'provider_subscription',
      403,
    );
  if (/invalid_grant|authorization code|code.*(invalid|expired)/i.test(raw))
    return new ConnectionError(
      'That sign-in link has expired. Start again.',
      'provider_state',
      400,
    );
  if (/certificate|econnrefused|enotfound|timed? ?out|network/i.test(raw))
    return new ConnectionError(
      `SparkyFitness couldn't reach ${spec.label}. Try again later.`,
      'provider_unreachable',
      502,
    );
  return new ConnectionError(
    `${spec.label} said: ${(friendly || err.message).slice(0, 200)}`,
    'provider_error',
    502,
  );
}

/** Wraps a SparkyFitness call so failures come out as ConnectionError. */
async function guard<T>(id: ProviderId, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw describeProviderError(id, err) ?? err;
  }
}

async function ensureRecord(
  client: SparkyClient,
  token: string,
  spec: Spec,
  env: ConnectionsEnv,
  extra: Record<string, unknown> = {},
): Promise<SparkyProvider> {
  const creds = env.oauth[spec.id];
  const fields: Record<string, unknown> = {
    is_active: true,
    sync_frequency: 'hourly',
    ...(spec.needsClientCredentials && creds
      ? { app_id: creds.clientId, app_key: creds.clientSecret }
      : {}),
    ...extra,
  };
  const existing = providerFor(await client.providers(token), spec);
  if (existing) return client.updateProvider(token, existing.id, fields);
  return client.createProvider(token, {
    provider_name: spec.label,
    provider_type: spec.type,
    ...fields,
  });
}

/**
 * Start connecting. API-key and library providers connect right away; OAuth providers answer with
 * the address of the provider's own sign-in page.
 */
export async function connectProvider(
  client: SparkyClient,
  token: string,
  id: ProviderId,
  env: ConnectionsEnv,
  input: { apiKey?: string } = {},
): Promise<ConnectResult> {
  const spec = SPECS[id];
  if (spec.kind === 'login')
    throw new ConnectionError('Garmin signs in with its own form.', 'bad_request', 400);

  if (spec.kind === 'oauth') {
    if (!env.oauthAvailable)
      throw new ConnectionError(
        'Connect this one in SparkyFitness, or add a Gauntlet server.',
        'oauth_unavailable',
        400,
      );
    if (!oauthConfigured(spec, env))
      throw new ConnectionError(
        `${spec.label} isn't set up on this server yet. The server owner needs to add ${spec.label} app keys.`,
        'oauth_not_configured',
        501,
      );
    return guard(id, async () => {
      await ensureRecord(client, token, spec, env);
      const res = await client.integration<Record<string, string>>(
        'GET',
        token,
        spec.route!,
        'authorize',
      );
      const url = res[spec.authKey ?? 'url'] ?? res.url ?? res.authUrl;
      if (!url) throw new SparkyError(`${spec.label} did not return a sign-in address`, 502, res);
      return { status: 'redirect', url } as const;
    });
  }

  if (spec.kind === 'api_key') {
    if (!input.apiKey) throw new ConnectionError('Paste your API key.', 'bad_request', 400);
    return guard(id, async () => {
      const rec = await ensureRecord(client, token, spec, env, { app_key: input.apiKey });
      try {
        // A short sync doubles as a key check: a wrong key comes back as an error right here.
        await client.integration('POST', token, spec.route!, 'sync', {
          body: {
            startDate: addDays(todayIn('UTC', env.now?.()), -7),
            endDate: todayIn('UTC', env.now?.()),
          },
          timeoutMs: 120_000,
        });
      } catch (err) {
        await client.deleteProvider(token, rec.id).catch(() => undefined);
        throw err;
      }
      return { status: 'connected' } as const;
    });
  }

  // library
  return guard(id, async () => {
    await ensureRecord(client, token, spec, env);
    return { status: 'connected' } as const;
  });
}

/** The provider sent the person back with a code: hand it to SparkyFitness to finish the link. */
export async function completeOAuth(
  client: SparkyClient,
  token: string,
  id: ProviderId,
  input: { code: string; state?: string },
): Promise<void> {
  const spec = SPECS[id];
  if (spec.kind !== 'oauth')
    throw new ConnectionError('That app does not sign in this way.', 'bad_request', 400);
  await guard(id, async () => {
    await client.integration('POST', token, spec.route!, 'callback', {
      body: { code: input.code, ...(input.state ? { state: input.state } : {}) },
    });
    await keepSynced(client, token, spec.type);
  });
}

/** Pull the last `days` days from the provider into SparkyFitness. Can take a minute. */
export async function syncProvider(
  client: SparkyClient,
  token: string,
  id: ProviderId,
  days: number,
  now: Date = new Date(),
): Promise<void> {
  const spec = SPECS[id];
  const end = todayIn('UTC', now);
  const start = addDays(end, -days);
  if (id === 'garmin') {
    await guard(id, () => client.garminSync(token, start, end));
    return;
  }
  if (!spec.route) return;
  await guard(id, () =>
    client.integration('POST', token, spec.route!, 'sync', {
      body: { startDate: start, endDate: end },
      timeoutMs: 240_000,
    }),
  );
}

export async function disconnectProvider(
  client: SparkyClient,
  token: string,
  id: ProviderId,
): Promise<void> {
  const spec = SPECS[id];
  await guard(id, async () => {
    if (id === 'garmin') {
      await client.garminUnlink(token).catch((err) => {
        if (!(err instanceof SparkyError && err.status === 400)) throw err;
      });
      return;
    }
    const rec = providerFor(await client.providers(token), spec);
    if (!rec) return;
    if (spec.kind === 'oauth' && spec.route) {
      // Clears the tokens but keeps the record, so connecting again is one tap.
      await client.integration('POST', token, spec.route, 'disconnect');
    } else {
      // Keys and switches: remove the record (and the key with it).
      await client.deleteProvider(token, rec.id);
    }
  });
}
