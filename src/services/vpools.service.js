const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const PoolHelpers = require('./pools/pool-helpers');

/**
 * VpoolsService manages MergerFS Path Pools ("vpools").
 *
 * Unlike regular pools, vpools do not manage block devices. They union
 * arbitrary existing filesystem paths via mergerfs directly under /mnt/{name}.
 * Persistence mirrors pools.json: a top-level array in /boot/config/vpools.json.
 */
class VpoolsService {
  constructor(eventEmitter = null) {
    this.vpoolsFile = '/boot/config/vpools.json';
    this.mountBasePath = '/mnt';
    this.eventEmitter = eventEmitter;
    // Lazy PoolsService instance for shared helpers (mount status, space, deps)
    this.poolsService = null;
  }

  /**
   * Lazily resolve a PoolsService instance to reuse shared helper logic
   * (mount status, device space, service dependency checks).
   * @returns {Object} PoolsService instance
   * @private
   */
  _getPoolsService() {
    if (!this.poolsService) {
      const PoolsService = require('./pools.service');
      this.poolsService = new PoolsService();
    }
    return this.poolsService;
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
   * Ensure the vpools file exists
   * @private
   */
  async _ensureVpoolsFile() {
    try {
      await fs.access(this.vpoolsFile);
    } catch (error) {
      const dir = path.dirname(this.vpoolsFile);
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (err) {
        // Directory might already exist
      }
      await fs.writeFile(this.vpoolsFile, JSON.stringify([], null, 2));
    }
  }

  /**
   * Read vpools data from file
   * @returns {Promise<Array>} Array of vpool objects
   * @private
   */
  async _readVpools() {
    await this._ensureVpoolsFile();
    const data = await fs.readFile(this.vpoolsFile, 'utf8');
    try {
      return JSON.parse(data);
    } catch (error) {
      throw new Error(`Invalid vpools file format: ${error.message}`);
    }
  }

  /**
   * Write vpools data to file, stripping dynamic runtime fields
   * @param {Array} vpoolsData - Array of vpool objects
   * @private
   */
  async _writeVpools(vpoolsData) {
    await this._ensureVpoolsFile();

    const cleanedVpools = vpoolsData.map(vpool => {
      const cleanVpool = { ...vpool };
      // Remove dynamic runtime properties that should not be persisted
      delete cleanVpool.status;
      delete cleanVpool.mountPoint;
      return cleanVpool;
    });

    await fs.writeFile(this.vpoolsFile, JSON.stringify(cleanedVpools, null, 2));

    this._emitEvent('vpools:updated', { vpools: vpoolsData });
  }

  /**
   * Normalize a path: make absolute and strip trailing slash
   * @param {string} p - Input path
   * @returns {string} Normalized path
   * @private
   */
  _normalizePath(p) {
    const resolved = path.resolve(p);
    return resolved.length > 1 ? resolved.replace(/\/+$/, '') : resolved;
  }

  /**
   * Validate that all configured paths exist and are directories.
   * Throws on the first invalid path (mount is aborted).
   * @param {string[]} paths - vpool.paths entries
   * @throws {Error} If a path is missing or not a directory
   * @private
   */
  async _validatePaths(paths) {
    for (const p of paths) {
      let stat;
      try {
        stat = await fs.stat(p);
      } catch (error) {
        throw new Error(`Path does not exist or is not accessible: ${p}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Path is not a directory: ${p}`);
      }
    }
  }

  /**
   * Mount a vpool's mergerfs union at /mnt/{name}.
   * Shared by createVpool (automount) and mountVpoolById.
   * @param {Object} vpool - Vpool object
   * @private
   */
  async _mountVpool(vpool) {
    const poolsService = this._getPoolsService();
    const mountPoint = path.join(this.mountBasePath, vpool.name);

    // Validate every source path before doing anything
    await this._validatePaths(vpool.paths);

    if (await poolsService._isMounted(mountPoint)) {
      throw new Error(`Pool "${vpool.name}" is already mounted at ${mountPoint}`);
    }

    // Source branches in configured order
    const sourcePaths = vpool.paths;

    // Create the mount point
    await fs.mkdir(mountPoint, { recursive: true });

    const mergerfsOptions = poolsService._buildMergerfsOptions(vpool.config);
    const mergerfsCommand = `mergerfs ${sourcePaths.join(':')} ${mountPoint} -o ${mergerfsOptions}`;
    await execPromise(mergerfsCommand);

    // Set ownership of mount point to mos:mos (non-recursive)
    try {
      await execPromise(`chown mos:mos "${mountPoint}"`);
    } catch (chownError) {
      console.warn(`Warning: Could not chown mount point: ${chownError.message}`);
    }

    // Make the mount point a shared mount if configured
    if (vpool.config?.shared === true) {
      try {
        await execPromise(`mount --make-shared "${mountPoint}"`);
        console.log(`Made vpool mount point shared: ${mountPoint}`);
      } catch (sharedError) {
        console.warn(`Warning: Could not make mount shared: ${sharedError.message}`);
      }
    }
  }

  /**
   * List all vpools with mount status and storage info.
   * Storage comes from a single df on the mergerfs union (like regular pools);
   * when not mounted, only { mounted: false } is returned (no disk access).
   * @param {Object} filters - Reserved for future filtering
   * @param {Object} user - User object for byte formatting
   * @returns {Promise<Array>} Array of vpool objects
   */
  async listVpools(filters = {}, user = null) {
    try {
      const vpools = await this._readVpools();
      const poolsService = this._getPoolsService();

      for (const vpool of vpools) {
        const mountPoint = path.join(this.mountBasePath, vpool.name);
        const isMounted = await poolsService._isMounted(mountPoint);

        if (isMounted) {
          vpool.status = await poolsService.getDeviceSpace(mountPoint, user);
          vpool.mountPoint = mountPoint;
        } else {
          vpool.status = { mounted: false };
        }
      }

      return vpools;
    } catch (error) {
      throw new Error(`Error listing vpools: ${error.message}`);
    }
  }

  /**
   * Get a single vpool by ID (enriched like listVpools)
   * @param {string} id - Vpool ID
   * @param {Object} user - User object for byte formatting
   * @returns {Promise<Object>} Vpool object
   */
  async getVpoolById(id, user = null) {
    try {
      const vpools = await this.listVpools({}, user);
      const vpool = vpools.find(v => v.id === id);
      if (!vpool) {
        throw new Error(`Pool with ID "${id}" not found`);
      }
      return vpool;
    } catch (error) {
      throw new Error(`Error getting vpool: ${error.message}`);
    }
  }

  /**
   * Create a new vpool from a list of existing filesystem paths.
   * @param {string} name - Vpool name
   * @param {string[]} paths - Source directory paths to union
   * @param {Object} options - Additional options (automount, comment, config)
   * @returns {Promise<Object>} Result with success status and the new vpool
   */
  async createVpool(name, paths, options = {}) {
    try {
      if (!name) {
        throw new Error('Pool name is required');
      }
      if (!Array.isArray(paths) || paths.length === 0) {
        throw new Error('At least one path is required for a vpool');
      }

      // Validate name format/reserved + ensure global uniqueness (pools + vpools)
      await PoolHelpers.assertGlobalPoolNameAvailable(name);

      // Normalize and deduplicate paths, keep first occurrence order
      const normalizedPaths = [];
      for (const p of paths) {
        if (typeof p !== 'string' || p.trim() === '') {
          throw new Error('Each path must be a non-empty string');
        }
        const normalized = this._normalizePath(p.trim());
        if (!normalizedPaths.includes(normalized)) {
          normalizedPaths.push(normalized);
        }
      }

      const vpools = await this._readVpools();

      const vpool = {
        id: PoolHelpers.generatePoolId(),
        name,
        type: 'vpool',
        automount: options.automount !== false,
        comment: options.comment || '',
        index: PoolHelpers.getNextPoolIndex(vpools),
        paths: normalizedPaths,
        config: {
          policies: {
            create: options.config?.policies?.create || 'mspmfs',
            search: options.config?.policies?.search || 'ff'
          },
          shared: options.config?.shared || false
        }
      };

      // Mount immediately when automount is enabled (default true).
      // Done before persisting so a failed mount never leaves a vpool in vpools.json.
      if (vpool.automount) {
        await this._mountVpool(vpool);
      }

      vpools.push(vpool);
      await this._writeVpools(vpools);

      return {
        success: true,
        message: `Pool "${name}" (ID: ${vpool.id}) created successfully`,
        pool: vpool
      };
    } catch (error) {
      throw new Error(`Error creating vpool: ${error.message}`);
    }
  }

  /**
   * Mount a vpool by ID
   * @param {string} id - Vpool ID
   * @param {Object} user - User object with byte_format preference
   * @returns {Promise<Object>} Result with success status
   */
  async mountVpoolById(id, user = null) {
    try {
      const vpools = await this._readVpools();
      const vpool = vpools.find(v => v.id === id);
      if (!vpool) {
        throw new Error(`Pool with ID "${id}" not found`);
      }

      await this._mountVpool(vpool);

      const mountPoint = path.join(this.mountBasePath, vpool.name);
      const spaceInfo = await this._getPoolsService().getDeviceSpace(mountPoint, user);

      return {
        success: true,
        message: `Pool "${vpool.name}" (ID: ${id}) mounted successfully`,
        pool: {
          id: vpool.id,
          name: vpool.name,
          status: spaceInfo
        }
      };
    } catch (error) {
      throw new Error(`Error mounting vpool: ${error.message}`);
    }
  }

  /**
   * Unmount a vpool by ID. Only the union at /mnt/{name} is unmounted;
   * source paths are left untouched.
   * @param {string} id - Vpool ID
   * @param {Object} options - { force }
   * @returns {Promise<Object>} Result with success status
   */
  async unmountVpoolById(id, options = {}) {
    try {
      const vpools = await this._readVpools();
      const vpool = vpools.find(v => v.id === id);
      if (!vpool) {
        throw new Error(`Pool with ID "${id}" not found`);
      }

      const poolsService = this._getPoolsService();
      const mountPoint = path.join(this.mountBasePath, vpool.name);

      // Check for service dependencies unless force is used
      if (!options.force) {
        const dependencyCheck = await poolsService._checkServiceDependencies(vpool.name);
        if (dependencyCheck.hasDependencies) {
          const serviceList = dependencyCheck.dependencies.map(dep =>
            `${dep.service} (${dep.path})`
          ).join(', ');
          throw new Error(
            `Cannot unmount pool "${vpool.name}": in use by ${serviceList}. Stop services first or use force=true.`
          );
        }
      }

      if (await poolsService._isMounted(mountPoint)) {
        const command = options.force ? `umount -l "${mountPoint}"` : `umount "${mountPoint}"`;
        await execPromise(command);
      }

      // Remove the (now empty) mount point directory, mirroring delete behavior.
      // The mount point is recreated on the next mount.
      try {
        await fs.rmdir(mountPoint);
      } catch (error) {
        // Ignore: directory missing or not empty
      }

      return {
        success: true,
        message: `Pool "${vpool.name}" (ID: ${id}) unmounted successfully`,
        pool: {
          id: vpool.id,
          name: vpool.name
        }
      };
    } catch (error) {
      throw new Error(`Error unmounting vpool: ${error.message}`);
    }
  }

  /**
   * Remove a vpool by ID. Unmounts the union (if mounted) and removes the
   * entry from vpools.json. Source paths are never touched.
   * @param {string} id - Vpool ID
   * @param {Object} options - { force }
   * @returns {Promise<Object>} Result with success status
   */
  async removeVpoolById(id, options = {}) {
    try {
      const vpools = await this._readVpools();
      const vpoolIndex = vpools.findIndex(v => v.id === id);
      if (vpoolIndex === -1) {
        throw new Error(`Pool with ID "${id}" not found`);
      }

      const vpool = vpools[vpoolIndex];
      const poolsService = this._getPoolsService();
      const mountPoint = path.join(this.mountBasePath, vpool.name);

      // Check for service dependencies unless force is used
      if (!options.force) {
        const dependencyCheck = await poolsService._checkServiceDependencies(vpool.name);
        if (dependencyCheck.hasDependencies) {
          const serviceList = dependencyCheck.dependencies.map(dep =>
            `${dep.service} (${dep.path})`
          ).join(', ');
          throw new Error(
            `Cannot delete pool "${vpool.name}": in use by ${serviceList}. Stop services first or use force=true.`
          );
        }
      }

      // Unmount the union if it is currently mounted
      if (await poolsService._isMounted(mountPoint)) {
        const command = options.force ? `umount -l "${mountPoint}"` : `umount "${mountPoint}"`;
        await execPromise(command);
      }

      // Remove the mount point directory if it is empty
      try {
        await fs.rmdir(mountPoint);
      } catch (error) {
        // Ignore: directory missing or not empty
      }

      const removedVpool = vpools.splice(vpoolIndex, 1)[0];
      await this._writeVpools(vpools);

      return {
        success: true,
        message: `Pool "${removedVpool.name}" (ID: ${id}) removed successfully`,
        pool: removedVpool
      };
    } catch (error) {
      throw new Error(`Error removing vpool: ${error.message}`);
    }
  }

  /**
   * Toggle the automount flag for a vpool (flag only, no mount/unmount)
   * @param {string} id - Vpool ID
   * @param {boolean} automount - New automount value
   * @returns {Promise<Object>} Result with success status
   */
  async toggleAutomountById(id, automount) {
    try {
      if (typeof automount !== 'boolean') {
        throw new Error('Automount value must be a boolean');
      }

      const vpools = await this._readVpools();
      const vpoolIndex = vpools.findIndex(v => v.id === id);
      if (vpoolIndex === -1) {
        throw new Error(`Pool with ID "${id}" not found`);
      }

      vpools[vpoolIndex].automount = automount;
      await this._writeVpools(vpools);

      return {
        success: true,
        message: `Automount ${automount ? 'enabled' : 'disabled'} for pool "${vpools[vpoolIndex].name}" (ID: ${id})`,
        pool: vpools[vpoolIndex]
      };
    } catch (error) {
      throw new Error(`Error toggling automount: ${error.message}`);
    }
  }

  /**
   * Update the display order (index) of vpools
   * @param {Array} order - Array of { id, index }
   * @returns {Promise<Object>} Result with success status
   */
  async updateVpoolsOrder(order) {
    try {
      if (!Array.isArray(order)) {
        throw new Error('Order must be an array');
      }

      const vpools = await this._readVpools();

      // Validate all entries first
      for (const item of order) {
        if (!item.id || typeof item.index !== 'number') {
          throw new Error('Each order item must have id and index properties');
        }
        const vpool = vpools.find(v => v.id === item.id);
        if (!vpool) {
          throw new Error(`Pool with ID "${item.id}" not found`);
        }
      }

      // Apply new indices
      for (const item of order) {
        const vpool = vpools.find(v => v.id === item.id);
        if (vpool) {
          vpool.index = item.index;
        }
      }

      await this._writeVpools(vpools);

      return {
        success: true,
        message: `Successfully updated order for ${order.length} pool(s)`,
        updatedCount: order.length
      };
    } catch (error) {
      throw new Error(`Error updating vpools order: ${error.message}`);
    }
  }
}

module.exports = VpoolsService;
