/**
 * src/api/roast.ts
 *
 * "The Analyst" — server-side LLM commentary for the live dashboard.
 *
 *   POST /api/roast  { ...stats, persona?, mode? }  → { source, line }
 *
 * mode "line"  (default): ONE dry/sarcastic sentence for the live stream.
 * mode "recap": a 2-3 sentence summary for the shareable recap card.
 * persona: voice to use (quant | hype | doomer | zen | drill).
 *
 * Roasts when the bot is below its +3.75 SOL/month goal, grudging praise above.
 * Calls Claude (Opus 4.8 by default) via the official Anthropic SDK. The live
 * page falls back to its built-in line pool whenever this returns anything
 * other than {source:"llm"}, so the feature degrades gracefully (no key, during
 * cooldown, on error) and the stream never breaks.
 *
 * Config (all optional):
 *   ANTHROPIC_API_KEY      — enables the LLM path. Without it: {source:"disabled"}.
 *   ROAST_MODEL            — model id (default "claude-opus-4-8").
 *   ROAST_MIN_INTERVAL_MS  — min ms between real Claude calls for the line
 *                            stream (default 15000), a global cost cap.
 */

import type { Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { makeLogger } from '../utils/logger';

const logger = makeLogger('roast');

const GOAL_SOL_PER_MONTH = 3.75;
const ROAST_MODEL = process.env.ROAST_MODEL || 'claude-opus-4-8';
const MIN_INTERVAL_MS = Number.parseInt(process.env.ROAST_MIN_INTERVAL_MS || '15000', 10);
// Recap is a deliberate button press, not a poll loop — exempt it from the beat
// cooldown but keep a light anti-double-click throttle. Same idea for a manual
// "new take" press on the live stream.
const RECAP_MIN_INTERVAL_MS = 2500;
const MANUAL_MIN_INTERVAL_MS = 3000;

let client: Anthropic | null = null;
let warnedNoKey = false;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY from the env
  return client;
}

let lastCallAt = 0;    // line-stream beat cooldown
let lastRecapAt = 0;   // recap anti-spam
let lastManualAt = 0;  // manual "new take" anti-spam

const SHARED =
  'You are "The Analyst", embedded in the dashboard of a Solana memecoin trading bot. ' +
  'The bot has ONE goal: net at least +3.75 SOL per month.';

const PERSONAS: Record<string, { label: string; voice: string }> = {
  quant: {
    label: 'Deadpan Quant',
    voice:
      'Voice: a jaded, deadpan quant. Dry, sarcastic, surgical. Mock the performance, never a person.',
  },
  hype: {
    label: 'Hype Man',
    voice:
      'Voice: a relentless crypto hype man — huge energy, spelled-out emphasis (WE ARE SO BACK), ' +
      'delusionally optimistic even when it is going badly ("just the shakeout before the rip"). Never genuinely worried.',
  },
  doomer: {
    label: 'Permabear Doomer',
    voice:
      'Voice: a permabear doomer. Every green candle is a bull trap, every win is exit liquidity in waiting. ' +
      'Gleefully, theatrically pessimistic even when the bot is winning.',
  },
  zen: {
    label: 'Zen Monk',
    voice:
      'Voice: a serene zen monk. Calm, detached, speaks in tiny koans about impermanence, attachment, ' +
      'and the illusion of profit and loss. Unbothered by gains or losses alike.',
  },
  drill: {
    label: 'Drill Sergeant',
    voice:
      'Voice: a furious drill sergeant. Barking, clipped, demanding. Treats every losing trade as a ' +
      'personal failure of discipline and says so.',
  },
};

function buildSystem(personaKey: string, mode: 'line' | 'recap'): string {
  const p = PERSONAS[personaKey] || PERSONAS.quant;
  const fmt =
    mode === 'recap'
      ? 'Write a 2-3 sentence recap (max ~45 words total) summarizing how the session is going, for a shareable social-media card.'
      : 'Reply with EXACTLY ONE punchy sentence (max ~30 words).';
  return [
    SHARED,
    p.voice,
    'React to the stats in character: if losing money or below the +3.75 SOL/month goal, be critical and ' +
      'roast the performance; if at or above the goal, acknowledge it but stay in character (grudging, ' +
      'suspicious, or unimpressed as your persona dictates); if there are too few trades to judge, refuse ' +
      'to judge a small sample.',
    fmt,
    'Rules: output ONLY the text — no preamble, no reasoning, no surrounding quotes, no emojis, no hashtags. Vary your wording.',
  ].join('\n\n');
}

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

  const b = (req.body ?? {}) as Record<string, unknown>;
  const mode: 'line' | 'recap' = b.mode === 'recap' ? 'recap' : 'line';
  const persona = typeof b.persona === 'string' && PERSONAS[b.persona] ? b.persona : 'quant';

  const now = Date.now();
  if (mode === 'line') {
    if (b.force === true) {
      // Manual "new take" — bypass the beat cooldown, keep a light anti-spam
      // throttle, and push the beat timer forward so the next auto-line waits.
      if (now - lastManualAt < MANUAL_MIN_INTERVAL_MS) { res.json({ source: 'cooldown' }); return; }
      lastManualAt = now;
      lastCallAt = now;
    } else {
      if (now - lastCallAt < MIN_INTERVAL_MS) { res.json({ source: 'cooldown' }); return; }
      lastCallAt = now;
    }
  } else {
    if (now - lastRecapAt < RECAP_MIN_INTERVAL_MS) { res.json({ source: 'cooldown' }); return; }
    lastRecapAt = now;
  }

  // Sanitize the client-supplied stats: coerce numbers, clamp the scope string.
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
    mode === 'recap' ? 'Write the recap now.' : 'Write one reaction line now.',
  ].join('\n');

  try {
    // Short, witty output — no thinking needed, so omit it for low latency.
    // (Opus 4.8 rejects temperature/top_p, so variety comes from the prompt.)
    const msg = await c.messages.create(
      {
        model: ROAST_MODEL,
        max_tokens: mode === 'recap' ? 256 : 200,
        system: buildSystem(persona, mode),
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
    res.json({ source: 'llm', line, model: msg.model, tier, persona, mode });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), mode },
      '/api/roast LLM call failed — live page will fall back to local lines',
    );
    res.json({ source: 'error' });
  }
}
