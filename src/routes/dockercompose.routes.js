const express = require('express');
const router = express.Router();
const { checkRole } = require('../middleware/auth.middleware');
const dockerComposeService = require('../services/dockercompose.service');

/**
 * @swagger
 * tags:
 *   name: Docker Compose
 *   description: Docker Compose Stack Management (Admin only)
 *
 * components:
 *   schemas:
 *     ComposeStack:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Stack name
 *           example: "wordpress"
 *         services:
 *           type: array
 *           items:
 *             type: string
 *           description: Service names in the stack
 *           example: ["web", "db"]
 *         containers:
 *           type: array
 *           items:
 *             type: string
 *           description: Container names
 *           example: ["wordpress_web_1", "wordpress_db_1"]
 *         iconUrl:
 *           type: string
 *           nullable: true
 *           description: Icon URL
 *           example: "https://example.com/icon.png"
 *         running:
 *           type: boolean
 *           description: Whether stack is running (from docker-compose ls)
 *           example: true
 *         autostart:
 *           type: boolean
 *           description: Whether stack should autostart on system boot
 *           example: false
 *         webui:
 *           type: string
 *           nullable: true
 *           description: WebUI URL for the stack
 *           example: "http://10.0.0.1:3001"
 *         no_autoupdate:
 *           type: boolean
 *           description: Whether automatic updates are disabled for this stack
 *           default: false
 *           example: false
 */

// Only admin can access these routes
router.use(checkRole(['admin']));

/**
 * @swagger
 * /docker/mos/compose/stacks:
 *   get:
 *     summary: Get all compose stacks
 *     description: Retrieve all Docker Compose stacks (admin only)
 *     tags: [Docker Compose]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of stacks
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ComposeStack'
 *             example:
 *               - name: "wordpress"
 *                 services: ["web", "db"]
 *                 containers: ["wordpress_web_1", "wordpress_db_1"]
 *                 iconUrl: "https://example.com/icon.png"
 *                 running: true
 *               - name: "nextcloud"
 *                 services: ["app", "db", "redis"]
 *                 containers: ["nextcloud_app_1", "nextcloud_db_1", "nextcloud_redis_1"]
 *                 iconUrl: null
 *                 running: false
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */
router.get('/stacks', async (req, res) => {
  try {
    const stacks = await dockerComposeService.getStacks();
    res.json(stacks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /docker/mos/compose/stacks/{name}:
 *   get:
 *     summary: Get a specific compose stack
 *     description: Retrieve details of a specific Docker Compose stack (admin only)
 *     tags: [Docker Compose]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Stack name
 *         example: "wordpress"
 *     responses:
 *       200:
 *         description: Stack details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 name:
 *                   type: string
 *                 yaml:
 *                   type: string
 *                   description: Content of compose.yaml
 *                 env:
 *                   type: string
 *                   nullable: true
 *                   description: Content of .env file
 *                 services:
 *                   type: array
 *                   items:
 *                     type: string
 *                 containers:
 *                   type: array
 *                   items:
 *                     type: string
 *                 iconUrl:
 *                   type: string
 *                   nullable: true
 *                 running:
 *                   type: boolean
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Stack not found
 *       500:
 *         description: Server error
 */
router.get('/stacks/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const stack = await dockerComposeService.getStack(name);
    res.json(stack);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /docker/mos/compose/stacks:
 *   post:
 *     summary: Create a new compose stack
 *     description: Create and deploy a new Docker Compose stack (admin only)
 *     tags: [Docker Compose]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - yaml
 *             properties:
 *               name:
 *                 type: string
 *                 description: Stack name (alphanumeric, hyphens, underscores only)
 *                 example: "wordpress"
 *               yaml:
 *                 type: string
 *                 description: compose.yaml content
 *                 example: "version: '3.8'\nservices:\n  web:\n    image: wordpress\n  db:\n    image: mysql:8.0\n"
 *               env:
 *                 type: string
 *                 nullable: true
 *                 description: .env file content (optional)
 *                 example: "MYSQL_ROOT_PASSWORD=secret\nMYSQL_DATABASE=wordpress"
 *               icon:
 *                 type: string
 *                 nullable: true
 *                 description: Icon URL (PNG only, optional)
 *                 example: "https://example.com/wordpress.png"
 *               autostart:
 *                 type: boolean
 *                 description: Whether stack should autostart on system boot (default false)
 *                 default: false
 *                 example: false
 *               webui:
 *                 type: string
 *                 nullable: true
 *                 description: WebUI URL for the stack (also accepts web_ui_url)
 *                 example: "http://10.0.0.1:3001"
 *               web_ui_url:
 *                 type: string
 *                 nullable: true
 *                 description: Alias for webui (webui takes priority if both are provided)
 *                 example: "http://[IP]:3001"
 *     responses:
 *       201:
 *         description: Stack created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 stack:
 *                   type: string
 *                   example: "wordpress"
 *                 services:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["web", "db"]
 *                 containers:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["wordpress_web_1", "wordpress_db_1"]
 *                 iconPath:
 *                   type: string
 *                   nullable: true
 *                   example: "/var/lib/docker/mos/icons/compose/wordpress.png"
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */
router.post('/stacks', async (req, res) => {
  try {
    const { name, yaml, env, icon, autostart } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Stack name is required' });
    }

    if (!yaml) {
      return res.status(400).json({ error: 'compose.yaml content is required' });
    }

    const webuiValue = req.body.webui !== undefined ? req.body.webui : req.body.web_ui_url;
    const noAutoupdate = req.body.no_autoupdate === true;
    const result = await dockerComposeService.createStack(name, yaml, env, icon, autostart === true, webuiValue || null, noAutoupdate);
    res.status(201).json(result);
  } catch (error) {
    if (error.message.includes('already exists')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /docker/mos/compose/stacks/{name}:
 *   put:
 *     summary: Update a compose stack
 *     description: Update an existing Docker Compose stack (admin only)
 *     tags: [Docker Compose]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Stack name
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - yaml
 *             properties:
 *               yaml:
 *                 type: string
 *                 description: New compose.yaml content
 *                 example: "version: '3.8'\nservices:\n  web:\n    image: wordpress:latest\n  db:\n    image: mysql:8.0\n"
 *               env:
 *                 type: string
 *                 nullable: true
 *                 description: New .env file content (optional)
 *                 example: "MYSQL_ROOT_PASSWORD=newsecret\nMYSQL_DATABASE=wordpress"
 *               icon:
 *                 type: string
 *                 nullable: true
 *                 description: New icon URL (PNG only, optional)
 *                 example: "https://example.com/wordpress-new.png"
 *               autostart:
 *                 type: boolean
 *                 description: Whether stack should autostart on system boot
 *                 example: true
 *               webui:
 *                 type: string
 *                 nullable: true
 *                 description: WebUI URL for the stack (null to clear, also accepts web_ui_url)
 *                 example: "http://10.0.0.1:3001"
 *               web_ui_url:
 *                 type: string
 *                 nullable: true
 *                 description: Alias for webui (webui takes priority if both are provided)
 *                 example: "http://[IP]:3001"
 *     responses:
 *       200:
 *         description: Stack updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 stack:
 *                   type: string
 *                 services:
 *                   type: array
 *                   items:
 *                     type: string
 *                 containers:
 *                   type: array
 *                   items:
 *                     type: string
 *                 iconPath:
 *                   type: string
 *                   nullable: true
 *                 autostart:
 *                   type: boolean
 *                 webui:
 *                   type: string
 *                   nullable: true
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Stack not found
 *       500:
 *         description: Server error
 */
router.put('/stacks/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const { yaml, env, icon, autostart } = req.body;

    if (!yaml) {
      return res.status(400).json({ error: 'compose.yaml content is required' });
    }

    // Pass autostart as-is (null if not provided, to preserve existing value)
    const autostartValue = autostart !== undefined ? autostart === true : null;
    // webui: undefined = preserve, null = clear, string = set
    // Accept both webui and web_ui_url
    const webui = req.body.webui !== undefined ? req.body.webui : req.body.web_ui_url;
    const noAutoupdate = req.body.no_autoupdate !== undefined ? req.body.no_autoupdate === true : null;
    const result = await dockerComposeService.updateStack(name, yaml, env, icon, autostartValue, webui, noAutoupdate);
    res.json(result);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /docker/mos/compose/stacks/{name}:
 *   patch:
 *     summary: Update stack settings
 *     description: Update stack settings (like autostart, webui) without redeploying (admin only)
 *     tags: [Docker Compose]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Stack name
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               autostart:
 *                 type: boolean
 *                 description: Whether stack should autostart on system boot
 *                 example: true
 *               webui:
 *                 type: string
 *                 nullable: true
 *                 description: WebUI URL for the stack (null to clear, also accepts web_ui_url)
 *                 example: "http://10.0.0.1:3001"
 *               web_ui_url:
 *                 type: string
 *                 nullable: true
 *                 description: Alias for webui (webui takes priority if both are provided)
 *                 example: "http://[IP]:3001"
 *     responses:
 *       200:
 *         description: Settings updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 stack:
 *                   type: string
 *                 autostart:
 *                   type: boolean
 *                 webui:
 *                   type: string
 *                   nullable: true
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Stack not found
 *       500:
 *         description: Server error
 */
router.patch('/stacks/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const { autostart } = req.body;

    const settings = {};
    if (autostart !== undefined) {
      settings.autostart = autostart === true;
    }
    // Accept both webui and web_ui_url
    const webui = req.body.webui !== undefined ? req.body.webui : req.body.web_ui_url;
    if (webui !== undefined) {
      settings.webui = webui; // null clears, string sets
    }
    if (req.body.no_autoupdate !== undefined) {
      settings.no_autoupdate = req.body.no_autoupdate === true;
    }

    const result = await dockerComposeService.updateStackSettings(name, settings);
    res.json(result);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /docker/mos/compose/stacks/{name}:
 *   delete:
 *     summary: Delete a compose stack
 *     description: Stop and delete a Docker Compose stack (admin only)
 *     tags: [Docker Compose]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Stack name
 *     responses:
 *       200:
 *         description: Stack deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Stack not found
 *       500:
 *         description: Server error
 */
router.delete('/stacks/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await dockerComposeService.deleteStack(name);
    res.json(result);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /docker/mos/compose/stacks/{name}/start:
 *   post:
 *     summary: Start a compose stack
 *     description: Start all services in a Docker Compose stack (admin only)
 *     tags: [Docker Compose]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Stack name
 *     responses:
 *       200:
 *         description: Stack started successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 stack:
 *                   type: string
 *                 containers:
 *                   type: array
 *                   items:
 *                     type: string
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Stack not found
 *       500:
 *         description: Server error
 */
router.post('/stacks/:name/start', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await dockerComposeService.startStack(name);
    res.json(result);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /docker/mos/compose/stacks/{name}/stop:
 *   post:
 *     summary: Stop a compose stack
 *     description: Stop all services in a Docker Compose stack (admin only)
 *     tags: [Docker Compose]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Stack name
 *     responses:
 *       200:
 *         description: Stack stopped successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 stack:
 *                   type: string
 *                 message:
 *                   type: string
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Stack not found
 *       500:
 *         description: Server error
 */
router.post('/stacks/:name/stop', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await dockerComposeService.stopStack(name);
    res.json(result);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /docker/mos/compose/stacks/{name}/restart:
 *   post:
 *     summary: Restart a compose stack
 *     description: Restart all services in a Docker Compose stack (admin only)
 *     tags: [Docker Compose]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Stack name
 *     responses:
 *       200:
 *         description: Stack restarted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 stack:
 *                   type: string
 *                 containers:
 *                   type: array
 *                   items:
 *                     type: string
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Stack not found
 *       500:
 *         description: Server error
 */
router.post('/stacks/:name/restart', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await dockerComposeService.restartStack(name);
    res.json(result);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /docker/mos/compose/stacks/{name}/pull:
 *   post:
 *     summary: Pull images for a compose stack
 *     description: Pull latest images for all services in a Docker Compose stack (admin only)
 *     tags: [Docker Compose]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Stack name
 *     responses:
 *       200:
 *         description: Images pulled successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 stack:
 *                   type: string
 *                 output:
 *                   type: string
 *                   description: Docker compose pull output
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Stack not found
 *       500:
 *         description: Server error
 */
router.post('/stacks/:name/pull', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await dockerComposeService.pullStack(name);
    res.json(result);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /docker/mos/compose/stacks/{name}/upgrade:
 *   post:
 *     summary: Upgrade a compose stack to latest images
 *     description: Pulls latest images and redeploys the stack (admin only)
 *     tags: [Docker Compose]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Stack name
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               force_update:
 *                 type: boolean
 *                 description: Force update even if no new version available
 *                 default: false
 *     responses:
 *       200:
 *         description: Stack upgraded successfully
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Stack not found
 *       500:
 *         description: Server error
 */
router.post('/stacks/:name/upgrade', async (req, res) => {
  try {
    const { name } = req.params;
    const { force_update } = req.body || {};
    const result = await dockerComposeService.upgradeStack(name, force_update === true);
    res.json(result);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /docker/mos/compose/templates:
 *   get:
 *     summary: Get all compose template names
 *     description: Retrieve all Docker Compose template names grouped by installed and removed (admin only)
 *     tags: [Docker Compose]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Template names retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 installed:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: List of installed stack template names
 *                   example: ["wordpress", "nextcloud"]
 *                 removed:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: List of removed stack template names
 *                   example: ["gitea", "vaultwarden"]
 *             example:
 *               installed: ["wordpress", "nextcloud"]
 *               removed: ["gitea", "vaultwarden"]
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */
router.get('/templates', async (req, res) => {
  try {
    const allTemplates = await dockerComposeService.getAllTemplates();
    res.json(allTemplates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /docker/mos/compose/templates/{name}:
 *   get:
 *     summary: Get specific compose template
 *     description: Retrieve a specific Docker Compose template, preferring installed over removed if both exist (admin only)
 *     tags: [Docker Compose]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the compose stack template
 *         example: "wordpress"
 *       - in: query
 *         name: edit
 *         required: false
 *         schema:
 *           type: boolean
 *           default: false
 *         description: If false (default), appends '_new' to the name for installed stacks. If true, returns original name.
 *         example: true
 *     responses:
 *       200:
 *         description: Template retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 name:
 *                   type: string
 *                   description: Stack name (may have '_new' suffix if edit=false and source is installed)
 *                   example: "wordpress_new"
 *                 yaml:
 *                   type: string
 *                   nullable: true
 *                   description: compose.yaml content
 *                 env:
 *                   type: string
 *                   nullable: true
 *                   description: .env file content
 *                 iconUrl:
 *                   type: string
 *                   nullable: true
 *                   description: Icon URL
 *                 autostart:
 *                   type: boolean
 *                   description: Whether stack should autostart
 *                 webui:
 *                   type: string
 *                   nullable: true
 *                   description: WebUI URL
 *                 source:
 *                   type: string
 *                   enum: [installed, removed]
 *                   description: Whether template is from installed or removed stacks
 *             example:
 *               name: "wordpress_new"
 *               yaml: "version: '3'\nservices:\n  web:\n    image: wordpress:latest"
 *               env: "DB_HOST=db"
 *               iconUrl: "https://example.com/icon.png"
 *               autostart: false
 *               webui: null
 *               source: "installed"
 *       400:
 *         description: Template name is required
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Template not found
 *       500:
 *         description: Server error
 */
router.get('/templates/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const edit = req.query.edit === 'true';

    if (!name) {
      return res.status(400).json({ error: 'Template name is required' });
    }

    const template = await dockerComposeService.getTemplate(name, edit);
    res.json(template);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

module.exports = router;
