/**
 * The "where did this come from" sheet's data. A server answers GET /api/me/day/stat; direct mode
 * (Android without a Gauntlet server) builds the same answer on the phone.
 */
import type { StatSourceResponse } from '@gauntlet/shared';
import { useQuery } from '@tanstack/react-query';
import { get } from './api';
import { originFor } from './hcOrigins';
import { session } from './session';

export const statSourceKey = (date: string, metric: string) =>
  ['statSource', date, metric] as const;

export const useStatSource = (date: string, metric: string) =>
  useQuery({
    queryKey: statSourceKey(date, metric),
    queryFn: async (): Promise<StatSourceResponse> =>
      session.direct
        ? session.direct.statSource(date, metric, await originFor(date, metric))
        : get<StatSourceResponse>(
            `/api/me/day/stat?date=${encodeURIComponent(date)}&metric=${encodeURIComponent(metric)}`,
          ),
    staleTime: 15_000,
  });
