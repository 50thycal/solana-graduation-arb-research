/**
 * scripts/test-api-shapes.ts
 *
 * Shape contract test for the /api/* endpoints. No test framework — just
 * a plain Node script you run with ts-node against a live bot:
 *
 *   HEALTH_URL=http://localhost:8080 npx ts-node scripts/test-api-shapes.ts
 *
 * or against Railway:
 *
 *   HEALTH_URL=https://<your-app>.up.railway.app npx ts-node scripts/test-api-shapes.ts
 *
 * Exits with code 0 on success, code 1 if any endpoint is missing or has
 * the wrong shape. Run before every deploy and as the last verification
 * step when a Claude session touches the API.
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const BASE = process.env.HEALTH_URL || 'http://localhost:8080';

interface Check {
  path: string;
  requiredKeys: string[];
  description: string;
}

const CHECKS: Check[] = [
  {
    path: '/api',
    requiredKeys: ['service', 'endpoints'],
    description: 'API index',
  },
  {
    path: '/api/diagnose',
    requiredKeys: [
      'generated_at',
      'verdict',
      'next_action',
      'level1_bot_running',
      'level2_price_capture',
      'level3_timestamps',
      'level4_label_logic',
    ],
    description: 'Level 1-4 bug triage verdict',
  },
  {
    path: '/api/snapshot',
    requiredKeys: [
      'generated_at',
      'uptime_sec',
      'counts',
      'scorecard',
      'data_quality',
      'recent_graduations',
    ],
    description: 'Dashboard summary',
  },
  {
    path: '/api/best-combos?min_n=1&top=5',
    requiredKeys: ['generated_at', 'baseline_avg_return_pct', 'rows'],
    description: 'Filter leaderboard',
  },
  {
    path: '/api/filter-catalog',
    requiredKeys: ['count', 'filters'],
    description: 'Filter catalog',
  },
  {
    path: '/api/trades?limit=5',
    requiredKeys: ['generated_at', 'stats', 'trades'],
    description: 'Recent trades',
  },
  {
    path: '/api/skips?limit=5',
    requiredKeys: ['generated_at', 'reason_counts', 'skips'],
    description: 'Recent skips',
  },
  {
    path: '/api/graduations?limit=5',
    requiredKeys: ['generated_at', 'count', 'rows'],
    description: 'Recent graduations',
  },
  {
    path: '/api/logs?limit=10',
    requiredKeys: ['generated_at', 'buffer_size', 'entries'],
    description: 'Log ring buffer',
  },
  {
    path: '/api/bot-errors?limit=5',
    requiredKeys: ['generated_at', 'recent'],
    description: 'Bot error log',
  },
];

function fetchJson(urlStr: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const client = u.protocol === 'https:' ? https : http;
    const req = client.get(u, (res) => {
      if ((res.statusCode ?? 500) >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${urlStr}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`Invalid JSON from ${urlStr}: ${(err as Error).message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error(`Timeout fetching ${urlStr}`));
    });
  });
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`Testing /api/* shapes against ${BASE}\n`);
  let failed = 0;

  for (const check of CHECKS) {
    const url = `${BASE}${check.path}`;
    try {
      const body = await fetchJson(url);
      if (typeof body !== 'object' || body === null) {
        throw new Error('Response is not a JSON object');
      }
      const bodyObj = body as Record<string, unknown>;
      const missing = check.requiredKeys.filter((k) => !(k in bodyObj));
      if (missing.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`  FAIL  ${check.path} — missing keys: ${missing.join(', ')}`);
        failed++;
      } else {
        // eslint-disable-next-line no-console
        console.log(`  PASS  ${check.path} — ${check.description}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(`  FAIL  ${check.path} — ${(err as Error).message}`);
      failed++;
    }
  }

  // eslint-disable-next-line no-console
  console.log(`\n${CHECKS.length - failed}/${CHECKS.length} checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal:', err);
  process.exit(1);
});
