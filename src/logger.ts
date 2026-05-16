import pino, { type DestinationStream } from "pino";

export type LogFields = Record<string, unknown>;

type LogMethod = (fields: LogFields, message: string) => void;

export type OttoLogger = {
  child: (fields: LogFields) => OttoLogger;
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
};

export type CreateLoggerOptions = {
  level?: string;
  stream?: DestinationStream;
};

export const noopLogger: OttoLogger = {
  child: () => noopLogger,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function createLogger(options: CreateLoggerOptions = {}): OttoLogger {
  const logger = pino(
    {
      base: null,
      level: options.level ?? process.env.OTTO_LOG_LEVEL ?? "info",
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    options.stream,
  );

  return logger;
}
