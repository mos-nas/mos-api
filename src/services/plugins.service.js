const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const net = require('net');
const crypto = require('crypto');

const MOS_NOTIFY_SOCKET = '/var/run/mos-notify.sock';
const PLUGINS_CACHE_DIR = '/var/mos/mos-plugins';
const PLUGINS_CONFIG_DIR = '/boot/optional/plugins';
const MAX_SOURCE_SIZE = 10 * 1024 * 1024; // 10MB

const PLUGINS_DIR = '/var/www/mos-plugins';

// Forbidden commands that cannot be executed via query API
// These are blocked both by name and as symlink targets
const FORBIDDEN_COMMANDS = [
  'mkdir', 'rmdir', 'rm', 'mv', 'cp', 'touch', 'truncate', 'ln',
  'chmod', 'chown', 'chgrp', 'chattr', 'tar', 'unzip', 'gunzip',
  'gzip', 'bzip2', 'xz', 'zip', 'cpio', 'sh', 'bash', 'zsh',
  'dash', 'fish', 'csh', 'tcsh', 'ksh', 'python', 'python2',
  'python3', 'perl', 'ruby', 'node', 'lua', 'php', 'awk', 'gawk',
  'nawk', 'mawk', 'sed', 'dd', 'shred', 'mkfs', 'fdisk',
  'parted', 'mount', 'umount', 'kill', 'killall', 'pkill',
  'reboot', 'shutdown', 'poweroff', 'halt', 'init', 'insmod',
  'rmmod', 'modprobe', 'depmod', 'nc', 'netcat', 'ncat',
  'socat', 'curl', 'wget', 'su', 'sudo', 'chroot', 'nohup',
  'setsid', 'apt', 'apt-get', 'dpkg', 'aptitude', 'snap', 'tee',
  'install', 'rsync', 'scp', 'sftp', 'ssh', 'eval', 'exec',
  'xargs', 'at', 'atq', 'atrm', 'crontab'
];

/**
 * Get list of all installed plugins
 * @returns {Promise<{results: Array, count: number}>}
 */
async function getPlugins() {
  const plugins = [];

  // Check if plugins directory exists
  try {
    await fs.access(PLUGINS_DIR);
  } catch {
    return { results: [], count: 0 };
  }

  // Load versions.json for update_available check
  let versionsMap = {};
  let versionsExists = false;
  try {
    const versionsPath = path.join(PLUGINS_CACHE_DIR, 'versions.json');
    const versionsContent = await fs.readFile(versionsPath, 'utf8');
    const versions = JSON.parse(versionsContent);
    versionsExists = true;
    // Create map for quick lookup
    for (const v of versions) {
      versionsMap[v.plugin] = v.update_available;
    }
  } catch {
    // versions.json doesn't exist
  }

  // Read all subdirectories
  const entries = await fs.readdir(PLUGINS_DIR, { withFileTypes: true });
  const pluginDirs = entries.filter(entry => entry.isDirectory());

  // Read manifest.json from each plugin directory
  for (const dir of pluginDirs) {
    const manifestPath = path.join(PLUGINS_DIR, dir.name, 'manifest.json');
    try {
      const manifestContent = await fs.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestContent);

      // Ensure widget field defaults to false
      if (manifest.widget === undefined) {
        manifest.widget = false;
      }

      // Add update_available status
      let updateAvailable = false;
      if (versionsExists) {
        const pluginName = manifest.name || dir.name;
        if (pluginName in versionsMap) {
          updateAvailable = versionsMap[pluginName];
        } else {
          updateAvailable = false; // Not in versions = no update info
        }
      }
      manifest.update_available = updateAvailable;

      plugins.push(manifest);
    } catch (err) {
      // Skip plugins without valid manifest.json
      console.warn(`Skipping plugin ${dir.name}: ${err.message}`);
    }
  }

  return { results: plugins, count: plugins.length };
}

/**
 * Execute a query command from /usr/bin/plugins
 * @param {string} command - Command name (must be in /usr/bin/plugins)
 * @param {string[]} args - Command arguments
 * @param {Object} options - Execution options
 * @param {number} options.timeout - Timeout in seconds (default 10, max 60)
 * @param {boolean} options.parse_json - Parse output as JSON
 * @returns {Promise<Object>} Execution result
 */
async function executeQuery(command, args = [], options = {}) {
  const PLUGINS_BIN_DIR = '/usr/bin/plugins';
  const { timeout = 10, parse_json = false } = options;

  // Validate command
  if (!command || typeof command !== 'string') {
    throw new Error('Command is required');
  }

  // Only allow command names, no paths
  const commandName = path.basename(command);
  if (commandName !== command || command.includes('/')) {
    throw new Error('Only command names allowed, not paths');
  }

  // Check if command name itself is forbidden
  if (FORBIDDEN_COMMANDS.includes(commandName)) {
    throw new Error(`Command '${commandName}' is not allowed`);
  }

  // Build full path to command
  const commandPath = path.join(PLUGINS_BIN_DIR, commandName);

  // Verify command exists (works with symlinks)
  try {
    await fs.access(commandPath, fs.constants.X_OK);
  } catch {
    throw new Error(`Command not found or not executable: ${commandName}`);
  }

  // Security: If it's a symlink, validate the target
  // Regular files (plugin scripts) are allowed
  try {
    const stats = await fs.lstat(commandPath);
    if (stats.isSymbolicLink()) {
      // Resolve the symlink to get the real target
      const realPath = await fs.realpath(commandPath);
      const targetName = path.basename(realPath);

      // Check if the symlink target is a forbidden command
      if (FORBIDDEN_COMMANDS.includes(targetName)) {
        throw new Error(`Command '${commandName}' links to forbidden command '${targetName}'`);
      }
    }
    // Regular files are allowed (plugin scripts, custom binaries)
  } catch (e) {
    // Re-throw our own errors
    if (e.message.includes('forbidden') || e.message.includes('not allowed')) {
      throw e;
    }
    // For other fs errors, provide generic message
    throw new Error(`Command '${commandName}' validation failed`);
  }

  // Validate and sanitize arguments
  const sanitizedArgs = [];
  for (const arg of args) {
    if (typeof arg !== 'string') continue;
    // Block shell metacharacters in arguments
    if (/[;&|`$(){}\[\]<>\n\r]/.test(arg)) {
      throw new Error('Invalid characters in arguments');
    }
    sanitizedArgs.push(arg);
  }

  // Build command string with proper escaping
  const escapedArgs = sanitizedArgs.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
  const fullCommand = `${commandPath} ${escapedArgs}`.trim();

  // Timeout in ms (min 0.1s, max 60s)
  const timeoutMs = Math.min(Math.max(timeout, 0.1), 60) * 1000;

  const startTime = Date.now();

  return new Promise((resolve) => {
    const execOptions = {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      shell: '/bin/bash'
    };

    exec(fullCommand, execOptions, (error, stdout, stderr) => {
      const duration_ms = Date.now() - startTime;
      let output = stdout || '';
      let exit_code = 0;
      let success = true;
      let timed_out = false;

      if (error) {
        exit_code = error.code || 1;
        success = false;
        if (error.killed) {
          // Timeout: return whatever output we got, not the error
          timed_out = true;
          // Keep stdout if we have it, otherwise show timeout message
          if (!output) {
            output = stderr || 'Command timed out';
          }
        } else {
          output = stderr || error.message;
        }
      }

      // Parse as JSON if requested
      if (parse_json && output) {
        output = _tryParseJson(output);
      }

      resolve({
        success,
        output,
        exit_code,
        duration_ms,
        timed_out
      });
    });
  });
}

/**
 * Extract architecture from .deb filename
 * @private
 */
function _extractArchFromDeb(filename) {
  // Pattern: name_version_arch.deb
  const match = filename.match(/_([a-z0-9]+)\.deb$/i);
  if (match) {
    const arch = match[1].toLowerCase();
    // Common architectures (no i386 - deprecated)
    if (['amd64', 'arm64', 'armhf', 'all', 'x86_64', 'aarch64'].includes(arch)) {
      return arch;
    }
  }
  return null;
}

/**
 * Get system architecture
 * @private
 */
function _getSystemArch() {
  const arch = process.arch;
  // Map Node.js arch to Debian arch
  const archMap = {
    'x64': 'amd64',
    'arm64': 'arm64',
    'arm': 'armhf'
  };
  return archMap[arch] || arch;
}

/**
 * Filter .deb assets by system architecture
 * @private
 */
function _filterDebByArch(assets) {
  const systemArch = _getSystemArch();
  const debAssets = assets.filter(a => a.name.endsWith('.deb') && !a.name.endsWith('.md5'));

  // First try to find exact arch match
  let filtered = debAssets.filter(a => {
    const arch = _extractArchFromDeb(a.name);
    return arch === systemArch;
  });

  // If no exact match, try 'all' architecture
  if (filtered.length === 0) {
    filtered = debAssets.filter(a => {
      const arch = _extractArchFromDeb(a.name);
      return arch === 'all';
    });
  }

  return filtered;
}

/**
 * Try to parse JSON, auto-fix if malformed (missing brackets)
 * @private
 */
function _tryParseJson(str) {
  if (typeof str !== 'string') return str;
  const trimmed = str.trim();
  if (!trimmed) return str;

  // Try direct parse first
  try {
    return JSON.parse(trimmed);
  } catch {
    // Try to fix common issues
  }

  // Detect if it looks like JSON
  const startsWithArray = trimmed.startsWith('[');
  const startsWithObject = trimmed.startsWith('{');

  if (!startsWithArray && !startsWithObject) {
    return str; // Not JSON-like, return as-is
  }

  // Try adding missing closing brackets
  const fixes = startsWithArray
    ? [']', '"}]', '"}]', '}]', '"]}']
    : ['}', '"}', '"}}', '}}'];

  for (const fix of fixes) {
    try {
      return JSON.parse(trimmed + fix);
    } catch {
      // Try next fix
    }
  }

  // Return original string if nothing works
  return str;
}

/**
 * Send notification via mos-notify socket
 * @private
 */
async function _sendNotification(title, message, priority = 'normal') {
  return new Promise((resolve) => {
    const client = net.createConnection(MOS_NOTIFY_SOCKET, () => {
      const payload = JSON.stringify({ title, message, priority });
      client.write(payload);
      client.end();
      resolve(true);
    });
    client.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Parse a repository URL into provider metadata.
 * GitHub is detected by host; every other host is treated as a Gitea instance
 * (this also covers Codeberg, which is a hosted Gitea).
 * @param {string} repository - Repository URL (https://host/owner/repo[.git])
 * @returns {{provider: string, host: string, owner: string, repo: string, apiBase: string}}
 * @private
 */
function _parseRepoUrl(repository) {
  if (!repository || typeof repository !== 'string') {
    throw new Error('Repository URL is required');
  }

  let host, owner, repo;
  try {
    const cleaned = repository.trim().replace(/\.git$/, '').replace(/\/+$/, '');
    const url = new URL(cleaned);
    host = url.hostname.toLowerCase();
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length < 2) {
      throw new Error('missing owner/repo');
    }
    owner = segments[segments.length - 2];
    repo = segments[segments.length - 1];
  } catch {
    throw new Error('Invalid repository URL');
  }

  // github.com -> GitHub API; anything else (incl. codeberg.org and
  // self-hosted Gitea) -> Gitea API at <host>/api/v1
  const provider = host === 'github.com' ? 'github' : 'gitea';
  const apiBase = provider === 'github'
    ? 'https://api.github.com'
    : `https://${host}/api/v1`;

  return { provider, host, owner, repo, apiBase };
}

/**
 * Get the API token for a provider if available.
 * @param {string} provider - 'github' or 'gitea'
 * @returns {Promise<string|null>}
 * @private
 */
async function _getProviderToken(provider) {
  try {
    const mosService = require('./mos.service');
    const tokens = await mosService.getTokens();
    if (provider === 'github') return tokens.github || null;
    // Gitea/Codeberg share the same API; allow either token key if configured
    if (provider === 'gitea') return tokens.gitea || tokens.codeberg || null;
    return null;
  } catch {
    return null;
  }
}

/**
 * Build request headers for a provider's JSON API.
 * @param {string} provider - 'github' or 'gitea'
 * @param {string|null} token - Optional auth token
 * @returns {Object}
 * @private
 */
function _apiHeaders(provider, token) {
  const headers = {
    'Accept': provider === 'github' ? 'application/vnd.github.v3+json' : 'application/json',
    'User-Agent': 'MOS-API'
  };
  if (token) headers['Authorization'] = `token ${token}`;
  return headers;
}

/**
 * Build the releases list URL for a provider.
 * @private
 */
function _releasesUrl(info) {
  const base = `${info.apiBase}/repos/${info.owner}/${info.repo}/releases`;
  return info.provider === 'github' ? `${base}?per_page=50` : `${base}?limit=50`;
}

/**
 * Build the tags list URL for a provider.
 * @private
 */
function _tagsUrl(info) {
  const base = `${info.apiBase}/repos/${info.owner}/${info.repo}/tags`;
  return info.provider === 'github' ? `${base}?per_page=50` : `${base}?limit=50`;
}

/**
 * Build the "release by tag" URL for a provider.
 * @private
 */
function _releaseByTagUrl(info, tag) {
  return `${info.apiBase}/repos/${info.owner}/${info.repo}/releases/tags/${encodeURIComponent(tag)}`;
}

/**
 * Build the source tarball URL for a provider.
 * @private
 */
function _tarballUrl(info, tag) {
  if (info.provider === 'github') {
    return `${info.apiBase}/repos/${info.owner}/${info.repo}/tarball/${encodeURIComponent(tag)}`;
  }
  // Gitea archive endpoint
  return `${info.apiBase}/repos/${info.owner}/${info.repo}/archive/${encodeURIComponent(tag)}.tar.gz`;
}

/**
 * Resolve the binary download URL for a release asset.
 * GitHub exposes an API url (asset.url, requires octet-stream Accept);
 * Gitea exposes a direct browser_download_url.
 * @private
 */
function _assetDownloadUrl(info, asset) {
  return info.provider === 'github' ? asset.url : asset.browser_download_url;
}

/**
 * Build headers for downloading a release asset binary.
 * @private
 */
function _assetDownloadHeaders(provider, token) {
  const headers = {
    'Accept': 'application/octet-stream',
    'User-Agent': 'MOS-API'
  };
  if (provider === 'github') {
    headers['X-GitHub-Api-Version'] = '2022-11-28';
  }
  if (token) headers['Authorization'] = `token ${token}`;
  return headers;
}

/**
 * Verify MD5 checksum of a file
 * @private
 */
async function _verifyMd5(filePath, md5Path) {
  const fileBuffer = await fs.readFile(filePath);
  const actualMd5 = crypto.createHash('md5').update(fileBuffer).digest('hex');

  const md5Content = await fs.readFile(md5Path, 'utf8');
  // MD5 file format: "hash  filename" or just "hash"
  const expectedMd5 = md5Content.trim().split(/\s+/)[0].toLowerCase();

  return actualMd5.toLowerCase() === expectedMd5;
}

const APT_OPTS = '-o Acquire::Retries=1 -o Acquire::http::Timeout=10 -o Acquire::https::Timeout=10 -o Acquire::ftp::Timeout=10';

/**
 * Install optional additional packages listed in a plugin's source-root "packages" file.
 * Persisted to <pluginBaseDir>/packages/packages for the boot-time installer.
 * Failures (e.g. no network) are non-fatal.
 * @private
 */
async function _installAdditionalPackages(sourceDir, pluginBaseDir) {
  const sourceList = path.join(sourceDir, 'packages');
  try {
    const stat = await fs.stat(sourceList);
    if (!stat.isFile()) return;
  } catch {
    return;
  }

  const pkgDir = path.join(pluginBaseDir, 'packages');
  const listPath = path.join(pkgDir, 'packages');

  await fs.mkdir(path.join(pkgDir, 'partial'), { recursive: true });
  await fs.copyFile(sourceList, listPath);

  let packages;
  try {
    const content = await fs.readFile(listPath, 'utf8');
    const validToken = /^[a-zA-Z0-9][a-zA-Z0-9+._:=~-]*$/;
    packages = content
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#') && validToken.test(l));
  } catch {
    return;
  }
  if (packages.length === 0) return;

  const pkgArgs = packages.map(p => `"${p}"`).join(' ');
  const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };

  try {
    await execPromise(`apt-get.orig ${APT_OPTS} update`, { timeout: 20000, env });
    await execPromise(
      `apt-get.orig ${APT_OPTS} install -y --download-only --no-install-recommends -o Dir::Cache::archives="${pkgDir}" ${pkgArgs}`,
      { timeout: 60000, env }
    );
    await execPromise(`dpkg -i "${pkgDir}"/*.deb`, { timeout: 30000, env });
    await execPromise('dpkg --configure -a', { timeout: 15000, env });
  } catch {
    // Plugin installation init script will fix that on boot
  }
}

/**
 * Fetch GitHub releases for a repository
 * @param {string} repository - GitHub repository URL
 * @param {boolean} forceRefresh - Force refresh cache
 * @returns {Promise<Object>} Releases data with tags
 */
async function getReleases(repository, forceRefresh = false) {
  if (!repository || typeof repository !== 'string') {
    throw new Error('Repository URL is required');
  }

  // Parse repository URL (GitHub or Gitea/Codeberg)
  const repoInfo = _parseRepoUrl(repository);
  const { owner, repo } = repoInfo;
  const pluginName = repo.replace(/^mos-/, ''); // Remove mos- prefix if present
  const cacheDir = path.join(PLUGINS_CACHE_DIR, pluginName);
  const cachePath = path.join(cacheDir, 'releases.json');

  // Check cache if not forcing refresh
  if (!forceRefresh) {
    try {
      const cacheData = await fs.readFile(cachePath, 'utf8');
      const cache = JSON.parse(cacheData);
      // Cache valid for 5 minutes
      if (cache.timestamp && Date.now() - cache.timestamp < 300000) {
        return cache;
      }
    } catch {
      // Cache doesn't exist or invalid
    }
  }

  // Fetch from provider API
  const token = await _getProviderToken(repoInfo.provider);
  const headers = _apiHeaders(repoInfo.provider, token);

  const apiUrl = _releasesUrl(repoInfo);

  const response = await fetch(apiUrl, { headers });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('Repository not found');
    }
    if (response.status === 403) {
      throw new Error('Rate limit exceeded or authentication required');
    }
    throw new Error(`${repoInfo.provider === 'github' ? 'GitHub' : 'Gitea'} API error: ${response.status}`);
  }

  const releases = await response.json();

  let releaseList;

  if (releases.length > 0) {
    // Extract relevant data - first release is latest
    releaseList = releases.map((r, index) => {
      // Extract architectures from .deb files
      const debAssets = r.assets.filter(a => a.name.endsWith('.deb') && !a.name.endsWith('.md5'));
      const archs = debAssets
        .map(a => _extractArchFromDeb(a.name))
        .filter(a => a !== null);
      const architectures = archs.length > 0 ? [...new Set(archs)] : null;

      return {
        tag: r.tag_name,
        name: r.name || r.tag_name,
        published_at: r.published_at,
        prerelease: r.prerelease,
        latest: index === 0,
        architectures,
        assets: (r.assets || []).map(a => ({
          name: a.name,
          size: a.size,
          download_url: a.browser_download_url,
          api_url: a.url || a.browser_download_url  // For authenticated downloads
        }))
      };
    });
  } else {
    // Fallback: fetch tags if no releases found
    const tagsUrl = _tagsUrl(repoInfo);
    const tagsResponse = await fetch(tagsUrl, { headers });

    if (tagsResponse.ok) {
      const tags = await tagsResponse.json();
      releaseList = tags.map((t, index) => ({
        tag: t.name,
        name: t.name,
        published_at: null,
        prerelease: false,
        latest: index === 0,
        architectures: null,
        assets: []
      }));
    } else {
      releaseList = [];
    }
  }

  const result = {
    repository,
    owner,
    repo,
    timestamp: Date.now(),
    releases: releaseList
  };

  // Cache the result
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(result, null, 2), 'utf8');

  return result;
}

/**
 * Read and validate a Hub plugin template
 * @param {string} templatePath - Absolute path to Hub template JSON
 * @returns {Promise<Object>} Template data
 * @private
 */
async function _readHubTemplate(templatePath) {
  const reposPath = '/var/mos/hub/repositories';

  if (!templatePath || typeof templatePath !== 'string') {
    throw new Error('Template path is required');
  }

  // Security: ensure path is within repositories
  if (!templatePath.startsWith(reposPath)) {
    throw new Error('Invalid template path');
  }

  try {
    const data = await fs.readFile(templatePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('Template not found');
    }
    throw new Error(`Failed to read template: ${error.message}`);
  }
}

/**
 * Install a plugin from Hub template
 * @param {string} templatePath - Absolute path to Hub template JSON
 * @param {string} tag - Release tag to install
 * @returns {Promise<Object>} Installation result
 */
async function installPlugin(templatePath, tag) {
  if (!templatePath || typeof templatePath !== 'string') {
    throw new Error('Template path is required');
  }
  if (!tag || typeof tag !== 'string') {
    throw new Error('Tag is required');
  }

  // Read Hub template
  const hubTemplate = await _readHubTemplate(templatePath);

  if (!hubTemplate.repository) {
    throw new Error('Template missing repository field');
  }

  const repository = hubTemplate.repository;

  // Extract metadata from Hub template
  const hubDriver = hubTemplate.driver === true;
  const hubDonate = hubTemplate.donate || null;
  const hubSupport = hubTemplate.support || null;
  const hubHomepage = hubTemplate.homepage || null;
  const hubDisplayName = hubTemplate.name || null;
  const hubDescription = hubTemplate.description || null;
  const hubIcon = hubTemplate.icon || null;
  const hubAuthor = hubTemplate.author || null;
  const hubSettings = hubTemplate.settings === true;

  // Parse repository URL (GitHub or Gitea/Codeberg)
  let repoInfo;
  try {
    repoInfo = _parseRepoUrl(repository);
  } catch {
    throw new Error('Invalid repository URL in template');
  }
  const pluginName = repoInfo.repo.replace(/^mos-/, '');

  // Check if plugin is already installed
  const existingPluginDir = path.join(PLUGINS_CONFIG_DIR, pluginName);
  let existingTag = null;
  let existingDebPackage = null;
  try {
    await fs.access(existingPluginDir);
    // Plugin exists - check which tag is installed
    const templatePath = path.join(existingPluginDir, 'template.json');
    try {
      const templateData = await fs.readFile(templatePath, 'utf8');
      const template = JSON.parse(templateData);
      existingTag = template.tag;
    } catch {
      // No template.json, treat as corrupted install - allow reinstall
    }

    if (existingTag === tag) {
      throw new Error(`Plugin '${pluginName}' is already installed at version ${tag}`);
    }

    // Different tag - we'll remove the old one and install the new one
    // First, find and remember the old .deb package name for removal
    const oldTagDir = path.join(existingPluginDir, existingTag);
    try {
      const files = await fs.readdir(oldTagDir);
      const debFile = files.find(f => f.endsWith('.deb') && !f.endsWith('.md5'));
      if (debFile) {
        const debFilePath = path.join(oldTagDir, debFile);
        try {
          const { stdout } = await execPromise(`dpkg-deb -f "${debFilePath}" Package`);
          existingDebPackage = stdout.trim();
        } catch { }
      }
    } catch { }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // Plugin not installed, continue
  }

  let tempDir = null;
  let cacheDir = null;
  let pluginBaseDir = null;
  let pluginTagDir = null;

  try {
    const token = await _getProviderToken(repoInfo.provider);
    const headers = _apiHeaders(repoInfo.provider, token);

    // Get release info for the specific tag
    const releaseUrl = _releaseByTagUrl(repoInfo, tag);
    const releaseRes = await fetch(releaseUrl, { headers });
    if (!releaseRes.ok) {
      throw new Error(`Release ${tag} not found`);
    }
    const release = await releaseRes.json();

    // Find .deb for system architecture
    const debAssets = _filterDebByArch(release.assets);
    const systemArch = _getSystemArch();

    if (debAssets.length === 0) {
      throw new Error(`No .deb file found for architecture: ${systemArch}`);
    }
    if (debAssets.length > 1) {
      throw new Error(`Multiple .deb files found for architecture ${systemArch} - only one per architecture supported`);
    }
    const debAsset = debAssets[0];

    // Find matching .md5 file
    const md5Asset = release.assets.find(a => a.name === debAsset.name + '.md5');

    // Create temp and cache directories
    tempDir = path.join('/tmp', `plugin-install-${Date.now()}`);
    cacheDir = path.join(PLUGINS_CACHE_DIR, pluginName, tag);
    await fs.mkdir(tempDir, { recursive: true });
    await fs.mkdir(cacheDir, { recursive: true });
    // Download .deb file via provider download URL (works for public and private repos)
    const debPath = path.join(cacheDir, debAsset.name);
    const downloadHeaders = _assetDownloadHeaders(repoInfo.provider, token);
    const debRes = await fetch(_assetDownloadUrl(repoInfo, debAsset), { headers: downloadHeaders, redirect: 'follow' });
    if (!debRes.ok) throw new Error(`Failed to download .deb file: ${debRes.status}`);
    const debBuffer = Buffer.from(await debRes.arrayBuffer());
    await fs.writeFile(debPath, debBuffer);

    // Download .deb.md5 if exists
    let md5Path = null;
    if (md5Asset) {
      md5Path = path.join(cacheDir, md5Asset.name);
      const md5Res = await fetch(_assetDownloadUrl(repoInfo, md5Asset), { headers: downloadHeaders, redirect: 'follow' });
      if (md5Res.ok) {
        const md5Buffer = Buffer.from(await md5Res.arrayBuffer());
        await fs.writeFile(md5Path, md5Buffer);
      }
    }

    // Download source tarball
    const tarballUrl = _tarballUrl(repoInfo, tag);
    const tarballRes = await fetch(tarballUrl, { headers, redirect: 'follow' });
    if (!tarballRes.ok) throw new Error('Failed to download source');

    // Check size before downloading fully
    const contentLength = tarballRes.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > MAX_SOURCE_SIZE) {
      throw new Error(`Source size exceeds 10MB limit (${Math.round(parseInt(contentLength) / 1024 / 1024)}MB)`);
    }

    const tarballBuffer = Buffer.from(await tarballRes.arrayBuffer());
    if (tarballBuffer.length > MAX_SOURCE_SIZE) {
      throw new Error(`Source size exceeds 10MB limit (${Math.round(tarballBuffer.length / 1024 / 1024)}MB)`);
    }

    const tarballPath = path.join(tempDir, 'source.tar.gz');
    await fs.writeFile(tarballPath, tarballBuffer);

    // Extract source
    await execPromise(`tar -xzf "${tarballPath}" -C "${tempDir}"`);

    // Find extracted directory (GitHub adds owner-repo-hash prefix)
    const entries = await fs.readdir(tempDir);
    const sourceDir = entries.find(e => e !== 'source.tar.gz');
    if (!sourceDir) throw new Error('Failed to extract source');

    const extractedPath = path.join(tempDir, sourceDir);

    // Read plugin.config.js to get plugin name
    const configPath = path.join(extractedPath, 'page', 'plugin.config.js');
    let configContent;
    try {
      configContent = await fs.readFile(configPath, 'utf8');
    } catch {
      throw new Error('plugin.config.js not found in source');
    }

    // Parse name and version from plugin.config.js
    const nameMatch = configContent.match(/name:\s*['"]([^'"]+)['"]/);
    if (!nameMatch) {
      throw new Error('Could not parse plugin name from plugin.config.js');
    }
    const configName = nameMatch[1];

    const versionMatch = configContent.match(/version:\s*['"]([^'"]+)['"]/);
    const configVersion = versionMatch ? versionMatch[1] : tag;

    const displayNameMatch = configContent.match(/displayName:\s*['"]([^'"]+)['"]/);
    const configDisplayName = displayNameMatch ? displayNameMatch[1] : hubDisplayName;

    // Use Hub template values for driver, donate, support, homepage (not from plugin.config.js)
    // Send notification with displayName
    const notifyName = configDisplayName || hubDisplayName || configName;
    await _sendNotification('Plugin', `Installing ${notifyName} Version: ${tag}`, 'normal');

    // Create target directories
    pluginBaseDir = path.join(PLUGINS_CONFIG_DIR, configName);
    pluginTagDir = path.join(pluginBaseDir, tag);
    await fs.mkdir(pluginTagDir, { recursive: true });

    // Copy settings.json to base dir (if exists)
    const settingsSource = path.join(extractedPath, 'settings.json');
    try {
      await fs.access(settingsSource);
      await fs.copyFile(settingsSource, path.join(pluginBaseDir, 'settings.json'));
    } catch {
      // settings.json doesn't exist, skip
    }

    // Copy staticfiles directory to base dir (if exists)
    const staticfilesSource = path.join(extractedPath, 'staticfiles');
    try {
      await fs.access(staticfilesSource);
      const staticfilesDest = path.join(pluginBaseDir, 'staticfiles');
      // Remove existing staticfiles and copy new ones
      await fs.rm(staticfilesDest, { recursive: true, force: true }).catch(() => {});
      await execPromise(`cp -r "${staticfilesSource}" "${staticfilesDest}"`);
    } catch {
      // staticfiles doesn't exist, skip
    }

    // Copy functions to tag dir (if exists)
    const functionsSource = path.join(extractedPath, 'functions');
    try {
      await fs.access(functionsSource);
      await fs.copyFile(functionsSource, path.join(pluginTagDir, 'functions'));
    } catch {
      // functions doesn't exist, skip
    }

    // Copy plugin.config.js to tag dir
    await fs.copyFile(configPath, path.join(pluginTagDir, 'plugin.config.js'));

    // Create template.json in base dir with repository info and Hub template values
    const templateInfo = {
      name: configName,
      displayName: configDisplayName,
      description: hubDescription,
      version: configVersion,
      tag,
      repository,
      driver: hubDriver,
      settings: hubSettings,
      icon: hubIcon,
      author: hubAuthor,
      donate: hubDonate,
      support: hubSupport,
      homepage: hubHomepage,
      installed_at: new Date().toISOString()
    };
    await fs.writeFile(path.join(pluginBaseDir, 'template.json'), JSON.stringify(templateInfo, null, 2), 'utf8');

    // Copy .deb and .deb.md5 to tag dir
    const targetDebPath = path.join(pluginTagDir, debAsset.name);
    await fs.copyFile(debPath, targetDebPath);
    if (md5Path) {
      await fs.copyFile(md5Path, path.join(pluginTagDir, md5Asset.name));
      // Verify MD5 checksum
      const md5Valid = await _verifyMd5(debPath, md5Path);
      if (!md5Valid) {
        throw new Error('MD5 checksum verification failed');
      }
    }

    // If upgrading/downgrading, remove old .deb package and old tag directory first
    if (existingDebPackage) {
      try {
        await execPromise(`dpkg --purge "${existingDebPackage}"`, { timeout: 120000 });
      } catch {
        // Old package might not be installed, continue
      }
    }
    if (existingTag) {
      const oldTagDir = path.join(pluginBaseDir, existingTag);
      await fs.rm(oldTagDir, { recursive: true, force: true }).catch(() => {});
    }

    // Execute pre_install function from functions file before any package installation
    const preInstallFunctions = path.join(pluginTagDir, 'functions');
    try {
      await fs.access(preInstallFunctions);
      await execPromise(`bash -c 'source "${preInstallFunctions}"; if declare -f pre_install &>/dev/null; then pre_install; fi'`, {
        cwd: pluginTagDir,
        timeout: 60000 // 1min timeout for pre_install function
      });
    } catch (preInstallError) {
      if (preInstallError.code !== 'ENOENT') {
        await _sendNotification('Plugin', `Pre-install function for ${notifyName} reported an error`, 'alert');
      }
    }

    // Install .deb package (force to handle downgrades and same version reinstalls)
    await execPromise(`dpkg -i --force-downgrade "${targetDebPath}"`, { timeout: 120000 });
    await _installAdditionalPackages(extractedPath, pluginBaseDir);

    // Cleanup temp directory
    await fs.rm(tempDir, { recursive: true, force: true });

    // Execute install function from functions file if it exists
    const functionsPath = path.join(pluginTagDir, 'functions');
    try {
      await fs.access(functionsPath);
      // Source the functions file and run the install function
      await execPromise(`bash -c 'source "${functionsPath}"; if declare -f install &>/dev/null; then install; fi'`, {
        cwd: pluginTagDir,
        timeout: 60000 // 1min timeout for install function
      });
    } catch (installError) {
      // Only log if it's not a missing functions file
      if (installError.code !== 'ENOENT') {
        await _sendNotification('Plugin', `Install function for ${notifyName} reported an error`, 'alert');
      }
    }

    await _sendNotification('Plugin', `${notifyName} Version: ${tag} installed successfully`, 'normal');

    // Cleanup cache directory (files already copied to plugin dir)
    if (cacheDir) await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {});

    // Refresh hub "installed" detection immediately
    try {
      require('./hub.service').invalidateInstalledCache();
    } catch { }

    return {
      success: true,
      plugin: configName,
      tag,
      installed_to: pluginTagDir,
      files: {
        deb: debAsset.name,
        md5: md5Asset?.name || null,
        config: 'plugin.config.js'
      }
    };

  } catch (error) {
    // Cleanup on error
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    if (cacheDir) await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
    // Remove plugin directories if they were created
    if (pluginTagDir) {
      await fs.rm(pluginTagDir, { recursive: true, force: true }).catch(() => {});
      // Remove base dir if empty
      if (pluginBaseDir) {
        try {
          const entries = await fs.readdir(pluginBaseDir);
          if (entries.length === 0) {
            await fs.rm(pluginBaseDir, { recursive: true, force: true });
          }
        } catch {
          // Ignore
        }
      }
    }
    await _sendNotification('Plugin', `Installation failed: ${error.message}`, 'alert');
    throw error;
  }
}

/**
 * Get plugin settings
 * @param {string} pluginName - Plugin name
 * @returns {Promise<Object>} Settings object
 */
async function getPluginSettings(pluginName) {
  if (!pluginName || typeof pluginName !== 'string') {
    throw new Error('Plugin name is required');
  }

  // Sanitize plugin name (no path traversal)
  const safeName = path.basename(pluginName);
  if (safeName !== pluginName || pluginName.includes('..')) {
    throw new Error('Invalid plugin name');
  }

  const settingsPath = path.join(PLUGINS_CONFIG_DIR, safeName, 'settings.json');

  try {
    const data = await fs.readFile(settingsPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Settings not found for plugin: ${pluginName}`);
    }
    throw new Error(`Error reading settings: ${error.message}`);
  }
}

/**
 * Set plugin settings
 * @param {string} pluginName - Plugin name
 * @param {Object} settings - Settings object to save
 * @returns {Promise<Object>} Saved settings
 */
async function setPluginSettings(pluginName, settings) {
  if (!pluginName || typeof pluginName !== 'string') {
    throw new Error('Plugin name is required');
  }
  if (!settings || typeof settings !== 'object') {
    throw new Error('Settings object is required');
  }

  // Sanitize plugin name (no path traversal)
  const safeName = path.basename(pluginName);
  if (safeName !== pluginName || pluginName.includes('..')) {
    throw new Error('Invalid plugin name');
  }

  const pluginDir = path.join(PLUGINS_CONFIG_DIR, safeName);
  const settingsPath = path.join(pluginDir, 'settings.json');

  // Check if plugin directory exists
  try {
    await fs.access(pluginDir);
  } catch {
    throw new Error(`Plugin not found: ${pluginName}`);
  }

  // Write settings
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

  return settings;
}

/**
 * Check for plugin updates
 * Compares installed plugins with latest available versions
 * @param {Object} [options] - Options
 * @param {boolean} [options.notify] - Send notification if updates are found
 * @returns {Promise<Array>} Update check results
 */
async function checkUpdates(options = {}) {
  const results = [];
  const versionsPath = path.join(PLUGINS_CACHE_DIR, 'versions.json');

  // Read all plugin directories from /boot/optional/plugins
  try {
    await fs.access(PLUGINS_CONFIG_DIR);
  } catch {
    await fs.mkdir(PLUGINS_CACHE_DIR, { recursive: true });
    await fs.writeFile(versionsPath, '[]', 'utf8');
    return [];
  }

  const entries = await fs.readdir(PLUGINS_CONFIG_DIR, { withFileTypes: true });
  const pluginDirs = entries.filter(e => e.isDirectory());

  for (const dir of pluginDirs) {
    const pluginName = dir.name;
    const templatePath = path.join(PLUGINS_CONFIG_DIR, pluginName, 'template.json');

    try {
      const templateData = await fs.readFile(templatePath, 'utf8');
      const template = JSON.parse(templateData);

      if (!template.repository) continue;

      // Get latest release from GitHub
      let available = null;
      try {
        const releases = await getReleases(template.repository, true);
        if (releases.releases && releases.releases.length > 0) {
          const latest = releases.releases.find(r => r.latest);
          if (latest) {
            available = latest.tag;
          }
        }
      } catch {
        // Could not fetch releases
      }

      const installed = template.tag || 'unknown';
      results.push({
        plugin: pluginName,
        installed,
        available,
        repository: template.repository,
        update_available: available && installed !== available
      });

    } catch {
      // Skip plugins without valid template.json
    }
  }

  // Save to versions.json
  await fs.mkdir(PLUGINS_CACHE_DIR, { recursive: true });
  await fs.writeFile(versionsPath, JSON.stringify(results, null, 2), 'utf8');

  // Send notification if updates found and notify flag is set
  if (options.notify) {
    const updatable = results.filter(r => r.update_available);
    if (updatable.length > 0) {
      const names = updatable.map(r => r.plugin).join(', ');
      await _sendNotification('Plugin', `Update for Plugins: ${names} found.`, 'normal');
    }
  }

  return results;
}

/**
 * Update one or all plugins
 * @param {string} pluginName - Optional plugin name, if empty updates all
 * @returns {Promise<Object>} Update results
 */
async function updatePlugins(pluginName = null) {
  const versionsPath = path.join(PLUGINS_CACHE_DIR, 'versions.json');

  // Check if versions.json exists
  try {
    await fs.access(versionsPath);
  } catch {
    throw new Error('No update check performed yet. Run updatecheck first.');
  }

  const versionsData = await fs.readFile(versionsPath, 'utf8');
  const versions = JSON.parse(versionsData);

  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error('No plugins found in versions.json');
  }

  // Filter plugins to update
  let pluginsToUpdate = versions.filter(p => p.update_available);

  if (pluginName) {
    pluginsToUpdate = pluginsToUpdate.filter(p => p.plugin === pluginName);
    if (pluginsToUpdate.length === 0) {
      const found = versions.find(p => p.plugin === pluginName);
      if (!found) {
        throw new Error(`Plugin not found: ${pluginName}`);
      }
      throw new Error(`No update available for: ${pluginName}`);
    }
  }

  if (pluginsToUpdate.length === 0) {
    return { updated: [], message: 'No updates available' };
  }

  const results = [];

  for (const plugin of pluginsToUpdate) {
    try {
      const templatePath = path.join(PLUGINS_CONFIG_DIR, plugin.plugin, 'template.json');
      const templateData = await fs.readFile(templatePath, 'utf8');
      const template = JSON.parse(templateData);
      const oldTag = template.tag;
      const newTag = plugin.available;
      const notifyName = template.displayName || plugin.plugin;

      await _sendNotification('Plugin', `Updating ${notifyName} to Version: ${plugin.available}`, 'normal');

      // Parse repository (GitHub or Gitea/Codeberg)
      const repoInfo = _parseRepoUrl(plugin.repository);

      // Get provider headers
      const token = await _getProviderToken(repoInfo.provider);
      const headers = _apiHeaders(repoInfo.provider, token);

      // Get release info
      const releaseUrl = _releaseByTagUrl(repoInfo, newTag);
      const releaseRes = await fetch(releaseUrl, { headers });
      if (!releaseRes.ok) throw new Error(`Release ${newTag} not found`);
      const release = await releaseRes.json();

      // Find .deb for system architecture
      const debAssets = _filterDebByArch(release.assets);
      const systemArch = _getSystemArch();
      if (debAssets.length === 0) throw new Error(`No .deb file found for architecture: ${systemArch}`);
      if (debAssets.length > 1) throw new Error(`Multiple .deb files for ${systemArch} - only one per architecture supported`);
      const debAsset = debAssets[0];

      // Find matching .md5 file
      const md5Asset = release.assets.find(a => a.name === debAsset.name + '.md5');

      // Create directories
      const tempDir = path.join('/tmp', `plugin-update-${Date.now()}`);
      const cacheDir = path.join(PLUGINS_CACHE_DIR, plugin.plugin, newTag);
      await fs.mkdir(tempDir, { recursive: true });
      await fs.mkdir(cacheDir, { recursive: true });

      try {
        // Download .deb via provider download URL
        const debPath = path.join(cacheDir, debAsset.name);
        const downloadHeaders = _assetDownloadHeaders(repoInfo.provider, token);
        const debRes = await fetch(_assetDownloadUrl(repoInfo, debAsset), { headers: downloadHeaders, redirect: 'follow' });
        if (!debRes.ok) throw new Error(`Failed to download .deb: ${debRes.status}`);
        await fs.writeFile(debPath, Buffer.from(await debRes.arrayBuffer()));

        // Download and verify MD5
        if (md5Asset) {
          const md5Path = path.join(cacheDir, md5Asset.name);
          const md5Res = await fetch(_assetDownloadUrl(repoInfo, md5Asset), { headers: downloadHeaders, redirect: 'follow' });
          if (md5Res.ok) {
            await fs.writeFile(md5Path, Buffer.from(await md5Res.arrayBuffer()));
            const md5Valid = await _verifyMd5(debPath, md5Path);
            if (!md5Valid) throw new Error('MD5 checksum verification failed');
          }
        }

        // Download and extract source
        const tarballUrl = _tarballUrl(repoInfo, newTag);
        const tarballRes = await fetch(tarballUrl, { headers, redirect: 'follow' });
        if (!tarballRes.ok) throw new Error('Failed to download source');
        const tarballBuffer = Buffer.from(await tarballRes.arrayBuffer());
        if (tarballBuffer.length > MAX_SOURCE_SIZE) throw new Error('Source exceeds 10MB limit');

        const tarballPath = path.join(tempDir, 'source.tar.gz');
        await fs.writeFile(tarballPath, tarballBuffer);
        await execPromise(`tar -xzf "${tarballPath}" -C "${tempDir}"`);

        const entries = await fs.readdir(tempDir);
        const sourceDir = entries.find(e => e !== 'source.tar.gz');
        if (!sourceDir) throw new Error('Failed to extract source');
        const extractedPath = path.join(tempDir, sourceDir);

        // Read plugin.config.js - only override template values if explicitly defined
        const configPath = path.join(extractedPath, 'page', 'plugin.config.js');
        const configContent = await fs.readFile(configPath, 'utf8');

        const versionMatch = configContent.match(/version:\s*['"]([^'"]+)['"]/);
        const configVersion = versionMatch ? versionMatch[1] : newTag;

        // Only override if explicitly defined in plugin.config.js, otherwise keep template value
        const displayNameMatch = configContent.match(/displayName:\s*['"]([^'"]+)['"]/);
        const driverMatch = configContent.match(/driver:\s*(true|false)/);
        const settingsMatch = configContent.match(/settings:\s*(true|false)/);
        const donateMatch = configContent.match(/donate:\s*['"]([^'"]+)['"]/);
        const supportMatch = configContent.match(/support:\s*['"]([^'"]+)['"]/);
        const homepageMatch = configContent.match(/homepage:\s*['"]([^'"]+)['"]/);
        const iconMatch = configContent.match(/icon:\s*['"]([^'"]+)['"]/);
        const authorMatch = configContent.match(/author:\s*['"]([^'"]+)['"]/);
        const descriptionMatch = configContent.match(/description:\s*['"]([^'"]+)['"]/);

        // Store old tag directory path for later removal (after successful update)
        const oldTagDir = path.join(PLUGINS_CONFIG_DIR, plugin.plugin, oldTag);

        // Create new tag directory
        const newTagDir = path.join(PLUGINS_CONFIG_DIR, plugin.plugin, newTag);
        await fs.mkdir(newTagDir, { recursive: true });

        // Copy files (NOT staticfiles and settings.json)
        // Copy functions
        const functionsSource = path.join(extractedPath, 'functions');
        try {
          await fs.access(functionsSource);
          await fs.copyFile(functionsSource, path.join(newTagDir, 'functions'));
        } catch { }

        // Copy plugin.config.js
        await fs.copyFile(configPath, path.join(newTagDir, 'plugin.config.js'));

        // Copy .deb
        await fs.copyFile(debPath, path.join(newTagDir, debAsset.name));
        if (md5Asset) {
          await fs.copyFile(path.join(cacheDir, md5Asset.name), path.join(newTagDir, md5Asset.name));
        }

        // Update template.json - only override if explicitly defined in plugin.config.js
        template.version = configVersion;
        template.tag = newTag;
        template.updated_at = new Date().toISOString();
        // Only update these fields if they are explicitly defined in plugin.config.js
        if (displayNameMatch) template.displayName = displayNameMatch[1];
        if (driverMatch) template.driver = driverMatch[1] === 'true';
        if (settingsMatch) template.settings = settingsMatch[1] === 'true';
        if (donateMatch) template.donate = donateMatch[1];
        if (supportMatch) template.support = supportMatch[1];
        if (homepageMatch) template.homepage = homepageMatch[1];
        if (iconMatch) template.icon = iconMatch[1];
        if (authorMatch) template.author = authorMatch[1];
        if (descriptionMatch) template.description = descriptionMatch[1];
        await fs.writeFile(path.join(PLUGINS_CONFIG_DIR, plugin.plugin, 'template.json'), JSON.stringify(template, null, 2), 'utf8');

        // Install .deb (force to handle downgrades and same version reinstalls)
        await execPromise(`dpkg -i --force-downgrade "${path.join(newTagDir, debAsset.name)}"`, { timeout: 300000 });
        await _installAdditionalPackages(extractedPath, path.join(PLUGINS_CONFIG_DIR, plugin.plugin));

        // Execute plugin-update function
        const functionsPath = path.join(newTagDir, 'functions');
        try {
          await fs.access(functionsPath);
          await execPromise(`bash -c 'source "${functionsPath}"; if declare -f plugin_update &>/dev/null; then plugin_update; fi'`, {
            cwd: newTagDir,
            timeout: 600000
          });
        } catch (updateError) {
          if (updateError.code !== 'ENOENT') {
            await _sendNotification('Plugin', `Update function for ${notifyName} reported an error`, 'alert');
          }
        }

        // Remove old tag directory only after successful update
        if (oldTag !== newTag) {
          await fs.rm(oldTagDir, { recursive: true, force: true }).catch(() => {});
        }

        // Cleanup temp and cache directories
        await fs.rm(tempDir, { recursive: true, force: true });
        await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {});

        await _sendNotification('Plugin', `${notifyName} updated to Version: ${newTag}`, 'normal');
        results.push({ plugin: plugin.plugin, from: oldTag, to: newTag, success: true });

      } catch (err) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
        await _sendNotification('Plugin', `Update failed for ${notifyName}: ${err.message}`, 'alert');
        results.push({ plugin: plugin.plugin, success: false, error: err.message });
      }

    } catch (err) {
      results.push({ plugin: plugin.plugin, success: false, error: err.message });
    }
  }

  // Refresh versions.json
  await checkUpdates();

  return { updated: results };
}

/**
 * Uninstall a plugin
 * @param {string} pluginName - Plugin name to uninstall
 * @returns {Promise<Object>} Uninstall result
 */
async function uninstallPlugin(pluginName) {
  if (!pluginName || typeof pluginName !== 'string') {
    throw new Error('Plugin name is required');
  }

  // Sanitize plugin name
  const safeName = path.basename(pluginName);
  if (safeName !== pluginName || pluginName.includes('..')) {
    throw new Error('Invalid plugin name');
  }

  const pluginConfigDir = path.join(PLUGINS_CONFIG_DIR, safeName);
  const pluginWebDir = path.join(PLUGINS_DIR, safeName);

  // Check if plugin exists in either location
  let configExists = false;
  let webExists = false;
  try {
    await fs.access(pluginConfigDir);
    configExists = true;
  } catch { }
  try {
    await fs.access(pluginWebDir);
    webExists = true;
  } catch { }

  if (!configExists && !webExists) {
    throw new Error(`Plugin not found: ${pluginName}`);
  }

  // Check if this is a driver plugin by reading template.json
  let isDriver = false;
  let displayName = pluginName;
  if (configExists) {
    try {
      const templatePath = path.join(pluginConfigDir, 'template.json');
      const templateData = await fs.readFile(templatePath, 'utf8');
      const template = JSON.parse(templateData);
      isDriver = template.driver === true;
      displayName = template.displayName || pluginName;
    } catch { }
  }

  try {
    // Find the .deb file and extract real package name using dpkg-deb
    let debPackageName = null;
    let debFilePath = null;
    if (configExists) {
      const entries = await fs.readdir(pluginConfigDir);
      for (const entry of entries) {
        const entryPath = path.join(pluginConfigDir, entry);
        const stat = await fs.stat(entryPath);
        if (stat.isDirectory()) {
          const files = await fs.readdir(entryPath);
          const debFile = files.find(f => f.endsWith('.deb') && !f.endsWith('.md5'));
          if (debFile) {
            debFilePath = path.join(entryPath, debFile);
            // Extract real package name from .deb file using dpkg-deb
            try {
              const { stdout } = await execPromise(`dpkg-deb -f "${debFilePath}" Package`);
              debPackageName = stdout.trim();
            } catch {
              // Fallback: try to extract from filename
              const match = debFile.match(/^([^_]+)/);
              if (match) {
                debPackageName = match[1];
              }
            }
            break;
          }
        }
      }
    }

    // Execute uninstall function from functions file if it exists (before removing files)
    if (configExists) {
      const entries = await fs.readdir(pluginConfigDir);
      for (const entry of entries) {
        const entryPath = path.join(pluginConfigDir, entry);
        const stat = await fs.stat(entryPath);
        if (stat.isDirectory()) {
          const functionsPath = path.join(entryPath, 'functions');
          try {
            await fs.access(functionsPath);
            await execPromise(`bash -c 'source "${functionsPath}"; if declare -f uninstall &>/dev/null; then uninstall; fi'`, {
              cwd: entryPath,
              timeout: 600000 // 10min timeout for uninstall
            });
          } catch (uninstallError) {
            if (uninstallError.code !== 'ENOENT') {
              await _sendNotification('Plugin', `Uninstall function for ${displayName} reported an error`, 'alert');
            }
          }
          break; // Only one tag directory expected
        }
      }
    }

    // Uninstall .deb package if found (use --purge to also remove config-only packages)
    if (debPackageName) {
      try {
        await execPromise(`dpkg --purge "${debPackageName}"`, { timeout: 120000 });
      } catch {
        // Package might not be installed via dpkg, continue with cleanup
      }
    }

    // Delete driver directory if this is a driver plugin (but don't uninstall driver packages)
    let driverDir = null;
    if (isDriver) {
      driverDir = path.join('/boot/optional/drivers', safeName);
      try {
        await fs.access(driverDir);
        await fs.rm(driverDir, { recursive: true, force: true });
      } catch {
        driverDir = null; // Directory doesn't exist
      }
    }

    // Delete plugin directories (if they exist)
    if (configExists) {
      await fs.rm(pluginConfigDir, { recursive: true, force: true });
    }
    if (webExists) {
      await fs.rm(pluginWebDir, { recursive: true, force: true });
    }

    // Clean up cache
    const cacheDir = path.join(PLUGINS_CACHE_DIR, safeName);
    await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {});

    // Refresh hub "installed" detection immediately
    try {
      require('./hub.service').invalidateInstalledCache();
    } catch { }

    return {
      success: true,
      plugin: pluginName,
      reboot_required: isDriver,
      removed: {
        config: configExists ? pluginConfigDir : null,
        web: webExists ? pluginWebDir : null,
        driver: driverDir
      }
    };

  } catch (error) {
    throw error;
  }
}

// Blocked functions that cannot be executed via executeFunction
const BLOCKED_FUNCTIONS = ['pre_install', 'install', 'uninstall', 'mos_start', 'mos_start_after_services', 'plugin_update', 'mos_osupdate'];

/**
 * Execute a function from a plugin's functions file
 * @param {string} pluginName - Plugin name
 * @param {string} functionName - Function to execute
 * @param {string} displayName - Optional display name for notifications
 * @param {boolean} restart - Optional flag to show reboot message on success
 * @returns {Promise<void>}
 */
async function executeFunction(pluginName, functionName, displayName = null, restart = false) {
  if (!pluginName || typeof pluginName !== 'string') {
    throw new Error('Plugin name is required');
  }
  if (!functionName || typeof functionName !== 'string') {
    throw new Error('Function name is required');
  }

  // Sanitize inputs
  const safeName = path.basename(pluginName);
  if (safeName !== pluginName || pluginName.includes('..')) {
    throw new Error('Invalid plugin name');
  }

  const safeFunctionName = functionName.replace(/[^a-zA-Z0-9_-]/g, '');
  if (safeFunctionName !== functionName) {
    throw new Error('Invalid function name');
  }

  // Check for blocked functions
  if (BLOCKED_FUNCTIONS.includes(functionName)) {
    throw new Error(`Function '${functionName}' is not allowed to be executed`);
  }

  const pluginConfigDir = path.join(PLUGINS_CONFIG_DIR, safeName);

  // Find the current tag directory
  let tagDir = null;
  try {
    const templatePath = path.join(pluginConfigDir, 'template.json');
    const templateData = await fs.readFile(templatePath, 'utf8');
    const template = JSON.parse(templateData);
    tagDir = path.join(pluginConfigDir, template.tag);
  } catch {
    throw new Error(`Plugin not found: ${pluginName}`);
  }

  // Check if functions file exists
  const functionsPath = path.join(tagDir, 'functions');
  try {
    await fs.access(functionsPath);
  } catch {
    throw new Error(`No functions file found for plugin: ${pluginName}`);
  }

  const notifyName = displayName || null;

  if (notifyName) {
    await _sendNotification('Plugin', `Executing ${notifyName}`, 'normal');
  }

  try {
    await execPromise(`bash -c 'source "${functionsPath}"; if declare -f ${safeFunctionName} &>/dev/null; then ${safeFunctionName}; else echo "Function not found" >&2; exit 1; fi'`, {
      cwd: tagDir,
      timeout: 600000 // 10min timeout
    });

    // Write to reboot_pending file if restart requested
    if (restart) {
      try {
        await fs.mkdir('/var/mos', { recursive: true });
        await fs.appendFile('/var/mos/reboot_pending', `${pluginName} Update\n`);
      } catch (e) {
        console.error(`[executefunction] Failed to write reboot_pending for ${pluginName}:`, e.message);
      }
    }

    if (notifyName) {
      const successMsg = restart
        ? `${notifyName} completed successfully, please reboot your server`
        : `${notifyName} completed successfully`;
      await _sendNotification('Plugin', successMsg, restart ? 'warning' : 'normal');
    }

  } catch (error) {
    let errorMsg = 'unknown error';
    if (error.killed) {
      errorMsg = 'timed out';
    } else if (error.stderr) {
      errorMsg = error.stderr.trim();
    } else if (error.message) {
      errorMsg = error.message.replace(/Command failed:.*?\n?/s, '').trim() || error.message;
    }
    if (notifyName) {
      await _sendNotification('Plugin', `${notifyName} failed: ${errorMsg}`, 'alert');
    }
    throw new Error(`${notifyName || functionName} failed: ${errorMsg}`);
  }
}

/**
 * Get installed driver package for a driver plugin
 * @param {string} pluginName - Plugin name
 * @returns {Promise<Object>} Driver package info
 */
async function getDriverPackage(pluginName) {
  if (!pluginName || typeof pluginName !== 'string') {
    throw new Error('Plugin name is required');
  }

  // Sanitize plugin name
  const safeName = path.basename(pluginName);
  if (safeName !== pluginName || pluginName.includes('..')) {
    throw new Error('Invalid plugin name');
  }

  const pluginConfigDir = path.join(PLUGINS_CONFIG_DIR, safeName);

  // Read template.json to check if this is a driver
  let template;
  try {
    const templatePath = path.join(pluginConfigDir, 'template.json');
    const templateData = await fs.readFile(templatePath, 'utf8');
    template = JSON.parse(templateData);
  } catch {
    throw new Error(`Plugin not found: ${pluginName}`);
  }

  if (template.driver !== true) {
    throw new Error(`Plugin '${pluginName}' is not a driver plugin`);
  }

  // Get current kernel version
  const { stdout: kernelVersion } = await execPromise('uname -r');
  const kernel = kernelVersion.trim();

  // Look for .deb files in driver directory
  const driverDir = path.join('/boot/optional/drivers', safeName, kernel);

  try {
    await fs.access(driverDir);
  } catch {
    throw new Error(`No driver directory found for kernel ${kernel}`);
  }

  const files = await fs.readdir(driverDir);
  const debFiles = files.filter(f => f.endsWith('.deb') && !f.endsWith('.md5'));

  if (debFiles.length === 0) {
    throw new Error(`No driver package found for kernel ${kernel}`);
  }

  // Return first .deb found (typically there's only one)
  const packageName = debFiles[0];
  const packagePath = path.join(driverDir, packageName);

  return {
    plugin: pluginName,
    kernel,
    package: packageName,
    path: packagePath,
    directory: driverDir
  };
}

/**
 * Get plugin settings
 * @param {string} pluginName - Plugin name
 * @returns {Promise<Object>} Settings object
 */
async function getPluginSettings(pluginName) {
  if (!pluginName || typeof pluginName !== 'string') {
    throw new Error('Plugin name is required');
  }

  // Sanitize plugin name (no path traversal)
  const safeName = path.basename(pluginName);
  if (safeName !== pluginName || pluginName.includes('..')) {
    throw new Error('Invalid plugin name');
  }

  const settingsPath = path.join(PLUGINS_CONFIG_DIR, safeName, 'settings.json');

  try {
    const data = await fs.readFile(settingsPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Settings not found for plugin: ${pluginName}`);
    }
    throw new Error(`Error reading settings: ${error.message}`);
  }
}

/**
 * Set plugin settings
 * @param {string} pluginName - Plugin name
 * @param {Object} settings - Settings object to save
 * @returns {Promise<Object>} Saved settings
 */
async function setPluginSettings(pluginName, settings) {
  if (!pluginName || typeof pluginName !== 'string') {
    throw new Error('Plugin name is required');
  }
  if (!settings || typeof settings !== 'object') {
    throw new Error('Settings object is required');
  }

  // Sanitize plugin name (no path traversal)
  const safeName = path.basename(pluginName);
  if (safeName !== pluginName || pluginName.includes('..')) {
    throw new Error('Invalid plugin name');
  }

  const pluginDir = path.join(PLUGINS_CONFIG_DIR, safeName);
  const settingsPath = path.join(pluginDir, 'settings.json');

  // Check if plugin directory exists
  try {
    await fs.access(pluginDir);
  } catch {
    throw new Error(`Plugin not found: ${pluginName}`);
  }

  // Write settings
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

  return settings;
}

/**
 * Validate that a plugin function can be executed
 * @param {string} pluginName - Plugin name
 * @param {string} functionName - Function to execute
 * @returns {Promise<void>}
 */
async function validateFunction(pluginName, functionName) {
  if (!pluginName || typeof pluginName !== 'string') {
    throw new Error('Plugin name is required');
  }
  if (!functionName || typeof functionName !== 'string') {
    throw new Error('Function name is required');
  }

  const safeName = path.basename(pluginName);
  if (safeName !== pluginName || pluginName.includes('..')) {
    throw new Error('Invalid plugin name');
  }

  const safeFunctionName = functionName.replace(/[^a-zA-Z0-9_-]/g, '');
  if (safeFunctionName !== functionName) {
    throw new Error('Invalid function name');
  }

  if (BLOCKED_FUNCTIONS.includes(functionName)) {
    throw new Error(`Function '${functionName}' is not allowed to be executed`);
  }

  const pluginConfigDir = path.join(PLUGINS_CONFIG_DIR, safeName);

  let tagDir = null;
  try {
    const templatePath = path.join(pluginConfigDir, 'template.json');
    const templateData = await fs.readFile(templatePath, 'utf8');
    const template = JSON.parse(templateData);
    tagDir = path.join(pluginConfigDir, template.tag);
  } catch {
    throw new Error(`Plugin not found: ${pluginName}`);
  }

  const functionsPath = path.join(tagDir, 'functions');
  try {
    await fs.access(functionsPath);
  } catch {
    throw new Error(`No functions file found for plugin: ${pluginName}`);
  }
}

module.exports = {
  getPlugins,
  executeQuery,
  getReleases,
  installPlugin,
  uninstallPlugin,
  executeFunction,
  validateFunction,
  getDriverPackage,
  getPluginSettings,
  setPluginSettings,
  checkUpdates,
  updatePlugins,
  sendNotification: _sendNotification
};
