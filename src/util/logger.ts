export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function format(level: LogLevel, msg: string, meta: Record<string, unknown>): string {
  const entries = Object.entries(meta);
  const tail =
    entries.length === 0
      ? ''
      : ' ' +
        entries.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
  return `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${tail}`;
}

export function createLogger(
  level: LogLevel = 'info',
  bindings: Record<string, unknown> = {},
): Logger {
  const threshold = ORDER[level];
  const emit = (lvl: Exclude<LogLevel, 'silent'>, msg: string, meta?: Record<string, unknown>) => {
    if (ORDER[lvl] < threshold) return;
    const line = format(lvl, msg, { ...bindings, ...meta });
    if (lvl === 'error' || lvl === 'warn') process.stderr.write(line + '\n');
    else process.stderr.write(line + '\n');
  };
  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  };
}

export const silentLogger: Logger = createLogger('silent');
