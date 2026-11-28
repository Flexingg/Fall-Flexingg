import { z } from 'zod';

/**
 * The phone's "I read every night of this range" note (POST /api/ingest/health-connect/sleep-days),
 * sent after all of a read's batches went through. SparkyFitness never forgets a night on its own,
 * so a night deleted in Health Connect is only removed when the phone says the whole range was read
 * and lists the nights it still has. Never sent when the sleep read failed or wasn't allowed.
 */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const MAX_DAYS = 400;
const span = (from: string, to: string) =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

export const sleepDaysSchema = z
  .object({
    from: day,
    to: day,
    /** Every night (local day it ended on) that was sent for this range. */
    dates: z.array(day).max(MAX_DAYS + 1),
  })
  .refine((v) => span(v.from, v.to) >= 0 && span(v.from, v.to) <= MAX_DAYS, {
    message: 'Range must run forwards and cover at most 400 days',
  })
  .refine((v) => v.dates.every((d) => d >= v.from && d <= v.to), {
    message: 'Every night must fall inside the range',
  });
export type SleepDaysBody = z.infer<typeof sleepDaysSchema>;
