import pino from "pino";

// Central logger: LOG_LEVEL gates verbosity (debug = per-match/metered spam, info =
// lifecycle + sampled heartbeat, warn/error for problems). LOG_PRETTY=1 renders
// human-readable lines for terminal use; default output is structured JSON.
const level = process.env.LOG_LEVEL ?? "info";
const pretty = process.env.LOG_PRETTY === "1";

export const logger = pino({
  level,
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(pretty
    ? {
        transport: {
          target: "pino-pretty",
          options: { translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" },
        },
      }
    : {}),
});
