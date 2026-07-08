const { spawn } = require('child_process');
const EventEmitter = require('events');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

/**
 * Create temp Docker config with registry auth if tokens available
 * @returns {Promise<{configDir: string|null, cleanup: Function}>}
 */
async function createDockerAuthConfig() {
  try {
    const mosService = require('../services/mos.service');
    const tokens = await mosService.getTokens();
    if (!tokens.dockerhub && !tokens.github) {
      return { configDir: null, cleanup: () => {} };
    }

    const auths = {};
    if (tokens.dockerhub) {
      auths['https://index.docker.io/v1/'] = { auth: Buffer.from(tokens.dockerhub).toString('base64') };
    }
    if (tokens.github) {
      auths['ghcr.io'] = { auth: Buffer.from(`_:${tokens.github}`).toString('base64') };
    }

    const configDir = '/var/mos/docker-auth';
    const configFile = path.join(configDir, 'config.json');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(configFile, JSON.stringify({ auths }));

    return {
      configDir,
      cleanup: async () => {
        try { await fs.unlink(configFile); } catch {}
      }
    };
  } catch {
    return { configDir: null, cleanup: () => {} };
  }
}

/**
 * Strip ANSI escape codes from string
 * @param {string} str - String potentially containing ANSI codes
 * @returns {string} Clean string without ANSI codes
 */
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

/**
 * Format bytes to human-readable string with binary/decimal support
 * @param {number} bytes - Bytes to format
 * @param {string} byteFormat - 'binary' or 'decimal'
 * @returns {string} Formatted string
 */
function formatBytes(bytes, byteFormat = 'binary') {
  if (!bytes || bytes <= 0 || !isFinite(bytes)) return '0 B';

  const isBinary = byteFormat === 'binary';
  const k = isBinary ? 1024 : 1000;
  const sizes = isBinary
    ? ['B', 'KiB', 'MiB', 'GiB', 'TiB']
    : ['B', 'KB', 'MB', 'GB', 'TB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Format memory bytes - always binary (GiB/MiB) for RAM
 * @param {number} bytes - Bytes to format
 * @returns {string} Formatted string
 */
function formatMemoryBytes(bytes) {
  if (!bytes || bytes <= 0 || !isFinite(bytes)) return '0 B';

  const k = 1024; // Always binary for memory
  const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Calculate and format Docker container stats
 * @param {Object} raw - Raw stats from Docker API
 * @param {Object} user - User object with byte_format preference
 * @returns {Object} Calculated and formatted stats
 */
function calculateContainerStats(raw, user = null) {
  const byteFormat = user?.byte_format || 'binary';

  // CPU calculation
  let cpuPercent = 0;
  if (raw.cpu_stats && raw.precpu_stats) {
    const cpuDelta = raw.cpu_stats.cpu_usage.total_usage - raw.precpu_stats.cpu_usage.total_usage;
    const systemDelta = raw.cpu_stats.system_cpu_usage - raw.precpu_stats.system_cpu_usage;
    if (systemDelta > 0 && cpuDelta > 0) {
      // Don't multiply by CPU cores
      cpuPercent = (cpuDelta / systemDelta) * 100;
    }
  }

  // Memory calculation (always binary for RAM) - matches docker stats CLI output
  let memoryUsage = 0;
  let memoryLimit = 0;
  let memoryPercent = 0;
  if (raw.memory_stats) {
    const inactiveFile = raw.memory_stats.stats?.inactive_file || 0;
    memoryUsage = raw.memory_stats.usage - inactiveFile;
    memoryLimit = raw.memory_stats.limit;
    if (memoryLimit > 0) {
      memoryPercent = (memoryUsage / memoryLimit) * 100;
    }
  }

  // Network calculation
  let networkRx = 0;
  let networkTx = 0;
  if (raw.networks) {
    for (const iface of Object.values(raw.networks)) {
      networkRx += iface.rx_bytes || 0;
      networkTx += iface.tx_bytes || 0;
    }
  }
  const networkTotal = networkRx + networkTx;

  // Block I/O calculation
  let blockRead = 0;
  let blockWrite = 0;
  if (raw.blkio_stats?.io_service_bytes_recursive) {
    for (const entry of raw.blkio_stats.io_service_bytes_recursive) {
      if (entry.op === 'read' || entry.op === 'Read') {
        blockRead += entry.value || 0;
      } else if (entry.op === 'write' || entry.op === 'Write') {
        blockWrite += entry.value || 0;
      }
    }
  }
  const blockTotal = blockRead + blockWrite;

  // PIDs
  const pids = raw.pids_stats?.current || 0;

  return {
    cpu_percent: parseFloat(cpuPercent.toFixed(2)),
    memory_percent: parseFloat(memoryPercent.toFixed(2)),
    memory_usage: memoryUsage,
    memory_usage_human: formatMemoryBytes(memoryUsage),
    memory_limit: memoryLimit,
    memory_limit_human: formatMemoryBytes(memoryLimit),
    network_rx: networkRx,
    network_rx_human: formatBytes(networkRx, byteFormat),
    network_tx: networkTx,
    network_tx_human: formatBytes(networkTx, byteFormat),
    network_total: networkTotal,
    network_total_human: formatBytes(networkTotal, byteFormat),
    block_read: blockRead,
    block_read_human: formatBytes(blockRead, byteFormat),
    block_write: blockWrite,
    block_write_human: formatBytes(blockWrite, byteFormat),
    block_total: blockTotal,
    block_total_human: formatBytes(blockTotal, byteFormat),
    pids
  };
}

/**
 * Docker WebSocket Manager - Handles real-time Docker operations with streaming output
 * @class DockerWebSocketManager
 * @extends EventEmitter
 *
 * For API documentation and usage examples, see: /routes/websocket/docker.websocket.routes.js
 */
class DockerWebSocketManager extends EventEmitter {
  constructor(io, dockerService, dockerComposeService) {
    super();
    this.io = io;
    this.dockerService = dockerService;
    this.dockerComposeService = dockerComposeService;
    this.activeOperations = new Map(); // operationId -> { process, type, startTime, operation, params }
    this.statsStreams = new Map(); // socketId -> Map(operationId -> { process, containerName })
  }

  /**
   * Handle WebSocket connection for Docker operations
   */
  handleConnection(socket) {
    console.log(`Docker WebSocket client connected: ${socket.id}`);

    // Start a Docker operation (pull, upgrade, create, etc.)
    socket.on('docker', async (data) => {
      try {
        const { token, operation, params } = data;

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          this.sendUpdate(socket, null, 'error', { message: authResult.message });
          return;
        }

        // Check if user is admin
        if (authResult.user.role !== 'admin') {
          this.sendUpdate(socket, null, 'error', { message: 'Admin role required for Docker operations' });
          return;
        }

        // Restricted tokens need 'write' permission for Docker operations
        const { isActionAllowed } = require('../middleware/auth.middleware');
        if (authResult.user.isAdminToken && !isActionAllowed(authResult.user.permissions, 'docker', 'write')) {
          this.sendUpdate(socket, null, 'error', { message: "Access denied. This token does not have 'write' permission for 'docker'." });
          return;
        }

        socket.userId = authResult.user.userId;
        socket.userRole = authResult.user.role;
        socket.user = authResult.user;

        console.log(`Client ${socket.id} starting Docker operation: ${operation}`);

        // Generate unique operation ID
        const operationId = `${operation}-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;

        // Join operation room so client can receive updates even after reconnect
        socket.join(`operation-${operationId}`);

        // Execute the operation based on type
        switch (operation) {
          case 'upgrade':
            await this.executeUpgrade(operationId, params);
            break;
          case 'upgrade-group':
            await this.executeUpgradeGroup(operationId, params);
            break;
          case 'pull':
            await this.executePull(operationId, params);
            break;
          case 'create':
            await this.executeCreate(operationId, params);
            break;
          case 'check-updates':
            await this.executeCheckUpdates(operationId, params);
            break;
          case 'compose-create':
            await this.executeComposeCreate(operationId, params);
            break;
          case 'compose-update':
            await this.executeComposeUpdate(operationId, params);
            break;
          case 'compose-pull':
            await this.executeComposePull(operationId, params);
            break;
          case 'compose-delete':
            await this.executeComposeDelete(operationId, params);
            break;
          case 'compose-upgrade':
            await this.executeComposeUpgrade(operationId, params);
            break;
          default:
            this.sendUpdate(socket, operationId, 'error', {
              message: `Unknown operation: ${operation}`
            });
        }

      } catch (error) {
        console.error('Error in docker event:', error);
        this.sendUpdate(socket, null, 'error', { message: error.message });
      }
    });

    // Get list of active operations
    socket.on('docker-get-operations', async (data) => {
      try {
        const { token } = data || {};

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          this.sendUpdate(socket, null, 'error', { message: authResult.message });
          return;
        }

        const operations = [];
        for (const [operationId, operation] of this.activeOperations.entries()) {
          operations.push({
            operationId,
            type: operation.type,
            operation: operation.operation,
            params: operation.params,
            duration: Date.now() - operation.startTime,
            status: 'running'
          });
        }

        socket.emit('docker-update', {
          status: 'operations-list',
          operations
        });

        // Join all active operation rooms so client receives future updates
        for (const operationId of this.activeOperations.keys()) {
          socket.join(`operation-${operationId}`);
        }

      } catch (error) {
        console.error('Error in docker-get-operations:', error);
        this.sendUpdate(socket, null, 'error', { message: 'Failed to get operations' });
      }
    });

    // Cancel an ongoing operation
    socket.on('docker-cancel', async (data) => {
      try {
        const { token, operationId } = data;

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          this.sendUpdate(socket, operationId, 'error', { message: authResult.message });
          return;
        }

        // Check if user is admin
        if (authResult.user.role !== 'admin') {
          this.sendUpdate(socket, operationId, 'error', { message: 'Admin role required' });
          return;
        }

        // Restricted tokens need 'write' permission to cancel operations
        const { isActionAllowed } = require('../middleware/auth.middleware');
        if (authResult.user.isAdminToken && !isActionAllowed(authResult.user.permissions, 'docker', 'write')) {
          this.sendUpdate(socket, operationId, 'error', { message: "Access denied. This token does not have 'write' permission for 'docker'." });
          return;
        }

        await this.cancelOperation(operationId);

      } catch (error) {
        console.error('Error in docker-cancel:', error);
        this.sendUpdate(socket, null, 'error', { message: 'Failed to cancel operation' });
      }
    });

    // Subscribe to container stats stream
    socket.on('docker-stats-subscribe', async (data) => {
      try {
        const { token, params } = data;
        const { name } = params || {};

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          this.sendUpdate(socket, null, 'error', { message: authResult.message });
          return;
        }

        // Check if user is admin
        if (authResult.user.role !== 'admin') {
          this.sendUpdate(socket, null, 'error', { message: 'Admin role required for Docker operations' });
          return;
        }

        if (!name) {
          this.sendUpdate(socket, null, 'error', { message: 'Container name is required for stats subscription' });
          return;
        }

        console.log(`Client ${socket.id} subscribing to stats for container: ${name}`);

        // Generate unique operation ID
        const operationId = `stats-${name}-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;

        // Join operation room
        socket.join(`operation-${operationId}`);

        // Execute stats stream with user for byte_format preference
        await this.executeContainerStats(socket.id, operationId, name, authResult.user);

      } catch (error) {
        console.error('Error in docker-stats-subscribe:', error);
        this.sendUpdate(socket, null, 'error', { message: error.message });
      }
    });

    // Unsubscribe from container stats stream
    socket.on('docker-stats-unsubscribe', async (data) => {
      try {
        const { token, operationId } = data;

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          this.sendUpdate(socket, operationId, 'error', { message: authResult.message });
          return;
        }

        if (!operationId) {
          this.sendUpdate(socket, null, 'error', { message: 'Operation ID is required for stats unsubscribe' });
          return;
        }

        console.log(`Client ${socket.id} unsubscribing from stats: ${operationId}`);

        await this.stopContainerStats(socket.id, operationId);

      } catch (error) {
        console.error('Error in docker-stats-unsubscribe:', error);
        this.sendUpdate(socket, null, 'error', { message: 'Failed to unsubscribe from stats' });
      }
    });

    // Handle disconnect - cleanup stats streams but DON'T kill operations
    socket.on('disconnect', () => {
      console.log(`Docker WebSocket client disconnected: ${socket.id}`);

      // Stop all stats streams for this socket
      this.cleanupSocketStatsStreams(socket.id);

      // Don't cleanup operations - they continue running!
    });
  }

  /**
   * Send update to operation room (all connected clients for this operation)
   */
  sendUpdate(target, operationId, status, data = {}) {
    const payload = {
      status,
      operationId,
      timestamp: Date.now(),
      ...data
    };

    if (operationId) {
      // Broadcast to all clients in this operation's room
      this.io.to(`operation-${operationId}`).emit('docker-update', payload);
    } else {
      // Send only to specific socket if no operationId
      if (target && target.emit) {
        target.emit('docker-update', payload);
      }
    }
  }

  /**
   * Execute Docker upgrade operation with streaming output
   */
  async executeUpgrade(operationId, params) {
    const { name, force_update } = params || {};

    this.sendUpdate(null, operationId, 'started', {
      operation: 'upgrade',
      name: name || 'all containers'
    });

    try {
      // If no specific container name is given and not forced, only update containers with available updates
      if (!name && !force_update) {
        // Get Docker containers with updates
        const containers = await this.dockerService.getDockerImages();
        const containersWithUpdates = containers.filter(c => c.update_available && !c.no_autoupdate);

        // Log skipped containers with no_autoupdate
        const skippedContainers = containers.filter(c => c.update_available && c.no_autoupdate);
        for (const container of skippedContainers) {
          this.sendUpdate(null, operationId, 'running', {
            output: `INFO: Auto update for container ${container.name} disabled, skipping\n`,
            stream: 'stdout'
          });
        }

        // Get Compose stacks with updates
        let stacksWithUpdates = [];
        let skippedStacks = [];
        try {
          const composeContainers = await this.dockerComposeService._readComposeContainers();
          stacksWithUpdates = composeContainers.filter(stack => {
            if (!stack.services) return false;
            if (stack.no_autoupdate === true) return false;
            return Object.values(stack.services).some(service =>
              service.local !== service.remote
            );
          });

          // Log skipped stacks with no_autoupdate
          skippedStacks = composeContainers.filter(stack => {
            if (!stack.services || stack.no_autoupdate !== true) return false;
            return Object.values(stack.services).some(service =>
              service.local !== service.remote
            );
          });
          for (const stack of skippedStacks) {
            this.sendUpdate(null, operationId, 'running', {
              output: `INFO: Auto update for Stack ${stack.stack} disabled, skipping\n`,
              stream: 'stdout'
            });
          }
        } catch (err) {
          // compose-containers file doesn't exist or error reading
        }

        const totalUpdates = containersWithUpdates.length + stacksWithUpdates.length;

        if (totalUpdates === 0) {
          const skippedCount = skippedContainers.length + skippedStacks.length;
          if (skippedCount === 0) {
            this.sendUpdate(null, operationId, 'running', {
              output: `All containers up to date.\n`,
              stream: 'stdout'
            });
          }
          this.activeOperations.delete(operationId);
          this.sendUpdate(null, operationId, 'completed', {
            success: true
          });
          return;
        }

        this.sendUpdate(null, operationId, 'running', {
          output: `Found ${containersWithUpdates.length} container(s) and ${stacksWithUpdates.length} stack(s) with available updates\n`,
          stream: 'stdout'
        });

        let currentItem = 0;

        // Update Docker containers sequentially
        for (let i = 0; i < containersWithUpdates.length; i++) {
          currentItem++;
          const container = containersWithUpdates[i];

          this.sendUpdate(null, operationId, 'running', {
            output: `\n=== Upgrading container ${currentItem}/${totalUpdates}: ${container.name} ===\n`,
            stream: 'stdout'
          });

          const scriptPath = '/usr/local/bin/mos-update_containers';
          const args = [container.name];

          try {
            await this.executeCommandWithStream(operationId, scriptPath, args, 'upgrade', params);
          } catch (error) {
            // Continue with next container even if one fails
          }
        }

        // Update Compose stacks sequentially
        for (let i = 0; i < stacksWithUpdates.length; i++) {
          currentItem++;
          const stack = stacksWithUpdates[i];

          this.sendUpdate(null, operationId, 'running', {
            output: `\n=== Upgrading stack ${currentItem}/${totalUpdates}: ${stack.stack} ===\n`,
            stream: 'stdout'
          });

          const scriptPath = '/usr/local/bin/mos-update_containers';
          const forceArg = '""';

          try {
            await this.executeCommandWithStream(
              operationId,
              scriptPath,
              [stack.stack, forceArg, 'compose'],
              'compose-upgrade',
              params
            );

            // Sync local SHAs to remote SHAs after successful upgrade
            await this.dockerComposeService._syncLocalShasAfterUpgrade(stack.stack, true);
          } catch (error) {
            // Continue with next stack even if one fails
          }
        }

        this.activeOperations.delete(operationId);
        this.sendUpdate(null, operationId, 'completed', {
          success: true,
          message: `Updated ${containersWithUpdates.length} container(s) and ${stacksWithUpdates.length} stack(s)`
        });
      } else {
        // Update specific container or force update all
        const scriptPath = '/usr/local/bin/mos-update_containers';
        const args = [];

        if (name) args.push(name);
        if (force_update) args.push('force_update');

        await this.executeCommandWithStream(operationId, scriptPath, args, 'upgrade', params);

        // Send completion manually since 'upgrade' is a managed operation
        this.activeOperations.delete(operationId);
        this.sendUpdate(null, operationId, 'completed', {
          success: true,
          message: name ? `Container '${name}' upgraded` : 'All containers upgraded'
        });
      }

    } catch (error) {
      this.activeOperations.delete(operationId);
      this.sendUpdate(null, operationId, 'error', {
        message: `Upgrade failed: ${error.message}`
      });
    }
  }

  /**
   * Execute Docker group upgrade operation with streaming output
   * Automatically detects if group is a Compose stack and handles accordingly
   */
  async executeUpgradeGroup(operationId, params) {
    const { groupId, force_update } = params || {};

    this.sendUpdate(null, operationId, 'started', {
      operation: 'upgrade-group',
      groupId: groupId
    });

    try {
      // Get group to find containers
      const groups = await this.dockerService._readGroups();
      const group = groups.find(g => g.id === groupId);

      if (!group) {
        throw new Error(`Group with ID '${groupId}' not found`);
      }

      const scriptPath = '/usr/local/bin/mos-update_containers';

      // Check if this is a Compose stack
      if (group.compose) {
        // Compose stack - upgrade the whole stack with 'compose' argument
        this.sendUpdate(null, operationId, 'running', {
          output: `Upgrading Compose stack: ${group.name}\n`,
          stream: 'stdout'
        });

        const forceArg = force_update ? 'force_update' : '""';

        try {
          await this.executeCommandWithStream(
            operationId,
            scriptPath,
            [group.name, forceArg, 'compose'],
            'upgrade-group',
            params
          );

          // Sync local SHAs to remote SHAs after successful upgrade
          await this.dockerComposeService._syncLocalShasAfterUpgrade(group.name, force_update);
        } catch (error) {
          // Error already handled by executeCommandWithStream
        }

        this.activeOperations.delete(operationId);
        this.sendUpdate(null, operationId, 'completed', {
          success: true,
          message: `Stack '${group.name}' upgraded`
        });

      } else {
        // Regular Docker containers - process each container
        let containersToUpdate = group.containers;

        if (!force_update) {
          const allContainers = await this.dockerService.getDockerImages();
          const containerUpdateMap = {};
          allContainers.forEach(c => {
            containerUpdateMap[c.name] = c.update_available;
          });

          containersToUpdate = group.containers.filter(name => containerUpdateMap[name] === true);

          if (containersToUpdate.length === 0) {
            this.activeOperations.delete(operationId);
            this.sendUpdate(null, operationId, 'completed', {
              success: true,
              message: 'No updates available for any container in this group'
            });
            return;
          }

          this.sendUpdate(null, operationId, 'running', {
            output: `Found ${containersToUpdate.length} of ${group.containers.length} container(s) with available updates\n`,
            stream: 'stdout'
          });
        }

        // Process each container sequentially
        for (let i = 0; i < containersToUpdate.length; i++) {
          const containerName = containersToUpdate[i];

          this.sendUpdate(null, operationId, 'running', {
            output: `\n=== Upgrading container ${i + 1}/${containersToUpdate.length}: ${containerName} ===\n`,
            stream: 'stdout'
          });

          const args = [containerName];
          if (force_update) args.push('force_update');

          try {
            await this.executeCommandWithStream(operationId, scriptPath, args, 'upgrade-group', params);
          } catch (error) {
            // Continue with next container even if one fails
          }
        }

        this.activeOperations.delete(operationId);
        this.sendUpdate(null, operationId, 'completed', {
          success: true,
          message: `Group upgrade completed - updated ${containersToUpdate.length} container(s)`
        });
      }

    } catch (error) {
      this.activeOperations.delete(operationId);
      this.sendUpdate(null, operationId, 'error', {
        message: `Group upgrade failed: ${error.message}`
      });
    }
  }

  /**
   * Execute Docker pull operation with streaming output
   */
  async executePull(operationId, params) {
    const { image } = params || {};

    if (!image) {
      this.sendUpdate(null, operationId, 'error', {
        message: 'Image parameter is required for pull operation'
      });
      return;
    }

    this.sendUpdate(null, operationId, 'started', {
      operation: 'pull',
      image
    });

    try {
      const dockerPath = '/usr/bin/docker';
      const args = ['pull', image];

      await this.executeCommandWithStream(operationId, dockerPath, args, 'pull', params);

    } catch (error) {
      this.sendUpdate(null, operationId, 'error', {
        message: `Pull failed: ${error.message}`
      });
    }
  }

  /**
   * Execute Docker container creation with streaming output
   */
  async executeCreate(operationId, params) {
    const { template } = params || {};

    if (!template) {
      this.sendUpdate(null, operationId, 'error', {
        message: 'Template parameter is required for create operation'
      });
      return;
    }

    this.sendUpdate(null, operationId, 'started', {
      operation: 'create',
      name: template.name
    });

    try {
      const fileName = `${template.name.replace(/[^A-Za-z0-9\-_.]/g, '_')}.json`;
      const scriptPath = '/usr/local/bin/mos-deploy_docker';
      const fs = require('fs').promises;
      const path = require('path');

      // Validate template first
      this.dockerService.validateContainerTemplate(template);

      // Write template to file
      const templatesDir = '/boot/config/system/docker/templates';
      const filePath = path.join(templatesDir, fileName);

      // Ensure templates directory exists
      await fs.mkdir(templatesDir, { recursive: true });

      // Check if template already exists
      let templateExists = false;
      try {
        await fs.access(filePath);
        templateExists = true;
      } catch (err) {
        // Template doesn't exist yet
      }

      await fs.writeFile(filePath, JSON.stringify(template, null, 2), 'utf8');

      const args = [fileName];
      if (templateExists) {
        args.push('recreate_container');
      }

      await this.executeCommandWithStream(
        operationId,
        scriptPath,
        args,
        'create',
        params,
        { cwd: templatesDir }
      );

    } catch (error) {
      this.sendUpdate(null, operationId, 'error', {
        message: `Create failed: ${error.message}`
      });
    }
  }

  /**
   * Execute check for updates operation
   */
  async executeCheckUpdates(operationId, params) {
    const { name } = params || {};

    this.sendUpdate(null, operationId, 'started', {
      operation: 'check-updates',
      name: name || 'all containers'
    });

    try {
      const scriptPath = '/usr/local/bin/mos-check_for_docker_updates';
      const args = name ? [name] : [];

      await this.executeCommandWithStream(operationId, scriptPath, args, 'check-updates', params);

    } catch (error) {
      this.sendUpdate(null, operationId, 'error', {
        message: `Check updates failed: ${error.message}`
      });
    }
  }

  /**
   * Execute a command with streaming output
   * Automatically adds Docker auth for docker/docker-compose commands if tokens available
   */
  async executeCommandWithStream(operationId, command, args = [], operationType, params = {}, options = {}) {
    // Add Docker auth for docker/docker-compose commands
    let authCleanup = () => {};
    let spawnOptions = { ...options, shell: false };

    if (command === 'docker-compose' || command === 'docker') {
      const { configDir, cleanup } = await createDockerAuthConfig();
      authCleanup = cleanup;
      if (configDir) {
        spawnOptions.env = { ...process.env, ...options.env, DOCKER_CONFIG: configDir };
      }
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, spawnOptions);

      const startTime = Date.now();

      // Store process for potential cancellation
      this.activeOperations.set(operationId, {
        process: proc,
        type: operationType,
        operation: operationType,
        params,
        startTime
      });

      let stdout = '';
      let stderr = '';

      // Stream stdout
      proc.stdout.on('data', (data) => {
        const output = stripAnsi(data.toString());
        stdout += output;

        // Send progress to all clients in operation room
        this.sendUpdate(null, operationId, 'running', {
          output,
          stream: 'stdout'
        });
      });

      // Stream stderr (Docker often uses stderr for progress)
      proc.stderr.on('data', (data) => {
        const output = stripAnsi(data.toString());
        stderr += output;

        // Send progress to all clients in operation room
        this.sendUpdate(null, operationId, 'running', {
          output,
          stream: 'stderr'
        });
      });

      // Handle process completion
      proc.on('close', async (code) => {
        await authCleanup();
        // Remove from active operations for operations that manage themselves
        // Don't auto-delete for: upgrade-group, compose-* (they manage their own lifecycle)
        const managedOperations = [
          'upgrade',
          'upgrade-group',
          'compose-create-deploy',
          'compose-update-down',
          'compose-update-up',
          'compose-delete',
          'compose-upgrade'
        ];

        if (!managedOperations.includes(operationType)) {
          this.activeOperations.delete(operationId);
        }

        const success = code === 0;
        const duration = Date.now() - startTime;

        // Try to parse JSON output if successful
        let result = null;
        if (success && stdout.trim()) {
          try {
            result = JSON.parse(stdout);
          } catch (e) {
            result = { message: stdout.trim() };
          }
        }

        // Only send 'completed' if not part of a managed operation (they send their own completed)
        if (!managedOperations.includes(operationType)) {
          this.sendUpdate(null, operationId, 'completed', {
            success,
            exitCode: code,
            result,
            duration,
            stdout: stdout.trim(),
            stderr: stderr.trim()
          });
        }

        if (success) {
          resolve(result);
        } else {
          reject(new Error(`Process exited with code ${code}`));
        }
      });

      // Handle process errors
      proc.on('error', async (error) => {
        await authCleanup();
        // Remove from active operations for operations that manage themselves
        const managedOperations = [
          'upgrade',
          'upgrade-group',
          'compose-create-deploy',
          'compose-update-down',
          'compose-update-up',
          'compose-delete',
          'compose-upgrade'
        ];

        if (!managedOperations.includes(operationType)) {
          this.activeOperations.delete(operationId);
        }

        this.sendUpdate(null, operationId, 'error', {
          message: `Process error: ${error.message}`
        });

        reject(error);
      });
    });
  }

  /**
   * Cancel an ongoing operation
   */
  async cancelOperation(operationId) {
    const operation = this.activeOperations.get(operationId);

    if (!operation) {
      this.sendUpdate(null, operationId, 'error', {
        message: 'Operation not found or already completed'
      });
      return;
    }

    try {
      // Kill the process
      operation.process.kill('SIGTERM');

      // Remove from active operations
      this.activeOperations.delete(operationId);

      this.sendUpdate(null, operationId, 'cancelled', {
        message: 'Operation cancelled by user'
      });

      console.log(`Operation ${operationId} cancelled`);
    } catch (error) {
      console.error('Error cancelling operation:', error);
      this.sendUpdate(null, operationId, 'error', {
        message: `Failed to cancel operation: ${error.message}`
      });
    }
  }

  /**
   * Get statistics about active operations
   */
  getStats() {
    const stats = {
      activeOperations: this.activeOperations.size,
      operations: []
    };

    for (const [operationId, operation] of this.activeOperations.entries()) {
      stats.operations.push({
        operationId,
        type: operation.type,
        operation: operation.operation,
        duration: Date.now() - operation.startTime
      });
    }

    return stats;
  }

  /**
   * Execute Docker Compose stack creation with streaming output
   */
  async executeComposeCreate(operationId, params) {
    const { name, yaml, env, icon } = params || {};
    const webui = params?.webui !== undefined ? params.webui : params?.web_ui_url;
    const noAutoupdate = params?.no_autoupdate === true;

    if (!name || !yaml) {
      this.sendUpdate(null, operationId, 'error', {
        message: 'Stack name and yaml are required for compose-create operation'
      });
      return;
    }

    this.sendUpdate(null, operationId, 'started', {
      operation: 'compose-create',
      name
    });

    // Track pull success so outer catch knows whether to clean up
    let pullSucceeded = false;

    try {
      const fs = require('fs').promises;
      const path = require('path');

      // Validate stack name
      this.dockerComposeService._validateStackName(name);

      // Get stack path
      const stackPath = this.dockerComposeService._getStackPath(name);

      // Check if stack already exists (directory + group = real active stack)
      let stackDirExists = false;
      try {
        await fs.access(stackPath);
        stackDirExists = true;
      } catch (err) {
        if (err.code !== 'ENOENT') {
          throw err;
        }
      }

      if (stackDirExists) {
        const groups = await this.dockerService.getContainerGroups();
        const existingGroup = groups.find(g => g.name === name && g.compose === true);

        if (existingGroup) {
          throw new Error(`Stack '${name}' already exists`);
        }
        // Directory exists but no group = orphaned files, safe to overwrite
      }

      // Create stack directory (mkdir is safe even if exists)
      await fs.mkdir(stackPath, { recursive: true });

      this.sendUpdate(null, operationId, 'running', {
        output: `Creating stack directory: ${stackPath}\n`,
        stream: 'stdout'
      });

      // Save compose.yaml
      const composePath = path.join(stackPath, 'compose.yaml');
      await fs.writeFile(composePath, yaml);

      this.sendUpdate(null, operationId, 'running', {
        output: `Saved compose.yaml\n`,
        stream: 'stdout'
      });

      // Save .env if provided
      if (env) {
        const envPath = path.join(stackPath, '.env');
        await fs.writeFile(envPath, env);
        this.sendUpdate(null, operationId, 'running', {
          output: `Saved .env file\n`,
          stream: 'stdout'
        });
      }

      // Get service names
      const services = await this.dockerComposeService._getComposeServices(stackPath);

      if (!services || services.length === 0) {
        throw new Error('No services found in compose.yaml');
      }

      this.sendUpdate(null, operationId, 'running', {
        output: `Found services: ${services.join(', ')}\n`,
        stream: 'stdout'
      });

      // Generate mos.override.yaml
      const mosOverride = this.dockerComposeService._generateMosOverride(services, name, icon, noAutoupdate);
      const mosOverridePath = path.join(stackPath, 'mos.override.yaml');
      await fs.writeFile(mosOverridePath, mosOverride);

      this.sendUpdate(null, operationId, 'running', {
        output: `Generated mos.override.yaml\n`,
        stream: 'stdout'
      });

      // Download icon (non-critical)
      let iconPath = null;
      if (icon) {
        iconPath = await this.dockerComposeService._downloadIcon(icon, name);
        if (iconPath) {
          this.sendUpdate(null, operationId, 'running', {
            output: `Icon downloaded\n`,
            stream: 'stdout'
          });
        } else {
          this.sendUpdate(null, operationId, 'running', {
            output: `Warning: Failed to download icon\n`,
            stream: 'stdout'
          });
        }
      }

      // Copy files from boot to working directory
      this.sendUpdate(null, operationId, 'running', {
        output: `Copying files to working directory...\n`,
        stream: 'stdout'
      });

      await this.dockerComposeService._copyStackToWorking(name);

      this.sendUpdate(null, operationId, 'running', {
        output: `Files copied to working directory\n`,
        stream: 'stdout'
      });

      // Create Docker group
      await this.dockerService.createContainerGroup(name, [], {
        compose: true,
        icon: iconPath ? name : null
      });

      this.sendUpdate(null, operationId, 'running', {
        output: `Created Docker group\n`,
        stream: 'stdout'
      });

      // Get working path for deployment
      const workingPath = await this.dockerComposeService._getWorkingPath(name);

      // Phase 1: Pull images first
      this.sendUpdate(null, operationId, 'running', {
        output: `\nPulling images...\n`,
        stream: 'stdout'
      });

      try {
        await this.executeCommandWithStream(
          operationId,
          'docker-compose',
          ['-f', 'compose.yaml', '-f', 'mos.override.yaml', 'pull'],
          'compose-create-deploy',
          params,
          { cwd: workingPath }
        );
      } catch (pullError) {
        // Pull failed - no images available, clean up everything
        this.sendUpdate(null, operationId, 'running', {
          output: `\nImage pull failed, cleaning up...\n`,
          stream: 'stderr'
        });

        // Delete group
        try {
          const groups = await this.dockerService.getContainerGroups();
          const group = groups.find(g => g.name === name && g.compose === true);
          if (group) await this.dockerService.deleteContainerGroup(group.id);
        } catch (groupError) { /* ignore */ }

        // Delete stack files
        try {
          await require('fs').promises.rm(this.dockerComposeService._getStackPath(name), { recursive: true, force: true });
        } catch (cleanupError) { /* ignore */ }

        this.activeOperations.delete(operationId);
        this.sendUpdate(null, operationId, 'error', {
          message: `Compose create failed: Could not pull images - ${pullError.message}`
        });
        return;
      }

      pullSucceeded = true;

      // Phase 2: Start containers (pull succeeded, so images exist)
      this.sendUpdate(null, operationId, 'running', {
        output: `\nStarting containers...\n`,
        stream: 'stdout'
      });

      let deploymentFailed = false;
      let deployError = null;

      try {
        await this.executeCommandWithStream(
          operationId,
          'docker-compose',
          ['-f', 'compose.yaml', '-f', 'mos.override.yaml', 'up', '-d'],
          'compose-create-deploy',
          params,
          { cwd: workingPath }
        );
      } catch (upError) {
        // Start failed (e.g. port conflict) - but images are pulled and containers may be created
        deploymentFailed = true;
        deployError = upError;

        // Stop all containers in the stack to ensure a clean stopped state
        this.sendUpdate(null, operationId, 'running', {
          output: `\nDeployment failed, stopping partially started containers...\n`,
          stream: 'stderr'
        });

        await this.dockerComposeService._stopStack(name);

        this.sendUpdate(null, operationId, 'running', {
          output: `Stack files are preserved - fix the issue and use update to redeploy.\n`,
          stream: 'stderr'
        });
      }

      // Get containers REGARDLESS of deployment success (containers might be created but not started)
      const containerNames = await this.dockerComposeService._getStackContainers(name);

      this.sendUpdate(null, operationId, 'running', {
        output: `\nFound ${containerNames.length} containers: ${containerNames.join(', ')}\n`,
        stream: 'stdout'
      });

      // Update group with containers (even if deployment failed)
      const groups = await this.dockerService.getContainerGroups();
      const group = groups.find(g => g.name === name && g.compose === true);
      if (group) {
        await this.dockerService.updateGroup(group.id, {
          containers: containerNames
        });
      }

      // Update compose-containers file (even with 0 containers, so the stack entry exists)
      await this.dockerComposeService._updateStackInComposeContainers(name, null, webui, noAutoupdate);
      this.sendUpdate(null, operationId, 'running', {
        output: `Updated compose-containers file\n`,
        stream: 'stdout'
      });

      // Send completion (with warning if deployment failed)
      this.activeOperations.delete(operationId);

      if (deploymentFailed) {
        this.sendUpdate(null, operationId, 'completed', {
          success: false,
          stack: name,
          services: services,
          containers: containerNames,
          iconPath: iconPath,
          warning: `Stack created but deployment failed: ${deployError.message}. Use update to fix and redeploy.`
        });
      } else {
        this.sendUpdate(null, operationId, 'completed', {
          success: true,
          stack: name,
          services: services,
          containers: containerNames,
          iconPath: iconPath
        });
      }

    } catch (error) {
      this.activeOperations.delete(operationId);
      this.sendUpdate(null, operationId, 'error', {
        message: `Compose create failed: ${error.message}`
      });

      // Only clean up if we failed BEFORE pull (validation, file creation, etc.)
      // If pull already succeeded, keep everything (files, group, containers) for user to fix
      if (!pullSucceeded) {
        const stackPath = this.dockerComposeService._getStackPath(name);
        try {
          const groups = await this.dockerService.getContainerGroups();
          const group = groups.find(g => g.name === name && g.compose === true);
          if (group) await this.dockerService.deleteContainerGroup(group.id);
        } catch (groupError) { /* ignore */ }
        try {
          await require('fs').promises.rm(stackPath, { recursive: true, force: true });
        } catch (cleanupError) { /* ignore */ }
      }
    }
  }

  /**
   * Execute Docker Compose stack update with streaming output
   */
  async executeComposeUpdate(operationId, params) {
    const { name, yaml, env, icon } = params || {};
    const webui = params?.webui !== undefined ? params.webui : params?.web_ui_url;
    const noAutoupdate = params?.no_autoupdate !== undefined ? params.no_autoupdate === true : null;

    if (!name || !yaml) {
      this.sendUpdate(null, operationId, 'error', {
        message: 'Stack name and yaml are required for compose-update operation'
      });
      return;
    }

    this.sendUpdate(null, operationId, 'started', {
      operation: 'compose-update',
      name
    });

    try {
      const fs = require('fs').promises;
      const path = require('path');

      this.dockerComposeService._validateStackName(name);

      const stackPath = this.dockerComposeService._getStackPath(name);
      const composePath = path.join(stackPath, 'compose.yaml');

      // Check if stack exists
      try {
        await fs.access(composePath);
      } catch (err) {
        throw new Error(`Stack '${name}' not found`);
      }

      // Get working path
      const workingPath = await this.dockerComposeService._getWorkingPath(name);

      // Check if working directory exists, if not recreate it
      try {
        await fs.access(workingPath);
      } catch (err) {
        this.sendUpdate(null, operationId, 'running', {
          output: `Working directory not found, recreating from boot...\n`,
          stream: 'stdout'
        });

        try {
          await this.dockerComposeService._copyStackToWorking(name);
          this.sendUpdate(null, operationId, 'running', {
            output: `Working directory recreated\n`,
            stream: 'stdout'
          });
        } catch (copyError) {
          this.sendUpdate(null, operationId, 'running', {
            output: `Warning: Failed to recreate working directory: ${copyError.message}\n`,
            stream: 'stdout'
          });
          // Continue anyway, we'll recreate it after updating the boot files
        }
      }

      this.sendUpdate(null, operationId, 'running', {
        output: `Stopping current stack...\n`,
        stream: 'stdout'
      });

      // Stop current stack with streaming from working directory, keep images
      await this.executeCommandWithStream(
        operationId,
        'docker-compose',
        ['-f', 'compose.yaml', '-f', 'mos.override.yaml', 'down', '-v'],
        'compose-update-down',
        params,
        { cwd: workingPath }
      );

      // Update compose.yaml
      await fs.writeFile(composePath, yaml);

      this.sendUpdate(null, operationId, 'running', {
        output: `Updated compose.yaml\n`,
        stream: 'stdout'
      });

      // Update .env
      const envPath = path.join(stackPath, '.env');
      if (env) {
        await fs.writeFile(envPath, env);
        this.sendUpdate(null, operationId, 'running', {
          output: `Updated .env file\n`,
          stream: 'stdout'
        });
      } else {
        try {
          await fs.unlink(envPath);
          this.sendUpdate(null, operationId, 'running', {
            output: `Removed .env file\n`,
            stream: 'stdout'
          });
        } catch (err) {
          // File doesn't exist
        }
      }

      // Get new service names
      const services = await this.dockerComposeService._getComposeServices(stackPath);

      if (!services || services.length === 0) {
        throw new Error('No services found in compose.yaml');
      }

      this.sendUpdate(null, operationId, 'running', {
        output: `Found services: ${services.join(', ')}\n`,
        stream: 'stdout'
      });

      // Regenerate mos.override.yaml (read existing no_autoupdate if not explicitly set)
      let effectiveNoAutoupdate = noAutoupdate;
      if (effectiveNoAutoupdate === null) {
        try {
          const cc = await this.dockerComposeService._readComposeContainers();
          const ccEntry = cc.find(s => s.stack === name);
          effectiveNoAutoupdate = ccEntry ? ccEntry.no_autoupdate === true : false;
        } catch (err) {
          effectiveNoAutoupdate = false;
        }
      }
      const mosOverride = this.dockerComposeService._generateMosOverride(services, name, icon, effectiveNoAutoupdate);
      const mosOverridePath = path.join(stackPath, 'mos.override.yaml');
      await fs.writeFile(mosOverridePath, mosOverride);

      // Update icon if provided
      let iconPath = null;
      if (icon) {
        iconPath = await this.dockerComposeService._downloadIcon(icon, name);
        if (iconPath) {
          this.sendUpdate(null, operationId, 'running', {
            output: `Icon updated\n`,
            stream: 'stdout'
          });
        } else {
          this.sendUpdate(null, operationId, 'running', {
            output: `Warning: Failed to download icon\n`,
            stream: 'stdout'
          });
        }
      }

      // Copy updated files from boot to working directory
      this.sendUpdate(null, operationId, 'running', {
        output: `Copying updated files to working directory...\n`,
        stream: 'stdout'
      });

      await this.dockerComposeService._copyStackToWorking(name);

      this.sendUpdate(null, operationId, 'running', {
        output: `Files copied to working directory\n`,
        stream: 'stdout'
      });

      // Phase 1: Pull images first
      this.sendUpdate(null, operationId, 'running', {
        output: `\nPulling images...\n`,
        stream: 'stdout'
      });

      try {
        await this.executeCommandWithStream(
          operationId,
          'docker-compose',
          ['-f', 'compose.yaml', '-f', 'mos.override.yaml', 'pull'],
          'compose-update-up',
          params,
          { cwd: workingPath }
        );
      } catch (pullError) {
        // Pull failed - report error but don't destroy the stack
        this.activeOperations.delete(operationId);
        this.sendUpdate(null, operationId, 'error', {
          message: `Compose update failed: Could not pull images - ${pullError.message}. Stack files are preserved.`
        });
        return;
      }

      // Phase 2: Start containers
      this.sendUpdate(null, operationId, 'running', {
        output: `\nStarting containers...\n`,
        stream: 'stdout'
      });

      let deploymentFailed = false;
      let deployError = null;

      try {
        await this.executeCommandWithStream(
          operationId,
          'docker-compose',
          ['-f', 'compose.yaml', '-f', 'mos.override.yaml', 'up', '-d'],
          'compose-update-up',
          params,
          { cwd: workingPath }
        );
      } catch (upError) {
        // Start failed (e.g. port conflict) - but images are pulled and containers may be created
        deploymentFailed = true;
        deployError = upError;

        // Stop all containers in the stack to ensure a clean stopped state
        this.sendUpdate(null, operationId, 'running', {
          output: `\nDeployment failed, stopping partially started containers...\n`,
          stream: 'stderr'
        });

        await this.dockerComposeService._stopStack(name);

        this.sendUpdate(null, operationId, 'running', {
          output: `Stack files are preserved - fix the issue and update again.\n`,
          stream: 'stderr'
        });
      }

      // Get new container names REGARDLESS of deployment success
      const containerNames = await this.dockerComposeService._getStackContainers(name);

      this.sendUpdate(null, operationId, 'running', {
        output: `\nFound ${containerNames.length} containers: ${containerNames.join(', ')}\n`,
        stream: 'stdout'
      });

      // Update Docker group (even if deployment failed)
      const groups = await this.dockerService.getContainerGroups();
      const existingGroup = groups.find(g => g.name === name && g.compose === true);

      if (existingGroup) {
        await this.dockerService.updateGroup(existingGroup.id, {
          containers: containerNames,
          icon: iconPath ? name : existingGroup.icon
        });
      }

      // Update compose-containers file (even with 0 containers, so the stack entry exists)
      await this.dockerComposeService._updateStackInComposeContainers(name, null, webui, noAutoupdate);
      this.sendUpdate(null, operationId, 'running', {
        output: `Updated compose-containers file\n`,
        stream: 'stdout'
      });

      // Send completion (with warning if deployment failed)
      this.activeOperations.delete(operationId);

      if (deploymentFailed) {
        this.sendUpdate(null, operationId, 'completed', {
          success: false,
          stack: name,
          services: services,
          containers: containerNames,
          iconPath: iconPath,
          warning: `Stack updated but deployment failed: ${deployError.message}. Fix the issue and update again.`
        });
      } else {
        this.sendUpdate(null, operationId, 'completed', {
          success: true,
          stack: name,
          services: services,
          containers: containerNames,
          iconPath: iconPath
        });
      }

    } catch (error) {
      this.activeOperations.delete(operationId);
      this.sendUpdate(null, operationId, 'error', {
        message: `Compose update failed: ${error.message}`
      });
    }
  }

  /**
   * Execute Docker Compose pull with streaming output
   */
  async executeComposePull(operationId, params) {
    const { name } = params || {};

    if (!name) {
      this.sendUpdate(null, operationId, 'error', {
        message: 'Stack name is required for compose-pull operation'
      });
      return;
    }

    this.sendUpdate(null, operationId, 'started', {
      operation: 'compose-pull',
      name
    });

    try {
      const fs = require('fs').promises;
      const path = require('path');

      this.dockerComposeService._validateStackName(name);

      const stackPath = this.dockerComposeService._getStackPath(name);

      // Check if stack exists in boot
      try {
        await fs.access(path.join(stackPath, 'compose.yaml'));
      } catch (err) {
        throw new Error(`Stack '${name}' not found`);
      }

      // Get working path
      const workingPath = await this.dockerComposeService._getWorkingPath(name);

      // Check if working directory exists, if not recreate it
      try {
        await fs.access(workingPath);
      } catch (err) {
        this.sendUpdate(null, operationId, 'running', {
          output: `Working directory not found, recreating from boot...\n`,
          stream: 'stdout'
        });

        await this.dockerComposeService._copyStackToWorking(name);

        this.sendUpdate(null, operationId, 'running', {
          output: `Working directory recreated\n`,
          stream: 'stdout'
        });
      }

      this.sendUpdate(null, operationId, 'running', {
        output: `Pulling images for stack '${name}' from working directory...\n`,
        stream: 'stdout'
      });

      // Pull images with streaming from working directory
      await this.executeCommandWithStream(
        operationId,
        'docker-compose',
        ['-f', 'compose.yaml', '-f', 'mos.override.yaml', 'pull'],
        'compose-pull',
        params,
        { cwd: workingPath }
      );

    } catch (error) {
      this.sendUpdate(null, operationId, 'error', {
        message: `Compose pull failed: ${error.message}`
      });
    }
  }

  /**
   * Execute Docker Compose stack deletion with streaming output
   */
  async executeComposeDelete(operationId, params) {
    const { name } = params || {};

    if (!name) {
      this.sendUpdate(null, operationId, 'error', {
        message: 'Stack name is required for compose-delete operation'
      });
      return;
    }

    this.sendUpdate(null, operationId, 'started', {
      operation: 'compose-delete',
      name
    });

    try {
      const fs = require('fs').promises;
      const path = require('path');

      this.dockerComposeService._validateStackName(name);

      const stackPath = this.dockerComposeService._getStackPath(name);
      const composePath = path.join(stackPath, 'compose.yaml');

      let stackExists = false;

      // Check if stack exists in boot
      try {
        await fs.access(composePath);
        stackExists = true;
      } catch (err) {
        this.sendUpdate(null, operationId, 'running', {
          output: `Warning: Stack files not found in boot directory\n`,
          stream: 'stdout'
        });
      }

      if (stackExists) {
        // Get working path
        const workingPath = await this.dockerComposeService._getWorkingPath(name);

        // Check if working directory exists, if not recreate it
        try {
          await fs.access(workingPath);
        } catch (err) {
          this.sendUpdate(null, operationId, 'running', {
            output: `Working directory not found, recreating from boot...\n`,
            stream: 'stdout'
          });

          try {
            await this.dockerComposeService._copyStackToWorking(name);
            this.sendUpdate(null, operationId, 'running', {
              output: `Working directory recreated\n`,
              stream: 'stdout'
            });
          } catch (copyError) {
            this.sendUpdate(null, operationId, 'running', {
              output: `Failed to recreate working directory: ${copyError.message}\n`,
              stream: 'stdout'
            });
            // Continue anyway, docker-compose down might still work if containers exist
          }
        }

        this.sendUpdate(null, operationId, 'running', {
          output: `Stopping and removing stack via docker-compose...\n`,
          stream: 'stdout'
        });

        // Stop and remove stack with streaming from working directory
        try {
          await this.executeCommandWithStream(
            operationId,
            'docker-compose',
            ['-f', 'compose.yaml', '-f', 'mos.override.yaml', 'down', '--rmi', 'all', '-v'],
            'compose-delete',
            params,
            { cwd: workingPath }
          );
        } catch (downError) {
          this.sendUpdate(null, operationId, 'running', {
            output: `Warning: docker-compose down failed: ${downError.message}\n`,
            stream: 'stdout'
          });
        }

        // Move stack directory in boot to removed (working directory stays untouched)
        try {
          await this.dockerComposeService._moveStackToRemoved(name);
          this.sendUpdate(null, operationId, 'running', {
            output: `Moved stack to removed directory\n`,
            stream: 'stdout'
          });
        } catch (moveError) {
          this.sendUpdate(null, operationId, 'running', {
            output: `Warning: Failed to move stack: ${moveError.message}\n`,
            stream: 'stdout'
          });
        }
      } else {
        // Stack files missing - only remove group, keep containers running
        this.sendUpdate(null, operationId, 'running', {
          output: `Stack files missing - only removing group, containers will remain running\n`,
          stream: 'stdout'
        });
      }

      // Delete icon
      try {
        const iconPath = `/var/lib/docker/mos/icons/compose/${name}.png`;
        await fs.unlink(iconPath);
        this.sendUpdate(null, operationId, 'running', {
          output: `Deleted icon\n`,
          stream: 'stdout'
        });
      } catch (err) {
        // Icon doesn't exist
      }

      // Delete Docker group
      const groups = await this.dockerService.getContainerGroups();
      const group = groups.find(g => g.name === name && g.compose === true);

      if (group) {
        await this.dockerService.deleteContainerGroup(group.id);
        this.sendUpdate(null, operationId, 'running', {
          output: `Deleted Docker group\n`,
          stream: 'stdout'
        });
      }

      // Remove from compose-containers file
      await this.dockerComposeService._removeStackFromComposeContainers(name);
      this.sendUpdate(null, operationId, 'running', {
        output: `Removed from compose-containers file\n`,
        stream: 'stdout'
      });

      // Send completion
      this.activeOperations.delete(operationId);
      this.sendUpdate(null, operationId, 'completed', {
        success: true,
        message: `Stack '${name}' deleted successfully`
      });

    } catch (error) {
      this.activeOperations.delete(operationId);
      this.sendUpdate(null, operationId, 'error', {
        message: `Compose delete failed: ${error.message}`
      });
    }
  }

  /**
   * Execute Docker Compose stack upgrade with streaming output
   */
  async executeComposeUpgrade(operationId, params) {
    const { name, force_update } = params || {};

    if (!name) {
      this.sendUpdate(null, operationId, 'error', {
        message: 'Stack name is required for compose-upgrade operation'
      });
      return;
    }

    this.sendUpdate(null, operationId, 'started', {
      operation: 'compose-upgrade',
      name,
      force_update: force_update || false
    });

    try {
      this.dockerComposeService._validateStackName(name);

      const stackPath = this.dockerComposeService._getStackPath(name);

      // Check if stack exists
      try {
        await require('fs').promises.access(
          require('path').join(stackPath, 'compose.yaml')
        );
      } catch (err) {
        throw new Error(`Stack '${name}' not found`);
      }

      this.sendUpdate(null, operationId, 'running', {
        output: `Upgrading stack '${name}'${force_update ? ' (force)' : ''}...\n`,
        stream: 'stdout'
      });

      // Build command: mos-update_containers NAME [force_update|""] compose
      const scriptPath = '/usr/local/bin/mos-update_containers';
      const forceArg = force_update ? 'force_update' : '""';

      await this.executeCommandWithStream(
        operationId,
        scriptPath,
        [name, forceArg, 'compose'],
        'compose-upgrade',
        params
      );

      // Sync local SHAs to remote SHAs after successful upgrade
      await this.dockerComposeService._syncLocalShasAfterUpgrade(name, force_update);

      this.sendUpdate(null, operationId, 'running', {
        output: `\nUpdated compose-containers file\n`,
        stream: 'stdout'
      });

      // Send completion
      this.activeOperations.delete(operationId);
      this.sendUpdate(null, operationId, 'completed', {
        success: true,
        stack: name,
        message: `Stack '${name}' upgraded successfully`
      });

    } catch (error) {
      this.activeOperations.delete(operationId);
      this.sendUpdate(null, operationId, 'error', {
        message: `Compose upgrade failed: ${error.message}`
      });
    }
  }

  /**
   * Execute container stats stream using Docker Socket API via Axios
   * @param {string} socketId - Socket ID
   * @param {string} operationId - Operation ID
   * @param {string} containerName - Container name
   * @param {Object} user - User object with byte_format preference
   */
  async executeContainerStats(socketId, operationId, containerName, user = null) {
    this.sendUpdate(null, operationId, 'started', {
      operation: 'container-stats',
      name: containerName
    });

    const startTime = Date.now();

    try {
      const response = await axios({
        method: 'GET',
        url: `http://localhost/containers/${encodeURIComponent(containerName)}/stats?stream=1`,
        socketPath: '/var/run/docker.sock',
        responseType: 'stream',
        validateStatus: () => true
      });

      // Handle non-200 responses
      if (response.status !== 200) {
        let message = `Container '${containerName}' not found or not running`;
        if (response.data && response.data.message) {
          message = response.data.message;
        }
        this.sendUpdate(null, operationId, 'error', { message });
        return;
      }

      const stream = response.data;

      // Initialize socket stats streams map if not exists
      if (!this.statsStreams.has(socketId)) {
        this.statsStreams.set(socketId, new Map());
      }

      // Store stream for this socket (to allow cancellation)
      this.statsStreams.get(socketId).set(operationId, {
        stream,
        containerName,
        startTime
      });

      let buffer = '';

      // Stream data from Docker API
      stream.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');

        // Keep the last incomplete line in buffer
        buffer = lines.pop();

        // Process complete JSON lines
        for (const line of lines) {
          if (line.trim()) {
            try {
              const rawStats = JSON.parse(line);
              // Calculate and format stats
              const stats = calculateContainerStats(rawStats, user);
              this.sendUpdate(null, operationId, 'running', {
                stats
              });
            } catch (e) {
              // Skip malformed JSON
            }
          }
        }
      });

      stream.on('end', () => {
        // Remove from stats streams
        if (this.statsStreams.has(socketId)) {
          this.statsStreams.get(socketId).delete(operationId);
          if (this.statsStreams.get(socketId).size === 0) {
            this.statsStreams.delete(socketId);
          }
        }

        const duration = Date.now() - startTime;
        this.sendUpdate(null, operationId, 'completed', {
          success: true,
          message: `Stats stream stopped for container '${containerName}'`,
          duration
        });
      });

      stream.on('error', (error) => {
        // Remove from stats streams
        if (this.statsStreams.has(socketId)) {
          this.statsStreams.get(socketId).delete(operationId);
          if (this.statsStreams.get(socketId).size === 0) {
            this.statsStreams.delete(socketId);
          }
        }

        this.sendUpdate(null, operationId, 'error', {
          message: `Stats stream error: ${error.message}`
        });
      });

    } catch (error) {
      this.sendUpdate(null, operationId, 'error', {
        message: `Failed to start stats stream: ${error.message}`
      });
    }
  }

  /**
   * Stop a container stats stream
   */
  async stopContainerStats(socketId, operationId) {
    if (!this.statsStreams.has(socketId)) {
      this.sendUpdate(null, operationId, 'error', {
        message: 'Stats stream not found or already stopped'
      });
      return;
    }

    const socketStreams = this.statsStreams.get(socketId);
    const stream = socketStreams.get(operationId);

    if (!stream) {
      this.sendUpdate(null, operationId, 'error', {
        message: 'Stats stream not found or already stopped'
      });
      return;
    }

    try {
      // Destroy the axios stream to stop streaming
      if (stream.stream) {
        stream.stream.destroy();
      }

      // Remove from tracking
      socketStreams.delete(operationId);
      if (socketStreams.size === 0) {
        this.statsStreams.delete(socketId);
      }

      this.sendUpdate(null, operationId, 'completed', {
        success: true,
        message: `Stats stream stopped for container '${stream.containerName}'`
      });

      console.log(`Stats stream ${operationId} stopped for container ${stream.containerName}`);
    } catch (error) {
      console.error('Error stopping stats stream:', error);
      this.sendUpdate(null, operationId, 'error', {
        message: `Failed to stop stats stream: ${error.message}`
      });
    }
  }

  /**
   * Cleanup all stats streams for a socket (on disconnect)
   */
  cleanupSocketStatsStreams(socketId) {
    if (!this.statsStreams.has(socketId)) {
      return;
    }

    const socketStreams = this.statsStreams.get(socketId);
    console.log(`Cleaning up ${socketStreams.size} stats stream(s) for socket ${socketId}`);

    for (const [operationId, stream] of socketStreams.entries()) {
      try {
        if (stream.stream) stream.stream.destroy();
        console.log(`Stopped stats stream ${operationId} for container ${stream.containerName}`);
      } catch (error) {
        console.error(`Error stopping stats stream ${operationId}:`, error);
      }
    }

    this.statsStreams.delete(socketId);
  }

  /**
   * Authenticate user
   */
  async authenticateUser(token) {
    if (!token) {
      return { success: false, message: 'Authentication token is required' };
    }

    try {
      const jwt = require('jsonwebtoken');
      const { getBootToken, isActionAllowed } = require('../middleware/auth.middleware');
      const userService = require('../services/user.service');

      // Check if it's the boot token
      const bootToken = await getBootToken();
      if (bootToken && token === bootToken) {
        return {
          success: true,
          user: {
            id: 'boot',
            username: 'boot',
            role: 'admin',
            isBootToken: true
          }
        };
      }

      // Check if it's an admin API token
      const adminTokenData = await userService.validateAdminToken(token);
      if (adminTokenData) {
        // Restricted tokens need at least 'read' permission for 'docker'
        // (write permission is checked separately for mutating operations)
        if (!isActionAllowed(adminTokenData.permissions, 'docker', 'read')) {
          return { success: false, message: "Access denied. This token does not have 'read' permission for 'docker'." };
        }
        return {
          success: true,
          user: adminTokenData
        };
      }

      // Regular JWT verification
      const decodedUser = jwt.verify(token, process.env.JWT_SECRET);

      // Check if user still exists
      const users = await userService.loadUsers();
      const currentUser = users.find(u => u.id === decodedUser.id);

      if (!currentUser) {
        return { success: false, message: 'User no longer exists' };
      }

      // samba_only users are not allowed
      if (currentUser.role === 'samba_only') {
        return { success: false, message: 'Access denied. This account is for file sharing only' };
      }

      // Check if role has changed
      if (currentUser.role !== decodedUser.role) {
        return { success: false, message: 'Token invalid due to role change. Please login again' };
      }

      return {
        success: true,
        user: {
          id: currentUser.id,
          username: currentUser.username,
          role: currentUser.role,
          byte_format: currentUser.byte_format
        }
      };

    } catch (authError) {
      return { success: false, message: 'Invalid authentication token' };
    }
  }
}

module.exports = DockerWebSocketManager;
