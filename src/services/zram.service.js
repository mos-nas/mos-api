const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// Unique ID-Generator with counter to prevent duplicates in rapid succession
let idCounter = 0;
const generateId = () => `${Date.now()}${++idCounter}`;

class ZramService {
  constructor() {
    this.configPath = '/boot/config/system/zram.json';
  }

  // ============================================================
  // CONFIG MANAGEMENT
  // ============================================================

  /**
   * Ensure the config directory exists
   * @private
   */
  async _ensureConfigDir() {
    const dir = path.dirname(this.configPath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }

  /**
   * Get default config structure
   * @private
   */
  _getDefaultConfig() {
    return {
      enabled: false,
      zram_devices: 0,
      devices: []
    };
  }

  /**
   * Load ZRAM configuration
   * @returns {Promise<Object>} ZRAM configuration
   */
  async loadConfig() {
    try {
      const data = await fs.readFile(this.configPath, 'utf8');
      const config = JSON.parse(data);
      return this._validateConfig(config);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return this._getDefaultConfig();
      }
      throw new Error(`Failed to load ZRAM config: ${error.message}`);
    }
  }

  /**
   * Save ZRAM configuration
   * @param {Object} config - Configuration to save
   * @private
   */
  async _saveConfig(config) {
    await this._ensureConfigDir();
    // Update zram_devices count
    config.zram_devices = config.devices.length;
    await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf8');
    return config;
  }

  /**
   * Validate and normalize config structure
   * @private
   */
  _validateConfig(config) {
    if (!config || typeof config !== 'object') {
      return this._getDefaultConfig();
    }
    return {
      enabled: config.enabled === true,
      zram_devices: config.zram_devices || 0,
      devices: Array.isArray(config.devices) ? config.devices : []
    };
  }

  /**
   * Generate UUID using uuidgen
   * @returns {Promise<string>} Generated UUID
   * @private
   */
  async _generateUUID() {
    const { stdout } = await execPromise('uuidgen');
    return stdout.trim();
  }

  // ============================================================
  // MODULE MANAGEMENT
  // ============================================================

  /**
   * Check if ZRAM module is loaded
   * @returns {Promise<boolean>}
   */
  async isModuleLoaded() {
    try {
      const { stdout } = await execPromise('lsmod | grep -E "^zram\\s"');
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Get current number of ZRAM devices from kernel
   * @returns {Promise<number>}
   */
  async getKernelDeviceCount() {
    try {
      const { stdout } = await execPromise('cat /sys/class/zram-control/hot_add 2>/dev/null || echo "-1"');
      // hot_add returns next available index, so we need to count existing devices
      const { stdout: lsOutput } = await execPromise('ls -d /sys/block/zram* 2>/dev/null | wc -l');
      return parseInt(lsOutput.trim()) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Load ZRAM module with specified number of devices
   * @param {number} numDevices - Number of ZRAM devices to create
   */
  async loadModule(numDevices) {
    if (numDevices < 1) {
      throw new Error('At least 1 ZRAM device is required');
    }

    const isLoaded = await this.isModuleLoaded();
    if (isLoaded) {
      throw new Error('ZRAM module is already loaded. Unload it first.');
    }

    await execPromise(`modprobe zram num_devices=${numDevices}`);
  }

  /**
   * Unload ZRAM module (checks for active mounts first)
   */
  async unloadModule() {
    // Check if module is loaded
    const isLoaded = await this.isModuleLoaded();
    if (!isLoaded) {
      console.log('[ZRAM] Module not loaded, nothing to unload');
      return;
    }

    const config = await this.loadConfig();
    const deviceCount = await this.getKernelDeviceCount();

    // First pass: Check all ramdisks for mounts before doing anything
    const mountErrors = [];
    for (let i = 0; i < deviceCount; i++) {
      const zramDev = `/dev/zram${i}`;
      const mountPoints = await this._getMountPoints(zramDev);
      if (mountPoints.length > 0) {
        const configDevice = config.devices.find(d => d.index === i);
        const name = configDevice?.name || `zram${i}`;
        mountErrors.push(`zram${i} (${name}) at: ${mountPoints.join(', ')}`);
      }
    }

    if (mountErrors.length > 0) {
      throw new Error(`Cannot unload ZRAM: Devices still mounted:\n- ${mountErrors.join('\n- ')}\nUnmount first.`);
    }

    // Second pass: Disable all active swaps
    for (let i = 0; i < deviceCount; i++) {
      if (await this._isSwapActive(i)) {
        console.log(`[ZRAM] Disabling swap on zram${i}`);
        await this._disableSwap(i);
      }
    }

    // Reset all ZRAM devices before unloading
    for (let i = 0; i < deviceCount; i++) {
      console.log(`[ZRAM] Resetting zram${i}`);
      await this._resetDevice(i);
    }

    // Unload module
    console.log('[ZRAM] Unloading zram module');
    try {
      await execPromise('modprobe -r zram');
    } catch (error) {
      throw new Error(`Failed to unload ZRAM module: ${error.message}. Module may still be in use.`);
    }
    console.log('[ZRAM] Module unloaded successfully');
  }

  // ============================================================
  // DEVICE MANAGEMENT
  // ============================================================

  /**
   * Check if a ZRAM device is in use as swap
   * @param {number} index - ZRAM device index
   * @returns {Promise<boolean>}
   * @private
   */
  async _isSwapActive(index) {
    try {
      const { stdout } = await execPromise('cat /proc/swaps');
      return stdout.includes(`/dev/zram${index}`);
    } catch {
      return false;
    }
  }

  /**
   * Get all mount points of a device or its partitions if mounted
   * @param {string} device - Device path (e.g., /dev/zram0)
   * @returns {Promise<string[]>} Array of mount points (empty if not mounted)
   * @private
   */
  async _getMountPoints(device) {
    try {
      const { stdout } = await execPromise('cat /proc/mounts');
      const lines = stdout.split('\n');
      const mountPoints = [];
      for (const line of lines) {
        const parts = line.split(' ');
        // Check for the device itself or any of its partitions (e.g., /dev/zram0p1)
        if (parts[0] === device || parts[0].startsWith(device + 'p')) {
          mountPoints.push(parts[1]);
        }
      }
      return mountPoints;
    } catch {
      return [];
    }
  }

  /**
   * Reset a ZRAM device
   * @param {number} index - ZRAM device index
   * @private
   */
  async _resetDevice(index) {
    try {
      await execPromise(`echo 1 > /sys/block/zram${index}/reset`);
    } catch (error) {
      // Device might not exist or already reset
    }
  }

  /**
   * Disable swap on a ZRAM device
   * @param {number} index - ZRAM device index
   * @private
   */
  async _disableSwap(index) {
    try {
      if (await this._isSwapActive(index)) {
        await execPromise(`swapoff /dev/zram${index}`);
      }
    } catch (error) {
      // Might already be disabled
    }
  }

  /**
   * Setup a ZRAM device with algorithm and size
   * @param {Object} device - Device configuration
   * @returns {Promise<Object>} Device with potentially updated config (e.g., generated UUID)
   * @private
   */
  async _setupDevice(device) {
    const zramDev = `/dev/zram${device.index}`;

    // Configure with zramctl
    await execPromise(`zramctl ${zramDev} --algorithm ${device.algorithm} --size ${device.size}`);

    if (device.type === 'swap') {
      // Setup as swap
      await execPromise(`mkswap ${zramDev}`);
      await execPromise(`swapon --discard --priority ${device.config.priority} ${zramDev}`);
    } else if (device.type === 'ramdisk') {
      // Generate UUID if not provided
      let uuid = device.config.uuid;
      if (!uuid) {
        uuid = await this._generateUUID();
        device.config.uuid = uuid;
      }
      const filesystem = device.config.filesystem;

      // Wipe any existing signatures first
      await execPromise(`wipefs -a ${zramDev}`);

      // Format directly on ZRAM device (no partition needed)
      if (filesystem === 'ext4') {
        await execPromise(`mkfs.ext4 -F -U ${uuid} ${zramDev}`);
      } else if (filesystem === 'xfs') {
        await execPromise(`mkfs.xfs -f -n ftype=1 -m uuid=${uuid} ${zramDev}`);
      } else if (filesystem === 'btrfs') {
        await execPromise(`mkfs.btrfs -f -U ${uuid} ${zramDev}`);
      } else {
        throw new Error(`Unsupported filesystem: ${filesystem}`);
      }
      // Mount is NOT handled by API - user mounts via pools using /dev/zramX
    }

    return device;
  }

  // ============================================================
  // API METHODS
  // ============================================================

  /**
   * Get ZRAM configuration and status
   * GET /mos/zram
   */
  async getConfig() {
    const config = await this.loadConfig();
    const moduleLoaded = await this.isModuleLoaded();

    return {
      ...config,
      module_loaded: moduleLoaded
    };
  }

  /**
   * Get available compression algorithms
   * GET /mos/zram/algorithms
   * Reads from /sys/block/zram0/comp_algorithm if available, otherwise returns static list
   */
  async getAlgorithms() {
    // Static fallback list (common kernel algorithms)
    const staticAlgorithms = ['lzo', 'lz4', 'lz4hc', 'zstd', 'deflate', '842'];

    try {
      // Try to read from sysfs (shows all available, current one in brackets)
      const { stdout } = await execPromise('cat /sys/block/zram0/comp_algorithm 2>/dev/null || cat /sys/block/zram1/comp_algorithm 2>/dev/null');
      // Format: "lzo lz4 lz4hc [zstd] deflate 842"
      const algorithms = stdout.trim().replace(/\[|\]/g, '').split(/\s+/).filter(a => a);
      return algorithms.length > 0 ? algorithms : staticAlgorithms;
    } catch {
      // Module not loaded or no devices - return static list
      return staticAlgorithms;
    }
  }

  /**
   * Update ZRAM configuration
   * POST /mos/zram
   * @param {Object} newConfig - New configuration
   */
  async updateConfig(newConfig) {
    const currentConfig = await this.loadConfig();
    const wasEnabled = currentConfig.enabled;
    const willBeEnabled = newConfig.enabled !== undefined ? newConfig.enabled : wasEnabled;

    // Validate zram_devices matches devices array length
    if (newConfig.devices !== undefined) {
      if (newConfig.zram_devices !== undefined && newConfig.zram_devices !== newConfig.devices.length) {
        throw new Error(`zram_devices (${newConfig.zram_devices}) must match devices array length (${newConfig.devices.length})`);
      }

      // Check for duplicate indices
      const indices = newConfig.devices.map(d => d.index).filter(i => i !== undefined);
      const uniqueIndices = new Set(indices);
      if (indices.length !== uniqueIndices.size) {
        throw new Error('Duplicate device indices are not allowed. Each device must have a unique index.');
      }

      // Validate and ensure id/uuid for each device
      for (const device of newConfig.devices) {
        this._validateDevice(device);
      }
      // Ensure id and uuid are set (generate if missing, preserve if existing)
      await this._ensureDeviceIdentifiers(newConfig.devices, currentConfig.devices);
    }

    const finalDevices = newConfig.devices !== undefined ? newConfig.devices : currentConfig.devices;

    // Handle global enabled state change
    if (wasEnabled && !willBeEnabled) {
      // Disable ZRAM: Check mounts and unload module
      await this._disableZram(currentConfig);
    } else if (!wasEnabled && willBeEnabled) {
      // Enable ZRAM: Load module and setup devices
      await this._enableZram({ devices: finalDevices });
    } else if (wasEnabled && willBeEnabled && newConfig.devices !== undefined) {
      // ZRAM stays enabled but devices changed - rebuild all
      await this._rebuildDevices(currentConfig.devices, finalDevices);
    }

    // Merge configuration
    const mergedConfig = {
      enabled: willBeEnabled,
      zram_devices: finalDevices.length,
      devices: finalDevices
    };

    return await this._saveConfig(mergedConfig);
  }

  /**
   * Rebuild all ZRAM devices - stop everything, then start fresh
   * This is the safest approach for any config change
   * @param {Array} oldDevices - Previous device configuration
   * @param {Array} newDevices - New device configuration
   * @private
   */
  async _rebuildDevices(oldDevices, newDevices) {
    // Phase 0: Pre-check all ramdisks for mounts before stopping anything
    const mountErrors = [];
    for (const oldDev of oldDevices) {
      if (!oldDev.enabled || oldDev.type !== 'ramdisk') continue;

      const zramDev = `/dev/zram${oldDev.index}`;
      const mountPoints = await this._getMountPoints(zramDev);
      if (mountPoints.length > 0) {
        mountErrors.push(`zram${oldDev.index} (${oldDev.name}) at: ${mountPoints.join(', ')}`);
      }
    }

    if (mountErrors.length > 0) {
      throw new Error(`Cannot rebuild ZRAM: Devices still mounted:\n- ${mountErrors.join('\n- ')}\nUnmount first.`);
    }

    // Phase 1: Stop ALL currently active swap devices
    for (const oldDev of oldDevices) {
      if (oldDev.enabled && oldDev.type === 'swap') {
        await this._disableSwap(oldDev.index);
      }
    }

    // Phase 2: Reset all zram devices to clean state
    const kernelDevices = await this.getKernelDeviceCount();
    for (let i = 0; i < kernelDevices; i++) {
      await this._resetDevice(i);
    }

    // Phase 3: Activate all enabled devices from new config
    for (const newDev of newDevices) {
      if (newDev.enabled) {
        // Ensure kernel has enough devices
        const currentKernelDevices = await this.getKernelDeviceCount();
        if (newDev.index >= currentKernelDevices) {
          await execPromise(`cat /sys/class/zram-control/hot_add`);
        }
        await this._setupDevice(newDev);
      }
    }

    // Phase 4: Remove excess kernel devices
    const maxNeededIndex = Math.max(...newDevices.filter(d => d.enabled).map(d => d.index), -1);
    const finalKernelDevices = await this.getKernelDeviceCount();
    for (let i = finalKernelDevices - 1; i > maxNeededIndex; i--) {
      try {
        await execPromise(`echo ${i} > /sys/class/zram-control/hot_remove`);
      } catch {
        // Device might be in use or already removed
      }
    }
  }

  /**
   * Ensure all devices have id and uuid (for ramdisk)
   * Also restructures device objects to have correct field order
   * - id: Generate if not present, cannot be changed
   * - uuid: Generate for ramdisk if not present, cannot be changed
   * @param {Array} newDevices - New devices array (modified in place)
   * @param {Array} existingDevices - Existing devices for reference
   * @private
   */
  async _ensureDeviceIdentifiers(newDevices, existingDevices) {
    // Build maps for lookup - by id (primary) and by index (fallback)
    const existingById = new Map();
    const existingByIndex = new Map();
    for (const dev of existingDevices) {
      if (dev.id) existingById.set(dev.id, dev);
      existingByIndex.set(dev.index, dev);
    }

    for (let i = 0; i < newDevices.length; i++) {
      const device = newDevices[i];

      // Find existing device - prefer by id, fallback to index
      let existing = device.id ? existingById.get(device.id) : null;
      if (!existing && device.index !== undefined) {
        existing = existingByIndex.get(device.index);
      }

      // Determine id
      let deviceId = device.id;
      if (!deviceId) {
        deviceId = generateId();
      }

      // Determine uuid for ramdisk
      let uuid = device.config?.uuid || null;
      if (device.type === 'ramdisk') {
        if (!uuid) {
          const existingForUuid = deviceId ? existingById.get(deviceId) : existing;
          if (existingForUuid?.config?.uuid) {
            uuid = existingForUuid.config.uuid;
          } else {
            uuid = await this._generateUUID();
          }
        }
        // Enforce immutability when updating existing device
        if (existing?.id === deviceId && existing?.config?.uuid &&
            uuid !== existing.config.uuid) {
          throw new Error(`Device "${device.name}": uuid cannot be changed`);
        }
      }

      // Rebuild device object with correct field order: id first, then name, etc.
      newDevices[i] = {
        id: deviceId,
        name: device.name,
        enabled: device.enabled || false,
        index: device.index,
        algorithm: device.algorithm || null,
        size: device.size || null,
        type: device.type,
        config: {
          priority: device.type === 'swap' ? (device.config?.priority ?? null) : null,
          uuid: device.type === 'ramdisk' ? uuid : null,
          filesystem: device.type === 'ramdisk' ? (device.config?.filesystem || null) : null
        }
      };
    }
  }

  /**
   * Validate a device configuration
   * @param {Object} device - Device to validate
   * @private
   */
  _validateDevice(device) {
    // Basic required fields for all devices
    if (!device.name) {
      throw new Error('Device name is required');
    }
    if (!device.type || !['swap', 'ramdisk'].includes(device.type)) {
      throw new Error('Device type must be "swap" or "ramdisk"');
    }

    // Only validate detailed config if device is enabled
    if (device.enabled) {
      if (!device.size) {
        throw new Error(`Device "${device.name}": size is required for enabled devices`);
      }
      if (!device.algorithm) {
        throw new Error(`Device "${device.name}": algorithm is required for enabled devices`);
      }

      if (device.type === 'swap') {
        if (device.config?.priority === undefined || device.config?.priority === null) {
          throw new Error(`Device "${device.name}": config.priority is required for enabled swap devices`);
        }
      } else if (device.type === 'ramdisk') {
        if (!device.config?.filesystem) {
          throw new Error(`Device "${device.name}": config.filesystem is required for enabled ramdisk devices`);
        }
        // UUID will be auto-generated in _setupDevice if not provided
      }
    }
    // Disabled devices can have null values in config
  }

  /**
   * Enable ZRAM system
   * @param {Object} config - Configuration with devices
   * @private
   */
  async _enableZram(config) {
    const devices = config.devices || [];
    if (devices.length === 0) {
      throw new Error('No ZRAM devices configured');
    }

    // Compact indices to remove gaps (e.g., after device deletion)
    // Sort by current index to maintain relative order, then reassign sequential indices
    devices.sort((a, b) => a.index - b.index);
    devices.forEach((device, i) => {
      device.index = i;
    });

    const moduleLoaded = await this.isModuleLoaded();
    if (!moduleLoaded) {
      await this.loadModule(devices.length);
    }

    // Setup enabled devices
    for (const device of devices) {
      if (device.enabled) {
        await this._setupDevice(device);
      }
    }
  }

  /**
   * Disable ZRAM system
   * @param {Object} config - Current configuration
   * @private
   */
  async _disableZram(config) {
    await this.unloadModule();
  }

  /**
   * Add a new ZRAM device
   * POST /mos/zram/devices
   * @param {Object} deviceData - Device configuration
   */
  async addDevice(deviceData) {
    const config = await this.loadConfig();

    // Set defaults
    if (!deviceData.algorithm) {
      deviceData.algorithm = 'zstd'; // Default
    }
    if (!deviceData.config) {
      deviceData.config = {};
    }
    const isEnabled = deviceData.enabled !== undefined ? deviceData.enabled : false;

    // Generate UUID for ramdisk if not provided
    if (deviceData.type === 'ramdisk' && !deviceData.config.uuid) {
      deviceData.config.uuid = await this._generateUUID();
    }

    // Build temporary device for validation
    const tempDevice = {
      name: deviceData.name,
      type: deviceData.type,
      enabled: isEnabled,
      algorithm: deviceData.algorithm,
      size: deviceData.size,
      config: deviceData.config
    };

    // Use shared validation (respects enabled state)
    this._validateDevice(tempDevice);

    // Assign index (next available)
    const usedIndices = config.devices.map(d => d.index);
    let newIndex = 0;
    while (usedIndices.includes(newIndex)) {
      newIndex++;
    }

    const newDevice = {
      id: generateId(),
      name: deviceData.name,
      enabled: isEnabled,
      index: newIndex,
      algorithm: deviceData.algorithm || null,
      size: deviceData.size || null,
      type: deviceData.type,
      config: this._buildDeviceConfig(deviceData)
    };

    config.devices.push(newDevice);
    await this._saveConfig(config);

    // If ZRAM is enabled and device should be enabled, set it up
    if (config.enabled && newDevice.enabled) {
      const moduleLoaded = await this.isModuleLoaded();
      if (moduleLoaded) {
        // May need to add more devices to kernel
        const kernelDevices = await this.getKernelDeviceCount();
        if (newDevice.index >= kernelDevices) {
          // Need to add device via hot_add
          await execPromise(`cat /sys/class/zram-control/hot_add`);
        }
        await this._setupDevice(newDevice);
      }
    }

    return newDevice;
  }

  /**
   * Build device config based on type
   * Handles null values for disabled devices
   * @private
   */
  _buildDeviceConfig(deviceData) {
    if (deviceData.type === 'swap') {
      return {
        priority: deviceData.config?.priority !== undefined ? deviceData.config.priority : null,
        uuid: null,
        filesystem: null
      };
    } else {
      return {
        priority: null,
        uuid: deviceData.config?.uuid || null,
        filesystem: deviceData.config?.filesystem || null
      };
    }
  }

  /**
   * Update a ZRAM device
   * POST /mos/zram/devices/:id
   * @param {string} id - Device ID
   * @param {Object} updateData - Updated fields
   */
  async updateDevice(id, updateData) {
    const config = await this.loadConfig();
    const deviceIndex = config.devices.findIndex(d => d.id === id);

    if (deviceIndex === -1) {
      throw new Error(`Device with id ${id} not found`);
    }

    const device = config.devices[deviceIndex];
    const wasEnabled = device.enabled;

    // Index cannot be changed via single device update
    if (updateData.index !== undefined && updateData.index !== device.index) {
      throw new Error('Index cannot be changed. Use full config update to reorder devices.');
    }

    // Update allowed fields (id, index, uuid are immutable)
    const allowedFields = ['name', 'enabled', 'algorithm', 'size'];
    for (const field of allowedFields) {
      if (updateData[field] !== undefined) {
        device[field] = updateData[field];
      }
    }

    // Update config based on type (uuid is immutable for ramdisk)
    if (updateData.config) {
      if (device.type === 'swap') {
        if (updateData.config.priority !== undefined) {
          device.config.priority = updateData.config.priority;
        }
      } else if (device.type === 'ramdisk') {
        if (updateData.config.filesystem !== undefined) {
          device.config.filesystem = updateData.config.filesystem;
        }
        // uuid cannot be changed - ignore if provided
      }
    }

    // Validate the updated device
    this._validateDevice(device);

    // If ZRAM is enabled, rebuild only THIS device
    if (config.enabled) {
      const moduleLoaded = await this.isModuleLoaded();
      if (moduleLoaded) {
        // Stop old device if it was enabled
        if (wasEnabled) {
          await this._deactivateDevice({ ...device, enabled: true }); // Use current index
        }
        // Start new device if now enabled
        if (device.enabled) {
          await this._setupDevice(device);
        }
      }
    }

    await this._saveConfig(config);
    return device;
  }

  /**
   * Deactivate a single device
   * @param {Object} device - Device to deactivate
   * @private
   */
  async _deactivateDevice(device) {
    const zramDev = `/dev/zram${device.index}`;

    if (device.type === 'swap') {
      await this._disableSwap(device.index);
    } else if (device.type === 'ramdisk') {
      const mountPoints = await this._getMountPoints(zramDev);
      if (mountPoints.length > 0) {
        const mountList = mountPoints.join(', ');
        throw new Error(`Cannot disable device: zram${device.index} is mounted at: ${mountList}. Unmount first.`);
      }
    }

    await this._resetDevice(device.index);
  }

  /**
   * Delete a ZRAM device
   * DELETE /mos/zram/devices/:id
   * @param {string} id - Device ID
   */
  async deleteDevice(id) {
    const config = await this.loadConfig();
    const deviceIndex = config.devices.findIndex(d => d.id === id);

    if (deviceIndex === -1) {
      throw new Error(`Device with id ${id} not found`);
    }

    const device = config.devices[deviceIndex];

    // If ZRAM is enabled and device was active, stop it
    if (config.enabled && device.enabled) {
      const moduleLoaded = await this.isModuleLoaded();
      if (moduleLoaded) {
        await this._deactivateDevice(device);
      }
    }

    // Remove from config
    const deleted = config.devices.splice(deviceIndex, 1)[0];
    await this._saveConfig(config);

    return deleted;
  }

  /**
   * Get status of all ZRAM devices
   * GET /mos/zram/status
   */
  async getStatus() {
    const config = await this.loadConfig();
    const moduleLoaded = await this.isModuleLoaded();

    const status = {
      module_loaded: moduleLoaded,
      enabled: config.enabled,
      devices: []
    };

    if (!moduleLoaded) {
      return status;
    }

    // Get status from zramctl
    try {
      const { stdout } = await execPromise('zramctl --output NAME,ALGORITHM,DISKSIZE,DATA,COMPR,TOTAL,STREAMS,MOUNTPOINT --bytes 2>/dev/null || true');
      const lines = stdout.trim().split('\n').slice(1); // Skip header

      for (const device of config.devices) {
        const zramName = `zram${device.index}`;
        const line = lines.find(l => l.includes(zramName));

        let deviceStatus = {
          id: device.id,
          name: device.name,
          index: device.index,
          type: device.type,
          configured_enabled: device.enabled,
          active: false
        };

        if (line) {
          const parts = line.trim().split(/\s+/);
          deviceStatus.active = true;
          deviceStatus.algorithm = parts[1] || device.algorithm;
          deviceStatus.disksize = parts[2] || '0';
          deviceStatus.data = parts[3] || '0';
          deviceStatus.compr = parts[4] || '0';
          deviceStatus.total = parts[5] || '0';
        }

        // Check swap/mount status
        if (device.type === 'swap') {
          deviceStatus.swap_active = await this._isSwapActive(device.index);
        } else {
          deviceStatus.mount_point = await this._getMountPoint(`/dev/zram${device.index}`);
        }

        status.devices.push(deviceStatus);
      }
    } catch (error) {
      // zramctl might not be available
    }

    return status;
  }
}

module.exports = new ZramService();
