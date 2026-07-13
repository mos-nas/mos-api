const fs = require('fs').promises;
const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const os = require('os');
const axios = require('axios');
const dockerService = require('./docker.service');
const mosService = require('./mos.service');

const execPromise = util.promisify(exec);

/**
 * Create temp Docker config with registry auth if tokens available
 * @returns {Promise<{configDir: string|null, cleanup: Function}>}
 */
async function createDockerAuthConfig() {
  try {
    const tokens = await mosService.getTokens();
    if (!tokens.dockerhub && !tokens.github) {
      return { configDir: null, cleanup: () => {} };
    }

    const auths = {};

    // DockerHub: token format is "username:token"
    if (tokens.dockerhub) {
      const auth = Buffer.from(tokens.dockerhub).toString('base64');
      auths['https://index.docker.io/v1/'] = { auth };
    }

    // GHCR uses GitHub token: "USERNAME:token" (USERNAME can be anything for PAT)
    if (tokens.github) {
      const auth = Buffer.from(`_:${tokens.github}`).toString('base64');
      auths['ghcr.io'] = { auth };
    }

    const configDir = '/var/mos/docker-auth';
    const configFile = path.join(configDir, 'config.json');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(configFile, JSON.stringify({ auths }));

    return {
      configDir,
      cleanup: async () => {
        try { await fs.unlink(configFile); } catch {}
      }
    };
  } catch {
    return { configDir: null, cleanup: () => {} };
  }
}

/**
 * Execute command with Docker auth if tokens available
 */
async function execWithAuth(command, options = {}) {
  const { configDir, cleanup } = await createDockerAuthConfig();
  try {
    const execOpts = { ...options };
    if (configDir) {
      execOpts.env = { ...process.env, ...options.env, DOCKER_CONFIG: configDir };
    }
    return await execPromise(command, execOpts);
  } finally {
    await cleanup();
  }
}

/**
 * Check if stderr output contains only docker-compose warnings (not real errors)
 * @param {string} stderr - stderr output
 * @returns {boolean}
 */
function isStderrOnlyWarnings(stderr) {
  if (!stderr || !stderr.trim()) return true;
  return stderr.trim().split('\n').every(line => {
    const t = line.trim();
    return !t || /^WARN\[/i.test(t) || /^WARNING:/i.test(t);
  });
}

/**
 * Execute a docker-compose command, treating warning-only stderr as success
 */
async function execCompose(command, options = {}) {
  try {
    return await execPromise(command, options);
  } catch (error) {
    if (error.stderr && isStderrOnlyWarnings(error.stderr)) {
      return { stdout: error.stdout || '', stderr: error.stderr || '' };
    }
    throw error;
  }
}

/**
 * Execute a docker-compose command with auth, treating warning-only stderr as success
 */
async function execComposeWithAuth(command, options = {}) {
  try {
    return await execWithAuth(command, options);
  } catch (error) {
    if (error.stderr && isStderrOnlyWarnings(error.stderr)) {
      return { stdout: error.stdout || '', stderr: error.stderr || '' };
    }
    throw error;
  }
}

class DockerComposeService {

  /**
   * Normalize webui URL: convert [IP] to [ADDRESS], null/empty to null
   * @param {string|null|undefined} webui - Raw webui value
   * @returns {string|null} Normalized webui or null
   */
  _normalizeWebui(webui) {
    if (webui === null || webui === undefined || webui === '') return null;
    let normalized = webui;
    if (normalized.includes('[IP]')) {
      normalized = normalized.replace(/\[IP\]/g, '[ADDRESS]');
    }
    return normalized;
  }

  /**
   * Get the base path for compose stacks (boot directory - master copy)
   * @returns {string} Base path
   */
  _getBasePath() {
    return '/boot/config/system/docker/compose';
  }

  /**
   * Get the path for a specific stack in boot (master copy)
   * @param {string} stackName - Stack name
   * @returns {string} Stack path
   */
  _getStackPath(stackName) {
    return path.join(this._getBasePath(), stackName);
  }

  /**
   * Get the Docker AppData path from settings
   * @returns {Promise<string>} AppData path
   */
  async _getDockerAppDataPath() {
    try {
      const dockerSettings = await mosService.getDockerSettings();
      if (!dockerSettings.appdata) {
        throw new Error('Docker AppData path not configured');
      }
      return dockerSettings.appdata;
    } catch (error) {
      throw new Error(`Failed to get Docker AppData path: ${error.message}`);
    }
  }

  /**
   * Get the working directory path for a specific stack (in Docker AppData)
   * @param {string} stackName - Stack name
   * @returns {Promise<string>} Working directory path
   */
  async _getWorkingPath(stackName) {
    const appDataPath = await this._getDockerAppDataPath();
    return path.join(appDataPath, `compose_${stackName}`);
  }

  /**
   * Copy stack files from boot to working directory
   * @param {string} stackName - Stack name
   * @returns {Promise<void>}
   */
  async _copyStackToWorking(stackName) {
    try {
      const bootPath = this._getStackPath(stackName);
      const workingPath = await this._getWorkingPath(stackName);

      // Create working directory if it doesn't exist
      await fs.mkdir(workingPath, { recursive: true });

      // Copy compose.yaml
      const composeBootPath = path.join(bootPath, 'compose.yaml');
      const composeWorkingPath = path.join(workingPath, 'compose.yaml');
      await fs.copyFile(composeBootPath, composeWorkingPath);

      // Copy .env if it exists
      const envBootPath = path.join(bootPath, '.env');
      const envWorkingPath = path.join(workingPath, '.env');
      try {
        await fs.access(envBootPath);
        await fs.copyFile(envBootPath, envWorkingPath);
      } catch (err) {
        // .env doesn't exist, that's ok
        // But remove it from working directory if it exists there
        try {
          await fs.unlink(envWorkingPath);
        } catch (unlinkErr) {
          // Doesn't exist, that's ok
        }
      }

      // Copy mos.override.yaml
      const mosOverrideBootPath = path.join(bootPath, 'mos.override.yaml');
      const mosOverrideWorkingPath = path.join(workingPath, 'mos.override.yaml');
      await fs.copyFile(mosOverrideBootPath, mosOverrideWorkingPath);
    } catch (error) {
      throw new Error(`Failed to copy stack to working directory: ${error.message}`);
    }
  }

  /**
   * Get the base path for removed compose stacks
   * @returns {string} Removed stacks base path
   */
  _getRemovedBasePath() {
    return '/boot/config/system/docker/compose-removed';
  }

  /**
   * Move a stack to the removed directory
   * @param {string} stackName - Stack name
   * @returns {Promise<void>}
   */
  async _moveStackToRemoved(stackName) {
    try {
      const stackPath = this._getStackPath(stackName);
      const removedBasePath = this._getRemovedBasePath();
      const removedPath = path.join(removedBasePath, stackName);

      // Create removed directory if it doesn't exist
      await fs.mkdir(removedBasePath, { recursive: true });

      // Check if stack exists
      try {
        await fs.access(stackPath);
      } catch (err) {
        // Stack doesn't exist, nothing to move
        return;
      }

      // If target already exists in removed, delete it first
      try {
        await fs.access(removedPath);
        await fs.rm(removedPath, { recursive: true, force: true });
      } catch (err) {
        // Removed path doesn't exist, that's fine
      }

      // Move stack to removed directory
      await fs.rename(stackPath, removedPath);
    } catch (error) {
      console.warn(`Failed to move stack to removed: ${error.message}`);
    }
  }

  /**
   * Validate stack name
   * @param {string} name - Stack name to validate
   * @throws {Error} If name is invalid
   */
  _validateStackName(name) {
    if (!name || typeof name !== 'string') {
      throw new Error('Stack name is required and must be a string');
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error('Stack name can only contain alphanumeric characters, hyphens and underscores');
    }

    if (name.length < 2 || name.length > 64) {
      throw new Error('Stack name must be between 2 and 64 characters');
    }
  }

  /**
   * Extract icon URL from mos.override.yaml comment
   * @param {string} content - YAML content
   * @returns {string|null} Icon URL or null
   */
  _extractIconUrl(content) {
    const match = content.match(/^#\s*icon_url:\s*(.+)$/m);
    return match ? match[1].trim() : null;
  }

  /**
   * Get service names from compose file using docker compose CLI
   * @param {string} stackPath - Path to stack directory
   * @returns {Promise<Array<string>>} Array of service names
   */
  async _getComposeServices(stackPath) {
    try {
      const { stdout } = await execPromise('docker-compose config --services', {
        cwd: stackPath
      });
      return stdout.trim().split('\n').filter(s => s);
    } catch (error) {
      throw new Error(`Failed to get compose services: ${error.message}`);
    }
  }

  /**
   * Generate mos.override.yaml with labels and icon metadata
   * @param {Array<string>} services - Service names
   * @param {string} stackName - Stack name
   * @param {string|null} iconUrl - Icon URL
   * @returns {string} YAML content
   */
  _generateMosOverride(services, stackName, iconUrl = null, noAutoupdate = false) {
    let yaml = '# MOS Metadata - Do not edit manually\n';
    if (iconUrl) {
      yaml += `# icon_url: ${iconUrl}\n`;
    }
    yaml += '\nservices:\n';

    services.forEach(service => {
      yaml += `  ${service}:\n`;
      yaml += `    labels:\n`;
      yaml += `      mos.backend: "compose"\n`;
      yaml += `      mos.stack.name: "${stackName}"\n`;
      if (noAutoupdate) {
        yaml += `      mos.no_autoupdate: "true"\n`;
      }
    });

    return yaml;
  }

  /**
   * Download and save icon (PNG only)
   * @param {string} iconUrl - Icon URL
   * @param {string} stackName - Stack name
   * @returns {Promise<string|null>} Path to saved icon or null
   */
  async _downloadIcon(iconUrl, stackName) {
    if (!iconUrl) return null;

    const iconDir = '/var/lib/docker/mos/icons/compose';
    const iconPath = path.join(iconDir, `${stackName}.png`);

    try {
      // Download icon
      const response = await axios.get(iconUrl, {
        responseType: 'arraybuffer',
        headers: { 'Accept': 'image/png' },
        timeout: 10000
      });

      // Validate Content-Type
      const contentType = response.headers['content-type'];
      if (!contentType || !contentType.includes('image/png')) {
        throw new Error('Icon must be a PNG image');
      }

      // Save icon
      await fs.mkdir(iconDir, { recursive: true });
      await fs.writeFile(iconPath, response.data);

      return iconPath;
    } catch (error) {
      // Icon download failure is not critical
      // If download failed, check if old icon exists and keep it
      try {
        await fs.access(iconPath);
        return iconPath;
      } catch (accessError) {
        // No existing icon either
        return null;
      }
    }
  }

  /**
   * Get set of running container names from Docker
   * @returns {Promise<Set<string>>} Set of running container names
   */
  async _getRunningContainers() {
    try {
      const { stdout } = await execPromise('docker ps --format "{{.Names}}" --filter "status=running"');
      const runningNames = stdout.trim().split('\n').filter(name => name.length > 0);
      return new Set(runningNames);
    } catch (error) {
      return new Set();
    }
  }

  /**
   * Check if a stack is running based on its containers
   * @param {Array<string>} containers - Container names for the stack
   * @param {Set<string>} runningContainers - Set of currently running container names
   * @returns {boolean} true if all containers are running, false otherwise
   */
  _isStackRunning(containers, runningContainers) {
    if (!containers || containers.length === 0) return false;
    return containers.every(name => runningContainers.has(name));
  }

  /**
   * Get actual container names after stack deployment (including stopped containers)
   * @param {string} stackName - Stack name
   * @returns {Promise<Array<string>>} Array of container names
   */
  async _getStackContainers(stackName) {
    try {
      const workingPath = await this._getWorkingPath(stackName);

      // Check if working directory exists, if not try to get containers by label
      try {
        await fs.access(workingPath);
      } catch (err) {
        // Working directory doesn't exist, try using Docker labels as fallback
        try {
          const { stdout } = await execPromise(`docker ps -a --filter "label=mos.stack.name=${stackName}" --format "{{.Names}}"`);
          const containerNames = stdout.trim().split('\n').filter(s => s);
          return containerNames;
        } catch (labelError) {
          console.warn(`Failed to get stack containers by label: ${labelError.message}`);
          return [];
        }
      }

      // Use -a to get ALL containers (running AND stopped)
      const { stdout } = await execPromise("docker-compose ps -aq", {
        cwd: workingPath
      });

      const containerIds = stdout.trim().split('\n').filter(s => s);

      if (containerIds.length === 0) {
        return [];
      }

      // Get container names from IDs
      const containerNames = [];
      for (const id of containerIds) {
        try {
          const { stdout: nameStdout } = await execPromise(`docker inspect --format='{{.Name}}' ${id}`);
          const name = nameStdout.trim().replace(/^\//, ''); // Remove leading slash
          if (name) {
            containerNames.push(name);
          }
        } catch (err) {
          console.warn(`Failed to get name for container ${id}: ${err.message}`);
        }
      }

      return containerNames;
    } catch (error) {
      // If stack not running, return empty array
      console.warn(`Failed to get stack containers: ${error.message}`);
      return [];
    }
  }

  /**
   * Get path to compose-containers file
   * @returns {string} Path to compose-containers file
   */
  _getComposeContainersPath() {
    return '/var/lib/docker/mos/compose-containers';
  }

  /**
   * Read compose-containers file
   * @returns {Promise<Array>} Compose containers data as array
   */
  async _readComposeContainers() {
    try {
      const filePath = this._getComposeContainersPath();
      const data = await fs.readFile(filePath, 'utf8');
      const parsed = data.trim() ? JSON.parse(data) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error.code === 'ENOENT') {
        return []; // File doesn't exist, return empty array
      }
      throw new Error(`Failed to read compose-containers: ${error.message}`);
    }
  }

  /**
   * Write compose-containers file
   * @param {Object} data - Compose containers data
   * @returns {Promise<void>}
   */
  async _writeComposeContainers(data) {
    try {
      const filePath = this._getComposeContainersPath();
      const dir = path.dirname(filePath);

      // Ensure directory exists
      await fs.mkdir(dir, { recursive: true });

      // Atomic write (tmp + rename)
      const tmpPath = `${filePath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
      await fs.rename(tmpPath, filePath);
    } catch (error) {
      throw new Error(`Failed to write compose-containers: ${error.message}`);
    }
  }

  /**
   * Get detailed container info for a stack (container name, image, local sha)
   * @param {string} stackName - Stack name
   * @returns {Promise<Object>} Object with service details
   */
  async _getStackContainerDetails(stackName) {
    try {
      const containerNames = await this._getStackContainers(stackName);
      const services = {};

      for (const containerName of containerNames) {
        try {
          // Get image name from container
          const { stdout: imageStdout } = await execPromise(
            `docker inspect --format='{{.Config.Image}}' ${containerName}`
          );
          const image = imageStdout.trim();

          // Get local SHA from installed image
          let localSha = null;
          try {
            const { stdout: shaStdout } = await execPromise(
              `docker image inspect "${image}" --format '{{index .RepoDigests 0}}' | cut -d '@' -f2-`
            );
            localSha = shaStdout.trim() || null;
          } catch (shaErr) {
            console.warn(`Failed to get local SHA for image ${image}: ${shaErr.message}`);
          }

          // Extract service name from container name
          // Format is usually: compose_stackname-servicename-1 (from working dir)
          // or stackname-servicename-1 or stackname_servicename_1
          let serviceName = containerName;
          const prefixes = [
            `compose_${stackName}-`,
            `compose_${stackName}_`,
            `${stackName}-`,
            `${stackName}_`
          ];
          for (const prefix of prefixes) {
            if (containerName.startsWith(prefix)) {
              serviceName = containerName.slice(prefix.length);
              // Remove trailing -1, _1, -2, etc.
              serviceName = serviceName.replace(/[-_]\d+$/, '');
              break;
            }
          }

          services[serviceName] = {
            container: containerName,
            repo: image,
            local: localSha,
            remote: localSha // Same as local on create (image was just pulled)
          };
        } catch (err) {
          console.warn(`Failed to get details for container ${containerName}: ${err.message}`);
        }
      }

      return services;
    } catch (error) {
      throw new Error(`Failed to get stack container details: ${error.message}`);
    }
  }

  /**
   * Update or add a stack in compose-containers file
   * @param {string} stackName - Stack name
   * @param {boolean|null} autostart - Autostart setting (null to preserve existing)
   * @param {string|null} webui - WebUI URL (null to preserve existing)
   * @returns {Promise<void>}
   */
  async _updateStackInComposeContainers(stackName, autostart = null, webui = null, noAutoupdate = null) {
    try {
      const composeContainers = await this._readComposeContainers();
      const services = await this._getStackContainerDetails(stackName);

      // Find existing stack entry
      const existingIndex = composeContainers.findIndex(s => s.stack === stackName);

      // Preserve existing remote SHAs, autostart, webui and no_autoupdate if available
      let existingAutostart = false; // Default to false
      let existingWebui = null; // Default to null
      let existingNoAutoupdate = false; // Default to false
      if (existingIndex !== -1) {
        if (composeContainers[existingIndex].services) {
          const existingServices = composeContainers[existingIndex].services;
          for (const [serviceName, serviceData] of Object.entries(services)) {
            if (existingServices[serviceName] && existingServices[serviceName].remote) {
              serviceData.remote = existingServices[serviceName].remote;
            }
          }
        }
        // Preserve existing autostart if not explicitly set
        if (composeContainers[existingIndex].autostart !== undefined) {
          existingAutostart = composeContainers[existingIndex].autostart;
        }
        // Preserve existing webui if not explicitly set
        if (composeContainers[existingIndex].webui !== undefined) {
          existingWebui = composeContainers[existingIndex].webui;
        }
        // Preserve existing no_autoupdate if not explicitly set
        if (composeContainers[existingIndex].no_autoupdate !== undefined) {
          existingNoAutoupdate = composeContainers[existingIndex].no_autoupdate;
        }
      }

      const normalizedWebui = this._normalizeWebui(webui);

      const stackEntry = {
        stack: stackName,
        autostart: autostart !== null ? autostart : existingAutostart,
        webui: normalizedWebui !== null ? normalizedWebui : existingWebui,
        no_autoupdate: noAutoupdate !== null ? noAutoupdate === true : existingNoAutoupdate === true,
        services: services
      };

      if (existingIndex !== -1) {
        composeContainers[existingIndex] = stackEntry;
      } else {
        composeContainers.push(stackEntry);
      }

      await this._writeComposeContainers(composeContainers);
    } catch (error) {
      console.warn(`Failed to update compose-containers for stack ${stackName}: ${error.message}`);
      // Don't throw - this is not critical for stack operation
    }
  }

  /**
   * Sync local SHAs to remote SHAs after successful upgrade
   * This simply copies the remote SHA value to local for each service
   * @param {string} stackName - Stack name
   * @returns {Promise<void>}
   */
  async _syncLocalShasAfterUpgrade(stackName, forceUpdate = false) {
    try {
      const composeContainers = await this._readComposeContainers();
      const existingIndex = composeContainers.findIndex(s => s.stack === stackName);

      if (existingIndex === -1) {
        console.warn(`Stack ${stackName} not found in compose-containers`);
        return;
      }

      // Skip sync if no_autoupdate is enabled (unless force update)
      if (composeContainers[existingIndex].no_autoupdate === true && !forceUpdate) {
        return;
      }

      // Get actual current SHAs from running containers
      // After upgrade, local and remote are the same (we just pulled latest)
      const services = await this._getStackContainerDetails(stackName);
      composeContainers[existingIndex].services = services;

      await this._writeComposeContainers(composeContainers);
    } catch (error) {
      console.warn(`Failed to sync SHAs for stack ${stackName}: ${error.message}`);
    }
  }

  /**
   * Remove a stack from compose-containers file
   * @param {string} stackName - Stack name
   * @returns {Promise<void>}
   */
  async _removeStackFromComposeContainers(stackName) {
    try {
      const composeContainers = await this._readComposeContainers();
      const index = composeContainers.findIndex(s => s.stack === stackName);

      if (index !== -1) {
        composeContainers.splice(index, 1);
        await this._writeComposeContainers(composeContainers);
      }
    } catch (error) {
      console.warn(`Failed to remove stack ${stackName} from compose-containers: ${error.message}`);
      // Don't throw - this is not critical for stack deletion
    }
  }

  /**
   * Pull images for a compose stack (without starting)
   * @param {string} stackName - Stack name
   * @returns {Promise<Object>} Object with stdout and stderr
   */
  async _pullStackImages(stackName) {
    try {
      const workingPath = await this._getWorkingPath(stackName);
      const { stdout, stderr } = await execComposeWithAuth('docker-compose -f compose.yaml -f mos.override.yaml pull', {
        cwd: workingPath
      });
      return { stdout: stdout || '', stderr: stderr || '' };
    } catch (error) {
      throw new Error(`Failed to pull images: ${error.message}${error.stderr ? '\n' + error.stderr : ''}`);
    }
  }

  /**
   * Deploy a compose stack (start containers, assumes images are already pulled)
   * @param {string} stackName - Stack name
   * @returns {Promise<Object>} Object with stdout and stderr
   */
  async _deployStack(stackName) {
    try {
      const workingPath = await this._getWorkingPath(stackName);
      const { stdout, stderr } = await execComposeWithAuth('docker-compose -f compose.yaml -f mos.override.yaml up -d', {
        cwd: workingPath
      });
      return { stdout: stdout || '', stderr: stderr || '' };
    } catch (error) {
      // Include output even on error
      throw new Error(`Failed to deploy stack: ${error.message}${error.stderr ? '\n' + error.stderr : ''}`);
    }
  }

  /**
   * Stop all containers in a compose stack (without removing them)
   * @param {string} stackName - Stack name
   * @returns {Promise<void>}
   */
  async _stopStack(stackName) {
    try {
      const workingPath = await this._getWorkingPath(stackName);
      await execPromise('docker-compose -f compose.yaml -f mos.override.yaml stop', {
        cwd: workingPath
      });
    } catch (error) {
      console.warn(`Warning during stack stop: ${error.message}`);
      // Don't throw - stopping is best-effort after a failed deploy
    }
  }

  /**
   * Stop and remove a compose stack
   * @param {string} stackName - Stack name
   * @param {boolean} removeImages - Whether to remove images (default: true)
   * @returns {Promise<Object>} Object with stdout and stderr
   */
  async _removeStack(stackName, removeImages = true) {
    try {
      const workingPath = await this._getWorkingPath(stackName);

      // Check if working directory exists
      let workingDirExists = false;
      try {
        await fs.access(workingPath);
        workingDirExists = true;
      } catch (err) {
        console.warn(`Working directory not found for stack '${stackName}', will recreate it`);
      }

      // If working directory doesn't exist, copy it from boot first
      // This way we can use docker-compose down properly
      if (!workingDirExists) {
        try {
          await this._copyStackToWorking(stackName);
          console.log(`Recreated working directory for stack '${stackName}'`);
        } catch (copyError) {
          console.warn(`Failed to recreate working directory: ${copyError.message}`);
          // If we can't copy, there's nothing to remove
          return { stdout: '', stderr: '' };
        }
      }

      // Now use docker-compose down - it handles everything correctly
      // --rmi all removes all images used by this stack
      // -v removes named volumes declared in the `volumes` section
      const rmiFlag = removeImages ? ' --rmi all' : '';
      const { stdout, stderr } = await execPromise(`docker-compose -f compose.yaml -f mos.override.yaml down${rmiFlag} -v`, {
        cwd: workingPath
      });

      return { stdout: stdout || '', stderr: stderr || '' };
    } catch (error) {
      // Don't throw if stack is already down
      console.warn(`Warning during stack removal: ${error.message}`);
      return { stdout: '', stderr: error.message || '' };
    }
  }

  /**
   * Create a new compose stack
   * @param {string} name - Stack name
   * @param {string} yamlContent - compose.yaml content
   * @param {string|null} envContent - .env content (optional)
   * @param {string|null} iconUrl - Icon URL (optional, PNG only)
   * @param {boolean} autostart - Autostart setting (default: false)
   * @param {string|null} webui - WebUI URL (optional)
   * @param {boolean} noAutoupdate - No auto-update setting (default: false)
   * @returns {Promise<Object>} Created stack info
   */
  async createStack(name, yamlContent, envContent = null, iconUrl = null, autostart = false, webui = null, noAutoupdate = false) {
    try {
      // Validate stack name
      this._validateStackName(name);

      // Validate YAML content
      if (!yamlContent || typeof yamlContent !== 'string') {
        throw new Error('compose.yaml content is required');
      }

      // Check if stack already exists (directory + group = real active stack)
      const stackPath = this._getStackPath(name);
      let stackDirExists = false;
      try {
        await fs.access(stackPath);
        stackDirExists = true;
      } catch (err) {
        if (err.code !== 'ENOENT') {
          throw err;
        }
      }

      if (stackDirExists) {
        // Directory exists - check if a compose group also exists
        const groups = await dockerService.getContainerGroups();
        const existingGroup = groups.find(g => g.name === name && g.compose === true);

        if (existingGroup) {
          // Both directory and group exist = real active stack, reject
          throw new Error(`Stack '${name}' already exists`);
        }
        // Directory exists but no group = orphaned files, safe to overwrite
      }

      // If a removed stack with the same name exists, delete it permanently
      const removedBasePath = this._getRemovedBasePath();
      const removedStackPath = path.join(removedBasePath, name);
      try {
        await fs.access(removedStackPath);
        await fs.rm(removedStackPath, { recursive: true, force: true });
      } catch (err) {
        // Removed stack doesn't exist, that's fine
      }

      // Step 1-2: Create stack directory in boot and save files (mkdir is safe even if exists)
      await fs.mkdir(stackPath, { recursive: true });

      // Save compose.yaml
      const composePath = path.join(stackPath, 'compose.yaml');
      await fs.writeFile(composePath, yamlContent);

      // Save .env if provided
      if (envContent) {
        const envPath = path.join(stackPath, '.env');
        await fs.writeFile(envPath, envContent);
      }

      // Get service names (from boot path)
      const services = await this._getComposeServices(stackPath);

      if (!services || services.length === 0) {
        throw new Error('No services found in compose.yaml');
      }

      // Generate mos.override.yaml
      const mosOverride = this._generateMosOverride(services, name, iconUrl, noAutoupdate);
      const mosOverridePath = path.join(stackPath, 'mos.override.yaml');
      await fs.writeFile(mosOverridePath, mosOverride);

      // Download icon (non-critical)
      let iconPath = null;
      if (iconUrl) {
        iconPath = await this._downloadIcon(iconUrl, name);
      }

      // Step 3-4: Copy files from boot to working directory (compose_STACKNAME)
      await this._copyStackToWorking(name);

      // Create Docker group BEFORE deployment so it exists even if deployment fails
      // Icon field is only the stack name (not full path), or null if no icon
      await dockerService.createContainerGroup(name, [], {
        compose: true,
        icon: iconPath ? name : null
      });

      // Step 5: Pull images first (if this fails, clean up everything)
      try {
        await this._pullStackImages(name);
      } catch (pullError) {
        // Pull failed - no images, clean up group and files
        try {
          const groups = await dockerService.getContainerGroups();
          const group = groups.find(g => g.name === name && g.compose === true);
          if (group) await dockerService.deleteContainerGroup(group.id);
        } catch (groupError) { /* ignore */ }

        // Remove stack files
        try {
          await fs.rm(stackPath, { recursive: true, force: true });
        } catch (cleanupError) { /* ignore */ }

        throw new Error(`Could not pull images: ${pullError.message}`);
      }

      // Step 6: Try to start containers (images are pulled, so containers can be created)
      let containerNames = [];
      let deploymentError = null;
      let stdout = '';
      let stderr = '';

      try {
        const output = await this._deployStack(name);
        stdout = output.stdout;
        stderr = output.stderr;
      } catch (deployError) {
        deploymentError = deployError;

        // Stop all containers to ensure a clean stopped state
        await this._stopStack(name);
      }

      // Get containers REGARDLESS of deployment success (containers might be created but stopped)
      containerNames = await this._getStackContainers(name);

      // Update group with actual containers (even if deployment failed)
      const groups = await dockerService.getContainerGroups();
      const group = groups.find(g => g.name === name && g.compose === true);
      if (group) {
        await dockerService.updateGroup(group.id, {
          containers: containerNames
        });
      }

      // Update compose-containers file (even with 0 containers, so the stack entry exists)
      await this._updateStackInComposeContainers(name, autostart, webui, noAutoupdate);

      // Return result (even if deployment failed, files and group were created)
      const result = {
        success: !deploymentError,
        stack: name,
        services: services,
        containers: containerNames,
        iconPath: iconPath,
        autostart: autostart,
        webui: webui,
        no_autoupdate: noAutoupdate === true,
        output: stdout || stderr || ''
      };

      if (deploymentError) {
        result.warning = `Stack created but deployment failed: ${deploymentError.message}. Use PUT to fix and redeploy.`;
      }

      return result;
    } catch (error) {
      // Only move to removed if we failed BEFORE creating files
      // If files were created, keep them so user can fix with PUT
      const stackPath = this._getStackPath(name);
      try {
        await fs.access(stackPath);
        // Files exist, don't move them - just delete the group if it was created
        try {
          const groups = await dockerService.getContainerGroups();
          const group = groups.find(g => g.name === name && g.compose === true);
          if (group) {
            await dockerService.deleteContainerGroup(group.id);
          }
        } catch (groupError) {
          // Ignore
        }
      } catch (accessError) {
        // Files don't exist, nothing to clean up
      }

      throw new Error(`Failed to create stack: ${error.message}`);
    }
  }

  /**
   * Get all compose stacks
   * @returns {Promise<Array>} Array of stack objects
   */
  async getStacks() {
    try {
      const basePath = this._getBasePath();

      // Ensure base directory exists
      try {
        await fs.access(basePath);
      } catch (err) {
        if (err.code === 'ENOENT') {
          return [];
        }
        throw err;
      }

      // Read compose-containers for autostart info
      const composeContainers = await this._readComposeContainers();

      // Read all stack directories from boot
      const entries = await fs.readdir(basePath, { withFileTypes: true });
      const stacks = [];

      // Get running containers ONCE for all stacks (same approach as groups)
      const runningContainers = await this._getRunningContainers();

      for (const entry of entries) {
        if (entry.isDirectory()) {
          try {
            const stackPath = path.join(basePath, entry.name);
            const composePath = path.join(stackPath, 'compose.yaml');
            const mosOverridePath = path.join(stackPath, 'mos.override.yaml');

            // Check if compose.yaml exists
            try {
              await fs.access(composePath);
            } catch (err) {
              continue; // Skip if no compose.yaml
            }

            // Get services from boot path (tolerate broken YAML: return empty list)
            let services = [];
            try {
              services = await this._getComposeServices(stackPath);
            } catch (err) {
              // Invalid compose.yaml - still list the stack so it can be fixed
            }

            // Get containers from working directory
            const containers = await this._getStackContainers(entry.name);

            // Get icon URL from mos.override.yaml
            let iconUrl = null;
            try {
              const mosOverrideContent = await fs.readFile(mosOverridePath, 'utf8');
              iconUrl = this._extractIconUrl(mosOverrideContent);
            } catch (err) {
              // No mos.override.yaml, that's ok
            }

            // Get autostart, webui and no_autoupdate from compose-containers
            const stackEntry = composeContainers.find(s => s.stack === entry.name);
            const autostart = stackEntry ? (stackEntry.autostart || false) : false;
            const webui = stackEntry ? (stackEntry.webui || null) : null;
            const noAutoupdate = stackEntry ? (stackEntry.no_autoupdate === true) : false;

            // Running = all containers in the stack are running
            const running = this._isStackRunning(containers, runningContainers);

            stacks.push({
              name: entry.name,
              services: services,
              containers: containers,
              iconUrl: iconUrl,
              autostart: autostart,
              webui: webui,
              no_autoupdate: noAutoupdate,
              running: running
            });
          } catch (err) {
            console.warn(`Failed to read stack '${entry.name}': ${err.message}`);
          }
        }
      }

      return stacks;
    } catch (error) {
      throw new Error(`Failed to get stacks: ${error.message}`);
    }
  }

  /**
   * Get a specific stack
   * @param {string} name - Stack name
   * @returns {Promise<Object>} Stack object
   */
  async getStack(name) {
    try {
      this._validateStackName(name);

      const stackPath = this._getStackPath(name);
      const composePath = path.join(stackPath, 'compose.yaml');
      const mosOverridePath = path.join(stackPath, 'mos.override.yaml');
      const envPath = path.join(stackPath, '.env');

      // Check if stack exists in boot
      try {
        await fs.access(composePath);
      } catch (err) {
        throw new Error(`Stack '${name}' not found`);
      }

      // Read compose.yaml from boot
      const composeContent = await fs.readFile(composePath, 'utf8');

      // Read .env from boot if exists
      let envContent = null;
      try {
        envContent = await fs.readFile(envPath, 'utf8');
      } catch (err) {
        // No .env file, that's ok
      }

      // Get icon URL from mos.override.yaml
      let iconUrl = null;
      try {
        const mosOverrideContent = await fs.readFile(mosOverridePath, 'utf8');
        iconUrl = this._extractIconUrl(mosOverrideContent);
      } catch (err) {
        // No mos.override.yaml
      }

      // Get services from boot path (tolerate broken YAML: return empty list so
      // the raw yaml is still returned and can be fixed by the user)
      let services = [];
      try {
        services = await this._getComposeServices(stackPath);
      } catch (err) {
        // Invalid compose.yaml - keep returning the raw content below
      }

      // Get containers from working directory
      const containers = await this._getStackContainers(name);

      // Get autostart, webui and no_autoupdate from compose-containers
      const composeContainers = await this._readComposeContainers();
      const stackEntry = composeContainers.find(s => s.stack === name);
      const autostart = stackEntry ? (stackEntry.autostart || false) : false;
      const webui = stackEntry ? (stackEntry.webui || null) : null;
      const noAutoupdate = stackEntry ? (stackEntry.no_autoupdate === true) : false;

      // Running = all containers in the stack are running
      const runningContainers = await this._getRunningContainers();
      const running = this._isStackRunning(containers, runningContainers);

      return {
        name: name,
        yaml: composeContent,
        env: envContent,
        services: services,
        containers: containers,
        iconUrl: iconUrl,
        autostart: autostart,
        webui: webui,
        no_autoupdate: noAutoupdate,
        running: running
      };
    } catch (error) {
      throw new Error(`Failed to get stack: ${error.message}`);
    }
  }

  /**
   * Update a compose stack
   * @param {string} name - Stack name
   * @param {string} yamlContent - New compose.yaml content
   * @param {string|null} envContent - New .env content (optional)
   * @param {string|null} iconUrl - New icon URL (optional, PNG only)
   * @param {boolean|null} autostart - Autostart setting (null to preserve existing)
   * @param {string|null|undefined} webui - WebUI URL (null to clear, undefined to preserve existing)
   * @param {boolean|null} noAutoupdate - No auto-update setting (null to preserve existing)
   * @returns {Promise<Object>} Updated stack info
   */
  async updateStack(name, yamlContent, envContent = null, iconUrl = null, autostart = null, webui = undefined, noAutoupdate = null) {
    try {
      this._validateStackName(name);

      const stackPath = this._getStackPath(name);
      const composePath = path.join(stackPath, 'compose.yaml');

      // Check if stack exists
      try {
        await fs.access(composePath);
      } catch (err) {
        throw new Error(`Stack '${name}' not found`);
      }

      // Validate YAML content
      if (!yamlContent || typeof yamlContent !== 'string') {
        throw new Error('compose.yaml content is required');
      }

      // Stop current stack (from working directory), keep images
      const removeOutput = await this._removeStack(name, false);

      // Step 1-2: Update files in boot directory
      await fs.writeFile(composePath, yamlContent);

      // Update .env
      const envPath = path.join(stackPath, '.env');
      if (envContent) {
        await fs.writeFile(envPath, envContent);
      } else {
        // Remove .env if not provided
        try {
          await fs.unlink(envPath);
        } catch (err) {
          // File doesn't exist, that's ok
        }
      }

      // Get new service names (from boot path)
      const services = await this._getComposeServices(stackPath);

      if (!services || services.length === 0) {
        throw new Error('No services found in compose.yaml');
      }

      // Regenerate mos.override.yaml (read no_autoupdate from compose-containers to preserve it)
      let existingNoAutoupdate = false;
      try {
        const cc = await this._readComposeContainers();
        const ccEntry = cc.find(s => s.stack === name);
        if (ccEntry) {
          existingNoAutoupdate = ccEntry.no_autoupdate === true;
        }
      } catch (err) {
        // Default to false
      }
      const effectiveNoAutoupdate = noAutoupdate !== null ? noAutoupdate === true : existingNoAutoupdate;
      const mosOverride = this._generateMosOverride(services, name, iconUrl, effectiveNoAutoupdate);
      const mosOverridePath = path.join(stackPath, 'mos.override.yaml');
      await fs.writeFile(mosOverridePath, mosOverride);

      // Update icon if URL provided
      let iconPath = null;
      if (iconUrl) {
        iconPath = await this._downloadIcon(iconUrl, name);
      }

      // Step 3-4: Copy updated files from boot to working directory
      await this._copyStackToWorking(name);

      // Step 5: Pull images first
      await this._pullStackImages(name);

      // Step 6: Try to start containers (images are pulled, so containers can be created)
      let deploymentError = null;
      let output = { stdout: '', stderr: '' };

      try {
        output = await this._deployStack(name);
      } catch (deployError) {
        deploymentError = deployError;

        // Stop all containers to ensure a clean stopped state
        await this._stopStack(name);
      }

      // Get new container names REGARDLESS of deployment success (containers might be created but stopped)
      const containerNames = await this._getStackContainers(name);

      // Update Docker group (even if deployment failed)
      const groups = await dockerService.getContainerGroups();
      const existingGroup = groups.find(g => g.name === name && g.compose === true);

      if (existingGroup) {
        await dockerService.updateGroup(existingGroup.id, {
          containers: containerNames,
          icon: iconPath ? name : existingGroup.icon
        });
      }

      // Update compose-containers file (even with 0 containers, so the stack entry exists)
      // webui: undefined = preserve, null = clear, string = set
      const webuiValue = webui === undefined ? null : webui;
      await this._updateStackInComposeContainers(name, autostart, webuiValue, noAutoupdate);

      // Get current values for response
      const composeContainers = await this._readComposeContainers();
      const stackEntry = composeContainers.find(s => s.stack === name);
      const currentAutostart = stackEntry ? stackEntry.autostart : false;
      const currentWebui = stackEntry ? stackEntry.webui : null;
      const currentNoAutoupdate = stackEntry ? (stackEntry.no_autoupdate === true) : false;

      // Combine output from down and up operations
      let combinedOutput = '';
      if (removeOutput.stdout || removeOutput.stderr) {
        combinedOutput += '=== Stopping stack ===\n' + (removeOutput.stdout || removeOutput.stderr) + '\n\n';
      }
      if (output.stdout || output.stderr) {
        combinedOutput += '=== Starting stack ===\n' + (output.stdout || output.stderr);
      }

      const result = {
        success: !deploymentError,
        stack: name,
        services: services,
        containers: containerNames,
        iconPath: iconPath,
        autostart: currentAutostart,
        webui: currentWebui,
        no_autoupdate: currentNoAutoupdate,
        output: combinedOutput || ''
      };

      if (deploymentError) {
        result.warning = `Stack updated but deployment failed: ${deploymentError.message}. Fix the issue and update again.`;
      }

      return result;
    } catch (error) {
      throw new Error(`Failed to update stack: ${error.message}`);
    }
  }

  /**
   * Update stack settings without redeploying
   * @param {string} name - Stack name
   * @param {Object} settings - Settings to update
   * @param {boolean} [settings.autostart] - Autostart setting
   * @param {string|null} [settings.webui] - WebUI URL (null to clear)
   * @param {boolean} [settings.no_autoupdate] - No auto-update setting
   * @returns {Promise<Object>} Updated settings
   */
  async updateStackSettings(name, settings) {
    try {
      this._validateStackName(name);

      const stackPath = this._getStackPath(name);
      const composePath = path.join(stackPath, 'compose.yaml');

      // Check if stack exists
      try {
        await fs.access(composePath);
      } catch (err) {
        throw new Error(`Stack '${name}' not found`);
      }

      // Read current compose-containers
      const composeContainers = await this._readComposeContainers();
      const existingIndex = composeContainers.findIndex(s => s.stack === name);

      if (existingIndex === -1) {
        // Stack exists in boot but not in compose-containers, create entry
        const webuiValue = this._normalizeWebui(settings.webui);
        const stackEntry = {
          stack: name,
          autostart: settings.autostart !== undefined ? settings.autostart : false,
          webui: webuiValue !== undefined ? webuiValue : null,
          no_autoupdate: settings.no_autoupdate !== undefined ? settings.no_autoupdate === true : false,
          services: {}
        };
        composeContainers.push(stackEntry);
      } else {
        // Update existing entry
        if (settings.autostart !== undefined) {
          composeContainers[existingIndex].autostart = settings.autostart;
        }
        if (settings.webui !== undefined) {
          composeContainers[existingIndex].webui = this._normalizeWebui(settings.webui);
        }
        if (settings.no_autoupdate !== undefined) {
          composeContainers[existingIndex].no_autoupdate = settings.no_autoupdate === true;
        }
      }

      await this._writeComposeContainers(composeContainers);

      // Get updated entry
      const updatedEntry = composeContainers.find(s => s.stack === name);

      return {
        success: true,
        stack: name,
        autostart: updatedEntry ? updatedEntry.autostart : false,
        webui: updatedEntry ? updatedEntry.webui : null,
        no_autoupdate: updatedEntry ? (updatedEntry.no_autoupdate === true) : false
      };
    } catch (error) {
      throw new Error(`Failed to update stack settings: ${error.message}`);
    }
  }

  /**
   * Delete a compose stack
   * @param {string} name - Stack name
   * @returns {Promise<Object>} Deletion result
   */
  async deleteStack(name) {
    try {
      this._validateStackName(name);

      const stackPath = this._getStackPath(name);
      const composePath = path.join(stackPath, 'compose.yaml');

      let stackExists = false;
      let warnings = [];
      let removeOutput = null;

      // Check if stack files exist
      try {
        await fs.access(composePath);
        stackExists = true;
      } catch (err) {
        warnings.push('Stack files not found in boot directory');
      }

      // Try to stop and remove stack (even if files are missing)
      if (stackExists) {
        try {
          removeOutput = await this._removeStack(name);
        } catch (err) {
          warnings.push(`Failed to stop stack via docker-compose: ${err.message}`);
        }

        // Move stack directory to removed instead of deleting
        try {
          await this._moveStackToRemoved(name);
        } catch (err) {
          warnings.push(`Failed to move stack to removed: ${err.message}`);
        }
      } else {
        // Stack files missing - only remove group, keep containers running
        warnings.push('Stack files missing - only removing group, containers will remain running as individual containers');
      }

      // Delete icon (always try, even if stack files are missing)
      try {
        const iconPath = `/var/lib/docker/mos/icons/compose/${name}.png`;
        await fs.unlink(iconPath);
      } catch (err) {
        // Icon doesn't exist, that's ok
      }

      // Delete Docker group
      const groups = await dockerService.getContainerGroups();
      const group = groups.find(g => g.name === name && g.compose === true);

      if (group) {
        await dockerService.deleteContainerGroup(group.id);
      } else {
        warnings.push('No Docker group found for this stack');
      }

      // Remove stack from compose-containers file
      await this._removeStackFromComposeContainers(name);

      const result = {
        success: true,
        message: `Stack '${name}' deleted successfully`,
        output: removeOutput ? (removeOutput.stdout || removeOutput.stderr || '') : ''
      };

      if (warnings.length > 0) {
        result.warnings = warnings;
      }

      return result;
    } catch (error) {
      throw new Error(`Failed to delete stack: ${error.message}`);
    }
  }

  /**
   * Start a compose stack
   * @param {string} name - Stack name
   * @returns {Promise<Object>} Start result
   */
  async startStack(name) {
    try {
      this._validateStackName(name);

      const stackPath = this._getStackPath(name);

      // Check if stack exists in boot
      try {
        await fs.access(path.join(stackPath, 'compose.yaml'));
      } catch (err) {
        throw new Error(`Stack '${name}' not found`);
      }

      // Get working path
      const workingPath = await this._getWorkingPath(name);

      // Check if working directory exists, if not recreate it
      try {
        await fs.access(workingPath);
      } catch (err) {
        // Working directory doesn't exist, copy from boot
        await this._copyStackToWorking(name);
      }

      // Start stack from working directory (up -d creates containers if they don't exist)
      const { stdout, stderr } = await execComposeWithAuth('docker-compose -f compose.yaml -f mos.override.yaml up -d', {
        cwd: workingPath
      });

      // Get containers
      const containers = await this._getStackContainers(name);

      return {
        success: true,
        stack: name,
        containers: containers,
        output: stdout || stderr || ''
      };
    } catch (error) {
      throw new Error(`Failed to start stack: ${error.message}`);
    }
  }

  /**
   * Stop a compose stack
   * @param {string} name - Stack name
   * @returns {Promise<Object>} Stop result
   */
  async stopStack(name) {
    try {
      this._validateStackName(name);

      const stackPath = this._getStackPath(name);

      // Check if stack exists in boot
      try {
        await fs.access(path.join(stackPath, 'compose.yaml'));
      } catch (err) {
        throw new Error(`Stack '${name}' not found`);
      }

      // Get working path
      const workingPath = await this._getWorkingPath(name);

      // Check if working directory exists, if not recreate it
      try {
        await fs.access(workingPath);
      } catch (err) {
        // Working directory doesn't exist, copy from boot
        await this._copyStackToWorking(name);
      }

      // Stop stack from working directory
      const { stdout, stderr } = await execCompose('docker-compose -f compose.yaml -f mos.override.yaml stop', {
        cwd: workingPath
      });

      return {
        success: true,
        stack: name,
        message: 'Stack stopped successfully',
        output: stdout || stderr || ''
      };
    } catch (error) {
      throw new Error(`Failed to stop stack: ${error.message}`);
    }
  }

  /**
   * Restart a compose stack
   * @param {string} name - Stack name
   * @returns {Promise<Object>} Restart result
   */
  async restartStack(name) {
    try {
      this._validateStackName(name);

      const stackPath = this._getStackPath(name);

      // Check if stack exists in boot
      try {
        await fs.access(path.join(stackPath, 'compose.yaml'));
      } catch (err) {
        throw new Error(`Stack '${name}' not found`);
      }

      // Get working path
      const workingPath = await this._getWorkingPath(name);

      // Check if working directory exists, if not recreate it
      try {
        await fs.access(workingPath);
      } catch (err) {
        // Working directory doesn't exist, copy from boot
        await this._copyStackToWorking(name);
      }

      // Restart stack: stop then up -d (handles missing containers)
      await execCompose('docker-compose -f compose.yaml -f mos.override.yaml stop', {
        cwd: workingPath
      });
      const { stdout, stderr } = await execComposeWithAuth('docker-compose -f compose.yaml -f mos.override.yaml up -d', {
        cwd: workingPath
      });

      // Get containers
      const containers = await this._getStackContainers(name);

      return {
        success: true,
        stack: name,
        containers: containers,
        output: stdout || stderr || ''
      };
    } catch (error) {
      throw new Error(`Failed to restart stack: ${error.message}`);
    }
  }

  /**
   * Pull images for a compose stack
   * @param {string} name - Stack name
   * @returns {Promise<Object>} Pull result
   */
  async pullStack(name) {
    try {
      this._validateStackName(name);

      const stackPath = this._getStackPath(name);

      // Check if stack exists in boot
      try {
        await fs.access(path.join(stackPath, 'compose.yaml'));
      } catch (err) {
        throw new Error(`Stack '${name}' not found`);
      }

      // Get working path
      const workingPath = await this._getWorkingPath(name);

      // Check if working directory exists, if not recreate it
      try {
        await fs.access(workingPath);
      } catch (err) {
        // Working directory doesn't exist, copy from boot
        await this._copyStackToWorking(name);
      }

      // Pull images from working directory (with auth if tokens available)
      const { stdout, stderr } = await execComposeWithAuth('docker-compose -f compose.yaml -f mos.override.yaml pull', {
        cwd: workingPath
      });

      return {
        success: true,
        stack: name,
        output: stdout || stderr
      };
    } catch (error) {
      throw new Error(`Failed to pull stack images: ${error.message}`);
    }
  }

  /**
   * Upgrade a compose stack to latest images
   * @param {string} name - Stack name
   * @param {boolean} forceUpdate - Force update even if no new version available
   * @returns {Promise<Object>} Upgrade result
   */
  async upgradeStack(name, forceUpdate = false) {
    try {
      this._validateStackName(name);

      const stackPath = this._getStackPath(name);

      // Check if stack exists
      try {
        await fs.access(path.join(stackPath, 'compose.yaml'));
      } catch (err) {
        throw new Error(`Stack '${name}' not found`);
      }

      // Build command: mos-update_containers NAME [force_update|""] compose
      const scriptPath = '/usr/local/bin/mos-update_containers';
      const forceArg = forceUpdate ? 'force_update' : '""';
      const command = `${scriptPath} ${name} ${forceArg} compose`;

      // Execute upgrade script
      const { stdout, stderr } = await execPromise(command);

      // Sync local SHAs to remote SHAs after successful upgrade
      await this._syncLocalShasAfterUpgrade(name, forceUpdate);

      // Try to parse the output as JSON
      try {
        const result = JSON.parse(stdout);
        if (stderr && stderr.trim() && result.message) {
          result.message += '\n' + stderr.trim();
        }
        return result;
      } catch (parseError) {
        let message = stdout.trim();
        if (stderr && stderr.trim()) {
          message += '\n' + stderr.trim();
        }
        return { success: true, stack: name, message };
      }
    } catch (error) {
      throw new Error(`Failed to upgrade stack: ${error.message}`);
    }
  }

  /**
   * Get all compose template names grouped by installed and removed
   * @returns {Promise<Object>} Object containing installed and removed template names
   */
  async getAllTemplates() {
    try {
      const basePath = this._getBasePath();
      const removedBasePath = this._getRemovedBasePath();

      // Get installed stack names
      let installed = [];
      try {
        const entries = await fs.readdir(basePath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const composePath = path.join(basePath, entry.name, 'compose.yaml');
            try {
              await fs.access(composePath);
              installed.push(entry.name);
            } catch (err) {
              // Skip directories without compose.yaml
            }
          }
        }
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }

      // Get removed stack names
      let removed = [];
      try {
        const entries = await fs.readdir(removedBasePath, { withFileTypes: true });
        removed = entries
          .filter(entry => entry.isDirectory())
          .map(entry => entry.name);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          // Directory doesn't exist, that's ok
        }
      }

      return {
        installed: installed.sort(),
        removed: removed.sort()
      };
    } catch (error) {
      throw new Error(`Failed to get all templates: ${error.message}`);
    }
  }

  /**
   * Get a specific compose template by name, preferring installed over removed
   * @param {string} name - Stack name
   * @param {boolean} edit - If false (default), appends '_new' to the name if it exists in installed
   * @returns {Promise<Object>} Template with yaml, env, icon
   */
  async getTemplate(name, edit = false) {
    try {
      this._validateStackName(name);

      // Try installed first
      const installedPath = path.join(this._getBasePath(), name);
      const removedPath = path.join(this._getRemovedBasePath(), name);

      let stackPath = null;
      let source = null;

      try {
        await fs.access(path.join(installedPath, 'compose.yaml'));
        stackPath = installedPath;
        source = 'installed';
      } catch (err) {
        // Not in installed, try removed
        try {
          await fs.access(removedPath);
          stackPath = removedPath;
          source = 'removed';
        } catch (err2) {
          throw new Error(`Template '${name}' not found in installed or removed stacks`);
        }
      }

      // Determine the returned name
      let templateName = name;
      if (!edit && source === 'installed') {
        // If not editing and stack is installed, append '_new' so user can create a copy
        templateName = name + '_new';
      }

      // Read compose.yaml
      let yaml = null;
      try {
        yaml = await fs.readFile(path.join(stackPath, 'compose.yaml'), 'utf8');
      } catch (err) {
        // File doesn't exist
      }

      // Read .env
      let envContent = null;
      try {
        envContent = await fs.readFile(path.join(stackPath, '.env'), 'utf8');
      } catch (err) {
        // File doesn't exist
      }

      // Read icon URL from mos.override.yaml
      let iconUrl = null;
      try {
        const mosOverride = await fs.readFile(path.join(stackPath, 'mos.override.yaml'), 'utf8');
        iconUrl = this._extractIconUrl(mosOverride);
      } catch (err) {
        // File doesn't exist
      }

      // Get autostart, webui and no_autoupdate from compose-containers (only for installed)
      let autostart = false;
      let webui = null;
      let noAutoupdate = false;
      if (source === 'installed') {
        const composeContainers = await this._readComposeContainers();
        const stackEntry = composeContainers.find(s => s.stack === name);
        autostart = stackEntry ? (stackEntry.autostart || false) : false;
        webui = stackEntry ? (stackEntry.webui || null) : null;
        noAutoupdate = stackEntry ? (stackEntry.no_autoupdate === true) : false;
      }

      return {
        name: templateName,
        yaml: yaml,
        env: envContent,
        iconUrl: iconUrl,
        autostart: autostart,
        webui: webui,
        no_autoupdate: noAutoupdate,
        source: source
      };
    } catch (error) {
      throw new Error(`Failed to get template: ${error.message}`);
    }
  }

}

module.exports = new DockerComposeService();
