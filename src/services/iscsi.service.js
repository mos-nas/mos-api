const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

class IscsiService {
  constructor() {
    this.targetsConfigPath = '/boot/config/system/iscsi/target.json';
  }

  /**
   * Validate and prepare LUN path (create image if needed or validate block device)
   * @param {string} lunPath - Path to LUN backing store
   * @param {string|number} size - Size for image file (e.g., '1G', '500M', or bytes as number), defaults to 1GB
   * @returns {Promise<boolean>} True if path is valid/created
   */
  /**
   * Convert size string to bytes
   * @param {string|number} size - Size as string (e.g., '1G', '500M') or number (bytes)
   * @returns {number} Size in bytes
   */
  parseSizeToBytes(size) {
    if (typeof size === 'number') {
      return size;
    }

    const sizeStr = size.toString().toUpperCase();
    const match = sizeStr.match(/^(\d+(?:\.\d+)?)\s*([KMGT]?)B?$/);

    if (!match) {
      throw new Error(`Invalid size format: ${size}. Use formats like '1G', '500M', '2048K', or bytes as number.`);
    }

    const value = parseFloat(match[1]);
    const unit = match[2];

    const multipliers = {
      '': 1,
      'K': 1024,
      'M': 1024 * 1024,
      'G': 1024 * 1024 * 1024,
      'T': 1024 * 1024 * 1024 * 1024
    };

    return Math.floor(value * multipliers[unit]);
  }

  /**
   * Safely delete an image file (only .img files, not block devices)
   * @param {string} lunPath - Path to the LUN file
   * @returns {Promise<boolean>} True if file was deleted, false if not applicable
   */
  async deleteImageFile(lunPath) {
    try {
      // Only delete .img files, never block devices
      if (lunPath.startsWith('/dev/')) {
        console.log(`Skipping deletion of block device: ${lunPath}`);
        return false;
      }

      if (!lunPath.toLowerCase().endsWith('.img')) {
        console.log(`Skipping deletion of non-image file: ${lunPath}`);
        return false;
      }

      // Check if file exists before trying to delete
      try {
        await fs.access(lunPath);
        await fs.unlink(lunPath);
        console.log(`Deleted image file: ${lunPath}`);
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') {
          console.log(`Image file already deleted or doesn't exist: ${lunPath}`);
          return false;
        } else {
          throw new Error(`Failed to delete image file ${lunPath}: ${error.message}`);
        }
      }
    } catch (error) {
      throw error;
    }
  }

  async validateAndPrepareLunPath(lunPath, size = '1G') {
    try {
      // Check if it's a block device (starts with /dev/)
      if (lunPath.startsWith('/dev/')) {
        // For block devices, just check if they exist
        try {
          await fs.access(lunPath);
          // Additional check to ensure it's actually a block device
          const stats = await fs.stat(lunPath);
          if (!stats.isBlockDevice()) {
            throw new Error(`${lunPath} exists but is not a block device`);
          }
          return true;
        } catch (error) {
          throw new Error(`Block device ${lunPath} does not exist or is not accessible`);
        }
      } else {
        // For regular files/images
        try {
          // Check if file already exists
          await fs.access(lunPath);
          return true; // File exists, all good
        } catch (error) {
          // File doesn't exist, check if it's an image file and create it
          if (lunPath.toLowerCase().endsWith('.img')) {
            // Check if directory exists
            const dirPath = path.dirname(lunPath);
            try {
              await fs.access(dirPath);
            } catch (dirError) {
              throw new Error(`Directory ${dirPath} does not exist. Cannot create image file.`);
            }

            // Create a sparse image file with specified size
            try {
              const sizeInBytes = this.parseSizeToBytes(size);
              await fs.writeFile(lunPath, '');
              await fs.truncate(lunPath, sizeInBytes);
              console.log(`Created sparse image file: ${lunPath} (${size})`);
              return true;
            } catch (createError) {
              throw new Error(`Failed to create image file ${lunPath}: ${createError.message}`);
            }
          } else {
            // Not an image file and doesn't exist
            throw new Error(`LUN path ${lunPath} does not exist and is not an image file that can be created`);
          }
        }
      }
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get all configured targets from JSON
   * @returns {Promise<Array>} Array of target configurations
   */
  async getTargets() {
    try {
      // Prüfe ob die Datei existiert
      await fs.access(this.targetsConfigPath);

      // Read the target.json file
      const targetsData = await fs.readFile(this.targetsConfigPath, 'utf8');

      // Parse JSON und return
      const targetsConfig = JSON.parse(targetsData);

      // Simple validation: Ensure it's an array
      if (!Array.isArray(targetsConfig)) {
        throw new Error(`Invalid targets configuration format: Expected array, got ${typeof targetsConfig}`);
      }

      // Sort targets by ID to ensure consistent ordering
      targetsConfig.sort((a, b) => a.id - b.id);

      return targetsConfig;
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File doesn't exist, return empty array
        return [];
      } else if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in targets configuration file: ${error.message}`);
      } else if (error.code === 'EACCES') {
        throw new Error(`Permission denied reading targets configuration file`);
      } else {
        throw new Error(`Error reading targets configuration: ${error.message}`);
      }
    }
  }

  /**
   * Get currently configured targets from tgtadm
   * @returns {Promise<Array>} Array of configured target IDs
   */
  async getConfiguredTargets() {
    try {
      const { stdout } = await execAsync('tgtadm -C 0 --op show --mode target 2>/dev/null | grep -E "^Target [0-9]+: " | cut -d ":" -f1 | cut -d " " -f2');

      if (!stdout.trim()) {
        return [];
      }

      return stdout.trim().split('\n').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
    } catch (error) {
      // If the command fails, return empty array
      return [];
    }
  }

  /**
   * Configure a new target
   * @param {number} tid - Target ID
   * @param {string} iqn - Target IQN
   */
  async configureTarget(tid, iqn) {
    try {
      await execAsync(`tgtadm --lld iscsi --op new --mode target --tid ${tid} -T "${iqn}"`);
    } catch (error) {
      throw new Error(`Error configuring target ${tid}: ${error.message}`);
    }
  }

  /**
   * Create a LUN
   * @param {number} tid - Target ID
   * @param {number} lunId - LUN ID
   * @param {string} mode - LUN mode
   * @param {string} path - LUN path
   */
  async createLun(tid, lunId, mode, path) {
    try {
      await execAsync(`tgtadm --lld iscsi --op new --mode ${mode} --tid ${tid} --lun ${lunId} -b "${path}"`);
    } catch (error) {
      throw new Error(`Error creating LUN ${lunId} for target ${tid}: ${error.message}`);
    }
  }

  /**
   * Update a LUN
   * @param {number} tid - Target ID
   * @param {number} lunId - LUN ID
   * @param {string} mode - LUN mode
   * @param {string} params - Parameters to update
   */
  async updateLun(tid, lunId, mode, params) {
    try {
      await execAsync(`tgtadm --lld iscsi --op update --mode ${mode} --tid ${tid} --lun ${lunId} --params "${params}"`);
    } catch (error) {
      throw new Error(`Error updating LUN ${lunId} for target ${tid}: ${error.message}`);
    }
  }

  /**
   * Create bindings for initiators
   * @param {number} tid - Target ID
   * @param {string} initiatorIqn - Initiator IQN
   */
  async createBindings(tid, initiatorIqn) {
    try {
      await execAsync(`tgtadm --lld iscsi --op bind --mode target --tid ${tid} -Q "${initiatorIqn}"`);
      await execAsync(`tgtadm --lld iscsi --op bind --mode target --tid ${tid} -I ALL`);
    } catch (error) {
      throw new Error(`Error creating bindings for target ${tid}: ${error.message}`);
    }
  }

  /**
   * Remove a target
   * @param {number} tid - Target ID
   */
  async removeTarget(tid) {
    try {
      await execAsync(`tgtadm --mode target --op delete --tid=${tid}`);
    } catch (error) {
      throw new Error(`Error removing target ${tid}: ${error.message}`);
    }
  }

  /**
   * Create a complete target with all LUNs and bindings
   * @param {Object} targetConfig - Target configuration
   */
  async createTarget(targetConfig) {
    const { id, iqn, luns = [], initiators = [] } = targetConfig;

    try {
      // Configure the target
      await this.configureTarget(id, iqn);

      // Create all LUNs
      for (const lun of luns) {
        const { id: lunId, path, mode, backing_store } = lun;
        await this.createLun(id, lunId, mode, path);

        // Set readonly if needed
        if (backing_store === 'ro') {
          await this.updateLun(id, lunId, mode, 'readonly=1');
        }
      }

      // Create bindings for initiators
      for (const initiator of initiators) {
        const { iqn: initiatorIqn } = initiator;
        await this.createBindings(id, initiatorIqn);
      }

    } catch (error) {
      // Try to clean up on error
      try {
        await this.removeTarget(id);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  /**
   * Save targets configuration to file
   * @param {Array} targetsConfig - Targets configuration to save
   */
  async saveTargets(targetsConfig) {
    try {
      // Ensure the directory exists
      await fs.mkdir(path.dirname(this.targetsConfigPath), { recursive: true });

      // Sort targets by ID before saving to ensure consistent file ordering
      targetsConfig.sort((a, b) => a.id - b.id);

      // Save JSON with pretty formatting
      await fs.writeFile(this.targetsConfigPath, JSON.stringify(targetsConfig, null, 2));
    } catch (error) {
      throw new Error(`Error saving targets configuration: ${error.message}`);
    }
  }

  /**
   * Get targets info/statistics
   * @returns {Promise<Object>} Targets statistics
   */
  async getTargetsInfo() {
    try {
      const targetsConfig = await this.getTargets();
      const configuredTargets = await this.getConfiguredTargets();

      let totalLuns = 0;
      let totalInitiators = 0;

      targetsConfig.forEach(target => {
        if (target.luns) totalLuns += target.luns.length;
        if (target.initiators) totalInitiators += target.initiators.length;
      });

      return {
        success: true,
        data: {
          totalTargets: targetsConfig.length,
          activeTargets: configuredTargets.length,
          totalLuns,
          totalInitiators
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Create a new iSCSI target
   * @param {Object} targetData - Target configuration data
   * @returns {Promise<Object>} Created target result
   */
  async createIscsiTarget(targetData) {
    try {
      // Load current targets configuration
      const targetsConfig = await this.getTargets();

      // Validate Target ID
      const targetId = targetData.id;
      if (!targetId || typeof targetId !== 'number') {
        throw new Error('Target ID is required and must be a number');
      }

      // Check if Target ID already exists
      if (targetsConfig.some(target => target.id === targetId)) {
        throw new Error(`Target with ID ${targetId} already exists`);
      }

      // Check if target is already active
      const configuredTargets = await this.getConfiguredTargets();
      if (configuredTargets.includes(targetId)) {
        throw new Error(`Target ID ${targetId} is already in use`);
      }

      // Validate and create LUN paths if necessary
      const luns = targetData.luns || [];
      for (const lun of luns) {
        if (lun.path) {
          await this.validateAndPrepareLunPath(lun.path, lun.size);
        }
      }

      // Create the target in the configuration
      const newTarget = {
        id: targetId,
        name: targetData.name || `Target ${targetId}`,
        iqn: targetData.iqn,
        portal: targetData.portal || '0.0.0.0:3260',
        authentication: targetData.authentication || { method: 'none' },
        luns: luns,
        initiators: targetData.initiators || []
      };

      // Add target to configuration
      targetsConfig.push(newTarget);

      // Save configuration
      await this.saveTargets(targetsConfig);

      // Create the target in the system
      await this.createTarget(newTarget);

      return {
        success: true,
        message: `iSCSI target '${newTarget.name}' created successfully`,
        data: newTarget,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error creating iSCSI target: ${error.message}`);
    }
  }

  /**
   * Update an existing iSCSI target
   * @param {number} targetId - Target ID to update
   * @param {Object} updates - Target configuration updates
   * @returns {Promise<Object>} Update result
   */
  async updateIscsiTarget(targetId, updates) {
    try {
      // Load current targets configuration
      const targetsConfig = await this.getTargets();

      // Find the target
      const targetIndex = targetsConfig.findIndex(target => target.id === targetId);
      if (targetIndex === -1) {
        throw new Error(`Target with ID ${targetId} not found`);
      }

      const oldTarget = targetsConfig[targetIndex];

      // Check if target is active and remove it temporarily
      const configuredTargets = await this.getConfiguredTargets();
      const wasActive = configuredTargets.includes(targetId);

      if (wasActive) {
        await this.removeTarget(targetId);
      }

      // Update the target configuration
      const updatedTarget = {
        ...oldTarget,
        ...updates,
        id: targetId // ID must not be changed
      };

      targetsConfig[targetIndex] = updatedTarget;

      // Save configuration
      await this.saveTargets(targetsConfig);

      // Recreate the target if it was previously active
      if (wasActive) {
        await this.createTarget(updatedTarget);
      }

      return {
        success: true,
        message: `iSCSI target '${updatedTarget.name}' updated successfully`,
        data: updatedTarget,
        wasActive,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error updating iSCSI target: ${error.message}`);
    }
  }

     /**
    * Delete an iSCSI target
    * @param {number} targetId - Target ID to delete
    * @param {boolean} deleteImages - If true, delete the backing image files
    * @returns {Promise<Object>} Delete result
    */
   async deleteIscsiTarget(targetId, deleteImages = false) {
    try {
      // Load current targets configuration
      const targetsConfig = await this.getTargets();

      // Find the target
      const targetIndex = targetsConfig.findIndex(target => target.id === targetId);
      if (targetIndex === -1) {
        throw new Error(`Target with ID ${targetId} not found`);
      }

      const targetToDelete = targetsConfig[targetIndex];

      // Check if target is active and remove it
      const configuredTargets = await this.getConfiguredTargets();
      const wasActive = configuredTargets.includes(targetId);

      if (wasActive) {
        await this.removeTarget(targetId);
      }

      // Remove target from configuration
      targetsConfig.splice(targetIndex, 1);

      // Save configuration
      await this.saveTargets(targetsConfig);

      // Delete backing image files only AFTER taking offline, if requested
      const deletedImageFiles = [];
      if (deleteImages && targetToDelete.luns && targetToDelete.luns.length > 0) {
        for (const lun of targetToDelete.luns) {
          if (lun.path) {
            const deleted = await this.deleteImageFile(lun.path);
            if (deleted) {
              deletedImageFiles.push(lun.path);
            }
          }
        }
      }

      return {
        success: true,
        message: `iSCSI target '${targetToDelete.name}' deleted successfully`,
        data: {
          target: targetToDelete,
          deletedImageFiles: deletedImageFiles
        },
        wasActive,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error deleting iSCSI target: ${error.message}`);
    }
  }

  /**
   * Get a specific target by ID
   * @param {number} targetId - Target ID
   * @returns {Promise<Object>} Target configuration
   */
  async getTarget(targetId) {
    try {
      const targetsConfig = await this.getTargets();
      const configuredTargets = await this.getConfiguredTargets();

      const target = targetsConfig.find(t => t.id === targetId);
      if (!target) {
        throw new Error(`Target with ID ${targetId} not found`);
      }

      return {
        success: true,
        data: {
          ...target,
          isActive: configuredTargets.includes(targetId)
        },
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error getting target: ${error.message}`);
    }
  }

  /**
   * Restart/reload all targets
   * @returns {Promise<Object>} Restart result
   */
  async restartAllTargets() {
    try {
      const targetsConfig = await this.getTargets();
      const configuredTargets = await this.getConfiguredTargets();

      // Remove all active targets
      for (const tid of configuredTargets) {
        try {
          await this.removeTarget(tid);
        } catch (error) {
          console.warn(`Warning: Could not remove target ${tid}: ${error.message}`);
        }
      }

      // Recreate all targets from configuration
      const results = [];
      for (const target of targetsConfig) {
        try {
          await this.createTarget(target);
          results.push({ id: target.id, status: 'success' });
        } catch (error) {
          results.push({ id: target.id, status: 'error', error: error.message });
        }
      }

      return {
        success: true,
        message: 'All targets restarted',
        data: {
          totalTargets: targetsConfig.length,
          results
        },
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error restarting targets: ${error.message}`);
    }
  }

  /**
   * Add a LUN to a target
   * @param {number} targetId - Target ID
   * @param {Object} lunData - LUN configuration data
   * @returns {Promise<Object>} Add LUN result
   */
  async addLunToTarget(targetId, lunData) {
    try {
      // Load current targets configuration
      const targetsConfig = await this.getTargets();

      // Find the target
      const targetIndex = targetsConfig.findIndex(target => target.id === targetId);
      if (targetIndex === -1) {
        throw new Error(`Target with ID ${targetId} not found`);
      }

      const target = targetsConfig[targetIndex];

      // Validate LUN data
      if (!lunData.id || typeof lunData.id !== 'number') {
        throw new Error('LUN ID is required and must be a number');
      }

      if (!lunData.path) {
        throw new Error('LUN path is required');
      }

      // Validate and create LUN path if necessary
      await this.validateAndPrepareLunPath(lunData.path, lunData.size);

      // Check if LUN ID already exists
      if (target.luns && target.luns.some(lun => lun.id === lunData.id)) {
        throw new Error(`LUN with ID ${lunData.id} already exists in target ${targetId}`);
      }

      // Create LUN object with defaults
      const newLun = {
        id: lunData.id,
        path: lunData.path,
        size: lunData.size || '1G',
        mode: lunData.mode || 'fileio',
        type: lunData.type || 'disk'
      };

      // Add LUN to target
      if (!target.luns) {
        target.luns = [];
      }
      target.luns.push(newLun);

      // Sort LUNs by ID
      target.luns.sort((a, b) => a.id - b.id);

      // Check if target is active
      const configuredTargets = await this.getConfiguredTargets();
      const isActive = configuredTargets.includes(targetId);

      if (isActive) {
        // Remove target temporarily and recreate it
        await this.removeTarget(targetId);
        await this.createTarget(target);
      }

      // Save configuration
      await this.saveTargets(targetsConfig);

      return {
        success: true,
        message: `LUN ${newLun.id} added to target '${target.name}' successfully`,
        data: {
          target: target,
          addedLun: newLun
        },
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error adding LUN to target: ${error.message}`);
    }
  }

  /**
   * Remove a LUN from a target
   * @param {number} targetId - Target ID
   * @param {number} lunId - LUN ID to remove
   * @param {boolean} deleteImages - If true, delete the backing image file
   * @returns {Promise<Object>} Remove LUN result
   */
  async removeLunFromTarget(targetId, lunId, deleteImages = false) {
    try {
      // Load current targets configuration
      const targetsConfig = await this.getTargets();

      // Find the target
      const targetIndex = targetsConfig.findIndex(target => target.id === targetId);
      if (targetIndex === -1) {
        throw new Error(`Target with ID ${targetId} not found`);
      }

      const target = targetsConfig[targetIndex];

      // Check if LUNs exist
      if (!target.luns || target.luns.length === 0) {
        throw new Error(`No LUNs found in target ${targetId}`);
      }

      // Find the LUN
      const lunIndex = target.luns.findIndex(lun => lun.id === lunId);
      if (lunIndex === -1) {
        throw new Error(`LUN with ID ${lunId} not found in target ${targetId}`);
      }

      const removedLun = target.luns[lunIndex];

      // Remove LUN
      target.luns.splice(lunIndex, 1);

      // Check if target is active
      const configuredTargets = await this.getConfiguredTargets();
      const isActive = configuredTargets.includes(targetId);

      if (isActive) {
        // Remove target temporarily and recreate it (without the deleted LUN)
        await this.removeTarget(targetId);
        await this.createTarget(target);
      }

      // Save configuration
      await this.saveTargets(targetsConfig);

      // Delete backing image file only AFTER taking offline, if requested
      let imageFileDeleted = false;
      if (deleteImages && removedLun.path) {
        imageFileDeleted = await this.deleteImageFile(removedLun.path);
      }

      return {
        success: true,
        message: `LUN ${lunId} removed from target '${target.name}' successfully`,
        data: {
          target: target,
          removedLun: removedLun,
          imageFileDeleted: imageFileDeleted
        },
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error removing LUN from target: ${error.message}`);
    }
  }

  /**
   * Update a LUN in a target
   * @param {number} targetId - Target ID
   * @param {number} lunId - LUN ID to update
   * @param {Object} updates - LUN updates
   * @returns {Promise<Object>} Update LUN result
   */
  async updateLunInTarget(targetId, lunId, updates) {
    try {
      // Load current targets configuration
      const targetsConfig = await this.getTargets();

      // Find the target
      const targetIndex = targetsConfig.findIndex(target => target.id === targetId);
      if (targetIndex === -1) {
        throw new Error(`Target with ID ${targetId} not found`);
      }

      const target = targetsConfig[targetIndex];

      // Check if LUNs exist
      if (!target.luns || target.luns.length === 0) {
        throw new Error(`No LUNs found in target ${targetId}`);
      }

      // Find the LUN
      const lunIndex = target.luns.findIndex(lun => lun.id === lunId);
      if (lunIndex === -1) {
        throw new Error(`LUN with ID ${lunId} not found in target ${targetId}`);
      }

      const oldLun = target.luns[lunIndex];

      // Validate new path if it has changed
      if (updates.path && updates.path !== oldLun.path) {
        await this.validateAndPrepareLunPath(updates.path, updates.size);
      }

      // Update LUN (ID must not be changed)
      const updatedLun = {
        ...oldLun,
        ...updates,
        id: lunId
      };

      target.luns[lunIndex] = updatedLun;

      // Sort LUNs by ID
      target.luns.sort((a, b) => a.id - b.id);

      // Check if target is active
      const configuredTargets = await this.getConfiguredTargets();
      const isActive = configuredTargets.includes(targetId);

      if (isActive) {
        // Remove target temporarily and recreate it
        await this.removeTarget(targetId);
        await this.createTarget(target);
      }

      // Save configuration
      await this.saveTargets(targetsConfig);

      return {
        success: true,
        message: `LUN ${lunId} in target '${target.name}' updated successfully`,
        data: {
          target: target,
          updatedLun: updatedLun,
          oldLun: oldLun
        },
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error updating LUN in target: ${error.message}`);
    }
  }

  // ==================== INITIATOR METHODS ====================

  /**
   * Generate a timestamp-based ID for initiator targets
   * @returns {number} Timestamp ID
   */
  generateTimestampId() {
    return Date.now();
  }

  /**
   * Get initiator configuration from JSON
   * @returns {Promise<Object>} Initiator configuration
   */
  async getInitiatorConfig() {
    const initiatorConfigPath = '/boot/config/system/iscsi/initiator.json';

    try {
      // Check if the file exists
      await fs.access(initiatorConfigPath);

      // Read the initiator.json file
      const configData = await fs.readFile(initiatorConfigPath, 'utf8');

      // Parse JSON and return
      const config = JSON.parse(configData);

      // Simple validation: Make sure the correct structure is present
      if (!config.initiator || !config.targets) {
        throw new Error('Invalid initiator configuration format: Missing initiator or targets');
      }

      // Sort targets by ID to ensure consistent ordering
      config.targets.sort((a, b) => a.id - b.id);

      return config;
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Datei existiert nicht, return default config
        return {
          initiator: {
            name: "iqn.2025-08.why-mos:why"
          },
          targets: []
        };
      } else if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in initiator configuration file: ${error.message}`);
      } else if (error.code === 'EACCES') {
        throw new Error(`Permission denied reading initiator configuration file`);
      } else {
        throw new Error(`Error reading initiator configuration: ${error.message}`);
      }
    }
  }

  /**
   * Save initiator configuration to file
   * @param {Object} config - Initiator configuration to save
   */
  async saveInitiatorConfig(config) {
    const initiatorConfigPath = '/boot/config/system/iscsi/initiator.json';

    try {
      // Make sure the directory exists
      await fs.mkdir(path.dirname(initiatorConfigPath), { recursive: true });

      // Sort targets by ID before saving to ensure consistent file ordering
      if (config.targets) {
        config.targets.sort((a, b) => a.id - b.id);
      }

      // Save JSON with pretty formatting
      await fs.writeFile(initiatorConfigPath, JSON.stringify(config, null, 2));
    } catch (error) {
      throw new Error(`Error saving initiator configuration: ${error.message}`);
    }
  }

  /**
   * Update initiator name
   * @param {string} newName - New initiator name (IQN)
   * @returns {Promise<Object>} Update result
   */
  async updateInitiatorName(newName) {
    try {
      // Validate IQN format
      if (!newName || !newName.startsWith('iqn.')) {
        throw new Error('Initiator name must be a valid IQN starting with "iqn."');
      }

      // Load current configuration
      const config = await this.getInitiatorConfig();

      // Update initiator name
      config.initiator.name = newName;

      // Save configuration
      await this.saveInitiatorConfig(config);

      return {
        success: true,
        message: `Initiator name updated to '${newName}' successfully`,
        data: config,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error updating initiator name: ${error.message}`);
    }
  }

  /**
   * Add a new target to the initiator configuration
   * @param {Object} targetData - Target configuration data
   * @returns {Promise<Object>} Add target result
   */
  async addInitiatorTarget(targetData) {
    try {
      // Load current configuration
      const config = await this.getInitiatorConfig();

      // Validate target data
      if (!targetData.name) {
        throw new Error('Target name (IQN) is required');
      }

      if (!targetData.name.startsWith('iqn.')) {
        throw new Error('Target name must be a valid IQN starting with "iqn."');
      }

      if (!targetData.portal || !targetData.portal.address) {
        throw new Error('Target portal address is required');
      }

      // Check if target already exists (based on name)
      if (config.targets.some(target => target.name === targetData.name)) {
        throw new Error(`Target with name '${targetData.name}' already exists`);
      }

      // Create new target object
      const newTarget = {
        id: this.generateTimestampId(),
        name: targetData.name,
        portal: {
          address: targetData.portal.address,
          port: targetData.portal.port || "3260"
        },
        connection: {
          automount: targetData.connection?.automount || false
        }
      };

      // Add target to configuration
      config.targets.push(newTarget);

      // Save configuration
      await this.saveInitiatorConfig(config);

      // Auto-login if automount is enabled
      let loginResult = null;
      if (newTarget.connection.automount) {
        try {
          const targetPortal = `${newTarget.portal.address}:${newTarget.portal.port}`;
          loginResult = await this.loginInitiatorTarget(newTarget.name, targetPortal);
        } catch (loginError) {
          console.warn(`Auto-login failed for target ${newTarget.name}: ${loginError.message}`);
          loginResult = {
            success: false,
            error: loginError.message
          };
        }
      }

      return {
        success: true,
        message: `Target '${newTarget.name}' added successfully${newTarget.connection.automount ? (loginResult?.success ? ' and logged in' : ' but auto-login failed') : ''}`,
        data: {
          config: config,
          addedTarget: newTarget,
          autoLogin: loginResult
        },
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error adding target: ${error.message}`);
    }
  }

  /**
   * Update an existing target in the initiator configuration
   * @param {number} targetId - Target ID to update
   * @param {Object} updates - Target configuration updates
   * @returns {Promise<Object>} Update result
   */
  async updateInitiatorTarget(targetId, updates) {
    try {
      // Load current configuration
      const config = await this.getInitiatorConfig();

      // Find the target
      const targetIndex = config.targets.findIndex(target => target.id === targetId);
      if (targetIndex === -1) {
        throw new Error(`Target with ID ${targetId} not found`);
      }

      const oldTarget = config.targets[targetIndex];

      // Validate updates
      if (updates.name && !updates.name.startsWith('iqn.')) {
        throw new Error('Target name must be a valid IQN starting with "iqn."');
      }

      // Check if new name already exists (if name is being changed)
      if (updates.name && updates.name !== oldTarget.name) {
        if (config.targets.some(target => target.name === updates.name && target.id !== targetId)) {
          throw new Error(`Target with name '${updates.name}' already exists`);
        }
      }

      // Logout if target was connected (before update)
      if (oldTarget.name) {
        try {
          await this.logoutInitiatorTarget(oldTarget.name);
        } catch (logoutError) {
          console.warn(`Warning: Could not logout from target ${oldTarget.name}: ${logoutError.message}`);
        }
      }

      // Update the target
      const updatedTarget = {
        ...oldTarget,
        ...updates,
        id: targetId, // ID must not be changed
        portal: {
          ...oldTarget.portal,
          ...(updates.portal || {})
        },
        connection: {
          ...oldTarget.connection,
          ...(updates.connection || {})
        }
      };

      config.targets[targetIndex] = updatedTarget;

      // Save configuration
      await this.saveInitiatorConfig(config);

      // Auto-login if automount is enabled
      let loginResult = null;
      if (updatedTarget.connection.automount && !oldTarget.connection.automount) {
        try {
          const targetPortal = `${updatedTarget.portal.address}:${updatedTarget.portal.port}`;
          loginResult = await this.loginInitiatorTarget(updatedTarget.name, targetPortal);
        } catch (loginError) {
          console.warn(`Auto-login failed for updated target ${updatedTarget.name}: ${loginError.message}`);
          loginResult = {
            success: false,
            error: loginError.message
          };
        }
      }

      return {
        success: true,
        message: `Target '${updatedTarget.name}' updated successfully${loginResult?.success ? ' and logged in' : (loginResult ? ' but auto-login failed' : '')}`,
        data: {
          config: config,
          updatedTarget: updatedTarget,
          oldTarget: oldTarget,
          autoLogin: loginResult
        },
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error updating target: ${error.message}`);
    }
  }

  /**
   * Remove a target from the initiator configuration
   * @param {number} targetId - Target ID to remove
   * @returns {Promise<Object>} Remove result
   */
  async removeInitiatorTarget(targetId) {
    try {
      // Load current configuration
      const config = await this.getInitiatorConfig();

      // Find the target
      const targetIndex = config.targets.findIndex(target => target.id === targetId);
      if (targetIndex === -1) {
        throw new Error(`Target with ID ${targetId} not found`);
      }

      const targetToRemove = config.targets[targetIndex];

      // Logout if target was connected
      try {
        await this.logoutInitiatorTarget(targetToRemove.name);
      } catch (logoutError) {
        console.warn(`Warning: Could not logout from target ${targetToRemove.name}: ${logoutError.message}`);
      }

      // Remove target from configuration
      config.targets.splice(targetIndex, 1);

      // Save configuration
      await this.saveInitiatorConfig(config);

      return {
        success: true,
        message: `Target '${targetToRemove.name}' removed successfully`,
        data: {
          config: config,
          removedTarget: targetToRemove
        },
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error removing target: ${error.message}`);
    }
  }

  /**
   * Test connection to a target
   * @param {string} targetIp - Target IP address
   * @param {string|number} targetPort - Target port (default: 3260)
   * @returns {Promise<Object>} Connection test result
   */
  async testConnection(targetIp, targetPort = 3260) {
    try {
      if (!targetIp) {
        throw new Error('Target IP address is required');
      }

      // Execute discovery test with timeout
      const command = `timeout 5 iscsiadm -m discovery -t sendtargets -p ${targetIp}:${targetPort}`;

      try {
        const { stdout, stderr } = await execAsync(command);

        // If the command is successful, parse the discovered targets
        const discoveredTargets = [];
        if (stdout.trim()) {
          const lines = stdout.trim().split('\n');
          for (const line of lines) {
            const parts = line.split(' ');
            if (parts.length >= 2) {
              discoveredTargets.push({
                portal: parts[0],
                iqn: parts[1]
              });
            }
          }
        }

        return {
          success: true,
          message: `Connection test to ${targetIp}:${targetPort} successful`,
          data: {
            targetIp,
            targetPort,
            discoveredTargets,
            connected: true
          },
          timestamp: new Date().toISOString()
        };

      } catch (execError) {
        // Timeout or other error
        return {
          success: false,
          message: `Connection test to ${targetIp}:${targetPort} failed`,
          data: {
            targetIp,
            targetPort,
            connected: false,
            error: execError.message
          },
          timestamp: new Date().toISOString()
        };
      }

    } catch (error) {
      throw new Error(`Error testing connection: ${error.message}`);
    }
  }

  /**
   * Logout from a target
   * @param {string} targetIqn - Target IQN to logout from
   * @returns {Promise<Object>} Logout result
   */
  async logoutInitiatorTarget(targetIqn) {
    try {
      if (!targetIqn) {
        throw new Error('Target IQN is required');
      }

      // Logout from target
      const command = `iscsiadm -m node -T "${targetIqn}" --logout`;

      try {
        const { stdout, stderr } = await execAsync(command);

        return {
          success: true,
          message: `Successfully logged out from target '${targetIqn}'`,
          data: {
            targetIqn,
            output: stdout.trim()
          },
          timestamp: new Date().toISOString()
        };

      } catch (execError) {
        // Target might not have been logged in
        if (execError.message.includes('No matching sessions')) {
          return {
            success: true,
            message: `Target '${targetIqn}' was not logged in`,
            data: {
              targetIqn,
              wasLoggedIn: false
            },
            timestamp: new Date().toISOString()
          };
        } else {
          throw new Error(`Failed to logout from target '${targetIqn}': ${execError.message}`);
        }
      }

    } catch (error) {
      throw new Error(`Error logging out from target: ${error.message}`);
    }
  }

  /**
   * Login to a target
   * @param {string} targetIqn - Target IQN to login to
   * @param {string} targetPortal - Target portal (IP:port)
   * @returns {Promise<Object>} Login result
   */
  async loginInitiatorTarget(targetIqn, targetPortal) {
    try {
      if (!targetIqn || !targetPortal) {
        throw new Error('Target IQN and portal are required');
      }

      // First perform discovery
      const [ip, port] = targetPortal.split(':');
      const discoveryCommand = `iscsiadm -m discovery -t sendtargets -p ${targetPortal}`;

      try {
        await execAsync(discoveryCommand);
      } catch (discoveryError) {
        throw new Error(`Discovery failed: ${discoveryError.message}`);
      }

      // Then login
      const loginCommand = `iscsiadm -m node -T "${targetIqn}" -p ${targetPortal} --login`;

      try {
        const { stdout, stderr } = await execAsync(loginCommand);

        return {
          success: true,
          message: `Successfully logged in to target '${targetIqn}'`,
          data: {
            targetIqn,
            targetPortal,
            output: stdout.trim()
          },
          timestamp: new Date().toISOString()
        };

      } catch (loginError) {
        throw new Error(`Login failed: ${loginError.message}`);
      }

    } catch (error) {
      throw new Error(`Error logging in to target: ${error.message}`);
    }
  }

  /**
   * Get a specific initiator target by ID
   * @param {number} targetId - Target ID
   * @returns {Promise<Object>} Target configuration
   */
  async getInitiatorTarget(targetId) {
    try {
      const config = await this.getInitiatorConfig();

      const target = config.targets.find(t => t.id === targetId);
      if (!target) {
        throw new Error(`Target with ID ${targetId} not found`);
      }

      return {
        success: true,
        data: target,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error getting target: ${error.message}`);
    }
  }
}

module.exports = new IscsiService();