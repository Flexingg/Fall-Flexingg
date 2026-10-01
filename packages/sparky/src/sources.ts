import type { SourcesResponse } from '@gauntlet/shared';
import type { SyncedSource } from './client.js';

const SOURCE_LABELS: Record<string, string> = {
  garmin: 'Garmin Connect',
  'health connect': 'Health Connect',
  health_connect: 'Health Connect',
  healthkit: 'Apple Health',
  'apple health': 'Apple Health',
  fitbit: 'Fitbit',
  strava: 'Strava',
  polar: 'Polar',
  oura: 'Oura',
  coros: 'COROS',
  withings: 'Withings',
  googlehealth: 'Google Health',
  hevy: 'Hevy',
};

/**
 * Turn SparkyFitness' synced-source list into the Data sources screen. It tags one provider several
 * ways ("health_connect", "Health Connect"), so entries are merged by their display name.
 */
export function describeSources(sparkyUrl: string, sources: SyncedSource[]): SourcesResponse {
  const byLabel = new Map<string, SourcesResponse['providers'][number]>();
  for (const s of sources) {
    const plain = s.source.replace(/[_-]+/g, ' ').trim();
    const label =
      SOURCE_LABELS[s.source.toLowerCase()] ??
      SOURCE_LABELS[plain.toLowerCase()] ??
      plain.charAt(0).toUpperCase() + plain.slice(1);
    const prev = byLabel.get(label);
    if (prev) prev.records += s.totalCount;
    else byLabel.set(label, { source: s.source, label, records: s.totalCount });
  }
  return {
    sparkyUrl,
    integrationsUrl: `${sparkyUrl}/settings?section=integrations`,
    providers: [...byLabel.values()].sort((a, b) => b.records - a.records),
  };
}
