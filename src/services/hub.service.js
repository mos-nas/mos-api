const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const axios = require('axios');

class HubService {
  constructor() {
    this.hubConfigPath = '/boot/config/system/hub.json';
    this.indexPath = '/var/mos/hub/repositories.json';
    this.installedPluginsPath = '/boot/optional/plugins';
    this.installedDockerTemplatesPath = '/boot/config/system/docker/templates';
    this.allowedTypes = ['docker', 'compose', 'lxc', 'plugin', 'vm'];
    this.allowedCategories = ['AI', 'Backup', 'Hosting', 'Crypto', 'Downloader', 'Driver', 'Game Server', 'Home Automation', 'Media', 'Network', 'Productivity', 'Monitoring', 'Security', 'System', 'Utilities', 'Misc'];

    // In-memory caches of installed identifiers to avoid hitting the USB /boot
    // path on every index read. Invalidated explicitly on install/uninstall
    // and otherwise refreshed after a short TTL.
    this._installedPluginReposCache = null;
    this._installedDockerImagesCache = null;
    this._installedCacheTtlMs = 30000;

    // Known repositories: cached to disk when the hub is enabled, refetched
    // hourly on failure and refreshed on every manual hub update.
    this.knownReposUrl = 'https://mos-official.net/known-repos.json';
    this.knownReposPath = '/var/mos/hub/known_repositories.json';
    this._knownReposFetchTimeoutMs = 10000;
    this._knownReposRetryMs = 60 * 60 * 1000;
    this._knownReposRetryTimer = null;
    this._knownReposFetching = false;
  }

  /**
   * Returns the system architecture in template format (amd64/arm64)
   * @returns {string} System architecture
   */
  _getSystemArch() {
    const arch = os.arch();
    const archMap = { x64: 'amd64', arm64: 'arm64' };
    return archMap[arch] || arch;
  }

  /**
   * Filters templates by system architecture
   * Templates without architectures field or with matching arch are kept
   * @param {Array} templates - Array of template objects
   * @returns {Array} Filtered templates
   */
  _filterByArch(templates) {
    const sysArch = this._getSystemArch();
    return templates.filter(t => {
      if (!Array.isArray(t.architecture) || t.architecture.length === 0) return true;
      return t.architecture.includes(sysArch) || t.architecture.includes('all');
    });
  }

  /**
   * Default configuration structure
   */
  _getDefaultConfig() {
    return {
      enabled: false,
      initial_update: false,
      schedule: '',
      page_entries: 24,
      update_check: {
        enabled: false,
        update_check_schedule: '10 1 * * *',
        auto_update: {
          enabled: false,
          auto_update_schedule: '10 2 * * SAT'
        }
      },
      repositories: []
    };
  }

  /**
   * Ensures the hub.json file exists with default structure
   * @returns {Promise<void>}
   */
  async _ensureConfigExists() {
    try {
      await fs.access(this.hubConfigPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Create directory if it doesn't exist
        const dir = path.dirname(this.hubConfigPath);
        await fs.mkdir(dir, { recursive: true });

        // Create default config
        await fs.writeFile(this.hubConfigPath, JSON.stringify(this._getDefaultConfig(), null, 2), 'utf8');
      } else {
        throw error;
      }
    }
  }

  /**
   * Reads the hub configuration
   * @returns {Promise<Object>} The hub configuration
   */
  async _readConfig() {
    await this._ensureConfigExists();
    const data = await fs.readFile(this.hubConfigPath, 'utf8');
    const config = JSON.parse(data);

    // Merge with defaults to ensure all fields exist
    const defaults = this._getDefaultConfig();
    const merged = { ...defaults, ...config };

    // Deep merge update_check to preserve nested defaults
    merged.update_check = {
      ...defaults.update_check,
      ...(config.update_check || {}),
      auto_update: {
        ...defaults.update_check.auto_update,
        ...((config.update_check && config.update_check.auto_update) || {})
      }
    };

    return merged;
  }

  /**
   * Writes the hub configuration
   * @param {Object} config - The configuration to write
   * @returns {Promise<void>}
   */
  async _writeConfig(config) {
    await this._ensureConfigExists();
    await fs.writeFile(this.hubConfigPath, JSON.stringify(config, null, 2), 'utf8');
  }

  /**
   * Validates a git repository URL
   * @param {string} url - URL to validate
   * @returns {boolean} True if valid
   */
  _isValidGitUrl(url) {
    if (!url || typeof url !== 'string') {
      return false;
    }
    const trimmedUrl = url.trim();
    return trimmedUrl.startsWith('http://') ||
           trimmedUrl.startsWith('https://') ||
           trimmedUrl.startsWith('git');
  }

  /**
   * Gets the hub settings (without repositories)
   * @returns {Promise<Object>} Hub settings
   */
  async getSettings() {
    try {
      const config = await this._readConfig();
      const { repositories, ...settings } = config;
      return settings;
    } catch (error) {
      throw new Error(`Error reading hub settings: ${error.message}`);
    }
  }

  /**
   * Updates the hub settings
   * @param {Object} settings - Settings to update
   * @returns {Promise<Object>} Updated settings
   */
  async setSettings(settings) {
    try {
      const current = await this._readConfig();
      let hubCronChanged = false;
      let hubEnabledTurnedOn = false;

      // Update only provided fields
      if (typeof settings.enabled === 'boolean' && current.enabled !== settings.enabled) {
        hubEnabledTurnedOn = settings.enabled === true;
        current.enabled = settings.enabled;
        hubCronChanged = true;
      }
      if (typeof settings.initial_update === 'boolean') {
        current.initial_update = settings.initial_update;
      }
      if (settings.schedule !== undefined && (typeof settings.schedule === 'string' || settings.schedule === null)) {
        const newSchedule = settings.schedule || '';
        if (current.schedule !== newSchedule) {
          hubCronChanged = true;
        }
        current.schedule = newSchedule;
      }
      if (typeof settings.page_entries === 'number' && settings.page_entries > 0) {
        current.page_entries = settings.page_entries;
      }

      let updateCronChanged = false;
      if (settings.update_check && typeof settings.update_check === 'object') {
        if (!current.update_check) {
          current.update_check = this._getDefaultConfig().update_check;
        }
        if (typeof settings.update_check.enabled === 'boolean' && current.update_check.enabled !== settings.update_check.enabled) {
          current.update_check.enabled = settings.update_check.enabled;
          updateCronChanged = true;
        }
        if (typeof settings.update_check.update_check_schedule === 'string') {
          if (current.update_check.update_check_schedule !== settings.update_check.update_check_schedule) {
            updateCronChanged = true;
          }
          current.update_check.update_check_schedule = settings.update_check.update_check_schedule;
        }
        if (settings.update_check.auto_update && typeof settings.update_check.auto_update === 'object') {
          if (!current.update_check.auto_update) {
            current.update_check.auto_update = this._getDefaultConfig().update_check.auto_update;
          }
          if (typeof settings.update_check.auto_update.enabled === 'boolean' && current.update_check.auto_update.enabled !== settings.update_check.auto_update.enabled) {
            current.update_check.auto_update.enabled = settings.update_check.auto_update.enabled;
            updateCronChanged = true;
          }
          if (typeof settings.update_check.auto_update.auto_update_schedule === 'string') {
            if (current.update_check.auto_update.auto_update_schedule !== settings.update_check.auto_update.auto_update_schedule) {
              updateCronChanged = true;
            }
            current.update_check.auto_update.auto_update_schedule = settings.update_check.auto_update.auto_update_schedule;
          }
        }
      }

      await this._writeConfig(current);

      if (hubCronChanged) {
        try {
          await execPromise('/usr/local/bin/mos-cron_update');
        } catch (cronError) {
          console.warn(`Hub: Failed to update cron: ${cronError.message}`);
        }
      }

      if (updateCronChanged) {
        try {
          await execPromise('/usr/local/bin/mos-cron_update');
        } catch (cronError) {
          console.warn(`Hub: Failed to update plugin cron: ${cronError.message}`);
        }
      }

      // Refresh known repositories in the background when the hub is enabled
      if (hubEnabledTurnedOn) {
        this.initKnownRepositories().catch(() => {});
      }

      const { repositories, ...result } = current;
      return result;
    } catch (error) {
      throw new Error(`Error saving hub settings: ${error.message}`);
    }
  }

  /**
   * Gets the hub enabled status for /mos/services
   * @returns {Promise<boolean>} Hub enabled status
   */
  async getHubEnabledStatus() {
    try {
      const config = await this._readConfig();
      return config.enabled === true;
    } catch {
      return false;
    }
  }

  /**
   * Gets all repository URLs
   * @returns {Promise<Array<string>>} List of repository URLs
   */
  async getRepositories() {
    try {
      const config = await this._readConfig();
      return Array.isArray(config.repositories) ? config.repositories : [];
    } catch (error) {
      throw new Error(`Error reading repositories: ${error.message}`);
    }
  }

  /**
   * Sets the repository URLs (replaces all)
   * @param {Array<string>} urls - Array of repository URLs
   * @returns {Promise<Array<string>>} The saved URLs
   */
  async setRepositories(urls) {
    try {
      if (!Array.isArray(urls)) {
        throw new Error('URLs must be an array');
      }

      // Validate and filter URLs
      const validUrls = [];
      for (const url of urls) {
        if (typeof url === 'string') {
          const trimmed = url.trim();
          if (this._isValidGitUrl(trimmed) && !validUrls.includes(trimmed)) {
            validUrls.push(trimmed);
          }
        }
      }

      const config = await this._readConfig();
      config.repositories = validUrls;
      await this._writeConfig(config);
      return validUrls;
    } catch (error) {
      throw new Error(`Error saving repositories: ${error.message}`);
    }
  }

  /**
   * Fetches the known repositories and caches them to disk.
   * Returns false on failure so the caller can schedule a retry.
   * @returns {Promise<boolean>}
   */
  async _fetchAndCacheKnownRepositories() {
    let body;
    try {
      const response = await axios.get(this.knownReposUrl, {
        timeout: this._knownReposFetchTimeoutMs,
        // Fetch as raw text and parse ourselves so we can reject non-JSON
        // (e.g. an HTML error page served with status 200)
        responseType: 'text',
        transformResponse: [(d) => d],
        maxContentLength: 1024 * 1024,
        maxBodyLength: 1024 * 1024,
        // axios rejects status >= 400 by default; keep it explicit
        validateStatus: (status) => status >= 200 && status < 300
      });
      body = response.data;
    } catch (error) {
      console.warn(`Hub: Could not fetch known repositories: ${error.message}`);
      return false;
    }

    let data;
    try {
      data = JSON.parse(body);
    } catch {
      console.warn('Hub: Known repositories response is not valid JSON');
      return false;
    }

    if (!Array.isArray(data)) {
      console.warn('Hub: Known repositories response is not an array');
      return false;
    }

    const repos = [];
    for (const url of data) {
      if (typeof url !== 'string') continue;
      const trimmed = url.trim();
      if (this._isValidGitUrl(trimmed) && !repos.includes(trimmed)) {
        repos.push(trimmed);
      }
    }

    try {
      await fs.mkdir(path.dirname(this.knownReposPath), { recursive: true });
      await fs.writeFile(this.knownReposPath, JSON.stringify(repos, null, 2), 'utf8');
    } catch (error) {
      console.warn(`Hub: Could not write known repositories cache: ${error.message}`);
      return false;
    }

    // Cancel any pending retry now that we have a valid list
    this._clearKnownReposRetry();
    return true;
  }

  /**
   * Clears a pending known repositories retry timer.
   */
  _clearKnownReposRetry() {
    if (this._knownReposRetryTimer) {
      clearTimeout(this._knownReposRetryTimer);
      this._knownReposRetryTimer = null;
    }
  }

  /**
   * Schedules an hourly retry until a fetch succeeds. Timer is unref'd.
   */
  _scheduleKnownReposRetry() {
    if (this._knownReposRetryTimer) return;

    this._knownReposRetryTimer = setTimeout(async () => {
      this._knownReposRetryTimer = null;
      await this.initKnownRepositories();
    }, this._knownReposRetryMs);

    if (this._knownReposRetryTimer.unref) {
      this._knownReposRetryTimer.unref();
    }
  }

  /**
   * Fetches and caches known repositories when the hub is enabled.
   * On failure, schedules an hourly retry. Safe to call at startup or on enable.
   * @returns {Promise<void>}
   */
  async initKnownRepositories() {
    if (this._knownReposFetching) return;

    let enabled = false;
    try {
      const config = await this._readConfig();
      enabled = config.enabled === true;
    } catch {
      enabled = false;
    }
    if (!enabled) {
      this._clearKnownReposRetry();
      return;
    }

    this._knownReposFetching = true;
    let ok = false;
    try {
      ok = await this._fetchAndCacheKnownRepositories();
    } finally {
      this._knownReposFetching = false;
    }
    if (!ok) this._scheduleKnownReposRetry();
  }

  /**
   * Returns the cached known repository URLs (empty array if none).
   * When the cache is missing/invalid, triggers a background refresh
   * (respects hub-enabled, same timeout/validation/retry).
   * @returns {Promise<Array<string>>}
   */
  async getKnownRepositories() {
    try {
      const data = await fs.readFile(this.knownReposPath, 'utf8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Cache missing or invalid -> fall through to background refresh
    }

    this.initKnownRepositories().catch(() => {});
    return [];
  }

  /**
   * Merges repo URL lists, validated and de-duplicated by normalized URL
   */
  _mergeRepoUrls(...lists) {
    const seen = new Set();
    const merged = [];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const url of list) {
        if (typeof url !== 'string') continue;
        const trimmed = url.trim();
        if (!this._isValidGitUrl(trimmed)) continue;
        const norm = this._normalizeRepoUrl(trimmed);
        if (seen.has(norm)) continue;
        seen.add(norm);
        merged.push(trimmed);
      }
    }
    return merged;
  }

  /**
   * Extracts owner and repo name from URL for folder path
   * @param {string} url - Git repository URL
   * @returns {string} Folder path like 'owner/reponame'
   */
  _getRepoFolderPath(url) {
    try {
      // Remove .git suffix and trailing slashes
      let cleaned = url.replace(/\.git$/, '').replace(/\/+$/, '');

      // Extract last two path segments (owner/repo)
      const parts = cleaned.split(/[\/:]/).filter(p => p && p !== 'https' && p !== 'http' && !p.includes('.'));

      if (parts.length >= 2) {
        const owner = parts[parts.length - 2];
        const repo = parts[parts.length - 1];
        return `${owner}/${repo}`;
      } else if (parts.length === 1) {
        return parts[0];
      }

      return `unknown/repo_${Date.now()}`;
    } catch {
      return `unknown/repo_${Date.now()}`;
    }
  }

  /**
   * Checks if a directory exists and is not empty
   * @param {string} dirPath - Directory path
   * @returns {Promise<boolean>} True if exists and has content
   */
  async _dirHasContent(dirPath) {
    try {
      const entries = await fs.readdir(dirPath);
      return entries.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Clones a git repository into a directory
   * @param {string} url - Repository URL
   * @param {string} targetDir - Directory to clone into
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async _cloneRepo(url, targetDir) {
    try {
      const folderPath = this._getRepoFolderPath(url);
      const fullPath = path.join(targetDir, folderPath);

      // Create owner directory if needed
      await fs.mkdir(path.dirname(fullPath), { recursive: true });

      // Try to get GitHub token for private repos
      let cloneUrl = url;
      if (url.includes('github.com') || url.includes('github.')) {
        try {
          const mosService = require('./mos.service');
          const tokens = await mosService.getTokens();
          if (tokens.github) {
            cloneUrl = url.replace(/^https:\/\//, `https://${tokens.github}@`);
          }
        } catch {
          // No token available, use original URL
        }
      }

      // Clone with full history, no interactive prompts
      const cmd = `GIT_TERMINAL_PROMPT=0 git clone "${cloneUrl}" "${fullPath}" 2>&1`;
      await execPromise(cmd, { timeout: 120000 });

      return { success: true, folder: folderPath };
    } catch (error) {
      const errorMsg = error.stderr || error.stdout || error.message;

      // Check for auth/password issues
      if (errorMsg.includes('Authentication') ||
          errorMsg.includes('Password') ||
          errorMsg.includes('credential') ||
          errorMsg.includes('403') ||
          errorMsg.includes('401')) {
        console.warn(`Hub: Skipping ${url} - requires authentication`);
        return { success: false, error: 'requires authentication' };
      }

      // Check for invalid repo
      if (errorMsg.includes('not found') ||
          errorMsg.includes('does not exist') ||
          errorMsg.includes('Could not read') ||
          errorMsg.includes('fatal:')) {
        console.warn(`Hub: Skipping ${url} - not a valid git repository`);
        return { success: false, error: 'not a valid git repository' };
      }

      console.warn(`Hub: Failed to clone ${url}: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Updates all repositories from hub.json
   * @returns {Promise<Object>} Update result with success/failed repos
   */
  async updateRepositories() {
    const reposPath = '/var/mos/hub/repositories';
    const tempPath = '/var/mos/hub/temp';

    // Refresh known repos and merge with configured or keep if failed
    await this.initKnownRepositories();
    const urls = this._mergeRepoUrls(
      await this.getRepositories(),
      await this._readJsonFile(this.knownReposPath)
    );

    if (!urls || urls.length === 0) {
      throw new Error('No repositories configured');
    }

    const results = {
      success: [],
      failed: [],
      total: urls.length
    };

    // Check if repos directory has content
    const hasExistingRepos = await this._dirHasContent(reposPath);

    if (hasExistingRepos) {
      // Clone to temp directory first
      await fs.rm(tempPath, { recursive: true, force: true });
      await fs.mkdir(tempPath, { recursive: true });

      for (const url of urls) {
        const result = await this._cloneRepo(url, tempPath);

        if (result.success) {
          results.success.push(url);
        } else {
          results.failed.push({ url, error: result.error });
        }
      }

      // If at least one succeeded, swap directories
      if (results.success.length > 0) {
        // Remove old repos
        await fs.rm(reposPath, { recursive: true, force: true });

        // Move temp to repos
        await fs.rename(tempPath, reposPath);
      } else {
        // All failed, cleanup temp
        await fs.rm(tempPath, { recursive: true, force: true });
        throw new Error('All repository downloads failed');
      }
    } else {
      // No existing repos, clone directly
      await fs.mkdir(reposPath, { recursive: true });

      for (const url of urls) {
        const result = await this._cloneRepo(url, reposPath);

        if (result.success) {
          results.success.push(url);
        } else {
          results.failed.push({ url, error: result.error });
        }
      }

      if (results.success.length === 0) {
        throw new Error('All repository downloads failed');
      }
    }

    // Build and save index after successful update
    await this._saveIndex();

    return results;
  }

  /**
   * Builds and saves the template index to disk
   * @returns {Promise<void>}
   */
  async _saveIndex() {
    const indexData = await this.buildIndex({});
    await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
    await fs.writeFile(this.indexPath, JSON.stringify(indexData, null, 2), 'utf8');
  }

  /**
   * Gets the cached template index with optional filtering
   * @param {Object} options - Filter, sort and pagination options
   * @returns {Promise<Object>} Object with results array and count
   */
  async getIndex(options = {}) {
    const { search, category, type, sort, order = 'asc', limit, skip, arch_filter = true } = options;

    // Try to read cached index
    let indexData;
    try {
      const data = await fs.readFile(this.indexPath, 'utf8');
      indexData = JSON.parse(data);
    } catch {
      // No cached index, build fresh
      indexData = await this.buildIndex({});
    }

    let filtered = indexData.results || [];

    // Filter by system architecture (enabled by default)
    if (arch_filter) {
      filtered = this._filterByArch(filtered);
    }

    const searchLower = search ? search.toLowerCase() : null;
    const categoryLower = category ? category.toLowerCase() : null;
    const typeLower = type ? type.toLowerCase() : null;

    // Filter by type
    if (typeLower) {
      filtered = filtered.filter(t => t.type === typeLower);
    }

    // Filter by search term
    if (searchLower) {
      filtered = filtered.filter(t => {
        const name = (t.name || '').toLowerCase();
        const maintainer = (t.maintainer || '').toLowerCase();
        const description = (t.description || '').toLowerCase();
        return name.includes(searchLower) || maintainer.includes(searchLower) || description.includes(searchLower);
      });
    }

    // Filter by category
    if (categoryLower) {
      filtered = filtered.filter(t => {
        if (!Array.isArray(t.category)) return false;
        return t.category.some(c => c.toLowerCase().includes(categoryLower));
      });
    }

    // Sort results
    if (sort) {
      filtered.sort((a, b) => {
        let valA, valB;
        switch (sort) {
          case 'name':
            valA = (a.name || '').toLowerCase();
            valB = (b.name || '').toLowerCase();
            return order === 'desc' ? valB.localeCompare(valA) : valA.localeCompare(valB);
          case 'created':
            valA = a.created_at || 0;
            valB = b.created_at || 0;
            return order === 'desc' ? valB - valA : valA - valB;
          case 'updated':
            valA = a.updated_at || 0;
            valB = b.updated_at || 0;
            return order === 'desc' ? valB - valA : valA - valB;
          default:
            return 0;
        }
      });
    }

    const totalCount = filtered.length;

    if (skip && skip > 0) filtered = filtered.slice(skip);
    if (limit && limit > 0) filtered = filtered.slice(0, limit);

    // Annotate only the returned page with installed status (cheap)
    await this._annotateInstalled(filtered);

    const config = await this._readConfig();
    return {
      results: filtered,
      page_entries: config.page_entries || 24,
      count: totalCount
    };
  }

  /**
   * Gets available types from the index (filtered by allowed types)
   * @returns {Promise<Array<string>>} List of available types
   */
  async getTypes() {
    let indexData;
    try {
      const data = await fs.readFile(this.indexPath, 'utf8');
      indexData = JSON.parse(data);
    } catch {
      indexData = await this.buildIndex({});
    }

    const templates = indexData.results || [];
    const foundTypes = new Set(templates.map(t => t.type));
    return this.allowedTypes.filter(t => foundTypes.has(t));
  }

  /**
   * Gets available categories from the index (filtered by allowed categories)
   * @param {boolean} all - If true, return all allowed categories, otherwise only those in use
   * @returns {Promise<Array<string>>} List of available categories
   */
  async getCategories(all = false) {
    if (all) {
      return [...this.allowedCategories];
    }

    let indexData;
    try {
      const data = await fs.readFile(this.indexPath, 'utf8');
      indexData = JSON.parse(data);
    } catch {
      indexData = await this.buildIndex({});
    }

    const templates = indexData.results || [];
    const foundCategories = new Set();
    for (const t of templates) {
      if (Array.isArray(t.category)) {
        t.category.forEach(c => foundCategories.add(c));
      }
    }
    return this.allowedCategories.filter(c => foundCategories.has(c));
  }

  /**
   * Reads a JSON file safely
   * @param {string} filePath - Path to JSON file
   * @returns {Promise<Object|null>} Parsed JSON or null
   */
  async _readJsonFile(filePath) {
    try {
      const data = await fs.readFile(filePath, 'utf8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Checks if a path exists
   * @param {string} p - Path to check
   * @returns {Promise<boolean>}
   */
  async _exists(p) {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Normalizes a repository URL for reliable comparison
   * (lowercase, strip trailing .git and slashes)
   * @param {string} url - Repository URL
   * @returns {string} Normalized URL
   */
  _normalizeRepoUrl(url) {
    if (!url || typeof url !== 'string') return '';
    return url.trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');
  }

  /**
   * Builds a Set of normalized repository URLs of currently installed plugins.
   * Reads /boot/optional/plugins/<name>/template.json. Result is cached in
   * memory (TTL) to avoid repeated reads from the USB /boot path.
   * @returns {Promise<Set<string>>} Set of normalized repository URLs
   */
  async _getInstalledPluginRepos() {
    const now = Date.now();
    if (this._installedPluginReposCache &&
        (now - this._installedPluginReposCache.timestamp) < this._installedCacheTtlMs) {
      return this._installedPluginReposCache.repos;
    }

    const repos = new Set();
    try {
      const entries = await fs.readdir(this.installedPluginsPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const template = await this._readJsonFile(
          path.join(this.installedPluginsPath, entry.name, 'template.json')
        );
        if (template && template.repository) {
          repos.add(this._normalizeRepoUrl(template.repository));
        }
      }
    } catch {
      // No installed plugins / directory missing -> empty set
    }

    this._installedPluginReposCache = { timestamp: now, repos };
    return repos;
  }

  /**
   * Normalizes a docker image reference for reliable comparison.
   * Strips an optional digest, lowercases, and defaults the tag to ":latest"
   * when none is given (so "nginx" matches "nginx:latest").
   * @param {string} ref - Image reference (e.g. "owner/img:tag", "img", "host:5000/img")
   * @returns {string} Normalized image reference
   */
  _normalizeImageRef(ref) {
    if (!ref || typeof ref !== 'string') return '';
    let s = ref.trim().toLowerCase();

    // Strip digest (e.g. "@sha256:...")
    const atIdx = s.indexOf('@');
    if (atIdx !== -1) s = s.slice(0, atIdx);

    // A ':' only denotes a tag if it appears after the last '/'.
    // Otherwise it's a registry port (e.g. "host:5000/img") -> no tag present.
    const lastSlash = s.lastIndexOf('/');
    const lastColon = s.lastIndexOf(':');
    if (lastColon <= lastSlash) {
      s = `${s}:latest`;
    }
    return s;
  }

  /**
   * Builds a Set of normalized image references of currently installed docker
   * containers. Reads /boot/config/system/docker/templates/<name>.json and uses
   * the `repo` field (which is the container image). Cached in memory (TTL).
   * @returns {Promise<Set<string>>} Set of normalized image references
   */
  async _getInstalledDockerImages() {
    const now = Date.now();
    if (this._installedDockerImagesCache &&
        (now - this._installedDockerImagesCache.timestamp) < this._installedCacheTtlMs) {
      return this._installedDockerImagesCache.images;
    }

    const images = new Set();
    try {
      const files = await fs.readdir(this.installedDockerTemplatesPath);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const template = await this._readJsonFile(
          path.join(this.installedDockerTemplatesPath, file)
        );
        if (template && template.repo) {
          images.add(this._normalizeImageRef(template.repo));
        }
      }
    } catch {
      // No installed containers / directory missing -> empty set
    }

    this._installedDockerImagesCache = { timestamp: now, images };
    return images;
  }

  /**
   * Invalidates the cached installed identifier sets (plugins + docker).
   * Should be called after an install/uninstall so the hub index reflects
   * the change immediately instead of waiting for the TTL.
   */
  invalidateInstalledCache() {
    this._installedPluginReposCache = null;
    this._installedDockerImagesCache = null;
  }

  /**
   * Annotates templates with an `installed` flag.
   * - plugins: matched by repository URL
   * - docker: matched by image reference (image:tag, defaulting to :latest)
   * @param {Array} templates - Array of template objects (mutated in place)
   * @returns {Promise<Array>} The annotated templates
   */
  async _annotateInstalled(templates) {
    if (!Array.isArray(templates) || templates.length === 0) return templates;

    const hasPlugin = templates.some(t => t.type === 'plugin');
    const hasDocker = templates.some(t => t.type === 'docker');
    const pluginRepos = hasPlugin ? await this._getInstalledPluginRepos() : null;
    const dockerImages = hasDocker ? await this._getInstalledDockerImages() : null;

    for (const t of templates) {
      if (t.type === 'plugin') {
        t.installed = pluginRepos.has(this._normalizeRepoUrl(t.repository));
      } else if (t.type === 'docker') {
        t.installed = dockerImages.has(this._normalizeImageRef(t.repository));
      } else {
        t.installed = false;
      }
    }
    return templates;
  }

  /**
   * Extracts container names and images from compose.yaml using yq
   * @param {string} composePath - Path to compose.yaml
   * @returns {Promise<Object>} Object with container_name: image pairs
   */
  async _parseComposeImages(composePath) {
    try {
      // Get all services with their container_name (or service name) and image
      const cmd = `yq '.services | to_entries | map({
        "name": ((.value.container_name // .key)),
        "image": .value.image
      })' "${composePath}" 2>/dev/null`;

      const { stdout } = await execPromise(cmd);
      const services = JSON.parse(stdout);

      const images = {};
      for (const svc of services) {
        if (svc.image) {
          images[svc.name] = svc.image;
        }
      }
      return images;
    } catch (error) {
      console.warn(`Hub: Failed to parse compose file ${composePath}: ${error.message}`);
      return {};
    }
  }

  /**
   * Gets git timestamps for a file (created and last modified)
   * @param {string} filePath - Path to file
   * @param {string} repoPath - Path to git repository root
   * @returns {Promise<{created_at: number|null, updated_at: number|null}>}
   */
  async _getGitTimestamps(filePath, repoPath) {
    try {
      // Get first commit timestamp (created)
      const createdCmd = `git log --format=%ct --diff-filter=A --follow -- "${filePath}" | tail -1`;
      const { stdout: createdOut } = await execPromise(createdCmd, { cwd: repoPath });
      const created_at = createdOut.trim() ? parseInt(createdOut.trim(), 10) : null;

      // Get last commit timestamp (updated)
      const updatedCmd = `git log -1 --format=%ct -- "${filePath}"`;
      const { stdout: updatedOut } = await execPromise(updatedCmd, { cwd: repoPath });
      const updated_at = updatedOut.trim() ? parseInt(updatedOut.trim(), 10) : null;

      return { created_at, updated_at };
    } catch {
      return { created_at: null, updated_at: null };
    }
  }

  /**
   * Processes a single docker template JSON
   * @param {string} jsonPath - Path to docker JSON
   * @param {Object} maintainerInfo - Maintainer info
   * @param {string} repoPath - Path to git repository root
   * @returns {Promise<Object|null>} Template object or null
   */
  async _processDockerTemplate(jsonPath, maintainerInfo, repoPath) {
    const template = await this._readJsonFile(jsonPath);
    if (!template) return null;

    // Validate category is an array
    const category = Array.isArray(template.category) ? template.category : null;

    // Get git timestamps
    const { created_at, updated_at } = await this._getGitTimestamps(jsonPath, repoPath);

    // Extract architecture (array or null)
    let architecture = null;
    if (Array.isArray(template.architecture) && template.architecture.length > 0) {
      architecture = template.architecture;
    } else if (typeof template.architecture === 'string') {
      architecture = [template.architecture];
    }

    return {
      name: template.name || '',
      maintainer: maintainerInfo.maintainer || '',
      maintainer_donate: maintainerInfo.donation || '',
      donate: template.donate || '',
      support: template.support || '',
      type: 'docker',
      category,
      description: template.description || '',
      readme_url: template.readme_url || '',
      website: template.project || '',
      icon: template.icon || '',
      repository: template.repo || '',
      architecture,
      created_at,
      updated_at,
      stack_images: [],
      files: {
        template: jsonPath,
        yaml: null,
        env: null
      }
    };
  }

  /**
   * Processes a single plugin template JSON
   * @param {string} jsonPath - Path to plugin JSON
   * @param {Object} maintainerInfo - Maintainer info
   * @param {string} repoPath - Path to git repository root
   * @returns {Promise<Object|null>} Template object or null
   */
  async _processPluginTemplate(jsonPath, maintainerInfo, repoPath) {
    const template = await this._readJsonFile(jsonPath);
    if (!template) return null;

    // Validate category is an array (plugins may not have category, default to empty)
    const category = Array.isArray(template.category) ? template.category : [];

    // Get git timestamps
    const { created_at, updated_at } = await this._getGitTimestamps(jsonPath, repoPath);

    // Extract architecture (array or null)
    let architecture = null;
    if (Array.isArray(template.architecture) && template.architecture.length > 0) {
      architecture = template.architecture;
    } else if (typeof template.architecture === 'string') {
      architecture = [template.architecture];
    }

    return {
      name: template.name || '',
      maintainer: maintainerInfo.maintainer || template.author || '',
      maintainer_donate: maintainerInfo.donation || '',
      donate: template.donate || '',
      support: template.support || '',
      type: 'plugin',
      category,
      description: template.description || '',
      readme_url: template.readme_url || '',
      website: template.homepage || '',
      icon: template.icon || '',
      repository: template.repository || '',
      driver: template.driver || false,
      architecture,
      created_at,
      updated_at,
      stack_images: [],
      files: {
        template: jsonPath,
        yaml: null,
        env: null
      }
    };
  }

  /**
   * Processes a single compose template
   * @param {string} templateDir - Path to compose template directory
   * @param {Object} maintainerInfo - Maintainer info
   * @param {string} repoPath - Path to git repository root
   * @returns {Promise<Object|null>} Template object or null
   */
  async _processComposeTemplate(templateDir, maintainerInfo, repoPath) {
    const templatePath = path.join(templateDir, 'template.json');
    const envPath = path.join(templateDir, '.env');

    const template = await this._readJsonFile(templatePath);
    if (!template) return null;

    // Support both compose.yaml and compose.yml
    let composePath = path.join(templateDir, 'compose.yaml');
    let hasCompose = await this._exists(composePath);
    if (!hasCompose) {
      composePath = path.join(templateDir, 'compose.yml');
      hasCompose = await this._exists(composePath);
    }

    // Parse compose file for images
    let stackImages = {};
    if (hasCompose) {
      stackImages = await this._parseComposeImages(composePath);
    }

    // Check if .env exists
    const hasEnv = await this._exists(envPath);

    // Validate category is an array
    const category = Array.isArray(template.category) ? template.category : null;

    // Get git timestamps
    const { created_at, updated_at } = await this._getGitTimestamps(templatePath, repoPath);

    // Extract architecture (array or null)
    let architecture = null;
    if (Array.isArray(template.architecture) && template.architecture.length > 0) {
      architecture = template.architecture;
    } else if (typeof template.architecture === 'string') {
      architecture = [template.architecture];
    }

    return {
      name: template.name || '',
      maintainer: maintainerInfo.maintainer || '',
      maintainer_donate: maintainerInfo.donation || '',
      donate: template.donate || '',
      support: template.support || '',
      type: 'compose',
      category,
      description: template.description || '',
      readme_url: template.readme_url || '',
      website: template.website || '',
      icon: template.icon || '',
      repository: template.repository || '',
      architecture,
      created_at,
      updated_at,
      stack_images: Object.keys(stackImages).length > 0 ? [stackImages] : [],
      files: {
        template: templatePath,
        yaml: hasCompose ? composePath : null,
        env: hasEnv ? envPath : null
      }
    };
  }

  /**
   * Builds index of all templates from all repositories
   * @param {Object} options - Filter, sort and pagination options
   * @param {string} options.search - Search in name, maintainer, description
   * @param {string} options.category - Filter by category
   * @param {string} options.type - Filter by type (docker/compose)
   * @param {string} options.sort - Sort by field (name, created, updated)
   * @param {string} options.order - Sort order (asc/desc)
   * @param {number} options.limit - Max number of results to return
   * @param {number} options.skip - Number of results to skip
   * @returns {Promise<Object>} Object with results array and count
   */
  async buildIndex(options = {}) {
    const { search, category, type, sort, order = 'asc', limit, skip, arch_filter = true } = options;
    const reposPath = '/var/mos/hub/repositories';
    const templates = [];
    const searchLower = search ? search.toLowerCase() : null;
    const categoryLower = category ? category.toLowerCase() : null;
    const typeLower = type ? type.toLowerCase() : null;

    // Check if repositories exist
    if (!await this._exists(reposPath)) {
      throw new Error('No repositories downloaded. Run update first.');
    }

    // Get all owner directories
    const owners = await fs.readdir(reposPath);

    for (const owner of owners) {
      const ownerPath = path.join(reposPath, owner);
      const ownerStat = await fs.stat(ownerPath);
      if (!ownerStat.isDirectory()) continue;

      // Get all repo directories under this owner
      const repos = await fs.readdir(ownerPath);

      for (const repo of repos) {
        const repoPath = path.join(ownerPath, repo);
        const repoStat = await fs.stat(repoPath);
        if (!repoStat.isDirectory()) continue;

        // Read maintainer.json
        const maintainerPath = path.join(repoPath, 'maintainer.json');
        const maintainerInfo = await this._readJsonFile(maintainerPath) || {};

        // Process docker templates
        const dockerPath = path.join(repoPath, 'docker');
        if (await this._exists(dockerPath)) {
          const dockerFiles = await fs.readdir(dockerPath);
          for (const file of dockerFiles) {
            if (file.endsWith('.json')) {
              const template = await this._processDockerTemplate(
                path.join(dockerPath, file),
                maintainerInfo,
                repoPath
              );
              if (template) templates.push(template);
            }
          }
        }

        // Process compose templates
        const composePath = path.join(repoPath, 'compose');
        if (await this._exists(composePath)) {
          const composeDirs = await fs.readdir(composePath);
          for (const dir of composeDirs) {
            const templateDir = path.join(composePath, dir);
            const dirStat = await fs.stat(templateDir);
            if (!dirStat.isDirectory()) continue;

            const template = await this._processComposeTemplate(
              templateDir,
              maintainerInfo,
              repoPath
            );
            if (template) templates.push(template);
          }
        }

        // Process plugin templates
        const pluginsPath = path.join(repoPath, 'plugins');
        if (await this._exists(pluginsPath)) {
          const pluginFiles = await fs.readdir(pluginsPath);
          for (const file of pluginFiles) {
            if (file.endsWith('.json')) {
              const template = await this._processPluginTemplate(
                path.join(pluginsPath, file),
                maintainerInfo,
                repoPath
              );
              if (template) templates.push(template);
            }
          }
        }
      }
    }

    // Filter results
    let filtered = templates;

    // Filter by system architecture (enabled by default)
    if (arch_filter) {
      filtered = this._filterByArch(filtered);
    }

    // Filter by type (docker/compose/plugin)
    if (typeLower) {
      filtered = filtered.filter(t => t.type === typeLower);
    }

    // Filter by search term (name, maintainer, description)
    if (searchLower) {
      filtered = filtered.filter(t => {
        const name = (t.name || '').toLowerCase();
        const maintainer = (t.maintainer || '').toLowerCase();
        const description = (t.description || '').toLowerCase();

        return name.includes(searchLower) ||
               maintainer.includes(searchLower) ||
               description.includes(searchLower);
      });
    }

    // Filter by category
    if (categoryLower) {
      filtered = filtered.filter(t => {
        if (!Array.isArray(t.category)) return false;
        return t.category.some(c => c.toLowerCase().includes(categoryLower));
      });
    }

    // Sort results
    if (sort) {
      filtered.sort((a, b) => {
        let valA, valB;

        switch (sort) {
          case 'name':
            valA = (a.name || '').toLowerCase();
            valB = (b.name || '').toLowerCase();
            if (order === 'desc') {
              return valB.localeCompare(valA);
            }
            return valA.localeCompare(valB);

          case 'created':
            valA = a.created_at || 0;
            valB = b.created_at || 0;
            break;

          case 'updated':
            valA = a.updated_at || 0;
            valB = b.updated_at || 0;
            break;

          default:
            return 0;
        }

        // For timestamp sorting (created/updated)
        if (sort === 'created' || sort === 'updated') {
          if (order === 'desc') {
            return valB - valA; // newest first
          }
          return valA - valB; // oldest first
        }

        return 0;
      });
    }

    // Store total count before pagination
    const totalCount = filtered.length;

    // Apply pagination
    if (skip && skip > 0) {
      filtered = filtered.slice(skip);
    }
    if (limit && limit > 0) {
      filtered = filtered.slice(0, limit);
    }

    // Get page_entries from config
    const config = await this._readConfig();
    const pageEntries = config.page_entries || 24;

    return {
      results: filtered,
      page_entries: pageEntries,
      count: totalCount
    };
  }

  /**
   * Gets a docker template by its file path
   * @param {string} templatePath - Absolute path to template JSON
   * @returns {Promise<Object>} The template content
   */
  async getDockerTemplate(templatePath) {
    if (!templatePath) {
      throw new Error('Template path is required');
    }

    // Security: ensure path is within repositories
    const reposPath = '/var/mos/hub/repositories';
    if (!templatePath.startsWith(reposPath)) {
      throw new Error('Invalid template path');
    }

    if (!await this._exists(templatePath)) {
      throw new Error('Template not found');
    }

    const template = await this._readJsonFile(templatePath);
    if (!template) {
      throw new Error('Failed to read template');
    }

    // Normalize container name: replace spaces with underscores
    if (template.name && template.name.includes(' ')) {
      template.name = template.name.replace(/ /g, '_');
    }

    // Remap appdata paths to the configured docker appdata directory
    await this._remapAppdataPaths(template);

    return template;
  }

  /**
   * Remaps template path hosts to the configured docker appdata directory.
   * @param {Object} template - The docker template (mutated in place)
   */
  async _remapAppdataPaths(template) {
    if (!template || !Array.isArray(template.paths) || template.paths.length === 0) {
      return;
    }

    let appdata;
    try {
      // Lazy require to avoid circular dependency
      const mosService = require('./mos.service');
      const dockerSettings = await mosService.getDockerSettings();
      appdata = dockerSettings && dockerSettings.appdata;
    } catch (error) {
      console.warn(`Could not load docker appdata setting for path remap: ${error.message}`);
      return;
    }

    if (!appdata || typeof appdata !== 'string') {
      return;
    }

    // Derive the pool root from the configured appdata path
    let base;
    if (appdata.includes('/mnt/')) {
      base = appdata.split('/').slice(0, 3).join('/');
    } else if (appdata.includes('/var/mergerfs/')) {
      base = appdata.split('/').slice(0, 5).join('/');
    } else {
      base = appdata;
    }

    for (const p of template.paths) {
      if (!p || typeof p !== 'object') continue;

      const original = typeof p.host === 'string' ? p.host : null;
      let host = original || '';

      // Build host from container when empty
      if (host === '' && typeof p.container === 'string' && p.container !== '') {
        host = appdata + p.container;
      }

      // Replace the leading pool root
      if (host && (host.startsWith('/mnt/user') || host.startsWith('/mnt/cache'))) {
        host = host.replace(/^\/mnt\/(user|cache)/, () => base);
      }

      if (host !== '' && host !== original) {
        p.host = host;
      }
    }
  }

  /**
   * Gets compose files by their paths
   * @param {string} templatePath - Absolute path to template.json
   * @param {string} yamlPath - Absolute path to compose.yaml
   * @param {string} envPath - Optional absolute path to .env
   * @returns {Promise<Object>} Object with name, yaml, env, icon, web_ui_url
   */
  async getComposeFiles(templatePath, yamlPath, envPath = null) {
    if (!templatePath) {
      throw new Error('Template path is required');
    }
    if (!yamlPath) {
      throw new Error('YAML path is required');
    }

    // Security: ensure paths are within repositories
    const reposPath = '/var/mos/hub/repositories';
    if (!templatePath.startsWith(reposPath)) {
      throw new Error('Invalid template path');
    }
    if (!yamlPath.startsWith(reposPath)) {
      throw new Error('Invalid yaml path');
    }
    if (envPath && !envPath.startsWith(reposPath)) {
      throw new Error('Invalid env path');
    }

    if (!await this._exists(templatePath)) {
      throw new Error('Template not found');
    }
    if (!await this._exists(yamlPath)) {
      throw new Error('YAML file not found');
    }

    // Read template.json for name and icon
    const template = await this._readJsonFile(templatePath);

    const webuiValue = template?.web_ui_url || null;
    const result = {
      name: template?.name || null,
      yaml: null,
      env: null,
      icon: template?.icon || null,
      web_ui_url: webuiValue,
      webui: webuiValue
    };

    // Read yaml content
    try {
      result.yaml = await fs.readFile(yamlPath, 'utf8');
    } catch (error) {
      throw new Error('Failed to read YAML file');
    }

    // Read env content if provided
    if (envPath && await this._exists(envPath)) {
      try {
        result.env = await fs.readFile(envPath, 'utf8');
      } catch {
        result.env = null;
      }
    }

    return result;
  }

  /**
   * Gets a plugin template by its file path
   * @param {string} templatePath - Absolute path to plugin JSON
   * @returns {Promise<Object>} The template content
   */
  async getPluginTemplate(templatePath) {
    if (!templatePath) {
      throw new Error('Template path is required');
    }

    // Security: ensure path is within repositories
    const reposPath = '/var/mos/hub/repositories';
    if (!templatePath.startsWith(reposPath)) {
      throw new Error('Invalid template path');
    }

    if (!await this._exists(templatePath)) {
      throw new Error('Template not found');
    }

    const template = await this._readJsonFile(templatePath);
    if (!template) {
      throw new Error('Failed to read template');
    }

    return template;
  }
}

module.exports = new HubService();
