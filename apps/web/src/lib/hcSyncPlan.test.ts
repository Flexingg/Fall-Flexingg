import { describe, expect, it } from 'vitest';
import {
  FULL_EVERY_MS,
  LIGHT_DAYS,
  nextState,
  ORIGINS_FULL_EVERY_MS,
  planSync,
  RESUME_MIN_GAP_MS,
  resumeDue,
  SEND_ALL_EVERY_MS,
} from './hcSyncPlan';
import { FIRST_SYNC_DAYS, RESEND_DAYS } from './healthRecords';

const NOW = 1_800_000_000_000;
const H = 3_600_000;

describe('resumeDue', () => {
  it('waits a few minutes after the last sync', () => {
    expect(resumeDue(NOW, NOW - RESUME_MIN_GAP_MS + 1)).toBe(false);
    expect(resumeDue(NOW, NOW - RESUME_MIN_GAP_MS)).toBe(true);
  });
  it('runs when there was never one, or the clock went backwards', () => {
    expect(resumeDue(NOW, null)).toBe(true);
    expect(resumeDue(NOW, undefined)).toBe(true);
    expect(resumeDue(NOW, NOW + H)).toBe(true);
  });
});

describe('planSync', () => {
  it('reads and sends everything the first time', () => {
    expect(planSync({ now: NOW, state: {} })).toEqual({
      kind: 'first',
      days: FIRST_SYNC_DAYS,
      sendAll: true,
      originsFull: true,
    });
  });
  it('an explicit range is a full read and send', () => {
    const p = planSync({ now: NOW, state: { lastFull: NOW - 1 }, days: 30 });
    expect(p).toMatchObject({ kind: 'first', days: 30, sendAll: true, originsFull: true });
  });
  it('is light (yesterday and today) soon after a full read', () => {
    const p = planSync({ now: NOW, state: { lastFull: NOW - FULL_EVERY_MS + 1 } });
    expect(p).toEqual({ kind: 'light', days: LIGHT_DAYS, sendAll: false, originsFull: false });
  });
  it('re-reads the week once the last full read is old enough', () => {
    const p = planSync({
      now: NOW,
      state: { lastFull: NOW - FULL_EVERY_MS, lastOriginsFull: NOW - H, lastSendAll: NOW - H },
    });
    expect(p).toEqual({ kind: 'full', days: RESEND_DAYS, sendAll: false, originsFull: false });
  });
  it('sends everything and re-reads origins about once a day', () => {
    const p = planSync({
      now: NOW,
      state: {
        lastFull: NOW - FULL_EVERY_MS,
        lastOriginsFull: NOW - ORIGINS_FULL_EVERY_MS,
        lastSendAll: NOW - SEND_ALL_EVERY_MS,
      },
    });
    expect(p).toMatchObject({ kind: 'full', sendAll: true, originsFull: true });
  });
  it('a sleep edit made right after a full read is picked up within 6 hours', () => {
    let state = nextState({}, planSync({ now: NOW, state: {} }), NOW);
    for (let h = 1; h < 6; h++) expect(planSync({ now: NOW + h * H, state }).kind).toBe('light');
    expect(planSync({ now: NOW + 6 * H, state }).kind).toBe('full');
  });
});

describe('nextState', () => {
  it('a light sync changes nothing', () => {
    const prev = { lastFull: 1, lastOriginsFull: 2, lastSendAll: 3 };
    const plan = planSync({ now: NOW, state: { lastFull: NOW } });
    expect(nextState(prev, plan, NOW)).toBe(prev);
  });
  it('a full one without send-all or origins keeps those marks', () => {
    const prev = { lastFull: 1, lastOriginsFull: 2, lastSendAll: 3 };
    const next = nextState(
      prev,
      { kind: 'full', days: 7, sendAll: false, originsFull: false },
      NOW,
    );
    expect(next).toEqual({ lastFull: NOW, lastOriginsFull: 2, lastSendAll: 3 });
  });
  it('a first one sets all three', () => {
    expect(nextState({}, planSync({ now: NOW, state: {} }), NOW)).toEqual({
      lastFull: NOW,
      lastOriginsFull: NOW,
      lastSendAll: NOW,
    });
  });
});
