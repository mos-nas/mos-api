const express = require('express');
const router = express.Router();
const { checkRole } = require('../middleware/auth.middleware');
const iscsiService = require('../services/iscsi.service');

/**
 * @swagger
 * tags:
 *   name: iSCSI Targets
 *   description: iSCSI Target Management
 *
 * components:
 *   schemas:
 *     Error:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           description: Success status
 *           example: false
 *         error:
 *           type: string
 *           description: Error message
 *     IscsiLun:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: LUN ID
 *           example: 1
 *         path:
 *           type: string
 *           description: Path to the LUN backing store
 *           example: "/mnt/misc_cache/iSCSI/test2_array.img"
 *         backing_store:
 *           type: string
 *           enum: ["rdwr", "ro"]
 *           description: Backing store mode
 *           example: "rdwr"
 *         mode:
 *           type: string
 *           description: LUN mode
 *           example: "logicalunit"
 *         size:
 *           type: string
 *           description: Size for image files (e.g., '1G', '500M', '2048K'). Only used when creating new .img files.
 *           example: "1G"
 *     IscsiInitiator:
 *       type: object
 *       properties:
 *         iqn:
 *           type: string
 *           description: Initiator IQN
 *           example: "iqn.2025-08.why-mos:mos"
 *         authentication:
 *           type: object
 *           properties:
 *             method:
 *               type: string
 *               enum: ["none", "chap"]
 *               description: Authentication method
 *               example: "none"
 *     IscsiTarget:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Target ID
 *           example: 1
 *         name:
 *           type: string
 *           description: Target name
 *           example: "Test Server 2"
 *         iqn:
 *           type: string
 *           description: Target IQN
 *           example: "iqn.2003-01.org.linux-iscsi.chipsserver.x8664:mos"
 *         portal:
 *           type: string
 *           description: Target portal
 *           example: "0.0.0.0:3260"
 *         authentication:
 *           type: object
 *           properties:
 *             method:
 *               type: string
 *               enum: ["none", "chap"]
 *               description: Authentication method
 *               example: "none"
 *         luns:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/IscsiLun'
 *         initiators:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/IscsiInitiator'
 *         isActive:
 *           type: boolean
 *           description: Whether target is currently active
 *           example: true
 *     CreateIscsiTargetRequest:
 *       type: object
 *       required:
 *         - id
 *         - iqn
 *       properties:
 *         id:
 *           type: integer
 *           description: Unique target ID
 *           example: 1
 *         name:
 *           type: string
 *           description: Target name
 *           example: "Test Server 2"
 *         iqn:
 *           type: string
 *           description: Target IQN
 *           example: "iqn.2003-01.org.linux-iscsi.chipsserver.x8664:mos"
 *         portal:
 *           type: string
 *           description: Target portal
 *           default: "0.0.0.0:3260"
 *           example: "0.0.0.0:3260"
 *         authentication:
 *           type: object
 *           properties:
 *             method:
 *               type: string
 *               enum: ["none", "chap"]
 *               default: "none"
 *               example: "none"
 *         luns:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/IscsiLun'
 *           default: []
 *         initiators:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/IscsiInitiator'
 *           default: []
 *     UpdateIscsiTargetRequest:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Target name
 *           example: "Updated Test Server"
 *         portal:
 *           type: string
 *           description: Target portal
 *           example: "0.0.0.0:3260"
 *         authentication:
 *           type: object
 *           properties:
 *             method:
 *               type: string
 *               enum: ["none", "chap"]
 *               example: "none"
 *         luns:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/IscsiLun'
 *         initiators:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/IscsiInitiator'
 *     IscsiTargetsStatistics:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           description: Operation success
 *           example: true
 *         data:
 *           type: object
 *           properties:
 *             totalTargets:
 *               type: integer
 *               description: Total number of configured targets
 *               example: 3
 *             activeTargets:
 *               type: integer
 *               description: Number of active targets
 *               example: 2
 *             totalLuns:
 *               type: integer
 *               description: Total number of LUNs across all targets
 *               example: 8
 *             totalInitiators:
 *               type: integer
 *               description: Total number of initiators across all targets
 *               example: 5
 *         timestamp:
 *           type: string
 *           format: date-time
 *           description: Statistics timestamp
 */

/**
 * @swagger
 * /iscsi/targets:
 *   get:
 *     summary: Get all iSCSI targets
 *     description: Retrieve all configured iSCSI targets (admin only)
 *     tags: [iSCSI Targets]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All iSCSI targets retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/IscsiTarget'
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

// Get all iSCSI targets (admin only)
router.get('/targets', checkRole(['admin']), async (req, res) => {
  try {
    const targets = await iscsiService.getTargets();
    const configuredTargets = await iscsiService.getConfiguredTargets();

    // Add isActive status to each target
    const targetsWithStatus = targets.map(target => ({
      ...target,
      isActive: configuredTargets.includes(target.id)
    }));

    // Sort targets by ID to ensure consistent ordering
    targetsWithStatus.sort((a, b) => a.id - b.id);

    res.json(targetsWithStatus);
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

/**
 * @swagger
 * /iscsi/targets/info:
 *   get:
 *     summary: Get iSCSI targets statistics
 *     description: Retrieve statistical information about iSCSI targets (admin only)
 *     tags: [iSCSI Targets]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: iSCSI targets statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/IscsiTargetsStatistics'
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

// Get iSCSI targets statistics (admin only)
router.get('/targets/info', checkRole(['admin']), async (req, res) => {
  try {
    const targetsInfo = await iscsiService.getTargetsInfo();
    res.json(targetsInfo);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /iscsi/targets:
 *   post:
 *     summary: Create new iSCSI target
 *     description: Create a new iSCSI target (admin only)
 *     tags: [iSCSI Targets]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateIscsiTargetRequest'
 *           example:
 *             id: 1
 *             name: "Test Server 2"
 *             iqn: "iqn.2003-01.org.linux-iscsi.chipsserver.x8664:mos"
 *             portal: "0.0.0.0:3260"
 *             authentication:
 *               method: "none"
 *             luns:
 *               - id: 1
 *                 path: "/mnt/misc_cache/iSCSI/test2_array.img"
 *                 backing_store: "rdwr"
 *                 mode: "logicalunit"
 *             initiators:
 *               - iqn: "iqn.2025-08.why-mos:mos"
 *                 authentication:
 *                   method: "none"
 *     responses:
 *       201:
 *         description: iSCSI target created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "iSCSI target 'Test Server 2' created successfully"
 *                 data:
 *                   $ref: '#/components/schemas/IscsiTarget'
 *       400:
 *         description: Bad request - validation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
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

// Create new iSCSI target (admin only)
router.post('/targets', checkRole(['admin']), async (req, res) => {
  try {
    const targetData = req.body;

    // Validate required fields
    if (!targetData.id || !targetData.iqn) {
      return res.status(400).json({
        success: false,
        error: 'Target ID and IQN are required'
      });
    }

    // Validate Target ID
    if (!Number.isInteger(targetData.id) || targetData.id <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Target ID must be a positive integer'
      });
    }

    // Validate IQN
    if (!targetData.iqn.startsWith('iqn.')) {
      return res.status(400).json({
        success: false,
        error: 'IQN must start with "iqn."'
      });
    }

    const result = await iscsiService.createIscsiTarget(targetData);
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /iscsi/targets/{targetId}:
 *   get:
 *     summary: Get a specific iSCSI target
 *     description: Retrieve detailed information about a specific iSCSI target by ID (admin only)
 *     tags: [iSCSI Targets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: targetId
 *         required: true
 *         schema:
 *           type: integer
 *         description: Target ID
 *         example: 1
 *     responses:
 *       200:
 *         description: iSCSI target retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/IscsiTarget'
 *       400:
 *         description: Invalid target ID
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
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
 *         description: Target not found
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

// Get a specific iSCSI target (admin only)
router.get('/targets/:targetId', checkRole(['admin']), async (req, res) => {
  try {
    const targetId = parseInt(req.params.targetId);

    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Target ID must be a positive integer'
      });
    }

    const result = await iscsiService.getTarget(targetId);
    res.json(result);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

/**
 * @swagger
 * /iscsi/targets/{targetId}:
 *   put:
 *     summary: Update an iSCSI target
 *     description: Update configuration of an existing iSCSI target (admin only)
 *     tags: [iSCSI Targets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: targetId
 *         required: true
 *         schema:
 *           type: integer
 *         description: Target ID to update
 *         example: 1
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateIscsiTargetRequest'
 *           example:
 *             name: "Updated Test Server"
 *             luns:
 *               - id: 1
 *                 path: "/mnt/misc_cache/iSCSI/updated_array.img"
 *                 backing_store: "rdwr"
 *                 mode: "logicalunit"
 *     responses:
 *       200:
 *         description: iSCSI target updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "iSCSI target 'Updated Test Server' updated successfully"
 *                 data:
 *                   $ref: '#/components/schemas/IscsiTarget'
 *                 wasActive:
 *                   type: boolean
 *                   description: Whether target was active during update
 *                   example: true
 *       400:
 *         description: Bad request - validation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
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
 *         description: Target not found
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

// Update an iSCSI target (admin only)
router.put('/targets/:targetId', checkRole(['admin']), async (req, res) => {
  try {
    const targetId = parseInt(req.params.targetId);
    const updates = req.body;

    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Target ID must be a positive integer'
      });
    }

    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Update data is required'
      });
    }

    const result = await iscsiService.updateIscsiTarget(targetId, updates);
    res.json(result);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

/**
 * @swagger
 * /iscsi/targets/{targetId}:
 *   delete:
 *     summary: Delete an iSCSI target
 *     description: Delete an existing iSCSI target (admin only)
 *     tags: [iSCSI Targets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: targetId
 *         required: true
 *         schema:
 *           type: integer
 *         description: Target ID to delete
 *         example: 1
 *       - in: query
 *         name: deleteImages
 *         required: false
 *         schema:
 *           type: boolean
 *           default: false
 *         description: If true, delete all backing image files (.img) associated with this target
 *         example: false
 *     responses:
 *       200:
 *         description: iSCSI target deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "iSCSI target 'Test Server 2' deleted successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     target:
 *                       $ref: '#/components/schemas/IscsiTarget'
 *                     deletedImageFiles:
 *                       type: array
 *                       items:
 *                         type: string
 *                       description: List of image files that were deleted
 *                       example: ["/mnt/storage/disk1.img", "/mnt/storage/disk2.img"]
 *                 wasActive:
 *                   type: boolean
 *                   description: Whether target was active when deleted
 *                   example: true
 *       400:
 *         description: Invalid target ID
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
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
 *         description: Target not found
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

// Delete an iSCSI target (admin only)
router.delete('/targets/:targetId', checkRole(['admin']), async (req, res) => {
  try {
    const targetId = parseInt(req.params.targetId);
    const deleteImages = req.query.deleteImages === 'true';

    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Target ID must be a positive integer'
      });
    }

    const result = await iscsiService.deleteIscsiTarget(targetId, deleteImages);
    res.json(result);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

/**
 * @swagger
 * /iscsi/targets/restart:
 *   post:
 *     summary: Restart all iSCSI targets
 *     description: Restart/reload all configured iSCSI targets (admin only)
 *     tags: [iSCSI Targets]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All targets restarted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "All targets restarted"
 *                 data:
 *                   type: object
 *                   properties:
 *                     totalTargets:
 *                       type: integer
 *                       example: 3
 *                     results:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: integer
 *                             example: 1
 *                           status:
 *                             type: string
 *                             enum: ["success", "error"]
 *                             example: "success"
 *                           error:
 *                             type: string
 *                             description: Error message if status is "error"
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

// Restart all iSCSI targets (admin only)
router.post('/targets/restart', checkRole(['admin']), async (req, res) => {
  try {
    const result = await iscsiService.restartAllTargets();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /iscsi/targets/{targetId}/luns:
 *   post:
 *     summary: Add a LUN to an iSCSI target
 *     description: Add a new LUN to an existing iSCSI target (admin only)
 *     tags: [iSCSI Targets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: targetId
 *         required: true
 *         schema:
 *           type: integer
 *         description: Target ID
 *         example: 1
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - id
 *               - path
 *             properties:
 *               id:
 *                 type: integer
 *                 description: LUN ID
 *                 example: 2
 *               path:
 *                 type: string
 *                 description: Path to the LUN backing store
 *                 example: "/mnt/misc_cache/iSCSI/new_lun.img"
 *               backing_store:
 *                 type: string
 *                 enum: ["rdwr", "ro"]
 *                 description: Backing store mode
 *                 default: "rdwr"
 *                 example: "rdwr"
 *               mode:
 *                 type: string
 *                 description: LUN mode
 *                 default: "logicalunit"
 *                 example: "logicalunit"
 *               size:
 *                 type: string
 *                 description: Size for image files (e.g., '1G', '500M', '2048K'). Only used when creating new .img files.
 *                 default: "1G"
 *                 example: "2G"
 *     responses:
 *       201:
 *         description: LUN added successfully
 *       400:
 *         description: Bad request - validation failed
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Target not found
 *       500:
 *         description: Server error
 */

// Add a LUN to a target (admin only)
router.post('/targets/:targetId/luns', checkRole(['admin']), async (req, res) => {
  try {
    const targetId = parseInt(req.params.targetId);
    const lunData = req.body;

    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Target ID must be a positive integer'
      });
    }

    const result = await iscsiService.addLunToTarget(targetId, lunData);
    res.status(201).json(result);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: error.message
      });
    } else if (error.message.includes('already exists') || error.message.includes('required')) {
      res.status(400).json({
        success: false,
        error: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

/**
 * @swagger
 * /iscsi/targets/{targetId}/luns/{lunId}:
 *   delete:
 *     summary: Remove a LUN from an iSCSI target
 *     description: Remove an existing LUN from an iSCSI target (admin only)
 *     tags: [iSCSI Targets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: targetId
 *         required: true
 *         schema:
 *           type: integer
 *         description: Target ID
 *         example: 1
 *       - in: path
 *         name: lunId
 *         required: true
 *         schema:
 *           type: integer
 *         description: LUN ID to remove
 *         example: 2
 *       - in: query
 *         name: deleteImages
 *         required: false
 *         schema:
 *           type: boolean
 *           default: false
 *         description: If true, delete the backing image file (.img) for this LUN
 *         example: false
 *     responses:
 *       200:
 *         description: LUN removed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "LUN 2 removed from target 'Test Server 1' successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     target:
 *                       $ref: '#/components/schemas/IscsiTarget'
 *                     removedLun:
 *                       $ref: '#/components/schemas/IscsiLun'
 *                     imageFileDeleted:
 *                       type: boolean
 *                       description: Whether the backing image file was deleted
 *                       example: true
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Invalid target or LUN ID
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Target or LUN not found
 *       500:
 *         description: Server error
 */

// Remove a LUN from a target (admin only)
router.delete('/targets/:targetId/luns/:lunId', checkRole(['admin']), async (req, res) => {
  try {
    const targetId = parseInt(req.params.targetId);
    const lunId = parseInt(req.params.lunId);
    const deleteImages = req.query.deleteImages === 'true';

    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Target ID must be a positive integer'
      });
    }

    if (!Number.isInteger(lunId) || lunId <= 0) {
      return res.status(400).json({
        success: false,
        error: 'LUN ID must be a positive integer'
      });
    }

    const result = await iscsiService.removeLunFromTarget(targetId, lunId, deleteImages);
    res.json(result);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

/**
 * @swagger
 * /iscsi/targets/{targetId}/luns/{lunId}:
 *   put:
 *     summary: Update a LUN in an iSCSI target
 *     description: Update configuration of an existing LUN in an iSCSI target (admin only)
 *     tags: [iSCSI Targets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: targetId
 *         required: true
 *         schema:
 *           type: integer
 *         description: Target ID
 *         example: 1
 *       - in: path
 *         name: lunId
 *         required: true
 *         schema:
 *           type: integer
 *         description: LUN ID to update
 *         example: 2
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               path:
 *                 type: string
 *                 description: Path to the LUN backing store
 *                 example: "/mnt/misc_cache/iSCSI/updated_lun.img"
 *               backing_store:
 *                 type: string
 *                 enum: ["rdwr", "ro"]
 *                 description: Backing store mode
 *                 example: "rdwr"
 *               mode:
 *                 type: string
 *                 description: LUN mode
 *                 example: "logicalunit"
 *               size:
 *                 type: string
 *                 description: Size for image files (e.g., '1G', '500M', '2048K'). Only used when creating new .img files.
 *                 example: "2G"
 *     responses:
 *       200:
 *         description: LUN updated successfully
 *       400:
 *         description: Bad request - validation failed
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Target or LUN not found
 *       500:
 *         description: Server error
 */

// Update a LUN in a target (admin only)
router.put('/targets/:targetId/luns/:lunId', checkRole(['admin']), async (req, res) => {
  try {
    const targetId = parseInt(req.params.targetId);
    const lunId = parseInt(req.params.lunId);
    const updates = req.body;

    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Target ID must be a positive integer'
      });
    }

    if (!Number.isInteger(lunId) || lunId <= 0) {
      return res.status(400).json({
        success: false,
        error: 'LUN ID must be a positive integer'
      });
    }

    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Update data is required'
      });
    }

    const result = await iscsiService.updateLunInTarget(targetId, lunId, updates);
    res.json(result);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

module.exports = router;