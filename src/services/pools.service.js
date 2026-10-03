const fs = require('fs').promises;
const path = require('path');
const { exec, spawn } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const os = require('os');
const crypto = require('crypto');
const { DeviceStrategyFactory } = require('./pools/device-strategy');
const PoolHelpers = require('./pools/pool-helpers');
const BcachefsHelpers = require('./pools/bcachefs-helpers');
const disksService = require('./disks.service');
const { sendNotification } = require('./plugins.service');

// Timestamp-based ID-Generator
const generateId = () => Date.now().toString();

// df stats every mount point it does not exclude, which blocks for the full
// NFS/SMB timeout when a remote server is gone
const DF_EXCLUDE_REMOTE = ['nfs', 'nfs3', 'nfs4', 'cifs', 'smb3', 'smbfs',
  'sshfs', 'fuse.sshfs', 'ceph', 'glusterfs', 'afs', '9p', 'davfs']
  .map(t => `-x ${t}`).join(' ');

class PoolsService {
  constructor(eventEmitter = null) {
    this.poolsFile = '/boot/config/pools.json';
    this.mountBasePath = '/mnt';
    this.mergerfsBasePath = '/var/mergerfs';
    this.snapraidBasePath = '/var/snapraid';
    this.eventEmitter = eventEmitter; // Optional event emitter for WebSocket integration

    // Initialize MOS service for service dependency checks
    this.mosService = null;

    // Use the singleton disksService instance for power status checks
    this.disksService = disksService;

    // Default ownership settings for pool mount points
    // Can be overridden per pool or globally configured
    this.defaultOwnership = {
      uid: 500,
      gid: 500
    };

    // Short-lived cache for disk info map (model, serial, name)
    // These are static properties that don't change between calls
    // 30s TTL: short enough to detect hot-swapped disks, long enough to avoid
    // calling getAllDisks() (which runs smartctl per disk) on every listPools()
    this._diskInfoMapCache = null;
    this._diskInfoMapCacheTimestamp = 0;
    this._diskInfoMapCacheTTL = 30000; // 30 seconds

    // NonRAID operation monitor state
    this._nonRaidMonitor = {
      active: false,
      poolName: null,
      operation: null,
      intervalId: null
    };

    // Shared across instances: slot -> { filesystem, passphrase } for data disks waiting for clear + format
    if (!PoolsService._nonRaidPendingDisks) {
      PoolsService._nonRaidPendingDisks = new Map();
      PoolsService._nonRaidFinalizing = false;
    }
    this._nonRaidPendingDisks = PoolsService._nonRaidPendingDisks;

    // BTRFS scrub operation monitor state
    this._btrfsScrubMonitor = {
      active: false,
      poolName: null,
      mountPoint: null,
      intervalId: null
    };

    // BTRFS balance operation monitor state
    this._btrfsBalanceMonitor = {
      active: false,
      poolName: null,
      mountPoint: null,
      intervalId: null
    };

    // Monitors and pending NonRAID disks belong to the API process, a CLI process exits mid-way
    if (process.env.MOS_API_CLI === '1') {
      return;
    }

    // Udev disk offline monitor (singleton: only one monitor across all instances)
    if (!PoolsService._udevMonitorStarted) {
      PoolsService._udevMonitor = null;
      PoolsService._udevAlertedDevices = new Set();
      PoolsService._udevDeviceMap = new Map(); // uuid/id -> { device, poolName }
      PoolsService._udevRestartCount = 0;
      PoolsService._udevMaxRestarts = 5;
      PoolsService._btrfsMonitorsInitialized = false;

      // Kill orphans from previous runs (sync: must complete before spawn)
      try { require('child_process').execSync('pkill -f "udevadm monitor --kernel --subsystem-match=block --property" 2>/dev/null || true'); } catch {}

      this._startUdevDiskMonitor();
      this._refreshUdevDeviceMap();

      // Clean shutdown handler (once)
      const cleanup = () => this._stopUdevDiskMonitor();
      process.on('exit', cleanup);
      process.on('SIGTERM', cleanup);
      process.on('SIGINT', cleanup);

      PoolsService._udevMonitorStarted = true;
    }

    // Initialize NonRAID monitor on startup (check if operation is already running)
    this._initNonRaidMonitor();

    // Initialize BTRFS monitors on startup (singleton pattern)
    if (!PoolsService._btrfsMonitorsInitialized) {
      this._initBtrfsScrubMonitor();
      this._initBtrfsBalanceMonitor();
      PoolsService._btrfsMonitorsInitialized = true;
    }

    // Pool usage alert monitor (singleton: only one interval across all instances)
    if (!PoolsService._usageMonitorStarted) {
      // poolId -> { level: 'normal'|'warning'|'alert', percent: number }
      PoolsService._usageAlertState = new Map();
      PoolsService._usageMonitorInterval = null;
      this._startUsageAlertMonitor();
      PoolsService._usageMonitorStarted = true;
    }
  }

  /**
   * Start udev monitor to detect block device removal events.
   * When a disk that belongs to a mounted pool disappears, an alert notification is sent.
   * @private
   */
  _startUdevDiskMonitor() {
    try {
      PoolsService._udevMonitor = spawn('udevadm', [
        'monitor', '--kernel', '--subsystem-match=block', '--property'
      ], { stdio: ['ignore', 'pipe', 'ignore'] });

      let buffer = '';

      PoolsService._udevMonitor.stdout.on('data', (data) => {
        buffer += data.toString();

        // udev events are separated by blank lines
        const blocks = buffer.split('\n\n');
        // Keep the last incomplete block in the buffer
        buffer = blocks.pop() || '';

        for (const block of blocks) {
          this._handleUdevBlock(block);
        }
      });

      PoolsService._udevMonitor.on('error', (err) => {
        console.warn(`[PoolsService] udev monitor failed to start: ${err.message}`);
        PoolsService._udevMonitor = null;
      });

      PoolsService._udevMonitor.on('exit', (code) => {
        // Don't restart if we stopped it intentionally (null = intentional stop)
        if (!PoolsService._udevMonitor) return;
        PoolsService._udevMonitor = null;

        // Respect restart limit to prevent crash loops
        PoolsService._udevRestartCount++;
        if (PoolsService._udevRestartCount > PoolsService._udevMaxRestarts) {
          console.error(`[PoolsService] udev monitor exceeded max restarts (${PoolsService._udevMaxRestarts}), giving up`);
          return;
        }

        console.warn(`[PoolsService] udev monitor exited (code ${code}), restarting in 5s... (${PoolsService._udevRestartCount}/${PoolsService._udevMaxRestarts})`);
        setTimeout(() => this._startUdevDiskMonitor(), 5000);
      });

      // Reset restart counter on successful start (process stays alive > 10s)
      setTimeout(() => {
        if (PoolsService._udevMonitor) {
          PoolsService._udevRestartCount = 0;
        }
      }, 10000);
    } catch (err) {
      console.warn(`[PoolsService] Could not start udev monitor: ${err.message}`);
    }
  }

  /**
   * Stop the udev disk monitor
   * @private
   */
  _stopUdevDiskMonitor() {
    if (PoolsService._udevMonitor) {
      const proc = PoolsService._udevMonitor;
      PoolsService._udevMonitor = null; // prevent restart in exit handler
      proc.kill('SIGTERM');
      PoolsService._udevMonitorStarted = false;
    }
  }

  /**
   * Handle a single udev event block from udevadm monitor --property output
   * @param {string} block - Raw udev event text block
   * @private
   */
  _handleUdevBlock(block) {
    const isAdd = block.includes('ACTION=add');
    const isRemove = block.includes('ACTION=remove');
    if (!isAdd && !isRemove) return;

    // Whole-disk events only; partition matching is normalized to base disk below
    if (!block.includes('DEVTYPE=disk')) return;

    const devMatch = block.match(/DEVNAME=(.+)/);
    if (!devMatch) return;
    const device = devMatch[1].trim();

    if (isAdd) {
      // Re-arm: a re-attached disk should be able to alert again on next removal
      PoolsService._udevAlertedDevices.delete(device);
      return;
    }

    this._checkRemovedDeviceAgainstPools(device)
      .catch(err => console.warn(`[PoolsService] Disk offline check error: ${err.message}`));
  }

  /**
   * Refresh the UUID/ID → device path map for all pools.
   * Called on startup and after mount/unmount so we always have a current
   * mapping even if the device symlink disappears before we can read it.
   * @private
   */
  async _refreshUdevDeviceMap() {
    try {
      const pools = await this._readPools();
      const map = new Map();

      for (const pool of pools) {
        const allDevices = [
          ...(pool.data_devices || []).map(d => ({ ...d, _isParity: false })),
          ...(pool.parity_devices || []).map(d => ({ ...d, _isParity: true }))
        ];

        for (const dev of allDevices) {
          if (!dev.id) continue;

          let resolvedPath = null;
          if (pool.type === 'nonraid' && dev._isParity) {
            resolvedPath = await this.getRealDevicePathFromId(dev.id);
          } else {
            resolvedPath = await this.getRealDevicePathFromUuid(dev.id);
          }

          if (resolvedPath) {
            map.set(dev.id, { device: resolvedPath, poolName: pool.name, poolId: pool.id });
          }
        }
      }

      PoolsService._udevDeviceMap = map;
    } catch (err) {
      // Silent: pools.json might not exist yet
    }
  }

  /**
   * Check if a removed device belongs to any mounted pool and send alert.
   * Uses the pre-built device map so UUID symlinks don't need to be live.
   * @param {string} removedDevice - The device path that was removed (e.g. /dev/sdj1)
   * @private
   */
  async _checkRemovedDeviceAgainstPools(removedDevice) {
    // Dedup: don't send multiple alerts for the same device
    if (PoolsService._udevAlertedDevices.has(removedDevice)) return;

    // Also derive the base disk (e.g. /dev/sdj from /dev/sdj1)
    const baseDisk = this._getBaseDiskFromPartition(removedDevice);

    // Search the cached device map for a match
    let matchedPoolName = null;

    for (const [, entry] of PoolsService._udevDeviceMap) {
      const cachedBase = this._getBaseDiskFromPartition(entry.device);
      if (entry.device === removedDevice || entry.device === baseDisk ||
          cachedBase === baseDisk) {
        matchedPoolName = entry.poolName;
        break;
      }
    }

    if (!matchedPoolName) return;

    // Only alert if pool is currently mounted
    try {
      const mountPoint = path.join(this.mountBasePath, matchedPoolName);
      const isMounted = await this._isMounted(mountPoint);
      if (!isMounted) return;
    } catch {
      return;
    }

    // Mark as alerted and send notification
    PoolsService._udevAlertedDevices.add(removedDevice);

    console.warn(`[PoolsService] Disk ${removedDevice} from Pool ${matchedPoolName} went offline!`);
    sendNotification(
      'Pool',
      `Disk ${removedDevice} from Pool ${matchedPoolName} went offline`,
      'alert'
    ).catch(err => console.warn(`[PoolsService] Failed to send disk offline notification: ${err.message}`));
  }

  /**
   * Get appropriate device strategy for a pool
   * @param {Object} pool - Pool object or config
   * @returns {DeviceStrategy} Device strategy instance
   */
  _getDeviceStrategy(pool) {
    return DeviceStrategyFactory.getStrategy(pool, this);
  }

  /**
   * Generate secure passphrase for encrypted pools
   * @returns {string} Secure random passphrase
   * @private
   */
  _generateSecurePassphrase() {
    return PoolHelpers.generateSecurePassphrase();
  }

  /**
   * Prepare devices for pool using Strategy Pattern
   * Handles encryption transparently
   * @param {string[]} devices - Physical device paths
   * @param {Object} pool - Pool config object
   * @param {Object} options - Options including passphrase, format, etc.
   * @returns {Promise<Object>} Object with preparedDevices array and metadata
   * @private
   */
  async _prepareDevicesWithStrategy(devices, pool, options) {
    const strategy = this._getDeviceStrategy(pool);

    // Prepare devices (handles LUKS encryption if needed)
    const preparedDevices = await strategy.prepareDevices(devices, pool, options);

    // Get operational device paths (mapped LUKS or physical)
    const operationalDevices = preparedDevices.map(d =>
      strategy.getOperationalDevicePath(d)
    );

    // Get physical device paths (for UUID and storage)
    const physicalDevices = preparedDevices.map(d =>
      strategy.getPhysicalDevicePath(d)
    );

    return {
      preparedDevices,      // Full device info objects
      operationalDevices,   // Paths for mount/format operations
      physicalDevices,      // Physical paths for UUID/storage
      strategy              // Strategy instance for later use
    };
  }

  /**
   * Helper function to execute cryptsetup command with passphrase via stdin
   * This ensures passphrases with spaces and special characters work correctly
   * @param {string[]} args - Command arguments for cryptsetup
   * @param {string} passphrase - Passphrase to pass via stdin
   * @returns {Promise<{stdout: string, stderr: string}>}
   * @private
   */
  _execCryptsetupWithPassphrase(args, passphrase) {
    return new Promise((resolve, reject) => {
      // Validate passphrase
      if (passphrase === undefined || passphrase === null) {
        reject(new Error('Passphrase is required for cryptsetup operation'));
        return;
      }

      const proc = spawn('cryptsetup', args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('error', (error) => {
        reject(new Error(`Failed to spawn cryptsetup: ${error.message}`));
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`cryptsetup exited with code ${code}: ${stderr || stdout}`));
        }
      });

      // Write passphrase to stdin and close it
      proc.stdin.write(passphrase);
      proc.stdin.end();
    });
  }

  /**
   * Normalize a LUKS passphrase to the exact bytes cryptsetup will receive on stdin
   * @param {string} passphrase - Raw passphrase
   * @returns {string|null} Normalized passphrase or null when empty
   * @private
   */
  _normalizeLuksPassphrase(passphrase) {
    if (typeof passphrase !== 'string') {
      return null;
    }

    const normalized = passphrase.replace(/[\r\n]+$/, '');
    return normalized === '' ? null : normalized;
  }

  /**
   * Check whether a device carries a LUKS header
   * @param {string} device - Device path
   * @returns {Promise<boolean>} True if the device is a LUKS container
   * @private
   */
  async _isLuksDevice(device) {
    try {
      await execPromise(`cryptsetup isLuks ${device}`);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Resolve a path through symlinks, falling back to the input when it cannot be resolved
   * @param {string} devicePath - Device path
   * @returns {Promise<string>} Resolved path
   * @private
   */
  async _realPathOrSelf(devicePath) {
    try {
      return await fs.realpath(devicePath);
    } catch (error) {
      return devicePath;
    }
  }

  /**
   * Determine whether a LUKS mapper is already open for exactly the given device
   * A mapper backed by a different disk means the slot numbering collided; reusing it would
   * silently format or mount the wrong pool member, so that case is rejected instead
   * @param {string} device - Physical device the mapper is expected to back
   * @param {string} luksName - Mapper name
   * @returns {Promise<boolean>} True when the mapper is already open for this device
   * @private
   */
  async _isLuksMapperOpenFor(device, luksName) {
    const mapperPath = `/dev/mapper/${luksName}`;

    const exists = await fs.access(mapperPath).then(() => true, () => false);
    if (!exists) {
      return false;
    }

    const backing = await this._getPhysicalDeviceFromMapper(mapperPath);
    if (!backing) {
      throw new Error(
        `Device mapper name '${luksName}' is already taken by a non-LUKS mapping. ` +
        `Resolve the conflict before continuing.`
      );
    }

    const owner = await this._realPathOrSelf(backing);
    const target = await this._realPathOrSelf(device);

    if (owner === target) {
      return true;
    }

    throw new Error(
      `LUKS mapper '${luksName}' is already active for ${owner}, refusing to reuse it for ${device}. ` +
      `This indicates colliding slot numbers in the pool configuration.`
    );
  }

  /**
   * Verify a passphrase against an already encrypted member of the pool
   * Formatting a new device with a diverging key would only surface on the next mount, when
   * part of the pool can no longer be unlocked
   * @param {Object} pool - Existing pool
   * @param {string} passphrase - Passphrase to verify
   * @param {string[]} excludeDevices - Devices that are about to be encrypted
   * @private
   */
  async _assertLuksPassphraseMatchesPool(pool, passphrase, excludeDevices = []) {
    const cleanPassphrase = this._normalizeLuksPassphrase(passphrase);
    if (!cleanPassphrase || !pool) {
      return;
    }

    const excluded = new Set();
    for (const device of excludeDevices) {
      excluded.add(await this._realPathOrSelf(device));
    }

    const members = [...(pool.data_devices || []), ...(pool.parity_devices || [])];

    for (const member of members) {
      const devicePath = member.device || (member.id ? await this.getRealDevicePathFromUuid(member.id) : null);
      if (!devicePath) {
        continue;
      }

      const resolved = await this._realPathOrSelf(devicePath);
      if (excluded.has(resolved) || !await this._isLuksDevice(resolved)) {
        continue;
      }

      try {
        await this._execCryptsetupWithPassphrase(['open', '--test-passphrase', resolved], cleanPassphrase);
        return;
      } catch (error) {
        throw new Error(
          `The provided passphrase does not unlock the existing LUKS members of pool '${pool.name}'. ` +
          `Refusing to encrypt new devices with a diverging key.`
        );
      }
    }
  }

  /**
   * Helper function to format bytes in human readable format
   * @param {number} bytes - Bytes to format
   * @param {Object} user - User object with byte_format preference
   * @returns {string} Human readable format
   */
  formatBytes(bytes, user = null) {
    if (bytes === 0) return '0 B';

    const byteFormat = this._getUserByteFormat(user);
    const isBinary = byteFormat === 'binary';
    const k = isBinary ? 1024 : 1000;
    const sizes = isBinary
      ? ['B', 'KiB', 'MiB', 'GiB', 'TiB']
      : ['B', 'KB', 'MB', 'GB', 'TB'];

    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  /**
   * Helper function to format speed in human readable format
   * @param {number} bytesPerSecond - Bytes per second to format
   * @param {Object} user - User object with byte_format preference
   * @returns {string} Human readable format
   */
  formatSpeed(bytesPerSecond, user = null) {
    if (bytesPerSecond === 0) return '0 B/s';

    const byteFormat = this._getUserByteFormat(user);
    const isBinary = byteFormat === 'binary';
    const k = isBinary ? 1024 : 1000;
    const sizes = isBinary
      ? ['B/s', 'KiB/s', 'MiB/s', 'GiB/s', 'TiB/s']
      : ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];

    const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k));
    return parseFloat((bytesPerSecond / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  /**
   * Get user's byte format preference
   * @param {Object} user - User object
   * @returns {string} Byte format ('binary' or 'decimal')
   * @private
   */
  _getUserByteFormat(user) {
    if (user && user.byte_format) {
      return user.byte_format;
    }
    return 'binary'; // Default fallback
  }

  /**
   * Set ownership of a directory
   * @param {string} path - Directory path
   * @param {number} uid - User ID
   * @param {number} gid - Group ID
   * @private
   */
  async _setOwnership(path, uid = this.defaultOwnership.uid, gid = this.defaultOwnership.gid) {
    try {
      await execPromise(`chown ${uid}:${gid} "${path}"`);
      console.log(`Set ownership of ${path} to ${uid}:${gid}`);
    } catch (error) {
      console.warn(`Warning: Could not set ownership of ${path}: ${error.message}`);
      // Don't throw error as this is not critical for pool functionality
    }
  }

  /**
   * Create directory with proper ownership
   * @param {string} path - Directory path to create
   * @param {Object} options - Options including uid and gid
   * @private
   */
  async _createDirectoryWithOwnership(path, options = {}) {
    await fs.mkdir(path, { recursive: true });

    // Set ownership if specified
    const uid = options.uid || this.defaultOwnership.uid;
    const gid = options.gid || this.defaultOwnership.gid;

    if (uid !== undefined && gid !== undefined) {
      await this._setOwnership(path, uid, gid);
    }
  }

  /**
   * Refresh device symlinks with udev
   * @private
   */
  async _refreshDeviceSymlinks() {
    try {
      console.log('Refreshing device symlinks with udev...');
      await execPromise('udevadm trigger --subsystem-match=block');
      await execPromise('udevadm settle');
      console.log('Device symlinks refreshed successfully');
    } catch (error) {
      console.warn(`Warning: Could not refresh device symlinks: ${error.message}`);
      // Don't throw error as this is not critical for pool functionality
    }
  }

  /**
   * Get the next available index for a new pool
   * @param {Array} pools - Array of existing pools
   * @returns {number} Next available index
   * @private
   */
  _getNextPoolIndex(pools) {
    if (!pools || pools.length === 0) {
      return 1;
    }

    const maxIndex = pools.reduce((max, pool) => {
      const poolIndex = pool.index || 0;
      return poolIndex > max ? poolIndex : max;
    }, 0);

    return maxIndex + 1;
  }

  /**
   * Ensure pools file exists
   */
  async _ensurePoolsFile() {
    try {
      await fs.access(this.poolsFile);
    } catch (error) {
      // Create directory if it doesn't exist
      const dir = path.dirname(this.poolsFile);
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (err) {
        // Directory might already exist
      }

      // Create empty pools file
      await fs.writeFile(this.poolsFile, JSON.stringify([], null, 2));
    }
  }

  /**
   * Read pools data from file
   */
  async _readPools() {
    await this._ensurePoolsFile();
    const data = await fs.readFile(this.poolsFile, 'utf8');
    try {
      const pools = JSON.parse(data);
      if (Array.isArray(pools)) {
        pools.forEach(pool => this._normalizeDeviceFields(pool));
      }
      return pools;
    } catch (error) {
      throw new Error(`Invalid pools file format: ${error.message}`);
    }
  }

  /**
   * Ensure every pool device carries the same field set
   * group/durability only carry meaning for bcachefs; all other pool types keep them null
   * so the persisted device shape is identical across pool types
   * @private
   */
  _normalizeDeviceFields(pool) {
    const devices = [...(pool.data_devices || []), ...(pool.parity_devices || [])];
    for (const device of devices) {
      if (device.group === undefined) device.group = null;
      if (device.durability === undefined) device.durability = null;
    }
    return pool;
  }

  /**
   * Write pools data to file
   */
  async _writePools(poolsData) {
    await this._ensurePoolsFile();

    // Clean up internal-only properties before writing
    const cleanedPools = poolsData.map(pool => {
      const cleanPool = { ...pool };
      // Remove internal properties that should not be persisted
      delete cleanPool.devices; // Internal array for encrypted pools
      delete cleanPool._luksDevices; // Internal LUKS device mappings
      delete cleanPool.device; // Injected device paths
      delete cleanPool.mountPoint; // Dynamic mount point
      delete cleanPool.status; // Dynamic status info
      delete cleanPool.device_groups; // Dynamic bcachefs group totals

      // Clean data_devices
      if (cleanPool.data_devices) {
        cleanPool.data_devices = cleanPool.data_devices.map(d => {
          const cleanDevice = { ...d };
          delete cleanDevice.device; // Injected from UUID
          delete cleanDevice.label; // Derived from group and slot
          delete cleanDevice.state; // Dynamic bcachefs member state
          delete cleanDevice.diskType; // Dynamic disk info
          delete cleanDevice.size; // Dynamic size info
          delete cleanDevice.used; // Dynamic usage info
          delete cleanDevice.available; // Dynamic availability
          delete cleanDevice.usage; // Dynamic usage percentage
          delete cleanDevice.standby; // Dynamic power status
          delete cleanDevice.temperature; // Dynamic temperature
          return cleanDevice;
        });
      }

      // Clean parity_devices
      if (cleanPool.parity_devices) {
        cleanPool.parity_devices = cleanPool.parity_devices.map(d => {
          const cleanDevice = { ...d };
          delete cleanDevice.device; // Always injected from UUID, never stored
          delete cleanDevice.diskType; // Dynamic disk info
          delete cleanDevice.size; // Dynamic size info
          delete cleanDevice.used; // Dynamic usage info
          delete cleanDevice.available; // Dynamic availability
          delete cleanDevice.usage; // Dynamic usage percentage
          delete cleanDevice.standby; // Dynamic power status
          delete cleanDevice.temperature; // Dynamic temperature
          return cleanDevice;
        });
      }

      return this._normalizeDeviceFields(cleanPool);
    });

    await fs.writeFile(this.poolsFile, JSON.stringify(cleanedPools, null, 2));

    // Emit event for pool data changes
    this._emitEvent('pools:updated', { pools: poolsData });
  }

  /**
   * Emit event if eventEmitter is available
   * @private
   */
  _emitEvent(event, data) {
    if (this.eventEmitter) {
      this.eventEmitter.emit(event, data);
    }
  }

  /**
   * Check if a path is mounted
   */
  async _isMounted(mountPath) {
    try {
      const { stdout } = await execPromise('cat /proc/mounts');
      const lines = stdout.split('\n');

      for (const line of lines) {
        if (line.trim()) {
          // Split the mount line: device mountpoint filesystem options
          const parts = line.split(' ');
          if (parts.length >= 2 && parts[1] === mountPath) {
            return true;
          }
        }
      }

      return false;
    } catch (error) {
      return false;
    }
  }

  // Construct mergerfs build options
  _buildMergerfsOptions(config) {
    const { global_options, policies, minfreespace, moveonenospc } = config || {};
    const globalOptions = Array.isArray(global_options) && global_options.length > 0
      ? global_options
      : ['cache.files=off', 'dropcacheonclose=true'];
    const options = [
      'defaults',
      'allow_other',
      'use_ino',
      ...globalOptions,
      `category.create=${policies?.create || 'mspmfs'}`,
      `category.search=${policies?.search || 'ff'}`
    ];
    if (minfreespace) {
      options.push(`minfreespace=${minfreespace}`);
    }
    if (moveonenospc !== undefined && moveonenospc !== null) {
      options.push(`moveonenospc=${moveonenospc}`);
    }
    return options.join(',');
  }

  /**
   * Check if a device is already mounted somewhere
   */
  async _isDeviceMounted(devicePath) {
    try {
      const { stdout } = await execPromise('cat /proc/mounts');
      const lines = stdout.split('\n');

      for (const line of lines) {
        if (line.trim() && line.startsWith(devicePath + ' ')) {
          // Extract mount point from the line
          const parts = line.split(' ');
          if (parts.length >= 2) {
            return {
              isMounted: true,
              mountPoint: parts[1]
            };
          }
        }
      }

      return {
        isMounted: false,
        mountPoint: null
      };
    } catch (error) {
      return {
        isMounted: false,
        mountPoint: null,
        error: error.message
      };
    }
  }

  /**
   * Check if a device is already formatted with the specified filesystem
   * This method checks both the device itself and its partitions to handle cases
   * where a device has a partition table (e.g., MBR/GPT) but the filesystem is on a partition
   */
  async checkDeviceFilesystem(device) {
    try {
      // First, try to check the device itself
      const deviceResult = await this._checkSingleDeviceFilesystem(device);

      // If the device has a filesystem that's not a partition table, return it
      // BUT: For single device pools, we should prefer partitions over whole disk filesystems
      if (deviceResult.isFormatted && !['dos', 'gpt', 'mbr'].includes(deviceResult.filesystem)) {
        // Check if we have partitions - if yes, prefer them over whole disk filesystem
        const partitions = await this._getDevicePartitions(device);
        if (partitions.length === 0) {
          // No partitions, use whole disk filesystem
          return deviceResult;
        }
        // Continue to check partitions below
      }

      // If the device has a partition table or no filesystem, check its partitions
      const partitions = await this._getDevicePartitions(device);

      if (partitions.length > 0) {
        // Check each partition for filesystems
        for (const partition of partitions) {
          const partitionResult = await this._checkSingleDeviceFilesystem(partition);
          if (partitionResult.isFormatted && !['dos', 'gpt', 'mbr'].includes(partitionResult.filesystem)) {
            // Return the partition info but include the partition path
            return {
              ...partitionResult,
              actualDevice: partition // The actual device/partition that has the filesystem
            };
          }
        }
      }

      // If no filesystem found on device or partitions, return unformatted
      // Don't return partition table types as "formatted"
      if (deviceResult.isFormatted && ['dos', 'gpt', 'mbr'].includes(deviceResult.filesystem)) {
        return {
          isFormatted: false,
          filesystem: null,
          uuid: null
        };
      }

      return deviceResult;

    } catch (error) {
      // If the command fails, the device is likely not formatted
      return {
        isFormatted: false,
        filesystem: null,
        uuid: null,
        error: error.message
      };
    }
  }

  /**
   * Check filesystem on a single device/partition
   * @private
   */
  async _checkSingleDeviceFilesystem(device) {
    try {
      const { stdout } = await execPromise(`blkid -o export ${device}`);

      // If blkid returns output, extract the filesystem type and UUIDs
      if (stdout.trim()) {
        const fsMatch = stdout.match(/TYPE="?([^"\n]+)"?/);
        if (fsMatch && fsMatch[1]) {
          // Extract both filesystem UUID and partition UUID
          const filesystemUuid = stdout.match(/UUID="?([^"\n]+)"?/)?.[1] || null;
          const partitionUuid = stdout.match(/PARTUUID="?([^"\n]+)"?/)?.[1] || null;

          return {
            isFormatted: true,
            filesystem: fsMatch[1],
            uuid: filesystemUuid, // Primary: filesystem UUID for mounting
            partuuid: partitionUuid, // Secondary: partition UUID for identification
            device: device // Store the device path for reference
          };
        }
      }

      return {
        isFormatted: false,
        filesystem: null,
        uuid: null,
        partuuid: null,
        device: device
      };
    } catch (error) {
      return {
        isFormatted: false,
        filesystem: null,
        uuid: null,
        partuuid: null,
        device: device,
        error: error.message
      };
    }
  }

  /**
   * Get all partitions for a given device
   * @private
   */
  async _getDevicePartitions(device) {
    try {
      // Use lsblk to get partitions for the device
      const { stdout } = await execPromise(`lsblk -rno NAME ${device}`);
      const lines = stdout.trim().split('\n');

      // Filter out the main device and return only partitions
      const deviceName = device.split('/').pop();
      const partitions = lines
        .filter(line => line.trim() && line !== deviceName && line.startsWith(deviceName))
        .map(partition => `/dev/${partition.trim()}`);

      return partitions;
    } catch (error) {
      // If lsblk fails, try a fallback method
      try {
        const { stdout } = await execPromise(`ls ${device}* 2>/dev/null || true`);
        const devices = stdout.trim().split('\n').filter(d => d && d !== device);
        return devices;
      } catch (fallbackError) {
        return [];
      }
    }
  }

  /**
   * Get the size of a device in bytes
   * @param {string} device - Device path
   */
  async getDeviceSize(device) {
    try {
      const { stdout } = await execPromise(`blockdev --getsize64 ${device}`);
      return parseInt(stdout.trim());
    } catch (error) {
      throw new Error(`Failed to get device size: ${error.message}`);
    }
  }

  /**
   * Get device UUID (filesystem UUID, not partition UUID)
   * @param {string} device - Device path
   * @returns {Promise<string|null>} - Device filesystem UUID or null if not found
   */
  async getDeviceUuid(device) {
    try {
      // Get filesystem UUID (not PARTUUID) - this is what we need for mounting and identification
      const { stdout } = await execPromise(`blkid -s UUID -o value ${device}`);
      const uuid = stdout.trim();

      return uuid || null;
    } catch (error) {
      // Don't throw error, just return null - let calling code handle it
      return null;
    }
  }

  /**
   * Get BTRFS filesystem UUID from any device in the pool
   * @param {string} device - Any device path in the BTRFS pool
   * @returns {Promise<string|null>} - BTRFS filesystem UUID or null if not found
   */
  async getBtrfsFilesystemUuid(device) {
    try {
      // Use btrfs filesystem show to get the UUID
      const { stdout } = await execPromise(`btrfs filesystem show ${device} 2>/dev/null || echo ""`);

      // Parse the UUID from the output: "uuid: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
      const uuidMatch = stdout.match(/uuid:\s*([a-f0-9-]{36})/i);
      if (uuidMatch && uuidMatch[1]) {
        return uuidMatch[1];
      }

      // Fallback: try to get filesystem UUID directly
      return await this.getDeviceUuid(device);
    } catch (error) {
      console.warn(`Could not get BTRFS filesystem UUID for ${device}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get device paths from BTRFS filesystem show
   * @param {string} device - Any device path in the BTRFS pool
   * @returns {Promise<string[]>} - Array of device paths from btrfs filesystem show
   */
  async getBtrfsDevicePaths(device) {
    try {
      const { stdout } = await execPromise(`btrfs filesystem show ${device} 2>/dev/null || echo ""`);

      // Parse device paths from the output
      const deviceMatches = stdout.match(/devid\s+\d+\s+size\s+[\d.]+[KMGT]iB\s+used\s+[\d.]+[KMGT]iB\s+path\s+(\/dev\/[^\s]+)/g);
      if (deviceMatches) {
        return deviceMatches.map(match => {
          const pathMatch = match.match(/path\s+(\/dev\/[^\s]+)/);
          return pathMatch ? pathMatch[1] : null;
        }).filter(Boolean);
      }

      return [];
    } catch (error) {
      console.warn(`Could not get BTRFS device paths for ${device}: ${error.message}`);
      return [];
    }
  }

  /**
   * Read the live BTRFS data profile from a mounted filesystem.
   * Served from kernel metadata, so no disk is woken up.
   * @param {string} mountPoint - BTRFS mount point
   * @returns {Promise<string|null>} Profile like 'raid1' or 'single', null if unreadable
   */
  async getBtrfsRaidProfile(mountPoint) {
    try {
      const { stdout } = await execPromise(`timeout 10 btrfs filesystem df "${mountPoint}"`);
      // Small filesystems use mixed block groups and report "Data+Metadata"
      const match = stdout.match(/^Data(?:\+Metadata)?,\s*(\w+):/im);
      return match ? match[1].toLowerCase() : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get UUIDs for BTRFS pool devices (handles LUKS vs non-LUKS)
   * @param {string[]} devices - Array of device paths
   * @param {boolean} isEncrypted - Whether the pool is encrypted with LUKS
   * @param {string} poolName - Pool name (for LUKS mapping)
   * @returns {Promise<Object[]>} - Array of device info objects with UUIDs
   */
  async getBtrfsPoolDeviceUuids(devices, isEncrypted = false, poolName = null) {
    const deviceInfos = [];

    if (isEncrypted && poolName) {
      // For LUKS encrypted pools, each device has different UUIDs
      for (let i = 0; i < devices.length; i++) {
        const device = devices[i];
        // Get PARTUUID from the physical partition (before LUKS)
        const partuuid = await this._getDevicePartuuid(device);
        // For encrypted devices, we use PARTUUID as unique identifier
        deviceInfos.push({
          device: device,
          uuid: partuuid,
          type: 'partuuid' // Indicates this is a PARTUUID, not filesystem UUID
        });
      }
    } else {
      // For non-encrypted BTRFS pools, all devices share the same filesystem UUID
      // but we need individual device identification
      const btrfsUuid = await this.getBtrfsFilesystemUuid(devices[0]);

      for (let i = 0; i < devices.length; i++) {
        const device = devices[i];
        // Use the same BTRFS filesystem UUID for all devices in the pool
        deviceInfos.push({
          device: device,
          uuid: btrfsUuid,
          type: 'filesystem' // Indicates this is a filesystem UUID
        });
      }
    }

    return deviceInfos;
  }

  /**
   * Update BTRFS device paths in pool from btrfs filesystem show
   * This ensures we display the correct /dev/sdX or /dev/nvmeX paths
   * @param {Object} pool - Pool object to update
   * @param {string} mountPoint - Mount point of the pool
   * @private
   */
  async _updateBtrfsDevicePathsInPool(pool, mountPoint) {
    try {
      if (pool.type !== 'btrfs') {
        return;
      }

      // Get actual device paths from btrfs filesystem show
      const actualDevicePaths = await this.getBtrfsDevicePaths(mountPoint);

      if (actualDevicePaths.length > 0 && pool.data_devices) {
        // Update device paths in pool data_devices for display purposes
        // Note: We keep the UUIDs as IDs, but store actual paths for display
        for (let i = 0; i < Math.min(pool.data_devices.length, actualDevicePaths.length); i++) {
          if (pool.data_devices[i]) {
            // Store the actual device path for display purposes
            pool.data_devices[i].device = actualDevicePaths[i];
          }
        }

        console.log(`Updated BTRFS device paths for pool ${pool.name}:`, actualDevicePaths);
      }
    } catch (error) {
      console.warn(`Could not update BTRFS device paths for pool ${pool.name}: ${error.message}`);
    }
  }

  /**
   * Get device PARTUUID (partition UUID, not filesystem UUID)
   * @param {string} device - Device path
   * @returns {Promise<string|null>} - Device PARTUUID or null if not found
   */
  async _getDevicePartuuid(device) {
    try {
      // Get PARTUUID (not filesystem UUID) - this is unique per partition
      const { stdout } = await execPromise(`blkid -s PARTUUID -o value ${device}`);
      const partuuid = stdout.trim();

      return partuuid || null;
    } catch (error) {
      // Don't throw error, just return null - let calling code handle it
      return null;
    }
  }

  /**
   * Get UUID-based device path without waking up disks
   * @param {string} uuid - Filesystem UUID
   * @returns {Promise<string|null>} - UUID device path or null if not found
   */
  async getDevicePathFromUuid(uuid) {
    try {
      if (!uuid) return null;

      // First try /dev/disk/by-uuid/ (filesystem UUID)
      const uuidPath = `/dev/disk/by-uuid/${uuid}`;
      try {
        await fs.access(uuidPath);
        return uuidPath;
      } catch (error) {
        // Not found, try PARTUUID
      }

      // Try /dev/disk/by-partuuid/ (partition UUID)
      const partuuidPath = `/dev/disk/by-partuuid/${uuid}`;
      try {
        await fs.access(partuuidPath);
        return partuuidPath;
      } catch (error) {
        // Not found via symlink, try ZRAM config lookup
      }

      // Try ZRAM config lookup (ZRAM devices may not have /dev/disk/by-uuid symlinks)
      try {
        const ZramService = require('./zram.service');
        const zramConfig = await ZramService.loadConfig();
        for (const device of zramConfig.devices || []) {
          if (device.config?.uuid === uuid) {
            return `/dev/zram${device.index}`;
          }
        }
      } catch {
        // ZRAM service not available
      }

      return null;
    } catch (error) {
      // Other error
      return null;
    }
  }

  /**
   * Get real device path from UUID for display purposes (WITHOUT waking up disks)
   * Uses fs.readlink() instead of readlink -f to avoid disk access
   * @param {string} uuid - Filesystem UUID
   * @returns {Promise<string|null>} - Real device path or null if not found
   */
  async getRealDevicePathFromUuid(uuid) {
    try {
      if (!uuid) return null;

      // First try /dev/disk/by-uuid/ (filesystem UUID)
      const uuidPath = `/dev/disk/by-uuid/${uuid}`;
      try {
        await fs.access(uuidPath);
        // Read the symlink WITHOUT following it (no disk access)
        const relativePath = await fs.readlink(uuidPath);
        // Resolve the relative path to absolute path
        const devicePath = path.resolve(path.dirname(uuidPath), relativePath);
        return devicePath || null;
      } catch (error) {
        // Not found, try PARTUUID
      }

      // Try /dev/disk/by-partuuid/ (partition UUID)
      const partuuidPath = `/dev/disk/by-partuuid/${uuid}`;
      try {
        await fs.access(partuuidPath);
        // Read the symlink WITHOUT following it (no disk access)
        const relativePath = await fs.readlink(partuuidPath);
        // Resolve the relative path to absolute path
        const devicePath = path.resolve(path.dirname(partuuidPath), relativePath);
        return devicePath || null;
      } catch (error) {
        // Not found via symlink, try ZRAM config lookup
      }

      // Try ZRAM config lookup (ZRAM devices may not have /dev/disk/by-uuid symlinks)
      try {
        const ZramService = require('./zram.service');
        const zramConfig = await ZramService.loadConfig();
        for (const device of zramConfig.devices || []) {
          if (device.config?.uuid === uuid) {
            return `/dev/zram${device.index}`;
          }
        }
      } catch {
        // ZRAM service not available
      }

      return null;
    } catch (error) {
      // Other error
      return null;
    }
  }

  /**
   * Get real device path from ID for display purposes (WITHOUT waking up disks)
   * Uses fs.readlink() instead of readlink -f to avoid disk access
   * @param {string} id - Device ID
   * @returns {Promise<string|null>} - Real device path or null if not found
   */
  async getRealDevicePathFromId(id) {
    try {
      if (!id) return null;

      // Try /dev/disk/by-id/ (device ID)
      const idPath = `/dev/disk/by-id/${id}`;
      try {
        await fs.access(idPath);
        // Read the symlink WITHOUT following it (no disk access)
        const relativePath = await fs.readlink(idPath);
        // Resolve the relative path to absolute path
        const devicePath = path.resolve(path.dirname(idPath), relativePath);
        return devicePath || null;
      } catch (error) {
        return null;
      }
    } catch (error) {
      // Other error
      return null;
    }
  }

  /**
   * Clean up SnapRAID configuration file for a pool
   * @param {string} poolName - Name of the pool
   * @returns {Promise<boolean>} - Whether cleanup was successful
   */
  async cleanupSnapRAIDConfig(poolName) {
    try {
      const snapraidConfigDir = '/boot/config/snapraid';
      const snapraidConfigPath = path.join(snapraidConfigDir, `${poolName}.conf`);

      // Check if config file exists
      try {
        await fs.access(snapraidConfigPath);
        await fs.unlink(snapraidConfigPath);
        console.log(`SnapRAID config file removed: ${snapraidConfigPath}`);
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') {
          // File doesn't exist, that's fine
          return true;
        }
        console.warn(`Warning: Could not remove SnapRAID config file: ${error.message}`);
        return false;
      }
    } catch (error) {
      console.error(`Error during SnapRAID cleanup: ${error.message}`);
      return false;
    }
  }

  /**
   * Clean up NonRAID configuration file
   * @returns {Promise<boolean>} - True if cleanup was successful
   */
  async cleanupNonRAIDConfig() {
    for (const { reservedDisks } of this._nonRaidPendingDisks.values()) {
      PoolHelpers.releaseDisks(reservedDisks || []);
    }
    this._nonRaidPendingDisks.clear();

    try {
      const nonraidDatPath = '/boot/config/system/nonraid.dat';

      // Check if config file exists
      try {
        await fs.access(nonraidDatPath);
        await fs.unlink(nonraidDatPath);
        console.log(`NonRAID config file removed: ${nonraidDatPath}`);
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') {
          // File doesn't exist, that's fine
          console.log('NonRAID config file does not exist, nothing to clean up');
          return true;
        }
        console.warn(`Warning: Could not remove NonRAID config file: ${error.message}`);
        return false;
      }
    } catch (error) {
      console.error(`Error during NonRAID cleanup: ${error.message}`);
      return false;
    }
  }

  /**
   * Execute SnapRAID operation on a pool
   * @param {string} poolId - Pool ID
   * @param {string} operation - Operation to perform (sync, check, scrub, fix, status)
   * @returns {Promise<Object>} - Operation result
   */
  /**
   * Execute NonRAID parity operation
   * @param {string} poolId - Pool ID
   * @param {string} operation - Operation to execute (check, pause, resume, cancel, auto)
   * @param {Object} options - Operation options
   * @returns {Promise<Object>} - Operation result
   */
  async executeNonRaidParityOperation(poolId, operation, options = {}) {
    const pool = await this.getPoolById(poolId);

    // Validate pool type
    if (pool.type !== 'nonraid') {
      throw new Error('NonRAID operations are only supported for NonRAID pools');
    }

    // Validate that pool has parity devices
    if (!pool.parity_devices || pool.parity_devices.length === 0) {
      throw new Error('Pool does not have any parity devices configured');
    }

    // Check if module is loaded
    try {
      const moduleCheck = await execPromise('lsmod | grep -qE "md.nonraid" && echo "loaded" || echo "not_loaded"');
      if (moduleCheck.stdout.trim() !== 'loaded') {
        throw new Error('NonRAID pool is not mounted. Please mount the pool first.');
      }
    } catch (error) {
      throw new Error('NonRAID pool is not mounted. Please mount the pool first.');
    }

    // Check if /proc/nmdcmd exists
    try {
      await fs.access('/proc/nmdcmd');
    } catch (error) {
      throw new Error('NonRAID control interface not available (/proc/nmdcmd not found)');
    }

    // Get current operation status
    const currentlyRunning = await this._isNonRaidParityOperationRunning();

    // Handle 'auto' operation - toggle between start and cancel
    if (operation === 'auto') {
      if (currentlyRunning) {
        // Cancel running operation
        operation = 'cancel';
      } else {
        // Start new check without correction
        operation = 'check';
        if (!options.option) {
          options.option = 'NOCORRECT';
        }
      }
    }

    // Validate operation
    const validOperations = ['check', 'pause', 'resume', 'cancel'];
    if (!validOperations.includes(operation)) {
      throw new Error(`Invalid operation. Supported operations: ${validOperations.join(', ')}, auto`);
    }

    // Build command based on operation
    let command;
    let description;

    switch (operation) {
      case 'check':
        const checkOption = options.option || 'NOCORRECT';
        const validCheckOptions = ['CORRECT', 'NOCORRECT'];
        if (!validCheckOptions.includes(checkOption)) {
          throw new Error(`Invalid check option. Supported options: ${validCheckOptions.join(', ')}`);
        }

        // Check if already running
        if (currentlyRunning) {
          throw new Error('A parity operation is already running. Use "cancel" to stop it first.');
        }

        const [pendingDisk] = this._getNonRaidPendingSlots(pool, await this._readNmdstat());
        if (pendingDisk) {
          throw new Error(`A new disk in slot ${pendingDisk.slot} is waiting to be cleared, no parity check can be started until it is ready.`);
        }

        command = `echo "check ${checkOption}" > /proc/nmdcmd`;
        description = checkOption === 'CORRECT'
          ? 'Parity check with correction started'
          : 'Parity check without correction started';
        break;

      case 'pause':
        if (!currentlyRunning) {
          throw new Error('No parity operation is currently running');
        }
        command = 'echo "nocheck PAUSE" > /proc/nmdcmd';
        description = 'Parity check paused';
        break;

      case 'resume':
        // For resume, we don't necessarily check if something is running
        // as the kernel module will handle that
        command = 'echo "check RESUME" > /proc/nmdcmd';
        description = 'Parity check resumed';
        break;

      case 'cancel':
        if (!currentlyRunning) {
          throw new Error('No parity operation is currently running');
        }
        command = 'echo "nocheck CANCEL" > /proc/nmdcmd';
        description = 'Parity check cancelled';
        break;

      default:
        throw new Error(`Unknown operation: ${operation}`);
    }

    // Execute the command
    try {
      console.log(`Executing NonRAID parity operation: ${command}`);
      await execPromise(command);

      // Handle notifications and monitor based on operation type
      const operationString = operation === 'check'
        ? `check ${options.option || 'NOCORRECT'}`
        : operation;

      switch (operation) {
        case 'check':
          // Start monitor for completion tracking
          this._startNonRaidMonitor(pool.name, operationString, true);
          break;

        case 'pause':
          // Send pause notification (monitor keeps running)
          sendNotification('nonraid', `nonraid operation ${this._nonRaidMonitor.operation || operationString} for Pool ${pool.name} paused`, 'normal')
            .catch(err => console.warn(`Failed to send NonRAID pause notification: ${err.message}`));
          break;

        case 'resume':
          // Send resume notification and ensure monitor is running
          sendNotification('nonraid', `nonraid operation ${this._nonRaidMonitor.operation || operationString} for Pool ${pool.name} resumed`, 'normal')
            .catch(err => console.warn(`Failed to send NonRAID resume notification: ${err.message}`));
          // Restart monitor if not active
          if (!this._nonRaidMonitor.active) {
            this._startNonRaidMonitor(pool.name, this._nonRaidMonitor.operation || operationString, false);
          }
          break;

        case 'cancel':
          // Send cancel notification and stop monitor
          sendNotification('nonraid', `nonraid operation ${this._nonRaidMonitor.operation || operationString} for Pool ${pool.name} cancelled`, 'normal')
            .catch(err => console.warn(`Failed to send NonRAID cancel notification: ${err.message}`));
          this._stopNonRaidMonitor();
          break;
      }

      return {
        success: true,
        message: description,
        operation,
        option: options.option || null,
        poolName: pool.name,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      throw new Error(`NonRAID parity operation failed: ${error.message}`);
    }
  }

  /**
   * Check if NonRAID parity operation is currently running
   * @returns {Promise<boolean>} - True if operation is running
   * @private
   */
  async _isNonRaidParityOperationRunning() {
    try {
      // Check if /proc/nmdstat exists
      await fs.access('/proc/nmdstat');

      // Read /proc/nmdstat and check mdResyncAction
      const { stdout } = await execPromise('cat /proc/nmdstat');
      const actionMatch = stdout.match(/mdResyncAction=(.+)/);

      // No action set = not running
      if (!actionMatch || !actionMatch[1] || actionMatch[1].trim() === '') {
        return false;
      }

      // Parse exit status, timestamps and resync position to determine if check is finished
      const syncExitMatch = stdout.match(/sbSyncExit=(-?\d+)/);
      const syncedMatch = stdout.match(/sbSynced=(\d+)/);
      const synced2Match = stdout.match(/sbSynced2=(\d+)/);
      const resyncPosMatch = stdout.match(/mdResyncPos=(\d+)/);
      const resyncDtMatch = stdout.match(/mdResyncDt=(\d+)/);
      const resyncDbMatch = stdout.match(/mdResyncDb=(\d+)/);

      const syncExit = syncExitMatch ? parseInt(syncExitMatch[1]) : null;
      const sbSynced = syncedMatch ? parseInt(syncedMatch[1]) : null;
      const sbSynced2 = synced2Match ? parseInt(synced2Match[1]) : null;
      const mdResyncPos = resyncPosMatch ? parseInt(resyncPosMatch[1]) : null;
      const mdResyncDt = resyncDtMatch ? parseInt(resyncDtMatch[1]) : null;
      const mdResyncDb = resyncDbMatch ? parseInt(resyncDbMatch[1]) : null;

      // Check if operation is actually running (has any progress/activity)
      // If mdResyncAction is set but all progress values are 0, it's not really active
      const hasActivity = (mdResyncPos !== null && mdResyncPos > 0) ||
                          (mdResyncDt !== null && mdResyncDt > 0) ||
                          (mdResyncDb !== null && mdResyncDb > 0);

      // If there's activity, the operation is definitely running
      // sbSynced/sbSynced2 are timestamps of LAST completed sync, not current operation
      if (hasActivity) {
        return true;
      }

      // No activity - operation is not running
      return false;
    } catch (error) {
      return false;
    }
  }

  /**
   * Initialize NonRAID monitor on API startup
   * Checks if a NonRAID operation is already running and starts monitoring if so
   * @private
   */
  async _initNonRaidMonitor() {
    try {
      // Check if NonRAID is installed (/proc/nmdstat exists)
      try {
        await fs.access('/proc/nmdstat');
      } catch (error) {
        // NonRAID not installed or not mounted, nothing to monitor
        return;
      }

      if (!PoolsService._nonRaidResumeDone) {
        PoolsService._nonRaidResumeDone = true;
        await this._resumePendingNonRaidDisks()
          .catch(err => console.warn(`Resuming pending NonRAID disks failed: ${err.message}`));
      }

      // Check if an operation is running
      const isRunning = await this._isNonRaidParityOperationRunning();
      if (!isRunning) {
        return;
      }

      // Get operation info from /proc/nmdstat
      const operationInfo = await this._getNonRaidOperationInfo();
      if (!operationInfo) {
        return;
      }

      // Find the NonRAID pool name
      const pools = await this.listPools({});
      const nonraidPool = pools.find(p => p.type === 'nonraid');
      if (!nonraidPool) {
        console.log('NonRAID operation detected but no NonRAID pool found in config');
        return;
      }

      console.log(`NonRAID operation detected on startup: ${operationInfo.operation} for pool ${nonraidPool.name}`);

      // Start monitoring (don't send start notification since operation was already running)
      this._startNonRaidMonitor(nonraidPool.name, operationInfo.operation, false);
    } catch (error) {
      // Silently fail - NonRAID monitoring is optional
      console.warn(`NonRAID monitor init failed: ${error.message}`);
    }
  }

  /**
   * Get NonRAID operation info from /proc/nmdstat
   * @returns {Promise<Object|null>} Operation info or null if not running
   * @private
   */
  async _getNonRaidOperationInfo() {
    try {
      const { stdout } = await execPromise('cat /proc/nmdstat');
      const actionMatch = stdout.match(/mdResyncAction=(.+)/);

      if (!actionMatch || !actionMatch[1] || actionMatch[1].trim() === '') {
        return null;
      }

      const operation = actionMatch[1].trim();

      // Get error count
      const syncErrsMatch = stdout.match(/sbSyncErrs=(\d+)/);
      const errors = syncErrsMatch ? parseInt(syncErrsMatch[1]) : 0;

      return { operation, errors };
    } catch (error) {
      return null;
    }
  }

  /**
   * Start NonRAID operation monitor
   * @param {string} poolName - Pool name
   * @param {string} operation - Operation being executed
   * @param {boolean} sendStartNotification - Whether to send start notification
   * @private
   */
  _startNonRaidMonitor(poolName, operation, sendStartNotification = true) {
    // Stop any existing monitor
    this._stopNonRaidMonitor();

    // Set monitor state
    this._nonRaidMonitor.active = true;
    this._nonRaidMonitor.poolName = poolName;
    this._nonRaidMonitor.operation = operation;

    // Send start notification if requested
    if (sendStartNotification) {
      sendNotification('nonraid', `Starting nonraid operation ${operation} for Pool ${poolName}`, 'normal')
        .catch(err => console.warn(`Failed to send NonRAID start notification: ${err.message}`));
    }

    // Start interval to check for completion every 30 seconds
    this._nonRaidMonitor.intervalId = setInterval(() => {
      this._checkNonRaidCompletion();
    }, 30000);

    console.log(`NonRAID monitor started for pool ${poolName}, operation: ${operation}`);
  }

  /**
   * Stop NonRAID operation monitor
   * @private
   */
  _stopNonRaidMonitor() {
    if (this._nonRaidMonitor.intervalId) {
      clearInterval(this._nonRaidMonitor.intervalId);
      this._nonRaidMonitor.intervalId = null;
    }
    this._nonRaidMonitor.active = false;
    this._nonRaidMonitor.poolName = null;
    this._nonRaidMonitor.operation = null;
  }

  /**
   * Check if NonRAID operation has completed
   * Called every 30 seconds by the monitor interval
   * @private
   */
  async _checkNonRaidCompletion() {
    try {
      const isRunning = await this._isNonRaidParityOperationRunning();

      if (!isRunning) {
        // Operation completed - get error count
        const operationInfo = await this._getNonRaidOperationInfo();
        const errors = operationInfo?.errors || 0;
        const poolName = this._nonRaidMonitor.poolName;
        const operation = this._nonRaidMonitor.operation;

        // Send completion notification
        if (errors > 0) {
          sendNotification('nonraid', `nonraid operation ${operation} for Pool: ${poolName} completed with ${errors} errors`, 'alert')
            .catch(err => console.warn(`Failed to send NonRAID completion notification: ${err.message}`));
        } else {
          sendNotification('nonraid', `nonraid operation ${operation} for Pool: ${poolName} completed`, 'normal')
            .catch(err => console.warn(`Failed to send NonRAID completion notification: ${err.message}`));
        }

        console.log(`NonRAID operation completed for pool ${poolName}${errors > 0 ? ` with ${errors} errors` : ''}`);

        // Stop the monitor
        this._stopNonRaidMonitor();

        this._finalizePendingNonRaidDisks()
          .catch(err => console.warn(`Finalizing pending NonRAID disks failed: ${err.message}`));
      }
    } catch (error) {
      console.warn(`NonRAID completion check failed: ${error.message}`);
    }
  }

  /**
   * Initialize BTRFS scrub monitor on API startup
   * @private
   */
  async _initBtrfsScrubMonitor() {
    try {
      const pools = await this.listPools({});
      const btrfsPools = pools.filter(p => p.type === 'btrfs');

      for (const pool of btrfsPools) {
        const mountPoint = `/mnt/${pool.name}`;
        try {
          await fs.access(mountPoint);
          const isRunning = await this._isBtrfsScrubRunning(mountPoint);
          if (isRunning) {
             console.log(`BTRFS scrub detected on startup for pool ${pool.name}`);
             this._startBtrfsScrubMonitor(pool.name, mountPoint, false);
           }
        } catch (error) {
          // Pool not mounted, skip
        }
      }
    } catch (error) {
      console.warn(`BTRFS scrub monitor init failed: ${error.message}`);
    }
  }

   /**
    * Initialize BTRFS balance monitor on API startup
    * @private
    */
   async _initBtrfsBalanceMonitor() {
     try {
       const pools = await this.listPools({});
       const btrfsPools = pools.filter(p => p.type === 'btrfs');

       for (const pool of btrfsPools) {
         const mountPoint = `/mnt/${pool.name}`;
         try {
           await fs.access(mountPoint);
           const isRunning = await this._isBtrfsBalanceRunning(mountPoint);
           if (isRunning) {
              console.log(`BTRFS balance detected on startup for pool ${pool.name}`);
              this._startBtrfsBalanceMonitor(pool.name, mountPoint, false);
            }
         } catch (error) {
           // Pool not mounted, skip
         }
       }
     } catch (error) {
       console.warn(`BTRFS balance monitor init failed: ${error.message}`);
     }
   }

   /**
    * Check if BTRFS scrub is currently running
    * @param {string} mountPoint - BTRFS mount point
    * @returns {Promise<boolean>}
    * @private
    */
    async _isBtrfsScrubRunning(mountPoint) {
      try {
        const { stdout } = await execPromise(`btrfs scrub status ${mountPoint} 2>/dev/null || echo ""`);
        return /Status:\s+running/.test(stdout);
      } catch (error) {
        return false;
      }
    }

   /**
    * Check if BTRFS balance is currently running
    * @param {string} mountPoint - BTRFS mount point
    * @returns {Promise<boolean>}
    * @private
    */
   async _isBtrfsBalanceRunning(mountPoint) {
     try {
       const { stdout } = await execPromise(`btrfs balance status ${mountPoint} 2>/dev/null || echo ""`);
       return /Balance on .* is running/.test(stdout);
     } catch (error) {
       return false;
     }
   }

   /**
    * Get BTRFS scrub progress information
    * @param {string} mountPoint - BTRFS mount point
    * @param {Object} user - User object with byte_format preference
    * @returns {Promise<Object|null>}
    * @private
    */
   async _getBtrfsScrubProgress(mountPoint, user = null) {
     try {
       const { stdout } = await execPromise(`btrfs scrub status ${mountPoint} 2>/dev/null || echo ""`);

       if (!/Status:\s+running/.test(stdout)) {
         return null;
       }

       const percentRegex = /Bytes scrubbed:\s+[\d.]+\s*\w+\s+\((\d+\.?\d*)%\)/;
       const bytesRegex = /Bytes scrubbed:\s+([\d.]+)\s*(\w+)/;
       const rateRegex = /Rate:\s+([\d.]+)\s*(\w+)\/s/;
       const errorRegex = /Error summary:\s*(\d+)\s+errors?/;

       const percentMatch = stdout.match(percentRegex);
       const bytesMatch = stdout.match(bytesRegex);
       const rateMatch = stdout.match(rateRegex);
       const errorMatch = stdout.match(errorRegex);

       const percent = percentMatch ? parseFloat(percentMatch[1]) : 0;

       let processed = null;
       if (bytesMatch) {
         const bytesValue = parseFloat(bytesMatch[1]);
         const bytesUnit = bytesMatch[2];
         const unitMultipliers = { 'B': 1, 'KiB': 1024, 'MiB': 1024 * 1024, 'GiB': 1024 * 1024 * 1024, 'TiB': 1024 * 1024 * 1024 * 1024 };
         const bytesTotal = bytesValue * (unitMultipliers[bytesUnit] || 1);
         processed = this.formatBytes(bytesTotal, user);
       }

       let speed = null;
       if (rateMatch) {
         const rateValue = parseFloat(rateMatch[1]);
         const rateUnit = rateMatch[2];
         const unitMultipliers = { 'KiB': 1024, 'MiB': 1024 * 1024, 'GiB': 1024 * 1024 * 1024 };
         const bytesPerSecond = rateValue * (unitMultipliers[rateUnit] || 1);
         speed = this.formatSpeed(bytesPerSecond, user);
       }

       const errors = errorMatch ? parseInt(errorMatch[1]) : 0;

       return {
         status: 'running',
         percent,
         processed,
         speed,
         errors
       };
     } catch (error) {
       return null;
     }
   }

  /**
   * Get BTRFS balance progress information
   * @param {string} mountPoint - BTRFS mount point
   * @param {Object} user - User object with byte_format preference
   * @returns {Promise<Object|null>}
   * @private
   */
  async _getBtrfsBalanceProgress(mountPoint, user = null) {
    try {
      const { stdout } = await execPromise(`btrfs balance status ${mountPoint} 2>/dev/null || echo ""`);

      if (!/Balance on .* is running/.test(stdout)) {
        return null;
      }

      // Parse: "28 out of about 2009 chunks balanced (29 considered),  99% left"
      const progressRegex = /(\d+)\s+out of about\s+(\d+)\s+chunks balanced/;
      const match = stdout.match(progressRegex);

      if (!match) {
        return { status: 'running', percent: 0 };
      }

      const [, done, total] = match;
      const percent = total > 0 ? ((parseFloat(done) / parseFloat(total)) * 100).toFixed(1) : 0;

      return {
        status: 'running',
        percent: parseFloat(percent)
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Start BTRFS scrub operation monitor
   * @param {string} poolName - Pool name
   * @param {string} mountPoint - BTRFS mount point
   * @param {boolean} sendStartNotification - Whether to send start notification
   * @private
   */
  _startBtrfsScrubMonitor(poolName, mountPoint, sendStartNotification = true) {
    this._stopBtrfsScrubMonitor();

    this._btrfsScrubMonitor.active = true;
    this._btrfsScrubMonitor.poolName = poolName;
    this._btrfsScrubMonitor.mountPoint = mountPoint;

    if (sendStartNotification) {
      sendNotification('BTRFS', `BTRFS scrub started for pool ${poolName}`, 'normal').catch(err => console.warn(`Failed to send BTRFS scrub start notification: ${err.message}`));
    }

    this._btrfsScrubMonitor.intervalId = setInterval(() => {
      this._checkBtrfsScrubCompletion();
    }, 10000); // Check every 10 seconds for faster detection

    console.log(`BTRFS scrub monitor started for pool ${poolName}`);
  }

  /**
   * Stop BTRFS scrub operation monitor
   * @private
   */
  _stopBtrfsScrubMonitor() {
    if (this._btrfsScrubMonitor.intervalId) {
      clearInterval(this._btrfsScrubMonitor.intervalId);
      this._btrfsScrubMonitor.intervalId = null;
    }
    this._btrfsScrubMonitor.active = false;
    this._btrfsScrubMonitor.poolName = null;
    this._btrfsScrubMonitor.mountPoint = null;
  }

  /**
   * Check if BTRFS scrub has completed
   * @private
   */
  async _checkBtrfsScrubCompletion() {
    try {
      const isRunning = await this._isBtrfsScrubRunning(this._btrfsScrubMonitor.mountPoint);

      if (!isRunning) {
        const { stdout } = await execPromise(`btrfs scrub status ${this._btrfsScrubMonitor.mountPoint} 2>/dev/null || echo ""`);

        // Parse error summary: "Error summary:    no errors found" or "Error summary:    X errors found"
        const errorSummaryMatch = stdout.match(/Error summary:\s*(\d+)\s+errors found/);
        const errors = errorSummaryMatch ? parseInt(errorSummaryMatch[1]) : 0;

        if (errors > 0) {
          sendNotification('BTRFS', `BTRFS scrub completed for pool ${this._btrfsScrubMonitor.poolName} with ${errors} error(s)`, 'alert').catch(err => console.warn(`Failed to send BTRFS scrub completion notification: ${err.message}`));
        } else {
          sendNotification('BTRFS', `BTRFS scrub completed successfully for pool ${this._btrfsScrubMonitor.poolName} - no errors found`, 'normal').catch(err => console.warn(`Failed to send BTRFS scrub completion notification: ${err.message}`));
        }

        console.log(`BTRFS scrub completed for pool ${this._btrfsScrubMonitor.poolName}${errors > 0 ? ` with ${errors} errors` : ' - no errors'}`);
        this._stopBtrfsScrubMonitor();
      }
    } catch (error) {
      console.warn(`BTRFS scrub completion check failed: ${error.message}`);
    }
  }

  /**
   * Start BTRFS balance operation monitor
   * @param {string} poolName - Pool name
   * @param {string} mountPoint - BTRFS mount point
   * @param {boolean} sendStartNotification - Whether to send start notification
   * @private
   */
  _startBtrfsBalanceMonitor(poolName, mountPoint, sendStartNotification = true) {
    this._stopBtrfsBalanceMonitor();

    this._btrfsBalanceMonitor.active = true;
    this._btrfsBalanceMonitor.poolName = poolName;
    this._btrfsBalanceMonitor.mountPoint = mountPoint;

    if (sendStartNotification) {
      sendNotification('BTRFS', `BTRFS balance started for pool ${poolName}`, 'normal').catch(err => console.warn(`Failed to send BTRFS balance start notification: ${err.message}`));
    }

    this._btrfsBalanceMonitor.intervalId = setInterval(() => {
      this._checkBtrfsBalanceCompletion();
    }, 10000); // Check every 10 seconds for faster detection

    console.log(`BTRFS balance monitor started for pool ${poolName}`);
  }

 /**
   * Stop BTRFS balance operation monitor
   * @private
   */
  _stopBtrfsBalanceMonitor() {
    if (this._btrfsBalanceMonitor.intervalId) {
      clearInterval(this._btrfsBalanceMonitor.intervalId);
      this._btrfsBalanceMonitor.intervalId = null;
    }
    this._btrfsBalanceMonitor.active = false;
    this._btrfsBalanceMonitor.poolName = null;
    this._btrfsBalanceMonitor.mountPoint = null;
  }

  /**
   * Check if BTRFS balance has completed
   * @private
   */
  async _checkBtrfsBalanceCompletion() {
    try {
      const isRunning = await this._isBtrfsBalanceRunning(this._btrfsBalanceMonitor.mountPoint);

      if (!isRunning) {
        const { stdout } = await execPromise(`btrfs balance status ${this._btrfsBalanceMonitor.mountPoint} 2>/dev/null || echo ""`);

        // Balance doesn't have error summary like scrub, just check completion
        sendNotification('BTRFS', `BTRFS balance completed successfully for pool ${this._btrfsBalanceMonitor.poolName}`, 'normal').catch(err => console.warn(`Failed to send BTRFS balance completion notification: ${err.message}`));

        console.log(`BTRFS balance completed for pool ${this._btrfsBalanceMonitor.poolName}`);
        this._stopBtrfsBalanceMonitor();
      }
    } catch (error) {
      console.warn(`BTRFS balance completion check failed: ${error.message}`);
    }
  }

  /**
   * Execute BTRFS scrub operation
   * @param {string} poolId - Pool ID
   * @param {string} operation - Operation: start, status, pause, cancel, auto
   * @param {Object} options - Additional options
   * @returns {Promise<Object>}
   */
  async executeBtrfsScrubOperation(poolId, operation, options = {}) {
    const pool = await this.getPoolById(poolId);

    if (pool.type !== 'btrfs') {
      throw new Error(`Scrub is only supported for BTRFS pools, not '${pool.type}'`);
    }

    const mountPoint = `/mnt/${pool.name}`;
    try {
      await fs.access(mountPoint);
    } catch (error) {
      throw new Error('BTRFS pool is not mounted. Please mount the pool first.');
    }

    // Validate operation
    const validOperations = ['start', 'status', 'pause', 'cancel'];
    if (!validOperations.includes(operation)) {
      throw new Error(`Invalid operation. Supported operations: ${validOperations.join(', ')}`);
    }

    // Handle status operation
    if (operation === 'status') {
      const isRunning = await this._isBtrfsScrubRunning(mountPoint);
      const progress = isRunning ? await this._getBtrfsScrubProgress(mountPoint, options.user) : null;

      return {
        success: true,
        operation: 'status',
        poolName: pool.name,
        running: isRunning,
        progress,
        timestamp: new Date().toISOString()
      };
    }

    // Check if operation is already running
    const isRunning = await this._isBtrfsScrubRunning(mountPoint);

    switch (operation) {
      case 'start':
        if (isRunning) {
          throw new Error('A scrub operation is already running. Use "cancel" to stop it first.');
        }
        break;
      case 'pause':
      case 'cancel':
        if (!isRunning) {
          throw new Error('No scrub operation is currently running');
        }
        break;
    }

    // Build command
    let command;
    let description;

    switch (operation) {
      case 'start':
        command = `btrfs scrub start ${mountPoint}`;
        description = 'BTRFS scrub started';
        break;
      case 'pause':
        command = `btrfs scrub cancel ${mountPoint}`;
        description = 'BTRFS scrub paused';
        break;
      case 'cancel':
        command = `btrfs scrub cancel ${mountPoint}`;
        description = 'BTRFS scrub cancelled';
        break;
    }

    try {
      console.log(`Executing BTRFS scrub operation: ${command}`);

      // For start operation, run detached (async) like SnapRAID
      if (operation === 'start') {
        const { spawn } = require('child_process');
        const child = spawn('bash', ['-c', command], {
          detached: true,
          stdio: 'ignore'
        });
        child.unref();

        this._startBtrfsScrubMonitor(pool.name, mountPoint, true);
      } else {
        // For pause/cancel, wait for completion
        await execPromise(command);

        if (operation === 'pause') {
          sendNotification('BTRFS', `BTRFS scrub paused for pool ${pool.name}`, 'normal')
            .catch(err => console.warn(`Failed to send BTRFS scrub pause notification: ${err.message}`));
        } else if (operation === 'cancel') {
          sendNotification('BTRFS', `BTRFS scrub cancelled for pool ${pool.name}`, 'normal')
            .catch(err => console.warn(`Failed to send BTRFS scrub cancel notification: ${err.message}`));
          this._stopBtrfsScrubMonitor();
        }
      }

      return {
        success: true,
        message: description,
        operation,
        poolName: pool.name,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      throw new Error(`BTRFS scrub operation failed: ${error.message}`);
    }
  }

  /**
   * Execute BTRFS balance operation
   * @param {string} poolId - Pool ID
   * @param {string} operation - Operation: start, status, pause, cancel, auto
   * @param {Object} options - Additional options
   * @returns {Promise<Object>}
   */
  async executeBtrfsBalanceOperation(poolId, operation, options = {}) {
    const pool = await this.getPoolById(poolId);

    if (pool.type !== 'btrfs') {
      throw new Error(`Balance is only supported for BTRFS pools, not '${pool.type}'`);
    }

    const mountPoint = `/mnt/${pool.name}`;
    try {
      await fs.access(mountPoint);
    } catch (error) {
      throw new Error('BTRFS pool is not mounted. Please mount the pool first.');
    }

     // Validate operation
     const validOperations = ['start', 'status', 'pause', 'cancel'];
     if (!validOperations.includes(operation)) {
       throw new Error(`Invalid operation. Supported operations: ${validOperations.join(', ')}`);
     }

     // Handle status operation
     if (operation === 'status') {
       const isRunning = await this._isBtrfsBalanceRunning(mountPoint);
       const progress = isRunning ? await this._getBtrfsBalanceProgress(mountPoint, options.user) : null;

       return {
         success: true,
         operation: 'status',
         poolName: pool.name,
         running: isRunning,
         progress,
         timestamp: new Date().toISOString()
       };
     }

     // Check if operation is already running
     const isRunning = await this._isBtrfsBalanceRunning(mountPoint);

     switch (operation) {
       case 'start':
         if (isRunning) {
           throw new Error('A balance operation is already running. Use "cancel" to stop it first.');
         }
         break;
       case 'pause':
       case 'cancel':
         if (!isRunning) {
           throw new Error('No balance operation is currently running');
         }
         break;
     }

     // Build command
     let command;
     let description;

     switch (operation) {
       case 'start':
         if (options.raidLevel) {
           command = `btrfs balance start -dconvert=${options.raidLevel} -mconvert=${options.raidLevel} ${mountPoint}`;
           description = `BTRFS balance started with RAID ${options.raidLevel} conversion`;
         } else {
           command = `btrfs balance start ${mountPoint}`;
           description = 'BTRFS balance started';
         }
         break;
       case 'pause':
         command = `btrfs balance pause ${mountPoint}`;
         description = 'BTRFS balance paused';
         break;
       case 'cancel':
         command = `btrfs balance cancel ${mountPoint}`;
         description = 'BTRFS balance cancelled';
         break;
     }

     try {
       console.log(`Executing BTRFS balance operation: ${command}`);

       // For start operation, run detached (async) like SnapRAID
       if (operation === 'start') {
         const { spawn } = require('child_process');
         const child = spawn('bash', ['-c', command], {
           detached: true,
           stdio: 'ignore'
         });
         child.unref();

         this._startBtrfsBalanceMonitor(pool.name, mountPoint, true);
       } else {
         // For pause/cancel, wait for completion
         await execPromise(command);

         if (operation === 'pause') {
           sendNotification('BTRFS', `BTRFS balance paused for pool ${pool.name}`, 'normal')
             .catch(err => console.warn(`Failed to send BTRFS balance pause notification: ${err.message}`));
         } else if (operation === 'cancel') {
           sendNotification('BTRFS', `BTRFS balance cancelled for pool ${pool.name}`, 'normal')
             .catch(err => console.warn(`Failed to send BTRFS balance cancel notification: ${err.message}`));
           this._stopBtrfsBalanceMonitor();
         }
       }

       return {
         success: true,
         message: description,
         operation,
         poolName: pool.name,
         timestamp: new Date().toISOString()
       };
     } catch (error) {
       throw new Error(`BTRFS balance operation failed: ${error.message}`);
     }
   }

   /**
    * Inject BTRFS scrub/balance operation status into pool object
    * @param {Object} pool - Pool object to inject status into
    * @param {Object} user - User object with byte_format preference
    * @returns {Promise<void>}
    */
   async _injectBtrfsOperationStatus(pool, user = null) {
     try {
       if (!pool.status) {
         pool.status = {};
       }

       const mountPoint = `/mnt/${pool.name}`;
       let scrubRunning = false;
       let balanceRunning = false;
       let scrubProgress = null;
       let balanceProgress = null;

       try {
         await fs.access(mountPoint);
         scrubRunning = await this._isBtrfsScrubRunning(mountPoint);
         balanceRunning = await this._isBtrfsBalanceRunning(mountPoint);

         if (scrubRunning) {
           scrubProgress = await this._getBtrfsScrubProgress(mountPoint, user);
         }
         if (balanceRunning) {
           balanceProgress = await this._getBtrfsBalanceProgress(mountPoint, user);
         }
       } catch (error) {
         // Pool not mounted
       }

        pool.status.scrub_operation = scrubRunning;
        pool.status.scrub_progress = scrubProgress;
        pool.status.balance_operation = balanceRunning;
        pool.status.balance_progress = balanceProgress;
     } catch (error) {
       if (!pool.status) {
         pool.status = {};
       }
       pool.status.scrub_operation = false;
       pool.status.scrub_progress = null;
       pool.status.balance_operation = false;
       pool.status.balance_progress = null;
     }
   }

  /**
   * Check if a bcachefs scrub is currently running
   * Also matches the scrub mos-mount_disks starts after an unclean shutdown. The bracket
   * keeps pgrep from matching the shell that runs it.
   * @param {string} mountPoint - bcachefs mount point
   * @returns {Promise<boolean>}
   * @private
   */
  async _isBcachefsScrubRunning(mountPoint) {
    try {
      await execPromise(`pgrep -f "[b]cachefs scrub ${mountPoint}$"`);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get bcachefs scrub progress from the log of an API started scrub
   * @param {string} poolName - Pool name
   * @returns {Promise<Object>} Progress, percent is null when it cannot be parsed
   * @private
   */
  async _getBcachefsScrubProgress(poolName) {
    try {
      const { stdout } = await execPromise(`tail -c 1000 /run/bcachefs/${poolName}.scrub 2>/dev/null || echo ""`);

      // Progress is redrawn with carriage returns, the last fragment holds the current state
      const lastLine = stdout.split(/[\r\n]+/).map(line => line.trim()).filter(Boolean).pop();
      const percentMatch = lastLine ? lastLine.match(/(\d+(?:\.\d+)?)%/) : null;

      return {
        status: 'running',
        percent: percentMatch ? parseFloat(percentMatch[1]) : null
      };
    } catch (error) {
      return { status: 'running', percent: null };
    }
  }

  /**
   * Execute bcachefs scrub operation
   * @param {string} poolId - Pool ID
   * @param {string} operation - Operation: start, status, cancel
   * @param {Object} options - Additional options
   * @returns {Promise<Object>}
   */
  async executeBcachefsScrubOperation(poolId, operation, options = {}) {
    const pool = await this.getPoolById(poolId);

    if (pool.type !== 'bcachefs') {
      throw new Error(`Scrub is only supported for bcachefs pools, not '${pool.type}'`);
    }

    const mountPoint = `/mnt/${pool.name}`;
    if (!await this._isMounted(mountPoint)) {
      throw new Error('bcachefs pool is not mounted. Please mount the pool first.');
    }

    // bcachefs scrub has no pause, it can only be stopped
    const validOperations = ['start', 'status', 'cancel'];
    if (!validOperations.includes(operation)) {
      throw new Error(`Invalid operation. Supported operations: ${validOperations.join(', ')}`);
    }

    const isRunning = await this._isBcachefsScrubRunning(mountPoint);

    if (operation === 'status') {
      return {
        success: true,
        operation: 'status',
        poolName: pool.name,
        running: isRunning,
        progress: isRunning ? await this._getBcachefsScrubProgress(pool.name) : null,
        timestamp: new Date().toISOString()
      };
    }

    if (operation === 'start' && isRunning) {
      throw new Error('A scrub operation is already running. Use "cancel" to stop it first.');
    }
    if (operation === 'cancel' && !isRunning) {
      throw new Error('No scrub operation is currently running');
    }

    try {
      if (operation === 'start') {
        await fs.mkdir('/run/bcachefs', { recursive: true });
        const log = await fs.open(`/run/bcachefs/${pool.name}.scrub`, 'w');

        // Runs in the foreground until done, so it is detached and its output kept for progress
        const child = spawn('bcachefs', ['scrub', mountPoint], {
          detached: true,
          stdio: ['ignore', log.fd, log.fd]
        });
        await log.close();

        child.on('error', (error) => {
          console.warn(`bcachefs scrub for pool ${pool.name} failed to start: ${error.message}`);
        });
        child.on('exit', (code, signal) => {
          // Cancel sends its own notification
          if (signal) return;

          const message = code === 0
            ? `bcachefs scrub completed for pool ${pool.name}`
            : `bcachefs scrub for pool ${pool.name} finished with exit code ${code}, affected paths are logged to dmesg`;
          sendNotification('bcachefs', message, code === 0 ? 'normal' : 'alert')
            .catch(err => console.warn(`Failed to send bcachefs scrub completion notification: ${err.message}`));
        });
        child.unref();

        sendNotification('bcachefs', `bcachefs scrub started for pool ${pool.name}`, 'normal')
          .catch(err => console.warn(`Failed to send bcachefs scrub start notification: ${err.message}`));
      } else {
        await execPromise(`pkill -f "[b]cachefs scrub ${mountPoint}$"`);

        sendNotification('bcachefs', `bcachefs scrub cancelled for pool ${pool.name}`, 'normal')
          .catch(err => console.warn(`Failed to send bcachefs scrub cancel notification: ${err.message}`));
      }

      return {
        success: true,
        message: operation === 'start' ? 'bcachefs scrub started' : 'bcachefs scrub cancelled',
        operation,
        poolName: pool.name,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      throw new Error(`bcachefs scrub operation failed: ${error.message}`);
    }
  }

  /**
   * Inject bcachefs scrub status into pool object
   * Uses the same status keys as BTRFS so clients can share the display
   * @param {Object} pool - Pool object to inject status into
   * @returns {Promise<void>}
   */
  async _injectBcachefsOperationStatus(pool) {
    if (!pool.status) {
      pool.status = {};
    }

    const scrubRunning = await this._isBcachefsScrubRunning(`/mnt/${pool.name}`);
    pool.status.scrub_operation = scrubRunning;
    pool.status.scrub_progress = scrubRunning ? await this._getBcachefsScrubProgress(pool.name) : null;
  }

   /**
    * Ensure that scrub configuration exists in pool config for BTRFS and bcachefs pools
    * @param {Object} pool - Pool object
    * @returns {boolean} - Whether the pool was modified
    * @private
    */
   _ensureBtrfsScrubConfig(pool) {
     if (!['btrfs', 'bcachefs'].includes(pool.type)) {
       return false;
     }

     if (!pool.config) {
       pool.config = {};
     }

     if (!pool.config.scrub) {
       pool.config.scrub = {
         enabled: false,
         schedule: "0 4 * * WED"
       };
       return true;
     }

     return false;
   }

   /**
    * Ensure that BTRFS balance configuration exists in pool config
    * @param {Object} pool - Pool object
    * @returns {boolean} - Whether the pool was modified
    * @private
    */
   _ensureBtrfsBalanceConfig(pool) {
     if (pool.type !== 'btrfs') {
       return false;
     }

     if (!pool.config) {
       pool.config = {};
     }

     if (!pool.config.balance) {
       pool.config.balance = {
         enabled: false,
         schedule: "0 5 * * SUN"
       };
       return true;
     }

     return false;
   }

   /**
   * Map mount points to SnapRAID disk identifiers (dN) by parsing the config file
   * @param {string} poolName - Pool name to find config file
   * @param {string[]} mountPoints - Array of mount points to map
   * @returns {Promise<string>} Comma-separated disk identifiers (e.g., "d2,d4")
   * @throws {Error} If config file not found or mount points don't match
   */
  async _mapMountPointsToSnapraidDisks(poolName, mountPoints) {
    const configPath = `/boot/config/snapraid/${poolName}.conf`;

    // Read and parse the SnapRAID config file
    let configContent;
    try {
      configContent = await fs.readFile(configPath, 'utf8');
    } catch (error) {
      throw new Error(`SnapRAID config file not found: ${configPath}`);
    }

    // Parse data lines: "data dN /path/to/mount"
    const dataLineRegex = /^data\s+(d\d+)\s+(.+)$/gm;
    const diskMap = new Map(); // mountPoint -> dN

    let match;
    while ((match = dataLineRegex.exec(configContent)) !== null) {
      const diskId = match[1];     // e.g., "d1", "d2"
      const diskPath = match[2].trim(); // e.g., "/var/mergerfs/media/disk1"
      diskMap.set(diskPath, diskId);
    }

    if (diskMap.size === 0) {
      throw new Error(`No data disk entries found in SnapRAID config: ${configPath}`);
    }

    // Map each mount point to its disk identifier
    const diskIds = [];
    const notFound = [];

    for (const mountPoint of mountPoints) {
      const normalizedMount = mountPoint.replace(/\/+$/, ''); // Remove trailing slashes
      const diskId = diskMap.get(normalizedMount);

      if (diskId) {
        diskIds.push(diskId);
      } else {
        notFound.push(mountPoint);
      }
    }

    if (notFound.length > 0) {
      const availablePaths = Array.from(diskMap.keys()).join(', ');
      throw new Error(`Mount point(s) not found in SnapRAID config: ${notFound.join(', ')}. Available paths: ${availablePaths}`);
    }

    if (diskIds.length === 0) {
      throw new Error('No valid disk identifiers found for the provided mount points');
    }

    return diskIds.join(',');
  }

  async executeSnapRAIDOperation(poolId, operation, options = {}) {
    const pool = await this.getPoolById(poolId);

    // Validate pool type
    if (pool.type !== 'mergerfs') {
      throw new Error('SnapRAID operations are only supported for MergerFS pools');
    }

    // Validate that pool has parity devices
    if (!pool.parity_devices || pool.parity_devices.length === 0) {
      throw new Error('Pool does not have any SnapRAID parity devices configured');
    }

    // Validate operation - extract base operation (first word) for validation
    // Operations can include flags like "sync --force-empty" or "fix -d d1"
    const baseOperation = operation.split(' ')[0];
    const validOperations = ['sync', 'check', 'scrub', 'fix', 'status', 'force_stop'];
    if (!validOperations.includes(baseOperation)) {
      throw new Error(`Invalid operation. Supported operations: ${validOperations.join(', ')}`);
    }

    // Check if operation is already running (except for force_stop)
    const socketPath = `/run/snapraid/${pool.name}.socket`;
    if (baseOperation !== 'force_stop') {
      try {
        await fs.access(socketPath);
        throw new Error(`SnapRAID operation is already running for pool '${pool.name}'. Socket file exists: ${socketPath}`);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error; // Re-throw if it's not a "file not found" error
        }
        // File doesn't exist, which is good - no operation running
      }
    } else {
      // For force_stop, check if operation is actually running
      try {
        await fs.access(socketPath);
        // Socket exists, operation is running - good for force_stop
      } catch (error) {
        if (error.code === 'ENOENT') {
          throw new Error(`No SnapRAID operation is currently running for pool '${pool.name}'`);
        }
        throw error;
      }
    }

    // For fix operation, optionally map disk mount points to dN identifiers
    // If fixDisks is provided, only those disks will be fixed; otherwise all disks
    // Skip this if operation already contains flags (e.g., "fix -d d1")
    let fixDisksArg = null;
    if (baseOperation === 'fix' && operation === 'fix') {
      const { fixDisks } = options;
      if (fixDisks && Array.isArray(fixDisks) && fixDisks.length > 0) {
        // Map mount points to SnapRAID disk identifiers
        fixDisksArg = await this._mapMountPointsToSnapraidDisks(pool.name, fixDisks);
      }
      // If no fixDisks provided, SnapRAID will fix all disks
    }

    // Execute the SnapRAID operation in background
    try {
      const { spawn } = require('child_process');
      console.log(`Starting SnapRAID ${operation} operation for pool '${pool.name}'${fixDisksArg ? ` with disks: ${fixDisksArg}` : ''}`);

      // Build command with quoted arguments for shell safety
      let cmd = `/usr/local/bin/mos-snapraid "${pool.name}" "${operation}"`;
      if (fixDisksArg) {
        cmd += ` "${fixDisksArg}"`; // e.g., "d2,d4" or "d3"
      }

      // Execute the script via shell with properly quoted arguments
      const child = spawn('bash', ['-c', cmd], {
        detached: true,
        stdio: 'ignore'
      });

      // Don't wait for the process to finish
      child.unref();

      const result = {
        success: true,
        message: `SnapRAID ${operation} operation started successfully for pool '${pool.name}'`,
        operation,
        poolName: pool.name,
        started: true,
        timestamp: new Date().toISOString()
      };

      // Include fix disks info in response
      if (fixDisksArg) {
        result.fixDisks = fixDisksArg;
        result.message += ` (fixing disks: ${fixDisksArg})`;
      }

      return result;
    } catch (error) {
      throw new Error(`SnapRAID ${operation} operation failed to start: ${error.message}`);
    }
  }

  /**
   * Parse SnapRAID progress from socket file output
   * @param {string} socketPath - Path to socket file
   * @param {Object} user - User object with byte_format preference
   * @returns {Promise<Object|null>} Progress object or null if not available
   * @private
   */
  async _parseSnapraidProgress(socketPath, user = null) {
    try {
      // Read last 1000 bytes of socket file to get latest progress line
      const { stdout } = await execPromise(`tail -c 1000 ${socketPath} 2>/dev/null || echo ""`);

      if (!stdout || !stdout.trim()) {
        return null;
      }

      // Get last non-empty line
      const lines = stdout.trim().split('\n').filter(line => line.trim());
      const lastLine = lines[lines.length - 1];

      // Pattern: "52%, 27524348 MB, 519 MB/s, 495 stripe/s, CPU 18%, 11:04 ETA"
      // Support MB, GB, TB for both data and speed
      const progressRegex = /(\d+)%,\s+([\d.]+)\s+(MB|GB|TB),\s+([\d.]+)\s+(MB|GB|TB)\/s,\s+([\d.]+)\s+stripe\/s.*?([\d]+:[\d]+)\s+ETA/;
      const match = lastLine.match(progressRegex);

      if (!match) {
        return null;
      }

      const [, percent, dataAmount, dataUnit, speedValue, speedUnit, stripes, eta] = match;

      // Convert to bytes for formatting
      const units = {
        'MB': 1000000,
        'GB': 1000000000,
        'TB': 1000000000000
      };

      const bytesAmount = parseFloat(dataAmount) * units[dataUnit];
      const bytesPerSecond = parseFloat(speedValue) * units[speedUnit];

      return {
        status: 'running',
        percent: parseInt(percent),
        height: this.formatBytes(bytesAmount, user),
        speed: this.formatSpeed(bytesPerSecond, user),
        stripes: `${stripes} stripe/s`,
        eta: eta
      };
    } catch (error) {
      // Silent fail - socket might not be readable or format unexpected
      return null;
    }
  }

  /**
   * Inject parity operation status into pool.status object (API-only, not persisted)
   * @param {Object} pool - Pool object to inject status into
   * @param {Object} user - User object with byte_format preference
   * @returns {Promise<void>}
   */
  async _injectParityOperationStatus(pool, user = null) {
    try {
      // Ensure status object exists
      if (!pool.status) {
        pool.status = {};
      }

      // Handle NonRAID pools
      if (pool.type === 'nonraid') {
        await this._injectNonRaidParityStatus(pool, user);
        return;
      }

      // Handle BTRFS pools (scrub and balance)
      if (pool.type === 'btrfs') {
        await this._injectBtrfsOperationStatus(pool, user);
        return;
      }

      if (pool.type === 'bcachefs') {
        await this._injectBcachefsOperationStatus(pool);
        return;
      }

      // Only MergerFS pools can have parity operations
      if (pool.type !== 'mergerfs') {
        pool.status.parity_operation = false;
        pool.status.parity_progress = null;
        return;
      }

      // Check if SnapRAID operation is running via socket file
      const socketPath = `/run/snapraid/${pool.name}.socket`;
      try {
        await fs.access(socketPath);
        // Socket exists, operation is running
        pool.status.parity_operation = true;

        // Try to parse progress information
        const progress = await this._parseSnapraidProgress(socketPath, user);
        if (progress) {
          pool.status.parity_progress = progress;
        } else {
          // Socket exists but no progress data yet
          pool.status.parity_progress = {
            status: 'preparing',
            percent: 0,
            height: null,
            speed: null,
            stripes: null,
            eta: null
          };
        }
      } catch (error) {
        if (error.code === 'ENOENT') {
          // Socket doesn't exist, no operation running
          pool.status.parity_operation = false;
          pool.status.parity_progress = null;
        } else {
          // Other error, assume no operation running
          pool.status.parity_operation = false;
          pool.status.parity_progress = null;
        }
      }
    } catch (error) {
      // On any error, default to false
      if (!pool.status) {
        pool.status = {};
      }
      pool.status.parity_operation = false;
      pool.status.parity_progress = null;
    }
  }

  /**
   * Ensure that scrub configuration exists in pool config for MergerFS pools with parity
   * @param {Object} pool - Pool object
   * @returns {boolean} - Whether the pool was modified
   * @private
   */
  _ensureScrubConfig(pool) {
    // Only for MergerFS pools with parity devices
    if (pool.type !== 'mergerfs' || !pool.parity_devices || pool.parity_devices.length === 0) {
      return false;
    }

    // Ensure config object exists
    if (!pool.config) {
      pool.config = {};
    }

    // Ensure sync config exists
    if (!pool.config.sync) {
      return false; // No sync config, scrub shouldn't be added
    }

    // Check if scrub config is missing within sync
    if (!pool.config.sync.scrub) {
      pool.config.sync.scrub = {
        enabled: false,
        schedule: "0 4 * * WED"
      };
      return true;
    }

    return false;
  }

  /**
   * Ensure that usage alert configuration exists in pool config.
   * Defaults: warning at 70%, alert at 90% (percent of pool usage).
   * A threshold value of 0 disables that level; warning=0 AND alert=0
   * disables monitoring for the pool entirely.
   * @param {Object} pool - Pool object
   * @returns {boolean} - Whether the pool was modified
   * @private
   */
  _ensureUsageAlertConfig(pool) {
    if (!pool.config) {
      pool.config = {};
    }

    if (!pool.config.usage_alert) {
      pool.config.usage_alert = {
        warning: 70,
        alert: 90
      };
      return true;
    }

    return false;
  }

  /**
   * Update the SnapRAID configuration for a pool
   * @param {Object} pool - Pool object
   * @returns {Promise<void>}
   */
  async updateSnapRAIDConfig(pool) {
    if (!pool.parity_devices || pool.parity_devices.length === 0) {
      return;
    }

    const snapraidConfigDir = '/boot/config/snapraid';
    await fs.mkdir(snapraidConfigDir, { recursive: true });
    const snapraidConfigPath = path.join(snapraidConfigDir, `${pool.name}.conf`);

    const mergerfsBaseDir = `/var/mergerfs/${pool.name}`;

    // Create a new SnapRAID config
    let snapraidConfig = `# SnapRAID configuration for ${pool.name} pool\n`;
    snapraidConfig += `# Generated by MOS API on ${new Date().toISOString()}\n\n`;

    // Add all parity devices - use sequential numbering (0=parity, 1=2-parity, 2=3-parity)
    pool.parity_devices.forEach((parityDevice, index) => {
      // Mount point is based on the device's slot number
      const parityMountPoint = path.join(this.snapraidBasePath, pool.name, `parity${parityDevice.slot}`);

      // Config naming is based on sequential order (first device is always "parity")
      if (index === 0) {
        snapraidConfig += `parity ${parityMountPoint}/.snapraid.parity\n`;
      } else {
        const configIndex = index + 1;
        snapraidConfig += `${configIndex}-parity ${parityMountPoint}/.snapraid.${configIndex}-parity\n`;
      }
    });

    // Add content files for all data devices
    pool.data_devices.forEach(device => {
      const deviceMountPoint = path.join(mergerfsBaseDir, `disk${device.slot}`);
      snapraidConfig += `content ${deviceMountPoint}/.snapraid\n`;
    });

    // Add content files for parity devices
    pool.parity_devices.forEach((parityDevice) => {
      const parityMountPoint = path.join(this.snapraidBasePath, pool.name, `parity${parityDevice.slot}`);
      snapraidConfig += `content ${parityMountPoint}/.snapraid.content\n`;
    });

    snapraidConfig += '\n';

    // Add data disks with IDs - use slot number to preserve parity mapping
    // IMPORTANT: SnapRAID disk IDs must stay consistent with original slot assignments
    // to maintain parity integrity across add/remove operations
    pool.data_devices.forEach((device) => {
      const deviceMountPoint = path.join(mergerfsBaseDir, `disk${device.slot}`);
      const diskId = `d${device.slot}`;  // Use slot number, not array index!
      snapraidConfig += `data ${diskId} ${deviceMountPoint}\n`;
    });

    snapraidConfig += '\n';

    // Add standard exclusion patterns
    snapraidConfig += `exclude *.tmp\n`;
    snapraidConfig += `exclude *.temp\n`;
    snapraidConfig += `exclude *.log\n`;
    snapraidConfig += `exclude *.bak\n`;
    snapraidConfig += `exclude Thumbs.db\n`;
    snapraidConfig += `exclude .DS_Store\n`;
    snapraidConfig += `exclude .AppleDouble\n`;
    snapraidConfig += `exclude ._*\n`;
    snapraidConfig += `exclude .Spotlight-V100\n`;
    snapraidConfig += `exclude .Trashes\n`;
    snapraidConfig += `exclude .fseventsd\n`;
    snapraidConfig += `exclude .DocumentRevisions-V100\n`;
    snapraidConfig += `exclude .TemporaryItems\n`;
    snapraidConfig += `exclude lost+found/\n`;
    snapraidConfig += `exclude .recycle/\n`;
    snapraidConfig += `exclude $RECYCLE.BIN/\n`;
    snapraidConfig += `exclude System Volume Information/\n`;
    snapraidConfig += `exclude pagefile.sys\n`;
    snapraidConfig += `exclude hiberfil.sys\n`;
    snapraidConfig += `exclude swapfile.sys\n`;

    // Write the updated config file
    await fs.writeFile(snapraidConfigPath, snapraidConfig);
  }

  /**
   * Create a multi-device BTRFS pool with RAID support
   * @param {string} name - Pool name
   * @param {string[]} devices - Array of device paths
   * @param {string} raidLevel - BTRFS raid level ('raid0', 'raid1', 'raid10', 'single', etc.)
   * @param {Object} options - Additional options
   * @param {Object} options.config - Pool configuration
   * @param {boolean} options.config.encrypted - Enable LUKS encryption
   * @param {boolean} options.config.create_keyfile - Create keyfile for encrypted pool (default: false)
   * @param {string} options.passphrase - Passphrase for encryption (required if encrypted=true)
   */
  async createMultiDevicePool(name, devices, raidLevel = 'raid1', options = {}) {
    const poolConfig = { name, config: options.config };
    const strategy = this._getDeviceStrategy(poolConfig);
    let preparedDeviceInfos = [];

    try {
      // Validate inputs
      if (!name) throw new Error('Pool name is required');
      PoolHelpers.validatePoolName(name);

      // Auto-generate passphrase if needed
      if (options.config?.encrypted) {
        if (!options.passphrase || options.passphrase.trim() === '') {
          if (options.config?.create_keyfile) {
            options.passphrase = this._generateSecurePassphrase();
            console.log(`Generated secure passphrase for encrypted pool '${name}'`);
          } else {
            throw new Error('Passphrase is required for encrypted pools');
          }
        }
        if (options.passphrase.length < 8) {
          throw new Error('Passphrase must be at least 8 characters long for LUKS encryption');
        }
      }

      // Validate devices
      if (!Array.isArray(devices)) {
        throw new Error('Devices must be an array of device paths');
      }

      if (devices.length === 1) {
        return this.createSingleDevicePool(name, devices[0], 'btrfs', options);
      }

      if (devices.length < 2) {
        throw new Error('At least two devices are required for a multi-device pool');
      }

      // Validate RAID level
      const validRaidLevels = ['raid0', 'raid1', 'raid10', 'single'];
      if (!validRaidLevels.includes(raidLevel)) {
        throw new Error(`Unsupported RAID level: ${raidLevel}. Supported: ${validRaidLevels.join(', ')}`);
      }

      // Read current pools data
      const pools = await this._readPools();

      // Check if pool exists
      if (pools.some(p => p.name === name)) {
        throw new Error(`Pool with name "${name}" already exists`);
      }

      // Check name does not collide with a MergerFS Path Pool (vpool)
      await PoolHelpers.assertNameNotInVpools(name);

      // Check each device
      for (const device of devices) {
        await fs.access(device).catch(() => {
          throw new Error(`Device ${device} does not exist`);
        });

        const mountStatus = await this._isDeviceMounted(device);
        if (mountStatus.isMounted) {
          throw new Error(`Device ${device} is already mounted at ${mountStatus.mountPoint}`);
        }
      }

      // Create mount point
      const mountPoint = path.join(this.mountBasePath, name);
      await this._createDirectoryWithOwnership(mountPoint, this.defaultOwnership);

      // Prepare physical devices (partitioning)
      const physicalDevices = [];
      for (const device of devices) {
        if (options.format === true) {
          const targetDevice = await this._ensurePartition(device);
          physicalDevices.push(targetDevice);
        } else {
          // Import mode
          const deviceInfo = await this.checkDeviceFilesystem(device);
          if (deviceInfo.actualDevice) {
            physicalDevices.push(deviceInfo.actualDevice);
          } else if (deviceInfo.isFormatted && !['dos', 'gpt', 'mbr'].includes(deviceInfo.filesystem)) {
            physicalDevices.push(device);
          } else {
            throw new Error(`Device ${device} has no usable filesystem. Use format: true`);
          }
        }
      }

      // Prepare devices with Strategy Pattern (handles encryption automatically)
      preparedDeviceInfos = await strategy.prepareDevices(
        physicalDevices,
        poolConfig,
        options
      );

      // Get operational devices for formatting/mounting
      const operationalDevices = preparedDeviceInfos.map(d =>
        strategy.getOperationalDevicePath(d)
      );

      // Format with BTRFS if requested
      if (options.format === true) {
        const deviceArgs = operationalDevices.join(' ');
        const formatCommand = `mkfs.btrfs -f -d ${raidLevel} -m ${raidLevel} -L "${name}" ${deviceArgs}`;
        await execPromise(formatCommand);
        await this._refreshDeviceSymlinks();
      } else {
        console.log(`Skipping formatting - importing existing BTRFS filesystem`);
      }

      // Create pool object with multiple devices
      const poolId = Date.now().toString();

      // Get UUIDs from devices (Strategy handles physical vs operational)
      const dataDevices = [];
      for (let i = 0; i < preparedDeviceInfos.length; i++) {
        const deviceInfo = preparedDeviceInfos[i];
        const uuid = await strategy.getDeviceUuid(deviceInfo, poolConfig);
        dataDevices.push({
          slot: i + 1,
          id: uuid,
          filesystem: 'btrfs',
          spindown: null
        });
      }

      const newPool = {
        id: poolId,
        name,
        type: 'btrfs',
        automount: options.automount !== undefined ? options.automount : false,
        comment: options.comment || "",
        index: this._getNextPoolIndex(pools),
        data_devices: dataDevices,
        parity_devices: [],
        config: {
          encrypted: options.config?.encrypted || false,
          shared: options.config?.shared || false,
          raid_level: raidLevel,
          unclean_check: true,
          usage_alert: { warning: 70, alert: 90 },
          ...(options.config || {})
        }
      };

      // Save pool
      pools.push(newPool);
      await this._writePools(pools);

      // Mount or cleanup
      if (newPool.automount) {
        try {
          const deviceToMount = operationalDevices[0];
          await this.mountDevice(deviceToMount, mountPoint, { mountOptions: `device=${deviceToMount}` });
          await this._updateBtrfsDevicePathsInPool(newPool, mountPoint);
        } catch (mountError) {
          console.warn(`Automount failed for pool ${name}: ${mountError.message}`);
        }
      } else {
        // Close devices if not automounting
        await strategy.cleanup(preparedDeviceInfos, poolConfig);
      }

      return {
        success: true,
        message: `Successfully created multi-device BTRFS pool "${name}" with ${raidLevel} configuration`,
        pool: newPool
      };
    } catch (error) {
      // Cleanup on error
      if (preparedDeviceInfos.length > 0) {
        try {
          await strategy.cleanup(preparedDeviceInfos, poolConfig);
        } catch (cleanupError) {
          console.warn(`Cleanup failed: ${cleanupError.message}`);
        }
      }
      throw new Error(`Error creating multi-device pool: ${error.message}`);
    }
  }

  /**
   * Check whether the bcachefs kernel module is available
   * The module ships via the mos-bcachefs plugin, so it may legitimately be missing
   * @returns {Promise<boolean>}
   * @private
   */
  async _isBcachefsAvailable() {
    try {
      await execPromise('modinfo bcachefs');
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Assert that bcachefs is usable, throwing a user facing error when it is not
   * @private
   */
  async _assertBcachefsAvailable() {
    if (!(await this._isBcachefsAvailable())) {
      throw new Error('bcachefs kernel module is not available. Install the bcachefs plugin first.');
    }
  }

  /**
   * Resolve all member device paths of a bcachefs pool, opening LUKS devices when encrypted
   * @param {Object} pool - Pool object
   * @param {Object} options - Options with optional passphrase
   * @returns {Promise<string[]>} Member device paths in slot order
   * @private
   */
  async _resolveBcachefsMembers(pool, options = {}) {
    await this._ensureDevicePaths(pool);

    const devices = [...(pool.data_devices || [])].sort((a, b) => a.slot - b.slot);

    if (!pool.config?.encrypted) {
      return devices.map(d => d.device);
    }

    const physicalDevices = devices.map(d => d.device);
    const slots = devices.map(d => parseInt(d.slot));
    const luksDevices = await this._openLuksDevicesWithSlots(
      physicalDevices,
      pool.name,
      slots,
      options.passphrase || null
    );
    pool._luksDevices = luksDevices;

    return luksDevices.map(d => d.mappedDevice);
  }

  /**
   * Resolve a device to the partition carrying an existing bcachefs member, for imports
   * A whole disk has no PARTUUID, so the member must be addressed through its partition
   * @param {string} device - Device path as passed by the user
   * @param {boolean} encrypted - Whether the member sits inside LUKS
   * @returns {Promise<string>} Partition (or device) path holding the member
   * @private
   */
  async _resolveExistingBcachefsMember(device, encrypted) {
    const info = await this.checkDeviceFilesystem(device);
    const expected = encrypted ? 'crypto_LUKS' : 'bcachefs';

    if (!info.isFormatted) {
      throw new Error(`Device ${device} is not formatted. Use format: true to create a new bcachefs pool.`);
    }
    if (info.filesystem !== expected) {
      throw new Error(`Device ${device} contains ${info.filesystem}, expected ${expected}. Use format: true to reformat it.`);
    }

    return info.actualDevice || device;
  }

  /**
   * Create a bcachefs pool from data devices and optional cache devices
   * bcachefs is a native multi-device filesystem: redundancy is a config property, not a
   * dedicated disk, so parity_devices stays empty and cache devices live in data_devices
   * @param {string} name - Pool name
   * @param {string[]} devices - Data device paths
   * @param {Object} options - Additional options (cache_devices, config, passphrase, format)
   */
  async createBcachefsPool(name, devices, options = {}) {
    const poolConfig = { name, config: options.config };
    const strategy = this._getDeviceStrategy(poolConfig);
    const cacheDevices = options.cache_devices || [];
    let preparedDeviceInfos = [];
    let reservedDisks = [];

    try {
      // Validate inputs
      if (!name) throw new Error('Pool name is required');
      await PoolHelpers.assertGlobalPoolNameAvailable(name);
      await this._assertBcachefsAvailable();

      if (!Array.isArray(devices) || devices.length === 0) {
        throw new Error('At least one data device is required for a bcachefs pool');
      }

      if (!Array.isArray(cacheDevices)) {
        throw new Error('cache_devices must be an array of device paths');
      }

      // Auto-generate passphrase if needed
      if (options.config?.encrypted) {
        if ((!options.passphrase || options.passphrase.trim() === '') && options.config?.create_keyfile) {
          options.passphrase = this._generateSecurePassphrase();
          console.log(`Generated secure passphrase for encrypted pool '${name}'`);
        }
        PoolHelpers.validateEncryptionOptions(options);
      }

      const pools = await this._readPools();

      // Check each device
      for (const device of [...devices, ...cacheDevices]) {
        PoolHelpers.validateDevicePath(device);

        await fs.access(device).catch(() => {
          throw new Error(`Device ${device} does not exist`);
        });

        const mountStatus = await this._isDeviceMounted(device);
        if (mountStatus.isMounted) {
          throw new Error(`Device ${device} is already mounted at ${mountStatus.mountPoint}`);
        }
      }

      reservedDisks = await this._reserveDisks([...devices, ...cacheDevices]);

      // Prepare physical devices (partitioning), data devices first so slots stay grouped
      const physicalDevices = [];
      for (const device of [...devices, ...cacheDevices]) {
        physicalDevices.push(options.format === true
          ? await this._ensurePartition(device)
          : await this._resolveExistingBcachefsMember(device, options.config?.encrypted));
      }

      const bcachefsConfig = BcachefsHelpers.buildConfig(options.config, cacheDevices.length > 0);

      // Prepare devices with Strategy Pattern (handles LUKS encryption automatically)
      preparedDeviceInfos = await strategy.prepareDevices(
        physicalDevices,
        poolConfig,
        { ...options, startSlot: 1 }
      );

      const deviceEntries = BcachefsHelpers.buildDeviceEntries(
        preparedDeviceInfos,
        devices.length,
        bcachefsConfig
      );
      BcachefsHelpers.validateConfig(bcachefsConfig, deviceEntries);

      // Format the whole filesystem in one go (bcachefs formats all members together)
      if (options.format === true) {
        const formatArgs = BcachefsHelpers.buildFormatArgs(name, deviceEntries, bcachefsConfig);
        await execPromise(`bcachefs ${formatArgs.join(' ')}`);
        await this._refreshDeviceSymlinks();
      } else {
        console.log(`Skipping formatting - importing existing bcachefs filesystem`);
      }

      // Collect device UUIDs - non-encrypted members share one filesystem UUID, so the
      // partition PARTUUID is used to keep every member individually resolvable
      const dataDevices = [];
      for (const entry of deviceEntries) {
        const uuid = options.config?.encrypted
          ? await strategy.getDeviceUuid(preparedDeviceInfos[entry.slot - 1], poolConfig)
          : await this._getDevicePartuuid(entry.physicalDevice);

        if (!uuid) {
          throw new Error(
            `Could not determine a unique identifier for device ${entry.physicalDevice}. ` +
            'bcachefs members need a partition, use format: true or partition the disk first.'
          );
        }

        dataDevices.push({
          slot: entry.slot,
          id: uuid,
          filesystem: 'bcachefs',
          group: entry.group,
          durability: entry.durability,
          spindown: null
        });
      }

      const mountPoint = path.join(this.mountBasePath, name);

      const newPool = {
        id: generateId(),
        name,
        type: 'bcachefs',
        automount: options.automount !== undefined ? options.automount : false,
        comment: options.comment || '',
        index: this._getNextPoolIndex(pools),
        data_devices: dataDevices,
        parity_devices: [],
        config: {
          unclean_check: true,
          usage_alert: { warning: 70, alert: 90 },
          ...(options.config || {}),
          encrypted: options.config?.encrypted || false,
          shared: options.config?.shared || false,
          // Last so the validated values win - mount and device add derive durability from these
          ...bcachefsConfig
        }
      };

      // Save pool
      pools.push(newPool);
      await this._writePools(pools);

      // Mount or close the LUKS devices again
      if (newPool.automount) {
        try {
          await this._createDirectoryWithOwnership(mountPoint, this.defaultOwnership);
          const source = BcachefsHelpers.buildMountSource(deviceEntries.map(e => e.path));
          await execPromise(`mount -t bcachefs ${source} ${mountPoint}`);

          if (newPool.config.shared === true) {
            await execPromise(`mount --make-shared "${mountPoint}"`).catch(() => {});
          }
        } catch (mountError) {
          console.warn(`Automount failed for pool ${name}: ${mountError.message}`);
        }
      } else {
        await strategy.cleanup(preparedDeviceInfos, poolConfig);
      }

      return {
        success: true,
        message: `Successfully created bcachefs pool "${name}" with ${devices.length} data device(s)` +
          (cacheDevices.length > 0 ? ` and ${cacheDevices.length} cache device(s)` : ''),
        pool: newPool
      };
    } catch (error) {
      // Cleanup on error
      if (preparedDeviceInfos.length > 0) {
        try {
          await strategy.cleanup(preparedDeviceInfos, poolConfig);
        } catch (cleanupError) {
          console.warn(`Cleanup failed: ${cleanupError.message}`);
        }
      }
      throw new Error(`Error creating bcachefs pool: ${error.message}`);
    } finally {
      PoolHelpers.releaseDisks(reservedDisks);
    }
  }

  /**
   * Add new device(s) to an existing BTRFS pool
   * @param {string} poolId - ID of the existing pool
   * @param {string[]} newDevices - Array of new device paths to add
   * @param {Object} options - Additional options
   */
  async addDevicesToPool(poolId, newDevices, options = {}) {
    try {
      if (!poolId) throw new Error('Pool ID is required');
      if (!Array.isArray(newDevices) || newDevices.length === 0) {
        throw new Error('At least one new device is required');
      }

      // Load pools data
      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.id === poolId);

      if (poolIndex === -1) {
        throw new Error(`Pool with ID ${poolId} not found`);
      }

      const pool = pools[poolIndex];

      // Handle different pool types
      if (pool.type === 'btrfs') {
        return await this._addDevicesToBTRFSPool(pool, newDevices, options, pools, poolIndex);
      } else if (pool.type === 'mergerfs') {
        return await this._addDevicesToMergerFSPool(pool, newDevices, options, pools, poolIndex);
      } else if (pool.type === 'bcachefs') {
        return await this._addDevicesToBcachefsPool(pool, newDevices, options, pools, poolIndex);
      } else {
        throw new Error(`Pool type '${pool.type}' does not support adding devices`);
      }

    } catch (error) {
      throw new Error(`Error adding devices to pool: ${error.message}`);
    }
  }

  /**
   * Add devices to a bcachefs pool
   * bcachefs integrates new members online, so there is no rebalance step to wait for
   * @param {Object} pool - Pool object
   * @param {string[]} newDevices - Device paths to add
   * @param {Object} options - Options, 'group' selects hdd (default) or ssd
   * @private
   */
  async _addDevicesToBcachefsPool(pool, newDevices, options, pools, poolIndex) {
    const mountPoint = path.join(this.mountBasePath, pool.name);

    await this._assertBcachefsAvailable();

    if (!await this._isMounted(mountPoint)) {
      throw new Error(`Pool "${pool.name}" must be mounted to add devices`);
    }

    // device add always writes a fresh member and an unpartitioned disk would join the
    // filesystem without a PARTUUID to record it by
    if (options.format !== true) {
      throw new Error('format: true is required when adding devices to bcachefs pools');
    }

    const group = options.group === BcachefsHelpers.CACHE_GROUP
      ? BcachefsHelpers.CACHE_GROUP
      : BcachefsHelpers.DATA_GROUP;

    const cacheMode = BcachefsHelpers.CACHE_MODES[pool.config?.cache_mode];
    const durability = group === BcachefsHelpers.CACHE_GROUP && cacheMode
      ? cacheMode.ssd_durability
      : 1;

    const strategy = this._getDeviceStrategy(pool);
    let nextSlot = Math.max(0, ...pool.data_devices.map(d => parseInt(d.slot))) + 1;
    const addedDevices = [];
    const preparedInfos = [];
    let reservedDisks = [];

    this._lockBcachefsDeviceOperation(pool, 'device addition');

    try {
      reservedDisks = await this._reserveDisks(newDevices);

      for (const device of newDevices) {
        PoolHelpers.validateDevicePath(device);

        await fs.access(device).catch(() => {
          throw new Error(`Device ${device} does not exist`);
        });

        const mountStatus = await this._isDeviceMounted(device);
        if (mountStatus.isMounted) {
          throw new Error(`Device ${device} is already mounted at ${mountStatus.mountPoint}`);
        }

        const physicalDevice = await this._ensurePartition(device);

        const prepared = await strategy.prepareDevices(
          [physicalDevice],
          pool,
          { ...options, config: pool.config, startSlot: nextSlot }
        );
        preparedInfos.push(prepared[0]);

        const operationalDevice = strategy.getOperationalDevicePath(prepared[0]);
        const label = BcachefsHelpers.deviceLabel(group, nextSlot);
        const rotational = group === BcachefsHelpers.DATA_GROUP ? ' --rotational' : '';

        await execPromise(
          `bcachefs device add --label=${label} --durability=${durability}${rotational} ${mountPoint} ${operationalDevice}`
        );

        const uuid = pool.config?.encrypted
          ? await strategy.getDeviceUuid(prepared[0], pool)
          : await this._getDevicePartuuid(physicalDevice);

        if (!uuid) {
          throw new Error(`Could not determine a unique identifier for device ${physicalDevice}`);
        }

        addedDevices.push({
          slot: nextSlot,
          id: uuid,
          filesystem: 'bcachefs',
          group,
          durability,
          spindown: null
        });

        nextSlot++;
      }

      pool.data_devices.push(...addedDevices);
      pools[poolIndex] = pool;
      await this._writePools(pools);

      return {
        success: true,
        message: `Successfully added ${addedDevices.length} device(s) to bcachefs pool "${pool.name}"`,
        pool
      };
    } catch (error) {
      // Close only the LUKS devices that never made it into the filesystem, then persist the
      // ones that did so pools.json stays in sync with the actual filesystem members
      const orphaned = preparedInfos.slice(addedDevices.length);
      if (orphaned.length > 0) {
        await strategy.cleanup(orphaned, pool).catch(() => {});
      }

      if (addedDevices.length > 0) {
        pool.data_devices.push(...addedDevices);
        pools[poolIndex] = pool;
        await this._writePools(pools).catch(() => {});
      }

      throw error;
    } finally {
      PoolsService._bcachefsDeviceOperations.delete(pool.id);
      PoolHelpers.releaseDisks(reservedDisks);
    }
  }

  /**
   * Add devices to a BTRFS pool
   */
  async _addDevicesToBTRFSPool(pool, newDevices, options, pools, poolIndex) {
    // Check if pool is mounted
    const mountPoint = path.join(this.mountBasePath, pool.name);
    const isMounted = await this._isMounted(mountPoint);
    if (!isMounted) {
      throw new Error(`Pool ${pool.name} must be mounted to add devices`);
    }

    await this._injectRealDevicePaths(pool);

    const memberDisks = await this._collectPoolMemberDisks(pool);

    // Validate every device before the first destructive step: luksFormat and mkfs cannot be
    // rolled back, so a device that fails a check must not have been touched at all
    for (const device of newDevices) {
      PoolHelpers.validateDevicePath(device);

      await fs.access(device).catch(() => {
        throw new Error(`Device ${device} does not exist`);
      });

      await this._assertDeviceNotInPool(pool, device, memberDisks);

      const mountStatus = await this._isDeviceMounted(device);
      if (mountStatus.isMounted) {
        throw new Error(`Device ${device} is already mounted at ${mountStatus.mountPoint}. Please unmount it first before adding to pool.`);
      }

      const deviceInfo = await this.checkDeviceFilesystem(device);
      if (options.format !== true) {
        if (!deviceInfo.isFormatted) {
          throw new Error(`Device ${device} is not formatted. Use format: true to confirm adding and formatting the device.`);
        }
        if (deviceInfo.filesystem !== 'btrfs') {
          throw new Error(`Device ${device} is already formatted with ${deviceInfo.filesystem}. BTRFS pools require unformatted devices or devices with BTRFS filesystem.`);
        }
      }
    }

    const strategy = this._getDeviceStrategy(pool);
    let preparedDeviceInfos = [];
    let newDataDevices = [];

    try {
      // Partition before encryption so members keep the layout the create path produces
      const physicalDevices = [];
      for (const device of newDevices) {
        if (options.format === true) {
          physicalDevices.push(await this._ensurePartition(device));
        } else {
          const deviceInfo = await this.checkDeviceFilesystem(device);
          physicalDevices.push(deviceInfo.actualDevice || device);
        }
      }

      const slots = this._findNextAvailableSlots(pool, physicalDevices.length);
      let actualDevicesToAdd = physicalDevices;

      if (pool.config?.encrypted) {
        console.log(`Setting up LUKS encryption for new devices in pool '${pool.name}'`);

        preparedDeviceInfos = await strategy.prepareDevices(
          physicalDevices,
          pool,
          { ...options, config: pool.config, slots, isParity: false }
        );

        actualDevicesToAdd = preparedDeviceInfos.map(d => strategy.getOperationalDevicePath(d));
        console.log(`LUKS devices opened for adding to pool: ${actualDevicesToAdd.join(', ')}`);
      }

      // Only force when the caller explicitly confirmed formatting
      const addFlags = options.format === true ? '-f ' : '';
      for (const device of actualDevicesToAdd) {
        await execPromise(`btrfs device add ${addFlags}${device} ${mountPoint}`);
      }

      for (let i = 0; i < physicalDevices.length; i++) {
        const deviceUuid = pool.config?.encrypted
          ? await strategy.getDeviceUuid(preparedDeviceInfos[i], pool)
          : await this.getDeviceUuid(actualDevicesToAdd[i]);

        if (!deviceUuid) {
          throw new Error(`No filesystem UUID found for device ${physicalDevices[i]}`);
        }

        newDataDevices.push({
          slot: slots[i],
          id: deviceUuid,
          filesystem: 'btrfs',
          spindown: null
        });
      }
    } catch (error) {
      if (preparedDeviceInfos.length > 0) {
        await strategy.cleanup(preparedDeviceInfos, pool).catch(cleanupError =>
          console.warn(`Warning: Could not cleanup LUKS devices: ${cleanupError.message}`)
        );
      }
      throw error;
    }

    // Add new devices to the pool's data_devices array
    pool.data_devices = [...pool.data_devices, ...newDataDevices];

    // Check if a single-device pool is being converted to a multi-device pool
    if (!pool.config.raid_level && pool.data_devices.length > 1) {
      // Set raid1 by default for more security
      pool.config.raid_level = 'raid1';

      // Execute the corresponding BTRFS balance command to apply the RAID level
      try {
        await execPromise(`btrfs balance start -dconvert=raid1 -mconvert=raid1 ${mountPoint}`);
      } catch (error) {
        // Log error, but continue - the pool can be rebalanced later
        console.warn(`Warning: Could not convert to RAID1: ${error.message}`);
      }
    }

    // Don't persist dynamic status info to pools.json
    // Status will be calculated dynamically when pools are retrieved

    // Write updated pool data (without status)
    pools[poolIndex] = pool;
    await this._writePools(pools);

    return {
      success: true,
      message: `Successfully added ${newDevices.length} device(s) to BTRFS pool ${pool.name}`,
      pool
    };
  }

  /**
   * Collect the resolved paths and base disks of all members of a pool
   * Members are stored as partitions while callers usually pass whole disks, so both forms
   * are collected to make containment checks reliable
   * @param {Object} pool - Pool with injected device paths
   * @returns {Promise<Set<string>>} Set of member paths and their base disks
   * @private
   */
  async _collectPoolMemberDisks(pool) {
    const disks = new Set();

    for (const member of [...(pool.data_devices || []), ...(pool.parity_devices || [])]) {
      if (!member.device) {
        continue;
      }

      const resolved = await this._realPathOrSelf(member.device);
      disks.add(resolved);
      disks.add(PoolHelpers.getBaseDiskFromPartition(resolved));
    }

    return disks;
  }

  /**
   * Collect the physical disks of a NonRAID pool for _assertDeviceNotInPool()
   * Every device carrying a member id counts: with a single data disk the parity is a bit for
   * bit copy, so the filesystem UUID shows up twice and a by-uuid symlink only points to one
   * @param {Object} pool - NonRAID pool from pools.json
   * @returns {Promise<Set<string>>} Set of member paths and their base disks
   * @private
   */
  async _collectNonRaidMemberDisks(pool) {
    const disks = new Set();
    const add = device => {
      disks.add(device);
      disks.add(PoolHelpers.getBaseDiskFromPartition(device));
    };

    // lsblk reads the udev database and does not wake disks from standby
    const ids = new Set(pool.data_devices.map(d => d.id));
    const { stdout } = await execPromise('lsblk -Ppno NAME,UUID,PARTUUID');
    for (const line of stdout.split('\n')) {
      const [, name, uuid, partuuid] = line.match(/^NAME="([^"]*)" UUID="([^"]*)" PARTUUID="([^"]*)"/) || [];
      if (name && !/^\/dev\/(nmd|mapper\/|dm-)/.test(name) && (ids.has(uuid) || ids.has(partuuid))) {
        add(name);
      }
    }

    for (const parity of pool.parity_devices || []) {
      add(await this._realPathOrSelf(`/dev/disk/by-id/${parity.id}`));
    }

    return disks;
  }

  /**
   * Reject a device that is already a member of the pool
   * @param {Object} pool - Pool object
   * @param {string} device - Candidate device
   * @param {Set<string>} memberDisks - Result of _collectPoolMemberDisks()
   * @private
   */
  async _assertDeviceNotInPool(pool, device, memberDisks) {
    const resolved = await this._realPathOrSelf(device);

    if (memberDisks.has(resolved) || memberDisks.has(PoolHelpers.getBaseDiskFromPartition(resolved))) {
      throw new Error(`Device ${device} is already part of pool ${pool.name}`);
    }
  }

  /**
   * Reject duplicate devices and devices that are mounted or already part of any pool
   * @param {string[]} devices - Candidate devices
   * @private
   */
  async _assertDevicesUnused(devices) {
    const resolved = await Promise.all(devices.map(d => this._realPathOrSelf(d)));
    const duplicates = resolved.filter((d, i) => resolved.indexOf(d) !== i);
    if (duplicates.length > 0) {
      throw new Error(`Device(s) ${[...new Set(duplicates)].join(', ')} specified more than once`);
    }

    const preparing = resolved.find(d => PoolHelpers.isDiskPreparing(d));
    if (preparing) {
      throw new Error(`Device ${preparing} is currently being prepared for a pool`);
    }

    const pools = await this.disksService._loadPoolsWithResolvedPaths();
    const mounts = await this.disksService._getMountInfo();
    for (const device of devices) {
      const usage = await this.disksService._isDiskInUse(device, pools, mounts);
      if (usage.inUse) {
        const where = usage.poolName ? `pool ${usage.poolName}` : `mounted at ${usage.mountpoint}`;
        throw new Error(`Device ${device} is already in use (${where}). Please free it first.`);
      }
    }
  }

  /**
   * Hide devices from the unassigned disks until the pool operation is done
   * @param {string[]} devices - Device paths as passed by the caller
   * @returns {Promise<string[]>} Keys for PoolHelpers.releaseDisks()
   * @private
   */
  async _reserveDisks(devices) {
    const resolved = await Promise.all(devices.map(d => this._realPathOrSelf(d)));
    return PoolHelpers.reserveDisks(resolved);
  }

  /**
   * Assign a batch of free slots without producing duplicates
   * Gaps left by removed devices are filled one at a time, so a naive startSlot + index
   * would hand out a slot that is still in use
   * @param {Object} pool - Pool object
   * @param {number} count - Number of slots needed
   * @returns {number[]} Free slot numbers
   * @private
   */
  _findNextAvailableSlots(pool, count) {
    const taken = (pool.data_devices || []).map(d => parseInt(d.slot));
    const slots = [];

    for (let i = 0; i < count; i++) {
      const slot = this._findNextAvailableSlot({
        data_devices: [...taken, ...slots].map(s => ({ slot: s }))
      });
      slots.push(slot);
    }

    return slots;
  }

  /**
   * Find the next available slot number for a pool
   * @private
   */
  _findNextAvailableSlot(pool) {
    const existingSlots = pool.data_devices.map(d => parseInt(d.slot)).sort((a, b) => a - b);

    // Find first gap in sequence
    for (let i = 1; i <= existingSlots.length + 1; i++) {
      if (!existingSlots.includes(i)) {
        return i;
      }
    }

    // Fallback: next number after highest slot
    return existingSlots.length > 0 ? Math.max(...existingSlots) + 1 : 1;
  }

  /**
   * Add devices to a MergerFS pool
   */
  async _addDevicesToMergerFSPool(pool, newDevices, options, pools, poolIndex) {
    const mountPoint = path.join(this.mountBasePath, pool.name);
    const mergerfsBasePath = path.join(this.mergerfsBasePath, pool.name);
    let luksDevices = null;

    // Check if pool was mounted before we start (to decide whether to remount at the end)
    // Also respect explicit remount option (used by replace operations)
    const currentlyMounted = await this._isMounted(mountPoint);
    const shouldRemount = options.remount !== undefined ? options.remount : currentlyMounted;

    try {
      // Determine filesystem from existing devices
      const existingFilesystem = pool.data_devices.length > 0 ? pool.data_devices[0].filesystem : 'xfs';

      await this._injectRealDevicePaths(pool);

      // Validate before the first destructive step: _ensurePartition wipes the disk and
      // luksFormat replaces its header, neither of which can be undone
      const memberDisks = await this._collectPoolMemberDisks(pool);
      for (const device of newDevices) {
        PoolHelpers.validateDevicePath(device);

        await fs.access(device).catch(() => {
          throw new Error(`Device ${device} does not exist`);
        });

        await this._assertDeviceNotInPool(pool, device, memberDisks);

        const mountStatus = await this._isDeviceMounted(device);
        if (mountStatus.isMounted) {
          throw new Error(`Device ${device} is already mounted at ${mountStatus.mountPoint}. Please unmount it first before adding to pool.`);
        }

        if (options.format !== true) {
          const deviceInfo = await this.checkDeviceFilesystem(device);
          if (!deviceInfo.isFormatted) {
            throw new Error(`Device ${device} is not formatted. Use format: true to format the device with ${existingFilesystem}.`);
          }
        }
      }

      // Check data device sizes against parity devices BEFORE doing anything (SnapRAID requirement)
      // For encrypted pools, we need to compare the PHYSICAL device sizes, not mapper sizes
      if (pool.parity_devices && pool.parity_devices.length > 0) {

        // Get size of smallest parity device (physical device for encrypted pools)
        let smallestParitySize = Infinity;
        for (const parityDevice of pool.parity_devices) {
          try {
            let deviceToCheck = parityDevice.device;

            // For encrypted pools, resolve mapper to physical device
            if (pool.config?.encrypted && deviceToCheck.startsWith('/dev/mapper/')) {
              try {
                const physicalDevice = await this._getPhysicalDeviceFromMapper(deviceToCheck);
                if (physicalDevice) {
                  deviceToCheck = physicalDevice;
                } else {
                }
              } catch (error) {
                console.warn(`Could not resolve physical device for parity mapper ${parityDevice.device}: ${error.message}`);
              }
            }

            const { stdout } = await execPromise(`blockdev --getsize64 ${deviceToCheck}`);
            const paritySize = parseInt(stdout.trim());
            const paritySizeGB = (paritySize / 1024 / 1024 / 1024).toFixed(2);

            if (paritySize < smallestParitySize) {
              smallestParitySize = paritySize;
            }
          } catch (error) {
            console.warn(`Warning: Could not get size of parity device ${parityDevice.device}: ${error.message}`);
          }
        }

        // Check each new data device size (physical device for encrypted pools)
        if (smallestParitySize !== Infinity) {
          const smallestParitySizeGB = (smallestParitySize / 1024 / 1024 / 1024).toFixed(2);

          for (let i = 0; i < newDevices.length; i++) {
            const deviceToCheck = newDevices[i];
            try {
              const { stdout } = await execPromise(`blockdev --getsize64 ${deviceToCheck}`);
              const dataDeviceSize = parseInt(stdout.trim());
              const dataSizeGB = (dataDeviceSize / 1024 / 1024 / 1024).toFixed(2);

              // Allow data device to be equal or smaller (not strictly larger)
              // Minor size differences (< 100MB) between same-model disks are acceptable
              const sizeDifference = dataDeviceSize - smallestParitySize;
              const acceptableThreshold = 100 * 1024 * 1024; // 100 MB tolerance

              if (sizeDifference > acceptableThreshold) {
                const paritySizeGB = (smallestParitySize / 1024 / 1024 / 1024).toFixed(2);
                throw new Error(
                  `Data device ${deviceToCheck} (${dataSizeGB} GB) is larger than the smallest parity device (${paritySizeGB} GB). ` +
                  `SnapRAID requires all data devices to be smaller or equal to the smallest parity device.`
                );
              }
            } catch (error) {
              if (error.message.includes('SnapRAID requires')) {
                throw error;
              }
              console.warn(`Warning: Could not verify size of data device ${deviceToCheck}: ${error.message}`);
            }
          }
        }
      }

      // Prepare physical devices - partition BEFORE encryption if format=true
      let physicalDevicesToEncrypt = newDevices;
      if (pool.config?.encrypted && options.format === true) {
        // For encrypted pools with format=true: partition first (consistent with pool creation)
        physicalDevicesToEncrypt = [];
        for (const device of newDevices) {
          const partitionedDevice = await this._ensurePartition(device);
          physicalDevicesToEncrypt.push(partitionedDevice);
        }
      }

      // Handle LUKS encryption for new devices if pool is encrypted
      let actualDevicesToAdd = physicalDevicesToEncrypt;
      let preparedDeviceInfos = [];

      if (pool.config?.encrypted) {
        console.log(`Setting up LUKS encryption for new devices in MergerFS pool '${pool.name}'`);

        // Use Strategy Pattern to handle encryption with proper slot numbers
        const strategy = this._getDeviceStrategy(pool);

        const slots = options.preserveSlot
          ? [parseInt(options.preserveSlot), ...this._findNextAvailableSlots(pool, physicalDevicesToEncrypt.length - 1)]
          : this._findNextAvailableSlots(pool, physicalDevicesToEncrypt.length);

        preparedDeviceInfos = await strategy.prepareDevices(
          physicalDevicesToEncrypt,
          pool,
          { ...options, config: pool.config, slots, isParity: false }
        );

        // Extract operational devices (mapped LUKS devices)
        actualDevicesToAdd = preparedDeviceInfos.map(d => d.operationalDevice);
        luksDevices = preparedDeviceInfos; // Store for cleanup

        console.log(`LUKS devices opened for adding to MergerFS pool: ${actualDevicesToAdd.join(', ')}`);
      }

    // Check and format new devices if needed
    const formattedDevices = [];
    for (let i = 0; i < newDevices.length; i++) {
      const originalDevice = newDevices[i];
      const deviceToCheck = actualDevicesToAdd[i];

      // Check if device exists
      await fs.access(deviceToCheck).catch(() => {
        throw new Error(`Device ${deviceToCheck} does not exist`);
      });

      // Check if device is already mounted
      const mountStatus = await this._isDeviceMounted(deviceToCheck);
      if (mountStatus.isMounted) {
        throw new Error(`Device ${deviceToCheck} is already mounted at ${mountStatus.mountPoint}. Please unmount it first before adding to pool.`);
      }

      // Check/format device
      const deviceInfo = await this.checkDeviceFilesystem(deviceToCheck);
      const actualDeviceToUse = deviceInfo.actualDevice || deviceToCheck;
      const isUsingPartition = deviceInfo.actualDevice && deviceInfo.actualDevice !== deviceToCheck;

      let actualDevice = deviceToCheck;
      if (!deviceInfo.isFormatted && options.format !== true) {
        // Device is not formatted - require explicit format option
        throw new Error(`Device ${deviceToCheck} is not formatted. Use format: true to format the device with ${existingFilesystem}.`);
      } else if (options.format === true || !deviceInfo.isFormatted) {
        // Explicit format requested - reformat the device
        const formatResult = await this.formatDevice(deviceToCheck, existingFilesystem);
        actualDevice = formatResult.device; // Use the partition created by formatDevice

        // For encrypted pools, get UUID from physical device using Strategy
        let uuid;
        if (pool.config?.encrypted && preparedDeviceInfos[i]) {
          const strategy = this._getDeviceStrategy(pool);
          uuid = await strategy.getDeviceUuid(preparedDeviceInfos[i], pool);
        } else {
          uuid = await this.getDeviceUuid(actualDevice);
        }

        formattedDevices.push({
          originalDevice,
          device: actualDevice,
          filesystem: existingFilesystem,
          uuid,
          isUsingPartition: actualDevice !== deviceToCheck
        });
      } else if (deviceInfo.filesystem !== existingFilesystem) {
        const deviceDisplayName = isUsingPartition ? `${deviceToCheck} (partition ${actualDeviceToUse})` : deviceToCheck;
        throw new Error(`Device ${deviceDisplayName} has filesystem ${deviceInfo.filesystem}, expected ${existingFilesystem}. Use format: true to reformat.`);
      } else {
        // Always get UUID from the actual device being used to ensure we have the correct one
        let uuid = await this.getDeviceUuid(actualDeviceToUse);
        if (!uuid) {
          // Fallback: try to get UUID from deviceInfo if getDeviceUuid failed
          uuid = deviceInfo.uuid;
        }
        if (!uuid) {
          throw new Error(`No filesystem UUID found for device ${actualDeviceToUse}. Device may not be properly formatted.`);
        }

        // Get UUID - for encrypted pools use Strategy
        let finalUuid;
        if (pool.config?.encrypted && preparedDeviceInfos[i]) {
          const strategy = this._getDeviceStrategy(pool);
          finalUuid = await strategy.getDeviceUuid(preparedDeviceInfos[i], pool);
        } else {
          finalUuid = uuid;
        }

        formattedDevices.push({
          originalDevice,
          device: actualDeviceToUse,
          filesystem: deviceInfo.filesystem,
          uuid: finalUuid,
          isUsingPartition
        });
      }
    }

    // Mount and add new devices to MergerFS
    const newDataDevices = [];
    for (let i = 0; i < formattedDevices.length; i++) {
      const { device, filesystem, uuid, isUsingPartition } = formattedDevices[i];

      // Use preserveSlot if provided (for replace operations),
      // or use slot from preparedDeviceInfos (for encrypted add operations),
      // otherwise find next available
      let diskIndex;
      if (options.preserveSlot && i === 0) {
        // For replace: use the preserved slot number
        diskIndex = parseInt(options.preserveSlot);
      } else if (pool.config?.encrypted && preparedDeviceInfos.length > 0 && preparedDeviceInfos[i]) {
        // For encrypted add: use slot from preparedDeviceInfos
        diskIndex = preparedDeviceInfos[i].slot;
      } else {
        // For normal add: find next available slot (fills gaps from removed devices)
        diskIndex = this._findNextAvailableSlot(pool);
      }
      const diskMountPoint = path.join(mergerfsBasePath, `disk${diskIndex}`);



      // Create mount point with proper ownership and mount device
      const ownershipOptions = {
        uid: this.defaultOwnership.uid,
        gid: this.defaultOwnership.gid
      };
      await this._createDirectoryWithOwnership(diskMountPoint, ownershipOptions);
      await this.mountDevice(device, diskMountPoint); // Mount the actual device (partition)

      // Ensure we get the correct UUID from the actual device being used
      let finalUuid = uuid;
      if (!finalUuid) {
        finalUuid = await this.getDeviceUuid(device);
      }

      const newDevice = {
        slot: diskIndex,
        id: finalUuid, // UUID of the actual partition/device being used
        filesystem,
        spindown: null
      };

      newDataDevices.push(newDevice);
      // Add immediately so next iteration finds next free slot
      pool.data_devices.push(newDevice);
    }

    // Remount MergerFS with all devices (use actual slot numbers)
    const allMountPoints = pool.data_devices.map(device =>
      path.join(mergerfsBasePath, `disk${device.slot}`)
    ).join(':');

    // Unmount current MergerFS
    try {
      await execPromise(`umount ${mountPoint}`);
    } catch (error) {
      // Pool might not be mounted, continue
    }

    // Only remount if pool was mounted before adding devices (or explicit remount requested)
    if (shouldRemount) {
      // Ensure mount point exists before remounting
      const ownershipOptions = {
        uid: this.defaultOwnership.uid,
        gid: this.defaultOwnership.gid
      };
      await this._createDirectoryWithOwnership(mountPoint, ownershipOptions);

      // Remount with all devices
      const mergerfsOptions = this._buildMergerfsOptions(pool.config);
      await execPromise(`mergerfs -o ${mergerfsOptions} ${allMountPoints} ${mountPoint}`);

      // Make the mount point a shared mount if configured (for bind mount propagation)
      if (pool.config?.shared === true) {
        try {
          await execPromise(`mount --make-shared "${mountPoint}"`);
          console.log(`Made pool mount point shared: ${mountPoint}`);
        } catch (sharedError) {
          console.warn(`Warning: Could not make mount shared: ${sharedError.message}`);
        }
      }
    } else {
      // Pool should stay unmounted - cleanup the new disk mounts we just created
      console.log(`Pool was not mounted, cleaning up new disk mounts...`);
      for (const newDevice of newDataDevices) {
        const diskMountPoint = path.join(mergerfsBasePath, `disk${newDevice.slot}`);
        try {
          await execPromise(`umount ${diskMountPoint}`);
          console.log(`Unmounted ${diskMountPoint}`);
        } catch (error) {
          console.warn(`Warning: Could not unmount ${diskMountPoint}: ${error.message}`);
        }
      }

      // Close LUKS devices if pool is encrypted
      if (pool.config?.encrypted && luksDevices && luksDevices.length > 0) {
        console.log(`Closing LUKS devices for unmounted pool...`);
        try {
          const strategy = this._getDeviceStrategy(pool);
          await strategy.cleanup(luksDevices, pool);
        } catch (cleanupError) {
          console.warn(`Warning: Could not cleanup LUKS devices: ${cleanupError.message}`);
        }
      }
    }

    // Update SnapRAID config if applicable
    if (pool.parity_devices.length > 0) {
      await this.updateSnapRAIDConfig(pool);
    }

    // Don't persist dynamic status info to pools.json
    // Status will be calculated dynamically when pools are retrieved

      // Write updated pool data (without status)
      pools[poolIndex] = pool;
      await this._writePools(pools);

      return {
        success: true,
        message: `Successfully added ${newDevices.length} device(s) to MergerFS pool ${pool.name}`,
        pool
      };
    } catch (error) {
      // Cleanup: Close LUKS devices if they were opened
      if (pool.config?.encrypted && luksDevices && luksDevices.length > 0) {
        console.error(`Error adding devices to MergerFS pool: ${error.message}`);
        console.log(`Cleaning up ${luksDevices.length} opened LUKS device(s)...`);
        try {
          const strategy = this._getDeviceStrategy(pool);
          await strategy.cleanup(luksDevices, pool);
        } catch (cleanupError) {
          console.warn(`Warning: Could not cleanup LUKS devices: ${cleanupError.message}`);
        }
      }
      throw error;
    }
  }

  /**
   * Change the RAID level of an existing BTRFS pool
   * @param {string} poolId - ID of the existing pool
   * @param {string} newRaidLevel - New RAID level to convert to
   * @param {Object} options - Additional options
   */
  async changePoolRaidLevel(poolId, newRaidLevel, options = {}) {
    try {
      if (!poolId) throw new Error('Pool ID is required');

      // Validate new raid level
      const validRaidLevels = ['raid0', 'raid1', 'raid10', 'single'];
      if (!validRaidLevels.includes(newRaidLevel)) {
        throw new Error(`Unsupported RAID level: ${newRaidLevel}. Supported: ${validRaidLevels.join(', ')}`);
      }

      // Load pools data
      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.id === poolId);

      if (poolIndex === -1) {
        throw new Error(`Pool with ID ${poolId} not found`);
      }

      const pool = pools[poolIndex];

      // Verify that this is a BTRFS pool
      if (pool.type !== 'btrfs') {
        throw new Error('Only BTRFS pools can have their RAID level changed');
      }

      // Check if current and new RAID levels are the same
      if (pool.raid_level === newRaidLevel || pool.config.raid_level === newRaidLevel) {
        return {
          success: true,
          message: `Pool ${pool.name} is already using ${newRaidLevel}`,
          pool
        };
      }

      // Check if pool is mounted
      const mountPoint = path.join(this.mountBasePath, pool.name);
      const isMounted = await this._isMounted(mountPoint);
      if (!isMounted) {
        throw new Error(`Pool ${pool.name} must be mounted to change RAID level`);
      }

      // Verify minimum device requirements for RAID levels
      const deviceCount = pool.data_devices.length;
      if ((newRaidLevel === 'raid0' || newRaidLevel === 'raid1') && deviceCount < 2) {
        throw new Error(`At least 2 devices are required for ${newRaidLevel}`);
      }
      if (newRaidLevel === 'raid10' && deviceCount < 4) {
        throw new Error(`At least 4 devices are required for ${newRaidLevel}`);
      }

      // Special checks for specific RAID level conversions
      if ((pool.raid_level === 'raid0' || pool.config.raid_level === 'raid0') && newRaidLevel === 'raid1') {
        // Check available storage space for converting from RAID 0 to RAID 1
        const spaceInfo = await this.getDeviceSpace(mountPoint);

        // For RAID 0 to RAID 1: Need at least 50% free space
        // because the data is converted from striped to mirrored data
        const freeSpacePercentage = (spaceInfo.freeSpace / spaceInfo.totalSpace) * 100;

        if (freeSpacePercentage < 50) {
          throw new Error(`Insufficient free space for converting from RAID 0 to RAID 1. ` +
                         `At least 50% free space is required, but only ${freeSpacePercentage.toFixed(1)}% is available.`);
        }

        // Add a note to the pool configuration
        if (!pool.config.notes) pool.config.notes = [];
        pool.config.notes.push({
          timestamp: Date.now(),
          message: `Starting conversion from RAID 0 (Striping) to RAID 1 (Mirroring). ` +
                   `This operation may take longer depending on the pool size and requires sufficient storage space.`
        });
      }

      // Change data and metadata RAID level
      await execPromise(`btrfs balance start -dconvert=${newRaidLevel} -mconvert=${newRaidLevel} ${mountPoint}`);

      // Update pool configuration
      pool.raid_level = newRaidLevel;
      pool.config = pool.config || {};
      pool.config.raid_level = newRaidLevel;

      // When we switch to 'single', adjust the pool structure accordingly
      if (newRaidLevel === 'single' && pool.data_devices.length > 1) {
        // Only the first device in the pool is used for data
        // We keep the other devices in the data structure, as they are still part of the BTRFS filesystem

        // Add a note to the pool configuration
        if (!pool.config.notes) pool.config.notes = [];
        pool.config.notes.push({
          timestamp: Date.now(),
          message: `Pool was converted to 'single' mode. Only the first device (${pool.data_devices[0].device}) is used for data.`
        });
      }

      // Write updated pool data
      await this._writePools(pools);

      return {
        success: true,
        message: `Successfully changed pool ${pool.name} to RAID level ${newRaidLevel}`,
        pool
      };
    } catch (error) {
      throw new Error(`Error changing RAID level: ${error.message}`);
    }
  }

  /**
   * Check if a device path is a partition
   */
  _isPartitionPath(device) {
    // Check for partition patterns:
    // /dev/sdb1, /dev/sdc2, etc. (SATA/SCSI)
    // /dev/nvme0n1p1, /dev/nvme0n1p2, etc. (NVMe)
    // /dev/bcache0p1, /dev/bcache0p2, etc. (bcache)
    // /dev/mapper/asdf_1 (LUKS mappers are treated as partitions - format directly, no partitioning)

    if (device.includes('/dev/mapper/')) {
      return true; // LUKS mappers are treated like partitions (formatted directly)
    }

    return /\/dev\/(sd[a-z]+\d+|nvme\d+n\d+p\d+|bcache\d+p\d+|nmd\d+p\d+|hd[a-z]+\d+|vd[a-z]+\d+)$/.test(device);
  }

  /**
   * Get the partition path for a device and partition number
   */
  _getPartitionPath(device, partitionNumber) {
    // Handle NVMe devices (e.g., /dev/nvme0n1 -> /dev/nvme0n1p1)
    // Handle bcache devices (e.g., /dev/bcache0 -> /dev/bcache0p1)
    // Handle LUKS mapped devices (e.g., /dev/mapper/luks_0 -> /dev/mapper/luks_0p1)
    if (device.includes('nvme') || device.includes('bcache') || device.includes('/dev/mapper/')) {
      return `${device}p${partitionNumber}`;
    }
    // Handle regular SATA/SCSI devices (e.g., /dev/sdb -> /dev/sdb1)
    return `${device}${partitionNumber}`;
  }

  /**
   * Check if device is a ZRAM device
   * @param {string} device - Device path
   * @returns {boolean}
   */
  _isZramDevice(device) {
    return /\/dev\/zram\d+/.test(device);
  }

  /**
   * Create a partition on a whole disk if needed
   * @param {string} device - Device path
   * @returns {Promise<string>} - Partition path or original device if already a partition/ZRAM
   */
  async _ensurePartition(device) {
    // ZRAM devices are formatted directly without partition
    if (this._isZramDevice(device)) {
      console.log(`${device} is a ZRAM device, using directly without partition`);
      return device;
    }

    // Check if device is a partition or a whole disk
    const isPartition = this._isPartitionPath(device);
    let targetDevice = device;

    if (!isPartition) {
      // This is a whole disk - create partition table and partition first
      console.log(`${device} is a whole disk, creating partition table and partition...`);

      // Wipe all existing filesystem signatures from the disk and all partitions
      // This ensures no old signatures (from e.g. sda1, sda2, sda3) remain
      try {
        await execPromise(`wipefs -a ${device}`);
        // Also wipe signatures from any existing partitions before destroying the table
        const existingPartitions = await this._getDevicePartitions(device);
        for (const part of existingPartitions) {
          try {
            await execPromise(`wipefs -a ${part}`);
          } catch (e) {
            // Partition may already be gone or inaccessible - that's fine
          }
        }
      } catch (e) {
        console.warn(`wipefs warning: ${e.message}`);
      }

      // Create GPT partition table
      await execPromise(`parted -s ${device} mklabel gpt`);

      // Create a single partition using the entire disk
      await execPromise(`parted -s ${device} mkpart primary 2048s 100%`);

      // Wait a moment for the partition to be recognized by the kernel
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Inform kernel about partition table changes
      try {
        await execPromise(`partprobe ${device}`);
      } catch (error) {
        // partprobe might fail on some systems, but that's usually not critical
        console.warn(`partprobe failed: ${error.message}`);
      }

      // Wait for udev to process the partition changes
      try {
        await execPromise('udevadm settle');
      } catch (error) {
        console.warn(`udevadm settle failed: ${error.message}`);
      }

      // Wait after udevadm settle (important for USB devices and slow controllers)
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Determine partition path
      targetDevice = this._getPartitionPath(device, 1);

      // Verify partition exists before returning (retry mechanism for slow devices)
      let partitionExists = false;
      for (let retry = 0; retry < 5; retry++) {
        try {
          await fs.access(targetDevice);
          partitionExists = true;
          break;
        } catch (error) {
          if (retry < 4) {
            // Wait before retry (exponential backoff)
            await new Promise(resolve => setTimeout(resolve, 500 * (retry + 1)));
          }
        }
      }

      if (!partitionExists) {
        throw new Error(`Partition ${targetDevice} was not created. This can happen with slow devices or controllers.`);
      }

      console.log(`Created partition: ${targetDevice}`);
    }

    return targetDevice;
  }

  /**
   * Format a device with the specified filesystem
   * Creates a partition first if device is a whole disk
   */
  async formatDevice(device, filesystem = 'xfs', options = {}) {
    // ZRAM devices are formatted by zram.service, not pools
    if (this._isZramDevice(device)) {
      throw new Error(`ZRAM device ${device} cannot be formatted via pools. Use /mos/zram to configure ZRAM devices.`);
    }

    console.log(`Formatting ${device} with ${filesystem}...`);

    try {
      // Ensure partition exists (create if whole disk)
      const targetDevice = await this._ensurePartition(device);

      // mkfs discards the whole device by default, md-nonraid parity must not see that
      const nodiscard = options.nodiscard === true;

      // Format the partition with the specified filesystem
      let command;

      switch (filesystem) {
        case 'ext4':
          command = `mkfs.ext4 -F${nodiscard ? ' -E nodiscard' : ''} ${targetDevice}`;
          break;
        case 'xfs':
          command = `mkfs.xfs -f${nodiscard ? ' -K' : ''} -n ftype=1 ${targetDevice}`;
          break;
        case 'btrfs':
          command = `mkfs.btrfs -f${nodiscard ? ' -K' : ''} ${targetDevice}`;
          break;
        default:
          throw new Error(`Unsupported filesystem type: ${filesystem}. Supported types are: ext4, xfs, btrfs`);
      }

      if (!command) {
        throw new Error(`Failed to determine format command for filesystem: ${filesystem}`);
      }

      await execPromise(command);

      // Get the UUID after formatting
      const { stdout } = await execPromise(`blkid -o export ${targetDevice}`);
      const uuid = stdout.match(/UUID="?([^"\n]+)"?/)?.[1] || null;

      return {
        success: true,
        message: `Device ${device} successfully formatted with ${filesystem}`,
        device: targetDevice,
        filesystem,
        uuid,
        alreadyFormatted: false
      };
    } catch (error) {
      throw new Error(`Error formatting device ${device}: ${error.message}`);
    }
  }

  /**
   * Mount a device
   * This method automatically detects if the filesystem is on a partition and mounts the correct device
   */
  async mountDevice(device, mountPoint, options = {}) {
    try {
      // Check if the device exists
      await fs.access(device);

      // Check if the device is formatted and get the actual device to mount
      let deviceInfo = await this.checkDeviceFilesystem(device);

      // Determine the actual device to mount (could be a partition)
      const actualDeviceToMount = deviceInfo.actualDevice || device;
      const isUsingPartition = deviceInfo.actualDevice && deviceInfo.actualDevice !== device;

      // Format if requested and not already formatted with the correct filesystem
      if (options.format && (!deviceInfo.isFormatted ||
          (options.filesystem && deviceInfo.filesystem !== options.filesystem))) {
        await this.formatDevice(actualDeviceToMount, options.filesystem || 'xfs');
        // Re-check the filesystem info after formatting
        deviceInfo = await this.checkDeviceFilesystem(device);
      } else if (!deviceInfo.isFormatted) {
        const deviceDisplayName = isUsingPartition ? `${device} (no filesystem found on device or partitions)` : device;
        throw new Error(`Device ${deviceDisplayName} is not formatted. Please format it first or use the format option.`);
      }

      // Create mount point if it doesn't exist with proper ownership
      try {
        await fs.access(mountPoint);
      } catch {
        const ownershipOptions = {
          uid: this.defaultOwnership.uid,
          gid: this.defaultOwnership.gid
        };
        await this._createDirectoryWithOwnership(mountPoint, ownershipOptions);
      }

      // Check if already mounted
      if (await this._isMounted(mountPoint)) {
        return {
          success: true,
          message: `Device ${device} is already mounted at ${mountPoint}`,
          requestedDevice: device,
          actualDevice: actualDeviceToMount,
          mountPoint,
          alreadyMounted: true,
          isUsingPartition
        };
      }

      // Check if the actual device is already mounted elsewhere
      const mountStatus = await this._isDeviceMounted(actualDeviceToMount);
      if (mountStatus.isMounted && mountStatus.mountPoint === mountPoint) {
        return {
          success: true,
          message: `Device ${device} is already mounted at ${mountPoint}`,
          requestedDevice: device,
          actualDevice: actualDeviceToMount,
          mountPoint,
          alreadyMounted: true,
          isUsingPartition
        };
      }
      if (mountStatus.isMounted) {
        throw new Error(`Device ${actualDeviceToMount} is already mounted at ${mountStatus.mountPoint}. Please unmount it first.`);
      }

      // Prepare mount options
      let mountOptions = '';
      if (options.mountOptions) {
        mountOptions = `-o ${options.mountOptions}`;
      }

      // Prefer mounting by UUID if available for better reliability
      let mountCommand;
      if (deviceInfo.uuid && options.preferUUID !== false) {
        mountCommand = `mount ${mountOptions} UUID=${deviceInfo.uuid} ${mountPoint}`;
      } else {
        mountCommand = `mount ${mountOptions} ${actualDeviceToMount} ${mountPoint}`;
      }

      // Mount the device
      await execPromise(mountCommand);

      // Set ownership of the mount point after mounting (if not already set)
      const uid = this.defaultOwnership.uid;
      const gid = this.defaultOwnership.gid;
      if (uid !== undefined && gid !== undefined) {
        try {
          const stats = await fs.stat(mountPoint);
          // Only set ownership if it's different from what we want
          if (stats.uid !== uid || stats.gid !== gid) {
            await this._setOwnership(mountPoint, uid, gid);
          }
        } catch (error) {
          // If stat fails, try to set ownership anyway
          await this._setOwnership(mountPoint, uid, gid);
        }
      }

      const successMessage = isUsingPartition
        ? `Device ${device} (partition ${actualDeviceToMount}) successfully mounted at ${mountPoint}`
        : `Device ${device} successfully mounted at ${mountPoint}`;

      return {
        success: true,
        message: successMessage,
        requestedDevice: device,
        actualDevice: actualDeviceToMount,
        mountPoint,
        filesystem: deviceInfo.filesystem,
        uuid: deviceInfo.uuid,
        alreadyMounted: false,
        isUsingPartition,
        mountedByUUID: deviceInfo.uuid && options.preferUUID !== false
      };
    } catch (error) {
      throw new Error(`Error mounting device ${device}: ${error.message}`);
    }
  }

  /**
   * Unmount a device
   */
  async unmountDevice(mountPoint, options = {}) {
    try {
      // Check if the path is mounted
      if (!(await this._isMounted(mountPoint))) {
        return {
          success: true,
          message: `Path ${mountPoint} is not mounted`,
          mountPoint,
          alreadyUnmounted: true
        };
      }

      let retries = options.retries || 3;
      let success = false;
      let lastError;

      // First try: standard unmount
      for (let attempt = 1; attempt <= 1; attempt++) {
        try {
          let unmountCommand = 'umount';
          if (options.force) {
            unmountCommand += ' -f';
          }
          await execPromise(`${unmountCommand} ${mountPoint}`);
          success = true;
          break;
        } catch (error) {
          lastError = error;
        }
      }

      // If standard unmount failed, try lazy unmount
      if (!success) {
        // Discrete check which processes are using the mount point
        try {
          await execPromise(`fuser -v ${mountPoint} 2>&1 || true`);
        } catch (error) {
          // Ignore if fuser is not available
        }

        // Second attempt: with lazy unmount (umount -l)
        for (let attempt = 1; attempt <= retries-1; attempt++) {
          try {
            await execPromise(`umount -l ${mountPoint}`);
            success = true;
            break;
          } catch (error) {
            lastError = error;
            // Wait before next attempt
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }
      }

      if (!success) {
        throw new Error(`Failed to unmount after ${retries} attempts: ${lastError.message}\nHinweis: Der Mount-Punkt wird noch von Prozessen verwendet. Versuche, alle Anwendungen zu schließen, die auf diesen Pool zugreifen.`);
      }

      // Remove directory if requested
      if (options.removeDirectory) {
        try {
          await fs.rmdir(mountPoint);
        } catch (error) {
          // Non-critical error, directory might not be empty - can be ignored
        }
      }

      return {
        success: true,
        message: `Successfully unmounted ${mountPoint}`,
        mountPoint,
        directoryRemoved: options.removeDirectory ? true : false,
        alreadyUnmounted: false
      };
    } catch (error) {
      throw new Error(`Error unmounting ${mountPoint}: ${error.message}`);
    }
  }

  /**
   * Get device space information
   * @param {string} mountPoint - Mount point path
   * @param {Object} user - User object with byte_format preference
   */
  async getDeviceSpace(mountPoint, user = null) {
    try {
      if (!(await this._isMounted(mountPoint))) {
        return {
          mounted: false,
          totalSpace: 0,
          usedSpace: 0,
          freeSpace: 0,
          usagePercent: 0
        };
      }

      // Use timeout to avoid hanging on unavailable remote mounts
      const { stdout } = await execPromise(`timeout 5 df -B1 ${mountPoint} | tail -1`);
      const parts = stdout.trim().split(/\s+/);

      if (parts.length >= 6) {
        const totalSpace = parseInt(parts[1], 10);
        const usedSpace = parseInt(parts[2], 10);
        const freeSpace = parseInt(parts[3], 10);

        return {
          mounted: true,
          totalSpace,
          totalSpace_human: this.formatBytes(totalSpace, user),
          usedSpace,
          usedSpace_human: this.formatBytes(usedSpace, user),
          freeSpace,
          freeSpace_human: this.formatBytes(freeSpace, user),
          usagePercent: Math.round((usedSpace / totalSpace) * 100),
          health: "healthy"
        };
      }

      throw new Error(`Unexpected df output format: ${stdout}`);
    } catch (error) {
      return {
        mounted: false,
        health: "unknown",
        totalSpace: 0,
        usedSpace: 0,
        freeSpace: 0,
        usagePercent: 0,
        error: error.message
      };
    }
  }

  /**
   * Create a single device pool
   * @param {string} name - Pool name
   * @param {string} device - Device path
   * @param {string} filesystem - Filesystem type (optional)
   * @param {Object} options - Additional options
   * @param {Object} options.config - Pool configuration
   * @param {boolean} options.config.encrypted - Enable LUKS encryption
   * @param {boolean} options.config.create_keyfile - Create keyfile for encrypted pool (default: false)
   * @param {string} options.passphrase - Passphrase for encryption (required if encrypted=true)
   */
  async createSingleDevicePool(name, device, filesystem = null, options = {}) {
    const poolConfig = { name, config: options.config };
    const strategy = this._getDeviceStrategy(poolConfig);
    let preparedDevices = [];

    try {
      // Validate inputs
      if (!name) throw new Error('Pool name is required');
      PoolHelpers.validatePoolName(name);
      if (!device) throw new Error('Device path is required');

      // Auto-generate passphrase if needed
      if (options.config?.encrypted) {
        if (!options.passphrase || options.passphrase.trim() === '') {
          if (options.config?.create_keyfile) {
            options.passphrase = this._generateSecurePassphrase();
            console.log(`Generated secure passphrase for encrypted pool '${name}'`);
          } else {
            throw new Error('Passphrase is required for encrypted pools');
          }
        }
        if (options.passphrase.length < 8) {
          throw new Error('Passphrase must be at least 8 characters long for LUKS encryption');
        }

        // ZRAM devices cannot be encrypted
        if (this._isZramDevice(device)) {
          throw new Error(`ZRAM device ${device} cannot be encrypted. ZRAM uses RAM compression and does not support LUKS.`);
        }
      }

      // Read current pools data
      const pools = await this._readPools();

      // Check if pool with the same name already exists
      if (pools.some(p => p.name === name)) {
        throw new Error(`Pool with name "${name}" already exists`);
      }

      // Check name does not collide with a MergerFS Path Pool (vpool)
      await PoolHelpers.assertNameNotInVpools(name);

      // Check if device is already mounted
      const mountStatus = await this._isDeviceMounted(device);
      if (mountStatus.isMounted) {
        throw new Error(`Device ${device} is already mounted at ${mountStatus.mountPoint}`);
      }

      // Determine the physical device to work with
      let physicalDevice;

      if (options.format === true) {
        // format=true: Use original device path so _ensurePartition can wipe
        // all existing partitions and create a fresh GPT + single partition
        physicalDevice = device;
      } else {
        // format=false (import mode): Resolve to existing partition if available
        const deviceInfo = await this.checkDeviceFilesystem(device);
        physicalDevice = deviceInfo.actualDevice || device;
      }

      // Prepare device with Strategy Pattern (handles encryption automatically)
      preparedDevices = await strategy.prepareDevices(
        [physicalDevice],
        poolConfig,
        { ...options, startSlot: 1 }
      );

      const deviceContext = preparedDevices[0];
      const operationalDevice = strategy.getOperationalDevicePath(deviceContext);
      const physicalPath = strategy.getPhysicalDevicePath(deviceContext);

      // Handle formatting
      let actualDeviceToUse = operationalDevice;
      let finalFilesystem = filesystem;

      if (options.format === true) {
        // Format the device (works for both plain and LUKS)
        finalFilesystem = finalFilesystem || 'xfs';
        const formatResult = await this.formatDevice(operationalDevice, finalFilesystem);
        await this._refreshDeviceSymlinks();
        actualDeviceToUse = formatResult.device;
      } else {
        // Import mode - check existing filesystem
        const fsInfo = await this.checkDeviceFilesystem(operationalDevice);
        if (!fsInfo.isFormatted) {
          throw new Error(`Device ${device} has no filesystem. Use format: true to format.`);
        }
        if (filesystem && filesystem !== fsInfo.filesystem) {
          throw new Error(`Device has filesystem ${fsInfo.filesystem}, but ${filesystem} was requested.`);
        }
        finalFilesystem = fsInfo.filesystem;
      }

      // Get UUID from the actual device being used (partition or LUKS mapper)
      // For format=true: formatDevice returns the UUID of the formatted partition
      // For format=false: get UUID from the operational device directly
      let deviceUuid;
      if (options.format === true) {
        // After formatting, get UUID from the actual formatted device (partition)
        deviceUuid = await this.getDeviceUuid(actualDeviceToUse);
      }
      if (!deviceUuid) {
        // Fallback: try Strategy (works for LUKS where UUID is on physical device)
        deviceUuid = await strategy.getDeviceUuid(deviceContext, poolConfig);
      }
      if (!deviceUuid) {
        throw new Error(`No filesystem UUID found for device ${device}`);
      }

      // Create mount point
      const mountPoint = path.join(this.mountBasePath, name);

      // Create pool object
      const poolId = generateId();
      const newPool = {
        id: poolId,
        name,
        // A single btrfs device stays a btrfs pool, it can be grown and supports scrub/balance
        type: finalFilesystem === 'btrfs' ? 'btrfs' : 'single',
        automount: options.automount !== undefined ? options.automount : false,
        comment: options.comment || "",
        index: this._getNextPoolIndex(pools),
        data_devices: [
          {
            slot: 1,
            id: deviceUuid,
            filesystem: finalFilesystem,
            spindown: options.spindown || null
          }
        ],
        parity_devices: [],
        config: {
          encrypted: options.config?.encrypted || false,
          shared: options.config?.shared || false,
          usage_alert: { warning: 70, alert: 90 },
          ...(options.config || {})
        }
      };

      // Save pool
      pools.push(newPool);
      await this._writePools(pools);

      // Mount if automount
      if (newPool.automount) {
        try {
          await this.mountDevice(actualDeviceToUse, mountPoint);
        } catch (mountError) {
          console.warn(`Automount failed: ${mountError.message}`);
        }
      } else {
        // Close devices if not automounting
        await strategy.cleanup(preparedDevices, poolConfig);
      }

      return {
        success: true,
        message: `Successfully created single device pool "${name}"`,
        pool: newPool,
        deviceInfo: {
          requestedDevice: device,
          actualDevice: actualDeviceToUse,
          encrypted: options.config?.encrypted || false
        }
      };
    } catch (error) {
      // Cleanup on error
      if (preparedDevices.length > 0) {
        try {
          await strategy.cleanup(preparedDevices, poolConfig);
        } catch (cleanupError) {
          console.warn(`Cleanup failed: ${cleanupError.message}`);
        }
      }
      throw new Error(`Error creating single device pool: ${error.message}`);
    }
  }

  /**
   * Mount a pool by ID
   * @param {string} poolId - Pool ID
   * @param {Object} options - Mount options
   * @param {string} options.passphrase - Passphrase for encrypted pools (if keyfile missing)
   */
  async mountPoolById(poolId, options = {}) {
    try {
      const pools = await this._readPools();
      const pool = pools.find(p => p.id === poolId);

      if (!pool) {
        throw new Error(`Pool with ID "${poolId}" not found`);
      }

      // Ensure device paths are available before mounting
      await this._ensureDevicePaths(pool);

      // Handle LUKS encryption before mounting
      if (pool.config?.encrypted) {
        console.log(`Opening LUKS devices for encrypted pool '${pool.name}'`);

        // Use the device path resolved from UUID
        const physicalDevice = pool.data_devices[0].device;
        const dataDeviceUuid = pool.data_devices[0].id;

        // Check if LUKS device is already mapped by looking for the UUID
        try {
          const mappedDevice = await execPromise(`find /dev/disk/by-uuid/ -name "${dataDeviceUuid}" -exec readlink -f {} \\;`);
          const devicePath = mappedDevice.stdout.trim();

          if (devicePath && devicePath.includes('/dev/mapper/')) {
            console.log(`LUKS device already mapped: ${devicePath}`);
            // Extract the mapper name from the path
            const mapperName = devicePath.replace('/dev/mapper/', '').replace('p1', '');
            pool._luksDevices = [{
              originalDevice: physicalDevice,
              mappedDevice: `/dev/mapper/${mapperName}`,
              uuid: dataDeviceUuid
            }];
          } else {
            throw new Error('Not mapped');
          }
        } catch (error) {
          // Device not mapped, need to open it
          console.log(`LUKS device not mapped, opening ${physicalDevice}...`);

          // Open the LUKS device using the physical device from pools.json with slot-based naming
          const deviceSlot = parseInt(pool.data_devices[0].slot);
          const luksDevices = await this._openLuksDevicesWithSlots([physicalDevice], pool.name, [deviceSlot], options.passphrase || null);
          pool._luksDevices = luksDevices;
        }
      }

      let result;

      // For single device pools
      if (pool.data_devices && pool.data_devices.length === 1 &&
          ['single', 'ext4', 'xfs', 'btrfs'].includes(pool.type)) {
        let device = pool.data_devices[0].device;
        const mountPoint = path.join(this.mountBasePath, pool.name);

        // For LUKS pools, use the mapped device directly (no partition)
        if (pool.config?.encrypted && pool._luksDevices) {
          device = pool._luksDevices[0].mappedDevice;
        }

        // Mount the device with format option
        const mountResult = await this.mountDevice(device, mountPoint, {
          format: options.format,
          filesystem: pool.data_devices[0].filesystem || pool.type,
          mountOptions: options.mountOptions
        });

        // Get space info after successful mount (for response only)
        const spaceInfo = await this.getDeviceSpace(mountPoint);

        result = {
          success: true,
          message: `Pool "${pool.name}" (ID: ${poolId}) mounted successfully`,
          pool: {
            id: pool.id,
            name: pool.name,
            status: spaceInfo
          }
        };
      }

      // For multi-device BTRFS pools
      else if (pool.type === 'btrfs' && pool.data_devices && pool.data_devices.length > 1) {
        result = await this._mountMultiDeviceBtrfsPool(pool, options);
      }

      // For MergerFS pools
      else if (pool.type === 'mergerfs') {
        result = await this._mountMergerFSPool(pool, options);
      }

      // For NonRAID pools
      else if (pool.type === 'nonraid') {
        result = await this._mountNonRaidPool(pool, options);
      }

      // For bcachefs pools
      else if (pool.type === 'bcachefs') {
        result = await this._mountBcachefsPool(pool, options);
      }

      else {
        throw new Error(`Mounting for pool type "${pool.type}" is not implemented yet`);
      }

      // Set ownership of mount point to mos:mos (non-recursive)
      const poolMountPoint = path.join(this.mountBasePath, pool.name);
      try {
        await execPromise(`chown mos:mos "${poolMountPoint}"`);
      } catch (chownError) {
        console.warn(`Warning: Could not chown mount point: ${chownError.message}`);
      }

      // Make the mount point a shared mount if configured (for bind mount propagation)
      if (pool.config?.shared === true) {
        try {
          await execPromise(`mount --make-shared "${poolMountPoint}"`);
          console.log(`Made pool mount point shared: ${poolMountPoint}`);
        } catch (sharedError) {
          console.warn(`Warning: Could not make mount shared: ${sharedError.message}`);
          // Don't fail the mount if --make-shared fails
        }
      }

      // Refresh device map so udev monitor knows about this pool's devices
      this._refreshUdevDeviceMap().catch(() => {});
      // Clear any previous offline alerts for devices in this pool (disk came back)
      PoolsService._udevAlertedDevices.clear();

      return result;
    } catch (error) {
      throw new Error(`Error mounting pool: ${error.message}`);
    }
  }

  /**
   * Check if the pool mount point is busy using findmnt
   * @param {string} poolName - Name of the pool to check
   * @returns {Promise<Object>} Busy check results
   */
  async _checkPoolBusy(poolName) {
    try {
      const poolMountPath = `/mnt/${poolName}`;
      const mountedPaths = [];

      // Check main pool mount path (/mnt/poolname)
      const { stdout: mainStdout } = await execPromise(`findmnt -R ${poolMountPath} -o TARGET,SOURCE -n 2>/dev/null || true`);

      if (mainStdout.trim()) {
        const lines = mainStdout.trim().split('\n');
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 1) {
            const target = parts[0];
            const source = parts[1] || 'unknown';

            // Skip the pool mount itself, only check subdirectories
            if (target !== poolMountPath) {
              mountedPaths.push({
                target,
                source,
                description: `Mounted filesystem at ${target}`
              });
            }
          }
        }
      }

      return {
        isBusy: mountedPaths.length > 0,
        mountedPaths,
        poolMountPath
      };

    } catch (error) {
      console.warn('Error checking pool busy status:', error.message);
      return {
        isBusy: false,
        mountedPaths: [],
        error: error.message
      };
    }
  }

  /**
   * Check if any services are using the pool and would be affected by unmounting
   * @param {string} poolName - Name of the pool to check
   * @returns {Promise<Object>} Service dependency check results
   */
  async _checkServiceDependencies(poolName) {
    try {
      // First check if pool is busy using findmnt (more reliable for /mnt paths)
      const busyCheck = await this._checkPoolBusy(poolName);

      if (busyCheck.isBusy) {
        return {
          hasDependencies: true,
          dependencies: busyCheck.mountedPaths.map(mount => ({
            service: 'System',
            type: 'mount',
            path: mount.target,
            description: `Active mount point (${mount.source})`
          })),
          poolMountPath: busyCheck.poolMountPath,
          busyReason: 'active_mounts'
        };
      }

      // Initialize MOS service if not already done
      if (!this.mosService) {
        this.mosService = require('./mos.service');
      }

      const poolMountPath = `/mnt/${poolName}`;
      const mergerfsBasePath = `/var/mergerfs/${poolName}`;
      const dependencies = [];

      /**
       * Helper function to check if a service path uses this pool
       * For /mnt paths: simple startsWith check
       * For /var/mergerfs paths: extract disk and verify it's mounted
       * @param {string} servicePath - The path to check
       * @returns {Promise<boolean>} True if the path is on this pool and accessible
       */
      const isPathOnPool = async (servicePath) => {
        if (!servicePath) return false;

        // Check regular pool mount (/mnt/poolname)
        if (servicePath.startsWith(poolMountPath)) {
          return true;
        }

        // Check MergerFS disk path (/var/mergerfs/poolname/diskN/...)
        if (servicePath.startsWith(mergerfsBasePath)) {
          // Extract the disk path: /var/mergerfs/poolname/diskN
          const relativePath = servicePath.substring(mergerfsBasePath.length);
          const pathParts = relativePath.split('/').filter(p => p);

          if (pathParts.length > 0) {
            const diskName = pathParts[0]; // e.g., 'disk1', 'disk2'
            const diskMountPath = `${mergerfsBasePath}/${diskName}`;

            // Check if this specific disk is mounted
            try {
              const isMounted = await this._isMounted(diskMountPath);
              return isMounted;
            } catch (error) {
              console.warn(`Could not check mount status for ${diskMountPath}:`, error.message);
              return false;
            }
          }
        }

        return false;
      };

      // Get all service statuses
      const serviceStatus = await this.mosService.getAllServiceStatus();

      // Check Docker dependencies
      if (serviceStatus.docker.enabled) {
        try {
          const dockerSettings = await this.mosService.getDockerSettings();

          // Check Docker system directory
          if (await isPathOnPool(dockerSettings.directory)) {
            dependencies.push({
              service: 'Docker',
              type: 'system',
              path: dockerSettings.directory,
              description: 'Docker system directory'
            });
          }

          // Check Docker appdata directory
          if (await isPathOnPool(dockerSettings.appdata)) {
            dependencies.push({
              service: 'Docker',
              type: 'appdata',
              path: dockerSettings.appdata,
              description: 'Docker application data directory'
            });
          }
        } catch (error) {
          console.warn('Could not check Docker settings:', error.message);
        }
      }

      // Check LXC dependencies
      if (serviceStatus.lxc.enabled) {
        try {
          const lxcSettings = await this.mosService.getLxcSettings();

          if (await isPathOnPool(lxcSettings.directory)) {
            dependencies.push({
              service: 'LXC',
              type: 'system',
              path: lxcSettings.directory,
              description: 'LXC container directory'
            });
          }
        } catch (error) {
          console.warn('Could not check LXC settings:', error.message);
        }
      }

      // Check VM dependencies
      if (serviceStatus.vm.enabled) {
        try {
          const vmSettings = await this.mosService.getVmSettings();

          // Check VM libvirt directory
          if (await isPathOnPool(vmSettings.directory)) {
            dependencies.push({
              service: 'VM',
              type: 'libvirt',
              path: vmSettings.directory,
              description: 'VM libvirt directory'
            });
          }

          // Check VM vdisk directory
          if (await isPathOnPool(vmSettings.vdisk_directory)) {
            dependencies.push({
              service: 'VM',
              type: 'vdisk',
              path: vmSettings.vdisk_directory,
              description: 'VM virtual disk directory'
            });
          }
        } catch (error) {
          console.warn('Could not check VM settings:', error.message);
        }
      }

      // Check active swap files on pool
      try {
        const { stdout } = await execPromise('swapon --show=NAME --noheadings 2>/dev/null || true');
        const swapFiles = stdout.trim().split('\n').filter(s => s);
        for (const swapFile of swapFiles) {
          if (await isPathOnPool(swapFile)) {
            dependencies.push({
              service: 'Swap',
              type: 'swapfile',
              path: swapFile,
              description: 'Active swap file'
            });
          }
        }
      } catch (error) {
        console.warn('Could not check swap files:', error.message);
      }

      return {
        hasDependencies: dependencies.length > 0,
        dependencies,
        poolMountPath
      };

    } catch (error) {
      console.warn('Error checking service dependencies:', error.message);
      return {
        hasDependencies: false,
        dependencies: [],
        error: error.message
      };
    }
  }

  /**
   * Unmount a pool by ID
   */
  async unmountPoolById(poolId, options = {}) {
    try {
      const pools = await this._readPools();
      const pool = pools.find(p => p.id === poolId);

      if (!pool) {
        throw new Error(`Pool with ID "${poolId}" not found`);
      }

      // Check for service dependencies unless force is used
      if (!options.force) {
        const dependencyCheck = await this._checkServiceDependencies(pool.name);

        if (dependencyCheck.hasDependencies) {
          const serviceList = dependencyCheck.dependencies.map(dep =>
            `${dep.service} (${dep.path})`
          ).join(', ');

          throw new Error(
            `Cannot unmount pool "${pool.name}": in use by ${serviceList}. Stop services first or use force=true.`
          );
        }
      }

      let result;

      // For single device pools
      if (pool.data_devices && pool.data_devices.length === 1 &&
          ['single', 'ext4', 'xfs', 'btrfs', 'vfat'].includes(pool.type)) {
        result = await this._unmountSingleDevicePool(pool, options.force);
      }

      // For multi-device BTRFS pools
      else if (pool.type === 'btrfs' && pool.data_devices && pool.data_devices.length > 1) {
        result = await this._unmountMultiDeviceBtrfsPool(pool, options.force);
      }

      // For MergerFS pools
      else if (pool.type === 'mergerfs') {
        result = await this._unmountMergerFSPool(pool, options.force);
      }

      // For NonRAID pools
      else if (pool.type === 'nonraid') {
        result = await this._unmountNonRaidPool(pool, options.force);
      }

      // For bcachefs pools
      else if (pool.type === 'bcachefs') {
        result = await this._unmountBcachefsPool(pool, options.force);
      }

      else {
        throw new Error(`Unmounting for pool type "${pool.type}" is not implemented yet`);
      }

      // Refresh device map (unmounted pool disks should no longer trigger alerts)
      this._refreshUdevDeviceMap().catch(() => {});

      return result;
    } catch (error) {
      throw new Error(`Error unmounting pool: ${error.message}`);
    }
  }

  /**
   * Remove a pool by ID
   */
  async removePoolById(poolId, options = {}) {
    try {
      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.id === poolId);

      if (poolIndex === -1) {
        throw new Error(`Pool with ID "${poolId}" not found`);
      }

      const pool = pools[poolIndex];

      // Check for service dependencies unless force is used
      if (!options.force) {
        const dependencyCheck = await this._checkServiceDependencies(pool.name);

        if (dependencyCheck.hasDependencies) {
          const serviceList = dependencyCheck.dependencies.map(dep =>
            `${dep.service} (${dep.path})`
          ).join(', ');

          throw new Error(
            `Cannot delete pool "${pool.name}": in use by ${serviceList}. Stop services first or use force=true.`
          );
        }
      }

      // Perform pool-type-specific unmounting
      await this._performCompletePoolUnmount(pool, options);

      // Only remove from pools array AFTER successful unmount
      const removedPool = pools.splice(poolIndex, 1)[0];
      await this._writePools(pools);

      // Clean up SnapRAID config if it was a MergerFS pool
      if (removedPool.type === 'mergerfs') {
        await this.cleanupSnapRAIDConfig(removedPool.name);
      }

      // Clean up NonRAID config if it was a NonRAID pool
      if (removedPool.type === 'nonraid') {
        await this.cleanupNonRAIDConfig();
      }

      return {
        success: true,
        message: `Pool "${removedPool.name}" (ID: ${poolId}) removed successfully`,
        pool: removedPool
      };
    } catch (error) {
      throw new Error(`Error removing pool: ${error.message}`);
    }
  }

  /**
   * Perform complete unmounting for different pool types
   * @private
   */
  async _performCompletePoolUnmount(pool, options = {}) {
    const { force = false } = options;

    if (pool.type === 'mergerfs') {
      await this._unmountMergerFSPool(pool, force);
    } else if (pool.type === 'nonraid') {
      await this._unmountNonRaidPool(pool, force);
    } else if (pool.type === 'bcachefs') {
      await this._unmountBcachefsPool(pool, force);
    } else if (pool.type === 'btrfs' && pool.data_devices && pool.data_devices.length > 1) {
      await this._unmountMultiDeviceBtrfsPool(pool, force);
    } else if (['single', 'btrfs', 'ext4', 'xfs', 'vfat'].includes(pool.type)) {
      await this._unmountSingleDevicePool(pool, force);
    } else {
      throw new Error(`Unsupported pool type for removal: ${pool.type}`);
    }
  }

  /**
   * Unmount a MergerFS pool completely
   * @private
   */
  async _unmountMergerFSPool(pool, force = false) {
    const mountPoint = path.join(this.mountBasePath, pool.name);
    const mergerfsBasePath = path.join(this.mergerfsBasePath, pool.name);

    // Ensure device paths are available
    await this._ensureDevicePaths(pool);

    const unmountErrors = [];

    // Step 1: Unmount main MergerFS mount point
    if (await this._isMounted(mountPoint)) {
      try {
        await this.unmountDevice(mountPoint, {
          force,
          removeDirectory: true
        });
      } catch (error) {
        unmountErrors.push(`Main mount point ${mountPoint}: ${error.message}`);
        if (!force) {
          throw new Error(`Failed to unmount main mount point: ${error.message}`);
        }
      }
    }

    // Step 2: Unmount all individual data device mount points
    for (const device of pool.data_devices) {
      const deviceMountPoint = path.join(mergerfsBasePath, `disk${device.slot}`);

      if (await this._isMounted(deviceMountPoint)) {
        try {
          await this.unmountDevice(deviceMountPoint, {
            force,
            removeDirectory: true
          });
        } catch (error) {
          unmountErrors.push(`Data device ${device.device} at ${deviceMountPoint}: ${error.message}`);
          if (!force) {
            throw new Error(`Failed to unmount data device ${device.device}: ${error.message}`);
          }
        }
      }
    }

    // Step 3: Unmount parity devices if they exist
    for (let i = 0; i < (pool.parity_devices || []).length; i++) {
      const parityDevice = pool.parity_devices[i];
      const snapraidPoolPath = path.join(this.snapraidBasePath, pool.name);
      const parityMountPoint = path.join(snapraidPoolPath, `parity${i + 1}`);

      if (await this._isMounted(parityMountPoint)) {
        try {
          await this.unmountDevice(parityMountPoint, {
            force,
            removeDirectory: true
          });
        } catch (error) {
          unmountErrors.push(`Parity device ${parityDevice.device} at ${parityMountPoint}: ${error.message}`);
          if (!force) {
            throw new Error(`Failed to unmount parity device ${parityDevice.device}: ${error.message}`);
          }
        }
      }
    }

    // Step 4: Close LUKS devices if pool is encrypted
    if (pool.config?.encrypted) {
      console.log(`Closing LUKS devices for encrypted MergerFS pool '${pool.name}' during removal`);

      // Extract physical device paths from data_devices and parity_devices
      const dataDevicesToClose = pool.data_devices.map(d => d.device);
      const parityDevicesToClose = pool.parity_devices.map(d => d.device);

      // Close data device LUKS mappers using slot numbers
      if (dataDevicesToClose.length > 0) {
        const dataSlots = pool.data_devices.map(d => parseInt(d.slot));
        await this._closeLuksDevicesWithSlots(dataDevicesToClose, pool.name, dataSlots);
      }

      // Close parity device LUKS mappers using slot numbers if they exist
      if (parityDevicesToClose.length > 0) {
        const paritySlots = pool.parity_devices.map(d => parseInt(d.slot));
        await this._closeLuksDevicesWithSlots(parityDevicesToClose, pool.name, paritySlots, true);
      }
    }

    // Step 5: Remove the mergerfs base directory
    try {
      const stats = await fs.stat(mergerfsBasePath);
      if (stats.isDirectory()) {
        // Check if directory is empty before removing
        const dirContents = await fs.readdir(mergerfsBasePath);
        if (dirContents.length === 0) {
          await fs.rmdir(mergerfsBasePath);
        } else if (force) {
          // Force removal of non-empty directory
          await execPromise(`rm -rf ${mergerfsBasePath}`);
        } else {
          unmountErrors.push(`MergerFS base directory ${mergerfsBasePath} is not empty`);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        unmountErrors.push(`Cleanup of base directory ${mergerfsBasePath}: ${error.message}`);
        if (!force) {
          throw new Error(`Failed to cleanup base directory: ${error.message}`);
        }
      }
    }

    // Step 5: Remove the snapraid base directory if it exists and has parity devices
    if (pool.parity_devices && pool.parity_devices.length > 0) {
      const snapraidPoolPath = path.join(this.snapraidBasePath, pool.name);
      try {
        const stats = await fs.stat(snapraidPoolPath);
        if (stats.isDirectory()) {
          // Check if directory is empty before removing
          const dirContents = await fs.readdir(snapraidPoolPath);
          if (dirContents.length === 0) {
            await fs.rmdir(snapraidPoolPath);
          } else if (force) {
            // Force removal of non-empty directory
            await execPromise(`rm -rf ${snapraidPoolPath}`);
          } else {
            unmountErrors.push(`SnapRAID base directory ${snapraidPoolPath} is not empty`);
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          unmountErrors.push(`Cleanup of SnapRAID directory ${snapraidPoolPath}: ${error.message}`);
          if (!force) {
            throw new Error(`Failed to cleanup SnapRAID directory: ${error.message}`);
          }
        }
      }
    }

    // Report warnings if force was used and errors occurred
    if (force && unmountErrors.length > 0) {
      console.warn(`Warning: Some unmount operations failed during forced removal:\n${unmountErrors.join('\n')}`);
    }
  }

  /**
   * Unmount a NonRAID pool completely
   * @param {Object} pool - Pool object
   * @param {boolean} force - Force unmount even if busy
   * @private
   */
  async _unmountNonRaidPool(pool, force = false) {
    const mountPoint = path.join(this.mountBasePath, pool.name);
    const nonraidBasePath = path.join(this.mergerfsBasePath, pool.name);
    const unmountErrors = [];

    try {
      // Check if pool is mounted at all
      const isMainMounted = await this._isMounted(mountPoint);

      // Check if module is loaded (indicates array is running)
      let moduleLoaded = false;
      try {
        const { stdout } = await execPromise('lsmod | grep -E "md.nonraid"');
        moduleLoaded = stdout.trim().length > 0;
      } catch (error) {
        // grep returns non-zero if no match
        moduleLoaded = false;
      }

      // If nothing is mounted and module not loaded, pool is already unmounted
      if (!isMainMounted && !moduleLoaded) {
        console.log(`NonRAID pool "${pool.name}" is already unmounted`);
        return {
          success: true,
          message: `NonRAID pool "${pool.name}" is already unmounted`,
          pool: {
            id: pool.id,
            name: pool.name,
            status: {
              mounted: false
            }
          }
        };
      }

      // Stopping the array would abort the clear of a new disk
      const nmdstat = await this._readNmdstat();
      if (!force && nmdstat?.mdResyncAction === 'clear' && await this._isNonRaidParityOperationRunning()) {
        throw new Error('A new disk is currently being cleared. Please cancel the clear first before unmounting the pool.');
      }

      // Step 1: Unmount main MergerFS mount point
      console.log(`Unmounting main NonRAID mount point: ${mountPoint}`);
      if (isMainMounted) {
        try {
          await this.unmountDevice(mountPoint, { force, removeDirectory: true });
        } catch (error) {
          unmountErrors.push(`Main mount point: ${error.message}`);
          if (!force) {
            throw new Error(`Failed to unmount main mount point: ${error.message}`);
          }
        }
      }

      // Step 2: Unmount individual data device mount points
      console.log('Unmounting individual data device mount points...');
      for (const device of pool.data_devices || []) {
        const deviceMountPoint = path.join(nonraidBasePath, `disk${device.slot}`);

        if (await this._isMounted(deviceMountPoint)) {
          try {
            await this.unmountDevice(deviceMountPoint, { force, removeDirectory: true });
            console.log(`Unmounted ${deviceMountPoint}`);
          } catch (error) {
            unmountErrors.push(`Device mount ${deviceMountPoint}: ${error.message}`);
            if (!force) {
              throw new Error(`Failed to unmount device mount point ${deviceMountPoint}: ${error.message}`);
            }
          }
        }
      }

      // Step 3: Close LUKS devices if pool is encrypted (only data devices).
      // The mappers are backed by /dev/nmd<slot>p1, so they have to go before the array stops
      if (pool.config?.encrypted) {
        try {
          console.log(`Closing LUKS devices for encrypted NonRAID pool '${pool.name}'`);

          const dataSlots = (pool.data_devices || []).map(d => parseInt(d.slot));
          const nmdDevices = dataSlots.map(slot => `/dev/nmd${slot}p1`);
          await this._closeLuksDevicesWithSlots(nmdDevices, pool.name, dataSlots);
        } catch (error) {
          unmountErrors.push(`Close LUKS devices: ${error.message}`);
          if (!force) {
            throw new Error(`Failed to close LUKS devices: ${error.message}`);
          }
        }
      }

      // Step 4: Stop the NonRAID array (only if module is loaded)
      let arrayStopped = false;

      if (moduleLoaded) {
        console.log('Stopping NonRAID array...');

        // Cancel any running checks first (ignore errors if no check is running)
        try {
          await execPromise('echo "nocheck CANCEL" > /proc/nmdcmd');
          console.log('Cancelled running check');
        } catch (error) {
          // Ignore error - no check was running
          console.log('No check running to cancel');
        }

        // Stop the array
        try {
          await execPromise('echo "stop" > /proc/nmdcmd');
          console.log('NonRAID array stopped');
          arrayStopped = true;
        } catch (error) {
          unmountErrors.push(`Stop pool: ${error.message}`);
          if (!force) {
            throw new Error(`Failed to stop NonRAID pool: ${error.message}`);
          }
        }
      } else {
        console.log('NonRAID module not loaded, skipping array stop');
      }

      // Step 5: Unload the md-nonraid module (ONLY if array was stopped successfully)
      if (arrayStopped) {
        console.log('Unloading md-nonraid kernel module...');
        try {
          await execPromise('modprobe -r md-nonraid');
          console.log('md-nonraid module unloaded');
        } catch (error) {
          unmountErrors.push(`Unload module: ${error.message}`);
          if (!force) {
            throw new Error(`Failed to unload md-nonraid module: ${error.message}`);
          }
        }
      } else {
        console.warn('Skipping module unload because array stop failed');
      }

      // Step 6: Remove the nonraid base directory
      try {
        const stats = await fs.stat(nonraidBasePath);
        if (stats.isDirectory()) {
          const dirContents = await fs.readdir(nonraidBasePath);
          if (dirContents.length === 0) {
            await fs.rmdir(nonraidBasePath);
          } else if (force) {
            await execPromise(`rm -rf ${nonraidBasePath}`);
          } else {
            unmountErrors.push(`NonRAID base directory ${nonraidBasePath} is not empty`);
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          unmountErrors.push(`Cleanup of base directory ${nonraidBasePath}: ${error.message}`);
          if (!force) {
            throw new Error(`Failed to cleanup base directory: ${error.message}`);
          }
        }
      }

      // Report warnings if force was used and errors occurred
      if (force && unmountErrors.length > 0) {
        console.warn(`Warning: Some unmount operations failed during forced removal:\n${unmountErrors.join('\n')}`);
      }
    } catch (error) {
      console.error(`Error unmounting NonRAID pool: ${error.message}`);
      throw error;
    }
  }

  /**
   * Unmount a single device pool (BTRFS, XFS, EXT4)
   * @private
   */
  async _unmountSingleDevicePool(pool, force = false) {
    const mountPoint = path.join(this.mountBasePath, pool.name);

    if (await this._isMounted(mountPoint)) {
      try {
        await this.unmountDevice(mountPoint, {
          force,
          removeDirectory: true
        });
      } catch (error) {
        throw new Error(`Failed to unmount pool: ${error.message}`);
      }
    }

    // Close LUKS devices if pool is encrypted
    if (pool.config?.encrypted) {
      console.log(`Closing LUKS devices for encrypted pool '${pool.name}' during unmount`);

      // For single device pools, we need to get the physical device first
      await this._ensureDevicePaths(pool);
      const physicalDevice = pool.data_devices[0].device;

      console.log(`Single device pool - closing LUKS slot 1 for pool '${pool.name}' with device ${physicalDevice}`);
      await this._closeLuksDevicesWithSlots([physicalDevice], pool.name, [1]);
    }
  }

  /**
   * Close LUKS devices for a pool using specific slot numbers
   * @param {string[]} devices - Array of original device paths
   * @param {string} poolName - Pool name
   * @param {number[]} slots - Array of slot numbers corresponding to devices
   * @param {boolean} isParity - Whether these are parity devices (uses different naming)
   * @private
   */
  async _closeLuksDevicesWithSlots(devices, poolName, slots, isParity = false) {
    for (let i = 0; i < devices.length; i++) {
      const slot = slots[i];

      // Construct LUKS mapper name based on whether it's a parity device
      const luksName = isParity ?
        `parity_${poolName}_${slot}` :
        `${poolName}_${slot}`;

      const partitionName = `${luksName}p1`;

      // Try to close partition first (e.g., pool_1p1)
      try {
        const { stdout: partitionInfo } = await execPromise(`dmsetup info ${partitionName} 2>/dev/null || true`);
        if (partitionInfo && partitionInfo.includes('State')) {
          await execPromise(`cryptsetup luksClose ${partitionName}`);
          console.log(`Closed LUKS partition: ${partitionName}`);
        }
      } catch (error) {
        // Try dmsetup as fallback for partition
        try {
          await execPromise(`dmsetup remove ${partitionName} 2>/dev/null`);
          console.log(`Force removed LUKS partition using dmsetup: ${partitionName}`);
        } catch (dmError) {
          // Partition might not exist, that's okay
        }
      }

      // Check if LUKS device is active before trying to close
      try {
        const { stdout } = await execPromise(`dmsetup info ${luksName} 2>/dev/null || true`);
        if (!stdout || !stdout.includes('State')) {
          console.log(`LUKS device ${luksName} is not active, skipping close`);
          continue;
        }
      } catch (error) {
        console.log(`LUKS device ${luksName} is not active, skipping close`);
        continue;
      }

      console.log(`Attempting to close LUKS device: ${luksName}...`);

      // Close the LUKS device
      try {
        await execPromise(`cryptsetup luksClose ${luksName}`);
        console.log(`Closed LUKS device: ${luksName}`);
      } catch (error) {
        console.warn(`Warning: Could not close LUKS device ${luksName}: ${error.message}`);
        // Try dmsetup as fallback
        try {
          await execPromise(`dmsetup remove ${luksName}`);
          console.log(`Force removed LUKS device using dmsetup: ${luksName}`);
        } catch (dmError) {
          console.warn(`Warning: Could not force remove LUKS device ${luksName}: ${dmError.message}`);
        }
      }
    }
  }

  /**
   * Get underlying physical device from mapper device (for LUKS)
   * @param {string} mapperDevice - Mapper device path (e.g. /dev/mapper/luks-xxx)
   * @returns {Promise<string|null>} Physical device path or null
   * @private
   */
  async _getPhysicalDeviceFromMapper(mapperDevice) {
    try {
      const mapperName = mapperDevice.replace('/dev/mapper/', '');
      const { stdout } = await execPromise(`cryptsetup status ${mapperName} 2>/dev/null || echo ""`);

      if (!stdout.trim()) {
        return null;
      }

      // Parse output for device line (e.g. "device: /dev/sda1")
      const deviceMatch = stdout.match(/device:\s+(.+)/);
      if (deviceMatch) {
        return deviceMatch[1].trim();
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Enrich device information with disk type details (without waking up disks)
   */
  async _enrichDeviceWithDiskTypeInfo(device) {
    try {
      // Lazy import to avoid circular dependency
      // Note: disks.service exports an instance
      const disksService = require('./disks.service');

      // Extract device path, handle both string and object inputs
      let devicePath;
      if (typeof device === 'string') {
        devicePath = device;
      } else if (device && typeof device.device === 'string') {
        devicePath = device.device;
      } else if (device && device.id) {
        // For BTRFS multi-device pools, device path might not be set yet, but we have UUID
        // Resolves to null for detached or unknown UUIDs
        devicePath = await this.getRealDevicePathFromUuid(device.id);
      }

      // Invalid device format or unresolvable UUID - nothing to enrich
      if (!devicePath) {
        return {
          ...device,
          diskType: {
            type: 'unknown',
            rotational: null,
            removable: null,
            usbInfo: null
          }
        };
      }

      // Check if this is a mapper device (LUKS encrypted)
      let physicalDevice = devicePath;
      if (devicePath.startsWith('/dev/mapper/')) {
        const underlying = await this._getPhysicalDeviceFromMapper(devicePath);
        if (underlying) {
          physicalDevice = underlying;
        }
      }

      // Check if this is a ZRAM device
      if (this._isZramDevice(physicalDevice)) {
        return {
          ...device,
          diskType: {
            type: 'ramdisk',
            rotational: false,
            removable: false,
            usbInfo: null,
            isZram: true
          }
        };
      }

      // Convert partition to base disk (e.g. /dev/sdj1 -> /dev/sdj)
      const baseDisk = this._getBaseDiskFromPartition(physicalDevice);

      // Only static information is collected - NO hdparm or other disk access!
      const diskTypeInfo = await disksService._getEnhancedDiskTypeForPools(baseDisk);

      return {
        ...device,
        diskType: {
          type: diskTypeInfo.type,
          rotational: diskTypeInfo.rotational,
          removable: diskTypeInfo.removable,
          usbInfo: diskTypeInfo.usbInfo
        }
      };
    } catch (error) {
      // On errors return original device information
      const devicePathForLog = (typeof device === 'string') ? device : (device?.device || 'unknown');
      console.warn(`Warning: Could not enrich device ${devicePathForLog} with disk type info: ${error.message}`);
      return {
        ...device,
        diskType: {
          type: 'unknown',
          rotational: null,
          removable: null,
          usbInfo: null
        }
      };
    }
  }

  /**
   * Get df data and create UUID to storage mapping
   */
  async _getDfData() {
    try {
      const { stdout } = await execPromise(`timeout 10 df -B1 ${DF_EXCLUDE_REMOTE}`);
      const lines = stdout.trim().split('\n').slice(1); // Skip header
      const dfData = {};

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 6) {
          const [filesystem, totalSpace, usedSpace, freeSpace, , mountPoint] = parts;

          dfData[mountPoint] = {
            filesystem,
            totalSpace: parseInt(totalSpace),
            usedSpace: parseInt(usedSpace),
            freeSpace: parseInt(freeSpace),
            usagePercent: Math.round((parseInt(usedSpace) / parseInt(totalSpace)) * 100)
          };
        }
      }

      return dfData;
    } catch (error) {
      console.warn(`Warning: Could not get df data: ${error.message}`);
      return {};
    }
  }

  /**
   * Convert bytes to human readable format
   */
  _bytesToHuman(bytes) {
    if (!bytes || bytes === 0) return '0 B';

    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + units[i];
  }

  /**
   * Get per-device usage of a bcachefs pool
   * Queried without -h so sizes come back as raw bytes. Returns null when the output cannot be
   * parsed, so callers fall back to the pool-wide df numbers instead of showing wrong values
   * @param {string} mountPoint - Pool mount point
   * @returns {Promise<Object|null>} Map of device label to usage, or null
   * @private
   */
  async _getBcachefsDeviceUsage(mountPoint) {
    try {
      const { stdout } = await execPromise(`timeout 10 bcachefs fs usage --fields devices ${mountPoint}`);
      const usage = {};

      for (const line of stdout.split('\n')) {
        // e.g. "hdd.hdd1 (device 0):  sdb1  rw  7999063638016  4398046511104  55%  0"
        const match = line.trim().match(/^(\S+)\s+\(device\s+(\d+)\):\s+(\S+)\s+(\w+)\s+(\d+)\s+(\d+)/);
        if (!match) continue;

        const [, label, index, deviceName, state, total, used] = match;
        const totalSpace = parseInt(total, 10);
        const usedSpace = parseInt(used, 10);

        usage[label] = {
          index: parseInt(index, 10),
          device: deviceName.startsWith('/') ? deviceName : `/dev/${deviceName}`,
          state,
          totalSpace,
          usedSpace,
          freeSpace: Math.max(0, totalSpace - usedSpace),
          usagePercent: totalSpace > 0 ? Math.round((usedSpace / totalSpace) * 100) : 0
        };
      }

      return Object.keys(usage).length > 0 ? usage : null;
    } catch (error) {
      console.warn(`Could not get bcachefs device usage for ${mountPoint}: ${error.message}`);
      return null;
    }
  }

  /**
   * Aggregate bcachefs device storage into the hdd/ssd device groups
   * Lets the UI show data and cache capacity separately
   * @param {Object} pool - Pool object with storage already injected
   * @param {Object} user - User object with byte_format preference
   * @returns {Object} Totals per device group
   * @private
   */
  _aggregateBcachefsGroups(pool, user = null) {
    const groups = {};

    for (const device of pool.data_devices || []) {
      if (!device.group || !device.storage) continue;

      if (!groups[device.group]) {
        groups[device.group] = { devices: 0, totalSpace: 0, usedSpace: 0, freeSpace: 0 };
      }

      const group = groups[device.group];
      group.devices++;
      group.totalSpace += device.storage.totalSpace || 0;
      group.usedSpace += device.storage.usedSpace || 0;
      group.freeSpace += device.storage.freeSpace || 0;
    }

    for (const group of Object.values(groups)) {
      group.totalSpace_human = this.formatBytes(group.totalSpace, user);
      group.usedSpace_human = this.formatBytes(group.usedSpace, user);
      group.freeSpace_human = this.formatBytes(group.freeSpace, user);
      group.usagePercent = group.totalSpace > 0
        ? Math.round((group.usedSpace / group.totalSpace) * 100)
        : 0;
    }

    return groups;
  }

  /**
   * Generate expected mount point for a device based on pool type
   */
  _generateExpectedMountPoint(pool, device, deviceType = 'data') {
    switch(pool.type) {
      case 'mergerfs':
        if (deviceType === 'parity') {
          return `/var/snapraid/${pool.name}/parity${device.slot}`;
        }
        return `/var/mergerfs/${pool.name}/disk${device.slot}`;
      case 'nonraid':
        if (deviceType === 'parity') {
          return null;
        }
        return `/var/mergerfs/${pool.name}/disk${device.slot}`;

      case 'btrfs':
      case 'ext4':
      case 'xfs':
      default:
        return `/mnt/${pool.name}`;
    }
  }

  /**
   * Filter out system devices (root disk, boot partitions, etc.) from device list
   */
  async _filterSystemDevices(devices, configuredDevices = []) {
    const systemDevices = new Set();

    try {
      // Get root filesystem device
      const { stdout: rootDevice } = await execPromise(`df / | tail -1 | awk '{print $1}'`);
      if (rootDevice.trim()) {
        const baseRootDevice = rootDevice.trim().replace(/\d+$/, '').replace(/p\d+$/, '');
        systemDevices.add(baseRootDevice);
      }

      // Get boot filesystem device
      const { stdout: bootDevice } = await execPromise(`df /boot 2>/dev/null | tail -1 | awk '{print $1}' || echo ""`);
      if (bootDevice.trim()) {
        const baseBootDevice = bootDevice.trim().replace(/\d+$/, '').replace(/p\d+$/, '');
        systemDevices.add(baseBootDevice);
      }
    } catch (error) {
      console.warn(`Could not detect system devices: ${error.message}`);
    }

    return devices.filter(dev => {
      // Skip if it's a system device or partition of system device
      const baseDevice = dev.replace(/\d+$/, '').replace(/p\d+$/, '');
      if (systemDevices.has(baseDevice) || systemDevices.has(dev)) {
        return false;
      }

      // Skip if it's a partition of an already configured device
      return !configuredDevices.some(configured => {
        const configuredBase = configured.replace(/\d+$/, '').replace(/p\d+$/, '');
        return dev.startsWith(configuredBase) && dev !== configured;
      });
    });
  }

  /**
   * Inject device paths dynamically by resolving UUIDs (for internal operations)
   * @param {Object} pool - Pool object
   * @private
   */
  async _injectDevicePaths(pool) {
    // Inject UUID-based device paths into data devices (for internal operations)
    for (const device of pool.data_devices || []) {
      if (device.id && !device.device) {
        device.device = await this.getDevicePathFromUuid(device.id);
      }
    }

    // Inject UUID-based device paths into parity devices (for internal operations)
    for (const device of pool.parity_devices || []) {
      if (device.id && !device.device) {
        device.device = await this.getDevicePathFromUuid(device.id);
      }
    }
  }

  /**
   * Inject real device paths into pool devices (for API display)
   * @param {Object} pool - Pool object
   * @private
   */
  async _injectRealDevicePaths(pool) {
    // Skip UUID-based device path injection for non-encrypted multi-device BTRFS pools
    // They will get their device paths from btrfs filesystem show in _injectStorageInfoIntoDevices
    // But encrypted pools need UUID-based device path injection
    if (pool.type === 'btrfs' && pool.data_devices && pool.data_devices.length > 1 && !pool.config?.encrypted) {
      return;
    }

    // Inject real device paths into data devices (for API display)
    for (const device of pool.data_devices || []) {
      if (device.id) {
        device.device = await this.getRealDevicePathFromUuid(device.id);
      }
    }

    // Inject real device paths into parity devices (for API display)
    for (const device of pool.parity_devices || []) {
      if (device.id) {
        if ( pool.type === 'nonraid') {
          device.device = await this.getRealDevicePathFromId(device.id);
        } else {
          device.device = await this.getRealDevicePathFromUuid(device.id);
        }
      }
    }
  }

  /**
   * Check if NonRAID parity is valid (all disks OK or NP)
   * @returns {Promise<boolean>} - True if parity is valid
   * @private
   */
  async _getNonRaidParityValid() {
    try {
      // Check if /proc/nmdstat exists
      await fs.access('/proc/nmdstat');

      // Read /proc/nmdstat and parse all disk statuses
      const { stdout } = await execPromise('cat /proc/nmdstat');

      // Find all rdevStatus entries
      const statusMatches = stdout.matchAll(/rdevStatus\.(\d+)=(\w+)/g);

      for (const match of statusMatches) {
        const status = match[2];
        // Valid statuses: DISK_OK or DISK_NP (not present)
        // Invalid statuses: DISK_INVALID, DISK_WRONG, DISK_DSBL_NEW, etc.
        if (status !== 'DISK_OK' && status !== 'DISK_NP') {
          return false;
        }
      }

      return true;
    } catch (error) {
      // If we can't read the status, assume invalid
      return false;
    }
  }

  /**
   * Inject parity operation status for NonRAID pools into pool.status object
   * @param {Object} pool - Pool object to inject status into
   * @param {Object} user - User object with byte_format preference
   * @returns {Promise<void>}
   * @private
   */
  async _injectNonRaidParityStatus(pool, user = null) {
    try {
      // Ensure status object exists
      if (!pool.status) {
        pool.status = {};
      }

      // Only NonRAID pools can have parity operations
      if (pool.type !== 'nonraid') {
        return;
      }

      // Only check if parity devices exist
      if (!pool.parity_devices || pool.parity_devices.length === 0) {
        pool.status.parity_operation = false;
        pool.status.parity_progress = null;
        pool.status.parity_valid = null; // No parity devices
        return;
      }

      // Check if module is loaded (pool must be mounted)
      try {
        const moduleCheck = await execPromise('lsmod | grep -qE "md.nonraid" && echo "loaded" || echo "not_loaded"');
        if (moduleCheck.stdout.trim() !== 'loaded') {
          // Module not loaded, pool not mounted
          pool.status.parity_operation = false;
          pool.status.parity_progress = null;
          pool.status.parity_valid = null; // Can't determine when unmounted
          return;
        }
      } catch (error) {
        pool.status.parity_operation = false;
        pool.status.parity_progress = null;
        pool.status.parity_valid = null;
        return;
      }

      // Check if /proc/nmdstat exists
      try {
        await fs.access('/proc/nmdstat');
      } catch (error) {
        pool.status.parity_operation = false;
        pool.status.parity_progress = null;
        pool.status.parity_valid = null;
        return;
      }

      // Check parity validity (all disks OK or NP)
      pool.status.parity_valid = await this._getNonRaidParityValid();

      // Read /proc/nmdstat and parse all values
      const { stdout } = await execPromise('cat /proc/nmdstat');
      const actionMatch = stdout.match(/mdResyncAction=(.+)/);

      if (!actionMatch || !actionMatch[1] || actionMatch[1].trim() === '') {
        // No operation running
        pool.status.parity_operation = false;
        pool.status.parity_progress = null;
        return;
      }

      const action = actionMatch[1].trim();

      // Parse exit status, timestamps and resync position to determine if check is finished
      const syncExitMatch = stdout.match(/sbSyncExit=(-?\d+)/);
      const syncedMatch = stdout.match(/sbSynced=(\d+)/);
      const synced2Match = stdout.match(/sbSynced2=(\d+)/);
      const resyncPosMatch = stdout.match(/mdResyncPos=(\d+)/);
      const resyncDtMatch = stdout.match(/mdResyncDt=(\d+)/);
      const resyncDbMatch = stdout.match(/mdResyncDb=(\d+)/);

      const syncExit = syncExitMatch ? parseInt(syncExitMatch[1]) : null;
      const sbSynced = syncedMatch ? parseInt(syncedMatch[1]) : null;
      const sbSynced2 = synced2Match ? parseInt(synced2Match[1]) : null;
      const mdResyncPos = resyncPosMatch ? parseInt(resyncPosMatch[1]) : null;
      const mdResyncDt = resyncDtMatch ? parseInt(resyncDtMatch[1]) : null;
      const mdResyncDb = resyncDbMatch ? parseInt(resyncDbMatch[1]) : null;

      // Check if operation is actually running (has any progress/activity)
      // If mdResyncAction is set but all progress values are 0, it's not really active
      const hasActivity = (mdResyncPos !== null && mdResyncPos > 0) ||
                          (mdResyncDt !== null && mdResyncDt > 0) ||
                          (mdResyncDb !== null && mdResyncDb > 0);

      // If there's activity, the operation is definitely running - don't check "finished" conditions!
      // sbSynced/sbSynced2 are timestamps of LAST completed sync, not current operation
      if (hasActivity) {
        // Operation is running, continue to build progress object
      } else {
        // No activity - check if operation is finished/cancelled:
        // 1. sbSyncExit = -4 AND mdResyncPos = 0: cancelled (aborted, not paused)
        // 2. sbSyncExit < 0 AND sbSyncExit ≠ -4: error exit
        // 3. No activity at all: not running
        const isCancelled = syncExit === -4 && mdResyncPos === 0;
        const isFinishedWithError = syncExit !== null && syncExit < 0 && syncExit !== -4;

        // Operation is not running
        pool.status.parity_operation = false;
        pool.status.parity_progress = null;
        return;
      }

      // Operation is running (or paused)
      pool.status.parity_operation = true;

      // Map actions to descriptions
      let description = '';
      if (action === 'recon P') {
        description = 'Reconstructing first parity (P-Disk)';
      } else if (action === 'recon Q') {
        description = 'Reconstructing second parity (Q-Disk)';
      } else if (action === 'recon P Q') {
        description = 'Full parity sync (reconstructing both parities)';
      } else if (action.startsWith('recon D')) {
        const diskNum = action.replace('recon D', '');
        description = `Reconstructing data disk ${diskNum}`;
      } else if (action === 'check P') {
        description = 'Checking first parity (P-Disk)';
      } else if (action === 'check Q') {
        description = 'Checking second parity (Q-Disk)';
      } else if (action === 'check P Q') {
        description = 'Checking both parities';
      } else if (action === 'clear') {
        description = 'Clearing new data device (filling with zeros)';
      } else if (action === 'check') {
        description = 'General pool check (re-verify)';
      } else {
        description = `Unknown operation: ${action}`;
      }

      // Parse resync statistics (resyncPos, resyncDt, resyncDb already parsed above)
      const resyncSizeMatch = stdout.match(/mdResyncSize=(\d+)/);
      const resyncCorrMatch = stdout.match(/mdResyncCorr=(\d+)/);

      const resyncSize = resyncSizeMatch ? parseInt(resyncSizeMatch[1]) : null;
      const resyncPos = mdResyncPos; // Use already parsed value
      const resyncDt = mdResyncDt; // Use already parsed value
      const resyncDb = mdResyncDb; // Use already parsed value
      const resyncCorr = resyncCorrMatch ? parseInt(resyncCorrMatch[1]) : null;

      // Calculate percent
      let percent = 0;
      if (resyncSize && resyncPos && resyncSize > 0) {
        percent = Math.floor((resyncPos / resyncSize) * 100);
      }

      // Calculate speed (KB/s -> bytes/s for formatting)
      let speed = null;
      if (resyncDt && resyncDb && resyncDt > 0) {
        const kbPerSecond = resyncDb / resyncDt;
        const bytesPerSecond = kbPerSecond * 1024;
        speed = this.formatSpeed(bytesPerSecond, user);
      }

      // Calculate ETA (format as MM:SS or HH:MM:SS)
      let eta = null;
      if (resyncSize && resyncPos && resyncDt && resyncDb && resyncDt > 0 && resyncDb > 0) {
        const remainingBlocks = resyncSize - resyncPos;
        const kbPerSecond = resyncDb / resyncDt;
        if (kbPerSecond > 0) {
          const remainingSeconds = Math.floor(remainingBlocks / kbPerSecond);
          const hours = Math.floor(remainingSeconds / 3600);
          const minutes = Math.floor((remainingSeconds % 3600) / 60);
          const seconds = remainingSeconds % 60;

          if (hours > 0) {
            eta = `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
          } else {
            eta = `${minutes}:${String(seconds).padStart(2, '0')}`;
          }
        }
      }

      // Calculate processed amount (height)
      let height = null;
      if (resyncPos) {
        const bytesProcessed = resyncPos * 1024;
        height = this.formatBytes(bytesProcessed, user);
      }

      // Parse error statistics
      const syncErrsMatch = stdout.match(/sbSyncErrs=(\d+)/);
      const syncErrs = syncErrsMatch ? parseInt(syncErrsMatch[1]) : null;

      // Determine if paused: sbSyncExit = -4 AND resyncPos > 0 indicates paused state
      // If sbSyncExit = -4 AND resyncPos = 0, it was cancelled (already handled above)
      const isPaused = syncExit === -4 && resyncPos !== null && resyncPos > 0;

      // Build progress object similar to SnapRAID
      pool.status.parity_progress = {
        operation: action,
        description: description,
        status: isPaused ? 'paused' : 'running',
        percent: percent,
        height: height,
        speed: isPaused ? null : speed, // No speed when paused
        eta: isPaused ? null : eta // No ETA when paused
      };

      // Add check mode information if available
      if (resyncCorr !== null) {
        pool.status.parity_progress.correction_enabled = resyncCorr === 1;
      }

      // Add timing information if available
      if (sbSynced !== null) {
        pool.status.parity_progress.start_time = sbSynced;
      }
      if (sbSynced2 !== null) {
        pool.status.parity_progress.end_time = sbSynced2;
      }

      // Add error information if available
      if (syncExit !== null) {
        pool.status.parity_progress.last_exit_code = syncExit;
      }
      if (syncErrs !== null) {
        pool.status.parity_progress.parity_errors = syncErrs;
      }

    } catch (error) {
      // On any error, default to false
      if (!pool.status) {
        pool.status = {};
      }
      pool.status.parity_operation = false;
      pool.status.parity_progress = null;
    }
  }

  /**
   * Ensure pool has device paths injected
   * @param {Object} pool - Pool object
   * @private
   */
  async _ensureDevicePaths(pool) {
    // Check if device paths are already injected
    const needsInjection = (pool.data_devices && pool.data_devices.some(d => d.id && !d.device)) ||
                          (pool.parity_devices && pool.parity_devices.some(d => d.id && !d.device));

    if (needsInjection) {
      await this._injectDevicePaths(pool);
    }
  }

  /**
   * Inject storage information directly into pool devices (no disk access)
   * @param {Object} pool - Pool object
   * @param {Object} user - User object with byte_format preference
   */
  async _injectStorageInfoIntoDevices(pool, user = null, sharedDfData = null) {
    const dfData = sharedDfData || await this._getDfData();

    // For non-encrypted BTRFS multi-device pools, get all physical devices from btrfs filesystem show
    let btrfsDevices = [];
    if (pool.type === 'btrfs' && pool.data_devices && pool.data_devices.length > 1 && !pool.config?.encrypted) {
      try {
        const mountPoint = this._generateExpectedMountPoint(pool, pool.data_devices[0], 'data');

        // Use the new method to get device paths for multi-device BTRFS pools only
        btrfsDevices = await this.getBtrfsDevicePaths(mountPoint);

        // Update the pool's device paths for display
        if (btrfsDevices.length > 0) {
          for (let i = 0; i < Math.min(pool.data_devices.length, btrfsDevices.length); i++) {
            if (pool.data_devices[i]) {
              // For multi-device BTRFS pools, use device paths from btrfs filesystem show
              pool.data_devices[i].device = btrfsDevices[i];
            }
          }
          // Device paths updated for multi-device BTRFS pool
        }
      } catch (error) {
        console.warn(`Could not get BTRFS device list for pool ${pool.name}: ${error.message}`);
      }
    }

    // Reported live instead of from config, which drifts on external balance/convert runs.
    // Stays null for single-device pools, where no profile choice was ever made.
    pool.raid_level = null;
    if (pool.type === 'btrfs' && pool.data_devices?.length > 1) {
      const poolMountPoint = this._generateExpectedMountPoint(pool, pool.data_devices[0], 'data');
      if (dfData[poolMountPoint]) {
        pool.raid_level = await this.getBtrfsRaidProfile(poolMountPoint);
      }
    }

    // df only knows the shared bcachefs mount point, so per-device numbers are read from the
    // filesystem itself. Gated on df seeing the mount so unmounted pools cost nothing.
    let bcachefsUsage = null;
    if (pool.type === 'bcachefs' && pool.data_devices?.length) {
      const poolMountPoint = this._generateExpectedMountPoint(pool, pool.data_devices[0], 'data');
      if (dfData[poolMountPoint]) {
        bcachefsUsage = await this._getBcachefsDeviceUsage(poolMountPoint);
      }
    }

    // Inject storage info into data devices
    for (const device of pool.data_devices || []) {
      const expectedMountPoint = this._generateExpectedMountPoint(pool, device, 'data');
      const storageData = dfData[expectedMountPoint];

      // bcachefs labels are derived from group and slot, never persisted
      if (pool.type === 'bcachefs' && device.group) {
        device.label = BcachefsHelpers.deviceLabel(device.group, device.slot);
      }

      const memberUsage = bcachefsUsage && device.label ? bcachefsUsage[device.label] : null;

      if (memberUsage) {
        device.storage = {
          totalSpace: memberUsage.totalSpace,
          totalSpace_human: this.formatBytes(memberUsage.totalSpace, user),
          usedSpace: memberUsage.usedSpace,
          usedSpace_human: this.formatBytes(memberUsage.usedSpace, user),
          freeSpace: memberUsage.freeSpace,
          freeSpace_human: this.formatBytes(memberUsage.freeSpace, user),
          usagePercent: memberUsage.usagePercent
        };
        device.state = memberUsage.state;
        device.mountPoint = expectedMountPoint;
        device.storageStatus = 'mounted';
      } else if (storageData) {
        device.storage = {
          totalSpace: storageData.totalSpace,
          totalSpace_human: this.formatBytes(storageData.totalSpace, user),
          usedSpace: storageData.usedSpace,
          usedSpace_human: this.formatBytes(storageData.usedSpace, user),
          freeSpace: storageData.freeSpace,
          freeSpace_human: this.formatBytes(storageData.freeSpace, user),
          usagePercent: storageData.usagePercent
        };
        device.mountPoint = expectedMountPoint;
        device.storageStatus = 'mounted';
      } else {
        device.storage = null;
        // Don't set mountPoint if not mounted
        device.storageStatus = 'unmounted_or_not_found';
      }

      // Mark as shared storage since all devices share the same filesystem
      device.isSharedStorage = ['btrfs', 'bcachefs'].includes(pool.type);
    }

    // Expose data and cache capacity separately, only meaningful once per-device usage was read
    if (pool.type === 'bcachefs' && bcachefsUsage) {
      pool.device_groups = this._aggregateBcachefsGroups(pool, user);
    }

    // For BTRFS pools, inject missing devices that are part of the filesystem but not in config
    // Skip this for encrypted pools as LUKS mapped devices should not be injected
    if (pool.type === 'btrfs' && btrfsDevices.length > 0 && !pool.config?.encrypted) {
      const configuredDevices = pool.data_devices.map(d => d.device);
      let missingDevices = btrfsDevices.filter(dev => !configuredDevices.includes(dev));

      // Filter out root disk and system partitions
      missingDevices = await this._filterSystemDevices(missingDevices, configuredDevices);

      for (const missingDevice of missingDevices) {
        try {
          const deviceUuid = await this.getDeviceUuid(missingDevice);
          const deviceInfo = await this.checkDeviceFilesystem(missingDevice);

          const injectedDevice = {
            slot: pool.data_devices.length + missingDevices.indexOf(missingDevice) + 1,
            id: deviceUuid,
            device: missingDevice,
            filesystem: deviceInfo.filesystem || 'btrfs',
            spindown: null,
            _injected: true, // Mark as dynamically injected
            storage: pool.data_devices[0]?.storage || null, // Share storage info from first device
            mountPoint: this._generateExpectedMountPoint(pool, { device: missingDevice }, 'data'),
            storageStatus: pool.data_devices[0]?.storageStatus || 'mounted',
            isSharedStorage: true
          };

          // Enrich with disk type info
          const enrichedDevice = await this._enrichDeviceWithDiskTypeInfo(injectedDevice);
          pool.data_devices.push(enrichedDevice);
        } catch (error) {
          console.warn(`Could not inject missing BTRFS device ${missingDevice}: ${error.message}`);
        }
      }
    }

    // Inject storage info into parity devices
    for (const device of pool.parity_devices || []) {
      const expectedMountPoint = this._generateExpectedMountPoint(pool, device, 'parity');
      const storageData = dfData[expectedMountPoint];

      if (storageData) {
        device.storage = {
          totalSpace: storageData.totalSpace,
          totalSpace_human: this.formatBytes(storageData.totalSpace, user),
          usedSpace: storageData.usedSpace,
          usedSpace_human: this.formatBytes(storageData.usedSpace, user),
          freeSpace: storageData.freeSpace,
          freeSpace_human: this.formatBytes(storageData.freeSpace, user),
          usagePercent: storageData.usagePercent
        };
        device.mountPoint = expectedMountPoint;
        device.storageStatus = 'mounted';
      } else {
        device.storage = null;
        // Don't set mountPoint if not mounted
        device.storageStatus = 'unmounted_or_not_found';
      }

      device.isSharedStorage = false; // Parity devices are always individual
    }
  }

  /**
   * List all pools with optional filtering
   * @param {Object} filters - Optional filters to apply
   * @param {string} filters.type - Filter by pool type (e.g., 'mergerfs', 'btrfs', 'single')
   * @param {string} filters.exclude_type - Exclude pools of specific type (e.g., 'mergerfs')
   * @param {Object} user - User object with byte_format preference
   */
  async listPools(filters = {}, user = null) {
    try {
      let pools = await this._readPools();

      // Apply type filtering if specified
      if (filters.type) {
        pools = pools.filter(pool => {
          // Check pool.type first, then fallback to checking filesystem type of first data device
          const poolType = pool.type || (pool.data_devices?.[0]?.filesystem);
          return poolType === filters.type;
        });
      }

      // Apply type exclusion if specified
      if (filters.exclude_type) {
        pools = pools.filter(pool => {
          // Check pool.type first, then fallback to checking filesystem type of first data device
          const poolType = pool.type || (pool.data_devices?.[0]?.filesystem);
          return poolType !== filters.exclude_type;
        });
      }

      // Ensure scrub config exists for all MergerFS pools with parity
      let poolsModified = false;
      for (const pool of pools) {
        if (this._ensureScrubConfig(pool)) {
          poolsModified = true;
        }
        // Ensure BTRFS scrub/balance config for BTRFS pools
        if (this._ensureBtrfsScrubConfig(pool)) {
          poolsModified = true;
        }
        if (this._ensureBtrfsBalanceConfig(pool)) {
          poolsModified = true;
        }
        // Ensure usage alert config exists for all pools
        if (this._ensureUsageAlertConfig(pool)) {
          poolsModified = true;
        }
      }

      // Save pools if any were modified
      if (poolsModified) {
        await this._writePools(pools);
      }

      // One df run for all pools instead of one per pool
      const dfData = await this._getDfData();

      // For each pool, update its mounted status and space info
      for (const pool of pools) {
        // Inject real device paths for API display
        await this._injectRealDevicePaths(pool);

        // Enrich device information with disk type details (parallel per pool)
        // These only read from /sys filesystem, no disk wake-up
        const enrichPromises = [];
        if (pool.data_devices && pool.data_devices.length > 0) {
          enrichPromises.push(...pool.data_devices.map(async (dev, i) => {
            pool.data_devices[i] = await this._enrichDeviceWithDiskTypeInfo(dev);
          }));
        }
        if (pool.parity_devices && pool.parity_devices.length > 0) {
          enrichPromises.push(...pool.parity_devices.map(async (dev, i) => {
            pool.parity_devices[i] = await this._enrichDeviceWithDiskTypeInfo(dev);
          }));
        }
        if (enrichPromises.length > 0) {
          await Promise.all(enrichPromises);
        }

        // Update mount status and space info
        if (pool.data_devices && pool.data_devices.length > 0) {
          const mountPoint = path.join(this.mountBasePath, pool.name);
          const isMounted = await this._isMounted(mountPoint);
          if (isMounted) {
            const spaceInfo = await this.getDeviceSpace(mountPoint, user);
            pool.status = spaceInfo;
            pool.mountPoint = mountPoint;
          } else {
            pool.status = { mounted: false };
            // Don't set mountPoint if not mounted
          }
        }

        // Inject storage info first (needed before power status for context)
        await this._injectStorageInfoIntoDevices(pool, user, dfData);

        // Run power status and disk info injection in parallel
        // Both are independent read-only operations, standby handling preserved
        await Promise.all([
          this._injectPowerStatusIntoDevices(pool),
          this._injectDiskInfoIntoDevices(pool)
        ]);

        // Inject parity operation status (API-only, not persisted)
        await this._injectParityOperationStatus(pool, user);
      }

      // Note: We don't write back to pools.json for read-only operations
      // The status and storage info are dynamic and should not be persisted

      return pools;
    } catch (error) {
      throw new Error(`Error listing pools: ${error.message}`);
    }
  }

  /**
   * Get a pool by ID
   * @param {string} poolId - Pool ID
   * @param {Object} user - User object with byte_format preference
   */
  async getPoolById(poolId, user = null) {
    try {
      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.id === poolId);

      if (poolIndex === -1) {
        throw new Error(`Pool with ID "${poolId}" not found`);
      }

      const pool = pools[poolIndex];

      // Ensure scrub config exists for MergerFS pools with parity
      if (this._ensureScrubConfig(pool)) {
        await this._writePools(pools);
      }
      // Ensure BTRFS scrub/balance config for BTRFS pools
      if (this._ensureBtrfsScrubConfig(pool)) {
        await this._writePools(pools);
      }
      if (this._ensureBtrfsBalanceConfig(pool)) {
        await this._writePools(pools);
      }
      // Ensure usage alert config exists
      if (this._ensureUsageAlertConfig(pool)) {
        await this._writePools(pools);
      }

      // Inject real device paths for API display
      await this._injectRealDevicePaths(pool);

      // Enrich device information with disk type details (parallel)
      // These only read from /sys filesystem, no disk wake-up
      const enrichPromises = [];
      if (pool.data_devices && pool.data_devices.length > 0) {
        enrichPromises.push(...pool.data_devices.map(async (dev, i) => {
          pool.data_devices[i] = await this._enrichDeviceWithDiskTypeInfo(dev);
        }));
      }
      if (pool.parity_devices && pool.parity_devices.length > 0) {
        enrichPromises.push(...pool.parity_devices.map(async (dev, i) => {
          pool.parity_devices[i] = await this._enrichDeviceWithDiskTypeInfo(dev);
        }));
      }
      if (enrichPromises.length > 0) {
        await Promise.all(enrichPromises);
      }

      // Update pool status
      if (pool.data_devices && pool.data_devices.length > 0) {
        const mountPoint = path.join(this.mountBasePath, pool.name);
        const spaceInfo = await this.getDeviceSpace(mountPoint, user);
        pool.status = spaceInfo;

        // Inject storage info first (needed before power status for context)
        await this._injectStorageInfoIntoDevices(pool, user);

        // Run power status and disk info injection in parallel
        // Both are independent read-only operations, standby handling preserved
        await Promise.all([
          this._injectPowerStatusIntoDevices(pool),
          this._injectDiskInfoIntoDevices(pool)
        ]);

        // Inject parity operation status (API-only, not persisted)
        await this._injectParityOperationStatus(pool, user);
      }

      return pool;
    } catch (error) {
      throw new Error(`Error getting pool: ${error.message}`);
    }
  }

  /**
   * Toggle automount for a pool
   */
  async toggleAutomountById(poolId, automount) {
    try {
      if (typeof automount !== 'boolean') {
        throw new Error('Automount value must be a boolean');
      }

      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.id === poolId);

      if (poolIndex === -1) {
        throw new Error(`Pool with ID "${poolId}" not found`);
      }

      // Update automount setting
      pools[poolIndex].automount = automount;
      await this._writePools(pools);

      return {
        success: true,
        message: `Automount ${automount ? 'enabled' : 'disabled'} for pool "${pools[poolIndex].name}" (ID: ${poolId})`,
        pool: pools[poolIndex]
      };
    } catch (error) {
      throw new Error(`Error toggling automount: ${error.message}`);
    }
  }

  /**
   * Toggle shared mount propagation for a pool (live, no remount)
   */
  async toggleSharedById(poolId, shared) {
    try {
      if (typeof shared !== 'boolean') {
        throw new Error('Shared value must be a boolean');
      }

      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.id === poolId);

      if (poolIndex === -1) {
        throw new Error(`Pool with ID "${poolId}" not found`);
      }

      const pool = pools[poolIndex];
      const mountPoint = path.join(this.mountBasePath, pool.name);

      // Apply live propagation change only if pool is currently mounted
      if (await this._isMounted(mountPoint)) {
        const propagation = shared ? '--make-shared' : '--make-private';
        await execPromise(`mount ${propagation} "${mountPoint}"`);
      }

      // Persist flag so it survives remount/reboot
      if (!pool.config) pool.config = {};
      pool.config.shared = shared;
      await this._writePools(pools);

      return {
        success: true,
        message: `Shared ${shared ? 'enabled' : 'disabled'} for pool "${pool.name}" (ID: ${poolId})`,
        pool
      };
    } catch (error) {
      throw new Error(`Error toggling shared: ${error.message}`);
    }
  }

  /**
   * Update a pool's comment
   */
  async updatePoolComment(poolId, comment) {
    try {
      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.id === poolId);

      if (poolIndex === -1) {
        throw new Error(`Pool with ID "${poolId}" not found`);
      }

      // Update comment
      pools[poolIndex].comment = comment || "";
      await this._writePools(pools);

      return {
        success: true,
        message: `Comment updated for pool "${pools[poolIndex].name}" (ID: ${poolId})`,
        pool: pools[poolIndex]
      };
    } catch (error) {
      throw new Error(`Error updating pool comment: ${error.message}`);
    }
  }

  /**
   * Helper function to set a value using dot notation
   * @param {Object} obj - Object to update
   * @param {string} path - Dot-notation path (e.g., "sync.enabled")
   * @param {*} value - Value to set
   * @private
   */
  _setDotNotation(obj, path, value) {
    const parts = path.split('.');
    let current = obj;

    // Navigate/create nested structure
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]] || typeof current[parts[i]] !== 'object') {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }

    // Set the final value
    current[parts[parts.length - 1]] = value;
  }

  /**
   * Get a pool's configuration
   * @param {string} poolId - Pool ID
   * @returns {Object} Pool config object
   */
  async getPoolConfig(poolId) {
    try {
      const pools = await this._readPools();
      const pool = pools.find(p => p.id === poolId);

      if (!pool) {
        throw new Error(`Pool with ID "${poolId}" not found`);
      }

      // Ensure usage alert defaults (70/90) are present and persisted
      if (this._ensureUsageAlertConfig(pool)) {
        await this._writePools(pools);
      }

      return pool.config || {};
    } catch (error) {
      throw new Error(`Error getting pool config: ${error.message}`);
    }
  }

  /**
   * Update a pool's configuration
   * @param {string} poolId - Pool ID
   * @param {Object} configUpdates - Configuration updates to apply (supports dot-notation)
   * @returns {Object} Result object with success status and updated pool
   */
  async updatePoolConfig(poolId, configUpdates) {
    try {
      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.id === poolId);

      if (poolIndex === -1) {
        throw new Error(`Pool with ID "${poolId}" not found`);
      }

      const pool = pools[poolIndex];

      // Ensure config object exists
      if (!pool.config) {
        pool.config = {};
      }

      // Capture whether usage monitoring was active before this update, so we
      // can notify once when it gets disabled (both thresholds set to 0).
      const prevUsageAlert = pool.config.usage_alert;
      const usageWasEnabled = !prevUsageAlert || prevUsageAlert.warning !== 0 || prevUsageAlert.alert !== 0;

      // Update config with provided values
      // Supports both direct properties and dot-notation (e.g., "sync.enabled")
      Object.keys(configUpdates).forEach(key => {
        if (key.includes('.')) {
          // Use dot-notation for nested properties
          this._setDotNotation(pool.config, key, configUpdates[key]);
        } else {
          // Direct property assignment
          pool.config[key] = configUpdates[key];
        }
      });

      // Store usage alert thresholds as integers, so numeric strings like "50"
      // are not silently ignored by the monitor's Number.isFinite check later.
      if (pool.config.usage_alert && typeof pool.config.usage_alert === 'object') {
        ['warning', 'alert'].forEach(level => {
          const value = pool.config.usage_alert[level];
          if (value !== undefined) {
            pool.config.usage_alert[level] = parseInt(value, 10);
          }
        });
      }

      await this._writePools(pools);

      // Notify once when usage monitoring was just turned off (both thresholds
      // set to 0). Otherwise a pool that was at warning/alert level would stay
      // silent with no closing message.
      const newUsageAlert = pool.config.usage_alert;
      const usageNowDisabled = newUsageAlert && newUsageAlert.warning === 0 && newUsageAlert.alert === 0;
      if (usageNowDisabled && usageWasEnabled) {
        if (PoolsService._usageAlertState) {
          PoolsService._usageAlertState.delete(pool.id);
        }
        sendNotification('Pool Usage', `Pool "${pool.name}" usage monitoring disabled`, 'normal')
          .catch(err => console.warn(`Failed to send pool usage notification: ${err.message}`));
      }

      // Execute mos-cron_update after pool configuration changes (schedule updates)
      try {
        console.log('Executing mos-cron_update after pool configuration update');
        await execPromise('mos-cron_update');
      } catch (cronError) {
        console.warn(`Failed to execute mos-cron_update: ${cronError.message}`);
      }

      return {
        success: true,
        message: `Configuration updated for pool "${pool.name}" (ID: ${poolId})`,
        pool: pool,
        updatedConfig: pool.config
      };
    } catch (error) {
      throw new Error(`Error updating pool config: ${error.message}`);
    }
  }

  /**
   * Update the order of all pools
   * @param {Array} order - Array of objects with {id, index}
   * @returns {Object} Result object with success status
   */
  async updatePoolsOrder(order) {
    try {
      if (!Array.isArray(order)) {
        throw new Error('Order must be an array');
      }

      const pools = await this._readPools();

      // Validate all pool IDs exist
      for (const item of order) {
        if (!item.id || typeof item.index !== 'number') {
          throw new Error('Each order item must have id and index properties');
        }

        const pool = pools.find(p => p.id === item.id);
        if (!pool) {
          throw new Error(`Pool with ID "${item.id}" not found`);
        }
      }

      // Update indices
      for (const item of order) {
        const pool = pools.find(p => p.id === item.id);
        if (pool) {
          pool.index = item.index;
        }
      }

      await this._writePools(pools);

      return {
        success: true,
        message: `Successfully updated order for ${order.length} pool(s)`,
        updatedCount: order.length
      };
    } catch (error) {
      throw new Error(`Error updating pools order: ${error.message}`);
    }
  }

  /**
   * Remove parity devices from a MergerFS pool
   * @param {string} poolId - Pool ID
   * @param {string[]} parityDevices - Array of parity device paths to remove
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} - Result object
   */
  async removeParityDevicesFromPool(poolId, parityDevices, options = {}) {
    try {
      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.id === poolId);

      if (poolIndex === -1) {
        throw new Error(`Pool with ID "${poolId}" not found`);
      }

      const pool = pools[poolIndex];

      if (pool.type !== 'mergerfs') {
        throw new Error('Only MergerFS pools support parity devices');
      }

      // Inject real device paths (e.g. /dev/sdj1 instead of /dev/disk/by-uuid/...)
      await this._injectRealDevicePaths(pool);

      // Identify parity devices to remove and their mount points
      const parityDevicesToRemove = [];
      const snapraidPoolPath = path.join(this.snapraidBasePath, pool.name);

      for (const parityDevice of pool.parity_devices) {
        // Accept both the injected path and the path the UUID resolves to
        let shouldRemove = parityDevices.includes(parityDevice.device);

        if (!shouldRemove && parityDevice.id) {
          const physicalDevice = await this.getRealDevicePathFromUuid(parityDevice.id).catch(() => null);
          shouldRemove = physicalDevice ? parityDevices.includes(physicalDevice) : false;
        }

        if (shouldRemove) {
          const parityMountPoint = path.join(snapraidPoolPath, `parity${parityDevice.slot}`);
          parityDevicesToRemove.push({
            device: parityDevice,
            mountPoint: parityMountPoint
          });
        }
      }

      const removedCount = parityDevicesToRemove.length;

      if (removedCount === 0) {
        throw new Error(`None of the specified parity devices are part of pool ${pool.name}`);
      }

      // Unmount parity devices if they are mounted
      const { unmount = true } = options;
      if (unmount) {
        for (const parityInfo of parityDevicesToRemove) {
          try {
            await this.unmountDevice(parityInfo.mountPoint);
            console.log(`Unmounted parity device from ${parityInfo.mountPoint}`);

            // Remove the mount point directory after unmounting
            try {
              await fs.rmdir(parityInfo.mountPoint);
              console.log(`Removed parity mount point directory ${parityInfo.mountPoint}`);
            } catch (rmdirError) {
              console.warn(`Warning: Could not remove parity mount point directory ${parityInfo.mountPoint}: ${rmdirError.message}`);
            }
          } catch (error) {
            console.warn(`Warning: Could not unmount parity device: ${error.message}`);
          }
        }
      }

      // Close LUKS devices for removed parity devices if pool is encrypted
      if (pool.config?.encrypted) {
        console.log(`Closing LUKS devices for removed parity devices from pool '${pool.name}'`);

        // Find original physical devices and their slots
        const physicalDevicesToClose = [];
        const paritySlots = [];

        for (const { device } of parityDevicesToRemove) {
          // Find the UUID in parity_devices to locate the physical device
          const parityDeviceUuid = device.id;

          // Parity devices are always resolved from their UUID
          try {
            const physicalDevice = await this.getRealDevicePathFromUuid(parityDeviceUuid);
            if (physicalDevice) {
              physicalDevicesToClose.push(physicalDevice);
              paritySlots.push(parseInt(device.slot));
            }
          } catch (error) {
            console.warn(`Warning: Could not resolve physical device for parity UUID ${parityDeviceUuid}: ${error.message}`);
          }
        }

        // Close LUKS devices using slot-based naming
        if (physicalDevicesToClose.length > 0) {
          try {
            await this._closeLuksDevicesWithSlots(physicalDevicesToClose, pool.name, paritySlots, true);
          } catch (error) {
            console.warn(`Warning: Could not close LUKS parity devices: ${error.message}`);
          }
        }
      }

      // Remove specified parity devices from pool configuration
      // Use the already identified devices to remove (which handles both physical and mapped)
      const slotsToRemove = parityDevicesToRemove.map(p => parseInt(p.device.slot));
      pool.parity_devices = pool.parity_devices.filter(
        device => !slotsToRemove.includes(parseInt(device.slot))
      );

      // If no parity devices left, clean up SnapRAID config and sync settings
      if (pool.parity_devices.length === 0) {
        // Remove SnapRAID configuration from pool config
        if (pool.config && pool.config.sync) {
          delete pool.config.sync;
        }

        // Clean up SnapRAID configuration file
        await this.cleanupSnapRAIDConfig(pool.name);

        console.log(`All parity devices removed from pool "${pool.name}". SnapRAID configuration cleaned up.`);
      } else {
        // Update SnapRAID configuration with remaining devices
        await this.updateSnapRAIDConfig(pool);
      }

      // Save updated pool configuration
      await this._writePools(pools);

      return {
        success: true,
        message: `Successfully removed ${removedCount} parity device(s) from pool "${pool.name}"${pool.parity_devices.length === 0 ? '. SnapRAID configuration removed.' : ''}`,
        pool,
        snapraidDisabled: pool.parity_devices.length === 0
      };
    } catch (error) {
      throw new Error(`Error removing parity devices: ${error.message}`);
    }
  }

  /**
   * Remove data devices from existing pools (supports both BTRFS and MergerFS)
   * @param {string} poolId - Pool ID
   * @param {string[]} devices - Array of device paths to remove
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} - Result object
   */
  async removeDevicesFromPool(poolId, devices, options = {}) {
    try {
      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.id === poolId);

      if (poolIndex === -1) {
        throw new Error(`Pool with ID "${poolId}" not found`);
      }

      const pool = pools[poolIndex];

      // Inject real device paths (e.g. /dev/sdj1 instead of /dev/disk/by-uuid/...)
      await this._injectRealDevicePaths(pool);

      // Handle different pool types
      if (pool.type === 'mergerfs') {
        return this._removeDevicesFromMergerFSPool(pool, devices, options, pools, poolIndex);
      } else if (['btrfs', 'single', 'ext4', 'xfs'].includes(pool.type)) {
        return this._removeDevicesFromBTRFSPool(pool, devices, options, pools, poolIndex);
      } else if (pool.type === 'bcachefs') {
        return this._removeDevicesFromBcachefsPool(pool, devices, options, pools, poolIndex);
      } else {
        throw new Error(`Removing devices from ${pool.type} pools is not supported`);
      }
    } catch (error) {
      throw new Error(`Error removing devices: ${error.message}`);
    }
  }

  /**
   * Remove devices from MergerFS pool
   * @private
   */
  async _removeDevicesFromMergerFSPool(pool, devices, options, pools, poolIndex) {
    const { unmount = true, skipSnapraidSync = false } = options;

    // Device paths were injected from the member UUIDs, which for encrypted pools are the
    // UUIDs of the LUKS containers - so this matches physical devices in both cases
    const existingDevices = pool.data_devices.map(d => d.device);
    const devicesToRemove = devices.filter(device => existingDevices.includes(device));

    if (devicesToRemove.length === 0) {
      throw new Error(`None of the specified devices are part of pool ${pool.name}`);
    }

    if (devicesToRemove.length < devices.length) {
      console.warn(`Warning: Some devices are not part of the pool and will be ignored`);
    }

    // Prevent removing all devices from the pool
    const totalDeviceCount = pool.data_devices.length;
    if (devicesToRemove.length >= totalDeviceCount) {
      throw new Error(`Cannot remove all devices from the pool. At least one device must remain.`);
    }

    // Get the mount points and slots of the devices to remove for unmounting
    const baseDir = `/var/mergerfs/${pool.name}`;
    const deviceMountPoints = {};
    const removedSlots = []; // Track removed slots for SnapRAID sync

    for (const device of devicesToRemove) {
      const deviceInfo = pool.data_devices.find(d => d.device === device);

      if (deviceInfo) {
        const mountPoint = path.join(baseDir, `disk${deviceInfo.slot}`);
        deviceMountPoints[device] = mountPoint;
        removedSlots.push(deviceInfo.slot); // Track the slot being removed
      }
    }

    // Unmount the MergerFS pool first if it's mounted
    const mainMountPoint = path.join(this.mountBasePath, pool.name);
    const wasPoolMounted = await this._isMounted(mainMountPoint);
    if (wasPoolMounted) {
      await this.unmountDevice(mainMountPoint);
    }

    // Unmount the removed devices if requested (BEFORE closing LUKS!)
    if (unmount) {
      for (const device of devicesToRemove) {
        const mountPoint = deviceMountPoints[device];
        if (mountPoint) {
          try {
            await this.unmountDevice(mountPoint);
            console.log(`Unmounted device ${device} from ${mountPoint}`);

            // Remove the mount point directory after unmounting
            try {
              await fs.rmdir(mountPoint);
              console.log(`Removed mount point directory ${mountPoint}`);
            } catch (rmdirError) {
              console.warn(`Warning: Could not remove mount point directory ${mountPoint}: ${rmdirError.message}`);
            }
          } catch (error) {
            console.warn(`Warning: Could not unmount ${device}: ${error.message}`);
          }
        }
      }
    }

    // Close LUKS devices for removed devices if pool is encrypted (AFTER unmounting!)
    if (pool.config?.encrypted) {
      console.log(`Closing LUKS devices for removed devices from MergerFS pool '${pool.name}'`);

      // Find slots and physical devices for the removed devices
      const physicalDevicesToClose = [];
      const slotsToClose = [];

      for (const removedDevice of devicesToRemove) {
        const deviceInfo = pool.data_devices.find(d => d.device === removedDevice);
        if (deviceInfo) {
          physicalDevicesToClose.push(removedDevice);
          slotsToClose.push(parseInt(deviceInfo.slot));
        }
      }

      if (physicalDevicesToClose.length > 0) {
        await this._closeLuksDevicesWithSlots(physicalDevicesToClose, pool.name, slotsToClose, false);
      }
    }

    // Remove devices from the pool data_devices array
    pool.data_devices = pool.data_devices.filter(d => !devicesToRemove.includes(d.device));

    // Remount the MergerFS pool with remaining devices if it was mounted before
    if (wasPoolMounted) {
      try {
        const mountPoints = pool.data_devices.map((_, index) =>
          path.join(baseDir, `disk${pool.data_devices[index].slot}`)
        ).join(':');
        const mergerfsOptions = this._buildMergerfsOptions(pool.config);

        await execPromise(`mergerfs -o ${mergerfsOptions} ${mountPoints} ${mainMountPoint}`);

        // Make the mount point a shared mount if configured (for bind mount propagation)
        if (pool.config?.shared === true) {
          try {
            await execPromise(`mount --make-shared "${mainMountPoint}"`);
            console.log(`Made pool mount point shared: ${mainMountPoint}`);
          } catch (sharedError) {
            console.warn(`Warning: Could not make mount shared: ${sharedError.message}`);
          }
        }
      } catch (error) {
        console.warn(`Warning: Could not remount MergerFS pool: ${error.message}`);
      }
    }

    // Update SnapRAID configuration if applicable
    if (pool.parity_devices && pool.parity_devices.length > 0) {
      await this.updateSnapRAIDConfig(pool);
    }

    // Save updated pool configuration
    await this._writePools(pools);

    // Trigger SnapRAID sync --force-empty if pool has parity and is mounted
    // Skip if this is part of a replace operation (skipSnapraidSync=true)
    // This is needed to update parity after device removal
    let snapraidSyncStarted = false;
    if (!skipSnapraidSync && pool.parity_devices && pool.parity_devices.length > 0 && wasPoolMounted) {
      try {
        console.log(`Starting SnapRAID sync --force-empty for pool '${pool.name}' after device removal (removed slots: ${removedSlots.join(', ')})`);
        await this.executeSnapRAIDOperation(pool.id, 'sync --force-empty');
        snapraidSyncStarted = true;
      } catch (syncError) {
        console.warn(`Warning: Could not start SnapRAID sync after device removal: ${syncError.message}`);
      }
    }

    const message = snapraidSyncStarted
      ? `Successfully removed ${devicesToRemove.length} device(s) from pool '${pool.name}'. SnapRAID sync started to update parity.`
      : `Successfully removed ${devicesToRemove.length} device(s) from pool '${pool.name}'`;

    return {
      success: true,
      message,
      pool,
      snapraidSyncStarted
    };
  }

  /**
   * Remove devices from BTRFS pool
   * @private
   */
  async _removeDevicesFromBTRFSPool(pool, devices, options, pools, poolIndex) {
    // Check if pool is mounted
    const mountPoint = path.join(this.mountBasePath, pool.name);
    const isMounted = await this._isMounted(mountPoint);
    if (!isMounted) {
      throw new Error(`Pool ${pool.name} must be mounted to remove devices`);
    }

    // Check if all devices to remove are actually in the pool
    const existingDevices = pool.data_devices.map(d => d.device);
    const devicesToRemove = devices.filter(device => existingDevices.includes(device));

    if (devicesToRemove.length === 0) {
      throw new Error(`None of the specified devices are part of pool ${pool.name}`);
    }

    // Prevent removing all devices from the pool
    if (devicesToRemove.length >= existingDevices.length) {
      throw new Error(`Cannot remove all devices from the pool. At least one device must remain.`);
    }

    // btrfs knows the LUKS mapper as its member, not the physical device behind it
    const removalTargets = devicesToRemove.map(device => {
      const deviceInfo = pool.data_devices.find(d => d.device === device);
      const slot = parseInt(deviceInfo.slot);

      return {
        device,
        slot,
        btrfsDevice: pool.config?.encrypted ? `/dev/mapper/${pool.name}_${slot}` : device
      };
    });

    // Remove each device from the BTRFS volume
    for (const target of removalTargets) {
      try {
        await execPromise(`btrfs device remove ${target.btrfsDevice} ${mountPoint}`);
        console.log(`Removed device ${target.device} from BTRFS pool ${pool.name}`);
      } catch (error) {
        throw new Error(`Failed to remove device ${target.device} from BTRFS pool: ${error.message}`);
      }
    }

    // Close LUKS devices for removed devices if pool is encrypted
    if (pool.config?.encrypted) {
      console.log(`Closing LUKS devices for removed devices from BTRFS pool '${pool.name}'`);

      await this._closeLuksDevicesWithSlots(
        removalTargets.map(t => t.device),
        pool.name,
        removalTargets.map(t => t.slot),
        false
      );
    }

    // Update the pool data structure
    pool.data_devices = pool.data_devices.filter(d => !devicesToRemove.includes(d.device));

    // Don't persist dynamic status info to pools.json
    // Status will be calculated dynamically when pools are retrieved

    // Save updated pool configuration (without status)
    await this._writePools(pools);

    return {
      success: true,
      message: `Successfully removed ${devicesToRemove.length} device(s) from BTRFS pool '${pool.name}'`,
      pool
    };
  }

  /**
   * Allow only one device operation per bcachefs pool at a time
   * @param {Object} pool - Pool object
   * @param {string} operation - Description used in errors and notifications
   * @private
   */
  _lockBcachefsDeviceOperation(pool, operation) {
    PoolsService._bcachefsDeviceOperations ??= new Map();
    const running = PoolsService._bcachefsDeviceOperations.get(pool.id);
    if (running) {
      throw new Error(`bcachefs ${running} is already running for pool ${pool.name}`);
    }
    PoolsService._bcachefsDeviceOperations.set(pool.id, operation);
  }

  /**
   * Remove devices from a bcachefs pool
   * Evacuation can take hours, so it runs in the background and reports through notifications
   * @param {Object} options - 'operation' overrides the description used in notifications
   * @private
   */
  async _removeDevicesFromBcachefsPool(pool, devices, options, pools, poolIndex) {
    const mountPoint = path.join(this.mountBasePath, pool.name);

    await this._assertBcachefsAvailable();

    if (!await this._isMounted(mountPoint)) {
      throw new Error(`Pool ${pool.name} must be mounted to remove devices`);
    }

    const targets = pool.data_devices.filter(d => devices.includes(d.device));
    if (targets.length === 0) {
      throw new Error(`None of the specified devices are part of pool ${pool.name}`);
    }

    BcachefsHelpers.validateRemainingMembers(
      pool.config,
      pool.data_devices.filter(d => !targets.includes(d))
    );

    const operation = options.operation || `removal of ${targets.map(t => t.device).join(', ')}`;
    this._lockBcachefsDeviceOperation(pool, operation);

    sendNotification('bcachefs', `bcachefs ${operation} for pool ${pool.name} started`, 'normal')
      .catch(err => console.warn(`Failed to send bcachefs notification: ${err.message}`));

    this._evacuateBcachefsDevices(pool, targets)
      .then(() => {
        sendNotification('bcachefs', `bcachefs ${operation} for pool ${pool.name} completed`, 'normal')
          .catch(err => console.warn(`Failed to send bcachefs notification: ${err.message}`));
      })
      .catch(error => {
        console.error(`bcachefs ${operation} for pool ${pool.name} failed: ${error.message}`);
        sendNotification('bcachefs', `bcachefs ${operation} for pool ${pool.name} failed: ${error.message}`, 'alert')
          .catch(err => console.warn(`Failed to send bcachefs notification: ${err.message}`));
      })
      .finally(() => PoolsService._bcachefsDeviceOperations.delete(pool.id));

    return {
      success: true,
      message: `bcachefs ${operation} for pool '${pool.name}' started, data is evacuated in the background`,
      pool
    };
  }

  /**
   * Evacuate and remove bcachefs members one by one
   * @private
   */
  async _evacuateBcachefsDevices(pool, targets) {
    for (const target of targets) {
      const slot = parseInt(target.slot);
      const member = pool.config?.encrypted ? `/dev/mapper/${pool.name}_${slot}` : target.device;

      try {
        await execPromise(`bcachefs device evacuate ${member} >/dev/null`);
        await execPromise(`bcachefs device remove ${member} >/dev/null`);
        console.log(`Removed device ${target.device} from bcachefs pool ${pool.name}`);
      } catch (error) {
        throw new Error(`Failed to remove device ${target.device}: ${error.message}`);
      }

      if (pool.config?.encrypted) {
        await this._closeLuksDevicesWithSlots([target.device], pool.name, [slot], false);
      }

      // Re-read since pools.json may have changed during the evacuation, persisted per
      // device so a later failure cannot leave already removed members behind
      const pools = await this._readPools();
      const currentPool = pools.find(p => p.id === pool.id);
      if (currentPool) {
        currentPool.data_devices = currentPool.data_devices.filter(d => parseInt(d.slot) !== slot);
        await this._writePools(pools);
      }
    }
  }

  /**
   * Replace a device in a pool (remove old, add new)
   * @param {string} poolId - Pool ID
   * @param {string} oldDevice - Device path to replace
   * @param {string} newDevice - New device path
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} - Result object
   */
  async replaceDeviceInPool(poolId, oldDevice, newDevice, options = {}) {
    try {
      const pools = await this._readPools();
      const pool = pools.find(p => p.id === poolId);

      if (!pool) {
        throw new Error(`Pool with ID "${poolId}" not found`);
      }

      // Inject real device paths (e.g. /dev/sdj1 instead of /dev/disk/by-uuid/...)
      await this._injectRealDevicePaths(pool);

      // Check if old device exists in pool
      const oldDeviceExists = pool.data_devices.some(d => d.device === oldDevice);
      if (!oldDeviceExists) {
        throw new Error(`Device ${oldDevice} is not part of pool ${pool.name}`);
      }

      // Check if new device exists
      await fs.access(newDevice).catch(() => {
        throw new Error(`New device ${newDevice} does not exist`);
      });

      // Check if new device is already mounted
      const newDeviceMountStatus = await this._isDeviceMounted(newDevice);
      if (newDeviceMountStatus.isMounted) {
        throw new Error(`New device ${newDevice} is already mounted at ${newDeviceMountStatus.mountPoint}. Please unmount it first before replacing.`);
      }

      // Handle different pool types
      if (pool.type === 'btrfs') {
        return this._replaceBTRFSDevice(pool, oldDevice, newDevice, options);
      } else if (pool.type === 'bcachefs') {
        return this._replaceBcachefsDevice(pool, oldDevice, newDevice, options);
      } else if (pool.type === 'mergerfs') {
        // For MergerFS: Get the slot number of the old device first
        const oldDeviceInfo = pool.data_devices.find(d => d.device === oldDevice);
        const preservedSlot = oldDeviceInfo ? oldDeviceInfo.slot : null;

        // Check if pool has parity (SnapRAID)
        const hasSnapRAID = pool.parity_devices && pool.parity_devices.length > 0;

        // Check mount status BEFORE removing device (to restore after add)
        const poolMountPoint = path.join(this.mountBasePath, pool.name);
        const wasMounted = await this._isMounted(poolMountPoint);

        try {
          // Step 1: Remove old device first
          // Skip SnapRAID sync on remove - we'll do a fix instead after adding the new device
          console.log(`Removing old device ${oldDevice}...`);
          await this.removeDevicesFromPool(poolId, [oldDevice], {
            unmount: true,
            skipSnapraidSync: hasSnapRAID  // Skip sync for replace, we'll fix instead
          });

          // Step 2: Add new device with the same slot number
          console.log(`Adding new device ${newDevice} to slot ${preservedSlot}...`);
          const addResult = await this.addDevicesToPool(poolId, [newDevice], {
            ...options,
            preserveSlot: preservedSlot,
            remount: wasMounted
          });

          // Step 3: For pools with SnapRAID, start fix operation to restore data from parity
          let snapraidFixStarted = false;
          if (hasSnapRAID && wasMounted && preservedSlot) {
            try {
              console.log(`Starting SnapRAID fix for slot d${preservedSlot} to restore data from parity...`);
              await this.executeSnapRAIDOperation(pool.id, `fix -d d${preservedSlot}`);
              snapraidFixStarted = true;
            } catch (fixError) {
              console.warn(`Warning: Could not start SnapRAID fix after device replacement: ${fixError.message}`);
            }
          }

          const message = snapraidFixStarted
            ? `Successfully replaced device ${oldDevice} with ${newDevice} in pool '${pool.name}'. SnapRAID fix started to restore data.`
            : `Successfully replaced device ${oldDevice} with ${newDevice} in pool '${pool.name}'`;

          return {
            success: true,
            message,
            pool: addResult.pool,
            snapraidFixStarted
          };
        } catch (error) {
          throw new Error(`Failed to replace device: ${error.message}`);
        }
      } else {
        throw new Error(`Device replacement for ${pool.type} pools is not supported`);
      }
    } catch (error) {
      throw new Error(`Error replacing device: ${error.message}`);
    }
  }

  /**
   * Replace bcachefs device
   * bcachefs has no in-place replace: the new member joins first so redundancy never drops,
   * then the old one is evacuated onto the remaining members and removed in the background
   * @private
   */
  async _replaceBcachefsDevice(pool, oldDevice, newDevice, options) {
    const oldMember = pool.data_devices.find(d => d.device === oldDevice);

    await this.addDevicesToPool(pool.id, [newDevice], { ...options, group: oldMember.group });

    let removeResult;
    try {
      removeResult = await this.removeDevicesFromPool(pool.id, [oldDevice], {
        operation: `replacement of ${oldDevice} with ${newDevice}`
      });
    } catch (error) {
      throw new Error(`New device ${newDevice} was added, but removing ${oldDevice} failed: ${error.message}. Remove ${oldDevice} to finish the replacement.`);
    }

    return {
      success: true,
      message: `${newDevice} was added to bcachefs pool '${pool.name}', ${oldDevice} is evacuated and removed in the background`,
      pool: removeResult.pool
    };
  }

  /**
   * Replace BTRFS device
   * @private
   */
  async _replaceBTRFSDevice(pool, oldDevice, newDevice, options) {
    const mountPoint = path.join(this.mountBasePath, pool.name);
    const isMounted = await this._isMounted(mountPoint);

    if (!isMounted) {
      throw new Error(`Pool ${pool.name} must be mounted to replace devices`);
    }

    // Prepare new device (partition if needed)
    let deviceToUse = newDevice;

    if (options.format === true) {
      // format=true: Create partition if whole disk
      deviceToUse = await this._ensurePartition(newDevice);
    } else {
      // format=false: Check for existing partition
      const isPartition = this._isPartitionPath(newDevice);
      if (!isPartition) {
        const deviceInfo = await this.checkDeviceFilesystem(newDevice);
        if (deviceInfo.actualDevice) {
          deviceToUse = deviceInfo.actualDevice;
        } else if (deviceInfo.isFormatted && !['dos', 'gpt', 'mbr'].includes(deviceInfo.filesystem)) {
          deviceToUse = newDevice;
        } else {
          throw new Error(`Device ${newDevice} has no usable filesystem. Use format: true`);
        }
      }
    }

    // Handle LUKS encryption for new device if pool is encrypted
    let actualNewDevice = deviceToUse;
    let preparedDeviceInfo = null;
    const strategy = this._getDeviceStrategy(pool);

    const oldDeviceEntry = pool.data_devices.find(d => d.device === oldDevice);
    const oldSlot = oldDeviceEntry ? parseInt(oldDeviceEntry.slot) : null;
    let newSlot = oldSlot;

    if (pool.config?.encrypted) {
      console.log(`Setting up LUKS encryption for replacement device in pool '${pool.name}'`);

      if (!oldSlot) {
        throw new Error(`Could not determine the slot of device ${oldDevice} in pool ${pool.name}`);
      }

      // btrfs replace keeps the old member attached until it finishes, so its mapper stays
      // open - the replacement has to take a free slot instead of the one being vacated
      newSlot = this._findNextAvailableSlot(pool);

      const preparedDevices = await strategy.prepareDevices(
        [deviceToUse],
        pool,
        { ...options, config: pool.config, startSlot: newSlot, isParity: false }
      );

      preparedDeviceInfo = preparedDevices[0];
      actualNewDevice = strategy.getOperationalDevicePath(preparedDeviceInfo);

      console.log(`LUKS device opened for replacement: ${actualNewDevice} (slot ${newSlot})`);
    }

    try {
      // BTRFS replace command (use actual device - mapped for LUKS)
      await execPromise(`btrfs replace start ${oldDevice} ${actualNewDevice} ${mountPoint}`);

      // Wait for replace to complete (this could take a while)
      let replaceStatus;
      do {
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
        try {
          const { stdout } = await execPromise(`btrfs replace status ${mountPoint}`);
          replaceStatus = stdout;
        } catch (error) {
          // Replace might be finished
          break;
        }
      } while (replaceStatus && !replaceStatus.includes('finished'));

      // Get new device UUID - for encrypted pools this is the LUKS container UUID
      const newDeviceUuid = pool.config?.encrypted && preparedDeviceInfo
        ? await strategy.getDeviceUuid(preparedDeviceInfo, pool)
        : await this.getDeviceUuid(deviceToUse);

      // Update pool data structure
      const deviceIndex = pool.data_devices.findIndex(d => d.device === oldDevice);
      if (deviceIndex !== -1) {
        pool.data_devices[deviceIndex].device = deviceToUse;
        pool.data_devices[deviceIndex].id = newDeviceUuid;
        pool.data_devices[deviceIndex].slot = newSlot;
      }

      // The vacated mapper is no longer referenced by any member
      if (pool.config?.encrypted && oldSlot && oldSlot !== newSlot) {
        await this._closeLuksDevicesWithSlots([oldDevice], pool.name, [oldSlot]);
      }

      // Don't persist dynamic status info to pools.json
      // Status will be calculated dynamically when pools are retrieved

      // Save updated pool configuration (without status)
      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.id === pool.id);
      if (poolIndex !== -1) {
        pools[poolIndex] = pool;
        await this._writePools(pools);
      }

      return {
        success: true,
        message: `Successfully replaced device ${oldDevice} with ${newDevice} in BTRFS pool '${pool.name}'`,
        pool
      };
    } catch (error) {
      if (preparedDeviceInfo) {
        await strategy.cleanup([preparedDeviceInfo], pool).catch(cleanupError =>
          console.warn(`Warning: Could not cleanup LUKS device: ${cleanupError.message}`)
        );
      }
      throw new Error(`BTRFS device replacement failed: ${error.message}`);
    }
  }

  /**
   * Create a MergerFS pool with optional SnapRAID support
   * @param {string} name - Pool name
   * @param {string[]} devices - Array of device paths for data
   * @param {string} filesystem - Filesystem to use for formatting (if needed)
   * @param {Object} options - Additional options including snapraid device
   */
  async createMergerFSPool(name, devices, filesystem = 'xfs', options = {}) {
    const poolConfig = { name, config: options.config };
    const strategy = this._getDeviceStrategy(poolConfig);
    let preparedDataDevices = [];
    let preparedParityDevices = [];
    const mountedPaths = [];
    let creationLocked = false;

    try {
      // Validate inputs
      if (!name) throw new Error('Pool name is required');
      PoolHelpers.validatePoolName(name);
      if (!Array.isArray(devices) || devices.length === 0) {
        throw new Error('At least one data device is required for a MergerFS pool');
      }

      // Parallel requests (e.g. double submit) would race on the same disks
      PoolsService._mergerfsCreationsInProgress ??= new Set();
      if (PoolsService._mergerfsCreationsInProgress.has(name)) {
        throw new Error(`Pool "${name}" is already being created`);
      }
      PoolsService._mergerfsCreationsInProgress.add(name);
      creationLocked = true;

      // Auto-generate passphrase if needed
      if (options.config?.encrypted) {
        if (!options.passphrase || options.passphrase.trim() === '') {
          if (options.config?.create_keyfile) {
            options.passphrase = this._generateSecurePassphrase();
            console.log(`Generated secure passphrase for encrypted pool '${name}'`);
          } else {
            throw new Error('Passphrase is required for encrypted pools');
          }
        }
        if (options.passphrase.length < 8) {
          throw new Error('Passphrase must be at least 8 characters long for LUKS encryption');
        }

        // ZRAM devices cannot be encrypted
        for (const device of devices) {
          if (this._isZramDevice(device)) {
            throw new Error(`ZRAM device ${device} cannot be encrypted. ZRAM uses RAM compression and does not support LUKS.`);
          }
        }
      }

      // Read current pools data
      const pools = await this._readPools();

      // Check if pool exists
      if (pools.some(p => p.name === name)) {
        throw new Error(`Pool with name "${name}" already exists`);
      }

      // Check name does not collide with a MergerFS Path Pool (vpool)
      await PoolHelpers.assertNameNotInVpools(name);

      const mountPoint = path.join(this.mountBasePath, name);
      const mergerfsBasePath = path.join(this.mergerfsBasePath, name);

      // Handle SnapRAID devices if provided
      let snapraidDevices = [];
      if (options.snapraid && options.snapraid.device) {
        // Support both single device (string) and multiple devices (array)
        if (typeof options.snapraid.device === 'string' && options.snapraid.device.trim() !== '') {
          snapraidDevices = [options.snapraid.device.trim()];
        } else if (Array.isArray(options.snapraid.device) && options.snapraid.device.length > 0) {
          snapraidDevices = options.snapraid.device.filter(d => d && d.trim() !== '');
        }
      }

      // Every check has to pass before the first device is partitioned or formatted
      await this._assertDevicesUnused([...devices, ...snapraidDevices]);

      if (snapraidDevices.length > 0 && !options.skip_size_check) {
        let largestDataDevice = 0;
        for (const device of devices) {
          largestDataDevice = Math.max(largestDataDevice, await this.getDeviceSize(device));
        }

        for (const snapraidDevice of snapraidDevices) {
          if (await this.getDeviceSize(snapraidDevice) < largestDataDevice) {
            throw new Error('SnapRAID parity device must be at least as large as the largest data device');
          }
        }
      }

      // Prepare devices
      console.log('Preparing devices...');
      const preparedDevices = [];

      if (options.format === true) {
        // format=true: Create partitions and format
        for (const device of devices) {
          const preparedDevice = await this._ensurePartition(device);
          preparedDevices.push(preparedDevice);
        }
      } else {
        // format=false: Import mode - use existing filesystems as-is
        for (const device of devices) {
          const isPartition = this._isPartitionPath(device);
          if (!isPartition) {
            // Whole disk - check what's on it
            const deviceInfo = await this.checkDeviceFilesystem(device);
            if (deviceInfo.actualDevice) {
              // Has partition with filesystem - use the partition
              preparedDevices.push(deviceInfo.actualDevice);
            } else if (deviceInfo.isFormatted && !['dos', 'gpt', 'mbr'].includes(deviceInfo.filesystem)) {
              // Whole disk has filesystem directly (no partition) - use whole disk
              preparedDevices.push(device);
            } else {
              // No usable filesystem found
              throw new Error(`Device ${device} has no usable filesystem. Use format: true to create partition and format.`);
            }
          } else {
            // Already a partition - use as-is
            preparedDevices.push(device);
          }
        }
      }

      // Prepare data devices with Strategy Pattern (handles encryption)
      preparedDataDevices = await strategy.prepareDevices(
        preparedDevices,
        poolConfig,
        options
      );

      // Get operational devices for formatting/mounting
      const actualDevices = preparedDataDevices.map(d =>
        strategy.getOperationalDevicePath(d)
      );

      // Process each SnapRAID device
      const preparedSnapraidDevices = [];
      for (let snapraidIndex = 0; snapraidIndex < snapraidDevices.length; snapraidIndex++) {
        const snapraidDevice = snapraidDevices[snapraidIndex];

        // Prepare SnapRAID device
        console.log(`Preparing SnapRAID parity device ${snapraidIndex + 1} '${snapraidDevice}'...`);
        let preparedSnapraidDevice;
        if (options.format === true) {
          // format=true: Create partition and format
          preparedSnapraidDevice = await this._ensurePartition(snapraidDevice);
        } else {
          // format=false: Import mode - use existing filesystem as-is
          const isSnapraidPartition = this._isPartitionPath(snapraidDevice);
          if (!isSnapraidPartition) {
            // Whole disk - check what's on it
            const snapraidDeviceInfo = await this.checkDeviceFilesystem(snapraidDevice);
            if (snapraidDeviceInfo.actualDevice) {
              // Has partition with filesystem - use the partition
              preparedSnapraidDevice = snapraidDeviceInfo.actualDevice;
            } else if (snapraidDeviceInfo.isFormatted && !['dos', 'gpt', 'mbr'].includes(snapraidDeviceInfo.filesystem)) {
              // Whole disk has filesystem directly (no partition) - use whole disk
              preparedSnapraidDevice = snapraidDevice;
            } else {
              // No usable filesystem found
              throw new Error(`SnapRAID device ${snapraidDevice} has no usable filesystem. Use format: true to create partition and format.`);
            }
          } else {
            // Already a partition - use as-is
            preparedSnapraidDevice = snapraidDevice;
          }
        }

        // Validate SnapRAID filesystem BEFORE encryption (for format=false)
        if (options.format === false) {
          const snapraidMountStatus = await this._isDeviceMounted(preparedSnapraidDevice);
          if (snapraidMountStatus.isMounted) {
            throw new Error(`SnapRAID device ${preparedSnapraidDevice} is already mounted at ${snapraidMountStatus.mountPoint}. Please unmount it first before creating a pool.`);
          }

          const snapraidInfo = await this.checkDeviceFilesystem(preparedSnapraidDevice);
          if (!snapraidInfo.isFormatted) {
            throw new Error(`SnapRAID device ${preparedSnapraidDevice} has no filesystem. Use format: true to create partition and format.`);
          }
          if (snapraidInfo.filesystem !== filesystem) {
            throw new Error(`SnapRAID device ${preparedSnapraidDevice} has filesystem ${snapraidInfo.filesystem}, but ${filesystem} was requested. Use format: true to reformat.`);
          }
        }

        // Handle encryption for SnapRAID parity device if encryption is enabled
        let actualSnapraidDevice;
        if (options.config?.encrypted) {
          const parityDeviceInfo = await strategy.prepareDevices(
            [preparedSnapraidDevice],
            poolConfig,
            { ...options, isParity: true, startSlot: snapraidIndex + 1 }
          );
          preparedParityDevices.push(parityDeviceInfo[0]);
          actualSnapraidDevice = strategy.getOperationalDevicePath(parityDeviceInfo[0]);
        } else {
          actualSnapraidDevice = preparedSnapraidDevice;
        }

        // Store prepared SnapRAID device info
        preparedSnapraidDevices.push({
          originalDevice: snapraidDevice,
          preparedDevice: preparedSnapraidDevice,
          actualDevice: actualSnapraidDevice,
          index: snapraidIndex
        });
      }

      // Format devices if format=true (AFTER encryption setup)
      if (options.format === true) {
        // format=true: Format all devices (partitions already created, encryption already setup)
        for (let i = 0; i < devices.length; i++) {
          const actualDevice = actualDevices[i];

          // Check if device is already mounted
          const mountStatus = await this._isDeviceMounted(actualDevice);
          if (mountStatus.isMounted) {
            throw new Error(`Device ${actualDevice} is already mounted at ${mountStatus.mountPoint}. Please unmount it first before creating a pool.`);
          }

          // Format the device (LUKS device if encrypted, partition if not)
          await this.formatDevice(actualDevice, filesystem);
        }

        // Format SnapRAID devices if provided
        for (const snapraidInfo of preparedSnapraidDevices) {
          const snapraidMountStatus = await this._isDeviceMounted(snapraidInfo.actualDevice);
          if (snapraidMountStatus.isMounted) {
            throw new Error(`SnapRAID device ${snapraidInfo.actualDevice} is already mounted at ${snapraidMountStatus.mountPoint}. Please unmount it first before creating a pool.`);
          }
          await this.formatDevice(snapraidInfo.actualDevice, filesystem);
        }
      }
      // Note: format=false validation already done BEFORE encryption

      // Refresh device symlinks after formatting
      await this._refreshDeviceSymlinks();

      // Create mergerFS base directory with proper ownership
      const ownershipOptions = {
        uid: this.defaultOwnership.uid,
        gid: this.defaultOwnership.gid
      };
      await this._createDirectoryWithOwnership(mergerfsBasePath, ownershipOptions);

      // Create mount points for each device and collect device info
      const dataDevices = [];
      let diskIndex = 1;

      for (let i = 0; i < devices.length; i++) {
        const originalDevice = devices[i];
        const actualDevice = actualDevices[i]; // Use mapped device for LUKS
        const diskMountPoint = path.join(mergerfsBasePath, `disk${diskIndex}`);
        await this._createDirectoryWithOwnership(diskMountPoint, ownershipOptions);

        // Mount the device to its individual mount point
        const diskMountResult = await this.mountDevice(actualDevice, diskMountPoint);
        if (!diskMountResult.alreadyMounted) mountedPaths.push(diskMountPoint);

        // Get device UUID using Strategy (handles physical vs operational)
        const deviceInfo = preparedDataDevices[i];
        const deviceUuid = await strategy.getDeviceUuid(deviceInfo, poolConfig);

        dataDevices.push({
          slot: diskIndex,
          id: deviceUuid,
          filesystem,
          spindown: null
        });

        diskIndex++;
      }

      // Handle snapraid devices if provided
      let parityDevices = [];
      if (preparedSnapraidDevices.length > 0) {
        const snapraidPoolPath = path.join(this.snapraidBasePath, name);

        for (const snapraidInfo of preparedSnapraidDevices) {
          const parityIndex = snapraidInfo.index + 1;
          const snapraidMountPoint = path.join(snapraidPoolPath, `parity${parityIndex}`);
          await this._createDirectoryWithOwnership(snapraidMountPoint, ownershipOptions);

          // Mount the actual snapraid device (encrypted or not)
          const parityMountResult = await this.mountDevice(snapraidInfo.actualDevice, snapraidMountPoint, ownershipOptions);
          if (!parityMountResult.alreadyMounted) mountedPaths.push(snapraidMountPoint);

          // Get parity device UUID using Strategy
          let parityUuid;
          if (options.config?.encrypted && preparedParityDevices.length > 0) {
            parityUuid = await strategy.getDeviceUuid(preparedParityDevices[snapraidInfo.index], poolConfig);
          } else {
            // For non-encrypted: get UUID from actualDevice (the one that was formatted and mounted)
            parityUuid = await this.getDeviceUuid(snapraidInfo.actualDevice);
          }

          parityDevices.push({
            slot: parityIndex,
            id: parityUuid,
            filesystem,
            spindown: null
          });
        }
      }

      // Create the main mount point with proper ownership
      await this._createDirectoryWithOwnership(mountPoint, ownershipOptions);

      // Build the mergerfs command
      const mountPoints = dataDevices.map(device => path.join(mergerfsBasePath, `disk${device.slot}`)).join(':');

      // Extract policies from options or use defaults
      const createPolicy = options.policies?.create || 'mspmfs';
      const searchPolicy = options.policies?.search || 'ff';

      // Create pool configuration for MergerFS with provided policies
      const mergerfsConfig = {
        policies: {
          create: createPolicy,
          search: searchPolicy
        },
        minfreespace: options.minfreespace || "20G",
        moveonenospc: options.moveonenospc !== undefined ? options.moveonenospc : true,
        global_options: options.global_options || [
          "cache.files=off",
          "dropcacheonclose=true"
        ],
        shared: options.config?.shared || false
      };

      // Add SnapRAID config if applicable
      if (preparedSnapraidDevices.length > 0) {
        mergerfsConfig.sync = {
          enabled: false,
          schedule: "30 0 * * *",
          check: {
            enabled: false,
            schedule: "0 0 * */3 SUN"
          },
          scrub: {
            enabled: false,
            schedule: "0 4 * * WED"
          }
        };
      }

      // Create a pool entry
      const pool = {
        id: generateId(),
        name,
        type: 'mergerfs',
        automount: options.automount !== false,
        comment: options.comment || '',
        index: this._getNextPoolIndex(pools),
        data_devices: dataDevices,
        parity_devices: parityDevices,

        config: {
          ...mergerfsConfig,
          encrypted: options.config?.encrypted || false,
          unclean_check: true,
          usage_alert: { warning: 70, alert: 90 },
          ...(options.config || {})
        }
      };

      const mergerfsOptions = options.mergerfsOptions || this._buildMergerfsOptions(pool.config);
      await execPromise(`mergerfs -o ${mergerfsOptions} ${mountPoints} ${mountPoint}`);
      mountedPaths.push(mountPoint);

      // Make the mount point a shared mount if configured (for bind mount propagation)
      if (pool.config.shared === true) {
        try {
          await execPromise(`mount --make-shared "${mountPoint}"`);
          console.log(`Made pool mount point shared: ${mountPoint}`);
        } catch (sharedError) {
          console.warn(`Warning: Could not make mount shared: ${sharedError.message}`);
        }
      }

      // Add snapraid info if applicable
      if (preparedSnapraidDevices.length > 0) {
        // Create snapraid config directory if it doesn't exist
        const snapraidConfigDir = '/boot/config/snapraid';
        await fs.mkdir(snapraidConfigDir, { recursive: true });

        // Generate snapraid configuration file
        const snapraidConfigPath = path.join(snapraidConfigDir, `${name}.conf`);

        // Build the configuration content
        let snapraidConfig = `# SnapRAID configuration for ${name} pool\n`;
        snapraidConfig += `# Generated by MOS API on ${new Date().toISOString()}\n\n`;

        // Add parity file locations
        const snapraidPoolPath = path.join(this.snapraidBasePath, name);
        for (let i = 0; i < preparedSnapraidDevices.length; i++) {
          const parityIndex = i + 1;
          const snapraidMountPoint = path.join(snapraidPoolPath, `parity${parityIndex}`);
          if (i === 0) {
            snapraidConfig += `parity ${snapraidMountPoint}/.snapraid.parity\n`;
          } else {
            snapraidConfig += `${parityIndex}-parity ${snapraidMountPoint}/.snapraid.${parityIndex}-parity\n`;
          }
        }

        // Add content file locations - one for each data disk and one for each parity
        dataDevices.forEach((device, index) => {
          const diskMountPoint = path.join(mergerfsBasePath, `disk${index + 1}`);
          snapraidConfig += `content ${diskMountPoint}/.snapraid\n`;
        });
        for (let i = 0; i < preparedSnapraidDevices.length; i++) {
          const parityIndex = i + 1;
          const snapraidMountPoint = path.join(snapraidPoolPath, `parity${parityIndex}`);
          snapraidConfig += `content ${snapraidMountPoint}/.snapraid.content\n`;
        }
        snapraidConfig += '\n';

        // Add data disks with unique IDs
        dataDevices.forEach((device, index) => {
          const diskId = `d${index + 1}`;
          const diskMountPoint = path.join(mergerfsBasePath, `disk${index + 1}`);
          snapraidConfig += `data ${diskId} ${diskMountPoint}\n`;
        });
        snapraidConfig += '\n';

        // Add standard exclusion patterns
        snapraidConfig += `exclude *.tmp\n`;
        snapraidConfig += `exclude *.temp\n`;
        snapraidConfig += `exclude *.log\n`;
        snapraidConfig += `exclude *.bak\n`;
        snapraidConfig += `exclude Thumbs.db\n`;
        snapraidConfig += `exclude .DS_Store\n`;
        snapraidConfig += `exclude .AppleDouble\n`;
        snapraidConfig += `exclude ._*\n`;
        snapraidConfig += `exclude .Spotlight-V100\n`;
        snapraidConfig += `exclude .Trashes\n`;
        snapraidConfig += `exclude .fseventsd\n`;
        snapraidConfig += `exclude .DocumentRevisions-V100\n`;
        snapraidConfig += `exclude .TemporaryItems\n`;
        snapraidConfig += `exclude lost+found/\n`;
        snapraidConfig += `exclude .recycle/\n`;
        snapraidConfig += `exclude $RECYCLE.BIN/\n`;
        snapraidConfig += `exclude System Volume Information/\n`;
        snapraidConfig += `exclude pagefile.sys\n`;
        snapraidConfig += `exclude hiberfil.sys\n`;
        snapraidConfig += `exclude swapfile.sys\n`;

        // Write the configuration file
        await fs.writeFile(snapraidConfigPath, snapraidConfig);
      }

      // Don't persist dynamic status info to pools.json
      // Status will be calculated dynamically when pools are retrieved

      // Save the pool
      pools.push(pool);
      await this._writePools(pools);

      return {
        success: true,
        message: `Successfully created MergerFS pool "${name}"${preparedSnapraidDevices.length > 0 ? ` with ${preparedSnapraidDevices.length} SnapRAID parity device(s)` : ''}`,
        pool
      };
    } catch (error) {
      // Mounts must be released before LUKS mappers can be closed
      for (const mountedPath of mountedPaths.reverse()) {
        try {
          await execPromise(`umount "${mountedPath}"`);
          await fs.rmdir(mountedPath).catch(() => {});
        } catch (unmountError) {
          console.warn(`Failed to unmount ${mountedPath}: ${unmountError.message}`);
        }
      }

      // Cleanup on error using Strategy
      if (preparedDataDevices.length > 0) {
        try {
          await strategy.cleanup(preparedDataDevices, poolConfig);
        } catch (cleanupError) {
          console.warn(`Data device cleanup failed: ${cleanupError.message}`);
        }
      }
      if (preparedParityDevices.length > 0) {
        try {
          await strategy.cleanup(preparedParityDevices, poolConfig);
        } catch (cleanupError) {
          console.warn(`Parity device cleanup failed: ${cleanupError.message}`);
        }
      }
      throw new Error(`Error creating MergerFS pool: ${error.message}`);
    } finally {
      if (creationLocked) PoolsService._mergerfsCreationsInProgress.delete(name);
    }
  }

  /**
   * Create a NonRAID pool with optional parity support
   * @param {string} name - Pool name
   * @param {string[]} devices - Array of device paths for data
   * @param {string} filesystem - Filesystem to use for formatting (if needed)
   * @param {Object} options - Additional options including parity devices and parity_valid flag
   */
  async createNonRaidPool(name, devices, filesystem = 'xfs', options = {}) {
    const poolConfig = { name, config: options.config };
    const strategy = this._getDeviceStrategy(poolConfig);
    let preparedDataDevices = [];
    let mountedDataDevices = [];
    let openedLuksDevices = [];
    let reservedDisks = [];
    let moduleLoaded = false;

    try {
      // Validate inputs
      if (!name) throw new Error('Pool name is required');
      PoolHelpers.validatePoolName(name);
      if (!Array.isArray(devices) || devices.length === 0) {
        throw new Error('At least one data device is required for a NonRAID pool');
      }
      if (devices.length > 28) {
        throw new Error('NonRAID pools support a maximum of 28 data devices');
      }

      // Check if kernel module is available
      try {
        await execPromise('modinfo md-nonraid');
      } catch (error) {
        throw new Error('NonRAID kernel module md-nonraid is not available on this system');
      }

      // Read current pools data
      const pools = await this._readPools();

      // nonraid.dat holds the array of the existing pool and is deleted further down
      const existingNonRaidPool = pools.find(p => p.type === 'nonraid');
      if (existingNonRaidPool) {
        throw new Error(`Only one NonRAID pool is allowed per system. Pool "${existingNonRaidPool.name}" already exists.`);
      }

      // Auto-generate passphrase if needed
      if (options.config?.encrypted) {
        if (!options.passphrase || options.passphrase.trim() === '') {
          if (options.config?.create_keyfile) {
            options.passphrase = this._generateSecurePassphrase();
            console.log(`Generated secure passphrase for encrypted pool '${name}'`);
          } else {
            throw new Error('Passphrase is required for encrypted pools');
          }
        }
        if (options.passphrase.length < 8) {
          throw new Error('Passphrase must be at least 8 characters long for LUKS encryption');
        }
      }

      // Check if pool exists
      if (pools.some(p => p.name === name)) {
        throw new Error(`Pool with name "${name}" already exists`);
      }

      // Check name does not collide with a MergerFS Path Pool (vpool)
      await PoolHelpers.assertNameNotInVpools(name);

      // Handle parity devices if provided
      let parityDevices = [];
      if (options.parity && Array.isArray(options.parity) && options.parity.length > 0) {
        if (options.parity.length > 2) {
          throw new Error('NonRAID pools support a maximum of 2 parity devices');
        }
        parityDevices = options.parity;
      }

      // Validate parity devices are not in data devices
      for (const parityDevice of parityDevices) {
        if (devices.includes(parityDevice)) {
          throw new Error('Parity device cannot also be used as a data device');
        }
      }

      // Every check has to pass before nonraid.dat is deleted and devices are partitioned
      await this._assertDevicesUnused([...devices, ...parityDevices]);
      reservedDisks = await this._reserveDisks([...devices, ...parityDevices]);

      // Validate parity devices up front - partitioning/formatting the data
      // devices later on is destructive and must not run into a parity error
      const parityByIds = new Map();
      if (parityDevices.length > 0) {
        let largestDataDevice = 0;
        let largestDataDeviceName = null;
        for (const device of devices) {
          const deviceSize = await this.getDeviceSize(device);
          if (deviceSize > largestDataDevice) {
            largestDataDevice = deviceSize;
            largestDataDeviceName = device;
          }
        }

        for (const parityDevice of parityDevices) {
          const paritySize = await this.getDeviceSize(parityDevice);
          if (paritySize < largestDataDevice) {
            throw new Error(
              `Parity device must be at least as large as the largest data device: ` +
              `${parityDevice} (${paritySize} bytes) is smaller than ` +
              `${largestDataDeviceName} (${largestDataDevice} bytes)`
            );
          }

          const byIdPath = await this._getDeviceByIdPath(parityDevice);
          if (!byIdPath) {
            throw new Error(`Could not find /dev/disk/by-id/ path for parity device ${parityDevice}`);
          }
          parityByIds.set(parityDevice, byIdPath);
        }
      }

      const mountPoint = path.join(this.mountBasePath, name);
      const nonraidBasePath = path.join(this.mergerfsBasePath, name);

      // Prepare devices
      console.log('Preparing devices...');
      const preparedDevices = [];

      if (options.format === true) {
        // format=true: Create partitions and format
        for (const device of devices) {
          const preparedDevice = await this._ensurePartition(device);
          preparedDevices.push(preparedDevice);
        }
      } else {
        // format=false: Import mode - use existing filesystems as-is
        for (const device of devices) {
          const isPartition = this._isPartitionPath(device);
          if (!isPartition) {
            // Whole disk - check what's on it
            const deviceInfo = await this.checkDeviceFilesystem(device);
            if (deviceInfo.actualDevice) {
              // Has partition with filesystem - use the partition
              preparedDevices.push(deviceInfo.actualDevice);
            } else if (deviceInfo.isFormatted && !['dos', 'gpt', 'mbr'].includes(deviceInfo.filesystem)) {
              // Whole disk has filesystem directly (no partition) - use whole disk
              preparedDevices.push(device);
            } else {
              // No usable filesystem found
              throw new Error(`Device ${device} has no usable filesystem. Use format: true to create partition and format.`);
            }
          } else {
            // Already a partition - use as-is
            preparedDevices.push(device);
          }
        }
      }

      // Delete existing nonraid.dat if it exists (only during pool creation)
      const nonraidDatPath = '/boot/config/system/nonraid.dat';
      try {
        await fs.access(nonraidDatPath);
        await fs.unlink(nonraidDatPath);
        console.log('Deleted existing nonraid.dat');
      } catch (error) {
        // File doesn't exist - that's fine
      }

      // Load the md-nonraid module
      console.log('Loading md-nonraid kernel module...');
      await execPromise(`modprobe md-nonraid super=${nonraidDatPath}`);
      moduleLoaded = true;

      // Encrypted NonRAID pools put LUKS on top of md-nonraid: the raw partition is imported
      // into the array first and the container is created on /dev/nmd<slot>p1 afterwards, so
      // every write passes the parity layer. The array already needs a disk id at import time,
      // so the container UUID is pinned up front instead of being read back later.
      const isEncrypted = poolConfig.config?.encrypted === true;
      const deviceUuids = [];
      const luksUuids = [];

      for (let i = 0; i < preparedDevices.length; i++) {
        const preparedDevice = preparedDevices[i];

        const mountStatus = await this._isDeviceMounted(preparedDevice);
        if (mountStatus.isMounted) {
          throw new Error(`Device ${preparedDevice} is already mounted at ${mountStatus.mountPoint}. Please unmount it first before creating a pool.`);
        }

        if (isEncrypted) {
          if (options.format === true) {
            const newUuid = crypto.randomUUID();
            luksUuids.push(newUuid);
            deviceUuids.push(newUuid);
          } else {
            // Import mode: the container already exists, its header sits on the raw partition
            luksUuids.push(null);
            deviceUuids.push(await this.getDeviceUuid(preparedDevice));
          }
        } else {
          if (options.format === true) {
            await this.formatDevice(preparedDevice, filesystem, { nodiscard: true });
          }
          deviceUuids.push(await this.getDeviceUuid(preparedDevice));
        }
      }

      // Refresh device symlinks after formatting
      await this._refreshDeviceSymlinks();

      // Create nonraid base directory with proper ownership
      const ownershipOptions = {
        uid: this.defaultOwnership.uid,
        gid: this.defaultOwnership.gid
      };
      await this._createDirectoryWithOwnership(nonraidBasePath, ownershipOptions);

      // Prepare parity devices (get by-id paths)
      const preparedParityDevices = [];
      for (let i = 0; i < parityDevices.length; i++) {
        const parityDevice = parityDevices[i];
        const byIdPath = parityByIds.get(parityDevice);

        // Get device size from physical device (not partition)
        const deviceSize = await this._getDeviceSizeInKB(parityDevice);

        preparedParityDevices.push({
          originalDevice: parityDevice,
          byIdPath: byIdPath,
          size: deviceSize,
          slot: i === 0 ? 0 : 29  // First parity = slot 0, second = slot 29
        });
      }

      // Import data devices into NonRAID array
      console.log('Importing data devices into NonRAID array...');
      const dataDevices = [];

      for (let i = 0; i < devices.length; i++) {
        const slot = i + 1;  // Slots 1-28 for data
        const physicalPartition = preparedDevices[i];  // Physical partition (for size calculation)
        const deviceUuid = deviceUuids[i];

        // Get device size from physical partition (not mapper)
        const deviceSize = await this._getDeviceSizeInKB(physicalPartition);

        // Get basename for import command
        const deviceBasename = path.basename(physicalPartition);

        // Import device into NonRAID array
        const importCmd = `echo "import ${slot} ${deviceBasename} 0 ${deviceSize} 0 ${deviceUuid}" > /proc/nmdcmd`;
        console.log(`Importing data device slot ${slot}: ${importCmd}`);
        await execPromise(importCmd);

        dataDevices.push({
          slot: slot,
          id: deviceUuid,
          filesystem,
          spindown: null
        });
      }

      // Import parity devices if provided
      const parityDevicesList = [];
      for (const parityInfo of preparedParityDevices) {
        const deviceBasename = path.basename(parityInfo.originalDevice);

        // Import parity device (slot 0 or 29, using by-id path as ID)
        const importCmd = `echo "import ${parityInfo.slot} ${deviceBasename} 0 ${parityInfo.size} 0 ${parityInfo.byIdPath}" > /proc/nmdcmd`;
        console.log(`Importing parity device slot ${parityInfo.slot}: ${importCmd}`);
        await execPromise(importCmd);

        // In JSON, parity slot 1 = array slot 0, parity slot 2 = array slot 29
        const jsonSlot = parityInfo.slot === 0 ? 1 : 2;
        parityDevicesList.push({
          slot: jsonSlot,
          id: parityInfo.byIdPath,
          filesystem: filesystem,
          spindown: null
        });
      }

      // Start the NonRAID array
      console.log('Starting NonRAID array...');
      if (options.parity_valid === true && parityDevicesList.length > 0) {
        // If parity is already valid, set invalidslot first
        await execPromise('echo "set invalidslot 99 99" > /proc/nmdcmd');
        console.log('Set parity as valid');
      }
      await execPromise('echo "start NEW_ARRAY" > /proc/nmdcmd');
      console.log('NonRAID array started');

      // Set write mode based on config
      const writeMode = options.config?.md_writemode || 'normal';
      await this._setNonRaidWriteMode(writeMode);

      // Set up LUKS on the md devices now that the array is running
      const operationalDevices = dataDevices.map(d => `/dev/nmd${d.slot}p1`);

      if (isEncrypted) {
        preparedDataDevices = await strategy.prepareDevices(
          operationalDevices,
          poolConfig,
          { ...options, slots: dataDevices.map(d => d.slot), luksUuids }
        );

        for (let i = 0; i < preparedDataDevices.length; i++) {
          operationalDevices[i] = strategy.getOperationalDevicePath(preparedDataDevices[i]);
          if (options.format === true) {
            await this.formatDevice(operationalDevices[i], filesystem, { nodiscard: true });
          }
        }

        await this._refreshDeviceSymlinks();
      }

      // Mount data devices
      console.log('Mounting data devices...');
      for (let i = 0; i < dataDevices.length; i++) {
        const slot = dataDevices[i].slot;
        const diskMountPoint = path.join(nonraidBasePath, `disk${slot}`);

        await this._createDirectoryWithOwnership(diskMountPoint, ownershipOptions);
        await execPromise(`mount -t ${filesystem} -o nodiscard ${operationalDevices[i]} ${diskMountPoint}`);
        mountedDataDevices.push(diskMountPoint);
        console.log(`Mounted ${operationalDevices[i]} to ${diskMountPoint}`);
      }

      // Parity is only built after the filesystems exist, so the check does not race the
      // LUKS format and mkfs writes
      const shouldRunCheck = options.parity_valid !== true && parityDevicesList.length > 0;
      if (shouldRunCheck) {
        const checkStarted = await this._startNonRaidParityCheck();
        if (checkStarted) {
          this._startNonRaidMonitor(name, 'check CORRECT', true);
        }
      }

      // Create the main mount point with proper ownership
      await this._createDirectoryWithOwnership(mountPoint, ownershipOptions);

      // Build the mergerfs command for main pool mount
      const mountPoints = dataDevices.map(device => path.join(nonraidBasePath, `disk${device.slot}`)).join(':');

      // Extract policies from options or use defaults
      const createPolicy = options.policies?.create || 'mspmfs';
      const searchPolicy = options.policies?.search || 'ff';

      // Create pool configuration for NonRAID with provided policies
      const nonraidConfig = {
        policies: {
          create: createPolicy,
          search: searchPolicy
        },
        minfreespace: options.minfreespace || "20G",
        moveonenospc: options.moveonenospc !== undefined ? options.moveonenospc : true,
        global_options: options.global_options || [
          "cache.files=off",
          "dropcacheonclose=true"
        ],
        encrypted: options.config?.encrypted || false,
        shared: options.config?.shared || false,
        unclean_check: true,
        md_writemode: options.config?.md_writemode || 'normal', // normal or turbo
        usage_alert: { warning: 70, alert: 90 },
        ...(options.config || {})
      };

      // Add check config if parity devices exist
      if (parityDevicesList.length > 0) {
        nonraidConfig.check = {
          enabled: false,
          schedule: "0 5 * * SUN"
        };
      }

      const mergerfsOptions = options.mergerfsOptions || this._buildMergerfsOptions(nonraidConfig);
      await execPromise(`mergerfs -o ${mergerfsOptions} ${mountPoints} ${mountPoint}`);

      // Make the mount point a shared mount if configured (for bind mount propagation)
      if (nonraidConfig.shared === true) {
        try {
          await execPromise(`mount --make-shared "${mountPoint}"`);
          console.log(`Made pool mount point shared: ${mountPoint}`);
        } catch (sharedError) {
          console.warn(`Warning: Could not make mount shared: ${sharedError.message}`);
        }
      }

      // Create a pool entry
      const pool = {
        id: generateId(),
        name,
        type: 'nonraid',
        automount: options.automount !== false,
        comment: options.comment || '',
        index: this._getNextPoolIndex(pools),
        data_devices: dataDevices,
        parity_devices: parityDevicesList,
        config: nonraidConfig,
        path_rules: []
      };

      // Save the pool
      pools.push(pool);
      await this._writePools(pools);

      // Build success message
      let message = `Successfully created NonRAID pool "${name}"`;
      if (parityDevicesList.length > 0) {
        message += ` with ${parityDevicesList.length} parity device(s)`;
        if (options.parity_valid !== true) {
          message += '. Parity check started';
        }
      }

      return {
        success: true,
        message,
        pool
      };
    } catch (error) {
      console.error(`Error creating NonRAID pool: ${error.message}`);

      // Cleanup on error
      try {
        // Unmount data devices
        for (const mountPoint of mountedDataDevices) {
          try {
            await execPromise(`umount ${mountPoint}`);
          } catch (e) {
            console.warn(`Failed to unmount ${mountPoint}: ${e.message}`);
          }
        }

        // Close LUKS devices if encrypted
        if (options.config?.encrypted && preparedDataDevices.length > 0) {
          try {
            await strategy.cleanup(preparedDataDevices, poolConfig);
          } catch (cleanupError) {
            console.warn(`LUKS cleanup failed: ${cleanupError.message}`);
          }
        }

        // An early validation error must not touch an already running NonRAID pool
        if (moduleLoaded) {
          // Cancel any running checks first
          try {
            await execPromise('echo "nocheck CANCEL" > /proc/nmdcmd');
          } catch (e) {
            // Ignore error - no check was running
          }

          try {
            await execPromise('echo "stop" > /proc/nmdcmd');

            // Unload module ONLY if stop was successful
            try {
              await execPromise('modprobe -r md-nonraid');
            } catch (e) {
              console.warn(`Failed to unload md-nonraid module: ${e.message}`);
            }
          } catch (e) {
            console.warn(`Failed to stop NonRAID array: ${e.message}`);
          }
        }

      } catch (cleanupError) {
        console.error(`Cleanup error: ${cleanupError.message}`);
      }

      throw new Error(`Error creating NonRAID pool: ${error.message}`);
    } finally {
      PoolHelpers.releaseDisks(reservedDisks);
    }
  }

  /**
   * Get device path from /dev/disk/by-id/ (preferring non wwn-/scsi- entries)
   * @param {string} device - Device path (e.g., /dev/sda)
   * @returns {Promise<string|null>} - by-id path or null if not found
   * @private
   */
  async _getDeviceByIdPath(device) {
    try {
      const deviceBasename = path.basename(device);
      const { stdout } = await execPromise(`ls -l /dev/disk/by-id/ | grep "${deviceBasename}$"`);

      const lines = stdout.trim().split('\n');
      let fallback = null;
      for (const line of lines) {
        const match = line.match(/([^\s]+)\s+->\s+/);
        if (match) {
          const byIdName = match[1];
          // wwn-/scsi- only as fallback, disks without serial
          if (!byIdName.startsWith('wwn-') && !byIdName.startsWith('scsi-')) {
            return byIdName;
          }
          if (!fallback) fallback = byIdName;
        }
      }

      return fallback;
    } catch (error) {
      console.error(`Error getting by-id path for ${device}: ${error.message}`);
      return null;
    }
  }

  /**
   * Start the NonRAID array; the driver only accepts "start <state>" if it matches the current mdState
   * @returns {Promise<string>} - mdState before start
   * @private
   */
  async _startNonRaidArray() {
    const { stdout } = await execPromise('cat /proc/nmdstat');
    const mdState = (stdout.match(/^mdState=(.*)$/m)?.[1] || '').trim();

    if (mdState === 'STARTED') return mdState;
    // SWAP_DSBL needs the old parity copied manually before the start
    if (!mdState || mdState.startsWith('ERROR') || mdState === 'SWAP_DSBL') {
      throw new Error(`Cannot start NonRAID pool in state "${mdState || 'unknown'}"`);
    }

    const cmd = mdState === 'STOPPED' ? 'start' : `start ${mdState}`;
    console.log(`Starting NonRAID array (mdState=${mdState}): ${cmd}`);
    await execPromise(`echo "${cmd}" > /proc/nmdcmd`);
    return mdState;
  }

  async _hasLuksKeyfile(poolName) {
    return fs.access(`/boot/config/system/luks/${poolName}.key`).then(() => true, () => false);
  }

  async _getPartUuid(device) {
    try {
      const { stdout } = await execPromise(`blkid -s PARTUUID -o value ${device}`);
      return stdout.trim() || null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Parse /proc/nmdstat into a key/value map
   * @returns {Promise<Object|null>} - Values or null if not available
   * @private
   */
  async _readNmdstat() {
    try {
      const { stdout } = await execPromise('cat /proc/nmdstat');
      const values = {};
      for (const line of stdout.split('\n')) {
        const idx = line.indexOf('=');
        if (idx > 0) values[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      return values;
    } catch (error) {
      return null;
    }
  }

  /**
   * Data slots known to the driver but not yet in pools.json, i.e. new disks waiting for clear + format
   * @private
   */
  _getNonRaidPendingSlots(pool, nmdstat) {
    const known = new Set((pool.data_devices || []).map(d => parseInt(d.slot)));
    const pending = [];
    for (let slot = 1; slot <= 28; slot++) {
      const id = nmdstat?.[`diskId.${slot}`];
      if (id && !known.has(slot)) pending.push({ slot, id });
    }
    return pending;
  }

  /**
   * Allow only one NonRAID device change at a time, a disk that is still being cleared counts as running
   * Release with PoolsService._nonRaidDeviceChangeActive = false once the change is done
   * @private
   */
  async _lockNonRaidDeviceChange(pool) {
    if (PoolsService._nonRaidDeviceChangeActive) {
      throw new Error(`Another device operation is already running for pool ${pool.name}`);
    }
    PoolsService._nonRaidDeviceChangeActive = true;

    try {
      let nmdstat = await this._readNmdstat();
      if (!nmdstat) {
        // Pending disks are only known to the superblock, which needs the module to be read
        await execPromise('modprobe md-nonraid super=/boot/config/system/nonraid.dat');
        nmdstat = await this._readNmdstat();
        await execPromise('modprobe -r md-nonraid').catch(() => {});
      }

      const [pending] = this._getNonRaidPendingSlots(pool, nmdstat);
      if (pending) {
        throw new Error(`A new disk is still being added to slot ${pending.slot} of pool ${pool.name}. Please wait until it is formatted and ready.`);
      }
    } catch (error) {
      PoolsService._nonRaidDeviceChangeActive = false;
      throw error;
    }
  }

  /**
   * Continue adding pending data disks: restart clearing if needed, otherwise format them
   * @param {string|null} passphrase - Passphrase for encrypted pools without keyfile
   * @private
   */
  async _resumePendingNonRaidDisks(passphrase = null) {
    const nmdstat = await this._readNmdstat();
    if (nmdstat?.mdState !== 'STARTED') return;

    const pools = await this._readPools();
    const pool = pools.find(p => p.type === 'nonraid');
    const pendingSlots = pool ? this._getNonRaidPendingSlots(pool, nmdstat) : [];
    if (pendingSlots.length === 0) return;

    // Reservations live in memory only and have to be restored after an API restart
    for (const { slot, id } of pendingSlots) {
      const pending = this._nonRaidPendingDisks.get(slot) || {};
      if (pending.reservedDisks) continue;
      const device = await this.getRealDevicePathFromUuid(id);
      if (!device || PoolHelpers.isDiskPreparing(device)) continue;
      this._nonRaidPendingDisks.set(slot, { ...pending, reservedDisks: PoolHelpers.reserveDisks([device]) });
    }

    if (await this._isNonRaidParityOperationRunning()) return;

    if (nmdstat.mdResyncAction === 'clear') {
      if (await this._startNonRaidParityCheck()) {
        this._startNonRaidMonitor(pool.name, 'clear', true);
      }
      return;
    }

    await this._finalizePendingNonRaidDisks(passphrase);
  }

  /**
   * Format cleared pending data disks and add them to pools.json
   * @param {string|null} passphrase - Passphrase for encrypted pools without keyfile
   * @private
   */
  async _finalizePendingNonRaidDisks(passphrase = null) {
    if (PoolsService._nonRaidFinalizing) return;
    PoolsService._nonRaidFinalizing = true;

    try {
      const nmdstat = await this._readNmdstat();
      if (nmdstat?.mdState !== 'STARTED' || nmdstat.mdResyncAction === 'clear') return;

      const pools = await this._readPools();
      const pool = pools.find(p => p.type === 'nonraid');
      if (!pool) return;

      for (const { slot, id } of this._getNonRaidPendingSlots(pool, nmdstat)) {
        try {
          await this._formatPendingNonRaidDisk(pool, slot, id, passphrase);
        } catch (error) {
          console.error(`Failed to format new NonRAID disk in slot ${slot}: ${error.message}`);
          sendNotification('nonraid', `Formatting new disk in slot ${slot} of Pool ${pool.name} failed: ${error.message}`, 'alert')
            .catch(err => console.warn(`Failed to send NonRAID notification: ${err.message}`));
        }
      }
    } finally {
      PoolsService._nonRaidFinalizing = false;
    }
  }

  /**
   * @private
   */
  async _formatPendingNonRaidDisk(pool, slot, id, passphrase) {
    const nmdDevice = `/dev/nmd${slot}p1`;

    // A cleared disk carries no signature; anything else must not be formatted automatically
    const existingType = await execPromise(`blkid -p -s TYPE -o value ${nmdDevice}`)
      .then(({ stdout }) => stdout.trim(), () => '');
    if (existingType) {
      console.warn(`Skipping NonRAID slot ${slot}: ${nmdDevice} already contains ${existingType}`);
      return;
    }

    const pending = this._nonRaidPendingDisks.get(slot) || {};
    const filesystem = pending.filesystem || pool.data_devices[0]?.filesystem || 'xfs';
    const key = passphrase || pending.passphrase || null;
    let strategy = null;
    let prepared = null;
    let target = nmdDevice;

    if (pool.config?.encrypted) {
      if (!key && !await this._hasLuksKeyfile(pool.name)) {
        sendNotification('nonraid', `New disk in slot ${slot} of Pool ${pool.name} is cleared. Mount the pool with passphrase to format it.`, 'alert')
          .catch(err => console.warn(`Failed to send NonRAID notification: ${err.message}`));
        return;
      }
      strategy = this._getDeviceStrategy({ name: pool.name, config: pool.config });
      [prepared] = await strategy.prepareDevices([nmdDevice], pool, {
        passphrase: key,
        config: pool.config,
        format: true,
        slots: [slot]
      });
      target = strategy.getOperationalDevicePath(prepared);
    }

    const closeLuks = async () => {
      if (!prepared) return;
      await strategy.cleanup([prepared], pool)
        .catch(err => console.warn(`LUKS cleanup failed: ${err.message}`));
    };

    try {
      await this.formatDevice(target, filesystem, { nodiscard: true });
    } catch (error) {
      await closeLuks();
      throw error;
    }

    const pools = await this._readPools();
    const nonraidPool = pools.find(p => p.type === 'nonraid');
    nonraidPool.data_devices.push({ slot, id, filesystem, spindown: null });
    await this._writePools(pools);
    PoolHelpers.releaseDisks(pending.reservedDisks || []);
    this._nonRaidPendingDisks.delete(slot);

    const mountPoint = path.join(this.mountBasePath, pool.name);
    if (await this._isMounted(mountPoint)) {
      const diskMountPoint = path.join(this.mergerfsBasePath, pool.name, `disk${slot}`);
      let diskMounted = false;
      try {
        await this._createDirectoryWithOwnership(diskMountPoint);
        await execPromise(`mount -t ${filesystem} -o nodiscard ${target} ${diskMountPoint}`);
        diskMounted = true;
        await execPromise(`setfattr -n user.mergerfs.branches -v "+>${diskMountPoint}" ${mountPoint}/.mergerfs`);
        // LUKS stays open while the disk is part of the pool
        prepared = null;
      } catch (error) {
        // A leftover mount would make the next pool mount fail on this slot
        if (diskMounted) {
          await execPromise(`umount "${diskMountPoint}"`)
            .catch(err => console.warn(`Failed to unmount ${diskMountPoint}: ${err.message}`));
        }
        await fs.rmdir(diskMountPoint).catch(() => {});
        console.warn(`Could not attach ${diskMountPoint} to the running pool, it is used after the next mount: ${error.message}`);
      }
    }
    await closeLuks();

    console.log(`New NonRAID disk in slot ${slot} formatted with ${filesystem} and added to pool ${pool.name}`);
    sendNotification('nonraid', `New disk in slot ${slot} of Pool ${pool.name} is formatted and ready to use`, 'normal')
      .catch(err => console.warn(`Failed to send NonRAID notification: ${err.message}`));
  }

  /**
   * Set NonRAID write mode with retries
   * @param {string} mode - Write mode (normal or turbo)
   * @param {number} maxAttempts - Maximum number of attempts (default: 10)
   * @param {number} delayMs - Delay between attempts in milliseconds (default: 2000)
   * @returns {Promise<boolean>} - True if mode set successfully, false otherwise
   * @private
   */
  async _setNonRaidWriteMode(mode = 'normal', maxAttempts = 10, delayMs = 2000) {
    const modeValue = mode === 'turbo' ? 1 : 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`Attempting to set write mode to ${mode} (${modeValue}) (attempt ${attempt}/${maxAttempts})...`);
        await execPromise(`echo "set md_write_method ${modeValue}" > /proc/nmdcmd`);
        console.log(`Write mode set to ${mode} successfully`);
        return true;
      } catch (error) {
        if (attempt < maxAttempts) {
          console.log(`Pool not ready yet, waiting ${delayMs}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        } else {
          console.warn(`Warning: Could not set write mode after ${maxAttempts} attempts: ${error.message}`);
          console.warn('Continuing with default write mode...');
          return false;
        }
      }
    }
    return false;
  }

  /**
   * Try to start NonRAID parity check with retries
   * @param {number} maxAttempts - Maximum number of attempts (default: 10)
   * @param {number} delayMs - Delay between attempts in milliseconds (default: 2000)
   * @returns {Promise<boolean>} - True if check started successfully, false otherwise
   * @private
   */
  async _startNonRaidParityCheck(maxAttempts = 10, delayMs = 2000) {
    await execPromise('cat /proc/nmdstat');
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`Attempting to start parity check (attempt ${attempt}/${maxAttempts})...`);
        // Like nmdctl: clear, parity reconstruction and re-sync after an import must write parity
        await execPromise('echo "check CORRECT" > /proc/nmdcmd');
        console.log('Parity check started successfully');
        return true;
      } catch (error) {
        if (attempt < maxAttempts) {
          console.log(`Check not ready yet, waiting ${delayMs}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        } else {
          console.warn(`Warning: Could not start parity check after ${maxAttempts} attempts: ${error.message}`);
          return false;
        }
      }
    }
    return false;
  }

  /**
   * Get device size in KB (using blockdev --getsz divided by 2)
   * @param {string} device - Device path
   * @returns {Promise<number>} - Size in KB
   * @private
   */
  async _getDeviceSizeInKB(device) {
    try {
      const { stdout } = await execPromise(`blockdev --getsz ${device}`);
      const sizeInSectors = parseInt(stdout.trim());
      return Math.floor(sizeInSectors / 2);  // Convert to KB
    } catch (error) {
      throw new Error(`Failed to get device size for ${device}: ${error.message}`);
    }
  }

  /**
   * Replace devices in a NonRAID pool
   * @param {string} poolId - Pool ID
   * @param {Array} replacements - Array of {slot, newDevice} objects
   * @param {Object} options - Options including format and passphrase
   * @returns {Promise<Object>} - Result object
   */
  async replaceDevicesInNonRaidPool(poolId, replacements, options = {}) {
    let deviceChangeLocked = false;
    let moduleLoaded = false;
    let reservedDisks = [];

    try {
      // Validate inputs
      if (!poolId) throw new Error('Pool ID is required');
      if (!Array.isArray(replacements) || replacements.length === 0) {
        throw new Error('At least one replacement is required');
      }

      // Read pools
      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.id === poolId);

      if (poolIndex === -1) {
        throw new Error(`Pool with ID ${poolId} not found`);
      }

      const pool = pools[poolIndex];

      if (pool.type !== 'nonraid') {
        throw new Error('Device replacement is only supported for NonRAID pools');
      }

      // Check if pool is mounted
      const mountPoint = path.join(this.mountBasePath, pool.name);
      const isMounted = await this._isMounted(mountPoint);

      if (isMounted) {
        throw new Error('Pool must be unmounted before replacing devices. Please unmount the pool first.');
      }

      await this._lockNonRaidDeviceChange(pool);
      deviceChangeLocked = true;

      // Validate replacements
      const dataReplacements = [];
      const parityReplacements = [];

      for (const replacement of replacements) {
        const { slot, newDevice } = replacement;

        if (!slot) throw new Error('Slot is required for each replacement');
        if (!newDevice) throw new Error('New device path is required for each replacement');

        // Check if it's a data device or parity device
        const dataDevice = pool.data_devices.find(d => d.slot === slot.toString());
        const parityDevice = pool.parity_devices?.find(d => d.slot === slot.toString());

        if (dataDevice) {
          dataReplacements.push({ slot, newDevice, oldDevice: dataDevice });
        } else if (parityDevice) {
          parityReplacements.push({ slot, newDevice, oldDevice: parityDevice });
        } else {
          throw new Error(`Slot ${slot} not found in pool`);
        }
      }

      // Validate replacement count against parity count
      const totalParityCount = (pool.parity_devices || []).length;
      const totalReplacements = dataReplacements.length + parityReplacements.length;

      if (dataReplacements.length > totalParityCount) {
        throw new Error(
          `Cannot replace ${dataReplacements.length} data device(s) with only ${totalParityCount} parity device(s). ` +
          `Maximum ${totalParityCount} device(s) can be replaced at once.`
        );
      }

      const newDevices = replacements.map(r => r.newDevice);
      const memberDisks = await this._collectNonRaidMemberDisks(pool);
      for (const device of newDevices) {
        await this._assertDeviceNotInPool(pool, device, memberDisks);
      }
      await this._assertDevicesUnused(newDevices);
      reservedDisks = await this._reserveDisks(newDevices);

      // Check passphrase for encrypted pools with data replacements
      if (pool.config?.encrypted && dataReplacements.length > 0) {
        if (!options.passphrase || options.passphrase.trim() === '') {
          throw new Error('Passphrase is required for replacing devices in encrypted pools');
        }
      }

      // Get smallest parity size and largest data size for validation
      let smallestParitySize = Infinity;
      let smallestParityDevice = null;
      let largestDataSize = 0;
      let largestDataDevice = null;

      // Calculate parity sizes (exclude devices being replaced)
      for (const parityDev of pool.parity_devices || []) {
        if (!parityReplacements.some(r => r.slot.toString() === parityDev.slot)) {
          const byIdPath = `/dev/disk/by-id/${parityDev.id}`;
          try {
            const { stdout } = await execPromise(`readlink -f ${byIdPath}`);
            const actualDevice = stdout.trim();
            const size = await this.getDeviceSize(actualDevice);
            if (size < smallestParitySize) {
              smallestParitySize = size;
              smallestParityDevice = actualDevice;
            }
          } catch (error) {
            console.warn(`Could not get size for parity device ${parityDev.id}: ${error.message}`);
          }
        }
      }

      // Calculate data sizes (exclude devices being replaced)
      for (const dataDev of pool.data_devices) {
        if (!dataReplacements.some(r => r.slot.toString() === dataDev.slot)) {
          try {
            const device = await this.getRealDevicePathFromUuid(dataDev.id);
            const size = await this.getDeviceSize(device);
            if (size > largestDataSize) {
              largestDataSize = size;
              largestDataDevice = device;
            }
          } catch (error) {
            console.warn(`Could not get size for data device ${dataDev.id}: ${error.message}`);
          }
        }
      }

      // Prepare new data devices
      const preparedDataReplacements = [];
      for (const replacement of dataReplacements) {
        const { slot, newDevice } = replacement;

        // Validate new data device size against smallest parity
        if (smallestParitySize !== Infinity) {
          const newDeviceSize = await this.getDeviceSize(newDevice);
          if (newDeviceSize > smallestParitySize) {
            throw new Error(
              `New data device ${newDevice} (${newDeviceSize} bytes) ` +
              `is larger than smallest parity device ${smallestParityDevice} (${smallestParitySize} bytes)`
            );
          }
        }

        // The rebuild overwrites the whole partition, so format: true is required as an
        // acknowledgement even though no filesystem is created here
        if (options.format !== true) {
          throw new Error('format: true is required when replacing devices in NonRAID pools');
        }
        const preparedDevice = await this._ensurePartition(newDevice);

        preparedDataReplacements.push({
          slot,
          originalDevice: newDevice,
          preparedDevice,
          oldDeviceInfo: replacement.oldDevice
        });
      }

      // A replacement is a parity rebuild: RECON_DISK restores the new disk bit for bit from
      // parity, including its partition contents, LUKS header and filesystem. Formatting or
      // re-encrypting it here would push an empty filesystem through the parity layer and
      // destroy the very data that is being rebuilt, so the disk is only partitioned.
      if (preparedDataReplacements.length > 0 && pool.config?.encrypted) {
        await this._assertLuksPassphraseMatchesPool(
          pool,
          options.passphrase,
          preparedDataReplacements.map(r => r.preparedDevice)
        );
      }

      // Refresh device symlinks
      await this._refreshDeviceSymlinks();

      // Prepare new parity devices
      const preparedParityReplacements = [];
      for (const replacement of parityReplacements) {
        const { slot, newDevice } = replacement;

        // Validate new parity device size against largest data device
        const newParitySize = await this.getDeviceSize(newDevice);
        if (largestDataSize > 0 && newParitySize < largestDataSize) {
          throw new Error(
            `New parity device ${newDevice} (${newParitySize} bytes) ` +
            `is smaller than largest data device ${largestDataDevice} (${largestDataSize} bytes)`
          );
        }

        // Get by-id path for parity device
        const byIdPath = await this._getDeviceByIdPath(newDevice);
        if (!byIdPath) {
          throw new Error(`Could not find /dev/disk/by-id/ path for new parity device ${newDevice}`);
        }

        preparedParityReplacements.push({
          slot,
          originalDevice: newDevice,
          byIdPath,
          oldDeviceInfo: replacement.oldDevice
        });
      }

      // Load md-nonraid module
      console.log('Loading md-nonraid kernel module...');
      const nonraidDatPath = '/boot/config/system/nonraid.dat';
      await execPromise(`modprobe md-nonraid super=${nonraidDatPath}`);
      moduleLoaded = true;

      // Import all devices (with replacements)
      console.log('Importing devices into NonRAID array...');

      // Import data devices
      for (const device of pool.data_devices) {
        const replacement = preparedDataReplacements.find(r => r.slot.toString() === device.slot);
        const slot = parseInt(device.slot);

        if (replacement) {
          // The rebuilt disk ends up carrying the UUID of the disk it replaces, so the stored
          // id stays untouched
          const deviceSize = await this._getDeviceSizeInKB(replacement.preparedDevice);
          const deviceBasename = path.basename(replacement.preparedDevice);

          const importCmd = `echo "import ${slot} ${deviceBasename} 0 ${deviceSize} 0 ${device.id}" > /proc/nmdcmd`;
          console.log(`Importing NEW data device slot ${slot}: ${importCmd}`);
          await execPromise(importCmd);
        } else {
          // Import existing device
          const physicalDevice = await this.getRealDevicePathFromUuid(device.id);
          const deviceSize = await this._getDeviceSizeInKB(physicalDevice);
          const deviceBasename = path.basename(physicalDevice);

          const importCmd = `echo "import ${slot} ${deviceBasename} 0 ${deviceSize} 0 ${device.id}" > /proc/nmdcmd`;
          console.log(`Importing existing data device slot ${slot}: ${importCmd}`);
          await execPromise(importCmd);
        }
      }

      // Import parity devices
      if (pool.parity_devices && pool.parity_devices.length > 0) {
        for (const parityDevice of pool.parity_devices) {
          const replacement = preparedParityReplacements.find(r => r.slot.toString() === parityDevice.slot);
          const jsonSlot = parseInt(parityDevice.slot);
          const arraySlot = jsonSlot === 1 ? 0 : 29;

          if (replacement) {
            // Import new parity device
            const deviceSize = await this._getDeviceSizeInKB(replacement.originalDevice);
            const deviceBasename = path.basename(replacement.originalDevice);

            const importCmd = `echo "import ${arraySlot} ${deviceBasename} 0 ${deviceSize} 0 ${replacement.byIdPath}" > /proc/nmdcmd`;
            console.log(`Importing NEW parity device slot ${arraySlot}: ${importCmd}`);
            await execPromise(importCmd);

            // Update pool config
            parityDevice.id = replacement.byIdPath;
          } else {
            // Import existing parity device
            const byIdPath = `/dev/disk/by-id/${parityDevice.id}`;
            const { stdout } = await execPromise(`readlink -f ${byIdPath}`);
            const actualDevice = stdout.trim();
            const deviceSize = await this._getDeviceSizeInKB(actualDevice);
            const deviceBasename = path.basename(actualDevice);

            const importCmd = `echo "import ${arraySlot} ${deviceBasename} 0 ${deviceSize} 0 ${parityDevice.id}" > /proc/nmdcmd`;
            console.log(`Importing existing parity device slot ${arraySlot}: ${importCmd}`);
            await execPromise(importCmd);
          }
        }
      }

      // Start array with RECON_DISK for parity reconstruction
      console.log('Starting NonRAID array with parity reconstruction...');
      await execPromise('echo "start RECON_DISK" > /proc/nmdcmd');
      console.log('NonRAID array started with RECON_DISK');

      // Set write mode based on config
      const writeMode = pool.config?.md_writemode || 'normal';
      await this._setNonRaidWriteMode(writeMode);

      // Update pool in pools.json
      pools[poolIndex] = pool;
      await this._writePools(pools);

      return {
        success: true,
        message: `Successfully replaced ${totalReplacements} device(s) in NonRAID pool "${pool.name}". Parity reconstruction started.`,
        pool,
        replacements: {
          data: dataReplacements.length,
          parity: parityReplacements.length
        }
      };
    } catch (error) {
      console.error(`Error replacing devices in NonRAID pool: ${error.message}`);

      // Nothing to clean up: a replacement never opens a LUKS container, the rebuild
      // restores the existing one from parity

      if (moduleLoaded) {
        // Cancel any running checks first (ignore errors)
        try {
          await execPromise('echo "nocheck CANCEL" > /proc/nmdcmd');
        } catch (e) {
          // Ignore - no check running
        }

        try {
          await execPromise('echo "stop" > /proc/nmdcmd');
          await execPromise('modprobe -r md-nonraid');
        } catch (e) {
          console.warn(`Failed to cleanup md-nonraid module: ${e.message}`);
        }
      }

      throw new Error(`Error replacing devices in NonRAID pool: ${error.message}`);
    } finally {
      if (deviceChangeLocked) PoolsService._nonRaidDeviceChangeActive = false;
      PoolHelpers.releaseDisks(reservedDisks);
    }
  }

  /**
   * Add data device to NonRAID pool
   * @param {string} newDevice - New device path
   * @param {Object} options - Options including format, passphrase, and parity_valid
   * @returns {Promise<Object>} - Result object
   */
  async addDataDeviceToNonRaidPool(newDevice, options = {}) {
    const poolConfig = { name: null, config: {} };
    let strategy = null;
    let preparedNewDevice = null;
    let pendingSlot = null;
    let deviceChangeLocked = false;
    let moduleLoaded = false;
    let reservedDisks = [];

    try {
      // Validate inputs
      if (!newDevice) throw new Error('Device path is required');

      // Find the NonRAID pool (only one can exist)
      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.type === 'nonraid');

      if (poolIndex === -1) {
        throw new Error('No NonRAID pool found on this system');
      }

      const pool = pools[poolIndex];

      // Set pool config for strategy
      poolConfig.name = pool.name;
      poolConfig.config = pool.config;
      strategy = this._getDeviceStrategy(poolConfig);

      // Check if pool is mounted
      const mountPoint = path.join(this.mountBasePath, pool.name);
      const isMounted = await this._isMounted(mountPoint);

      if (isMounted) {
        throw new Error('Pool must be unmounted before adding devices. Please unmount the pool first.');
      }

      if (pool.config?.encrypted && !options.passphrase?.trim() && !await this._hasLuksKeyfile(pool.name)) {
        throw new Error('Passphrase is required for adding devices to encrypted pools without keyfile');
      }

      await this._lockNonRaidDeviceChange(pool);
      deviceChangeLocked = true;
      await this._assertDeviceNotInPool(pool, newDevice, await this._collectNonRaidMemberDisks(pool));
      await this._assertDevicesUnused([newDevice]);
      reservedDisks = await this._reserveDisks([newDevice]);

      // Find next available data slot (1-28)
      const usedSlots = pool.data_devices.map(d => parseInt(d.slot));
      let nextSlot = null;
      for (let i = 1; i <= 28; i++) {
        if (!usedSlots.includes(i)) {
          nextSlot = i;
          break;
        }
      }

      if (!nextSlot) {
        throw new Error('No available data slots (maximum 28 data devices)');
      }

      // Validate new device size against smallest parity (if exists)
      if (pool.parity_devices && pool.parity_devices.length > 0) {
        let smallestParitySize = Infinity;
        let smallestParityDevice = null;
        for (const parityDev of pool.parity_devices) {
          const byIdPath = `/dev/disk/by-id/${parityDev.id}`;
          try {
            const { stdout } = await execPromise(`readlink -f ${byIdPath}`);
            const actualDevice = stdout.trim();
            const size = await this.getDeviceSize(actualDevice);
            if (size < smallestParitySize) {
              smallestParitySize = size;
              smallestParityDevice = actualDevice;
            }
          } catch (error) {
            console.warn(`Could not get size for parity device ${parityDev.id}: ${error.message}`);
          }
        }

        const newDeviceSize = await this.getDeviceSize(newDevice);
        if (smallestParitySize !== Infinity && newDeviceSize > smallestParitySize) {
          throw new Error(
            `New data device ${newDevice} (${newDeviceSize} bytes) ` +
            `is larger than smallest parity device ${smallestParityDevice} (${smallestParitySize} bytes)`
          );
        }
      }

      // Prepare device (partition if needed)
      let preparedDevice;
      if (options.format === true) {
        // format=true: Create partition and format
        preparedDevice = await this._ensurePartition(newDevice);
      } else {
        // format=false: Import mode - use existing filesystem as-is
        const isPartition = this._isPartitionPath(newDevice);
        if (!isPartition) {
          // Whole disk - check what's on it
          const deviceInfo = await this.checkDeviceFilesystem(newDevice);
          if (deviceInfo.actualDevice) {
            // Has partition with filesystem - use the partition
            preparedDevice = deviceInfo.actualDevice;
          } else if (deviceInfo.isFormatted && !['dos', 'gpt', 'mbr'].includes(deviceInfo.filesystem)) {
            // Whole disk has filesystem directly (no partition) - use whole disk
            preparedDevice = newDevice;
          } else {
            // No usable filesystem found
            throw new Error(`Device ${newDevice} has no usable filesystem. Use format: true to create partition and format.`);
          }
        } else {
          // Already a partition - use as-is
          preparedDevice = newDevice;
        }

        // Validate filesystem exists when format=false
        const deviceInfo = await this.checkDeviceFilesystem(preparedDevice);
        if (!deviceInfo.isFormatted) {
          throw new Error(`Device ${preparedDevice} has no filesystem. Use format: true to format.`);
        }
      }

      // Encrypted pools put LUKS on top of md-nonraid, so the container can only be created
      // after the array is running. The import already needs the disk id, so it is pinned here
      const isEncrypted = pool.config?.encrypted === true;
      const hasParity = pool.parity_devices?.length > 0;
      // New disk has to be zeroed by the driver before it can be formatted,
      // otherwise the existing parity would no longer match
      const needsClear = hasParity && options.format === true && options.parity_valid !== true;
      let filesystem;
      let luksUuid = null;
      let deviceUuid;

      if (needsClear) {
        if (isEncrypted) {
          await this._assertLuksPassphraseMatchesPool(pool, options.passphrase, [preparedDevice]);
        }
        filesystem = options.filesystem || pool.data_devices[0]?.filesystem || 'xfs';
        await this._refreshDeviceSymlinks();
        deviceUuid = await this._getPartUuid(preparedDevice);
        if (!deviceUuid) {
          throw new Error(`Could not determine partition UUID for ${preparedDevice}`);
        }
      } else if (isEncrypted) {
        // Fail before anything destructive happens if the key diverges from the pool
        await this._assertLuksPassphraseMatchesPool(pool, options.passphrase, [preparedDevice]);

        if (options.format === true) {
          luksUuid = crypto.randomUUID();
          deviceUuid = luksUuid;
          filesystem = options.filesystem || pool.data_devices[0]?.filesystem || 'xfs';
        } else {
          deviceUuid = await this.getDeviceUuid(preparedDevice);
        }
      } else {
        if (options.format === true) {
          filesystem = options.filesystem || pool.data_devices[0]?.filesystem || 'xfs';
          await this.formatDevice(preparedDevice, filesystem, { nodiscard: true });
        } else {
          const deviceInfo = await this.checkDeviceFilesystem(preparedDevice);
          filesystem = deviceInfo.filesystem;
          if (!filesystem || ['dos', 'gpt', 'mbr'].includes(filesystem)) {
            throw new Error(`Could not determine filesystem type for ${preparedDevice}`);
          }
        }
        deviceUuid = await this.getDeviceUuid(preparedDevice);
      }

      // Refresh device symlinks
      await this._refreshDeviceSymlinks();

      // Load md-nonraid module
      console.log('Loading md-nonraid kernel module...');
      const nonraidDatPath = '/boot/config/system/nonraid.dat';
      await execPromise(`modprobe md-nonraid super=${nonraidDatPath}`);
      moduleLoaded = true;

      // Import all devices (including new one)
      console.log('Importing devices into NonRAID array...');

      // Import existing data devices
      for (const device of pool.data_devices) {
        const slot = parseInt(device.slot);

        // The stored UUID is the LUKS container UUID for encrypted pools, so this
        // resolves to the physical device in both cases
        const physicalDevice = await this.getRealDevicePathFromUuid(device.id);

        if (!physicalDevice) {
          throw new Error(`Could not find physical device for UUID ${device.id} at slot ${slot}`);
        }

        const deviceSize = await this._getDeviceSizeInKB(physicalDevice);
        const deviceBasename = path.basename(physicalDevice);

        const importCmd = `echo "import ${slot} ${deviceBasename} 0 ${deviceSize} 0 ${device.id}" > /proc/nmdcmd`;
        console.log(`Importing existing data device slot ${slot}: ${importCmd}`);
        await execPromise(importCmd);
      }

      // Import NEW data device
      const deviceSize = await this._getDeviceSizeInKB(preparedDevice);
      const deviceBasename = path.basename(preparedDevice);
      const erased = needsClear ? 0 : 1;
      const importCmd = `echo "import ${nextSlot} ${deviceBasename} 0 ${deviceSize} ${erased} ${deviceUuid}" > /proc/nmdcmd`;
      console.log(`Importing NEW data device slot ${nextSlot}: ${importCmd}`);
      await execPromise(importCmd);

      // Import parity devices if they exist
      if (pool.parity_devices && pool.parity_devices.length > 0) {
        for (const parityDevice of pool.parity_devices) {
          const jsonSlot = parseInt(parityDevice.slot);
          const arraySlot = jsonSlot === 1 ? 0 : 29;

          const byIdPath = `/dev/disk/by-id/${parityDevice.id}`;
          const { stdout } = await execPromise(`readlink -f ${byIdPath}`);
          const actualDevice = stdout.trim();
          const deviceSize = await this._getDeviceSizeInKB(actualDevice);
          const deviceBasename = path.basename(actualDevice);

          const importCmd = `echo "import ${arraySlot} ${deviceBasename} 0 ${deviceSize} 0 ${parityDevice.id}" > /proc/nmdcmd`;
          console.log(`Importing existing parity device slot ${arraySlot}: ${importCmd}`);
          await execPromise(importCmd);
        }
      }

      await this._startNonRaidArray();
      console.log('NonRAID array started');

      // Set write mode based on config
      const writeMode = pool.config?.md_writemode || 'normal';
      await this._setNonRaidWriteMode(writeMode);

      // The disk only lands in pools.json once it is cleared and formatted
      if (needsClear) {
        pendingSlot = nextSlot;
        this._nonRaidPendingDisks.set(nextSlot, {
          filesystem,
          passphrase: options.passphrase?.trim() ? options.passphrase : null,
          reservedDisks
        });

        // The disk is part of the array superblock now and cannot be rolled back,
        // a failed start is picked up again by the resume on the next mount
        const clearStarted = await this._startNonRaidParityCheck();
        if (clearStarted) {
          this._startNonRaidMonitor(pool.name, 'clear', false);
          sendNotification('nonraid', `New disk is being added to slot ${nextSlot} of Pool ${pool.name}, clearing started`, 'normal')
            .catch(err => console.warn(`Failed to send NonRAID notification: ${err.message}`));
        } else {
          sendNotification('nonraid', `New disk was added to slot ${nextSlot} of Pool ${pool.name}, but clearing could not be started. It is retried on the next mount.`, 'alert')
            .catch(err => console.warn(`Failed to send NonRAID notification: ${err.message}`));
        }

        return {
          success: true,
          message: clearStarted
            ? `Data device is being cleared for NonRAID pool "${pool.name}" at slot ${nextSlot}. It will be formatted and added once clearing is complete.`
            : `Data device was added to NonRAID pool "${pool.name}" at slot ${nextSlot}, but clearing could not be started. It is retried on the next mount.`,
          pool,
          slot: nextSlot
        };
      }

      // Set up LUKS on the md device now that the array is running
      if (isEncrypted) {
        const nmdDevice = `/dev/nmd${nextSlot}p1`;
        const preparedDevices = await strategy.prepareDevices(
          [nmdDevice],
          pool,
          { ...options, config: pool.config, slots: [nextSlot], luksUuids: [luksUuid] }
        );

        preparedNewDevice = preparedDevices[0];
        const actualDevice = strategy.getOperationalDevicePath(preparedNewDevice);

        if (options.format === true) {
          await this.formatDevice(actualDevice, filesystem, { nodiscard: true });
        } else {
          const deviceInfo = await this.checkDeviceFilesystem(actualDevice);
          filesystem = deviceInfo.filesystem;
          if (!filesystem || ['dos', 'gpt', 'mbr'].includes(filesystem)) {
            throw new Error(`Could not determine filesystem type for ${actualDevice}`);
          }
        }

        await this._refreshDeviceSymlinks();
      }

      // Run check CORRECT if parity_valid is NOT true
      const shouldRunCheck = options.parity_valid !== true && hasParity;
      if (shouldRunCheck) {
        const checkStarted = await this._startNonRaidParityCheck();
        if (checkStarted) {
          this._startNonRaidMonitor(pool.name, 'check CORRECT', true);
        }
      }

      // Add new device to pool config
      pool.data_devices.push({
        slot: nextSlot,
        id: deviceUuid,
        filesystem,
        spindown: null
      });

      // Update pool in pools.json
      pools[poolIndex] = pool;
      await this._writePools(pools);

      return {
        success: true,
        message: `Successfully added data device to NonRAID pool "${pool.name}" at slot ${nextSlot}${shouldRunCheck ? '. Parity check started.' : ''}`,
        pool,
        slot: nextSlot
      };
    } catch (error) {
      console.error(`Error adding data device to NonRAID pool: ${error.message}`);

      // Cleanup on error
      if (preparedNewDevice && strategy) {
        try {
          await strategy.cleanup([preparedNewDevice], poolConfig);
        } catch (cleanupError) {
          console.warn(`LUKS cleanup failed: ${cleanupError.message}`);
        }
      }

      // A pending disk is already committed to the superblock
      if (moduleLoaded && !pendingSlot) {
        // Cancel any running checks first (ignore errors)
        try {
          await execPromise('echo "nocheck CANCEL" > /proc/nmdcmd');
        } catch (e) {
          // Ignore - no check running
        }

        try {
          await execPromise('echo "stop" > /proc/nmdcmd');
          await execPromise('modprobe -r md-nonraid');
        } catch (e) {
          console.warn(`Failed to cleanup md-nonraid module: ${e.message}`);
        }
      }

      throw new Error(`Error adding data device to NonRAID pool: ${error.message}`);
    } finally {
      if (deviceChangeLocked) PoolsService._nonRaidDeviceChangeActive = false;
      // A pending disk stays reserved until _formatPendingNonRaidDisk() adds it to pools.json
      if (!pendingSlot) PoolHelpers.releaseDisks(reservedDisks);
    }
  }

  /**
   * Add parity device to NonRAID pool
   * @param {string} newDevice - New parity device path
   * @param {Object} options - Options
   * @returns {Promise<Object>} - Result object
   */
  async addParityDeviceToNonRaidPool(newDevice, options = {}) {
    let deviceChangeLocked = false;
    let moduleLoaded = false;
    let reservedDisks = [];

    try {
      // Validate inputs
      if (!newDevice) throw new Error('Device path is required');

      // Find the NonRAID pool (only one can exist)
      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.type === 'nonraid');

      if (poolIndex === -1) {
        throw new Error('No NonRAID pool found on this system');
      }

      const pool = pools[poolIndex];

      // Check if pool is mounted
      const mountPoint = path.join(this.mountBasePath, pool.name);
      const isMounted = await this._isMounted(mountPoint);

      if (isMounted) {
        throw new Error('Pool must be unmounted before adding parity devices. Please unmount the pool first.');
      }

      await this._lockNonRaidDeviceChange(pool);
      deviceChangeLocked = true;
      await this._assertDeviceNotInPool(pool, newDevice, await this._collectNonRaidMemberDisks(pool));
      await this._assertDevicesUnused([newDevice]);
      reservedDisks = await this._reserveDisks([newDevice]);

      // Check max parity devices
      const currentParityCount = pool.parity_devices?.length || 0;
      if (currentParityCount >= 2) {
        throw new Error('Maximum 2 parity devices allowed for NonRAID pools');
      }

      // Determine next parity slot
      const nextJsonSlot = currentParityCount === 0 ? 1 : 2;
      const nextArraySlot = nextJsonSlot === 1 ? 0 : 29;

      // Validate new parity device size against largest data device
      let largestDataSize = 0;
      let largestDataDevice = null;
      for (const dataDev of pool.data_devices) {
        try {
          const device = await this.getRealDevicePathFromUuid(dataDev.id);
          const size = await this.getDeviceSize(device);
          if (size > largestDataSize) {
            largestDataSize = size;
            largestDataDevice = device;
          }
        } catch (error) {
          console.warn(`Could not get size for data device ${dataDev.id}: ${error.message}`);
        }
      }

      const newParitySize = await this.getDeviceSize(newDevice);
      if (largestDataSize > 0 && newParitySize < largestDataSize) {
        throw new Error(
          `New parity device ${newDevice} (${newParitySize} bytes) ` +
          `is smaller than largest data device ${largestDataDevice} (${largestDataSize} bytes)`
        );
      }

      // Get by-id path for parity device
      const byIdPath = await this._getDeviceByIdPath(newDevice);
      if (!byIdPath) {
        throw new Error(`Could not find /dev/disk/by-id/ path for parity device ${newDevice}`);
      }

      // Load md-nonraid module
      console.log('Loading md-nonraid kernel module...');
      const nonraidDatPath = '/boot/config/system/nonraid.dat';
      await execPromise(`modprobe md-nonraid super=${nonraidDatPath}`);
      moduleLoaded = true;

      // Import all devices (including new parity)
      console.log('Importing devices into NonRAID array...');

      // Import existing data devices
      for (const device of pool.data_devices) {
        const slot = parseInt(device.slot);

        // The stored UUID is the LUKS container UUID for encrypted pools, so this
        // resolves to the physical device in both cases
        const physicalDevice = await this.getRealDevicePathFromUuid(device.id);

        if (!physicalDevice) {
          throw new Error(`Could not find physical device for UUID ${device.id} at slot ${slot}`);
        }

        const deviceSize = await this._getDeviceSizeInKB(physicalDevice);
        const deviceBasename = path.basename(physicalDevice);

        const importCmd = `echo "import ${slot} ${deviceBasename} 0 ${deviceSize} 0 ${device.id}" > /proc/nmdcmd`;
        console.log(`Importing existing data device slot ${slot}: ${importCmd}`);
        await execPromise(importCmd);
      }

      // Import existing parity devices
      if (pool.parity_devices && pool.parity_devices.length > 0) {
        for (const parityDevice of pool.parity_devices) {
          const jsonSlot = parseInt(parityDevice.slot);
          const arraySlot = jsonSlot === 1 ? 0 : 29;

          const byIdPath = `/dev/disk/by-id/${parityDevice.id}`;
          const { stdout } = await execPromise(`readlink -f ${byIdPath}`);
          const actualDevice = stdout.trim();
          const deviceSize = await this._getDeviceSizeInKB(actualDevice);
          const deviceBasename = path.basename(actualDevice);

          const importCmd = `echo "import ${arraySlot} ${deviceBasename} 0 ${deviceSize} 0 ${parityDevice.id}" > /proc/nmdcmd`;
          console.log(`Importing existing parity device slot ${arraySlot}: ${importCmd}`);
          await execPromise(importCmd);
        }
      }

      // Import NEW parity device
      const deviceSize = await this._getDeviceSizeInKB(newDevice);
      const deviceBasename = path.basename(newDevice);
      const importCmd = `echo "import ${nextArraySlot} ${deviceBasename} 0 ${deviceSize} 0 ${byIdPath}" > /proc/nmdcmd`;
      console.log(`Importing NEW parity device slot ${nextArraySlot}: ${importCmd}`);
      await execPromise(importCmd);

      await this._startNonRaidArray();
      console.log('NonRAID array started');

      // Set write mode based on config (with retries)
      const writeMode = pool.config?.md_writemode || 'normal';
      await this._setNonRaidWriteMode(writeMode);

      // ALWAYS run check CORRECT when adding parity
      const checkStarted = await this._startNonRaidParityCheck();
      if (checkStarted) {
        this._startNonRaidMonitor(pool.name, 'check CORRECT', true);
      }

      // Add new parity device to pool config
      if (!pool.parity_devices) pool.parity_devices = [];
      pool.parity_devices.push({
        slot: nextJsonSlot,
        id: byIdPath,
        filesystem: pool.data_devices[0]?.filesystem || 'xfs',
        spindown: null
      });

      // Add check config if this is the first parity
      if (currentParityCount === 0) {
        if (!pool.config) pool.config = {};
        pool.config.check = {
          enabled: false,
          schedule: "0 5 * * SUN"
        };
      }

      // Update pool in pools.json
      pools[poolIndex] = pool;
      await this._writePools(pools);

      return {
        success: true,
        message: `Successfully added parity device to NonRAID pool "${pool.name}" at slot ${nextJsonSlot}. Parity check started.`,
        pool,
        slot: nextJsonSlot
      };
    } catch (error) {
      console.error(`Error adding parity device to NonRAID pool: ${error.message}`);

      if (moduleLoaded) {
        // Cancel any running checks first (ignore errors)
        try {
          await execPromise('echo "nocheck CANCEL" > /proc/nmdcmd');
        } catch (e) {
          // Ignore - no check running
        }

        try {
          await execPromise('echo "stop" > /proc/nmdcmd');
          await execPromise('modprobe -r md-nonraid');
        } catch (e) {
          console.warn(`Failed to cleanup md-nonraid module: ${e.message}`);
        }
      }

      throw new Error(`Error adding parity device to NonRAID pool: ${error.message}`);
    } finally {
      if (deviceChangeLocked) PoolsService._nonRaidDeviceChangeActive = false;
      PoolHelpers.releaseDisks(reservedDisks);
    }
  }

  /**
   * Add parity devices to a MergerFS pool
   * @param {string} poolId - Pool ID
   * @param {string[]} parityDevices - Array of parity device paths to add
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} - Result object
   */
  async addParityDevicesToPool(poolId, parityDevices, options = {}) {
    let pool = null;
    let parityLuksDevices = null;
    let paritySlots = [];

    try {
      if (!poolId) throw new Error('Pool ID is required');
      if (!Array.isArray(parityDevices) || parityDevices.length === 0) {
        throw new Error('At least one parity device is required');
      }

      // Load pools data
      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.id === poolId);

      if (poolIndex === -1) {
        throw new Error(`Pool with ID ${poolId} not found`);
      }

      pool = pools[poolIndex];

      if (pool.type !== 'mergerfs') {
        throw new Error('Only MergerFS pools support parity devices');
      }

      // Inject real device paths (e.g. /dev/sdj1 instead of /dev/disk/by-uuid/...)
      await this._injectRealDevicePaths(pool);

      // Find next available parity slots (fill gaps from removed devices)
      const findNextAvailableParitySlot = () => {
        const existingSlots = pool.parity_devices.map(d => parseInt(d.slot)).sort((a, b) => a - b);
        for (let i = 1; i <= existingSlots.length + 1; i++) {
          if (!existingSlots.includes(i)) {
            return i;
          }
        }
        return existingSlots.length + 1;
      };

      // Calculate slots for new parity devices
      paritySlots = [];
      for (let i = 0; i < parityDevices.length; i++) {
        const slot = paritySlots.length > 0
          ? Math.max(...paritySlots, ...pool.parity_devices.map(d => parseInt(d.slot))) + 1
          : findNextAvailableParitySlot();
        paritySlots.push(slot);
      }

      // Prepare physical devices - partition BEFORE encryption/formatting if format=true
      let physicalParityDevices = parityDevices;
      if (options.format === true) {
        // format=true: Partition devices first (both encrypted and non-encrypted)
        physicalParityDevices = [];
        for (const device of parityDevices) {
          const partitionedDevice = await this._ensurePartition(device);
          physicalParityDevices.push(partitionedDevice);
        }
      } else if (!pool.config?.encrypted) {
        // format=false, non-encrypted: Check for existing partitions (same logic as createMergerFSPool)
        physicalParityDevices = [];
        for (const device of parityDevices) {
          const isPartition = this._isPartitionPath(device);
          if (!isPartition) {
            // Whole disk - check what's on it
            const deviceInfo = await this.checkDeviceFilesystem(device);
            if (deviceInfo.actualDevice) {
              // Has partition with filesystem - use the partition
              physicalParityDevices.push(deviceInfo.actualDevice);
            } else if (deviceInfo.isFormatted && !['dos', 'gpt', 'mbr'].includes(deviceInfo.filesystem)) {
              // Whole disk has filesystem directly (no partition) - use whole disk
              physicalParityDevices.push(device);
            } else {
              throw new Error(`Parity device ${device} has no usable filesystem. Use format: true to create partition and format.`);
            }
          } else {
            // Already a partition - use as-is
            physicalParityDevices.push(device);
          }
        }
      }

      // Handle LUKS encryption for new parity devices if pool is encrypted
      let actualParityDevices = physicalParityDevices;
      let preparedParityDeviceInfos = [];

      if (pool.config?.encrypted) {
        console.log(`Setting up LUKS encryption for new parity devices in MergerFS pool '${pool.name}'`);

        // Use Strategy Pattern to handle encryption with proper slot numbers
        const strategy = this._getDeviceStrategy(pool);

        preparedParityDeviceInfos = await strategy.prepareDevices(
          physicalParityDevices,
          pool,
          { ...options, config: pool.config, startSlot: paritySlots[0], isParity: true }
        );

        // Extract operational devices (mapped LUKS devices)
        actualParityDevices = preparedParityDeviceInfos.map(d => d.operationalDevice);
        parityLuksDevices = preparedParityDeviceInfos; // Store for cleanup

        console.log(`LUKS parity devices opened for adding to pool: ${actualParityDevices.join(', ')}`);
      }

      // Check each new parity device
      for (let i = 0; i < parityDevices.length; i++) {
        const originalDevice = parityDevices[i];
        const deviceToCheck = actualParityDevices[i];

        // Check if device exists
        await fs.access(deviceToCheck).catch(() => {
          throw new Error(`Device ${deviceToCheck} does not exist`);
        });

        // Check if device is already mounted
        const mountStatus = await this._isDeviceMounted(deviceToCheck);
        if (mountStatus.isMounted) {
          throw new Error(`Device ${deviceToCheck} is already mounted at ${mountStatus.mountPoint}. Please unmount it first before adding to pool.`);
        }

        // Check if device is already part of this pool (data or parity)
        const isInPool = pool.data_devices.some(d => d.device === deviceToCheck) ||
                        pool.parity_devices.some(d => d.device === deviceToCheck);
        if (isInPool) {
          throw new Error(`Device ${deviceToCheck} is already part of pool ${pool.name}`);
        }

        // Verify parity device size requirements (use original device for size check)
        if (!options.skip_size_check) {
          const paritySize = await this.getDeviceSize(originalDevice);

          // Check all data devices and make sure parity device is at least as large as the largest
          let largestDataDevice = 0;
          for (let i = 0; i < pool.data_devices.length; i++) {
            const dataDevice = pool.data_devices[i];
            const deviceToMeasure = dataDevice.device;
            const deviceSize = await this.getDeviceSize(deviceToMeasure);
            if (deviceSize > largestDataDevice) {
              largestDataDevice = deviceSize;
            }
          }

          if (paritySize < largestDataDevice) {
            throw new Error(`Parity device ${originalDevice} must be at least as large as the largest data device`);
          }
        }

        // Check device format status
        // For encrypted pools, deviceToCheck is the LUKS mapper - check filesystem inside
        const deviceInfo = await this.checkDeviceFilesystem(deviceToCheck);
        const expectedFilesystem = pool.data_devices.length > 0 ? pool.data_devices[0].filesystem : 'xfs';

        if (options.format === true) {
          // Explicit format requested - format the device (LUKS mapper or physical device)
          console.log(`Formatting parity device ${deviceToCheck} with ${expectedFilesystem}`);
          const formatResult = await this.formatDevice(deviceToCheck, expectedFilesystem);
        } else if (!deviceInfo.isFormatted) {
          // Device is not formatted - require explicit format option
          throw new Error(`Device ${deviceToCheck} is not formatted. Use format: true to format the device with ${expectedFilesystem}.`);
        } else if (deviceInfo.filesystem !== expectedFilesystem) {
          throw new Error(`Device ${deviceToCheck} has filesystem ${deviceInfo.filesystem}, expected ${expectedFilesystem}. Use format: true to reformat.`);
        }
      }

      // Refresh device symlinks after formatting (needed for UUID resolution)
      await this._refreshDeviceSymlinks();

      // Mount and add new parity devices
      const newParityDevices = [];
      for (let i = 0; i < parityDevices.length; i++) {
        const originalDevice = parityDevices[i];
        const deviceToMount = actualParityDevices[i];
        const paritySlot = paritySlots[i];
        const snapraidPoolPath = path.join(this.snapraidBasePath, pool.name);
        const parityMountPoint = path.join(snapraidPoolPath, `parity${paritySlot}`);

        // Create mount point with proper ownership and mount the device
        const ownershipOptions = {
          uid: this.defaultOwnership.uid,
          gid: this.defaultOwnership.gid
        };
        await this._createDirectoryWithOwnership(parityMountPoint, ownershipOptions);
        await this.mountDevice(deviceToMount, parityMountPoint, ownershipOptions);

        // Get device UUID - for encrypted pools use Strategy
        let deviceUuid;
        if (pool.config?.encrypted && preparedParityDeviceInfos[i]) {
          const strategy = this._getDeviceStrategy(pool);
          deviceUuid = await strategy.getDeviceUuid(preparedParityDeviceInfos[i], pool);
        } else {
          // For non-encrypted: get UUID from actualDevice (consistent with createMergerFSPool)
          deviceUuid = await this.getDeviceUuid(deviceToMount);
        }

        const expectedFilesystem = pool.data_devices.length > 0 ? pool.data_devices[0].filesystem : 'xfs';

        newParityDevices.push({
          slot: paritySlot,
          id: deviceUuid,
          filesystem: expectedFilesystem,
          spindown: null
          // Note: device property is NOT stored, it's injected when reading pools
        });
      }

      // Add new parity devices to pool
      pool.parity_devices = [...pool.parity_devices, ...newParityDevices];



      // Add SnapRAID sync config if this is the first parity device
      if (pool.parity_devices.length === newParityDevices.length) {
        pool.config.sync = {
          enabled: false,
          schedule: "30 0 * * *",
          check: {
            enabled: false,
            schedule: "0 0 * */3 SUN"
          },
          scrub: {
            enabled: false,
            schedule: "0 4 * * WED"
          }
        };
      }

      // Update SnapRAID configuration
      await this.updateSnapRAIDConfig(pool);

      // Save updated pool configuration
      pools[poolIndex] = pool;
      await this._writePools(pools);

      return {
        success: true,
        message: `Successfully added ${newParityDevices.length} parity device(s) to pool "${pool.name}"`,
        pool
      };
    } catch (error) {
      // Cleanup: Close LUKS devices if they were opened
      if (pool && pool.config?.encrypted && parityLuksDevices && parityLuksDevices.length > 0) {
        console.log(`Error occurred, cleaning up LUKS parity devices for pool '${pool.name}'`);
        try {
          const strategy = this._getDeviceStrategy(pool);
          await strategy.cleanup(parityLuksDevices, pool);
        } catch (cleanupError) {
          console.warn(`Warning: Could not cleanup LUKS parity devices: ${cleanupError.message}`);
        }
      }
      throw new Error(`Error adding parity devices: ${error.message}`);
    }
  }

  /**
   * Replace a parity device in a pool
   * @param {string} poolId - Pool ID
   * @param {string} oldDevice - Current parity device path
   * @param {string} newDevice - New parity device path
   * @param {Object} options - Options including format flag
   * @returns {Promise<Object>} - Operation result
   */
  async replaceParityDeviceInPool(poolId, oldDevice, newDevice, options = {}) {
    try {
      // Load pools data
      const pools = await this._readPools();
      const poolIndex = pools.findIndex(p => p.id === poolId);

      if (poolIndex === -1) {
        throw new Error(`Pool with ID ${poolId} not found`);
      }

      const pool = pools[poolIndex];

      // Inject real device paths (e.g. /dev/sdj1 instead of /dev/disk/by-uuid/...)
      await this._injectRealDevicePaths(pool);

      // Find the old parity device
      const oldParityIndex = pool.parity_devices.findIndex(device => device.device === oldDevice);

      if (oldParityIndex === -1) {
        throw new Error(`Parity device ${oldDevice} not found in pool`);
      }

      // Check if new device exists
      await fs.access(newDevice).catch(() => {
        throw new Error(`Device ${newDevice} does not exist`);
      });

      // Check if new device is already part of this pool
      const isInPool = pool.data_devices.some(d => d.device === newDevice) ||
                      pool.parity_devices.some(d => d.device === newDevice);
      if (isInPool) {
        throw new Error(`Device ${newDevice} is already part of pool ${pool.name}`);
      }

      // Verify new parity device size requirements
      if (!options.skip_size_check) {
        const newParitySize = await this.getDeviceSize(newDevice);

        // Check all data devices and make sure new parity device is at least as large as the largest
        let largestDataDevice = 0;
        for (const dataDevice of pool.data_devices) {
          const deviceSize = await this.getDeviceSize(dataDevice.device);
          if (deviceSize > largestDataDevice) {
            largestDataDevice = deviceSize;
          }
        }

        if (newParitySize < largestDataDevice) {
          throw new Error(`New parity device ${newDevice} must be at least as large as the largest data device`);
        }
      }

      // Get the old parity device info for preserving slot number
      const oldParityDevice = pool.parity_devices[oldParityIndex];
      const paritySlot = parseInt(oldParityDevice.slot);
      const expectedFilesystem = pool.data_devices.length > 0 ? pool.data_devices[0].filesystem : 'xfs';

      // Unmount old parity device first
      const snapraidPoolPath = path.join(this.snapraidBasePath, pool.name);
      const oldParityMountPoint = path.join(snapraidPoolPath, `parity${paritySlot}`);

      if (await this._isMounted(oldParityMountPoint)) {
        await this.unmountDevice(oldParityMountPoint);
      }

      // For encrypted pools: close old LUKS device BEFORE opening new one
      if (pool.config?.encrypted) {
        try {
          const oldPhysicalDevice = await this.getRealDevicePathFromUuid(oldParityDevice.id);
          if (oldPhysicalDevice) {
            console.log(`Closing old LUKS parity device for slot ${paritySlot}`);
            await this._closeLuksDevicesWithSlots([oldPhysicalDevice], pool.name, [paritySlot], true);
          }
        } catch (error) {
          console.warn(`Warning: Could not close old LUKS device: ${error.message}`);
        }
      }

      // Prepare physical device - partition BEFORE encryption if format=true
      let physicalDevice = newDevice;
      if (pool.config?.encrypted && options.format === true) {
        physicalDevice = await this._ensurePartition(newDevice);
      }

      // Handle LUKS encryption if pool is encrypted
      let deviceToMount = physicalDevice;
      let preparedDeviceInfo = null;

      if (pool.config?.encrypted) {
        console.log(`Setting up LUKS encryption for replacement parity device in pool '${pool.name}'`);

        const strategy = this._getDeviceStrategy(pool);
        const preparedDevices = await strategy.prepareDevices(
          [physicalDevice],
          pool,
          { ...options, config: pool.config, startSlot: paritySlot, isParity: true }
        );

        preparedDeviceInfo = preparedDevices[0];
        deviceToMount = preparedDeviceInfo.operationalDevice;
      } else {
        // Non-encrypted: partition/check device
        if (options.format === true) {
          deviceToMount = await this._ensurePartition(newDevice);
        } else {
          const isPartition = this._isPartitionPath(newDevice);
          if (!isPartition) {
            const deviceInfo = await this.checkDeviceFilesystem(newDevice);
            if (deviceInfo.actualDevice) {
              deviceToMount = deviceInfo.actualDevice;
            } else if (deviceInfo.isFormatted && !['dos', 'gpt', 'mbr'].includes(deviceInfo.filesystem)) {
              deviceToMount = newDevice;
            } else {
              throw new Error(`Device ${newDevice} has no usable filesystem. Use format: true`);
            }
          }
        }
      }

      // Check/format the device to mount
      const deviceInfo = await this.checkDeviceFilesystem(deviceToMount);

      if (options.format === true) {
        await this.formatDevice(deviceToMount, expectedFilesystem);
      } else if (!deviceInfo.isFormatted) {
        throw new Error(`Device ${deviceToMount} is not formatted. Use format: true`);
      } else if (deviceInfo.filesystem !== expectedFilesystem) {
        throw new Error(`Device ${deviceToMount} has filesystem ${deviceInfo.filesystem}, expected ${expectedFilesystem}. Use format: true to reformat.`);
      }

      // Mount new parity device at the same mount point (already unmounted above)
      await this.mountDevice(deviceToMount, oldParityMountPoint);

      // Get new device UUID - for encrypted pools use Strategy
      let newDeviceUuid;
      if (pool.config?.encrypted && preparedDeviceInfo) {
        const strategy = this._getDeviceStrategy(pool);
        newDeviceUuid = await strategy.getDeviceUuid(preparedDeviceInfo, pool);
      } else {
        newDeviceUuid = await this.getDeviceUuid(deviceToMount);
      }

      // Update the parity device in the pool configuration
      pool.parity_devices[oldParityIndex] = {
        slot: paritySlot,
        id: newDeviceUuid,
        filesystem: expectedFilesystem,
        spindown: oldParityDevice.spindown || null
        // Note: device property is NOT stored, it's injected when reading pools
      };

      // Update SnapRAID configuration
      await this.updateSnapRAIDConfig(pool);

      // Save updated pool configuration
      pools[poolIndex] = pool;
      await this._writePools(pools);

      return {
        success: true,
        message: `Successfully replaced parity device ${oldDevice} with ${newDevice} in pool '${pool.name}'`,
        pool
      };
    } catch (error) {
      throw new Error(`Error replacing parity device: ${error.message}`);
    }
  }

  /**
   * ===== SIMPLE POOL POWER MANAGEMENT =====
   */

  /**
   * Get disk status by UUID
   * @param {string} poolId - Pool ID
   * @param {string} diskUuid - Disk UUID
   * @returns {Promise<Object>} - Disk status
   */
  async getDiskStatus(poolId, diskUuid) {
    try {
      const pools = await this._readPools();
      const pool = pools.find(p => p.id === poolId);

      if (!pool) {
        throw new Error(`Pool ${poolId} not found`);
      }

      const allDisks = [...pool.data_devices, ...pool.parity_devices];
      const disk = allDisks.find(d => d.id === diskUuid);

      if (!disk) {
        throw new Error(`Disk ${diskUuid} not found in pool`);
      }

      // Use DisksService to check power status (uses smartctl -n standby, doesn't wake disks)
      let powerStatus = 'active';
      try {
        const diskPowerInfo = await this.disksService._getLiveDiskPowerStatus(disk.device);
        powerStatus = diskPowerInfo.status;
      } catch (error) {
        powerStatus = 'unknown';
      }

      return {
        poolId,
        poolName: pool.name,
        diskUuid,
        device: disk.device,
        slot: disk.slot,
        diskType: pool.data_devices.some(d => d.id === diskUuid) ? 'data' : 'parity',
        powerStatus
      };

    } catch (error) {
      throw new Error(`Failed to get disk status: ${error.message}`);
    }
  }

  /**
   * Wake or sleep a single disk by UUID
   * @param {string} poolId - Pool ID
   * @param {string} diskUuid - Disk UUID
   * @param {string} action - 'wake', 'standby', or 'sleep'
   * @returns {Promise<Object>} - Operation result
   */
  async controlDisk(poolId, diskUuid, action) {
    try {
      const pools = await this._readPools();
      const pool = pools.find(p => p.id === poolId);

      if (!pool) {
        throw new Error(`Pool ${poolId} not found`);
      }

      const allDisks = [...pool.data_devices, ...pool.parity_devices];
      const disk = allDisks.find(d => d.id === diskUuid);

      if (!disk) {
        throw new Error(`Disk ${diskUuid} not found in pool`);
      }

      if (action === 'wake') {
        // Wake with dd command
        await execPromise(`dd if=${disk.device} of=/dev/null bs=512 count=1 iflag=direct 2>/dev/null`);
      } else if (action === 'standby' || action === 'sleep') {
        // NVMe devices don't reliably support power management via nvme-cli
        // Many NVMe controllers don't implement the power management features properly
        if (disk.device && disk.device.includes('nvme')) {
          return {
            success: false,
            message: 'NVMe devices do not reliably support standby mode',
            device: disk.device
          };
        } else if (disk.device && disk.device.includes('ssd')) {
          // Regular SSD - try hdparm but don't fail if it doesn't work
          try {
            const command = action === 'sleep' ? `hdparm -Y ${disk.device}` : `hdparm -y ${disk.device}`;
            await execPromise(command);
          } catch (error) {
            return {
              success: false,
              message: 'SSD device does not support standby mode'
            };
          }
        } else {
          // Traditional HDD
          const command = action === 'sleep' ? `hdparm -Y ${disk.device}` : `hdparm -y ${disk.device}`;
          await execPromise(command);
        }
      } else {
        throw new Error('Invalid action. Use wake, standby, or sleep');
      }

      return {
        poolId,
        poolName: pool.name,
        diskUuid,
        device: disk.device,
        slot: disk.slot,
        action,
        message: `Disk ${action} successful`
      };

    } catch (error) {
      throw new Error(`Failed to ${action} disk: ${error.message}`);
    }
  }

  /**
   * Wake or sleep entire pool
   * @param {string} poolId - Pool ID
   * @param {string} action - 'wake', 'standby', or 'sleep'
   * @returns {Promise<Object>} - Operation results
   */
  async controlPool(poolId, action) {
    try {
      const pools = await this._readPools();
      const pool = pools.find(p => p.id === poolId);

      if (!pool) {
        throw new Error(`Pool ${poolId} not found`);
      }

      const allDisks = [...pool.data_devices, ...pool.parity_devices];
      const results = [];

      for (const disk of allDisks) {
        try {
          const result = await this.controlDisk(poolId, disk.id, action);
          results.push(result);
        } catch (error) {
          results.push({
            success: false,
            diskUuid: disk.id,
            device: disk.device,
            slot: disk.slot,
            action,
            message: error.message
          });
        }
      }

      return results;

    } catch (error) {
      throw new Error(`Failed to ${action} pool: ${error.message}`);
    }
  }

  /**
   * Inject power status information directly into pool devices
   */
  async _injectPowerStatusIntoDevices(pool) {
    // Collect all devices that need power status checks
    const allDevices = [
      ...(pool.data_devices || []),
      ...(pool.parity_devices || [])
    ];

    // Query all power statuses in parallel (each smartctl call is independent)
    // Standby handling is preserved: _getLiveDiskPowerStatus() still returns 'standby' correctly
    await Promise.all(allDevices.map(async (device) => {
      if (!device.device) {
        device.powerStatus = 'unknown';
        return;
      }

      // Check if this is a mapper device (LUKS encrypted)
      let targetDevice = device.device;
      if (device.device.startsWith('/dev/mapper/')) {
        const underlying = await this._getPhysicalDeviceFromMapper(device.device);
        if (underlying) {
          targetDevice = underlying;
        }
      }

      try {
        const diskPowerInfo = await this.disksService._getLiveDiskPowerStatus(targetDevice);
        device.powerStatus = diskPowerInfo.status;
      } catch (error) {
        device.powerStatus = 'unknown';
      }
    }));
  }

  /**
   * Get base disk device from partition
   * E.g. /dev/sdj1 -> /dev/sdj, /dev/nvme2n1p1 -> /dev/nvme2n1
   * @param {string} devicePath - Device path (partition or disk)
   * @returns {string} Base disk device path
   * @private
   */
  _getBaseDiskFromPartition(devicePath) {
    if (!devicePath) return devicePath;

    // Disks whose name ends in a digit use a 'p' separator for partitions
    // (nvme, mmcblk, bcache, loop, md, mtdblk, zram, ...):
    //   /dev/nvme2n1p1 -> /dev/nvme2n1, /dev/mmcblk0p1 -> /dev/mmcblk0
    // A name WITHOUT a trailing 'pN' (e.g. /dev/nvme2n1) is already a base disk.
    if (/\dp\d+$/.test(devicePath)) {
      return devicePath.replace(/p\d+$/, '');
    }

    // SCSI/SATA/virtio/IDE style names end in a letter, so partitions are bare
    // trailing digits (sdX/vdX/hdX/xvdX/srX): /dev/sdj1 -> /dev/sdj.
    // Anchored so base disks ending in a digit are never falsely stripped.
    if (/^\/dev\/(?:sd|vd|hd|xvd|sr)[a-z]+\d+$/.test(devicePath)) {
      return devicePath.replace(/\d+$/, '');
    }

    // Already a base disk (or mapper/unknown device) -> return unchanged
    return devicePath;
  }

  /**
   * Inject disk information (name, model, serial) into devices
   * @param {Object} pool - Pool object
   * @private
   */
  async _injectDiskInfoIntoDevices(pool) {
    try {
      // Lazy import to avoid circular dependency
      // Note: disks.service exports an instance
      const disksService = require('./disks.service');
      await disksService.ensureDescriptionsLoaded();

      // Use cached disk info map if available (model/serial are static, 30s TTL)
      // This avoids calling getAllDisks() (which runs smartctl per disk) on every listPools()
      let diskMap = this._diskInfoMapCache;
      if (!diskMap || (Date.now() - this._diskInfoMapCacheTimestamp) > this._diskInfoMapCacheTTL) {
        // Get all disks with their information
        // skipStandby: true ensures that standby disks are not woken up
        // They will still be included in the result with basic info (model, serial) but without partitions
        const allDisks = await disksService.getAllDisks({ skipStandby: true, includePerformance: false });

        // Create a map for quick lookup by device path
        diskMap = {};
        for (const disk of allDisks) {
          diskMap[disk.device] = {
            diskName: disk.name,
            diskModel: disk.model,
            diskSerial: disk.serial
          };
        }

        // Cache the disk info map
        this._diskInfoMapCache = diskMap;
        this._diskInfoMapCacheTimestamp = Date.now();
      }

      // Inject disk info into data devices
      for (const device of pool.data_devices || []) {
        if (!device.device) continue;

        // Check if this is a mapper device (LUKS encrypted)
        let physicalDevice = device.device;
        if (device.device.startsWith('/dev/mapper/')) {
          const underlying = await this._getPhysicalDeviceFromMapper(device.device);
          if (underlying) {
            physicalDevice = underlying;
          }
        }

        // Try to find disk info by converting partition to base disk
        const baseDisk = this._getBaseDiskFromPartition(physicalDevice);
        const diskInfo = diskMap[baseDisk];

        if (diskInfo) {
          device.diskInfo = diskInfo;
        } else {
          // If disk not found, try to extract name from device path
          const deviceName = device.device ? device.device.replace('/dev/', '') : null;
          device.diskInfo = {
            diskName: deviceName || 'unknown',
            diskModel: 'Unknown',
            diskSerial: 'Unknown'
          };
        }
        device.description = disksService.getDescription(device.diskInfo.diskSerial);
      }

      // Inject disk info into parity devices
      for (const device of pool.parity_devices || []) {
        if (!device.device) continue;

        // Check if this is a mapper device (LUKS encrypted)
        let physicalDevice = device.device;
        if (device.device.startsWith('/dev/mapper/')) {
          const underlying = await this._getPhysicalDeviceFromMapper(device.device);
          if (underlying) {
            physicalDevice = underlying;
          }
        }

        // Try to find disk info by converting partition to base disk
        const baseDisk = this._getBaseDiskFromPartition(physicalDevice);
        const diskInfo = diskMap[baseDisk];

        if (diskInfo) {
          device.diskInfo = diskInfo;
        } else {
          // If disk not found, try to extract name from device path
          const deviceName = device.device ? device.device.replace('/dev/', '') : null;
          device.diskInfo = {
            diskName: deviceName || 'unknown',
            diskModel: 'Unknown',
            diskSerial: 'Unknown'
          };
        }
        device.description = disksService.getDescription(device.diskInfo.diskSerial);
      }
    } catch (error) {
      console.warn(`Warning: Could not inject disk info into devices: ${error.message}`);
      // Don't throw error, just log warning and continue
    }
  }

  /**
   * Get overall pool power status (wake/standby)
   * @param {string} poolId - Pool ID
   * @returns {Promise<string>} Overall power status: 'wake', 'standby', 'mixed', or 'unknown'
   */
  async _getPoolPowerStatus(poolId) {
    try {
      const pools = await this._readPools();
      const pool = pools.find(p => p.id === poolId);

      if (!pool) {
        return 'unknown';
      }

      const allDisks = [...pool.data_devices, ...pool.parity_devices];
      if (allDisks.length === 0) {
        return 'unknown';
      }

      const powerStatuses = [];

      for (const disk of allDisks) {
        try {
          const diskPowerInfo = await this.disksService._getLiveDiskPowerStatus(disk.device);
          disk.powerStatus = diskPowerInfo.status;
          powerStatuses.push(diskPowerInfo.status);
        } catch (error) {
          disk.powerStatus = 'unknown';
          powerStatuses.push('unknown');
        }
      }

      // Determine overall status
      const uniqueStatuses = [...new Set(powerStatuses)];

      if (uniqueStatuses.length === 1) {
        const status = uniqueStatuses[0];
        if (status === 'active') return 'wake';
        if (status === 'standby') return 'standby';
        return 'unknown';
      } else if (uniqueStatuses.includes('active') && uniqueStatuses.includes('standby')) {
        return 'mixed';
      } else {
        return 'unknown';
      }

    } catch (error) {
      return 'unknown';
    }
  }

  /**
   * Start the pool usage alert monitor.
   * Runs a single interval (every 10 minutes) that checks the usage of all
   * mounted, awake pools against their configured warning/alert thresholds.
   * Cheap by design: df reads cached filesystem stats (no disk wake-up) and
   * pools in standby are skipped entirely (their usage cannot change).
   * @private
   */
  _startUsageAlertMonitor() {
    const intervalMs = 10 * 60 * 1000; // 10 minutes

    PoolsService._usageMonitorInterval = setInterval(() => {
      this._checkPoolsUsage().catch(err =>
        console.warn(`Pool usage check failed: ${err.message}`));
    }, intervalMs);

    // Don't keep the process alive just for this timer
    if (PoolsService._usageMonitorInterval.unref) {
      PoolsService._usageMonitorInterval.unref();
    }

    // Initial delayed run after startup
    setTimeout(() => {
      this._checkPoolsUsage().catch(err =>
        console.warn(`Pool usage check failed: ${err.message}`));
    }, 15 * 1000);

    console.log('Pool usage alert monitor started (interval: 10min)');
  }

  /**
   * Stop the pool usage alert monitor.
   * @private
   */
  _stopUsageAlertMonitor() {
    if (PoolsService._usageMonitorInterval) {
      clearInterval(PoolsService._usageMonitorInterval);
      PoolsService._usageMonitorInterval = null;
    }
  }

  /**
   * Check usage for all pools (processed sequentially to avoid load spikes).
   * @private
   */
  async _checkPoolsUsage() {
    let pools;
    try {
      pools = await this._readPools();
    } catch (error) {
      console.warn(`Pool usage monitor: could not read pools: ${error.message}`);
      return;
    }

    // Sequential on purpose: spreads the few smartctl/df calls over time
    for (const pool of pools) {
      try {
        await this._checkSinglePoolUsage(pool);
      } catch (error) {
        console.warn(`Usage check failed for pool ${pool.name}: ${error.message}`);
      }
    }
  }

  /**
   * Check a single pool's usage against its thresholds and notify on changes.
   * Notification rules (anti-spam):
   * - Notify when the level changes (normal/warning/alert), in either direction.
   * - Within an elevated level, notify only when the usage percent value changes.
   * - Stable usage at the same level stays silent.
   * @param {Object} pool - Pool object (raw, from _readPools)
   * @private
   */
  async _checkSinglePoolUsage(pool) {
    const cfg = pool.config && pool.config.usage_alert;
    const warning = Number.isFinite(cfg && cfg.warning) ? cfg.warning : 70;
    const alert = Number.isFinite(cfg && cfg.alert) ? cfg.alert : 90;

    // Both thresholds disabled -> skip this pool entirely
    if (warning === 0 && alert === 0) {
      PoolsService._usageAlertState.delete(pool.id);
      return;
    }

    const mountPoint = path.join(this.mountBasePath, pool.name);
    if (!(await this._isMounted(mountPoint))) {
      PoolsService._usageAlertState.delete(pool.id);
      return;
    }

    // Skip sleeping pools: nothing can write, so usage cannot have changed.
    // _getPoolPowerStatus uses smartctl -n standby and does NOT wake disks.
    const powerStatus = await this._getPoolPowerStatus(pool.id);
    if (powerStatus === 'standby') {
      return; // keep last known state untouched
    }

    const space = await this.getDeviceSpace(mountPoint);
    if (!space || !space.mounted || typeof space.usagePercent !== 'number') {
      return;
    }
    const percent = Math.round(space.usagePercent);

    // Determine current level (a threshold of 0 disables that level)
    let level = 'normal';
    if (alert > 0 && percent >= alert) {
      level = 'alert';
    } else if (warning > 0 && percent >= warning) {
      level = 'warning';
    }

    const prev = PoolsService._usageAlertState.get(pool.id) || { level: 'normal', percent: null };

    let notify = false;
    if (level !== prev.level) {
      notify = true; // escalation or recovery
    } else if (level !== 'normal' && percent !== prev.percent) {
      notify = true; // same elevated level, but usage value changed
    }

    if (notify) {
      this._sendUsageNotification(pool, level, prev.level, percent);
    }

    PoolsService._usageAlertState.set(pool.id, { level, percent });
  }

  /**
   * Send a pool usage notification for the given level transition.
   * @param {Object} pool - Pool object
   * @param {string} level - New level: 'normal' | 'warning' | 'alert'
   * @param {string} prevLevel - Previous level
   * @param {number} percent - Current usage percent
   * @private
   */
  _sendUsageNotification(pool, level, prevLevel, percent) {
    let message;
    let priority;

    if (level === 'alert') {
      message = `Pool "${pool.name}" usage at ${percent}% - alert threshold reached`;
      priority = 'alert';
    } else if (level === 'warning') {
      if (prevLevel === 'alert') {
        message = `Pool "${pool.name}" usage dropped to ${percent}% - back to warning level`;
      } else {
        message = `Pool "${pool.name}" usage at ${percent}% - warning threshold reached`;
      }
      priority = 'warning';
    } else {
      // Recovery to normal
      message = `Pool "${pool.name}" usage back to normal at ${percent}%`;
      priority = 'normal';
    }

    sendNotification('Pool Usage', message, priority)
      .catch(err => console.warn(`Failed to send pool usage notification: ${err.message}`));
  }

  /**
   * Open LUKS devices for a pool using specific slot numbers
   * @param {string[]} devices - Array of device paths
   * @param {string} poolName - Pool name
   * @param {number[]} slots - Array of slot numbers corresponding to devices
   * @param {string} passphrase - Passphrase for LUKS devices (optional if keyfile exists)
   * @param {boolean} isParity - Whether these are parity devices (uses different naming)
   * @returns {Promise<Object[]>} Array of objects with mappedDevice and uuid
   * @private
   */
  async _openLuksDevicesWithSlots(devices, poolName, slots, passphrase = null, isParity = false) {
    const keyfilePath = `/boot/config/system/luks/${poolName}.key`;
    const mappedDevices = [];
    const openedByUs = [];
    let useKeyfile = false;

    const cleanPassphrase = this._normalizeLuksPassphrase(passphrase);

    // Check if keyfile exists
    try {
      await fs.access(keyfilePath);
      useKeyfile = true;
      console.log(`Using keyfile for LUKS devices: ${keyfilePath}`);
    } catch (error) {
      if (!cleanPassphrase) {
        throw new Error(`No keyfile found at ${keyfilePath} and no passphrase provided`);
      }
      console.log(`No keyfile found, using passphrase for LUKS devices`);
    }

    try {
      for (let i = 0; i < devices.length; i++) {
        const device = devices[i];
        const slot = slots[i];
        const luksName = isParity ? `parity_${poolName}_${slot}` : `${poolName}_${slot}`;
        const mappedDevice = `/dev/mapper/${luksName}`;

        // Rejects the mapper when it is backed by a different device
        if (await this._isLuksMapperOpenFor(device, luksName)) {
          console.log(`LUKS device ${luksName} is already open for ${device}`);
          mappedDevices.push({
            originalDevice: device,
            mappedDevice: mappedDevice,
            uuid: await this._getLuksMapperUuid(mappedDevice),
            slot: slot
          });
          continue;
        }

        // An explicit passphrase wins over the keyfile, which may be a leftover from an
        // earlier pool of the same name. The other one is still tried as a fallback, because
        // both are valid keyslots for pools created by this API
        const openWithPassphrase = () => this._execCryptsetupWithPassphrase(
          ['luksOpen', device, luksName],
          cleanPassphrase
        );
        const openWithKeyfile = () =>
          execPromise(`cryptsetup luksOpen ${device} ${luksName} --key-file ${keyfilePath}`);

        if (cleanPassphrase && useKeyfile) {
          await openWithPassphrase().catch(async error => {
            console.warn(`Passphrase did not unlock ${device}, falling back to keyfile: ${error.message}`);
            await openWithKeyfile();
          });
        } else if (cleanPassphrase) {
          await openWithPassphrase();
        } else {
          await openWithKeyfile();
        }
        openedByUs.push(luksName);

        const mappedDeviceUuid = await this._getLuksMapperUuid(mappedDevice);

        mappedDevices.push({
          originalDevice: device,
          mappedDevice: mappedDevice,
          uuid: mappedDeviceUuid,
          slot: slot
        });

        console.log(`Opened LUKS device: ${device} -> ${mappedDevice} (UUID: ${mappedDeviceUuid}, Slot: ${slot})`);
      }

      return mappedDevices;
    } catch (error) {
      // Leave no half-opened mappers behind, but keep mappers that were already open
      for (const luksName of openedByUs.reverse()) {
        await execPromise(`cryptsetup luksClose ${luksName}`).catch(() => {});
      }
      throw error;
    }
  }

  /**
   * Get the filesystem UUID behind a LUKS mapper
   * Pools created by the API put the filesystem straight onto the mapper, older layouts
   * carry a partition table inside the container
   * @param {string} mappedDevice - Mapper path
   * @returns {Promise<string|null>} Filesystem UUID or null
   * @private
   */
  async _getLuksMapperUuid(mappedDevice) {
    return await this.getDeviceUuid(mappedDevice)
      || await this.getDeviceUuid(this._getPartitionPath(mappedDevice, 1));
  }



  /**
   * Mount a multi-device BTRFS pool
   * @param {Object} pool - Pool object
   * @param {Object} options - Mount options
   * @private
   */
  async _mountMultiDeviceBtrfsPool(pool, options = {}) {
    const mountPoint = path.join(this.mountBasePath, pool.name);

    // Ensure device paths are available
    await this._ensureDevicePaths(pool);

    // Handle LUKS encryption before mounting
    if (pool.config?.encrypted) {
      console.log(`Opening LUKS devices for encrypted multi-device BTRFS pool '${pool.name}'`);

      const physicalDevices = pool.data_devices.map(d => d.device);

      // Device paths resolve from the LUKS container UUID, so a mapper path here means the
      // pool config still carries a stale mapped path from an older API version
      if (physicalDevices.some(d => d && d.startsWith('/dev/mapper/'))) {
        pool._luksDevices = pool.data_devices.map(d => ({
          originalDevice: d.device,
          mappedDevice: d.device,
          uuid: d.id,
          slot: parseInt(d.slot)
        }));
      } else {
        const dataSlots = pool.data_devices.map(d => parseInt(d.slot));
        pool._luksDevices = await this._openLuksDevicesWithSlots(
          physicalDevices,
          pool.name,
          dataSlots,
          options.passphrase || null
        );
      }
    }

    // For BTRFS, we can mount using any device from the array
    let mountDevice = pool.data_devices[0].device;

    // For LUKS pools, use the first mapped device
    if (pool.config?.encrypted && pool._luksDevices) {
      mountDevice = pool._luksDevices[0].mappedDevice;
    }

    // Mount the BTRFS pool
    const mountResult = await this.mountDevice(mountDevice, mountPoint, {
      format: options.format,
      filesystem: 'btrfs',
      mountOptions: options.mountOptions
    });

    // Get space info after successful mount
    const spaceInfo = await this.getDeviceSpace(mountPoint);

    return {
      success: true,
      message: `Multi-device BTRFS pool "${pool.name}" mounted successfully`,
      pool: {
        id: pool.id,
        name: pool.name,
        status: spaceInfo
      }
    };
  }

  /**
   * Mount a MergerFS pool
   * @param {Object} pool - Pool object
   * @param {Object} options - Mount options
   * @private
   */
  async _mountMergerFSPool(pool, options = {}) {
    const mountPoint = path.join(this.mountBasePath, pool.name);
    const mergerfsBasePath = path.join(this.mergerfsBasePath, pool.name);

    // Ensure device paths are available
    await this._ensureDevicePaths(pool);

    // Handle LUKS encryption before mounting
    if (pool.config?.encrypted) {
      console.log(`Opening LUKS devices for encrypted MergerFS pool '${pool.name}'`);

      // Extract physical device paths from data_devices and parity_devices
      const dataDevices = pool.data_devices.map(d => d.device);
      const parityDevices = pool.parity_devices.map(d => d.device);

      // Open data device LUKS mappers with slot-based naming
      const dataSlots = pool.data_devices.map(d => parseInt(d.slot));
      const luksDevices = await this._openLuksDevicesWithSlots(dataDevices, pool.name, dataSlots, options.passphrase || null);
      pool._luksDevices = luksDevices;

      // Open parity device LUKS mappers if they exist
      if (parityDevices.length > 0) {
        console.log(`Opening parity LUKS devices for encrypted MergerFS pool '${pool.name}'`);
        const paritySlots = pool.parity_devices.map(d => parseInt(d.slot));
        const parityLuksDevices = await this._openLuksDevicesWithSlots(parityDevices, pool.name, paritySlots, options.passphrase || null, true);
        pool._parityLuksDevices = parityLuksDevices;
      }
    }

    // Create mergerfs base directory
    await this._createDirectoryWithOwnership(mergerfsBasePath);

    // Mount individual data devices
    const mountedDevices = [];
    for (let i = 0; i < pool.data_devices.length; i++) {
      const device = pool.data_devices[i];
      let actualDevice = device.device;

      // For LUKS pools, use the mapped device
      if (pool.config?.encrypted && pool._luksDevices) {
        actualDevice = pool._luksDevices[i].mappedDevice;
      }

      const deviceMountPoint = path.join(mergerfsBasePath, `disk${device.slot}`);

      await this.mountDevice(actualDevice, deviceMountPoint, {
        format: options.format,
        filesystem: device.filesystem || 'xfs',
        mountOptions: options.mountOptions
      });

      mountedDevices.push(deviceMountPoint);
    }

    // Mount parity devices if they exist
    for (let i = 0; i < (pool.parity_devices || []).length; i++) {
      const parityDevice = pool.parity_devices[i];
      let actualParityDevice = parityDevice.device;

      // For encrypted pools, use the mapped parity device
      if (pool.config?.encrypted && pool._parityLuksDevices) {
        const mappedParity = pool._parityLuksDevices.find(d => d.slot === parseInt(parityDevice.slot));
        if (mappedParity) {
          actualParityDevice = mappedParity.mappedDevice;
        }
      }

      const snapraidPoolPath = path.join(this.snapraidBasePath, pool.name);
      const parityMountPoint = path.join(snapraidPoolPath, `parity${parityDevice.slot}`);

      await this.mountDevice(actualParityDevice, parityMountPoint, {
        format: options.format,
        filesystem: parityDevice.filesystem || 'xfs',
        mountOptions: options.mountOptions
      });
    }

    // Create main mount point
    await this._createDirectoryWithOwnership(mountPoint);

    // Mount MergerFS
    const mergerfsOptions = this._buildMergerfsOptions(pool.config);
    const mergerfsCommand = `mergerfs ${mountedDevices.join(':')} ${mountPoint} -o ${mergerfsOptions}`;
    await execPromise(mergerfsCommand);

    // Get space info after successful mount
    const spaceInfo = await this.getDeviceSpace(mountPoint);

    return {
      success: true,
      message: `MergerFS pool "${pool.name}" mounted successfully`,
      pool: {
        id: pool.id,
        name: pool.name,
        status: spaceInfo
      }
    };
  }

  /**
   * Mount a NonRAID pool
   * @param {Object} pool - Pool object
   * @param {Object} options - Mount options
   * @private
   */
  async _mountNonRaidPool(pool, options = {}) {
    const mountPoint = path.join(this.mountBasePath, pool.name);
    const nonraidBasePath = path.join(this.mergerfsBasePath, pool.name);

    try {
      // Ensure device paths are available
      await this._ensureDevicePaths(pool);

      // Check if md-nonraid module is loaded
      let moduleLoaded = false;
      try {
        const { stdout } = await execPromise('lsmod | grep -E "md.nonraid"');
        moduleLoaded = stdout.trim().length > 0;
      } catch (error) {
        // grep returns non-zero if no match
        moduleLoaded = false;
      }

      // Check for missing devices (both data and parity)
      const missingDataDevices = [];
      const availableDataDevices = [];
      const missingParityDevices = [];
      const availableParityDevices = [];

      // Check data devices availability
      for (const device of pool.data_devices) {
        // For encrypted pools the stored UUID is the one of the LUKS container, so this
        // resolves to the physical device in both cases
        const physicalDevice = await this.getRealDevicePathFromUuid(device.id);

        // Check if device exists
        if (physicalDevice) {
          try {
            await fs.access(physicalDevice);
            availableDataDevices.push({ ...device, physicalDevice });
          } catch (error) {
            missingDataDevices.push(device);
            console.warn(`Data device at slot ${device.slot} (${device.id}) is missing`);
          }
        } else {
          missingDataDevices.push(device);
          console.warn(`Data device at slot ${device.slot} (${device.id}) could not be resolved`);
        }
      }

      // Check parity devices availability (always allow missing parity)
      if (pool.parity_devices && pool.parity_devices.length > 0) {
        for (const parityDevice of pool.parity_devices) {
          const byIdPath = `/dev/disk/by-id/${parityDevice.id}`;

          try {
            const { stdout } = await execPromise(`readlink -f ${byIdPath}`);
            const actualDevice = stdout.trim();
            await fs.access(actualDevice);
            availableParityDevices.push({ ...parityDevice, actualDevice });
          } catch (error) {
            missingParityDevices.push(parityDevice);
            console.warn(`Parity device at slot ${parityDevice.slot} (${parityDevice.id}) is missing`);
          }
        }
      }

      // Validate missing devices based on mount_missing option
      const mountMissing = options.mount_missing || false;
      const totalParityCount = (pool.parity_devices || []).length;

      if (missingDataDevices.length > 0) {
        if (!mountMissing) {
          throw new Error(
            `Cannot mount NonRAID pool: ${missingDataDevices.length} data device(s) missing. ` +
            `Use mount_missing: true to mount in degraded mode.`
          );
        }

        // Check if we have enough parity devices to recover
        if (missingDataDevices.length > totalParityCount) {
          throw new Error(
            `Cannot mount NonRAID pool: ${missingDataDevices.length} data device(s) missing, ` +
            `but only ${totalParityCount} parity device(s) available. Cannot recover data.`
          );
        }

        console.log(
          `Mounting NonRAID pool in degraded mode: ${missingDataDevices.length} data device(s) missing, ` +
          `${totalParityCount} parity device(s) available`
        );
      }

      // Load md-nonraid module if not loaded
      if (!moduleLoaded) {
        console.log('Loading md-nonraid kernel module...');
        const nonraidDatPath = '/boot/config/system/nonraid.dat';
        await execPromise(`modprobe md-nonraid super=${nonraidDatPath}`);
      }

      // Create nonraid base directory
      await this._createDirectoryWithOwnership(nonraidBasePath);

      // The array keeps running after adding a disk (e.g. while it is being cleared)
      const nmdstat = await this._readNmdstat();
      const arrayStarted = nmdstat?.mdState === 'STARTED';

      if (!arrayStarted) {
        // Import available data devices into NonRAID array
        console.log('Importing available data devices into NonRAID array...');
        for (const device of availableDataDevices) {
          const slot = parseInt(device.slot);
          const physicalDevice = device.physicalDevice;

          // Get device size from physical partition
          const deviceSize = await this._getDeviceSizeInKB(physicalDevice);

          // Get basename for import command
          const deviceBasename = path.basename(physicalDevice);

          // Import device into NonRAID array
          const importCmd = `echo "import ${slot} ${deviceBasename} 0 ${deviceSize} 0 ${device.id}" > /proc/nmdcmd`;
          console.log(`Importing data device slot ${slot}: ${importCmd}`);
          await execPromise(importCmd);
        }

        // New disks that are not cleared/formatted yet are only known to the driver
        for (const { slot, id } of this._getNonRaidPendingSlots(pool, nmdstat)) {
          const physicalDevice = await this.getRealDevicePathFromUuid(id);
          if (!physicalDevice) {
            console.warn(`Pending data device at slot ${slot} (${id}) could not be resolved`);
            continue;
          }
          const deviceSize = await this._getDeviceSizeInKB(physicalDevice);
          const importCmd = `echo "import ${slot} ${path.basename(physicalDevice)} 0 ${deviceSize} 0 ${id}" > /proc/nmdcmd`;
          console.log(`Importing pending data device slot ${slot}: ${importCmd}`);
          await execPromise(importCmd);
        }

        // Import missing data devices as empty
        if (missingDataDevices.length > 0) {
          console.log('Importing missing data devices as empty slots...');
          for (const device of missingDataDevices) {
            const slot = parseInt(device.slot);
            const importCmd = `echo "import ${slot} '' 0 0 0 ''" > /proc/nmdcmd`;
            console.log(`Importing missing data device slot ${slot}: ${importCmd}`);
            await execPromise(importCmd);
          }
        }

        // Import available parity devices
        if (availableParityDevices.length > 0) {
          console.log('Importing available parity devices into NonRAID array...');
          for (const parityDevice of availableParityDevices) {
            // Map JSON slot (1,2) to array slot (0,29)
            const jsonSlot = parseInt(parityDevice.slot);
            const arraySlot = jsonSlot === 1 ? 0 : 29;

            // Get device size from physical device (whole disk, not partition)
            const deviceSize = await this._getDeviceSizeInKB(parityDevice.actualDevice);

            // Get basename for import command (whole disk, no partition)
            const deviceBasename = path.basename(parityDevice.actualDevice);

            // Import parity device
            const importCmd = `echo "import ${arraySlot} ${deviceBasename} 0 ${deviceSize} 0 ${parityDevice.id}" > /proc/nmdcmd`;
            console.log(`Importing parity device slot ${arraySlot}: ${importCmd}`);
            await execPromise(importCmd);
          }
        }

        // Import missing parity devices as empty (always allowed)
        if (missingParityDevices.length > 0) {
          console.log('Importing missing parity devices as empty slots...');
          for (const parityDevice of missingParityDevices) {
            // Map JSON slot (1,2) to array slot (0,29)
            const jsonSlot = parseInt(parityDevice.slot);
            const arraySlot = jsonSlot === 1 ? 0 : 29;

            const importCmd = `echo "import ${arraySlot} '' 0 0 0 ''" > /proc/nmdcmd`;
            console.log(`Importing missing parity device slot ${arraySlot}: ${importCmd}`);
            await execPromise(importCmd);
          }
        }

        await this._startNonRaidArray();
      }

      // Set write mode based on config
      const writeMode = pool.config?.md_writemode || 'normal';
      await this._setNonRaidWriteMode(writeMode);

      // LUKS sits on top of md-nonraid, so the containers can only be opened once the array
      // is running
      const operationalDevices = availableDataDevices.map(d => `/dev/nmd${parseInt(d.slot)}p1`);

      if (pool.config?.encrypted && availableDataDevices.length > 0) {
        console.log(`Opening LUKS devices for encrypted NonRAID pool '${pool.name}'`);

        const dataSlots = availableDataDevices.map(d => parseInt(d.slot));
        pool._luksDevices = await this._openLuksDevicesWithSlots(
          operationalDevices,
          pool.name,
          dataSlots,
          options.passphrase || null
        );

        for (let i = 0; i < pool._luksDevices.length; i++) {
          operationalDevices[i] = pool._luksDevices[i].mappedDevice;
        }
      }

      // Mount individual data devices (only available ones)
      const mountedDevices = [];
      for (let i = 0; i < availableDataDevices.length; i++) {
        const device = availableDataDevices[i];
        const slot = device.slot;
        const deviceMountPoint = path.join(nonraidBasePath, `disk${slot}`);

        await this._createDirectoryWithOwnership(deviceMountPoint);
        await execPromise(`mount -t ${device.filesystem || 'xfs'} -o nodiscard ${operationalDevices[i]} ${deviceMountPoint}`);

        mountedDevices.push(deviceMountPoint);
        console.log(`Mounted ${operationalDevices[i]} to ${deviceMountPoint}`);
      }

      // Log warning if mounting in degraded mode
      if (missingDataDevices.length > 0 || missingParityDevices.length > 0) {
        console.warn(
          `NonRAID pool mounted in degraded mode: ` +
          `${missingDataDevices.length} data device(s) missing, ` +
          `${missingParityDevices.length} parity device(s) missing`
        );
      }

      // Create main mount point
      await this._createDirectoryWithOwnership(mountPoint);

      // Mount MergerFS
      const mergerfsOptions = this._buildMergerfsOptions(pool.config);
      const mergerfsCommand = `mergerfs ${mountedDevices.join(':')} ${mountPoint} -o ${mergerfsOptions}`;
      await execPromise(mergerfsCommand);

      // Get space info after successful mount
      const spaceInfo = await this.getDeviceSpace(mountPoint);

      // Build message with degraded mode info if applicable
      let message = `NonRAID pool "${pool.name}" mounted successfully`;
      if (missingDataDevices.length > 0 || missingParityDevices.length > 0) {
        message += ` (degraded mode: ${missingDataDevices.length} data + ${missingParityDevices.length} parity device(s) missing)`;
      }

      this._resumePendingNonRaidDisks(options.passphrase || null)
        .catch(err => console.warn(`Resuming pending NonRAID disks failed: ${err.message}`));

      return {
        success: true,
        message,
        pool: {
          id: pool.id,
          name: pool.name,
          status: spaceInfo
        }
      };
    } catch (error) {
      console.error(`Error mounting NonRAID pool: ${error.message}`);
      throw error;
    }
  }

  /**
   * Unmount a multi-device BTRFS pool
   * @param {Object} pool - Pool object
   * @param {boolean} force - Force unmount
   * @private
   */
  async _unmountMultiDeviceBtrfsPool(pool, force = false) {
    const mountPoint = path.join(this.mountBasePath, pool.name);

    // Check if pool is mounted
    if (await this._isMounted(mountPoint)) {
      // Unmount the BTRFS pool
      await this.unmountDevice(mountPoint, { force, removeDirectory: true });
    }

    // Close LUKS devices if pool is encrypted
    if (pool.config?.encrypted) {
      console.log(`Closing LUKS devices for encrypted multi-device BTRFS pool '${pool.name}'`);
      // Ensure device paths are available before closing LUKS
      await this._ensureDevicePaths(pool);
      const physicalDevices = pool.data_devices.map(d => d.device);
      const dataSlots = pool.data_devices.map(d => parseInt(d.slot));
      await this._closeLuksDevicesWithSlots(physicalDevices, pool.name, dataSlots);
    }



    return {
      success: true,
      message: `Multi-device BTRFS pool "${pool.name}" unmounted successfully`,
      pool: {
        id: pool.id,
        name: pool.name,
        status: {
          mounted: false
        }
      }
    };
  }

  /**
   * Mount a bcachefs pool
   * All members have to be named at mount time, so every device is resolved first
   * @param {Object} pool - Pool object
   * @param {Object} options - Mount options
   * @private
   */
  async _mountBcachefsPool(pool, options = {}) {
    const mountPoint = path.join(this.mountBasePath, pool.name);

    await this._assertBcachefsAvailable();

    const members = await this._resolveBcachefsMembers(pool, options);
    const source = BcachefsHelpers.buildMountSource(members);

    await this._createDirectoryWithOwnership(mountPoint, this.defaultOwnership);

    const mountOptions = options.mountOptions ? `-o ${options.mountOptions}` : '';
    await execPromise(`mount -t bcachefs ${mountOptions} ${source} ${mountPoint}`);

    const spaceInfo = await this.getDeviceSpace(mountPoint);

    return {
      success: true,
      message: `bcachefs pool "${pool.name}" mounted successfully`,
      pool: {
        id: pool.id,
        name: pool.name,
        status: spaceInfo
      }
    };
  }

  /**
   * Unmount a bcachefs pool and close its LUKS devices
   * @param {Object} pool - Pool object
   * @param {boolean} force - Force unmount
   * @private
   */
  async _unmountBcachefsPool(pool, force = false) {
    const mountPoint = path.join(this.mountBasePath, pool.name);

    if (await this._isMounted(mountPoint)) {
      await this.unmountDevice(mountPoint, { force, removeDirectory: true });
    }

    if (pool.config?.encrypted) {
      console.log(`Closing LUKS devices for encrypted bcachefs pool '${pool.name}'`);
      await this._ensureDevicePaths(pool);

      const devices = [...(pool.data_devices || [])].sort((a, b) => a.slot - b.slot);
      await this._closeLuksDevicesWithSlots(
        devices.map(d => d.device),
        pool.name,
        devices.map(d => parseInt(d.slot))
      );
    }

    return {
      success: true,
      message: `bcachefs pool "${pool.name}" unmounted successfully`,
      pool: {
        id: pool.id,
        name: pool.name,
        status: {
          mounted: false
        }
      }
    };
  }



  /**
   * Get power status for all disks in a pool
   * @param {string} poolId - Pool ID
   * @returns {Promise<Object>} Power status for all disks
   */
  async getPoolDisksPowerStatus(poolId) {
    try {
      const pools = await this._readPools();
      const pool = pools.find(p => p.id === poolId);

      if (!pool) {
        throw new Error(`Pool with ID ${poolId} not found`);
      }

      const allDisks = [...pool.data_devices, ...pool.parity_devices];
      const results = [];

      for (const disk of allDisks) {
        try {
          const diskStatus = await this.getDiskStatus(poolId, disk.id);
          results.push(diskStatus);
        } catch (error) {
          results.push({
            success: false,
            poolId,
            poolName: pool.name,
            diskUuid: disk.id,
            device: disk.device,
            slot: disk.slot,
            diskType: pool.data_devices.find(d => d.id === disk.id) ? 'data' : 'parity',
            powerStatus: 'error',
            message: error.message
          });
        }
      }

      return results;

    } catch (error) {
      throw new Error(`Failed to get pool disks power status: ${error.message}`);
    }
  }

  /**
   * Get available pool types based on system capabilities
   * Returns static pool types and conditionally includes 'nonraid' based on:
   * - md-nonraid kernel module availability
   * - No existing nonraid pool
   * and 'bcachefs' based on bcachefs kernel module availability
   * @returns {Promise<Array<string>>} - Array of available pool types
   */
  async getAvailablePoolTypes() {
    // Start with static pool types
    const poolTypes = ['single', 'multi', 'mergerfs'];

    try {
      // Check if md-nonraid module is available (without loading it)
      let moduleAvailable = false;
      try {
        await execPromise('modinfo md-nonraid');
        moduleAvailable = true;
      } catch (error) {
        // Module not available
        moduleAvailable = false;
      }

      // If module is available, check if there's already a nonraid pool - disabled for now
      const pools = await this._readPools();
      const hasNonRaidPool = pools.some(pool => pool.type === 'nonraid');

      // Only add nonraid if module is available AND no nonraid pool exists
      if (moduleAvailable && !hasNonRaidPool) {
        poolTypes.push('nonraid');
      }
    } catch (error) {
      // If there's any error reading pools, just return the basic types
      console.warn(`Warning: Could not check nonraid availability: ${error.message}`);
    }

    // bcachefs ships via the mos-bcachefs plugin, so it is only offered once installed.
    // Checked independently so a failing nonraid probe cannot hide it.
    if (await this._isBcachefsAvailable()) {
      poolTypes.push('bcachefs');
    }

    return poolTypes;
  }

}

// Export the class
module.exports = PoolsService;
