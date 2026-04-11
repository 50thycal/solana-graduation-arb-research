/**
 * src/api/gist-sync.ts
 *
 * Pushes diagnose.json, snapshot.json, and best-combos.json to a dedicated
 * `bot-status` branch in the GitHub repo every SYNC_INTERVAL_MS. Because
 * raw.githubusercontent.com is accessible from Anthropic's WebFetch (while
 * gist.githubusercontent.com and Railway's edge are not), this lets Claude
 * self-serve bot state without the human being a middleman.
 *
 * Required env var: GITHUB_TOKEN — a personal access token with `public_repo`
 *   scope (classic token) or Contents:Write (fine-grained token).
 * Optional env var: GIST_SYNC_INTERVAL_MS — defaults to 120000 (2 min).
 *
 * Files are written to the root of the `bot-status` branch:
 *   https://raw.githubusercontent.com/50thycal/solana-graduation-arb-research/bot-status/diagnose.json
 *   https://raw.githubusercontent.com/50thycal/solana-graduation-arb-research/bot-status/snapshot.json
 *   https://raw.githubusercontent.com/50thycal/solana-graduation-arb-research/bot-status/best-combos.json
 */

import type Database from 'better-sqlite3';
import {
  computeThesisScorecard,
  computeDataQualityFlags,
  computeRecentGraduationsEnriched,
  computeBestCombos,
} from './aggregates';
import { runDiagnosis } from './diagnose';
import { getGraduationCount, getLastBotError } from '../db/queries';
import { makeLogger } from '../utils/logger';
import type { LogBuffer } from '../utils/log-buffer';

const logger = makeLogger('gist-sync');

const GITHUB_API = 'https://api.github.com';
const OWNER = '50thycal';
const REPO = 'solana-graduation-arb-research';
const BRANCH = 'bot-status';
const DEFAULT_INTERVAL_MS = 2 * 60 * 1000;

const STATUS_FILES = ['diagnose.json', 'snapshot.json', 'best-combos.json'] as const;
type StatusFile = (typeof STATUS_FILES)[number];

export interface StatusUrls {
  diagnose: string;
  snapshot: string;
  best_combos: string;
  branch_html: string;
}

export class GistSync {
  private readonly db: Database.Database;
  private readonly logBuffer: LogBuffer;
  private readonly startTime: number;
  private readonly getListenerStats: () => unknown;
  private readonly token: string;
  private readonly intervalMs: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  // Cached blob SHAs — required by GitHub Contents API to overwrite files.
  private fileShas = new Map<StatusFile, string>();

  constructor(opts: {
    db: Database.Database;
    logBuffer: LogBuffer;
    startTime: number;
    getListenerStats: () => unknown;
    token: string;
  }) {
    this.db = opts.db;
    this.logBuffer = opts.logBuffer;
    this.startTime = opts.startTime;
    this.getListenerStats = opts.getListenerStats;
    this.token = opts.token;
    this.intervalMs = parseInt(
      process.env.GIST_SYNC_INTERVAL_MS ?? String(DEFAULT_INTERVAL_MS),
      10,
    );
  }

  async start(): Promise<void> {
    await this.ensureBranch();
    await this.loadFileShas();
    await this.sync();

    this.timer = setInterval(() => {
      this.sync().catch((err) => logger.error({ err }, 'Status sync failed'));
    }, this.intervalMs);

    logger.info({ intervalMs: this.intervalMs, branch: BRANCH }, 'Status sync scheduled');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getUrls(): StatusUrls {
    const base = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}`;
    return {
      diagnose: `${base}/diagnose.json`,
      snapshot: `${base}/snapshot.json`,
      best_combos: `${base}/best-combos.json`,
      branch_html: `https://github.com/${OWNER}/${REPO}/tree/${BRANCH}`,
    };
  }

  // ── private ──────────────────────────────────────────────────

  private async ensureBranch(): Promise<void> {
    const resp = await fetch(
      `${GITHUB_API}/repos/${OWNER}/${REPO}/branches/${BRANCH}`,
      { headers: this.headers() },
    );

    if (resp.ok) {
      logger.info({ branch: BRANCH }, 'bot-status branch exists');
      return;
    }

    if (resp.status !== 404) {
      throw new Error(`Branch check failed: ${resp.status} ${await resp.text()}`);
    }

    // Create bot-status from current HEAD of main.
    const mainResp = await fetch(
      `${GITHUB_API}/repos/${OWNER}/${REPO}/git/ref/heads/main`,
      { headers: this.headers() },
    );
    if (!mainResp.ok) {
      throw new Error(`Could not read main branch SHA: ${mainResp.status}`);
    }
    const mainData = (await mainResp.json()) as { object: { sha: string } };

    const createResp = await fetch(
      `${GITHUB_API}/repos/${OWNER}/${REPO}/git/refs`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          ref: `refs/heads/${BRANCH}`,
          sha: mainData.object.sha,
        }),
      },
    );

    if (!createResp.ok) {
      throw new Error(`Failed to create branch: ${createResp.status} ${await createResp.text()}`);
    }

    logger.info({ branch: BRANCH }, 'bot-status branch created');
  }

  private async loadFileShas(): Promise<void> {
    for (const filename of STATUS_FILES) {
      try {
        const resp = await fetch(
          `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${filename}?ref=${BRANCH}`,
          { headers: this.headers() },
        );
        if (resp.ok) {
          const data = (await resp.json()) as { sha: string };
          this.fileShas.set(filename, data.sha);
        }
        // 404 = file not yet created, skip — PUT without sha will create it.
      } catch (err) {
        logger.warn({ err, filename }, 'Could not pre-load file SHA');
      }
    }
  }

  private buildPayloads(): Record<StatusFile, string> {
    const nowMs = Date.now();

    const diagnose = runDiagnosis(this.db, this.logBuffer);

    const scorecard = computeThesisScorecard(this.db);
    const quality = computeDataQualityFlags(this.db);
    const recent = computeRecentGraduationsEnriched(this.db, 10);
    const lastError = getLastBotError(this.db);
    const listenerStats = this.getListenerStats();

    const snapshot = {
      generated_at: new Date(nowMs).toISOString(),
      uptime_sec: Math.floor((nowMs - this.startTime) / 1000),
      counts: {
        graduations: getGraduationCount(this.db),
        momentum_labeled: scorecard.total_labeled,
        pump: scorecard.PUMP,
        dump: scorecard.DUMP,
        stable: scorecard.STABLE,
        unlabeled: scorecard.unlabeled,
      },
      scorecard,
      data_quality: quality,
      listener: listenerStats,
      recent_graduations: recent,
      last_error: lastError,
    };

    const bestCombos = computeBestCombos(this.db, {
      min_n: 20,
      top: 20,
      include_pairs: true,
    });

    return {
      'diagnose.json': JSON.stringify(diagnose, null, 2),
      'snapshot.json': JSON.stringify(snapshot, null, 2),
      'best-combos.json': JSON.stringify(bestCombos, null, 2),
    };
  }

  private async sync(): Promise<void> {
    const payloads = this.buildPayloads();

    for (const filename of STATUS_FILES) {
      const content = payloads[filename];
      const encoded = Buffer.from(content).toString('base64');
      const currentSha = this.fileShas.get(filename);

      const body: Record<string, unknown> = {
        message: `bot: update ${filename} [skip ci]`,
        content: encoded,
        branch: BRANCH,
      };
      if (currentSha) body.sha = currentSha;

      try {
        const resp = await fetch(
          `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${filename}`,
          {
            method: 'PUT',
            headers: this.headers(),
            body: JSON.stringify(body),
          },
        );

        if (resp.ok) {
          const data = (await resp.json()) as { content: { sha: string } };
          this.fileShas.set(filename, data.content.sha);
        } else {
          const text = await resp.text();
          logger.error({ filename, status: resp.status, body: text }, 'File PUT failed');
        }
      } catch (err) {
        logger.error({ err, filename }, 'File PUT threw');
      }
    }

    logger.debug({ branch: BRANCH }, 'Status files updated');
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `token ${this.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'solana-graduation-arb-research-bot',
    };
  }
}
