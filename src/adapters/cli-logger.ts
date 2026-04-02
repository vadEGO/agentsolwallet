import type { Logger } from '@agentsolwallet/sdk';
import { verbose, warn } from '../output/formatter.js';

export class CliLogger implements Logger {
  verbose(msg: string): void {
    verbose(msg);
  }

  warn(msg: string): void {
    warn(msg);
  }
}
