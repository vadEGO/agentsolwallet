import type { ConfigProvider } from '@agentsolwallet/sdk';
import { getConfigValue } from '../core/config-manager.js';

export class TomlConfig implements ConfigProvider {
  get(key: string): unknown {
    return getConfigValue(key);
  }
}
