const fs = require('fs').promises;
const { exec, execFile } = require('child_process');
const util = require('util');
const path = require('path');
const axios = require('axios');

// Promisify exec for easier use with async/await
const execPromise = util.promisify(exec);
// Promisify execFile to run binaries without shell interpolation (safer for user input)
const execFilePromise = util.promisify(execFile);

class DockerService {

  /**
   * Normalizes a shell value from a template into a valid absolute path
   * @param {string|undefined|null} shell - The shell value from the template
   * @returns {string} Normalized shell path
   */
  normalizeShell(shell) {
    if (!shell) {
      return '/bin/sh';
    }

    const trimmed = shell.trim();

    if (!trimmed) {
      return '/bin/sh';
    }

    if (trimmed === 'sh') {
      return '/bin/sh';
    }

    if (trimmed === 'bash') {
      return '/bin/bash';
    }

    if (trimmed.startsWith('/')) {
      return trimmed;
    }

    // Anything else that doesn't start with / and isn't sh or bash
    return '/bin/sh';
  }

  /**
   * Atomically writes JSON data to a file
   * @param {string} filePath - Target file path
   * @param {*} data - Data to serialize as JSON
   * @returns {Promise<void>}
   */
  async _writeJsonAtomic(filePath, data) {
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmpPath, filePath);
  }

  /**
   * Reads the Docker containers file and checks for available updates
   * @returns {Promise<Array>} Array of Docker images with update status
   */
  async getDockerImages() {
    try {
      // Path to containers.json
      const filePath = '/var/lib/docker/mos/containers';

      // Read file
      const data = await fs.readFile(filePath, 'utf8');
      let images = data.trim() ? JSON.parse(data) : [];
      if (!Array.isArray(images)) {
        images = [];
      }

      // Lazy cleanup: remove orphaned entries not present in Docker
      try {
        const { stdout } = await execPromise('docker ps -a --format "{{.Names}}"');
        const dockerContainers = new Set(
          stdout.trim().split('\n').filter(name => name.length > 0)
        );

        const originalLength = images.length;
        // Skip cleanup if Docker reports no containers at all
        if (dockerContainers.size > 0) {
          images = images.filter(image => dockerContainers.has(image.name));
        }

        if (images.length < originalLength) {
          // Reindex remaining entries
          images.sort((a, b) => (a.index || 0) - (b.index || 0));
          images.forEach((image, i) => { image.index = i + 1; });

          // Write cleaned file back
          await this._writeJsonAtomic(filePath, images);
        }
      } catch (dockerError) {
        // Docker daemon not available - skip cleanup
      }

      // Read templates to get shell info and no_autoupdate for each container
      const templatesDir = '/boot/config/system/docker/templates';
      const templateInfoMap = {};
      for (const image of images) {
        try {
          const templatePath = path.join(templatesDir, `${image.name}.json`);
          const templateData = await fs.readFile(templatePath, 'utf8');
          const template = JSON.parse(templateData);
          templateInfoMap[image.name] = {
            default_shell: this.normalizeShell(template.default_shell),
            no_autoupdate: template.no_autoupdate === true
          };
        } catch (templateError) {
          templateInfoMap[image.name] = { default_shell: '/bin/sh', no_autoupdate: false };
        }
      }

      // Process each image and add update status
      return images.map(image => {
        const updateAvailable = image.local !== image.remote;
        const info = templateInfoMap[image.name] || { default_shell: '/bin/sh', no_autoupdate: false };

        return {
          ...image,
          update_available: updateAvailable,
          default_shell: info.default_shell,
          no_autoupdate: info.no_autoupdate
        };
      });
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('containers file not found');
      }
      throw new Error(`Error reading containers: ${error.message}`);
    }
  }

  /**
   * Executes the Docker update script
   * @param {string} [name] - Optional name of the container to update
   * @returns {Promise<Object>} Result of the update check
   */
  async checkForUpdates(name = null) {
    try {
      // Path to update script
      const scriptPath = '/usr/local/bin/mos-check_for_docker_updates';

      // Command with or without parameter
      const command = name ? `${scriptPath} ${name}` : scriptPath;

      // Execute command
      // Note: stderr may contain warnings (e.g., swap limit), but exit code 0 means success
      const { stdout, stderr } = await execPromise(command);

      // Try to parse the output as JSON, if possible
      try {
        const result = JSON.parse(stdout);
        // Append stderr to message if present
        if (stderr && stderr.trim() && result.message) {
          result.message += '\n' + stderr.trim();
        }
        return result;
      } catch (parseError) {
        // If no JSON output, return text
        let message = stdout.trim();
        if (stderr && stderr.trim()) {
          message += '\n' + stderr.trim();
        }
        return { message };
      }
    } catch (error) {
      throw new Error(`Failed to check for updates: ${error.message}`);
    }
  }

  /**
   * Executes the Docker restart
   * @param {string} [name] - Name of the container to restart
   */
  async Restart(name) {
    try {
      // Check if name is not empty
      if (!name) {
        throw new Error('Name is required');
      }

      // Use Docker REST API to restart container
      await axios({
        method: 'POST',
        url: `http://localhost/containers/${name}/restart`,
        socketPath: '/var/run/docker.sock',
        validateStatus: () => true,
        timeout: 10000
      });

      const result = {
        success: true,
        message: 'Container restarted successfully'
      };

      return result;
    } catch (error) {
      let errorMessage = 'Failed to restart container';
      if (error.response && error.response.data) {
        if (typeof error.response.data === 'string') {
          errorMessage = error.response.data;
        } else if (error.response.data.message) {
          errorMessage = error.response.data.message;
        }
      } else if (error.message) {
        errorMessage = error.message;
      }
      throw new Error(errorMessage);
    }
  }

  /**
   * Upgrade Docker containers to their latest versions
   * @param {string|null} name - Container name (null for all containers)
   * @param {boolean} forceUpdate - Force update even if no new version available (default: false)
   * @returns {Promise<Object>} Result of the upgrade process
   */
  async Upgrade(name = null, forceUpdate = false) {
    try {

      // Path to update script
      const scriptPath = '/usr/local/bin/mos-update_containers';

      // Build command with parameters
      let command = scriptPath;
      if (name) {
        command += ` ${name}`;
      }
      if (forceUpdate) {
        command += ' force_update';
      }

      // Execute command
      // Note: stderr may contain warnings (e.g., kernel swap limit), but exit code 0 means success
      const { stdout, stderr } = await execPromise(command);

      // Try to parse the output as JSON, if possible
      try {
        const result = JSON.parse(stdout);
        // Append stderr to message if present
        if (stderr && stderr.trim() && result.message) {
          result.message += '\n' + stderr.trim();
        }
        return result;
      } catch (parseError) {
        // If no JSON output, return text
        let message = stdout.trim();
        if (stderr && stderr.trim()) {
          message += '\n' + stderr.trim();
        }
        return { message };
      }
    } catch (error) {
      throw new Error(`Failed to upgrade: ${error.message}`);
    }
  }

  /**
   * Updates container indices with new values
   * @param {Array} containers - Array of containers with name and new index
   * @returns {Promise<Array>} Updated container list
   */
  async updateContainerIndices(containers) {
    try {
      // Path to containers file
      const filePath = '/var/lib/docker/mos/containers';

      // Read current file
      const data = await fs.readFile(filePath, 'utf8');
      let currentContainers = data.trim() ? JSON.parse(data) : [];
      if (!Array.isArray(currentContainers)) {
        currentContainers = [];
      }

      // Create a map of names to new properties (index and wait)
      const updateMap = {};
      containers.forEach(container => {
        if (container.name) {
          updateMap[container.name] = {
            ...(container.index !== undefined && { index: container.index }),
            ...(container.autostart !== undefined && { autostart: container.autostart }),
            ...(container.wait !== undefined && { wait: container.wait }),
            ...(container.no_autoupdate !== undefined && { no_autoupdate: container.no_autoupdate === true })
          };
        }
      });

      // Update properties in the current container list
      const updatedContainers = currentContainers.map(container => {
        if (updateMap.hasOwnProperty(container.name)) {
          return {
            ...container,
            ...updateMap[container.name]
          };
        }
        return container;
      });

      // Write the updated container list back to the file
      await this._writeJsonAtomic(filePath, updatedContainers);

      // Update template files if no_autoupdate changed
      for (const container of containers) {
        if (container.name && container.no_autoupdate !== undefined) {
          try {
            const templatePath = path.join('/boot/config/system/docker/templates', `${container.name}.json`);
            const templateData = await fs.readFile(templatePath, 'utf8');
            const template = JSON.parse(templateData);
            template.no_autoupdate = container.no_autoupdate === true;
            await fs.writeFile(templatePath, JSON.stringify(template, null, 2), 'utf8');
          } catch (err) {
            // Template file might not exist, non-critical
          }
        }
      }

      return updatedContainers;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('containers file not found');
      }
      throw new Error(`Error updating container indices: ${error.message}`);
    }
  }

  /**
   * Validates a container template
   * @param {Object} template - The template to validate
   * @throws {Error} If validation fails
   */
  validateContainerTemplate(template) {
    // Check required fields
    if (!template.name) {
      throw new Error('Name is required');
    }
    if (!template.repo) {
      throw new Error('Repository is required');
    }

    // Validate paths if present
    if (template.paths) {
      if (!Array.isArray(template.paths)) {
        throw new Error('Paths must be an array');
      }

      template.paths.forEach((path, index) => {
        // Skip empty objects
        if (!path || Object.keys(path).length === 0) {
          return;
        }

        if (!path.host || !path.container) {
          throw new Error(`Path ${index + 1} is missing required fields (host, container`);
        }
      });
    }

    // Validate ports if present
    if (template.ports) {
      if (!Array.isArray(template.ports)) {
        throw new Error('Ports must be an array');
      }

      template.ports.forEach((port, index) => {
        // Skip empty objects
        if (!port || Object.keys(port).length === 0) {
          return;
        }

        if (!port.host || !port.container) {
          throw new Error(`Port ${index + 1} is missing required fields (host, container)`);
        }
      });
    }

    // Validate labels if present
    if (template.labels) {
      if (!Array.isArray(template.labels)) {
        throw new Error('Labels must be an array');
      }

      template.labels.forEach((label, index) => {
        // Skip empty objects
        if (!label || Object.keys(label).length === 0) {
          return;
        }

        if (!label.key || !label.value) {
          throw new Error(`Label ${index + 1} is missing required fields (key, value)`);
        }
      });
    }

    // Validate devices if present
    if (template.devices) {
      if (!Array.isArray(template.devices)) {
        throw new Error('Devices must be an array');
      }

      template.devices.forEach((device, index) => {
        // Skip empty objects
        if (!device || Object.keys(device).length === 0) {
          return;
        }

        if (!device.host || !device.container) {
          throw new Error(`Device ${index + 1} is missing required fields (host, container)`);
        }
      });
    }

    return true;
  }

  /**
   * Creates a new container from template
   * @param {Object} template - The container template
   * @returns {Promise<Object>} Result of the container creation
   */
  async createContainer(template) {
    try {
      // Ensure required directories exist, create them if they don't
      const requiredDirs = [
        '/boot/config/system/docker/templates',
        '/boot/config/system/docker/removed'
      ];

      for (const dir of requiredDirs) {
        try {
          await fs.access(dir);
        } catch (err) {
          if (err.code === 'ENOENT') {
            // Directory doesn't exist, create it recursively
            try {
              await fs.mkdir(dir, { recursive: true });
            } catch (mkdirErr) {
              throw new Error(`Failed to create required directory: ${dir}. Error: ${mkdirErr.message}`);
            }
          } else {
            throw new Error(`Cannot access directory: ${dir}. Error: ${err.message}`);
          }
        }
      }

      // Validate the template
      this.validateContainerTemplate(template);

      template.no_autoupdate = template.no_autoupdate === true;

      // Create filename
      const fileName = `${template.name.replace(/[^A-Za-z0-9\-_.]/g, '_')}.json`;
      const filePath = path.join('/boot/config/system/docker/templates', fileName);

      // Check if file already exists to determine if we need recreate_container parameter
      let templateExists = false;
      try {
        await fs.access(filePath);
        templateExists = true;
      } catch (err) {
        // File doesn't exist, we can proceed with normal creation
        if (err.code !== 'ENOENT') {
          throw err;
        }
      }

      // Write template to file (overwrite if exists)
      await fs.writeFile(filePath, JSON.stringify(template, null, 2), 'utf8');

      // Execute deploy script with recreate_container parameter if template existed
      const scriptPath = '/usr/local/bin/mos-deploy_docker';
      let command = `${scriptPath} ${fileName}`;

      if (templateExists) {
        command += ' recreate_container';
      }

      let deploymentSuccessful = false;
      let stdout = '';
      try {
        const { stdout: deployStdout, stderr } = await execPromise(command, {
          cwd: '/boot/config/system/docker/templates'
        });

        stdout = deployStdout; // Store stdout in broader scope

        // Note: stderr may contain Docker pull progress, which is normal
        // We only check if the container was actually created, not stderr content

        // Verify that the container was actually created by checking if it exists
        try {
          const containerCheckResponse = await axios({
            method: 'GET',
            url: `http://localhost/containers/${template.name}/json`,
            socketPath: '/var/run/docker.sock',
            validateStatus: () => true,
            timeout: 5000
          });

          if (containerCheckResponse.status === 200) {
            deploymentSuccessful = true;
          } else {
            throw new Error(`Container '${template.name}' was not created successfully`);
          }
        } catch (verifyError) {
          throw new Error(`Container verification failed: ${verifyError.message}`);
        }

      } catch (deployError) {
        // Deployment failed - keep template for user to edit and retry
        // Template remains available for correction and redeployment
        const enhancedError = new Error(`Container deployment failed: ${deployError.message}. Template has been saved and can be edited for retry.`);
        enhancedError.templateSaved = true;
        enhancedError.templatePath = filePath;
        throw enhancedError;
      }

      // If deployment was successful, check and remove any template with same name from removed directory
      let removedOldTemplate = false;
      try {
        const removedDir = '/boot/config/system/docker/removed';
        const removedFilePath = path.join(removedDir, fileName);

        // Check if a template with the same name exists in removed directory
        try {
          await fs.access(removedFilePath);
          // File exists, delete it since we successfully created a new container with same name
          await fs.unlink(removedFilePath);
          removedOldTemplate = true;
        } catch (accessError) {
          // File doesn't exist in removed directory, which is fine
        }
      } catch (cleanupError) {
        // Don't fail the main operation if cleanup fails, just continue
      }

      // Refresh hub "installed" detection immediately
      try {
        require('./hub.service').invalidateInstalledCache();
      } catch { }

      try {
        const result = JSON.parse(stdout);

        // Add information about removed old template
        if (removedOldTemplate) {
          result.message = `${result.message || 'Container created successfully'}. Old removed template was automatically cleaned up.`;
        }

        return result;
      } catch (parseError) {
        const result = { message: stdout.trim() };

        // Add information about removed old template
        if (removedOldTemplate) {
          result.message = `${result.message}. Old removed template was automatically cleaned up.`;
        }

        return result;
      }
    } catch (error) {
      throw new Error(`Container creation failed: ${error.message}`);
    }
  }

  /**
   * Removes a container and moves its template to the removed directory
   * @param {string} name - The name of the container to remove
   * @returns {Promise<Object>} Result of the removal process
   */
  async removeContainer(name) {
    try {

      const templateDir = '/boot/config/system/docker/templates';
      const removedDir = '/boot/config/system/docker/removed';
      const fileName = `${name}.json`;
      const templatePath = path.join(templateDir, fileName);
      const removedPath = path.join(removedDir, fileName);

      // Check if template exists (but don't fail if it doesn't)
      let templateExists = true;
      let templateWarning = null;
      try {
        await fs.access(templatePath);
      } catch (err) {
        if (err.code === 'ENOENT') {
          templateExists = false;
          templateWarning = `Container template '${name}' not found, but proceeding with container cleanup`;
        } else {
          throw err;
        }
      }

      // Create removed directory if it doesn't exist
      try {
        await fs.access(removedDir);
      } catch (err) {
        if (err.code === 'ENOENT') {
          await fs.mkdir(removedDir, { recursive: true });
        }
      }

      // Stop and remove the container
      try {
        await execPromise(`docker stop ${name}`);
      } catch (error) {
        // Ignore error if container is not running
      }

      try {
        await execPromise(`docker rm ${name}`);
      } catch (error) {
        // Ignore error if container doesn't exist
      }

      let warning = templateWarning;

      // Read template to get repository information before removing image (only if template exists)
      let repositoryToRemove = null;
      if (templateExists) {
        try {
          const templateData = await fs.readFile(templatePath, 'utf8');
          const template = JSON.parse(templateData);
          repositoryToRemove = template.repo;
        } catch (templateReadError) {
          warning = warning ?
            `${warning}; Could not read template to get repository info: ${templateReadError.message}` :
            `Could not read template to get repository info: ${templateReadError.message}`;
        }
      } else {
        warning = warning ?
          `${warning}; Could not remove image because template is missing` :
          'Could not remove image because template is missing';
      }

      // Remove the container image using the repository from template
      if (repositoryToRemove) {
        try {
          await execPromise(`docker rmi ${repositoryToRemove}`);
        } catch (error) {
          // Check if error is due to image being used by other containers
          if (error.message.includes('image is being used by')) {
            warning = warning ?
              `${warning}; Image could not be removed as it is being used by other containers` :
              'Image could not be removed as it is being used by other containers';
          } else {
            warning = warning ?
              `${warning}; Failed to remove image ${repositoryToRemove}: ${error.message}` :
              `Failed to remove image ${repositoryToRemove}: ${error.message}`;
          }
        }
      } else {
        warning = warning ?
          `${warning}; Could not remove image because repository information is not available` :
          'Could not remove image because repository information is not available';
      }

      // Move template to removed directory (only if it exists)
      if (templateExists) {
        await fs.rename(templatePath, removedPath);
      }

      // Refresh hub "installed" detection immediately
      try {
        require('./hub.service').invalidateInstalledCache();
      } catch { }

      // Remove container entry from containers file and reindex
      try {
        const containersFilePath = '/var/lib/docker/mos/containers';

        // Check if containers file exists
        try {
          await fs.access(containersFilePath);
        } catch (err) {
          if (err.code === 'ENOENT') {
            // File doesn't exist, skip container list update
            return {
              success: true,
              message: `Container '${name}' and its template have been removed`,
              warning: warning
            };
          }
          throw err;
        }

        // Read containers file (tolerate empty/invalid content)
        const containersData = await fs.readFile(containersFilePath, 'utf8');
        let containers = containersData.trim() ? JSON.parse(containersData) : [];
        if (!Array.isArray(containers)) {
          containers = [];
        }

        // Remove the container with the specified name
        const originalLength = containers.length;
        containers = containers.filter(container => container.name !== name);

        // Only proceed if a container was actually removed
        if (containers.length < originalLength) {
          // Sort containers by current index to maintain order
          containers.sort((a, b) => (a.index || 0) - (b.index || 0));

          // Reindex starting from 1
          containers.forEach((container, index) => {
            container.index = index + 1;
          });

          // Write the updated containers list back to file
          await this._writeJsonAtomic(containersFilePath, containers);
        }
      } catch (containerFileError) {
        // If updating the containers file fails, log the warning but don't fail the removal
        warning = warning ?
          `${warning}; Failed to update containers file: ${containerFileError.message}` :
          `Failed to update containers file: ${containerFileError.message}`;
      }

      return {
        success: true,
        message: `Container '${name}' and its template have been removed`,
        warning: warning
      };
    } catch (error) {
      throw new Error(`Container removal failed: ${error.message}`);
    }
  }

  /**
   * Converts XML using the MOS XML convert script
   * @param {string} url - The URL to convert
   * @returns {Promise<Object>} Result of the conversion process
   */
  async convertXml(url) {
    try {
      // Path to XML convert script
      const scriptPath = '/usr/local/bin/mos-xml_convert';

      // Check if URL is provided
      if (!url) {
        throw new Error('URL is required');
      }

      // Command with URL parameter
      const command = `${scriptPath} ${url}`;

      // Execute command
      // Note: stderr may contain warnings, but exit code 0 means success
      const { stdout, stderr } = await execPromise(command);

      // Try to parse the output as JSON, if possible
      let result;
      try {
        result = JSON.parse(stdout);
      } catch (parseError) {
        // If no JSON output, return text
        let message = stdout.trim();
        if (stderr && stderr.trim()) {
          message += '\n' + stderr.trim();
        }
        return { message };
      }

      // Append stderr to message if present
      if (stderr && stderr.trim() && result.message) {
        result.message += '\n' + stderr.trim();
      }

      // Check if name field is null, which indicates an error
      if (result.name === null) {
        throw new Error('Invalid or malformed XML data');
      }

      // If conversion was successful and result has a name, check if template already exists
      if (result.name) {
        const templateExistsPath = path.join('/boot/config/system/docker/templates', `${result.name}.json`);
        try {
          await fs.access(templateExistsPath);
          // Template exists, so append _new to avoid conflicts
          result.name = result.name + '_new';
        } catch (accessError) {
          // Template doesn't exist, keep original name
        }
      }

      return result;
    } catch (error) {
      throw new Error(`Failed to convert XML: ${error.message}`);
    }
  }

  /**
   * Gets a list of removed container templates
   * @returns {Promise<Array>} Array of removed template names
   */
  async getRemovedTemplates() {
    try {
      const removedDir = '/boot/config/system/docker/removed';

      // Check if removed directory exists
      try {
        await fs.access(removedDir);
      } catch (err) {
        if (err.code === 'ENOENT') {
          return []; // Directory doesn't exist, return empty array
        }
        throw err;
      }

      // Read directory contents
      const files = await fs.readdir(removedDir);

      // Filter for .json files and remove the extension
      const templates = files
        .filter(file => file.endsWith('.json'))
        .map(file => ({
          name: file.replace('.json', ''),
          filename: file,
          removed_at: null // Could be enhanced with file stats if needed
        }));

      // Optionally get file stats for removal date
      for (const template of templates) {
        try {
          const filePath = path.join(removedDir, template.filename);
          const stats = await fs.stat(filePath);
          template.removed_at = stats.mtime; // Modification time as removal date
        } catch (statError) {
          // If we can't get stats, continue without the date
        }
      }

      return templates;
    } catch (error) {
      throw new Error(`Failed to get removed templates: ${error.message}`);
    }
  }

  /**
   * Gets a specific removed container template
   * @param {string} name - The name of the removed template
   * @returns {Promise<Object>} The template content
   */
  async getRemovedTemplate(name) {
    try {
      if (!name) {
        throw new Error('Template name is required');
      }

      const removedDir = '/boot/config/system/docker/removed';
      const fileName = `${name}.json`;
      const filePath = path.join(removedDir, fileName);

      // Check if file exists
      try {
        await fs.access(filePath);
      } catch (err) {
        if (err.code === 'ENOENT') {
          throw new Error(`Removed template '${name}' not found`);
        }
        throw err;
      }

      // Read and parse the template file
      const templateData = await fs.readFile(filePath, 'utf8');
      const template = JSON.parse(templateData);

      // Get file stats for additional metadata
      const stats = await fs.stat(filePath);

      return {
        name: name,
        template: template,
        removed_at: stats.mtime,
        file_size: stats.size
      };
    } catch (error) {
      throw new Error(`Failed to get removed template: ${error.message}`);
    }
  }

  /**
   * Gets a list of installed container templates
   * @returns {Promise<Array>} Array of installed template names
   */
  async getInstalledTemplates() {
    try {
      const templatesDir = '/boot/config/system/docker/templates';

      // Check if templates directory exists
      try {
        await fs.access(templatesDir);
      } catch (err) {
        if (err.code === 'ENOENT') {
          return []; // Directory doesn't exist, return empty array
        }
        throw err;
      }

      // Read directory contents
      const files = await fs.readdir(templatesDir);

      // Filter for .json files and remove the extension
      const templates = files
        .filter(file => file.endsWith('.json'))
        .map(file => ({
          name: file.replace('.json', ''),
          filename: file,
          created_at: null // Will be populated with file stats
        }));

      // Get file stats for creation date
      for (const template of templates) {
        try {
          const filePath = path.join(templatesDir, template.filename);
          const stats = await fs.stat(filePath);
          template.created_at = stats.ctime; // Creation time
        } catch (statError) {
          // If we can't get stats, continue without the date
        }
      }

      return templates;
    } catch (error) {
      throw new Error(`Failed to get installed templates: ${error.message}`);
    }
  }

  /**
   * Gets a specific installed container template
   * @param {string} name - The name of the installed template
   * @returns {Promise<Object>} The template content
   */
  async getInstalledTemplate(name) {
    try {
      if (!name) {
        throw new Error('Template name is required');
      }

      const templatesDir = '/boot/config/system/docker/templates';
      const fileName = `${name}.json`;
      const filePath = path.join(templatesDir, fileName);

      // Check if file exists
      try {
        await fs.access(filePath);
      } catch (err) {
        if (err.code === 'ENOENT') {
          throw new Error(`Installed template '${name}' not found`);
        }
        throw err;
      }

      // Read and parse the template file
      const templateData = await fs.readFile(filePath, 'utf8');
      const template = JSON.parse(templateData);

      // Get file stats for additional metadata
      const stats = await fs.stat(filePath);

      return {
        name: name,
        template: template,
        created_at: stats.ctime,
        modified_at: stats.mtime,
        file_size: stats.size
      };
    } catch (error) {
      throw new Error(`Failed to get installed template: ${error.message}`);
    }
  }

  /**
   * Gets a specific template by name, preferring installed over removed
   * @param {string} name - The name of the template
   * @param {boolean} edit - If false, appends '_new' to the template name (default: false)
   * @returns {Promise<Object>} The template object only
   */
  async getTemplate(name, edit = false) {
    try {
      if (!name) {
        throw new Error('Template name is required');
      }

      // First try to get installed template
      try {
        const installedTemplate = await this.getInstalledTemplate(name);
        const template = { ...installedTemplate.template };

        // If edit is false (default), append '_new' to the template name only if a template with that name exists in installed
        if (!edit && template.name) {
          const templateExistsPath = path.join('/boot/config/system/docker/templates', `${template.name}.json`);
          try {
            await fs.access(templateExistsPath);
            // Template exists, so append _new
            template.name = template.name + '_new';
          } catch (accessError) {
            // Template doesn't exist, keep original name
          }
        }

        // no_autoupdate: show actual value only in edit mode, otherwise false (hub download)
        template.no_autoupdate = edit ? (template.no_autoupdate === true) : false;
        return template;
      } catch (installedError) {
        // If installed template not found, try removed template
        if (installedError.message.includes('not found')) {
          try {
            const removedTemplate = await this.getRemovedTemplate(name);
            const template = { ...removedTemplate.template };

            // If edit is false (default), append '_new' to the template name only if a template with that name exists in installed
            if (!edit && template.name) {
              const templateExistsPath = path.join('/boot/config/system/docker/templates', `${template.name}.json`);
              try {
                await fs.access(templateExistsPath);
                // Template exists, so append _new
                template.name = template.name + '_new';
              } catch (accessError) {
                // Template doesn't exist, keep original name
              }
            }

            // no_autoupdate: show actual value only in edit mode, otherwise false (hub download)
            template.no_autoupdate = edit ? (template.no_autoupdate === true) : false;
            return template;
          } catch (removedError) {
            if (removedError.message.includes('not found')) {
              throw new Error(`Template '${name}' not found in installed or removed templates`);
            }
            throw removedError;
          }
        }
        throw installedError;
      }
    } catch (error) {
      throw new Error(`Failed to get template: ${error.message}`);
    }
  }

  /**
   * Gets all container template names grouped by installed and removed
   * @returns {Promise<Object>} Object containing installed and removed template names
   */
  async getAllTemplates() {
    try {
      const [installedTemplates, removedTemplates] = await Promise.all([
        this.getInstalledTemplates(),
        this.getRemovedTemplates()
      ]);

      // Extract just the names and sort them
      const installedNames = installedTemplates.map(t => t.name).sort();
      const removedNames = removedTemplates.map(t => t.name).sort();

      return {
        installed: installedNames,
        removed: removedNames
      };
    } catch (error) {
      throw new Error(`Failed to get all templates: ${error.message}`);
    }
  }

  /**
   * Get the groups file path
   * @returns {string} Path to groups file
   */
  _getGroupsFilePath() {
    return '/var/lib/docker/mos/groups';
  }

  /**
   * Ensure groups directory exists
   */
  async _ensureGroupsDirectory() {
    const groupsDir = path.dirname(this._getGroupsFilePath());
    try {
      await fs.access(groupsDir);
    } catch (error) {
      await fs.mkdir(groupsDir, { recursive: true });
    }
  }

  /**
   * Read groups from file
   * @returns {Promise<Array>} Array of groups
   */
  async _readGroups() {
    try {
      await this._ensureGroupsDirectory();
      const groupsData = await fs.readFile(this._getGroupsFilePath(), 'utf8');
      return JSON.parse(groupsData);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return []; // File doesn't exist, return empty array
      }
      throw new Error(`Failed to read groups: ${error.message}`);
    }
  }

  /**
   * Write groups to file
   * @param {Array} groups - Array of groups to write
   */
  async _writeGroups(groups) {
    try {
      await this._ensureGroupsDirectory();
      await fs.writeFile(this._getGroupsFilePath(), JSON.stringify(groups, null, 2));
    } catch (error) {
      throw new Error(`Failed to write groups: ${error.message}`);
    }
  }

  /**
   * Get the directory where group icons (PNG) are stored
   * @returns {string} Path to the group icons directory
   */
  _getGroupIconsDirectory() {
    return '/var/lib/docker/mos/icons/groups';
  }

  /**
   * Build the absolute icon path for a group, guarding against path traversal
   * @param {string} groupName - Group name (used as the file name)
   * @returns {string} Absolute path to the group's PNG icon
   */
  _getGroupIconPath(groupName) {
    const safeName = String(groupName).replace(/[/\\]/g, '_');
    return path.join(this._getGroupIconsDirectory(), `${safeName}.png`);
  }

  /**
   * Check whether a value is an http(s) URL
   * @param {*} value - Value to test
   * @returns {boolean} True if the value is an http(s) URL
   */
  _isHttpUrl(value) {
    return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
  }

  /**
   * Check whether an icon value is considered "empty" (no icon set)
   * @param {*} value - Value to test
   * @returns {boolean} True for null, undefined or empty/whitespace strings
   */
  _isEmptyIcon(value) {
    return value === null || value === undefined ||
      (typeof value === 'string' && value.trim() === '');
  }

  /**
   * Download a group icon (PNG) from a URL via wget (5s timeout) and validate it
   * @param {string} iconUrl - HTTP(S) URL pointing to a PNG image
   * @param {string} groupName - Group name (used as the file name)
   * @returns {Promise<string>} Absolute path to the saved icon
   */
  async _downloadGroupIcon(iconUrl, groupName) {
    const iconDir = this._getGroupIconsDirectory();
    const iconPath = this._getGroupIconPath(groupName);

    await fs.mkdir(iconDir, { recursive: true });

    try {
      // execFile avoids shell interpolation of the user-provided URL
      await execFilePromise(
        'wget',
        ['-q', '--tries=1', '--timeout=5', '-O', iconPath, iconUrl],
        { timeout: 5000 }
      );
    } catch (error) {
      await fs.unlink(iconPath).catch(() => {});
      throw new Error(`Failed to download icon from '${iconUrl}': ${error.message}`);
    }

    // Must be non-empty and start with the PNG magic number
    let isValidPng = false;
    try {
      const stats = await fs.stat(iconPath);
      if (stats.size > 0) {
        const handle = await fs.open(iconPath, 'r');
        try {
          const header = Buffer.alloc(8);
          await handle.read(header, 0, 8, 0);
          isValidPng = header.equals(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
          );
        } finally {
          await handle.close();
        }
      }
    } catch (error) {
      isValidPng = false;
    }

    if (!isValidPng) {
      await fs.unlink(iconPath).catch(() => {});
      throw new Error(`Downloaded icon from '${iconUrl}' is not a valid PNG image`);
    }

    return iconPath;
  }

  /**
   * Remove a group's downloaded icon file if present (best-effort cleanup)
   * @param {string} groupName - Group name (used as the file name)
   */
  async _removeGroupIcon(groupName) {
    await fs.unlink(this._getGroupIconPath(groupName)).catch(() => {});
  }

  /**
   * Generate timestamp-based ID for container groups
   * @private
   * @returns {string} Timestamp ID in milliseconds
   */
  _generateTimestampId() {
    return Date.now().toString();
  }

  /**
   * Get running container names from Docker
   * @returns {Promise<Set>} Set of running container names
{{ ... }}
   */
  async _getRunningContainers() {
    try {
      const { stdout } = await execPromise('docker ps --format "{{.Names}}" --filter "status=running"');
      const runningNames = stdout.trim().split('\n').filter(name => name.length > 0);
      return new Set(runningNames);
    } catch (error) {
      // If docker command fails, return empty set (no running containers)
      return new Set();
    }
  }

  /**
   * Get all container groups
   * @returns {Promise<Array>} Array of groups with their containers
   */
  async getContainerGroups() {
    try {
      const groups = await this._readGroups();

      // Get current container order from containers file
      const containers = await this.getDockerImages();

      // Get running containers ONCE for all groups (performance optimization)
      const runningContainers = await this._getRunningContainers();

      // Load compose-containers data for update_available check (array format)
      let composeContainersMap = {};
      try {
        const composeContainersPath = '/var/lib/docker/mos/compose-containers';
        const data = await fs.readFile(composeContainersPath, 'utf8');
        const composeContainersArray = JSON.parse(data);
        // Convert array to map for quick lookup
        for (const entry of composeContainersArray) {
          composeContainersMap[entry.stack] = entry;
        }
      } catch (err) {
        // File doesn't exist or is invalid, use empty object
      }

      // Track if any groups were modified (for cleanup)
      let groupsModified = false;

      // Enrich groups with current container status and sort by index
      const enrichedGroups = groups.map(group => {
        // For compose groups, don't filter containers (they're not in the containers file)
        // For regular groups, filter to only show existing containers
        const filteredContainers = group.compose
          ? group.containers
          : group.containers.filter(containerName =>
              containers.some(c => c.name === containerName)
            );

        // If containers were removed from a non-compose group, update the stored group
        if (!group.compose && filteredContainers.length !== group.containers.length) {
          group.containers = filteredContainers;
          groupsModified = true;
        }

        // Count running containers in this group (O(1) lookup per container)
        const runningCount = filteredContainers.filter(containerName =>
          runningContainers.has(containerName)
        ).length;

        // Check if any container in the group has an update available
        let updateAvailable = false;
        if (group.compose) {
          // For compose groups, check compose-containers file
          const stackData = composeContainersMap[group.name];
          if (stackData && stackData.services) {
            updateAvailable = Object.values(stackData.services).some(service =>
              service.local !== service.remote
            );
          }
        } else {
          // For regular groups, check containers file
          updateAvailable = filteredContainers.some(containerName => {
            const container = containers.find(c => c.name === containerName);
            return container && container.update_available === true;
          });
        }

        return {
          ...group,
          compose: group.compose || false, // Ensure compose field exists, default to false
          containers: filteredContainers,
          count: filteredContainers.length,
          runningCount: runningCount,
          update_available: updateAvailable
        };
      }).sort((a, b) => a.index - b.index);

      // Save groups if any were modified (cleanup of deleted containers)
      if (groupsModified) {
        await this._writeGroups(groups);
      }

      return enrichedGroups;
    } catch (error) {
      throw new Error(`Failed to get container groups: ${error.message}`);
    }
  }

  /**
   * Check if containers are already assigned to other groups
   * @param {Array} containers - Array of container names to check
   * @param {string} excludeGroupId - Group ID to exclude from check (for updates)
   * @returns {Promise<Array>} Array of conflicts: [{container, groupName, groupId}]
   */
  async _checkContainerConflicts(containers, excludeGroupId = null) {
    const groups = await this._readGroups();
    const conflicts = [];

    for (const container of containers) {
      for (const group of groups) {
        if (group.id === excludeGroupId) continue; // Skip current group when updating

        if (group.containers.includes(container)) {
          conflicts.push({
            container,
            groupName: group.name,
            groupId: group.id
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * Create a new container group
   * @param {string} name - Group name
   * @param {Array} containers - Array of container names
   * @param {Object} options - Optional settings
   * @param {boolean} options.compose - Whether this is a compose stack group (default: false)
   * @param {string|null} options.icon - Icon path (default: null)
   * @returns {Promise<Object>} Created group
   */
  async createContainerGroup(name, containers = [], options = {}) {
    try {
      if (!name || typeof name !== 'string') {
        throw new Error('Group name is required and must be a string');
      }

      const groups = await this._readGroups();

      // Check if group name already exists
      if (groups.some(group => group.name === name)) {
        throw new Error(`Group with name '${name}' already exists`);
      }

      // Skip container validation for compose groups (containers may not exist yet)
      if (!options.compose) {
        // Validate containers exist
        const existingContainers = await this.getDockerImages();
        const existingContainerNames = existingContainers.map(c => c.name);

        const invalidContainers = containers.filter(containerName =>
          !existingContainerNames.includes(containerName)
        );

        if (invalidContainers.length > 0) {
          throw new Error(`Containers not found: ${invalidContainers.join(', ')}`);
        }

        // Check for container conflicts (containers already in other groups)
        const conflicts = await this._checkContainerConflicts(containers);
        if (conflicts.length > 0) {
          const conflictMessages = conflicts.map(c =>
            `'${c.container}' is already in group '${c.groupName}'`
          );
          throw new Error(`Container conflicts: ${conflictMessages.join(', ')}`);
        }
      }

      // Get next index
      const nextIndex = groups.length > 0 ? Math.max(...groups.map(g => g.index)) + 1 : 1;

      const newGroup = {
        id: this._generateTimestampId(),
        name,
        index: nextIndex,
        containers: [...new Set(containers)], // Remove duplicates
        icon: options.icon || null,
        compose: options.compose || false
      };

      // Download the PNG if the icon is a URL (stored value stays the URL)
      if (this._isHttpUrl(newGroup.icon)) {
        await this._downloadGroupIcon(newGroup.icon, newGroup.name);
      }

      groups.push(newGroup);
      await this._writeGroups(groups);

      return newGroup;
    } catch (error) {
      throw new Error(`Failed to create container group: ${error.message}`);
    }
  }

  /**
   * Delete a container group
   * @param {string} groupId - Group ID to delete
   * @returns {Promise<boolean>} True if deleted successfully
   */
  async deleteContainerGroup(groupId) {
    try {
      const groups = await this._readGroups();
      const groupIndex = groups.findIndex(group => group.id === groupId);

      if (groupIndex === -1) {
        throw new Error(`Group with ID '${groupId}' not found`);
      }

      const removedGroup = groups[groupIndex];
      groups.splice(groupIndex, 1);
      await this._writeGroups(groups);

      // Best-effort cleanup of any downloaded icon for this group
      await this._removeGroupIcon(removedGroup.name);

      return true;
    } catch (error) {
      throw new Error(`Failed to delete container group: ${error.message}`);
    }
  }

  /**
   * Start all containers in a group
   * @param {string} groupId - Group ID
   * @returns {Promise<Object>} Result with success/failure details
   */
  async startContainerGroup(groupId) {
    try {
      const groups = await this._readGroups();
      const group = groups.find(g => g.id === groupId);

      if (!group) {
        throw new Error(`Group with ID '${groupId}' not found`);
      }

      // Check if this is a compose group
      if (group.compose === true) {
        throw new Error(`Group '${group.name}' is a Docker Compose stack. Use the compose API endpoints to manage compose stacks.`);
      }

      const results = {
        groupId,
        groupName: group.name,
        totalContainers: group.containers.length,
        results: [],
        successCount: 0,
        failureCount: 0
      };

      // Start each container in the group using Docker API
      for (const containerName of group.containers) {
        try {
          await axios({
            method: 'POST',
            url: `http://localhost/containers/${containerName}/start`,
            socketPath: '/var/run/docker.sock',
            validateStatus: () => true,
            timeout: 10000
          });
          results.results.push({
            container: containerName,
            status: 'success',
            message: 'Container started successfully'
          });
          results.successCount++;
        } catch (error) {
          let errorMessage = 'Unknown error';
          if (error.response && error.response.data) {
            if (typeof error.response.data === 'string') {
              errorMessage = error.response.data;
            } else if (error.response.data.message) {
              errorMessage = error.response.data.message;
            }
          } else if (error.message) {
            errorMessage = error.message;
          }

          results.results.push({
            container: containerName,
            status: 'error',
            message: errorMessage
          });
          results.failureCount++;
        }
      }

      return results;
    } catch (error) {
      throw new Error(`Failed to start container group: ${error.message}`);
    }
  }

  /**
   * Restart all containers in a group (sequential execution)
   * @param {string} groupId - Group ID
   * @returns {Promise<Object>} Result with success/failure details
   */
  async restartContainerGroup(groupId) {
    try {
      const groups = await this._readGroups();
      const group = groups.find(g => g.id === groupId);

      if (!group) {
        throw new Error(`Group with ID '${groupId}' not found`);
      }

      // Check if this is a compose group
      if (group.compose === true) {
        throw new Error(`Group '${group.name}' is a Docker Compose stack. Use the compose API endpoints to manage compose stacks.`);
      }

      const results = {
        groupId,
        groupName: group.name,
        totalContainers: group.containers.length,
        results: [],
        successCount: 0,
        failureCount: 0
      };

      // Restart each container in the group using Docker API
      for (const containerName of group.containers) {
        try {
          await axios({
            method: 'POST',
            url: `http://localhost/containers/${containerName}/restart`,
            socketPath: '/var/run/docker.sock',
            validateStatus: () => true,
            timeout: 10000
          });
          results.results.push({
            container: containerName,
            status: 'success',
            message: 'Container restarted successfully'
          });
          results.successCount++;
        } catch (error) {
          let errorMessage = 'Unknown error';
          if (error.response && error.response.data) {
            if (typeof error.response.data === 'string') {
              errorMessage = error.response.data;
            } else if (error.response.data.message) {
              errorMessage = error.response.data.message;
            }
          } else if (error.message) {
            errorMessage = error.message;
          }

          results.results.push({
            container: containerName,
            status: 'error',
            message: errorMessage
          });
          results.failureCount++;
        }
      }

      return results;
    } catch (error) {
      throw new Error(`Failed to restart container group: ${error.message}`);
    }
  }

  /**
   * Stop all containers in a group (parallel execution)
   * @param {string} groupId - Group ID
   * @returns {Promise<Object>} Result with success/failure details
   */
  async stopContainerGroup(groupId) {
    try {
      const groups = await this._readGroups();
      const group = groups.find(g => g.id === groupId);

      if (!group) {
        throw new Error(`Group with ID '${groupId}' not found`);
      }

      // Check if this is a compose group
      if (group.compose === true) {
        throw new Error(`Group '${group.name}' is a Docker Compose stack. Use the compose API endpoints to manage compose stacks.`);
      }

      const results = {
        groupId,
        groupName: group.name,
        totalContainers: group.containers.length,
        results: [],
        successCount: 0,
        failureCount: 0
      };

      // Stop all containers in parallel using Promise.allSettled with Docker API
      const stopPromises = group.containers.map(async (containerName) => {
        try {
          await axios({
            method: 'POST',
            url: `http://localhost/containers/${containerName}/stop`,
            socketPath: '/var/run/docker.sock',
            validateStatus: () => true,
            timeout: 10000
          });
          return {
            container: containerName,
            status: 'success',
            message: 'Container stopped successfully'
          };
        } catch (error) {
          let errorMessage = 'Unknown error';
          if (error.response && error.response.data) {
            if (typeof error.response.data === 'string') {
              errorMessage = error.response.data;
            } else if (error.response.data.message) {
              errorMessage = error.response.data.message;
            }
          } else if (error.message) {
            errorMessage = error.message;
          }
          return {
            container: containerName,
            status: 'error',
            message: errorMessage
          };
        }
      });

      // Wait for all stop operations to complete (parallel)
      const stopResults = await Promise.allSettled(stopPromises);

      // Process results
      stopResults.forEach((result) => {
        if (result.status === 'fulfilled') {
          results.results.push(result.value);
          if (result.value.status === 'success') {
            results.successCount++;
          } else {
            results.failureCount++;
          }
        } else {
          // This should not happen since we catch errors in the promise
          results.results.push({
            container: 'unknown',
            status: 'error',
            message: result.reason?.message || 'Unknown error'
          });
          results.failureCount++;
        }
      });

      return results;
    } catch (error) {
      throw new Error(`Failed to stop container group: ${error.message}`);
    }
  }

  /**
   * Upgrade all containers in a group (sequential execution)
   * @param {string} groupId - Group ID
   * @param {boolean} forceUpdate - Force update even if no new version available (default: false)
   * @returns {Promise<Object>} Result with success/failure details
   */
  async upgradeContainerGroup(groupId, forceUpdate = false) {
    try {
      const groups = await this._readGroups();
      const group = groups.find(g => g.id === groupId);

      if (!group) {
        throw new Error(`Group with ID '${groupId}' not found`);
      }

      // Check if this is a compose group
      if (group.compose === true) {
        throw new Error(`Group '${group.name}' is a Docker Compose stack. Use the compose API endpoints to manage compose stacks.`);
      }

      const results = {
        groupId,
        groupName: group.name,
        totalContainers: group.containers.length,
        results: [],
        successCount: 0,
        failureCount: 0
      };

      // Upgrade each container in the group sequentially
      for (const containerName of group.containers) {
        try {
          const upgradeResult = await this.Upgrade(containerName, forceUpdate);
          results.results.push({
            container: containerName,
            status: 'success',
            message: upgradeResult.message || 'Container upgraded successfully',
            details: upgradeResult
          });
          results.successCount++;
        } catch (error) {
          results.results.push({
            container: containerName,
            status: 'error',
            message: error.message || 'Unknown error'
          });
          results.failureCount++;
        }
      }

      return results;
    } catch (error) {
      throw new Error(`Failed to upgrade container group: ${error.message}`);
    }
  }

  /**
   * Add containers to a group
   * @param {string} groupId - Group ID
   * @param {Array} containerNames - Array of container names to add
   * @returns {Promise<Object>} Updated group
   */
  async addContainersToGroup(groupId, containerNames) {
    try {
      if (!Array.isArray(containerNames) || containerNames.length === 0) {
        throw new Error('Container names must be a non-empty array');
      }

      const groups = await this._readGroups();
      const group = groups.find(g => g.id === groupId);

      if (!group) {
        throw new Error(`Group with ID '${groupId}' not found`);
      }

      // Validate containers exist
      const existingContainers = await this.getDockerImages();
      const existingContainerNames = existingContainers.map(c => c.name);

      const invalidContainers = containerNames.filter(containerName =>
        !existingContainerNames.includes(containerName)
      );

      if (invalidContainers.length > 0) {
        throw new Error(`Containers not found: ${invalidContainers.join(', ')}`);
      }

      // Add containers (avoid duplicates)
      containerNames.forEach(containerName => {
        if (!group.containers.includes(containerName)) {
          group.containers.push(containerName);
        }
      });

      await this._writeGroups(groups);
      return group;
    } catch (error) {
      throw new Error(`Failed to add containers to group: ${error.message}`);
    }
  }

  /**
   * Remove containers from a group
   * @param {string} groupId - Group ID
   * @param {Array} containerNames - Array of container names to remove
   * @returns {Promise<Object>} Updated group
   */
  async removeContainersFromGroup(groupId, containerNames) {
    try {
      if (!Array.isArray(containerNames) || containerNames.length === 0) {
        throw new Error('Container names must be a non-empty array');
      }

      const groups = await this._readGroups();
      const group = groups.find(g => g.id === groupId);

      if (!group) {
        throw new Error(`Group with ID '${groupId}' not found`);
      }

      // Remove containers
      group.containers = group.containers.filter(containerName =>
        !containerNames.includes(containerName)
      );

      await this._writeGroups(groups);
      return group;
    } catch (error) {
      throw new Error(`Failed to remove containers from group: ${error.message}`);
    }
  }

  /**
   * Update group with partial data (name, icon, containers, etc.)
   * @param {string} groupId - Group ID
   * @param {Object} updateData - Data to update
   * @param {string} [updateData.name] - New group name
   * @param {string|null} [updateData.icon] - New icon (can be null to remove icon)
   * @param {Array} [updateData.containers] - New containers array (replaces existing)
   * @param {Array} [updateData.addContainers] - Containers to add to existing
   * @param {Array} [updateData.removeContainers] - Containers to remove from existing
   * @returns {Promise<Object>} Updated group
   */
  async updateGroup(groupId, updateData) {
    try {
      const groups = await this._readGroups();
      const group = groups.find(g => g.id === groupId);

      if (!group) {
        throw new Error(`Group with ID ${groupId} not found`);
      }

      // Snapshot values needed to keep the on-disk icon in sync after the update
      const previousName = group.name;
      const previousIcon = group.icon;

      // Update name if provided
      if (updateData.name !== undefined) {
        if (!updateData.name || typeof updateData.name !== 'string') {
          throw new Error('Group name must be a non-empty string');
        }

        // Check if name already exists (excluding current group)
        const existingGroup = groups.find(g => g.name === updateData.name && g.id !== groupId);
        if (existingGroup) {
          throw new Error(`Group with name '${updateData.name}' already exists`);
        }

        group.name = updateData.name;
      }

      // Update icon if provided
      if (updateData.icon !== undefined) {
        // Allow null or string values for icon
        if (updateData.icon !== null && typeof updateData.icon !== 'string') {
          throw new Error('Icon must be a string or null');
        }
        // Normalize empty/whitespace to null
        group.icon = this._isEmptyIcon(updateData.icon) ? null : updateData.icon;
      }

      // Handle containers updates
      if (updateData.containers !== undefined) {
        // Replace entire containers array
        if (!Array.isArray(updateData.containers)) {
          throw new Error('Containers must be an array');
        }

        // Skip container validation for compose groups (containers may not exist yet)
        if (!group.compose) {
          // Validate containers exist
          const allContainers = await this.getDockerImages();
          const containerNames = allContainers.map(c => c.name);
          const invalidContainers = updateData.containers.filter(name => !containerNames.includes(name));

          if (invalidContainers.length > 0) {
            throw new Error(`Invalid containers: ${invalidContainers.join(', ')}`);
          }

          // Check for container conflicts (exclude current group)
          const conflicts = await this._checkContainerConflicts(updateData.containers, groupId);
          if (conflicts.length > 0) {
            const conflictMessages = conflicts.map(c =>
              `'${c.container}' is already in group '${c.groupName}'`
            );
            throw new Error(`Container conflicts: ${conflictMessages.join(', ')}`);
          }
        }

        group.containers = [...new Set(updateData.containers)]; // Remove duplicates
      } else {
        // Handle add/remove operations
        if (updateData.addContainers && Array.isArray(updateData.addContainers)) {
          // Validate containers exist
          const allContainers = await this.getDockerImages();
          const containerNames = allContainers.map(c => c.name);
          const invalidContainers = updateData.addContainers.filter(name => !containerNames.includes(name));

          if (invalidContainers.length > 0) {
            throw new Error(`Invalid containers to add: ${invalidContainers.join(', ')}`);
          }

          // Check for container conflicts for containers to add (exclude current group)
          const conflicts = await this._checkContainerConflicts(updateData.addContainers, groupId);
          if (conflicts.length > 0) {
            const conflictMessages = conflicts.map(c =>
              `'${c.container}' is already in group '${c.groupName}'`
            );
            throw new Error(`Container conflicts: ${conflictMessages.join(', ')}`);
          }

          // Add containers (avoid duplicates)
          const currentContainers = new Set(group.containers);
          updateData.addContainers.forEach(container => currentContainers.add(container));
          group.containers = Array.from(currentContainers);
        }

        if (updateData.removeContainers && Array.isArray(updateData.removeContainers)) {
          // Remove containers
          group.containers = group.containers.filter(container =>
            !updateData.removeContainers.includes(container)
          );
        }
      }

      // Keep the on-disk icon PNG in sync with the icon URL / group name
      const iconProvided = updateData.icon !== undefined;
      const iconIsUrl = this._isHttpUrl(group.icon);
      const nameChanged = group.name !== previousName;
      if (iconIsUrl && (group.icon !== previousIcon || nameChanged)) {
        // New URL or rename: (re)download
        await this._downloadGroupIcon(group.icon, group.name);
        if (nameChanged) {
          await this._removeGroupIcon(previousName);
        }
      } else if (iconProvided && this._isEmptyIcon(group.icon)) {
        // Icon cleared: drop the PNG
        await this._removeGroupIcon(previousName);
      } else if (!iconIsUrl && this._isHttpUrl(previousIcon)) {
        // URL replaced by another identifier: drop the old PNG
        await this._removeGroupIcon(previousName);
      }

      group.updated_at = new Date().toISOString();

      await this._writeGroups(groups);
      return group;
    } catch (error) {
      throw new Error(`Failed to update group: ${error.message}`);
    }
  }

  /**
   * Update group name
   * @param {string} groupId - Group ID
   * @param {string} newName - New group name
   * @returns {Promise<Object>} Updated group
   * @deprecated Use updateGroup() instead
   */
  async updateGroupName(groupId, newName) {
    return this.updateGroup(groupId, { name: newName });
  }

  /**
   * Update group icon
   * @param {string} groupId - Group ID
   * @param {string|null} icon - New icon (can be null to remove icon)
   * @returns {Promise<Object>} Updated group
   * @deprecated Use updateGroup() instead
   */
  async updateGroupIcon(groupId, icon) {
    return this.updateGroup(groupId, { icon: icon });
  }

  /**
   * Update group order/index
   * @param {Array} groupOrder - Array of group objects with id and index
   * @returns {Promise<Array>} Updated groups array
   */
  async updateGroupOrder(groupOrder) {
    try {
      if (!Array.isArray(groupOrder)) {
        throw new Error('Group order must be an array');
      }

      const groups = await this._readGroups();

      // Validate all group IDs exist
      const groupIds = groups.map(g => g.id);
      const invalidIds = groupOrder.filter(item => !groupIds.includes(item.id));

      if (invalidIds.length > 0) {
        throw new Error(`Invalid group IDs: ${invalidIds.map(item => item.id).join(', ')}`);
      }

      // Update indices
      groupOrder.forEach(orderItem => {
        const group = groups.find(g => g.id === orderItem.id);
        if (group) {
          group.index = orderItem.index;
        }
      });

      await this._writeGroups(groups);

      // Return sorted groups
      return groups.sort((a, b) => a.index - b.index);
    } catch (error) {
      throw new Error(`Failed to update group order: ${error.message}`);
    }
  }

  /**
   * Get unused Docker images (images not used by any container)
   * @returns {Promise<Array>} Array of unused images with repository, tag, and id
   */
  async getUnusedImages() {
    try {
      const dockerSocketPath = '/var/run/docker.sock';

      // Get all images via Docker API
      const imagesResponse = await axios.get('http://localhost/images/json', {
        socketPath: dockerSocketPath
      });

      const images = imagesResponse.data;

      if (!images || images.length === 0) {
        return [];
      }

      // Get all containers (running and stopped) via Docker API
      const containersResponse = await axios.get('http://localhost/containers/json', {
        socketPath: dockerSocketPath,
        params: {
          all: true
        }
      });

      const containers = containersResponse.data;

      // Build set of used image IDs
      const usedImageIds = new Set();

      containers.forEach(container => {
        // Add full image ID (sha256:...)
        if (container.ImageID) {
          usedImageIds.add(container.ImageID);
          // Also add short version
          const shortId = container.ImageID.replace('sha256:', '').substring(0, 12);
          usedImageIds.add(shortId);
        }
        // Also add the image name used by container
        if (container.Image) {
          usedImageIds.add(container.Image);
        }
      });

      // Filter out images that are used by containers
      const unusedImages = images.filter(image => {
        // Check if full image ID is used
        if (usedImageIds.has(image.Id)) {
          return false;
        }

        // Check short image ID
        const shortId = image.Id.replace('sha256:', '').substring(0, 12);
        if (usedImageIds.has(shortId)) {
          return false;
        }

        // Check if any of the image's RepoTags are used
        if (image.RepoTags) {
          for (const repoTag of image.RepoTags) {
            if (usedImageIds.has(repoTag)) {
              return false;
            }
          }
        }

        return true;
      });

      // Format response
      const formattedImages = [];

      unusedImages.forEach(image => {
        const shortId = image.Id.replace('sha256:', '').substring(0, 12);
        const sizeInMB = (image.Size / (1024 * 1024)).toFixed(2);
        const size = sizeInMB >= 1024
          ? `${(sizeInMB / 1024).toFixed(2)}GB`
          : `${sizeInMB}MB`;

        // Handle images with RepoTags
        if (image.RepoTags && image.RepoTags.length > 0 && image.RepoTags[0] !== '<none>:<none>') {
          image.RepoTags.forEach(repoTag => {
            const [repository, tag] = repoTag.split(':');
            formattedImages.push({
              repository,
              tag,
              id: shortId,
              size
            });
          });
        } else {
          // Dangling/untagged image
          formattedImages.push({
            repository: '<untagged>',
            tag: '<none>',
            id: shortId,
            size
          });
        }
      });

      return formattedImages;

    } catch (error) {
      throw new Error(`Failed to get unused images: ${error.message}`);
    }
  }

  /**
   * Delete unused Docker images
   * @param {Array<string>} imageIds - Optional array of image IDs to delete (deletes all if not provided)
   * @returns {Promise<Object>} Result with deleted and failed images
   */
  async deleteUnusedImages(imageIds = null) {
    try {
      // Get unused images
      const unusedImages = await this.getUnusedImages();

      if (unusedImages.length === 0) {
        return {
          success: true,
          message: 'No unused images to delete',
          deleted: [],
          failed: []
        };
      }

      // Filter images to delete if specific IDs provided
      let imagesToDelete = unusedImages;
      if (imageIds && Array.isArray(imageIds) && imageIds.length > 0) {
        imagesToDelete = unusedImages.filter(img => imageIds.includes(img.id));

        if (imagesToDelete.length === 0) {
          throw new Error('None of the specified image IDs are unused images');
        }
      }

      const deleted = [];
      const failed = [];

      // Delete images using Docker API via axios
      const dockerSocketPath = '/var/run/docker.sock';

      for (const image of imagesToDelete) {
        try {
          // Use repo:tag reference to avoid "referenced in multiple repositories" error
          // Fall back to ID for untagged/dangling images
          const imageRef = (image.repository !== '<untagged>' && image.tag !== '<none>')
            ? `${image.repository}:${image.tag}`
            : image.id;

          // Use Docker API to delete image
          await axios.delete(`http://localhost/images/${encodeURIComponent(imageRef)}`, {
            socketPath: dockerSocketPath,
            params: {
              force: false // Don't force delete, only delete if truly unused
            }
          });

          deleted.push({
            repository: image.repository,
            tag: image.tag,
            id: image.id,
            size: image.size
          });
        } catch (error) {
          failed.push({
            repository: image.repository,
            tag: image.tag,
            id: image.id,
            size: image.size,
            error: error.response?.data?.message || error.message
          });
        }
      }

      return {
        success: failed.length === 0,
        message: `Deleted ${deleted.length} image(s), ${failed.length} failed`,
        deleted,
        failed
      };

    } catch (error) {
      throw new Error(`Failed to delete unused images: ${error.message}`);
    }
  }
  /**
   * Gets all Docker container port bindings via the Docker socket API
   * @returns {Promise<Array>} Array of port objects sorted by port and proto
   */
  async getDockerPorts() {
    try {
      // Get all containers
      const listResponse = await axios({
        method: 'GET',
        url: 'http://localhost/containers/json?all=true',
        socketPath: '/var/run/docker.sock',
        validateStatus: () => true,
        timeout: 10000
      });

      if (listResponse.status !== 200 || !Array.isArray(listResponse.data)) {
        throw new Error('Failed to list containers from Docker API');
      }

      const containers = listResponse.data;
      const ports = [];

      // Inspect each container for PortBindings
      for (const container of containers) {
        try {
          const inspectResponse = await axios({
            method: 'GET',
            url: `http://localhost/containers/${container.Id}/json`,
            socketPath: '/var/run/docker.sock',
            validateStatus: () => true,
            timeout: 5000
          });

          if (inspectResponse.status !== 200) continue;

          const data = inspectResponse.data;
          const portBindings = (data.HostConfig && data.HostConfig.PortBindings) || {};
          const name = data.Name ? data.Name.replace(/^\//, '') : '';
          const status = (data.State && data.State.Status) || 'unknown';

          for (const [binding, hosts] of Object.entries(portBindings)) {
            if (!Array.isArray(hosts)) continue;
            const proto = binding.split('/')[1] || 'tcp';

            for (const host of hosts) {
              if (host && host.HostPort && host.HostPort !== '') {
                ports.push({
                  port: Number(host.HostPort),
                  proto,
                  name,
                  status
                });
              }
            }
          }
        } catch (inspectError) {
          // Skip containers that can't be inspected
        }
      }

      // Sort by port, then proto
      ports.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));

      return ports;
    } catch (error) {
      throw new Error(`Failed to get Docker ports: ${error.message}`);
    }
  }
}

module.exports = new DockerService();
