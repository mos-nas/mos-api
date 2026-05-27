const express = require('express');
const router = express.Router();
const { checkRole } = require('../middleware/auth.middleware');
const sharesService = require('../services/shares.service');

/**
 * @swagger
 * tags:
 *   name: Shares
 *   description: Network Shares Management (SMB/CIFS)
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
 *     SmbShare:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Unique identifier for the share
 *           example: "1640995200000abc123"
 *         name:
 *           type: string
 *           description: Name of the SMB share
 *           example: "media"
 *         path:
 *           type: string
 *           description: Full path to the share directory
 *           example: "/mnt/storage-pool/movies"
 *         enabled:
 *           type: boolean
 *           description: Whether share is enabled
 *           example: true
 *         automount:
 *           type: boolean
 *           description: Auto-mount on startup
 *           example: false
 *         read_only:
 *           type: boolean
 *           description: Read-only access
 *           example: false
 *         guest_ok:
 *           type: boolean
 *           description: Allow guest access
 *           example: false
 *         browseable:
 *           type: boolean
 *           description: Show in network browse list
 *           example: true
 *         allow_execute_always:
 *           type: boolean
 *           description: Allow execute permission on all files (acl_allow_execute_always)
 *           example: false
 *         write_list:
 *           type: array
 *           items:
 *             type: string
 *           description: List of users with write access
 *           example: ["user1", "user2"]
 *         valid_users:
 *           type: array
 *           items:
 *             type: string
 *           description: List of valid users
 *           example: ["user1", "user2", "user3"]
 *         comment:
 *           type: string
 *           nullable: true
 *           description: Share description
 *           example: "Media files storage"
 *     CreateSmbShareRequest:
 *       type: object
 *       required:
 *         - shareName
 *       properties:
 *         shareName:
 *           type: string
 *           description: Name of the SMB share (alphanumeric, underscore, hyphen only)
 *           pattern: '^[a-zA-Z0-9_-]+$'
 *           example: "media"
 *         poolName:
 *           type: string
 *           nullable: true
 *           description: Pool name to use for the share. If null or empty, subPath must be an absolute path to an existing directory.
 *           example: "storage-pool"
 *         subPath:
 *           type: string
 *           description: |
 *             If poolName is provided: Subdirectory path within the pool (relative path).
 *             If poolName is null/empty: Absolute path to an existing directory (e.g., "/data/myshare"). The directory must exist and permissions will NOT be modified.
 *           default: ""
 *           example: "movies"
 *         automount:
 *           type: boolean
 *           description: Auto-mount on startup
 *           default: false
 *           example: false
 *         enabled:
 *           type: boolean
 *           description: Enable the share
 *           default: true
 *           example: true
 *         read_only:
 *           type: boolean
 *           description: Read-only access
 *           default: false
 *           example: false
 *         guest_ok:
 *           type: boolean
 *           description: Allow guest access
 *           default: false
 *           example: false
 *         browseable:
 *           type: boolean
 *           description: Show in network browse list
 *           default: true
 *           example: true
 *         write_list:
 *           type: array
 *           items:
 *             type: string
 *           description: List of users with write access
 *           default: []
 *           example: ["user1", "user2"]
 *         valid_users:
 *           type: array
 *           items:
 *             type: string
 *           description: List of valid users
 *           default: []
 *           example: ["user1", "user2"]
 *         force_root:
 *           type: boolean
 *           description: Force root ownership
 *           default: false
 *           example: false
 *         create_mask:
 *           type: string
 *           description: File creation mask
 *           default: "0664"
 *           example: "0664"
 *         directory_mask:
 *           type: string
 *           description: Directory creation mask
 *           default: "0775"
 *           example: "0775"
 *         inherit_permissions:
 *           type: boolean
 *           description: Inherit permissions from parent
 *           default: true
 *           example: true
 *         hide_dot_files:
 *           type: boolean
 *           description: Hide files starting with dot
 *           default: false
 *           example: false
 *         preserve_case:
 *           type: boolean
 *           description: Preserve filename case
 *           default: true
 *           example: true
 *         case_sensitive:
 *           type: boolean
 *           description: Case sensitive filenames
 *           default: true
 *           example: true
 *         allow_execute_always:
 *           type: boolean
 *           description: Allow execute permission on all files (acl_allow_execute_always)
 *           default: false
 *           example: false
 *         comment:
 *           type: string
 *           nullable: true
 *           description: Share description
 *           example: "Media files storage"
 *     NfsShare:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Unique identifier for the share
 *           example: "1640995200000abc123"
 *         name:
 *           type: string
 *           description: Name of the NFS share
 *           example: "media"
 *         path:
 *           type: string
 *           description: Full path to the share directory
 *           example: "/mnt/storage-pool/movies"
 *         source:
 *           type: string
 *           description: Network address/range or host allowed to access (* for all hosts)
 *           example: "10.0.0.0/24"
 *         enabled:
 *           type: boolean
 *           description: Whether share is enabled
 *           example: true
 *         read_only:
 *           type: boolean
 *           description: Read-only access
 *           example: false
 *         anonuid:
 *           type: integer
 *           nullable: true
 *           description: Anonymous UID mapping
 *           example: 65534
 *         anongid:
 *           type: integer
 *           nullable: true
 *           description: Anonymous GID mapping
 *           example: 65534
 *         write_operations:
 *           type: string
 *           description: Write operation mode
 *           enum: [sync, async]
 *           example: "sync"
 *         mapping:
 *           type: string
 *           description: ID mapping mode
 *           enum: [root_squash, no_root_squash, all_squash]
 *           example: "root_squash"
 *         secure:
 *           type: boolean
 *           description: Use secure ports (1024 and below)
 *           example: true
 *         policies:
 *           type: array
 *           items:
 *             type: string
 *           description: Additional policies
 *           default: []
 *           example: []
 *         createDirectory:
 *           type: boolean
 *           description: Create share directory if it doesn't exist
 *           default: true
 *           example: true
 *         targetDevices:
 *           type: array
 *           items:
 *             type: integer
 *           description: Array of disk slot numbers for MergerFS pools (optional). Use GET /pools to retrieve available slots from pool.data_devices[].slot
 *           example: [1, 2]
 *         createDirectories:
 *           type: boolean
 *           description: Create directories on specified disk slots for MergerFS pools
 *           default: true
 *           example: true
 *         managePathRules:
 *           type: boolean
 *           description: Automatically create/update path rules in pool configuration
 *           default: true
 *           example: true
 *     CreateNfsShareRequest:
 *       type: object
 *       required:
 *         - shareName
 *       properties:
 *         shareName:
 *           type: string
 *           description: Name of the NFS share (alphanumeric, underscore, hyphen only)
 *           pattern: '^[a-zA-Z0-9_-]+$'
 *           example: "media"
 *         poolName:
 *           type: string
 *           nullable: true
 *           description: Pool name to use for the share. If null or empty, subPath must be an absolute path to an existing directory.
 *           example: "storage-pool"
 *         subPath:
 *           type: string
 *           description: |
 *             If poolName is provided: Subdirectory path within the pool (relative path).
 *             If poolName is null/empty: Absolute path to an existing directory (e.g., "/data/myshare"). The directory must exist and permissions will NOT be modified.
 *           default: ""
 *           example: "movies"
 *         source:
 *           type: string
 *           description: Network address/range or host allowed to access the share (* for all hosts)
 *           default: "10.0.0.0/24"
 *           examples:
 *             - "10.0.0.0/24"
 *             - "192.168.1.100"
 *             - "*"
 *           example: "10.0.0.0/24"
 *         enabled:
 *           type: boolean
 *           description: Enable the share
 *           default: true
 *           example: true
 *         read_only:
 *           type: boolean
 *           description: Read-only access
 *           default: false
 *           example: false
 *         anonuid:
 *           type: integer
 *           nullable: true
 *           description: Anonymous UID mapping for squashed users
 *           example: 65534
 *         anongid:
 *           type: integer
 *           nullable: true
 *           description: Anonymous GID mapping for squashed users
 *           example: 65534
 *         write_operations:
 *           type: string
 *           description: Write operation synchronization mode
 *           enum: [sync, async]
 *           default: "sync"
 *           example: "sync"
 *         mapping:
 *           type: string
 *           description: User ID mapping mode
 *           enum: [root_squash, no_root_squash, all_squash]
 *           default: "root_squash"
 *           example: "root_squash"
 *         secure:
 *           type: boolean
 *           description: Use secure ports (1024 and below)
 *           default: true
 *           example: true
 *         createDirectory:
 *           type: boolean
 *           description: Create share directory if it doesn't exist
 *           default: true
 *           example: true
 *         targetDevices:
 *           type: array
 *           items:
 *             type: integer
 *           description: Array of disk slot numbers for MergerFS pools (optional). Use GET /pools to retrieve available slots from pool.data_devices[].slot
 *           example: [1, 2]
 *         createDirectories:
 *           type: boolean
 *           description: Create directories on specified disk slots for MergerFS pools
 *           default: true
 *           example: true
 *         managePathRules:
 *           type: boolean
 *           description: Automatically create/update path rules in pool configuration
 *           default: true
 *           example: true
 *     UpdateSmbShareRequest:
 *       type: object
 *       properties:
 *         enabled:
 *           type: boolean
 *           description: Enable/disable the share
 *           example: true
 *         read_only:
 *           type: boolean
 *           description: Read-only access
 *           example: false
 *         guest_ok:
 *           type: boolean
 *           description: Allow guest access
 *           example: false
 *         browseable:
 *           type: boolean
 *           description: Show in network browse list
 *           example: true
 *         write_list:
 *           type: array
 *           items:
 *             type: string
 *           description: List of users with write access
 *           example: ["user1", "user2"]
 *         valid_users:
 *           type: array
 *           items:
 *             type: string
 *           description: List of valid users
 *           example: ["user1", "user2"]
 *         allow_execute_always:
 *           type: boolean
 *           description: Allow execute permission on all files (acl_allow_execute_always)
 *           example: false
 *         comment:
 *           type: string
 *           nullable: true
 *           description: Share description
 *           example: "Updated media files storage"
 *         targetDevices:
 *           type: array
 *           items:
 *             type: integer
 *           description: Array of disk slot numbers for MergerFS pools (automatically updates path rules)
 *           example: [3, 4]
 *     UpdateNfsShareRequest:
 *       type: object
 *       properties:
 *         source:
 *           type: string
 *           description: Network address/range or host allowed to access the share (* for all hosts)
 *           example: "192.168.1.0/24"
 *         enabled:
 *           type: boolean
 *           description: Enable/disable the share
 *           example: true
 *         read_only:
 *           type: boolean
 *           description: Read-only access
 *           example: false
 *         anonuid:
 *           type: integer
 *           nullable: true
 *           description: Anonymous UID mapping for squashed users
 *           example: 65534
 *         anongid:
 *           type: integer
 *           nullable: true
 *           description: Anonymous GID mapping for squashed users
 *           example: 65534
 *         write_operations:
 *           type: string
 *           description: Write operation synchronization mode
 *           enum: [sync, async]
 *           example: "sync"
 *         mapping:
 *           type: string
 *           description: User ID mapping mode
 *           enum: [root_squash, no_root_squash, all_squash]
 *           example: "root_squash"
 *         secure:
 *           type: boolean
 *           description: Use secure ports (1024 and below)
 *           example: true
 *         targetDevices:
 *           type: array
 *           items:
 *             type: integer
 *           description: Array of disk slot numbers for MergerFS pools (automatically updates path rules)
 *           example: [3, 4]
 *     SharesStatistics:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           description: Operation success
 *           example: true
 *         data:
 *           type: object
 *           properties:
 *             total:
 *               type: integer
 *               description: Total number of shares
 *               example: 5
 *             enabled:
 *               type: integer
 *               description: Number of enabled shares
 *               example: 3
 *             disabled:
 *               type: integer
 *               description: Number of disabled shares
 *               example: 2
 *             types:
 *               type: object
 *               description: Shares by type
 *               additionalProperties:
 *                 type: integer
 *               example:
 *                 smb: 5
 *         timestamp:
 *           type: string
 *           format: date-time
 *           description: Statistics timestamp
 *           example: "2024-01-20T10:30:00.000Z"
 *     AvailablePool:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Pool name
 *           example: "storage-pool"
 *         type:
 *           type: string
 *           description: Pool type
 *           example: "mergerfs"
 *         mountpoint:
 *           type: string
 *           description: Pool mount point
 *           example: "/mnt/storage-pool"
 *         available:
 *           type: boolean
 *           description: Whether pool is available for shares
 *           example: true
 *     ShareOperationResult:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           description: Operation successful
 *           example: true
 *         message:
 *           type: string
 *           description: Operation result message
 *           example: "SMB share created successfully"
 *         share:
 *           $ref: '#/components/schemas/SmbShare'
 *     DeleteShareRequest:
 *       type: object
 *       properties:
 *         deleteDirectory:
 *           type: boolean
 *           description: |
 *             Also delete the share directory (only for pool-based shares).
 *             For absolute path shares (without pool), the directory will NEVER be deleted, even if this is set to true.
 *           default: false
 *           example: false
 *         removePathRule:
 *           type: boolean
 *           description: Also remove the corresponding path rule from pool configuration (only applies to pool-based shares)
 *           default: true
 *           example: true
 */

/**
 * @swagger
 * /shares:
 *   get:
 *     summary: Get all shares configuration
 *     description: Retrieve all network shares configuration (admin only)
 *     tags: [Shares]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All shares configuration retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 smb:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SmbShare'
 *                 nfs:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/NfsShare'
 *             example:
 *               smb:
 *                 - id: "1640995200000"
 *                   name: "media"
 *                   path: "/mnt/storage-pool/movies"
 *                   enabled: true
 *                   read_only: false
 *               nfs: []
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

// Get all shares configuration (admin only)
router.get('/', checkRole(['admin']), async (req, res) => {
  try {
    const sharesArray = await sharesService.getShares();
    
    // Transform array format to flat object {smb: [], nfs: []}
    const shares = { smb: [], nfs: [] };
    sharesArray.forEach(section => {
      if (section.smb) shares.smb = shares.smb.concat(section.smb);
      if (section.nfs) shares.nfs = shares.nfs.concat(section.nfs);
    });
    
    res.json(shares);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /shares/smb:
 *   get:
 *     summary: Get SMB shares only
 *     description: Retrieve only SMB/CIFS shares configuration (admin only)
 *     tags: [Shares]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: SMB shares retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/SmbShare'
 *             example:
 *               - id: "1640995200000abc123"
 *                 name: "media"
 *                 path: "/mnt/storage-pool/movies"
 *                 enabled: true
 *                 read_only: false
 *                 guest_ok: false
 *                 browseable: true
 *                 write_list: ["user1", "user2"]
 *                 valid_users: ["user1", "user2", "user3"]
 *                 comment: "Media files storage"
 *               - id: "1640995200000def456"
 *                 name: "documents"
 *                 path: "/mnt/storage-pool/docs"
 *                 enabled: true
 *                 read_only: true
 *                 guest_ok: false
 *                 browseable: true
 *                 write_list: []
 *                 valid_users: ["admin"]
 *                 comment: "Document storage"
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

// Get SMB shares only (admin only)
router.get('/smb', checkRole(['admin']), async (req, res) => {
  try {
    const smbShares = await sharesService.getSmbShares();
    res.json(smbShares);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /shares/nfs:
 *   get:
 *     summary: Get NFS shares only
 *     description: Retrieve only NFS shares configuration (admin only)
 *     tags: [Shares]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: NFS shares retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/NfsShare'
 *             example:
 *               - id: "1640995200000abc123"
 *                 name: "media"
 *                 path: "/mnt/storage-pool/movies"
 *                 source: "10.0.0.0/24"
 *                 enabled: true
 *                 read_only: false
 *                 anonuid: null
 *                 anongid: null
 *                 write_operations: "sync"
 *                 mapping: "root_squash"
 *                 secure: true
 *               - id: "1640995200000def456"
 *                 name: "documents"
 *                 path: "/mnt/storage-pool/docs"
 *                 source: "192.168.1.0/24"
 *                 enabled: true
 *                 read_only: true
 *                 anonuid: 65534
 *                 anongid: 65534
 *                 write_operations: "sync"
 *                 mapping: "all_squash"
 *                 secure: true
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

// Get NFS shares only (admin only)
router.get('/nfs', checkRole(['admin']), async (req, res) => {
  try {
    const nfsShares = await sharesService.getNfsShares();
    res.json(nfsShares);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /shares/info:
 *   get:
 *     summary: Get shares information/statistics
 *     description: Retrieve statistical information about all network shares (admin only)
 *     tags: [Shares]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Shares statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SharesStatistics'
 *             example:
 *               success: true
 *               data:
 *                 total: 5
 *                 enabled: 3
 *                 disabled: 2
 *                 types:
 *                   smb: 5
 *               timestamp: "2024-01-20T10:30:00.000Z"
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

// Get shares information/statistics (admin only)
router.get('/info', checkRole(['admin']), async (req, res) => {
  try {
    const sharesInfo = await sharesService.getSharesInfo();
    res.json(sharesInfo);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /shares/pools:
 *   get:
 *     summary: Get available pools for share creation
 *     description: Retrieve a list of storage pools available for creating network shares (admin only)
 *     tags: [Shares]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Available pools retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/AvailablePool'
 *             example:
 *               - name: "storage-pool"
 *                 type: "mergerfs"
 *                 mountpoint: "/mnt/storage-pool"
 *                 available: true
 *               - name: "backup-pool"
 *                 type: "ext4"
 *                 mountpoint: "/mnt/backup-pool"
 *                 available: true
 *               - name: "temp-pool"
 *                 type: "xfs"
 *                 mountpoint: "/mnt/temp-pool"
 *                 available: false
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

// Get available pools for share creation (admin only)
router.get('/pools', checkRole(['admin']), async (req, res) => {
  try {
    const availablePools = await sharesService.getAvailablePools();
    res.json(availablePools);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /shares/smb:
 *   post:
 *     summary: Create new SMB share
 *     description: |
 *       Create a new SMB/CIFS network share (admin only).
 *
 *       **Pool-based shares**: Provide poolName and a relative subPath. The directory will be created if it doesn't exist, and ownership/permissions will be set.
 *
 *       **Absolute path shares**: Set poolName to null and provide an absolute path in subPath. The directory must already exist, and ownership/permissions will NOT be modified.
 *
 *       **For MergerFS pools**: You can specify targetDevices to control which disk slots store the data.
 *       Use GET /pools to get available disk slots from pool.data_devices[].slot.
 *     tags: [Shares]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateSmbShareRequest'
 *           examples:
 *             basic_share:
 *               summary: Basic SMB share (works with all pool types)
 *               value:
 *                 shareName: "documents"
 *                 poolName: "storage-pool"
 *                 subPath: "docs"
 *                 enabled: true
 *                 read_only: false
 *                 guest_ok: false
 *                 browseable: true
 *                 write_list: ["user1"]
 *                 valid_users: ["user1", "user2"]
 *                 comment: "Document storage"
 *             absolute_path_share:
 *               summary: SMB share with absolute path (no pool)
 *               value:
 *                 shareName: "external_data"
 *                 poolName: null
 *                 subPath: "/data/external/shared"
 *                 enabled: true
 *                 read_only: false
 *                 guest_ok: false
 *                 browseable: true
 *                 write_list: ["user1"]
 *                 valid_users: ["user1", "user2"]
 *                 comment: "External data share (existing directory, permissions preserved)"
 *             mergerfs_share_with_slots:
 *               summary: MergerFS share with specific disk slots
 *               value:
 *                 shareName: "filme"
 *                 poolName: "media"
 *                 subPath: "Filme"
 *                 targetDevices: [1, 2]
 *                 enabled: true
 *                 read_only: false
 *                 guest_ok: false
 *                 browseable: true
 *                 write_list: ["user1", "user2"]
 *                 valid_users: ["user1", "user2", "user3"]
 *                 comment: "Movies storage on disk slots 1-2"
 *                 createDirectories: true
 *                 managePathRules: true
 *     responses:
 *       201:
 *         description: SMB share created successfully
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
 *                   example: "SMB share 'filme' created successfully and SMB restarted"
 *                 data:
 *                   type: object
 *                   properties:
 *                     shareName:
 *                       type: string
 *                       example: "filme"
 *                     sharePath:
 *                       type: string
 *                       example: "/mnt/media/Filme"
 *                     poolName:
 *                       type: string
 *                       example: "media"
 *                     config:
 *                       type: object
 *                       description: SMB share configuration
 *                     mergerfsDetails:
 *                       type: object
 *                       description: Additional details for MergerFS pools (only present when targetDevices specified)
 *                       properties:
 *                         poolType:
 *                           type: string
 *                           example: "mergerfs"
 *                         targetDevices:
 *                           type: array
 *                           items:
 *                             type: integer
 *                           example: [1, 2]
 *                         diskDirectories:
 *                           type: object
 *                           description: Results of directory creation on disk slots
 *                         pathRuleCreated:
 *                           type: boolean
 *                           example: true
 *                         createdPaths:
 *                           type: array
 *                           items:
 *                             type: string
 *                           example: ["/var/mergerfs/media/disk1/Filme", "/var/mergerfs/media/disk2/Filme"]
 *                 smbRestarted:
 *                   type: boolean
 *                   example: true
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Bad request - validation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               missing_fields:
 *                 summary: Missing required fields
 *                 value:
 *                   success: false
 *                   error: "shareName and poolName are required"
 *               invalid_name:
 *                 summary: Invalid share name
 *                 value:
 *                   success: false
 *                   error: "Share name can only contain letters, numbers, underscores and hyphens"
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

// Create new SMB share (admin only)
router.post('/smb', checkRole(['admin']), async (req, res) => {
  try {
    const {
      shareName,
      poolName,
      subPath = '',
      automount = false,
      enabled = true,
      read_only = false,
      guest_ok = false,
      browseable = true,
      write_list = [],
      valid_users = [],
      force_root = false,
      create_mask = "0664",
      directory_mask = "0775",
      inherit_permissions = true,
      hide_dot_files = false,
      preserve_case = true,
      case_sensitive = true,
      allow_execute_always = false,
      comment = null,
      policies = [],
      createDirectory = true,
      targetDevices = null,
      createDirectories = true,
      managePathRules = true
    } = req.body;

    // Validation of required fields
    if (!shareName) {
      return res.status(400).json({
        success: false,
        error: 'shareName is required'
      });
    }

    // Validation of share name
    if (!/^[a-zA-Z0-9_-]+$/.test(shareName)) {
      return res.status(400).json({
        success: false,
        error: 'Share name can only contain letters, numbers, underscores and hyphens'
      });
    }

    // If no poolName is provided, subPath must be an absolute path
    if (!poolName || poolName === null || poolName === '') {
      if (!subPath || !subPath.startsWith('/')) {
        return res.status(400).json({
          success: false,
          error: 'When no poolName is provided, subPath must be an absolute path (starting with /)'
        });
      }
    }

    // Validation of targetDevices (if given)
    if (targetDevices !== null) {
      if (!Array.isArray(targetDevices)) {
        return res.status(400).json({
          success: false,
          error: 'targetDevices must be an array of disk slot numbers'
        });
      }

      if (targetDevices.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'targetDevices array cannot be empty'
        });
      }

      // Check if all values are numbers
      const invalidDevices = targetDevices.filter(device => !Number.isInteger(device) || device < 1);
      if (invalidDevices.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'All targetDevices must be positive integers (disk slot numbers)'
        });
      }
    }

    const options = {
      automount,
      enabled,
      read_only,
      guest_ok,
      browseable,
      write_list,
      valid_users,
      force_root,
      create_mask,
      directory_mask,
      inherit_permissions,
      hide_dot_files,
      preserve_case,
      case_sensitive,
      allow_execute_always,
      comment,
      policies,
      createDirectory,
      target_devices: targetDevices,
      createDirectories,
      managePathRules
    };

    const result = await sharesService.createSmbShare(shareName, poolName, subPath, options);
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
 * /shares/nfs:
 *   post:
 *     summary: Create new NFS share
 *     description: |
 *       Create a new NFS network share (admin only).
 *
 *       **Pool-based shares**: Provide poolName and a relative subPath. The directory will be created if it doesn't exist, and ownership/permissions will be set.
 *
 *       **Absolute path shares**: Set poolName to null and provide an absolute path in subPath. The directory must already exist, and ownership/permissions will NOT be modified.
 *
 *       **For MergerFS pools**: You can specify targetDevices to control which disk slots store the data.
 *       Use GET /pools to get available disk slots from pool.data_devices[].slot.
 *     tags: [Shares]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateNfsShareRequest'
 *           examples:
 *             basic_share:
 *               summary: Basic NFS share (works with all pool types)
 *               value:
 *                 shareName: "documents"
 *                 poolName: "storage-pool"
 *                 subPath: "docs"
 *                 source: "10.0.0.0/24"
 *                 enabled: true
 *                 read_only: false
 *                 anonuid: null
 *                 anongid: null
 *                 write_operations: "sync"
 *                 mapping: "root_squash"
 *                 secure: true
 *             absolute_path_share:
 *               summary: NFS share with absolute path (no pool)
 *               value:
 *                 shareName: "external_data"
 *                 poolName: null
 *                 subPath: "/data/external/shared"
 *                 source: "10.0.0.0/24"
 *                 enabled: true
 *                 read_only: false
 *                 anonuid: null
 *                 anongid: null
 *                 write_operations: "sync"
 *                 mapping: "root_squash"
 *                 secure: true
 *             mergerfs_share_with_slots:
 *               summary: MergerFS share with specific disk slots
 *               value:
 *                 shareName: "filme"
 *                 poolName: "media"
 *                 subPath: "Filme"
 *                 source: "192.168.1.0/24"
 *                 targetDevices: [1, 2]
 *                 enabled: true
 *                 read_only: false
 *                 anonuid: 65534
 *                 anongid: 65534
 *                 write_operations: "sync"
 *                 mapping: "all_squash"
 *                 secure: true
 *                 createDirectories: true
 *                 managePathRules: true
 *             public_share:
 *               summary: Public NFS share (accessible from all hosts)
 *               value:
 *                 shareName: "public"
 *                 poolName: "storage-pool"
 *                 subPath: "public"
 *                 source: "*"
 *                 enabled: true
 *                 read_only: true
 *                 mapping: "all_squash"
 *                 anonuid: 65534
 *                 anongid: 65534
 *     responses:
 *       201:
 *         description: NFS share created successfully
 *       400:
 *         description: Bad request - validation failed
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */

// Create new NFS share (admin only)
router.post('/nfs', checkRole(['admin']), async (req, res) => {
  try {
    const {
      shareName,
      poolName,
      subPath = '',
      source = "10.0.0.0/24",
      enabled = true,
      read_only = false,
      anonuid = null,
      anongid = null,
      write_operations = "sync",
      mapping = "root_squash",
      secure = true,
      createDirectory = true,
      targetDevices = null,
      createDirectories = true,
      managePathRules = true
    } = req.body;

    // Validation of required fields
    if (!shareName) {
      return res.status(400).json({
        success: false,
        error: 'shareName is required'
      });
    }

    // Validation of share name
    if (!/^[a-zA-Z0-9_-]+$/.test(shareName)) {
      return res.status(400).json({
        success: false,
        error: 'Share name can only contain letters, numbers, underscores and hyphens'
      });
    }

    // If no poolName is provided, subPath must be an absolute path
    if (!poolName || poolName === null || poolName === '') {
      if (!subPath || !subPath.startsWith('/')) {
        return res.status(400).json({
          success: false,
          error: 'When no poolName is provided, subPath must be an absolute path (starting with /)'
        });
      }
    }

    // Validation of targetDevices (if given)
    if (targetDevices !== null) {
      if (!Array.isArray(targetDevices)) {
        return res.status(400).json({
          success: false,
          error: 'targetDevices must be an array of disk slot numbers'
        });
      }

      if (targetDevices.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'targetDevices array cannot be empty'
        });
      }

      // Check if all values are numbers
      const invalidDevices = targetDevices.filter(device => !Number.isInteger(device) || device < 1);
      if (invalidDevices.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'All targetDevices must be positive integers (disk slot numbers)'
        });
      }
    }

    // Validation of NFS-specific parameters
    if (write_operations && !['sync', 'async'].includes(write_operations)) {
      return res.status(400).json({
        success: false,
        error: 'write_operations must be either "sync" or "async"'
      });
    }

    if (mapping && !['root_squash', 'no_root_squash', 'all_squash'].includes(mapping)) {
      return res.status(400).json({
        success: false,
        error: 'mapping must be one of: root_squash, no_root_squash, all_squash'
      });
    }

    if (secure !== undefined && typeof secure !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'secure must be a boolean'
      });
    }

    // Validation of source address (simple check)
    if (source && source !== '*' && !/^[\d\.\/\:\*a-fA-F]+$/.test(source)) {
      return res.status(400).json({
        success: false,
        error: 'source must be a valid IP address/range, hostname, or "*" for all hosts'
      });
    }

    const options = {
      source,
      enabled,
      read_only,
      anonuid,
      anongid,
      write_operations,
      mapping,
      secure,
      createDirectory,
      target_devices: targetDevices,
      createDirectories,
      managePathRules
    };

    const result = await sharesService.createNfsShare(shareName, poolName, subPath, options);
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
 * /shares/smb/{shareId}:
 *   get:
 *     summary: Get a specific SMB share
 *     description: Retrieve detailed information about a specific SMB share by ID (admin only)
 *     tags: [Shares]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: shareId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the SMB share
 *         example: "1640995200000abc123"
 *     responses:
 *       200:
 *         description: SMB share retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ShareOperationResult'
 *             example:
 *               success: true
 *               message: "Share retrieved successfully"
 *               share:
 *                 shareName: "media"
 *                 poolName: "storage-pool"
 *                 subPath: "movies"
 *                 enabled: true
 *                 read_only: false
 *                 guest_ok: false
 *                 browseable: true
 *                 write_list: ["user1", "user2"]
 *                 valid_users: ["user1", "user2", "user3"]
 *                 comment: "Media files storage"
 *       400:
 *         description: Share name is required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               success: false
 *               error: "Share name is required"
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

// Get a specific SMB share (admin only)
router.get('/smb/:shareId', checkRole(['admin']), async (req, res) => {
  try {
    const { shareId } = req.params;

    if (!shareId) {
      return res.status(400).json({
        success: false,
        error: 'Share ID is required'
      });
    }

    const result = await sharesService.getShare(shareId);
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
 * /shares/smb/{shareId}:
 *   put:
 *     summary: Update a SMB share
 *     description: |
 *       Update configuration of an existing SMB share (admin only).
 *
 *       **Note**: When updating targetDevices, the corresponding path rules in the pool configuration are automatically updated.
 *     tags: [Shares]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: shareId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the SMB share to update
 *         example: "1640995200000abc123"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateSmbShareRequest'
 *           example:
 *             enabled: false
 *             read_only: true
 *             guest_ok: false
 *             browseable: true
 *             write_list: ["user1"]
 *             valid_users: ["user1", "user2"]
 *             comment: "Updated media files storage - read only"
 *     responses:
 *       200:
 *         description: SMB share updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ShareOperationResult'
 *             example:
 *               success: true
 *               message: "Share updated successfully"
 *               share:
 *                 shareName: "media"
 *                 poolName: "storage-pool"
 *                 subPath: "movies"
 *                 enabled: false
 *                 read_only: true
 *                 guest_ok: false
 *                 browseable: true
 *                 write_list: ["user1"]
 *                 valid_users: ["user1", "user2"]
 *                 comment: "Updated media files storage - read only"
 *       400:
 *         description: Bad request - validation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               missing_id:
 *                 summary: Share ID is required
 *                 value:
 *                   success: false
 *                   error: "Share ID is required"
 *               no_data:
 *                 summary: Update data is required
 *                 value:
 *                   success: false
 *                   error: "Update data is required"
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

// Update a SMB share (admin only)
router.put('/smb/:shareId', checkRole(['admin']), async (req, res) => {
  try {
    const { shareId } = req.params;
    const updates = req.body;

    if (!shareId) {
      return res.status(400).json({
        success: false,
        error: 'Share ID is required'
      });
    }

    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Update data is required'
      });
    }

    const result = await sharesService.updateShare(shareId, updates);
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
 * /shares/smb/{shareId}:
 *   delete:
 *     summary: Delete a SMB share
 *     description: |
 *       Delete an existing SMB share and optionally its directory (admin only).
 *
 *       **Pool-based shares**: Directory can be deleted if deleteDirectory is true.
 *
 *       **Absolute path shares**: Directory will NEVER be deleted, even if deleteDirectory is true (to protect external directories).
 *
 *       **Note**: Associated path rules in the pool configuration are automatically removed when removePathRule is true (default).
 *     tags: [Shares]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: shareId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the SMB share to delete
 *         example: "1640995200000abc123"
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/DeleteShareRequest'
 *           example:
 *             deleteDirectory: false
 *     responses:
 *       200:
 *         description: SMB share deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ShareOperationResult'
 *             example:
 *               success: true
 *               message: "SMB share 'media' deleted successfully"
 *               share:
 *                 shareName: "media"
 *                 poolName: "storage-pool"
 *                 subPath: "movies"
 *                 enabled: true
 *                 read_only: false
 *                 guest_ok: false
 *                 browseable: true
 *                 write_list: ["user1", "user2"]
 *                 valid_users: ["user1", "user2", "user3"]
 *                 comment: "Media files storage"
 *       400:
 *         description: Share name is required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               success: false
 *               error: "Share name is required"
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

// Delete a SMB share (admin only)
router.delete('/smb/:shareId', checkRole(['admin']), async (req, res) => {
  try {
    const { shareId } = req.params;
    const { deleteDirectory = false, removePathRule = true } = req.body;

    if (!shareId) {
      return res.status(400).json({
        success: false,
        error: 'Share ID is required'
      });
    }

    const result = await sharesService.deleteShare(shareId, { deleteDirectory, removePathRule });
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
 * /shares/smb/{shareId}/target-devices:
 *   get:
 *     summary: Get target devices for a specific share
 *     description: Retrieve the current target devices (disk slots) configuration for a share. Only applies to MergerFS pools.
 *     tags: [Shares]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: shareId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the SMB share
 *         example: "1640995200000abc123"
 *     responses:
 *       200:
 *         description: Target devices retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     shareId:
 *                       type: string
 *                       example: "1640995200000abc123"
 *                     shareName:
 *                       type: string
 *                       example: "filme"
 *                     poolName:
 *                       type: string
 *                       example: "media"
 *                     poolType:
 *                       type: string
 *                       example: "mergerfs"
 *                     isValidForPathRules:
 *                       type: boolean
 *                       example: true
 *                     pathRule:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         path:
 *                           type: string
 *                           example: "/Filme"
 *                         targetDevices:
 *                           type: array
 *                           items:
 *                             type: integer
 *                           example: [1, 2]
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       404:
 *         description: Share not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 */

// Get target devices for a specific share (admin only)
router.get('/smb/:shareId/target-devices', checkRole(['admin']), async (req, res) => {
  try {
    const { shareId } = req.params;

    if (!shareId) {
      return res.status(400).json({
        success: false,
        error: 'Share ID is required'
      });
    }

    const result = await sharesService.getShareTargetDevices(shareId);
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
 * /shares/smb/{shareId}/target-devices:
 *   put:
 *     summary: Update target devices for a share
 *     description: |
 *       Update the target devices (disk slots) for a specific share.
 *       This automatically manages the path rules in the pool configuration.
 *       Only works with MergerFS pools.
 *     tags: [Shares]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: shareId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the SMB share
 *         example: "1640995200000abc123"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - targetDevices
 *             properties:
 *               targetDevices:
 *                 type: array
 *                 items:
 *                   type: integer
 *                 description: Array of disk slot numbers. Use GET /pools to get available slots.
 *                 example: [3, 4]
 *           example:
 *             targetDevices: [3, 4]
 *     responses:
 *       200:
 *         description: Target devices updated successfully
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
 *                   example: "Share 'filme' (ID: 1640995200000abc123) updated successfully and SMB restarted"
 *                 data:
 *                   type: object
 *                   properties:
 *                     shareId:
 *                       type: string
 *                       example: "1640995200000abc123"
 *                     shareName:
 *                       type: string
 *                       example: "filme"
 *                     config:
 *                       type: object
 *                       description: Updated share configuration including path_rule
 *                 smbRestarted:
 *                   type: boolean
 *                   example: true
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Bad request - validation failed
 *       404:
 *         description: Share not found
 *       500:
 *         description: Server error
 */

// Update target devices for a specific share (admin only)
router.put('/smb/:shareId/target-devices', checkRole(['admin']), async (req, res) => {
  try {
    const { shareId } = req.params;
    const { targetDevices } = req.body;

    if (!shareId) {
      return res.status(400).json({
        success: false,
        error: 'Share ID is required'
      });
    }

    if (!Array.isArray(targetDevices)) {
      return res.status(400).json({
        success: false,
        error: 'targetDevices must be an array of disk slot numbers'
      });
    }

    if (targetDevices.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'targetDevices array cannot be empty'
      });
    }

    // Validation of targetDevices
    const invalidDevices = targetDevices.filter(device => !Number.isInteger(device) || device < 1);
    if (invalidDevices.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'All targetDevices must be positive integers (disk slot numbers)'
      });
    }

    const result = await sharesService.updateShareTargetDevices(shareId, targetDevices);
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
 * /shares/smb/{shareId}/target-devices:
 *   delete:
 *     summary: Remove target devices from a share
 *     description: |
 *       Remove target devices configuration from a share.
 *       This removes the path rule from both the share and pool configuration.
 *     tags: [Shares]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: shareId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the SMB share
 *         example: "1640995200000abc123"
 *     responses:
 *       200:
 *         description: Target devices removed successfully
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
 *                   example: "Share 'filme' (ID: 1640995200000abc123) updated successfully and SMB restarted"
 *                 data:
 *                   type: object
 *                   properties:
 *                     shareId:
 *                       type: string
 *                       example: "1640995200000abc123"
 *                     shareName:
 *                       type: string
 *                       example: "filme"
 *                     config:
 *                       type: object
 *                       description: Updated share configuration without path_rule
 *                 nfsReloaded:
 *                   type: boolean
 *                   example: true
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       404:
 *         description: Share not found
 *       500:
 *         description: Server error
 */

// Remove target devices from a specific share (admin only)
router.delete('/smb/:shareId/target-devices', checkRole(['admin']), async (req, res) => {
  try {
    const { shareId } = req.params;

    if (!shareId) {
      return res.status(400).json({
        success: false,
        error: 'Share ID is required'
      });
    }

    const result = await sharesService.removeShareTargetDevices(shareId);
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
 * /shares/nfs/{shareId}:
 *   get:
 *     summary: Get a specific NFS share
 *     description: Retrieve detailed information about a specific NFS share by ID (admin only)
 *     tags: [Shares]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: shareId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the NFS share
 *         example: "1640995200000abc123"
 *     responses:
 *       200:
 *         description: NFS share retrieved successfully
 *       404:
 *         description: Share not found
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */

// Get a specific NFS share (admin only)
router.get('/nfs/:shareId', checkRole(['admin']), async (req, res) => {
  try {
    const { shareId } = req.params;

    if (!shareId) {
      return res.status(400).json({
        success: false,
        error: 'Share ID is required'
      });
    }

    const result = await sharesService.getShare(shareId);
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
 * /shares/nfs/{shareId}:
 *   put:
 *     summary: Update a NFS share
 *     description: |
 *       Update configuration of an existing NFS share (admin only).
 *
 *       **Note**: When updating targetDevices, the corresponding path rules in the pool configuration are automatically updated.
 *     tags: [Shares]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: shareId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the NFS share to update
 *         example: "1640995200000abc123"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateNfsShareRequest'
 *           example:
 *             source: "192.168.1.0/24"
 *             enabled: false
 *             read_only: true
 *             mapping: "all_squash"
 *             anonuid: 65534
 *             anongid: 65534
 *     responses:
 *       200:
 *         description: NFS share updated successfully
 *       400:
 *         description: Bad request - validation failed
 *       404:
 *         description: Share not found
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */

// Update a NFS share (admin only)
router.put('/nfs/:shareId', checkRole(['admin']), async (req, res) => {
  try {
    const { shareId } = req.params;
    const updates = req.body;

    if (!shareId) {
      return res.status(400).json({
        success: false,
        error: 'Share ID is required'
      });
    }

    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Update data is required'
      });
    }

    // Validation of NFS-specific parameters (if updated)
    if (updates.write_operations && !['sync', 'async'].includes(updates.write_operations)) {
      return res.status(400).json({
        success: false,
        error: 'write_operations must be either "sync" or "async"'
      });
    }

    if (updates.mapping && !['root_squash', 'no_root_squash', 'all_squash'].includes(updates.mapping)) {
      return res.status(400).json({
        success: false,
        error: 'mapping must be one of: root_squash, no_root_squash, all_squash'
      });
    }

    if (updates.secure !== undefined && typeof updates.secure !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'secure must be a boolean'
      });
    }

    const result = await sharesService.updateShare(shareId, updates);
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
 * /shares/nfs/{shareId}:
 *   delete:
 *     summary: Delete a NFS share
 *     description: |
 *       Delete an existing NFS share and optionally its directory (admin only).
 *
 *       **Pool-based shares**: Directory can be deleted if deleteDirectory is true.
 *
 *       **Absolute path shares**: Directory will NEVER be deleted, even if deleteDirectory is true (to protect external directories).
 *
 *       **Note**: Associated path rules in the pool configuration are automatically removed when removePathRule is true (default).
 *     tags: [Shares]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: shareId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the NFS share to delete
 *         example: "1640995200000abc123"
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/DeleteShareRequest'
 *           example:
 *             deleteDirectory: false
 *             removePathRule: true
 *     responses:
 *       200:
 *         description: NFS share deleted successfully
 *       400:
 *         description: Share ID is required
 *       404:
 *         description: Share not found
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */

// Delete a NFS share (admin only)
router.delete('/nfs/:shareId', checkRole(['admin']), async (req, res) => {
  try {
    const { shareId } = req.params;
    const { deleteDirectory = false, removePathRule = true } = req.body;

    if (!shareId) {
      return res.status(400).json({
        success: false,
        error: 'Share ID is required'
      });
    }

    const result = await sharesService.deleteShare(shareId, { deleteDirectory, removePathRule });
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
 * /shares/nfs/{shareId}/target-devices:
 *   get:
 *     summary: Get target devices for a specific NFS share
 *     description: Retrieve the current target devices (disk slots) configuration for an NFS share. Only applies to MergerFS pools.
 *     tags: [Shares]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: shareId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the NFS share
 *         example: "1640995200000abc123"
 *     responses:
 *       200:
 *         description: Target devices retrieved successfully
 *       404:
 *         description: Share not found
 *       500:
 *         description: Server error
 */

// Get target devices for a specific NFS share (admin only)
router.get('/nfs/:shareId/target-devices', checkRole(['admin']), async (req, res) => {
  try {
    const { shareId } = req.params;

    if (!shareId) {
      return res.status(400).json({
        success: false,
        error: 'Share ID is required'
      });
    }

    const result = await sharesService.getShareTargetDevices(shareId);
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
 * /shares/nfs/{shareId}/target-devices:
 *   put:
 *     summary: Update target devices for a NFS share
 *     description: |
 *       Update the target devices (disk slots) for a specific NFS share.
 *       This automatically manages the path rules in the pool configuration.
 *       Only works with MergerFS pools.
 *     tags: [Shares]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: shareId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the NFS share
 *         example: "1640995200000abc123"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - targetDevices
 *             properties:
 *               targetDevices:
 *                 type: array
 *                 items:
 *                   type: integer
 *                 description: Array of disk slot numbers. Use GET /pools to get available slots.
 *                 example: [3, 4]
 *           example:
 *             targetDevices: [3, 4]
 *     responses:
 *       200:
 *         description: Target devices updated successfully
 *       400:
 *         description: Bad request - validation failed
 *       404:
 *         description: Share not found
 *       500:
 *         description: Server error
 */

// Update target devices for a specific NFS share (admin only)
router.put('/nfs/:shareId/target-devices', checkRole(['admin']), async (req, res) => {
  try {
    const { shareId } = req.params;
    const { targetDevices } = req.body;

    if (!shareId) {
      return res.status(400).json({
        success: false,
        error: 'Share ID is required'
      });
    }

    if (!Array.isArray(targetDevices)) {
      return res.status(400).json({
        success: false,
        error: 'targetDevices must be an array of disk slot numbers'
      });
    }

    if (targetDevices.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'targetDevices array cannot be empty'
      });
    }

    // Validation of targetDevices
    const invalidDevices = targetDevices.filter(device => !Number.isInteger(device) || device < 1);
    if (invalidDevices.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'All targetDevices must be positive integers (disk slot numbers)'
      });
    }

    const result = await sharesService.updateShareTargetDevices(shareId, targetDevices);
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
 * /shares/nfs/{shareId}/target-devices:
 *   delete:
 *     summary: Remove target devices from a NFS share
 *     description: |
 *       Remove target devices configuration from an NFS share.
 *       This removes the path rule from both the share and pool configuration.
 *     tags: [Shares]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: shareId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the NFS share
 *         example: "1640995200000abc123"
 *     responses:
 *       200:
 *         description: Target devices removed successfully
 *       404:
 *         description: Share not found
 *       500:
 *         description: Server error
 */

// Remove target devices from a specific NFS share (admin only)
router.delete('/nfs/:shareId/target-devices', checkRole(['admin']), async (req, res) => {
  try {
    const { shareId } = req.params;

    if (!shareId) {
      return res.status(400).json({
        success: false,
        error: 'Share ID is required'
      });
    }

    const result = await sharesService.removeShareTargetDevices(shareId);
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