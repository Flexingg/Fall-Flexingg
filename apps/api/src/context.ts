import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { SparkyClient } from '@gauntlet/sparky';

export interface AppContext {
  db: Db;
  cfg: Config;
  sparky: SparkyClient;
  log: FastifyBaseLogger;
  /** Overridable clock for tests. */
  now: () => Date;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Not found') => new HttpError(404, what, 'not_found');
export const forbidden = (what = 'Forbidden') => new HttpError(403, what, 'forbidden');
export const badRequest = (what: string, code = 'bad_request') => new HttpError(400, what, code);
