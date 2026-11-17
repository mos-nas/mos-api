const { spawn } = require('child_process');

const MAX_BUFFER_BYTES = 100 * 1024; // Output kept per operation for rejoining clients
const MAX_RETAINED_OPERATIONS = 5;
const KILL_ESCALATION_MS = 5000;
const INSTALL_CWD = '/var/mos';
const INSTALL_SCRIPT = '/usr/local/bin/mos-install';
const VALID_FILESYSTEMS = ['vfat', 'ext4', 'btrfs', 'xfs'];

/**
 * Strip ANSI escape codes from string
 */
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

/**
 * Quote a value for safe use in a bash command line
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Install To Disk WebSocket Manager - Runs mos-install with real-time output streaming
 * Same parameters as POST /mos/installtodisk, but with streamed progress,
 * cancel support and reconnect replay. Only one installation can run at a time.
 *
 * For API documentation and usage examples, see: /routes/websocket/installtodisk.websocket.routes.js
 */
class InstallToDiskWebSocketManager {
  constructor(io) {
    this.io = io;
    // operationId -> { process, pid, params, startTime, completedAt, status, exitCode, signal, outputChunks, outputBytes, cancelled, killTimer }
    this.activeOperations = new Map();
  }

  /**
   * Handle WebSocket connection for MOS installation to disk
   */
  handleConnection(socket) {
    console.log(`InstallToDisk WebSocket client connected: ${socket.id}`);

    // Start an installation (same parameters as POST /mos/installtodisk)
    socket.on('installtodisk-run', async (data) => {
      try {
        const { token, disk, filesystem, extra_partition = false, tar_file = '', backup_label = false } = data || {};

        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          this.sendUpdate(socket, null, 'error', { message: authResult.message });
          return;
        }

        if (authResult.user.role !== 'admin') {
          this.sendUpdate(socket, null, 'error', { message: 'Admin role required for installation to disk' });
          return;
        }

        if (!disk || typeof disk !== 'string') {
          this.sendUpdate(socket, null, 'error', { message: 'disk parameter is required and must be a string' });
          return;
        }

        if (!filesystem || !VALID_FILESYSTEMS.includes(filesystem)) {
          this.sendUpdate(socket, null, 'error', { message: `filesystem must be one of: ${VALID_FILESYSTEMS.join(', ')}` });
          return;
        }

        if (tar_file && typeof tar_file !== 'string') {
          this.sendUpdate(socket, null, 'error', { message: 'tar_file must be a string' });
          return;
        }

        // mos-install on multiple disks in parallel is not supported
        for (const operation of this.activeOperations.values()) {
          if (operation.status === 'running') {
            this.sendUpdate(socket, null, 'error', { message: 'An installation is already running', operationId: operation.operationId });
            return;
          }
        }

        const operationId = `install-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
        socket.join(`operation-${operationId}`);

        const params = {
          disk,
          filesystem,
          extra_partition: !!extra_partition,
          tar_file: tar_file || '',
          backup_label: !!backup_label
        };

        console.log(`Client ${socket.id} starting installation to disk (${operationId}): ${disk} (${filesystem})`);
        this.executeInstall(operationId, params);

      } catch (error) {
        console.error('Error in installtodisk-run:', error);
        this.sendUpdate(socket, null, 'error', { message: 'Failed to start installation' });
      }
    });

    // Cancel a running installation (kills process group including children)
    socket.on('installtodisk-cancel', async (data) => {
      try {
        const { token, operationId } = data || {};

        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          this.sendUpdate(socket, operationId, 'error', { message: authResult.message });
          return;
        }

        if (authResult.user.role !== 'admin') {
          this.sendUpdate(socket, operationId, 'error', { message: 'Admin role required for installation to disk' });
          return;
        }

        this.cancelOperation(operationId);

      } catch (error) {
        console.error('Error in installtodisk-cancel:', error);
        this.sendUpdate(socket, null, 'error', { message: 'Failed to cancel installation' });
      }
    });

    // List operations, replay buffered output and rejoin running operation rooms
    socket.on('installtodisk-get-operations', async (data) => {
      try {
        const { token } = data || {};

        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          this.sendUpdate(socket, null, 'error', { message: authResult.message });
          return;
        }

        if (authResult.user.role !== 'admin') {
          this.sendUpdate(socket, null, 'error', { message: 'Admin role required for installation to disk' });
          return;
        }

        const operations = [];
        for (const [operationId, operation] of this.activeOperations.entries()) {
          operations.push({
            operationId,
            ...operation.params,
            status: operation.status,
            exitCode: operation.exitCode,
            signal: operation.signal,
            duration: (operation.completedAt || Date.now()) - operation.startTime
          });
        }

        this.sendUpdate(socket, null, 'operations-list', { operations });

        // Replay buffered output, then join rooms of still-running operations
        for (const [operationId, operation] of this.activeOperations.entries()) {
          for (const chunk of operation.outputChunks) {
            socket.emit('installtodisk-update', {
              status: 'running',
              operationId,
              timestamp: Date.now(),
              output: chunk.data,
              stream: chunk.stream,
              replay: true
            });
          }
          if (operation.status === 'running') {
            socket.join(`operation-${operationId}`);
          }
        }

      } catch (error) {
        console.error('Error in installtodisk-get-operations:', error);
        this.sendUpdate(socket, null, 'error', { message: 'Failed to get operations' });
      }
    });

    // Handle disconnect - installation continues running
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
      this.io.to(`operation-${operationId}`).emit('installtodisk-update', payload);
    } else if (target && target.emit) {
      target.emit('installtodisk-update', payload);
    }
  }

  /**
   * Execute mos-install with streaming output
   * Command matches POST /mos/installtodisk: quiet mode and api notifications enabled
   */
  executeInstall(operationId, params) {
    const { disk, filesystem, extra_partition, tar_file, backup_label } = params;
    const args = [
      INSTALL_SCRIPT,
      disk,
      filesystem,
      'quiet',
      String(extra_partition),
      'api',
      tar_file,
      String(backup_label)
    ];
    const commandLine = `bash ${args.map(shellQuote).join(' ')}`;

    let proc;
    try {
      // detached: own process group so cancel can kill the whole tree
      proc = spawn('bash', ['-c', commandLine], { cwd: INSTALL_CWD, detached: true });
    } catch (error) {
      this.sendUpdate(null, operationId, 'error', { message: `Failed to start installation: ${error.message}` });
      return;
    }

    const startTime = Date.now();
    const operation = {
      operationId,
      process: proc,
      pid: proc.pid,
      params,
      startTime,
      completedAt: null,
      status: 'running',
      exitCode: null,
      signal: null,
      outputChunks: [],
      outputBytes: 0,
      cancelled: false,
      killTimer: null
    };
    this.activeOperations.set(operationId, operation);
    this._evictOldOperations();

    this.sendUpdate(null, operationId, 'started', { ...params, pid: proc.pid });

    const streamOutput = (data, stream) => {
      const output = stripAnsi(data.toString());
      this._appendToBuffer(operation, stream, output);
      this.sendUpdate(null, operationId, 'running', { output, stream });
    };

    proc.stdout.on('data', (data) => streamOutput(data, 'stdout'));
    proc.stderr.on('data', (data) => streamOutput(data, 'stderr'));

    proc.on('close', (code, signal) => {
      operation.completedAt = Date.now();
      operation.exitCode = code;
      operation.signal = signal;
      operation.status = operation.cancelled ? 'cancelled' : 'completed';

      this.sendUpdate(null, operationId, operation.status, {
        ...params,
        exitCode: code,
        signal,
        duration: operation.completedAt - startTime
      });

      if (operation.cancelled) {
        this._umountInstallerMounts();
      }

      console.log(`InstallToDisk operation ${operationId} ${operation.status} (exit=${code}, signal=${signal})`);
    });

    proc.on('error', (error) => {
      operation.status = 'failed';
      this.sendUpdate(null, operationId, 'error', { message: `Process error: ${error.message}` });
    });
  }

  /**
   * Cancel a running installation by killing its process group (SIGTERM, then SIGKILL)
   */
  cancelOperation(operationId) {
    const operation = this.activeOperations.get(operationId);

    if (!operation || operation.status !== 'running') {
      this.sendUpdate(null, operationId, 'error', { message: 'Operation not found or already completed' });
      return;
    }

    try {
      operation.cancelled = true;
      process.kill(-operation.pid, 'SIGTERM');

      operation.killTimer = setTimeout(() => {
        operation.killTimer = null;
        // Sweep stragglers in the group (bash can defer SIGTERM while waiting)
        try {
          process.kill(-operation.pid, 'SIGKILL');
        } catch {}
        // Second unmount pass once the whole group is guaranteed dead
        this._umountInstallerMounts();
      }, KILL_ESCALATION_MS);

      this.sendUpdate(null, operationId, 'cancelling', { message: 'Cancellation requested' });
      console.log(`InstallToDisk operation ${operationId} (pgid ${operation.pid}) cancel requested`);
    } catch (error) {
      operation.cancelled = false;
      console.error('Error cancelling operation:', error);
      this.sendUpdate(null, operationId, 'error', { message: `Failed to cancel operation: ${error.message}` });
    }
  }

  /**
   * Unmount installer mount points after cancelled installations (mos-install leaves them mounted when killed)
   */
  _umountInstallerMounts() {
    for (const mountPoint of ['/var/mos/installer/boot', '/var/mos/installer/esp']) {
      const proc = spawn('umount', [mountPoint]);
      proc.on('error', () => {});
    }
  }

  /**
   * Keep output buffer per operation bounded
   */
  _appendToBuffer(operation, stream, output) {
    operation.outputChunks.push({ stream, data: output });
    operation.outputBytes += output.length;

    while (operation.outputBytes > MAX_BUFFER_BYTES && operation.outputChunks.length > 1) {
      const removed = operation.outputChunks.shift();
      operation.outputBytes -= removed.data.length;
    }
  }

  /**
   * Drop oldest completed operations when exceeding the retention limit
   */
  _evictOldOperations() {
    if (this.activeOperations.size <= MAX_RETAINED_OPERATIONS) return;

    for (const [operationId, operation] of this.activeOperations.entries()) {
      if (this.activeOperations.size <= MAX_RETAINED_OPERATIONS) break;
      if (operation.status !== 'running') {
        this.activeOperations.delete(operationId);
      }
    }
  }

  /**
   * Get statistics about installation operations
   */
  getStats() {
    const stats = {
      totalOperations: this.activeOperations.size,
      running: 0,
      operations: []
    };

    for (const [operationId, operation] of this.activeOperations.entries()) {
      if (operation.status === 'running') stats.running++;
      stats.operations.push({
        operationId,
        ...operation.params,
        status: operation.status,
        duration: (operation.completedAt || Date.now()) - operation.startTime
      });
    }

    return stats;
  }

  /**
   * Authenticate user via token (boot token, admin API token or JWT)
   * Admin API tokens need 'write' permission for 'terminal' (shell access)
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
        // Restricted tokens need 'write' permission for 'terminal' (shell access)
        if (!isActionAllowed(adminTokenData.permissions, 'terminal', 'write')) {
          return { success: false, message: "Access denied. This token does not have 'write' permission for 'terminal'." };
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
          role: currentUser.role
        }
      };

    } catch (authError) {
      return { success: false, message: 'Invalid authentication token' };
    }
  }
}

module.exports = InstallToDiskWebSocketManager;
