const express = require('express');
const router = express.Router();
const { checkRole } = require('../middleware/auth.middleware');
const iscsiService = require('../services/iscsi.service');

/**
 * @swagger
 * tags:
 *   name: iSCSI Initiators
 *   description: iSCSI Initiator Management
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
 *     IscsiInitiatorPortal:
 *       type: object
 *       properties:
 *         address:
 *           type: string
 *           description: Target IP address
 *           example: "10.0.0.1"
 *         port:
 *           type: string
 *           description: Target port
 *           example: "3260"
 *     IscsiInitiatorConnection:
 *       type: object
 *       properties:
 *         automount:
 *           type: boolean
 *           description: Whether to automatically connect to target
 *           example: false
 *     IscsiInitiatorTarget:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Timestamp-based target ID
 *           example: 1647875123456
 *         name:
 *           type: string
 *           description: Target IQN
 *           example: "iqn.2003-01.org.linux-iscsi.chipsserver.x8664:mos"
 *         portal:
 *           $ref: '#/components/schemas/IscsiInitiatorPortal'
 *         connection:
 *           $ref: '#/components/schemas/IscsiInitiatorConnection'
 *     IscsiInitiatorConfig:
 *       type: object
 *       properties:
 *         initiator:
 *           type: object
 *           properties:
 *             name:
 *               type: string
 *               description: Initiator IQN
 *               example: "iqn.2025-08.why-mos:why"
 *         targets:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/IscsiInitiatorTarget'
 *     CreateInitiatorTargetRequest:
 *       type: object
 *       required:
 *         - name
 *         - portal
 *       properties:
 *         name:
 *           type: string
 *           description: Target IQN
 *           example: "iqn.2003-01.org.linux-iscsi.chipsserver.x8664:mos"
 *         portal:
 *           type: object
 *           required:
 *             - address
 *           properties:
 *             address:
 *               type: string
 *               description: Target IP address
 *               example: "10.0.0.1"
 *             port:
 *               type: string
 *               description: Target port
 *               default: "3260"
 *               example: "3260"
 *         connection:
 *           type: object
 *           properties:
 *             automount:
 *               type: boolean
 *               description: Whether to automatically connect to target
 *               default: false
 *               example: false
 *     UpdateInitiatorTargetRequest:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Target IQN
 *           example: "iqn.2003-01.org.linux-iscsi.chipsserver.x8664:mos-updated"
 *         portal:
 *           $ref: '#/components/schemas/IscsiInitiatorPortal'
 *         connection:
 *           $ref: '#/components/schemas/IscsiInitiatorConnection'
 *     ConnectionTestRequest:
 *       type: object
 *       required:
 *         - targetIp
 *       properties:
 *         targetIp:
 *           type: string
 *           description: Target IP address to test
 *           example: "10.0.0.1"
 *         targetPort:
 *           type: string
 *           description: Target port to test
 *           default: "3260"
 *           example: "3260"
 *     DiscoveredTarget:
 *       type: object
 *       properties:
 *         portal:
 *           type: string
 *           description: Target portal
 *           example: "10.0.0.1:3260,1"
 *         iqn:
 *           type: string
 *           description: Target IQN
 *           example: "iqn.2003-01.org.linux-iscsi.chipsserver.x8664:mos"
 */

/**
 * @swagger
 * /iscsi/initiator:
 *   get:
 *     summary: Get iSCSI initiator configuration
 *     description: Retrieve the complete iSCSI initiator configuration (admin only)
 *     tags: [iSCSI Initiators]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Initiator configuration retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/IscsiInitiatorConfig'
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

// Get iSCSI initiator configuration (admin only)
router.get('/', checkRole(['admin']), async (req, res) => {
  try {
    const config = await iscsiService.getInitiatorConfig();
    res.json(config);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /iscsi/initiator/name:
 *   put:
 *     summary: Update initiator name
 *     description: Update the IQN name of the iSCSI initiator (admin only)
 *     tags: [iSCSI Initiators]
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
 *                 description: New initiator IQN
 *                 example: "iqn.2025-08.why-mos:updated-why"
 *     responses:
 *       200:
 *         description: Initiator name updated successfully
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
 *                   example: "Initiator name updated to 'iqn.2025-08.why-mos:updated-why' successfully"
 *                 data:
 *                   $ref: '#/components/schemas/IscsiInitiatorConfig'
 *                 timestamp:
 *                   type: string
 *                   format: date-time
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

// Update initiator name (admin only)
router.put('/name', checkRole(['admin']), async (req, res) => {
  try {
    const { name } = req.body;

    // Validation
    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'Initiator name is required'
      });
    }

    if (!name.startsWith('iqn.')) {
      return res.status(400).json({
        success: false,
        error: 'Initiator name must be a valid IQN starting with "iqn."'
      });
    }

    const result = await iscsiService.updateInitiatorName(name);
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
 * /iscsi/initiator/targets:
 *   post:
 *     summary: Add a new target
 *     description: Add a new iSCSI target to the initiator configuration (admin only)
 *     tags: [iSCSI Initiators]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateInitiatorTargetRequest'
 *           example:
 *             name: "iqn.2003-01.org.linux-iscsi.chipsserver.x8664:mos"
 *             portal:
 *               address: "10.0.0.1"
 *               port: "3260"
 *             connection:
 *               automount: false
 *     responses:
 *       201:
 *         description: Target added successfully
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
 *                   example: "Target 'iqn.2003-01.org.linux-iscsi.chipsserver.x8664:mos' added successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     config:
 *                       $ref: '#/components/schemas/IscsiInitiatorConfig'
 *                     addedTarget:
 *                       $ref: '#/components/schemas/IscsiInitiatorTarget'
 *                     autoLogin:
 *                       type: object
 *                       description: Auto-login result (only present if automount was true)
 *                       properties:
 *                         success:
 *                           type: boolean
 *                           example: true
 *                         message:
 *                           type: string
 *                           example: "Successfully logged in to target 'iqn.2003-01.org.linux-iscsi.chipsserver.x8664:mos'"
 *                         error:
 *                           type: string
 *                           description: Error message if auto-login failed
 *                 timestamp:
 *                   type: string
 *                   format: date-time
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

// Add a new target (admin only)
router.post('/targets', checkRole(['admin']), async (req, res) => {
  try {
    const targetData = req.body;

    // Validate required fields
    if (!targetData.name) {
      return res.status(400).json({
        success: false,
        error: 'Target name (IQN) is required'
      });
    }

    if (!targetData.name.startsWith('iqn.')) {
      return res.status(400).json({
        success: false,
        error: 'Target name must be a valid IQN starting with "iqn."'
      });
    }

    if (!targetData.portal || !targetData.portal.address) {
      return res.status(400).json({
        success: false,
        error: 'Target portal address is required'
      });
    }

    const result = await iscsiService.addInitiatorTarget(targetData);
    res.status(201).json(result);
  } catch (error) {
    if (error.message.includes('already exists')) {
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
 * /iscsi/initiator/targets/{targetId}:
 *   get:
 *     summary: Get a specific target
 *     description: Retrieve detailed information about a specific target by ID (admin only)
 *     tags: [iSCSI Initiators]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: targetId
 *         required: true
 *         schema:
 *           type: integer
 *         description: Target ID
 *         example: 1647875123456
 *     responses:
 *       200:
 *         description: Target retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/IscsiInitiatorTarget'
 *                 timestamp:
 *                   type: string
 *                   format: date-time
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

// Get a specific target (admin only)
router.get('/targets/:targetId', checkRole(['admin']), async (req, res) => {
  try {
    const targetId = parseInt(req.params.targetId);

    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Target ID must be a positive integer'
      });
    }

    const result = await iscsiService.getInitiatorTarget(targetId);
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
 * /iscsi/initiator/targets/{targetId}:
 *   put:
 *     summary: Update a target
 *     description: Update configuration of an existing target (admin only)
 *     tags: [iSCSI Initiators]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: targetId
 *         required: true
 *         schema:
 *           type: integer
 *         description: Target ID to update
 *         example: 1647875123456
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateInitiatorTargetRequest'
 *           example:
 *             name: "iqn.2003-01.org.linux-iscsi.chipsserver.x8664:mos-updated"
 *             portal:
 *               address: "10.0.0.2"
 *               port: "3260"
 *             connection:
 *               automount: true
 *     responses:
 *       200:
 *         description: Target updated successfully
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
 *                   example: "Target 'iqn.2003-01.org.linux-iscsi.chipsserver.x8664:mos-updated' updated successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     config:
 *                       $ref: '#/components/schemas/IscsiInitiatorConfig'
 *                     updatedTarget:
 *                       $ref: '#/components/schemas/IscsiInitiatorTarget'
 *                     oldTarget:
 *                       $ref: '#/components/schemas/IscsiInitiatorTarget'
 *                     autoLogin:
 *                       type: object
 *                       description: Auto-login result (only present if automount was changed from false to true)
 *                       properties:
 *                         success:
 *                           type: boolean
 *                           example: true
 *                         message:
 *                           type: string
 *                           example: "Successfully logged in to target 'iqn.2003-01.org.linux-iscsi.chipsserver.x8664:mos'"
 *                         error:
 *                           type: string
 *                           description: Error message if auto-login failed
 *                 timestamp:
 *                   type: string
 *                   format: date-time
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

// Update a target (admin only)
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

    const result = await iscsiService.updateInitiatorTarget(targetId, updates);
    res.json(result);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: error.message
      });
    } else if (error.message.includes('already exists') || error.message.includes('must be a valid IQN')) {
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
 * /iscsi/initiator/targets/{targetId}:
 *   delete:
 *     summary: Remove a target
 *     description: Remove an existing target from the initiator configuration (admin only)
 *     tags: [iSCSI Initiators]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: targetId
 *         required: true
 *         schema:
 *           type: integer
 *         description: Target ID to remove
 *         example: 1647875123456
 *     responses:
 *       200:
 *         description: Target removed successfully
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
 *                   example: "Target 'iqn.2003-01.org.linux-iscsi.chipsserver.x8664:mos' removed successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     config:
 *                       $ref: '#/components/schemas/IscsiInitiatorConfig'
 *                     removedTarget:
 *                       $ref: '#/components/schemas/IscsiInitiatorTarget'
 *                 timestamp:
 *                   type: string
 *                   format: date-time
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

// Remove a target (admin only)
router.delete('/targets/:targetId', checkRole(['admin']), async (req, res) => {
  try {
    const targetId = parseInt(req.params.targetId);

    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Target ID must be a positive integer'
      });
    }

    const result = await iscsiService.removeInitiatorTarget(targetId);
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
 * /iscsi/initiator/test-connection:
 *   post:
 *     summary: Test connection to a target
 *     description: Test connectivity to an iSCSI target using discovery (admin only)
 *     tags: [iSCSI Initiators]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ConnectionTestRequest'
 *           example:
 *             targetIp: "10.0.0.1"
 *             targetPort: "3260"
 *     responses:
 *       200:
 *         description: Connection test completed (check success field for result)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   description: Whether connection test was successful
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Connection test to 10.0.0.1:3260 successful"
 *                 data:
 *                   type: object
 *                   properties:
 *                     targetIp:
 *                       type: string
 *                       example: "10.0.0.1"
 *                     targetPort:
 *                       type: string
 *                       example: "3260"
 *                     connected:
 *                       type: boolean
 *                       example: true
 *                     discoveredTargets:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/DiscoveredTarget'
 *                       description: List of discovered targets (only if successful)
 *                     error:
 *                       type: string
 *                       description: Error message (only if failed)
 *                 timestamp:
 *                   type: string
 *                   format: date-time
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

// Test connection to a target (admin only)
router.post('/test-connection', checkRole(['admin']), async (req, res) => {
  try {
    const { targetIp, targetPort = "3260" } = req.body;

    // Validate required fields
    if (!targetIp) {
      return res.status(400).json({
        success: false,
        error: 'Target IP address is required'
      });
    }

    const result = await iscsiService.testConnection(targetIp, targetPort);
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
 * /iscsi/initiator/targets/{targetId}/logout:
 *   post:
 *     summary: Logout from a target
 *     description: Logout from an iSCSI target session (admin only)
 *     tags: [iSCSI Initiators]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: targetId
 *         required: true
 *         schema:
 *           type: integer
 *         description: Target ID to logout from
 *         example: 1647875123456
 *     responses:
 *       200:
 *         description: Logout completed successfully
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
 *                   example: "Successfully logged out from target 'iqn.2003-01.org.linux-iscsi.chipsserver.x8664:mos'"
 *                 data:
 *                   type: object
 *                   properties:
 *                     targetIqn:
 *                       type: string
 *                       example: "iqn.2003-01.org.linux-iscsi.chipsserver.x8664:mos"
 *                     output:
 *                       type: string
 *                       description: Command output
 *                     wasLoggedIn:
 *                       type: boolean
 *                       description: Whether target was actually logged in
 *                 timestamp:
 *                   type: string
 *                   format: date-time
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

// Logout from a target (admin only)
router.post('/targets/:targetId/logout', checkRole(['admin']), async (req, res) => {
  try {
    const targetId = parseInt(req.params.targetId);

    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Target ID must be a positive integer'
      });
    }

    // Get Target-Informationen
    const targetResult = await iscsiService.getInitiatorTarget(targetId);
    const targetIqn = targetResult.data.name;

    // Perform Logout
    const result = await iscsiService.logoutInitiatorTarget(targetIqn);
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
 * /iscsi/initiator/targets/{targetId}/login:
 *   post:
 *     summary: Login to a target
 *     description: Login to an iSCSI target session (admin only)
 *     tags: [iSCSI Initiators]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: targetId
 *         required: true
 *         schema:
 *           type: integer
 *         description: Target ID to login to
 *         example: 1647875123456
 *     responses:
 *       200:
 *         description: Login completed successfully
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
 *                   example: "Successfully logged in to target 'iqn.2003-01.org.linux-iscsi.chipsserver.x8664:mos'"
 *                 data:
 *                   type: object
 *                   properties:
 *                     targetIqn:
 *                       type: string
 *                       example: "iqn.2003-01.org.linux-iscsi.chipsserver.x8664:mos"
 *                     targetPortal:
 *                       type: string
 *                       example: "10.0.0.1:3260"
 *                     output:
 *                       type: string
 *                       description: Command output
 *                 timestamp:
 *                   type: string
 *                   format: date-time
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

// Login to a target (admin only)
router.post('/targets/:targetId/login', checkRole(['admin']), async (req, res) => {
  try {
    const targetId = parseInt(req.params.targetId);

    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Target ID must be a positive integer'
      });
    }

    // Get Target-Informationen
    const targetResult = await iscsiService.getInitiatorTarget(targetId);
    const target = targetResult.data;
    const targetPortal = `${target.portal.address}:${target.portal.port}`;

    // Perform Login
    const result = await iscsiService.loginInitiatorTarget(target.name, targetPortal);
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