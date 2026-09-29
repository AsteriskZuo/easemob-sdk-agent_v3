export { createFileLogger } from "./file-logger.js";
export type {
  ConsoleLike,
  LogLevel,
  FileLoggerOptions,
  SharedControl,
} from "./file-logger.js";
export { initLogger, logger, resetForTests } from "./facade.js";
export type { LogFields, CategoryLogger, LoggerInitOptions } from "./facade.js";
