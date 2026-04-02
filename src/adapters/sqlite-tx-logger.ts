import type { TransactionLogger, TxLogEntry } from '@agentsolwallet/sdk';
import { logTransaction, updateTransactionStatus } from '../core/transaction.js';

export class SqliteTxLogger implements TransactionLogger {
  log(entry: TxLogEntry): void {
    logTransaction(entry);
  }

  updateStatus(signature: string, status: string, error?: string): void {
    updateTransactionStatus(signature, status, error);
  }
}
