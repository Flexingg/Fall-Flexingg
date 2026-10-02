import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const UPDATED = '2 October 2026';

const CSS = `
:root{color-scheme:dark light}
body{background:#0c0c0d;color:#cfcfca;font:16px/1.6 system-ui,sans-serif;max-width:680px;margin:0 auto;padding:32px 20px 64px}
h1,h2{color:#f2f2f0;line-height:1.2}h2{margin-top:30px;font-size:19px}
a{color:#c6ff00}li{margin:4px 0}small{color:#8a8a85}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid #2a2a2c;padding:6px 8px;text-align:left;vertical-align:top}
@media (prefers-color-scheme:light){body{background:#fff;color:#333}h1,h2{color:#111}a{color:#2b6a00}td,th{border-color:#ddd}}
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}<p><small>Last updated ${UPDATED}. <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/delete-account">Delete your account</a></small></p></body></html>`;
}

export function legalRoutes(app: FastifyInstance, ctx: AppContext): void {
  const contact = ctx.cfg.CONTACT_EMAIL.trim() || [...ctx.cfg.adminEmails][0] || '';
  const contactHtml = contact
    ? `<a href="mailto:${esc(contact)}">${esc(contact)}</a>`
    : 'the person who runs this Gauntlet server';
  const host = (() => {
    try {
      return new URL(ctx.cfg.PUBLIC_WEB_URL).host;
    } catch {
      return 'this server';
    }
  })();
  const send = (html: string) => (_req: unknown, reply: import('fastify').FastifyReply) =>
    reply
      .header('Cache-Control', 'public, max-age=300')
      .type('text/html; charset=utf-8')
      .send(html);

  const privacy = page(
    'Gauntlet privacy policy',
    `<h1>Gauntlet privacy policy</h1>
<p>Gauntlet runs fitness challenges between friends, on top of the SparkyFitness server you sign in with. This policy covers the Gauntlet app (Android and web) and the Gauntlet server at <strong>${esc(host)}</strong>. Questions or requests: ${contactHtml}.</p>

<h2>What we collect, and why</h2>
<table>
<tr><th>Data</th><th>Why</th><th>Kept</th></tr>
<tr><td>Name, email, time zone, optional @handle, profile visibility (public or private)</td><td>Your account, finding friends, showing you on leaderboards</td><td>Until you delete your account</td></tr>
<tr><td>An encrypted SparkyFitness API key (your password is never stored by Gauntlet)</td><td>To read your fitness data from SparkyFitness and score challenges</td><td>Until you delete your account (the key is revoked)</td></tr>
<tr><td>Daily totals for the stats you compete on (steps, distance, active calories, sleep, resting heart rate, workouts, lift volume, water, calories and macros, weight-goal progress, fasting hours, and similar)</td><td>Scoring challenges, trends and your progress graphs</td><td>Until you delete your account; rebuilt from SparkyFitness at any time</td></tr>
<tr><td>Friends, challenges, invites, scores and results</td><td>The app's core features</td><td>Until you or the challenge creator deletes them, or you delete your account</td></tr>
<tr><td>Health Connect data (Android, only with your permission): steps, distance, active calories, resting heart rate, sleep, exercise sessions</td><td>Forwarded to <em>your</em> SparkyFitness server so it counts toward your challenges</td><td>Gauntlet does not keep raw Health Connect records; SparkyFitness stores them</td></tr>
<tr><td>Standard server logs (IP address, time, request) and rate-limit counters</td><td>Security and abuse prevention</td><td>Short-lived operational logs</td></tr>
</table>

<h2>What other people can see</h2>
<ul>
<li><strong>Private profile (the default):</strong> only your friends and people in your challenges see your name, handle and challenge scores.</li>
<li><strong>Public profile (your choice):</strong> anyone signed in can find you by name or handle and see your name, handle and challenge record.</li>
<li><strong>Challenges:</strong> people in a challenge see your total, rank and progress graph for that challenge. Public challenges can be seen by any signed-in person.</li>
<li><strong>Show Events:</strong> if a challenge has it on, other participants can open the workouts, lift sessions or fasts that count toward scores. These are read live from SparkyFitness when someone looks and are not copied into Gauntlet. You can opt out in Data sources &amp; privacy.</li>
<li>Gauntlet never shows anyone your weight, your health records, routes or heart-rate samples. Solo challenges are private to you.</li>
</ul>

<h2>Sharing</h2>
<p>We do not sell personal data, use it for advertising, or share it with data brokers. Gauntlet does not include advertising or analytics SDKs. Your data goes only to: your own SparkyFitness server (to read and write your fitness data), the app or service you choose to link through SparkyFitness (such as Strava, Fitbit, Oura, Polar or Garmin, under their own policies), and our hosting provider (Fly.io), which processes it on our behalf. Data is encrypted in transit; API keys are encrypted at rest.</p>

<h2>Health data</h2>
<p>Health data from Health Connect and SparkyFitness is used only to run challenges, trends and progress for you and the people you choose to compete with. It is never used for advertising or sold. You can revoke Health Connect access at any time in Android settings.</p>

<h2>Your choices and deleting your data</h2>
<ul>
<li><strong>Delete your account:</strong> in the app, Me → Delete Gauntlet account, or see <a href="/delete-account">how to delete your account</a>. This removes your profile, API key, totals, friendships, scores, and challenges you created (these disappear for everyone in them). Your SparkyFitness data is not touched; delete it from SparkyFitness separately.</li>
<li>Change profile visibility, handle, workout sharing and Show Events opt-out at any time under Me and Data sources &amp; privacy.</li>
<li>Ask us for a copy of your data or a correction: ${contactHtml}.</li>
</ul>

<h2>Children</h2>
<p>Gauntlet is not for children under 13 (or the minimum age in your country). We do not knowingly collect their data.</p>

<h2>Changes</h2>
<p>If this policy changes, the date above changes and significant changes are announced in the app.</p>

<h2>Contact</h2>
<p>${contactHtml}</p>`,
  );

  const terms = page(
    'Gauntlet terms of use',
    `<h1>Gauntlet terms of use</h1>
<p>By using Gauntlet you agree to these terms. Gauntlet is operated by the person who runs the server at <strong>${esc(host)}</strong> (${contactHtml}).</p>
<ul>
<li><strong>Not medical advice.</strong> Gauntlet is for friendly competition. Don't push your body past what is safe because of a score, and talk to a professional before starting a new training programme.</li>
<li><strong>Be decent.</strong> Don't harass, impersonate or abuse others, post unlawful or offensive names, or cheat by submitting data you know is false. Challenge creators and the operator can remove people or challenges.</li>
<li><strong>Your data, your account.</strong> You are responsible for your SparkyFitness account and the apps you link. You can delete your Gauntlet account at any time.</li>
<li><strong>Service as is.</strong> The service is provided without warranties and may change or stop. Scores come from data other services report and may be late or imperfect. To the extent the law allows, the operator isn't liable for losses from using it.</li>
<li><strong>Privacy.</strong> See the <a href="/privacy">privacy policy</a>.</li>
</ul>`,
  );

  const del = page(
    'Delete your Gauntlet account',
    `<h1>Delete your Gauntlet account</h1>
<h2>In the app (fastest)</h2>
<ol>
<li>Open Gauntlet (Android app or <a href="/">${esc(host)}</a>) and sign in.</li>
<li>Go to <strong>Me</strong> and tap <strong>Delete Gauntlet account</strong>, then confirm.</li>
</ol>
<p>Your account is deleted straight away.</p>
<h2>Can't sign in?</h2>
<p>Email ${contactHtml} from the address on your account with the subject "Delete my Gauntlet account". We delete it within 30 days.</p>
<h2>What is deleted</h2>
<ul>
<li>Your profile, handle and settings, your encrypted SparkyFitness API key (we also revoke it), and all daily totals Gauntlet cached.</li>
<li>Your friendships, invites, scores and results, and challenges you created (these disappear for everyone in them; use Rematch or leave them if you'd rather keep them).</li>
</ul>
<h2>What is not deleted</h2>
<p>Your data stored in SparkyFitness, Health Connect, Strava, Fitbit, Garmin and other linked services belongs to those services; delete it there.</p>`,
  );

  app.get('/privacy', send(privacy));
  app.get('/terms', send(terms));
  app.get('/delete-account', send(del));
}
