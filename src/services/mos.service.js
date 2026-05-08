const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const crypto = require('crypto');
const axios = require('axios');
const PoolsService = require('./pools.service');
const hubService = require('./hub.service');
const systemService = require('./system.service');
const swapService = require('./swap.service');

class MosService {
  constructor() {
    this.dbPath = path.join(process.cwd(), 'mos_db.sqlite');
    this.pools = [];
    this.settingsPath = '/boot/config/docker.json';
    this.dashboardPath = '/boot/config/dashboard.json';
    this.sensorsConfigPath = '/boot/config/system/sensors.json';
    this.sensorsExternalPath = '/var/mos/external-sensors.json';
    this.tokensPath = '/boot/config/system/tokens.json';

    // Sensors config cache
    this._sensorsConfigCache = null;

    // Network pending changes state
    this._networkPendingChanges = false;
    this._networkRollbackTimer = null;
    this._networkBackupConfig = null;
    this._systemJsonBackup = null;
    this._networkRollbackTimeout = 60000; // 60 seconds
    this._networkPendingTimestamp = null;
  }

  /**
   * Checks if a ZFS dataset is mounted at the given path
   * This allows using ZFS pools that are not registered in pools.json
   * @param {string} mountPath - The mount path to check (e.g., /mnt/poolname)
   * @returns {Promise<Object>} Object with { isMounted: boolean, poolName?: string, datasetName?: string }
   */
  async _checkZfsMountedAt(mountPath) {
    try {
      // Use zfs list to get all mounted datasets with their mountpoints
      // Example output: "zfspool\t/mnt/zfs" or "tank/data\t/mnt/tank/data"
      const { stdout: zfsOutput } = await execPromise('zfs list -H -o name,mountpoint 2>/dev/null');
      const lines = zfsOutput.trim().split('\n').filter(l => l);

      for (const line of lines) {
        const [datasetName, zfsMountPoint] = line.split('\t');
        // Check if the requested path is on this ZFS mountpoint
        if (zfsMountPoint && zfsMountPoint !== '-' && mountPath.startsWith(zfsMountPoint)) {
          return {
            isMounted: true,
            poolName: datasetName.split('/')[0], // First part is pool name
            datasetName: datasetName,
            mountPoint: zfsMountPoint
          };
        }
      }

      return { isMounted: false };
    } catch {
      // ZFS not installed or command failed - no ZFS pools available
      return { isMounted: false };
    }
  }

  // ============================================================
  // SENSOR MAPPING METHODS
  // ============================================================

  /**
   * Generate timestamp-based ID
   * @returns {string} Timestamp ID
   * @private
   */
  _generateSensorId() {
    return Date.now().toString();
  }

  /**
   * Ensure the sensors config directory exists
   * @private
   */
  async _ensureSensorsConfigDir() {
    const dir = path.dirname(this.sensorsConfigPath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      // Directory already exists or cannot be created
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }

  /**
   * Valid sensor types
   * @private
   */
  _getValidSensorTypes() {
    return ['fan', 'temperature', 'power', 'voltage', 'psu', 'other'];
  }

  /**
   * Get empty grouped sensors structure
   * @private
   */
  _getEmptyGroupedSensors() {
    return {
      fan: [],
      temperature: [],
      power: [],
      voltage: [],
      psu: [],
      other: []
    };
  }

  /**
   * Get default view settings
   * @private
   */
  _getDefaultViewSettings() {
    return {
      index: true,
      name: true,
      type: true,
      subtype: true,
      manufacturer: true,
      model: true,
      value: true,
      unit: true,
      actions: true
    };
  }

  /**
   * Load external sensors from file if it exists
   * @returns {Promise<Object|null>} External sensors data or null
   * @private
   */
  async _loadExternalSensors() {
    try {
      const data = await fs.readFile(this.sensorsExternalPath, 'utf8');
      const parsed = JSON.parse(data);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed;
      }
      return null;
    } catch (error) {
      // File doesn't exist or invalid - that's fine
      return null;
    }
  }

  /**
   * Check if any configured sensor uses external source
   * @param {Object} groupedConfig - Sensor configuration
   * @returns {boolean} True if any sensor uses mos-external source
   * @private
   */
  _hasExternalSensorSources(groupedConfig) {
    const validTypes = this._getValidSensorTypes();
    for (const type of validTypes) {
      const sensors = groupedConfig[type] || [];
      if (sensors.some(s => s.source && s.source.startsWith('mos-external.'))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Load sensors configuration from file (uses cache if available)
   * @param {boolean} forceReload - Force reload from file, bypassing cache
   * @returns {Promise<Object>} Grouped sensor configurations
   */
  async loadSensorsConfig(forceReload = false) {
    // Return cached config if available
    if (!forceReload && this._sensorsConfigCache) {
      return this._sensorsConfigCache;
    }

    try {
      const data = await fs.readFile(this.sensorsConfigPath, 'utf8');
      const config = JSON.parse(data);

      // Validate it's a grouped object
      if (typeof config !== 'object' || config === null || Array.isArray(config)) {
        this._sensorsConfigCache = this._getEmptyGroupedSensors();
        return this._sensorsConfigCache;
      }

      // Ensure all groups exist
      const validTypes = this._getValidSensorTypes();
      const result = this._getEmptyGroupedSensors();
      for (const type of validTypes) {
        if (Array.isArray(config[type])) {
          result[type] = config[type];
        }
      }
      this._sensorsConfigCache = result;
      return result;
    } catch (error) {
      if (error.code === 'ENOENT') {
        this._sensorsConfigCache = this._getEmptyGroupedSensors();
        return this._sensorsConfigCache;
      }
      throw new Error(`Failed to load sensors config: ${error.message}`);
    }
  }

  /**
   * Save sensors configuration to file (grouped by type)
   * Also updates the in-memory cache
   * Preserves the view settings if they exist
   * @param {Object} groupedSensors - Grouped sensor configurations
   * @private
   */
  async _saveSensorsConfig(groupedSensors) {
    await this._ensureSensorsConfigDir();

    // Load existing config to preserve view settings
    let existingConfig = {};
    try {
      const data = await fs.readFile(this.sensorsConfigPath, 'utf8');
      existingConfig = JSON.parse(data);
    } catch (error) {
      // File doesn't exist, start fresh
    }

    // Re-index sensors within each group
    const validTypes = this._getValidSensorTypes();
    const reindexed = {};
    for (const type of validTypes) {
      if (Array.isArray(groupedSensors[type])) {
        reindexed[type] = groupedSensors[type].map((sensor, idx) => ({
          ...sensor,
          index: idx
        }));
      } else {
        reindexed[type] = [];
      }
    }

    // Preserve view settings
    if (existingConfig.view) {
      reindexed.view = existingConfig.view;
    }

    await fs.writeFile(
      this.sensorsConfigPath,
      JSON.stringify(reindexed, null, 2),
      'utf8'
    );

    // Update cache (without view)
    const cacheResult = { ...reindexed };
    delete cacheResult.view;
    this._sensorsConfigCache = cacheResult;
    return cacheResult;
  }

  /**
   * Invalidate the sensors config cache
   * Call this if the config file was modified externally
   */
  invalidateSensorsCache() {
    this._sensorsConfigCache = null;
  }

  /**
   * Find sensor by source across all groups
   * @param {Object} groupedSensors - Grouped sensor configurations
   * @param {string} source - Source path to find
   * @param {string} excludeId - Optional sensor ID to exclude from search
   * @returns {Object|null} Found sensor with its type, or null
   * @private
   */
  _findSensorBySource(groupedSensors, source, excludeId = null) {
    const validTypes = this._getValidSensorTypes();
    for (const type of validTypes) {
      const sensors = groupedSensors[type] || [];
      const found = sensors.find(s => s.source === source && s.id !== excludeId);
      if (found) {
        return { sensor: found, type };
      }
    }
    return null;
  }

  /**
   * Find sensor by ID across all groups
   * @param {Object} groupedSensors - Grouped sensor configurations
   * @param {string} id - Sensor ID to find
   * @returns {Object|null} Found sensor with its type and index, or null
   * @private
   */
  _findSensorById(groupedSensors, id) {
    const validTypes = this._getValidSensorTypes();
    for (const type of validTypes) {
      const sensors = groupedSensors[type] || [];
      const index = sensors.findIndex(s => s.id === id);
      if (index !== -1) {
        return { sensor: sensors[index], type, index };
      }
    }
    return null;
  }

  /**
   * Get value from nested object using dot notation path
   * Supports escaped dots with \. for keys containing literal dots
   * @param {Object} obj - Source object
   * @param {string} pathStr - Dot notation path (e.g., "adapter.v_out +3\.3v.in3_input")
   * @returns {*} Value at path or undefined
   * @private
   */
  _getValueByPath(obj, pathStr) {
    // Use placeholder for escaped dots, split by unescaped dots, then restore
    const placeholder = '\x00';
    const escaped = pathStr.replace(/\\\./g, placeholder);
    const parts = escaped.split('.').map(p => p.replace(/\x00/g, '.'));

    let current = obj;
    for (const part of parts) {
      if (current === undefined || current === null) {
        return undefined;
      }
      current = current[part];
    }

    return current;
  }

  /**
   * Transform sensor value based on configuration
   * @param {number} value - Raw sensor value
   * @param {Object} sensorConfig - Sensor configuration
   * @returns {number} Transformed value
   * @private
   */
  _transformValue(value, sensorConfig) {
    if (value === undefined || value === null) {
      return null;
    }

    // Apply multiplier first (for voltage dividers etc.)
    if (sensorConfig.multiplier && typeof sensorConfig.multiplier === 'number') {
      value = value * sensorConfig.multiplier;
    }

    // Apply divisor (alternative to multiplier)
    if (sensorConfig.divisor && typeof sensorConfig.divisor === 'number' && sensorConfig.divisor !== 0) {
      value = value / sensorConfig.divisor;
    }

    if (sensorConfig.transform === 'percentage' && sensorConfig.value_range) {
      const { min = 0, max } = sensorConfig.value_range;
      if (max && max !== min) {
        return Math.round(((value - min) / (max - min)) * 100 * 10) / 10;
      }
    }

    // No transformation, return raw value (rounded to 2 decimals)
    return Math.round(value * 100) / 100;
  }

  /**
   * Validate that a sensor source path exists in the raw sensor data
   * @param {string} source - Dot notation path to validate
   * @throws {Error} If source path doesn't exist
   * @private
   */
  async _validateSensorSource(source) {
    // Check if source is external
    if (source.startsWith('mos-external.')) {
      const externalSensors = await this._loadExternalSensors();
      if (!externalSensors) {
        throw new Error(`Invalid source: external sensors file not found`);
      }
      const externalPath = source.substring('mos-external.'.length);
      const value = this._getValueByPath(externalSensors, externalPath);
      if (value === undefined) {
        throw new Error(`Invalid source: "${source}" not found in external sensor data`);
      }
      return;
    }

    // Validate against system sensors
    let rawSensors;
    try {
      rawSensors = await systemService.getSensors();
    } catch (error) {
      throw new Error(`Cannot validate source: sensors command failed - ${error.message}`);
    }

    const value = this._getValueByPath(rawSensors, source);
    if (value === undefined) {
      throw new Error(`Invalid source: "${source}" not found in sensor data`);
    }
  }

  /**
   * Get sensors configuration (full config, grouped by type)
   * GET /mos/sensors/config
   * @returns {Promise<Object>} Grouped sensors configuration
   */
  async getSensorsConfig() {
    return await this.loadSensorsConfig();
  }

  /**
   * Get sensors view settings
   * GET /mos/sensors/view
   * @returns {Promise<Object>} View settings
   */
  async getSensorsView() {
    const config = await this._loadFullSensorsConfig();
    return config.view || this._getDefaultViewSettings();
  }

  /**
   * Update sensors view settings
   * POST /mos/sensors/view
   * @param {Object} viewData - View settings to update
   * @returns {Promise<Object>} Updated view settings
   */
  async updateSensorsView(viewData) {
    const config = await this._loadFullSensorsConfig();
    const currentView = config.view || this._getDefaultViewSettings();

    // Merge with existing settings (only update provided fields)
    const updatedView = { ...currentView };
    const allowedFields = ['index', 'name', 'type', 'subtype', 'manufacturer', 'model', 'value', 'unit', 'actions'];

    for (const field of allowedFields) {
      if (viewData[field] !== undefined) {
        updatedView[field] = Boolean(viewData[field]);
      }
    }

    config.view = updatedView;
    await this._saveFullSensorsConfig(config);

    return updatedView;
  }

  /**
   * Load full sensors config including view (internal use)
   * @private
   */
  async _loadFullSensorsConfig() {
    try {
      const data = await fs.readFile(this.sensorsConfigPath, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      // Return default structure
      return {
        ...this._getEmptyGroupedSensors(),
        view: this._getDefaultViewSettings()
      };
    }
  }

  /**
   * Save full sensors config including view (internal use)
   * @private
   */
  async _saveFullSensorsConfig(config) {
    await this._ensureSensorsConfigDir();
    await fs.writeFile(this.sensorsConfigPath, JSON.stringify(config, null, 2));
    // Invalidate cache
    this._sensorsConfigCache = null;
  }

  /**
   * Get mapped sensor values (values only, grouped by type)
   * GET /mos/sensors
   * @returns {Promise<Object>} Grouped sensor values
   */
  async getMappedSensors() {
    const groupedConfig = await this.loadSensorsConfig();
    const validTypes = this._getValidSensorTypes();

    // Check if any sensors exist
    const hasAnySensors = validTypes.some(type => groupedConfig[type]?.length > 0);
    if (!hasAnySensors) {
      return this._getEmptyGroupedSensors();
    }

    // Get raw sensor data
    let rawSensors;
    try {
      rawSensors = await systemService.getSensors();
    } catch (error) {
      console.error('Failed to get raw sensors:', error.message);
      rawSensors = null;
    }

    // Load external sensors only if needed (any sensor uses mos-external.* source)
    let externalSensors = null;
    if (this._hasExternalSensorSources(groupedConfig)) {
      externalSensors = await this._loadExternalSensors();
    }

    // Build grouped response with values
    const result = {};
    for (const type of validTypes) {
      const sensors = groupedConfig[type] || [];
      result[type] = sensors
        .filter(s => s.enabled)
        .sort((a, b) => a.index - b.index)
        .map(sensor => {
          let value = null;
          // Check if source is external
          if (sensor.source && sensor.source.startsWith('mos-external.')) {
            if (externalSensors) {
              // Remove 'mos-external.' prefix and get value
              const externalPath = sensor.source.substring('mos-external.'.length);
              const rawValue = this._getValueByPath(externalSensors, externalPath);
              if (rawValue !== undefined) {
                value = this._transformValue(rawValue, sensor);
              } else {
                // Path not found in external file
                value = '-';
              }
            } else {
              // External file not found
              value = '-';
            }
          } else if (rawSensors) {
            const rawValue = this._getValueByPath(rawSensors, sensor.source);
            value = this._transformValue(rawValue, sensor);
          }
          return {
            id: sensor.id,
            index: sensor.index,
            name: sensor.name,
            manufacturer: sensor.manufacturer || null,
            model: sensor.model || null,
            subtype: sensor.subtype || null,
            value: value,
            unit: sensor.unit
          };
        });
    }
    return result;
  }

  /**
   * Get unmapped sensors (available but not yet configured)
   * Returns same structure as /system/sensors but with mapped sources removed
   * GET /mos/sensors/unmapped
   * @returns {Promise<Object>} Sensor data structure with mapped entries removed
   */
  async getUnmappedSensors() {
    // Get current config to find already mapped sources
    const groupedConfig = await this.loadSensorsConfig();
    const validTypes = this._getValidSensorTypes();

    // Collect all mapped sources (unescape \. to . for comparison)
    const mappedSources = new Set();
    for (const type of validTypes) {
      for (const sensor of groupedConfig[type] || []) {
        // Unescape \. to . for comparison with raw sensor paths
        const unescapedSource = sensor.source.replace(/\\\./g, '.');
        mappedSources.add(unescapedSource);
      }
    }

    // Get raw sensor data
    let rawSensors;
    try {
      rawSensors = await systemService.getSensors();
    } catch (error) {
      throw new Error(`Cannot get sensor data: ${error.message}`);
    }

    // Deep clone and filter out mapped sources
    const filterMapped = (obj, path = '') => {
      if (obj === null || obj === undefined) return undefined;
      if (typeof obj !== 'object') return obj;

      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        const currentPath = path ? `${path}.${key}` : key;

        if (typeof value === 'object' && value !== null) {
          // Recurse into nested objects
          const filtered = filterMapped(value, currentPath);
          // Only include if it has remaining properties
          if (filtered && Object.keys(filtered).length > 0) {
            result[key] = filtered;
          }
        } else if (typeof value === 'number') {
          // Check if this sensor value is mapped
          if (!mappedSources.has(currentPath)) {
            result[key] = value;
          }
        } else {
          // Keep non-numeric values (like "Adapter": "ISA adapter")
          result[key] = value;
        }
      }

      return result;
    };

    const unmapped = filterMapped(rawSensors);

    // Remove empty adapter entries (only have "Adapter" string left)
    const cleanEmpty = (obj) => {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'object' && value !== null) {
          // Check if this is an adapter with only "Adapter" key left
          const keys = Object.keys(value);
          const hasOnlyAdapter = keys.length === 1 && keys[0] === 'Adapter';
          const isEmpty = keys.length === 0;

          if (!hasOnlyAdapter && !isEmpty) {
            result[key] = value;
          }
        }
      }
      return result;
    };

    const result = cleanEmpty(unmapped);

    // Add external sensors if file exists
    const externalSensors = await this._loadExternalSensors();
    if (externalSensors) {
      // Filter out already mapped external sources
      const filteredExternal = filterMapped(externalSensors, 'mos-external');
      if (Object.keys(filteredExternal).length > 0) {
        result['mos-external'] = filteredExternal;
      }
    }

    return result;
  }

  /**
   * Create a new sensor mapping
   * POST /mos/sensors
   * @param {Object} sensorData - Sensor configuration data
   * @returns {Promise<Object>} Created sensor configuration
   */
  async createSensorMapping(sensorData) {
    const groupedSensors = await this.loadSensorsConfig();

    // Validate required fields
    const requiredFields = ['name', 'type', 'source', 'unit'];
    for (const field of requiredFields) {
      if (!sensorData[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    // Validate type
    const validTypes = this._getValidSensorTypes();
    if (!validTypes.includes(sensorData.type)) {
      throw new Error(`Invalid type. Must be one of: ${validTypes.join(', ')}`);
    }

    // Check for duplicate source
    const existing = this._findSensorBySource(groupedSensors, sensorData.source);
    if (existing) {
      throw new Error(`Source already defined by sensor "${existing.sensor.name}"`);
    }

    // Validate source exists in sensor data
    await this._validateSensorSource(sensorData.source);

    // Parse and validate multiplier/divisor (convert strings to numbers)
    const multiplier = sensorData.multiplier ? parseFloat(sensorData.multiplier) : null;
    const divisor = sensorData.divisor ? parseFloat(sensorData.divisor) : null;

    if (multiplier !== null && isNaN(multiplier)) {
      throw new Error('multiplier must be a valid number');
    }
    if (divisor !== null && isNaN(divisor)) {
      throw new Error('divisor must be a valid number');
    }
    if (multiplier && divisor) {
      throw new Error('Cannot specify both multiplier and divisor. Use only one.');
    }

    // Create new sensor config
    const targetGroup = groupedSensors[sensorData.type] || [];
    const newSensor = {
      id: this._generateSensorId(),
      index: targetGroup.length,
      name: sensorData.name,
      manufacturer: sensorData.manufacturer || null,
      model: sensorData.model || null,
      subtype: sensorData.subtype || null,
      source: sensorData.source,
      unit: sensorData.unit,
      multiplier: multiplier,
      divisor: divisor,
      value_range: sensorData.value_range || null,
      transform: sensorData.transform || null,
      enabled: sensorData.enabled !== undefined ? sensorData.enabled : true
    };

    // Add to correct group
    groupedSensors[sensorData.type].push(newSensor);
    await this._saveSensorsConfig(groupedSensors);

    return { ...newSensor, type: sensorData.type };
  }

  /**
   * Update an existing sensor mapping
   * POST /mos/sensors/:id
   * @param {string} id - Sensor ID
   * @param {Object} updateData - Fields to update
   * @returns {Promise<Object>} Updated sensor configuration
   */
  async updateSensorMapping(id, updateData) {
    const groupedSensors = await this.loadSensorsConfig();

    // Find sensor
    const found = this._findSensorById(groupedSensors, id);
    if (!found) {
      throw new Error(`Sensor with id ${id} not found`);
    }

    const { sensor, type: currentType, index: currentIndex } = found;

    // Validate type if provided
    const validTypes = this._getValidSensorTypes();
    if (updateData.type && !validTypes.includes(updateData.type)) {
      throw new Error(`Invalid type. Must be one of: ${validTypes.join(', ')}`);
    }

    // Check for duplicate source (excluding this sensor)
    if (updateData.source) {
      const existing = this._findSensorBySource(groupedSensors, updateData.source, id);
      if (existing) {
        throw new Error(`Source already defined by sensor "${existing.sensor.name}"`);
      }
      await this._validateSensorSource(updateData.source);
    }

    // Parse and validate multiplier/divisor (convert strings to numbers)
    let parsedMultiplier = sensor.multiplier;
    let parsedDivisor = sensor.divisor;

    if (updateData.multiplier !== undefined) {
      parsedMultiplier = updateData.multiplier ? parseFloat(updateData.multiplier) : null;
      if (parsedMultiplier !== null && isNaN(parsedMultiplier)) {
        throw new Error('multiplier must be a valid number');
      }
    }
    if (updateData.divisor !== undefined) {
      parsedDivisor = updateData.divisor ? parseFloat(updateData.divisor) : null;
      if (parsedDivisor !== null && isNaN(parsedDivisor)) {
        throw new Error('divisor must be a valid number');
      }
    }

    // Validate multiplier/divisor exclusivity
    if (parsedMultiplier && parsedDivisor) {
      throw new Error('Cannot specify both multiplier and divisor. Use only one.');
    }

    // Update allowed fields (not type - handled separately)
    const allowedFields = ['name', 'manufacturer', 'model', 'subtype', 'source', 'unit', 'value_range', 'transform', 'enabled', 'index'];
    for (const field of allowedFields) {
      if (updateData[field] !== undefined) {
        sensor[field] = updateData[field];
      }
    }

    // Set parsed multiplier/divisor
    if (updateData.multiplier !== undefined) {
      sensor.multiplier = parsedMultiplier;
    }
    if (updateData.divisor !== undefined) {
      sensor.divisor = parsedDivisor;
    }

    // Handle type change - move to different group
    const newType = updateData.type || currentType;
    if (newType !== currentType) {
      // Remove from current group
      groupedSensors[currentType].splice(currentIndex, 1);
      // Add to new group
      sensor.index = groupedSensors[newType].length;
      groupedSensors[newType].push(sensor);
    } else if (updateData.index !== undefined && updateData.index !== currentIndex) {
      // Reorder within same group
      groupedSensors[currentType].splice(currentIndex, 1);
      const newIndex = Math.max(0, Math.min(updateData.index, groupedSensors[currentType].length));
      groupedSensors[currentType].splice(newIndex, 0, sensor);
    }

    const savedConfig = await this._saveSensorsConfig(groupedSensors);

    // Find updated sensor in saved config
    const updatedFound = this._findSensorById(savedConfig, id);
    return { ...updatedFound.sensor, type: updatedFound.type };
  }

  /**
   * Delete a sensor mapping
   * DELETE /mos/sensors/:id
   * @param {string} id - Sensor ID
   * @returns {Promise<Object>} Deleted sensor configuration
   */
  async deleteSensorMapping(id) {
    const groupedSensors = await this.loadSensorsConfig();

    // Find sensor
    const found = this._findSensorById(groupedSensors, id);
    if (!found) {
      throw new Error(`Sensor with id ${id} not found`);
    }

    const { sensor, type, index } = found;

    // Remove from group
    groupedSensors[type].splice(index, 1);

    // _saveSensorsConfig automatically re-indexes
    await this._saveSensorsConfig(groupedSensors);

    return { ...sensor, type };
  }

  /**
   * Replace entire sensors configuration
   * PUT /mos/sensors
   * @param {Object} newConfig - New grouped sensor configuration
   * @returns {Promise<Object>} Saved sensor configuration
   */
  async replaceSensorsConfig(newConfig) {
    // Validate input is an object
    if (typeof newConfig !== 'object' || newConfig === null || Array.isArray(newConfig)) {
      throw new Error('Config must be an object with sensor type groups');
    }

    const validTypes = this._getValidSensorTypes();
    const result = this._getEmptyGroupedSensors();

    // Validate and copy each group
    for (const type of validTypes) {
      if (newConfig[type] !== undefined) {
        if (!Array.isArray(newConfig[type])) {
          throw new Error(`Invalid config: ${type} must be an array`);
        }
        // Validate each sensor has required fields
        for (const sensor of newConfig[type]) {
          if (!sensor.id || !sensor.name || !sensor.source || !sensor.unit) {
            throw new Error(`Invalid sensor in ${type}: missing required fields (id, name, source, unit)`);
          }
        }
        result[type] = newConfig[type];
      }
    }

    // Save and return (will re-index)
    return await this._saveSensorsConfig(result);
  }

  /**
   * Finds the first available non-MergerFS pool for default path suggestions
   * Falls back to MergerFS pool if no other pool is available
   * @returns {Promise<string|null>} The pool name or null if no suitable pool found
   */
  async _getFirstNonMergerFSPool() {
    try {
      const baseService = new PoolsService();
      const pools = await baseService.listPools({});

      let firstMergerFSPool = null;

      // First pass: Check for non-MergerFS pools
      for (const pool of pools) {
        if (pool.type !== 'mergerfs') {
          const mountPoint = `/mnt/${pool.name}`;
          const isMounted = await baseService._isMounted(mountPoint);
          if (isMounted) {
            return pool.name;
          }
        } else if (!firstMergerFSPool) {
          // Remember the first MergerFS pool for fallback
          firstMergerFSPool = pool;
        }
      }

      // No non-MergerFS pool found, try to use MergerFS as fallback
      if (firstMergerFSPool) {
        // Find the first available disk in the MergerFS pool
        const firstDisk = await this._getFirstAvailableMergerFSDisk(firstMergerFSPool.name);
        if (firstDisk) {
          return `${firstMergerFSPool.name}/${firstDisk}`;
        }
      }

      return null;
    } catch (error) {
      console.warn('Could not determine default pool for path suggestions:', error.message);
      return null;
    }
  }

  /**
   * Finds the first available disk in a MergerFS pool
   * @param {string} poolName - The MergerFS pool name
   * @returns {Promise<string|null>} The disk name (e.g., 'disk1', 'disk2') or null
   */
  async _getFirstAvailableMergerFSDisk(poolName) {
    try {
      const basePath = `/var/mergerfs/${poolName}`;

      // Check up to 10 disks (should be more than enough)
      for (let i = 1; i <= 10; i++) {
        const diskPath = `${basePath}/disk${i}`;
        try {
          // Check if the disk path exists and is mounted
          const stats = await fs.stat(diskPath);
          if (stats.isDirectory()) {
            // Verify it's actually mounted by checking if it's accessible
            const baseService = new PoolsService();
            const isMounted = await baseService._isMounted(diskPath);
            if (isMounted) {
              return `disk${i}`;
            }
          }
        } catch (err) {
          // Disk doesn't exist or isn't accessible, continue to next
          continue;
        }
      }

      return null;
    } catch (error) {
      console.warn(`Could not determine first available disk for MergerFS pool ${poolName}:`, error.message);
      return null;
    }
  }

  /**
   * Generates default paths for services based on the first available non-MergerFS pool
   * @param {string} poolName - The pool name to use for paths (can be 'poolname' or 'poolname/diskN' for MergerFS)
   * @returns {Object} Default paths for all services
   */
  _generateDefaultPaths(poolName) {
    if (!poolName) return {};

    // Check if this is a MergerFS disk path (contains '/')
    let basePath;
    if (poolName.includes('/')) {
      // MergerFS disk path: poolname/diskN -> /var/mergerfs/poolname/diskN
      basePath = `/var/mergerfs/${poolName}`;
    } else {
      // Regular pool: poolname -> /mnt/poolname
      basePath = `/mnt/${poolName}`;
    }

    return {
      docker: {
        directory: `${basePath}/system/docker`,
        appdata: `${basePath}/appdata`
      },
      lxc: {
        directory: `${basePath}/system/lxc`,
        backup_path: `${basePath}/backups/lxc`
      },
      vm: {
        directory: `${basePath}/system/vm`,
        vdisk_directory: `${basePath}/vms`
      }
    };
  }

  /**
   * Checks if a directory path is mounted on a pool
   * @param {string} dirPath - The directory path to check
   * @param {string} serviceType - The service type (docker, lxc, vm) for specific validations
   * @param {string} fieldName - The field name (directory, appdata, vdisk_directory) for specific validations
   * @returns {Promise<Object>} The result of the check
   */
  async _checkDirectoryMountStatus(dirPath, serviceType = null, fieldName = null) {
    try {
      // Normalize the path
      const normalizedPath = path.resolve(dirPath);

      // Check if the path is under /mnt/ (Pool-Mountpoints) or /var/mergerfs/ (MergerFS-Disks)
      const isMntPath = normalizedPath.startsWith('/mnt/');
      const isMergerfsDiskPath = normalizedPath.startsWith('/var/mergerfs/');

      if (!isMntPath && !isMergerfsDiskPath) {
        return {
          isOnPool: false,
          isValid: false,
          error: 'Services can only be configured on Pool-Mountpoints (/mnt/) or MergerFS disks (/var/mergerfs/)',
          suggestion: 'Use a path like /mnt/poolname/service-directory or /var/mergerfs/poolname/disk1/service-directory'
        };
      }

      // Check for remote mount paths (/mnt/remotes/server/share/...)
      // Remotes are not pools - only validate path format
      if (normalizedPath.startsWith('/mnt/remotes/')) {
        const remoteParts = normalizedPath.split('/');
        // Minimum: /mnt/remotes/server/share -> 5 parts
        if (remoteParts.length < 5) {
          return {
            isOnPool: false,
            isValid: false,
            error: 'Invalid remote path. Expected format: /mnt/remotes/server/share/...',
            suggestion: 'Use a path like /mnt/remotes/myserver/myshare/service-directory'
          };
        }
        return {
          isOnPool: false,
          isRemote: true,
          isValid: true,
          remotePath: normalizedPath,
          userPath: normalizedPath,
          message: `Remote mount path accepted: ${normalizedPath}`
        };
      }

      // Extract Pool name from the path
      const pathParts = normalizedPath.split('/');
      let poolName;
      let poolPath;
      let diskPath = null;

      if (isMergerfsDiskPath) {
        // /var/mergerfs/poolname/disk1/... -> poolname
        if (pathParts.length < 5) {
          return {
            isOnPool: false,
            isValid: false,
            error: 'Invalid MergerFS disk path. Expected format: /var/mergerfs/poolname/diskN/...'
          };
        }
        poolName = pathParts[3]; // /var/mergerfs/poolname/disk1
        diskPath = pathParts[4];  // disk1, disk2, etc.
        poolPath = `/var/mergerfs/${poolName}/${diskPath}`;
      } else {
        // /mnt/poolname/... -> poolname
        if (pathParts.length < 3) {
          return {
            isOnPool: false,
            isValid: false,
            error: 'Invalid Pool Path'
          };
        }
        poolName = pathParts[2];
        poolPath = `/mnt/${poolName}`;
      }

      // Read pools.json directly - lightweight check without PoolsService instantiation
      // Avoids: constructor side-effects (_initNonRaidMonitor), heavy listPools() pipeline
      // (smartctl on every device, df, btrfs filesystem show, etc.)
      let poolsData;
      try {
        const rawData = await fs.readFile('/boot/config/pools.json', 'utf8');
        poolsData = JSON.parse(rawData);
      } catch (readError) {
        if (readError.code === 'ENOENT') {
          poolsData = [];
        } else {
          throw readError;
        }
      }

      try {
        const pool = poolsData.find(p => p.name === poolName);

        if (!pool) {
          throw new Error(`Pool "${poolName}" not found`);
        }

        // Check if pool is mergerfs or nonraid and restrict only core service directories
        // BUT: Allow core directories on individual MergerFS disks (/var/mergerfs/...)
        // Only restrict when using the merged pool mount point (/mnt/poolname)
        const restrictedCombinations = [
          { serviceType: 'docker', fieldName: 'directory' },  // Docker core directory
          { serviceType: 'lxc', fieldName: 'directory' }      // LXC core directory
          // VM directories and Docker appdata are allowed on mergerfs
        ];

        const restrictedPoolTypes = ['mergerfs', 'nonraid'];
        const isRestricted = restrictedPoolTypes.includes(pool.type) &&
          isMntPath && // Only restrict /mnt/ paths, not /var/mergerfs/ disk paths
          restrictedCombinations.some(combo =>
            combo.serviceType === serviceType && combo.fieldName === fieldName
          );

        if (isRestricted) {
          const poolTypeLabel = pool.type === 'mergerfs' ? 'MergerFS' : 'NonRAID';
          return {
            isOnPool: true,
            isValid: false,
            poolName,
            poolPath,
            userPath: normalizedPath,
            poolType: pool.type,
            error: `${serviceType.toUpperCase()} core directories cannot be placed on ${poolTypeLabel} pool mount points. ${poolTypeLabel} pools are designed for data storage, not for system services.`,
            suggestion: pool.type === 'mergerfs'
              ? `Use a single or multi device BTRFS, XFS, or EXT4 pool, or use an individual MergerFS disk path like /var/mergerfs/${poolName}/disk1/...`
              : `Use a single or multi device BTRFS, XFS, or EXT4 pool instead.`
          };
        }

        // Check mount status directly via findmnt (no PoolsService needed)
        const checkMountPoint = isMergerfsDiskPath && diskPath
          ? `/var/mergerfs/${poolName}/${diskPath}`
          : `/mnt/${poolName}`;

        let isMounted = false;
        try {
          const { stdout } = await execPromise(`findmnt -n -o TARGET ${JSON.stringify(checkMountPoint)} 2>/dev/null || true`);
          isMounted = stdout.trim().length > 0;
        } catch (error) {
          isMounted = false;
        }

        if (!isMounted) {
          const errorMsg = isMergerfsDiskPath && diskPath
            ? `MergerFS disk "${diskPath}" in pool "${poolName}" is not mounted. Service directory would not be available.`
            : `Pool "${poolName}" is not mounted. Service directory would not be available.`;
          const suggestionMsg = isMergerfsDiskPath && diskPath
            ? `Mount the pool "${poolName}" first or choose a different disk.`
            : `Mount the pool "${poolName}" first or choose a different path.`;
          return {
            isOnPool: true,
            isValid: false,
            poolName,
            poolPath,
            userPath: normalizedPath,
            poolType: pool.type,
            error: errorMsg,
            suggestion: suggestionMsg
          };
        }

        return {
          isOnPool: true,
          isValid: true,
          poolName,
          poolPath,
          userPath: normalizedPath,
          poolType: pool.type,
          message: diskPath
            ? `Pool "${poolName}" disk "${diskPath}" (${pool.type}) is mounted - Path is available`
            : `Pool "${poolName}" (${pool.type}) is mounted - Path is available`
        };

      } catch (poolError) {
        if (poolError.message.includes('not found')) {
          // Pool not found in pools.json - check if there's a ZFS pool mounted at this path
          // This allows using externally managed ZFS pools that are not registered in pools.json
          const zfsCheck = await this._checkZfsMountedAt(poolPath);

          if (zfsCheck.isMounted) {
            // ZFS pool is mounted at this path - allow it
            return {
              isOnPool: true,
              isValid: true,
              poolName: zfsCheck.poolName,
              poolPath: zfsCheck.mountPoint,
              userPath: normalizedPath,
              poolType: 'zfs',
              message: `ZFS dataset "${zfsCheck.datasetName}" is mounted at ${zfsCheck.mountPoint} - Path is available (external ZFS pool)`
            };
          }

          return {
            isOnPool: true,
            isValid: false,
            poolName,
            poolPath,
            userPath: normalizedPath,
            error: `Pool "${poolName}" does not exist.`,
            suggestion: 'Create the pool first or choose a different path.'
          };
        }
        throw poolError;
      }

    } catch (error) {
      console.error('Error checking directory mount status:', error.message);
      return {
        isOnPool: false,
        isValid: false,
        error: `Error checking directory mount status: ${error.message}`
      };
    }
  }

  /**
   * Checks multiple directory paths at once
   * @param {Object} pathsToCheck - Object with paths {fieldName: path}
   * @param {string} serviceType - The service type (docker, lxc, vm) for specific validations
   * @returns {Promise<Object>} Summary of the check results
   */
  async _checkMultipleDirectories(pathsToCheck, serviceType = null) {
    const results = {};
    const errors = [];

    for (const [fieldName, dirPath] of Object.entries(pathsToCheck)) {
      if (!dirPath || typeof dirPath !== 'string') {
        continue; // Skip empty/invalid paths
      }

      const check = await this._checkDirectoryMountStatus(dirPath, serviceType, fieldName);
      results[fieldName] = check;

      if (!check.isValid) {
        errors.push({
          field: fieldName,
          path: dirPath,
          error: check.error,
          suggestion: check.suggestion
        });
      }
    }

    return {
      hasErrors: errors.length > 0,
      results,
      errors
    };
  }

  /**
   * Returns the default docker settings structure with all expected fields
   * @returns {Promise<Object>} Default docker settings
   */
  async _getDefaultDockerSettings() {
    const defaultPoolName = await this._getFirstNonMergerFSPool();
    const defaultPaths = defaultPoolName ? this._generateDefaultPaths(defaultPoolName) : null;

    return {
      enabled: false,
      directory: defaultPaths ? defaultPaths.docker.directory : null,
      appdata: defaultPaths ? defaultPaths.docker.appdata : null,
      docker_net: {
        mode: 'macvlan',
        config: []
      },
      filesystem: 'overlay2',
      start_wait: 0,
      docker_options: '',
      update_check: {
        enabled: false,
        update_check_schedule: '0 1 * * *',
        auto_update: {
          enabled: false,
          auto_update_schedule: '0 2 * * SAT'
        }
      }
    };
  }

  /**
   * Reads the Docker settings from the docker.json file.
   * Ensures all expected fields are present by merging with defaults.
   * @returns {Promise<Object>} The Docker settings as an object
   */
  async getDockerSettings() {
    try {
      const defaults = await this._getDefaultDockerSettings();

      let loadedSettings = {};
      try {
        const data = await fs.readFile(this.settingsPath, 'utf8');
        loadedSettings = JSON.parse(data);
      } catch (error) {
        if (error.code === 'ENOENT') {
          console.warn('docker.json not found, returning defaults');
          return defaults;
        }
        throw error;
      }

      // Merge loaded settings with defaults (loaded settings take precedence)
      const settings = this._deepMerge(defaults, loadedSettings);

      // Set default paths if values are still null
      if (settings.directory === null || settings.appdata === null) {
        const defaultPoolName = await this._getFirstNonMergerFSPool();
        if (defaultPoolName) {
          const defaultPaths = this._generateDefaultPaths(defaultPoolName);
          if (settings.directory === null) {
            settings.directory = defaultPaths.docker.directory;
          }
          if (settings.appdata === null) {
            settings.appdata = defaultPaths.docker.appdata;
          }
        }
      }

      return settings;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('docker.json not found');
      }
      throw new Error(`Error reading docker.json: ${error.message}`);
    }
  }

  /**
   * Writes new values to the docker.json. Only the passed fields are updated.
   * If enabled is changed, the Docker service is stopped/started.
   * @param {Object} updates - The fields to update
   * @returns {Promise<Object>} The updated settings
   */
  async updateDockerSettings(updates) {
    try {
      // Read current settings with defaults
      const defaults = await this._getDefaultDockerSettings();
      let current = { ...defaults };

      try {
        const data = await fs.readFile(this.settingsPath, 'utf8');
        const loadedSettings = JSON.parse(data);
        // Merge loaded settings with defaults
        current = this._deepMerge(defaults, loadedSettings);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      // Only allowed fields are updated
      const allowed = ['enabled', 'directory', 'appdata', 'docker_net', 'filesystem', 'start_wait', 'docker_options', 'update_check'];
      let updateCheckChanged = false;

      // Check directory paths for mount status
      // Always validate 'directory' to catch legacy nonraid/mergerfs paths
      // Use updates.directory if provided, otherwise fall back to current.directory
      // This ensures validation runs even when only 'enabled: true' is sent
      const pathsToCheck = {};
      const effectiveDirectory = updates.directory || current.directory;
      if (effectiveDirectory) {
        pathsToCheck.directory = effectiveDirectory;
      }
      if (updates.appdata && updates.appdata !== current.appdata) {
        pathsToCheck.appdata = updates.appdata;
      }

      if (Object.keys(pathsToCheck).length > 0) {
        const directoryCheck = await this._checkMultipleDirectories(pathsToCheck, 'docker');

        if (directoryCheck.hasErrors) {
          const errorDetails = directoryCheck.errors.map(error =>
            `${error.field}: ${error.error}${error.suggestion ? ' ' + error.suggestion : ''}`
          ).join('; ');
          throw new Error(`Docker directory conflict: ${errorDetails}`);
        }
      }

      for (const key of Object.keys(updates)) {
        if (!allowed.includes(key)) {
          throw new Error(`Invalid field: ${key}`);
        }
        if (key === 'docker_net') {
          // Docker-Netzwerk configuration handling
          if (!current.docker_net) current.docker_net = {};

          // Validation of docker_net structure
          if (typeof updates.docker_net === 'object') {
            // Mode validation
            if (updates.docker_net.mode !== undefined) {
              const validModes = ['macvlan', 'ipvlan'];
              if (!validModes.includes(updates.docker_net.mode)) {
                throw new Error(`Invalid docker_net mode: ${updates.docker_net.mode}. Valid modes: ${validModes.join(', ')}`);
              }
              current.docker_net.mode = updates.docker_net.mode;
            }

            // Config validation and adoption
            if (Array.isArray(updates.docker_net.config)) {
              // Validation of config entries
              for (const configEntry of updates.docker_net.config) {
                if (typeof configEntry !== 'object') {
                  throw new Error('docker_net.config entries must be objects');
                }
                // Subnet validation if present
                if (configEntry.subnet && !/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(configEntry.subnet)) {
                  throw new Error(`Invalid subnet format: ${configEntry.subnet}. Expected format: x.x.x.x/xx`);
                }
                // Gateway validation if present
                if (configEntry.gateway && !/^(\d{1,3}\.){3}\d{1,3}$/.test(configEntry.gateway)) {
                  throw new Error(`Invalid gateway format: ${configEntry.gateway}. Expected format: x.x.x.x`);
                }
              }
              current.docker_net.config = updates.docker_net.config;
            }
          }
        } else if (key === 'update_check') {
          // Intelligent update_check handling - only changed fields are overwritten
          if (!current.update_check) current.update_check = {};

          const currentUpdateCheck = JSON.parse(JSON.stringify(current.update_check)); // Deep copy for comparison

          // If only a boolean is sent, it is for enabled
          if (typeof updates.update_check === 'boolean') {
            if (current.update_check.enabled !== updates.update_check) {
              updateCheckChanged = true;
            }
            current.update_check.enabled = updates.update_check;
          } else if (typeof updates.update_check === 'object') {
            // Individual update_check properties are adopted
            if (updates.update_check.enabled !== undefined &&
                current.update_check.enabled !== updates.update_check.enabled) {
              updateCheckChanged = true;
            }
            if (updates.update_check.update_check_schedule !== undefined &&
                current.update_check.update_check_schedule !== updates.update_check.update_check_schedule) {
              updateCheckChanged = true;
            }

            // auto_update handling
            if (updates.update_check.auto_update) {
              if (!current.update_check.auto_update) current.update_check.auto_update = {};

              if (updates.update_check.auto_update.enabled !== undefined &&
                  current.update_check.auto_update.enabled !== updates.update_check.auto_update.enabled) {
                updateCheckChanged = true;
              }
              if (updates.update_check.auto_update.auto_update_schedule !== undefined &&
                  current.update_check.auto_update.auto_update_schedule !== updates.update_check.auto_update.auto_update_schedule) {
                updateCheckChanged = true;
              }

              // auto_update properties are adopted
              if (updates.update_check.auto_update.enabled !== undefined)
                current.update_check.auto_update.enabled = updates.update_check.auto_update.enabled;
              if (updates.update_check.auto_update.auto_update_schedule !== undefined)
                current.update_check.auto_update.auto_update_schedule = updates.update_check.auto_update.auto_update_schedule;
            }

            // Main properties are adopted
            if (updates.update_check.enabled !== undefined)
              current.update_check.enabled = updates.update_check.enabled;
            if (updates.update_check.update_check_schedule !== undefined)
              current.update_check.update_check_schedule = updates.update_check.update_check_schedule;
          }
        } else {
          current[key] = updates[key];
        }
      }

      // Write the file
      await fs.writeFile(this.settingsPath, JSON.stringify(current, null, 2), 'utf8');

      // Docker service stop/start on configuration changes
      try {
        // Docker always stop when configuration is changed
        // Ignore errors on stop (e.g. if service is already stopped)
        try {
          await execPromise('/etc/init.d/docker stop');
        } catch (stopError) {
          // Ignore stop errors (service could already be stopped)
        }

        // Docker start only if enabled = true (mos-start reads the new file)
        if (current.enabled === true) {
          await execPromise('/usr/local/bin/mos-start docker');
        }
      } catch (error) {
        throw new Error(`Error restarting docker service: ${error.message}`);
      }

      // mos-cron_update execute if update_check changed
      if (updateCheckChanged) {
        try {
          await execPromise('/usr/local/bin/mos-cron_update');
        } catch (error) {
          console.warn('Warning: mos-cron_update could not be executed:', error.message);
        }
      }

      return current;
    } catch (error) {
      throw new Error(`Error writing docker.json: ${error.message}`);
    }
  }

  /**
   * Returns the default LXC settings structure with all expected fields
   * @returns {Promise<Object>} Default LXC settings
   */
  async _getDefaultLxcSettings() {
    const defaultPoolName = await this._getFirstNonMergerFSPool();
    const defaultPaths = defaultPoolName ? this._generateDefaultPaths(defaultPoolName) : null;

    return {
      enabled: false,
      bridge: false,
      directory: defaultPaths ? defaultPaths.lxc.directory : null,
      backing_storage: 'directory',  // Options: 'directory', 'btrfs'
      start_wait: 0,
      lxc_registry: null,
      backup_path: defaultPaths ? defaultPaths.lxc.backup_path : null,
      backups_to_keep: 3,
      compression: 6,
      threads: 0,
      use_snapshot: false
    };
  }

  /**
   * Reads the LXC settings from the lxc.json file.
   * Ensures all expected fields are present by merging with defaults.
   * @returns {Promise<Object>} The LXC settings as an object
   */
  async getLxcSettings() {
    try {
      const defaults = await this._getDefaultLxcSettings();

      let loadedSettings = {};
      try {
        const data = await fs.readFile('/boot/config/lxc.json', 'utf8');
        loadedSettings = JSON.parse(data);
      } catch (error) {
        if (error.code === 'ENOENT') {
          console.warn('lxc.json not found, returning defaults');
          return defaults;
        }
        throw error;
      }

      // Merge loaded settings with defaults (loaded settings take precedence)
      const settings = this._deepMerge(defaults, loadedSettings);

      // Set default path if directory is still null
      if (settings.directory === null) {
        const defaultPoolName = await this._getFirstNonMergerFSPool();
        if (defaultPoolName) {
          const defaultPaths = this._generateDefaultPaths(defaultPoolName);
          settings.directory = defaultPaths.lxc.directory;
        }
      }

      return settings;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('lxc.json not found');
      }
      throw new Error(`Error reading lxc.json: ${error.message}`);
    }
  }

  /**
   * Writes new values to the lxc.json. Only the passed fields are changed.
   * If enabled is changed, the LXC service is stopped/started.
   * @param {Object} updates - The fields to update
   * @returns {Promise<Object>} The updated settings
   */
  async updateLxcSettings(updates) {
    try {
      // Read current settings with defaults
      const defaults = await this._getDefaultLxcSettings();
      let current = { ...defaults };

      try {
        const data = await fs.readFile('/boot/config/lxc.json', 'utf8');
        const loadedSettings = JSON.parse(data);
        // Merge loaded settings with defaults
        current = this._deepMerge(defaults, loadedSettings);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      // Only allowed fields are updated
      const allowed = ['enabled', 'bridge', 'directory', 'start_wait', 'lxc_registry', 'backup_path', 'backups_to_keep', 'compression', 'threads', 'use_snapshot', 'backing_storage'];

      // Validate lxc_registry if provided (must not contain protocol prefixes)
      if (updates.lxc_registry !== undefined && updates.lxc_registry !== null && updates.lxc_registry !== '') {
        const protocolPattern = /^(https?|ftp):\/\//i;
        if (protocolPattern.test(updates.lxc_registry)) {
          throw new Error('lxc_registry must not contain protocol prefixes (http://, https://, ftp://). Example: my.lxc.org');
        }
      }

      // Validate backup settings
      if (updates.backups_to_keep !== undefined) {
        const val = updates.backups_to_keep;
        if (!Number.isInteger(val) || val < 1 || val > 100) {
          throw new Error('backups_to_keep must be an integer between 1 and 100');
        }
      }

      if (updates.compression !== undefined) {
        const val = updates.compression;
        if (!Number.isInteger(val) || val < 0 || val > 9) {
          throw new Error('compression must be an integer between 0 and 9 (7-9 requires 12GB+ RAM)');
        }
      }

      if (updates.threads !== undefined) {
        const val = updates.threads;
        if (!Number.isInteger(val) || val < 0) {
          throw new Error('threads must be 0 (auto) or a positive integer');
        }
      }

      if (updates.use_snapshot !== undefined && typeof updates.use_snapshot !== 'boolean') {
        throw new Error('use_snapshot must be a boolean');
      }

      if (updates.backing_storage !== undefined) {
        const validBackingStorage = ['directory', 'btrfs'];
        if (!validBackingStorage.includes(updates.backing_storage)) {
          throw new Error('backing_storage must be either "directory" or "btrfs"');
        }
      }

      // Check directory paths for mount status
      // Always validate 'directory' to catch legacy nonraid/mergerfs paths
      // Use updates.directory if provided, otherwise fall back to current.directory
      // This ensures validation runs even when only 'enabled: true' is sent
      const pathsToCheck = {};
      const effectiveDirectory = updates.directory || current.directory;
      if (effectiveDirectory) {
        pathsToCheck.directory = effectiveDirectory;
      }
      if (updates.backup_path && updates.backup_path !== current.backup_path) {
        pathsToCheck.backup_path = updates.backup_path;
      }

      if (Object.keys(pathsToCheck).length > 0) {
        const directoryCheck = await this._checkMultipleDirectories(pathsToCheck, 'lxc');

        if (directoryCheck.hasErrors) {
          const errorDetails = directoryCheck.errors.map(error =>
            `${error.field}: ${error.error}${error.suggestion ? ' ' + error.suggestion : ''}`
          ).join('; ');
          throw new Error(`LXC directory conflict: ${errorDetails}`);
        }
      }

      // Track if we need to restart the service (only for enabled, directory, or bridge changes)
      const previousEnabled = current.enabled;
      const previousDirectory = current.directory;
      const previousBridge = current.bridge;
      const previousRegistry = current.lxc_registry;

      for (const key of Object.keys(updates)) {
        if (!allowed.includes(key)) {
          throw new Error(`Invalid field: ${key}`);
        }
        current[key] = updates[key];
      }

      // Write the file
      await fs.writeFile('/boot/config/lxc.json', JSON.stringify(current, null, 2), 'utf8');

      // Delete container index cache if lxc_registry changed
      const registryChanged = updates.lxc_registry !== undefined && updates.lxc_registry !== previousRegistry;
      if (registryChanged) {
        const indexPath = '/var/mos/lxc/container_index.json';
        try {
          await fs.unlink(indexPath);
        } catch (unlinkError) {
          // Ignore if file doesn't exist
          if (unlinkError.code !== 'ENOENT') {
            console.warn(`Warning: Could not delete container index: ${unlinkError.message}`);
          }
        }
      }

      // Only restart LXC service if enabled, directory, or bridge changed
      const enabledChanged = updates.enabled !== undefined && updates.enabled !== previousEnabled;
      const directoryChanged = updates.directory !== undefined && updates.directory !== previousDirectory;
      const bridgeChanged = updates.bridge !== undefined && updates.bridge !== previousBridge;

      if (enabledChanged || directoryChanged || bridgeChanged) {
        try {
          // Stop services first (ignore errors if already stopped)
          try {
            await exec('/etc/init.d/lxc stop');
          } catch (stopError) {
            // Ignore stop errors (service could already be stopped)
          }

          try {
            await exec('/etc/init.d/lxc-net stop');
          } catch (stopError) {
            // Ignore stop errors (service could already be stopped)
          }

          // Only start if enabled = true (mos-start reads the new file)
          if (current.enabled === true) {
            await execPromise('/usr/local/bin/mos-start lxc');
          }
        } catch (error) {
          throw new Error(`Error restarting lxc service: ${error.message}`);
        }
      }

      return current;
    } catch (error) {
      throw new Error(`Error writing lxc.json: ${error.message}`);
    }
  }

  /**
   * Checks if IOMMU is currently active on the system
   * @returns {Promise<boolean>} True if IOMMU is active
   */
  async _checkIommuActive() {
    try {
      // Check if /sys/class/iommu/ exists and has entries
      const iommuPath = '/sys/class/iommu';
      try {
        const entries = await fs.readdir(iommuPath);
        return entries.length > 0;
      } catch (error) {
        if (error.code === 'ENOENT') {
          return false;
        }
        throw error;
      }
    } catch (error) {
      console.error('Error checking IOMMU status:', error.message);
      return false;
    }
  }

  /**
   * Returns the default VM settings structure with all expected fields
   * @returns {Promise<Object>} Default VM settings
   */
  async _getDefaultVmSettings() {
    const defaultPoolName = await this._getFirstNonMergerFSPool();
    const defaultPaths = defaultPoolName ? this._generateDefaultPaths(defaultPoolName) : null;

    return {
      enabled: false,
      directory: defaultPaths ? defaultPaths.vm.directory : null,
      vdisk_directory: defaultPaths ? defaultPaths.vm.vdisk_directory : null,
      start_wait: 0
    };
  }

  /**
   * Reads the VM settings from the vm.json file.
   * Ensures all expected fields are present by merging with defaults.
   * @returns {Promise<Object>} The VM settings as an object
   */
  async getVmSettings() {
    try {
      const defaults = await this._getDefaultVmSettings();

      let loadedSettings = {};
      try {
        const data = await fs.readFile('/boot/config/vm.json', 'utf8');
        loadedSettings = JSON.parse(data);
      } catch (error) {
        if (error.code === 'ENOENT') {
          console.warn('vm.json not found, returning defaults');
          // Inject iommu_active (runtime-only, not saved to file)
          defaults.iommu_active = await this._checkIommuActive();
          return defaults;
        }
        throw error;
      }

      // Merge loaded settings with defaults (loaded settings take precedence)
      const settings = this._deepMerge(defaults, loadedSettings);

      // Set default paths if values are still null
      if (settings.directory === null || settings.vdisk_directory === null) {
        const defaultPoolName = await this._getFirstNonMergerFSPool();
        if (defaultPoolName) {
          const defaultPaths = this._generateDefaultPaths(defaultPoolName);
          if (settings.directory === null) {
            settings.directory = defaultPaths.vm.directory;
          }
          if (settings.vdisk_directory === null) {
            settings.vdisk_directory = defaultPaths.vm.vdisk_directory;
          }
        }
      }

      // Inject iommu_active (runtime-only, not saved to file)
      settings.iommu_active = await this._checkIommuActive();

      return settings;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('vm.json not found');
      }
      throw new Error(`Error reading vm.json: ${error.message}`);
    }
  }

  /**
   * Writes new values to the vm.json. Only the passed fields are changed.
   * If enabled is changed, the libvirtd service is stopped/started.
   * @param {Object} updates - The fields to update
   * @returns {Promise<Object>} The updated settings
   */
  async updateVmSettings(updates) {
    try {
      // Read current settings with defaults
      const defaults = await this._getDefaultVmSettings();
      let current = { ...defaults };

      try {
        const data = await fs.readFile('/boot/config/vm.json', 'utf8');
        const loadedSettings = JSON.parse(data);
        // Merge loaded settings with defaults
        current = this._deepMerge(defaults, loadedSettings);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      // Remove read-only fields that may come from GET response
      delete updates.iommu_active;

      // Only allowed fields are updated
      const allowed = ['enabled', 'directory', 'vdisk_directory', 'start_wait'];

      // Check directory paths for mount status
      // Always validate 'directory' to catch legacy nonraid/mergerfs paths
      // Use updates.directory if provided, otherwise fall back to current.directory
      // This ensures validation runs even when only 'enabled: true' is sent
      const pathsToCheck = {};
      const effectiveDirectory = updates.directory || current.directory;
      if (effectiveDirectory) {
        pathsToCheck.directory = effectiveDirectory;
      }
      if (updates.vdisk_directory && updates.vdisk_directory !== current.vdisk_directory) {
        pathsToCheck.vdisk_directory = updates.vdisk_directory;
      }

      if (Object.keys(pathsToCheck).length > 0) {
        const directoryCheck = await this._checkMultipleDirectories(pathsToCheck, 'vm');

        if (directoryCheck.hasErrors) {
          const errorDetails = directoryCheck.errors.map(error =>
            `${error.field}: ${error.error}${error.suggestion ? ' ' + error.suggestion : ''}`
          ).join('; ');
          throw new Error(`VM directory conflict: ${errorDetails}`);
        }
      }

      for (const key of Object.keys(updates)) {
        if (!allowed.includes(key)) {
          throw new Error(`Invalid field: ${key}`);
        }
        current[key] = updates[key];
      }

      // Write the file
      await fs.writeFile('/boot/config/vm.json', JSON.stringify(current, null, 2), 'utf8');

      // libvirtd service stop/start on configuration changes
      try {
        // VM services always stop when configuration is changed
        // Ignore errors on stop (e.g. if service is already stopped)
        try {
          await execPromise('/etc/init.d/libvirtd stop');
        } catch (stopError) {
          // Ignore stop errors (service could already be stopped)
        }

        try {
          await execPromise('/etc/init.d/virtlogd stop');
        } catch (stopError) {
          // Ignore stop errors (service could already be stopped)
        }

        // VM services only start if enabled = true (mos-start reads the new file)
        if (current.enabled === true) {
          await execPromise('/usr/local/bin/mos-start vm');
        }
      } catch (error) {
        throw new Error(`Error restarting vm service: ${error.message}`);
      }

      return current;
    } catch (error) {
      throw new Error(`Error writing vm.json: ${error.message}`);
    }
  }

  /**
   * Derives listen_interfaces from the current network interface config and
   * updates system.json + restarts nginx when the list changes.
   * Active IP-carrying interfaces: enabled ethernet (not bridged/bonded), bridges, bonds.
   * When eth0 becomes bridged → eth0 is removed, br0 is added. Reverse on bridge removal.
   * @param {Array} interfaces - The current interfaces array
   * @returns {Promise<void>}
   * @private
   */
  async _syncListenInterfaces(interfaces) {
    const sysDefaults = this._getDefaultSystemSettings();
    let sysSettings = { ...sysDefaults };
    try {
      const sysData = await fs.readFile('/boot/config/system.json', 'utf8');
      sysSettings = this._deepMerge(sysDefaults, JSON.parse(sysData));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }

    if (!sysSettings.webui) sysSettings.webui = { ports: { http: 80, https: 443 }, https_enabled: false, local_dns_searchname: '', listen_interfaces: ['eth0'] };
    if (!Array.isArray(sysSettings.webui.listen_interfaces)) sysSettings.webui.listen_interfaces = ['eth0'];

    // Empty list = nginx listens on all interfaces (default), nothing to do
    if (sysSettings.webui.listen_interfaces.length === 0) return;

    const activeListenIfaces = interfaces
      .filter(i => {
        if (i.status === 'disabled' || i.status === 'orphan') return false;
        if (i.type === 'bridged' || i.type === 'bonded') return false;
        return true;
      })
      .map(i => i.name);

    const oldList = JSON.stringify(sysSettings.webui.listen_interfaces);
    sysSettings.webui.listen_interfaces = activeListenIfaces;

    if (oldList !== JSON.stringify(sysSettings.webui.listen_interfaces)) {
      await fs.writeFile('/boot/config/system.json', JSON.stringify(sysSettings, null, 2), 'utf8');
      try {
        await execPromise('/etc/init.d/nginx restart');
      } catch (nginxErr) {
        console.warn('Warning: Could not restart nginx after listen_interfaces update:', nginxErr.message);
      }
    }
  }

  /**
   * Backs up the current network.json and system.json (listen_interfaces)
   * before applying changes. Stores the configs in memory for potential rollback.
   * @returns {Promise<void>}
   * @private
   */
  async _backupNetworkConfig() {
    try {
      const data = await fs.readFile('/boot/config/network.json', 'utf8');
      this._networkBackupConfig = data;
    } catch (error) {
      if (error.code === 'ENOENT') {
        this._networkBackupConfig = null;
      } else {
        throw new Error(`Error backing up network config: ${error.message}`);
      }
    }

    // Backup system.json for listen_interfaces rollback
    try {
      const sysData = await fs.readFile('/boot/config/system.json', 'utf8');
      this._systemJsonBackup = sysData;
    } catch (error) {
      if (error.code === 'ENOENT') {
        this._systemJsonBackup = null;
      }
    }
  }

  /**
   * Starts the pending changes timer after a network change.
   * If not confirmed within the timeout, the previous config is restored.
   * @returns {void}
   * @private
   */
  _startNetworkRollbackTimer() {
    // Clear any existing timer
    if (this._networkRollbackTimer) {
      clearTimeout(this._networkRollbackTimer);
    }

    this._networkPendingChanges = true;
    this._networkPendingTimestamp = Date.now();

    this._networkRollbackTimer = setTimeout(async () => {
      console.warn('Network changes not confirmed within timeout — rolling back');
      try {
        await this._rollbackNetworkConfig();
      } catch (error) {
        console.error('Network rollback failed:', error.message);
      }
    }, this._networkRollbackTimeout);
  }

  /**
   * Rolls back the network config to the backup and restarts networking.
   * Called automatically when the confirm timeout expires.
   * @returns {Promise<void>}
   * @private
   */
  async _rollbackNetworkConfig() {
    try {
      if (this._networkBackupConfig !== null) {
        await fs.writeFile('/boot/config/network.json', this._networkBackupConfig, 'utf8');
      } else {
        // Backup was null (file didn't exist before) — remove file
        try {
          await fs.unlink('/boot/config/network.json');
        } catch { /* ignore if already gone */ }
      }

      // Restore system.json (listen_interfaces) if we have a backup
      let needNginxRestart = false;
      if (this._systemJsonBackup !== null && this._systemJsonBackup !== undefined) {
        await fs.writeFile('/boot/config/system.json', this._systemJsonBackup, 'utf8');
        // Only restart nginx if the backed-up listen_interfaces was non-empty
        try {
          const backedUp = JSON.parse(this._systemJsonBackup);
          if (Array.isArray(backedUp?.webui?.listen_interfaces) && backedUp.webui.listen_interfaces.length > 0) {
            needNginxRestart = true;
          }
        } catch { /* parse error — skip nginx restart */ }
      }

      // Restart networking to apply restored config
      await execPromise('/etc/init.d/networking restart');

      // Restart nginx to restore previous listen_interfaces (only if non-empty)
      if (needNginxRestart) {
        try {
          await execPromise('/etc/init.d/nginx restart');
        } catch (nginxErr) {
          console.warn('Warning: Could not restart nginx during rollback:', nginxErr.message);
        }
      }
    } catch (error) {
      console.error('Error during network rollback:', error.message);
    } finally {
      this._networkPendingChanges = false;
      this._networkRollbackTimer = null;
      this._networkBackupConfig = null;
      this._systemJsonBackup = null;
      this._networkPendingTimestamp = null;
    }
  }

  /**
   * Confirms pending network changes, cancelling the rollback timer.
   * Must be called within the timeout window after a network change.
   * @returns {Object} { confirmed: true }
   * @throws {Error} If no pending changes exist
   */
  async confirmNetworkChanges() {
    if (!this._networkPendingChanges) {
      throw new Error('No pending network changes to confirm');
    }

    // Cancel the rollback timer
    if (this._networkRollbackTimer) {
      clearTimeout(this._networkRollbackTimer);
    }

    this._networkPendingChanges = false;
    this._networkRollbackTimer = null;
    this._networkBackupConfig = null;
    this._systemJsonBackup = null;
    this._networkPendingTimestamp = null;

    return { confirmed: true };
  }

  /**
   * Reverts pending network changes immediately (user-triggered rollback).
   * @returns {Promise<Object>} { reverted: true }
   * @throws {Error} If no pending changes exist
   */
  async revertNetworkChanges() {
    if (!this._networkPendingChanges) {
      throw new Error('No pending network changes to revert');
    }

    // Cancel the auto-rollback timer (we'll rollback manually now)
    if (this._networkRollbackTimer) {
      clearTimeout(this._networkRollbackTimer);
    }

    await this._rollbackNetworkConfig();
    return { reverted: true };
  }

  /**
   * Returns the current pending network changes state.
   * @returns {Object} { pending_changes: boolean, remaining_seconds: number|null }
   */
  getNetworkPendingState() {
    if (!this._networkPendingChanges || !this._networkPendingTimestamp) {
      return { pending_changes: false, remaining_seconds: null };
    }

    const elapsed = Date.now() - this._networkPendingTimestamp;
    const remaining = Math.max(0, Math.ceil((this._networkRollbackTimeout - elapsed) / 1000));

    return { pending_changes: true, remaining_seconds: remaining };
  }

  /**
   * Returns the default network settings structure with all expected fields
   * @returns {Object} Default network settings
   */
  _getDefaultNetworkSettings() {
    return {
      interfaces: [
        {
          mac: null,
          name: 'eth0',
          label: null,
          type: 'ethernet',
          mode: null,
          interfaces: [],
          ipv4: [{ dhcp: true }],
          ipv6: [],
          vlans: [],
          mtu: null,
          hw_addr: null,
          status: 'enabled'
        }
      ],
      services: {
        ssh: { enabled: true },
        samba: { enabled: false, workgroup: 'WORKGROUP' },
        samba_discovery: { enabled: false },
        nfs: { enabled: false },
        remote_mounting: { enabled: false },
        nut: { enabled: false },
        iscsi_target: { enabled: false },
        iscsi_initiator: { enabled: false },
        tailscale: {
          enabled: false,
          update_check: false,
          tailscaled_params: ''
        },
        netbird: {
          enabled: false,
          update_check: false,
          netbird_service_params: ''
        },
        dnsmasq: { enabled: false }
      }
    };
  }

  /**
   * Deep merges two objects, with source values taking precedence
   * @param {Object} target - Target object (defaults)
   * @param {Object} source - Source object (loaded settings)
   * @returns {Object} Merged object
   */
  _deepMerge(target, source) {
    const result = { ...target };

    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        // Recursive merge for nested objects
        result[key] = this._deepMerge(result[key] || {}, source[key]);
      } else {
        // Direct assignment for primitives and arrays
        result[key] = source[key];
      }
    }

    return result;
  }

  /**
   * Migrates legacy network service settings to new format:
   * - Converts 'nmbd' to 'samba_discovery'
   * - Adds 'workgroup' to 'samba' if missing
   * @param {Object} settings - Network settings object
   * @returns {Object} Migrated settings
   * @private
   */
  _migrateNetworkServices(settings) {
    if (!settings || !settings.services) {
      return settings;
    }

    const services = settings.services;

    // Migrate nmbd to samba_discovery
    if (services.nmbd !== undefined && services.samba_discovery === undefined) {
      services.samba_discovery = { enabled: services.nmbd.enabled || false };
      delete services.nmbd;
    }

    // Ensure samba has workgroup
    if (services.samba) {
      if (services.samba.workgroup === undefined) {
        services.samba.workgroup = 'WORKGROUP';
      }
    }

    return settings;
  }

  /**
   * Migrates legacy network interface settings to new format:
   * - Adds 'mac', 'mtu', 'hw_addr', 'status' fields if missing
   * - Adds 'mtu' to VLAN entries if missing
   * @param {Object} settings - Network settings object
   * @returns {Object} Migrated settings
   * @private
   */
  _migrateNetworkInterfaces(settings) {
    if (!settings || !Array.isArray(settings.interfaces)) {
      return settings;
    }

    for (const iface of settings.interfaces) {
      if (iface.mac === undefined) iface.mac = null;
      if (iface.label === undefined) iface.label = null;
      if (iface.mtu === undefined) iface.mtu = null;
      if (iface.hw_addr === undefined) iface.hw_addr = null;
      if (iface.status === undefined) iface.status = 'enabled';
      if (!Array.isArray(iface.vlans)) iface.vlans = [];
      if (iface.type === 'bridge') {
        if (iface.vlan_filtering === undefined) iface.vlan_filtering = false;
        if (!Array.isArray(iface.bridge_vids)) iface.bridge_vids = [];
      }

      // Migrate VLAN entries
      for (const vlan of iface.vlans) {
        if (vlan.mtu === undefined) vlan.mtu = null;
      }
    }

    return settings;
  }

  /**
   * Validates a CIDR value for IPv4 (must be integer 0–32).
   * Strips leading '/' if present (e.g., "/24" → 24).
   * @param {*} cidr - CIDR value to validate
   * @returns {number} Validated CIDR as integer
   * @throws {Error} If CIDR is not a valid number between 0 and 32
   * @private
   */
  _validateCidr(cidr) {
    let value = cidr;
    if (typeof value === 'string') {
      value = value.replace(/^\//, '');
    }
    const parsed = parseInt(value, 10);
    if (isNaN(parsed) || parsed < 0 || parsed > 32) {
      throw new Error(`Invalid CIDR value '${cidr}': must be a number between 0 and 32`);
    }
    return parsed;
  }

  /**
   * Strips CIDR notation from IPv4 addresses and exposes it as a separate field.
   * E.g., "192.168.0.5/24" → { address: "192.168.0.5", cidr: 24, ... }
   * If no CIDR is present in the address, defaults cidr to 24.
   * @param {Array} ipv4Array - Array of IPv4 config objects
   * @returns {Array} Transformed array with cidr field
   * @private
   */
  _stripCidrFromIpv4(ipv4Array) {
    if (!Array.isArray(ipv4Array)) return ipv4Array;
    return ipv4Array.map(entry => {
      if (!entry.address) return entry;
      const result = { ...entry };
      if (result.address.includes('/')) {
        const [ip, cidrStr] = result.address.split('/');
        result.address = ip;
        result.cidr = this._validateCidr(cidrStr);
      } else {
        result.cidr = 24;
      }
      return result;
    });
  }

  /**
   * Appends CIDR notation to IPv4 addresses before saving to file.
   * Uses the provided cidr field, or defaults to /24 if not specified.
   * E.g., { address: "192.168.0.5", cidr: 16 } → { address: "192.168.0.5/16", ... }
   * The cidr field is removed from the object after merging.
   * @param {Array} ipv4Array - Array of IPv4 config objects
   * @returns {Array} Transformed array with CIDR in address
   * @private
   */
  _appendCidrToIpv4(ipv4Array) {
    if (!Array.isArray(ipv4Array)) return ipv4Array;
    return ipv4Array.map(entry => {
      if (!entry.address) return entry;
      const result = { ...entry };
      // Don't double-append if already has CIDR
      if (!result.address.includes('/')) {
        const cidr = result.cidr !== undefined && result.cidr !== null
          ? this._validateCidr(result.cidr)
          : 24;
        result.address = `${result.address}/${cidr}`;
      }
      delete result.cidr;
      return result;
    });
  }

  /**
   * Reads the Network-Settings from the network.json file.
   * Ensures all expected fields are present by merging with defaults.
   * @returns {Promise<Object>} The Network-Settings as an object
   */
  async getNetworkSettings() {
    try {
      const defaults = this._getDefaultNetworkSettings();

      let loadedSettings = {};
      try {
        const data = await fs.readFile('/boot/config/network.json', 'utf8');
        loadedSettings = JSON.parse(data);
      } catch (error) {
        if (error.code === 'ENOENT') {
          // If file doesn't exist, return defaults
          console.warn('network.json not found, returning defaults');
          return defaults;
        }
        throw error;
      }

      // Merge loaded settings with defaults (loaded settings take precedence)
      const settings = this._deepMerge(defaults, loadedSettings);

      // Apply migration for legacy settings (nmbd -> samba_discovery, add workgroup)
      const migratedServices = this._migrateNetworkServices(settings);

      // Apply migration for legacy interface settings (add mac, mtu, hw_addr, status)
      return this._migrateNetworkInterfaces(migratedServices);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('network.json not found');
      }
      throw new Error(`Error reading network.json: ${error.message}`);
    }
  }

  /**
   * Reads the network interfaces from the network.json file and enriches them
   * with live hardware info (link_state, speed, driver) from the system.
   * Hardware info is NOT written to the config file.
   * @returns {Promise<Object>} { interfaces: Array, pending_changes: boolean, remaining_seconds: number|null }
   */
  async getNetworkInterfaces() {
    try {
      // Reconcile first — ensures config reflects current hardware state
      // (new NICs added, orphans marked, kernel names updated)
      try {
        await this.reconcileInterfaces();
      } catch { /* ignore reconciliation errors — proceed with existing config */ }

      const settings = await this.getNetworkSettings();
      const interfaces = settings.interfaces || [];

      // Detect current hardware state
      let detected = [];
      try {
        detected = await this.detectPhysicalInterfaces();
      } catch { /* ignore detection errors — return config without hw info */ }

      // Build MAC → hardware info lookup
      const hwByMac = new Map();
      const hwByName = new Map();
      for (const hw of detected) {
        hwByMac.set(hw.mac.toLowerCase(), hw);
        hwByName.set(hw.name, hw);
      }

      // Merge live info into each interface (without modifying config)
      const enriched = interfaces.map(iface => {
        const result = { ...iface };

        // Strip CIDR from IPv4 addresses and expose as separate field
        if (result.ipv4) {
          result.ipv4 = this._stripCidrFromIpv4(result.ipv4);
        }
        if (Array.isArray(result.vlans)) {
          result.vlans = result.vlans.map(vlan => ({
            ...vlan,
            ipv4: this._stripCidrFromIpv4(vlan.ipv4)
          }));
        }

        // Match by MAC first, then by name
        const hw = (iface.mac && hwByMac.get(iface.mac.toLowerCase())) ||
                   hwByName.get(iface.name);

        if (hw) {
          result.link_state = hw.link_state;
          result.speed = hw.speed;
          result.adapter = hw.adapter;
        } else {
          result.link_state = null;
          result.speed = null;
          result.adapter = null;
        }

        return result;
      });

      // Include pending changes state
      const pendingState = this.getNetworkPendingState();

      return {
        interfaces: enriched,
        pending_changes: pendingState.pending_changes,
        remaining_seconds: pendingState.remaining_seconds
      };
    } catch (error) {
      throw new Error(`Error reading network interfaces: ${error.message}`);
    }
  }

  /**
   * Checks if Tailscale is online via CLI.
   * @returns {Promise<boolean>} true if connected, false on any error
   */
  async _getTailscaleOnline() {
    try {
      const { stdout } = await execPromise('tailscale status --json');
      const status = JSON.parse(stdout);
      return status?.Self?.Online === true;
    } catch {
      return false;
    }
  }

  /**
   * Checks if Netbird is online via CLI.
   * @returns {Promise<boolean>} true if management is connected, false on any error
   */
  async _getNetbirdOnline() {
    try {
      const { stdout } = await execPromise('netbird status --json');
      const status = JSON.parse(stdout);
      return status?.management?.connected === true;
    } catch {
      return false;
    }
  }

  /**
   * Reads only the network services from the network.json file.
   * Injects runtime 'online' status for tailscale and netbird if enabled.
   * @returns {Promise<Object>} Network services object
   */
  async getNetworkServices() {
    try {
      const settings = await this.getNetworkSettings();
      const services = settings.services || {};

      // Inject runtime online status for VPN services (not persisted)
      const checks = [];
      if (services.tailscale) {
        if (services.tailscale.enabled) {
          checks.push(this._getTailscaleOnline().then(online => { services.tailscale.online = online; }));
        } else {
          services.tailscale.online = false;
        }
      }
      if (services.netbird) {
        if (services.netbird.enabled) {
          checks.push(this._getNetbirdOnline().then(online => { services.netbird.online = online; }));
        } else {
          services.netbird.online = false;
        }
      }
      if (checks.length) await Promise.all(checks);

      return services;
    } catch (error) {
      throw new Error(`Error reading network services: ${error.message}`);
    }
  }

  /**
   * Detects all physical network interfaces present in the system.
   * Reads from /sys/class/net and filters out virtual interfaces.
   * @returns {Promise<Array>} Array of detected interfaces: [{ name, mac, link_state, speed }]
   */
  async detectPhysicalInterfaces() {
    try {
      const VIRTUAL_PREFIXES = ['lo', 'veth', 'docker', 'br-', 'virbr', 'tailscale', 'wt', 'bond', 'dummy', 'tunl', 'sit', 'vxlan', 'flannel', 'cni', 'lxc'];
      const netDir = '/sys/class/net';
      const entries = await fs.readdir(netDir);
      const interfaces = [];

      for (const name of entries) {
        // Skip virtual interface prefixes
        if (VIRTUAL_PREFIXES.some(prefix => name.startsWith(prefix))) {
          continue;
        }

        try {
          // Check if this is a physical device (has /device symlink)
          const devicePath = path.join(netDir, name, 'device');
          try {
            await fs.access(devicePath);
          } catch {
            // No /device symlink means it's virtual (e.g., bridges, bonds)
            // Exception: some embedded NICs may not have /device, check type
            const typePath = path.join(netDir, name, 'type');
            try {
              const typeVal = (await fs.readFile(typePath, 'utf8')).trim();
              // type 1 = Ethernet, anything else is likely virtual
              if (typeVal !== '1') continue;
            } catch {
              continue;
            }
          }

          const macPath = path.join(netDir, name, 'address');
          const mac = (await fs.readFile(macPath, 'utf8')).trim();

          // Skip interfaces with no MAC or all-zero MAC
          if (!mac || mac === '00:00:00:00:00:00') continue;

          let linkState = 'unknown';
          try {
            linkState = (await fs.readFile(path.join(netDir, name, 'operstate'), 'utf8')).trim();
          } catch { /* ignore */ }

          let speed = null;
          try {
            const speedVal = (await fs.readFile(path.join(netDir, name, 'speed'), 'utf8')).trim();
            const parsed = parseInt(speedVal, 10);
            if (!isNaN(parsed) && parsed > 0) speed = parsed;
          } catch { /* ignore - speed not available when link is down */ }

          let adapter = null;
          try {
            // Read PCI slot from device symlink (e.g. ../../../0000:01:00.0)
            const deviceRealPath = await fs.readlink(path.join(netDir, name, 'device'));
            const pciSlot = path.basename(deviceRealPath);
            // Use lspci to get human-readable device name
            const { stdout } = await execPromise(`lspci -s ${pciSlot}`);
            if (stdout && stdout.trim()) {
              // Output: "01:00.0 Ethernet controller: Intel Corporation I225-V (rev 03)"
              const match = stdout.trim().match(/:\s+(.+)$/);
              if (match) {
                adapter = match[1].replace(/\s*\(rev [0-9a-f]+\)\s*$/i, '').trim();
              }
            }
          } catch { /* ignore - lspci or device info not available */ }

          interfaces.push({ name, mac, link_state: linkState, speed, adapter });
        } catch {
          // Skip interfaces that can't be read
          continue;
        }
      }

      // Sort by name for stable ordering
      interfaces.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

      return interfaces;
    } catch (error) {
      throw new Error(`Error detecting physical interfaces: ${error.message}`);
    }
  }

  /**
   * Reconciles detected physical interfaces with the stored network.json config.
   * - MAC found in config → update kernel name if changed
   * - MAC not in config → add new interface with DHCP (status: active)
   * - MAC in config but not in system → set status: orphan
   * - Legacy entries (no mac field) → assign MAC based on current kernel name
   * @returns {Promise<Object>} { interfaces, changes } where changes describes what was modified
   */
  async reconcileInterfaces() {
    try {
      const detected = await this.detectPhysicalInterfaces();

      // Read current settings
      const defaults = this._getDefaultNetworkSettings();
      let current = { ...defaults };

      try {
        const data = await fs.readFile('/boot/config/network.json', 'utf8');
        const loadedSettings = JSON.parse(data);
        current = this._deepMerge(defaults, loadedSettings);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      // Apply migration first
      current = this._migrateNetworkInterfaces(current);

      const changes = [];
      const detectedMacs = new Map(detected.map(d => [d.mac.toLowerCase(), d]));
      const configuredMacs = new Set();

      // Pass 1: Handle legacy entries (no mac field) — assign MAC by kernel name
      for (const iface of current.interfaces) {
        if (!iface.mac && iface.type !== 'bridge' && iface.type !== 'bond') {
          const detectedByName = detected.find(d => d.name === iface.name);
          if (detectedByName) {
            iface.mac = detectedByName.mac.toLowerCase();
            changes.push({ type: 'mac_assigned', name: iface.name, mac: iface.mac });
          }
        }
      }

      // Pass 2: Match configured interfaces against detected
      for (const iface of current.interfaces) {
        // Skip virtual types (bridges, bonds) — they don't have physical MACs
        if (iface.type === 'bridge' || iface.type === 'bond') {
          continue;
        }

        if (iface.mac) {
          const macLower = iface.mac.toLowerCase();
          configuredMacs.add(macLower);
          const detectedIface = detectedMacs.get(macLower);

          if (detectedIface) {
            // MAC found in system — update kernel name if changed
            if (iface.name !== detectedIface.name) {
              changes.push({ type: 'name_updated', mac: macLower, old_name: iface.name, new_name: detectedIface.name });
              iface.name = detectedIface.name;
            }
            // Ensure status is active
            if (iface.status === 'orphan') {
              iface.status = 'enabled';
              changes.push({ type: 'reactivated', name: iface.name, mac: macLower });
            }
          } else {
            // MAC not in system — mark as orphan
            if (iface.status !== 'orphan' && iface.status !== 'disabled') {
              iface.status = 'orphan';
              changes.push({ type: 'orphaned', name: iface.name, mac: macLower });
            }
          }
        }
      }

      // Pass 3: Add newly detected interfaces that are not in config
      for (const [mac, detectedIface] of detectedMacs) {
        if (!configuredMacs.has(mac)) {
          const newIface = {
            mac: mac,
            name: detectedIface.name,
            label: null,
            type: 'ethernet',
            mode: null,
            interfaces: [],
            ipv4: [{ dhcp: true }],
            ipv6: [],
            vlans: [],
            mtu: null,
            hw_addr: null,
            status: 'enabled'
          };
          current.interfaces.push(newIface);
          changes.push({ type: 'new_interface', name: detectedIface.name, mac: mac });
        }
      }

      // Write back if changes were made
      if (changes.length > 0) {
        await fs.writeFile('/boot/config/network.json', JSON.stringify(current, null, 2), 'utf8');
      }

      return { interfaces: current.interfaces, changes };
    } catch (error) {
      throw new Error(`Error reconciling interfaces: ${error.message}`);
    }
  }

  /**
   * Validates a MAC address format (xx:xx:xx:xx:xx:xx)
   * @param {string} mac - MAC address to validate
   * @returns {boolean} True if valid
   * @private
   */
  _isValidMac(mac) {
    return /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(mac);
  }

  /**
   * Updates only the network interfaces in the network.json file.
   * Supports multi-interface setups with bridge, bond, VLANs, MTU, and MAC spoofing.
   * @param {Array} interfaces - Array of network interfaces
   * @returns {Promise<Array>} The updated interfaces array
   */
  async updateNetworkInterfaces(interfaces) {
    try {
      if (!Array.isArray(interfaces)) {
        throw new Error('interfaces must be an array');
      }

      // Validate: each interface must have a name
      for (const iface of interfaces) {
        if (!iface.name || typeof iface.name !== 'string') {
          throw new Error('Each interface must have a name');
        }
      }

      // Read current settings
      const defaults = this._getDefaultNetworkSettings();
      let current = { ...defaults };

      try {
        const data = await fs.readFile('/boot/config/network.json', 'utf8');
        const loadedSettings = JSON.parse(data);
        current = this._deepMerge(defaults, loadedSettings);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      // Track interface changes
      let interfacesChanged = false;
      let primaryInterfaceChanged = false;
      let oldPrimaryInterface = this._determinePrimaryInterface(current.interfaces || []);

      // Merge posted interfaces with current config (by MAC, fallback by name)
      // Interfaces in the POST body update their matching entry
      // Interfaces NOT in the POST body are preserved as-is
      const merged = [];
      const matchedIndices = new Set();

      for (const posted of interfaces) {
        const postedMac = posted.mac ? posted.mac.toLowerCase() : null;
        let matchIdx = -1;

        // Match by MAC first
        if (postedMac) {
          matchIdx = current.interfaces.findIndex(c => c.mac && c.mac.toLowerCase() === postedMac);
        }

        // Fallback: match by name
        if (matchIdx === -1) {
          matchIdx = current.interfaces.findIndex((c, idx) => !matchedIndices.has(idx) && c.name === posted.name);
        }

        if (matchIdx !== -1) {
          matchedIndices.add(matchIdx);
        }
        merged.push(posted);
      }

      // Preserve interfaces that were not in the POST body
      // Exception: orphan interfaces not in POST body are removed (user chose to discard them)
      for (let i = 0; i < current.interfaces.length; i++) {
        if (!matchedIndices.has(i)) {
          if (current.interfaces[i].status === 'orphan') {
            interfacesChanged = true;
            continue;
          }
          merged.push(current.interfaces[i]);
        }
      }

      // Check if anything has changed
      if (JSON.stringify(current.interfaces) !== JSON.stringify(merged)) {
        interfacesChanged = true;
      }

      current.interfaces = merged;

      // Collect all bridged interfaces and existing bridges
      const bridgedIfaces = interfaces.filter(i => i.type === 'bridged');
      const bridgeIfaces = interfaces.filter(i => i.type === 'bridge');
      const bridgeNames = new Set(bridgeIfaces.map(i => i.name));

      // Auto-create bridge for each bridged interface that has no matching bridge
      for (const bridgedIface of bridgedIfaces) {
        // Find a bridge that references this interface
        const hasMatchingBridge = bridgeIfaces.some(br =>
          Array.isArray(br.interfaces) && br.interfaces.includes(bridgedIface.name)
        );

        if (!hasMatchingBridge) {
          // Determine bridge name: br0, br1, ...
          let brIdx = 0;
          while (bridgeNames.has(`br${brIdx}`)) brIdx++;
          const brName = `br${brIdx}`;
          bridgeNames.add(brName);

          const brInterface = {
            mac: null,
            name: brName,
            label: null,
            type: 'bridge',
            mode: null,
            interfaces: [bridgedIface.name],
            ipv4: bridgedIface.ipv4 && bridgedIface.ipv4.length > 0 ? bridgedIface.ipv4 : [{ dhcp: true }],
            ipv6: [],
            vlans: [],
            mtu: bridgedIface.mtu || null,
            hw_addr: null,
            status: 'enabled',
            vlan_filtering: false,
            bridge_vids: []
          };

          // Reset bridged interface (no IP configuration)
          bridgedIface.ipv4 = [];
          bridgedIface.ipv6 = [];

          current.interfaces.push(brInterface);
          interfacesChanged = true;
        }
      }

      // Bridge removal: if an interface was bridged and is now ethernet, remove orphan bridges
      for (const iface of current.interfaces) {
        if (iface.type === 'ethernet') {
          // Find bridges that only reference this interface
          const orphanBridges = current.interfaces.filter(br =>
            br.type === 'bridge' &&
            Array.isArray(br.interfaces) &&
            br.interfaces.length === 1 &&
            br.interfaces[0] === iface.name
          );

          for (const orphanBr of orphanBridges) {
            // If this interface has no IP config, transfer from bridge
            if ((!iface.ipv4 || iface.ipv4.length === 0) && orphanBr.ipv4 && orphanBr.ipv4.length > 0) {
              iface.ipv4 = orphanBr.ipv4;
            }
            // Remove orphan bridge
            current.interfaces = current.interfaces.filter(i => i.name !== orphanBr.name);
            interfacesChanged = true;
          }
        }
      }

      // Validate: every bonded interface must be referenced by an active bond
      for (const iface of current.interfaces) {
        if (iface.type === 'bonded') {
          const parentBond = current.interfaces.find(b =>
            b.type === 'bond' && Array.isArray(b.interfaces) && b.interfaces.includes(iface.name)
          );
          if (!parentBond) {
            throw new Error(`Interface ${iface.name}: type 'bonded' but no bond references it. Create a bond with this interface first.`);
          }
        }
        if (iface.type === 'bridged') {
          const parentBridge = current.interfaces.find(b =>
            b.type === 'bridge' && Array.isArray(b.interfaces) && b.interfaces.includes(iface.name)
          );
          if (!parentBridge) {
            throw new Error(`Interface ${iface.name}: type 'bridged' but no bridge references it.`);
          }
        }
      }

      // Validation
      const validTypes = ['ethernet', 'bridged', 'bridge', 'bond', 'bonded'];
      const validStatuses = ['enabled', 'disabled', 'orphan'];
      const validBondModes = ['balance-rr', 'active-backup', 'balance-xor', 'broadcast', '802.3ad', 'balance-tlb', 'balance-alb'];

      for (const iface of current.interfaces) {
        // Type validation
        if (iface.type && !validTypes.includes(iface.type)) {
          throw new Error(`Interface ${iface.name}: invalid type '${iface.type}'. Valid: ${validTypes.join(', ')}`);
        }

        // Status validation
        if (iface.status && !validStatuses.includes(iface.status)) {
          throw new Error(`Interface ${iface.name}: invalid status '${iface.status}'. Valid: ${validStatuses.join(', ')}`);
        }

        // MAC validation
        if (iface.mac && !this._isValidMac(iface.mac)) {
          throw new Error(`Interface ${iface.name}: invalid mac format '${iface.mac}'`);
        }

        // hw_addr validation (MAC spoofing)
        if (iface.hw_addr && !this._isValidMac(iface.hw_addr)) {
          throw new Error(`Interface ${iface.name}: invalid hw_addr format '${iface.hw_addr}'`);
        }

        // MTU validation
        if (iface.mtu !== null && iface.mtu !== undefined) {
          const mtu = parseInt(iface.mtu, 10);
          if (isNaN(mtu) || mtu < 68 || mtu > 9000) {
            throw new Error(`Interface ${iface.name}: mtu must be between 68 and 9000`);
          }
          iface.mtu = mtu;
        }

        // Bond validation
        if (iface.type === 'bond') {
          if (iface.mode && !validBondModes.includes(iface.mode)) {
            throw new Error(`Interface ${iface.name}: invalid bond mode '${iface.mode}'. Valid: ${validBondModes.join(', ')}`);
          }
          if (!Array.isArray(iface.interfaces) || iface.interfaces.length < 1) {
            throw new Error(`Interface ${iface.name}: bond requires at least one slave interface`);
          }
        }

        // Bridge validation
        if (iface.type === 'bridge') {
          if (!Array.isArray(iface.interfaces) || iface.interfaces.length < 1) {
            throw new Error(`Interface ${iface.name}: bridge requires at least one member interface`);
          }
          if (iface.vlan_filtering === undefined) iface.vlan_filtering = false;
          if (!Array.isArray(iface.bridge_vids)) iface.bridge_vids = [];

          // Validate bridge_vids entries
          for (let v = 0; v < iface.bridge_vids.length; v++) {
            const vid = parseInt(iface.bridge_vids[v], 10);
            if (isNaN(vid) || vid < 1 || vid > 4094) {
              throw new Error(`Interface ${iface.name}: bridge_vids must contain VLAN IDs between 1 and 4094`);
            }
            iface.bridge_vids[v] = vid;
          }
        } else {
          delete iface.vlan_filtering;
          delete iface.bridge_vids;
        }

        // Static IP validation (skip bridged/bonded — they don't need IP config)
        if (iface.type !== 'bridged' && iface.type !== 'bonded') {
          if (iface.ipv4 && Array.isArray(iface.ipv4)) {
            for (const ipv4Config of iface.ipv4) {
              if (ipv4Config.dhcp === false && !ipv4Config.address) {
                throw new Error(`Interface ${iface.name}: address is required when dhcp=false`);
              }
            }
          }
        }

        // VLAN MTU validation
        if (Array.isArray(iface.vlans)) {
          for (const vlan of iface.vlans) {
            if (vlan.mtu !== null && vlan.mtu !== undefined) {
              const vlanMtu = parseInt(vlan.mtu, 10);
              if (isNaN(vlanMtu) || vlanMtu < 68 || vlanMtu > 9000) {
                throw new Error(`Interface ${iface.name} VLAN ${vlan.vlan_id}: mtu must be between 68 and 9000`);
              }
              vlan.mtu = vlanMtu;
            }
          }
        }

        // Prevent disabling member interfaces that are referenced by an active bridge or bond
        if (iface.status === 'disabled' && (iface.type === 'bridged' || iface.type === 'bonded')) {
          const parent = current.interfaces.find(p =>
            (p.type === 'bridge' || p.type === 'bond') &&
            Array.isArray(p.interfaces) && p.interfaces.includes(iface.name) &&
            p.status !== 'disabled'
          );
          if (parent) {
            throw new Error(`Interface ${iface.name}: cannot disable — it is a member of ${parent.type} '${parent.name}'. Disable '${parent.name}' first.`);
          }
        }

        // Strip read-only hardware fields (never persist to config)
        delete iface.link_state;
        delete iface.speed;
        delete iface.adapter;

        // Ensure new fields have defaults
        if (iface.mac === undefined) iface.mac = null;
        if (iface.label === undefined) iface.label = null;
        if (iface.mtu === undefined) iface.mtu = null;
        if (iface.hw_addr === undefined) iface.hw_addr = null;
        if (iface.status === undefined) iface.status = 'enabled';
        if (!Array.isArray(iface.vlans)) iface.vlans = [];

        // Append CIDR to IPv4 addresses for file storage
        if (iface.ipv4 && Array.isArray(iface.ipv4)) {
          iface.ipv4 = this._appendCidrToIpv4(iface.ipv4);
        }
        if (Array.isArray(iface.vlans)) {
          for (const vlan of iface.vlans) {
            if (vlan.ipv4 && Array.isArray(vlan.ipv4)) {
              vlan.ipv4 = this._appendCidrToIpv4(vlan.ipv4);
            }
          }
        }
      }

      // Check if primary interface has changed
      const newPrimaryInterface = this._determinePrimaryInterface(current.interfaces || []);
      if (oldPrimaryInterface !== newPrimaryInterface) {
        primaryInterfaceChanged = true;
      }

      // Backup current config before writing (for rollback)
      if (interfacesChanged) {
        await this._backupNetworkConfig();
      }

      // Write updated settings
      await fs.writeFile('/boot/config/network.json', JSON.stringify(current, null, 2), 'utf8');

      // Update LXC default.conf if interfaces or primary interface have changed
      if (interfacesChanged || primaryInterfaceChanged) {
        await this._updateLxcDefaultConf(newPrimaryInterface, current.interfaces);
      }

      // Networking restart if interfaces have changed
      if (interfacesChanged) {
        await execPromise('/etc/init.d/networking restart');
        this._startNetworkRollbackTimer();
      }

      // Auto-update webui listen_interfaces based on active IP-carrying interfaces
      if (interfacesChanged) {
        try {
          await this._syncListenInterfaces(current.interfaces);
        } catch (listenErr) {
          console.warn('Warning: Could not update webui listen_interfaces:', listenErr.message);
        }
      }

      return current.interfaces;
    } catch (error) {
      throw new Error(`Error updating network interfaces: ${error.message}`);
    }
  }

  /**
   * Adds a VLAN to a network interface.
   * @param {string} interfaceName - Name of the interface (e.g., 'eth0')
   * @param {Object} vlanConfig - VLAN configuration object
   * @param {number} vlanConfig.vlan_id - VLAN ID (1-4094)
   * @param {Array} [vlanConfig.ipv4] - IPv4 configuration array
   * @param {Array} [vlanConfig.ipv6] - IPv6 configuration array
   * @returns {Promise<Object>} The created VLAN configuration
   */
  async addVlan(interfaceName, vlanConfig) {
    try {
      if (!interfaceName || typeof interfaceName !== 'string') {
        throw new Error('interfaceName must be a string');
      }

      if (!vlanConfig || typeof vlanConfig !== 'object') {
        throw new Error('vlanConfig must be an object');
      }

      const vlanId = parseInt(vlanConfig.vlan_id, 10);
      if (isNaN(vlanId) || vlanId < 1 || vlanId > 4094) {
        throw new Error('vlan_id must be a number between 1 and 4094');
      }

      // Read current settings
      const defaults = this._getDefaultNetworkSettings();
      let current = { ...defaults };

      try {
        const data = await fs.readFile('/boot/config/network.json', 'utf8');
        const loadedSettings = JSON.parse(data);
        current = this._deepMerge(defaults, loadedSettings);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      // Find the interface
      const iface = current.interfaces.find(i => i.name === interfaceName);
      if (!iface) {
        throw new Error(`Interface '${interfaceName}' not found`);
      }

      // Ensure vlans array exists
      if (!Array.isArray(iface.vlans)) {
        iface.vlans = [];
      }

      // Check if VLAN already exists
      if (iface.vlans.some(v => v.vlan_id === vlanId)) {
        throw new Error(`VLAN ${vlanId} already exists on interface '${interfaceName}'`);
      }

      // Validate and parse MTU
      let vlanMtu = null;
      if (vlanConfig.mtu !== null && vlanConfig.mtu !== undefined) {
        vlanMtu = parseInt(vlanConfig.mtu, 10);
        if (isNaN(vlanMtu) || vlanMtu < 68 || vlanMtu > 9000) {
          throw new Error(`VLAN ${vlanId}: mtu must be between 68 and 9000`);
        }
      }

      // Create VLAN config with defaults
      const newVlan = {
        vlan_id: vlanId,
        ipv4: Array.isArray(vlanConfig.ipv4) ? vlanConfig.ipv4 : [{ dhcp: true }],
        ipv6: Array.isArray(vlanConfig.ipv6) ? vlanConfig.ipv6 : [],
        mtu: vlanMtu
      };

      // Validate IPv4 configuration
      for (const ipv4Config of newVlan.ipv4) {
        if (ipv4Config.dhcp === false && !ipv4Config.address) {
          throw new Error(`VLAN ${vlanId}: address is required when dhcp=false`);
        }
      }

      // Append CIDR to IPv4 addresses for file storage
      newVlan.ipv4 = this._appendCidrToIpv4(newVlan.ipv4);

      // Add VLAN to interface
      iface.vlans.push(newVlan);

      // Backup current config before writing (for rollback)
      await this._backupNetworkConfig();

      // Write updated settings
      await fs.writeFile('/boot/config/network.json', JSON.stringify(current, null, 2), 'utf8');

      // Restart networking
      await execPromise('/etc/init.d/networking restart');
      this._startNetworkRollbackTimer();

      return newVlan;
    } catch (error) {
      throw new Error(`Error adding VLAN: ${error.message}`);
    }
  }

  /**
   * Deletes a VLAN from a network interface.
   * @param {string} interfaceName - Name of the interface (e.g., 'eth0')
   * @param {number} vlanId - VLAN ID to delete
   * @returns {Promise<boolean>} True if VLAN was deleted
   */
  async deleteVlan(interfaceName, vlanId) {
    try {
      if (!interfaceName || typeof interfaceName !== 'string') {
        throw new Error('interfaceName must be a string');
      }

      const parsedVlanId = parseInt(vlanId, 10);
      if (isNaN(parsedVlanId) || parsedVlanId < 1 || parsedVlanId > 4094) {
        throw new Error('vlanId must be a number between 1 and 4094');
      }

      // Read current settings
      const defaults = this._getDefaultNetworkSettings();
      let current = { ...defaults };

      try {
        const data = await fs.readFile('/boot/config/network.json', 'utf8');
        const loadedSettings = JSON.parse(data);
        current = this._deepMerge(defaults, loadedSettings);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      // Find the interface
      const iface = current.interfaces.find(i => i.name === interfaceName);
      if (!iface) {
        throw new Error(`Interface '${interfaceName}' not found`);
      }

      // Check if vlans array exists
      if (!Array.isArray(iface.vlans) || iface.vlans.length === 0) {
        throw new Error(`No VLANs configured on interface '${interfaceName}'`);
      }

      // Find and remove VLAN
      const vlanIndex = iface.vlans.findIndex(v => v.vlan_id === parsedVlanId);
      if (vlanIndex === -1) {
        throw new Error(`VLAN ${parsedVlanId} not found on interface '${interfaceName}'`);
      }

      iface.vlans.splice(vlanIndex, 1);

      // Backup current config before writing (for rollback)
      await this._backupNetworkConfig();

      // Write updated settings
      await fs.writeFile('/boot/config/network.json', JSON.stringify(current, null, 2), 'utf8');

      // Restart networking
      await execPromise('/etc/init.d/networking restart');
      this._startNetworkRollbackTimer();

      return true;
    } catch (error) {
      throw new Error(`Error deleting VLAN: ${error.message}`);
    }
  }

  /**
   * Updates only the network services in the network.json file.
   * @param {Object} services - Network services object
   * @returns {Promise<Object>} The updated services object
   */
  async updateNetworkServices(services) {
    try {
      if (!services || typeof services !== 'object') {
        throw new Error('services must be an object');
      }

      // Read current settings
      const defaults = this._getDefaultNetworkSettings();
      let current = { ...defaults };

      try {
        const data = await fs.readFile('/boot/config/network.json', 'utf8');
        const loadedSettings = JSON.parse(data);
        current = this._deepMerge(defaults, loadedSettings);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      // Track service changes
      let sambaChanged = false, sambaValue = null;
      let nfsChanged = false, nfsValue = null;
      let nutChanged = false, nutValue = null;
      let sshChanged = false, sshValue = null;
      let sambaDiscoveryChanged = false, sambaDiscoveryValue = null;
      let tailscaleChanged = false, tailscaleValue = null;
      let netbirdChanged = false, netbirdValue = null;
      let remoteMountingChanged = false, remoteMountingValue = null;
      let dnsmasqChanged = false, dnsmasqValue = null;

      // Handle remote_mounting setting
      if (services.remote_mounting && typeof services.remote_mounting === 'object') {
        if (!current.services) current.services = {};
        if (!current.services.remote_mounting) current.services.remote_mounting = {};
        if (typeof services.remote_mounting.enabled === 'boolean') {
          if (current.services.remote_mounting.enabled !== services.remote_mounting.enabled) {
            remoteMountingChanged = true;
            remoteMountingValue = services.remote_mounting.enabled;
          }
          current.services.remote_mounting.enabled = services.remote_mounting.enabled;
        }
      }

      // Handle samba service
      if (services.samba) {
        if (!current.services) current.services = {};
        if (!current.services.samba) current.services.samba = {};
        if (typeof services.samba.enabled === 'boolean') {
          if (current.services.samba.enabled !== services.samba.enabled) {
            sambaChanged = true;
            sambaValue = services.samba.enabled;
          }
          current.services.samba.enabled = services.samba.enabled;
        }
        // Handle workgroup
        if (services.samba.workgroup !== undefined) {
          current.services.samba.workgroup = services.samba.workgroup;
        }
      }

      // Handle nfs service
      if (services.nfs && typeof services.nfs.enabled === 'boolean') {
        if (!current.services) current.services = {};
        if (!current.services.nfs) current.services.nfs = {};
        if (current.services.nfs.enabled !== services.nfs.enabled) {
          nfsChanged = true;
          nfsValue = services.nfs.enabled;
        }
        current.services.nfs.enabled = services.nfs.enabled;
      }

      // Handle nut service
      if (services.nut && typeof services.nut.enabled === 'boolean') {
        if (!current.services) current.services = {};
        if (!current.services.nut) current.services.nut = {};
        if (current.services.nut.enabled !== services.nut.enabled) {
          nutChanged = true;
          nutValue = services.nut.enabled;
        }
        current.services.nut.enabled = services.nut.enabled;
      }

      // Handle ssh service
      if (services.ssh && typeof services.ssh.enabled === 'boolean') {
        if (!current.services) current.services = {};
        if (!current.services.ssh) current.services.ssh = {};
        if (current.services.ssh.enabled !== services.ssh.enabled) {
          sshChanged = true;
          sshValue = services.ssh.enabled;
        }
        current.services.ssh.enabled = services.ssh.enabled;
      }

      // Handle samba_discovery service (also accept legacy 'nmbd' key)
      const sambaDiscoveryInput = services.samba_discovery || services.nmbd;
      if (sambaDiscoveryInput && typeof sambaDiscoveryInput.enabled === 'boolean') {
        if (!current.services) current.services = {};
        if (!current.services.samba_discovery) current.services.samba_discovery = {};
        if (current.services.samba_discovery.enabled !== sambaDiscoveryInput.enabled) {
          sambaDiscoveryChanged = true;
          sambaDiscoveryValue = sambaDiscoveryInput.enabled;
        }
        current.services.samba_discovery.enabled = sambaDiscoveryInput.enabled;
        // Remove legacy nmbd key if present
        if (current.services.nmbd) {
          delete current.services.nmbd;
        }
      }

      // Handle tailscale service
      if (services.tailscale) {
        if (!current.services) current.services = {};
        if (!current.services.tailscale) current.services.tailscale = {};
        if (typeof services.tailscale.enabled === 'boolean' &&
            current.services.tailscale.enabled !== services.tailscale.enabled) {
          tailscaleChanged = true;
          tailscaleValue = services.tailscale.enabled;
        }
        if (services.tailscale.enabled !== undefined)
          current.services.tailscale.enabled = services.tailscale.enabled;
        if (services.tailscale.update_check !== undefined)
          current.services.tailscale.update_check = services.tailscale.update_check;
        if (services.tailscale.tailscaled_params !== undefined)
          current.services.tailscale.tailscaled_params = services.tailscale.tailscaled_params;
      }

      // Handle netbird service
      if (services.netbird) {
        if (!current.services) current.services = {};
        if (!current.services.netbird) current.services.netbird = {};
        if (typeof services.netbird.enabled === 'boolean' &&
            current.services.netbird.enabled !== services.netbird.enabled) {
          netbirdChanged = true;
          netbirdValue = services.netbird.enabled;
        }
        if (services.netbird.enabled !== undefined)
          current.services.netbird.enabled = services.netbird.enabled;
        if (services.netbird.update_check !== undefined)
          current.services.netbird.update_check = services.netbird.update_check;
        if (services.netbird.netbird_service_params !== undefined)
          current.services.netbird.netbird_service_params = services.netbird.netbird_service_params;
      }

      // Handle dnsmasq service
      if (services.dnsmasq && typeof services.dnsmasq.enabled === 'boolean') {
        if (!current.services) current.services = {};
        if (!current.services.dnsmasq) current.services.dnsmasq = {};
        if (current.services.dnsmasq.enabled !== services.dnsmasq.enabled) {
          dnsmasqChanged = true;
          dnsmasqValue = services.dnsmasq.enabled;
        }
        current.services.dnsmasq.enabled = services.dnsmasq.enabled;
      }

      // Write updated settings
      await fs.writeFile('/boot/config/network.json', JSON.stringify(current, null, 2), 'utf8');

      // Handle remote mounting changes
      if (remoteMountingChanged && !remoteMountingValue) {
        // If remote mounting is disabled, unmount all remotes
        try {
          const RemotesService = require('./remotes.service');
          const remotesService = new RemotesService();
          await remotesService.unmountAllRemotes();
          console.log('All remotes unmounted due to remote_mounting being disabled');
        } catch (error) {
          console.warn('Failed to unmount remotes when disabling remote_mounting:', error.message);
        }
      }

      // Services stop/start
      if (sambaChanged) {
        if (sambaValue === false) {
          await execPromise('/etc/init.d/smbd stop');
        } else if (sambaValue === true) {
          await execPromise('/etc/init.d/smbd start');
        }
      }
      if (nfsChanged) {
        if (nfsValue === false) {
          await execPromise('/etc/init.d/nfs-kernel-server stop');
        } else if (nfsValue === true) {
          await execPromise('/etc/init.d/nfs-kernel-server start');
        }
      }
      if (nutChanged) {
        if (nutValue === false) {
          await execPromise('/etc/init.d/nut-client stop');
          await execPromise('/etc/init.d/nut-server stop');
        } else if (nutValue === true) {
          await execPromise('/etc/init.d/nut-client start');
          await execPromise('/etc/init.d/nut-server start');
        }
      }
      if (sshChanged) {
        if (sshValue === false) {
          await execPromise('/etc/init.d/ssh stop');
        } else if (sshValue === true) {
          await execPromise('/etc/init.d/ssh start');
        }
      }
      if (sambaDiscoveryChanged) {
        if (sambaDiscoveryValue === false) {
          await execPromise('/etc/init.d/nmbd stop');
          await execPromise('/etc/init.d/wsddn stop');
        } else if (sambaDiscoveryValue === true) {
          await execPromise('/etc/init.d/nmbd start');
          await execPromise('/etc/init.d/wsddn start');
        }
      }
      if (tailscaleChanged) {
        if (tailscaleValue === false) {
          await execPromise('/etc/init.d/tailscaled stop');
        } else if (tailscaleValue === true) {
          await execPromise('/etc/init.d/tailscaled start');
        }
      }
      if (netbirdChanged) {
        if (netbirdValue === false) {
          await execPromise('/etc/init.d/netbird stop');
        } else if (netbirdValue === true) {
          await execPromise('/etc/init.d/netbird start');
        }
      }
      if (dnsmasqChanged) {
        if (dnsmasqValue === false) {
          await execPromise('/etc/init.d/dnsmasq stop');
        } else if (dnsmasqValue === true) {
          await execPromise('/etc/init.d/dnsmasq start');
        }
      }

      return current.services;
    } catch (error) {
      throw new Error(`Error updating network services: ${error.message}`);
    }
  }

  /**
   * Get available CPU governors from the system
   * @returns {Promise<Array>} Array of available governors
   */
  async getAvailableGovernors() {
    try {
      // Try to read from cpufreq system file first
      try {
        const data = await fs.readFile('/sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors', 'utf8');
        const governors = data.trim().split(/\s+/).filter(gov => gov.length > 0);
        return governors;
      } catch (sysError) {
        // Fallback: try cpufreq-info if available
        try {
          const { stdout } = await execPromise('cpufreq-info --governors 2>/dev/null');
          const governors = stdout.trim().split(/\s+/).filter(gov => gov.length > 0);
          if (governors.length > 0) {
            return governors;
          }
        } catch (cpufreqError) {
          // Ignore cpufreq-info errors
        }

        // If both methods fail, return common default governors
        console.warn('Could not read available governors, returning defaults');
        return ['ondemand', 'performance', 'powersave', 'conservative'];
      }
    } catch (error) {
      throw new Error(`Fehler beim Abrufen der verfügbaren Governors: ${error.message}`);
    }
  }

  /**
   * Returns the default system settings structure with all expected fields
   * @returns {Object} Default system settings
   */
  _getDefaultSystemSettings() {
    return {
      hostname: 'MOS',
      global_spindown: 0,
      keymap: 'us',
      timezone: 'America/New_York',
      display: {
        timeout: 30,
        powersave: 'on',
        powerdown: 60
      },
      persist_history: false,
      ntp: {
        enabled: true,
        server: 'pool.ntp.org'
      },
      notification_sound: {
        startup: true,
        reboot: true,
        shutdown: true
      },
      cpufreq: {
        governor: 'ondemand',
        max_speed: 0,
        min_speed: 0
      },
      swapfile: swapService.getDefaultConfig(),
      binfmt: {
        enabled: false,
        architectures: []
      },
      webui: {
        ports: {
          http: 80,
          https: 443
        },
        https_enabled: true,
        local_dns_searchname: 'local',
        listen_interfaces: []
      },
      update_check: {
        enabled: false,
        update_check_schedule: '15 9 * * *'
      }
    };
  }

  // Swapfile management is handled by swap.service.js

  /**
   * Reads the system settings from the system.json file.
   * Ensures all expected fields are present by merging with defaults.
   * @returns {Promise<Object>} The system settings as an object
   */
  async getSystemSettings() {
    try {
      const defaults = this._getDefaultSystemSettings();

      let loadedSettings = {};
      try {
        const data = await fs.readFile('/boot/config/system.json', 'utf8');
        loadedSettings = JSON.parse(data);
      } catch (error) {
        if (error.code === 'ENOENT') {
          console.warn('system.json not found, returning defaults');
          return defaults;
        }
        throw error;
      }

      // Merge loaded settings with defaults (loaded settings take precedence)
      const settings = this._deepMerge(defaults, loadedSettings);

      return settings;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('system.json nicht gefunden');
      }
      throw new Error(`Fehler beim Lesen der system.json: ${error.message}`);
    }
  }

  /**
   * Writes new values to the system.json. Only hostname and global_spindown are accepted.
   * @param {Object} updates - The fields to update
   * @returns {Promise<Object>} The updated settings
   */
  async updateSystemSettings(updates) {
    try {
      // Read current settings with defaults
      const defaults = this._getDefaultSystemSettings();
      let current = { ...defaults };

      try {
        const data = await fs.readFile('/boot/config/system.json', 'utf8');
        const loadedSettings = JSON.parse(data);
        // Merge loaded settings with defaults
        current = this._deepMerge(defaults, loadedSettings);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      // Only allowed fields are updated
      const allowed = ['hostname', 'global_spindown', 'keymap', 'timezone', 'display', 'persist_history', 'ntp', 'notification_sound', 'cpufreq', 'swapfile', 'binfmt', 'webui', 'update_check'];
      let ntpChanged = false;
      let swapfileUpdate = null;
      let keymapChanged = false;
      let timezoneChanged = false;
      let hostnameChanged = false;
      let newHostname = null;
      let displayChanged = false;
      let persistHistoryChanged = false;
      let persistHistoryValue = null;
      let cpufreqChanged = false;
      let binfmtChanged = false;
      let webuiChanged = false;
      let localDnsSearchnameChanged = false;
      let updateCheckChanged = false;

      for (const key of Object.keys(updates)) {
        if (!allowed.includes(key)) {
          throw new Error(`Ungültiges Feld: ${key}`);
        }

        if (key === 'ntp') {
          // Update NTP settings
          if (!current.ntp) current.ntp = {};

          // Check if enabled has changed
          if (updates.ntp.enabled !== undefined && updates.ntp.enabled !== current.ntp.enabled) {
            ntpChanged = true;
          }

          // Check if other NTP settings have changed and service is active
          if (current.ntp.enabled === true && (
            (updates.ntp.mode !== undefined && updates.ntp.mode !== current.ntp.mode) ||
            (Array.isArray(updates.ntp.servers) && JSON.stringify(updates.ntp.servers) !== JSON.stringify(current.ntp.servers))
          )) {
            ntpChanged = true;
          }

          // Update NTP settings
          if (updates.ntp.enabled !== undefined) current.ntp.enabled = updates.ntp.enabled;
          if (updates.ntp.mode !== undefined) current.ntp.mode = updates.ntp.mode;
          if (Array.isArray(updates.ntp.servers)) current.ntp.servers = updates.ntp.servers;
        } else if (key === 'keymap') {
          if (updates.keymap !== current.keymap) {
            keymapChanged = true;
          }
          current[key] = updates[key];
        } else if (key === 'timezone') {
          if (updates.timezone !== current.timezone) {
            timezoneChanged = true;
          }
          current[key] = updates[key];
        } else if (key === 'persist_history') {
          if (updates.persist_history !== current.persist_history && updates.persist_history === true) {
            persistHistoryChanged = true;
            persistHistoryValue = true;
          }
          current[key] = updates[key];
        } else if (key === 'display') {
          // Initialize display with defaults if not present
          if (!current.display) {
            current.display = {
              timeout: 30,
              powersave: 'on',
              powerdown: 60
            };
          }

          // Update display settings
          if (typeof updates.display === 'object' && updates.display !== null) {
            // Check if any display setting changed
            if (updates.display.timeout !== undefined && updates.display.timeout !== current.display.timeout) {
              displayChanged = true;
            }
            if (updates.display.powersave !== undefined && updates.display.powersave !== current.display.powersave) {
              displayChanged = true;
            }
            if (updates.display.powerdown !== undefined && updates.display.powerdown !== current.display.powerdown) {
              displayChanged = true;
            }

            // Merge with existing settings, keeping defaults for missing values
            current.display = {
              timeout: updates.display.timeout !== undefined ? updates.display.timeout : current.display.timeout,
              powersave: updates.display.powersave !== undefined ? updates.display.powersave : current.display.powersave,
              powerdown: updates.display.powerdown !== undefined ? updates.display.powerdown : current.display.powerdown
            };
          }
        } else if (key === 'notification_sound') {
          // Initialize notification_sound with defaults if not present
          if (!current.notification_sound) {
            current.notification_sound = {
              startup: true,
              reboot: true,
              shutdown: true
            };
          }

          // Update notification_sound settings
          if (typeof updates.notification_sound === 'object' && updates.notification_sound !== null) {
            // Merge with existing settings, keeping defaults for missing values
            current.notification_sound = {
              startup: updates.notification_sound.startup !== undefined ? updates.notification_sound.startup : current.notification_sound.startup,
              reboot: updates.notification_sound.reboot !== undefined ? updates.notification_sound.reboot : current.notification_sound.reboot,
              shutdown: updates.notification_sound.shutdown !== undefined ? updates.notification_sound.shutdown : current.notification_sound.shutdown
            };
          }
        } else if (key === 'cpufreq') {
          // Initialize cpufreq with defaults if not present
          if (!current.cpufreq) {
            current.cpufreq = {
              governor: 'ondemand',
              max_speed: 0,
              min_speed: 0
            };
          }

          // Update cpufreq settings
          if (typeof updates.cpufreq === 'object' && updates.cpufreq !== null) {
            // Check if any cpufreq setting changed
            if (updates.cpufreq.governor !== undefined && updates.cpufreq.governor !== current.cpufreq.governor) {
              cpufreqChanged = true;
            }
            if (updates.cpufreq.max_speed !== undefined && updates.cpufreq.max_speed !== current.cpufreq.max_speed) {
              cpufreqChanged = true;
            }
            if (updates.cpufreq.min_speed !== undefined && updates.cpufreq.min_speed !== current.cpufreq.min_speed) {
              cpufreqChanged = true;
            }

            // Merge with existing settings, keeping defaults for missing values
            current.cpufreq = {
              governor: updates.cpufreq.governor !== undefined ? updates.cpufreq.governor : current.cpufreq.governor,
              max_speed: updates.cpufreq.max_speed !== undefined ? updates.cpufreq.max_speed : current.cpufreq.max_speed,
              min_speed: updates.cpufreq.min_speed !== undefined ? updates.cpufreq.min_speed : current.cpufreq.min_speed
            };
          }
        } else if (key === 'swapfile') {
          // Mark swapfile for update - will be processed after file is written
          if (typeof updates.swapfile === 'object' && updates.swapfile !== null) {
            swapfileUpdate = updates.swapfile;
          }
        } else if (key === 'binfmt') {
          // Initialize binfmt with defaults if not present
          if (!current.binfmt) {
            current.binfmt = {
              enabled: false,
              architectures: []
            };
          }

          // Update binfmt settings
          if (typeof updates.binfmt === 'object' && updates.binfmt !== null) {
            // Check if enabled changed from false to true
            if (updates.binfmt.enabled === true && current.binfmt.enabled === false) {
              binfmtChanged = true;
            }
            // Check if architectures changed while enabled
            if (Array.isArray(updates.binfmt.architectures) &&
                JSON.stringify(updates.binfmt.architectures) !== JSON.stringify(current.binfmt.architectures) &&
                (updates.binfmt.enabled === true || current.binfmt.enabled === true)) {
              binfmtChanged = true;
            }

            current.binfmt = {
              enabled: updates.binfmt.enabled !== undefined ? updates.binfmt.enabled : current.binfmt.enabled,
              architectures: Array.isArray(updates.binfmt.architectures) ? updates.binfmt.architectures : current.binfmt.architectures
            };
          }
        } else if (key === 'webui') {
          // Initialize webui with defaults if not present
          if (!current.webui) {
            current.webui = {
              ports: {
                http: 80,
                https: 443
              },
              https_enabled: true,
              local_dns_searchname: '',
              listen_interfaces: [
                'eth0'
              ]
            };
          }
          if (!current.webui.ports) {
            current.webui.ports = { http: 80, https: 443 };
          }
          if (current.webui.https_enabled === undefined) {
            current.webui.https_enabled = false;
          }
          if (current.webui.local_dns_searchname === undefined) {
            current.webui.local_dns_searchname = '';
          }
          if (!Array.isArray(current.webui.listen_interfaces)) {
            current.webui.listen_interfaces = [];
          }

          // Update webui settings
          if (typeof updates.webui === 'object' && updates.webui !== null) {
            if (typeof updates.webui.ports === 'object' && updates.webui.ports !== null) {
              // Check if http port changed
              if (updates.webui.ports.http !== undefined && updates.webui.ports.http !== current.webui.ports.http) {
                webuiChanged = true;
              }
              // Check if https port changed
              if (updates.webui.ports.https !== undefined && updates.webui.ports.https !== current.webui.ports.https) {
                webuiChanged = true;
              }

              current.webui.ports = {
                http: updates.webui.ports.http !== undefined ? updates.webui.ports.http : current.webui.ports.http,
                https: updates.webui.ports.https !== undefined ? updates.webui.ports.https : current.webui.ports.https
              };
            }

            // Check if https_enabled changed
            if (updates.webui.https_enabled !== undefined && updates.webui.https_enabled !== current.webui.https_enabled) {
              webuiChanged = true;
            }
            if (updates.webui.https_enabled !== undefined) {
              current.webui.https_enabled = updates.webui.https_enabled;
            }

            // Check if local_dns_searchname changed
            if (updates.webui.local_dns_searchname !== undefined && updates.webui.local_dns_searchname !== current.webui.local_dns_searchname) {
              localDnsSearchnameChanged = true;
            }
            if (updates.webui.local_dns_searchname !== undefined) {
              current.webui.local_dns_searchname = updates.webui.local_dns_searchname;
            }

            // Check if listen_interfaces changed
            if (Array.isArray(updates.webui.listen_interfaces)) {
              if (JSON.stringify(updates.webui.listen_interfaces) !== JSON.stringify(current.webui.listen_interfaces)) {
                webuiChanged = true;
              }
              current.webui.listen_interfaces = updates.webui.listen_interfaces;
            }
          }
        } else if (key === 'update_check') {
          // Intelligent update_check handling - only changed fields are overwritten
          if (!current.update_check) current.update_check = {};

          // If only a boolean is sent, it is for enabled
          if (typeof updates.update_check === 'boolean') {
            if (current.update_check.enabled !== updates.update_check) {
              updateCheckChanged = true;
            }
            current.update_check.enabled = updates.update_check;
          } else if (typeof updates.update_check === 'object') {
            // Individual update_check properties are adopted
            if (updates.update_check.enabled !== undefined &&
                current.update_check.enabled !== updates.update_check.enabled) {
              updateCheckChanged = true;
            }
            if (updates.update_check.update_check_schedule !== undefined &&
                current.update_check.update_check_schedule !== updates.update_check.update_check_schedule) {
              updateCheckChanged = true;
            }

            // Main properties are adopted
            if (updates.update_check.enabled !== undefined)
              current.update_check.enabled = updates.update_check.enabled;
            if (updates.update_check.update_check_schedule !== undefined)
              current.update_check.update_check_schedule = updates.update_check.update_check_schedule;
          }
        } else if (key === 'hostname') {
          if (updates.hostname !== current.hostname) {
            hostnameChanged = true;
            newHostname = updates.hostname;
          }
          current[key] = updates[key];
        } else {
          current[key] = updates[key];
        }
      }

      // Write file
      await fs.writeFile('/boot/config/system.json', JSON.stringify(current, null, 2), 'utf8');

      // NTP service stop/start/restart if changed
      if (ntpChanged) {
        if (current.ntp.enabled === false) {
          await execPromise('/etc/init.d/ntpsec stop');
        } else if (current.ntp.enabled === true) {
          // If service was already active and settings have changed, restart
          if (updates.ntp && (updates.ntp.mode !== undefined || Array.isArray(updates.ntp.servers))) {
            await execPromise('/etc/init.d/ntpsec restart');
          } else {
            await execPromise('/etc/init.d/ntpsec start');
          }
        }
      }

      // Set hostname directly if changed
      if (hostnameChanged && newHostname) {
        await execPromise(`hostname ${newHostname}`);
      }

      // Keymap directly into system load
      if (keymapChanged) {
        await execPromise(`loadkeys ${current.keymap}`);
      }

      // Timezone directly into system set
      if (timezoneChanged) {
        await execPromise(`ln -sf /usr/share/zoneinfo/${current.timezone} /etc/localtime`);
      }

      // Persist history setup
      if (persistHistoryChanged && persistHistoryValue === true) {
        try {
          // Remove old bash_history file
          await execPromise('rm -f /root/.bash_history');
          // Create directory if it doesn't exist
          await execPromise('mkdir -p /boot/config/system');
          // Create new bash_history file
          await execPromise('touch /boot/config/system/.bash_history');
          // Create symlink
          await execPromise('ln -s /boot/config/system/.bash_history /root/.bash_history');
        } catch (error) {
          console.warn('Warning: Could not setup persistent bash history:', error.message);
        }
      }

      // Display settings apply with setterm
      if (displayChanged && current.display) {
        try {
          const settermArgs = [];

          // Add --blank parameter for timeout
          if (current.display.timeout !== undefined && current.display.timeout !== null) {
            settermArgs.push(`--blank ${current.display.timeout}`);
          }

          // Add --powersave parameter
          if (current.display.powersave !== undefined && current.display.powersave !== null) {
            settermArgs.push(`--powersave ${current.display.powersave}`);
          }

          // Add --powerdown parameter
          if (current.display.powerdown !== undefined && current.display.powerdown !== null) {
            settermArgs.push(`--powerdown ${current.display.powerdown}`);
          }

          // Execute setterm command if we have arguments
          if (settermArgs.length > 0) {
            const settermCmd = `setterm ${settermArgs.join(' ')}`;
            await execPromise(settermCmd);
          }
        } catch (error) {
          console.warn('Warning: Could not apply display settings with setterm:', error.message);
        }
      }

      // CPU frequency scaling settings apply with cpupower service
      if (cpufreqChanged) {
        try {
          await execPromise('/etc/init.d/cpupower start');
        } catch (error) {
          console.warn('Warning: Could not apply cpufreq settings with cpupower:', error.message);
        }
      }

      // Apply binfmt settings when enabled or architectures changed
      if (binfmtChanged) {
        try {
          await execPromise('/usr/local/bin/mos-start "binfmt"');
        } catch (error) {
          console.warn('Warning: Could not apply binfmt settings:', error.message);
        }
      }

      // Recreate certs and restart nginx if local_dns_searchname changed
      if (localDnsSearchnameChanged) {
        try {
          await execPromise('/etc/init.d/nginx recreatecerts');
        } catch (error) {
          console.warn('Warning: nginx recreatecerts failed:', error.message);
        }
        try {
          await execPromise('/etc/init.d/nginx restart');
        } catch (error) {
          console.warn('Warning: Could not restart nginx after recreatecerts:', error.message);
        }
      }

      // Restart nginx if webui settings changed (http/https port, https_enabled, or listen_interfaces)
      if (webuiChanged && !localDnsSearchnameChanged) {
        try {
          await execPromise('/etc/init.d/nginx restart');
        } catch (error) {
          console.warn('Warning: Could not restart nginx:', error.message);
        }
      }

      // mos-cron_update execute if update_check changed
      if (updateCheckChanged) {
        try {
          await execPromise('/usr/local/bin/mos-cron_update');
        } catch (error) {
          console.warn('Warning: mos-cron_update could not be executed:', error.message);
        }
      }

      // Handle swapfile configuration update
      if (swapfileUpdate !== null) {
        try {
          // Initialize swapfile with defaults if not present
          if (!current.swapfile) {
            current.swapfile = this._getDefaultSystemSettings().swapfile;
          }

          // Handle the swapfile update (create/remove/modify) via swap.service.js
          const updatedSwapfile = await swapService.handleUpdate(current.swapfile, swapfileUpdate);
          current.swapfile = updatedSwapfile;

          // Write updated config back to file (with new swapfile settings)
          await fs.writeFile('/boot/config/system.json', JSON.stringify(current, null, 2), 'utf8');
        } catch (error) {
          throw new Error(`Swapfile configuration failed: ${error.message}`);
        }
      }

      return current;
    } catch (error) {
      throw new Error(`Fehler beim Schreiben der system.json: ${error.message}`);
    }
  }

  async listKeymaps() {
    try {
      const keymaps = [];
      const basePath = '/usr/share/keymaps/i386';
      const subdirs = await fs.readdir(basePath);

      for (const subdir of subdirs) {
        const subdirPath = `${basePath}/${subdir}`;
        try {
          const files = await fs.readdir(subdirPath);
          const mapFiles = files.filter(f => f.endsWith('.kmap') || f.endsWith('.kmap.gz'));
          mapFiles.forEach(f => {
            const keymapName = f.replace(/\.kmap.gz$/, '');
            if (!keymaps.includes(keymapName)) {
              keymaps.push(keymapName);
            }
          });
        } catch (error) {
          continue;
        }
      }
      return keymaps.sort();
    } catch (error) {
      throw new Error('Fehler beim Lesen der Keymaps: ' + error.message);
    }
  }

  /**
   * Lists all available timezones under /usr/share/zoneinfo recursively (only files, no directories)
   * @returns {Promise<string[]>} Array of timezones (e.g. Europe/Vienna)
   */
  async listTimezones() {
    const basePath = '/usr/share/zoneinfo';
    const result = [];
    async function walk(dir, relPath = '') {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Skip hidden and special directories
          if (entry.name.startsWith('.')) continue;
          await walk(`${dir}/${entry.name}`, relPath ? `${relPath}/${entry.name}` : entry.name);
        } else if (entry.isFile()) {
          // Only real timezone files (no posix, right, localtime, etc.)
          if (['posix', 'right', 'localtime', 'posixrules', 'leapseconds', 'zone.tab', 'zone1970.tab', 'iso3166.tab', 'tzdata.zi', 'leap-seconds.list'].includes(entry.name)) continue;
          result.push(relPath ? `${relPath}/${entry.name}` : entry.name);
        }
      }
    }
    await walk(basePath);
    // Filter out right/ timezones
    const filteredResult = result.filter(tz => !tz.startsWith('right/'));
    return filteredResult.sort();
  }

  /**
   * Public method to check directory mount status
   * @param {string|Object} directoryPaths - Single path or object with paths {fieldName: path}
   * @returns {Promise<Object>} Check result
   */
  async checkDirectoryMountStatus(directoryPaths) {
    try {
      if (typeof directoryPaths === 'string') {
        // Einzelner Pfad
        const result = await this._checkDirectoryMountStatus(directoryPaths);
        return {
          path: directoryPaths,
          ...result
        };
      } else if (typeof directoryPaths === 'object') {
        // Mehrere Pfade
        const result = await this._checkMultipleDirectories(directoryPaths);
        return {
          hasErrors: result.hasErrors,
          directories: Object.keys(directoryPaths).map(fieldName => ({
            field: fieldName,
            path: directoryPaths[fieldName],
            ...result.results[fieldName]
          })),
          errors: result.errors
        };
      } else {
        throw new Error('directoryPaths must be a string or object');
      }
    } catch (error) {
      throw new Error(`Error checking directory mount status: ${error.message}`);
    }
  }

  /**
   * Update services
   * @param {string} service - Service name ('api' or 'nginx')
   * @returns {Promise<Object>} Update status
   */
  async updateService(service) {
    try {
      const allowedServices = ['api', 'nginx'];
      if (!allowedServices.includes(service)) {
        throw new Error(`Service '${service}' not allowed. Allowed: ${allowedServices.join(', ')}`);
      }

      // Create a detached child process that executes the update immediately
      const { spawn } = require('child_process');

      // Execute the update directly in a detached process
      const child = spawn('/etc/init.d/' + service, ['update'], {
        detached: true,
        stdio: 'ignore'
      });

      // Detach the child process from the parent, so it continues running even if the API is terminated
      child.unref();

      return {
        success: true,
        message: `${service} update initiated`,
        service,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error initiating service updating: ${error.message}`);
    }
  }

  /**
   * Updates the API immediately
   * @returns {Promise<Object>} Update status
   */
  async updateApi() {
    return await this.updateService('api');
  }

  /**
   * Updates nginx immediately
   * @returns {Promise<Object>} Update status
   */
  async updateNginx() {
    return await this.updateService('nginx');
  }

  /**
   * Recreates SSL certificates and restarts nginx
   * @returns {Promise<Object>} Result with recreatecerts and restart status
   */
  async recreateCerts() {
    const result = { recreatecerts: null, nginx_restart: null };

    try {
      await execPromise('/etc/init.d/nginx recreatecerts');
      result.recreatecerts = 'success';
    } catch (error) {
      result.recreatecerts = `failed: ${error.message}`;
    }

    try {
      await execPromise('/etc/init.d/nginx restart');
      result.nginx_restart = 'success';
    } catch (error) {
      result.nginx_restart = `failed: ${error.message}`;
    }

    return result;
  }

  /**
   * Reads SSL certificate information from /boot/config/system/ssl/
   * Returns validity, subject, issuer, serial for nginx cert and root CA
   * @returns {Promise<Object>} Certificate information
   */
  async getCertificatesInfo() {
    const sslDir = '/boot/config/system/ssl';
    const certs = [
      { name: 'nginx', path: `${sslDir}/nginx.crt` },
      { name: 'root_ca', path: `${sslDir}/root/ca.crt` }
    ];

    const result = {};

    const parseDistinguishedName = (dn) => {
      const result = {};
      const parts = dn.split(',').map(p => p.trim());
      for (const part of parts) {
        const idx = part.indexOf('=');
        if (idx !== -1) {
          const key = part.substring(0, idx).trim();
          const value = part.substring(idx + 1).trim();
          result[key] = value;
        }
      }
      return result;
    };

    for (const cert of certs) {
      const info = {
        subject: null,
        issuer: null,
        not_before: null,
        not_after: null,
        serial: null,
        fingerprint_sha256: null,
        san: null,
        days_remaining: null,
        expired: null,
        file: cert.path
      };

      try {
        await fs.access(cert.path);
        const { stdout } = await execPromise(
          `openssl x509 -in ${cert.path} -noout -subject -issuer -dates -serial -sha256 -fingerprint -ext subjectAltName 2>&1`
        );

        const lines = stdout.split('\n').filter(l => l.trim());

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('subject=')) {
            info.subject = parseDistinguishedName(trimmed.replace('subject=', '').trim());
          } else if (trimmed.startsWith('issuer=')) {
            info.issuer = parseDistinguishedName(trimmed.replace('issuer=', '').trim());
          } else if (trimmed.startsWith('notBefore=')) {
            info.not_before = trimmed.replace('notBefore=', '').trim();
          } else if (trimmed.startsWith('notAfter=')) {
            info.not_after = trimmed.replace('notAfter=', '').trim();
          } else if (trimmed.startsWith('serial=')) {
            info.serial = trimmed.replace('serial=', '').trim();
          } else if (trimmed.toLowerCase().includes('fingerprint=')) {
            info.fingerprint_sha256 = trimmed.split('=').slice(1).join('=').trim();
          } else if (trimmed.startsWith('DNS:') || trimmed.startsWith('IP Address:')) {
            info.san = trimmed.split(',').map(s => s.trim().replace(/^DNS:|^IP Address:/i, '').trim());
          }
        }

        // Calculate days remaining
        if (info.not_after) {
          const expiry = new Date(info.not_after);
          const now = new Date();
          const diffMs = expiry - now;
          info.days_remaining = Math.floor(diffMs / (1000 * 60 * 60 * 24));
          info.expired = info.days_remaining < 0;
        }
      } catch (_) {
        // Certificate not readable — all fields remain null
      }

      result[cert.name] = info;
    }

    return result;
  }

  /**
   * Updates the LXC default.conf with the current primary interface and correct network type
   * @param {string} primaryInterface - The primary interface (br0 or eth0)
   * @param {Array} interfaces - Interface array from network.json for type determination
   * @returns {Promise<void>}
   */
  async _updateLxcDefaultConf(primaryInterface, interfaces = []) {
    try {
      const confPath = '/boot/config/system/lxc/default.conf';
      let confContent = '';

      // Determine the correct LXC Network Type
      const networkType = this._determineLxcNetworkType(primaryInterface, interfaces);

      try {
        confContent = await fs.readFile(confPath, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // File does not exist, create basic configuration
        confContent = `# LXC default configuration
lxc.net.0.type = ${networkType}
lxc.net.0.link = ${primaryInterface}
lxc.net.0.flags = up
lxc.net.0.hwaddr = 00:16:3e:xx:xx:xx
`;
      }

      // Replace the type line with the correct network type
      const typeRegex = /^lxc\.net\.0\.type\s*=\s*.+$/m;
      const newTypeLine = `lxc.net.0.type = ${networkType}`;

      if (typeRegex.test(confContent)) {
        confContent = confContent.replace(typeRegex, newTypeLine);
      } else {
        // Add the line if it doesn't exist
        confContent += `\nlxc.net.0.type = ${networkType}\n`;
      }

      // Replace the link line with the new interface
      const linkRegex = /^lxc\.net\.0\.link\s*=\s*.+$/m;
      const newLinkLine = `lxc.net.0.link = ${primaryInterface}`;

      if (linkRegex.test(confContent)) {
        confContent = confContent.replace(linkRegex, newLinkLine);
      } else {
        // Add the line if it doesn't exist
        confContent += `\nlxc.net.0.link = ${primaryInterface}\n`;
      }

      // Make sure the directory exists
      await fs.mkdir('/boot/config/system/lxc', { recursive: true });

      // Write the updated configuration
      await fs.writeFile(confPath, confContent, 'utf8');

      console.log(`LXC default.conf updated: lxc.net.0.type = ${networkType}, lxc.net.0.link = ${primaryInterface}`);
    } catch (error) {
      console.warn(`Warning: Could not update LXC default.conf: ${error.message}`);
    }
  }

  /**
   * Determines the correct LXC Network Type based on Interface Configuration
   * @param {string} primaryInterface - The primary interface (br0 or eth0)
   * @param {Array} interfaces - Interface array from network.json
   * @returns {string} LXC Network Type (veth, macvlan, etc.)
   */
  _determineLxcNetworkType(primaryInterface, interfaces = []) {
    if (!Array.isArray(interfaces)) {
      return 'veth'; // Standard fallback
    }

    const primaryIface = interfaces.find(iface => iface.name === primaryInterface);

    if (primaryIface) {
      // If it is a bridge, use veth
      if (primaryIface.type === 'bridge') {
        return 'veth';
      }

      // If it is a direct interface, use macvlan
      if (primaryIface.type === 'ethernet') {
        return 'macvlan';
      }

      // If it is a bridged interface, use veth
      if (primaryIface.type === 'bridged') {
        return 'veth';
      }
    }

    //  Fallback: Bridge-Interfaces verwenden veth, direkte Interfaces verwenden macvlan
    return primaryInterface === 'br0' ? 'veth' : 'macvlan';
  }



  /**
   * Determines the primary network interface based on the current configuration.
   * Priority: first active bridge > first active bond > first active ethernet with IP > first active interface
   * @param {Array} interfaces - Interface array from network.json
   * @returns {string} The primary interface name
   */
  _determinePrimaryInterface(interfaces) {
    if (!Array.isArray(interfaces) || interfaces.length === 0) {
      return 'eth0';
    }

    // Only consider active interfaces
    const active = interfaces.filter(i => i.status !== 'orphan' && i.status !== 'disabled');

    // 1. First active bridge with IP config
    const bridge = active.find(i => i.type === 'bridge' && Array.isArray(i.ipv4) && i.ipv4.length > 0);
    if (bridge) return bridge.name;

    // 2. First active bond with IP config
    const bond = active.find(i => i.type === 'bond' && Array.isArray(i.ipv4) && i.ipv4.length > 0);
    if (bond) return bond.name;

    // 3. First active ethernet with IP config
    const ethernet = active.find(i => i.type === 'ethernet' && Array.isArray(i.ipv4) && i.ipv4.length > 0);
    if (ethernet) return ethernet.name;

    // 4. First active interface of any type (excluding bridged)
    const any = active.find(i => i.type !== 'bridged');
    if (any) return any.name;

    // Fallback
    return 'eth0';
  }

  /**
   * Fast read of docker enabled status without loading defaults
   * @returns {Promise<boolean>} Docker enabled status
   */
  async _getDockerEnabledStatus() {
    try {
      const data = await fs.readFile(this.settingsPath, 'utf8');
      const settings = JSON.parse(data);
      return settings.enabled === true;
    } catch (error) {
      return false; // File not found or error - defaults to false
    }
  }

  /**
   * Check if Docker daemon is actually running via socket ping
   * @returns {Promise<boolean>} True if Docker daemon is responding
   */
  async _isDockerRunning() {
    try {
      const response = await axios({
        method: 'GET',
        url: 'http://localhost/_ping',
        socketPath: '/var/run/docker.sock',
        timeout: 2000,
        validateStatus: () => true
      });
      return response.status === 200;
    } catch (error) {
      return false;
    }
  }

  /**
   * Fast read of LXC enabled status without loading defaults
   * @returns {Promise<boolean>} LXC enabled status
   */
  async _getLxcEnabledStatus() {
    try {
      const data = await fs.readFile('/boot/config/lxc.json', 'utf8');
      const settings = JSON.parse(data);
      return settings.enabled === true;
    } catch (error) {
      return false; // File not found or error - defaults to false
    }
  }

  /**
   * Fast read of VM enabled status without loading defaults
   * @returns {Promise<boolean>} VM enabled status
   */
  async _getVmEnabledStatus() {
    try {
      const data = await fs.readFile('/boot/config/vm.json', 'utf8');
      const settings = JSON.parse(data);
      return settings.enabled === true;
    } catch (error) {
      return false; // File not found or error - defaults to false
    }
  }

  /**
   * Check if a process with given PID is running
   * @param {number} pid - Process ID to check
   * @returns {Promise<boolean>} True if process is running
   */
  async _isProcessRunning(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Check if libvirt daemon is actually running via PID files
   * @returns {Promise<boolean>} True if libvirtd is running
   */
  async _isLibvirtRunning() {
    try {
      // Check libvirtd.pid
      const pidData = await fs.readFile('/var/run/libvirtd.pid', 'utf8');
      const pid = parseInt(pidData.trim(), 10);
      if (isNaN(pid)) return false;
      return await this._isProcessRunning(pid);
    } catch (error) {
      return false;
    }
  }

  /**
   * Fast read of network services status without loading defaults
   * @returns {Promise<Object>} Network services with enabled status
   */
  async _getNetworkServicesStatus() {
    try {
      const data = await fs.readFile('/boot/config/network.json', 'utf8');
      const settings = JSON.parse(data);
      const result = {};

      if (settings.services && typeof settings.services === 'object') {
        for (const [serviceName, serviceConfig] of Object.entries(settings.services)) {
          if (serviceConfig && typeof serviceConfig === 'object' && 'enabled' in serviceConfig) {
            // Migrate nmbd to samba_discovery in status response
            const outputName = serviceName === 'nmbd' ? 'samba_discovery' : serviceName;
            result[outputName] = {
              enabled: serviceConfig.enabled === true
            };
          }
        }
      }

      return result;
    } catch (error) {
      return {}; // File not found or error - return empty object
    }
  }

  /**
   * Gets the status of all services from different configuration files
   * Optimized version that only reads enabled flags without loading defaults
   * Also checks if services are actually running (not just configured)
   * @returns {Promise<Object>} Status object with all services (flat structure)
   */
  async getAllServiceStatus() {
    try {
      // Execute all status reads in parallel for maximum performance
      const [dockerEnabled, lxcEnabled, vmEnabled, hubEnabled, networkServices, dockerRunning, vmRunning] = await Promise.all([
        this._getDockerEnabledStatus(),
        this._getLxcEnabledStatus(),
        this._getVmEnabledStatus(),
        hubService.getHubEnabledStatus(),
        this._getNetworkServicesStatus(),
        this._isDockerRunning(),
        this._isLibvirtRunning()
      ]);

      const result = {
        docker: { enabled: dockerEnabled, running: dockerRunning },
        lxc: { enabled: lxcEnabled },
        vm: { enabled: vmEnabled, running: vmRunning },
        hub: { enabled: hubEnabled },
        ...networkServices
      };

      // Inject runtime online status for VPN services (not persisted)
      const checks = [];
      if (result.tailscale) {
        if (result.tailscale.enabled) {
          checks.push(this._getTailscaleOnline().then(online => { result.tailscale.online = online; }));
        } else {
          result.tailscale.online = false;
        }
      }
      if (result.netbird) {
        if (result.netbird.enabled) {
          checks.push(this._getNetbirdOnline().then(online => { result.netbird.online = online; }));
        } else {
          result.netbird.online = false;
        }
      }
      if (checks.length) await Promise.all(checks);

      return result;
    } catch (error) {
      throw new Error(`Fehler beim Abrufen des Service-Status: ${error.message}`);
    }
  }

  /**
   * Compares two version strings for semantic version sorting
   * @param {string} versionA - First version string (e.g., "0.0.2-alpha.1")
   * @param {string} versionB - Second version string (e.g., "0.0.1-alpha.16")
   * @returns {number} Comparison result: positive if A > B, negative if A < B, 0 if equal
   */
  _compareVersions(versionA, versionB) {
    // Parse version strings into components
    const parseVersion = (version) => {
      // Remove 'v' prefix if present
      const cleanVersion = version.replace(/^v/, '');

      // Split into main version and pre-release parts
      const [mainVersion, preRelease] = cleanVersion.split('-');

      // Parse main version numbers
      const mainParts = mainVersion.split('.').map(num => parseInt(num, 10) || 0);

      // Ensure we have at least 3 parts for major.minor.patch
      while (mainParts.length < 3) {
        mainParts.push(0);
      }

      // Parse pre-release part
      let preReleaseType = '';
      let preReleaseNumber = 0;

      if (preRelease) {
        const preMatch = preRelease.match(/^(alpha|beta|rc)\.?(\d+)?$/i);
        if (preMatch) {
          preReleaseType = preMatch[1].toLowerCase();
          preReleaseNumber = parseInt(preMatch[2], 10) || 0;
        }
      }

      return {
        major: mainParts[0],
        minor: mainParts[1],
        patch: mainParts[2],
        preReleaseType,
        preReleaseNumber,
        isPreRelease: !!preRelease
      };
    };

    const vA = parseVersion(versionA);
    const vB = parseVersion(versionB);

    // Compare main version numbers (major.minor.patch)
    if (vA.major !== vB.major) return vA.major - vB.major;
    if (vA.minor !== vB.minor) return vA.minor - vB.minor;
    if (vA.patch !== vB.patch) return vA.patch - vB.patch;

    // If main versions are equal, handle pre-release comparison
    // Stable versions (no pre-release) are higher than pre-release versions
    if (!vA.isPreRelease && vB.isPreRelease) return 1;
    if (vA.isPreRelease && !vB.isPreRelease) return -1;
    if (!vA.isPreRelease && !vB.isPreRelease) return 0;

    // Both are pre-releases, compare pre-release types
    const preReleaseOrder = { alpha: 1, beta: 2, rc: 3 };
    const typeA = preReleaseOrder[vA.preReleaseType] || 0;
    const typeB = preReleaseOrder[vB.preReleaseType] || 0;

    if (typeA !== typeB) return typeA - typeB;

    // Same pre-release type, compare numbers
    return vA.preReleaseNumber - vB.preReleaseNumber;
  }

  /**
   * Gets available releases via the mos-os_get_releases script
   * @returns {Promise<Object>} Release information grouped by channels
   */
  async getReleases() {
    try {
      const command = '/usr/local/bin/mos-os_get_releases';

      // Execute script
      const { stdout, stderr } = await execPromise(command);

      if (stderr) {
        console.warn('Get releases script stderr:', stderr);
      }

      // Read JSON file
      const releasesPath = '/var/mos/mos-update/releases.json';

      try {
        const releasesData = await fs.readFile(releasesPath, 'utf8');
        const releases = JSON.parse(releasesData);

        if (!Array.isArray(releases)) {
          throw new Error('Invalid releases data format - expected array');
        }

        // Group releases by channels based on tag_name
        const groupedReleases = {
          alpha: [],
          beta: [],
          stable: []
        };

        releases.forEach(release => {
          if (release.tag_name) {
            const tagName = release.tag_name.toLowerCase();

            if (tagName.includes('-alpha')) {
              groupedReleases.alpha.push({
                tag_name: release.tag_name,
                html_url: release.html_url
              });
            } else if (tagName.includes('-beta')) {
              groupedReleases.beta.push({
                tag_name: release.tag_name,
                html_url: release.html_url
              });
            } else {
              // Alles andere als stable behandeln (keine -alpha oder -beta Kennzeichnung)
              groupedReleases.stable.push({
                tag_name: release.tag_name,
                html_url: release.html_url
              });
            }
          }
        });

        // Sort releases by semantic version (newest first)
        Object.keys(groupedReleases).forEach(channel => {
          groupedReleases[channel].sort((a, b) => {
            return this._compareVersions(b.tag_name, a.tag_name);
          });
        });

        return groupedReleases;

      } catch (fileError) {
        throw new Error(`Failed to read or parse releases file: ${fileError.message}`);
      }

    } catch (error) {
      console.error('Get releases error:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Gets the current OS information including release, CPU details and hostname
   * @returns {Promise<Object>} OS and CPU information with hostname
   */
  async getCurrentRelease() {
    try {
      const releasePath = '/etc/mos-release.json';
      const releaseData = await fs.readFile(releasePath, 'utf8');
      const release = JSON.parse(releaseData);

      // Get CPU information using systeminformation
      const si = require('systeminformation');
      const cpu = await si.cpu();

      // Get hostname from system.json
      let hostname = null;
      try {
        const systemData = await fs.readFile('/boot/config/system.json', 'utf8');
        const systemSettings = JSON.parse(systemData);
        hostname = systemSettings.hostname || null;
      } catch (hostnameError) {
        console.warn('Warning: Could not read hostname from system.json:', hostnameError.message);
      }

      // Get running kernel version
      let runningKernel = null;
      try {
        const { stdout } = await execPromise('uname -r');
        runningKernel = stdout.trim();
      } catch (kernelError) {
        console.warn('Warning: Could not get running kernel version:', kernelError.message);
      }

      // Get system architecture
      let arch = null;
      try {
        const { stdout: archOut } = await execPromise('uname -m');
        arch = archOut.trim();
      } catch (archError) {
        console.warn('Warning: Could not get system architecture:', archError.message);
      }

      // Get uptime information
      let uptimeInfo = {
        pretty: null,
        since: null
      };
      try {
        // Get uptime --pretty
        const { stdout: uptimePretty } = await execPromise('uptime --pretty');
        // Remove "up " prefix and trim whitespace
        uptimeInfo.pretty = uptimePretty.trim().replace(/^up\s+/i, '');
      } catch (prettyError) {
        console.warn('Warning: Could not get uptime --pretty:', prettyError.message);
      }
      try {
        // Get uptime --since
        const { stdout: uptimeSince } = await execPromise('uptime --since');
        uptimeInfo.since = uptimeSince.trim();
      } catch (sinceError) {
        console.warn('Warning: Could not get uptime --since:', sinceError.message);
      }

      // Process version and channel - handle nested mos object structure
      if (release.mos && typeof release.mos === 'object') {
        const originalVersion = release.mos.version || '';
        const originalChannel = release.mos.channel || '';

        // Construct full version from version + channel
        if (originalChannel) {
          release.mos.version = `${originalVersion}-${originalChannel}`;
        }

        // Clean up channel to remove suffixes (e.g., "alpha.4" -> "alpha")
        if (originalChannel) {
          release.mos.channel = originalChannel.split('.')[0];
        }

        // Add running kernel to mos object
        if (runningKernel) {
          release.mos.running_kernel = runningKernel;
        }

        // Add architecture to mos object
        if (arch) {
          release.mos.arch = arch;
        }
      } else {
        // Handle flat structure (fallback)
        const originalVersion = release.version || '';
        const originalChannel = release.channel || '';

        // Construct full version from version + channel
        if (originalChannel) {
          release.version = `${originalVersion}-${originalChannel}`;
        }

        // Clean up channel to remove suffixes (e.g., "alpha.4" -> "alpha")
        if (originalChannel) {
          release.channel = originalChannel.split('.')[0];
        }

        // Add running kernel to flat structure
        if (runningKernel) {
          if (!release.mos) release.mos = {};
          release.mos.running_kernel = runningKernel;
        }

        // Add architecture to flat structure
        if (arch) {
          if (!release.mos) release.mos = {};
          release.mos.arch = arch;
        }
      }

      // Combine release info with CPU info, hostname and uptime
      const osInfo = {
        hostname: hostname,
        uptime: uptimeInfo,
        cpu: {
          manufacturer: cpu.manufacturer,
          brand: cpu.brand,
          cores: cpu.cores,
          physicalCores: cpu.physicalCores
        },
        ...release
      };

      return osInfo;

    } catch (error) {
      console.error('Get current OS info error:', error.message);
      throw new Error(`Failed to read OS information: ${error.message}`);
    }
  }

  /**
   * Executes an OS update using the mos-os_update script
   * @param {string} version - Version (latest or version number like 0.0.0, 1.223.1)
   * @param {string} channel - Update channel (alpha, beta, stable)
   * @param {boolean} updateKernel - Optional, whether to update the kernel (default: true)
   * @returns {Promise<Object>} Update status
   */
  async updateOS(version, channel, updateKernel = true) {
    try {
      // Parameter validation
      if (!version || typeof version !== 'string') {
        throw new Error('Version parameter is required and must be a string');
      }

      if (!channel || !['alpha', 'beta', 'stable'].includes(channel)) {
        throw new Error('Channel must be one of: alpha, beta, stable');
      }

      // Version validation - either "latest" or version number format (with optional suffixes)
      const versionPattern = /^(latest|\d+\.\d+\.\d+.*)$/;
      if (!versionPattern.test(version)) {
        throw new Error('Version must be "latest" or start with a version number (e.g., 0.0.0, 1.223.1, 0.0.0-alpha.1)');
      }

      // Command arguments
      const args = [version, channel];

      // Add third argument only if updateKernel is true
      if (updateKernel === true) {
        args.push('update_kernel');
      }

      // Create a detached child process that executes the update immediately
      const { spawn } = require('child_process');

      // Execute the update directly in a detached process
      const child = spawn('/usr/local/bin/mos-os_update', args, {
        detached: true,
        stdio: 'ignore'
      });

      // Detach the child process from the parent, so it continues running even if the API is terminated
      child.unref();

      return {
        success: true,
        message: 'OS update initiated successfully',
        version,
        channel,
        updateKernel,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('OS update error:', error.message);
      return {
        success: false,
        error: error.message,
        version,
        channel,
        updateKernel,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Executes an OS rollback using the mos-os_update script
   * @param {boolean} kernelRollback - Optional, whether to perform a kernel rollback (default: true)
   * @returns {Promise<Object>} Rollback status
   */
  async rollbackOS(kernelRollback = true) {
    try {
      // Arguments for the command
      const args = ['rollback'];

      // "not_kernel" argument only add if kernelRollback is explicitly false
      if (kernelRollback === false) {
        args.push('not_kernel');
      }

      // Create a detached child process that executes the rollback immediately
      const { spawn } = require('child_process');

      // Execute the rollback directly in a detached process
      const child = spawn('/usr/local/bin/mos-os_update', args, {
        detached: true,
        stdio: 'ignore'
      });

      // Detach the child process from the parent, so it continues running even if the API is terminated
      child.unref();

      return {
        success: true,
        message: 'OS rollback initiated successfully',
        kernelRollback,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('OS rollback error:', error.message);
      return {
        success: false,
        error: error.message,
        kernelRollback,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Gets available kernel releases via the mos-kernel_get_releases script
   * @returns {Promise<Array>} Sorted array of kernel releases (newest first)
   */
  async getKernelReleases() {
    try {
      const command = '/usr/local/bin/mos-kernel_get_releases';

      // Execute script
      const { stdout, stderr } = await execPromise(command);

      if (stderr) {
        console.warn('Get kernel releases script stderr:', stderr);
      }

      // Read JSON file
      const releasesPath = '/var/mos/mos-update/kernel/releases.json';

      try {
        const releasesData = await fs.readFile(releasesPath, 'utf8');
        const releases = JSON.parse(releasesData);

        if (!Array.isArray(releases)) {
          throw new Error('Invalid kernel releases data format - expected array');
        }

        // Extract and sort releases by tag_name (newest first)
        const sortedReleases = releases
          .filter(release => release.tag_name) // Only releases with tag_name
          .map(release => ({
            tag_name: release.tag_name,
            html_url: release.html_url
          }))
          .sort((a, b) => {
            return this._compareVersions(b.tag_name, a.tag_name);
          });

        return sortedReleases;

      } catch (fileError) {
        throw new Error(`Failed to read or parse kernel releases file: ${fileError.message}`);
      }

    } catch (error) {
      console.error('Get kernel releases error:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Executes a kernel update using the mos-kernel_update script
   * @param {string} version - Version (recommended or version number like 6.1.0, 6.17.1-mos)
   * @returns {Promise<Object>} Update status
   */
  async updateKernel(version) {
    try {
      // Parameter validation
      if (!version || typeof version !== 'string') {
        throw new Error('Version parameter is required and must be a string');
      }

      // Version validation - either "recommended" or version number format (with optional suffixes)
      const versionPattern = /^(recommended|\d+\.\d+\.\d+.*)$/;
      if (!versionPattern.test(version)) {
        throw new Error('Version must be "recommended" or start with a version number (e.g., 6.1.0, 6.17.1-mos, 6.1.0-alpha.1)');
      }

      // Create a detached child process that executes the kernel update immediately
      const { spawn } = require('child_process');

      // Execute the kernel update directly in a detached process
      const child = spawn('/usr/local/bin/mos-kernel_update', [version], {
        detached: true,
        stdio: 'ignore'
      });

      // Detach the child process from the parent, so it continues running even if the API is terminated
      child.unref();

      return {
        success: true,
        message: 'Kernel update initiated successfully',
        version,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('Kernel update error:', error.message);
      return {
        success: false,
        error: error.message,
        version,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Executes a kernel rollback using the mos-kernel_update script
   * @returns {Promise<Object>} Rollback status
   */
  async rollbackKernel() {
    try {
      // Create a detached child process that executes the kernel rollback immediately
      const { spawn } = require('child_process');

      // Execute the kernel rollback directly in a detached process
      const child = spawn('/usr/local/bin/mos-kernel_update', ['rollback'], {
        detached: true,
        stdio: 'ignore'
      });

      // Detach the child process from the parent, so it continues running even if the API is terminated
      child.unref();

      return {
        success: true,
        message: 'Kernel rollback initiated successfully',
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('Kernel rollback error:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Gets installed drivers from /boot/optional/drivers/
   * @returns {Promise<Object>} Grouped installed drivers by category
   */
  async getInstalledDrivers() {
    try {
      // Get current kernel version
      const { stdout: unameOutput } = await execPromise('uname -r');
      const kernelVersionTrimmed = unameOutput.trim();

      const driversBasePath = '/boot/optional/drivers';

      // Check if base directory exists
      try {
        await fs.access(driversBasePath);
      } catch (error) {
        // Directory doesn't exist, return empty object
        return {};
      }

      // Read all category directories
      const categories = await fs.readdir(driversBasePath);
      const installedDrivers = {};

      for (const category of categories) {
        const categoryPath = `${driversBasePath}/${category}`;

        // Check if it's a directory
        try {
          const stat = await fs.stat(categoryPath);
          if (!stat.isDirectory()) continue;
        } catch (error) {
          continue;
        }

        // Check if kernel version directory exists
        const kernelPath = `${categoryPath}/${kernelVersionTrimmed}`;
        try {
          await fs.access(kernelPath);
        } catch (error) {
          // Kernel version directory doesn't exist for this category
          continue;
        }

        // Read .deb files in kernel version directory
        const files = await fs.readdir(kernelPath);

        for (const file of files) {
          // Skip non-.deb files and .md5 files
          if (!file.endsWith('.deb') || file.endsWith('.deb.md5')) {
            continue;
          }

          // Remove .deb extension
          const nameWithoutDeb = file.replace('.deb', '');

          // Parse the package name
          // Format: packagename_version+suffix_architecture.deb
          const firstUnderscore = nameWithoutDeb.indexOf('_');

          if (firstUnderscore === -1) {
            continue;
          }

          const packageName = nameWithoutDeb.substring(0, firstUnderscore);
          const rest = nameWithoutDeb.substring(firstUnderscore + 1);

          // Extract version (between first _ and +)
          const plusIndex = rest.indexOf('+');
          const version = plusIndex !== -1 ? rest.substring(0, plusIndex) : rest.split('_')[0];

          // Initialize category object if it doesn't exist
          if (!installedDrivers[category]) {
            installedDrivers[category] = {};
          }

          // Initialize driver array if it doesn't exist
          if (!installedDrivers[category][packageName]) {
            installedDrivers[category][packageName] = [];
          }

          // Add version to driver array
          installedDrivers[category][packageName].push(version);
        }
      }

      return installedDrivers;

    } catch (error) {
      console.error('Get installed drivers error:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Gets available driver releases via the mos-drivers_get_releases script
   * @param {string} kernelVersion - Optional kernel version, if not provided uses uname -r
   * @param {boolean} excludeInstalled - If true, filters out installed drivers
   * @returns {Promise<Object>} Grouped driver releases by category
   */
  async getDriverReleases(kernelVersion = null, excludeInstalled = false) {
    try {
      // Build command with optional kernel version
      let command = '/usr/local/bin/mos-drivers_get_releases';
      if (kernelVersion) {
        command += ` "${kernelVersion}"`;
      }

      // Execute script
      const { stdout, stderr } = await execPromise(command);

      if (stderr) {
        console.warn('Get driver releases script stderr:', stderr);
      }

      // Get kernel version for the JSON file path
      let kernelVersionTrimmed;
      if (kernelVersion) {
        kernelVersionTrimmed = kernelVersion;
      } else {
        const { stdout: unameOutput } = await execPromise('uname -r');
        kernelVersionTrimmed = unameOutput.trim();
      }

      // Read JSON file
      const driversPath = `/var/mos/mos-drivers/drivers-${kernelVersionTrimmed}.json`;

      try {
        const driversData = await fs.readFile(driversPath, 'utf8');
        const driversJson = JSON.parse(driversData);

        // Extract assets from the JSON
        // Assuming the JSON structure contains an 'assets' array
        const assets = driversJson.assets || driversJson || [];

        if (!Array.isArray(assets)) {
          throw new Error('Invalid drivers data format - expected array or object with assets');
        }

        // Group drivers by category (first word before first dash)
        const groupedDrivers = {};

        assets.forEach(asset => {
          // Get the asset name (could be string or object with 'name' property)
          const assetName = typeof asset === 'string' ? asset : (asset.name || '');

          if (!assetName.endsWith('.deb')) {
            return; // Skip non-.deb files
          }

          // Remove .deb extension
          const nameWithoutDeb = assetName.replace('.deb', '');

          // Parse the package name
          // Format: packagename_version+suffix_architecture.deb
          // Example: dvb-digital-devices_20250910-1+mos_amd64.deb
          const firstUnderscore = nameWithoutDeb.indexOf('_');

          if (firstUnderscore === -1) {
            return; // Skip if no underscore found
          }

          const packageName = nameWithoutDeb.substring(0, firstUnderscore);
          const rest = nameWithoutDeb.substring(firstUnderscore + 1);

          // Extract version (between first _ and +)
          const plusIndex = rest.indexOf('+');
          const version = plusIndex !== -1 ? rest.substring(0, plusIndex) : rest.split('_')[0];

          // Get category (first word before first dash)
          const firstDash = packageName.indexOf('-');
          const category = firstDash !== -1 ? packageName.substring(0, firstDash) : packageName;

          // Initialize category object if it doesn't exist
          if (!groupedDrivers[category]) {
            groupedDrivers[category] = {};
          }

          // Initialize driver array if it doesn't exist
          if (!groupedDrivers[category][packageName]) {
            groupedDrivers[category][packageName] = [];
          }

          // Add version to driver array
          groupedDrivers[category][packageName].push(version);
        });

        // Filter out installed drivers if requested
        if (excludeInstalled) {
          const installedDrivers = await this.getInstalledDrivers();

          // Remove installed versions from available drivers
          for (const category in groupedDrivers) {
            if (installedDrivers[category]) {
              for (const packageName in groupedDrivers[category]) {
                if (installedDrivers[category][packageName]) {
                  // Filter out installed versions
                  groupedDrivers[category][packageName] = groupedDrivers[category][packageName].filter(
                    version => !installedDrivers[category][packageName].includes(version)
                  );

                  // Remove package entry if no versions left
                  if (groupedDrivers[category][packageName].length === 0) {
                    delete groupedDrivers[category][packageName];
                  }
                }
              }

              // Remove category if no packages left
              if (Object.keys(groupedDrivers[category]).length === 0) {
                delete groupedDrivers[category];
              }
            }
          }
        }

        return groupedDrivers;

      } catch (fileError) {
        throw new Error(`Failed to read or parse drivers file: ${fileError.message}`);
      }

    } catch (error) {
      console.error('Get driver releases error:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Downloads or upgrades drivers using the mos-driver_download script
   * @param {Object} options - Driver options
   * @param {string} [options.packagename] - Complete driver package filename (e.g., dvb-digital-devices_20250910-1+mos_amd64.deb)
   * @param {string} [options.drivername] - Driver name only (e.g., dvb-digital-devices) - requires driverversion
   * @param {string} [options.driverversion] - Driver version only (e.g., 20250910-1) - requires drivername
   * @param {string} [options.kernelVersion] - Optional desired kernel version/uname
   * @param {boolean} options.upgrade - If true, checks for driver updates
   * @returns {Promise<Object>} Driver download/upgrade status
   */
  async downloadDriver(options) {
    try {
      const { packagename, drivername, driverversion, kernelVersion, upgrade } = options;

      let command;
      let args = [];
      let finalPackageName;

      // Validate input: either upgrade=true OR packagename OR (drivername + driverversion) must be provided
      if (upgrade === true) {
        args.push('upgrade');
        command = `/usr/local/bin/mos-driver_download ${args.join(' ')}`;
      } else {
        // Option 1: Complete package name provided
        if (packagename && typeof packagename === 'string') {
          finalPackageName = packagename;
        }
        // Option 2: Driver name and version provided separately
        else if (drivername && driverversion) {
          if (typeof drivername !== 'string' || typeof driverversion !== 'string') {
            throw new Error('Driver name and driver version must be strings');
          }
          // Build complete package name: drivername_driverversion+mos_amd64.deb
          finalPackageName = `${drivername}_${driverversion}+mos_amd64.deb`;
        }
        // Error: Neither option provided
        else {
          throw new Error('Either packagename OR (drivername and driverversion) must be provided when upgrade is not true');
        }

        args.push(`"${finalPackageName}"`);

        // Add kernel version if provided
        if (kernelVersion && typeof kernelVersion === 'string') {
          args.push(`"${kernelVersion}"`);
        }

        command = `/usr/local/bin/mos-driver_download ${args.join(' ')}`;
      }

      // Execute script
      const { stdout, stderr } = await execPromise(command);

      return {
        success: true,
        message: upgrade ? 'Driver upgrade check initiated successfully' : 'Driver download initiated successfully',
        upgrade: upgrade || false,
        packagename: finalPackageName || null,
        drivername: drivername || null,
        driverversion: driverversion || null,
        kernelVersion: kernelVersion || null,
        command,
        output: stdout,
        error: stderr || null,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('Driver download error:', error.message);
      return {
        success: false,
        error: error.message,
        upgrade: options.upgrade || false,
        packagename: options.packagename || null,
        drivername: options.drivername || null,
        driverversion: options.driverversion || null,
        kernelVersion: options.kernelVersion || null,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Deletes a driver package from /boot/optional/drivers/
   * @param {Object} options - Driver options
   * @param {string} [options.packagename] - Complete driver package filename (e.g., dvb-digital-devices_20250910-1+mos_amd64.deb)
   * @param {string} [options.drivername] - Driver name only (e.g., dvb-digital-devices) - requires driverversion
   * @param {string} [options.driverversion] - Driver version only (e.g., 20250910-1) - requires drivername
   * @returns {Promise<Object>} Driver deletion status
   */
  async deleteDriver(options) {
    try {
      const { packagename, drivername, driverversion } = options;

      let finalPackageName;

      // Option 1: Complete package name provided
      if (packagename && typeof packagename === 'string') {
        finalPackageName = packagename;
      }
      // Option 2: Driver name and version provided separately
      else if (drivername && driverversion) {
        if (typeof drivername !== 'string' || typeof driverversion !== 'string') {
          throw new Error('Driver name and driver version must be strings');
        }
        // Build complete package name: drivername_driverversion+mos_amd64.deb
        finalPackageName = `${drivername}_${driverversion}+mos_amd64.deb`;
      }
      // Error: Neither option provided
      else {
        throw new Error('Either packagename OR (drivername and driverversion) must be provided');
      }

      // Parse package name to get category
      const nameWithoutDeb = finalPackageName.replace('.deb', '');
      const firstUnderscore = nameWithoutDeb.indexOf('_');

      if (firstUnderscore === -1) {
        throw new Error('Invalid package name format');
      }

      const fullDriverName = nameWithoutDeb.substring(0, firstUnderscore);

      // Get category (first word before first dash)
      const firstDash = fullDriverName.indexOf('-');
      const category = firstDash !== -1 ? fullDriverName.substring(0, firstDash) : fullDriverName;

      // Get current kernel version
      const { stdout: unameOutput } = await execPromise('uname -r');
      const kernelVersion = unameOutput.trim();

      // Build full path to driver package
      const driverPath = `/boot/optional/drivers/${category}/${kernelVersion}/${finalPackageName}`;
      const md5Path = `${driverPath}.md5`;

      // Check if driver package exists
      try {
        await fs.access(driverPath);
      } catch (error) {
        throw new Error(`Driver package not found: ${driverPath}`);
      }

      // Delete the .deb file
      await fs.unlink(driverPath);
      console.log(`Deleted driver package: ${driverPath}`);

      // Delete the .md5 file if it exists
      try {
        await fs.access(md5Path);
        await fs.unlink(md5Path);
        console.log(`Deleted MD5 file: ${md5Path}`);
      } catch (error) {
        // MD5 file doesn't exist, that's okay
        console.log(`No MD5 file found for: ${finalPackageName}`);
      }

      // Check if kernel version directory is empty
      const kernelDirPath = `/boot/optional/drivers/${category}/${kernelVersion}`;
      try {
        const filesInKernelDir = await fs.readdir(kernelDirPath);
        if (filesInKernelDir.length === 0) {
          await fs.rmdir(kernelDirPath);
          console.log(`Deleted empty kernel directory: ${kernelDirPath}`);

          // Check if category directory is empty
          const categoryDirPath = `/boot/optional/drivers/${category}`;
          try {
            const filesInCategoryDir = await fs.readdir(categoryDirPath);
            if (filesInCategoryDir.length === 0) {
              await fs.rmdir(categoryDirPath);
              console.log(`Deleted empty category directory: ${categoryDirPath}`);
            }
          } catch (error) {
            console.log(`Category directory not empty or could not be deleted: ${categoryDirPath}`);
          }
        }
      } catch (error) {
        console.log(`Kernel directory not empty or could not be deleted: ${kernelDirPath}`);
      }

      return {
        success: true,
        message: 'Driver deleted successfully',
        packagename: finalPackageName,
        drivername: drivername || null,
        driverversion: driverversion || null,
        category,
        kernelVersion,
        path: driverPath,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('Driver deletion error:', error.message);
      return {
        success: false,
        error: error.message,
        packagename: options.packagename || null,
        drivername: options.drivername || null,
        driverversion: options.driverversion || null,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Executes MOS installation to disk using the mos-install script
   * @param {string} disk - Disk device (e.g., /dev/sda)
   * @param {string} filesystem - Filesystem type (vfat, ext4, btrfs, xfs)
   * @param {boolean} extra_partition - Whether to create an extra partition (default: false)
   * @returns {Promise<Object>} Installation status
   */
  async installToDisk(disk, filesystem, extra_partition = false) {
    try {
      // Parameter validation
      if (!disk || typeof disk !== 'string') {
        throw new Error('disk parameter is required and must be a string');
      }

      if (!filesystem || typeof filesystem !== 'string') {
        throw new Error('filesystem parameter is required and must be a string');
      }

      // Filesystem validation
      const validFilesystems = ['vfat', 'ext4', 'btrfs', 'xfs'];
      if (!validFilesystems.includes(filesystem)) {
        throw new Error(`filesystem must be one of: ${validFilesystems.join(', ')}`);
      }

      // Build command: bash /usr/local/bin/mos-install disk filesystem quiet extra_partition
      const command = `bash /usr/local/bin/mos-install ${disk} ${filesystem} quiet ${extra_partition}`;

      // Execute script
      const { stdout, stderr } = await execPromise(command);

      return {
        success: true,
        message: 'MOS installation to disk initiated successfully',
        disk,
        filesystem,
        extra_partition,
        command,
        output: stdout,
        error: null,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('MOS installation to disk error:', error.message);
      return {
        success: false,
        error: error.message,
        disk: disk || null,
        filesystem: filesystem || null,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Reads a file from the filesystem
   * @param {string} filePath - Path to the file to read
   * @returns {Promise<Object>} Result object with file content and metadata
   */
  async readFile(filePath) {
    try {
      // Check if file exists and read it
      const content = await fs.readFile(filePath, 'utf8');

      return {
        success: true,
        path: filePath,
        content: content,
        size: Buffer.byteLength(content, 'utf8')
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`File does not exist: ${filePath}`);
      }
      console.error('Error reading file:', error.message);
      throw error;
    }
  }

  /**
   * Validates and returns metadata for a file download
   * @param {string} filePath - Absolute path to the file to download
   * @returns {Promise<Object>} File metadata for streaming (resolvedPath, filename, size, modified)
   */
  async getFileForDownload(filePath) {
    if (!filePath) {
      throw new Error('File path is required');
    }

    const resolvedPath = path.resolve(filePath);

    if (resolvedPath !== path.normalize(filePath)) {
      throw new Error('Invalid file path');
    }

    let stats;
    try {
      stats = await fs.stat(resolvedPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`File does not exist: ${filePath}`);
      }
      throw error;
    }

    if (stats.isDirectory()) {
      throw new Error(`Path is a directory, not a file: ${filePath}`);
    }

    return {
      resolvedPath,
      filename: path.basename(resolvedPath),
      size: stats.size,
      modified: stats.mtime
    };
  }

  /**
   * Uploads a file to the specified target directory
   * @param {string} targetDir - Absolute path to the target directory
   * @param {Object} file - express-fileupload file object (name, size, mv)
   * @returns {Promise<Object>} Upload result with file info
   */
  async uploadFile(targetDir, file) {
    if (!file) {
      throw new Error('No file provided');
    }

    const resolvedDir = path.resolve(targetDir);

    if (resolvedDir !== path.normalize(targetDir)) {
      throw new Error('Invalid target directory path');
    }

    let dirStats;
    try {
      dirStats = await fs.stat(resolvedDir);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`Target directory does not exist: ${targetDir}`);
      }
      throw error;
    }

    if (!dirStats.isDirectory()) {
      throw new Error(`Target path is not a directory: ${targetDir}`);
    }

    const finalPath = path.join(resolvedDir, file.name);

    await file.mv(finalPath);

    return {
      success: true,
      message: 'File uploaded successfully',
      file: {
        name: file.name,
        size: file.size,
        path: finalPath
      }
    };
  }

  /**
   * Edits a file on the filesystem
   * @param {string} filePath - Path to the file to edit
   * @param {string} content - New content for the file
   * @param {boolean} createBackup - Whether to create a backup file (default: false)
   * @returns {Promise<Object>} Result object with success status and optional backup path
   */
  async editFile(filePath, content, createBackup = false) {
    try {
      // Check if file exists
      try {
        await fs.access(filePath);
      } catch (error) {
        throw new Error(`File does not exist: ${filePath}`);
      }

      // Create backup if requested
      let backupPath = null;
      if (createBackup) {
        backupPath = `${filePath}.backup`;
        const originalContent = await fs.readFile(filePath, 'utf8');
        await fs.writeFile(backupPath, originalContent, 'utf8');
      }

      // Write new content to file
      await fs.writeFile(filePath, content, 'utf8');

      return {
        success: true,
        message: 'File edited successfully',
        backupPath: backupPath
      };
    } catch (error) {
      console.error('Error editing file:', error.message);
      throw error;
    }
  }

  /**
   * Rename a file or directory
   * @param {string} destination - Full path to the file or directory to rename
   * @param {string} new_name - New name (filename only, no path separators)
   * @returns {Promise<Object>} Result with old path, new path, and new name
   */
  async rename(destination, new_name) {
    if (!destination) {
      throw new Error('destination is required');
    }
    if (!new_name) {
      throw new Error('new_name is required');
    }

    // Prevent path traversal
    if (new_name.includes('/') || new_name.includes('\\') || new_name === '.' || new_name === '..') {
      throw new Error('new_name must be a simple filename without path separators');
    }

    // Validate Linux filename: only NUL (\0) and / are truly forbidden,
    // but we also reject control characters and other problematic characters
    const invalidCharsRegex = /[\x00-\x1f\x7f/\\:*?"<>|]/;
    if (invalidCharsRegex.test(new_name)) {
      throw new Error('new_name contains invalid characters. Forbidden: \\ / : * ? " < > | and control characters');
    }

    // Reject names that are only whitespace or start/end with spaces (common filesystem issues)
    if (new_name.trim() !== new_name || new_name.trim().length === 0) {
      throw new Error('new_name must not be empty or have leading/trailing whitespace');
    }

    const normalizedDest = path.resolve(destination);
    const currentName = path.basename(normalizedDest);

    // Check if new name is identical to current name
    if (new_name === currentName) {
      throw new Error('new_name is identical to the current name');
    }

    // Check destination exists
    try {
      await fs.stat(normalizedDest);
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new Error(`Path does not exist: ${normalizedDest}`);
      }
      throw e;
    }

    // Build new path (same parent directory, new name)
    const parentDir = path.dirname(normalizedDest);
    const newPath = path.join(parentDir, new_name);

    // Check new path doesn't already exist (skip for case-only changes on case-sensitive FS)
    const isCaseChangeOnly = new_name.toLowerCase() === currentName.toLowerCase();
    if (!isCaseChangeOnly) {
      try {
        await fs.access(newPath);
        throw new Error(`A file or directory with the name "${new_name}" already exists in ${parentDir}`);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }

    // Perform rename
    await fs.rename(normalizedDest, newPath);

    return {
      source: normalizedDest,
      destination: newPath,
      new_name: new_name
    };
  }

  /**
   * Gets the dashboard layout configuration
   * @returns {Promise<Object>} The dashboard layout with left, right columns and visibility
   */
  async getDashboardLayout() {
    try {
      const data = await fs.readFile(this.dashboardPath, 'utf8');
      const layout = JSON.parse(data);

      // Validate the structure
      if (typeof layout !== 'object' || layout === null || Array.isArray(layout)) {
        throw new Error('Dashboard layout must be an object with left, right, and visibility properties');
      }

      // Ensure interface key exists (default: eth0)
      if (!layout.interface || typeof layout.interface !== 'string') {
        layout.interface = 'eth0';
      }

      return layout;
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Return default empty layout if file doesn't exist
        return { left: [], right: [], visibility: {}, interface: 'eth0' };
      }
      throw error;
    }
  }

  /**
   * Updates the dashboard layout configuration
   * @param {Object} layout - Object with left, right arrays and visibility object
   * @returns {Promise<Object>} The updated dashboard layout
   */
  async updateDashboardLayout(layout) {
    try {
      // Validate input structure
      if (typeof layout !== 'object' || layout === null || Array.isArray(layout)) {
        throw new Error('Dashboard layout must be an object');
      }

      // Validate left array
      if (!Array.isArray(layout.left)) {
        throw new Error('Dashboard layout must have a "left" array');
      }

      // Validate right array
      if (!Array.isArray(layout.right)) {
        throw new Error('Dashboard layout must have a "right" array');
      }

      // Validate visibility object
      if (typeof layout.visibility !== 'object' || layout.visibility === null || Array.isArray(layout.visibility)) {
        throw new Error('Dashboard layout must have a "visibility" object');
      }

      // Validate cards in left and right arrays
      const validateCard = (card, position) => {
        if (!card.id || typeof card.id !== 'string') {
          throw new Error(`Each card in "${position}" must have an "id" property of type string`);
        }
        if (!card.name || typeof card.name !== 'string') {
          throw new Error(`Each card in "${position}" must have a "name" property of type string`);
        }
      };

      for (const card of layout.left) {
        validateCard(card, 'left');
      }
      for (const card of layout.right) {
        validateCard(card, 'right');
      }

      // Validate visibility values are booleans
      for (const [key, value] of Object.entries(layout.visibility)) {
        if (typeof value !== 'boolean') {
          throw new Error(`Visibility value for "${key}" must be a boolean`);
        }
      }

      // Read existing interface setting from file to preserve it if not provided
      let existingInterface = 'eth0';
      try {
        const existingData = await fs.readFile(this.dashboardPath, 'utf8');
        const existingLayout = JSON.parse(existingData);
        if (existingLayout.interface && typeof existingLayout.interface === 'string') {
          existingInterface = existingLayout.interface;
        }
      } catch (e) {
        // File doesn't exist or invalid, use default
      }

      // Normalize layout (preserve existing interface if not provided in update)
      const normalizedLayout = {
        left: layout.left.map(card => ({ id: card.id, name: card.name })),
        right: layout.right.map(card => ({ id: card.id, name: card.name })),
        visibility: { ...layout.visibility },
        interface: (layout.interface && typeof layout.interface === 'string') ? layout.interface : existingInterface
      };

      // Write to file
      await fs.writeFile(this.dashboardPath, JSON.stringify(normalizedLayout, null, 2), 'utf8');

      return normalizedLayout;
    } catch (error) {
      console.error('Error updating dashboard layout:', error.message);
      throw error;
    }
  }

  /**
   * Gets the dashboard network interface setting
   * @returns {Promise<string>} The interface name (default: 'eth0')
   */
  async getDashboardInterface() {
    try {
      const data = await fs.readFile(this.dashboardPath, 'utf8');
      const layout = JSON.parse(data);
      return (layout.interface && typeof layout.interface === 'string') ? layout.interface : 'eth0';
    } catch (error) {
      if (error.code === 'ENOENT') {
        return 'eth0';
      }
      throw error;
    }
  }

  /**
   * Updates the dashboard network interface setting
   * @param {string} interfaceName - The interface name to set (e.g. 'eth0', 'br0', 'bond0')
   * @returns {Promise<Object>} Object with the updated interface name
   */
  async updateDashboardInterface(interfaceName) {
    try {
      // Validate interface name
      if (!interfaceName || typeof interfaceName !== 'string') {
        throw new Error('Interface name must be a non-empty string');
      }

      // Validate interface name format (alphanumeric + dots for VLANs)
      if (!/^[a-zA-Z][a-zA-Z0-9.]*$/.test(interfaceName)) {
        throw new Error('Invalid interface name format');
      }

      // Read existing dashboard config
      let layout = {};
      try {
        const data = await fs.readFile(this.dashboardPath, 'utf8');
        layout = JSON.parse(data);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // File doesn't exist, start with defaults
        layout = { left: [], right: [], visibility: {} };
      }

      // Update interface
      layout.interface = interfaceName;

      // Write to file
      await fs.writeFile(this.dashboardPath, JSON.stringify(layout, null, 2), 'utf8');

      return { interface: interfaceName };
    } catch (error) {
      console.error('Error updating dashboard interface:', error.message);
      throw error;
    }
  }

  /**
   * Filesystem Navigator - Browse directories and files with optional virtual root
   * @param {string} requestPath - Path to browse
   * @param {string} type - "directories" or "all"
   * @param {Array<string>} allowedRoots - Optional array of allowed root directories for virtual root
   * @param {boolean} includeHidden - Whether to include hidden files/folders
   * @returns {Promise<Object>} Directory listing with items and navigation info
   */
  async browseFilesystem(requestPath, type = 'directories', allowedRoots = null, includeHidden = false, user = null) {
    const normalizedPath = requestPath?.trim() || '/';

    // If allowedRoots are specified, create a virtual root
    if (allowedRoots && allowedRoots.length > 0) {
      // Special case: Virtual Root (show only specified start directories)
      if (normalizedPath === '/' || normalizedPath === '') {
        return await this._getVirtualRoot(allowedRoots, type);
      }

      // Normal path: check if within allowed roots
      const resolvedPath = path.resolve(normalizedPath);

      if (!this._isWithinAllowedRoots(resolvedPath, allowedRoots)) {
        throw new Error('Path outside allowed directories');
      }

      // Browse real directory with virtual root boundary
      return await this._browseDirectory(resolvedPath, type, allowedRoots, includeHidden, user);
    }

    // No roots specified: Browse filesystem normally (full access)
    const resolvedPath = path.resolve(normalizedPath);

    // Browse without restrictions
    return await this._browseDirectory(resolvedPath, type, null, includeHidden, user);
  }

  /**
   * Returns virtual root with configured start directories
   * @private
   */
  async _getVirtualRoot(fsNavigatorRoots, type) {
    const items = [];

    for (const rootPath of fsNavigatorRoots) {
      try {
        const stats = await fs.stat(rootPath);
        if (stats.isDirectory()) {
          items.push({
            name: path.basename(rootPath) || rootPath,
            path: rootPath,
            type: 'directory',
            displayPath: rootPath
          });
        }
      } catch (error) {
        // Root doesn't exist or isn't accessible, skip it
        console.warn(`Filesystem navigator root ${rootPath} not accessible:`, error.message);
      }
    }

    return {
      isVirtualRoot: true,
      currentPath: '/',
      parentPath: null,
      canGoUp: false,
      items: items
    };
  }

  /**
   * Browse a real directory
   * @private
   */
  async _browseDirectory(dirPath, type, fsNavigatorRoots, includeHidden = false, user = null) {
    // Check if path exists
    let stats;
    try {
      stats = await fs.stat(dirPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('Path does not exist');
      }
      throw error;
    }

    if (!stats.isDirectory()) {
      throw new Error('Path is not a directory');
    }

    // Read directory contents
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    // Filter out hidden files/folders (starting with .) unless includeHidden is true
    // But keep ALL types for now (filter by type AFTER symlink resolution)
    let filteredEntries = entries;
    if (!includeHidden) {
      filteredEntries = entries.filter(e => !e.name.startsWith('.'));
    }

    // Local cache only for this directory call
    const localUserCache = new Map();
    const localGroupCache = new Map();

    // Create items with metadata
    const items = await Promise.all(
      filteredEntries.map(async (entry) => {
        const fullPath = path.join(dirPath, entry.name);
        let itemStats, linkStats;
        let isSymlink = false;
        let symlinkTarget = null;
        let resolvedType = null;

        try {
          // First, get lstat to detect symlinks (without following them)
          linkStats = await fs.lstat(fullPath);
          isSymlink = linkStats.isSymbolicLink();

          if (isSymlink) {
            // Get the symlink target
            try {
              symlinkTarget = await fs.readlink(fullPath);

              // Resolve relative symlinks to absolute paths
              if (!path.isAbsolute(symlinkTarget)) {
                symlinkTarget = path.resolve(path.dirname(fullPath), symlinkTarget);
              }

              // Get stats of the target to determine final type
              itemStats = await fs.stat(fullPath); // This follows the symlink
              resolvedType = itemStats.isDirectory() ? 'directory' : 'file';
            } catch (error) {
              // Broken symlink - use lstat data and mark as broken
              itemStats = linkStats;
              resolvedType = 'file'; // Default for broken symlinks
              symlinkTarget = symlinkTarget + ' (broken)';
            }
          } else {
            // Not a symlink, use regular stat
            itemStats = linkStats;
            resolvedType = entry.isDirectory() ? 'directory' : 'file';
          }
        } catch (error) {
          // Skip items that can't be accessed
          return null;
        }

        // Get permissions information (from the symlink itself, not the target)
        const mode = linkStats.mode;
        const octalPermissions = (mode & parseInt('777', 8)).toString(8).padStart(3, '0');

        // Get owner and group information with local caching (from the symlink itself)
        const owner = await this._getLocalUserName(linkStats.uid, localUserCache);
        const group = await this._getLocalGroupName(linkStats.gid, localGroupCache);

        return {
          name: entry.name,
          path: fullPath,
          type: resolvedType,
          size: (resolvedType === 'file' && itemStats.isFile()) ? itemStats.size : null,
          size_human: (resolvedType === 'file' && itemStats.isFile()) ? systemService.formatBytes(itemStats.size, user) : null,
          modified: itemStats.mtime,
          isSymlink: isSymlink,
          symlinkTarget: symlinkTarget,
          permissions: {
            octal: octalPermissions,
            owner: owner,
            group: group
          }
        };
      })
    );

    // Filter out null entries (inaccessible items)
    let validItems = items.filter(item => item !== null);

    // Apply type filtering AFTER symlink resolution
    if (type === 'directories') {
      validItems = validItems.filter(item => item.type === 'directory');
    }

    // Sort: directories first, then alphabetically
    validItems.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    // Determine parent path (with virtual root logic)
    const parentPath = this._getParentPath(dirPath, fsNavigatorRoots);

    return {
      isVirtualRoot: false,
      currentPath: dirPath,
      parentPath: parentPath,
      canGoUp: parentPath !== null,
      items: validItems
    };
  }

  /**
   * Check if path is within allowed roots
   * @private
   */
  _isWithinAllowedRoots(checkPath, fsNavigatorRoots) {
    return fsNavigatorRoots.some(root => {
      return checkPath === root || checkPath.startsWith(root + '/');
    });
  }

  /**
   * Get parent path with optional virtual root boundary
   * @private
   */
  _getParentPath(currentPath, fsNavigatorRoots) {
    // If no roots specified, allow normal navigation
    if (!fsNavigatorRoots || fsNavigatorRoots.length === 0) {
      if (currentPath === '/') {
        return null;  // Already at root
      }
      return path.dirname(currentPath);
    }

    // With virtual root: Check if we're at a root directory
    if (fsNavigatorRoots.includes(currentPath)) {
      return '/';  // Go back to virtual root
    }

    const parent = path.dirname(currentPath);

    // Check if parent is still within allowed roots
    if (this._isWithinAllowedRoots(parent, fsNavigatorRoots)) {
      return parent;
    }

    // Parent is outside allowed roots → go back to virtual root
    return '/';
  }

  /**
   * Get username with local caching (only for current directory call)
   * @private
   */
  async _getLocalUserName(uid, localCache) {
    if (localCache.has(uid)) {
      return localCache.get(uid);
    }

    let username;
    try {
      const { execSync } = require('child_process');
      username = execSync(`getent passwd ${uid} | cut -d: -f1`, {
        encoding: 'utf8',
        timeout: 1000
      }).trim();

      if (!username) {
        username = uid.toString();
      }
    } catch {
      username = uid.toString();
    }

    localCache.set(uid, username);
    return username;
  }

  /**
   * Get group name with local caching (only for current directory call)
   * @private
   */
  async _getLocalGroupName(gid, localCache) {
    if (localCache.has(gid)) {
      return localCache.get(gid);
    }

    let groupname;
    try {
      const { execSync } = require('child_process');
      groupname = execSync(`getent group ${gid} | cut -d: -f1`, {
        encoding: 'utf8',
        timeout: 1000
      }).trim();

      if (!groupname) {
        groupname = gid.toString();
      }
    } catch {
      groupname = gid.toString();
    }

    localCache.set(gid, groupname);
    return groupname;
  }

  // ============================================================
  // TOKEN MANAGEMENT METHODS (github, dockerhub, etc.)
  // ============================================================

  /**
   * Encrypt token using JWT_SECRET
   * @param {string} plainToken - Plain text token
   * @returns {string} Encrypted token in format "iv:authTag:encrypted"
   * @private
   */
  _encryptToken(plainToken) {
    if (!plainToken) return '';

    const algorithm = 'aes-256-gcm';
    const key = crypto.scryptSync(process.env.JWT_SECRET, 'tokens-salt', 32);
    const iv = crypto.randomBytes(16);

    const cipher = crypto.createCipheriv(algorithm, key, iv);
    cipher.setAAD(Buffer.from('tokens-auth'));

    let encrypted = cipher.update(plainToken, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  /**
   * Decrypt token using JWT_SECRET
   * @param {string} encryptedToken - Encrypted token in format "iv:authTag:encrypted"
   * @returns {string} Plain text token
   * @private
   */
  _decryptToken(encryptedToken) {
    if (!encryptedToken) return '';

    try {
      const [ivHex, authTagHex, encrypted] = encryptedToken.split(':');
      if (!ivHex || !authTagHex || !encrypted) {
        throw new Error('Invalid encrypted token format');
      }

      const algorithm = 'aes-256-gcm';
      const key = crypto.scryptSync(process.env.JWT_SECRET, 'tokens-salt', 32);
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');

      const decipher = crypto.createDecipheriv(algorithm, key, iv);
      decipher.setAuthTag(authTag);
      decipher.setAAD(Buffer.from('tokens-auth'));

      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      throw new Error(`Failed to decrypt token: ${error.message}`);
    }
  }

  /**
   * Get all tokens (decrypted)
   * GET /mos/tokens
   * @returns {Promise<Object>} Object with token keys (github, dockerhub, etc.) - all decrypted
   */
  async getTokens() {
    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(this.tokensPath), { recursive: true });

      const data = await fs.readFile(this.tokensPath, 'utf8');
      const config = JSON.parse(data);

      // Decrypt all tokens before returning
      const decryptedTokens = {};
      for (const [key, encryptedValue] of Object.entries(config)) {
        decryptedTokens[key] = encryptedValue ? this._decryptToken(encryptedValue) : null;
      }

      return decryptedTokens;
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File doesn't exist, return empty object
        return { github: null, dockerhub: null };
      }
      throw new Error(`Failed to get tokens: ${error.message}`);
    }
  }

  /**
   * Update tokens (encrypted) - supports partial updates
   * POST /mos/tokens
   * @param {Object} tokens - Object with token keys to update (e.g., {github: "...", dockerhub: "..."})
   * @returns {Promise<Object>} Success confirmation
   */
  async updateTokens(tokens) {
    try {
      if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
        throw new Error('Tokens must be an object');
      }

      // Ensure directory exists
      await fs.mkdir(path.dirname(this.tokensPath), { recursive: true });

      // Load existing tokens
      let existingConfig = {};
      try {
        const data = await fs.readFile(this.tokensPath, 'utf8');
        existingConfig = JSON.parse(data);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
        // File doesn't exist yet, start with empty config
      }

      // Update only the provided tokens (partial update)
      for (const [key, plainValue] of Object.entries(tokens)) {
        if (plainValue === null || plainValue === undefined || plainValue === '') {
          // Allow setting to null to remove a token
          existingConfig[key] = null;
        } else {
          // Encrypt and store the token
          existingConfig[key] = this._encryptToken(plainValue);
        }
      }

      await fs.writeFile(
        this.tokensPath,
        JSON.stringify(existingConfig, null, 2),
        'utf8'
      );

      return {
        success: true,
        message: 'Tokens updated successfully',
        updated: Object.keys(tokens)
      };
    } catch (error) {
      throw new Error(`Failed to update tokens: ${error.message}`);
    }
  }

  /**
   * Get GitHub rate limit (works with or without token)
   * @param {string|null} token - GitHub token or null for anonymous
   * @returns {Promise<Object>} Rate limit info
   * @private
   */
  async _getGitHubRateLimit(token) {
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'MOS-API'
    };

    if (token) {
      headers['Authorization'] = `token ${token}`;
    }

    const response = await axios.get('https://api.github.com/rate_limit', {
      headers,
      timeout: 10000
    });

    return response.data.rate;
  }

  /**
   * Get DockerHub rate limit (works with or without auth)
   * @param {string|null} authString - Base64 encoded "username:token" or null for anonymous
   * @returns {Promise<Object|null>} Rate limit info or null if unavailable
   * @private
   */
  async _getDockerHubRateLimit(authString) {
    try {
      const tokenHeaders = authString
        ? { 'Authorization': `Basic ${authString}` }
        : {};

      const tokenResponse = await axios.get(
        'https://auth.docker.io/token?service=registry.docker.io&scope=repository:ratelimitpreview/test:pull',
        { headers: tokenHeaders, timeout: 10000 }
      );

      if (!tokenResponse.data?.token) {
        return null;
      }

      const registryResponse = await axios.head(
        'https://registry-1.docker.io/v2/ratelimitpreview/test/manifests/latest',
        {
          headers: { 'Authorization': `Bearer ${tokenResponse.data.token}` },
          timeout: 10000,
          validateStatus: () => true
        }
      );

      const limitHeader = registryResponse.headers['ratelimit-limit'];
      const remainingHeader = registryResponse.headers['ratelimit-remaining'];

      if (limitHeader || remainingHeader) {
        return {
          limit: limitHeader ? parseInt(limitHeader.split(';')[0]) : null,
          remaining: remainingHeader ? parseInt(remainingHeader.split(';')[0]) : null
        };
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Validate tokens (github, dockerhub)
   * GET /mos/validatetokens
   * @returns {Promise<Object>} Validation results for each token (always includes rate limits)
   */
  async validateTokens() {
    const tokens = await this.getTokens();
    const result = {
      github: null,
      dockerhub: null
    };

    const hasGithub = tokens.github && tokens.github.trim() !== '';
    const hasDockerHub = tokens.dockerhub && tokens.dockerhub.trim() !== '';

    // Validate GitHub token or get anonymous rate limit
    if (hasGithub) {
      try {
        const rate = await this._getGitHubRateLimit(tokens.github);
        result.github = {
          configured: true,
          valid: true,
          rate
        };
      } catch (error) {
        // Token invalid - get anonymous rate limit instead
        let anonymousRate = null;
        try {
          anonymousRate = await this._getGitHubRateLimit(null);
        } catch (anonError) {
          // Could not get anonymous rate either
        }

        result.github = {
          configured: true,
          valid: false,
          error: error.response?.status === 401
            ? 'Invalid or expired token'
            : error.message,
          rate: anonymousRate
        };
      }
    } else {
      // No token configured - get anonymous rate limit
      let anonymousRate = null;
      try {
        anonymousRate = await this._getGitHubRateLimit(null);
      } catch (error) {
        // Could not get anonymous rate
      }

      result.github = {
        configured: false,
        valid: null,
        rate: anonymousRate
      };
    }

    // Validate DockerHub token or get anonymous rate limit
    if (hasDockerHub) {
      const [username, token] = tokens.dockerhub.split(':');
      if (!username || !token) {
        // Invalid format - get anonymous rate limit
        const anonymousRate = await this._getDockerHubRateLimit(null);
        result.dockerhub = {
          configured: true,
          valid: false,
          error: 'Invalid format. Expected "username:token"',
          rate: anonymousRate
        };
      } else {
        try {
          // Use Docker Hub API to validate - check user info
          const authString = Buffer.from(`${username}:${token}`).toString('base64');
          const response = await axios.get(`https://hub.docker.com/v2/users/${username}/`, {
            headers: {
              'Authorization': `Basic ${authString}`,
              'Accept': 'application/json'
            },
            timeout: 10000
          });

          // Get rate limit with auth
          const rate = await this._getDockerHubRateLimit(authString);

          result.dockerhub = {
            configured: true,
            valid: true,
            username: response.data?.username || username,
            rate
          };
        } catch (error) {
          // Token invalid - get anonymous rate limit
          const anonymousRate = await this._getDockerHubRateLimit(null);

          result.dockerhub = {
            configured: true,
            valid: false,
            error: error.response?.status === 401 || error.response?.status === 403
              ? 'Invalid or expired token'
              : error.message,
            rate: anonymousRate
          };
        }
      }
    } else {
      // No token configured - get anonymous rate limit
      const anonymousRate = await this._getDockerHubRateLimit(null);

      result.dockerhub = {
        configured: false,
        valid: null,
        rate: anonymousRate
      };
    }

    return result;
  }

  /**
   * Creates a new file on the filesystem
   * @param {string} filePath - Path to the file to create
   * @param {string} content - Content for the new file (default: empty)
   * @param {Object} options - Optional settings
   * @param {string} options.user - User ID or username (default: '500')
   * @param {string} options.group - Group ID or group name (default: '500')
   * @param {string} options.permissions - File permissions in octal (default: '777')
   * @returns {Promise<Object>} Result object with success status
   */
  async createFile(filePath, content = '', options = {}) {
    const { user = '500', group = '500', permissions = '777' } = options;

    try {
      // Check if file or folder already exists at this path
      try {
        const stats = await fs.stat(filePath);
        if (stats.isDirectory()) {
          throw new Error(`Path already exists as a directory: ${filePath}`);
        } else {
          throw new Error(`File already exists: ${filePath}`);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
        // Path doesn't exist, continue
      }

      // Ensure parent directory exists
      const parentDir = path.dirname(filePath);
      await fs.mkdir(parentDir, { recursive: true });

      // Write the file
      await fs.writeFile(filePath, content, 'utf8');

      // Set ownership (chown)
      await execPromise(`chown ${user}:${group} "${filePath}"`);

      // Set permissions (chmod)
      await execPromise(`chmod ${permissions} "${filePath}"`);

      return {
        success: true,
        message: 'File created successfully',
        path: filePath,
        user: user,
        group: group,
        permissions: permissions
      };
    } catch (error) {
      console.error('Error creating file:', error.message);
      throw error;
    }
  }

  /**
   * Creates a new folder on the filesystem
   * @param {string} folderPath - Path to the folder to create
   * @param {Object} options - Optional settings
   * @param {string} options.user - User ID or username (default: '500')
   * @param {string} options.group - Group ID or group name (default: '500')
   * @param {string} options.permissions - Folder permissions in octal (default: '777')
   * @returns {Promise<Object>} Result object with success status
   */
  async createFolder(folderPath, options = {}) {
    const { user = '500', group = '500', permissions = '777' } = options;

    try {
      // Check if folder already exists
      try {
        const stats = await fs.stat(folderPath);
        if (stats.isDirectory()) {
          throw new Error(`Folder already exists: ${folderPath}`);
        } else {
          throw new Error(`Path exists but is not a directory: ${folderPath}`);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
        // Folder doesn't exist, continue
      }

      // Create the folder (including parents if needed)
      await fs.mkdir(folderPath, { recursive: true });

      // Set ownership (chown)
      await execPromise(`chown ${user}:${group} "${folderPath}"`);

      // Set permissions (chmod)
      await execPromise(`chmod ${permissions} "${folderPath}"`);

      return {
        success: true,
        message: 'Folder created successfully',
        path: folderPath,
        user: user,
        group: group,
        permissions: permissions
      };
    } catch (error) {
      console.error('Error creating folder:', error.message);
      throw error;
    }
  }

  /**
   * Change ownership of a file or folder
   * @param {string} itemPath - Path to the file or folder
   * @param {Object} options - Optional settings
   * @param {string} options.user - User ID or username (default: '500')
   * @param {string} options.group - Group ID or group name (default: '500')
   * @param {boolean} options.recursive - Apply recursively (default: false)
   * @returns {Promise<Object>} Result object with success status
   */
  async chown(itemPath, options = {}) {
    const { user = '500', group = '500', recursive = false } = options;

    try {
      // Check if path exists
      try {
        await fs.stat(itemPath);
      } catch (error) {
        if (error.code === 'ENOENT') {
          throw new Error(`Path does not exist: ${itemPath}`);
        }
        throw error;
      }

      // Build chown command
      const recursiveFlag = recursive ? '-R ' : '';
      await execPromise(`chown ${recursiveFlag}${user}:${group} "${itemPath}"`);

      return {
        success: true,
        message: 'Ownership changed successfully',
        path: itemPath,
        user: user,
        group: group,
        recursive: recursive
      };
    } catch (error) {
      console.error('Error changing ownership:', error.message);
      throw error;
    }
  }

  /**
   * Change permissions of a file or folder
   * @param {string} itemPath - Path to the file or folder
   * @param {Object} options - Optional settings
   * @param {string} options.permissions - Permissions in octal format (default: '777')
   * @param {boolean} options.recursive - Apply recursively (default: false)
   * @returns {Promise<Object>} Result object with success status
   */
  async chmod(itemPath, options = {}) {
    const { permissions = '777', recursive = false } = options;

    try {
      // Check if path exists
      try {
        await fs.stat(itemPath);
      } catch (error) {
        if (error.code === 'ENOENT') {
          throw new Error(`Path does not exist: ${itemPath}`);
        }
        throw error;
      }

      // Build chmod command
      const recursiveFlag = recursive ? '-R ' : '';
      await execPromise(`chmod ${recursiveFlag}${permissions} "${itemPath}"`);

      return {
        success: true,
        message: 'Permissions changed successfully',
        path: itemPath,
        permissions: permissions,
        recursive: recursive
      };
    } catch (error) {
      console.error('Error changing permissions:', error.message);
      throw error;
    }
  }

  /**
   * Deletes a file or folder from the filesystem
   * @param {string} itemPath - Path to the file or folder to delete
   * @param {Object} options - Optional settings
   * @param {boolean} options.force - Force deletion (ignore nonexistent files, default: true)
   * @param {boolean} options.recursive - Recursively delete directories (default: false)
   * @returns {Promise<Object>} Result object with success status
   */
  async deleteItem(itemPath, options = {}) {
    const { force = true, recursive = false } = options;

    try {
      // Check if path exists
      let stats;
      try {
        stats = await fs.stat(itemPath);
      } catch (error) {
        if (error.code === 'ENOENT') {
          if (force) {
            return {
              success: true,
              message: 'Item does not exist (force mode)',
              path: itemPath
            };
          }
          throw new Error(`Path does not exist: ${itemPath}`);
        }
        throw error;
      }

      const isDirectory = stats.isDirectory();

      if (isDirectory) {
        // Check if directory is empty when recursive is false
        if (!recursive) {
          const contents = await fs.readdir(itemPath);
          if (contents.length > 0) {
            throw new Error(`Directory is not empty. Use recursive: true to delete non-empty directories: ${itemPath}`);
          }
          // Empty directory, use rmdir
          await fs.rmdir(itemPath);
        } else {
          // Recursive delete
          await fs.rm(itemPath, { recursive: true, force: force });
        }
      } else {
        // It's a file
        if (force) {
          await fs.rm(itemPath, { force: true });
        } else {
          await fs.unlink(itemPath);
        }
      }

      return {
        success: true,
        message: isDirectory ? 'Folder deleted successfully' : 'File deleted successfully',
        path: itemPath,
        type: isDirectory ? 'directory' : 'file',
        recursive: recursive,
        force: force
      };
    } catch (error) {
      console.error('Error deleting item:', error.message);
      throw error;
    }
  }
}

module.exports = new MosService();
