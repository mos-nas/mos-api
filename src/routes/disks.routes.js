const express = require('express');
const router = express.Router();
const disksService = require('../services/disks.service');
const smartService = require('../services/smart.service');
const { checkRole, authenticateToken } = require('../middleware/auth.middleware');

/**
 * @swagger
 * tags:
 *   name: Disks
 *   description: Disk and Storage Management
 *
 * components:
 *   schemas:
 *     Error:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           description: Error message
 *     Partition:
 *       type: object
 *       properties:
 *         number:
 *           type: integer
 *           description: Partition number
 *           example: 1
 *         device:
 *           type: string
 *           description: Partition device path
 *           example: "/dev/sda1"
 *         size:
 *           type: integer
 *           description: Partition size in bytes
 *           example: 536870912000
 *         filesystem:
 *           type: string
 *           nullable: true
 *           description: Filesystem type
 *           example: "ext4"
 *         mountpoint:
 *           type: string
 *           nullable: true
 *           description: Current mount point
 *           example: "/mnt/disk1"
 *         uuid:
 *           type: string
 *           nullable: true
 *           description: Partition UUID
 *           example: "12345678-1234-1234-1234-123456789abc"
 *         label:
 *           type: string
 *           nullable: true
 *           description: Partition label
 *           example: "Data"
 *         status:
 *           type: object
 *           description: Mount status (unified format with pools)
 *           properties:
 *             mounted:
 *               type: boolean
 *               description: Whether partition is currently mounted
 *               example: true
 *             totalSpace:
 *               type: integer
 *               description: Total space in bytes
 *               example: 1000204886016
 *             usedSpace:
 *               type: integer
 *               description: Used space in bytes
 *               example: 500000000000
 *             freeSpace:
 *               type: integer
 *               description: Free space in bytes
 *               example: 500204886016
 *             health:
 *               type: string
 *               description: Health status
 *               example: "healthy"
 *             error:
 *               type: string
 *               nullable: true
 *               description: Error message if status check failed
 *     DiskInfo:
 *       type: object
 *       properties:
 *         device:
 *           type: string
 *           description: Device path
 *           example: "/dev/sda"
 *         name:
 *           type: string
 *           description: Device name
 *           example: "sda"
 *         model:
 *           type: string
 *           description: Disk model
 *           example: "WD Blue 1TB"
 *         serial:
 *           type: string
 *           description: Serial number
 *           example: "WD-WCC4N7XXXXXX"
 *         size:
 *           type: integer
 *           description: Disk size in bytes
 *           example: 1000204886016
 *         sizeHuman:
 *           type: string
 *           description: Human-readable size
 *           example: "1.00 TB"
 *         powerStatus:
 *           type: string
 *           enum: [active, standby, sleeping, unknown]
 *           description: Current power status
 *           example: "active"
 *         type:
 *           type: string
 *           enum: [hdd, ssd, nvme, emmc, usb, unknown]
 *           description: Disk type (enhanced detection)
 *           example: "hdd"

 *         rotational:
 *           type: boolean
 *           nullable: true
 *           description: Whether disk uses rotational storage (true=HDD, false=SSD)
 *           example: true
 *         removable:
 *           type: boolean
 *           nullable: true
 *           description: Whether disk is removable (USB, SD cards, etc.)
 *           example: false
 *         usbInfo:
 *           type: object
 *           nullable: true
 *           description: USB device information (only for USB devices)
 *           properties:
 *             vendorId:
 *               type: string
 *               description: USB vendor ID
 *               example: "0781"
 *             productId:
 *               type: string
 *               description: USB product ID
 *               example: "5567"
 *             manufacturer:
 *               type: string
 *               description: USB manufacturer name
 *               example: "SanDisk"
 *             product:
 *               type: string
 *               description: USB product name
 *               example: "Cruzer Blade"
 *             speed:
 *               type: string
 *               description: USB speed
 *               example: "480"
 *         partitions:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/Partition'
 *         performance:
 *           type: object
 *           nullable: true
 *           description: Performance metrics if requested
 *         standbySkipped:
 *           type: boolean
 *           description: Whether disk was skipped due to standby
 *         preclearRunning:
 *           type: boolean
 *           description: Whether a preClear operation is currently running on this disk
 *           example: false
 *         smartWarning:
 *           type: boolean
 *           description: True if any monitored SMART attribute has a non-zero raw value
 *           example: false
 *         description:
 *           type: string
 *           nullable: true
 *           description: User-defined description for the disk (null if none set)
 *           example: "Media Pool Disk 3"
 *     DiskUsage:
 *       type: object
 *       properties:
 *         device:
 *           type: string
 *           description: Device path
 *           example: "/dev/sda1"
 *         total:
 *           type: integer
 *           description: Total space in bytes
 *           example: 1000204886016
 *         used:
 *           type: integer
 *           description: Used space in bytes
 *           example: 500000000000
 *         available:
 *           type: integer
 *           description: Available space in bytes
 *           example: 500204886016
 *         percentage:
 *           type: number
 *           description: Usage percentage
 *           example: 50.0
 *         totalHuman:
 *           type: string
 *           description: Human-readable total space
 *         usedHuman:
 *           type: string
 *           description: Human-readable used space
 *         availableHuman:
 *           type: string
 *           description: Human-readable available space
 *     PowerStatus:
 *       type: object
 *       properties:
 *         device:
 *           type: string
 *           description: Device name
 *           example: "sda"
 *         powerStatus:
 *           type: string
 *           enum: [active, standby, sleeping, unknown]
 *           description: Current power status
 *           example: "active"
 *         active:
 *           type: boolean
 *           description: Whether disk is active
 *         type:
 *           type: string
 *           enum: [hdd, ssd, nvme, emmc, usb, unknown]
 *           description: Disk type (enhanced detection)
 *         rotational:
 *           type: boolean
 *           nullable: true
 *           description: Whether disk uses rotational storage
 *         removable:
 *           type: boolean
 *           nullable: true
 *           description: Whether disk is removable
 *     IOStats:
 *       type: object
 *       properties:
 *         device:
 *           type: string
 *           description: Device name
 *           example: "sda"
 *         ioStats:
 *           type: object
 *           properties:
 *             reads:
 *               type: integer
 *               description: Total read operations
 *               example: 12345
 *             writes:
 *               type: integer
 *               description: Total write operations
 *               example: 6789
 *             readBytes:
 *               type: integer
 *               description: Total bytes read
 *               example: 1073741824
 *             writeBytes:
 *               type: integer
 *               description: Total bytes written
 *               example: 536870912
 *     SmartInfo:
 *       type: object
 *       properties:
 *         device:
 *           type: string
 *           description: Device path
 *           example: "/dev/sda"
 *         smartStatus:
 *           type: string
 *           description: Overall SMART status
 *           example: "PASSED"
 *         temperature:
 *           type: number
 *           nullable: true
 *           description: Current temperature
 *           example: 35
 *         powerOnHours:
 *           type: integer
 *           nullable: true
 *           description: Power on hours
 *           example: 8760
 *         attributes:
 *           type: array
 *           items:
 *             type: object
 *           description: Detailed SMART attributes
 *     FormatRequest:
 *       type: object
 *       required:
 *         - device
 *         - filesystem
 *       properties:
 *         device:
 *           type: string
 *           description: Device to format (e.g., /dev/sdb)
 *           example: "/dev/sdb"
 *         filesystem:
 *           type: string
 *           enum: [ext4, xfs, btrfs, ntfs, fat32, exfat, vfat, zfs]
 *           description: Target filesystem
 *           example: "ext4"
 *         partition:
 *           type: boolean
 *           description: Create partition table
 *           default: true
 *           example: true
 *         wipeExisting:
 *           type: boolean
 *           description: Wipe existing data (wipefs)
 *           default: true
 *           example: true
 *         preClear:
 *           type: object
 *           nullable: true
 *           description: PreClear options for secure disk wiping before format. Operation runs async.
 *           properties:
 *             wipes:
 *               type: integer
 *               minimum: 1
 *               maximum: 4
 *               description: Number of wipe passes (1-4). If 0 or not set, preClear is skipped.
 *               example: 2
 *             algorithm:
 *               type: string
 *               enum: [zero, ff, random, one-zero]
 *               description: |
 *                 Wipe algorithm:
 *                 - zero: Write all zeros (0x00)
 *                 - ff: Write all ones (0xFF)
 *                 - random: Write random data
 *                 - one-zero: Alternate ff/zero passes (requires even wipes count)
 *               default: "zero"
 *               example: "zero"
 *             readCheck:
 *               type: boolean
 *               description: Verify all sectors are zero after wipe. Only valid for zero or one-zero algorithms.
 *               default: false
 *               example: false
 *             log:
 *               type: boolean
 *               description: Log bad sectors to /var/log/preclear/{device} (max 5MB). Only used with readCheck.
 *               default: false
 *               example: false
 *     PreClearAbortResult:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           example: true
 *         message:
 *           type: string
 *           example: "PreClear operation on /dev/sdb aborted"
 *         device:
 *           type: string
 *           example: "/dev/sdb"
 *     FilesystemInfo:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Filesystem name
 *           example: "ext4"
 *         command:
 *           type: string
 *           description: Command used to create filesystem
 *           example: "mkfs.ext4"
 *         description:
 *           type: string
 *           description: Filesystem description
 *           example: "Fourth Extended Filesystem (recommended for Linux)"
 *         available:
 *           type: boolean
 *           description: Whether the filesystem tools are available
 *           example: true
 *         version:
 *           type: string
 *           nullable: true
 *           description: Version information of the filesystem tools
 *           example: "mke2fs 1.46.2"
 *         error:
 *           type: string
 *           nullable: true
 *           description: Error message if filesystem is not available
 *           example: "mkfs.btrfs not found"
 *         note:
 *           type: string
 *           nullable: true
 *           description: Special notes for the filesystem
 *           example: "ZFS requires a specific kernel module and mount options."
 *     AvailableFilesystems:
 *       type: object
 *       properties:
 *         filesystems:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/FilesystemInfo'
 *           description: All supported filesystems with availability status
 *         available:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/FilesystemInfo'
 *           description: Only available filesystems
 *         unavailable:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/FilesystemInfo'
 *           description: Unavailable filesystems
 *         totalSupported:
 *           type: integer
 *           description: Total number of supported filesystems
 *           example: 3
 *         totalAvailable:
 *           type: integer
 *           description: Number of available filesystems
 *           example: 2
 *     SleepRequest:
 *       type: object
 *       properties:
 *         mode:
 *           type: string
 *           enum: [standby, sleep]
 *           description: Sleep mode
 *           default: "standby"
 *           example: "standby"
 *     MultipleDisksRequest:
 *       type: object
 *       required:
 *         - devices
 *       properties:
 *         devices:
 *           type: array
 *           items:
 *             type: string
 *           description: Array of device names
 *           example: ["sda", "sdb", "sdc"]
 *         mode:
 *           type: string
 *           enum: [standby, sleep]
 *           description: Sleep mode (for sleep operations)
 *           default: "standby"
 *           example: "standby"
 *     OperationResult:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           description: Operation successful
 *           example: true
 *         message:
 *           type: string
 *           description: Result message
 *           example: "Operation completed successfully"
 *         device:
 *           type: string
 *           nullable: true
 *           description: Affected device
 *           example: "sda"
 */

/**
 * @swagger
 * /disks:
 *   get:
 *     summary: List all disks with partitions
 *     description: Retrieve a comprehensive list of all disks with their partitions and power status. Uses live data without caching.
 *     tags: [Disks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: performance
 *         schema:
 *           type: string
 *           enum: [true, false]
 *           default: "false"
 *         description: Include performance metrics (may wake sleeping disks)
 *         example: "false"
 *       - in: query
 *         name: skipStandby
 *         schema:
 *           type: string
 *           enum: [true, false]
 *           default: "true"
 *         description: Skip disks in standby mode to avoid waking them
 *         example: "true"
 *     responses:
 *       200:
 *         description: List of all disks retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/DiskInfo'
 *       401:
 *         description: Not authenticated
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

// List all disks with partitions
router.get('/', authenticateToken, async (req, res) => {
  try {
    const {
      performance = 'false',
      skipStandby = 'true'
    } = req.query;

    const options = {
      includePerformance: performance === 'true',
      skipStandby: skipStandby === 'true'
    };

    const disks = await disksService.getAllDisks(options, req.user);
    await disksService.ensureDescriptionsLoaded();
    for (const disk of disks) {
      disk.smartWarning = disk.serial ? smartService.hasDiskWarning(disk.serial) : false;
      disk.temperatureStatus = disk.serial ? smartService.getDiskTemperatureStatus(disk.serial) : null;
      disk.description = disk.serial ? disksService.getDescription(disk.serial) : null;
    }
    res.json(disks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/{device}/usage:
 *   get:
 *     summary: Get disk usage statistics
 *     description: Retrieve usage statistics for a specific disk or partition using df command
 *     tags: [Disks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: device
 *         required: true
 *         schema:
 *           type: string
 *         description: Device name (e.g., sda, sda1)
 *         example: "sda1"
 *     responses:
 *       200:
 *         description: Disk usage retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DiskUsage'
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error getting disk usage
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Disk-specific operations
router.get('/:device/usage', authenticateToken, async (req, res) => {
  try {
    const usage = await disksService.getDiskUsage(req.params.device, req.user);
    res.json(usage);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/{device}/power:
 *   get:
 *     summary: Get disk power status
 *     description: Retrieve the current power status of a specific disk
 *     tags: [Disks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: device
 *         required: true
 *         schema:
 *           type: string
 *         description: Device name (e.g., sda)
 *         example: "sda"
 *     responses:
 *       200:
 *         description: Power status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PowerStatus'
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error getting power status
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Get power status of a specific disk
router.get('/:device/power', async (req, res) => {
  try {
    const device = req.params.device.startsWith('/dev/') ? req.params.device : `/dev/${req.params.device}`;
    const powerStatus = await disksService._getDiskPowerStatus(device);
    res.json({
      device: req.params.device,
      powerStatus: powerStatus.status,
      active: powerStatus.active,
      type: powerStatus.type,
      rotational: powerStatus.rotational,
      removable: powerStatus.removable,
      usbInfo: powerStatus.usbInfo
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/{device}/iostats:
 *   get:
 *     summary: Get disk I/O statistics
 *     description: Retrieve I/O statistics for a specific disk
 *     tags: [Disks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: device
 *         required: true
 *         schema:
 *           type: string
 *         description: Device name (e.g., sda)
 *         example: "sda"
 *     responses:
 *       200:
 *         description: I/O statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/IOStats'
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error getting I/O statistics
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Get I/O statistics of a specific disk
router.get('/:device/iostats', async (req, res) => {
  try {
    const device = req.params.device.startsWith('/dev/') ? req.params.device : `/dev/${req.params.device}`;
    const ioStats = await disksService._getDiskIOStats(device);
    res.json({
      device: req.params.device,
      ioStats
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/{device}/wake:
 *   post:
 *     summary: Wake disk from standby
 *     description: Wake a disk from standby or sleep mode (admin only)
 *     tags: [Disks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: device
 *         required: true
 *         schema:
 *           type: string
 *         description: Device name (e.g., sda)
 *         example: "sda"
 *     responses:
 *       200:
 *         description: Disk woken successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OperationResult'
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
 *         description: Error waking disk
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Wake disk from standby (admin only)
router.post('/:device/wake', checkRole(['admin']), async (req, res) => {
  try {
    const result = await disksService.wakeDisk(req.params.device);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/{device}/sleep:
 *   post:
 *     summary: Put disk to sleep/standby
 *     description: Put a disk into standby or sleep mode (admin only)
 *     tags: [Disks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: device
 *         required: true
 *         schema:
 *           type: string
 *         description: Device name (e.g., sda)
 *         example: "sda"
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SleepRequest'
 *     responses:
 *       200:
 *         description: Disk put to sleep successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OperationResult'
 *       400:
 *         description: Invalid mode parameter
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
 *         description: Error putting disk to sleep
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Put disk to sleep/standby (admin only)
router.post('/:device/sleep', checkRole(['admin']), async (req, res) => {
  try {
    const { mode = 'standby' } = req.body;

    // Validate mode parameter
    if (mode !== 'standby' && mode !== 'sleep') {
      return res.status(400).json({
        error: 'Mode must be either "standby" or "sleep"'
      });
    }

    const result = await disksService.sleepDisk(req.params.device, mode);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/{device}/smart:
 *   get:
 *     summary: Get SMART information
 *     description: |
 *       Retrieve comprehensive SMART data for a specific disk. Data is sourced from
 *       smartd state files (no disk I/O) or smartctl (live). If the disk is sleeping,
 *       all SMART fields are null unless wakeUp=true is specified.
 *       Response structure is always consistent - fields are null when unavailable.
 *     tags: [Disks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: device
 *         required: true
 *         schema:
 *           type: string
 *         description: Device name (e.g., sda)
 *         example: "sda"
 *       - in: query
 *         name: wakeUp
 *         schema:
 *           type: string
 *           enum: [true, false]
 *           default: "false"
 *         description: Wake the disk from standby before reading SMART data
 *     responses:
 *       200:
 *         description: SMART information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 device:
 *                   type: string
 *                   example: "/dev/sda"
 *                 deviceName:
 *                   type: string
 *                   example: "sda"
 *                 serial:
 *                   type: string
 *                   nullable: true
 *                   example: "5PJJ26DF"
 *                 model:
 *                   type: string
 *                   nullable: true
 *                   example: "WDC WD120EDAZ-11F3RA0"
 *                 diskType:
 *                   type: string
 *                   enum: [hdd, ssd, nvme, unknown]
 *                 sleeping:
 *                   type: boolean
 *                 warning:
 *                   type: boolean
 *                   description: True if any monitored attribute has a non-zero raw value
 *                 smartStatus:
 *                   type: string
 *                   nullable: true
 *                   enum: [PASSED, FAILED]
 *                 temperature:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     current:
 *                       type: integer
 *                       nullable: true
 *                     min:
 *                       type: integer
 *                       nullable: true
 *                     max:
 *                       type: integer
 *                       nullable: true
 *                 powerOnHours:
 *                   type: integer
 *                   nullable: true
 *                 powerCycleCount:
 *                   type: integer
 *                   nullable: true
 *                 errorCount:
 *                   type: integer
 *                   nullable: true
 *                 attributes:
 *                   type: array
 *                   nullable: true
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       name:
 *                         type: string
 *                       value:
 *                         type: integer
 *                         nullable: true
 *                       worst:
 *                         type: integer
 *                         nullable: true
 *                       threshold:
 *                         type: integer
 *                         nullable: true
 *                       rawValue:
 *                         type: integer
 *                         nullable: true
 *                       status:
 *                         type: string
 *                         enum: [ok, ok_past_failure, failing, warning]
 *                 source:
 *                   type: string
 *                   nullable: true
 *                   enum: [smartctl_live, smartd_state]
 *                   description: Where the SMART data was sourced from
 *                 monitoringConfig:
 *                   type: object
 *                   properties:
 *                     temperatureWarning:
 *                       type: integer
 *                     temperatureCritical:
 *                       type: integer
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error getting SMART information
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Get SMART information (enhanced, uses smart.service)
router.get('/:device/smart', async (req, res) => {
  try {
    const { wakeUp = 'false' } = req.query;
    const device = req.params.device;
    const devicePath = device.startsWith('/dev/') ? device : `/dev/${device}`;

    let sleeping = false;

    if (wakeUp === 'true') {
      await disksService.wakeDisk(device);
    } else {
      try {
        const powerStatus = await disksService._getDiskPowerStatus(devicePath);
        sleeping = powerStatus.active === false;
      } catch {
        sleeping = false;
      }
    }

    const smartInfo = await smartService.getSmartInfo(device, {
      wakeUp: wakeUp === 'true',
      sleeping
    });
    res.json(smartInfo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/descriptions/orphaned:
 *   get:
 *     summary: List orphaned disk descriptions
 *     description: Get all disk descriptions whose disk is no longer physically present
 *     tags: [Disks]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Orphaned descriptions retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   serial:
 *                     type: string
 *                     example: "5PJJ26DF"
 *                   description:
 *                     type: string
 *                     example: "Media Pool Disk 3"
 *                   model:
 *                     type: string
 *                     nullable: true
 *                     example: "WDC WD120EDAZ-11F3RA0"
 *       500:
 *         description: Server error
 */
router.get('/descriptions/orphaned', authenticateToken, async (req, res) => {
  try {
    res.json(await disksService.getOrphanedDescriptions());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/descriptions/orphaned:
 *   delete:
 *     summary: Delete all orphaned disk descriptions
 *     description: Remove all descriptions whose disk is no longer physically present (admin only)
 *     tags: [Disks]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All orphaned descriptions deleted
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
 *                   example: "2 orphaned descriptions removed"
 *                 count:
 *                   type: integer
 *                   example: 2
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */
router.delete('/descriptions/orphaned', checkRole(['admin']), async (req, res) => {
  try {
    res.json(await disksService.deleteAllOrphanDescriptions());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/descriptions/orphaned/{serial}:
 *   delete:
 *     summary: Delete a specific orphaned disk description
 *     description: Remove a single description by serial number, only if the disk is not currently present (admin only)
 *     tags: [Disks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: serial
 *         required: true
 *         schema:
 *           type: string
 *         description: Serial number of the orphaned disk
 *     responses:
 *       200:
 *         description: Orphaned description deleted
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Description not found
 *       500:
 *         description: Server error
 */
router.delete('/descriptions/orphaned/:serial', checkRole(['admin']), async (req, res) => {
  try {
    const result = await disksService.deleteOrphanDescription(req.params.serial);
    res.json(result);
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/{device}/description:
 *   put:
 *     summary: Set or clear a disk description
 *     description: |
 *       Set a user-defined description for a disk. The description is stored persistently
 *       keyed by the disk's serial number (survives device name changes). An empty or null
 *       description removes the entry. The config file is only written on change (admin only).
 *     tags: [Disks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: device
 *         required: true
 *         schema:
 *           type: string
 *         description: Device name (e.g., sda)
 *         example: "sda"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               description:
 *                 type: string
 *                 nullable: true
 *                 description: Description text (empty or null clears the entry)
 *                 example: "Media Pool Disk 3"
 *     responses:
 *       200:
 *         description: Description set or cleared
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 serial:
 *                   type: string
 *                   example: "5PJJ26DF"
 *                 description:
 *                   type: string
 *                   nullable: true
 *                   example: "Media Pool Disk 3"
 *       400:
 *         description: Could not resolve serial for device
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */
router.put('/:device/description', checkRole(['admin']), async (req, res) => {
  try {
    const result = await disksService.setDescription(req.params.device, req.body.description);
    res.json(result);
  } catch (error) {
    if (error.message.includes('Could not resolve serial')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

 /**
  * @swagger
  * /disks/availablefilesystems:
  *   get:
  *     summary: Get available filesystems
  *     description: |
  *       Retrieve a simple array of available filesystem names for formatting.
  *       Use the pooltype parameter to filter filesystems based on pool type:
  *       - **multi**: Returns only btrfs and zfs (if available) - these support multiple disks
  *       - **nonraid**, **single**, **mergerfs** or no parameter: Returns all available filesystems
  *     tags: [Disks]
  *     security:
  *       - bearerAuth: []
  *     parameters:
  *       - in: query
  *         name: pooltype
  *         schema:
  *           type: string
  *           enum: [multi, nonraid, single, mergerfs]
  *         description: |
  *           Filter filesystems by pool type.
  *           'multi' returns only btrfs/zfs (multi-disk capable).
  *           Other values or omitting returns all filesystems.
  *     responses:
  *       200:
  *         description: Available filesystems retrieved successfully
  *         content:
  *           application/json:
  *             schema:
  *               type: array
  *               items:
  *                 type: string
  *             examples:
  *               all:
  *                 summary: All filesystems (no filter or nonraid/single/mergerfs)
  *                 value: ["ext4", "xfs", "btrfs", "zfs"]
  *               multi:
  *                 summary: Multi-disk filesystems only (pooltype=multi)
  *                 value: ["btrfs", "zfs"]
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

// Get available filesystems
router.get('/availablefilesystems', async (req, res) => {
  try {
    const { pooltype } = req.query;
    const availableFilesystems = await disksService.getAvailableFilesystems(pooltype);
    res.json(availableFilesystems);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/format:
 *   post:
 *     summary: Format disk/device
 *     description: Format a disk or device with specified filesystem (admin only)
 *     tags: [Disks]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/FormatRequest'
 *     responses:
 *       200:
 *         description: Device formatted successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OperationResult'
 *       400:
 *         description: Invalid request parameters
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
 *         description: Error formatting device
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Format disk (admin only)
router.post('/format', checkRole(['admin']), async (req, res) => {
  try {
    const {
      device,
      filesystem,
      partition = true,
      wipeExisting = true,
      preClear = null
    } = req.body;

    if (!device || typeof device !== 'string') {
      throw new Error('Device must be specified as a string');
    }
    if (!filesystem) {
      throw new Error('Filesystem must be specified');
    }

    const result = await disksService.formatDevice(device, filesystem, {
      partition,
      wipeExisting,
      preClear
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/{device}/preclear/abort:
 *   post:
 *     summary: Abort preClear operation
 *     description: Abort a running preClear operation on a device (admin only). The disk will be left in an undefined state.
 *     tags: [Disks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: device
 *         required: true
 *         schema:
 *           type: string
 *         description: Device name (e.g., sda, nvme0n1)
 *         example: "sdb"
 *     responses:
 *       200:
 *         description: PreClear operation aborted successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PreClearAbortResult'
 *       400:
 *         description: No preClear operation running on device
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
 *         description: Error aborting preClear operation
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Abort preClear operation (admin only)
router.post('/:device/preclear/abort', checkRole(['admin']), async (req, res) => {
  try {
    const result = await disksService.abortPreClear(req.params.device);
    res.json(result);
  } catch (error) {
    if (error.message.includes('No preClear operation running')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /disks/{device}/partition:
 *   post:
 *     summary: Create partition
 *     description: Create a new partition on the specified device (admin only)
 *     tags: [Disks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: device
 *         required: true
 *         schema:
 *           type: string
 *         description: Device name (e.g., sda)
 *         example: "sda"
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PartitionRequest'
 *     responses:
 *       200:
 *         description: Partition created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OperationResult'
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
 *         description: Error creating partition
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Create partition (admin only)
router.post('/:device/partition', checkRole(['admin']), async (req, res) => {
  try {
    const { start = '1MiB', end = '100%', type } = req.body;
    const result = await disksService.createPartition(req.params.device, start, end, type);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/{device}/partition/{partitionNumber}:
 *   delete:
 *     summary: Delete partition
 *     description: Delete a specific partition from a device (admin only)
 *     tags: [Disks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: device
 *         required: true
 *         schema:
 *           type: string
 *         description: Device name (e.g., sda)
 *         example: "sda"
 *       - in: path
 *         name: partitionNumber
 *         required: true
 *         schema:
 *           type: integer
 *         description: Partition number to delete
 *         example: 1
 *     responses:
 *       200:
 *         description: Partition deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OperationResult'
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
 *         description: Error deleting partition
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Delete partition (admin only)
router.delete('/:device/partition/:partitionNumber', checkRole(['admin']), async (req, res) => {
  try {
    const { device, partitionNumber } = req.params;
    const result = await disksService.deletePartition(device, parseInt(partitionNumber));
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/{device}/wipe:
 *   delete:
 *     summary: Wipe entire disk
 *     description: Completely wipe a disk, removing all partitions and data (admin only)
 *     tags: [Disks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: device
 *         required: true
 *         schema:
 *           type: string
 *         description: Device name (e.g., sda)
 *         example: "sda"
 *     responses:
 *       200:
 *         description: Disk wiped successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OperationResult'
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
 *         description: Error wiping disk
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Wipe entire disk (admin only)
router.delete('/:device/wipe', checkRole(['admin']), async (req, res) => {
  try {
    const result = await disksService.wipeDisk(req.params.device);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/{device}/partitions:
 *   get:
 *     summary: Get disk partitions
 *     description: Retrieve all partitions for a specific disk
 *     tags: [Disks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: device
 *         required: true
 *         schema:
 *           type: string
 *         description: Device name (e.g., sda)
 *         example: "sda"
 *     responses:
 *       200:
 *         description: Partitions retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 device:
 *                   type: string
 *                   example: "sda"
 *                 partitions:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Partition'
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error getting partitions
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Get partitions of a specific disk
router.get('/:device/partitions', async (req, res) => {
  try {
    const device = req.params.device.startsWith('/dev/') ? req.params.device : `/dev/${req.params.device}`;
    const partitions = await disksService._getPartitions(device);
    res.json({
      device: req.params.device,
      partitions
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/wake:
 *   post:
 *     summary: Wake multiple disks
 *     description: Wake multiple disks from standby simultaneously (admin only)
 *     tags: [Disks]
 *     security:
 *       - bearerAuth: []
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
 *                 description: Array of device names
 *                 example: ["sda", "sdb", "sdc"]
 *     responses:
 *       200:
 *         description: Wake operations completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 results:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/OperationResult'
 *       400:
 *         description: Invalid devices array
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
 *         description: Error waking disks
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// ========== MULTIPLE DISK OPERATIONS ==========

// Wake multiple disks (admin only)
router.post('/wake', checkRole(['admin']), async (req, res) => {
  try {
    const { devices } = req.body;

    if (!devices || !Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({
        error: 'devices array is required and must not be empty'
      });
    }

    const result = await disksService.wakeMultipleDisks(devices);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/sleep:
 *   post:
 *     summary: Sleep multiple disks
 *     description: Put multiple disks to sleep/standby simultaneously (admin only)
 *     tags: [Disks]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/MultipleDisksRequest'
 *     responses:
 *       200:
 *         description: Sleep operations completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 results:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/OperationResult'
 *       400:
 *         description: Invalid request parameters
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
 *         description: Error putting disks to sleep
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Sleep multiple disks (admin only)
router.post('/sleep', checkRole(['admin']), async (req, res) => {
  try {
    const { devices, mode = 'standby' } = req.body;

    if (!devices || !Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({
        error: 'devices array is required and must not be empty'
      });
    }

    // Validate mode parameter
    if (mode !== 'standby' && mode !== 'sleep') {
      return res.status(400).json({
        error: 'mode must be either "standby" or "sleep"'
      });
    }

    const result = await disksService.sleepMultipleDisks(devices, mode);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/power/status:
 *   post:
 *     summary: Get power status for multiple disks
 *     description: Get power status for multiple disks simultaneously (admin only)
 *     tags: [Disks]
 *     security:
 *       - bearerAuth: []
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
 *                 description: Array of device names
 *                 example: ["sda", "sdb", "sdc"]
 *     responses:
 *       200:
 *         description: Power status retrieved for all devices
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 results:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/PowerStatus'
 *       400:
 *         description: Invalid devices array
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
 *         description: Error getting power status
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Get Power-Status for multiple disks (admin only)
router.post('/power/status', checkRole(['admin']), async (req, res) => {
  try {
    const { devices } = req.body;

    if (!devices || !Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({
        error: 'devices array is required and must not be empty'
      });
    }

    const result = await disksService.getMultipleDisksPowerStatus(devices);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/power/manage:
 *   post:
 *     summary: Manage disk power settings
 *     description: Configure power management settings for a disk (admin only)
 *     tags: [Disks]
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
 *                 description: Device name
 *                 example: "sda"
 *               check:
 *                 type: boolean
 *                 description: Only check current settings
 *                 default: true
 *                 example: true
 *     responses:
 *       200:
 *         description: Power settings managed successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OperationResult'
 *       400:
 *         description: Invalid request parameters
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
 *         description: Error managing power settings
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Power Management Settings Manage (admin only)
router.post('/power/manage', checkRole(['admin']), async (req, res) => {
  try {
    const { device, check = true } = req.body;

    if (!device || typeof device !== 'string') {
      return res.status(400).json({
        error: 'device must be specified as a string'
      });
    }

    const options = { check };
    const result = await disksService.manageDiskPowerSettings(device, options);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/unassigned:
 *   get:
 *     summary: List unassigned disks
 *     description: Retrieve a list of disks that are not assigned to any pool or array and are not system disks
 *     tags: [Disks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: includePerformance
 *         schema:
 *           type: string
 *           enum: [true, false]
 *           default: "false"
 *         description: Include performance metrics
 *         example: "false"
 *       - in: query
 *         name: skipStandby
 *         schema:
 *           type: string
 *           enum: [true, false]
 *           default: "true"
 *         description: Skip disks in standby mode
 *         example: "true"
 *     responses:
 *       200:
 *         description: Unassigned disks retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 unassignedDisks:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/DiskInfo'
 *                 totalUnassigned:
 *                   type: integer
 *                   description: Total number of unassigned disks
 *                   example: 3
 *                 totalDisks:
 *                   type: integer
 *                   description: Total number of disks
 *                   example: 8
 *                 metadata:
 *                   type: object
 *                   properties:
 *                     skipStandby:
 *                       type: boolean
 *                       example: true
 *                     includePerformance:
 *                       type: boolean
 *                       example: false
 *                     timestamp:
 *                       type: integer
 *                       description: Timestamp of scan
 *                       example: 1705749600000
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Error getting unassigned disks
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// ========== UNASSIGNED DISK OPERATIONS ==========

// List unassigned disks
router.get('/unassigned', authenticateToken, async (req, res) => {
  try {
    const {
      includePerformance = 'false',
      skipStandby = 'true'
    } = req.query;

    const options = {
      includePerformance: includePerformance === 'true',
      skipStandby: skipStandby === 'true'
    };

    const result = await disksService.getUnassignedDisks(options, req.user);

    // Return only the unassigned disks, not the complete analysis
    res.json({
      unassignedDisks: result.unassignedDisks,
      totalUnassigned: result.unassignedCount,
      totalDisks: result.totalDisks,
      metadata: {
        skipStandby: options.skipStandby,
        includePerformance: options.includePerformance,
        timestamp: Date.now()
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/{device}/mount:
 *   post:
 *     summary: Mount a disk device
 *     description: Mount a single disk device or partition to /mnt/disks/ with automatic mountability checks (admin only)
 *     tags: [Disks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: device
 *         required: true
 *         schema:
 *           type: string
 *         description: Device name (e.g., sda1, sdb)
 *         example: "sdb1"
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               mountOptions:
 *                 type: string
 *                 description: Custom mount options
 *                 default: "defaults"
 *                 example: "defaults,noatime"
 *     responses:
 *       200:
 *         description: Device mounted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 device:
 *                   type: string
 *                   example: "sdb1"
 *                 mountPoint:
 *                   type: string
 *                   example: "/mnt/disks/MyData"
 *                 filesystem:
 *                   type: string
 *                   example: "ext4"
 *                 uuid:
 *                   type: string
 *                   nullable: true
 *                   example: "12345678-1234-1234-1234-123456789abc"
 *                 label:
 *                   type: string
 *                   nullable: true
 *                   example: "MyData"
 *                 alreadyMounted:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Device sdb1 successfully mounted at /mnt/disks/MyData"
 *       400:
 *         description: Invalid request or device not mountable
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
 *         description: Error mounting device
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Mount single device (admin only)
router.post('/:device/mount', checkRole(['admin']), async (req, res) => {
  try {
    const { mountOptions } = req.body;
    const options = { mountOptions };

    const result = await disksService.mountDevice(req.params.device, options);
    res.json(result);
  } catch (error) {
    // Return 400 for known validation errors (pool, no filesystem, system disk, already mounted, etc.)
    const msg = error.message || '';
    if (msg.includes('used in pool') || msg.includes('no filesystem') || msg.includes('no mountable partitions') ||
        msg.includes('Cannot mount system') || msg.includes('does not exist') || msg.includes('is in use') ||
        msg.includes('already mounted')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/{device}/unmount:
 *   post:
 *     summary: Unmount a disk device
 *     description: Unmount a single disk device or partition, handles BTRFS multi-device properly (admin only)
 *     tags: [Disks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: device
 *         required: true
 *         schema:
 *           type: string
 *         description: Device name (e.g., sda1, sdb)
 *         example: "sdb1"
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               force:
 *                 type: boolean
 *                 description: Force unmount even if busy
 *                 default: false
 *                 example: false
 *               lazy:
 *                 type: boolean
 *                 description: Lazy unmount - detach immediately
 *                 default: false
 *                 example: false
 *     responses:
 *       200:
 *         description: Device unmounted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 device:
 *                   type: string
 *                   example: "sdb1"
 *                 mountPoint:
 *                   type: string
 *                   example: "/mnt/disks/MyData"
 *                 alreadyUnmounted:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Device sdb1 successfully unmounted from /mnt/disks/MyData"
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
 *         description: Error unmounting device
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Unmount single device (admin only)
router.post('/:device/unmount', checkRole(['admin']), async (req, res) => {
  try {
    const { force = false, lazy = false } = req.body;
    const options = { force, lazy };

    const result = await disksService.unmountDevice(req.params.device, options);
    res.json(result);
  } catch (error) {
    // Return 400 for known validation errors (pool, not mounted, system mount)
    const msg = error.message || '';
    if (msg.includes('used in pool') || msg.includes('is not mounted') ||
        msg.includes('not a manual disk mount') || msg.includes('pool or system mounts') ||
        msg.includes('no unmountable partitions')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /disks/zram/ramdisks:
 *   get:
 *     summary: Get ZRAM ramdisk devices
 *     description: Returns all active ZRAM ramdisk devices (type=ramdisk, enabled=true) that can be used as storage pools
 *     tags: [Disks]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of ZRAM ramdisk devices
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   device:
 *                     type: string
 *                     example: "/dev/zram0"
 *                   name:
 *                     type: string
 *                     example: "Temp Ramdisk"
 *                   id:
 *                     type: string
 *                   size:
 *                     type: integer
 *                   sizeHuman:
 *                     type: string
 *                   type:
 *                     type: string
 *                     example: "ramdisk"
 *                   algorithm:
 *                     type: string
 *                   filesystem:
 *                     type: string
 *                   uuid:
 *                     type: string
 *                   isZram:
 *                     type: boolean
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */

// GET: ZRAM ramdisk devices
router.get('/zram/ramdisks', async (req, res) => {
  try {
    const ramdisks = await disksService.getZramRamdisks(req.user);
    res.json(ramdisks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
