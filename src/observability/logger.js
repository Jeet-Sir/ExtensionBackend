// ─────────────────────────────────────────────
// Structured logger (pino) – observability layer
// Pretty, colorized, minimal noise (no hostname/pid in dev)
// ─────────────────────────────────────────────

import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';
const usePretty = isDev || process.env.LOG_PRETTY === 'true';

const baseOptions = {
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  base: null, // no hostname, pid, etc.
};

const transport =
  usePretty
    ? pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'hostname,pid',
          singleLine: false,
        },
      })
    : undefined;

export const logger = transport ? pino(baseOptions, transport) : pino(baseOptions);

export default logger;
