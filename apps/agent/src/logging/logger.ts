import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from 'node:fs';
import { dirname } from 'node:path';
import pino, { type Logger, destination, multistream, type StreamEntry } from 'pino';
import pretty from 'pino-pretty';

let _root: Logger | undefined;
let _level: string = 'info';
let _initialized = false;
/** 持有文件流，避免被 GC 提前关掉 */
let _fileStream: WriteStream | undefined;

export interface LoggingConfig {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  file: string;
  pretty: boolean;
  /** 是否记录 HTTP access log；默认 false（/health 轮询会刷屏） */
  http: boolean;
}

const PRETTY_TIME = 'SYS:yyyy-mm-dd HH:MM:ss.l';
/** 已在 message 里展示的字段不再重复展开 */
const PRETTY_IGNORE = 'pid,hostname,taskId';

function createPrettyStream(opts: { colorize: boolean; destination?: number | WriteStream }) {
  return pretty({
    ...opts,
    translateTime: PRETTY_TIME,
    ignore: PRETTY_IGNORE,
    singleLine: true,
    // 避免把普通字符串字段当 Error 多行展开
    errorLikeObjectKeys: [],
    messageFormat: prettyMessageFormat,
  });
}

export function createLogger(cfg: LoggingConfig): Logger {
  _level = cfg.level;
  _initialized = true;

  const streams: StreamEntry[] = [];

  // stream 固定 trace，过滤只靠 logger.level，便于运行时 setLogLevel 热切换
  if (cfg.pretty) {
    streams.push({
      level: 'trace',
      stream: createPrettyStream({ colorize: true }),
    });
  } else {
    streams.push({ level: 'trace', stream: destination(1) });
  }

  if (cfg.file && canWriteLogFile(cfg.file)) {
    mkdirSync(dirname(cfg.file), { recursive: true });
    rotateLogFileIfNeeded(cfg.file);
    _fileStream = createWriteStream(cfg.file, { flags: 'a' });
    _fileStream.on('error', (err) => {
      console.error('[logger] file stream error:', err);
    });
    streams.push({
      level: 'trace',
      stream: createPrettyStream({ colorize: false, destination: _fileStream }),
    });
  }

  const baseOptions = {
    level: cfg.level,
    // 结构化对象里用 ISO；pretty 再显示本地可读时间
    timestamp: pino.stdTimeFunctions.isoTime,
    base: undefined,
    formatters: {
      level(label: string) {
        return { level: label };
      },
    },
  };

  _root =
    streams.length === 1
      ? pino(baseOptions, streams[0]!.stream)
      : pino(baseOptions, multistream(streams));

  return _root;
}

/** 单行消息：任务相关时前置 `task=xxxx`（模块名由 pino-pretty 的 (name) 展示） */
function prettyMessageFormat(log: Record<string, unknown>, messageKey = 'msg'): string {
  const msg = String(log[messageKey] ?? '');
  const task =
    typeof log.taskId === 'string' && log.taskId
      ? `task=${shortId(String(log.taskId))} `
      : '';
  return `${task}${msg}`;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
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

/** 简单滚动：超过 10MB 时 file → file.1 … 最多 5 份 */
function rotateLogFileIfNeeded(file: string, maxBytes = 10 * 1024 * 1024, keep = 5): void {
  try {
    if (!existsSync(file)) return;
    if (statSync(file).size < maxBytes) return;
    const oldest = `${file}.${keep}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = keep - 1; i >= 1; i -= 1) {
      const src = `${file}.${i}`;
      if (existsSync(src)) renameSync(src, `${file}.${i + 1}`);
    }
    renameSync(file, `${file}.1`);
  } catch (err) {
    console.error('[logger] log rotate skipped:', err);
  }
}

export function getLogger(name: string): Logger {
  return ensureRoot().child({ name });
}

export function getRootLogger(): Logger {
  return ensureRoot();
}

export type LogLevelName = LoggingConfig['level'];

/** 运行时调整日志等级（设置页 / 持久化加载后调用）。 */
export function setLogLevel(level: LogLevelName): void {
  _level = level;
  if (_root) {
    _root.level = level;
  }
}

export function getLogLevel(): LogLevelName {
  return _level as LogLevelName;
}

function ensureRoot(): Logger {
  if (!_root) {
    _root = _initialized
      ? pino(
          {
            level: _level,
            timestamp: pino.stdTimeFunctions.isoTime,
            base: undefined,
            formatters: {
              level(label) {
                return { level: label };
              },
            },
          },
          destination(1),
        )
      : pino({ level: 'silent' }, destination(1));
  }
  return _root;
}
