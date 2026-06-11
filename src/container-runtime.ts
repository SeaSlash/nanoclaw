/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'container';

/** Label applied to NanoClaw-managed containers for safer cleanup. */
export const NANOCLAW_MANAGED_LABEL = 'com.nanoclaw.managed';

const APPLE_CONTAINER_BRIDGE_NAME = 'bridge100';
const APPLE_CONTAINER_DEFAULT_GATEWAY = '192.168.64.1';

function getAppleContainerBridgeAddress(): string | null {
  const bridge = os.networkInterfaces()[APPLE_CONTAINER_BRIDGE_NAME];
  const ipv4 = bridge?.find((addr) => addr.family === 'IPv4');
  return ipv4?.address || null;
}

/** Hostname or IP containers use to reach the host machine. */
export function detectContainerHostGateway(): string {
  if (os.platform() === 'darwin') {
    return getAppleContainerBridgeAddress() || APPLE_CONTAINER_DEFAULT_GATEWAY;
  }
  return 'host.docker.internal';
}

export const CONTAINER_HOST_GATEWAY =
  process.env.CONTAINER_HOST_GATEWAY || detectContainerHostGateway();

/**
 * Address the credential proxy binds to.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

export function detectProxyBindHost(): string {
  if (os.platform() === 'darwin') {
    // Bind only on the Apple Container bridge when it's available so the
    // credential proxy isn't exposed on every host interface.
    return getAppleContainerBridgeAddress() || '0.0.0.0';
  }

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  // Check /proc filesystem, not env vars — WSL_DISTRO_NAME isn't set under systemd.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to the docker0 bridge IP instead of 0.0.0.0
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '0.0.0.0';
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return [
    '--mount',
    `type=bind,source=${hostPath},target=${containerPath},readonly`,
  ];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} system status`, { stdio: 'pipe' });
    logger.debug('Container runtime already running');
  } catch {
    logger.info('Starting container runtime...');
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} system start`, {
        stdio: 'pipe',
        timeout: 30000,
      });
      logger.info('Container runtime started');
    } catch (err) {
      logger.error({ err }, 'Failed to start container runtime');
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: Container runtime failed to start                      ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Agents cannot run without a container runtime. To fix:        ║',
      );
      console.error(
        '║  1. Ensure Apple Container is installed                        ║',
      );
      console.error(
        '║  2. Run: container system start                                ║',
      );
      console.error(
        '║  3. Restart NanoClaw                                           ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('Container runtime is required but failed to start');
    }
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(`${CONTAINER_RUNTIME_BIN} ls --format json`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers: {
      status: string;
      configuration: {
        id: string;
        labels?: Record<string, string>;
      };
    }[] =
      JSON.parse(output || '[]');
    const currentHostname = os.hostname();
    const orphans = containers
      .filter(
        (c) =>
          c.status === 'running' &&
          c.configuration.id !== currentHostname &&
          (c.configuration.labels?.[NANOCLAW_MANAGED_LABEL] === 'true' ||
            c.configuration.id.startsWith('nanoclaw-')),
      )
      .map((c) => c.configuration.id);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
