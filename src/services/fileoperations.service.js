const { spawn } = require('child_process');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');

// Timestamp-basierter ID-Generator
const generateId = () => Date.now().toString();

class FileOperationsService extends EventEmitter {
  constructor() {
    super();
    this.operations = new Map(); // id -> operation object
    this.poolsFile = '/boot/config/pools.json';
    this.mergerfsBasePath = '/var/mergerfs';
    this.mountBasePath = '/mnt';
    this.completedRetentionMs = 5 * 60 * 1000; // 5 minutes retention for completed ops

    // Cleanup completed operations periodically
    this.cleanupInterval = setInterval(() => this._cleanupCompleted(), 60000);
  }

  /**
   * Start a file operation (copy or move)
   * @param {Object} params - Operation parameters
   * @param {string} params.operation - "copy" or "move"
   * @param {string|string[]} params.source - Source file/directory path or array of paths
   * @param {string} params.destination - Destination directory path
   * @param {string} params.onConflict - "fail", "overwrite", or "skip" (default: "fail")
   * @param {Object} user - User object with byte_format preference
   * @returns {Promise<Object>} Operation object
   */
  async startOperation({ operation, source, destination, onConflict = 'fail', user }) {
    // Validate operation type
    if (!operation || !['copy', 'move'].includes(operation)) {
      throw new Error('Invalid operation. Must be "copy" or "move"');
    }

    // Validate onConflict
    if (!['fail', 'overwrite', 'skip'].includes(onConflict)) {
      throw new Error('Invalid onConflict. Must be "fail", "overwrite", or "skip"');
    }

    if (!source || (Array.isArray(source) && source.length === 0) || !destination) {
      throw new Error('Source and destination are required');
    }

    // Normalize sources, remember input shape to mirror it in responses
    const sourceIsArray = Array.isArray(source);
    const sources = (sourceIsArray ? source : [source]).map(s => {
      if (typeof s !== 'string' || !s.trim()) {
        throw new Error('Invalid source. Must be a path or an array of paths');
      }
      return path.resolve(s);
    });
    const normalizedDest = path.resolve(destination);

    // Check sources exist
    for (const src of sources) {
      try {
        await fs.stat(src);
      } catch (e) {
        if (e.code === 'ENOENT') {
          throw new Error(`Source does not exist: ${src}`);
        }
        throw e;
      }
    }

    // Check destination exists and is a directory
    try {
      const destStats = await fs.stat(normalizedDest);
      if (!destStats.isDirectory()) {
        throw new Error('Destination must be a directory');
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new Error(`Destination does not exist: ${normalizedDest}`);
      }
      throw e;
    }

    // MergerFS validation (each source against destination)
    for (const src of sources) {
      await this._validateMergerfsRules(operation, src, normalizedDest);
    }

    // Check for conflicts (fail mode)
    const destinationsFull = sources.map(s => path.join(normalizedDest, path.basename(s)));
    if (onConflict === 'fail') {
      for (const destPath of destinationsFull) {
        try {
          await fs.access(destPath);
          throw new Error(`Destination already exists: ${destPath}. Use onConflict "overwrite" or "skip" to proceed`);
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
          // ENOENT = doesn't exist = good
        }
      }
    }

    // Generate operation ID
    const id = generateId();

    // Create operation object
    const op = {
      id,
      operation,
      sources,
      sourceIsArray,
      destination: normalizedDest,
      destinationsFull,
      status: 'preparing',
      instantMove: false,
      onConflict,
      progress: 0,
      speed: 0,
      eta: null,
      bytesTransferred: 0,
      bytesTotal: 0,
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
      _process: null // internal, not exposed via API
    };

    this.operations.set(id, op);
    this._emitUpdate(id);

    // Start async operation (don't await - runs in background)
    this._executeOperation(op, user).catch(err => {
      op.status = 'failed';
      op.error = err.message;
      op.completedAt = new Date().toISOString();
      this._emitUpdate(id);
    });

    return this._sanitizeOperation(op, user);
  }

  /**
   * Execute the file operation (runs in background)
   * @private
   */
  async _executeOperation(op, user) {
    // For move operations, try instant move first (same filesystem)
    let pendingSources = op.sources;
    if (op.operation === 'move') {
      pendingSources = [];
      for (let i = 0; i < op.sources.length; i++) {
        try {
          await fs.rename(op.sources[i], op.destinationsFull[i]);
        } catch (e) {
          if (e.code !== 'EXDEV') throw e;
          // Cross-device move → fall through to rsync for this source
          pendingSources.push(op.sources[i]);
        }
      }
      if (pendingSources.length === 0) {
        op.instantMove = true;
        op.status = 'completed';
        op.progress = 100;
        op.completedAt = new Date().toISOString();
        this._emitUpdate(op.id);
        return;
      }
    }

    // Calculate total size for progress tracking and disk space check
    op.status = 'preparing';
    this._emitUpdate(op.id);

    try {
      const quoted = pendingSources.map(s => `"${s}"`).join(' ');
      const { stdout } = await execPromise(`du -sb ${quoted}`);
      op.bytesTotal = stdout
        .split('\n')
        .reduce((sum, line) => sum + (parseInt(line.split('\t')[0], 10) || 0), 0);
    } catch (e) {
      console.warn(`[FileOps] Failed to calculate source size for ${op.id}: ${e.message}`);
    }

    // Check disk space
    if (op.bytesTotal > 0) {
      try {
        const { stdout } = await execPromise(`df -B1 --output=avail "${op.destination}" | tail -1`);
        const available = parseInt(stdout.trim(), 10);
        if (available > 0 && available < op.bytesTotal) {
          const disksService = require('./disks.service');
          throw new Error(
            `Not enough disk space. Required: ${disksService.formatBytes(op.bytesTotal, user)}, ` +
            `Available: ${disksService.formatBytes(available, user)}`
          );
        }
      } catch (e) {
        if (e.message.includes('Not enough disk space')) throw e;
        console.warn(`[FileOps] Failed to check disk space for ${op.id}: ${e.message}`);
      }
    }

    // Start rsync
    op.status = 'running';
    this._emitUpdate(op.id);

    await this._runRsync(op, user, pendingSources);
  }

  /**
   * Run rsync with progress tracking
   * @private
   */
  _runRsync(op, user, sources) {
    return new Promise((resolve, reject) => {
      const args = [
        '-a',
        '--info=progress2',
        '--no-i-r'
      ];

      // Move: remove source files after transfer
      if (op.operation === 'move') {
        args.push('--remove-source-files');
      }

      // Skip existing files
      if (op.onConflict === 'skip') {
        args.push('--ignore-existing');
      }

      // Source paths (no trailing slash = copy the directory itself)
      for (const src of sources) {
        args.push(src);
      }
      // Destination directory (trailing slash = put into this directory)
      args.push(op.destination + '/');

      const rsync = spawn('rsync', args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      op._process = rsync;

      // Parse rsync progress output from stdout
      let outputBuffer = '';
      rsync.stdout.on('data', (data) => {
        outputBuffer += data.toString();
        // rsync uses \r for progress line updates
        const lines = outputBuffer.split('\r');
        outputBuffer = lines.pop(); // Keep incomplete line

        for (const line of lines) {
          this._parseRsyncProgress(op, line.trim(), user);
        }
      });

      rsync.stderr.on('data', (data) => {
        const errStr = data.toString().trim();
        if (errStr) {
          console.error(`[FileOps] rsync stderr for ${op.id}: ${errStr}`);
        }
      });

      rsync.on('close', (code) => {
        op._process = null;

        if (code === 0) {
          op.status = 'completed';
          op.progress = 100;
          op.completedAt = new Date().toISOString();
          this._emitUpdate(op.id);

          // For move: clean up empty source directories left by --remove-source-files
          if (op.operation === 'move') {
            for (const src of op.sources) {
              this._cleanupEmptyDirs(src).catch(() => {});
            }
          }

          resolve();
        } else if (code === 20) {
          // rsync: received SIGUSR1 or SIGINT (cancelled)
          op.status = 'cancelled';
          op.completedAt = new Date().toISOString();
          this._emitUpdate(op.id);
          resolve();
        } else {
          op.status = 'failed';
          op.error = `rsync exited with code ${code}`;
          op.completedAt = new Date().toISOString();
          this._emitUpdate(op.id);
          reject(new Error(op.error));
        }
      });

      rsync.on('error', (err) => {
        op._process = null;
        op.status = 'failed';
        op.error = err.message;
        op.completedAt = new Date().toISOString();
        this._emitUpdate(op.id);
        reject(err);
      });
    });
  }

  /**
   * Parse rsync --info=progress2 output line
   * Format: "1,234,567  45%    1.23MB/s    0:01:23"
   * @private
   */
  _parseRsyncProgress(op, line, user) {
    const match = line.match(/^\s*([\d,]+)\s+(\d+)%\s+([\d.]+[kKmMgGtT]?B\/s)\s+(\d+:\d+:\d+)/);
    if (match) {
      op.bytesTransferred = parseInt(match[1].replace(/,/g, ''), 10);
      op.progress = parseInt(match[2], 10);
      op.speed = this._parseRsyncSpeed(match[3]);
      op.eta = match[4];

      // Don't emit on every line - WebSocket manager handles throttled broadcasts
    }
  }

  /**
   * Parse rsync speed string to bytes per second
   * @param {string} speedStr - e.g., "1.23MB/s", "456.78kB/s"
   * @returns {number} Bytes per second
   * @private
   */
  _parseRsyncSpeed(speedStr) {
    const match = speedStr.match(/([\d.]+)([kKmMgGtT]?)B\/s/);
    if (!match) return 0;

    const value = parseFloat(match[1]);
    const unit = match[2].toUpperCase();

    const multipliers = {
      '': 1,
      'K': 1024,
      'M': 1024 * 1024,
      'G': 1024 * 1024 * 1024,
      'T': 1024 * 1024 * 1024 * 1024
    };
    return Math.round(value * (multipliers[unit] || 1));
  }

  /**
   * Clean up empty directories after rsync --remove-source-files
   * @private
   */
  async _cleanupEmptyDirs(dirPath) {
    try {
      // Use find to remove empty directories bottom-up
      await execPromise(`find "${dirPath}" -type d -empty -delete 2>/dev/null`);
      // Try to remove the source directory itself if empty
      try {
        await fs.rmdir(dirPath);
      } catch (e) {
        // Directory not empty or doesn't exist - that's fine
      }
    } catch (e) {
      console.warn(`[FileOps] Failed to cleanup empty dirs: ${e.message}`);
    }
  }

  // ============================================================
  // MERGERFS VALIDATION
  // ============================================================

  /**
   * Validate MergerFS copy/move rules
   * BLOCKS copy operations where source and destination belong to the same pool
   * ALLOWS move operations in all cases
   * @private
   */
  async _validateMergerfsRules(operation, source, destination) {
    // Only copy operations are restricted
    if (operation !== 'copy') return;

    // Detect which pool the source belongs to
    const sourcePool = this._detectPoolFromPath(source);
    const destPool = this._detectPoolFromPath(destination);

    // If neither path is in a pool, no restriction
    if (!sourcePool && !destPool) return;

    // If both belong to the same pool, BLOCK the copy
    if (sourcePool && destPool && sourcePool === destPool) {
      throw new Error(
        `Copy operation blocked: Source and destination both belong to pool "${sourcePool}". ` +
        `Copying within the same MergerFS pool creates duplicates and corrupts the pool. ` +
        `Use "move" instead, or copy to a different pool/location`
      );
    }
  }

  /**
   * Detect which pool a path belongs to
   * Checks both /mnt/POOLNAME and /var/mergerfs/POOLNAME paths
   * @param {string} filePath - Absolute path to check
   * @returns {string|null} Pool name or null
   * @private
   */
  _detectPoolFromPath(filePath) {
    // Check /var/mergerfs/POOLNAME/...
    if (filePath.startsWith(this.mergerfsBasePath + '/')) {
      const relativePath = filePath.substring(this.mergerfsBasePath.length + 1);
      const poolName = relativePath.split('/')[0];
      if (poolName) return poolName;
    }

    // Check /mnt/POOLNAME/...
    if (filePath.startsWith(this.mountBasePath + '/')) {
      const relativePath = filePath.substring(this.mountBasePath.length + 1);
      const poolName = relativePath.split('/')[0];
      if (poolName) return this._isPoolName(poolName) ? poolName : null;
    }

    return null;
  }

  /**
   * Check if a name under /mnt/ corresponds to an actual pool
   * Uses pools.json to verify - only mergerfs and nonraid pools use /var/mergerfs
   * @param {string} name - Directory name under /mnt/
   * @returns {boolean}
   * @private
   */
  _isPoolName(name) {
    try {
      const data = require('fs').readFileSync(this.poolsFile, 'utf8');
      const pools = JSON.parse(data);
      return pools.some(pool =>
        pool.name === name &&
        ['mergerfs', 'nonraid'].includes(pool.type)
      );
    } catch (e) {
      // If pools.json can't be read, don't block the operation
      console.warn(`[FileOps] Could not read pools.json for validation: ${e.message}`);
      return false;
    }
  }

  // ============================================================
  // OPERATION MANAGEMENT
  // ============================================================

  /**
   * Cancel a running operation
   * @param {string} id - Operation ID
   * @returns {Object} Updated operation object
   */
  cancelOperation(id, user) {
    const op = this.operations.get(id);
    if (!op) {
      throw new Error(`Operation not found: ${id}`);
    }

    if (op.status === 'completed' || op.status === 'failed' || op.status === 'cancelled') {
      throw new Error(`Operation ${id} is already ${op.status}`);
    }

    // Kill the rsync process
    if (op._process) {
      op._process.kill('SIGINT');
    }

    op.status = 'cancelled';
    op.completedAt = new Date().toISOString();
    this._emitUpdate(id);

    return this._sanitizeOperation(op, user);
  }

  /**
   * Get all operations (running + recently completed)
   * @param {Object} user - User object with byte_format preference
   * @returns {Array} Array of operation objects
   */
  getOperations(user) {
    const ops = [];
    for (const op of this.operations.values()) {
      ops.push(this._sanitizeOperation(op, user));
    }
    // Sort: running first, then by startedAt descending
    ops.sort((a, b) => {
      const statusOrder = { preparing: 0, running: 1, pending: 2, completed: 3, failed: 4, cancelled: 5 };
      const aOrder = statusOrder[a.status] ?? 99;
      const bOrder = statusOrder[b.status] ?? 99;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return new Date(b.startedAt) - new Date(a.startedAt);
    });
    return ops;
  }

  /**
   * Get a single operation by ID
   * @param {string} id - Operation ID
   * @param {Object} user - User object with byte_format preference
   * @returns {Object|null} Operation object or null
   */
  getOperation(id, user) {
    const op = this.operations.get(id);
    if (!op) return null;
    return this._sanitizeOperation(op, user);
  }

  /**
   * Get count of currently running operations
   * @returns {number}
   */
  getRunningCount() {
    let count = 0;
    for (const op of this.operations.values()) {
      if (op.status === 'preparing' || op.status === 'running') {
        count++;
      }
    }
    return count;
  }

  // ============================================================
  // INTERNAL HELPERS
  // ============================================================

  /**
   * Mirror the request shape for output fields (string stays string, array stays array)
   * @private
   */
  _mirrorShape(op, values) {
    return op.sourceIsArray ? [...values] : values[0];
  }

  /**
   * Sanitize operation for API output (remove internal fields, add _human fields)
   * @private
   */
  _sanitizeOperation(op, user) {
    const disksService = require('./disks.service');

    return {
      id: op.id,
      operation: op.operation,
      source: this._mirrorShape(op, op.sources),
      destination: op.destination,
      destinationFull: this._mirrorShape(op, op.destinationsFull),
      status: op.status,
      instantMove: op.instantMove,
      onConflict: op.onConflict,
      progress: op.progress,
      speed: op.speed,
      speed_human: disksService.formatSpeed(op.speed, user),
      eta: op.eta,
      bytesTransferred: op.bytesTransferred,
      bytesTransferred_human: disksService.formatBytes(op.bytesTransferred, user),
      bytesTotal: op.bytesTotal,
      bytesTotal_human: disksService.formatBytes(op.bytesTotal, user),
      startedAt: op.startedAt,
      completedAt: op.completedAt,
      error: op.error
    };
  }

  /**
   * Emit operation update event for WebSocket
   * @private
   */
  _emitUpdate(operationId) {
    const op = this.operations.get(operationId);
    if (op) {
      // Emit raw operation data - WebSocket manager formats per client
      this.emit('operation-update', operationId, {
        id: op.id,
        operation: op.operation,
        source: this._mirrorShape(op, op.sources),
        destination: op.destination,
        destinationFull: this._mirrorShape(op, op.destinationsFull),
        status: op.status,
        instantMove: op.instantMove,
        onConflict: op.onConflict,
        progress: op.progress,
        speed: op.speed,
        eta: op.eta,
        bytesTransferred: op.bytesTransferred,
        bytesTotal: op.bytesTotal,
        startedAt: op.startedAt,
        completedAt: op.completedAt,
        error: op.error
      });
    }
  }

  /**
   * Cleanup completed operations older than retention period
   * @private
   */
  _cleanupCompleted() {
    const now = Date.now();
    for (const [id, op] of this.operations) {
      if (op.completedAt) {
        const completedTime = new Date(op.completedAt).getTime();
        if (now - completedTime > this.completedRetentionMs) {
          this.operations.delete(id);
        }
      }
    }
  }

  /**
   * Shutdown service
   */
  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // Cancel all running operations
    for (const op of this.operations.values()) {
      if (op._process) {
        op._process.kill('SIGINT');
      }
    }

    this.operations.clear();
  }
}

// Export singleton instance
module.exports = new FileOperationsService();
