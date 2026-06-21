/**
 * src/api/roast.ts
 *
 * "The Analyst" — server-side LLM commentary for the live dashboard's
 * performance stream. POST /api/roast takes the current performance stats and
 * returns ONE dry/sarcastic reaction line: it roasts when the bot is below its
 * +3.75 SOL/month goal and gives grudging, deadpan praise when it's clearing
 * the bar. Calls Claude (Opus 4.8 by default) via the official Anthropic SDK.
 *
 * The live page (html-renderer) falls back to its built-in line pool whenever
 * this returns anything other than {source:"llm"}, so the feature degrades
 * gracefully when no API key is set, during the cooldown window, or on any
 * API error — the stream never breaks.
 *
 * Config (all optional):
 *   ANTHROPIC_API_KEY      — enables the LLM path. Without it: {source:"disabled"}.
 *   ROAST_MODEL            — model id (default "claude-opus-4-8").
 *   ROAST_MIN_INTERVAL_MS  — min ms between real Claude calls (default 15000),
 *                            a global cooldown that caps cost regardless of how
 *                            many viewers are open or how fast they poll.
 */

import type { Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('roast');

const GOAL_SOL_PER_MONTH = 3.75;
const ROAST_MODEL = process.env.ROAST_MODEL || 'claude-opus-4-8';
const MIN_INTERVAL_MS = Number.parseInt(process.env.ROAST_MIN_INTERVAL_MS || '15000', 10);

let client: Anthropic | null = null;
let warnedNoKey = false;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY from the env
  return client;
}

// Global cooldown so a roomful of viewers (or a fast poll loop) can't run up the
// bill. Reserved before the (slow) call so concurrent hits also cool down.
let lastCallAt = 0;

const SYSTEM = [
  'You are "The Analyst", a deadpan, dry-witted commentator embedded in the dashboard',
  'of a Solana memecoin trading bot. The bot has ONE goal: net at least +3.75 SOL per month.',
  '',
  'Given the current stats, reply with EXACTLY ONE punchy sentence (max ~30 words) reacting',
  'to the performance.',
  '',
  'Voice:',
  '- Losing money, or positive but below the +3.75 SOL/month goal: roast it. Sharp,',
  '  sarcastic, funny. Mock the performance, never a person.',
  '- At or above the goal: be supportive but DRY — grudging, backhanded, never earnest',
  '  cheerleading.',
  '- Too few trades to judge: refuse to judge a small sample, sarcastically.',
  '',
  'Rules: output ONLY the single line — no preamble, no reasoning, no surrounding quotes,',
  'no emojis, no hashtags. Vary your wording each time. You may cite the specific numbers.',
].join('\n');

type Tier = 'wait' | 'bad' | 'cold' | 'ok' | 'good';
function tierOf(monthly: number, net: number, n: number): Tier {
  if (n < 8) return 'wait';
  if (net < 0 || monthly < 0) return 'bad';
  if (monthly < GOAL_SOL_PER_MONTH) return 'cold';
  if (monthly < GOAL_SOL_PER_MONTH * 2) return 'ok';
  return 'good';
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** POST /api/roast — see module header. Always responds 200 with a {source}. */
export async function handleRoast(req: Request, res: Response): Promise<void> {
  const c = getClient();
  if (!c) {
    if (!warnedNoKey) {
      logger.info('ANTHROPIC_API_KEY not set — /api/roast serving {disabled}; live page uses local lines');
      warnedNoKey = true;
    }
    res.json({ source: 'disabled' });
    return;
  }

  const now = Date.now();
  if (now - lastCallAt < MIN_INTERVAL_MS) {
    res.json({ source: 'cooldown' });
    return;
  }
  lastCallAt = now;

  // Sanitize the client-supplied stats: coerce numbers, clamp the scope string.
  const b = (req.body ?? {}) as Record<string, unknown>;
  const monthly = num(b.monthly);
  const net = num(b.net);
  const n = Math.max(0, Math.round(num(b.n)));
  const winRate = b.winRate == null ? null : num(b.winRate);
  const worstLoss = b.worstLoss == null ? null : num(b.worstLoss);
  const bestWin = b.bestWin == null ? null : num(b.bestWin);
  const drawdown = num(b.drawdown);
  const scope = String(b.scope ?? 'all active strategies').replace(/[\r\n]+/g, ' ').slice(0, 60);
  const tier = tierOf(monthly, net, n);

  const userMsg = [
    'Current stats (goal: +3.75 SOL/month):',
    `- monthly run rate: ${monthly.toFixed(2)} SOL/month`,
    `- total net: ${net.toFixed(3)} SOL over ${n} closed trades`,
    `- win rate: ${winRate == null ? 'unknown' : winRate + '%'}`,
    `- worst drawdown: ${drawdown.toFixed(3)} SOL`,
    `- biggest single loss: ${worstLoss == null ? 'n/a' : worstLoss.toFixed(3) + ' SOL'}`,
    `- biggest single win: ${bestWin == null ? 'n/a' : bestWin.toFixed(3) + ' SOL'}`,
    `- scope: ${scope}`,
    `- verdict tier: ${tier}`,
    '',
    'Write one reaction line now.',
  ].join('\n');

  try {
    // One short, witty line — no thinking needed, so omit it for low latency.
    // (Opus 4.8 rejects temperature/top_p, so variety comes from the prompt.)
    const msg = await c.messages.create(
      {
        model: ROAST_MODEL,
        max_tokens: 200,
        system: SYSTEM,
        messages: [{ role: 'user', content: userMsg }],
      },
      { timeout: 20_000 },
    );

    if (msg.stop_reason === 'refusal') {
      res.json({ source: 'refused' });
      return;
    }

    let line = '';
    for (const blk of msg.content) {
      if (blk.type === 'text') line += (line ? ' ' : '') + blk.text;
    }
    line = line.trim().replace(/^["']+|["']+$/g, '').trim();
    if (!line) {
      res.json({ source: 'empty' });
      return;
    }
    res.json({ source: 'llm', line, model: msg.model, tier });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '/api/roast LLM call failed — live page will fall back to local lines',
    );
    res.json({ source: 'error' });
  }
}
