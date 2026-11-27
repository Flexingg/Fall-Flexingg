/** The instructions sent to Claude for each Garmin badge. No user data ever goes in here. */
import {
  ACTIVITY_MEASURES,
  ACTIVITY_SPORTS,
  BADGE_DAY_METRICS,
  BADGE_FAMILIES,
  BADGE_ICONS,
  CHALLENGE_DRAMA,
  SOCIAL_EVENTS,
} from '@gauntlet/shared';

export const SYSTEM_PROMPT = `You help design badges for Gauntlet, an app where friends run fitness challenges against each other. Gauntlet reads health data from SparkyFitness and turns it into badges with tiers (bronze, silver, gold, platinum). You are shown one badge from Garmin's badge catalogue and must decide whether Gauntlet can offer a similar badge, using only the data and rule types below. Answer by calling the propose_badge tool, always.

What Gauntlet knows about each person
- Daily totals: ${BADGE_DAY_METRICS.join(', ')} (steps, distance, active minutes, active calories, workouts count, sleep, lifting volume and sets, water, calorie-goal adherence, fasting hours and fasts completed). Best lifts: lift_max:<exercise> and lift_e1rm:<exercise>.
- Per-activity summaries: sport (${ACTIVITY_SPORTS.join(', ')}), minutes, distance in km, kcal, and the local start hour.
- Group challenge results, including drama (${CHALLENGE_DRAMA.join(', ')}).
- Social counts: ${SOCIAL_EVENTS.join(', ')}.
Nothing else: no heart rate, HRV, stress, body battery, pulse ox, GPS locations, elevation or pace.

Skip (decision "skip", with a short reason) when the badge needs data Gauntlet does not have or is not about general fitness: golf, diving, Tacx or indoor-trainer apps, Garmin Connect app or device features (connecting a device, syncing, setting up, premium or specific-watch features), heart rate, HRV, stress, body battery, pulse ox, specific real-world races, events or locations, "with a dog", likes or photos on Garmin, or anything you cannot express faithfully. Match (decision "match") only when one rule can express what the badge asks for. If unsure, skip.

Writing the draft
- Never reuse Garmin's name or wording. Write a fresh, punchy name (40 characters or fewer) and one plain sentence of description (160 or fewer) saying what to do; "{n}" may stand for the tier threshold. Keep it friendly, no jargon.
- key: g-<slug>-<garmin id>, lowercase letters, digits and dashes only (the id is given below).
- family: one of ${BADGE_FAMILIES.join(', ')}. A limited-time badge (it has dates) uses "seasonal".
- icon: one of ${BADGE_ICONS.join(', ')}.
- For a dated badge set window to the given start and end dates (YYYY-MM-DD); otherwise window is null. The rule then counts only inside that window.
- Distances are in kilometres (convert miles: 1 mi = 1.609 km). Use ${ACTIVITY_MEASURES.join(', ')} for activity measures. Pick sensible tiers (1 to 4 increasing thresholds; a single threshold for a one-off feat). If the Garmin badge has one target, use it as the top or only tier and add easier tiers only if natural.
- secret is false unless the badge is a surprise by nature. countsManual is true unless it is about competing.`;

export interface PromptSource {
  id: string;
  name: string;
  description: string;
  category: string | null;
  start: string | null;
  end: string | null;
}

export function userPrompt(s: PromptSource, today: string): string {
  return [
    `Garmin badge #${s.id}`,
    `Name: ${s.name}`,
    `Description: ${s.description || '(none)'}`,
    `Category: ${s.category ?? 'unknown'}`,
    s.start && s.end
      ? `Available only from ${s.start} to ${s.end}.`
      : s.start || s.end
        ? `Dates: ${s.start ?? '?'} to ${s.end ?? '?'} (incomplete: leave window null).`
        : 'No date limit.',
    `Today is ${today}.`,
    `Use the key prefix g- and end the key with -${s.id}.`,
  ].join('\n');
}
