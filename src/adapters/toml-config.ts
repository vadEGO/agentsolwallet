import type { ConfigProvider } from '@solana-compass/sdk';
import { getConfigValue } from '../core/config-manager.js';

export class TomlConfig implements ConfigProvider {
  get(key: string): unknown {
    return getConfigValue(key);
  }
}
