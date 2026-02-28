import type { SignerProvider } from '@solana-compass/sdk';
import type { TransactionSigner } from '@solana/kit';
import { loadSigner, loadSignerRawBytes } from '../core/wallet-manager.js';

export class FileSigner implements SignerProvider {
  async getSigner(identifier: string): Promise<TransactionSigner> {
    return loadSigner(identifier);
  }

  async getAddress(identifier: string): Promise<string> {
    const signer = await loadSigner(identifier);
    return signer.address;
  }

  getRawBytes(identifier: string): Uint8Array {
    return loadSignerRawBytes(identifier);
  }
}
