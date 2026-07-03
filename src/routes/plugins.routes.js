const express = require('express');
const router = express.Router();
const pluginsService = require('../services/plugins.service');

/**
 * @swagger
 * tags:
 *   name: MOS Plugins
 *   description: MOS Plugin management
 *
 * components:
 *   schemas:
 *     Plugin:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Plugin identifier
 *           example: "example-plugin"
 *         displayName:
 *           type: string
 *           description: Human-readable plugin name
 *           example: "Example Plugin"
 *         description:
 *           type: string
 *           description: Plugin description
 *           example: "An example plugin for MOS"
 *         version:
 *           type: string
 *           description: Plugin version
 *           example: "1.0.0"
 *         icon:
 *           type: string
 *           description: MDI icon name
 *           example: "mdi-puzzle"
 *         author:
 *           type: string
 *           description: Plugin author
 *           example: ""
 *         homepage:
 *           type: string
 *           description: Plugin homepage URL
 *           example: ""
 *     PluginsResponse:
 *       type: object
 *       properties:
 *         results:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/Plugin'
 *         count:
 *           type: integer
 *           description: Total number of plugins
 */

/**
 * @swagger
 * /mos/plugins:
 *   get:
 *     summary: List all installed plugins
 *     description: Returns a list of all installed plugins with their manifest data
 *     tags: [MOS Plugins]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of plugins
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PluginsResponse'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 */
router.get('/', async (req, res) => {
  try {
    const result = await pluginsService.getPlugins();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: `Error listing plugins: ${error.message}` });
  }
});

/**
 * @swagger
 * /mos/plugins/query:
 *   post:
 *     summary: Query a plugin command
 *     description: Executes a command from /usr/bin/plugins and returns output. Symlinks are allowed but their targets are validated. Dangerous commands like rm, mkdir, bash, sh, etc. are blocked both by name and as symlink targets.
 *     tags: [MOS Plugins]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - command
 *             properties:
 *               command:
 *                 type: string
 *                 description: Command name (must exist in /usr/bin/plugins)
 *                 example: "nvidia-smi"
 *               args:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Command arguments
 *                 example: ["--query-gpu=temperature.gpu", "--format=csv"]
 *               timeout:
 *                 type: number
 *                 description: Timeout in seconds (0.1-60, default 10)
 *                 example: 5
 *               parse_json:
 *                 type: boolean
 *                 description: Parse output as JSON
 *                 default: false
 *     responses:
 *       200:
 *         description: Query execution result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 output:
 *                   oneOf:
 *                     - type: string
 *                     - type: object
 *                   description: Command output (string or JSON if parse_json=true)
 *                 exit_code:
 *                   type: integer
 *                 duration_ms:
 *                   type: integer
 *                   description: Execution time in milliseconds
 *       400:
 *         description: Invalid request or command not allowed
 *       500:
 *         description: Server error
 */
router.post('/query', async (req, res) => {
  try {
    const { command, args, timeout, parse_json } = req.body;
    const result = await pluginsService.executeQuery(command, args, {
      timeout,
      parse_json
    });
    res.json(result);
  } catch (error) {
    if (error.message.includes('required') ||
        error.message.includes('not found') ||
        error.message.includes('Invalid') ||
        error.message.includes('Only command') ||
        error.message.includes('not allowed') ||
        error.message.includes('forbidden') ||
        error.message.includes('validation failed')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/plugins/releases:
 *   post:
 *     summary: Get GitHub releases for a plugin repository
 *     description: Fetches and caches up to 50 releases from a GitHub repository
 *     tags: [MOS Plugins]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - repository
 *             properties:
 *               repository:
 *                 type: string
 *                 description: GitHub repository URL
 *                 example: "https://github.com/mos-nas/mos-intel-gpu-top"
 *               refresh:
 *                 type: boolean
 *                 description: Force refresh cache
 *                 default: false
 *     responses:
 *       200:
 *         description: Releases data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 repository:
 *                   type: string
 *                 owner:
 *                   type: string
 *                 repo:
 *                   type: string
 *                 timestamp:
 *                   type: integer
 *                 releases:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       tag:
 *                         type: string
 *                       name:
 *                         type: string
 *                       published_at:
 *                         type: string
 *                       prerelease:
 *                         type: boolean
 *                       latest:
 *                         type: boolean
 *                         description: True for the first (most recent) release
 *                       assets:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             name:
 *                               type: string
 *                             size:
 *                               type: integer
 *                             download_url:
 *                               type: string
 *       400:
 *         description: Invalid repository URL
 *       404:
 *         description: Repository not found
 *       500:
 *         description: Server error
 */
router.post('/releases', async (req, res) => {
  try {
    const { repository, refresh } = req.body;
    const result = await pluginsService.getReleases(repository, refresh === true);
    res.json(result);
  } catch (error) {
    if (error.message.includes('required') || error.message.includes('Invalid')) {
      res.status(400).json({ error: error.message });
    } else if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/plugins/install:
 *   post:
 *     summary: Install a plugin from Hub template
 *     description: Downloads and installs a plugin using a Hub template path and release tag
 *     tags: [MOS Plugins]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - template
 *               - tag
 *             properties:
 *               template:
 *                 type: string
 *                 description: Absolute path to Hub plugin template JSON
 *                 example: "/var/mos/hub/repositories/owner/repo/plugins/intel-gpu-top.json"
 *               tag:
 *                 type: string
 *                 description: Release tag to install
 *                 example: "v1.0.0"
 *     responses:
 *       200:
 *         description: Installation started
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid request or template not found
 *       500:
 *         description: Server error
 */
router.post('/install', async (req, res) => {
  const { template, tag } = req.body;

  // Validate input before starting background job
  if (!template || typeof template !== 'string') {
    return res.status(400).json({ error: 'Template path is required' });
  }
  if (!tag || typeof tag !== 'string') {
    return res.status(400).json({ error: 'Tag is required' });
  }

  // Start installation in background
  pluginsService.installPlugin(template, tag).catch(() => {
    // Errors are handled via notifications
  });

  res.json({ status: 'started', message: 'Installation started in background' });
});

/**
 * @swagger
 * /mos/plugins/settings/{pluginName}:
 *   get:
 *     summary: Get plugin settings
 *     description: Retrieves settings.json for a specific plugin
 *     tags: [MOS Plugins]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: pluginName
 *         required: true
 *         schema:
 *           type: string
 *         description: Plugin name
 *     responses:
 *       200:
 *         description: Plugin settings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       400:
 *         description: Invalid plugin name
 *       404:
 *         description: Settings not found
 *       500:
 *         description: Server error
 *   post:
 *     summary: Update plugin settings
 *     description: Writes settings.json for a specific plugin
 *     tags: [MOS Plugins]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: pluginName
 *         required: true
 *         schema:
 *           type: string
 *         description: Plugin name
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *           description: Settings object to save
 *     responses:
 *       200:
 *         description: Saved settings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       400:
 *         description: Invalid request
 *       404:
 *         description: Plugin not found
 *       500:
 *         description: Server error
 */
router.get('/settings/:pluginName', async (req, res) => {
  try {
    const { pluginName } = req.params;
    const settings = await pluginsService.getPluginSettings(pluginName);
    res.json(settings);
  } catch (error) {
    if (error.message.includes('Invalid')) {
      res.status(400).json({ error: error.message });
    } else if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

router.post('/settings/:pluginName', async (req, res) => {
  try {
    const { pluginName } = req.params;
    const settings = await pluginsService.setPluginSettings(pluginName, req.body);
    res.json(settings);
  } catch (error) {
    if (error.message.includes('Invalid') || error.message.includes('required')) {
      res.status(400).json({ error: error.message });
    } else if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/plugins/updatecheck:
 *   post:
 *     summary: Check for plugin updates
 *     description: Compares installed plugin versions with latest available on GitHub
 *     tags: [MOS Plugins]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               notify:
 *                 type: boolean
 *                 description: Send notification if updates are found
 *     responses:
 *       200:
 *         description: Update check results
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   plugin:
 *                     type: string
 *                   installed:
 *                     type: string
 *                   available:
 *                     type: string
 *                   repository:
 *                     type: string
 *                   update_available:
 *                     type: boolean
 *       500:
 *         description: Server error
 */
router.post('/updatecheck', async (req, res) => {
  try {
    const { notify } = req.body || {};
    const result = await pluginsService.checkUpdates({ notify: !!notify });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/plugins/update:
 *   post:
 *     summary: Update plugins
 *     description: Updates one or all plugins with available updates
 *     tags: [MOS Plugins]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               plugin:
 *                 type: string
 *                 description: Plugin name to update (optional, if empty updates all)
 *     responses:
 *       200:
 *         description: Update results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 updated:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       plugin:
 *                         type: string
 *                       from:
 *                         type: string
 *                       to:
 *                         type: string
 *                       success:
 *                         type: boolean
 *                       error:
 *                         type: string
 *       400:
 *         description: No update check performed or plugin not found
 *       500:
 *         description: Server error
 */
router.post('/update', async (req, res) => {
  const { plugin } = req.body || {};

  // Start update in background
  pluginsService.updatePlugins(plugin).catch(() => {
    // Errors are handled via notifications
  });

  res.json({ status: 'started', message: plugin ? `Update for ${plugin} started` : 'Update for all plugins started' });
});

/**
 * @swagger
 * /mos/plugins/delete/{pluginName}:
 *   delete:
 *     summary: Delete a plugin
 *     description: Removes a plugin including dpkg package and all related files
 *     tags: [MOS Plugins]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: pluginName
 *         required: true
 *         schema:
 *           type: string
 *         description: Plugin name to delete
 *     responses:
 *       200:
 *         description: Plugin deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 plugin:
 *                   type: string
 *                 removed:
 *                   type: object
 *                   properties:
 *                     config:
 *                       type: string
 *                     web:
 *                       type: string
 *       400:
 *         description: Plugin not found
 *       500:
 *         description: Server error
 */
router.delete('/delete/:pluginName', async (req, res) => {
  try {
    const { pluginName } = req.params;

    if (!pluginName) {
      return res.status(400).json({ error: 'Plugin name is required' });
    }

    const result = await pluginsService.uninstallPlugin(pluginName);
    res.json(result);
  } catch (error) {
    if (error.message.includes('not found') || error.message.includes('Invalid')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/plugins/executefunction:
 *   post:
 *     summary: Execute a function from a plugin
 *     description: Executes a specified function from the plugin's functions file. Some functions are blocked for security.
 *     tags: [MOS Plugins]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - plugin
 *               - function
 *             properties:
 *               plugin:
 *                 type: string
 *                 description: Plugin name
 *               function:
 *                 type: string
 *                 description: Function name to execute
 *               name:
 *                 type: string
 *                 description: Optional display name for notifications
 *               restart:
 *                 type: boolean
 *                 description: Show reboot message on success
 *                 default: false
 *     responses:
 *       200:
 *         description: Function execution started
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid request, blocked function, or no functions file
 *       500:
 *         description: Server error
 */
router.post('/executefunction', async (req, res) => {
  const { plugin, function: functionName, name, restart } = req.body || {};

  if (!plugin) {
    return res.status(400).json({ error: 'Plugin name is required' });
  }
  if (!functionName) {
    return res.status(400).json({ error: 'Function name is required' });
  }

  try {
    // Validate plugin exists, function file exists, and function is not blocked
    await pluginsService.validateFunction(plugin, functionName);

    // Start execution in background
    pluginsService.executeFunction(plugin, functionName, name, restart === true).catch((err) => {
      console.error(`[executefunction] ${plugin}/${functionName} failed:`, err.message);
    });

    res.json({ status: 'started', message: `Executing ${name || functionName}` });

  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/plugins/driver/{pluginName}:
 *   get:
 *     summary: Get driver package info for a driver plugin
 *     description: Returns the installed driver package path and name for the current kernel. Only works for driver plugins.
 *     tags: [MOS Plugins]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: pluginName
 *         required: true
 *         schema:
 *           type: string
 *         description: Plugin name
 *     responses:
 *       200:
 *         description: Driver package info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 plugin:
 *                   type: string
 *                 kernel:
 *                   type: string
 *                 package:
 *                   type: string
 *                 path:
 *                   type: string
 *                 directory:
 *                   type: string
 *       400:
 *         description: Plugin not found, not a driver, or no package found
 *       500:
 *         description: Server error
 */
router.get('/driver/:pluginName', async (req, res) => {
  try {
    const { pluginName } = req.params;
    const result = await pluginsService.getDriverPackage(pluginName);
    res.json(result);
  } catch (error) {
    if (error.message.includes('not found') || error.message.includes('not a driver') || error.message.includes('Invalid')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

module.exports = router;
