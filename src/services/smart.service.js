const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const net = require('net');

const SMART_CONFIG_PATH = '/boot/config/system/smart.json';
const SMART_CONFIG_DIR = '/boot/config/system';
const SMARTD_STATE_DIR = '/var/lib/smartmontools';
const SMARTD_CONF_PATH = '/etc/smartd.conf';
const MOS_NOTIFY_SOCKET = '/var/run/mos-notify.sock';

const DEFAULT_TEMPERATURE_LIMITS = {
  hdd: { warning: 45, critical: 55 },
  ssd: { warning: 55, critical: 70 },
  nvme: { warning: 65, critical: 80 }
};

const DEFAULT_MONITORED_ATTRIBUTES = [5, 187, 198, 199];
const DEFAULT_ATTRIBUTE_COOLDOWN = 150;

const ATTRIBUTE_NAMES = {
  1: 'Raw_Read_Error_Rate',
  2: 'Throughput_Performance',
  3: 'Spin_Up_Time',
  4: 'Start_Stop_Count',
  5: 'Reallocated_Sector_Ct',
  7: 'Seek_Error_Rate',
  8: 'Seek_Time_Performance',
  9: 'Power_On_Hours',
  10: 'Spin_Retry_Count',
  12: 'Power_Cycle_Count',
  22: 'Helium_Level',
  187: 'Reported_Uncorrect',
  188: 'Command_Timeout',
  190: 'Airflow_Temperature_Cel',
  192: 'Power-Off_Retract_Count',
  193: 'Load_Cycle_Count',
  194: 'Temperature_Celsius',
  196: 'Reallocated_Event_Count',
  197: 'Current_Pending_Sector',
  198: 'Offline_Uncorrectable',
  199: 'UDMA_CRC_Error_Count',
  200: 'Multi_Zone_Error_Rate'
};

const ATTRIBUTE_DISPLAY_NAMES = {
  5: 'Reallocated Sectors',
  187: 'Reported Uncorrectable Errors',
  196: 'Reallocated Events',
  197: 'Current Pending Sectors',
  198: 'Offline Uncorrectable Sectors',
  199: 'UDMA CRC Errors'
};

class SmartService {
  constructor() {
    this.config = null;
    this.diskState = new Map();
    this.serialDeviceMap = new Map();
    this._watcher = null;
    this._dirRetryTimer = null;
    this._debounceTimers = new Map();
    this._attrCooldowns = new Map();
    this._tempWarnings = new Map();
    this._tempCriticals = new Map();
    this._initialized = false;
    this._lastStateChange = null;
  }

  // ============================================================
  // INITIALIZATION
  // ============================================================

  /**
   * Initialize the SMART monitoring service
   * Loads config, maps serials, reads smartd states, syncs disks, checks initial state
   */
  async initialize() {
    try {
      await this._loadConfig();
      await this._updateSerialMapping();
      await this._loadSmartdStates();
      await this._syncDisks();
      this._checkInitialState();
      this._startFileWatcher();
      await this._generateSmartdConf();
      this._initialized = true;
      console.info('[SmartService] SMART monitoring service initialized');
    } catch (error) {
      console.error(`[SmartService] Initialization error: ${error.message}`);
      this._initialized = false;
    }
  }

  /**
   * Check all loaded disk states for non-zero monitored attributes and temperature anomalies
   * Sends boot-time notifications for any pre-existing issues
   * @private
   */
  _checkInitialState() {
    if (!this.config) return;
    if (this.config.defaults.bootCheck === false) return;

    for (const [serial, state] of this.diskState) {
      const diskConfig = this.config.disks[serial];
      if (!diskConfig) continue;

      const monitored = this._getEffectiveMonitoredAttributes(diskConfig);
      const deviceInfo = this.serialDeviceMap.get(serial);
      const devName = deviceInfo ? deviceInfo.name : serial;
      const model = deviceInfo ? deviceInfo.model : diskConfig.model;
      const nonZero = [];

      for (const attrId of monitored) {
        const attr = state.attributes[attrId];
        if (!attr || attr.rawValue === null || attr.rawValue === undefined) continue;
        if (attr.rawValue > 0) {
          const name = ATTRIBUTE_DISPLAY_NAMES[attrId] || ATTRIBUTE_NAMES[attrId] || `Attribute ${attrId}`;
          nonZero.push(`${name} (${attrId}): ${attr.rawValue}`);
        }
      }

      if (nonZero.length > 0) {
        this._sendNotification(
          `SMART Disk: ${devName}`,
          `${model}: ${nonZero.join(', ')}`,
          'warning'
        );
      }

      if (state.temperatureCurrent !== null) {
        const warn = diskConfig.temperatureWarning;
        const crit = diskConfig.temperatureCritical;
        if (crit && state.temperatureCurrent >= crit) {
          this._tempCriticals.set(serial, true);
          this._tempWarnings.set(serial, true);
          this._sendNotification(
            `SMART Disk: ${devName}`,
            `${model}: ${state.temperatureCurrent}°C exceeds critical limit of ${crit}°C`,
            'alert'
          );
        } else if (warn && state.temperatureCurrent >= warn) {
          this._tempWarnings.set(serial, true);
          this._sendNotification(
            `SMART Disk: ${devName}`,
            `${model}: ${state.temperatureCurrent}°C exceeds warning limit of ${warn}°C`,
            'warning'
          );
        }
      }
    }
  }

  // ============================================================
  // CONFIGURATION MANAGEMENT
  // ============================================================

  /**
   * Load SMART configuration from disk or create defaults
   * @private
   */
  async _loadConfig() {
    try {
      const data = await fs.readFile(SMART_CONFIG_PATH, 'utf8');
      this.config = JSON.parse(data);
      if (!this.config.defaults) this.config.defaults = {};
      if (!this.config.defaults.temperatureLimits) {
        this.config.defaults.temperatureLimits = {
          hdd: { ...DEFAULT_TEMPERATURE_LIMITS.hdd },
          ssd: { ...DEFAULT_TEMPERATURE_LIMITS.ssd },
          nvme: { ...DEFAULT_TEMPERATURE_LIMITS.nvme }
        };
      }
      if (!this.config.defaults.monitoredAttributes) {
        this.config.defaults.monitoredAttributes = [...DEFAULT_MONITORED_ATTRIBUTES];
      }
      if (this.config.defaults.attributeNotificationCooldown === undefined) {
        this.config.defaults.attributeNotificationCooldown = DEFAULT_ATTRIBUTE_COOLDOWN;
      }
      if (this.config.defaults.bootCheck === undefined) {
        this.config.defaults.bootCheck = true;
      }
      if (!this.config.smartdOptions) this.config.smartdOptions = { quietMode: 'errorsonly' };
      if (!this.config.disks) this.config.disks = {};
      if (!this.config.orphaned) this.config.orphaned = [];

      const newAttrs = DEFAULT_MONITORED_ATTRIBUTES.filter(
        id => !this.config.defaults.monitoredAttributes.includes(id)
      );
      if (newAttrs.length > 0) {
        this.config.defaults.monitoredAttributes.push(...newAttrs);
        for (const diskConf of Object.values(this.config.disks)) {
          if (diskConf.monitoredAttributes) {
            for (const id of newAttrs) {
              if (!diskConf.monitoredAttributes.includes(id)) {
                diskConf.monitoredAttributes.push(id);
              }
            }
          }
        }
        await this._saveConfig();
        console.info(`[SmartService] Added new monitored attributes: ${newAttrs.join(', ')}`);
      }
    } catch {
      this.config = {
        defaults: {
          temperatureLimits: {
            hdd: { ...DEFAULT_TEMPERATURE_LIMITS.hdd },
            ssd: { ...DEFAULT_TEMPERATURE_LIMITS.ssd },
            nvme: { ...DEFAULT_TEMPERATURE_LIMITS.nvme }
          },
          monitoredAttributes: [...DEFAULT_MONITORED_ATTRIBUTES],
          attributeNotificationCooldown: DEFAULT_ATTRIBUTE_COOLDOWN,
          bootCheck: true
        },
        smartdOptions: { quietMode: 'errorsonly' },
        disks: {},
        orphaned: []
      };
      await this._saveConfig();
    }
  }

  /**
   * Persist current config to disk
   * @private
   */
  async _saveConfig() {
    try {
      await fs.mkdir(SMART_CONFIG_DIR, { recursive: true });
      await fs.writeFile(SMART_CONFIG_PATH, JSON.stringify(this.config, null, 2), 'utf8');
    } catch (error) {
      console.error(`[SmartService] Failed to save smart.json: ${error.message}`);
    }
  }

  /**
   * Get current SMART configuration with computed warning state per disk
   * @returns {Object|null} Configuration object or null if not loaded
   */
  getConfig() {
    if (!this.config) return null;
    const result = { ...this.config, disks: {} };
    for (const [serial, diskConf] of Object.entries(this.config.disks)) {
      result.disks[serial] = { ...diskConf, warning: this._hasDiskWarning(serial, diskConf) };
    }
    return result;
  }

  /**
   * Update global SMART configuration via deep merge
   * @param {Object} partial - Partial config to merge (defaults, smartdOptions)
   * @returns {Object} Updated configuration
   */
  async updateConfig(partial) {
    if (!this.config) await this._loadConfig();
    const { disks, orphaned, ...globalFields } = partial;
    this.config = this._deepMerge(this.config, globalFields);
    await this._saveConfig();
    await this._generateSmartdConf();
    return this.config;
  }

  /**
   * Get monitoring configuration for a specific disk with computed warning state
   * @param {string} serial - Disk serial number
   * @returns {Object|null} Disk config or null
   */
  getDiskConfig(serial) {
    if (!this.config) return null;
    const diskConf = this.config.disks[serial];
    if (!diskConf) return null;
    return { ...diskConf, warning: this._hasDiskWarning(serial, diskConf) };
  }

  /**
   * Update monitoring settings for a specific disk (partial merge)
   * @param {string} serial - Disk serial number
   * @param {Object} partial - Fields to update
   * @returns {Object} Updated disk configuration
   */
  async updateDiskConfig(serial, partial) {
    if (!this.config) await this._loadConfig();
    if (!this.config.disks[serial]) {
      throw new Error(`Disk with serial ${serial} not found in configuration`);
    }
    const { lastSeen, model, diskType, ...updatable } = partial;
    this.config.disks[serial] = this._deepMerge(this.config.disks[serial], updatable);
    this.config.disks[serial].lastSeen = new Date().toISOString();
    await this._saveConfig();
    await this._generateSmartdConf();
    return this.config.disks[serial];
  }

  /**
   * Delete custom config for a disk (re-added with defaults on next sync if present)
   * @param {string} serial - Disk serial number
   * @returns {Object} Success result
   */
  async deleteDiskConfig(serial) {
    if (!this.config) await this._loadConfig();
    if (!this.config.disks[serial]) {
      throw new Error(`Disk with serial ${serial} not found in configuration`);
    }
    delete this.config.disks[serial];
    await this._saveConfig();
    await this._syncDisks();
    await this._generateSmartdConf();
    return { success: true, message: `Config for ${serial} deleted, will be re-added with defaults if disk is present` };
  }

  /**
   * Get list of orphaned disk entries
   * @returns {Array} Orphaned disk entries
   */
  getOrphaned() {
    return this.config ? this.config.orphaned : [];
  }

  /**
   * Delete a specific orphaned entry by serial number
   * @param {string} serial - Serial number of orphaned disk
   * @returns {Object} Success result
   */
  async deleteOrphan(serial) {
    if (!this.config) await this._loadConfig();
    const idx = this.config.orphaned.findIndex(o => o.serial === serial);
    if (idx === -1) throw new Error(`Orphaned entry ${serial} not found`);
    this.config.orphaned.splice(idx, 1);
    await this._saveConfig();
    return { success: true, message: `Orphaned entry ${serial} removed` };
  }

  /**
   * Delete all orphaned disk entries
   * @returns {Object} Success result with count
   */
  async deleteAllOrphans() {
    if (!this.config) await this._loadConfig();
    const count = this.config.orphaned.length;
    this.config.orphaned = [];
    await this._saveConfig();
    return { success: true, message: `${count} orphaned entries removed`, count };
  }

  /**
   * Create a new disk config entry with defaults based on disk type
   * @param {string} serial - Disk serial number
   * @param {string} model - Disk model name
   * @param {string} diskType - Disk type (hdd, ssd, nvme)
   * @returns {Object} New disk configuration entry
   * @private
   */
  _createDiskEntry(serial, model, diskType) {
    const type = diskType || 'hdd';
    const limits = this.config.defaults.temperatureLimits[type] ||
                   this.config.defaults.temperatureLimits.hdd;
    return {
      temperatureWarning: limits.warning,
      temperatureCritical: limits.critical,
      monitoredAttributes: [...this.config.defaults.monitoredAttributes],
      attributeNotificationCooldown: this.config.defaults.attributeNotificationCooldown,
      lastSeen: new Date().toISOString(),
      model: model || 'Unknown',
      diskType: type
    };
  }

  // ============================================================
  // SERIAL / DEVICE MAPPING
  // ============================================================

  /**
   * Update the serial-to-device mapping from lsblk
   * @private
   */
  async _updateSerialMapping() {
    try {
      const { stdout } = await execPromise(
        'lsblk -Jndo NAME,SERIAL,MODEL,ROTA,TRAN,TYPE,DISC-GRAN 2>/dev/null'
      );
      const data = JSON.parse(stdout);
      this.serialDeviceMap.clear();
      if (data.blockdevices) {
        for (const dev of data.blockdevices) {
          if (dev.type !== 'disk' || !dev.serial) continue;
          const diskType = dev.tran === 'nvme' ? 'nvme'
            : (!dev.rota || dev['disc-gran']) ? 'ssd' : 'hdd';
          this.serialDeviceMap.set(dev.serial, {
            name: dev.name,
            model: dev.model || 'Unknown',
            diskType,
            tran: dev.tran
          });
        }
      }
    } catch (error) {
      console.warn(`[SmartService] Serial mapping update failed: ${error.message}`);
    }
  }

  /**
   * Get device info (serial, model, type) for a given device name
   * @param {string} deviceName - Device name (e.g. 'sda')
   * @returns {Object} Device info with serial, model, diskType
   * @private
   */
  async _getDeviceInfo(deviceName) {
    const name = deviceName.replace('/dev/', '');
    for (const [serial, info] of this.serialDeviceMap) {
      if (info.name === name) return { serial, ...info };
    }
    try {
      const { stdout } = await execPromise(
        `lsblk -Jndo NAME,SERIAL,MODEL,ROTA,TRAN,DISC-GRAN /dev/${name} 2>/dev/null`
      );
      const data = JSON.parse(stdout);
      if (data.blockdevices && data.blockdevices[0]) {
        const dev = data.blockdevices[0];
        const diskType = dev.tran === 'nvme' ? 'nvme'
          : (!dev.rota || dev['disc-gran']) ? 'ssd' : 'hdd';
        if (dev.serial) {
          this.serialDeviceMap.set(dev.serial, {
            name: dev.name, model: dev.model || 'Unknown', diskType, tran: dev.tran
          });
        }
        return { serial: dev.serial || null, name: dev.name, model: dev.model || null, diskType };
      }
    } catch { /* ignore */ }
    return { serial: null, name, model: null, diskType: 'unknown' };
  }

  // ============================================================
  // SMARTD STATE FILE PARSING
  // ============================================================

  /**
   * Load all smartd state files from disk into memory cache
   * @private
   */
  async _loadSmartdStates() {
    try {
      await fs.access(SMARTD_STATE_DIR);
    } catch {
      console.warn(`[SmartService] smartd state directory ${SMARTD_STATE_DIR} not found, will retry`);
      this._startDirRetry();
      return;
    }

    try {
      const files = await fs.readdir(SMARTD_STATE_DIR);
      const stateFiles = files.filter(f =>
        f.startsWith('smartd.') && f.endsWith('.state') && !f.endsWith('.state~')
      );

      for (const file of stateFiles) {
        try {
          const filePath = path.join(SMARTD_STATE_DIR, file);
          const content = await fs.readFile(filePath, 'utf8');
          const parsed = this._parseStateFile(content);
          const fileInfo = this._parseStateFilename(file);
          const serial = this._resolveSerialFromFileInfo(fileInfo);
          if (serial) {
            const hash = crypto.createHash('md5').update(content).digest('hex');
            this.diskState.set(serial, {
              ...parsed,
              filename: file,
              fileSerial: fileInfo.serial,
              fileModel: fileInfo.model,
              fileType: fileInfo.type,
              contentHash: hash
            });
          }
        } catch { /* skip unparseable files */ }
      }
    } catch (error) {
      console.warn(`[SmartService] Failed to load smartd states: ${error.message}`);
    }
  }

  /**
   * Parse a smartd state file into a structured object
   * @param {string} content - Raw state file content
   * @returns {Object} Parsed state with temperature, errorCount, attributes
   * @private
   */
  _parseStateFile(content) {
    const result = {
      temperatureMin: null,
      temperatureMax: null,
      temperatureCurrent: null,
      errorCount: null,
      attributes: {}
    };

    const attrMap = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.substring(0, eqIdx).trim();
      const value = trimmed.substring(eqIdx + 1).trim();

      if (key === 'temperature-min') {
        result.temperatureMin = parseInt(value) || null;
      } else if (key === 'temperature-max') {
        result.temperatureMax = parseInt(value) || null;
      } else if (key === 'ata-error-count') {
        result.errorCount = parseInt(value) || 0;
      } else {
        const attrMatch = key.match(/^ata-smart-attribute\.(\d+)\.(id|val|worst|raw)$/);
        if (attrMatch) {
          const idx = attrMatch[1];
          const field = attrMatch[2];
          if (!attrMap[idx]) attrMap[idx] = {};
          attrMap[idx][field] = field === 'id' ? parseInt(value) : parseInt(value) || 0;
        }
      }
    }

    for (const idx of Object.keys(attrMap).sort((a, b) => parseInt(a) - parseInt(b))) {
      const attr = attrMap[idx];
      if (attr.id !== undefined) {
        result.attributes[attr.id] = {
          id: attr.id,
          name: ATTRIBUTE_NAMES[attr.id] || `Unknown_Attribute_${attr.id}`,
          value: attr.val !== undefined ? attr.val : null,
          worst: attr.worst !== undefined ? attr.worst : null,
          threshold: null,
          rawValue: attr.raw !== undefined ? attr.raw : null
        };
      }
    }

    if (result.attributes[194]) {
      result.temperatureCurrent = this._extractTemperatureFromRaw(result.attributes[194].rawValue);
    } else if (result.attributes[190]) {
      result.temperatureCurrent = this._extractTemperatureFromRaw(result.attributes[190].rawValue);
    } else {
      result.temperatureCurrent = result.temperatureMax;
    }

    return result;
  }

  /**
   * Extract model, serial, and interface type from a smartd state filename
   * @param {string} filename - State file name (e.g. 'smartd.WDC_WD120EDAZ_11F3RA0-5PJJ26DF.ata.state')
   * @returns {Object} Parsed info with model, serial, type
   * @private
   */
  _parseStateFilename(filename) {
    const match = filename.match(/^smartd\.(.+)\.(ata|nvme|scsi)\.state$/);
    if (!match) return { model: null, serial: null, type: null };
    const identifier = match[1];
    const type = match[2];
    const lastDash = identifier.lastIndexOf('-');
    if (lastDash === -1) return { model: identifier, serial: null, type };
    return {
      model: identifier.substring(0, lastDash),
      serial: identifier.substring(lastDash + 1),
      type
    };
  }

  /**
   * Extract temperature value from SMART raw value (handles packed format)
   * @param {number} rawValue - Raw attribute value
   * @returns {number|null} Temperature in Celsius or null
   * @private
   */
  _extractTemperatureFromRaw(rawValue) {
    if (rawValue === null || rawValue === undefined) return null;
    const lowByte = rawValue & 0xFF;
    if (lowByte >= 1 && lowByte <= 100) return lowByte;
    const low16 = rawValue & 0xFFFF;
    if (low16 >= 1 && low16 <= 100) return low16;
    return null;
  }

  /**
   * Find cached state data for a given serial (with normalized matching)
   * @param {string} serial - Disk serial number
   * @returns {Object|null} Cached state or null
   * @private
   */
  _findStateForSerial(serial) {
    if (!serial) return null;
    const direct = this.diskState.get(serial);
    if (direct) return direct;
    const normalized = serial.replace(/[-\s]/g, '_');
    for (const [key, state] of this.diskState) {
      if (key.replace(/[-\s]/g, '_') === normalized) return state;
    }
    return null;
  }

  /**
   * Resolve a serial from file info against the known serial mapping
   * @param {Object} fileInfo - Parsed filename info with serial field
   * @returns {string|null} Resolved serial number
   * @private
   */
  _resolveSerialFromFileInfo(fileInfo) {
    if (!fileInfo.serial) return null;
    for (const [serial] of this.serialDeviceMap) {
      const normalized = serial.replace(/[-\s]/g, '_');
      if (normalized === fileInfo.serial || serial === fileInfo.serial) return serial;
    }
    return fileInfo.serial;
  }

  /**
   * Resolve a serial number from a smartd state filename
   * @param {string} filename - State file name
   * @returns {string|null} Resolved serial number
   * @private
   */
  _resolveSerialFromFilename(filename) {
    const info = this._parseStateFilename(filename);
    return this._resolveSerialFromFileInfo(info);
  }

  // ============================================================
  // FILE WATCHER
  // ============================================================

  /**
   * Start watching smartd state directory for changes via inotify
   * Falls back to retry timer if directory doesn't exist yet
   * @private
   */
  _startFileWatcher() {
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }

    try {
      fsSync.accessSync(SMARTD_STATE_DIR);
    } catch {
      console.warn('[SmartService] smartd state directory not found, starting retry timer');
      this._startDirRetry();
      return;
    }

    try {
      this._watcher = fsSync.watch(SMARTD_STATE_DIR, (eventType, changedFile) => {
        if (!changedFile) return;
        if (!changedFile.startsWith('smartd.')) return;
        if (!changedFile.endsWith('.state')) return;
        if (changedFile.endsWith('.state~')) return;

        const key = changedFile;
        if (this._debounceTimers.has(key)) clearTimeout(this._debounceTimers.get(key));
        this._debounceTimers.set(key, setTimeout(() => {
          this._debounceTimers.delete(key);
          this._onStateFileChanged(changedFile);
        }, 500));
      });

      this._watcher.on('error', (error) => {
        console.warn(`[SmartService] Watcher error: ${error.message}`);
        this._watcher.close();
        this._watcher = null;
        this._startDirRetry();
      });

      if (this._dirRetryTimer) {
        clearInterval(this._dirRetryTimer);
        this._dirRetryTimer = null;
      }
      console.info(`[SmartService] File watcher active on ${SMARTD_STATE_DIR}`);
    } catch (error) {
      console.warn(`[SmartService] Failed to start file watcher: ${error.message}`);
      this._startDirRetry();
    }
  }

  /**
   * Start periodic retry timer to detect when smartd state directory becomes available
   * @private
   */
  _startDirRetry() {
    if (this._dirRetryTimer) return;
    this._dirRetryTimer = setInterval(() => {
      try {
        fsSync.accessSync(SMARTD_STATE_DIR);
        clearInterval(this._dirRetryTimer);
        this._dirRetryTimer = null;
        console.info('[SmartService] smartd state directory found, starting file watcher');
        this._loadSmartdStates().then(() => this._startFileWatcher());
      } catch { /* still not available */ }
    }, 60000);
  }

  /**
   * Handle a smartd state file change event
   * @param {string} filename - Changed file name
   * @private
   */
  async _onStateFileChanged(filename) {
    try {
      const filePath = path.join(SMARTD_STATE_DIR, filename);
      const content = await fs.readFile(filePath, 'utf8');
      const hash = crypto.createHash('md5').update(content).digest('hex');

      const serial = this._resolveSerialFromFilename(filename);
      if (!serial) return;

      const oldState = this.diskState.get(serial);
      if (oldState && oldState.contentHash === hash) return;

      const newState = this._parseStateFile(content);
      const fileInfo = this._parseStateFilename(filename);
      const stateEntry = {
        ...newState,
        filename,
        fileSerial: fileInfo.serial,
        fileModel: fileInfo.model,
        fileType: fileInfo.type,
        contentHash: hash
      };

      this._lastStateChange = new Date().toISOString();
      this._processStateUpdate(serial, oldState, stateEntry);
      this.diskState.set(serial, stateEntry);
    } catch (error) {
      console.warn(`[SmartService] Error processing state file ${filename}: ${error.message}`);
    }
  }

  // ============================================================
  // NOTIFICATION LOGIC
  // ============================================================

  /**
   * Process a state update and trigger notifications for temperature/attribute changes
   * @param {string} serial - Disk serial number
   * @param {Object} oldState - Previous state (null on first load)
   * @param {Object} newState - New parsed state
   * @private
   */
  _processStateUpdate(serial, oldState, newState) {
    if (!this.config) return;
    const diskConfig = this.config.disks[serial];
    if (!diskConfig) return;

    if (oldState) {
      this._checkTemperature(serial, diskConfig, newState.temperatureCurrent);
      this._checkAttributes(serial, diskConfig, oldState.attributes, newState.attributes);
    }
  }

  /**
   * Check temperature against thresholds and send notifications with deduplication
   * @param {string} serial - Disk serial number
   * @param {Object} config - Disk monitoring config
   * @param {number|null} temp - Current temperature
   * @private
   */
  _checkTemperature(serial, config, temp) {
    if (temp === null || temp === undefined) return;
    const warn = config.temperatureWarning;
    const crit = config.temperatureCritical;
    const deviceInfo = this.serialDeviceMap.get(serial);
    const devName = deviceInfo ? deviceInfo.name : serial;
    const model = deviceInfo ? deviceInfo.model : serial;

    if (crit && temp >= crit && !this._tempCriticals.get(serial)) {
      this._tempCriticals.set(serial, true);
      this._tempWarnings.set(serial, true);
      this._sendNotification(
        `SMART Disk: ${devName}`,
        `${model}: ${temp}°C exceeds critical limit of ${crit}°C`,
        'alert'
      );
      return;
    }

    if (warn && temp >= warn && !this._tempWarnings.get(serial)) {
      this._tempWarnings.set(serial, true);
      this._sendNotification(
        `SMART Disk: ${devName}`,
        `${model}: ${temp}°C exceeds warning limit of ${warn}°C`,
        'warning'
      );
      return;
    }

    if (warn && temp < warn && this._tempWarnings.get(serial)) {
      this._tempWarnings.delete(serial);
      this._tempCriticals.delete(serial);
      this._sendNotification(
        `SMART Disk: ${devName}`,
        `${model}: Temperature back to normal (${temp}°C)`,
        'normal'
      );
    } else if (crit && temp < crit && this._tempCriticals.get(serial)) {
      this._tempCriticals.delete(serial);
    }
  }

  /**
   * Check monitored attributes for value increases and send notifications with cooldown
   * @param {string} serial - Disk serial number
   * @param {Object} config - Disk monitoring config
   * @param {Object} oldAttrs - Previous attribute values
   * @param {Object} newAttrs - New attribute values
   * @private
   */
  _checkAttributes(serial, config, oldAttrs, newAttrs) {
    if (!oldAttrs || !newAttrs) return;
    const monitored = this._getEffectiveMonitoredAttributes(config);
    const deviceInfo = this.serialDeviceMap.get(serial);
    const devName = deviceInfo ? deviceInfo.name : serial;
    const model = deviceInfo ? deviceInfo.model : serial;

    for (const attrId of monitored) {
      const oldAttr = oldAttrs[attrId];
      const newAttr = newAttrs[attrId];
      if (!oldAttr || !newAttr) continue;
      if (newAttr.rawValue === null || oldAttr.rawValue === null) continue;
      if (newAttr.rawValue <= oldAttr.rawValue) continue;

      if (!this._canNotifyAttribute(serial, attrId, config)) continue;

      const name = ATTRIBUTE_DISPLAY_NAMES[attrId] || ATTRIBUTE_NAMES[attrId] || `Attribute ${attrId}`;
      const diff = newAttr.rawValue - oldAttr.rawValue;
      this._sendNotification(
        `SMART Disk: ${devName}`,
        `${model}: ${name} (${attrId}) increased from ${oldAttr.rawValue} to ${newAttr.rawValue} (+${diff})`,
        'warning'
      );
    }
  }

  /**
   * Check if an attribute notification is allowed (respects cooldown period)
   * @param {string} serial - Disk serial number
   * @param {number} attrId - SMART attribute ID
   * @param {Object} config - Disk monitoring config
   * @returns {boolean} True if notification is allowed
   * @private
   */
  _canNotifyAttribute(serial, attrId, config) {
    const key = `${serial}:${attrId}`;
    const cooldown = (config.attributeNotificationCooldown || DEFAULT_ATTRIBUTE_COOLDOWN) * 1000;
    const lastNotified = this._attrCooldowns.get(key);
    const now = Date.now();
    if (lastNotified && (now - lastNotified) < cooldown) return false;
    this._attrCooldowns.set(key, now);
    return true;
  }

  /**
   * Send notification via mos-notify socket
   * @param {string} title - Notification title
   * @param {string} message - Notification message
   * @param {string} priority - Priority level (normal, warning, alert)
   * @param {number} delayMs - Delay after sending for ordering guarantee
   * @private
   */
  async _sendNotification(title, message, priority = 'normal', delayMs = 1000) {
    return new Promise((resolve) => {
      const client = net.createConnection(MOS_NOTIFY_SOCKET, () => {
        const payload = JSON.stringify({ title, message, priority });
        client.write(payload);
        client.end();
        setTimeout(() => resolve(true), delayMs);
      });
      client.on('error', () => {
        setTimeout(() => resolve(false), delayMs);
      });
    });
  }

  // ============================================================
  // SMART ENDPOINT
  // ============================================================

  /**
   * Get full SMART information for a device (live or cached)
   * @param {string} device - Device path or name (e.g. 'sda' or '/dev/sda')
   * @param {Object} options - Options (wakeUp, sleeping)
   * @returns {Object} SMART data response
   */
  async getSmartInfo(device, options = {}) {
    const { wakeUp = false, sleeping = false } = options;
    const deviceName = device.replace('/dev/', '');
    const devicePath = device.startsWith('/dev/') ? device : `/dev/${device}`;
    const deviceInfo = await this._getDeviceInfo(deviceName);
    const serial = deviceInfo.serial;
    const monConfig = this._getDiskMonitoringConfig(serial, deviceInfo.diskType);

    const diskConf = serial ? this.config?.disks[serial] : null;

    const response = {
      device: devicePath,
      deviceName,
      serial: serial || null,
      model: deviceInfo.model || null,
      diskType: deviceInfo.diskType,
      sleeping: false,
      warning: diskConf ? this._hasDiskWarning(serial, diskConf) : false,
      smartStatus: null,
      temperature: null,
      powerOnHours: null,
      powerCycleCount: null,
      errorCount: null,
      attributes: null,
      source: null,
      monitoringConfig: monConfig
    };

    if (sleeping && !wakeUp) {
      response.sleeping = true;
      return response;
    }

    // Try smartctl JSON mode
    try {
      const { stdout } = await execPromise(`smartctl -j -a ${devicePath} 2>&1 || true`);
      const data = JSON.parse(stdout);

      if (data.smartctl && (data.smartctl.exit_status & 2)) {
        response.sleeping = true;
        return response;
      }

      return this._buildFromSmartctlJson(response, data);
    } catch { /* JSON mode not available or parse failed */ }

    // Fallback: smartctl text mode
    try {
      const { stdout } = await execPromise(`smartctl -a ${devicePath} 2>&1 || true`);
      if (stdout.includes('Device is in STANDBY mode')) {
        response.sleeping = true;
        return response;
      }
      return this._buildFromSmartctlText(response, stdout);
    } catch { /* smartctl failed entirely */ }

    // Last resort: state file data
    if (serial) {
      const stateData = this._findStateForSerial(serial);
      if (stateData) return this._buildFromStateFile(response, stateData);
    }

    return response;
  }

  /**
   * Build SMART response from smartctl JSON output
   * @param {Object} response - Response object to populate
   * @param {Object} data - Parsed smartctl JSON data
   * @returns {Object} Populated response
   * @private
   */
  _buildFromSmartctlJson(response, data) {
    response.source = 'smartctl_live';

    if (data.smart_status) {
      response.smartStatus = data.smart_status.passed === true ? 'PASSED' :
                             data.smart_status.passed === false ? 'FAILED' : null;
    }

    if (data.temperature) {
      response.temperature = {
        current: data.temperature.current ?? null,
        min: data.temperature.lifetime_min ?? null,
        max: data.temperature.lifetime_max ?? null
      };
    }

    response.powerOnHours = data.power_on_time?.hours ?? null;
    response.powerCycleCount = data.power_cycle_count ?? null;
    response.errorCount = data.ata_smart_error_log?.summary?.count ?? null;

    if (data.serial_number) response.serial = data.serial_number;
    if (data.model_name) response.model = data.model_name;

    if (data.ata_smart_attributes?.table) {
      response.attributes = data.ata_smart_attributes.table.map(attr => ({
        id: attr.id,
        name: attr.name || ATTRIBUTE_NAMES[attr.id] || `Unknown_${attr.id}`,
        value: attr.value ?? null,
        worst: attr.worst ?? null,
        threshold: attr.thresh ?? null,
        rawValue: attr.raw?.value ?? null,
        status: !attr.when_failed || attr.when_failed === '' ? 'ok' :
                attr.when_failed === 'past' ? 'ok_past_failure' : 'failing'
      }));
    } else if (data.nvme_smart_health_information_log) {
      const nvme = data.nvme_smart_health_information_log;
      response.temperature = {
        current: nvme.temperature ?? null,
        min: null,
        max: null
      };
      response.powerOnHours = nvme.power_on_hours ?? null;
      response.powerCycleCount = nvme.power_cycles ?? null;
      response.errorCount = nvme.media_errors ?? null;
      response.attributes = [
        {
          id: 0, name: 'Critical_Warning', value: null, worst: null,
          threshold: null, rawValue: nvme.critical_warning ?? 0,
          status: nvme.critical_warning ? 'failing' : 'ok'
        },
        {
          id: 1, name: 'Available_Spare', value: nvme.available_spare ?? null, worst: null,
          threshold: nvme.available_spare_threshold ?? null, rawValue: nvme.available_spare ?? null,
          status: (nvme.available_spare ?? 100) < (nvme.available_spare_threshold ?? 0) ? 'failing' : 'ok'
        },
        {
          id: 2, name: 'Media_Errors', value: null, worst: null,
          threshold: null, rawValue: nvme.media_errors ?? 0,
          status: nvme.media_errors ? 'warning' : 'ok'
        },
        {
          id: 3, name: 'Percentage_Used', value: null, worst: null,
          threshold: null, rawValue: nvme.percentage_used ?? 0,
          status: (nvme.percentage_used ?? 0) >= 100 ? 'warning' : 'ok'
        }
      ];
    }

    return response;
  }

  /**
   * Build SMART response from smartctl text output (fallback)
   * @param {Object} response - Response object to populate
   * @param {string} stdout - Raw smartctl text output
   * @returns {Object} Populated response
   * @private
   */
  _buildFromSmartctlText(response, stdout) {
    response.source = 'smartctl_live';
    const lines = stdout.split('\n');

    for (const line of lines) {
      if (line.includes('SMART overall-health')) {
        response.smartStatus = line.includes('PASSED') ? 'PASSED' : 'FAILED';
      }
    }

    const attrs = [];
    let inAttrSection = false;
    for (const line of lines) {
      if (line.startsWith('ID#')) { inAttrSection = true; continue; }
      if (inAttrSection && line.trim() === '') { inAttrSection = false; continue; }
      if (!inAttrSection) continue;

      const parts = line.trim().split(/\s+/);
      if (parts.length >= 10) {
        const id = parseInt(parts[0]);
        if (isNaN(id)) continue;
        const rawStr = parts[9];
        const rawValue = parseInt(rawStr) || 0;

        attrs.push({
          id,
          name: parts[1] || ATTRIBUTE_NAMES[id] || `Unknown_${id}`,
          value: parseInt(parts[3]) || null,
          worst: parseInt(parts[4]) || null,
          threshold: parseInt(parts[5]) || null,
          rawValue,
          status: parts[8] === '-' ? 'ok' : parts[8] === 'FAILING_NOW' ? 'failing' : 'ok'
        });

        if ((id === 194 || id === 190) && !response.temperature) {
          const temp = rawValue & 0xFF;
          if (temp >= 1 && temp <= 100) {
            response.temperature = { current: temp, min: null, max: null };
          }
        }
        if (id === 9) response.powerOnHours = rawValue;
        if (id === 12) response.powerCycleCount = rawValue;
      }
    }

    if (attrs.length > 0) response.attributes = attrs;

    const errorMatch = stdout.match(/ATA Error Count:\s*(\d+)/);
    if (errorMatch) response.errorCount = parseInt(errorMatch[1]);

    return response;
  }

  /**
   * Build SMART response from cached smartd state data (last resort)
   * @param {Object} response - Response object to populate
   * @param {Object} stateData - Cached state data
   * @returns {Object} Populated response
   * @private
   */
  _buildFromStateFile(response, stateData) {
    response.source = 'smartd_state';
    response.errorCount = stateData.errorCount;

    if (stateData.temperatureCurrent !== null || stateData.temperatureMin !== null) {
      response.temperature = {
        current: stateData.temperatureCurrent,
        min: stateData.temperatureMin,
        max: stateData.temperatureMax
      };
    }

    const attrEntries = Object.values(stateData.attributes);
    if (attrEntries.length > 0) {
      response.attributes = attrEntries.map(a => ({ ...a }));
      const attr9 = stateData.attributes[9];
      if (attr9 && attr9.rawValue !== null) response.powerOnHours = attr9.rawValue;
      const attr12 = stateData.attributes[12];
      if (attr12 && attr12.rawValue !== null) response.powerCycleCount = attr12.rawValue;
    }

    return response;
  }

  /**
   * Get effective monitoring config for a disk (disk-specific or type defaults)
   * @param {string} serial - Disk serial number
   * @param {string} diskType - Disk type (hdd, ssd, nvme)
   * @returns {Object} Monitoring config with temperatureWarning, temperatureCritical
   * @private
   */
  _getDiskMonitoringConfig(serial, diskType) {
    if (!this.config || !serial) {
      const type = diskType || 'hdd';
      const limits = DEFAULT_TEMPERATURE_LIMITS[type] || DEFAULT_TEMPERATURE_LIMITS.hdd;
      return { temperatureWarning: limits.warning, temperatureCritical: limits.critical };
    }
    const diskConf = this.config.disks[serial];
    if (diskConf) {
      return {
        temperatureWarning: diskConf.temperatureWarning,
        temperatureCritical: diskConf.temperatureCritical
      };
    }
    const type = diskType || 'hdd';
    const limits = this.config.defaults.temperatureLimits[type] || DEFAULT_TEMPERATURE_LIMITS.hdd;
    return { temperatureWarning: limits.warning, temperatureCritical: limits.critical };
  }

  // ============================================================
  // SMARTD.CONF GENERATION
  // ============================================================

  /**
   * Generate /etc/smartd.conf from current configuration and reload smartd
   * @private
   */
  async _generateSmartdConf() {
    if (!this.config) return;

    try {
      const lines = [
        '# Generated by mos-api SMART service - DO NOT EDIT MANUALLY',
        `# Last generated: ${new Date().toISOString()}`,
        ''
      ];

      const hasCustomDisks = Object.values(this.config.disks).some(d => {
        const defaults = this.config.defaults.temperatureLimits[d.diskType] ||
                         this.config.defaults.temperatureLimits.hdd;
        if (d.temperatureWarning !== defaults.warning || d.temperatureCritical !== defaults.critical) return true;
        if (d.monitoredAttributes) return true;
        return false;
      });

      if (!hasCustomDisks || Object.keys(this.config.disks).length === 0) {
        const defaultLimits = this.config.defaults.temperatureLimits.hdd;
        const attrFlags = this.config.defaults.monitoredAttributes.map(id => `-R ${id}`).join(' ');
        lines.push(
          `DEVICESCAN -n standby,q -W 5,${defaultLimits.warning},${defaultLimits.critical} ${attrFlags}`
        );
      } else {
        const byIdPaths = await this._getDeviceByIdPaths();

        for (const [serial, diskConf] of Object.entries(this.config.disks)) {
          const deviceInfo = this.serialDeviceMap.get(serial);
          let devicePath = null;
          if (deviceInfo) {
            devicePath = byIdPaths[deviceInfo.name] || `/dev/${deviceInfo.name}`;
          }
          if (!devicePath) {
            lines.push(`# ${diskConf.model} (${serial}) - device not found, skipped`);
            continue;
          }

          const attrFlags = this._getEffectiveMonitoredAttributes(diskConf)
            .map(id => `-R ${id}`).join(' ');
          const w = diskConf.temperatureWarning;
          const c = diskConf.temperatureCritical;
          const dType = { nvme: 'nvme', sata: 'sat', sas: 'scsi', usb: 'sat' }[deviceInfo.tran] || 'auto';
          lines.push(`${devicePath} -d ${dType} -n standby,q -W 5,${w},${c} ${attrFlags}`);
        }
      }

      lines.push('');
      const newContent = lines.join('\n');

      // Only write and reload if functional content changed (skip timestamp line for comparison)
      try {
        const existing = await fs.readFile(SMARTD_CONF_PATH, 'utf8');
        const stripTimestamp = (s) => s.replace(/^# Last generated:.*$/m, '');
        if (stripTimestamp(existing) === stripTimestamp(newContent)) {
          return; // No functional change → skip reload to avoid waking disks
        }
      } catch {
        // File doesn't exist yet → write it
      }

      await fs.writeFile(SMARTD_CONF_PATH, newContent, 'utf8');
      await this._reloadSmartd();
    } catch (error) {
      console.warn(`[SmartService] Failed to generate smartd.conf: ${error.message}`);
    }
  }

  /**
   * Reload smartd configuration via SIGHUP (no restart needed)
   * @private
   */
  async _reloadSmartd() {
    try {
      await execPromise('pgrep smartd >/dev/null 2>&1 && kill -HUP $(pgrep smartd)');
    } catch { /* smartd not running */ }
  }

  /**
   * Get /dev/disk/by-id/ paths mapped to device names
   * @returns {Object} Map of device name to by-id path
   * @private
   */
  async _getDeviceByIdPaths() {
    const result = {};
    try {
      const { stdout } = await execPromise('ls -la /dev/disk/by-id/ 2>/dev/null');
      for (const line of stdout.split('\n')) {
        const match = line.match(/\s(ata-[^\s]+|nvme-[^\s]+|scsi-[^\s]+)\s+->\s+\.\.\/\.\.\/(\S+)$/);
        if (!match) continue;
        if (match[1].match(/-part\d+$/)) continue;
        result[match[2]] = `/dev/disk/by-id/${match[1]}`;
      }
    } catch { /* ignore */ }
    return result;
  }

  // ============================================================
  // DISK SYNC
  // ============================================================

  /**
   * Sync disk configuration with currently present disks
   * Adds new disks, updates existing, moves missing to orphaned
   * @private
   */
  async _syncDisks() {
    if (!this.config) return;
    let configChanged = false;
    const currentSerials = new Set(this.serialDeviceMap.keys());

    for (const [serial, info] of this.serialDeviceMap) {
      if (!this.config.disks[serial]) {
        const orphanIdx = this.config.orphaned.findIndex(o => o.serial === serial);
        if (orphanIdx >= 0) {
          this.config.disks[serial] = this._createDiskEntry(
            serial, this.config.orphaned[orphanIdx].model || info.model, info.diskType
          );
          this.config.orphaned.splice(orphanIdx, 1);
        } else {
          this.config.disks[serial] = this._createDiskEntry(serial, info.model, info.diskType);
        }
        configChanged = true;
      } else {
        const disk = this.config.disks[serial];
        disk.lastSeen = new Date().toISOString();
        if (disk.model === 'Unknown' && info.model) disk.model = info.model;
        if (disk.diskType === 'unknown' && info.diskType !== 'unknown') disk.diskType = info.diskType;
        configChanged = true;
      }
    }

    const orphanSerials = [];
    for (const serial of Object.keys(this.config.disks)) {
      if (!currentSerials.has(serial)) orphanSerials.push(serial);
    }
    for (const serial of orphanSerials) {
      const disk = this.config.disks[serial];
      this.config.orphaned.push({
        serial,
        lastSeen: disk.lastSeen,
        model: disk.model,
        diskType: disk.diskType
      });
      delete this.config.disks[serial];
      configChanged = true;
    }

    if (configChanged) await this._saveConfig();
  }

  // ============================================================
  // STATUS
  // ============================================================

  /**
   * Get current monitoring service status including active warnings
   * @returns {Object} Status information
   */
  getStatus() {
    const activeWarnings = { temperature: [], attributes: {} };

    for (const [serial, isWarning] of this._tempWarnings) {
      if (isWarning) activeWarnings.temperature.push(serial);
    }

    for (const [key, timestamp] of this._attrCooldowns) {
      const [serial, attrId] = key.split(':');
      if (!activeWarnings.attributes[serial]) activeWarnings.attributes[serial] = {};
      activeWarnings.attributes[serial][attrId] = {
        lastNotified: new Date(timestamp).toISOString()
      };
    }

    return {
      initialized: this._initialized,
      watcherActive: this._watcher !== null,
      smartdStateDir: SMARTD_STATE_DIR,
      stateDirExists: (() => { try { fsSync.accessSync(SMARTD_STATE_DIR); return true; } catch { return false; } })(),
      configPath: SMART_CONFIG_PATH,
      monitoredDisks: this.config ? Object.keys(this.config.disks).length : 0,
      orphanedDisks: this.config ? this.config.orphaned.length : 0,
      cachedStates: this.diskState.size,
      activeWarnings,
      lastStateChange: this._lastStateChange
    };
  }

  // ============================================================
  // HELPERS
  // ============================================================

  /**
   * Resolve a device identifier (device name like 'sda' or serial number) to a serial
   * @param {string} identifier - Device name or serial number
   * @returns {string|null} Serial number or null if not found
   */
  resolveToSerial(identifier) {
    if (!identifier) return null;
    if (this.config && this.config.disks[identifier]) return identifier;
    for (const [serial, info] of this.serialDeviceMap) {
      if (info.name === identifier) return serial;
    }
    return null;
  }

  /**
   * Check if a disk has a SMART warning by serial number (for external use, e.g. pools)
   * @param {string} serial - Disk serial number
   * @returns {boolean} True if any monitored attribute raw value is > 0
   */
  hasDiskWarning(serial) {
    if (!serial || !this.config) return false;
    const diskConf = this.config.disks[serial];
    return this._hasDiskWarning(serial, diskConf || {});
  }

  /**
   * Get temperature status for a disk by serial number (for external use, e.g. pools)
   * @param {string} serial - Disk serial number
   * @returns {null|"warning"|"critical"} null if no temp data, "warning" or "critical" if thresholds exceeded
   */
  getDiskTemperatureStatus(serial) {
    if (!serial || !this.config) return null;
    const diskConf = this.config.disks[serial];
    if (!diskConf) return null;
    const state = this.diskState.get(serial);
    if (!state || state.temperatureCurrent === null || state.temperatureCurrent === undefined) return null;
    const temp = state.temperatureCurrent;
    if (diskConf.temperatureCritical && temp >= diskConf.temperatureCritical) return 'critical';
    if (diskConf.temperatureWarning && temp >= diskConf.temperatureWarning) return 'warning';
    return null;
  }

  /**
   * Get effective monitored attributes for a disk (disk-specific override or global defaults)
   * @param {Object} diskConf - Disk configuration
   * @returns {Array<number>} Monitored attribute IDs
   * @private
   */
  _getEffectiveMonitoredAttributes(diskConf) {
    if (diskConf && diskConf.monitoredAttributes) return diskConf.monitoredAttributes;
    if (this.config && this.config.defaults.monitoredAttributes) return this.config.defaults.monitoredAttributes;
    return DEFAULT_MONITORED_ATTRIBUTES;
  }

  /**
   * Check if a disk has any non-zero monitored attribute values (computed, not stored)
   * @param {string} serial - Disk serial number
   * @param {Object} diskConf - Disk configuration
   * @returns {boolean} True if any monitored attribute raw value is > 0
   * @private
   */
  _hasDiskWarning(serial, diskConf) {
    const state = this.diskState.get(serial);
    if (!state || !state.attributes) return false;
    const monitored = this._getEffectiveMonitoredAttributes(diskConf);
    for (const attrId of monitored) {
      const attr = state.attributes[attrId];
      if (attr && attr.rawValue !== null && attr.rawValue !== undefined && attr.rawValue > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * Deep merge source into target (objects merged recursively, arrays replaced)
   * @param {Object} target - Target object
   * @param {Object} source - Source object to merge
   * @returns {Object} Merged result
   * @private
   */
  _deepMerge(target, source) {
    if (!source || typeof source !== 'object') return target;
    const result = { ...target };
    for (const [key, value] of Object.entries(source)) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value) &&
          result[key] !== null && typeof result[key] === 'object' && !Array.isArray(result[key])) {
        result[key] = this._deepMerge(result[key], value);
      } else {
        result[key] = value;
      }
    }
    return result;
  }
}

module.exports = new SmartService();
