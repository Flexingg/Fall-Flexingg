import { SparkyError } from './client.js';

export type GarminErrorCode =
  | 'garmin_credentials'
  | 'garmin_mfa'
  | 'garmin_rate_limited'
  | 'garmin_unreachable'
  | 'garmin_error';

export interface GarminProblem {
  code: GarminErrorCode;
  /** What to show the person. */
  message: string;
  /** Suggested HTTP status for the Gauntlet API. */
  status: number;
}

/**
 * SparkyFitness wraps whatever its Garmin service said ("Failed to login to Garmin: Garmin
 * authentication failed: ..."). Turn that into a message a person can act on.
 */
export function describeGarminError(err: unknown): GarminProblem | null {
  if (!(err instanceof SparkyError)) return null;
  const text = err.message;
  // A plain 401/403 from SparkyFitness is about the API key, not about Garmin.
  if ((err.status === 401 || err.status === 403) && !/garmin/i.test(text)) return null;
  const detail = text
    .replace(/^Failed to (login to|sync) Garmin:\s*/i, '')
    .replace(/^Garmin /i, '');

  if (/invalid or expired mfa|mfa failed|client state/i.test(text))
    return {
      code: 'garmin_mfa',
      message: /expired/i.test(text)
        ? 'That sign-in timed out. Start again.'
        : "Garmin didn't accept that code. Check it and try again.",
      status: 400,
    };
  if (/rate limit|too many requests|\b429\b/i.test(text))
    return {
      code: 'garmin_rate_limited',
      message: 'Garmin is limiting sign-ins right now. Wait a few minutes and try again.',
      status: 429,
    };
  if (
    /authentication failed|invalid (credentials|email|password)|incorrect|unauthori[sz]ed|\b401\b/i.test(
      text,
    )
  )
    return {
      code: 'garmin_credentials',
      message: "Garmin didn't accept that email and password.",
      status: 401,
    };
  if (err.status === 503 || /could not reach sparkyfitness/i.test(text))
    return {
      code: 'garmin_unreachable',
      message: "Couldn't reach SparkyFitness. Try again in a moment.",
      status: 502,
    };
  if (/connection error|econnrefused|enotfound|timed out|timeout/i.test(text))
    return {
      code: 'garmin_unreachable',
      message: `SparkyFitness couldn't reach Garmin (${detail.slice(0, 160)}). Try again later.`,
      status: 502,
    };
  return {
    code: 'garmin_error',
    message: `Garmin said: ${detail.slice(0, 200)}`,
    status: 502,
  };
}
