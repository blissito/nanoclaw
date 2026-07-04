import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

// Some outbound HTTP failures surface as async socket errors that escape their
// caller's try/catch (e.g. undici downloading a remote media URL for Baileys:
// when the origin drops the stream mid-body it emits `terminated: other side
// closed` on the socket, not on the awaited promise). Left to the default
// handler these crash the whole process, and systemd's restart re-runs the
// same pending send → crash loop. Swallow this transient network class; keep
// exiting on everything else so real bugs still restart.
function isTransientSocketError(err: unknown): boolean {
  const e = err as { message?: unknown; code?: unknown; cause?: { code?: unknown } };
  const msg = typeof e?.message === 'string' ? e.message : '';
  const code = typeof e?.code === 'string' ? e.code : '';
  const causeCode = typeof e?.cause?.code === 'string' ? e.cause.code : '';
  const netCodes = new Set([
    'ECONNRESET',
    'UND_ERR_SOCKET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'EPIPE',
  ]);
  return (
    /terminated|other side closed/i.test(msg) ||
    netCodes.has(code) ||
    netCodes.has(causeCode)
  );
}

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  if (isTransientSocketError(err)) {
    logger.error({ err }, 'Uncaught transient socket error (not exiting)');
    return;
  }
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
