const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const PoolsService = require('./pools.service');

class SharesService {
  constructor() {
    this.sharesConfigPath = '/boot/config/shares.json';
    this.poolsConfigPath = '/boot/config/pools.json';
  }

  /**
   * Restart SMB daemon
   * @returns {Promise<boolean>} Success status
   */
  async _restartSmbd() {
    try {
      await execAsync('/etc/init.d/smbd restart');
      return true;
    } catch (error) {
      console.error(`Error restarting SMB daemon: ${error.message}`);
      // Do not treat as critical error - Share was still created/deleted
      return false;
    }
  }

  /**
   * Restart NFS daemon
   * @returns {Promise<boolean>} Success status
   */
  async _restartNfsd() {
    try {
      // Devuan/SysV init - Regenerate exports and reload NFS server
      await execAsync('/etc/init.d/nfs-kernel-server restart');
      return true;
    } catch (error) {
      console.error(`Error restarting NFS daemon: ${error.message}`);
      // Do not treat as critical error - Share was still created/deleted
      return false;
    }
  }

  /**
   * Get shares configuration from /boot/config/shares.json
   * @returns {Promise<Object>} Shares configuration
   */
  async getShares() {
    try {
      // Check if the file exists
      await fs.access(this.sharesConfigPath);

      // Read the shares.json file
      const sharesData = await fs.readFile(this.sharesConfigPath, 'utf8');

      // Parse JSON and return
      const sharesConfig = JSON.parse(sharesData);

      // Simple validation: Make sure it's an array
      if (!Array.isArray(sharesConfig)) {
        throw new Error(`Invalid shares configuration format: Expected array, got ${typeof sharesConfig}`);
      }

      // Enrich shares with pool information (API-only, not persisted)
      sharesConfig.forEach(section => {
        Object.keys(section).forEach(shareType => {
          if (Array.isArray(section[shareType])) {
            section[shareType] = section[shareType].map(share =>
              this._enrichShareWithPoolInfo(share)
            );
          }
        });
      });

      return sharesConfig;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`Shares configuration file not found at ${this.sharesConfigPath}`);
      } else if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in shares configuration file: ${error.message}`);
      } else if (error.code === 'EACCES') {
        throw new Error(`Permission denied reading shares configuration file`);
      } else {
        throw new Error(`Error reading shares configuration: ${error.message}`);
      }
    }
  }

  /**
   * Get SMB shares specifically
   * @returns {Promise<Array>} SMB shares only
   */
  async getSmbShares() {
    try {
      const sharesConfig = await this.getShares();

      // Extract only SMB shares
      let smbShares = [];
      if (sharesConfig && Array.isArray(sharesConfig)) {
        // Go through the array and find SMB entries
        sharesConfig.forEach(item => {
          if (item.smb && Array.isArray(item.smb)) {
            smbShares = smbShares.concat(item.smb);
          }
        });
      }

      // Pool info is already enriched in getShares()
      return smbShares;
    } catch (error) {
      throw error; // Re-throw to preserve the original error
    }
  }

  /**
   * Get NFS shares specifically
   * @returns {Promise<Array>} NFS shares only
   */
  async getNfsShares() {
    try {
      const sharesConfig = await this.getShares();

      // Extract only NFS shares
      let nfsShares = [];
      if (sharesConfig && Array.isArray(sharesConfig)) {
        // Go through the array and find NFS entries
        sharesConfig.forEach(item => {
          if (item.nfs && Array.isArray(item.nfs)) {
            nfsShares = nfsShares.concat(item.nfs);
          }
        });
      }

      // Pool info is already enriched in getShares()
      return nfsShares;
    } catch (error) {
      throw error; // Re-throw to preserve the original error
    }
  }

  /**
   * Get shares info/stats
   * @returns {Promise<Object>} Shares statistics
   */
  async getSharesInfo() {
    try {
      const sharesConfig = await this.getShares();

      let totalShares = 0;
      let enabledShares = 0;
      let shareTypes = {};

      if (sharesConfig && Array.isArray(sharesConfig)) {
        sharesConfig.forEach(item => {
          Object.keys(item).forEach(shareType => {
            if (!shareTypes[shareType]) {
              shareTypes[shareType] = 0;
            }

            if (Array.isArray(item[shareType])) {
              item[shareType].forEach(share => {
                totalShares++;
                shareTypes[shareType]++;

                if (share && share.enabled === true) {
                  enabledShares++;
                }
              });
            }
          });
        });
      }

      return {
        success: true,
        data: {
          total: totalShares,
          enabled: enabledShares,
          disabled: totalShares - enabledShares,
          types: shareTypes
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get available pools for share creation
   * @returns {Promise<Array>} Available mounted pools
   */
  async getAvailablePools() {
    try {
      const poolsService = new PoolsService();
      const pools = await poolsService.listPools({});

      // Filter only mounted pools
      const availablePools = pools
        .filter(pool => pool.status && pool.status.mounted)
        .map(pool => ({
          name: pool.name,
          id: pool.id,
          type: pool.type,
          mountPath: `/mnt/${pool.name}`,
          totalSpace: pool.status.totalSpace,
          freeSpace: pool.status.freeSpace,
          health: pool.status.health
        }));

      return {
        success: true,
        data: availablePools,
        count: availablePools.length,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      throw new Error(`Error getting available pools: ${error.message}`);
    }
  }

  /**
   * Validate pool exists and is mounted
   * @param {string} poolName - Name of the pool
   * @returns {Promise<Object>} Pool information
   */
  async _validatePool(poolName) {
    try {
      const mountPath = `/mnt/${poolName}`;

      // Simple check: is the mount path accessible and mounted?
      try {
        await fs.access(mountPath);

        // Check if it's actually a mount point by checking /proc/mounts
        const { stdout } = await execAsync('cat /proc/mounts');
        const lines = stdout.split('\n');

        let isMounted = false;
        for (const line of lines) {
          if (line.trim()) {
            const parts = line.split(' ');
            if (parts.length >= 2 && parts[1] === mountPath) {
              isMounted = true;
              break;
            }
          }
        }

        if (!isMounted) {
          throw new Error(`Pool ${poolName} is not mounted`);
        }

      } catch (error) {
        if (error.code === 'ENOENT') {
          throw new Error(`Pool mount path ${mountPath} does not exist`);
        }
        throw error;
      }

      return {
        name: poolName,
        mountPath
      };
    } catch (error) {
      throw new Error(`Pool validation failed: ${error.message}`);
    }
  }

  /**
   * Extract pool name from share path
   * @param {string} sharePath - Full path to the share
   * @returns {string|null} Pool name or null if not extractable
   */
  _extractPoolNameFromPath(sharePath) {
    try {
      const pathSegments = sharePath.split('/');
      if (pathSegments.length >= 3 && pathSegments[1] === 'mnt') {
        return pathSegments[2];
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Enrich share with pool information (for GET requests only, not persisted)
   * @param {Object} share - Share configuration object
   * @returns {Object} Share with pool information
   */
  _enrichShareWithPoolInfo(share) {
    if (!share || !share.path) {
      return share;
    }

    // Ensure allow_execute_always is always present for SMB shares (default: false)
    if (share.allow_execute_always === undefined) {
      share.allow_execute_always = false;
    }

    // Check if path starts with /mnt/
    if (share.path.startsWith('/mnt/')) {
      const poolName = this._extractPoolNameFromPath(share.path);
      if (poolName) {
        // Add pool info (not persisted, only for API response)
        share.pool = poolName;
      }
    }

    return share;
  }

  /**
   * Extract relative path from share path
   * @param {string} sharePath - Full path to the share
   * @param {string} poolName - Pool name
   * @returns {string} Relative path
   */
  _extractRelativePathFromShare(sharePath, poolName) {
    const poolPath = `/mnt/${poolName}`;
    if (sharePath.startsWith(poolPath)) {
      const relativePath = sharePath.substring(poolPath.length);
      return relativePath || '/';
    }
    return '/';
  }

  /**
   * Create default SMB share configuration
   * @param {string} shareName - Name of the share
   * @param {string} sharePath - Full path to the share
   * @param {Object} options - Share options
   * @returns {Object} SMB share configuration
   */
  _createSmbShareConfig(shareName, sharePath, options = {}) {
    const {
      automount = false,
      enabled = true,
      read_only = false,
      guest_ok = false,
      browseable = true,
      write_list = [],
      valid_users = [],
      force_root = false,
      create_mask = "0664",
      directory_mask = "0775",
      inherit_permissions = true,
      hide_dot_files = false,
      preserve_case = true,
      case_sensitive = true,
      allow_execute_always = false,
      comment = null,
      policies = [],
      target_devices = null
    } = options;

    // Process write_list and valid_users arrays
    const processedWriteList = Array.isArray(write_list) ? write_list : [write_list].filter(Boolean);
    const processedValidUsers = Array.isArray(valid_users) ? valid_users : [valid_users].filter(Boolean);

    const shareConfig = {
      id: Date.now().toString(),
      name: shareName,
      path: sharePath,
      automount,
      enabled,
      read_only,
      guest_ok,
      browseable,
      write_list: guest_ok ? [] : processedWriteList, // Clear write_list if guest access is enabled
      valid_users: guest_ok ? [] : processedValidUsers, // Clear valid_users if guest access is enabled
      force_root,
      create_mask,
      directory_mask,
      inherit_permissions,
      hide_dot_files,
      preserve_case,
      case_sensitive,
      allow_execute_always,
      comment,
      policies: Array.isArray(policies) ? policies : []
    };

    return shareConfig;
  }

  /**
   * Create default NFS share configuration
   * @param {string} shareName - Name of the share
   * @param {string} sharePath - Full path to the share
   * @param {Object} options - Share options
   * @returns {Object} NFS share configuration
   */
  _createNfsShareConfig(shareName, sharePath, options = {}) {
    const {
      source = "192.168.1.0/24",
      enabled = true,
      read_only = false,
      anonuid = null,
      anongid = null,
      write_operations = "sync",
      mapping = "root_squash",
      secure = true,
      target_devices = null
    } = options;

    const shareConfig = {
      id: Date.now().toString(),
      name: shareName,
      path: sharePath,
      source,
      enabled,
      read_only,
      anonuid,
      anongid,
      write_operations,
      mapping,
      secure
    };

    return shareConfig;
  }

  /**
   * Create a new SMB share with optional disk slot specification for MergerFS pools
   * @param {string} shareName - Name of the share
   * @param {string|null} poolName - Name of the pool (or null for absolute paths)
   * @param {string} subPath - Sub-path within the pool OR absolute path if poolName is null
   * @param {Object} options - Share configuration options
   * @param {string} options.permissions - Directory permissions in octal format (default: '0775')
   * @returns {Promise<Object>} Created share configuration
   */
  async createSmbShare(shareName, poolName, subPath = '', options = {}) {
    try {
      let sharePath;
      let poolConfig = null;
      let diskResults = null;
      let pathRuleCreated = false;
      let isAbsolutePath = false;

      // Check if poolName is null or empty -> absolute path mode
      if (!poolName || poolName === null || poolName === '') {
        isAbsolutePath = true;

        // In absolute path mode, subPath must be an absolute path
        if (!subPath || !path.isAbsolute(subPath)) {
          throw new Error('When no pool is specified, an absolute path must be provided');
        }

        sharePath = subPath;

        // Verify that the directory exists
        try {
          await fs.access(sharePath);
          const stats = await fs.stat(sharePath);
          if (!stats.isDirectory()) {
            throw new Error(`Path '${sharePath}' exists but is not a directory`);
          }
        } catch (error) {
          if (error.code === 'ENOENT') {
            throw new Error(`Absolute path '${sharePath}' does not exist. Directory must exist when using absolute paths.`);
          }
          throw error;
        }

        // No pool validation, no directory creation, no permission changes in absolute path mode
        console.log(`Using absolute path mode for share '${shareName}': ${sharePath}`);

      } else {
        // Pool-based mode (existing logic)
        // Validate pool
        const pool = await this._validatePool(poolName);

        // Get pool information for extended functionality
        try {
          poolConfig = await this._getPoolByName(poolName);
        } catch (error) {
          // Pool configuration not found - use fallback
          console.warn(`Could not load pool configuration for '${poolName}': ${error.message}`);
        }

        // Extended functionality for MergerFS pools
        if (poolConfig && poolConfig.type === 'mergerfs' && options.target_devices && Array.isArray(options.target_devices)) {
          // Validate that the specified disk slots exist
          await this._validateDiskSlots(poolName, options.target_devices);

          // Create directories on the specified disk slots
          if (options.createDirectories !== false) {
            diskResults = await this._createDiskDirectories(poolName, subPath, options.target_devices, {
              createDirectories: true,
              setOwnership: true
            });

            // Check if all directories were successfully created
            const failedCreations = Object.keys(diskResults).filter(slot => !diskResults[slot].success);
            if (failedCreations.length > 0) {
              const failureDetails = failedCreations.map(slot =>
                `Slot ${slot}: ${diskResults[slot].error}`
              ).join('; ');
              throw new Error(`Failed to create directories on some disk slots: ${failureDetails}`);
            }
          }

          // Create or update path_rule for this share
          if (options.managePathRules !== false) {
            const rulePath = subPath.startsWith('/') ? subPath : `/${subPath}`;
            try {
              const pathRuleResult = await this.addOrUpdatePathRule(poolName, rulePath, options.target_devices);
              pathRuleCreated = true;
            } catch (pathRuleError) {
              console.warn(`Could not create path rule: ${pathRuleError.message}`);
            }
          }
        }

        // Create full share path (default behavior)
        sharePath = path.join(pool.mountPath, subPath).replace(/\/+/g, '/');

        // Check if the share path already exists or should be created (default behavior)
        if (options.createDirectory !== false && (!poolConfig || poolConfig.type !== 'mergerfs' || !options.target_devices)) {
          try {
            await fs.mkdir(sharePath, { recursive: true });

            // Set ownership to 500:500 (user:group)
            try {
              await execAsync(`chown 500:500 "${sharePath}"`);
            } catch (chownError) {
              // Do nothing
            }

            // Set permissions (default: 0775 = rwxrwxr-x)
            const permissions = options.permissions || '0775';
            try {
              await execAsync(`chmod ${permissions} "${sharePath}"`);
            } catch (chmodError) {
              // Do nothing
            }
          } catch (error) {
            throw new Error(`Could not create share directory ${sharePath}: ${error.message}`);
          }
        } else if (options.createDirectory === false) {
          // Check if path exists
          try {
            await fs.access(sharePath);
          } catch (error) {
            throw new Error(`Share path ${sharePath} does not exist`);
          }
        }
      }

      // Load current shares configuration
      let sharesConfig;
      try {
        sharesConfig = await this.getShares();
      } catch (error) {
        // If file does not exist, create empty configuration
        sharesConfig = [{ smb: [], nfs: [] }];
      }

      // Ensure correct structure: single object with smb and nfs keys
      if (sharesConfig.length === 0) {
        sharesConfig = [{ smb: [], nfs: [] }];
      }

      // Check if share name already exists (only within SMB shares)
      if (this._shareExists(sharesConfig, shareName, 'smb')) {
        throw new Error(`SMB share with name '${shareName}' already exists`);
      }

      // Create SMB share configuration
      const smbConfig = this._createSmbShareConfig(shareName, sharePath, options);

      // Add smb key to first object if not present
      if (!sharesConfig[0].smb) {
        sharesConfig[0].smb = [];
      }

      // Add new share to SMB array
      sharesConfig[0].smb.push(smbConfig);

      // Save configuration
      await this._saveShares(sharesConfig);

      // Restart SMB daemon
      const smbRestartSuccess = await this._restartSmbd();

      // Build response object
      const result = {
        success: true,
        message: `SMB share '${shareName}' created successfully${smbRestartSuccess ? ' and SMB restarted' : ' (SMB restart failed)'}`,
        data: {
          shareName,
          sharePath,
          poolName: poolName || null,
          isAbsolutePath,
          config: smbConfig
        },
        smbRestarted: smbRestartSuccess,
        timestamp: new Date().toISOString()
      };

      // Add extended information for MergerFS pools
      if (poolConfig && poolConfig.type === 'mergerfs' && options.target_devices) {
        result.data.mergerfsDetails = {
          poolType: poolConfig.type,
          target_devices: options.target_devices,
          diskDirectories: diskResults,
          pathRuleCreated
        };

        if (diskResults) {
          result.data.mergerfsDetails.createdPaths = Object.keys(diskResults)
            .filter(slot => diskResults[slot].success)
            .map(slot => diskResults[slot].path);
        }
      }

      return result;

    } catch (error) {
      throw new Error(`Error creating SMB share: ${error.message}`);
    }
  }

  /**
   * Create a new NFS share with optional disk slot specification for MergerFS pools
   * @param {string} shareName - Name of the share
   * @param {string|null} poolName - Name of the pool (or null for absolute paths)
   * @param {string} subPath - Sub-path within the pool OR absolute path if poolName is null
   * @param {Object} options - Share configuration options
   * @param {string} options.permissions - Directory permissions in octal format (default: '0775')
   * @returns {Promise<Object>} Created share configuration
   */
  async createNfsShare(shareName, poolName, subPath = '', options = {}) {
    try {
      let sharePath;
      let poolConfig = null;
      let diskResults = null;
      let pathRuleCreated = false;
      let isAbsolutePath = false;

      // Check if poolName is null or empty -> absolute path mode
      if (!poolName || poolName === null || poolName === '') {
        isAbsolutePath = true;

        // In absolute path mode, subPath must be an absolute path
        if (!subPath || !path.isAbsolute(subPath)) {
          throw new Error('When no pool is specified, an absolute path must be provided');
        }

        sharePath = subPath;

        // Verify that the directory exists
        try {
          await fs.access(sharePath);
          const stats = await fs.stat(sharePath);
          if (!stats.isDirectory()) {
            throw new Error(`Path '${sharePath}' exists but is not a directory`);
          }
        } catch (error) {
          if (error.code === 'ENOENT') {
            throw new Error(`Absolute path '${sharePath}' does not exist. Directory must exist when using absolute paths.`);
          }
          throw error;
        }

        // No pool validation, no directory creation, no permission changes in absolute path mode
        console.log(`Using absolute path mode for share '${shareName}': ${sharePath}`);

      } else {
        // Pool-based mode (existing logic)
        // Validate pool
        const pool = await this._validatePool(poolName);

        // Get pool information for extended functionality
        try {
          poolConfig = await this._getPoolByName(poolName);
        } catch (error) {
          // Pool configuration not found - use fallback
          console.warn(`Could not load pool configuration for '${poolName}': ${error.message}`);
        }

        // Extended functionality for MergerFS pools
        if (poolConfig && poolConfig.type === 'mergerfs' && options.target_devices && Array.isArray(options.target_devices)) {
          // Validate that the specified disk slots exist
          await this._validateDiskSlots(poolName, options.target_devices);

          // Create directories on the specified disk slots
          if (options.createDirectories !== false) {
            diskResults = await this._createDiskDirectories(poolName, subPath, options.target_devices, {
              createDirectories: true,
              setOwnership: true
            });

            // Check if all directories were successfully created
            const failedCreations = Object.keys(diskResults).filter(slot => !diskResults[slot].success);
            if (failedCreations.length > 0) {
              const failureDetails = failedCreations.map(slot =>
                `Slot ${slot}: ${diskResults[slot].error}`
              ).join('; ');
              throw new Error(`Failed to create directories on some disk slots: ${failureDetails}`);
            }
          }

          // Create or update path_rule for this share
          if (options.managePathRules !== false) {
            const rulePath = subPath.startsWith('/') ? subPath : `/${subPath}`;
            try {
              const pathRuleResult = await this.addOrUpdatePathRule(poolName, rulePath, options.target_devices);
              pathRuleCreated = true;
            } catch (pathRuleError) {
              console.warn(`Could not create path rule: ${pathRuleError.message}`);
            }
          }
        }

        // Create full share path (default behavior)
        sharePath = path.join(pool.mountPath, subPath).replace(/\/+/g, '/');

        // Check if the share path already exists or should be created (default behavior)
        if (options.createDirectory !== false && (!poolConfig || poolConfig.type !== 'mergerfs' || !options.target_devices)) {
          try {
            await fs.mkdir(sharePath, { recursive: true });

            // Set ownership to 500:500 (user:group)
            try {
              await execAsync(`chown 500:500 "${sharePath}"`);
            } catch (chownError) {
              // Do nothing
            }

            // Set permissions (default: 0775 = rwxrwxr-x)
            const permissions = options.permissions || '0775';
            try {
              await execAsync(`chmod ${permissions} "${sharePath}"`);
            } catch (chmodError) {
              // Do nothing
            }
          } catch (error) {
            throw new Error(`Could not create share directory ${sharePath}: ${error.message}`);
          }
        } else if (options.createDirectory === false) {
          // Check if path exists
          try {
            await fs.access(sharePath);
          } catch (error) {
            throw new Error(`Share path ${sharePath} does not exist`);
          }
        }
      }

      // Load current shares configuration
      let sharesConfig;
      try {
        sharesConfig = await this.getShares();
      } catch (error) {
        // If file does not exist, create empty configuration
        sharesConfig = [{ smb: [], nfs: [] }];
      }

      // Ensure correct structure: single object with smb and nfs keys
      if (sharesConfig.length === 0) {
        sharesConfig = [{ smb: [], nfs: [] }];
      }

      // Check if share name already exists (only within NFS shares)
      if (this._shareExists(sharesConfig, shareName, 'nfs')) {
        throw new Error(`NFS share with name '${shareName}' already exists`);
      }

      // Create NFS share configuration
      const nfsConfig = this._createNfsShareConfig(shareName, sharePath, options);

      // Add nfs key to first object if not present
      if (!sharesConfig[0].nfs) {
        sharesConfig[0].nfs = [];
      }

      // Add new share to NFS array
      sharesConfig[0].nfs.push(nfsConfig);

      // Save configuration
      await this._saveShares(sharesConfig);

      // Restart NFS daemon
      const nfsRestartSuccess = await this._restartNfsd();

      // Build response object
      const result = {
        success: true,
        message: `NFS share '${shareName}' created successfully${nfsRestartSuccess ? ' and NFS restarted' : ' (NFS restart failed)'}`,
        data: {
          shareName,
          sharePath,
          poolName: poolName || null,
          isAbsolutePath,
          config: nfsConfig
        },
        nfsRestarted: nfsRestartSuccess,
        timestamp: new Date().toISOString()
      };

      // Add extended information for MergerFS pools
      if (poolConfig && poolConfig.type === 'mergerfs' && options.target_devices) {
        result.data.mergerfsDetails = {
          poolType: poolConfig.type,
          target_devices: options.target_devices,
          diskDirectories: diskResults,
          pathRuleCreated
        };

        if (diskResults) {
          result.data.mergerfsDetails.createdPaths = Object.keys(diskResults)
            .filter(slot => diskResults[slot].success)
            .map(slot => diskResults[slot].path);
        }
      }

      return result;

    } catch (error) {
      throw new Error(`Error creating NFS share: ${error.message}`);
    }
  }

  /**
   * Check if a share name already exists
   * @param {Array} sharesConfig - Current shares configuration
   * @param {string} shareName - Name to check
   * @param {string} [filterType] - Optional: only check within this share type ('smb' or 'nfs')
   * @returns {boolean} True if share exists
   */
  _shareExists(sharesConfig, shareName, filterType = null) {
    if (!Array.isArray(sharesConfig)) return false;

    return sharesConfig.some(section => {
      return Object.keys(section).some(shareType => {
        // If filterType is specified, only check that specific type
        if (filterType && shareType !== filterType) {
          return false;
        }
        if (Array.isArray(section[shareType])) {
          return section[shareType].some(share => {
            return share.name === shareName;
          });
        }
        return false;
      });
    });
  }

  /**
   * Find a share by ID
   * @param {Array} sharesConfig - Current shares configuration
   * @param {string} shareId - ID to find
   * @returns {Object|null} Share object with metadata or null if not found
   */
  _findShareById(sharesConfig, shareId) {
    if (!Array.isArray(sharesConfig)) return null;

    for (const section of sharesConfig) {
      for (const shareType of Object.keys(section)) {
        if (Array.isArray(section[shareType])) {
          const shareIndex = section[shareType].findIndex(share => share.id === shareId);
          if (shareIndex !== -1) {
            return {
              share: section[shareType][shareIndex],
              section,
              shareType,
              shareIndex
            };
          }
        }
      }
    }
    return null;
  }

  /**
   * Save shares configuration to file
   * @param {Array} sharesConfig - Shares configuration to save
   */
  async _saveShares(sharesConfig) {
    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(this.sharesConfigPath), { recursive: true });

      // Save JSON with pretty formatting
      await fs.writeFile(this.sharesConfigPath, JSON.stringify(sharesConfig, null, 2));
    } catch (error) {
      throw new Error(`Error saving shares configuration: ${error.message}`);
    }
  }

  /**
   * Delete a share by ID
   * @param {string} shareId - ID of the share to delete
   * @param {Object} options - Delete options
   * @returns {Promise<Object>} Delete result
   */
  async deleteShare(shareId, options = {}) {
    try {
      const { deleteDirectory = false, removePathRule = true } = options;

      // Load current shares configuration
      const sharesConfig = await this.getShares();

      // Search for share only by ID
      const shareResult = this._findShareById(sharesConfig, shareId);

      if (!shareResult) {
        throw new Error(`Share with ID '${shareId}' not found`);
      }

      const { share: deletedShare, section, shareType, shareIndex } = shareResult;
      const sharePath = deletedShare.path;
      const shareName = deletedShare.name;
      const deletedShareId = deletedShare.id;

      // Extract pool name from share path
      const poolName = this._extractPoolNameFromPath(sharePath);

      let pathRuleRemoved = false;

      // Try to remove path rule if share has one or if desired
      if (removePathRule && poolName) {
        try {
          // Check if share has an embedded path rule
          if (deletedShare.path_rule && deletedShare.path_rule.pool === poolName) {
            try {
              await this.removePathRule(deletedShare.path_rule.pool, deletedShare.path_rule.path);
              pathRuleRemoved = true;
            } catch (pathRuleError) {
              console.warn(`Could not remove embedded path rule: ${pathRuleError.message}`);
            }
          } else {
            // Fallback: Try to remove path rule based on share path
            const relativePath = this._extractRelativePathFromShare(sharePath, poolName);
            if (relativePath && relativePath !== '/') {
              try {
                await this.removePathRule(poolName, relativePath);
                pathRuleRemoved = true;
              } catch (pathRuleError) {
                console.warn(`Could not remove path rule for '${relativePath}' from pool '${poolName}': ${pathRuleError.message}`);
              }
            }
          }
        } catch (error) {
          console.warn(`Could not process path rule removal: ${error.message}`);
        }
      }

      // Remove share from array
      section[shareType].splice(shareIndex, 1);

      // Save updated configuration (keep structure intact, don't remove empty arrays)
      await this._saveShares(sharesConfig);

      // Restart/Reload appropriate daemon based on share type
      let daemonReloadSuccess = false;
      let daemonReloadMessage = '';

      if (shareType === 'smb') {
        daemonReloadSuccess = await this._restartSmbd();
        daemonReloadMessage = daemonReloadSuccess ? ' and SMB restarted' : ' (SMB restart failed)';
      } else if (shareType === 'nfs') {
        daemonReloadSuccess = await this._restartNfsd();
        daemonReloadMessage = daemonReloadSuccess ? ' and NFS restarted' : ' (NFS restart failed)';
      }

      // Delete directory if desired (but not for absolute paths without pool)
      let directoryDeleted = false;
      if (deleteDirectory && sharePath && poolName) {
        // Only delete directory if it's pool-based
        // Absolute path shares (poolName === null) should never have their directories deleted
        try {
          await fs.rmdir(sharePath);
          directoryDeleted = true;
        } catch (error) {
          console.warn(`Could not delete share directory ${sharePath}: ${error.message}`);
        }
      } else if (deleteDirectory && !poolName) {
        console.log(`Skipping directory deletion for absolute path share: ${sharePath}`);
      }

      return {
        success: true,
        message: `${shareType.toUpperCase()} share '${shareName}' (ID: ${deletedShareId}) deleted successfully${daemonReloadMessage}${pathRuleRemoved ? ' and path rule removed' : ''}`,
        data: {
          shareId: deletedShareId,
          shareName,
          sharePath,
          poolName,
          shareType,
          directoryDeleted,
          pathRuleRemoved,
          config: deletedShare
        },
        daemonReloaded: daemonReloadSuccess,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error deleting share: ${error.message}`);
    }
  }

  /**
   * Update an existing share by ID
   * @param {string} shareId - ID of the share to update
   * @param {Object} updates - Share configuration updates
   * @returns {Promise<Object>} Update result
   */
  async updateShare(shareId, updates) {
    try {
      // Load current shares configuration
      const sharesConfig = await this.getShares();

      // Search for share only by ID
      const shareResult = this._findShareById(sharesConfig, shareId);

      if (!shareResult) {
        throw new Error(`Share with ID '${shareId}' not found`);
      }

      const { section, shareType, shareIndex } = shareResult;
      const originalShare = section[shareType][shareIndex];

      // Update share configuration
      const updatedShareConfig = {
        ...originalShare,
        ...updates,
        id: originalShare.id, // ID cannot be changed
        name: originalShare.name // Name cannot be changed in ID-based updates
      };

      // Check if target_devices was updated and update path_rule accordingly
      if (updates.hasOwnProperty('target_devices')) {
        const poolName = this._extractPoolNameFromPath(updatedShareConfig.path);
        if (poolName) {
          // Check if it's a MergerFS pool
          try {
            const pool = await this._getPoolByName(poolName);
            if (pool.type === 'mergerfs') {
              const relativePath = this._extractRelativePathFromShare(updatedShareConfig.path, poolName);

              if (updates.target_devices && Array.isArray(updates.target_devices) && updates.target_devices.length > 0) {
                // Update or create path rule in pools.json
                try {
                  await this.addOrUpdatePathRule(poolName, relativePath, updates.target_devices);
                } catch (pathRuleError) {
                  console.warn(`Could not update path rule: ${pathRuleError.message}`);
                }
              } else if (updates.target_devices === null || (Array.isArray(updates.target_devices) && updates.target_devices.length === 0)) {
                // Remove path_rule from pools.json if target_devices is empty or null
                try {
                  await this.removePathRule(poolName, relativePath);
                } catch (pathRuleError) {
                  console.warn(`Could not remove path rule: ${pathRuleError.message}`);
                }
              }
            } else {
              // Not a MergerFS pool - remove path_rule if present
              if (updatedShareConfig.path_rule) {
                console.warn(`Removing path_rule from share as pool '${poolName}' is not a MergerFS pool`);
                delete updatedShareConfig.path_rule;
              }
            }
          } catch (poolError) {
            console.warn(`Could not check pool type for '${poolName}': ${poolError.message}`);
          }
        }
      }

      // Always remove target_devices from share config
      delete updatedShareConfig.target_devices;

      section[shareType][shareIndex] = updatedShareConfig;

      // Save updated configuration
      await this._saveShares(sharesConfig);

      // Restart/Reload appropriate daemon based on share type
      let daemonReloadSuccess = false;
      let daemonReloadMessage = '';

      if (shareType === 'smb') {
        daemonReloadSuccess = await this._restartSmbd();
        daemonReloadMessage = daemonReloadSuccess ? ' and SMB restarted' : ' (SMB restart failed)';
      } else if (shareType === 'nfs') {
        daemonReloadSuccess = await this._restartNfsd();
        daemonReloadMessage = daemonReloadSuccess ? ' and NFS restarted' : ' (NFS restart failed)';
      }

      return {
        success: true,
        message: `${shareType.toUpperCase()} share '${originalShare.name}' (ID: ${originalShare.id}) updated successfully${daemonReloadMessage}`,
        data: {
          shareId: originalShare.id,
          shareName: originalShare.name,
          shareType,
          config: updatedShareConfig
        },
        daemonReloaded: daemonReloadSuccess,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error updating share: ${error.message}`);
    }
  }

  /**
   * Get a specific share by ID
   * @param {string} shareId - ID of the share
   * @returns {Promise<Object>} Share configuration
   */
  async getShare(shareId) {
    try {
      const sharesConfig = await this.getShares();

      // Search for share only by ID
      const shareResult = this._findShareById(sharesConfig, shareId);

      if (!shareResult) {
        throw new Error(`Share with ID '${shareId}' not found`);
      }

      const { share: foundShare, shareType } = shareResult;

      // Pool info is already enriched in getShares()
      return {
        success: true,
        data: {
          shareId: foundShare.id,
          shareName: foundShare.name,
          shareType,
          config: foundShare
        },
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error getting share: ${error.message}`);
    }
  }

  /**
   * Update target devices for a share (path rule management)
   * @param {string} shareId - ID of the share
   * @param {Array<number>} target_devices - Array of disk slot numbers
   * @returns {Promise<Object>} Update result
   */
  async updateShareTargetDevices(shareId, target_devices) {
    try {
      // Validate target_devices
      if (target_devices && (!Array.isArray(target_devices) || !target_devices.every(device => Number.isInteger(device) && device > 0))) {
        throw new Error('target_devices must be an array of positive integers (disk slot numbers)');
      }

      return await this.updateShare(shareId, { target_devices });
    } catch (error) {
      throw new Error(`Error updating share target devices: ${error.message}`);
    }
  }

  /**
   * Get target devices for a share (from path rule)
   * @param {string} shareId - ID of the share
   * @returns {Promise<Object>} Target devices information
   */
  async getShareTargetDevices(shareId) {
    try {
      const shareResult = await this.getShare(shareId);
      const share = shareResult.data.config;

      const poolName = this._extractPoolNameFromPath(share.path);
      let poolType = null;
      let isValidForPathRules = false;
      let pathRule = null;

      if (poolName) {
        try {
          const pool = await this._getPoolByName(poolName);
          poolType = pool.type;
          isValidForPathRules = pool.type === 'mergerfs';

          // If it's a MergerFS pool, look for path rules
          if (isValidForPathRules && pool.config && pool.config.path_rules) {
            // Extract the relative path from the share path
            const relativePath = this._extractRelativePathFromShare(share.path, poolName);

            // Find matching path rule in the pool configuration
            const matchingRule = pool.config.path_rules.find(rule => rule.path === relativePath);

            if (matchingRule) {
              // Convert to camelCase for API response (pools.json still uses snake_case)
              pathRule = {
                path: matchingRule.path,
                targetDevices: matchingRule.target_devices
              };
            }
          }
        } catch (poolError) {
          console.warn(`Could not check pool type: ${poolError.message}`);
        }
      }

      return {
        success: true,
        data: {
          shareId,
          shareName: share.name,
          sharePath: share.path,
          poolName,
          poolType,
          isValidForPathRules,
          relativePath: poolName ? this._extractRelativePathFromShare(share.path, poolName) : null,
          pathRule
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      throw new Error(`Error getting share target devices: ${error.message}`);
    }
  }

  /**
   * Remove target devices from a share (remove path rule)
   * @param {string} shareId - ID of the share
   * @returns {Promise<Object>} Remove result
   */
  async removeShareTargetDevices(shareId) {
    try {
      return await this.updateShare(shareId, { target_devices: null });
    } catch (error) {
      throw new Error(`Error removing share target devices: ${error.message}`);
    }
  }

  /**
   * Get pools configuration from /boot/config/pools.json
   * @returns {Promise<Array>} Pools configuration
   */
  async _getPools() {
    try {
      // Check if the file exists
      await fs.access(this.poolsConfigPath);

      // Read the pools.json file
      const poolsData = await fs.readFile(this.poolsConfigPath, 'utf8');

      // Parse JSON and return
      const poolsConfig = JSON.parse(poolsData);

      // Simple validation: Make sure it's an array
      if (!Array.isArray(poolsConfig)) {
        throw new Error(`Invalid pools configuration format: Expected array, got ${typeof poolsConfig}`);
      }

      return poolsConfig;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`Pools configuration file not found at ${this.poolsConfigPath}`);
      } else if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in pools configuration file: ${error.message}`);
      } else if (error.code === 'EACCES') {
        throw new Error(`Permission denied reading pools configuration file`);
      } else {
        throw new Error(`Error reading pools configuration: ${error.message}`);
      }
    }
  }

  /**
   * Save pools configuration to file
   * @param {Array} poolsConfig - Pools configuration to save
   */
  async _savePools(poolsConfig) {
    try {
      // Make sure the directory exists
      await fs.mkdir(path.dirname(this.poolsConfigPath), { recursive: true });

      // Save JSON with pretty formatting
      await fs.writeFile(this.poolsConfigPath, JSON.stringify(poolsConfig, null, 2));
    } catch (error) {
      throw new Error(`Error saving pools configuration: ${error.message}`);
    }
  }

  /**
   * Get specific pool by name from pools configuration
   * @param {string} poolName - Name of the pool
   * @returns {Promise<Object>} Pool configuration
   */
  async _getPoolByName(poolName) {
    try {
      const pools = await this._getPools();
      const pool = pools.find(p => p.name === poolName);

      if (!pool) {
        throw new Error(`Pool '${poolName}' not found`);
      }

      return pool;
    } catch (error) {
      throw error;
    }
  }



  /**
   * Check if disk directories exist for MergerFS pool
   * @param {string} poolName - Name of the pool
   * @param {Array<number>} diskSlots - Array of disk slot numbers
   * @returns {Promise<Object>} Status of disk directories
   */
  async _checkDiskDirectories(poolName, diskSlots) {
    const basePath = `/var/mergerfs/${poolName}`;
    const results = {};

    for (const slot of diskSlots) {
      const diskPath = path.join(basePath, `disk${slot}`);
      try {
        await fs.access(diskPath);
        results[slot] = { exists: true, path: diskPath };
      } catch (error) {
        results[slot] = { exists: false, path: diskPath };
      }
    }

    return results;
  }

  /**
   * Validate that specified disk slots exist for a pool
   * @param {string} poolName - Name of the pool
   * @param {Array<number>} diskSlots - Array of disk slot numbers to validate
   * @returns {Promise<Object>} Validation result
   */
  async _validateDiskSlots(poolName, diskSlots) {
    try {
      const pool = await this._getPoolByName(poolName);

      if (pool.type !== 'mergerfs') {
        throw new Error(`Pool '${poolName}' is not a MergerFS pool. Disk slots are only available for MergerFS pools.`);
      }

      // Get available slots directly from the pool configuration
      const availableSlots = [];
      if (pool.data_devices && Array.isArray(pool.data_devices)) {
        for (const device of pool.data_devices) {
          const slot = parseInt(device.slot);
          const diskPath = path.join(`/var/mergerfs/${poolName}`, `disk${slot}`);

          try {
            await fs.access(diskPath);
            availableSlots.push(slot);
          } catch (error) {
            // Slot is not available - do not add to list
          }
        }
      }

      const invalidSlots = diskSlots.filter(slot => !availableSlots.includes(slot));

      if (invalidSlots.length > 0) {
        throw new Error(`The following disk slots do not exist or are not available: ${invalidSlots.join(', ')}. Available slots: ${availableSlots.join(', ')}`);
      }

      return {
        valid: true,
        validSlots: diskSlots,
        availableSlots: availableSlots
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Create directories on specific disk slots for MergerFS pool
   * @param {string} poolName - Name of the pool
   * @param {string} subPath - Sub-path to create (e.g., "Filme")
   * @param {Array<number>} diskSlots - Array of disk slot numbers
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Creation results
   */
  async _createDiskDirectories(poolName, subPath, diskSlots, options = {}) {
    const basePath = `/var/mergerfs/${poolName}`;
    const results = {};
    const { createDirectories = true, setOwnership = true } = options;

    for (const slot of diskSlots) {
      const diskPath = path.join(basePath, `disk${slot}`);
      const fullPath = path.join(diskPath, subPath);

      try {
        // Check if disk mount point exists
        await fs.access(diskPath);

        if (createDirectories) {
          // Create directory
          await fs.mkdir(fullPath, { recursive: true });

          // Set ownership to 500:500 (user:group)
          if (setOwnership) {
            try {
              await execAsync(`chown 500:500 "${fullPath}"`);
            } catch (chownError) {
              console.warn(`Could not set ownership for ${fullPath}: ${chownError.message}`);
            }
          }
        }

        results[slot] = {
          success: true,
          path: fullPath,
          created: createDirectories,
          diskPath
        };
      } catch (error) {
        results[slot] = {
          success: false,
          error: error.message,
          path: fullPath,
          diskPath
        };
      }
    }

    return results;
  }

  /**
   * Create directories on target devices for a specific path
   * @param {string} poolName - Name of the pool
   * @param {string} rulePath - Path for the rule (e.g., "/Filme")
   * @param {Array<number>} target_devices - Array of target device slots
   * @returns {Promise<Object>} Creation results
   */
  async _createDirectoriesOnTargetDevices(poolName, rulePath, target_devices) {
    // Remove leading slash for directory creation
    const subPath = rulePath.startsWith('/') ? rulePath.substring(1) : rulePath;

    // Use existing _createDiskDirectories method
    return await this._createDiskDirectories(poolName, subPath, target_devices, {
      createDirectories: true,
      setOwnership: true
    });
  }

  /**
   * Add or update path rule in pool configuration
   * @param {string} poolName - Name of the pool
   * @param {string} rulePath - Path for the rule (e.g., "/Filme")
   * @param {Array<number>} target_devices - Array of target device slots
   * @returns {Promise<Object>} Update result
   */
  async addOrUpdatePathRule(poolName, rulePath, target_devices) {
    try {
      const pools = await this._getPools();
      const poolIndex = pools.findIndex(p => p.name === poolName);

      if (poolIndex === -1) {
        throw new Error(`Pool '${poolName}' not found`);
      }

      const pool = pools[poolIndex];

      // Check if it's a MergerFS pool
      if (pool.type !== 'mergerfs') {
        throw new Error(`Pool '${poolName}' is not a MergerFS pool. Path rules are only supported for MergerFS pools.`);
      }

      // Check if the pool is mounted
      const poolMountPath = `/mnt/${poolName}`;
      try {
        await fs.access(poolMountPath);
        // Additionally check if it really is a mount point
        const { stdout } = await execAsync(`mountpoint -q "${poolMountPath}" && echo "mounted" || echo "not_mounted"`);
        if (stdout.trim() !== 'mounted') {
          throw new Error(`Pool '${poolName}' is not mounted at '${poolMountPath}'. Cannot create directories on unmounted pool.`);
        }
      } catch (error) {
        if (error.code === 'ENOENT') {
          throw new Error(`Pool mount path '${poolMountPath}' does not exist. Pool '${poolName}' is not mounted.`);
        }
        throw new Error(`Pool '${poolName}' is not properly mounted: ${error.message}`);
      }

      // Validate target devices against available disks
      // _validateDiskSlots already throws if slots are invalid
      if (target_devices && target_devices.length > 0) {
        await this._validateDiskSlots(poolName, target_devices);
      }

      // Make sure config.path_rules exists
      if (!pool.config) {
        pool.config = {};
      }
      if (!pool.config.path_rules) {
        pool.config.path_rules = [];
      }

      // Normalize the path (make sure it starts with /)
      const normalizedPath = rulePath.startsWith('/') ? rulePath : `/${rulePath}`;

      // Create directories on the specified target devices if given
      let directoryCreationResults = {};
      if (target_devices && target_devices.length > 0 && normalizedPath !== '/') {
        try {
          directoryCreationResults = await this._createDirectoriesOnTargetDevices(poolName, normalizedPath, target_devices);

          // Check if all directories were successfully created
          const failedCreations = Object.entries(directoryCreationResults)
            .filter(([slot, result]) => !result.success);

          if (failedCreations.length > 0) {
            const failedSlots = failedCreations.map(([slot, result]) => `disk${slot}: ${result.error}`);
            console.warn(`Some directories could not be created: ${failedSlots.join(', ')}`);
            // Do not treat as critical error - path rule will still be set
          }
        } catch (dirError) {
          console.warn(`Error creating directories on target devices: ${dirError.message}`);
          // Do not treat as critical error
        }
      }

      // Check if the rule already exists
      const existingRuleIndex = pool.config.path_rules.findIndex(rule => rule.path === normalizedPath);

      if (existingRuleIndex !== -1) {
        // Update existing rule
        pool.config.path_rules[existingRuleIndex].target_devices = target_devices;
      } else {
        // Add new rule
        pool.config.path_rules.push({
          path: normalizedPath,
          target_devices: target_devices
        });
      }

      // Save updated configuration
      await this._savePools(pools);

      return {
        success: true,
        message: existingRuleIndex !== -1 ?
          `Path rule for '${normalizedPath}' updated successfully` :
          `Path rule for '${normalizedPath}' added successfully`,
        data: {
          poolName,
          path: normalizedPath,
          target_devices: target_devices,
          action: existingRuleIndex !== -1 ? 'updated' : 'created',
          directoryCreation: directoryCreationResults
        },
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error managing path rule: ${error.message}`);
    }
  }

  /**
   * Remove path rule from pool configuration
   * @param {string} poolName - Name of the pool
   * @param {string} rulePath - Path for the rule to remove
   * @returns {Promise<Object>} Remove result
   */
  async removePathRule(poolName, rulePath) {
    try {
      const pools = await this._getPools();
      const poolIndex = pools.findIndex(p => p.name === poolName);

      if (poolIndex === -1) {
        throw new Error(`Pool '${poolName}' not found`);
      }

      const pool = pools[poolIndex];

      if (!pool.config || !pool.config.path_rules) {
        throw new Error(`No path rules found for pool '${poolName}'`);
      }

      // Normalize the path
      const normalizedPath = rulePath.startsWith('/') ? rulePath : `/${rulePath}`;

      // Find and remove the rule
      const ruleIndex = pool.config.path_rules.findIndex(rule => rule.path === normalizedPath);

      if (ruleIndex === -1) {
        throw new Error(`Path rule for '${normalizedPath}' not found in pool '${poolName}'`);
      }

      const removedRule = pool.config.path_rules.splice(ruleIndex, 1)[0];

      // Save updated configuration
      await this._savePools(pools);

      return {
        success: true,
        message: `Path rule for '${normalizedPath}' removed successfully`,
        data: {
          poolName,
          removedRule
        },
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error removing path rule: ${error.message}`);
    }
  }

  /**
   * Get path rules for a specific pool
   * @param {string} poolName - Name of the pool
   * @returns {Promise<Object>} Path rules
   */
  async getPathRules(poolName) {
    try {
      const pool = await this._getPoolByName(poolName);

      const pathRules = pool.config?.path_rules || [];

      return {
        success: true,
        data: {
          poolName,
          poolType: pool.type,
          path_rules: pathRules
        },
        count: pathRules.length,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error getting path rules: ${error.message}`);
    }
  }
}

module.exports = new SharesService(); 