/**
 * Asks Claude (plain fetch to the Messages API, forced tool use so the answer is structured)
 * whether a Garmin badge can become a Gauntlet badge. Only the Garmin badge's public text is sent.
 * The answer is validated with badgeDraftSchema; one invalid answer gets one retry with the error
 * shown to the model. Busy/overloaded responses back off and retry (3 tries); 401/403 are fatal for
 * the whole run (LlmAuthError) so the caller can stop and leave the rest pending.
 */
import { badgeDraftSchema, type BadgeDraft } from '@gauntlet/shared';
import type { AppContext } from '../../context.js';
import { getImportBackoff, importFetch, sleep } from './http.js';
import { SYSTEM_PROMPT, userPrompt, type PromptSource } from './prompt.js';
import { buildProposeBadgeTool, TOOL_NAME } from './toolSchema.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_TRIES = 3;

/** The API key was refused: stop the whole run. */
export class LlmAuthError extends Error {}
/** Claude could not be reached or kept failing for this badge. */
export class LlmUnavailableError extends Error {}

export type Proposal =
  | { decision: 'match'; reason: string; draft: BadgeDraft }
  | { decision: 'skip'; reason: string }
  | { decision: 'invalid'; reason: string };

interface ToolUse {
  id: string;
  input: unknown;
}
interface Message {
  role: 'user' | 'assistant';
  content: unknown;
}

async function callModel(ctx: AppContext, messages: Message[]): Promise<ToolUse> {
  const body = JSON.stringify({
    model: ctx.cfg.BADGE_IMPORT_MODEL,
    max_tokens: 1500,
    temperature: 0,
    system: SYSTEM_PROMPT,
    tools: [buildProposeBadgeTool()],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages,
  });
  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    let wait = getImportBackoff() * 2 ** (attempt - 1);
    try {
      const res = await importFetch(API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': ctx.cfg.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 401 || res.status === 403)
        throw new LlmAuthError(`Anthropic refused the API key (${res.status})`);
      if (res.ok) {
        const json = (await res.json()) as {
          content?: { type: string; id?: string; name?: string; input?: unknown }[];
        };
        const tu = json.content?.find((c) => c.type === 'tool_use' && c.name === TOOL_NAME);
        if (!tu?.id) throw new LlmUnavailableError('Claude did not answer with the tool');
        return { id: tu.id, input: tu.input };
      }
      lastError = `Anthropic answered ${res.status}`;
      if (res.status !== 429 && res.status !== 529 && res.status < 500) {
        const detail = await res.text().catch(() => '');
        let msg = '';
        try {
          msg = (JSON.parse(detail) as { error?: { message?: string } }).error?.message ?? '';
        } catch {
          /* not json */
        }
        throw new LlmUnavailableError(`${lastError}${msg ? `: ${msg.slice(0, 200)}` : ''}`);
      }
      const ra = Number(res.headers.get('retry-after'));
      if (Number.isFinite(ra) && ra > 0) wait = Math.min(ra * 1000, 60_000);
    } catch (err) {
      if (err instanceof LlmAuthError || err instanceof LlmUnavailableError) throw err;
      lastError = `Could not reach Anthropic (${(err as Error).message})`;
    }
    if (attempt < MAX_TRIES) await sleep(wait);
  }
  throw new LlmUnavailableError(`${lastError} (gave up after ${MAX_TRIES} tries)`);
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Make the key `g-<slug>-<id>` whatever the model wrote, and pin the window to the source dates. */
function fixDraft(input: unknown, s: PromptSource): unknown {
  if (!input || typeof input !== 'object') return input;
  const d = { ...(input as Record<string, unknown>) };
  const raw = typeof d.key === 'string' ? d.key : typeof d.name === 'string' ? d.name : '';
  const base =
    slug(raw)
      .replace(/^g-/, '')
      .replace(new RegExp(`-?${s.id}$`), '')
      .slice(0, 63 - 3 - s.id.length)
      .replace(/-+$/, '') || 'badge';
  d.key = `g-${base}-${s.id}`;
  d.window = s.start && s.end ? { start: s.start, end: s.end } : null;
  if (d.window) d.family = 'seasonal';
  return d;
}

function check(input: unknown, s: PromptSource): Proposal | string {
  const i = (input ?? {}) as { decision?: unknown; reason?: unknown; draft?: unknown };
  const reason = typeof i.reason === 'string' ? i.reason.trim().slice(0, 300) : '';
  if (i.decision === 'skip')
    return { decision: 'skip', reason: reason || 'Not a fit for Gauntlet' };
  if (i.decision !== 'match') return 'decision must be "match" or "skip"';
  if (!i.draft) return 'draft is required when decision is "match"';
  const parsed = badgeDraftSchema.safeParse(fixDraft(i.draft, s));
  if (!parsed.success)
    return parsed.error.issues
      .slice(0, 5)
      .map((e) => `${['draft', ...e.path].join('.')}: ${e.message}`)
      .join('; ');
  return { decision: 'match', reason: reason || 'Matches a Gauntlet rule', draft: parsed.data };
}

/** One badge, one call (plus one retry if the answer doesn't validate). */
export async function proposeBadge(ctx: AppContext, source: PromptSource): Promise<Proposal> {
  const today = ctx.now().toISOString().slice(0, 10);
  const messages: Message[] = [{ role: 'user', content: userPrompt(source, today) }];
  const first = await callModel(ctx, messages);
  const r1 = check(first.input, source);
  if (typeof r1 !== 'string') return r1;
  messages.push(
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: first.id, name: TOOL_NAME, input: first.input }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: first.id,
          is_error: true,
          content: `That did not pass validation: ${r1}. Call ${TOOL_NAME} again with a corrected answer.`,
        },
      ],
    },
  );
  const second = await callModel(ctx, messages);
  const r2 = check(second.input, source);
  if (typeof r2 !== 'string') return r2;
  return { decision: 'invalid', reason: `The draft did not pass checks: ${r2}`.slice(0, 400) };
}
