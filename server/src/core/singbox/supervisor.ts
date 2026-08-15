import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { env, paths } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { serializeConfig, type SingBoxConfig } from './config.js';

/**
 * Супервизор процесса sing-box.
 *
 * Отвечает ровно за три вещи: проверить конфиг перед применением, поднять
 * процесс и не дать ему тихо умереть. Ничего не знает ни о БД, ни о HTTP —
 * конфиг ему приносят готовым.
 *
 * Порядок применения намеренно консервативный: сначала `sing-box check` на
 * файле-кандидате, и только если он прошёл — замена рабочего конфига и
 * перезапуск. Так битая подписка не может уронить уже работающие прокси.
 */

export type SingBoxStatus = 'stopped' | 'starting' | 'running' | 'failed' | 'binary-missing';

export interface SingBoxState {
  status: SingBoxStatus;
  pid: number | null;
  startedAt: string | null;
  lastError: string | null;
  version: string | null;
  binary: string;
  inboundCount: number;
  restarts: number;
  configuredAt: string | null;
}

export class SingBoxConfigError extends Error {
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message);
    this.name = 'SingBoxConfigError';
  }
}

const MAX_LOG_LINES = 800;
const STARTUP_GRACE_MS = 900;
const STOP_TIMEOUT_MS = 5000;
const MAX_BACKOFF_MS = 60_000;

/** stdin закрыт, stdout/stderr читаем построчно. */
type SingBoxProcess = ChildProcessByStdio<null, Readable, Readable>;

class SingBoxSupervisor {
  private child: SingBoxProcess | null = null;
  private status: SingBoxStatus = 'stopped';
  private startedAt: Date | null = null;
  private lastError: string | null = null;
  private version: string | null = null;
  private restarts = 0;
  private configuredAt: Date | null = null;
  private configHash: string | null = null;
  private inboundCount = 0;
  private logs: string[] = [];
  private stopping = false;
  private backoffMs = 1000;
  private restartTimer: NodeJS.Timeout | null = null;

  /** Определяет версию бинаря; вызывается один раз на старте приложения. */
  async init(): Promise<void> {
    const result = await this.execute(['version'], 8000);
    if (result.failedToSpawn) {
      this.status = 'binary-missing';
      this.lastError = `Бинарь sing-box не найден: ${env.SINGBOX_BIN}`;
      logger.error(this.lastError);
      return;
    }

    const match = /sing-box version (\S+)/.exec(result.stdout);
    this.version = match?.[1] ?? result.stdout.trim().split('\n')[0] ?? null;
    logger.info(`sing-box: ${this.version ?? 'версия не определена'}`);
  }

  getState(): SingBoxState {
    return {
      status: this.status,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt?.toISOString() ?? null,
      lastError: this.lastError,
      version: this.version,
      binary: env.SINGBOX_BIN,
      inboundCount: this.inboundCount,
      restarts: this.restarts,
      configuredAt: this.configuredAt?.toISOString() ?? null,
    };
  }

  getLogs(limit = 200): string[] {
    return this.logs.slice(-Math.max(1, Math.min(limit, MAX_LOG_LINES)));
  }

  /** Текущий рабочий конфиг — показываем в UI для отладки. */
  readCurrentConfig(): string | null {
    return fs.existsSync(paths.singboxConfig) ? fs.readFileSync(paths.singboxConfig, 'utf8') : null;
  }

  /**
   * Применяет конфиг: проверка → запись → перезапуск.
   * Возвращает false, если конфиг не изменился и перезапуск не потребовался.
   */
  async apply(config: SingBoxConfig, inboundCount: number): Promise<boolean> {
    const text = serializeConfig(config);
    const hash = crypto.createHash('sha256').update(text).digest('hex');

    const alreadyApplied = hash === this.configHash;
    const runningAsExpected = inboundCount === 0 ? this.status === 'stopped' : this.status === 'running';
    if (alreadyApplied && runningAsExpected) return false;

    if (this.status !== 'binary-missing') {
      await this.validate(text);
    }

    fs.writeFileSync(paths.singboxConfig, text, { mode: 0o600 });
    this.configHash = hash;
    this.configuredAt = new Date();
    this.inboundCount = inboundCount;

    if (inboundCount === 0) {
      await this.stop();
      this.appendLog('нет активных прокси — sing-box остановлен');
      return true;
    }

    await this.restart();
    return true;
  }

  /** Прогоняет `sing-box check` на файле-кандидате. Бросает SingBoxConfigError. */
  async validate(text: string): Promise<void> {
    fs.writeFileSync(paths.singboxConfigCandidate, text, { mode: 0o600 });

    const result = await this.execute(['check', '-c', paths.singboxConfigCandidate, '-D', paths.singboxDir], 20_000);
    if (result.failedToSpawn) {
      throw new SingBoxConfigError(`Бинарь sing-box не найден: ${env.SINGBOX_BIN}`, '');
    }
    if (result.code !== 0) {
      const output = `${result.stdout}\n${result.stderr}`.trim();
      throw new SingBoxConfigError('sing-box отверг конфигурацию', output);
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    this.stopping = false;
    this.backoffMs = 1000;
    this.spawnProcess();

    // Даём процессу шанс упасть на старте (занятый порт, битый сертификат),
    // чтобы вернуть пользователю ошибку сразу, а не «всё хорошо».
    await delay(STARTUP_GRACE_MS);
    if (this.status === 'starting' && this.child && this.child.exitCode === null) {
      this.status = 'running';
      this.startedAt = new Date();
    }
    if (this.status === 'failed') {
      throw new Error(this.lastError ?? 'sing-box не смог запуститься');
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.child = null;
      if (this.status !== 'binary-missing') this.status = 'stopped';
      return;
    }

    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, STOP_TIMEOUT_MS);

      child.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });

      child.kill('SIGTERM');
    });

    this.child = null;
    this.startedAt = null;
    if (this.status !== 'binary-missing') this.status = 'stopped';
  }

  private spawnProcess(): void {
    this.status = 'starting';
    this.lastError = null;

    const child: SingBoxProcess = spawn(env.SINGBOX_BIN, ['run', '-c', paths.singboxConfig, '-D', paths.singboxDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.child = child;

    for (const stream of [child.stdout, child.stderr]) {
      const rl = readline.createInterface({ input: stream });
      rl.on('line', (line) => this.appendLog(line));
    }

    child.on('error', (error: NodeJS.ErrnoException) => {
      this.status = error.code === 'ENOENT' ? 'binary-missing' : 'failed';
      this.lastError = error.code === 'ENOENT' ? `Бинарь sing-box не найден: ${env.SINGBOX_BIN}` : error.message;
      this.appendLog(`ошибка запуска: ${this.lastError}`);
    });

    child.on('exit', (code, signal) => {
      const reason = signal ? `сигнал ${signal}` : `код ${code ?? '?'}`;
      this.child = null;
      this.startedAt = null;

      if (this.stopping) {
        this.status = this.status === 'binary-missing' ? 'binary-missing' : 'stopped';
        return;
      }

      this.status = 'failed';
      this.lastError = `sing-box завершился неожиданно (${reason})`;
      this.appendLog(this.lastError);
      this.scheduleRestart();
    });
  }

  /** Перезапуск с экспоненциальной задержкой: не долбим упавший процесс в цикле. */
  private scheduleRestart(): void {
    if (this.restartTimer) return;

    const delayMs = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.appendLog(`перезапуск через ${Math.round(delayMs / 1000)} с`);

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      this.restarts += 1;
      this.spawnProcess();
      setTimeout(() => {
        if (this.status === 'starting' && this.child && this.child.exitCode === null) {
          this.status = 'running';
          this.startedAt = new Date();
          this.backoffMs = 1000;
        }
      }, STARTUP_GRACE_MS);
    }, delayMs);
  }

  private appendLog(line: string): void {
    const stamped = `${new Date().toISOString()} ${line}`;
    this.logs.push(stamped);
    if (this.logs.length > MAX_LOG_LINES) {
      this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
    }
  }

  /** Разовый запуск sing-box (version/check) со сбором вывода. */
  private execute(
    args: string[],
    timeoutMs: number,
  ): Promise<{ code: number | null; stdout: string; stderr: string; failedToSpawn: boolean }> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;

      const child = spawn(env.SINGBOX_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        resolve({ code: null, stdout, stderr: `${stderr}\nПревышено время ожидания`, failedToSpawn: false });
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr, failedToSpawn: true });
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr, failedToSpawn: false });
      });
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const singbox = new SingBoxSupervisor();
