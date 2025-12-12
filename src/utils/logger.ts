import { LogMetadata } from '../types/index.js';

enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR',
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: '\x1b[36m', // Cyan
  [LogLevel.INFO]: '\x1b[32m', // Green
  [LogLevel.WARN]: '\x1b[33m', // Yellow
  [LogLevel.ERROR]: '\x1b[31m', // Red
};

const RESET_COLOR = '\x1b[0m';

const LEVEL_MAP: Record<string, LogLevel> = {
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
};

class Logger {
  private level: LogLevel;
  private isDevelopment: boolean;

  constructor() {
    // Read directly from environment variables to avoid config import
    const levelName = process.env.LOG_LEVEL || 'info';
    this.level = LEVEL_MAP[levelName.toLowerCase()] ?? LogLevel.INFO;
    this.isDevelopment = process.env.NODE_ENV !== 'production';
  }

  private shouldLog(level: LogLevel): boolean {
    return level >= this.level;
  }

  private formatMessage(level: LogLevel, message: string, meta?: LogMetadata): string {
    const timestamp = new Date().toISOString();
    const levelName = LEVEL_NAMES[level];

    if (this.isDevelopment) {
      // Pretty colored output for development
      const color = LEVEL_COLORS[level];
      const metaStr = meta ? `\n  ${JSON.stringify(meta, null, 2)}` : '';
      return `${color}[${timestamp}] ${levelName}${RESET_COLOR}: ${message}${metaStr}`;
    } else {
      // JSON output for production (easier to parse in logs)
      const logObject = {
        timestamp,
        level: levelName,
        message,
        ...meta,
      };
      return JSON.stringify(logObject);
    }
  }

  debug(message: string, meta?: LogMetadata) {
    if (this.shouldLog(LogLevel.DEBUG)) {
      console.log(this.formatMessage(LogLevel.DEBUG, message, meta));
    }
  }

  info(message: string, meta?: LogMetadata) {
    if (this.shouldLog(LogLevel.INFO)) {
      console.log(this.formatMessage(LogLevel.INFO, message, meta));
    }
  }

  warn(message: string, meta?: LogMetadata) {
    if (this.shouldLog(LogLevel.WARN)) {
      console.warn(this.formatMessage(LogLevel.WARN, message, meta));
    }
  }

  error(message: string, meta?: LogMetadata) {
    if (this.shouldLog(LogLevel.ERROR)) {
      console.error(this.formatMessage(LogLevel.ERROR, message, meta));
    }
  }

  // Convenience methods with emojis for better readability
  success(message: string, meta?: LogMetadata) {
    this.info(`✅ ${message}`, meta);
  }

  failure(message: string, meta?: LogMetadata) {
    this.error(`❌ ${message}`, meta);
  }

  processing(message: string, meta?: LogMetadata) {
    this.info(`⚙️  ${message}`, meta);
  }

  complete(message: string, meta?: LogMetadata) {
    this.success(`🎉 ${message}`, meta);
  }
}

// Export singleton instance
export const logger = new Logger();
