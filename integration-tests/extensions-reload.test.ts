/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it, describe, beforeEach, afterEach } from 'vitest';
import { TestRig } from './test-helper.js';
import { TestMcpServer } from './test-mcp-server.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { safeJsonStringify } from '@google/gemini-cli-core/src/utils/safeJsonStringify.js';
import { env } from 'node:process';
import { platform } from 'node:os';

import stripAnsi from 'strip-ansi';

const itIf = (condition: boolean) => (condition ? it : it.skip);

describe('extension reloading', () => {
  const sandboxEnv = env['GEMINI_SANDBOX'];
  let rig: TestRig;
  let testExtensionName: string;

  beforeEach(() => {
    rig = new TestRig();
    testExtensionName = `test-ext-${Math.random().toString(36).substring(7)}`;
  });

  afterEach(async () => {
    if (rig) {
      try {
        await rig.runCommand(['extensions', 'uninstall', testExtensionName]);
      } catch {
        /* ignore */
      }
      await rig.cleanup();
    }
  });

  // Fails in linux non-sandbox e2e tests
  // TODO(#14527): Re-enable this once fixed
  // Fails in sandbox mode, can't check for local extension updates.
  itIf(
    (!sandboxEnv || sandboxEnv === 'false') &&
      platform() !== 'win32' &&
      platform() !== 'linux',
  )(
    'installs a local extension, updates it, checks it was reloaded properly',
    async () => {
      const serverA = new TestMcpServer();
      const portA = await serverA.start({
        hello: () => ({ content: [{ type: 'text', text: 'world' }] }),
      });
      const extension = {
        name: testExtensionName,
        version: '0.0.1',
        mcpServers: {
          'test-server': {
            httpUrl: `http://localhost:${portA}/mcp`,
          },
        },
      };

      rig.setup('extension reload test', {
        settings: {
          experimental: { extensionReloading: true },
        },
      });
      const testServerPath = join(rig.testDir!, 'gemini-extension.json');
      writeFileSync(testServerPath, safeJsonStringify(extension, 2));

      const result = await rig.runCommand(
        ['extensions', 'install', `${rig.testDir!}`],
        { stdin: 'y\n' },
      );
      expect(result).toContain(testExtensionName);

      // Now create the update, but its not installed yet
      const serverB = new TestMcpServer();
      const portB = await serverB.start({
        goodbye: () => ({ content: [{ type: 'text', text: 'world' }] }),
      });
      extension.version = '0.0.2';
      extension.mcpServers['test-server'].httpUrl =
        `http://localhost:${portB}/mcp`;
      writeFileSync(testServerPath, safeJsonStringify(extension, 2));

      // Start the CLI.
      const run = await rig.runInteractive('--debug');
      await run.expectText('You have 1 extension with an update available');
      // See the outdated extension
      await run.sendText('/extensions list');
      await run.type('\r');
      await run.expectText(
        `${testExtensionName} (v0.0.1) - active (update available)`,
      );
      // Wait for the UI to settle and retry the command until we see the update
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Poll for the updated list
      await rig.pollCommand(
        () => run.sendKeys('\u0015/mcp list\r'),
        () => {
          const output = stripAnsi(run.output);
          return (
            output.includes(
              `test-server (from ${testExtensionName}) - Ready (1 tool)`,
            ) && output.includes('- hello')
          );
        },
        30000, // 30s timeout
      );

      // Update the extension, expect the list to update, and mcp servers as well.
      await run.sendKeys(`\u0015/extensions update ${testExtensionName}`);
      await run.expectText(`/extensions update ${testExtensionName}`);
      await run.sendKeys('\r');
      await new Promise((resolve) => setTimeout(resolve, 500));
      await run.sendKeys('\r');
      await run.expectText(
        ` * test-server (remote): http://localhost:${portB}/mcp`,
      );
      await run.type('\r'); // consent
      await run.expectText(
        `Extension "${testExtensionName}" successfully updated: 0.0.1 → 0.0.2`,
      );

      // Poll for the updated extension version
      await rig.pollCommand(
        () => run.sendKeys('\u0015/extensions list\r'),
        () =>
          stripAnsi(run.output).includes(
            `${testExtensionName} (v0.0.2) - active (updated)`,
          ),
        30000,
      );

      // Poll for the updated mcp tool
      await rig.pollCommand(
        () => run.sendKeys('\u0015/mcp list\r'),
        () => {
          const output = stripAnsi(run.output);
          return (
            output.includes(
              `test-server (from ${testExtensionName}) - Ready (1 tool)`,
            ) && output.includes('- goodbye')
          );
        },
        30000,
      );

      await run.sendText('/quit');
      await run.sendKeys('\r');

      // Clean things up.
      await serverA.stop();
      await serverB.stop();
    },
  );

  itIf(
    (!sandboxEnv || sandboxEnv === 'false') &&
      platform() !== 'win32' &&
      platform() !== 'linux',
  )(
    'installs a local extension with hooks, updates them, checks they were reloaded',
    async () => {
      rig.setup('extension hook reload test', {
        settings: {
          general: { disableAutoUpdate: true },
          experimental: { extensionReloading: true },
          tools: { enableHooks: true },
        },
      });

      const extensionDir = join(rig.testDir!, testExtensionName);
      mkdirSync(extensionDir, { recursive: true });
      mkdirSync(join(extensionDir, 'hooks'), { recursive: true });

      const createHook = (version: string) => {
        const extensionConfig = {
          name: testExtensionName,
          version,
        };
        writeFileSync(
          join(extensionDir, 'gemini-extension.json'),
          safeJsonStringify(extensionConfig, 2),
        );

        const command = `echo '{"decision": "block", "reason": "Hook Version ${version}"}'`;
        const initialHooks = {
          hooks: {
            BeforeAgent: [
              {
                hooks: [{ type: 'command', command }],
              },
            ],
          },
        };
        writeFileSync(
          join(extensionDir, 'hooks', 'hooks.json'),
          safeJsonStringify(initialHooks, 2),
        );
      };

      createHook('0.0.1');

      const installResult = await rig.runCommand(
        ['extensions', 'install', extensionDir],
        { stdin: 'y\n' },
      );
      expect(installResult).toContain(testExtensionName);

      // install version 0.0.2 of the hook extension
      createHook('0.0.2');

      const run = await rig.runInteractive('--debug');
      await run.expectText('You have 1 extension with an update available');

      // Trigger hook V1 by sending a message and check for the block reason
      await run.sendKeys('\u0015hello\r');
      await run.expectText('Hook Version 0.0.1');

      // Update the extension
      await run.type(`/extensions update ${testExtensionName}`);
      await run.sendKeys('\r');
      await new Promise((resolve) => setTimeout(resolve, 500));
      await run.sendKeys('\r');
      await run.expectText(
        `Extension "${testExtensionName}" successfully updated`,
      );
      await run.expectText('0.0.2');

      // Solve the mystery: Wait for the extension list to reflect the new version
      // to ensure the reload has actually completed internally.
      await rig.pollCommand(
        async () => {
          await run.sendKeys('\u0015/extensions list\r');
        },
        () => stripAnsi(run.output).includes(`${testExtensionName} (v0.0.2)`),
      );

      // Trigger hook V2 by sending a message and check for the block reason
      await run.sendKeys('\u0015hello again\r');
      await run.expectText('Hook Version 0.0.2');

      await run.sendKeys('\u0015/quit\r');
    },
  );
});
