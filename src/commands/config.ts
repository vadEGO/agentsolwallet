import { Command } from 'commander';
import { getConfigValue, setConfigValue, listConfig, getConfigPath } from '../core/config-manager.js';
import { output, success, failure, isJsonMode } from '../output/formatter.js';
import { table } from '../output/table.js';

export function registerConfigCommand(program: Command): void {
  const config = program.command('config').description('Manage CLI configuration');

  config
    .command('set <key> <value>')
    .description('Set a config value (e.g., sol config set rpc.url https://my-rpc.com)')
    .action((key: string, value: string) => {
      try {
        setConfigValue(key, value);
        if (isJsonMode()) {
          output(success({ key, value: getConfigValue(key) }));
        } else {
          console.log(`Set ${key} = ${value}`);
        }
      } catch (err: any) {
        output(failure('CONFIG_SET_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  config
    .command('get <key>')
    .description('Get a config value')
    .action((key: string) => {
      const value = getConfigValue(key);
      if (isJsonMode()) {
        output(success({ key, value }));
      } else if (value === undefined) {
        console.log(`(not set)`);
      } else {
        console.log(String(value));
      }
    });

  config
    .command('list')
    .description('List all config values')
    .action(() => {
      const values = listConfig();
      if (isJsonMode()) {
        output(success(values));
      } else {
        const entries = Object.entries(values);
        if (entries.length === 0) {
          console.log('No configuration set. Use: sol config set <key> <value>');
        } else {
          console.log(table(
            entries.map(([key, value]) => ({ key, value: String(value) })),
            [
              { key: 'key', header: 'Key' },
              { key: 'value', header: 'Value' },
            ]
          ));
        }
      }
    });

  config
    .command('path')
    .description('Show config file path')
    .action(() => {
      const path = getConfigPath();
      if (isJsonMode()) {
        output(success({ path }));
      } else {
        console.log(path);
      }
    });
}
