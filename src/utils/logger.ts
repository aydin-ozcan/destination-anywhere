import * as vscode from 'vscode';

type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

/**
 * Logger backed by a VS Code OutputChannel.
 * Respects the `destinationAnywhere.logLevel` setting.
 */
export class Logger {
  private static outputChannel: vscode.OutputChannel;

  /**
   * Initialize the logger. Must be called once during extension activation.
   */
  static init(context: vscode.ExtensionContext): void {
    Logger.outputChannel = vscode.window.createOutputChannel('Destination Anywhere');
    context.subscriptions.push(Logger.outputChannel);
  }

  private static getConfiguredLevel(): LogLevel {
    const config = vscode.workspace.getConfiguration('destinationAnywhere');
    return (config.get<string>('logLevel') as LogLevel) || 'info';
  }

  private static shouldLog(level: LogLevel): boolean {
    const configured = Logger.getConfiguredLevel();
    return LOG_LEVEL_PRIORITY[level] <= LOG_LEVEL_PRIORITY[configured];
  }

  private static timestamp(): string {
    return new Date().toISOString();
  }

  private static log(level: string, message: string): void {
    if (!Logger.outputChannel) {
      return;
    }
    Logger.outputChannel.appendLine(
      `[${Logger.timestamp()}] [${level}] ${message}`
    );
  }

  /** Log an informational message. */
  static info(message: string): void {
    if (Logger.shouldLog('info')) {
      Logger.log('INFO', message);
    }
  }

  /** Log a warning message. */
  static warn(message: string): void {
    if (Logger.shouldLog('warn')) {
      Logger.log('WARN', message);
    }
  }

  /** Log an error message with an optional Error for stack trace. */
  static error(message: string, error?: Error): void {
    if (Logger.shouldLog('error')) {
      Logger.log('ERROR', message);
      if (error?.stack) {
        Logger.outputChannel.appendLine(error.stack);
      }
    }
  }

  /** Log a debug message (only when logLevel is "debug"). */
  static debug(message: string): void {
    if (Logger.shouldLog('debug')) {
      Logger.log('DEBUG', message);
    }
  }

  /** Reveal the output channel in the VS Code panel. */
  static show(): void {
    Logger.outputChannel?.show();
  }
}
