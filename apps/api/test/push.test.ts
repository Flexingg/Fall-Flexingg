import type { DevicePollResponse, PushConfig } from '@gauntlet/shared';
import { eq } from 'drizzle-orm';
import webpush from 'web-push';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pushTargets } from '../src/db/schema.js';
import { sha256 } from '../src/crypto.js';
import { notify } from '../src/services/notify.js';
import { setWebPushSender, type WebPushSender } from '../src/services/push.js';
import { setup, type Harness } from './notifyHarness.js';

const keys = webpush.generateVAPIDKeys();
const sub = (n: string) => ({
  endpoint: `https://push.example.test/send/${n}`,
  keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` },
});

let h: Harness;
const sent: { endpoint: string; payload: Record<string, string>; ttl: number; subject: string }[] =
  [];
let failWith: Record<string, number> = {};

beforeAll(async () => {
  const sender: WebPushSender = async (s, payload, o) => {
    const status = failWith[s.endpoint];
    if (status) throw Object.assign(new Error('push failed'), { statusCode: status });
    sent.push({
      endpoint: s.endpoint,
      payload: JSON.parse(payload),
      ttl: o.TTL,
      subject: o.vapidDetails.subject,
    });
  };
  setWebPushSender(sender);
  h = await setup(['ann', 'ben'], {
    env: {
      VAPID_PUBLIC_KEY: keys.publicKey,
      VAPID_PRIVATE_KEY: keys.privateKey,
      VAPID_SUBJECT: 'mailto:admin@gauntlet.test',
    },
  });
});
afterAll(async () => {
  setWebPushSender(null);
  await h.close();
});

const nudge = (who: 'ann' | 'ben', title: string) =>
  notify(h.ctx, h.ids[who]!, { kind: 'nudge', title, body: `body ${title}`, url: '/c/abc' });

describe('web push', () => {
  it('reports the public key, and null when the server has no keys', async () => {
    expect((await h.call<PushConfig>('ann', 'GET', '/api/push/config')).webPush).toEqual({
      publicKey: keys.publicKey,
    });
    const configured = h.ctx.cfg;
    h.ctx.cfg = { ...configured, VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' };
    try {
      expect((await h.call<PushConfig>('ann', 'GET', '/api/push/config')).webPush).toBeNull();
      const res = await h.raw('ann', 'POST', '/api/push/webpush', { subscription: sub('c') });
      expect(res.statusCode).toBe(409);
    } finally {
      h.ctx.cfg = configured;
    }
  });

  it('stores a subscription once, however often the browser registers', async () => {
    await h.call('ann', 'POST', '/api/push/webpush', { subscription: sub('a1'), label: 'Chrome' });
    await h.call('ann', 'POST', '/api/push/webpush', {
      subscription: sub('a1'),
      label: 'Chrome 2',
    });
    await h.call('ann', 'POST', '/api/push/webpush', { subscription: sub('a2') });
    await h.call('ben', 'POST', '/api/push/webpush', { subscription: sub('b1') });
    const rows = await h.ctx.db.select().from(pushTargets);
    expect(
      rows
        .filter((r) => r.userId === h.ids.ann)
        .map((r) => r.endpoint)
        .sort(),
    ).toEqual([sub('a1').endpoint, sub('a2').endpoint]);
    expect(rows.find((r) => r.endpoint === sub('a1').endpoint)!.label).toBe('Chrome 2');
  });

  it('rejects a malformed subscription', async () => {
    const res = await h.raw('ann', 'POST', '/api/push/webpush', {
      subscription: { endpoint: 'nope' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('sends a notification to every browser of that person only', async () => {
    sent.length = 0;
    await nudge('ann', 'Maya nudged you');
    expect(sent.map((s) => s.endpoint).sort()).toEqual([sub('a1').endpoint, sub('a2').endpoint]);
    const first = sent[0]!;
    expect(first.payload).toMatchObject({
      title: 'Maya nudged you',
      body: 'body Maya nudged you',
      url: '/c/abc',
    });
    expect(first.payload.id).toBeTruthy();
    expect(first.ttl).toBe(86_400);
    expect(first.subject).toBe('mailto:admin@gauntlet.test');
  });

  it('does not send when the person turned that kind off', async () => {
    await h.call('ann', 'PUT', '/api/me/notification-prefs', { prefs: { nudge: false } });
    sent.length = 0;
    await nudge('ann', 'muted');
    expect(sent).toHaveLength(0);
    await h.call('ann', 'PUT', '/api/me/notification-prefs', { prefs: { nudge: true } });
  });

  it('removes a subscription the browser says is gone (410), and keeps the rest on other errors', async () => {
    failWith = { [sub('a2').endpoint]: 410, [sub('a1').endpoint]: 500 };
    await nudge('ann', 'cleanup');
    const left = (
      await h.ctx.db.select().from(pushTargets).where(eq(pushTargets.userId, h.ids.ann!))
    ).map((r) => r.endpoint);
    expect(left).toEqual([sub('a1').endpoint]);
    failWith = {};
  });

  it('a failing push never breaks notify()', async () => {
    failWith = { [sub('a1').endpoint]: 502 };
    await expect(nudge('ann', 'flaky')).resolves.not.toBeNull();
    failWith = {};
  });

  it('unsubscribes only your own', async () => {
    await h.call('ben', 'DELETE', '/api/push/webpush', { endpoint: sub('a1').endpoint });
    expect(
      await h.ctx.db
        .select()
        .from(pushTargets)
        .where(eq(pushTargets.endpoint, sub('a1').endpoint)),
    ).toHaveLength(1);
    await h.call('ann', 'DELETE', '/api/push/webpush', { endpoint: sub('a1').endpoint });
    expect(
      await h.ctx.db
        .select()
        .from(pushTargets)
        .where(eq(pushTargets.endpoint, sub('a1').endpoint)),
    ).toHaveLength(0);
  });
});

describe('phone (device) polling', () => {
  let annPhone = '';
  let annTablet = '';
  let benPhone = '';
  const poll = (token: string) =>
    h.raw(null, 'GET', '/api/push/device/poll', undefined, { authorization: `Device ${token}` });
  const pollOk = async (token: string) => {
    const res = await poll(token);
    expect(res.statusCode).toBe(200);
    return (res.json() as DevicePollResponse).notifications;
  };

  it('registers a device, returning a token and storing only its hash', async () => {
    annPhone = (
      await h.call<{ token: string }>('ann', 'POST', '/api/push/device', { label: 'Pixel' })
    ).token;
    expect(annPhone.length).toBeGreaterThan(20);
    benPhone = (await h.call<{ token: string }>('ben', 'POST', '/api/push/device')).token;
    const row = (await h.ctx.db.select().from(pushTargets)).find(
      (r) => r.endpoint === sha256(annPhone),
    );
    expect(row).toMatchObject({ kind: 'device', userId: h.ids.ann, label: 'Pixel' });
    expect((await h.ctx.db.select().from(pushTargets)).some((r) => r.endpoint === annPhone)).toBe(
      false,
    );
  });

  it('refuses an unknown or missing token', async () => {
    expect((await poll('not-a-real-token')).statusCode).toBe(401);
    expect((await h.raw(null, 'GET', '/api/push/device/poll')).statusCode).toBe(401);
    // A signed-in access token is not a device token.
    expect(
      (
        await h.raw(null, 'GET', '/api/push/device/poll', undefined, {
          authorization: `Bearer ${h.tokens.ann}`,
        })
      ).statusCode,
    ).toBe(401);
  });

  it('returns each notification once per device, and only the owner’s', async () => {
    h.setClock('2026-10-02T18:05:00Z');
    expect(await pollOk(annPhone)).toEqual([]);
    // A second device is registered later, so it starts from now.
    annTablet = (await h.call<{ token: string }>('ann', 'POST', '/api/push/device')).token;
    await h.ctx.db
      .update(pushTargets)
      .set({ lastSeenAt: new Date('2000-01-01') })
      .where(eq(pushTargets.endpoint, sha256(annTablet)));

    await nudge('ann', 'first');
    await new Promise((r) => setTimeout(r, 5));
    await nudge('ann', 'second');
    await notify(h.ctx, h.ids.ben!, { kind: 'nudge', title: 'ben only', body: 'x' });

    const phone = await pollOk(annPhone);
    expect(phone.map((n) => n.title)).toEqual(['first', 'second']);
    expect(phone[0]).toMatchObject({ kind: 'nudge', body: 'body first', url: '/c/abc' });
    // Same poll again: nothing new.
    expect(await pollOk(annPhone)).toEqual([]);
    // The tablet keeps its own place, so it still gets them (plus the earlier ones from epoch).
    const tablet = await pollOk(annTablet);
    expect(tablet.map((n) => n.title)).toEqual(expect.arrayContaining(['first', 'second']));
    expect(tablet.some((n) => n.title === 'ben only')).toBe(false);
    expect((await pollOk(benPhone)).map((n) => n.title)).toEqual(['ben only']);
    expect(await pollOk(benPhone)).toEqual([]);
  });

  it('skips notifications already read in the app', async () => {
    await nudge('ann', 'read already');
    await h.call('ann', 'POST', '/api/notifications/read-all');
    expect(await pollOk(annPhone)).toEqual([]);
  });

  it('revoking removes the device; only for its owner', async () => {
    expect(
      (await h.raw('ben', 'POST', '/api/push/device/revoke', { token: annPhone })).statusCode,
    ).toBe(200);
    expect((await poll(annPhone)).statusCode).toBe(200); // ben could not remove ann's device
    await h.call('ann', 'POST', '/api/push/device/revoke', { token: annPhone });
    expect((await poll(annPhone)).statusCode).toBe(401);
  });
});
