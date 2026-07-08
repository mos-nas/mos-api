const fs = require('fs').promises;
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { exec, spawn } = require('child_process');
const util = require('util');
const { generateSecret, generateURI, verifySync } = require('otplib');
const QRCode = require('qrcode');
const config = require('../config');

const execAsync = util.promisify(exec);
const ENV_FILE = '/boot/config/api/env';

class UserService {
  constructor() {
    this.users = [];
    this.lastLoad = 0;
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes cache
    // Admin tokens caching
    this.adminTokens = [];
    this.adminTokensLastLoad = 0;
    this.systemConfigPath = '/boot/config/system';
    this.mfaPendingSetups = new Map();
    this.mfaBlacklistedTokens = new Set();
  }

  async ensureUserFile() {
    try {
      await fs.access(config.usersFilePath);
      // Check if file is empty or invalid
      const data = await fs.readFile(config.usersFilePath, 'utf8');
      if (!data.trim() || data.trim() === '[]') {
        await fs.writeFile(config.usersFilePath, JSON.stringify([], null, 2));
      }
    } catch {
      // Create file with empty array if it doesn't exist
      await fs.writeFile(config.usersFilePath, JSON.stringify([], null, 2));
    }
  }

  async ensureAdminTokenFile() {
    try {
      await fs.access(config.adminTokensFilePath);
      // Check if file is empty or invalid
      const data = await fs.readFile(config.adminTokensFilePath, 'utf8');
      if (!data.trim() || data.trim() === '[]') {
        await fs.writeFile(config.adminTokensFilePath, JSON.stringify([], null, 2));
      }
    } catch {
      // Create file with empty array if it doesn't exist
      await fs.writeFile(config.adminTokensFilePath, JSON.stringify([], null, 2), { mode: 0o600 });
    }
  }

  async loadUsers() {
    const now = Date.now();
    // Only reload if cache is expired
    if (now - this.lastLoad > this.cacheTimeout) {
      try {
        await this.ensureUserFile();
        const data = await fs.readFile(config.usersFilePath, 'utf8');
        // Handle empty or invalid file content
        try {
          this.users = data.trim() ? JSON.parse(data) : [];
          // Ensure users is always an array
          if (!Array.isArray(this.users)) {
            this.users = [];
          }
        } catch (parseError) {
          console.error('Error parsing users file:', parseError);
          this.users = [];
        }
        this.lastLoad = now;
      } catch (error) {
        console.error('Error loading users:', error);
        this.users = []; // Set to empty array in case of error
        this.lastLoad = now;
      }
    }
    return this.users;
  }

  async loadAdminTokens() {
    const now = Date.now();
    // Only reload if cache is expired
    if (now - this.adminTokensLastLoad > this.cacheTimeout) {
      try {
        await this.ensureAdminTokenFile();
        const data = await fs.readFile(config.adminTokensFilePath, 'utf8');

        try {
          this.adminTokens = data.trim() ? JSON.parse(data) : [];
          // Ensure tokens is always an array
          if (!Array.isArray(this.adminTokens)) {
            this.adminTokens = [];
          }
        } catch (parseError) {
          console.error('Error parsing admin tokens file:', parseError);
          this.adminTokens = [];
        }

        this.adminTokensLastLoad = now;
      } catch (error) {
        console.error('Error loading admin tokens:', error);
        this.adminTokens = [];
        this.adminTokensLastLoad = now;
      }
    }
    return this.adminTokens;
  }

  async saveUsers(users) {
    try {
      await fs.writeFile(config.usersFilePath, JSON.stringify(users, null, 2));
      this.users = users;
      this.lastLoad = Date.now();
    } catch (error) {
      console.error('Error saving users:', error);
      throw new Error('Error saving user data');
    }
  }

  async saveAdminTokens(tokens) {
    try {
      await fs.writeFile(config.adminTokensFilePath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
      this.adminTokens = tokens;
      this.adminTokensLastLoad = Date.now();
    } catch (error) {
      console.error('Error saving admin tokens:', error);
      throw new Error('Error saving admin token data');
    }
  }

  async _ensureUserDefaults(userId) {
    const users = await this.loadUsers();
    const index = users.findIndex(u => u.id === userId);
    if (index === -1) return null;

    let dirty = false;
    if (users[index].hide_inactive_menus === undefined) {
      users[index].hide_inactive_menus = true;
      dirty = true;
    }
    if (users[index].group_menus === undefined) {
      users[index].group_menus = false;
      dirty = true;
    }

    if (dirty) {
      await this.saveUsers(users);
    }

    return users[index];
  }

  _sanitizeUser(user) {
    const sanitizedUser = { ...user };
    sanitizedUser.password = 'SECRET';
    sanitizedUser.mfa_enabled = !!user.mfa_enabled;
    delete sanitizedUser.mfa_secret;
    delete sanitizedUser.mfa_recovery_code;
    return sanitizedUser;
  }

  _sanitizeUsers(users) {
    return users.map(this._sanitizeUser);
  }

  _sanitizeAdminToken(token) {
    const sanitized = { ...token };
    // Always expose the complete permissions model. Tokens stored without
    // permissions (or with null) are full-access, so report an explicit
    // { mode: 'full' } instead of null for a consistent API contract.
    sanitized.permissions = token.permissions || { mode: 'full' };
    return sanitized;
  }

  /**
   * Validate and normalize a token permissions object
   * Accepts null (full access), or { mode: 'full'|'readonly'|'custom', resources?: {...} }
   * @param {Object|null} permissions - Permissions to validate
   * @returns {Object|null} Normalized permissions object or null for full access
   */
  _validatePermissions(permissions) {
    if (permissions === null || permissions === undefined) {
      return null;
    }

    if (typeof permissions !== 'object' || Array.isArray(permissions)) {
      throw new Error('permissions must be an object or null');
    }

    const validModes = ['full', 'readonly', 'custom'];
    if (!validModes.includes(permissions.mode)) {
      throw new Error(`permissions.mode must be one of: ${validModes.join(', ')}`);
    }

    // full and readonly do not carry per-resource data
    if (permissions.mode !== 'custom') {
      return { mode: permissions.mode };
    }

    const resources = permissions.resources;
    if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
      throw new Error('permissions.resources must be an object when mode is "custom"');
    }

    const validLevels = ['none', 'read', 'write'];
    const normalized = {};
    for (const [resource, level] of Object.entries(resources)) {
      if (!validLevels.includes(level)) {
        throw new Error(`Invalid permission level '${level}' for resource '${resource}'. Must be one of: ${validLevels.join(', ')}`);
      }
      normalized[resource] = level;
    }

    return { mode: 'custom', resources: normalized };
  }

  _sanitizeAdminTokens(tokens) {
    return tokens.map(this._sanitizeAdminToken);
  }

  async getUsers(filters = {}) {
    const users = await this.loadUsers();
    let filteredUsers = users;

    // Apply samba_user filter if specified
    if (filters.samba_user !== undefined) {
      filteredUsers = users.filter(user => {
        if (filters.samba_user === true || filters.samba_user === 'true') {
          return user.samba_user === true;
        } else if (filters.samba_user === false || filters.samba_user === 'false') {
          return user.samba_user !== true;
        }
        return true;
      });
    }

    return this._sanitizeUsers(filteredUsers);
  }

  async createUser(username, password, role = 'user', language = 'en', primary_color = '#607d8b', darkmode = false, samba_user = false, requestingUser = null) {
    const users = await this.loadUsers();

    // Validate username, password and password length
    if (!username || username.trim() === '') {
      throw new Error('Username is required');
    }

    if (!password || password.trim() === '') {
      throw new Error('Password is required');
    }

    if (password.length < 6) {
      throw new Error('Password must be at least 6 characters long');
    }

    if (users.some(u => u.username === username)) {
      throw new Error('Username already exists');
    }

    // Validate role
    const allowedRoles = ['admin', 'user', 'samba_only'];
    if (!allowedRoles.includes(role)) {
      throw new Error('Invalid role. Allowed roles: admin, user, samba_only');
    }

    // Validate username for SMB users
    if (samba_user || role === 'samba_only') {
      if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
        throw new Error('Username can only contain letters, numbers, underscores and hyphens');
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
      id: Date.now().toString(),
      username,
      password: hashedPassword,
      role,
      language,
      primary_color,
      darkmode,
      samba_user: samba_user || role === 'samba_only',
      byte_format: 'binary', // Default byte format setting
      show_menu: true, // Default menu visibility setting
      hide_inactive_menus: true, // Default hide inactive menus
      group_menus: false, // Default group menus
      createdAt: new Date().toISOString()
    };

    // Create Linux user for all users (required for system access)
    try {
      if (newUser.samba_user) {
        // Create SMB user (includes Linux user + SMB setup)
        await this._createSmbUser(username, password);
      } else {
        // Create only Linux user (no SMB)
        await this._createLinuxUserOnly(username, password);
      }
    } catch (error) {
      throw new Error(`Failed to create system user: ${error.message}`);
    }

    users.push(newUser);
    await this.saveUsers(users);

    // Check if any user was created with boot token - if so, delete the boot token
    if (requestingUser && requestingUser.isBootToken) {
      try {
        // Clear the token file directly without checking (we know it exists since we used it)
        const tokenFile = config.tokenFilePath;
        await fs.writeFile(tokenFile, '', { mode: 0o600 });
        console.log('Boot token deleted after user creation');
      } catch (error) {
        console.warn('Failed to delete boot token after user creation:', error.message);
      }
    }

    return this._sanitizeUser(newUser);
  }

  async authenticate(username, password) {
    const users = await this.loadUsers();
    const user = users.find(u => u.username === username);

    if (!user) {
      throw new Error('Invalid username or password');
    }

    // samba_only users cannot log in via API
    if (user.role === 'samba_only') {
      throw new Error('Invalid username or password');
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      throw new Error('Invalid username or password');
    }

    // If MFA is enabled, return mfa_token instead of real JWT
    if (user.mfa_enabled && user.mfa_secret) {
      const mfaToken = jwt.sign(
        {
          id: user.id,
          purpose: 'mfa_verify'
        },
        process.env.JWT_SECRET,
        { expiresIn: '2m' }
      );

      // Return same model as normal login, all values null
      const nullUser = this._sanitizeUser(user);
      for (const key of Object.keys(nullUser)) {
        nullUser[key] = null;
      }

      return {
        user: nullUser,
        token: null,
        mfa_required: true,
        mfa_token: mfaToken
      };
    }

    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: config.jwtExpiryString }
    );

    return {
      user: this._sanitizeUser(user),
      token,
      mfa_required: false,
      mfa_disabled: false,
      message: null
    };
  }

  async updateUser(id, updates, requestingUser = null) {
    const users = await this.loadUsers();
    const index = users.findIndex(u => u.id === id);

    if (index === -1) {
      throw new Error('User not found');
    }

    const currentUser = users[index];

    if (requestingUser) {
      // Check if user has admin privileges (admin role, boot token, or admin token)
      const isAdmin = requestingUser.role === 'admin' || requestingUser.isBootToken || requestingUser.isAdminToken;
      const isOwnProfile = requestingUser.id === id;

      // Non-admin users can only update their own profile
      if (!isAdmin && !isOwnProfile) {
        throw new Error('You can only update your own profile');
      }

      // Non-admin users have restricted field access
      if (!isAdmin) {
        // Check if user is trying to change their role to something other than 'user'
        if (updates.role && updates.role !== 'user') {
          throw new Error('You are not allowed to change your role to admin. Only administrators can modify user roles.');
        }

        const allowedFields = ['language', 'primary_color', 'darkmode', 'password', 'show_menu', 'hide_inactive_menus', 'group_menus'];
        const filteredUpdates = {};

        for (const [key, value] of Object.entries(updates)) {
          if (allowedFields.includes(key)) {
            filteredUpdates[key] = value;
          }
        }
        updates = filteredUpdates;
      }
    }

    // Prevent removing the last admin
    if (updates.role && updates.role !== 'admin') {
      const adminCount = users.filter(u => u.role === 'admin').length;
      if (adminCount === 1 && users[index].role === 'admin') {
        throw new Error('Cannot remove the last admin');
      }
    }

    // Store plain password for SMB operations before hashing
    let plainPassword = null;
    if (updates.password && updates.password.trim() !== '') {
      plainPassword = updates.password.trim();
      updates.password = await bcrypt.hash(plainPassword, 10);

      // Update SMB password if user is SMB user
      if (currentUser.samba_user) {
        try {
          await this._changeSmbPassword(currentUser.username, plainPassword);
        } catch (error) {
          throw new Error(`Failed to update SMB password: ${error.message}`);
        }
      }
    } else {
      delete updates.password;
    }

    // Handle samba_user flag changes (admin only)
    let smbUserHandled = false;
    if (updates.hasOwnProperty('samba_user') && requestingUser &&
        (requestingUser.role === 'admin' || requestingUser.isBootToken || requestingUser.isAdminToken)) {

      if (updates.samba_user && !currentUser.samba_user) {
        // Create SMB user - password is REQUIRED when converting existing user to SMB
        if (!updates.password || updates.password.trim() === '') {
          throw new Error('Password is required when converting a user to SMB user. SMB passwords cannot be derived from existing system passwords.');
        }

        try {
          // Use the stored plain password (before hashing)
          await this._createSmbUser(currentUser.username, plainPassword);
          smbUserHandled = true;
        } catch (error) {
          throw new Error(`Failed to create SMB user: ${error.message}`);
        }
      } else if (!updates.samba_user && currentUser.samba_user) {
        // Remove SMB user
        try {
          await this._deleteSmbUser(currentUser.username);
          await this._copySystemFiles();
          await this._restartSmbd();
        } catch (error) {
          // Non-critical error, log and continue
          console.warn(`Failed to delete SMB user: ${error.message}`);
        }
      }
    }

    // Handle role changes to/from samba_only
    if (updates.role) {
      if (updates.role === 'samba_only') {
        updates.samba_user = true;
        if (!currentUser.samba_user && !smbUserHandled) {
          // Create SMB user - password is REQUIRED when converting to samba_only role
          if (!updates.password || updates.password.trim() === '') {
            throw new Error('Password is required when converting a user to samba_only role. SMB passwords cannot be derived from existing system passwords.');
          }

          try {
            // Use the stored plain password (before hashing)
            await this._createSmbUser(currentUser.username, plainPassword);
          } catch (error) {
            throw new Error(`Failed to create SMB user: ${error.message}`);
          }
        }
      }
    }

    // Handle admin MFA disable
    if (updates.hasOwnProperty('mfa_enabled') && updates.mfa_enabled === false && requestingUser &&
        (requestingUser.role === 'admin' || requestingUser.isBootToken || requestingUser.isAdminToken)) {
      if (currentUser.mfa_enabled) {
        updates.mfa_enabled = false;
        updates.mfa_secret = undefined;
        updates.mfa_recovery_code = undefined;
      }
    } else {
      // Non-admin cannot change MFA via updateUser
      delete updates.mfa_enabled;
      delete updates.mfa_secret;
      delete updates.mfa_recovery_code;
    }

    users[index] = { ...users[index], ...updates };

    // Clean up undefined fields (from MFA disable)
    if (users[index].mfa_secret === undefined) delete users[index].mfa_secret;
    if (users[index].mfa_recovery_code === undefined) delete users[index].mfa_recovery_code;
    await this.saveUsers(users);

    return this._sanitizeUser(users[index]);
  }

  async deleteUser(id) {
    const users = await this.loadUsers();
    const index = users.findIndex(u => u.id === id);

    if (index === -1) {
      throw new Error('User not found');
    }

    const user = users[index];

    if (user.role === 'admin') {
      const adminCount = users.filter(u => u.role === 'admin').length;
      if (adminCount === 1) {
        throw new Error('Cannot delete the last admin');
      }
    }

    // Delete system user (Linux user for all users, SMB user only for samba users)
    try {
      if (user.samba_user) {
        // Delete SMB user first
        await this._deleteSmbUser(user.username);
      }

      // Delete Linux user (for all users)
      await this._deleteLinuxUser(user.username);

      // Copy updated system files after deletion
      await this._copySystemFiles();

      // Restart SMB daemon if user had samba access
      if (user.samba_user) {
        await this._restartSmbd();
      }

    } catch (error) {
      // Non-critical error, log and continue
      console.warn(`Failed to delete system user during user deletion: ${error.message}`);
    }

    users.splice(index, 1);
    await this.saveUsers(users);
  }

  /**
   * Change root password
   * @param {string} newPassword - New password
   * @returns {Promise<Object>} Change result
   */
  async changeRootPassword(newPassword) {
    try {
      // Validation
      if (!newPassword) {
        throw new Error('New password is required');
      }

      // Password strength validation
      if (newPassword.length < 4) {
        throw new Error('Password must be at least 4 characters long');
      }

      // Change root password with chpasswd (via stdin to avoid shell escaping issues)
      await this._execWithStdin('chpasswd', [], `root:${newPassword}\n`);

      // Copy system files (like in smb-user.service)
      const systemConfigPath = '/boot/config/system';
      try {
        await fs.mkdir(systemConfigPath, { recursive: true });
        await execAsync(`cp /etc/passwd ${systemConfigPath}/passwd`);
        await execAsync(`cp /etc/shadow ${systemConfigPath}/shadow`);
      } catch (copyError) {
        console.error(`Error copying system files: ${copyError.message}`);
      }

      return {
        success: true,
        message: 'Root password changed successfully',
        data: {
          user: 'root',
          passwordChanged: true,
          systemFilesCopied: true
        },
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error changing root password: ${error.message}`);
    }
  }

  // Environment/JWT Settings Management
  /**
   * Read current environment variables from file
   * @returns {Promise<Object>} Environment variables
   */
  async getEnvVars() {
    try {
      const envContent = await fs.readFile(ENV_FILE, 'utf8');
      const envVars = {};

      envContent.split('\n').forEach(line => {
        const [key, value] = line.split('=');
        if (key && value) {
          envVars[key.trim()] = value.trim();
        }
      });

      return envVars;
    } catch (error) {
      throw new Error(`Error reading environment file: ${error.message}`);
    }
  }

  /**
   * Get current JWT settings
   * @returns {Promise<Object>} JWT settings
   */
  async getJwtSettings() {
    try {
      const envVars = await this.getEnvVars();
      return {
        expiryDays: parseInt(envVars.JWT_EXPIRY_DAYS) || 1
      };
    } catch (error) {
      throw new Error(`Error getting JWT settings: ${error.message}`);
    }
  }

  /**
   * Update JWT expiry days in environment file
   * @param {number} days - Number of days for JWT expiry
   * @returns {Promise<Object>} Update result
   */
  async updateJwtExpiryDays(days) {
    try {
      // Validation
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        throw new Error('JWT expiry days must be an integer between 1 and 365');
      }

      const envVars = await this.getEnvVars();
      envVars.JWT_EXPIRY_DAYS = days.toString();

      // Convert back to file format
      const envContent = Object.entries(envVars)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');

      await fs.writeFile(ENV_FILE, envContent, { mode: 0o600 });

      // Update process.env immediately
      process.env.JWT_EXPIRY_DAYS = days.toString();

      return {
        success: true,
        message: `JWT expiry updated to ${days} day(s)`,
        data: {
          expiryDays: days,
          updated_at: new Date().toISOString()
        }
      };
    } catch (error) {
      throw new Error(`Error updating JWT expiry: ${error.message}`);
    }
  }

  // Admin Token Management
  /**
   * Create a new permanent admin token
   * @param {string} name - Descriptive name for the token
   * @param {string} description - Optional description
   * @param {Object|null} permissions - Optional permissions (null = full access / admin)
   * @returns {Promise<Object>} Created token with full token value
   */
  async createAdminToken(name, description = '', permissions = null) {
    const tokens = await this.loadAdminTokens();

    // Check if name already exists
    if (tokens.some(t => t.name === name)) {
      throw new Error('Token name already exists');
    }

    // Validate permissions (null = full access / admin)
    const normalizedPermissions = this._validatePermissions(permissions);

    // Generate secure random token
    const token = crypto.randomBytes(32).toString('hex');

    const newToken = {
      id: Date.now().toString(),
      name,
      description,
      token,
      permissions: normalizedPermissions,
      createdAt: new Date().toISOString(),
      lastUsed: null,
      isActive: true
    };

    tokens.push(newToken);
    await this.saveAdminTokens(tokens);

    return {
      success: true,
      message: 'Admin token created successfully',
      // Return full token only on creation; sanitize to expose the explicit
      // permissions model (e.g. { mode: 'full' }) while keeping the token value.
      data: this._sanitizeAdminToken(newToken)
    };
  }

  /**
   * Get all admin tokens (sanitized)
   * @returns {Promise<Array>} List of sanitized tokens
   */
  async getAdminTokens() {
    const tokens = await this.loadAdminTokens();
    return this._sanitizeAdminTokens(tokens);
  }

  /**
   * Validate admin token and update last used timestamp
   * @param {string} token - Token to validate
   * @returns {Promise<Object|null>} Token data if valid, null if invalid
   */
  async validateAdminToken(token) {
    const tokens = await this.loadAdminTokens();
    const tokenIndex = tokens.findIndex(t => t.token === token && t.isActive);

    if (tokenIndex === -1) {
      return null;
    }

    // Update last used timestamp
    tokens[tokenIndex].lastUsed = new Date().toISOString();
    await this.saveAdminTokens(tokens);

    return {
      id: tokens[tokenIndex].id,
      name: tokens[tokenIndex].name,
      role: 'admin',
      isAdminToken: true,
      permissions: tokens[tokenIndex].permissions || null
    };
  }

  /**
   * Update the permissions of an admin token
   * @param {string} id - Token ID
   * @param {Object|null} permissions - New permissions (null = full access)
   * @returns {Promise<Object>} Result with sanitized token
   */
  async updateAdminTokenPermissions(id, permissions) {
    const tokens = await this.loadAdminTokens();
    const tokenIndex = tokens.findIndex(t => t.id === id);

    if (tokenIndex === -1) {
      throw new Error('Admin token not found');
    }

    tokens[tokenIndex].permissions = this._validatePermissions(permissions);
    await this.saveAdminTokens(tokens);

    return {
      success: true,
      message: 'Admin token permissions updated successfully',
      data: this._sanitizeAdminToken(tokens[tokenIndex])
    };
  }

  /**
   * Deactivate admin token
   * @param {string} id - Token ID
   * @returns {Promise<Object>} Result
   */
  async deactivateAdminToken(id) {
    const tokens = await this.loadAdminTokens();
    const tokenIndex = tokens.findIndex(t => t.id === id);

    if (tokenIndex === -1) {
      throw new Error('Admin token not found');
    }

    tokens[tokenIndex].isActive = false;
    tokens[tokenIndex].deactivatedAt = new Date().toISOString();

    await this.saveAdminTokens(tokens);

    return {
      success: true,
      message: 'Admin token deactivated successfully'
    };
  }

  /**
   * Delete admin token permanently
   * @param {string} id - Token ID
   * @returns {Promise<Object>} Result
   */
  async deleteAdminToken(id) {
    const tokens = await this.loadAdminTokens();
    const tokenIndex = tokens.findIndex(t => t.id === id);

    if (tokenIndex === -1) {
      throw new Error('Admin token not found');
    }

    tokens.splice(tokenIndex, 1);
    await this.saveAdminTokens(tokens);

    return {
      success: true,
      message: 'Admin token deleted successfully'
    };
  }

  // SMB User Management Methods (moved from smb-user.service.js)

  /**
   * Execute a command with stdin input (avoids shell escaping issues)
   * @param {string} cmd - Command to execute
   * @param {Array<string>} args - Command arguments
   * @param {string} stdinData - Data to write to stdin
   * @returns {Promise<string>} stdout output
   */
  _execWithStdin(cmd, args, stdinData) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data; });
      proc.stderr.on('data', (data) => { stderr += data; });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`${cmd} exited with code ${code}: ${stderr.trim()}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to start ${cmd}: ${err.message}`));
      });

      proc.stdin.write(stdinData);
      proc.stdin.end();
    });
  }

  /**
   * Copy system files to boot config
   * @returns {Promise<boolean>} Success status
   */
  async _copySystemFiles() {
    try {
      // Stelle sicher, dass das Zielverzeichnis existiert
      await fs.mkdir(this.systemConfigPath, { recursive: true });

      // Kopiere /etc/passwd und /etc/shadow und /etc/samba/smbpasswd
      await execAsync(`cp /etc/passwd ${this.systemConfigPath}/passwd`);
      await execAsync(`cp /etc/shadow ${this.systemConfigPath}/shadow`);
      await execAsync(`cp /etc/samba/smbpasswd ${this.systemConfigPath}/smbpasswd`);

      return true;
    } catch (error) {
      console.error(`Error copying system files: ${error.message}`);
      return false;
    }
  }

  /**
   * Check if a Linux user exists
   * @param {string} username - Username to check
   * @returns {Promise<boolean>} True if user exists
   */
  async _userExists(username) {
    try {
      await execAsync(`id "${username}"`);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Check if an SMB user exists
   * @param {string} username - Username to check
   * @returns {Promise<boolean>} True if SMB user exists
   */
  async _smbUserExists(username) {
    try {
      const { stdout } = await execAsync('pdbedit -L');
      return stdout.includes(`${username}:`);
    } catch (error) {
      return false;
    }
  }

  /**
   * Create a Linux user
   * @param {string} username - Username
   * @param {number} gid - Group ID (default 500)
   * @returns {Promise<boolean>} Success status
   */
  async _createLinuxUser(username, gid = 500) {
    try {
      // Create user with group 500, without home directory and with /bin/false shell
      await execAsync(`useradd -g ${gid} -M -s /bin/false "${username}"`);

      return true;
    } catch (error) {
      console.error(`Error creating Linux user: ${error.message}`);
      throw new Error(`Failed to create Linux user: ${error.message}`);
    }
  }

  /**
   * Create a Linux user only (no SMB setup) and copy system files
   * @param {string} username - Username
   * @param {string} password - Password (for potential future use)
   * @param {number} gid - Group ID (default 500)
   * @returns {Promise<boolean>} Success status
   */
  async _createLinuxUserOnly(username, password, gid = 500) {
    try {
      // Check if user already exists
      const userExists = await this._userExists(username);
      if (userExists) {
        throw new Error(`Linux user '${username}' already exists`);
      }

      // Create Linux user
      await this._createLinuxUser(username, gid);

      // Copy system files to boot config
      await this._copySystemFiles();

      return true;
    } catch (error) {
      // Cleanup on error
      try {
        const userExists = await this._userExists(username);
        if (userExists) {
          await this._deleteLinuxUser(username);
        }
      } catch (cleanupError) {
        console.error(`Cleanup error: ${cleanupError.message}`);
      }

      throw error;
    }
  }

  /**
   * Delete a Linux user
   * @param {string} username - Username
   * @returns {Promise<boolean>} Success status
   */
  async _deleteLinuxUser(username) {
    try {
      // Delete user (without home directory since none exists)
      await execAsync(`userdel "${username}"`);
      return true;
    } catch (error) {
      console.error(`Error deleting Linux user: ${error.message}`);
      throw new Error(`Failed to delete Linux user: ${error.message}`);
    }
  }

  /**
   * Set SMB password for user
   * @param {string} username - Username
   * @param {string} password - Password
   * @returns {Promise<boolean>} Success status
   */
  async _setSmbPassword(username, password) {
    try {
      // Set SMB password (non-interactive, via stdin to avoid shell escaping issues)
      await this._execWithStdin('smbpasswd', ['-a', '-s', username], `${password}\n${password}\n`);

      return true;
    } catch (error) {
      console.error(`Error setting SMB password: ${error.message}`);
      throw new Error(`Failed to set SMB password: ${error.message}`);
    }
  }

  /**
   * Change SMB password for user
   * @param {string} username - Username
   * @param {string} password - New password
   * @returns {Promise<boolean>} Success status
   */
  async _changeSmbPassword(username, password) {
    try {
      // Change SMB password (non-interactive, via stdin to avoid shell escaping issues)
      await this._execWithStdin('smbpasswd', ['-s', username], `${password}\n${password}\n`);

      // Copy system files after password change
      await this._copySystemFiles();

      return true;
    } catch (error) {
      console.error(`Error changing SMB password: ${error.message}`);
      throw new Error(`Failed to change SMB password: ${error.message}`);
    }
  }

  /**
   * Delete SMB user
   * @param {string} username - Username
   * @returns {Promise<boolean>} Success status
   */
  async _deleteSmbUser(username) {
    try {
      // Delete SMB user
      await execAsync(`smbpasswd -x "${username}"`);

      return true;
    } catch (error) {
      console.error(`Error deleting SMB user: ${error.message}`);
      // Do not treat as critical error
      return false;
    }
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
      return false;
    }
  }

  /**
   * Create SMB user (combines Linux user creation and SMB setup)
   * @param {string} username - Username
   * @param {string} password - Password
   * @param {number} gid - Group ID (default 500)
   * @returns {Promise<boolean>} Success status
   */
  async _createSmbUser(username, password, gid = 500) {
    let createdLinuxUser = false;

    try {
      // Check if SMB user already exists
      const smbUserExists = await this._smbUserExists(username);
      if (smbUserExists) {
        throw new Error(`SMB user '${username}' already exists`);
      }

      // Check if Linux user exists
      const linuxUserExists = await this._userExists(username);

      // Create Linux user only if it doesn't exist
      if (!linuxUserExists) {
        await this._createLinuxUser(username, gid);
        createdLinuxUser = true;
      }

      // Set SMB password (this will add the user to SMB)
      await this._setSmbPassword(username, password);

      // Restart SMB daemon
      await this._restartSmbd();

      // Copy system files
      await this._copySystemFiles();

      return true;
    } catch (error) {
      // Cleanup on error - only clean up what we created
      try {
        const smbExists = await this._smbUserExists(username);
        if (smbExists) {
          await this._deleteSmbUser(username);
        }

        // Only delete Linux user if we created it in this function
        if (createdLinuxUser) {
          const linuxUserExists = await this._userExists(username);
          if (linuxUserExists) {
            await this._deleteLinuxUser(username);
          }
        }
      } catch (cleanupError) {
        console.error(`Cleanup error: ${cleanupError.message}`);
      }

      throw error;
    }
  }

  /**
   * Delete boot token from file and invalidate in memory
   * @returns {Promise<boolean>} Success status
   */
  async _deleteBootToken() {
    try {
      const tokenFile = config.tokenFilePath;

      // Check if token file already empty to avoid unnecessary writes
      try {
        const currentToken = await fs.readFile(tokenFile, 'utf8');
        if (!currentToken.trim()) {
          // Token already cleared, no need to write
          return true;
        }
      } catch (error) {
        // File doesn't exist, nothing to delete
        return true;
      }

      // Clear the token file (write empty string)
      await fs.writeFile(tokenFile, '', { mode: 0o600 });

      console.log('Boot token file cleared');
      return true;
    } catch (error) {
      throw new Error(`Failed to delete boot token: ${error.message}`);
    }
  }

  // MFA (TOTP) Methods

  /**
   * Generate MFA secret and QR code for setup
   * @param {string} userId - User ID
   * @param {string} password - Password confirmation
   * @returns {Promise<Object>} Secret, otpauth URL and QR code
   */
  async setupMfa(userId, password) {
    const users = await this.loadUsers();
    const user = users.find(u => u.id === userId);

    if (!user) {
      throw new Error('User not found');
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      throw new Error('Invalid password');
    }

    if (user.mfa_enabled) {
      throw new Error('MFA is already enabled');
    }

    const secret = generateSecret();
    const otpauthUrl = generateURI({ issuer: 'MOS', label: user.username, secret, type: 'totp' });
    const qrCode = await QRCode.toDataURL(otpauthUrl);

    // Store pending secret in memory only (5 minutes TTL)
    this.mfaPendingSetups.set(userId, {
      secret,
      expires: Date.now() + 5 * 60 * 1000
    });

    return {
      secret,
      otpauth_url: otpauthUrl,
      qr_code: qrCode
    };
  }

  /**
   * Confirm MFA setup with TOTP code and activate MFA
   * @param {string} userId - User ID
   * @param {string} code - TOTP code from authenticator app
   * @returns {Promise<Object>} MFA status and recovery code
   */
  async confirmMfa(userId, code) {
    const users = await this.loadUsers();
    const user = users.find(u => u.id === userId);

    if (!user) {
      throw new Error('User not found');
    }

    if (user.mfa_enabled) {
      throw new Error('MFA is already enabled');
    }

    const pending = this.mfaPendingSetups.get(userId);
    if (!pending) {
      throw new Error('No MFA setup in progress. Call setup first.');
    }

    // Check if pending secret has expired
    if (Date.now() > pending.expires) {
      this.mfaPendingSetups.delete(userId);
      throw new Error('MFA setup expired. Please start setup again.');
    }

    let confirmValid = false;
    try {
      const verifyResult = verifySync({ token: code, secret: pending.secret });
      confirmValid = verifyResult && verifyResult.valid === true;
    } catch (e) {
      confirmValid = false;
    }
    if (!confirmValid) {
      throw new Error('Invalid MFA code');
    }

    // Generate recovery code
    const recoveryCode = crypto.randomBytes(16).toString('hex').toUpperCase().match(/.{4}/g).join('-');
    const hashedRecovery = await bcrypt.hash(recoveryCode, 10);

    // Activate MFA
    const index = users.findIndex(u => u.id === userId);
    users[index].mfa_enabled = true;
    users[index].mfa_secret = pending.secret;
    users[index].mfa_recovery_code = hashedRecovery;
    this.mfaPendingSetups.delete(userId);
    await this.saveUsers(users);

    return {
      mfa_enabled: true,
      recovery_code: recoveryCode
    };
  }

  /**
   * Verify MFA code during login (TOTP or recovery code)
   * @param {string} mfaToken - Short-lived MFA JWT token
   * @param {string} code - TOTP code or recovery code
   * @returns {Promise<Object>} JWT token and user data
   */
  async verifyMfa(mfaToken, code) {
    // Check if token is blacklisted
    if (this.mfaBlacklistedTokens.has(mfaToken)) {
      throw new Error('Authentication failed. Please login again.');
    }

    // Verify mfa_token JWT
    let decoded;
    try {
      decoded = jwt.verify(mfaToken, process.env.JWT_SECRET);
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        this.mfaBlacklistedTokens.delete(mfaToken);
        throw new Error('MFA token expired. Please login again.');
      }
      throw new Error('Invalid MFA token');
    }

    if (decoded.purpose !== 'mfa_verify') {
      throw new Error('Invalid MFA token');
    }

    const users = await this.loadUsers();
    const user = users.find(u => u.id === decoded.id);

    if (!user || !user.mfa_enabled || !user.mfa_secret) {
      throw new Error('Invalid MFA token');
    }

    // Classify input: TOTP (6 digits), recovery code (hex with dashes, 39 chars), or invalid
    const isTotpFormat = /^\d{6}$/.test(code);
    const isRecoveryFormat = /^[A-F0-9]{4}(-[A-F0-9]{4}){7}$/i.test(code);

    if (isTotpFormat) {
      // Try TOTP verification
      let totpValid = false;
      try {
        const verifyResult = verifySync({ token: code, secret: user.mfa_secret });
        totpValid = verifyResult && verifyResult.valid === true;
      } catch (e) {
        totpValid = false;
      }
      if (!totpValid) {
        throw new Error('Invalid MFA code');
      }
    } else if (isRecoveryFormat) {
      // Try recovery code
      if (!user.mfa_recovery_code) {
        this.mfaBlacklistedTokens.add(mfaToken);
        setTimeout(() => this.mfaBlacklistedTokens.delete(mfaToken), 2 * 60 * 1000);
        throw new Error('Authentication failed. Please login again.');
      }

      const isValidRecovery = await bcrypt.compare(code, user.mfa_recovery_code);
      if (!isValidRecovery) {
        this.mfaBlacklistedTokens.add(mfaToken);
        setTimeout(() => this.mfaBlacklistedTokens.delete(mfaToken), 2 * 60 * 1000);
        throw new Error('Authentication failed. Please login again.');
      }

      // Recovery code used - disable MFA
      const index = users.findIndex(u => u.id === decoded.id);
      users[index].mfa_enabled = false;
      delete users[index].mfa_secret;
      delete users[index].mfa_recovery_code;
      await this.saveUsers(users);

      const updatedUser = users[index];
      const token = jwt.sign(
        {
          id: updatedUser.id,
          username: updatedUser.username,
          role: updatedUser.role
        },
        process.env.JWT_SECRET,
        { expiresIn: config.jwtExpiryString }
      );

      return {
        user: this._sanitizeUser(updatedUser),
        token,
        mfa_disabled: true,
        message: 'MFA has been disabled because a recovery code was used. Please reconfigure MFA in your settings.'
      };
    } else {
      // Neither valid TOTP nor recovery format - generic error, no blacklist
      throw new Error('Invalid MFA code');
    }

    // Valid TOTP code - issue real JWT
    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: config.jwtExpiryString }
    );

    return {
      user: this._sanitizeUser(user),
      token,
      mfa_disabled: false,
      message: null
    };
  }

  /**
   * Disable MFA for a user
   * @param {string} userId - User ID
   * @param {string} password - Password confirmation (null for admin override)
   * @param {boolean} adminOverride - If true, skip password check (admin action)
   * @returns {Promise<Object>} Result
   */
  async disableMfa(userId, password = null, adminOverride = false) {
    const users = await this.loadUsers();
    const user = users.find(u => u.id === userId);

    if (!user) {
      throw new Error('User not found');
    }

    if (!user.mfa_enabled) {
      throw new Error('MFA is not enabled');
    }

    if (!adminOverride) {
      if (!password) {
        throw new Error('Password is required');
      }
      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) {
        throw new Error('Invalid password');
      }
    }

    const index = users.findIndex(u => u.id === userId);
    users[index].mfa_enabled = false;
    delete users[index].mfa_secret;
    delete users[index].mfa_recovery_code;
    await this.saveUsers(users);
    this.mfaPendingSetups.delete(userId);

    return {
      success: true,
      message: 'MFA disabled successfully'
    };
  }

  /**
   * Get list of SMB users
   * @returns {Promise<Array>} SMB users list
   */
  async getSmbUsers() {
    try {
      const { stdout } = await execAsync('pdbedit -L');

      const users = stdout.trim().split('\n')
        .filter(line => line.trim())
        .map(line => {
          const parts = line.split(':');
          return {
            username: parts[0],
            uid: parts[1] || null,
            fullName: parts[2] || null
          };
        });

      return users;
    } catch (error) {
      throw new Error(`Error getting SMB users: ${error.message}`);
    }
  }
}

module.exports = new UserService(); 
