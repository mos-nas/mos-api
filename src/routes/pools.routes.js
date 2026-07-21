const express = require('express');
const router = express.Router();
const { checkRole, authenticateToken } = require('../middleware/auth.middleware');
const PoolsService = require('../services/pools.service');
const disksService = require('../services/disks.service');
const smartService = require('../services/smart.service');

// Initialize pools service for all operations
const poolsService = new PoolsService();

// Sub-router for MergerFS Path Pools (vpools).
router.use('/vpools', require('./vpools.routes'));

/**
 * @swagger
 * tags:
 *   name: Pools
 *   description: Storage Pool Management
 *
 * components:
 *   schemas:
 *     Error:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           description: Error message
 *           example: "Pool not found"
 *     Pool:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Pool ID
 *           example: "1234567890"
 *         name:
 *           type: string
 *           description: Pool name
 *           example: "data_pool"
 *         type:
 *           type: string
 *           description: Pool type
 *           example: "btrfs"
 *         automount:
 *           type: boolean
 *           description: Whether pool is automatically mounted
 *           example: true
 *         comment:
 *           type: string
 *           description: Pool comment
 *           example: "My data pool"
 *         data_devices:
 *           type: array
 *           description: Data devices in the pool
 *           items:
 *             type: object
 *             properties:
 *               device:
 *                 type: string
 *                 example: "/dev/sdj1"
 *               powerStatus:
 *                 type: string
 *                 enum: [active, standby, unknown]
 *               performance:
 *                 type: object
 *                 description: I/O performance (only with includeMetrics=true)
 *                 properties:
 *                   readSpeed:
 *                     type: number
 *                   writeSpeed:
 *                     type: number
 *                   readSpeed_human:
 *                     type: string
 *                   writeSpeed_human:
 *                     type: string
 *               temperature:
 *                 type: number
 *                 nullable: true
 *                 description: Temperature in Celsius (only with includeMetrics=true, null if standby)
 *               smartWarning:
 *                 type: boolean
 *                 description: True if any monitored SMART attribute has a non-zero value
 *               temperatureStatus:
 *                 type: string
 *                 nullable: true
 *                 enum: [null, warning, critical]
 *                 description: Temperature threshold status (null=no data/OK, warning=warning threshold exceeded, critical=critical threshold exceeded)
 *         parity_devices:
 *           type: array
 *           description: Parity devices in the pool
 *           items:
 *             type: object
 *         performance:
 *           type: object
 *           description: Pool-level total performance (only with includeMetrics=true)
 *           properties:
 *             readSpeed:
 *               type: number
 *             writeSpeed:
 *               type: number
 *             readSpeed_human:
 *               type: string
 *             writeSpeed_human:
 *               type: string
 *         config:
 *           type: object
 *           description: Pool configuration
 *           properties:
 *             encrypted:
 *               type: boolean
 *               description: Whether pool is encrypted
 *               example: false
 *             shared:
 *               type: boolean
 *               description: Whether pool is shared (applies to all pool types)
 *               example: false
 *         status:
 *           type: object
 *           description: Pool status information
 *           properties:
 *             parity_operation:
 *               type: boolean
 *               description: Whether a parity operation is currently running (MergerFS/NonRAID)
 *               example: true
 *             parity_valid:
 *               type: boolean
 *               description: Whether parity is valid (all disks OK or NP) - NonRAID only, null if unmounted or no parity
 *               example: true
 *             parity_progress:
 *               type: object
 *               description: Progress information for running parity operation
 *               properties:
 *                 operation:
 *                   type: string
 *                   description: Current operation (NonRAID only)
 *                   example: "check P Q"
 *                 description:
 *                   type: string
 *                   description: Human-readable description of the operation (NonRAID only)
 *                   example: "Checking both parities"
 *                 status:
 *                   type: string
 *                   description: Operation status
 *                   enum: [running, paused, preparing]
 *                   example: "running"
 *                 percent:
 *                   type: integer
 *                   description: Progress percentage
 *                   example: 52
 *                 height:
 *                   type: string
 *                   description: Data processed
 *                   example: "27.5 GB"
 *                 speed:
 *                   type: string
 *                   description: Current speed
 *                   example: "519 MB/s"
 *                 eta:
 *                   type: string
 *                   description: Estimated time to completion
 *                   example: "11:04"
 *                 correction_enabled:
 *                   type: boolean
 *                   description: Whether correction is enabled (NonRAID only)
 *                   example: false
 *                 start_time:
 *                   type: integer
 *                   description: Start time in seconds (NonRAID only)
 *                   example: 1732099200
 *                 end_time:
 *                   type: integer
 *                   description: End time in seconds (NonRAID only)
 *                   example: 1732102800
 *                 last_exit_code:
 *                   type: integer
 *                   description: Last sync exit code (0 = OK, < 0 = error) (NonRAID only)
 *                   example: 0
 *                 parity_errors:
 *                   type: integer
 *                   description: Number of parity errors detected (NonRAID only)
 *                   example: 0
 *                 stripes:
 *                   type: string
 *                   description: Stripes per second (SnapRAID only)
 *                   example: "495 stripe/s"
 */

/**
 * @swagger
 * /pools:
 *   get:
 *     summary: List all pools
 *     description: Get a list of all storage pools with optional filtering, performance and temperature data
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *         description: Filter pools by type
 *       - in: query
 *         name: exclude_type
 *         schema:
 *           type: string
 *         description: Exclude pools of specific type
 *       - in: query
 *         name: includeMetrics
 *         schema:
 *           type: boolean
 *         description: Include performance and temperature data for each disk
 *     responses:
 *       200:
 *         description: List of pools
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Pool'
 *       500:
 *         description: Server error
 */
// List all pools
router.get('/', authenticateToken, async (req, res) => {
  try {
    const filters = {
      type: req.query.type,
      exclude_type: req.query.exclude_type
    };

    // Remove undefined filters
    Object.keys(filters).forEach(key => filters[key] === undefined && delete filters[key]);

    const includeMetrics = req.query.includeMetrics === 'true';

    let pools = await poolsService.listPools(filters, req.user);

    // Add performance and temperature if requested
    if (includeMetrics) {
      pools = await Promise.all(pools.map(async pool => {
        const enrichedPool = { ...pool };

        // Process data_devices
        if (enrichedPool.data_devices) {
          enrichedPool.data_devices = await Promise.all(
            enrichedPool.data_devices.map(async disk => {
              if (!disk.device) return { ...disk, performance: null, temperature: null };
              const enrichedDisk = { ...disk };
              enrichedDisk.performance = disksService.getDiskThroughput(disk.device, req.user);

              if (disk.powerStatus === 'active') {
                const tempData = await disksService.getDiskTemperature(disk.device);
                enrichedDisk.temperature = tempData?.temperature || null;
              } else {
                enrichedDisk.temperature = null;
              }

              return enrichedDisk;
            })
          );
        }

        // Process parity_devices
        if (enrichedPool.parity_devices) {
          enrichedPool.parity_devices = await Promise.all(
            enrichedPool.parity_devices.map(async disk => {
              if (!disk.device) return { ...disk, performance: null, temperature: null };
              const enrichedDisk = { ...disk };
              enrichedDisk.performance = disksService.getDiskThroughput(disk.device, req.user);

              if (disk.powerStatus === 'active') {
                const tempData = await disksService.getDiskTemperature(disk.device);
                enrichedDisk.temperature = tempData?.temperature || null;
              } else {
                enrichedDisk.temperature = null;
              }

              return enrichedDisk;
            })
          );
        }

        // Add pool-level total performance
        const devices = [];
        if (pool.data_devices) {
          pool.data_devices.forEach(d => d.device && devices.push(d.device));
        }
        if (pool.parity_devices) {
          pool.parity_devices.forEach(d => d.device && devices.push(d.device));
        }
        enrichedPool.performance = devices.length > 0
          ? disksService.getPoolThroughput(devices, req.user)
          : null;
        if (enrichedPool.performance) {
          delete enrichedPool.performance.disks;
        }

        return enrichedPool;
      }));
    }

    for (const pool of pools) {
      for (const device of pool.data_devices || []) {
        const serial = device.diskInfo?.diskSerial;
        device.smartWarning = serial ? smartService.hasDiskWarning(serial) : false;
        device.temperatureStatus = serial ? smartService.getDiskTemperatureStatus(serial) : null;
      }
      for (const device of pool.parity_devices || []) {
        const serial = device.diskInfo?.diskSerial;
        device.smartWarning = serial ? smartService.hasDiskWarning(serial) : false;
        device.temperatureStatus = serial ? smartService.getDiskTemperatureStatus(serial) : null;
      }
    }

    res.json(pools);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


/**
  * @swagger
  * /pools/availablepooltypes:
  *   get:
  *     summary: Get available pool types
  *     description: Retrieve a simple array of available pool types.
  *     tags: [Pools]
  *     security:
  *       - bearerAuth: []
  *     responses:
  *       200:
  *         description: Available pool types retrieved successfully
  *         content:
  *           application/json:
  *             schema:
  *               type: array
  *               items:
  *                 type: string
  *               example: ["single", "multi", "mergerfs", "nonraid"]
  *       401:
  *         description: Not authenticated
  *         content:
  *           application/json:
  *             schema:
  *               $ref: '#/components/schemas/Error'
  *       500:
  *         description: Error getting available filesystems
  *         content:
  *           application/json:
  *             schema:
  *               $ref: '#/components/schemas/Error'
  */

// Get available pool types
router.get('/availablepooltypes', async (req, res) => {
  try {
    const availablePoolTypes = await poolsService.getAvailablePoolTypes();
    res.json(availablePoolTypes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}:
 *   get:
 *     summary: Get pool by ID
 *     description: Get a specific pool by its ID
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     responses:
 *       200:
 *         description: Pool details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Pool'
 *       404:
 *         description: Pool not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Get pool by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === id);

    if (!pool) {
      return res.status(404).json({ error: `Pool with ID "${id}" not found` });
    }

    for (const device of pool.data_devices || []) {
      const serial = device.diskInfo?.diskSerial;
      device.smartWarning = serial ? smartService.hasDiskWarning(serial) : false;
      device.temperatureStatus = serial ? smartService.getDiskTemperatureStatus(serial) : null;
    }
    for (const device of pool.parity_devices || []) {
      const serial = device.diskInfo?.diskSerial;
      device.smartWarning = serial ? smartService.hasDiskWarning(serial) : false;
      device.temperatureStatus = serial ? smartService.getDiskTemperatureStatus(serial) : null;
    }

    res.json(pool);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/status:
 *   get:
 *     summary: Get pool status
 *     description: Get the status of a specific pool by its ID
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     responses:
 *       200:
 *         description: Pool status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       404:
 *         description: Pool not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 */
// Get pool status
router.get('/:id/status', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === id);

    if (!pool) {
      return res.status(404).json({ error: 'Pool not found' });
    }

    return res.json(pool.status || {});
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/automount:
 *   post:
 *     summary: Toggle automount setting for a pool
 *     description: Enable or disable automatic mounting of a pool on system boot (admin only)
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - enabled
 *             properties:
 *               enabled:
 *                 type: boolean
 *                 description: Whether to enable or disable automount
 *                 example: true
 *     responses:
 *       200:
 *         description: Automount setting updated successfully
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
 *                   example: "Automount enabled for pool 'data_pool' (ID: 1746318722394)"
 *                 pool:
 *                   $ref: '#/components/schemas/Pool'
 *       400:
 *         description: Invalid request parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Pool not found
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
// Toggle automount by ID (admin only)
router.post('/:id/automount', checkRole(['admin']), async (req, res) => {
  try {
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        error: 'enabled parameter must be a boolean'
      });
    }

    // Use pools service directly
    const result = await poolsService.toggleAutomountById(req.params.id, enabled);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/shared:
 *   post:
 *     summary: Toggle shared mount propagation for a pool
 *     description: Enable or disable shared mount propagation (mount --make-shared / --make-private) live without remounting; the setting is persisted and reapplied on mount (admin only)
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - enabled
 *             properties:
 *               enabled:
 *                 type: boolean
 *                 description: Whether to enable (make-shared) or disable (make-private) shared propagation
 *                 example: true
 *     responses:
 *       200:
 *         description: Shared setting updated successfully
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
 *                   example: "Shared enabled for pool 'data_pool' (ID: 1746318722394)"
 *                 pool:
 *                   $ref: '#/components/schemas/Pool'
 *       400:
 *         description: Invalid request parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Pool not found
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
// Toggle shared mount propagation by ID (admin only)
router.post('/:id/shared', checkRole(['admin']), async (req, res) => {
  try {
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        error: 'enabled parameter must be a boolean'
      });
    }

    // Use pools service directly
    const result = await poolsService.toggleSharedById(req.params.id, enabled);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/comment:
 *   patch:
 *     summary: Update pool comment
 *     description: Update the comment/description for a storage pool (admin only)
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - comment
 *             properties:
 *               comment:
 *                 type: string
 *                 description: Pool comment
 *                 example: "My storage pool"
 *     responses:
 *       200:
 *         description: Comment updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 pool:
 *                   $ref: '#/components/schemas/Pool'
 *       400:
 *         description: Bad request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Pool not found
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
// Update pool comment
router.patch('/:id/comment', checkRole(['admin']), async (req, res) => {
  try {
    const { comment } = req.body;

    // Get the appropriate service
    const result = await poolsService.updatePoolComment(req.params.id, comment);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/config:
 *   get:
 *     summary: Get pool configuration
 *     description: Retrieve the configuration settings for a specific pool
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     responses:
 *       200:
 *         description: Pool configuration retrieved successfully (returns config object directly)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: The pool's configuration object
 *               example:
 *                 unclean_check: true
 *                 encrypted: false
 *                 shared: false
 *                 sync:
 *                   enabled: true
 *                   schedule: "0 4 * * *"
 *       404:
 *         description: Pool not found
 *       500:
 *         description: Server error
 *   patch:
 *     summary: Update pool configuration
 *     description: |
 *       Update configuration settings for a pool (works for all pool types - mergerfs, btrfs, xfs, etc.)
 *
 *       **Supports dot-notation for nested properties:**
 *       - Direct: `{ "unclean_check": false }`
 *       - Nested: `{ "sync.enabled": true, "sync.schedule": "0 5 * * *" }`
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               unclean_check:
 *                 type: boolean
 *                 description: Enable/disable unclean filesystem check on mount
 *               encrypted:
 *                 type: boolean
 *                 description: Whether pool is encrypted
 *               raid_level:
 *                 type: string
 *                 description: RAID level for BTRFS pools
 *               shared:
 *                 type: boolean
 *                 description: Whether pool is shared (applies to all pool types - mergerfs, nonraid, btrfs, xfs, ext4)
 *               sync.enabled:
 *                 type: boolean
 *                 description: Enable SnapRAID sync (dot-notation example)
 *               sync.schedule:
 *                 type: string
 *                 description: SnapRAID sync cron schedule (dot-notation example)
 *               usage_alert.warning:
 *                 type: integer
 *                 description: "Usage warning threshold in percent (default 70). 0 disables the warning level."
 *                 example: 70
 *               usage_alert.alert:
 *                 type: integer
 *                 description: "Usage alert threshold in percent (default 90). 0 disables the alert level. warning=0 AND alert=0 disables usage monitoring for the pool."
 *                 example: 90
 *           examples:
 *             shared:
 *               summary: Toggle shared status
 *               value:
 *                 shared: true
 *             direct:
 *               summary: Direct property
 *               value:
 *                 unclean_check: false
 *             dotNotation:
 *               summary: Nested with dot-notation
 *               value:
 *                 sync.enabled: true
 *                 sync.schedule: "0 5 * * *"
 *     responses:
 *       200:
 *         description: Configuration updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 pool:
 *                   type: object
 *                 updatedConfig:
 *                   type: object
 *       404:
 *         description: Pool not found
 *       500:
 *         description: Server error
 */
// Get pool configuration
router.get('/:id/config', checkRole(['admin']), async (req, res) => {
  try {
    const result = await poolsService.getPoolConfig(req.params.id);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update pool configuration
router.patch('/:id/config', checkRole(['admin']), async (req, res) => {
  try {
    const configUpdates = req.body;

    if (!configUpdates || Object.keys(configUpdates).length === 0) {
      return res.status(400).json({ error: 'No configuration updates provided' });
    }

    const result = await poolsService.updatePoolConfig(req.params.id, configUpdates);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/order:
 *   put:
 *     summary: Update order of all pools
 *     description: Update the display order for multiple pools at once by providing an array of pool IDs with their new index values (admin only)
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - order
 *             properties:
 *               order:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     index:
 *                       type: integer
 *     responses:
 *       200:
 *         description: Order updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: Bad request
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
// Update pools order
router.put('/order', checkRole(['admin']), async (req, res) => {
  try {
    const { order } = req.body;

    if (!Array.isArray(order)) {
      return res.status(400).json({
        error: 'Order must be an array'
      });
    }

    // Use base service for this operation
    const result = await poolsService.updatePoolsOrder(order);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/single:
 *   post:
 *     summary: Create single device pool
 *     description: Create a new single device pool
 *     tags: [Pools]
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
 *               - device
 *             properties:
 *               name:
 *                 type: string
 *                 description: Name for the new pool
 *                 example: "data_pool"
 *               device:
 *                 type: string
 *                 description: Path to the device to use
 *                 example: "/dev/sdb"
 *               filesystem:
 *                 type: string
 *                 description: Filesystem to format the device with
 *                 enum: [ext4, xfs, btrfs]
 *                 default: xfs
 *                 example: xfs
 *               format:
 *                 type: boolean
 *                 description: Whether to force format the device
 *                 example: false
 *               config:
 *                 type: object
 *                 properties:
 *                   encrypted:
 *                     type: boolean
 *                     description: Enable LUKS encryption
 *                     default: false
 *                     example: false
 *                   create_keyfile:
 *                     type: boolean
 *                     description: Create keyfile for automatic mounting
 *                     default: false
 *                     example: false
 *               passphrase:
 *                 type: string
 *                 description: Encryption passphrase (required if encrypted=true)
 *                 example: "my_secure_password"
 *               options:
 *                 type: object
 *                 properties:
 *                   automount:
 *                     type: boolean
 *                     description: Whether to automatically mount the pool
 *                     default: false
 *                     example: true
 *                   comment:
 *                     type: string
 *                     description: Optional comment for the pool
 *                     example: "My data pool"
 *     responses:
 *       201:
 *         description: Pool created successfully
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
 *                   example: "Successfully created single device pool 'data_pool'"
 *                 pool:
 *                   type: object
 *                   description: Created pool object
 *       400:
 *         description: Bad request
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
 */
// Create single device pool (admin only)
router.post('/single', checkRole(['admin']), async (req, res) => {
  try {
    const {
      name,
      device,
      filesystem = null,
      format,
      options = {},
      automount,
      config = {},
      passphrase
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    if (!device) {
      return res.status(400).json({ error: 'Device path is required' });
    }

    // Prepare pool options
    const poolOptions = { ...options };
    if (automount !== undefined) {
      poolOptions.automount = automount;
    }
    if (config && Object.keys(config).length > 0) {
      poolOptions.config = config;
    }
    if (config.encrypted) {
      poolOptions.passphrase = passphrase || '';
    }

    // Get the appropriate service and create the pool
    // Use poolsService directly
    const result = await poolsService.createSingleDevicePool(
      name,
      device,
      filesystem,
      { ...poolOptions, format: format }
    );

    return res.status(201).json(result);
  } catch (error) {
    console.error(error);
    return res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/multi:
 *   post:
 *     summary: Create multi-device BTRFS pool
 *     description: Create a new multi-device BTRFS pool
 *     tags: [Pools]
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
 *               - devices
 *               - raidLevel
 *             properties:
 *               name:
 *                 type: string
 *                 description: Name for the new pool
 *                 example: "data_raid1"
 *               devices:
 *                 type: array
 *                 description: Array of device paths to use in the pool
 *                 items:
 *                   type: string
 *                 example: ["/dev/sdb", "/dev/sdc"]
 *               raidLevel:
 *                 type: string
 *                 description: BTRFS RAID level for the pool
 *                 enum: [single, raid0, raid1, raid10]
 *                 example: raid1
 *               format:
 *                 type: boolean
 *                 description: Whether to force format the devices
 *                 example: true
 *               config:
 *                 type: object
 *                 properties:
 *                   encrypted:
 *                     type: boolean
 *                     description: Enable LUKS encryption
 *                     default: false
 *                     example: false
 *                   create_keyfile:
 *                     type: boolean
 *                     description: Create keyfile for automatic mounting
 *                     default: false
 *                     example: false
 *               passphrase:
 *                 type: string
 *                 description: Encryption passphrase (required if encrypted=true)
 *                 example: "my_secure_password"
 *               options:
 *                 type: object
 *                 properties:
 *                   automount:
 *                     type: boolean
 *                     description: Whether to automatically mount the pool
 *                     default: false
 *                     example: true
 *                   comment:
 *                     type: string
 *                     description: Optional comment for the pool
 *                     example: "My RAID1 pool"
 *     responses:
 *       201:
 *         description: Pool created successfully
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
 *                   example: "Successfully created multi-device BTRFS pool 'data_raid1' with raid1 configuration"
 *                 pool:
 *                   type: object
 *                   description: Created pool object
 *       400:
 *         description: Bad request
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
 */
// Create multi-device pool (admin only)
router.post('/multi', checkRole(['admin']), async (req, res) => {
  try {
    const {
      name,
      devices,
      raidLevel = 'raid1',
      format,
      options = {},
      config = {},
      passphrase
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    if (!Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({ error: 'At least one device is required' });
    }

    // Prepare pool options
    const poolOptions = { ...options };
    if (config && Object.keys(config).length > 0) {
      poolOptions.config = config;
    }
    if (config.encrypted) {
      poolOptions.passphrase = passphrase || '';
    }

    // Get the appropriate service and create the pool
    // Use poolsService directly
    const result = await poolsService.createMultiDevicePool(
      name,
      devices,
      raidLevel,
      { ...poolOptions, format: format }
    );

    return res.status(201).json(result);
  } catch (error) {
    console.error(error);
    return res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/mergerfs:
 *   post:
 *     summary: Create MergerFS pool
 *     description: Create a new MergerFS pool
 *     tags: [Pools]
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
 *               - devices
 *             properties:
 *               name:
 *                 type: string
 *                 description: Name for the new pool
 *                 example: "mergerfs_pool"
 *               devices:
 *                 type: array
 *                 description: Array of device paths to use in the pool
 *                 items:
 *                   type: string
 *                 example: ["/dev/sdb", "/dev/sdc"]
 *               filesystem:
 *                 type: string
 *                 description: Filesystem to format individual devices with
 *                 enum: [ext4, xfs, btrfs]
 *                 default: xfs
 *                 example: xfs
 *               format:
 *                 type: boolean
 *                 description: Whether to force format the devices
 *                 example: true
 *               config:
 *                 type: object
 *                 properties:
 *                   encrypted:
 *                     type: boolean
 *                     description: Enable LUKS encryption
 *                     default: false
 *                     example: false
 *                   create_keyfile:
 *                     type: boolean
 *                     description: Create keyfile for automatic mounting
 *                     default: false
 *                     example: false
 *               passphrase:
 *                 type: string
 *                 description: Encryption passphrase (required if encrypted=true)
 *                 example: "my_secure_password"
 *               options:
 *                 type: object
 *                 properties:
 *                   automount:
 *                     type: boolean
 *                     description: Whether to automatically mount the pool
 *                     default: false
 *                     example: true
 *                   comment:
 *                     type: string
 *                     description: Optional comment for the pool
 *                     example: "My MergerFS pool"
 *                   mergerfsOptions:
 *                     type: string
 *                     description: MergerFS mount options
 *                     default: "defaults,allow_other,direct_io=auto,moveonenospc=true,category.create=mfs,minfree=5G"
 *                     example: "defaults,allow_other,direct_io=auto"
 *               skip_size_check:
 *                 type: boolean
 *                 description: Skip the parity device size validation (SnapRAID normally requires parity >= largest data device)
 *                 default: false
 *                 example: false
 *     responses:
 *       201:
 *         description: Pool created successfully
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
 *                   example: "Successfully created MergerFS pool 'mergerfs_pool' with 2 device(s)"
 *                 pool:
 *                   type: object
 *                   description: Created pool object
 *       400:
 *         description: Bad request
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
 */
// Create MergerFS pool (admin only)
router.post('/mergerfs', checkRole(['admin']), async (req, res) => {
  try {
    const {
      name,
      devices,
      filesystem = 'xfs',
      format,
      options = {},
      config = {},
      passphrase,
      skip_size_check = false
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    if (!Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({ error: 'At least one device is required' });
    }

    // Prepare pool options
    const poolOptions = { ...options };
    if (config && Object.keys(config).length > 0) {
      poolOptions.config = config;
    }
    if (config.encrypted) {
      poolOptions.passphrase = passphrase || '';
    }

    // Get the appropriate service and create the pool
    // Use poolsService directly
    const result = await poolsService.createMergerFSPool(
      name,
      devices,
      filesystem,
      { ...poolOptions, format: format, skip_size_check: skip_size_check === true }
    );

    return res.status(201).json(result);
  } catch (error) {
    console.error(error);
    return res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/nonraid:
 *   post:
 *     summary: Create NonRAID pool
 *     description: |
 *       Create a new NonRAID pool with optional parity devices (max 2).
 *
 *       **Important:**
 *       - Only one NonRAID pool per system
 *       - Parity check runs automatically after creation unless parity_valid is true
 *       - When parity_valid is true, parity is marked as valid and no check runs
 *     tags: [Pools]
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
 *               - devices
 *             properties:
 *               name:
 *                 type: string
 *                 description: Name for the new pool (only one NonRAID pool allowed per system)
 *                 example: "nonraid_pool"
 *               devices:
 *                 type: array
 *                 description: Array of device paths to use in the pool (max 28 devices)
 *                 items:
 *                   type: string
 *                 example: ["/dev/sdb", "/dev/sdc", "/dev/sdd"]
 *               filesystem:
 *                 type: string
 *                 description: Filesystem to format individual devices with
 *                 enum: [ext4, xfs, btrfs]
 *                 default: xfs
 *                 example: xfs
 *               format:
 *                 type: boolean
 *                 description: Whether to force format the devices
 *                 example: true
 *               parity:
 *                 type: array
 *                 description: Array of parity device paths (max 2 devices)
 *                 items:
 *                   type: string
 *                 example: ["/dev/sde", "/dev/sdf"]
 *               parity_valid:
 *                 type: boolean
 *                 description: Whether existing parity is valid (for importing existing arrays)
 *                 default: false
 *                 example: false
 *               config:
 *                 type: object
 *                 properties:
 *                   encrypted:
 *                     type: boolean
 *                     description: Enable LUKS encryption (only for data devices, not parity)
 *                     default: false
 *                     example: false
 *                   create_keyfile:
 *                     type: boolean
 *                     description: Create keyfile for automatic mounting
 *                     default: false
 *                     example: false
 *                   md_writemode:
 *                     type: string
 *                     description: Write mode for NonRAID (normal or turbo)
 *                     enum: [normal, turbo]
 *                     default: normal
 *                     example: normal
 *               passphrase:
 *                 type: string
 *                 description: Encryption passphrase (required if encrypted=true)
 *                 example: "my_secure_password"
 *               options:
 *                 type: object
 *                 properties:
 *                   automount:
 *                     type: boolean
 *                     description: Whether to automatically mount the pool
 *                     default: false
 *                     example: true
 *                   comment:
 *                     type: string
 *                     description: Optional comment for the pool
 *                     example: "My NonRAID pool"
 *                   policies:
 *                     type: object
 *                     properties:
 *                       create:
 *                         type: string
 *                         description: MergerFS create policy
 *                         default: mspmfs
 *                         example: mspmfs
 *                       search:
 *                         type: string
 *                         description: MergerFS search policy
 *                         default: ff
 *                         example: ff
 *     responses:
 *       201:
 *         description: Pool created successfully
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
 *                   example: "Successfully created NonRAID pool 'nonraid_pool' with 2 parity device(s). Parity check started"
 *                 pool:
 *                   type: object
 *                   description: Created pool object
 *       400:
 *         description: Bad request
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
 */
// Create NonRAID pool (admin only)
router.post('/nonraid', checkRole(['admin']), async (req, res) => {
  try {
    const {
      name,
      devices,
      filesystem = 'xfs',
      format,
      parity = [],
      parity_valid = false,
      options = {},
      config = {},
      passphrase
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    if (!Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({ error: 'At least one data device is required' });
    }

    if (devices.length > 28) {
      return res.status(400).json({ error: 'NonRAID pools support a maximum of 28 data devices' });
    }

    if (Array.isArray(parity) && parity.length > 2) {
      return res.status(400).json({ error: 'NonRAID pools support a maximum of 2 parity devices' });
    }

    // Prepare pool options
    const poolOptions = { ...options };
    if (config && Object.keys(config).length > 0) {
      poolOptions.config = config;
    }
    if (config.encrypted) {
      poolOptions.passphrase = passphrase || '';
    }

    // Add parity devices if provided
    if (Array.isArray(parity) && parity.length > 0) {
      poolOptions.parity = parity;
    }

    // Add parity_valid flag if provided
    if (parity_valid === true) {
      poolOptions.parity_valid = true;
    }

    // Create the NonRAID pool
    const result = await poolsService.createNonRaidPool(
      name,
      devices,
      filesystem,
      { ...poolOptions, format: format }
    );

    return res.status(201).json(result);
  } catch (error) {
    console.error(error);
    return res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/nonraid/replace:
 *   post:
 *     summary: Replace devices in a NonRAID pool
 *     description: |
 *       Replace one or more devices in the NonRAID pool with parity reconstruction (admin only).
 *
 *       **Important:**
 *       - Only one NonRAID pool can exist per system
 *       - Pool must be unmounted before replacement
 *       - Maximum replacements: 1 device with 1 parity, 2 devices with 2 parities
 *       - Data and parity devices can be replaced simultaneously
 *       - Parity reconstruction starts automatically after replacement
 *
 *       **Size Requirements:**
 *       - New data devices must be <= smallest parity device
 *       - New parity devices must be >= largest data device
 *
 *       **Encryption:**
 *       - Passphrase required when replacing data devices in encrypted pools
 *       - New data devices will be encrypted with the existing key
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - replacements
 *               - format
 *             properties:
 *               replacements:
 *                 type: array
 *                 description: Array of device replacements (slot and new device path)
 *                 items:
 *                   type: object
 *                   required:
 *                     - slot
 *                     - newDevice
 *                   properties:
 *                     slot:
 *                       type: string
 *                       description: Slot number to replace (data slots 1-28, parity slots 1-2)
 *                       example: "2"
 *                     newDevice:
 *                       type: string
 *                       description: Path to new device
 *                       example: "/dev/sdg"
 *                 example:
 *                   - slot: "2"
 *                     newDevice: "/dev/sdg"
 *                   - slot: "3"
 *                     newDevice: "/dev/sdh"
 *               format:
 *                 type: boolean
 *                 description: Must be true (devices will be formatted)
 *                 example: true
 *               passphrase:
 *                 type: string
 *                 description: Encryption passphrase (required for encrypted pools with data replacements)
 *                 example: "my_secure_password"
 *     responses:
 *       200:
 *         description: Devices replaced successfully, parity reconstruction started
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
 *                   example: "Successfully replaced 2 device(s) in NonRAID pool 'media'. Parity reconstruction started."
 *                 pool:
 *                   type: object
 *                   description: Updated pool object
 *                 replacements:
 *                   type: object
 *                   properties:
 *                     data:
 *                       type: integer
 *                       description: Number of data devices replaced
 *                       example: 1
 *                     parity:
 *                       type: integer
 *                       description: Number of parity devices replaced
 *                       example: 1
 *       400:
 *         description: Bad request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               pool_mounted:
 *                 value:
 *                   error: "Pool must be unmounted before replacing devices. Please unmount the pool first."
 *               too_many_replacements:
 *                 value:
 *                   error: "Cannot replace 2 data device(s) with only 1 parity device(s). Maximum 1 device(s) can be replaced at once."
 *               size_mismatch:
 *                 value:
 *                   error: "New data device /dev/sdg (500.00 GB) is larger than smallest parity device (250.00 GB)"
 *               missing_passphrase:
 *                 value:
 *                   error: "Passphrase is required for replacing devices in encrypted pools"
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: NonRAID pool not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "No NonRAID pool found on this system"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Replace devices in NonRAID pool (admin only)
router.post('/nonraid/replace', checkRole(['admin']), async (req, res) => {
  try {
    const { replacements, format = false, passphrase } = req.body;

    if (!Array.isArray(replacements) || replacements.length === 0) {
      return res.status(400).json({ error: 'At least one replacement is required' });
    }

    if (format !== true) {
      return res.status(400).json({ error: 'format must be true for device replacement' });
    }

    // Validate replacement structure
    for (const replacement of replacements) {
      if (!replacement.slot) {
        return res.status(400).json({ error: 'slot is required for each replacement' });
      }
      if (!replacement.newDevice) {
        return res.status(400).json({ error: 'newDevice is required for each replacement' });
      }
    }

    // Find the NonRAID pool (only one can exist)
    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.type === 'nonraid');

    if (!pool) {
      return res.status(404).json({ error: 'No NonRAID pool found on this system' });
    }

    // Replace devices
    const result = await poolsService.replaceDevicesInNonRaidPool(
      pool.id,
      replacements,
      { format, passphrase }
    );

    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/nonraid/adddevice:
 *   post:
 *     summary: Add data device to NonRAID pool
 *     description: |
 *       Add a new data device to the NonRAID pool (admin only).
 *       Device will be assigned the next available slot (1-28) automatically.
 *
 *       **Modes:**
 *       - format: true - Create partition and format device with specified filesystem
 *       - format: false - Import existing partition/filesystem (device must have usable filesystem)
 *
 *       **Important:**
 *       - Pool must be unmounted before adding device
 *       - Parity check runs automatically unless parity_valid is true
 *       - Passphrase required for encrypted pools
 *
 *       **Size Requirements:**
 *       - New data device must be <= smallest parity device
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - device
 *             properties:
 *               device:
 *                 type: string
 *                 description: Path to new data device
 *                 example: "/dev/sdg"
 *               format:
 *                 type: boolean
 *                 description: Format mode - true to create partition and format, false to import existing filesystem
 *                 default: false
 *                 example: true
 *               filesystem:
 *                 type: string
 *                 description: Filesystem type (defaults to pool's existing filesystem)
 *                 enum: [xfs, ext4, btrfs]
 *                 example: xfs
 *               passphrase:
 *                 type: string
 *                 description: Encryption passphrase (required for encrypted pools)
 *                 example: "my_secure_password"
 *               parity_valid:
 *                 type: boolean
 *                 description: If true, skip parity check (parity is already valid)
 *                 default: false
 *                 example: false
 *     responses:
 *       200:
 *         description: Device added successfully
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
 *                   example: "Successfully added data device to NonRAID pool 'media' at slot 5. Parity check started."
 *                 pool:
 *                   type: object
 *                 slot:
 *                   type: integer
 *                   description: Assigned slot number
 *                   example: 5
 *       400:
 *         description: Bad request
 *       404:
 *         description: NonRAID pool not found
 *       500:
 *         description: Server error
 */
router.post('/nonraid/adddevice', checkRole(['admin']), async (req, res) => {
  try {
    const { device, format = false, filesystem, passphrase, parity_valid = false } = req.body;

    if (!device) {
      return res.status(400).json({ error: 'device path is required' });
    }

    const result = await poolsService.addDataDeviceToNonRaidPool(device, {
      format,
      filesystem,
      passphrase,
      parity_valid
    });

    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/nonraid/addparity:
 *   post:
 *     summary: Add parity device to NonRAID pool
 *     description: |
 *       Add a new parity device to the NonRAID pool (admin only).
 *       Device will be assigned the next available parity slot (1 or 2) automatically.
 *
 *       **Important:**
 *       - Pool must be unmounted before adding parity
 *       - Maximum 2 parity devices allowed
 *       - Parity check ALWAYS runs when adding parity
 *       - Parity device is NOT formatted
 *
 *       **Size Requirements:**
 *       - Parity device must be >= largest data device
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - device
 *             properties:
 *               device:
 *                 type: string
 *                 description: Path to new parity device (whole disk, not partition)
 *                 example: "/dev/sdg"
 *     responses:
 *       200:
 *         description: Parity device added successfully
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
 *                   example: "Successfully added parity device to NonRAID pool 'media' at slot 2. Parity check started."
 *                 pool:
 *                   type: object
 *                 slot:
 *                   type: integer
 *                   description: Assigned parity slot number (1 or 2)
 *                   example: 2
 *       400:
 *         description: Bad request
 *       404:
 *         description: NonRAID pool not found
 *       500:
 *         description: Server error
 */
router.post('/nonraid/addparity', checkRole(['admin']), async (req, res) => {
  try {
    const { device } = req.body;

    if (!device) {
      return res.status(400).json({ error: 'device path is required' });
    }

    const result = await poolsService.addParityDeviceToNonRaidPool(device);

    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/mount:
 *   post:
 *     summary: Mount pool by ID
 *     description: Mount a storage pool
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               passphrase:
 *                 type: string
 *                 description: Encryption passphrase (if required)
 *                 example: "my_secure_password"
 *               mountOptions:
 *                 type: string
 *                 description: Additional mount options
 *                 example: "noatime"
 *               mount_missing:
 *                 type: boolean
 *                 description: Allow mounting NonRAID pools in degraded mode with missing devices (requires sufficient parity)
 *                 default: false
 *                 example: false
 *     responses:
 *       200:
 *         description: Pool mounted successfully
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
 *                   example: "Pool 'data_pool' mounted successfully"
 *       404:
 *         description: Pool not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Mount pool
router.post('/:id/mount', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { passphrase, mountOptions } = req.body || {};

    // Get the pool first to determine the appropriate service
    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === id);

    if (!pool) {
      return res.status(404).json({ error: `Pool with ID "${id}" not found` });
    }

    // Get the appropriate service and mount the pool
    const result = await poolsService.mountPoolById(id, {
      passphrase,
      mountOptions,
      ...(req.body || {})
    });

    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/unmount:
 *   post:
 *     summary: Unmount pool by ID
 *     description: Unmount a storage pool
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               force:
 *                 type: boolean
 *                 description: Force unmount
 *                 default: false
 *                 example: false
 *     responses:
 *       200:
 *         description: Pool unmounted successfully
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
 *                   example: "Pool 'data_pool' unmounted successfully"
 *       404:
 *         description: Pool not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Unmount pool
router.post('/:id/unmount', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { force = false } = req.body || {};

    // Get the pool first to determine the appropriate service
    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === id);

    if (!pool) {
      return res.status(404).json({ error: `Pool with ID "${id}" not found` });
    }

    // Get the appropriate service and unmount the pool
    const result = await poolsService.unmountPoolById(id, {
      force,
      ...(req.body || {})
    });

    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}:
 *   delete:
 *     summary: Remove pool by ID
 *     description: Remove a storage pool
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     responses:
 *       200:
 *         description: Pool removed successfully
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
 *                   example: "Pool 'data_pool' removed successfully"
 *       404:
 *         description: Pool not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Remove pool (admin only)
router.delete('/:id', checkRole(['admin']), async (req, res) => {
  try {
    const { id } = req.params;

    // Get the pool first to determine the appropriate service
    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === id);

    if (!pool) {
      return res.status(404).json({ error: `Pool with ID "${id}" not found` });
    }

    // Get the appropriate service and remove the pool
    const result = await poolsService.removePoolById(id, req.body || {});

    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/devices:
 *   post:
 *     summary: Add devices to pool
 *     description: Add new devices to an existing pool
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - devices
 *             properties:
 *               devices:
 *                 type: array
 *                 description: Array of device paths to add
 *                 items:
 *                   type: string
 *                 example: ["/dev/sdd", "/dev/sde"]
 *               format:
 *                 type: boolean
 *                 description: Whether to format the devices
 *                 example: true
 *     responses:
 *       200:
 *         description: Devices added successfully
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
 *                   example: "Successfully added 2 device(s) to pool"
 *       404:
 *         description: Pool not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Add devices to pool (admin only)
router.post('/:id/devices', checkRole(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { devices, format } = req.body;

    if (!Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({ error: 'At least one device is required' });
    }

    // Get the pool first to determine the appropriate service
    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === id);

    if (!pool) {
      return res.status(404).json({ error: `Pool with ID "${id}" not found` });
    }

    // Get the appropriate service and add devices
    const result = await poolsService.addDevicesToPool(id, devices, { format });

    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/status:
 *   get:
 *     summary: Get pool status
 *     description: Get the current status of a pool
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     responses:
 *       200:
 *         description: Pool status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 mounted:
 *                   type: boolean
 *                   example: true
 *                 mountPoint:
 *                   type: string
 *                   example: "/mnt/storage/data_pool"
 *       404:
 *         description: Pool not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Get pool status
router.get('/:id/status', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Get the pool first
    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === id);

    if (!pool) {
      return res.status(404).json({ error: `Pool with ID "${id}" not found` });
    }

    // Get pool status using base service
    const status = await poolsService._getPoolStatus(pool);

    res.json(status);
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/parity/add:
 *   post:
 *     summary: Add parity devices to a MergerFS pool
 *     description: Add one or more parity devices to an existing MergerFS pool for SnapRAID protection (admin only). Devices will be formatted if needed and SnapRAID configuration will be updated.
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - devices
 *             properties:
 *               devices:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: List of parity device paths to add
 *                 example: ["/dev/sdd", "/dev/sde"]
 *               format:
 *                 type: boolean
 *                 description: Whether to force format the devices before adding
 *                 default: false
 *                 example: false
 *               skip_size_check:
 *                 type: boolean
 *                 description: Skip the parity device size validation (SnapRAID normally requires parity >= largest data device)
 *                 default: false
 *                 example: false
 *     responses:
 *       200:
 *         description: Parity devices added successfully
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
 *                   example: "Successfully added 2 parity device(s) to pool 'media'"
 *                 pool:
 *                   type: object
 *                   description: Updated pool object
 *       400:
 *         description: Bad request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Pool not found
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

// Add parity devices to an existing MergerFS pool (admin only)
router.post('/:id/parity/add', checkRole(['admin']), async (req, res) => {
  try {
    const { devices, format = false, skip_size_check = false } = req.body;

    if (!Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({ error: 'At least one parity device is required' });
    }

    // Get the pool first to determine the appropriate service
    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === req.params.id);

    if (!pool) {
      return res.status(404).json({ error: `Pool with ID "${req.params.id}" not found` });
    }

    if (pool.type !== 'mergerfs') {
      return res.status(400).json({ error: 'Parity devices can only be added to MergerFS pools' });
    }

    // Get the appropriate service and add parity devices
    const result = await poolsService.addParityDevicesToPool(req.params.id, devices, { format, skip_size_check: skip_size_check === true });

    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/parity/replace:
 *   post:
 *     summary: Replace a parity device in a MergerFS pool
 *     description: |
 *       Replace an existing parity device with a new one in a MergerFS pool (admin only).
 *       The old device will be unmounted and the new device will take over its parity slot.
 *       SnapRAID configuration will be updated automatically.
 *
 *       **Size Requirements (default):**
 *       - New parity device must be >= largest data device
 *       - Use skip_size_check to bypass this validation
 *
 *       **Encryption:**
 *       - For encrypted pools, the new device will be encrypted with the existing key
 *       - Passphrase is required for encrypted pools
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - oldDevice
 *               - newDevice
 *             properties:
 *               oldDevice:
 *                 type: string
 *                 description: Path to the current parity device to replace
 *                 example: "/dev/sdd1"
 *               newDevice:
 *                 type: string
 *                 description: Path to the new parity device
 *                 example: "/dev/sde"
 *               format:
 *                 type: boolean
 *                 description: Whether to format the new device before adding
 *                 default: false
 *                 example: true
 *               passphrase:
 *                 type: string
 *                 description: Encryption passphrase (required for encrypted pools)
 *                 example: "my_secure_password"
 *               skip_size_check:
 *                 type: boolean
 *                 description: Skip the parity device size validation (SnapRAID normally requires parity >= largest data device)
 *                 default: false
 *                 example: false
 *     responses:
 *       200:
 *         description: Parity device replaced successfully
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
 *                   example: "Successfully replaced parity device /dev/sdd1 with /dev/sde in pool 'media'"
 *                 pool:
 *                   type: object
 *                   description: Updated pool object
 *       400:
 *         description: Bad request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Pool or device not found
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
// Replace parity device in pool (admin only)
router.post('/:id/parity/replace', checkRole(['admin']), async (req, res) => {
  try {
    const { oldDevice, newDevice, format = false, skip_size_check = false } = req.body;

    if (!oldDevice || !newDevice) {
      return res.status(400).json({ error: 'Both oldDevice and newDevice are required' });
    }

    const options = {
      format,
      passphrase: req.body.passphrase,
      skip_size_check: skip_size_check === true
    };

    const result = await poolsService.replaceParityDeviceInPool(req.params.id, oldDevice, newDevice, options);
    res.json(result);
  } catch (error) {
    console.error('Error replacing parity device:', error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/parity/remove:
 *   post:
 *     summary: Remove parity devices from a MergerFS pool
 *     description: Remove one or more parity devices from an existing MergerFS pool (admin only). If all parity devices are removed, SnapRAID configuration will be cleaned up.
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - devices
 *             properties:
 *               devices:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: List of parity device paths to remove
 *                 example: ["/dev/sdd"]
 *               unmount:
 *                 type: boolean
 *                 description: Whether to unmount the devices after removing them
 *                 default: true
 *                 example: true
 *     responses:
 *       200:
 *         description: Parity devices removed successfully
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
 *                   example: "Successfully removed 1 parity device(s) from pool 'data_mergerfs'. SnapRAID configuration removed."
 *                 pool:
 *                   $ref: '#/components/schemas/Pool'
 *                 snapraidDisabled:
 *                   type: boolean
 *                   description: Whether SnapRAID was disabled due to no remaining parity devices
 *                   example: true
 *       400:
 *         description: Invalid request parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Pool not found
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

// Remove parity devices from an existing MergerFS pool (admin only)
router.post('/:id/parity/remove', checkRole(['admin']), async (req, res) => {
  try {
    const { devices, unmount = true } = req.body;

    if (!Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({ error: 'At least one parity device is required' });
    }

    // Get the pool first to determine the appropriate service
    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === req.params.id);

    if (!pool) {
      return res.status(404).json({ error: `Pool with ID "${req.params.id}" not found` });
    }

    if (pool.type !== 'mergerfs') {
      return res.status(400).json({ error: 'Parity devices can only be removed from MergerFS pools' });
    }

    // Get the appropriate service and remove parity devices
    const result = await poolsService.removeParityDevicesFromPool(req.params.id, devices, { unmount });

    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/devices/remove:
 *   post:
 *     summary: Remove devices from an existing MergerFS pool
 *     description: Remove one or more devices from an existing MergerFS pool (admin only). Will update SnapRAID config if pool has SnapRAID configured.
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - devices
 *             properties:
 *               devices:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: List of device paths to remove
 *                 example: ["/dev/sdd", "/dev/sde"]
 *               unmount:
 *                 type: boolean
 *                 description: Whether to unmount the devices after removing them
 *                 default: true
 *                 example: true
 *     responses:
 *       200:
 *         description: Devices removed successfully
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
 *                   example: "Successfully removed 2 device(s) from MergerFS pool 'data_mergerfs'"
 *                 pool:
 *                   $ref: '#/components/schemas/Pool'
 *       400:
 *         description: Invalid request parameters or device requirements not met
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
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Pool not found
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

// Remove devices from an existing MergerFS pool (admin only)
router.post('/:id/devices/remove', checkRole(['admin']), async (req, res) => {
  try {
    const { devices, unmount = true } = req.body;

    if (!Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({ error: 'At least one device is required' });
    }

    // Get the pool first to determine the appropriate service
    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === req.params.id);

    if (!pool) {
      return res.status(404).json({ error: `Pool with ID "${req.params.id}" not found` });
    }

    // Get the appropriate service and remove devices
    const result = await poolsService.removeDevicesFromPool(req.params.id, devices, { unmount });

    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/devices/add:
 *   post:
 *     summary: Add devices to an existing pool
 *     description: |
 *       Add one or more devices to an existing pool (admin only).
 *
 *       **BTRFS Pools:**
 *       - Single-device pools (type 'btrfs') will automatically be converted to multi-device with raid1 configuration
 *       - Uses native BTRFS device addition functionality
 *       - Pool must be mounted for the operation
 *
 *       **MergerFS Pools:**
 *       - Devices will be mounted individually and added to the MergerFS union
 *       - Will format devices if needed and update SnapRAID config if pool has SnapRAID configured
 *       - Pool will be remounted automatically after device addition
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - devices
 *             properties:
 *               devices:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: List of device paths to add
 *                 example: ["/dev/sdd", "/dev/sde"]
 *               format:
 *                 type: boolean
 *                 description: Whether to force format the devices before adding
 *                 default: false
 *                 example: false
 *     responses:
 *       200:
 *         description: Devices added successfully
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
 *                   example: "Successfully added 2 device(s) to pool 'data_mergerfs'"
 *                 pool:
 *                   $ref: '#/components/schemas/Pool'
 *       400:
 *         description: Invalid request parameters or device requirements not met
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
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Pool not found
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

// Replace device in pool (admin only)
router.post('/:id/devices/replace', checkRole(['admin']), async (req, res) => {
  try {
    const { oldDevice, newDevice, format = false } = req.body;

    if (!oldDevice || !newDevice) {
      return res.status(400).json({ error: 'Both oldDevice and newDevice are required' });
    }

    const options = {
      format,
      passphrase: req.body.passphrase
    };

    const result = await poolsService.replaceDeviceInPool(req.params.id, oldDevice, newDevice, options);
    res.json(result);
  } catch (error) {
    console.error('Error replacing device:', error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

// Add devices to an existing pool (admin only)
router.post('/:id/devices/add', checkRole(['admin']), async (req, res) => {
  try {
    const { devices, format = false, passphrase } = req.body;

    if (!Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({ error: 'At least one device is required' });
    }

    // Get the pool first to determine the appropriate service
    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === req.params.id);

    if (!pool) {
      return res.status(404).json({ error: `Pool with ID "${req.params.id}" not found` });
    }

    // Get the appropriate service and add devices
    const result = await poolsService.addDevicesToPool(req.params.id, devices, { format, passphrase });

    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/parity:
 *   post:
 *     summary: Execute parity operation on a MergerFS or NonRAID pool
 *     description: |
 *       Execute parity operations on pools with parity devices (admin only).
 *
 *       **MergerFS Pools (SnapRAID):**
 *       - Operations: sync, check, scrub, fix, status, force_stop
 *
 *       **NonRAID Pools:**
 *       - Operations: check, pause, resume, cancel, auto
 *       - For 'check': use 'option' parameter (CORRECT or NOCORRECT)
 *       - 'auto': Automatically starts check (NOCORRECT) if not running, or cancels if running
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - operation
 *             properties:
 *               operation:
 *                 type: string
 *                 description: Operation to execute
 *                 enum: [sync, check, scrub, fix, status, force_stop, pause, resume, cancel, auto]
 *                 example: "check"
 *               option:
 *                 type: string
 *                 description: Check option for NonRAID pools (CORRECT or NOCORRECT)
 *                 enum: [CORRECT, NOCORRECT]
 *                 example: "NOCORRECT"
 *               fixDisks:
 *                 type: array
 *                 description: |
 *                   Mount points of disks to fix (optional for SnapRAID 'fix' operation on MergerFS pools).
 *                   If provided, only the specified disks will be fixed. If omitted, all disks will be fixed.
 *                   These are the mount points from the pool's data_devices (e.g., "/var/mergerfs/media/disk1").
 *                   The API will automatically map these to SnapRAID disk identifiers (d1, d2, etc.).
 *                 items:
 *                   type: string
 *                 example: ["/var/mergerfs/media/disk1", "/var/mergerfs/media/disk3"]
 *     responses:
 *       200:
 *         description: SnapRAID operation executed successfully
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
 *                   example: "Parity check without correction started"
 *                 operation:
 *                   type: string
 *                   example: "check"
 *                 option:
 *                   type: string
 *                   example: "NOCORRECT"
 *                 poolName:
 *                   type: string
 *                   example: "media"
 *                 fixDisks:
 *                   type: string
 *                   description: SnapRAID disk identifiers for fix operation (e.g., "d2,d4")
 *                   example: "d2,d4"
 *                 timestamp:
 *                   type: string
 *                   example: "2025-11-20T12:34:56.789Z"
 *       400:
 *         description: Invalid request parameters or operation requirements not met
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   examples:
 *                     invalid_operation_snapraid:
 *                       value: "Invalid operation. Supported operations: sync, check, scrub, fix, status, force_stop"
 *                     invalid_operation_nonraid:
 *                       value: "Invalid operation. Supported operations: check, pause, resume, cancel, auto"
 *                     operation_running:
 *                       value: "A parity operation is already running. Use 'cancel' to stop it first."
 *                     no_parity:
 *                       value: "Pool does not have any parity devices configured"
 *                     wrong_type:
 *                       value: "Parity operations are not supported for pool type 'btrfs'. Only 'mergerfs' and 'nonraid' pools support parity operations."
 *                     not_mounted:
 *                       value: "NonRAID pool is not mounted. Please mount the pool first."
 *                     no_operation_running:
 *                       value: "No parity operation is currently running"
 *                     mount_points_not_found:
 *                       value: "Mount point(s) not found in SnapRAID config: /var/mergerfs/media/disk99"
 *       404:
 *         description: Pool not found
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

// Execute parity operation on a MergerFS or NonRAID pool (admin only)
router.post('/:id/parity', checkRole(['admin']), async (req, res) => {
  try {
    const { operation, option, fixDisks } = req.body;

    if (!operation) {
      return res.status(400).json({ error: 'Operation is required' });
    }

    // Get the pool first to determine the appropriate service
    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === req.params.id);

    if (!pool) {
      return res.status(404).json({ error: `Pool with ID "${req.params.id}" not found` });
    }

    let result;

    // Route to appropriate handler based on pool type
    if (pool.type === 'mergerfs') {
      // SnapRAID operations for MergerFS pools
      result = await poolsService.executeSnapRAIDOperation(req.params.id, operation, { fixDisks });
    } else if (pool.type === 'nonraid') {
      // NonRAID operations
      result = await poolsService.executeNonRaidParityOperation(req.params.id, operation, { option });
    } else {
      return res.status(400).json({
        error: `Parity operations are not supported for pool type '${pool.type}'. Only 'mergerfs' and 'nonraid' pools support parity operations.`
      });
    }

    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    if (error.message.includes('already running') ||
        error.message.includes('Invalid operation') ||
        error.message.includes('Invalid check option') ||
        error.message.includes('only supported for') ||
        error.message.includes('does not have any') ||
        error.message.includes('No') ||
        error.message.includes('not mounted') ||
        error.message.includes('not available') ||
        error.message.includes('Mount point') ||
        error.message.includes('No valid disk identifiers') ||
        error.message.includes('No data disk entries')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/btrfs/scrub:
 *   post:
 *     summary: Execute BTRFS scrub operation
 *     description: |
 *       Scrub operations for BTRFS pools only.
 *
 *       **Operations:**
 *       - `start`: Start a new scrub (fails if one is already running)
 *       - `status`: Get current scrub status and progress
 *       - `pause`: Pause a running scrub (via cancel in BTRFS)
 *       - `cancel`: Cancel a running scrub
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - operation
 *             properties:
 *               operation:
 *                 type: string
 *                 description: Operation to execute
 *                 enum: [start, status, pause, cancel]
 *                 example: "start"
 *     responses:
 *       200:
 *         description: BTRFS scrub operation executed successfully
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
 *                   example: "BTRFS scrub started"
 *                 operation:
 *                   type: string
 *                   example: "start"
 *                 poolName:
 *                   type: string
 *                   example: "data"
 *                 running:
 *                   type: boolean
 *                   description: Present only for status operation
 *                   example: true
 *                 progress:
 *                   type: object
 *                   description: Present only for status operation when running
 *                   properties:
 *                     status:
 *                       type: string
 *                       example: "running"
 *                     percent:
 *                       type: number
 *                       example: 45.5
 *                     processed:
 *                       type: string
 *                       example: "1.5 TB"
 *                     speed:
 *                       type: string
 *                       example: "150 MB/s"
 *                     errors:
 *                       type: integer
 *                       example: 0
 *                 timestamp:
 *                   type: string
 *                   example: "2025-06-04T12:34:56.789Z"
 *       400:
 *         description: Invalid request parameters or operation requirements not met
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   examples:
 *                     wrong_type:
 *                       value: "Scrub is only supported for BTRFS pools, not 'mergerfs'"
 *                     not_mounted:
 *                       value: "BTRFS pool is not mounted. Please mount the pool first."
 *                     already_running:
 *                       value: "A scrub operation is already running. Use cancel to stop it first."
 *                     not_running:
 *                       value: "No scrub operation is currently running"
 *                     invalid_operation:
 *                       value: "Invalid operation. Supported operations: start, status, pause, cancel"
 *       404:
 *         description: Pool not found
 *       500:
 *         description: Internal server error
 */
router.post('/:id/btrfs/scrub', checkRole(['admin']), async (req, res) => {
  try {
    const { operation } = req.body;

    if (!operation) {
      return res.status(400).json({ error: 'Operation is required' });
    }

    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === req.params.id);

    if (!pool) {
      return res.status(404).json({ error: `Pool with ID "${req.params.id}" not found` });
    }

    const result = await poolsService.executeBtrfsScrubOperation(req.params.id, operation, { user: req.user });
    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    if (error.message.includes('only supported for') ||
        error.message.includes('not mounted') ||
        error.message.includes('already running') ||
        error.message.includes('No') ||
        error.message.includes('Invalid operation')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /pools/{id}/btrfs/balance:
 *   post:
 *     summary: Execute BTRFS balance operation
 *     description: |
 *       Balance operations for BTRFS pools only.
 *
 *       **Operations:**
 *       - `start`: Start a new balance (optionally with RAID conversion)
 *       - `status`: Get current balance status and progress
 *       - `pause`: Pause a running balance
 *       - `cancel`: Cancel a running or paused balance
 *     tags: [Pools]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - operation
 *             properties:
 *               operation:
 *                 type: string
 *                 description: Operation to execute
 *                 enum: [start, status, pause, cancel]
 *                 example: "start"
 *               raidLevel:
 *                 type: string
 *                 description: RAID level for balance conversion (optional)
 *                 enum: [raid0, raid1, raid10]
 *                 example: "raid1"
 *     responses:
 *       200:
 *         description: BTRFS balance operation executed successfully
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
 *                   example: "BTRFS balance started"
 *                 operation:
 *                   type: string
 *                   example: "start"
 *                 poolName:
 *                   type: string
 *                   example: "data"
 *                 running:
 *                   type: boolean
 *                   description: Present only for status operation
 *                   example: true
 *                 progress:
 *                   type: object
 *                   description: Present only for status operation when running
 *                   properties:
 *                     status:
 *                       type: string
 *                       example: "running"
 *                     percent:
 *                       type: number
 *                       example: 45.5
 *                 timestamp:
 *                   type: string
 *                   example: "2025-06-04T12:34:56.789Z"
 *       400:
 *         description: Invalid request parameters or operation requirements not met
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   examples:
 *                     wrong_type:
 *                       value: "Balance is only supported for BTRFS pools, not 'mergerfs'"
 *                     not_mounted:
 *                       value: "BTRFS pool is not mounted. Please mount the pool first."
 *                     already_running:
 *                       value: "A balance operation is already running. Use cancel to stop it first."
 *                     not_running:
 *                       value: "No balance operation is currently running"
 *                     invalid_operation:
 *                       value: "Invalid operation. Supported operations: start, status, pause, cancel"
 *       404:
 *         description: Pool not found
 *       500:
 *         description: Internal server error
 */
router.post('/:id/btrfs/balance', checkRole(['admin']), async (req, res) => {
  try {
    const { operation, raidLevel } = req.body;

    if (!operation) {
      return res.status(400).json({ error: 'Operation is required' });
    }

    const pools = await poolsService.listPools({}, req.user);
    const pool = pools.find(p => p.id === req.params.id);

    if (!pool) {
      return res.status(404).json({ error: `Pool with ID "${req.params.id}" not found` });
    }

    const result = await poolsService.executeBtrfsBalanceOperation(req.params.id, operation, {
      user: req.user,
      raidLevel
    });
    res.json(result);
  } catch (error) {
    console.error(error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    if (error.message.includes('only supported for') ||
        error.message.includes('not mounted') ||
        error.message.includes('already running') ||
        error.message.includes('No') ||
        error.message.includes('Invalid operation')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
