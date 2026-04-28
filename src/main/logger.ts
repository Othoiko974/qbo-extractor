import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

// Single append-only log file at <userData>/app.log
// Used for user-visible action tracing (extraction pipeline, API calls, errors).

function logPath(): string {
  return path.join(app.getPath('userData'), 'app.log');
}

function fmt(level: string, scope: string, msg: string, data?: unknown): string {
  const base = `${new Date().toISOString()} [${level}] [${scope}] ${msg}`;
  if (data === undefined) return base;
  try {
    return base + ' | ' + JSON.stringify(data);
  } catch {
    return base + ' | <unserializable>';
  }
}

function write(line: string): void {
  try {
    fs.appendFileSync(logPath(), line + '\n');
  } catch {
    /* ignore */
  }
  // eslint-disable-next-line no-console
  console.log(line);
}

export const log = {
  info(scope: string, msg: string, data?: unknown): void {
    write(fmt('INFO', scope, msg, data));
  },
  warn(scope: string, msg: string, data?: unknown): void {
    write(fmt('WARN', scope, msg, data));
  },
  error(scope: string, msg: string, data?: unknown): void {
    write(fmt('ERR ', scope, msg, data));
  },
  path(): string {
    return logPath();
  },
};
