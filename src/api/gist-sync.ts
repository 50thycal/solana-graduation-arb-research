/**
 * src/api/gist-sync.ts
 *
 * Pushes a snapshot of /api/diagnose, /api/snapshot, and /api/best-combos to
 * a public GitHub Gist every SYNC_INTERVAL_MS so Claude can self-serve via
 * WebFetch (Railway's edge blocks Anthropic IPs; gist.githubusercontent.com
 * does not).
 *
 * Required env var: GITHUB_TOKEN — a personal access token with `gist` scope.
 * Optional env var: GIST_SYNC_INTERVAL_MS — defaults to 120000 (2 min).
 *
 * The Gist ID is persisted in the bot_settings DB table so it survives
 * restarts without creating a new Gist each time.
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

const GIST_API = 'https://api.github.com/gists';
const GIST_DESCRIPTION = 'solana-graduation-arb-research bot status (auto-updated)';
const DEFAULT_INTERVAL_MS = 2 * 60 * 1000;

interface GistFile {
  raw_url: string;
}

interface GistResponse {
  id: string;
  html_url: string;
  files: Record<string, GistFile>;
}

export interface GistUrls {
  diagnose: string;
  snapshot: string;
  best_combos: string;
  gist_html: string;
}

export class GistSync {
  private readonly db: Database.Database;
  private readonly logBuffer: LogBuffer;
  private readonly startTime: number;
  private readonly getListenerStats: () => unknown;
  private readonly token: string;
  private readonly intervalMs: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private gistId: string | null = null;
  private urls: GistUrls | null = null;

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
    this.intervalMs = parseInt(process.env.GIST_SYNC_INTERVAL_MS ?? String(DEFAULT_INTERVAL_MS), 10);
  }

  async start(): Promise<void> {
    this.gistId = this.loadGistId();
    if (this.gistId) {
      logger.info({ gistId: this.gistId }, 'Resuming existing Gist');
    }

    await this.sync();

    this.timer = setInterval(() => {
      this.sync().catch((err) => logger.error({ err }, 'Gist sync failed'));
    }, this.intervalMs);

    logger.info({ intervalMs: this.intervalMs }, 'Gist sync scheduled');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getUrls(): GistUrls | null {
    return this.urls;
  }

  // ── private ──────────────────────────────────────────────────

  private buildFiles(): Record<string, { content: string }> {
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
      'diagnose.json': { content: JSON.stringify(diagnose, null, 2) },
      'snapshot.json': { content: JSON.stringify(snapshot, null, 2) },
      'best-combos.json': { content: JSON.stringify(bestCombos, null, 2) },
    };
  }

  private async sync(): Promise<void> {
    const files = this.buildFiles();

    try {
      let data: GistResponse;

      if (this.gistId) {
        const resp = await fetch(`${GIST_API}/${this.gistId}`, {
          method: 'PATCH',
          headers: this.headers(),
          body: JSON.stringify({ files }),
        });

        if (resp.status === 404) {
          // Gist was deleted externally — create a fresh one.
          logger.warn({ gistId: this.gistId }, 'Gist not found, recreating');
          this.gistId = null;
          this.clearGistId();
          await this.sync();
          return;
        }

        if (!resp.ok) {
          throw new Error(`Gist PATCH ${resp.status}: ${await resp.text()}`);
        }

        data = (await resp.json()) as GistResponse;
        logger.debug({ gistId: this.gistId }, 'Gist updated');
      } else {
        const resp = await fetch(GIST_API, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            description: GIST_DESCRIPTION,
            public: true,
            files,
          }),
        });

        if (!resp.ok) {
          throw new Error(`Gist POST ${resp.status}: ${await resp.text()}`);
        }

        data = (await resp.json()) as GistResponse;
        this.gistId = data.id;
        this.saveGistId(data.id);
        logger.info({ gistId: this.gistId, html_url: data.html_url }, 'Gist created');
      }

      this.urls = {
        diagnose: data.files['diagnose.json']?.raw_url ?? '',
        snapshot: data.files['snapshot.json']?.raw_url ?? '',
        best_combos: data.files['best-combos.json']?.raw_url ?? '',
        gist_html: data.html_url,
      };
    } catch (err) {
      logger.error({ err }, 'Gist sync error');
    }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `token ${this.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'solana-graduation-arb-research-bot',
    };
  }

  private loadGistId(): string | null {
    try {
      const row = this.db
        .prepare('SELECT value FROM bot_settings WHERE key = ?')
        .get('gist_id') as { value: string } | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  }

  private saveGistId(id: string): void {
    try {
      this.db
        .prepare('INSERT OR REPLACE INTO bot_settings (key, value) VALUES (?, ?)')
        .run('gist_id', id);
    } catch (err) {
      logger.error({ err }, 'Failed to persist Gist ID');
    }
  }

  private clearGistId(): void {
    try {
      this.db.prepare('DELETE FROM bot_settings WHERE key = ?').run('gist_id');
    } catch {
      // best-effort
    }
  }
}
