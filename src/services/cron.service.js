const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

class CronService {
  constructor() {
    this.cronFile = '/boot/config/system/cron.json';
  }

  /**
   * Creates the directory if it does not exist
   * @private
   */
  async _ensureDirectoryExists() {
    const dir = path.dirname(this.cronFile);
    try {
      await fs.access(dir);
    } catch (error) {
      if (error.code === 'ENOENT') {
        await fs.mkdir(dir, { recursive: true });
      } else {
        throw error;
      }
    }
  }

  /**
   * Reads all cron jobs from the JSON file
   * @returns {Promise<Array>} Array of cron jobs with status
   */
  async getCronJobs() {
    try {
      await this._ensureDirectoryExists();
      const data = await fs.readFile(this.cronFile, 'utf8');
      const jobs = JSON.parse(data);

      // Always add status
      const jobsWithStatus = await Promise.all(
        jobs.map(async (job) => ({
          ...job,
          status: await this._getJobStatus(job)
        }))
      );
      return jobsWithStatus;
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File does not exist - return empty array
        return [];
      }
      throw new Error(`Error reading cron.json: ${error.message}`);
    }
  }

  /**
   * Saves all cron jobs to the JSON file
   * @param {Array} cronJobs - Array of cron jobs
   * @private
   */
  async _saveCronJobs(cronJobs) {
    await this._ensureDirectoryExists();
    await fs.writeFile(this.cronFile, JSON.stringify(cronJobs, null, 2), 'utf8');
  }

  /**
   * Generates a unique ID for a new cron job
   * @param {Array} existingJobs - Existing cron jobs
   * @returns {string} Unique ID
   * @private
   */
  _generateUniqueId(existingJobs) {
    let id;
    do {
      id = Date.now().toString();
      // Small delay to ensure unique IDs
      // in case multiple jobs are created quickly
    } while (existingJobs.find(job => job.id === id));
    return id;
  }

  /**
   * Converts a cron job name to a safe filename
   * @param {string} name - Cron job name
   * @returns {string} Safe filename
   * @private
   */
  _generateSafeFilename(name) {
    // Replace spaces and special characters with underscores
    // Remove dangerous characters for filesystem
    return name
      .replace(/[^a-zA-Z0-9\s\-_]/g, '_')  // Replace all non-alphanumeric characters except spaces, hyphens, and underscores
      .replace(/\s+/g, '_')                 // Replace spaces with underscores
      .replace(/_+/g, '_')                  // Merge multiple consecutive underscores
      .replace(/^_+|_+$/g, '')             // Remove leading and trailing underscores
      .toLowerCase();                       // Convert to lowercase
  }

  /**
   * Creates a script for a cron job
   * @param {string} name - Cron job name
   * @param {string} scriptContent - Script content
   * @param {boolean} convertToUnix - Whether to convert the script to Unix format using dos2unix (default: false)
   * @returns {Promise<string>} Path to the created script
   * @private
   */
  async _createCronScript(name, scriptContent, convertToUnix = false) {
    try {
      const scriptsDir = '/boot/optional/scripts/cron';

      // Check if directory exists, create it if not
      try {
        await fs.access(scriptsDir);
      } catch (error) {
        if (error.code === 'ENOENT') {
          await fs.mkdir(scriptsDir, { recursive: true });
        } else {
          throw error;
        }
      }

      // Generate safe filename
      const safeFilename = this._generateSafeFilename(name);
      const scriptPath = path.join(scriptsDir, `${safeFilename}.sh`);

      // Create script content with shebang
      const fullScriptContent = `${scriptContent}`;

      // Create script and make it executable
      await fs.writeFile(scriptPath, fullScriptContent, 'utf8');
      await execPromise(`chmod +x "${scriptPath}"`);

      // Convert to Unix format if requested
      if (convertToUnix) {
        try {
          await execPromise(`dos2unix "${scriptPath}"`);
        } catch (error) {
          console.warn(`Warning: dos2unix conversion failed for ${scriptPath}: ${error.message}`);
        }
      }

      return scriptPath;
    } catch (error) {
      throw new Error(`Error creating cron script: ${error.message}`);
    }
  }

  /**
   * Validates a cron job
   * @param {Object} jobData - Cron job data
   * @param {boolean} isUpdate - Whether it is an update
   * @private
   */
  _validateCronJob(jobData, isUpdate = false) {
    if (!isUpdate || jobData.name !== undefined) {
      if (!jobData.name || typeof jobData.name !== 'string') {
        throw new Error('Name is required and must be a string');
      }
    }

    if (!isUpdate || jobData.schedule !== undefined) {
      if (!jobData.schedule || typeof jobData.schedule !== 'string') {
        throw new Error('Schedule is required and must be a string');
      }

      const schedule = jobData.schedule.trim();

      // Check for special cron shortcuts
      const validShortcuts = ['@reboot', '@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly'];
      const isShortcut = validShortcuts.includes(schedule);

      if (!isShortcut) {
        // Default Cron-Format validation (5 fields)
        const cronParts = schedule.split(/\s+/);
        if (cronParts.length !== 5) {
          throw new Error('Schedule must be in Cron format (5 fields: Minute Hour Day Month Weekday) or a valid shortcut (@reboot, @daily, @hourly, etc.)');
        }
      }
    }

    // Either command, script, or scriptPath is required
    if (!isUpdate || jobData.command !== undefined || jobData.script !== undefined || jobData.scriptPath !== undefined) {
      const hasScript = jobData.script && typeof jobData.script === 'string' && jobData.script.trim() !== '';
      const hasScriptPath = jobData.scriptPath && typeof jobData.scriptPath === 'string' && jobData.scriptPath.trim() !== '';
      const hasCommand = jobData.command && typeof jobData.command === 'string' && jobData.command.trim() !== '';

      // At least one of command, script, or scriptPath must be provided
      if (!hasScript && !hasScriptPath && !hasCommand) {
        throw new Error('Either command, script, or scriptPath must be provided');
      }

      // Validate types if provided
      if (jobData.script !== undefined && typeof jobData.script !== 'string') {
        throw new Error('Script must be a string');
      }

      if (jobData.scriptPath !== undefined && typeof jobData.scriptPath !== 'string') {
        throw new Error('ScriptPath must be a string');
      }

      if (jobData.command !== undefined && typeof jobData.command !== 'string') {
        throw new Error('Command must be a string');
      }
    }

    if (jobData.enabled !== undefined) {
      if (typeof jobData.enabled !== 'boolean') {
        throw new Error('Enabled must be a boolean value');
      }
    }

    // Check that either script or scriptPath is specified, but not both
    if (jobData.script && jobData.scriptPath) {
      throw new Error('Cannot specify both script content and scriptPath. Use either script to create a new script or scriptPath to reference an existing script.');
    }

    // Validate convert_to_unix if provided
    if (jobData.convert_to_unix !== undefined && typeof jobData.convert_to_unix !== 'boolean') {
      throw new Error('convert_to_unix must be a boolean value');
    }
  }

  /**
   * Creates a new cron job
   * @param {Object} jobData - Cron job data {name, schedule, command, script?, scriptPath?, enabled?, convert_to_unix?}
   * @returns {Promise<Object>} Created cron job
   */
  async createCronJob(jobData) {
    try {
      this._validateCronJob(jobData);

      const cronJobs = await this.getCronJobs();

      // Check if name already exists
      const existingJob = cronJobs.find(job => job.name === jobData.name);
      if (existingJob) {
        throw new Error(`A Cron-Job with the name "${jobData.name}" already exists`);
      }

      let scriptPath = null;
      let finalCommand = jobData.command || null;

      // If script content is provided, create the script
      if (jobData.script) {
        const convertToUnix = jobData.convert_to_unix || false;
        scriptPath = await this._createCronScript(jobData.name, jobData.script, convertToUnix);
        // Set the command to the created script with output suppression
        finalCommand = `bash ${scriptPath} > /dev/null 2>&1`;
      }

      // If scriptPath is provided, use it
      if (jobData.scriptPath) {
        scriptPath = jobData.scriptPath;
        // Check if the script exists
        try {
          await fs.access(scriptPath);
        } catch (error) {
          throw new Error(`Referenced script does not exist: ${scriptPath}`);
        }
        // Set the command to the referenced script with output suppression
        finalCommand = `bash ${scriptPath} > /dev/null 2>&1`;
      }

      // Ensure we have a command at this point
      if (!finalCommand) {
        throw new Error('No command could be determined. Provide either command, script, or scriptPath.');
      }

      // Create new job
      const newJob = {
        id: this._generateUniqueId(cronJobs),
        name: jobData.name,
        schedule: jobData.schedule,
        command: finalCommand,
        enabled: jobData.enabled !== undefined ? jobData.enabled : true,
        scriptPath: scriptPath
      };

      cronJobs.push(newJob);
      await this._saveCronJobs(cronJobs);

      // Cron-Konfiguration aktualisieren
      await execPromise('/usr/local/bin/mos-cron_update');

      return newJob;
    } catch (error) {
      throw new Error(`Error creating Cron-Job: ${error.message}`);
    }
  }

  /**
   * Sucht einen Cron-Job nach ID oder Name
   * @param {string} identifier - ID oder Name des Cron-Jobs
   * @returns {Promise<Object>} Gefundener Cron-Job oder null
   */
  async findCronJob(identifier) {
    const cronJobs = await this.getCronJobs();
    return cronJobs.find(job => job.id === identifier || job.name === identifier) || null;
  }

  /**
   * Aktualisiert einen Cron-Job
   * @param {string} identifier - ID oder Name des zu aktualisierenden Jobs
   * @param {Object} updates - Felder die aktualisiert werden sollen
   * @returns {Promise<Object>} Aktualisierter Cron-Job
   */
  async updateCronJob(identifier, updates) {
    try {
      this._validateCronJob(updates, true);

      const cronJobs = await this.getCronJobs();
      const jobIndex = cronJobs.findIndex(job => job.id === identifier || job.name === identifier);

      if (jobIndex === -1) {
        throw new Error(`Cron-Job with ID/Name "${identifier}" not found`);
      }

      // Check if new name already exists (if name is changed)
      if (updates.name && updates.name !== cronJobs[jobIndex].name) {
        const existingJob = cronJobs.find(job => job.name === updates.name);
        if (existingJob) {
          throw new Error(`A Cron-Job with the name "${updates.name}" already exists`);
        }
      }

      // Apply updates (only allowed fields)
      const allowedFields = ['name', 'schedule', 'command', 'enabled'];
      for (const field of allowedFields) {
        if (updates[field] !== undefined) {
          cronJobs[jobIndex][field] = updates[field];
        }
      }

      // Execute script updates
      if (updates.script || updates.scriptPath) {
        let newScriptPath = null;
        let newCommand = cronJobs[jobIndex].command;

        // If script content is provided, create a new script
        if (updates.script) {
          // Delete old script if it exists
          if (cronJobs[jobIndex].scriptPath) {
            try {
              await fs.unlink(cronJobs[jobIndex].scriptPath);
            } catch (error) {
              console.warn(`Warning: Could not delete old script file ${cronJobs[jobIndex].scriptPath}: ${error.message}`);
            }
          }

          const convertToUnix = updates.convert_to_unix || false;
          newScriptPath = await this._createCronScript(updates.name || cronJobs[jobIndex].name, updates.script, convertToUnix);
          newCommand = `bash ${newScriptPath} > /dev/null 2>&1`;
        }

        // If scriptPath is provided, use it
        if (updates.scriptPath) {
          newScriptPath = updates.scriptPath;
          // Check if the script exists
          try {
            await fs.access(newScriptPath);
          } catch (error) {
            throw new Error(`Referenced script does not exist: ${newScriptPath}`);
          }
          newCommand = `bash ${newScriptPath} > /dev/null 2>&1`;
        }

        cronJobs[jobIndex].scriptPath = newScriptPath;
        cronJobs[jobIndex].command = newCommand;
      }

      await this._saveCronJobs(cronJobs);

      // Update Cron configuration
      await execPromise('/usr/local/bin/mos-cron_update');

      return cronJobs[jobIndex];
    } catch (error) {
      throw new Error(`Error updating Cron-Job: ${error.message}`);
    }
  }

  /**
   * Deletes a Cron-Job
   * @param {string} identifier - ID or name of the job to delete
   * @param {boolean} deleteScript - Whether the associated script should also be deleted (default: false)
   * @returns {Promise<Object>} Deleted Cron-Job
   */
  async deleteCronJob(identifier, deleteScript = false) {
    try {
      const cronJobs = await this.getCronJobs();
      const jobIndex = cronJobs.findIndex(job => job.id === identifier || job.name === identifier);

      if (jobIndex === -1) {
        throw new Error(`Cron-Job with ID/Name "${identifier}" not found`);
      }

      const deletedJob = cronJobs[jobIndex];

      // Delete the script if it exists and deleteScript is true
      if (deleteScript && deletedJob.scriptPath) {
        try {
          await fs.unlink(deletedJob.scriptPath);
          console.log(`Script deleted: ${deletedJob.scriptPath}`);
        } catch (error) {
          console.warn(`Warning: Could not delete script file ${deletedJob.scriptPath}: ${error.message}`);
        }
      }

      cronJobs.splice(jobIndex, 1);

      await this._saveCronJobs(cronJobs);

      // Update Cron configuration
      await execPromise('/usr/local/bin/mos-cron_update');

      return deletedJob;
    } catch (error) {
      throw new Error(`Error deleting Cron-Job: ${error.message}`);
    }
  }

  /**
   * Gets a specific Cron-Job by ID or name
   * @param {string} identifier - ID or name of the Cron-Job
   * @returns {Promise<Object>} Cron-Job with status
   */
  async getCronJob(identifier) {
    const job = await this.findCronJob(identifier);
    if (!job) {
      throw new Error(`Cron-Job with ID/Name "${identifier}" not found`);
    }

    // Always add status
    return {
      ...job,
      status: await this._getJobStatus(job)
    };
  }

  /**
   * Activates a Cron-Job
   * @param {string} identifier - ID or name of the Cron-Job
   * @returns {Promise<Object>} Activated Cron-Job
   */
  async enableCronJob(identifier) {
    try {
      const cronJobs = await this.getCronJobs();
      const jobIndex = cronJobs.findIndex(job => job.id === identifier || job.name === identifier);

      if (jobIndex === -1) {
        throw new Error(`Cron-Job with ID/Name "${identifier}" not found`);
      }

      cronJobs[jobIndex].enabled = true;
      await this._saveCronJobs(cronJobs);

      // Cron configuration updated
      await execPromise('/usr/local/bin/mos-cron_update');

      return cronJobs[jobIndex];
    } catch (error) {
      throw new Error(`Error enabling Cron-Job: ${error.message}`);
    }
  }

  /**
   * Deactivates a Cron-Job
   * @param {string} identifier - ID or name of the Cron-Job
   * @returns {Promise<Object>} Deactivated Cron-Job
   */
  async disableCronJob(identifier) {
    try {
      const cronJobs = await this.getCronJobs();
      const jobIndex = cronJobs.findIndex(job => job.id === identifier || job.name === identifier);

      if (jobIndex === -1) {
        throw new Error(`Cron-Job with ID/Name "${identifier}" not found`);
      }

      cronJobs[jobIndex].enabled = false;
      await this._saveCronJobs(cronJobs);

      // Cron configuration updated
      await execPromise('/usr/local/bin/mos-cron_update');

      return cronJobs[jobIndex];
    } catch (error) {
      throw new Error(`Error disabling Cron-Job: ${error.message}`);
    }
  }

  /**
   * Lists all available scripts in the Cron-Script directory
   * @returns {Promise<Array>} Array of available scripts
   */
  async listCronScripts() {
    try {
      const scriptsDir = '/boot/optional/scripts/cron';

      try {
        await fs.access(scriptsDir);
      } catch (error) {
        if (error.code === 'ENOENT') {
          return [];
        } else {
          throw error;
        }
      }

      const files = await fs.readdir(scriptsDir);
      const scripts = [];

      for (const file of files) {
        if (file.endsWith('.sh')) {
          const filePath = path.join(scriptsDir, file);
          try {
            const stats = await fs.stat(filePath);
            scripts.push({
              name: file,
              path: filePath,
              size: stats.size,
              created: stats.birthtime,
              modified: stats.mtime
            });
          } catch (error) {
            console.warn(`Warning: Could not read file info for ${file}: ${error.message}`);
          }
        }
      }

      return scripts.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      throw new Error(`Error listing cron scripts: ${error.message}`);
    }
  }

  /**
   * Gets the content of a Cron-Script
   * @param {string} scriptName - Name of the script (with or without .sh) or job name
   * @returns {Promise<Object>} Script information and content
   */
  async getCronScript(scriptName) {
    try {
      const scriptsDir = '/boot/optional/scripts/cron';
      let scriptPath = null;

      // Add .sh if not present
      let scriptFileName = scriptName.endsWith('.sh') ? scriptName : scriptName + '.sh';
      let directPath = path.join(scriptsDir, scriptFileName);

      // Check if the script is in /usr/local/bin (protected path)
      if (directPath.startsWith('/usr/local/bin')) {
        throw new Error('Editing scripts in /usr/local/bin not allowed');
      }

      // First try: direct script file access
      try {
        await fs.access(directPath);
        scriptPath = directPath;
      } catch (error) {
        // If direct access fails, try to find by job name
        if (error.code === 'ENOENT') {
          const jobs = await this.getCronJobs();
          const job = jobs.find(j => j.name === scriptName || j.id === scriptName);

          if (job) {
            // Try to get scriptPath from job
            if (job.scriptPath) {
              scriptPath = job.scriptPath;
            } else if (job.command) {
              // Extract from command
              const extractedPath = this._extractScriptPathFromCommand(job.command);
              if (extractedPath) {
                scriptPath = extractedPath;
              }
            }
          }

          // If still no path found, throw error
          if (!scriptPath) {
            throw new Error(`Script '${scriptName}' not found`);
          }

          // Verify the extracted path exists
          try {
            await fs.access(scriptPath);
          } catch (err) {
            throw new Error(`Script '${scriptName}' not found (resolved path: ${scriptPath} does not exist)`);
          }
        } else {
          throw error;
        }
      }

      // Check if resolved scriptPath is in /usr/local/bin (protected path)
      if (scriptPath && scriptPath.startsWith('/usr/local/bin')) {
        throw new Error('Editing scripts in /usr/local/bin not allowed');
      }

      const stats = await fs.stat(scriptPath);
      const content = await fs.readFile(scriptPath, 'utf8');

      return {
        name: path.basename(scriptPath),
        path: scriptPath,
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        content: content
      };
    } catch (error) {
      throw new Error(`Error reading cron script: ${error.message}`);
    }
  }

  /**
   * Updates the content of a Cron-Script
   * @param {string} scriptName - Name of the script (with or without .sh) or job name
   * @param {string} newContent - New script content
   * @returns {Promise<Object>} Updated script
   */
  async updateCronScript(scriptName, newContent) {
    try {
      const scriptsDir = '/boot/optional/scripts/cron';
      let scriptPath = null;

      // Add .sh if not present
      let scriptFileName = scriptName.endsWith('.sh') ? scriptName : scriptName + '.sh';
      let directPath = path.join(scriptsDir, scriptFileName);

      // Check if the script is in /usr/local/bin (protected path)
      if (directPath.startsWith('/usr/local/bin')) {
        throw new Error('Editing scripts in /usr/local/bin not allowed');
      }

      // First try: direct script file access
      try {
        await fs.access(directPath);
        scriptPath = directPath;
      } catch (error) {
        // If direct access fails, try to find by job name
        if (error.code === 'ENOENT') {
          const jobs = await this.getCronJobs();
          const job = jobs.find(j => j.name === scriptName || j.id === scriptName);

          if (job) {
            // Try to get scriptPath from job
            if (job.scriptPath) {
              scriptPath = job.scriptPath;
            } else if (job.command) {
              // Extract from command
              const extractedPath = this._extractScriptPathFromCommand(job.command);
              if (extractedPath) {
                scriptPath = extractedPath;
              }
            }
          }

          // If still no path found, throw error
          if (!scriptPath) {
            throw new Error(`Script '${scriptName}' not found`);
          }

          // Verify the extracted path exists
          try {
            await fs.access(scriptPath);
          } catch (err) {
            throw new Error(`Script '${scriptName}' not found (resolved path: ${scriptPath} does not exist)`);
          }
        } else {
          throw error;
        }
      }

      // Check if resolved scriptPath is in /usr/local/bin (protected path)
      if (scriptPath && scriptPath.startsWith('/usr/local/bin')) {
        throw new Error('Editing scripts in /usr/local/bin not allowed');
      }

      // Update script content
      await fs.writeFile(scriptPath, newContent, 'utf8');

      // Make sure the file is executable
      await execPromise(`chmod +x "${scriptPath}"`);

      const stats = await fs.stat(scriptPath);
      const content = await fs.readFile(scriptPath, 'utf8');

      return {
        name: path.basename(scriptPath),
        path: scriptPath,
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        content: content
      };
    } catch (error) {
      throw new Error(`Error updating cron script: ${error.message}`);
    }
  }

  /**
   * Extracts a script path from a command string
   * @param {string} command - Command string
   * @returns {string|null} Extracted script path or null
   * @private
   */
  _extractScriptPathFromCommand(command) {
    if (!command) {
      return null;
    }

    // Remove output redirections (> /dev/null 2>&1, etc.)
    let cmd = command.split('>')[0].trim();

    // Remove shell prefix (bash, sh, zsh, etc.)
    cmd = cmd.replace(/^(bash|sh|zsh|ksh|dash)\s+/, '').trim();

    // Check if the remaining part looks like a file path
    // Should start with / or ./ or ../ and end with common script extensions or no extension
    if (cmd.match(/^(\/|\.\/|\.\.\/)[^\s]+/) || cmd.match(/^\/[^\s]+\.sh$/)) {
      // Extract just the path (first word, no arguments)
      const pathMatch = cmd.match(/^([^\s]+)/);
      if (pathMatch) {
        return pathMatch[1];
      }
    }

    return null;
  }

  /**
   * Extracts the search pattern from a cron job for process detection
   * @param {Object} job - Cron job object
   * @returns {string} Search pattern for pgrep/pkill
   * @private
   */
  _getProcessSearchPattern(job) {
    let searchPattern = '';

    // First try to use stored scriptPath
    if (job.scriptPath) {
      searchPattern = job.scriptPath;
    }
    // Otherwise extract from command
    else if (job.command) {
      const extractedPath = this._extractScriptPathFromCommand(job.command);
      if (extractedPath) {
        searchPattern = extractedPath;
      } else {
        // Fallback: extract the main command (without redirections)
        let cmd = job.command.split('>')[0].trim();
        // Strip bash/sh/zsh/etc. from the beginning to get the actual script/command
        cmd = cmd.replace(/^(bash|sh|zsh|ksh|dash)\s+/, '');
        searchPattern = cmd;
      }
    }

    return searchPattern;
  }

  /**
   * Checks if a cron job is currently running
   * @param {Object} job - Cron job object
   * @returns {Promise<boolean>} True if the job is running
   * @private
   */
  async _isJobRunning(job) {
    try {
      const searchPattern = this._getProcessSearchPattern(job);

      if (!searchPattern) {
        return false;
      }

      try {
        // Use ps aux with grep to find processes
        // grep -F uses fixed string matching (no regex interpretation)
        // Multiple grep -v to exclude:
        // - grep itself (appears in process list while running)
        // - ps aux command
        // - This Node.js process checking the status
        const { stdout } = await execPromise(
          `ps aux | grep -F "${searchPattern}" | grep -v "grep -F" | grep -v "ps aux" | grep -v "${process.pid}"`
        );

        // Parse the output - each line is a process
        const lines = stdout.trim().split('\n').filter(line => {
          if (!line || line.length === 0) return false;

          // Additional filtering: Make sure the line actually contains our script path
          // and is running bash/sh (not just any process that happens to have the path in args)
          const lowerLine = line.toLowerCase();
          const isActualScript = (
            lowerLine.includes('bash') ||
            lowerLine.includes('/bin/sh') ||
            lowerLine.includes('sleep') ||  // Long-running scripts often have sleep
            line.includes(searchPattern)
          );

          return isActualScript;
        });

        return lines.length > 0;
      } catch (error) {
        // grep returns exit code 1 when no matches found - this is expected
        if (error.code === 1 || (error.stderr && error.stderr === '')) {
          return false;
        }
        // Only log unexpected errors
        if (error.code !== 1) {
          console.warn(`Unexpected error in _isJobRunning: ${error.message}`);
        }
        return false;
      }
    } catch (error) {
      console.warn(`Warning: Could not check if job is running: ${error.message}`);
      return false;
    }
  }

  /**
   * Gets the running status for a cron job
   * @param {Object} job - Cron job object
   * @returns {Promise<string>} Status: 'running' or 'stopped'
   * @private
   */
  async _getJobStatus(job) {
    const isRunning = await this._isJobRunning(job);
    return isRunning ? 'running' : 'stopped';
  }

  /**
   * Starts a cron job manually (runs it in the background)
   * @param {string} identifier - ID or name of the Cron-Job
   * @returns {Promise<Object>} Started job with PID
   */
  async startCronJob(identifier) {
    try {
      const job = await this.findCronJob(identifier);
      if (!job) {
        throw new Error(`Cron-Job with ID/Name "${identifier}" not found`);
      }

      // Check if the job is already running
      if (await this._isJobRunning(job)) {
        throw new Error(`Cron-Job "${job.name}" is already running`);
      }

      // Extract the actual command without output redirection for manual execution
      let commandToRun = job.command;

      // Run the command in the background with nohup
      // We use nohup to keep the process running even if the API terminates
      const { stdout } = await execPromise(`nohup ${commandToRun} &`);

      // Get the status after starting
      const status = await this._getJobStatus(job);

      return {
        ...job,
        status,
        message: `Cron-Job "${job.name}" started successfully`
      };
    } catch (error) {
      throw new Error(`Error starting Cron-Job: ${error.message}`);
    }
  }

  /**
   * Gets the PIDs of processes running a specific job
   * @param {Object} job - Cron job object
   * @returns {Promise<Array<number>>} Array of PIDs
   * @private
   */
  async _getJobPids(job) {
    try {
      const searchPattern = this._getProcessSearchPattern(job);
      if (!searchPattern) {
        return [];
      }

      const { stdout } = await execPromise(
        `ps aux | grep -F "${searchPattern}" | grep -v "grep -F" | grep -v "ps aux" | grep -v "${process.pid}" | awk '{print $2}'`
      );

      const pids = stdout.trim().split('\n')
        .filter(pid => pid && pid.length > 0)
        .map(pid => parseInt(pid, 10))
        .filter(pid => !isNaN(pid) && pid !== process.pid);

      return pids;
    } catch (error) {
      // grep returns exit code 1 when no matches found
      if (error.code === 1) {
        return [];
      }
      return [];
    }
  }

  /**
   * Stops a running cron job
   * @param {string} identifier - ID or name of the Cron-Job
   * @returns {Promise<Object>} Stopped job
   */
  async stopCronJob(identifier) {
    try {
      const job = await this.findCronJob(identifier);
      if (!job) {
        throw new Error(`Cron-Job with ID/Name "${identifier}" not found`);
      }

      // Check if the job is running and get PIDs
      const pids = await this._getJobPids(job);

      if (pids.length === 0) {
        throw new Error(`Cron-Job "${job.name}" is not currently running`);
      }

      // Kill each PID individually for precise control
      for (const pid of pids) {
        try {
          await execPromise(`kill ${pid}`);
        } catch (error) {
          // Process might have already terminated
          console.warn(`Warning: Could not kill PID ${pid}: ${error.message}`);
        }
      }

      // Give it a moment to terminate
      await new Promise(resolve => setTimeout(resolve, 500));

      // If processes are still running, try SIGKILL
      const remainingPids = await this._getJobPids(job);
      for (const pid of remainingPids) {
        try {
          await execPromise(`kill -9 ${pid}`);
        } catch (error) {
          // Ignore errors
        }
      }

      // Get the status after stopping
      const status = await this._getJobStatus(job);

      return {
        ...job,
        status,
        message: `Cron-Job "${job.name}" stopped successfully`
      };
    } catch (error) {
      throw new Error(`Error stopping Cron-Job: ${error.message}`);
    }
  }

  /**
   * Reads system cron jobs from crontab that start with "# MOS"
   * @returns {Promise<Array>} Array of system cron jobs
   */
  async getSystemCronJobs() {
    try {
      const { stdout } = await execPromise('crontab -l 2>/dev/null');
      const lines = stdout.split('\n');
      const systemJobs = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Check if this is a MOS comment line
        if (line.startsWith('# MOS ')) {
          // Extract name from comment (remove "# MOS " prefix and trailing ":")
          let name = line.substring(6).trim();
          if (name.endsWith(':')) {
            name = name.slice(0, -1).trim();
          }

          // Next non-empty line should be the cron entry
          let cronLine = null;
          for (let j = i + 1; j < lines.length; j++) {
            const nextLine = lines[j].trim();
            if (nextLine && !nextLine.startsWith('#')) {
              cronLine = nextLine;
              i = j; // Skip to this line
              break;
            }
          }

          if (cronLine) {
            let schedule, command;

            // Handle special schedules like @reboot
            if (cronLine.startsWith('@')) {
              const parts = cronLine.split(/\s+/);
              schedule = parts[0];
              command = parts.slice(1).join(' ');
            } else {
              // Standard cron: first 5 fields are the schedule
              const parts = cronLine.split(/\s+/);
              if (parts.length >= 6) {
                schedule = parts.slice(0, 5).join(' ');
                command = parts.slice(5).join(' ');
              } else {
                continue;
              }
            }

            systemJobs.push({
              name,
              schedule,
              command
            });
          }
        }
      }

      // Add running status for each system job
      const jobsWithStatus = await Promise.all(
        systemJobs.map(async (job) => ({
          ...job,
          status: await this._getJobStatus(job)
        }))
      );

      return jobsWithStatus;
    } catch (error) {
      // If crontab is empty or not available
      if (error.message.includes('no crontab')) {
        return [];
      }
      throw new Error(`Error reading system cron jobs: ${error.message}`);
    }
  }

  /**
   * Deletes a Cron-Script
   * @param {string} scriptName - Name of the script (with or without .sh) or job name
   * @param {boolean} deleteDependentJobs - Whether dependent Cron-Jobs should also be deleted (default: false)
   * @returns {Promise<Object>} Deleted script and deleted jobs
   */
  async deleteCronScript(scriptName, deleteDependentJobs = false) {
    try {
      const scriptsDir = '/boot/optional/scripts/cron';
      let scriptPath = null;

      // Add .sh if not present
      let scriptFileName = scriptName.endsWith('.sh') ? scriptName : scriptName + '.sh';
      let directPath = path.join(scriptsDir, scriptFileName);

      // First try: direct script file access
      try {
        await fs.access(directPath);
        scriptPath = directPath;
      } catch (error) {
        // If direct access fails, try to find by job name
        if (error.code === 'ENOENT') {
          const jobs = await this.getCronJobs();
          const job = jobs.find(j => j.name === scriptName || j.id === scriptName);

          if (job) {
            // Try to get scriptPath from job
            if (job.scriptPath) {
              scriptPath = job.scriptPath;
            } else if (job.command) {
              // Extract from command
              const extractedPath = this._extractScriptPathFromCommand(job.command);
              if (extractedPath) {
                scriptPath = extractedPath;
              }
            }
          }

          // If still no path found, throw error
          if (!scriptPath) {
            throw new Error(`Script '${scriptName}' not found`);
          }

          // Verify the extracted path exists
          try {
            await fs.access(scriptPath);
          } catch (err) {
            throw new Error(`Script '${scriptName}' not found (resolved path: ${scriptPath} does not exist)`);
          }
        } else {
          throw error;
        }
      }

      // Check if the script is used by a cron job
      const cronJobs = await this.getCronJobs();
      const usedBy = cronJobs.filter(job => {
        // Check both stored scriptPath and extracted path from command
        if (job.scriptPath === scriptPath) {
          return true;
        }
        const extractedPath = this._extractScriptPathFromCommand(job.command);
        return extractedPath === scriptPath;
      });

      let deletedJobs = [];

      if (usedBy.length > 0) {
        if (deleteDependentJobs) {
          // Delete all dependent cron jobs
          for (const job of usedBy) {
            try {
              await this.deleteCronJob(job.id, false); // Script not deleted, as we delete it separately
              deletedJobs.push(job);
            } catch (error) {
              console.warn(`Warning: Could not delete dependent cron job ${job.name}: ${error.message}`);
            }
          }
        } else {
          const jobNames = usedBy.map(job => job.name).join(', ');
          throw new Error(`Cannot delete script '${path.basename(scriptPath)}' - it is used by cron job(s): ${jobNames}. Use deleteDependentJobs=true to also delete dependent jobs.`);
        }
      }

      const stats = await fs.stat(scriptPath);
      const content = await fs.readFile(scriptPath, 'utf8');

      // Delete the file
      await fs.unlink(scriptPath);

      return {
        name: path.basename(scriptPath),
        path: scriptPath,
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        content: content,
        deletedJobs: deletedJobs,
        dependentJobsCount: usedBy.length
      };
    } catch (error) {
      throw new Error(`Error deleting cron script: ${error.message}`);
    }
  }
}

module.exports = new CronService();