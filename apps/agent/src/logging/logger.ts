import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import pino, { type Logger, transport, destination } from 'pino';

let _root: Logger | undefined;
let _level: string = 'info';
let _initialized = false;

interface TransportTarget {
  target: string;
  level?: string;
  options?: Record<string, unknown>;
}

export interface LoggingConfig {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  file: string;
  pretty: boolean;
}

export function createLogger(cfg: LoggingConfig): Logger {
  _level = cfg.level;
  _initialized = true;

  const targets: TransportTarget[] = [];

  if (cfg.pretty) {
    targets.push({
      target: 'pino-pretty',
      level: cfg.level,
      options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
    });
  } else {
    targets.push({ target: 'pino/file', level: cfg.level, options: { destination: 1 } });
  }

  if (cfg.file && canWriteLogFile(cfg.file)) {
    mkdirSync(dirname(cfg.file), { recursive: true });
    targets.push({
      target: 'pino-roll',
      level: cfg.level,
      options: { file: cfg.file, size: '10m', limit: { count: 5 } },
    });
  }

  if (targets.length > 1) {
    const stream = transport({ targets });
    stream.on('error', (err) => {
      console.error('[logger] file transport disabled after error:', err);
    });
    _root = pino({ level: cfg.level }, stream);
  } else {
    _root = pino({ level: cfg.level }, destination(1));
  }

  return _root;
}

function canWriteLogFile(file: string): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const fd = openSync(file, 'a');
    closeSync(fd);
    return true;
  } catch (err) {
    console.error('[logger] file logging disabled:', err);
    return false;
  }
}

export function getLogger(name: string): Logger {
  return ensureRoot().child({ name });
}

export function getRootLogger(): Logger {
  return ensureRoot();
}

function ensureRoot(): Logger {
  if (!_root) {
    _root = _initialized
      ? pino({ level: _level }, destination(1))
      : pino({ level: 'silent' }, destination(1));
  }
  return _root;
}
