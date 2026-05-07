const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const crypto = require('crypto');
const dns = require('dns');
const dnsLookup = util.promisify(dns.lookup);

// Timestamp-basierter ID-Generator
const generateId = () => Date.now().toString();

class RemotesService {
  constructor() {
    this.remotesFile = '/boot/config/remotes.json';
    this.mountBasePath = '/mnt/remotes';
  }

  /**
   * Check if remote mounting is enabled in network settings
   * @returns {Promise<boolean>} True if remote mounting is enabled
   * @private
   */
  async _isRemoteMountingEnabled() {
    try {
      const mosService = require('./mos.service');
      const networkSettings = await mosService.getNetworkSettings();

      // Return the actual enabled status from services section
      return networkSettings.services?.remote_mounting?.enabled === true;
    } catch (error) {
      console.warn('Failed to check remote mounting setting, defaulting to disabled:', error.message);
      return false; // Default to disabled if we can't read settings
    }
  }

  /**
   * Encrypt password using JWT_SECRET
   * @param {string} plainPassword - Plain text password
   * @returns {string} Encrypted password in format "iv:authTag:encrypted"
   * @private
   */
  _encryptPassword(plainPassword) {
    if (!plainPassword) return '';

    const algorithm = 'aes-256-gcm';
    const key = crypto.scryptSync(process.env.JWT_SECRET, 'remotes-salt', 32);
    const iv = crypto.randomBytes(16);

    const cipher = crypto.createCipheriv(algorithm, key, iv);
    cipher.setAAD(Buffer.from('remotes-auth'));

    let encrypted = cipher.update(plainPassword, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  /**
   * Decrypt password using JWT_SECRET
   * @param {string} encryptedPassword - Encrypted password in format "iv:authTag:encrypted"
   * @returns {string} Plain text password
   * @private
   */
  _decryptPassword(encryptedPassword) {
    if (!encryptedPassword) return '';

    try {
      const [ivHex, authTagHex, encrypted] = encryptedPassword.split(':');
      if (!ivHex || !authTagHex || !encrypted) {
        throw new Error('Invalid encrypted password format');
      }

      const algorithm = 'aes-256-gcm';
      const key = crypto.scryptSync(process.env.JWT_SECRET, 'remotes-salt', 32);
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');

      const decipher = crypto.createDecipheriv(algorithm, key, iv);
      decipher.setAuthTag(authTag);
      decipher.setAAD(Buffer.from('remotes-auth'));

      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      throw new Error(`Failed to decrypt password: ${error.message}`);
    }
  }

  /**
   * Generate mount path for remote share
   * @param {string} server - Server IP or hostname
   * @param {string} share - Share name
   * @returns {string} Mount path
   * @private
   */
  _generateMountPath(server, share) {
    // Sanitize server and share names for filesystem
    const cleanServer = server.replace(/[^a-zA-Z0-9.-]/g, '_');
    // Strip leading/trailing slashes, replace remaining slashes with _, fallback to 'root' for /
    const cleanShare = share.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'root';

    return path.join(this.mountBasePath, cleanServer, cleanShare);
  }

  /**
   * Validate remote data
   * @param {Object} data - Remote data to validate
   * @throws {Error} If validation fails
   * @private
   */
  _validateRemoteData(data) {
    // Basic required fields
    const required = ['name', 'type', 'server', 'share'];

    for (const field of required) {
      if (!data[field] || data[field].toString().trim() === '') {
        throw new Error(`Field '${field}' is required`);
      }
    }

    if (!['smb', 'nfs'].includes(data.type)) {
      throw new Error("Type must be 'smb' or 'nfs'");
    }

    // For NFS, username and password are optional (not used)
    // For SMB, username and password are optional (guest access if not provided)

    if (data.type === 'smb' && data.version && !['1.0', '2.0', '3.0'].includes(data.version)) {
      throw new Error("SMB version must be '1.0', '2.0', or '3.0'");
    }

    // Validate uid/gid if provided
    if (data.uid !== undefined && data.uid !== null && (!Number.isInteger(data.uid) || data.uid < 0)) {
      throw new Error('UID must be a positive integer or null');
    }

    if (data.gid !== undefined && data.gid !== null && (!Number.isInteger(data.gid) || data.gid < 0)) {
      throw new Error('GID must be a positive integer or null');
    }

    // Validate server format (IP or hostname)
    const serverRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$|^[a-zA-Z0-9.-]+$/;
    if (!serverRegex.test(data.server)) {
      throw new Error('Invalid server format');
    }
  }

  /**
   * Validate connection test data
   * @param {Object} data - Connection test data to validate
   * @throws {Error} If validation fails
   * @private
   */
  _validateConnectionData(data) {
    // Basic required fields for connection test
    const required = ['type', 'server', 'share'];

    for (const field of required) {
      if (!data[field] || data[field].toString().trim() === '') {
        throw new Error(`Field '${field}' is required`);
      }
    }

    if (!['smb', 'nfs'].includes(data.type)) {
      throw new Error("Type must be 'smb' or 'nfs'");
    }

    // Validate server format (IP or hostname)
    const serverRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$|^[a-zA-Z0-9.-]+$/;
    if (!serverRegex.test(data.server)) {
      throw new Error('Invalid server format');
    }
  }

 /**
   * Create mount point directory
   * @param {string} mountPath - Path to create
   * @private
   */
  async _createMountPoint(mountPath) {
    try {
      await fs.mkdir(mountPath, { recursive: true });
      console.log(`Created mount point: ${mountPath}`);
    } catch (error) {
      throw new Error(`Failed to create mount point ${mountPath}: ${error.message}`);
    }
  }

  /**
   * Check if path is mounted
   * @param {string} mountPath - Path to check
   * @returns {boolean} True if mounted
   * @private
   */
  async _isMounted(mountPath) {
    try {
      const { stdout } = await execPromise('cat /proc/mounts');
      const lines = stdout.split('\n');

      for (const line of lines) {
        const fields = line.split(' ');
        if (fields.length >= 2 && fields[1] === mountPath) {
          return true;
        }
      }
      return false;
    } catch (error) {
      console.warn(`Warning: Could not check mount status for ${mountPath}: ${error.message}`);
      return false;
    }
  }

  /**
   * Check if mounted path is actually accessible (not stale)
   * @param {string} mountPath - Path to check
   * @returns {Promise<boolean>} True if accessible
   * @private
   */
  async _isMountAccessible(mountPath) {
    try {
      // Use stat with timeout to check if mount is accessible
      // If the mount is stale, this will timeout/fail
      await execPromise(`timeout 2 stat "${mountPath}" >/dev/null 2>&1`);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Load remotes from JSON file
   * @returns {Array} Array of remote objects
   * @private
   */
  async _loadRemotes() {
    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(this.remotesFile), { recursive: true });

      const data = await fs.readFile(this.remotesFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File doesn't exist, return empty array
        return [];
      }
      throw new Error(`Failed to load remotes: ${error.message}`);
    }
  }

  /**
   * Save remotes to JSON file
   * @param {Array} remotes - Array of remote objects
   * @private
   */
  async _saveRemotes(remotes) {
    try {
      await fs.mkdir(path.dirname(this.remotesFile), { recursive: true });
      await fs.writeFile(this.remotesFile, JSON.stringify(remotes, null, 2));
    } catch (error) {
      throw new Error(`Failed to save remotes: ${error.message}`);
    }
  }

  /**
   * List all remotes
   * @returns {Array} Array of remote objects with current status and masked password
   */
  async listRemotes() {
    try {
      const remotes = await this._loadRemotes();

      // Update status and mask password for each remote
      for (const remote of remotes) {
        const mountPath = this._generateMountPath(remote.server, remote.share);
        const isMounted = await this._isMounted(mountPath);

        if (isMounted) {
          // Check if mount is actually accessible
          const isAccessible = await this._isMountAccessible(mountPath);
          remote.status = isAccessible ? 'mounted' : 'unavailable';
        } else {
          remote.status = 'unmounted';
        }

        remote.password = 'SECRET'; // Mask password in responses
      }

      return remotes;
    } catch (error) {
      throw new Error(`Failed to list remotes: ${error.message}`);
    }
  }

  /**
   * Get remote by ID
   * @param {string} id - Remote ID
   * @returns {Object} Remote object with current status and masked password
   */
  async getRemoteById(id) {
    try {
      const remotes = await this._loadRemotes();
      const remote = remotes.find(r => r.id === id);

      if (!remote) {
        throw new Error(`Remote with ID ${id} not found`);
      }

      // Update status and mask password
      const mountPath = this._generateMountPath(remote.server, remote.share);
      const isMounted = await this._isMounted(mountPath);

      if (isMounted) {
        // Check if mount is actually accessible
        const isAccessible = await this._isMountAccessible(mountPath);
        remote.status = isAccessible ? 'mounted' : 'unavailable';
      } else {
        remote.status = 'unmounted';
      }

      remote.password = 'SECRET'; // Mask password in responses

      return remote;
    } catch (error) {
      throw new Error(`Failed to get remote: ${error.message}`);
    }
  }

  /**
   * Create a new remote share configuration
   * @param {Object} data - Remote share data
   * @returns {Object} Created remote
   */
  async createRemote(data) {
    // Check if remote mounting is enabled
    const remoteMountingEnabled = await this._isRemoteMountingEnabled();
    if (!remoteMountingEnabled) {
      throw new Error('Remote mounting is disabled in network settings');
    }

    try {
      // Validate input data
      this._validateRemoteData(data);

      const remotes = await this._loadRemotes();

      // Check for duplicate names
      if (remotes.some(r => r.name === data.name)) {
        throw new Error(`Remote with name '${data.name}' already exists`);
      }

      // Create new remote object (status is dynamic, not stored)
      const remote = {
        id: generateId(),
        name: data.name.trim(),
        type: data.type,
        server: data.server.trim(),
        share: data.type === 'nfs' && !data.share.trim().startsWith('/') ? `/${data.share.trim()}` : data.share.trim(),
        username: data.username && data.username.trim() ? data.username.trim() : null,
        password: data.password && data.password.trim() ? this._encryptPassword(data.password) : null,
        domain: data.domain && data.domain.trim() ? data.domain.trim() : null,
        version: data.version || (data.type === 'smb' ? '3.0' : null),
        uid: data.uid !== undefined ? data.uid : null,
        gid: data.gid !== undefined ? data.gid : null,
        auto_mount: data.auto_mount || false
      };

      remotes.push(remote);
      await this._saveRemotes(remotes);

      console.log(`Created remote: ${remote.name} (${remote.id})`);

      // Auto-mount if requested
      if (data.auto_mount) {
        try {
          console.log(`Auto-mounting remote: ${remote.name}`);
          await this.mountRemote(remote.id);
          console.log(`Successfully auto-mounted remote: ${remote.name}`);
        } catch (mountError) {
          console.warn(`Failed to auto-mount remote ${remote.name}: ${mountError.message}`);
          // Don't fail the creation if auto-mount fails, just log it
        }
      }

      return remote;
    } catch (error) {
      throw new Error(`Failed to create remote: ${error.message}`);
    }
  }

  /**
   * Update remote
   * @param {string} id - Remote ID
   * @param {Object} updateData - Data to update
   * @returns {Object} Updated remote object
   */
  async updateRemote(id, updateData) {
    try {
      const remotes = await this._loadRemotes();
      const remoteIndex = remotes.findIndex(r => r.id === id);

      if (remoteIndex === -1) {
        throw new Error(`Remote with ID ${id} not found`);
      }

      const remote = remotes[remoteIndex];

      // Check if remote is mounted - prevent updates to critical fields
      const mountPath = this._generateMountPath(remote.server, remote.share);
      const isMounted = await this._isMounted(mountPath);

      if (isMounted && (updateData.server || updateData.share || updateData.type)) {
        throw new Error('Cannot update server, share, or type while remote is mounted. Unmount first.');
      }

      // Validate updated data
      const updatedRemote = { ...remote, ...updateData };
      this._validateRemoteData(updatedRemote);

      // Check for duplicate names (excluding current remote)
      if (updateData.name && remotes.some(r => r.id !== id && r.name === updateData.name)) {
        throw new Error(`Remote with name '${updateData.name}' already exists`);
      }

      // Update fields
      if (updateData.name) remote.name = updateData.name.trim();
      if (updateData.type) remote.type = updateData.type;
      if (updateData.server) remote.server = updateData.server.trim();
      if (updateData.share) remote.share = remote.type === 'nfs' && !updateData.share.trim().startsWith('/') ? `/${updateData.share.trim()}` : updateData.share.trim();
      if (updateData.username !== undefined) remote.username = updateData.username && updateData.username.trim() ? updateData.username.trim() : null;
      if (updateData.password !== undefined) remote.password = updateData.password && updateData.password.trim() ? this._encryptPassword(updateData.password) : null;
      if (updateData.domain !== undefined) remote.domain = updateData.domain && updateData.domain.trim() ? updateData.domain.trim() : null;
      if (updateData.version) remote.version = updateData.version;
      if (updateData.uid !== undefined) remote.uid = updateData.uid;
      if (updateData.gid !== undefined) remote.gid = updateData.gid;
      if (updateData.auto_mount !== undefined) remote.auto_mount = updateData.auto_mount;

      remotes[remoteIndex] = remote;
      await this._saveRemotes(remotes);

      console.log(`Updated remote: ${remote.name} (${remote.id})`);
      return remote;
    } catch (error) {
      throw new Error(`Failed to update remote: ${error.message}`);
    }
  }

  /**
   * Delete remote
   * @param {string} id - Remote ID
   * @returns {Object} Deleted remote object
   */
  async deleteRemote(id) {
    try {
      const remotes = await this._loadRemotes();
      const remoteIndex = remotes.findIndex(r => r.id === id);

      if (remoteIndex === -1) {
        throw new Error(`Remote with ID ${id} not found`);
      }

      const remote = remotes[remoteIndex];

      // Check if remote is mounted and unmount it automatically
      const mountPath = this._generateMountPath(remote.server, remote.share);
      const isMounted = await this._isMounted(mountPath);

      if (isMounted) {
        // Automatically unmount before deleting
        try {
          await execPromise(`umount "${mountPath}"`);
        } catch (umountError) {
          // If unmount fails, still try to proceed with deletion
          console.warn(`Warning: Could not unmount remote ${remote.name} before deletion`);
        }
      }

      // Remove from array
      remotes.splice(remoteIndex, 1);
      await this._saveRemotes(remotes);

      // Cleanup empty directories
      await this._cleanupMountPoint(remote.server, remote.share);

      return remote;
    } catch (error) {
      throw new Error(`Failed to delete remote: ${error.message}`);
    }
  }

  /**
   * Mount a remote share
   * @param {string} id - Remote ID
   * @returns {Object} Mount result
   */
  async mountRemote(id) {
    // Check if remote mounting is enabled
    const remoteMountingEnabled = await this._isRemoteMountingEnabled();
    if (!remoteMountingEnabled) {
      throw new Error('Remote mounting is disabled in network settings');
    }

    try {
      const remotes = await this._loadRemotes();
      const remote = remotes.find(r => r.id === id);

      if (!remote) {
        throw new Error(`Remote with ID ${id} not found`);
      }

      const mountPath = this._generateMountPath(remote.server, remote.share);

      // Check if already mounted
      if (await this._isMounted(mountPath)) {
        throw new Error('Remote is already mounted');
      }

      // Create mount point
      await this._createMountPoint(mountPath);

      // Decrypt password (null-safe)
      const password = remote.password ? this._decryptPassword(remote.password) : null;

      // Test connection before mounting
      const testResult = await this.connectiontest({
        type: remote.type,
        server: remote.server,
        share: remote.share,
        username: remote.username,
        password: password,
        domain: remote.domain
      });

      if (!testResult.success) {
        throw new Error(`Connection test failed: ${testResult.message}`);
      }

      // Resolve hostname to IP before mounting (mount.cifs kernel resolver
      // does not support DNS search domains and may fail with bare hostnames)
      let resolvedServer = remote.server;
      try {
        const resolved = await dnsLookup(remote.server);
        resolvedServer = resolved.address;
        if (resolvedServer !== remote.server) {
          console.log(`Resolved ${remote.server} to ${resolvedServer}`);
        }
      } catch (dnsError) {
        console.warn(`DNS lookup failed for ${remote.server}, using as-is: ${dnsError.message}`);
      }

      let mountCommand;

      if (remote.type === 'smb') {
        // Build SMB mount command
        const server = resolvedServer;
        const share = remote.share;
        const username = remote.username;
        const domain = remote.domain;
        const version = remote.version || '3.0';

        let options;

        // Guest access if no username/password provided (null or empty)
        if (!username || !password) {
          options = `guest,vers=${version},iocharset=utf8,noperm`;
        } else {
          // Authenticated access
          options = `username=${username},password=${password},vers=${version},iocharset=utf8,noperm`;
          if (domain) {
            options += `,domain=${domain}`;
          }
        }

        // Add uid/gid if specified (null means root)
        if (remote.uid !== null) {
          options += `,uid=${remote.uid}`;
        }
        if (remote.gid !== null) {
          options += `,gid=${remote.gid}`;
        }

        mountCommand = `mount -t cifs //${server}/${share} "${mountPath}" -o ${options}`;
      } else if (remote.type === 'nfs') {
        // Build NFS mount command
        const server = resolvedServer;
        const share = remote.share;

        let options = 'vers=4,soft,retrans=2,timeo=50';

        // Add uid/gid if specified (null means root)
        if (remote.uid !== null) {
          options += `,uid=${remote.uid}`;
        }
        if (remote.gid !== null) {
          options += `,gid=${remote.gid}`;
        }

        // Normalize share path: ensure exactly one leading slash
        const nfsExportPath = share.startsWith('/') ? share : `/${share}`;
        mountCommand = `mount -t nfs ${server}:${nfsExportPath} "${mountPath}" -o ${options}`;
      } else {
        throw new Error(`Unsupported remote type: ${remote.type}`);
      }

      // Execute mount command with secure error handling
      try {
        await execPromise(mountCommand, { timeout: 5000 });
      } catch (mountError) {
        // Log actual error for diagnosis (stderr often contains the real reason)
        const errMsg = (mountError.stderr || mountError.message || '').replace(/password=[^\s,]*/gi, 'password=***');
        console.error(`Mount failed for //${remote.server}/${remote.share}: ${errMsg}`);
        // Don't expose the mount command (which may contain password) in error message
        throw new Error(`Unable to mount ${remote.type.toUpperCase()} share //${remote.server}/${remote.share}`);
      }

      // Make the mount point a shared mount (for bind mount propagation)
      try {
        await execPromise(`mount --make-shared "${mountPath}"`);
        console.log(`Made mount point shared: ${mountPath}`);
      } catch (sharedError) {
        console.warn(`Warning: Could not make mount shared: ${sharedError.message}`);
        // Don't fail the mount if --make-shared fails
      }

      return {
        success: true,
        message: `Remote '${remote.name}' mounted successfully`,
        mountPath: mountPath
      };
    } catch (error) {
      throw new Error(`Failed to mount remote: ${error.message}`);
    }
  }

  /**
   * Clean up empty mount point directories
   * @param {string} server - Server IP or hostname
   * @param {string} share - Share name
   * @private
   */
  async _cleanupMountPoint(server, share) {
    try {
      const sharePath = this._generateMountPath(server, share);
      const serverPath = path.join(this.mountBasePath, server.replace(/[^a-zA-Z0-9.-]/g, '_'));

      // Try to remove share directory (only works if empty)
      try {
        await execPromise(`rmdir "${sharePath}" 2>/dev/null`);
        console.log(`Removed empty share directory: ${sharePath}`);
      } catch (error) {
        // Directory not empty or doesn't exist - that's fine
      }

      // Check if server directory is now empty and remove it
      try {
        const { stdout } = await execPromise(`ls -A "${serverPath}" 2>/dev/null | wc -l`);
        const fileCount = parseInt(stdout.trim());

        if (fileCount === 0) {
          await execPromise(`rmdir "${serverPath}" 2>/dev/null`);
          console.log(`Removed empty server directory: ${serverPath}`);
        }
      } catch (error) {
        // Directory doesn't exist or can't be removed - that's fine
      }
    } catch (error) {
      console.warn(`Warning: Could not cleanup mount point: ${error.message}`);
      // Don't throw error, cleanup is optional
    }
  }

  /**
   * Unmount remote share
   * @param {string} id - Remote ID
   * @returns {Object} Unmount result
   */
  async unmountRemote(id) {
    try {
      const remotes = await this._loadRemotes();
      const remote = remotes.find(r => r.id === id);

      if (!remote) {
        throw new Error(`Remote with ID ${id} not found`);
      }

      const mountPath = this._generateMountPath(remote.server, remote.share);

      // Check if mounted
      if (!(await this._isMounted(mountPath))) {
        throw new Error('Remote is not mounted');
      }

      try {
        await execPromise(`umount "${mountPath}"`);
      } catch (umountError) {
        throw new Error(`Unable to unmount remote '${remote.name}'`);
      }

      // Cleanup empty directories
      await this._cleanupMountPoint(remote.server, remote.share);

      return {
        success: true,
        message: `Remote '${remote.name}' unmounted successfully`
      };
    } catch (error) {
      throw new Error(`Failed to unmount remote: ${error.message}`);
    }
  }

  /**
   * Unmount all mounted remotes
   * @returns {Promise<Object>} Result with unmounted remotes count
   */
  async unmountAllRemotes() {
    try {
      const remotes = await this.listRemotes();
      // Include both 'mounted' and 'unavailable' (unavailable means mounted but server unreachable)
      const mountedRemotes = remotes.filter(remote => remote.status === 'mounted' || remote.status === 'unavailable');

      let unmountedCount = 0;
      const errors = [];

      for (const remote of mountedRemotes) {
        try {
          await this.unmountRemote(remote.id);
          unmountedCount++;
          console.log(`Unmounted remote: ${remote.name} (${remote.server}/${remote.share})`);
        } catch (error) {
          errors.push(`Failed to unmount ${remote.name}: ${error.message}`);
        }
      }

      return {
        success: true,
        message: `Unmounted ${unmountedCount} of ${mountedRemotes.length} remotes`,
        unmountedCount,
        totalMounted: mountedRemotes.length,
        errors: errors.length > 0 ? errors : undefined
      };
    } catch (error) {
      throw new Error(`Failed to unmount all remotes: ${error.message}`);
    }
  }

  /**
   * List all available shares from a server
   * @param {string} server - Server IP or hostname
   * @param {string} type - Share type ('smb' or 'nfs')
   * @param {string} username - Username for authentication (SMB optional, can use guest)
   * @param {string} password - Password for authentication (SMB optional, can use guest)
   * @param {string} domain - Domain for authentication (SMB only, optional)
   * @returns {Array} List of share names
   */
  async listServerShares(server, type, username = '', password = '', domain = '') {
    if (!server || !type) {
      throw new Error('Server and type are required');
    }

    if (!['smb', 'nfs'].includes(type)) {
      throw new Error("Type must be 'smb' or 'nfs'");
    }

    if (type === 'smb') {
      // List SMB shares using smbclient
      // Try with credentials if provided, otherwise use guest access
      let smbCommand;

      if (username && password) {
        // Authenticated access
        if (domain) {
          smbCommand = `smbclient -L //${server} -U ${domain}/${username}%${password} 2>/dev/null | grep 'Disk' | awk '{print $1}'`;
        } else {
          smbCommand = `smbclient -L //${server} -U ${username}%${password} 2>/dev/null | grep 'Disk' | awk '{print $1}'`;
        }
      } else {
        // Guest access (no credentials)
        smbCommand = `smbclient -L //${server} -U guest% -N 2>/dev/null | grep 'Disk' | awk '{print $1}'`;
      }

      try {
        const { stdout } = await execPromise(smbCommand);

        // Parse share names from output
        const shares = stdout
          .split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0);

        // If no shares found, it might be a connection error
        if (shares.length === 0) {
          throw new Error('No shares found or connection failed');
        }

        return shares;
      } catch (error) {
        // Don't expose the command (which may contain password) in error message
        throw new Error(`Failed to list SMB shares from ${server}`);
      }
    } else if (type === 'nfs') {
      // List NFS exports using showmount
      try {
        // First check if server is reachable
        await execPromise(`ping -c 1 -W 5 ${server}`);

        // Get NFS exports
        const { stdout } = await execPromise(`timeout 5 showmount -e ${server} 2>/dev/null`);
        const lines = stdout.split('\n');

        // Parse export paths (skip header line)
        const shares = [];
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.length === 0) continue;

          const parts = line.split(/\s+/);
          if (parts.length > 0 && parts[0].startsWith('/')) {
            shares.push(parts[0]);
          }
        }

        if (shares.length === 0) {
          throw new Error('No NFS exports found or connection failed');
        }

        return shares;
      } catch (error) {
        throw new Error(`Failed to list NFS exports from ${server}`);
      }
    }
  }

  /**
   * Test connection to remote share without mounting
   * @param {Object} data - Remote connection data
   * @returns {Object} Test result
   */
  async connectiontest(data) {
    try {
      // Validate input data (name is not required for connection test)
      this._validateConnectionData(data);

      if (data.type === 'smb') {
        // Test SMB connection using smbclient
        const server = data.server;
        const share = data.share;
        const username = data.username;
        const password = data.password;
        const domain = data.domain || '';

        let smbCommand;

        // Guest access if no username/password provided (null or empty)
        if (!username || !password) {
          smbCommand = `smbclient //${server}/${share} -U guest% -N -c "ls" 2>&1`;
        } else {
          // Authenticated access
          if (domain) {
            smbCommand = `smbclient //${server}/${share} -U ${domain}/${username}%${password} -c "ls" 2>&1`;
          } else {
            smbCommand = `smbclient //${server}/${share} -U ${username}%${password} -c "ls" 2>&1`;
          }
        }

        try {
          await execPromise(smbCommand);
          return {
            success: true,
            message: `Successfully connected to SMB share //${server}/${share}`,
            type: 'smb'
          };
        } catch (error) {
          // Don't include command in error message to avoid exposing password
          throw new Error(`Unable to connect to SMB share //${server}/${share}`);
        }
      } else if (data.type === 'nfs') {
        // Test NFS connection using showmount to check available exports
        const server = data.server;
        const share = data.share;

        try {
          // First check if server is reachable
          await execPromise(`ping -c 1 -W 5 ${server}`);

          // Then check if the specific share is exported
          const { stdout } = await execPromise(`timeout 5 showmount -e ${server} 2>&1`);
          const exports = stdout.split('\n');

          // Normalize share for comparison: ensure leading slash
          const normalizedShare = share.startsWith('/') ? share : `/${share}`;

          // Check if our share is in the exports list
          const shareFound = exports.some(line => {
            const exportPath = line.split(/\s+/)[0];
            return exportPath === normalizedShare;
          });

          if (!shareFound) {
            throw new Error(`Share '${normalizedShare}' not found in NFS exports`);
          }

          return {
            success: true,
            message: `Successfully connected to NFS share ${server}:${normalizedShare}`,
            type: 'nfs'
          };
        } catch (showmountError) {
          // Fallback to basic ping test if showmount fails
          try {
            await execPromise(`ping -c 1 -W 5 ${server}`);
            return {
              success: true,
              message: `NFS server ${server} is reachable (share availability not verified)`,
              type: 'nfs'
            };
          } catch (pingError) {
            throw new Error(`Unable to connect to NFS server ${server}`);
          }
        }
      } else {
        throw new Error(`Unsupported remote type: ${data.type}`);
      }
    } catch (error) {
      return {
        success: false,
        message: `Connection test failed: ${error.message}`,
        type: data.type || 'unknown'
      };
    }
  }
}

module.exports = RemotesService;
