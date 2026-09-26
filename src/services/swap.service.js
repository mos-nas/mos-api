const fs = require('fs').promises;
const path = require('path');
const net = require('net');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const PoolsService = require('./pools.service');

const MOS_NOTIFY_SOCKET = '/run/mos-notify.sock';

/**
 * Swap Service - Manages swapfile and zswap configuration
 */
class SwapService {
  constructor() {
    this.configPath = '/boot/config/system.json';
    this._busy = false;
  }

  /**
   * Send notification via mos-notify socket
   * @private
   */
  _notify(message, priority = 'normal') {
    const client = net.createConnection(MOS_NOTIFY_SOCKET, () => {
      client.write(JSON.stringify({ title: 'Swap', message, priority }));
      client.end();
    });
    client.on('error', () => {});
  }

  // ============================================================
  // DEFAULT CONFIGURATION
  // ============================================================

  /**
   * Get default swapfile configuration
   * @returns {Object} Default swapfile config
   */
  getDefaultConfig() {
    return {
      enabled: false,
      path: null,
      size: '10G',
      priority: -2,
      config: {
        zswap: false,
        shrinker: true,
        max_pool_percent: 20,
        compressor: 'zstd',
        accept_threshold_percent: 90
      }
    };
  }

  // ============================================================
  // FILESYSTEM HELPERS
  // ============================================================

  /**
   * Get filesystem type for a given path
   * @param {string} dirPath - Directory path
   * @returns {Promise<Object>} Filesystem info with type and mount point
   */
  async getFilesystemInfo(dirPath) {
    try {
      // Use df to get the mount point and filesystem type
      const { stdout } = await execPromise(`df -T "${dirPath}" | tail -1`);
      const parts = stdout.trim().split(/\s+/);
      // Format: Filesystem Type 1K-blocks Used Available Use% Mounted on
      if (parts.length >= 7) {
        return {
          device: parts[0],
          filesystem: parts[1].toLowerCase(),
          mountPoint: parts[6]
        };
      }
      throw new Error('Unexpected df output format');
    } catch (error) {
      throw new Error(`Could not determine filesystem for ${dirPath}: ${error.message}`);
    }
  }

  /**
   * Check if a BTRFS filesystem is using RAID (data profile)
   * @param {string} mountPoint - BTRFS mount point
   * @returns {Promise<Object>} RAID info
   */
  async checkBtrfsRaidProfile(mountPoint) {
    const profile = (await new PoolsService().getBtrfsRaidProfile(mountPoint)) || 'unknown';
    const isRaid = ['raid0', 'raid1', 'raid5', 'raid6', 'raid10', 'raid1c3', 'raid1c4'].includes(profile);
    return {
      profile,
      isRaid,
      allowed: !isRaid // Swapfile only allowed on single/dup profile
    };
  }

  /**
   * Parse size string to bytes (e.g., "10G" -> 10737418240)
   * @param {string} sizeStr - Size string (e.g., "10G", "1024M", "500K")
   * @returns {number} Size in bytes
   */
  parseSizeToBytes(sizeStr) {
    const match = String(sizeStr).match(/^(\d+(?:\.\d+)?)\s*([KMGT]?)B?$/i);
    if (!match) {
      throw new Error(`Invalid size format: ${sizeStr}. Use format like "10G", "1024M", etc.`);
    }
    const value = parseFloat(match[1]);
    const unit = (match[2] || '').toUpperCase();
    const multipliers = { '': 1, 'K': 1024, 'M': 1024 ** 2, 'G': 1024 ** 3, 'T': 1024 ** 4 };
    return Math.floor(value * multipliers[unit]);
  }

  /**
   * Format bytes to human readable (simple version)
   */
  formatBytesSimple(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let value = bytes;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    return `${value.toFixed(2)} ${units[i]}`;
  }

  /**
   * Extract pool info from a path
   * Handles both /mnt/POOLNAME/... and /var/mergerfs/POOLNAME/diskN/...
   * @param {string} swapPath - Full path
   * @returns {Object} Pool info with name, mountPoint, and type
   */
  extractPoolInfo(swapPath) {
    const normalizedPath = path.resolve(swapPath);

    // Check for MergerFS disk path: /var/mergerfs/POOLNAME/diskN/...
    if (normalizedPath.startsWith('/var/mergerfs/')) {
      const pathParts = normalizedPath.split('/');
      if (pathParts.length >= 5) {
        const poolName = pathParts[3];
        const diskName = pathParts[4];
        return {
          type: 'mergerfs',
          poolName,
          diskName,
          mountPoint: `/var/mergerfs/${poolName}/${diskName}`,
          isValid: true
        };
      }
      return { isValid: false, error: 'Invalid MergerFS path format. Expected: /var/mergerfs/POOLNAME/diskN/...' };
    }

    // Check for standard pool path: /mnt/POOLNAME/...
    if (normalizedPath.startsWith('/mnt/')) {
      const pathParts = normalizedPath.split('/');
      if (pathParts.length >= 3) {
        const poolName = pathParts[2];
        return {
          type: 'standard',
          poolName,
          diskName: null,
          mountPoint: `/mnt/${poolName}`,
          isValid: true
        };
      }
      return { isValid: false, error: 'Invalid pool path format' };
    }

    return { isValid: false, error: 'Swapfile must be on a mounted pool under /mnt/ or MergerFS disk under /var/mergerfs/' };
  }

  // ============================================================
  // VALIDATION
  // ============================================================

  /**
   * Validate swapfile path and check requirements
   * @param {string} swapPath - Path for swapfile directory
   * @param {string} size - Swapfile size
   * @returns {Promise<Object>} Validation result
   */
  async validateSwapfilePath(swapPath, size) {
    const result = {
      valid: false,
      path: swapPath,
      filesystem: null,
      isBtrfs: false,
      error: null
    };

    try {
      // Extract pool info from path
      const poolInfo = this.extractPoolInfo(swapPath);
      if (!poolInfo.isValid) {
        result.error = poolInfo.error;
        return result;
      }

      result.poolName = poolInfo.poolName;
      result.poolType = poolInfo.type;

      // Check if pool/disk is mounted
      const poolsService = new PoolsService();
      const isMounted = await poolsService._isMounted(poolInfo.mountPoint);
      if (!isMounted) {
        if (poolInfo.type === 'mergerfs') {
          result.error = `MergerFS disk "${poolInfo.diskName}" in pool "${poolInfo.poolName}" is not mounted. Mount the pool first.`;
        } else {
          result.error = `Pool "${poolInfo.poolName}" is not mounted. Mount the pool first.`;
        }
        return result;
      }

      // Get filesystem info from the actual mount point
      const fsInfo = await this.getFilesystemInfo(poolInfo.mountPoint);
      result.filesystem = fsInfo.filesystem;
      result.isBtrfs = fsInfo.filesystem === 'btrfs';
      result.mountPoint = poolInfo.mountPoint;

      // Check for MergerFS - swapfiles are not supported on MergerFS pools
      if (fsInfo.filesystem === 'fuse.mergerfs' || fsInfo.filesystem === 'mergerfs') {
        result.error = `Swapfiles are not supported on MergerFS pools. Use a direct disk path under /var/mergerfs/${poolInfo.poolName}/diskN/ instead.`;
        return result;
      }

      // bcachefs has no swapfile support in the kernel
      if (fsInfo.filesystem === 'bcachefs') {
        result.error = `Swapfiles are not supported on bcachefs pools. Use a swap partition or ZRAM instead.`;
        return result;
      }

      // If BTRFS, check for RAID profile
      if (result.isBtrfs) {
        const raidInfo = await this.checkBtrfsRaidProfile(poolInfo.mountPoint);
        if (!raidInfo.allowed) {
          result.error = `BTRFS pool "${poolInfo.poolName}" uses ${raidInfo.profile.toUpperCase()} profile. Swapfiles are only allowed on single-device BTRFS pools (single/dup profile).`;
          return result;
        }
        result.btrfsProfile = raidInfo.profile;
      }

      // Check available space on the pool mount point (not the subdirectory)
      const sizeBytes = this.parseSizeToBytes(size);
      const spaceInfo = await poolsService.getDeviceSpace(poolInfo.mountPoint);

      if (!spaceInfo.mounted) {
        result.error = `Could not get space info for ${poolInfo.type === 'mergerfs' ? 'disk' : 'pool'} "${poolInfo.poolName}"`;
        return result;
      }

      // Need at least the swapfile size + 1GB buffer
      const requiredSpace = sizeBytes + (1024 ** 3);
      if (spaceInfo.freeSpace < requiredSpace) {
        const freeHuman = this.formatBytesSimple(spaceInfo.freeSpace);
        const neededHuman = this.formatBytesSimple(requiredSpace);
        result.error = `Not enough free space on "${poolInfo.mountPoint}". Available: ${freeHuman}, Required: ${neededHuman}`;
        return result;
      }

      result.valid = true;
      result.freeSpace = spaceInfo.freeSpace;
      return result;

    } catch (error) {
      result.error = `Validation failed: ${error.message}`;
      return result;
    }
  }

  // ============================================================
  // SWAPFILE MANAGEMENT
  // ============================================================

  /**
   * Get the full swapfile path
   * @param {string} basePath - Base directory path
   * @returns {string} Full path to swapfile
   */
  getSwapfilePath(basePath) {
    return path.join(basePath, '.swapfile');
  }

  /**
   * Check if swapfile is currently active
   * @param {string} swapfilePath - Path to swapfile
   * @returns {Promise<boolean>}
   */
  async isSwapfileActive(swapfilePath) {
    try {
      const { stdout } = await execPromise('cat /proc/swaps');
      return stdout.includes(swapfilePath);
    } catch {
      return false;
    }
  }

  /**
   * Create swapfile with proper handling for BTRFS vs other filesystems
   * @param {string} basePath - Base directory for swapfile
   * @param {string} size - Swapfile size (e.g., "10G")
   * @param {boolean} isBtrfs - Whether the filesystem is BTRFS
   * @param {number} priority - Swap priority (default -2)
   * @returns {Promise<void>}
   */
  async createSwapfile(basePath, size, isBtrfs, priority = -2) {
    const swapfilePath = this.getSwapfilePath(basePath);
    const sizeBytes = this.parseSizeToBytes(size);
    const sizeMB = Math.floor(sizeBytes / (1024 ** 2));

    // Ensure directory exists
    await fs.mkdir(basePath, { recursive: true });

    if (isBtrfs) {
      // BTRFS requires special handling: truncate + chattr +C + fallocate
      console.log(`[Swapfile] Creating BTRFS swapfile at ${swapfilePath}`);

      // Step 1: Truncate to zero (creates empty file)
      await execPromise(`truncate -s 0 "${swapfilePath}"`);

      // Step 2: Set NOCOW attribute (chattr +C) - required for BTRFS swapfiles
      await execPromise(`chattr +C "${swapfilePath}"`);

      // Step 3: Allocate space with fallocate
      await execPromise(`fallocate -l ${size} "${swapfilePath}"`);
    } else {
      // Non-BTRFS: use dd to create swapfile
      console.log(`[Swapfile] Creating swapfile at ${swapfilePath} with dd`);
      await execPromise(`dd if=/dev/zero of="${swapfilePath}" bs=1M count=${sizeMB} status=progress`);
    }

    // Set permissions
    await execPromise(`chmod 600 "${swapfilePath}"`);

    // Create swap signature
    await execPromise(`mkswap "${swapfilePath}"`);

    // Activate swap with priority
    await execPromise(`swapon --priority ${priority} "${swapfilePath}"`);

    console.log(`[Swapfile] Swapfile ${swapfilePath} created and activated (${size}, priority=${priority})`);
    this._notify(`Swapfile created and activated (${size})`);
  }

  /**
   * Remove an existing swapfile
   * @param {string} basePath - Base directory containing swapfile
   * @returns {Promise<boolean>} True if removed, false if not found
   */
  async removeSwapfile(basePath) {
    const swapfilePath = this.getSwapfilePath(basePath);

    try {
      // Check if file exists
      await fs.access(swapfilePath);
    } catch {
      // File doesn't exist
      return false;
    }

    // Deactivate swap if active
    if (await this.isSwapfileActive(swapfilePath)) {
      console.log(`[Swapfile] Deactivating swapfile ${swapfilePath}`);
      await execPromise(`swapoff "${swapfilePath}"`);
    }

    // Remove file
    console.log(`[Swapfile] Removing swapfile ${swapfilePath}`);
    await fs.unlink(swapfilePath);
    this._notify('Swapfile removed');

    return true;
  }

  // ============================================================
  // ZSWAP MANAGEMENT
  // ============================================================

  /**
   * Configure zswap kernel parameters
   * For compressor/shrinker changes, zswap must be disabled first, then re-enabled
   * @param {Object} config - Zswap configuration
   * @param {boolean} config.zswap - Enable/disable zswap
   * @param {boolean} config.shrinker - Enable shrinker
   * @param {number} config.max_pool_percent - Max pool percent
   * @param {string} config.compressor - Compression algorithm
   * @param {number} config.accept_threshold_percent - Accept threshold percent
   * @param {Object} previousConfig - Previous zswap configuration (for detecting changes)
   * @returns {Promise<void>}
   */
  async configureZswap(config, previousConfig = null) {
    const zswapPath = '/sys/module/zswap/parameters';

    try {
      // Check if zswap module is available
      await fs.access(zswapPath);
    } catch {
      if (config.zswap) {
        throw new Error('Zswap module is not available on this system');
      }
      return; // Zswap not available, skip configuration
    }

    console.log('[Zswap] Configuring zswap parameters');

    // Check if critical parameters changed that require zswap restart
    const needsRestart = previousConfig && config.zswap && (
      (config.compressor && config.compressor !== previousConfig.compressor) ||
      (config.shrinker !== undefined && config.shrinker !== previousConfig.shrinker)
    );

    // If critical params changed and zswap is/was enabled, we need to disable first
    if (needsRestart) {
      console.log('[Zswap] Critical parameters changed, disabling zswap first');
      await execPromise(`echo "N" > ${zswapPath}/enabled`);
      // Small delay to ensure zswap is fully disabled
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Configure parameters BEFORE enabling (compressor must be set while disabled)
    if (config.zswap || needsRestart) {
      // Set compressor (must be done while zswap is disabled for changes)
      if (config.compressor) {
        try {
          await execPromise(`echo "${config.compressor}" > ${zswapPath}/compressor`);
          console.log(`[Zswap] Compressor set to: ${config.compressor}`);
        } catch (error) {
          console.warn(`[Zswap] Could not set compressor: ${error.message}`);
        }
      }
    }

    // Now enable/disable zswap
    const enabledValue = config.zswap ? 'Y' : 'N';
    await execPromise(`echo "${enabledValue}" > ${zswapPath}/enabled`);

    if (config.zswap) {
      // Configure other zswap parameters (these can be changed on-the-fly)
      if (config.shrinker !== undefined) {
        const shrinkerValue = config.shrinker ? 'Y' : 'N';
        try {
          await execPromise(`echo "${shrinkerValue}" > ${zswapPath}/shrinker_enabled`);
        } catch {
          // Some kernels don't have shrinker_enabled parameter
          console.warn('[Zswap] shrinker_enabled parameter not available');
        }
      }

      if (config.max_pool_percent !== undefined) {
        await execPromise(`echo "${config.max_pool_percent}" > ${zswapPath}/max_pool_percent`);
      }

      if (config.accept_threshold_percent !== undefined) {
        await execPromise(`echo "${config.accept_threshold_percent}" > ${zswapPath}/accept_threshold_percent`);
      }
    }

    console.log(`[Zswap] Configuration applied: enabled=${config.zswap}`);
  }

  // ============================================================
  // MAIN UPDATE HANDLER
  // ============================================================

  /**
   * Handle swapfile configuration update
   * @param {Object} currentSwapfile - Current swapfile config
   * @param {Object} newSwapfile - New swapfile config
   * @returns {Promise<Object>} Updated swapfile config
   */
  async handleUpdate(currentSwapfile, newSwapfile) {
    if (this._busy) throw new Error('A swapfile operation is already in progress');
    this._busy = true;

    try {
      const result = await this._handleUpdateInternal(currentSwapfile, newSwapfile);
      // Only reset _busy if not running in background
      if (result.status !== 'creating') this._busy = false;
      return result;
    } catch (error) {
      this._busy = false;
      throw error;
    }
  }

  async _handleUpdateInternal(currentSwapfile, newSwapfile) {
    const wasEnabled = currentSwapfile.enabled;
    const willBeEnabled = newSwapfile.enabled !== undefined ? newSwapfile.enabled : wasEnabled;

    const currentPath = currentSwapfile.path;
    const newPath = newSwapfile.path !== undefined ? newSwapfile.path : currentPath;

    const currentSize = currentSwapfile.size;
    const newSize = newSwapfile.size !== undefined ? newSwapfile.size : currentSize;

    const currentPriority = currentSwapfile.priority !== undefined ? currentSwapfile.priority : -2;
    const newPriority = newSwapfile.priority !== undefined ? newSwapfile.priority : currentPriority;

    // Merge config with defaults
    const currentConfig = currentSwapfile.config || {};
    const newConfig = { ...currentConfig, ...newSwapfile.config };

    const pathChanged = newPath !== currentPath;
    const sizeChanged = newSize !== currentSize;
    const priorityChanged = newPriority !== currentPriority;
    const needsRecreate = pathChanged || sizeChanged || priorityChanged;

    // Handle disable
    if (wasEnabled && !willBeEnabled) {
      if (currentPath) await this.removeSwapfile(currentPath);
      await this.configureZswap({ ...newConfig, zswap: false }, currentConfig);
      return { enabled: false, path: newPath, size: newSize, priority: newPriority, config: newConfig };
    }

    // Handle enable or update
    if (willBeEnabled) {
      if (!newPath) throw new Error('Swapfile path is required when enabling swapfile');

      const validation = await this.validateSwapfilePath(newPath, newSize);
      if (!validation.valid) throw new Error(validation.error);

      const swapfilePath = this.getSwapfilePath(newPath);
      const isActive = await this.isSwapfileActive(swapfilePath);

      if (!wasEnabled || needsRecreate) {
        if (wasEnabled && currentPath && pathChanged) await this.removeSwapfile(currentPath);
        if (wasEnabled && !pathChanged && (sizeChanged || priorityChanged) && isActive) await this.removeSwapfile(newPath);

        if (!isActive || needsRecreate) {
          // Run in background - don't await
          this._createInBackground(newPath, newSize, validation.isBtrfs, newPriority, newConfig, currentConfig);
          return { enabled: true, path: newPath, size: newSize, priority: newPriority, config: newConfig, status: 'creating' };
        }
      } else if (!isActive) {
        try {
          await fs.access(swapfilePath);
          await execPromise(`swapon --priority ${newPriority} "${swapfilePath}"`);
          this._notify('Swapfile reactivated');
        } catch {
          this._createInBackground(newPath, newSize, validation.isBtrfs, newPriority, newConfig, currentConfig);
          return { enabled: true, path: newPath, size: newSize, priority: newPriority, config: newConfig, status: 'creating' };
        }
      }

      await this.configureZswap(newConfig, currentConfig);
      return { enabled: true, path: newPath, size: newSize, priority: newPriority, config: newConfig, status: 'ready' };
    }

    return { enabled: false, path: newPath, size: newSize, priority: newPriority, config: newConfig };
  }

  /**
   * Create swapfile in background with notification on completion
   * @private
   */
  async _createInBackground(path, size, isBtrfs, priority, config, prevConfig) {
    this._notify('Swapfile creation started');
    try {
      await this.createSwapfile(path, size, isBtrfs, priority);
      await this.configureZswap(config, prevConfig);
    } catch (error) {
      this._notify(`Creation failed: ${error.message}`, 'alert');
    } finally {
      this._busy = false;
    }
  }

  /**
   * Get current swap status
   * @returns {Promise<Object>} Swap status
   */
  async getStatus() {
    try {
      const { stdout } = await execPromise('cat /proc/swaps');
      const lines = stdout.trim().split('\n').slice(1); // Skip header

      const swaps = lines.map(line => {
        const parts = line.split(/\s+/);
        return {
          filename: parts[0],
          type: parts[1],
          size: parseInt(parts[2], 10) * 1024, // Convert KB to bytes
          used: parseInt(parts[3], 10) * 1024,
          priority: parseInt(parts[4], 10)
        };
      });

      // Get zswap status
      let zswapStatus = null;
      try {
        const zswapPath = '/sys/module/zswap/parameters';
        const [enabled, compressor, maxPool] = await Promise.all([
          execPromise(`cat ${zswapPath}/enabled`).then(r => r.stdout.trim() === 'Y').catch(() => false),
          execPromise(`cat ${zswapPath}/compressor`).then(r => r.stdout.trim()).catch(() => 'unknown'),
          execPromise(`cat ${zswapPath}/max_pool_percent`).then(r => parseInt(r.stdout.trim(), 10)).catch(() => 0)
        ]);

        zswapStatus = {
          enabled,
          compressor,
          max_pool_percent: maxPool
        };
      } catch {
        // Zswap not available
      }

      return {
        swaps,
        zswap: zswapStatus
      };
    } catch (error) {
      throw new Error(`Failed to get swap status: ${error.message}`);
    }
  }

  /**
   * Get available zswap compression algorithms
   * GET /mos/zswap/algorithms
   * @returns {string[]} List of available compression algorithms
   */
  getAlgorithms() {
    // Static list of common kernel compression algorithms for zswap
    return ['lzo', 'lz4', 'lz4hc', 'zstd', 'deflate', '842'];
  }

}

module.exports = new SwapService();
