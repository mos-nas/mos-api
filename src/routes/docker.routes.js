const express = require('express');
const router = express.Router();
const axios = require('axios');
const { checkRole } = require('../middleware/auth.middleware');
const dockerService = require('../services/docker.service');
const fs = require('fs');

/**
 * @swagger
 * tags:
 *   name: Docker
 *   description: Docker Container Management (Admin only)
 *
 * components:
 *   schemas:
 *     Error:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           description: Error message
 *     DockerImage:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Container/image name
 *           example: "nginx"
 *         local:
 *           type: string
 *           description: Local image version/tag
 *           example: "1.20.2"
 *         remote:
 *           type: string
 *           description: Remote/latest image version/tag
 *           example: "1.21.0"
 *         update_available:
 *           type: boolean
 *           description: Whether an update is available
 *           example: true
 *         repository:
 *           type: string
 *           description: Docker repository
 *           example: "library/nginx"
 *         index:
 *           type: integer
 *           description: Container index/order
 *           example: 1
 *     ContainerTemplate:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Container name
 *           example: "my-nginx"
 *         image:
 *           type: string
 *           description: Docker image
 *           example: "nginx:latest"
 *         ports:
 *           type: array
 *           items:
 *             type: string
 *           description: Port mappings
 *           example: ["80:80", "443:443"]
 *         volumes:
 *           type: array
 *           items:
 *             type: string
 *           description: Volume mappings
 *           example: ["/host/path:/container/path"]
 *         environment:
 *           type: array
 *           items:
 *             type: string
 *           description: Environment variables
 *           example: ["ENV_VAR=value"]
 *         restart:
 *           type: string
 *           description: Restart policy
 *           example: "unless-stopped"
 *         no_autoupdate:
 *           type: boolean
 *           description: Whether automatic updates are disabled for this container
 *           default: false
 *           example: false
 *     ContainerIndexUpdate:
 *       type: object
 *       required:
 *         - name
 *         - index
 *       properties:
 *         name:
 *           type: string
 *           description: Container name
 *           example: "nginx"
 *         index:
 *           type: integer
 *           description: New container index/order
 *           example: 2
 *     UpdateCheckRequest:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           nullable: true
 *           description: Container name (null for all containers)
 *           example: "nginx"
 *     UpgradeRequest:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           nullable: true
 *           description: Container name (null for all containers)
 *           example: "nginx"
 *         force_update:
 *           type: boolean
 *           default: false
 *           description: Force update even if no new version available
 *           example: false
 *     XmlConvertRequest:
 *       type: object
 *       required:
 *         - url
 *       properties:
 *         url:
 *           type: string
 *           format: uri
 *           description: URL to XML template to convert
 *           example: "https://example.com/template.xml"
 *     RemoveContainerRequest:
 *       type: object
 *       required:
 *         - name
 *       properties:
 *         name:
 *           type: string
 *           description: Container name to remove
 *           example: "nginx"
 *     OperationResult:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           description: Operation successful
 *           example: true
 *         message:
 *           type: string
 *           description: Operation result message
 *           example: "Container created successfully"
 *     XmlConvertResult:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           nullable: true
 *           description: Converted container name (null if conversion failed)
 *           example: "converted-app"
 *         message:
 *           type: string
 *           description: Conversion result or error message
 *           example: "XML converted successfully"
 */

// Only admin can access this route
router.use(checkRole(['admin']));

/**
 * @swagger
 * /docker/mos/create:
 *   post:
 *     summary: Create new container from template
 *     description: Create a new Docker container from a provided template (admin only)
 *     tags: [Docker]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ContainerTemplate'
 *           example:
 *             name: "my-nginx"
 *             image: "nginx:latest"
 *             ports: ["80:80", "443:443"]
 *             volumes: ["/host/data:/var/www/html"]
 *             environment: ["NGINX_HOST=localhost"]
 *             restart: "unless-stopped"
 *     responses:
 *       200:
 *         description: Container created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OperationResult'
 *             example:
 *               success: true
 *               message: "Container 'my-nginx' created successfully"
 *       400:
 *         description: Invalid container template
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Request body must be a valid container template"
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Create new container from template
router.post('/mos/create', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'Request body must be a valid container template' });
    }

    const result = await dockerService.createContainer(req.body);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /docker/mos/remove:
 *   delete:
 *     summary: Remove container and its template
 *     description: Remove a Docker container and its associated template (admin only)
 *     tags: [Docker]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RemoveContainerRequest'
 *           example:
 *             name: "my-nginx"
 *     responses:
 *       200:
 *         description: Container removed successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OperationResult'
 *             example:
 *               success: true
 *               message: "Container 'my-nginx' and template removed successfully"
 *       400:
 *         description: Container name is required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Container name is required"
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Container not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Container 'my-nginx' not found"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Remove container and its template
router.delete('/mos/remove', async (req, res) => {
  try {
    const name = req.body.name || null;

    if (!name) {
      return res.status(400).json({ error: 'Container name is required' });
    }

    const result = await dockerService.removeContainer(name);
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
 * /docker/mos/containers:
 *   get:
 *     summary: Get Docker images with update status
 *     description: Retrieve all Docker images/containers with their update availability status (admin only)
 *     tags: [Docker]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Docker images retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/DockerImage'
 *             example:
 *               - name: "nginx"
 *                 local: "1.20.2"
 *                 remote: "1.21.0"
 *                 update_available: true
 *                 repository: "library/nginx"
 *                 index: 1
 *               - name: "mysql"
 *                 local: "8.0.28"
 *                 remote: "8.0.28"
 *                 update_available: false
 *                 repository: "library/mysql"
 *                 index: 2
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Containers file not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "containers file not found"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *   post:
 *     summary: Update Docker container indices
 *     description: Update the ordering indices for Docker containers (admin only)
 *     tags: [Docker]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: array
 *             items:
 *               $ref: '#/components/schemas/ContainerIndexUpdate'
 *           example:
 *             - name: "nginx"
 *               index: 2
 *             - name: "mysql"
 *               index: 1
 *     responses:
 *       200:
 *         description: Container indices updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/DockerImage'
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Request body must be an array of containers with name and index"
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Containers file not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Get Docker images with update status
router.get('/mos/containers', async (req, res) => {
  try {
    const images = await dockerService.getDockerImages();
    res.json(images);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Update Docker container indices
router.post('/mos/containers', async (req, res) => {
  try {
    // Check if an array of containers is present in the request body
    if (!req.body || !Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an array of containers with name and index' });
    }

    // Update container indices
    const updatedContainers = await dockerService.updateContainerIndices(req.body);

    res.json(updatedContainers);
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
 * /docker/mos/update_check:
 *   post:
 *     summary: Check for Docker updates
 *     description: Check for available updates for Docker containers (admin only)
 *     tags: [Docker]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateCheckRequest'
 *           example:
 *             name: "nginx"
 *     responses:
 *       200:
 *         description: Update check completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OperationResult'
 *             example:
 *               success: true
 *               message: "Update check completed for nginx"
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Check for Docker updates
router.post('/mos/update_check', async (req, res) => {
  try {
    // Check if a container name is present in the request body
    const name = req.body.name || null;

    // Execute update check
    const result = await dockerService.checkForUpdates(name);

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /docker/mos/upgrade:
 *   post:
 *     summary: Upgrade containers
 *     description: Upgrade Docker containers to their latest versions (admin only)
 *     tags: [Docker]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpgradeRequest'
 *           example:
 *             name: "nginx"
 *             force_update: false
 *     responses:
 *       200:
 *         description: Container upgrade completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OperationResult'
 *             example:
 *               success: true
 *               message: "Container nginx upgraded successfully"
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Upgrade containers
router.post('/mos/upgrade', async (req, res) => {
  try {
    // Check if a container name is present in the request body
    const name = req.body.name || null;
    const forceUpdate = req.body.force_update || false;

    // Execute upgrade
    const result = await dockerService.Upgrade(name, forceUpdate);

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /docker/mos/xml_convert:
 *   post:
 *     summary: Convert XML using URL
 *     description: Convert XML template from URL to Docker container configuration (admin only)
 *     tags: [Docker]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/XmlConvertRequest'
 *           example:
 *             url: "https://raw.githubusercontent.com/user/repo/main/template.xml"
 *     responses:
 *       200:
 *         description: XML converted successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/XmlConvertResult'
 *             example:
 *               name: "converted-app"
 *               message: "XML template converted successfully"
 *       400:
 *         description: URL is required or XML conversion failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               missing_url:
 *                 summary: Missing URL
 *                 value:
 *                   error: "URL is required"
 *               invalid_xml:
 *                 summary: Invalid XML data
 *                 value:
 *                   error: "Failed to convert XML: Invalid or malformed XML data"
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Convert XML using URL
router.post('/mos/xml_convert', async (req, res) => {
  try {
    // Check if a URL is present in the request body
    const url = req.body.url;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Execute XML conversion
    const result = await dockerService.convertXml(url);

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /docker/mos/templates:
 *   get:
 *     summary: Get all container template names
 *     description: Retrieve all Docker container template names grouped by installed and removed (admin only)
 *     tags: [Docker]
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
 *                   description: List of installed template names
 *                   example: ["nginx", "mysql", "redis"]
 *                 removed:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: List of removed template names
 *                   example: ["apache", "postgres"]
 *             example:
 *               installed: ["nginx", "mysql", "redis"]
 *               removed: ["apache", "postgres"]
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Get all container template names (installed and removed)
router.get('/mos/templates', async (req, res) => {
  try {
    const allTemplates = await dockerService.getAllTemplates();
    res.json(allTemplates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /docker/mos/templates/{name}:
 *   get:
 *     summary: Get specific container template
 *     description: Retrieve a specific Docker container template, preferring installed over removed if both exist (admin only)
 *     tags: [Docker]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the container template
 *         example: "nginx"
 *       - in: query
 *         name: edit
 *         required: false
 *         schema:
 *           type: boolean
 *           default: false
 *         description: If false (default), appends '_new' to the template name in the response. If true, returns original name.
 *         example: true
 *     responses:
 *       200:
 *         description: Template retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: The container template configuration
 *               properties:
 *                 name:
 *                   type: string
 *                   description: Container name (modified with '_new' suffix if edit=false)
 *                   example: "nginx_new"
 *                 image:
 *                   type: string
 *                   description: Docker image
 *                   example: "nginx:latest"
 *                 ports:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Port mappings
 *                   example: ["80:80"]
 *                 volumes:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Volume mappings
 *                   example: ["/host/path:/container/path"]
 *                 environment:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Environment variables
 *                   example: ["ENV_VAR=value"]
 *               example:
 *                 name: "nginx_new"
 *                 image: "nginx:latest"
 *                 ports: ["80:80"]
 *                 restart: "unless-stopped"
 *       400:
 *         description: Template name is required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Template name is required"
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Template not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Failed to get template: Template 'nginx' not found in installed or removed templates"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Get specific container template (prefers installed over removed)
router.get('/mos/templates/:name', async (req, res) => {
  try {
    const templateName = req.params.name;
    const edit = req.query.edit === 'true'; // Convert string to boolean, defaults to false

    if (!templateName) {
      return res.status(400).json({ error: 'Template name is required' });
    }

    const template = await dockerService.getTemplate(templateName, edit);
    res.json(template);
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
 * /docker/mos/templates:
 *   get:
 *     summary: Get all container templates (installed and removed)
 *     description: Retrieve all Docker container templates with status flags (admin only)
 *     tags: [Docker]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All templates retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total:
 *                   type: integer
 *                   description: Total number of templates
 *                   example: 5
 *                 installed_count:
 *                   type: integer
 *                   description: Number of installed templates
 *                   example: 3
 *                 removed_count:
 *                   type: integer
 *                   description: Number of removed templates
 *                   example: 2
 *                 templates:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                         description: Container template name
 *                         example: "nginx"
 *                       filename:
 *                         type: string
 *                         description: Template filename
 *                         example: "nginx.json"
 *                       status:
 *                         type: string
 *                         enum: ["installed", "removed"]
 *                         description: Template status
 *                         example: "installed"
 *                       template:
 *                         type: object
 *                         description: The container template JSON
 *                       created_at:
 *                         type: string
 *                         format: date-time
 *                         description: Date when template was created (installed only)
 *                       modified_at:
 *                         type: string
 *                         format: date-time
 *                         description: Date when template was modified (installed only)
 *                       removed_at:
 *                         type: string
 *                         format: date-time
 *                         description: Date when template was removed (removed only)
 *                       file_size:
 *                         type: integer
 *                         description: File size in bytes
 *             example:
 *               total: 3
 *               installed_count: 2
 *               removed_count: 1
 *               templates:
 *                 - name: "nginx"
 *                   filename: "nginx.json"
 *                   status: "installed"
 *                   template: {"name": "nginx", "image": "nginx:latest"}
 *                   created_at: "2024-01-15T10:30:00.000Z"
 *                   modified_at: "2024-01-15T11:30:00.000Z"
 *                   file_size: 1024
 *                 - name: "mysql"
 *                   filename: "mysql.json"
 *                   status: "removed"
 *                   template: {"name": "mysql", "image": "mysql:8.0"}
 *                   removed_at: "2024-01-14T15:45:00.000Z"
 *                   file_size: 2048
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Get all container templates (installed and removed)
router.get('/mos/templates', async (req, res) => {
  try {
    const allTemplates = await dockerService.getAllTemplates();
    res.json(allTemplates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper function for container status check
async function waitForContainerState(containerId, expectedState, maxRetries = 10) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await axios({
        method: 'GET',
        url: `http://localhost/containers/${containerId}/json`,
        socketPath: '/var/run/docker.sock',
        timeout: 3000,
        validateStatus: () => true
      });

      if (response.status === 200 && response.data.State) {
        const currentState = response.data.State.Status;

        // Expected state reached
        if (currentState === expectedState) {
          return true;
        }

        // Early termination for definite error states
        if (expectedState === 'running') {
          // Container definitively stopped/crashed - do not wait further
          if (currentState === 'exited' || currentState === 'dead') {
            return false;
          }
        }

        if (expectedState === 'exited') {
          // Container is still running - that's ok, continue waiting
          // But if it's "dead", that's also a valid end state
          if (currentState === 'dead') {
            return true;
          }
        }
      }
    } catch (error) {
      // Ignore errors, just retry
    }

    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return false;
}

/**
 * @swagger
 * components:
 *   schemas:
 *     ContainerGroup:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Unique timestamp-based group ID
 *           example: "1695384000123456789"
 *         name:
 *           type: string
 *           description: Group name
 *           example: "Web Services"
 *         index:
 *           type: integer
 *           description: Group order index
 *           example: 1
 *         containers:
 *           type: array
 *           items:
 *             type: string
 *           description: Array of container names in this group
 *           example: ["nginx", "apache", "traefik"]
 *         icon:
 *           type: string
 *           nullable: true
 *           description: Icon name/identifier for the group
 *         count:
 *           type: integer
 *           description: Number of containers in the group
 *           example: 3
 *         runningCount:
 *           type: integer
 *           description: Number of running containers in the group
 *           example: 2
 *         update_available:
 *           type: boolean
 *           description: Whether any container in the group has an update available
 *           example: true
 */

/**
 * @swagger
 * /docker/mos/groups:
 *   get:
 *     summary: Get all container groups
 *     tags: [Docker]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of container groups
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ContainerGroup'
 *             example:
 *               - id: "1695384000123"
 *                 name: "Web Services"
 *                 index: 1
 *                 containers: ["nginx", "apache"]
 *                 icon: "web"
 *                 count: 2
 *                 runningCount: 2
 *                 update_available: true
 *               - id: "1695384000456"
 *                 name: "Database Services"
 *                 index: 2
 *                 containers: ["mysql", "redis"]
 *                 icon: "database"
 *                 count: 2
 *                 runningCount: 1
 *                 update_available: false
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/mos/groups', async (req, res) => {
  try {
    const groups = await dockerService.getContainerGroups();
    res.json(groups);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /docker/mos/groups:
 *   post:
 *     summary: Create a new container group
 *     tags: [Docker]
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
 *             properties:
 *               name:
 *                 type: string
 *                 description: Group name
 *                 example: "Web Services"
 *               containers:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of container names to add to group
 *                 example: ["nginx", "apache"]
 *     responses:
 *       201:
 *         description: Group created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ContainerGroup'
 *       400:
 *         description: Bad request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/mos/groups', async (req, res) => {
  try {
    const { name, containers = [] } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Group name is required' });
    }

    const group = await dockerService.createContainerGroup(name, containers);
    res.status(201).json(group);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /docker/mos/groups/{groupId}:
 *   delete:
 *     summary: Delete a container group
 *     tags: [Docker]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: groupId
 *         required: true
 *         schema:
 *           type: string
 *         description: Group ID to delete
 *         example: "1695384000123456789"
 *     responses:
 *       200:
 *         description: Group deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Group deleted successfully"
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Group not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.delete('/mos/groups/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;
    await dockerService.deleteContainerGroup(groupId);
    res.json({ message: 'Group deleted successfully' });
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
 * /docker/mos/groups/order:
 *   put:
 *     summary: Update group order/index
 *     tags: [Docker]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: array
 *             items:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                   description: Group ID
 *                   example: "1695384000123456789"
 *                 index:
 *                   type: integer
 *                   description: New index position
 *                   example: 2
 *             description: Array of group objects with id and new index
 *             example:
 *               - id: "1695384000123456789"
 *                 index: 1
 *               - id: "1695384000987654321"
 *                 index: 2
 *     responses:
 *       200:
 *         description: Group order updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ContainerGroup'
 *       400:
 *         description: Bad request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.put('/mos/groups/order', async (req, res) => {
  try {
    const groupOrder = req.body;

    if (!Array.isArray(groupOrder)) {
      return res.status(400).json({ error: 'Request body must be an array of group objects' });
    }

    const updatedGroups = await dockerService.updateGroupOrder(groupOrder);
    res.json(updatedGroups);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /docker/mos/groups/{groupId}:
 *   put:
 *     summary: Update container group (name, icon, containers)
 *     description: Update any combination of group properties in a single request
 *     tags: [Docker]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: groupId
 *         required: true
 *         schema:
 *           type: string
 *         description: Group ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: New group name
 *                 example: "Web Servers"
 *               icon:
 *                 type: string
 *                 nullable: true
 *                 description: Icon name/identifier (null to remove icon)
 *                 example: "fas fa-server"
 *               containers:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Complete list of containers (replaces existing)
 *                 example: ["nginx", "apache"]
 *               addContainers:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Containers to add to existing list
 *                 example: ["redis"]
 *               removeContainers:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Containers to remove from existing list
 *                 example: ["old-container"]
 *           examples:
 *             updateName:
 *               summary: Update only name
 *               value:
 *                 name: "Database Servers"
 *             updateIcon:
 *               summary: Update only icon
 *               value:
 *                 icon: "fas fa-database"
 *             replaceContainers:
 *               summary: Replace all containers
 *               value:
 *                 containers: ["mysql", "postgres"]
 *             addRemoveContainers:
 *               summary: Add and remove containers
 *               value:
 *                 addContainers: ["redis"]
 *                 removeContainers: ["old-cache"]
 *             updateAll:
 *               summary: Update multiple properties
 *               value:
 *                 name: "Updated Group"
 *                 icon: "fas fa-cogs"
 *                 addContainers: ["new-service"]
 *     responses:
 *       200:
 *         description: Group updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ContainerGroup'
 *       400:
 *         description: Bad request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Group not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.put('/mos/groups/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;
    const updateData = req.body;

    // Validate that at least one field is provided
    const validFields = ['name', 'icon', 'containers', 'addContainers', 'removeContainers'];
    const providedFields = Object.keys(updateData).filter(key => validFields.includes(key));

    if (providedFields.length === 0) {
      return res.status(400).json({
        error: 'At least one field must be provided: name, icon, containers, addContainers, or removeContainers'
      });
    }

    // Validate that containers and addContainers/removeContainers are not used together
    if (updateData.containers !== undefined &&
        (updateData.addContainers !== undefined || updateData.removeContainers !== undefined)) {
      return res.status(400).json({
        error: 'Cannot use "containers" together with "addContainers" or "removeContainers"'
      });
    }

    const group = await dockerService.updateGroup(groupId, updateData);
    res.json(group);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(400).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /docker/mos/groups/{groupId}/start:
 *   post:
 *     summary: Start all containers in a group
 *     description: |
 *       Start all containers that belong to the specified group.
 *       Note: Docker Compose groups are not supported - use the compose API endpoints instead.
 *     tags: [Docker]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: groupId
 *         required: true
 *         schema:
 *           type: string
 *         description: Group ID
 *         example: "1695384000123456789"
 *     responses:
 *       200:
 *         description: Group start operation completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 groupId:
 *                   type: string
 *                   description: Group ID
 *                   example: "1695384000123456789"
 *                 groupName:
 *                   type: string
 *                   description: Group name
 *                   example: "Web Services"
 *                 totalContainers:
 *                   type: integer
 *                   description: Total number of containers in group
 *                   example: 3
 *                 successCount:
 *                   type: integer
 *                   description: Number of containers started successfully
 *                   example: 2
 *                 failureCount:
 *                   type: integer
 *                   description: Number of containers that failed to start
 *                   example: 1
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       container:
 *                         type: string
 *                         description: Container name
 *                         example: "nginx"
 *                       status:
 *                         type: string
 *                         enum: [success, error]
 *                         description: Operation status
 *                         example: "success"
 *                       message:
 *                         type: string
 *                         description: Status message
 *                         example: "Container started successfully"
 *       400:
 *         description: Group is a Docker Compose stack
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Group 'mystack' is a Docker Compose stack. Use the compose API endpoints to manage compose stacks."
 *       404:
 *         description: Group not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/mos/groups/:groupId/start', async (req, res) => {
  try {
    const { groupId } = req.params;
    const result = await dockerService.startContainerGroup(groupId);
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
 * /docker/mos/groups/{groupId}/stop:
 *   post:
 *     summary: Stop all containers in a group
 *     description: |
 *       Stop all containers that belong to the specified group.
 *       Note: Docker Compose groups are not supported - use the compose API endpoints instead.
 *     tags: [Docker]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: groupId
 *         required: true
 *         schema:
 *           type: string
 *         description: Group ID
 *         example: "1695384000123456789"
 *     responses:
 *       200:
 *         description: Group stop operation completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 groupId:
 *                   type: string
 *                   description: Group ID
 *                   example: "1695384000123456789"
 *                 groupName:
 *                   type: string
 *                   description: Group name
 *                   example: "Web Services"
 *                 totalContainers:
 *                   type: integer
 *                   description: Total number of containers in group
 *                   example: 3
 *                 successCount:
 *                   type: integer
 *                   description: Number of containers stopped successfully
 *                   example: 3
 *                 failureCount:
 *                   type: integer
 *                   description: Number of containers that failed to stop
 *                   example: 0
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       container:
 *                         type: string
 *                         description: Container name
 *                         example: "nginx"
 *                       status:
 *                         type: string
 *                         enum: [success, error]
 *                         description: Operation status
 *                         example: "success"
 *                       message:
 *                         type: string
 *                         description: Status message
 *                         example: "Container stopped successfully"
 *       400:
 *         description: Group is a Docker Compose stack
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Group 'mystack' is a Docker Compose stack. Use the compose API endpoints to manage compose stacks."
 *       404:
 *         description: Group not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/mos/groups/:groupId/stop', async (req, res) => {
  try {
    const { groupId } = req.params;
    const result = await dockerService.stopContainerGroup(groupId);
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
 * /docker/mos/groups/{groupId}/restart:
 *   post:
 *     summary: Restart all containers in a group
 *     description: |
 *       Restart all containers that belong to the specified group (stop and start sequentially).
 *       Note: Docker Compose groups are not supported - use the compose API endpoints instead.
 *     tags: [Docker]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: groupId
 *         required: true
 *         schema:
 *           type: string
 *         description: Group ID
 *         example: "1695384000123456789"
 *     responses:
 *       200:
 *         description: Group restart operation completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 groupId:
 *                   type: string
 *                   description: Group ID
 *                   example: "1695384000123456789"
 *                 groupName:
 *                   type: string
 *                   description: Group name
 *                   example: "Web Services"
 *                 totalContainers:
 *                   type: integer
 *                   description: Total number of containers in group
 *                   example: 3
 *                 successCount:
 *                   type: integer
 *                   description: Number of containers restarted successfully
 *                   example: 3
 *                 failureCount:
 *                   type: integer
 *                   description: Number of containers that failed to restart
 *                   example: 0
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       container:
 *                         type: string
 *                         description: Container name
 *                         example: "nginx"
 *                       status:
 *                         type: string
 *                         enum: [success, error]
 *                         description: Operation status
 *                         example: "success"
 *                       message:
 *                         type: string
 *                         description: Status message
 *                         example: "Container restarted successfully"
 *       400:
 *         description: Group is a Docker Compose stack
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Group 'mystack' is a Docker Compose stack. Use the compose API endpoints to manage compose stacks."
 *       404:
 *         description: Group not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/mos/groups/:groupId/restart', async (req, res) => {
  try {
    const { groupId } = req.params;
    const result = await dockerService.restartContainerGroup(groupId);
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
 * /docker/mos/groups/{groupId}/upgrade:
 *   post:
 *     summary: Upgrade all containers in a group
 *     description: |
 *       Upgrade all containers that belong to the specified group to their latest versions (sequential execution).
 *
 *       **Note:** This endpoint waits for all upgrades to complete before returning. For live streaming output
 *       during the upgrade process, use the WebSocket API with operation: 'upgrade-group'.
 *
 *       **WebSocket Alternative:**
 *       ```javascript
 *       socket.emit('docker', {
 *         token: 'your-jwt-token',
 *         operation: 'upgrade-group',
 *         params: { groupId: '123', force_update: false }
 *       });
 *       ```
 *
 *       **Docker Compose:** Compose groups are not supported - use the compose API endpoints instead.
 *     tags: [Docker]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: groupId
 *         required: true
 *         schema:
 *           type: string
 *         description: Group ID
 *         example: "1695384000123456789"
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               force_update:
 *                 type: boolean
 *                 default: false
 *                 description: Force update even if no new version available
 *                 example: false
 *     responses:
 *       200:
 *         description: Group upgrade operation completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 groupId:
 *                   type: string
 *                   description: Group ID
 *                   example: "1695384000123456789"
 *                 groupName:
 *                   type: string
 *                   description: Group name
 *                   example: "Web Services"
 *                 totalContainers:
 *                   type: integer
 *                   description: Total number of containers in group
 *                   example: 3
 *                 successCount:
 *                   type: integer
 *                   description: Number of containers upgraded successfully
 *                   example: 2
 *                 failureCount:
 *                   type: integer
 *                   description: Number of containers that failed to upgrade
 *                   example: 1
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       container:
 *                         type: string
 *                         description: Container name
 *                         example: "nginx"
 *                       status:
 *                         type: string
 *                         enum: [success, error]
 *                         description: Operation status
 *                         example: "success"
 *                       message:
 *                         type: string
 *                         description: Status message
 *                         example: "Container upgraded successfully"
 *                       details:
 *                         type: object
 *                         description: Detailed upgrade information
 *       400:
 *         description: Group is a Docker Compose stack
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Group 'mystack' is a Docker Compose stack. Use the compose API endpoints to manage compose stacks."
 *       404:
 *         description: Group not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/mos/groups/:groupId/upgrade', async (req, res) => {
  try {
    const { groupId } = req.params;
    const forceUpdate = req.body?.force_update || false;
    const result = await dockerService.upgradeContainerGroup(groupId, forceUpdate);
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
 * /docker/mos/groups/order:
 *   put:
 *     summary: Update group order/index
 *     tags: [Docker]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: array
 *             items:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                   description: Group ID
 *                   example: "1695384000123456789"
 *                 index:
 *                   type: integer
 *                   description: New index position
 *                   example: 2
 *             description: Array of group objects with id and new index
 *             example:
 *               - id: "1695384000123456789"
 *                 index: 1
 *               - id: "1695384000987654321"
 *                 index: 2
 *     responses:
 *       200:
 *         description: Group order updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ContainerGroup'
 *       400:
 *         description: Bad request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.put('/mos/groups/order', async (req, res) => {
  try {
    const groupOrder = req.body;

    if (!Array.isArray(groupOrder)) {
      return res.status(400).json({ error: 'Request body must be an array of group objects' });
    }

    const updatedGroups = await dockerService.updateGroupOrder(groupOrder);
    res.json(updatedGroups);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /docker/mos/unusedimages:
 *   get:
 *     summary: Get unused Docker images
 *     description: Get list of Docker images that are not used by any container (admin only)
 *     tags: [Docker]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of unused images
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   repository:
 *                     type: string
 *                     description: Image repository name
 *                     example: "nginx"
 *                   tag:
 *                     type: string
 *                     description: Image tag
 *                     example: "1.20.2"
 *                   id:
 *                     type: string
 *                     description: Image ID (short format)
 *                     example: "a1b2c3d4e5f6"
 *                   size:
 *                     type: string
 *                     description: Image size
 *                     example: "133MB"
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/mos/unusedimages', async (req, res) => {
  try {
    const unusedImages = await dockerService.getUnusedImages();
    res.json(unusedImages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /docker/mos/unusedimages:
 *   delete:
 *     summary: Delete unused Docker images
 *     description: Delete unused Docker images - all or specific ones by ID (admin only)
 *     tags: [Docker]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       description: Optional array of image IDs to delete. If not provided or empty, deletes all unused images.
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: array
 *             items:
 *               type: string
 *             example: ["a1b2c3d4e5f6", "b2c3d4e5f6g7"]
 *     responses:
 *       200:
 *         description: Deletion result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   description: Whether all deletions succeeded
 *                   example: true
 *                 message:
 *                   type: string
 *                   description: Summary message
 *                   example: "Deleted 3 image(s), 0 failed"
 *                 deleted:
 *                   type: array
 *                   description: Successfully deleted images
 *                   items:
 *                     type: object
 *                     properties:
 *                       repository:
 *                         type: string
 *                       tag:
 *                         type: string
 *                       id:
 *                         type: string
 *                       size:
 *                         type: string
 *                 failed:
 *                   type: array
 *                   description: Failed deletions with error messages
 *                   items:
 *                     type: object
 *                     properties:
 *                       repository:
 *                         type: string
 *                       tag:
 *                         type: string
 *                       id:
 *                         type: string
 *                       size:
 *                         type: string
 *                       error:
 *                         type: string
 *       400:
 *         description: Bad request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.delete('/mos/unusedimages', async (req, res) => {
  try {
    // Body can be array directly or empty
    const imageIds = Array.isArray(req.body) ? req.body : null;

    // Validate array contents if provided
    if (imageIds && imageIds.length > 0) {
      if (!imageIds.every(id => typeof id === 'string')) {
        return res.status(400).json({ error: 'All image IDs must be strings' });
      }
    }

    const result = await dockerService.deleteUnusedImages(imageIds);
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /docker/{path}:
 *   get:
 *     summary: Docker REST API Proxy (GET)
 *     description: Proxy requests to the Docker REST API via Unix socket (admin only)
 *     tags: [Docker]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Docker API endpoint path
 *         example: "containers/json"
 *     responses:
 *       200:
 *         description: Docker API response
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: Docker API response (varies by endpoint)
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Docker API or proxy error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *   post:
 *     summary: Docker REST API Proxy (POST)
 *     description: Proxy POST requests to the Docker REST API via Unix socket (admin only)
 *     tags: [Docker]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Docker API endpoint path
 *         example: "containers/create"
 *     requestBody:
 *       description: Request body for Docker API (varies by endpoint)
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Docker API response
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Docker API or proxy error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *   put:
 *     summary: Docker REST API Proxy (PUT)
 *     description: Proxy PUT requests to the Docker REST API via Unix socket (admin only)
 *     tags: [Docker]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Docker API endpoint path
 *     requestBody:
 *       description: Request body for Docker API (varies by endpoint)
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Docker API response
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Docker API or proxy error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *   delete:
 *     summary: Docker REST API Proxy (DELETE)
 *     description: Proxy DELETE requests to the Docker REST API via Unix socket (admin only)
 *     tags: [Docker]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Docker API endpoint path
 *         example: "containers/{id}"
 *     responses:
 *       200:
 *         description: Docker API response
 *       204:
 *         description: Docker API no content response
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Docker API or proxy error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Proxy für Docker REST API
router.use('/', checkRole('admin'), async (req, res) => {
  // Define variables outside try block so they're available in catch
  const isStreamingEndpoint = req.originalUrl.includes('/logs') ||
                             req.originalUrl.includes('/attach') ||
                             req.originalUrl.includes('/exec') ||
                             req.originalUrl.includes('/stats');

  const isContainerStateChange = req.method === 'POST' &&
                                (req.originalUrl.includes('/start') ||
                                 req.originalUrl.includes('/stop') ||
                                 req.originalUrl.includes('/restart'));

  // Extract Container ID for State Check
  const containerIdMatch = req.originalUrl.match(/\/containers\/([^\/]+)\//);
  const containerId = containerIdMatch ? containerIdMatch[1] : null;

  try {
    const axiosConfig = {
      method: req.method,
      url: `http://localhost${req.originalUrl.replace('/api/v1/docker', '')}`,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
      },
      data: req.body,
      socketPath: '/var/run/docker.sock',
      validateStatus: () => true,
      timeout: 30000,
      responseType: 'json'
    };

    // Use Stream-Mode only for real Streaming Endpoints
    if (isStreamingEndpoint) {
      axiosConfig.responseType = 'stream';
    }

    const response = await axios(axiosConfig);

    // Handle error responses from Docker API
    if (!isStreamingEndpoint && response.status >= 400) {
      let errorMessage = 'Docker API error';

      // Extract detailed error message
      if (response.data) {
        if (typeof response.data === 'string') {
          errorMessage = response.data;
        } else if (response.data.message) {
          errorMessage = response.data.message;
        } else if (typeof response.data === 'object') {
          errorMessage = JSON.stringify(response.data);
        }
      }

      // Convert 500 to 400 for container state changes (start/stop/restart)
      // This allows frontend to properly handle errors like port conflicts
      const statusCode = (response.status === 500 && isContainerStateChange) ? 400 : response.status;

      return res.status(statusCode).json({ error: errorMessage });
    }

    res.status(response.status);

    if (isStreamingEndpoint) {
      // Streaming for Logs, Attach, Exec
      response.data.pipe(res);
    } else {
      // Normal JSON Response
      let responseData = response.data;

      // Wait for container state change if successful container operation
      if (isContainerStateChange && containerId && response.status >= 200 && response.status < 300) {
        let expectedState = null;
        if (req.originalUrl.includes('/start')) expectedState = 'running';
        if (req.originalUrl.includes('/stop')) expectedState = 'exited';
        if (req.originalUrl.includes('/restart')) expectedState = 'running';

        if (expectedState) {
          await waitForContainerState(containerId, expectedState);
        }

        // Handle dependent containers after main container state change
        try {
          if (req.originalUrl.includes('/start')) {
            // For start: only start dependents with autostart: true
            const autostartDependents = await dockerService.getDependentContainers(containerId, true);

            if (autostartDependents.length > 0) {
              setTimeout(async () => {
                for (const dependentName of autostartDependents) {
                  try {
                    await axios({
                      method: 'POST',
                      url: `http://localhost/containers/${dependentName}/start`,
                      socketPath: '/var/run/docker.sock',
                      validateStatus: () => true
                    });
                  } catch (dependentError) {
                    // Silent fail - continue with other containers
                  }
                }
              }, 10000);
            }
          } else if (req.originalUrl.includes('/restart')) {
            // For restart: restart all dependents (don't check autostart)
            const dependentContainers = await dockerService.getDependentContainers(containerId);

            if (dependentContainers.length > 0) {
              setTimeout(async () => {
                for (const dependentName of dependentContainers) {
                  try {
                    await axios({
                      method: 'POST',
                      url: `http://localhost/containers/${dependentName}/restart`,
                      socketPath: '/var/run/docker.sock',
                      validateStatus: () => true
                    });
                  } catch (dependentError) {
                    // Silent fail - continue with other containers
                  }
                }
              }, 10000);
            }
          } else if (req.originalUrl.includes('/stop')) {
            // For stop: immediately stop all dependents (no delay, don't check autostart)
            const dependentContainers = await dockerService.getDependentContainers(containerId);

            if (dependentContainers.length > 0) {
              for (const dependentName of dependentContainers) {
                try {
                  await axios({
                    method: 'POST',
                    url: `http://localhost/containers/${dependentName}/stop`,
                    socketPath: '/var/run/docker.sock',
                    validateStatus: () => true
                  });
                } catch (dependentError) {
                  // Silent fail - continue with other containers
                }
              }
            }
          }
        } catch (dependencyError) {
          // Silent fail - don't break main functionality
        }
      }

      res.json(responseData);
    }
  } catch (error) {
    // Handle unexpected errors (network errors, timeouts, etc.)
    let errorMessage = error.message;
    let statusCode = 500;

    // Check if this is an axios error with response
    if (error.response) {
      statusCode = error.response.status || 500;

      if (error.response.data) {
        if (typeof error.response.data === 'string') {
          errorMessage = error.response.data;
        } else if (error.response.data.message) {
          errorMessage = error.response.data.message;
        } else if (typeof error.response.data === 'object') {
          errorMessage = JSON.stringify(error.response.data);
        }
      }
    }

    // Convert 500 errors to 400 for container start/stop/restart operations
    // This allows frontend to properly display error messages (e.g., port conflicts)
    if (statusCode === 500 && isContainerStateChange) {
      statusCode = 400;
    }

    res.status(statusCode).json({ error: errorMessage });
  }
});

module.exports = router;
