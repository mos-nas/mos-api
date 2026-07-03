const express = require('express');
const fs = require('fs');
const path = require('path');
const fileUpload = require('express-fileupload');
const router = express.Router();
const mosService = require('../services/mos.service');
const zramService = require('../services/zram.service');
const swapService = require('../services/swap.service');
const pluginsService = require('../services/plugins.service');
const { checkRole } = require('../middleware/auth.middleware');

/**
 * @swagger
 * tags:
 *   name: MOS
 *   description: MOS System Configuration and Settings Management
 *
 * components:
 *   schemas:
 *     Error:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           description: Error message
 *     SensorValue:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Sensor ID
 *           example: "1735303800123"
 *         index:
 *           type: integer
 *           description: Sort index within group
 *           example: 0
 *         name:
 *           type: string
 *           description: Display name
 *           example: "Front Fan"
 *         manufacturer:
 *           type: string
 *           nullable: true
 *           description: Hardware manufacturer
 *           example: "Corsair"
 *         model:
 *           type: string
 *           nullable: true
 *           description: Hardware model
 *           example: "HX750i"
 *         subtype:
 *           type: string
 *           nullable: true
 *           description: Sensor subtype for more specific categorization
 *           enum: [voltage, wattage, amperage, speed, flow, temperature, rpm, percentage, null]
 *           example: "voltage"
 *         value:
 *           type: number
 *           nullable: true
 *           description: Current sensor value
 *           example: 30.5
 *         unit:
 *           type: string
 *           description: Value unit
 *           example: "%"
 *     SensorConfig:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           example: "1735303800123"
 *         index:
 *           type: integer
 *           example: 0
 *         name:
 *           type: string
 *           example: "Front Fan"
 *         manufacturer:
 *           type: string
 *           nullable: true
 *           description: Hardware manufacturer
 *           example: "Corsair"
 *         model:
 *           type: string
 *           nullable: true
 *           description: Hardware model
 *           example: "HX750i"
 *         subtype:
 *           type: string
 *           nullable: true
 *           description: Sensor subtype
 *           enum: [voltage, wattage, amperage, speed, flow, temperature, rpm, percentage, null]
 *         source:
 *           type: string
 *           description: Dot notation path to sensor value
 *           example: "nct6798-isa-0290.pwm1.pwm1"
 *         unit:
 *           type: string
 *           example: "%"
 *         multiplier:
 *           type: number
 *           nullable: true
 *           description: Multiplier for voltage dividers (applied before other transforms). Cannot be used together with divisor.
 *           example: 6
 *         divisor:
 *           type: number
 *           nullable: true
 *           description: Divisor for sensors that output scaled values (applied before other transforms). Cannot be used together with multiplier.
 *           example: 1000
 *         value_range:
 *           type: object
 *           nullable: true
 *           properties:
 *             min:
 *               type: number
 *             max:
 *               type: number
 *         transform:
 *           type: string
 *           nullable: true
 *           enum: [percentage, null]
 *         enabled:
 *           type: boolean
 *           example: true
 *     DockerSettings:
 *       type: object
 *       properties:
 *         enabled:
 *           type: boolean
 *           description: Enable Docker service
 *           example: true
 *         directory:
 *           type: string
 *           description: Docker data directory
 *           example: "/mnt/pool1/docker"
 *         appdata:
 *           type: string
 *           description: Docker appdata directory
 *           example: "/mnt/pool1/appdata"
 *         docker_net:
 *           type: object
 *           description: Docker network configuration
 *           properties:
 *             mode:
 *               type: string
 *               enum: [macvlan, ipvlan]
 *               description: Docker network mode
 *               example: "ipvlan"
 *             config:
 *               type: array
 *               description: Network configuration entries
 *               items:
 *                 type: object
 *                 properties:
 *                   subnet:
 *                     type: string
 *                     description: Network subnet in CIDR notation
 *                     example: "10.0.0.0/24"
 *                   gateway:
 *                     type: string
 *                     description: Gateway IP address
 *                     example: "10.0.0.5"
 *         filesystem:
 *           type: string
 *           description: Docker filesystem type
 *           example: "btrfs"
 *         start_wait:
 *           type: string
 *           description: Wait time before starting Docker containers
 *           example: "0"
 *         docker_options:
 *           type: string
 *           description: Additional Docker daemon command line arguments
 *           example: "--log-level=info --storage-opt=overlay2.size=10G"
 *         update_check:
 *           type: object
 *           description: Docker update check configuration
 *           properties:
 *             enabled:
 *               type: boolean
 *               description: Enable update checking
 *               example: true
 *             update_check_schedule:
 *               type: string
 *               description: Cron schedule for update checks
 *               example: "0 1 * * *"
 *             auto_update:
 *               type: object
 *               description: Auto-update configuration
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                   description: Enable automatic updates
 *                   example: true
 *                 auto_update_schedule:
 *                   type: string
 *                   description: Cron schedule for auto-updates
 *                   example: "0 2 * * SAT"
 *     LxcSettings:
 *       type: object
 *       properties:
 *         enabled:
 *           type: boolean
 *           description: Enable LXC service
 *           example: true
 *         directory:
 *           type: string
 *           description: LXC containers directory
 *           example: "/mnt/pool1/lxc"
 *         lxc_registry:
 *           type: string
 *           nullable: true
 *           description: Custom LXC container registry server (without protocol prefix). When set, containers are downloaded from this server instead of the default. Example format - my.lxc.org (not https://my.lxc.org)
 *           example: "images.linuxcontainers.org"
 *     VmSettings:
 *       type: object
 *       properties:
 *         enabled:
 *           type: boolean
 *           description: Enable VM service
 *           example: true
 *         iommu_active:
 *           type: boolean
 *           description: Whether IOMMU is currently active on the system (read-only, injected at runtime)
 *           readOnly: true
 *           example: false
 *         directory:
 *           type: string
 *           description: VM storage directory
 *           example: "/mnt/pool1/vm"
 *         vdisk_directory:
 *           type: string
 *           description: Virtual disk directory
 *           example: "/mnt/pool1/vdisk"
 *         start_wait:
 *           type: integer
 *           description: Wait time before starting VMs
 *           example: 30
 *         hugepages:
 *           type: object
 *           description: Hugepages configuration and runtime info
 *           properties:
 *             enabled:
 *               type: boolean
 *               description: Whether hugepages are enabled
 *               example: true
 *             total:
 *               type: integer
 *               description: Number of hugepages to allocate (set via sysctl)
 *               example: 1024
 *             size_mb:
 *               type: integer
 *               description: Size of each hugepage in MB (read-only, from system)
 *               readOnly: true
 *               example: 2
 *             free:
 *               type: integer
 *               description: Number of currently free hugepages (read-only, from system)
 *               readOnly: true
 *               example: 512
 *     NetworkSettings:
 *       type: object
 *       properties:
 *         interfaces:
 *           type: array
 *           description: Network interfaces configuration
 *           items:
 *             type: object
 *             properties:
 *               mac:
 *                 type: string
 *                 nullable: true
 *                 description: Physical MAC address for interface identification (null for virtual/legacy)
 *                 example: "aa:bb:cc:dd:ee:ff"
 *               name:
 *                 type: string
 *                 description: Kernel interface name
 *                 example: "eth0"
 *               label:
 *                 type: string
 *                 nullable: true
 *                 description: User-defined display name for the interface
 *                 example: "LAN"
 *               type:
 *                 type: string
 *                 enum: [ethernet, bridged, bridge, bond, bonded]
 *                 description: Interface type
 *                 example: "ethernet"
 *               mode:
 *                 type: string
 *                 nullable: true
 *                 description: Bond mode (only for type bond)
 *                 enum: [balance-rr, active-backup, balance-xor, broadcast, 802.3ad, balance-tlb, balance-alb]
 *                 example: null
 *               interfaces:
 *                 type: array
 *                 description: Member interfaces (for bridge or bond type)
 *                 items:
 *                   type: string
 *                 example: ["eth0"]
 *               ipv4:
 *                 type: array
 *                 description: IPv4 configuration array
 *                 items:
 *                   type: object
 *                   properties:
 *                     dhcp:
 *                       type: boolean
 *                       description: Enable DHCP for this IPv4 config
 *                       example: true
 *                     address:
 *                       type: string
 *                       description: Static IP address with CIDR (required when dhcp=false)
 *                       example: "10.0.0.1/24"
 *                     gateway:
 *                       type: string
 *                       description: Gateway IP address (optional for static)
 *                       example: "10.0.0.5"
 *                     dns:
 *                       type: array
 *                       description: DNS servers (optional for static)
 *                       items:
 *                         type: string
 *                       example: ["10.0.0.5"]
 *                 example: [{"dhcp": true}]
 *               ipv6:
 *                 type: array
 *                 description: IPv6 configuration array (currently always empty)
 *                 items:
 *                   type: object
 *                 example: []
 *               vlans:
 *                 type: array
 *                 description: VLAN configurations for this interface
 *                 items:
 *                   type: object
 *                   properties:
 *                     vlan_id:
 *                       type: integer
 *                       description: VLAN ID (1-4094)
 *                       example: 100
 *                     ipv4:
 *                       type: array
 *                       description: IPv4 configuration for this VLAN
 *                       items:
 *                         type: object
 *                         properties:
 *                           dhcp:
 *                             type: boolean
 *                             example: true
 *                           address:
 *                             type: string
 *                             example: "192.168.100.1/24"
 *                           gateway:
 *                             type: string
 *                             example: "192.168.100.254"
 *                     ipv6:
 *                       type: array
 *                       description: IPv6 configuration for this VLAN
 *                       items:
 *                         type: object
 *                     mtu:
 *                       type: integer
 *                       nullable: true
 *                       description: MTU for this VLAN (null inherits from parent interface)
 *                       example: null
 *                 example: []
 *               mtu:
 *                 type: integer
 *                 nullable: true
 *                 description: MTU for this interface (null = system default 1500)
 *                 example: null
 *               hw_addr:
 *                 type: string
 *                 nullable: true
 *                 description: MAC spoofing address (null = use real hardware MAC)
 *                 example: null
 *               status:
 *                 type: string
 *                 enum: [enabled, orphan, disabled]
 *                 description: "Interface status: enabled = configured and running, orphan = hardware not found (set by reconcile), disabled = manually disabled by user (skipped at boot, not overwritten by reconcile)"
 *                 example: "enabled"
 *               vlan_filtering:
 *                 type: boolean
 *                 description: "Enable VLAN filtering on bridge (bridge only). Turns the bridge into a VLAN-aware switch, required for LXC VLAN passthrough."
 *                 example: false
 *               bridge_vids:
 *                 type: array
 *                 items:
 *                   type: integer
 *                 description: "Allowed VLAN IDs on bridge (bridge only, requires vlan_filtering=true). Empty array = all VLANs (2-4094)."
 *                 example: []
 *         services:
 *           type: object
 *           properties:
 *             ssh:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                   description: Enable SSH service
 *                   example: true
 *             samba:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                   description: Enable Samba service
 *                   example: true
 *                 workgroup:
 *                   type: string
 *                   description: Samba workgroup name
 *                   example: "WORKGROUP"
 *                 localmaster:
 *                   type: boolean
 *                   description: Enable Samba local master browser
 *                   example: false
 *             samba_discovery:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                   description: Enable Samba discovery service (WSD)
 *                   example: false
 *             nfs:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                   description: Enable NFS service
 *                   example: false
 *             nut:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                   description: Enable NUT (Network UPS Tools) service
 *                   example: false
 *             remote_mounting:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                   description: Enable remote mounting functionality (SMB/NFS shares)
 *                   example: true
     *     SystemSettings:
     *       type: object
     *       properties:
     *         hostname:
     *           type: string
     *           description: System hostname
     *           example: "mos-server"
     *         global_spindown:
     *           type: boolean
     *           description: Global disk spindown setting
     *           example: true
     *         timezone:
     *           type: string
     *           description: System timezone
     *           example: "Europe/Berlin"
     *         display:
     *           type: object
     *           description: Display settings
     *           properties:
     *             timeout:
     *               type: integer
     *               description: Display timeout in seconds
     *               example: 30
     *             powersave:
     *               type: string
     *               description: Display power save mode (on, vsync, powerdown, off)
     *               example: "on"
     *             powerdown:
     *               type: integer
     *               description: Display power down timeout in seconds
     *               example: 60
     *         persist_history:
     *           type: boolean
     *           description: Persist command history
     *           example: false
     *         notification_sound:
     *           type: object
     *           description: System notification sound settings
     *           properties:
     *             startup:
     *               type: boolean
     *               description: Enable sound notification on system startup
     *               example: true
     *             reboot:
     *               type: boolean
     *               description: Enable sound notification on system reboot
     *               example: true
     *             shutdown:
     *               type: boolean
     *               description: Enable sound notification on system shutdown
     *               example: true
     *         swapfile:
     *           type: object
     *           description: Swapfile configuration
     *           properties:
     *             enabled:
     *               type: boolean
     *               description: Enable swapfile
     *               example: false
     *             path:
     *               type: string
     *               nullable: true
     *               description: Directory path for swapfile (must be on mounted pool under /mnt/)
     *               example: "/mnt/pool1"
     *             size:
     *               type: string
     *               description: Swapfile size (e.g., "10G", "1024M")
     *               example: "10G"
     *             priority:
     *               type: integer
     *               description: Swap priority (default -2)
     *               example: -2
     *             config:
     *               type: object
     *               description: Zswap configuration
     *               properties:
     *                 zswap:
     *                   type: boolean
     *                   description: Enable zswap (compressed swap cache)
     *                   example: false
     *                 shrinker:
     *                   type: boolean
     *                   description: Enable zswap shrinker
     *                   example: true
     *                 max_pool_percent:
     *                   type: integer
     *                   description: Maximum pool size as percentage of RAM
     *                   example: 20
     *                 compressor:
     *                   type: string
     *                   description: Compression algorithm (zstd, lz4, lzo, etc.)
     *                   example: "zstd"
     *                 accept_threshold_percent:
     *                   type: integer
     *                   description: Accept threshold percentage
     *                   example: 90
     *         webui:
     *           type: object
     *           description: WebUI configuration settings
     *           properties:
     *             ports:
     *               type: object
     *               description: WebUI port configuration
     *               properties:
     *                 http:
     *                   type: integer
     *                   description: HTTP port for the WebUI (default 80)
     *                   example: 80
     *         update_check:
     *           type: object
     *           description: MOS system update check configuration
     *           properties:
     *             enabled:
     *               type: boolean
     *               description: Enable system update checking
     *               example: false
     *             update_check_schedule:
     *               type: string
     *               description: Cron schedule for update checks
     *               example: "0 1 * * *"
 *     Keymap:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Keymap name
 *           example: "de"
 *         description:
 *           type: string
 *           description: Keymap description
 *           example: "German"
 *     Timezone:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Timezone identifier
 *           example: "Europe/Berlin"
 *         description:
 *           type: string
 *           description: Timezone description
 *           example: "Central European Time"
 *     SettingsUpdateRequest:
 *       type: object
 *       description: Generic settings update request (fields depend on endpoint)
 *       additionalProperties: true
 *       example:
 *         enabled: true
 *         directory: "/mnt/pool1/docker"
 *         docker_options: "--log-level=info"
 */

// Only Admin can access these routes
router.use(checkRole(['admin']));

/**
 * @swagger
 * /mos/settings/docker:
 *   get:
 *     summary: Get Docker settings
 *     description: Retrieve current Docker service configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Docker settings retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DockerSettings'
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
 *         description: Docker settings not found
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
 *   post:
 *     summary: Update Docker settings
 *     description: Update Docker service configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SettingsUpdateRequest'
 *           example:
 *             enabled: true
 *             directory: "/mnt/pool1/docker"
 *             appdata: "/mnt/pool1/appdata"
 *             docker_net:
 *               mode: "ipvlan"
 *               config:
 *                 - subnet: "10.0.0.0/24"
 *                   gateway: "10.0.0.5"
 *             filesystem: "btrfs"
 *             start_wait: "0"
 *             docker_options: "--log-level=info --storage-opt=overlay2.size=10G"
 *             update_check:
 *               enabled: true
 *               update_check_schedule: "0 1 * * *"
 *               auto_update:
 *                 enabled: true
 *                 auto_update_schedule: "0 2 * * SAT"
 *     responses:
 *       200:
 *         description: Docker settings updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DockerSettings'
 *       400:
 *         description: Invalid request body
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

// GET: Read Docker settings
router.get('/settings/docker', async (req, res) => {
  try {
    const settings = await mosService.getDockerSettings();
    res.json(settings);
  } catch (error) {
    if (error.message.includes('nicht gefunden')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// POST: Update Docker settings (single or multiple fields)
router.post('/settings/docker', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object with valid fields.' });
    }
    const updated = await mosService.updateDockerSettings(req.body);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/settings/lxc:
 *   get:
 *     summary: Get LXC settings
 *     description: Retrieve current LXC service configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: LXC settings retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LxcSettings'
 *             example:
 *               enabled: true
 *               directory: "/mnt/pool1/lxc"
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
 *         description: LXC settings not found
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
 *   post:
 *     summary: Update LXC settings
 *     description: Update LXC service configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SettingsUpdateRequest'
 *           example:
 *             enabled: true
 *             directory: "/mnt/pool1/lxc"
 *             lxc_registry: "images.linuxcontainers.org"
 *     responses:
 *       200:
 *         description: LXC settings updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LxcSettings'
 *       400:
 *         description: Invalid request body
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

// GET: Read LXC settings
router.get('/settings/lxc', async (req, res) => {
  try {
    const settings = await mosService.getLxcSettings();
    res.json(settings);
  } catch (error) {
    if (error.message.includes('nicht gefunden')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// POST: Update LXC settings (single or multiple fields)
router.post('/settings/lxc', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object with valid fields.' });
    }
    const updated = await mosService.updateLxcSettings(req.body);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/settings/vm:
 *   get:
 *     summary: Get VM settings
 *     description: Retrieve current VM service configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: VM settings retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/VmSettings'
 *             example:
 *               enabled: true
 *               iommu_active: false
 *               directory: "/mnt/pool1/vm"
 *               vdisk_directory: "/mnt/pool1/vdisk"
 *               start_wait: 30
 *               hugepages:
 *                 enabled: true
 *                 total: 1024
 *                 size_mb: 2
 *                 free: 512
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
 *         description: VM settings not found
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
 *   post:
 *     summary: Update VM settings
 *     description: Update VM service configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SettingsUpdateRequest'
 *           examples:
 *             basic:
 *               summary: Update basic VM settings
 *               value:
 *                 enabled: true
 *                 directory: "/mnt/pool1/vm"
 *                 vdisk_directory: "/mnt/pool1/vdisk"
 *                 start_wait: 45
 *             hugepages:
 *               summary: Enable hugepages with 1024 pages
 *               value:
 *                 hugepages:
 *                   enabled: true
 *                   total: 1024
 *     responses:
 *       200:
 *         description: VM settings updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/VmSettings'
 *       400:
 *         description: Invalid request body
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

// GET: Read VM settings
router.get('/settings/vm', async (req, res) => {
  try {
    const settings = await mosService.getVmSettings();
    res.json(settings);
  } catch (error) {
    if (error.message.includes('nicht gefunden')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// POST: Update VM settings (single or multiple fields)
router.post('/settings/vm', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object with valid fields.' });
    }
    const updated = await mosService.updateVmSettings(req.body);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/system/network/interfaces:
 *   get:
 *     summary: Detect physical network interfaces
 *     description: Scans the system for all physical network interfaces and returns their MAC addresses, link state, and speed. This is a read-only system endpoint (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Physical interfaces detected successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   name:
 *                     type: string
 *                     description: Kernel interface name
 *                     example: "eth0"
 *                   mac:
 *                     type: string
 *                     description: Hardware MAC address
 *                     example: "aa:bb:cc:dd:ee:ff"
 *                   link_state:
 *                     type: string
 *                     description: Link state (up, down, unknown)
 *                     example: "up"
 *                   speed:
 *                     type: integer
 *                     nullable: true
 *                     description: Link speed in Mbps (null if link is down)
 *                     example: 1000
 *                   adapter:
 *                     type: string
 *                     nullable: true
 *                     description: PCI device name (e.g. Intel Corporation I225-V)
 *                     example: "Ethernet controller: Intel Corporation I225-V"
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// GET: Detect physical network interfaces (system status, read-only)
router.get('/system/network/interfaces', async (req, res) => {
  try {
    const interfaces = await mosService.detectPhysicalInterfaces();
    res.json(interfaces);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/settings/network/interfaces/reconcile:
 *   post:
 *     summary: Reconcile network interfaces
 *     description: Matches detected physical interfaces against stored config by MAC address. Updates kernel names, marks orphaned interfaces, and adds new interfaces with DHCP (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Reconciliation completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 interfaces:
 *                   type: array
 *                   items:
 *                     type: object
 *                 changes:
 *                   type: array
 *                   description: List of changes made during reconciliation
 *                   items:
 *                     type: object
 *                     properties:
 *                       type:
 *                         type: string
 *                         enum: [mac_assigned, name_updated, reactivated, orphaned, new_interface]
 *                       name:
 *                         type: string
 *                       mac:
 *                         type: string
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// POST: Reconcile network interfaces
router.post('/settings/network/interfaces/reconcile', async (req, res) => {
  try {
    const result = await mosService.reconcileInterfaces();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/settings/network/interfaces:
 *   get:
 *     summary: Get network interfaces
 *     description: Retrieve current network interfaces configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Network interfaces retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 interfaces:
 *                   type: array
 *                   items:
 *                     type: object
 *                 pending_changes:
 *                   type: boolean
 *                   description: True if network changes are pending confirmation
 *                 remaining_seconds:
 *                   type: integer
 *                   nullable: true
 *                   description: Seconds remaining to confirm changes (null if no pending changes)
 *             example:
 *               interfaces:
 *                 - mac: "aa:bb:cc:dd:ee:ff"
 *                   name: "eth0"
 *                   label: null
 *                   type: "ethernet"
 *                   mode: null
 *                   interfaces: []
 *                   ipv4: [{"dhcp": true}]
 *                   ipv6: []
 *                   vlans: []
 *                   mtu: null
 *                   hw_addr: null
 *                   status: "enabled"
 *                   link_state: "up"
 *                   speed: 1000
 *                   adapter: "Ethernet controller: Intel Corporation I225-V"
 *               pending_changes: false
 *               remaining_seconds: null
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
 *   post:
 *     summary: Update network interfaces
 *     description: Update network interfaces configuration (admin only). Supports ethernet, bridge, bond types with MAC identification, MTU, and MAC spoofing.
 *     tags: [MOS]
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
 *           examples:
 *             ethernet_dhcp:
 *               summary: Ethernet with DHCP
 *               value:
 *                 - mac: "aa:bb:cc:dd:ee:ff"
 *                   name: "eth0"
 *                   label: null
 *                   type: "ethernet"
 *                   mode: null
 *                   interfaces: []
 *                   ipv4: [{"dhcp": true}]
 *                   ipv6: []
 *                   vlans: []
 *                   mtu: null
 *                   hw_addr: null
 *                   status: "enabled"
 *             ethernet_static:
 *               summary: Ethernet with static IP
 *               value:
 *                 - mac: "aa:bb:cc:dd:ee:ff"
 *                   name: "eth0"
 *                   label: "WAN"
 *                   type: "ethernet"
 *                   mode: null
 *                   interfaces: []
 *                   ipv4: [{"dhcp": false, "address": "10.0.0.1/24", "gateway": "10.0.0.5", "dns": ["10.0.0.5"]}]
 *                   ipv6: []
 *                   vlans: []
 *                   mtu: 9000
 *                   hw_addr: null
 *                   status: "enabled"
 *             bridge_setup:
 *               summary: Bridge configuration
 *               value:
 *                 - mac: "aa:bb:cc:dd:ee:ff"
 *                   name: "eth0"
 *                   label: null
 *                   type: "bridged"
 *                   mode: null
 *                   interfaces: []
 *                   ipv4: []
 *                   ipv6: []
 *                   vlans: []
 *                   mtu: null
 *                   hw_addr: null
 *                   status: "enabled"
 *                 - mac: null
 *                   name: "br0"
 *                   label: "LAN Bridge"
 *                   type: "bridge"
 *                   mode: null
 *                   interfaces: ["eth0"]
 *                   ipv4: [{"dhcp": false, "address": "10.0.0.1/24", "gateway": "10.0.0.5", "dns": ["10.0.0.5"]}]
 *                   ipv6: []
 *                   vlans: []
 *                   mtu: null
 *                   hw_addr: null
 *                   status: "enabled"
 *                   vlan_filtering: false
 *                   bridge_vids: []
 *             bridge_vlan_aware:
 *               summary: VLAN-aware bridge - all VLANs
 *               value:
 *                 - mac: "aa:bb:cc:dd:ee:ff"
 *                   name: "eth0"
 *                   label: "Trunk"
 *                   type: "bridged"
 *                   mode: null
 *                   interfaces: []
 *                   ipv4: []
 *                   ipv6: []
 *                   vlans: []
 *                   mtu: null
 *                   hw_addr: null
 *                   status: "enabled"
 *                 - mac: null
 *                   name: "br0"
 *                   label: "LXC Bridge"
 *                   type: "bridge"
 *                   mode: null
 *                   interfaces: ["eth0"]
 *                   ipv4: [{"dhcp": false, "address": "10.0.0.1/24", "gateway": "10.0.0.5", "dns": ["10.0.0.5"]}]
 *                   ipv6: []
 *                   vlans: []
 *                   mtu: null
 *                   hw_addr: null
 *                   status: "enabled"
 *                   vlan_filtering: true
 *                   bridge_vids: []
 *             bridge_vlan_selective:
 *               summary: VLAN-aware bridge - only VID 2 and 10
 *               value:
 *                 - mac: "aa:bb:cc:dd:ee:ff"
 *                   name: "eth0"
 *                   label: "Trunk"
 *                   type: "bridged"
 *                   mode: null
 *                   interfaces: []
 *                   ipv4: []
 *                   ipv6: []
 *                   vlans: []
 *                   mtu: null
 *                   hw_addr: null
 *                   status: "enabled"
 *                 - mac: null
 *                   name: "br0"
 *                   label: "LXC Bridge"
 *                   type: "bridge"
 *                   mode: null
 *                   interfaces: ["eth0"]
 *                   ipv4: [{"dhcp": false, "address": "10.0.0.1/24", "gateway": "10.0.0.5", "dns": ["10.0.0.5"]}]
 *                   ipv6: []
 *                   vlans: []
 *                   mtu: null
 *                   hw_addr: null
 *                   status: "enabled"
 *                   vlan_filtering: true
 *                   bridge_vids: [2, 10]
 *             bond_setup:
 *               summary: Bond configuration (LACP)
 *               value:
 *                 - mac: "aa:bb:cc:dd:ee:ff"
 *                   name: "eth0"
 *                   label: null
 *                   type: "bonded"
 *                   mode: null
 *                   interfaces: []
 *                   ipv4: []
 *                   ipv6: []
 *                   vlans: []
 *                   mtu: null
 *                   hw_addr: null
 *                   status: "enabled"
 *                 - mac: "11:22:33:44:55:66"
 *                   name: "eth1"
 *                   label: null
 *                   type: "bonded"
 *                   mode: null
 *                   interfaces: []
 *                   ipv4: []
 *                   ipv6: []
 *                   vlans: []
 *                   mtu: null
 *                   hw_addr: null
 *                   status: "enabled"
 *                 - mac: null
 *                   name: "bond0"
 *                   label: "LACP Bond"
 *                   type: "bond"
 *                   mode: "802.3ad"
 *                   interfaces: ["eth0", "eth1"]
 *                   ipv4: [{"dhcp": false, "address": "10.0.0.1/24", "gateway": "10.0.0.5", "dns": ["10.0.0.5"]}]
 *                   ipv6: []
 *                   vlans: []
 *                   mtu: null
 *                   hw_addr: null
 *                   status: "enabled"
 *             vlan_setup:
 *               summary: Ethernet with VLANs
 *               value:
 *                 - mac: "aa:bb:cc:dd:ee:ff"
 *                   name: "eth0"
 *                   label: "Trunk"
 *                   type: "ethernet"
 *                   mode: null
 *                   interfaces: []
 *                   ipv4: [{"dhcp": true}]
 *                   ipv6: []
 *                   vlans:
 *                     - vlan_id: 100
 *                       ipv4: [{"dhcp": false, "address": "192.168.100.1/24", "gateway": "192.168.100.254", "dns": ["8.8.8.8"]}]
 *                       ipv6: []
 *                       mtu: 1400
 *                     - vlan_id: 200
 *                       ipv4: [{"dhcp": true}]
 *                       ipv6: []
 *                       mtu: null
 *                   mtu: 9000
 *                   hw_addr: null
 *                   status: "enabled"
 *             mac_spoofing:
 *               summary: MAC spoofing
 *               value:
 *                 - mac: "aa:bb:cc:dd:ee:ff"
 *                   name: "eth0"
 *                   label: null
 *                   type: "ethernet"
 *                   mode: null
 *                   interfaces: []
 *                   ipv4: [{"dhcp": true}]
 *                   ipv6: []
 *                   vlans: []
 *                   mtu: null
 *                   hw_addr: "00:11:22:33:44:55"
 *                   status: "enabled"
 *             disabled_interface:
 *               summary: Disable an interface
 *               value:
 *                 - mac: "aa:bb:cc:dd:ee:ff"
 *                   name: "eth0"
 *                   label: "LAN"
 *                   type: "ethernet"
 *                   mode: null
 *                   interfaces: []
 *                   ipv4: [{"dhcp": true}]
 *                   ipv6: []
 *                   vlans: []
 *                   mtu: null
 *                   hw_addr: null
 *                   status: "enabled"
 *                 - mac: "11:22:33:44:55:66"
 *                   name: "eth1"
 *                   label: "Unused"
 *                   type: "ethernet"
 *                   mode: null
 *                   interfaces: []
 *                   ipv4: [{"dhcp": true}]
 *                   ipv6: []
 *                   vlans: []
 *                   mtu: null
 *                   hw_addr: null
 *                   status: "disabled"
 *     responses:
 *       200:
 *         description: Network interfaces updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *       400:
 *         description: Invalid request body
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

// GET: Read network interfaces
router.get('/settings/network/interfaces', async (req, res) => {
  try {
    const interfaces = await mosService.getNetworkInterfaces();
    res.json(interfaces);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// POST: Update network interfaces
router.post('/settings/network/interfaces', async (req, res) => {
  try {
    if (!Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an array of interfaces.' });
    }
    const updated = await mosService.updateNetworkInterfaces(req.body);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/settings/network/apply:
 *   post:
 *     summary: Confirm pending network changes
 *     description: Confirms pending network changes within the 60-second timeout window. If not called in time, changes are automatically rolled back to the previous configuration. Must be called after any network interface change (update interfaces, add/delete VLAN).
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Network changes confirmed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 confirmed:
 *                   type: boolean
 *             example:
 *               confirmed: true
 *       400:
 *         description: No pending network changes to confirm
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

// POST: Confirm pending network changes
router.post('/settings/network/apply', async (req, res) => {
  try {
    const result = await mosService.confirmNetworkChanges();
    res.json(result);
  } catch (error) {
    if (error.message.includes('No pending')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/settings/network/revert:
 *   post:
 *     summary: Revert pending network changes
 *     description: Immediately reverts pending network changes to the previous configuration and restarts networking. Can be used instead of waiting for the automatic rollback timeout.
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Network changes reverted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 reverted:
 *                   type: boolean
 *             example:
 *               reverted: true
 *       400:
 *         description: No pending network changes to revert
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

// POST: Revert pending network changes
router.post('/settings/network/revert', async (req, res) => {
  try {
    const result = await mosService.revertNetworkChanges();
    res.json(result);
  } catch (error) {
    if (error.message.includes('No pending')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/settings/network/interfaces/{interfaceName}/vlans:
 *   post:
 *     summary: Add VLAN to interface
 *     description: Add a new VLAN to a network interface (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: interfaceName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the interface (e.g., eth0)
 *         example: eth0
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - vlan_id
 *             properties:
 *               vlan_id:
 *                 type: integer
 *                 description: VLAN ID (1-4094)
 *                 example: 100
 *               ipv4:
 *                 type: array
 *                 description: IPv4 configuration
 *                 items:
 *                   type: object
 *                   properties:
 *                     dhcp:
 *                       type: boolean
 *                       example: true
 *                     address:
 *                       type: string
 *                       example: "192.168.100.1"
 *                     netmask:
 *                       type: string
 *                       example: "255.255.255.0"
 *                     gateway:
 *                       type: string
 *                       example: "192.168.100.254"
 *               ipv6:
 *                 type: array
 *                 description: IPv6 configuration
 *                 items:
 *                   type: object
 *                   properties:
 *                     address:
 *                       type: string
 *                       example: "fd00::1"
 *                     prefix:
 *                       type: integer
 *                       example: 64
 *               mtu:
 *                 type: integer
 *                 nullable: true
 *                 description: MTU for this VLAN (null inherits from parent interface, 68-9000)
 *                 example: null
 *           example:
 *             vlan_id: 100
 *             ipv4:
 *               - dhcp: true
 *             ipv6: []
 *             mtu: null
 *     responses:
 *       200:
 *         description: VLAN added successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 vlan_id:
 *                   type: integer
 *                 ipv4:
 *                   type: array
 *                 ipv6:
 *                   type: array
 *                 mtu:
 *                   type: integer
 *                   nullable: true
 *       400:
 *         description: Invalid request
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

// POST: Add VLAN to interface
router.post('/settings/network/interfaces/:interfaceName/vlans', async (req, res) => {
  try {
    const { interfaceName } = req.params;
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be a VLAN configuration object.' });
    }
    const vlan = await mosService.addVlan(interfaceName, req.body);
    res.json(vlan);
  } catch (error) {
    if (error.message.includes('not found') || error.message.includes('already exists')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/settings/network/interfaces/{interfaceName}/vlans/{vlanId}:
 *   delete:
 *     summary: Delete VLAN from interface
 *     description: Delete a VLAN from a network interface (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: interfaceName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the interface (e.g., eth0)
 *         example: eth0
 *       - in: path
 *         name: vlanId
 *         required: true
 *         schema:
 *           type: integer
 *         description: VLAN ID to delete
 *         example: 100
 *     responses:
 *       200:
 *         description: VLAN deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *       400:
 *         description: Invalid request or VLAN not found
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

// DELETE: Delete VLAN from interface
router.delete('/settings/network/interfaces/:interfaceName/vlans/:vlanId', async (req, res) => {
  try {
    const { interfaceName, vlanId } = req.params;
    await mosService.deleteVlan(interfaceName, vlanId);
    res.json({ success: true });
  } catch (error) {
    if (error.message.includes('not found') || error.message.includes('No VLANs')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/settings/network/services:
 *   get:
 *     summary: Get network services
 *     description: Retrieve current network services configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Network services retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *             example:
 *               ssh:
 *                 enabled: true
 *               samba:
 *                 enabled: true
 *               nfs:
 *                 enabled: false
 *               nut:
 *                 enabled: false
 *               tailscale:
 *                 enabled: true
 *                 update_check: false
 *                 tailscaled_params: ""
 *                 online: true
 *               netbird:
 *                 enabled: false
 *                 update_check: false
 *                 netbird_service_params: ""
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
 *   post:
 *     summary: Update network services
 *     description: Update network services configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *           example:
 *             samba:
 *               enabled: true
 *             nfs:
 *               enabled: true
 *             nut:
 *               enabled: false
 *     responses:
 *       200:
 *         description: Network services updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       400:
 *         description: Invalid request body
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

// GET: Read network services
router.get('/settings/network/services', async (req, res) => {
  try {
    const services = await mosService.getNetworkServices();
    res.json(services);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// POST: Update network services
router.post('/settings/network/services', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object with service configurations.' });
    }
    const updated = await mosService.updateNetworkServices(req.body);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/settings/system:
 *   get:
 *     summary: Get system settings
 *     description: Retrieve current system configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: System settings retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SystemSettings'
 *             example:
 *               hostname: "mos-server"
 *               global_spindown: true
 *               timezone: "Europe/Berlin"
 *               display:
 *                 timeout: 30
 *                 powersave: "on"
 *                 powerdown: 60
 *               persist_history: false
 *               webui:
 *                 ports:
 *                   http: 80
 *                 listen_interfaces: ["eth0"]
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
 *         description: System settings not found
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
 *   post:
 *     summary: Update system settings
 *     description: Update system configuration - hostname, global_spindown, notification_sound, webui listen_interfaces and more (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SettingsUpdateRequest'
 *           example:
 *             hostname: "new-mos-server"
 *             global_spindown: false
 *             timezone: "Europe/Berlin"
 *             display:
 *               timeout: 60
 *               powersave: "off"
 *               powerdown: 120
 *             persist_history: true
 *             notification_sound:
 *               startup: true
 *               reboot: false
 *               shutdown: true
 *     responses:
 *       200:
 *         description: System settings updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SystemSettings'
 *       400:
 *         description: Invalid request body
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

// GET: Read system settings
router.get('/settings/system', async (req, res) => {
  try {
    const settings = await mosService.getSystemSettings();
    res.json(settings);
  } catch (error) {
    if (error.message.includes('nicht gefunden')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/settings/system:
 *   post:
 *     summary: Update system settings
 *     description: Update system configuration including hostname, global_spindown, keymap, timezone, NTP, notification sounds, and CPU frequency settings (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               hostname:
 *                 type: string
 *                 description: System hostname
 *                 example: "my-server"
 *               global_spindown:
 *                 type: integer
 *                 description: Global disk spindown time in minutes (0 = disabled)
 *                 example: 30
 *               keymap:
 *                 type: string
 *                 description: Keyboard layout
 *                 example: "de"
 *               timezone:
 *                 type: string
 *                 description: System timezone
 *                 example: "Europe/Berlin"
 *               display:
 *                 type: object
 *                 description: Display settings
 *                 properties:
 *                   timeout:
 *                     type: integer
 *                     description: Display timeout in seconds
 *                     example: 30
 *                   powersave:
 *                     type: string
 *                     description: Display power save mode (on, vsync, powerdown, off)
 *                     example: "on"
 *                   powerdown:
 *                     type: integer
 *                     description: Display power down timeout in seconds
 *                     example: 60
 *               persist_history:
 *                 type: boolean
 *                 description: Persist command history
 *                 example: false
 *               ntp:
 *                 type: object
 *                 description: NTP configuration
 *                 properties:
 *                   enabled:
 *                     type: boolean
 *                     description: Enable NTP service
 *                     example: true
 *                   mode:
 *                     type: string
 *                     enum: [pool, server]
 *                     description: NTP mode
 *                     example: "pool"
 *                   servers:
 *                     type: array
 *                     items:
 *                       type: string
 *                     description: NTP servers
 *                     example: ["pool.ntp.org", "time.google.com"]
 *               notification_sound:
 *                 type: object
 *                 description: Notification sound settings
 *                 properties:
 *                   startup:
 *                     type: boolean
 *                     description: Play sound on startup
 *                     example: true
 *                   reboot:
 *                     type: boolean
 *                     description: Play sound on reboot
 *                     example: true
 *                   shutdown:
 *                     type: boolean
 *                     description: Play sound on shutdown
 *                     example: true
 *               cpufreq:
 *                 type: object
 *                 description: CPU frequency scaling settings
 *                 properties:
 *                   governor:
 *                     type: string
 *                     description: CPU frequency governor
 *                     example: "ondemand"
 *                   max_speed:
 *                     type: integer
 *                     description: Maximum CPU frequency in kHz (0 = system default)
 *                     example: 3000000
 *                   min_speed:
 *                     type: integer
 *                     description: Minimum CPU frequency in kHz (0 = system default)
 *                     example: 800000
 *               swapfile:
 *                 type: object
 *                 description: Swapfile configuration. Path must be on mounted pool under /mnt/. BTRFS RAID pools are not supported.
 *                 properties:
 *                   enabled:
 *                     type: boolean
 *                     description: Enable or disable swapfile
 *                     example: true
 *                   path:
 *                     type: string
 *                     description: Directory path for swapfile (must be on mounted pool under /mnt/)
 *                     example: "/mnt/pool1"
 *                   size:
 *                     type: string
 *                     description: Swapfile size (e.g., "10G", "1024M"). Changing size recreates the swapfile.
 *                     example: "10G"
 *                   priority:
 *                     type: integer
 *                     description: Swap priority (default -2). Changing priority recreates the swapfile.
 *                     example: -2
 *                   config:
 *                     type: object
 *                     description: Zswap configuration (compressed swap cache)
 *                     properties:
 *                       zswap:
 *                         type: boolean
 *                         description: Enable zswap
 *                         example: false
 *                       shrinker:
 *                         type: boolean
 *                         description: Enable zswap shrinker (default true)
 *                         example: true
 *                       max_pool_percent:
 *                         type: integer
 *                         description: Maximum pool size as percentage of RAM (default 20)
 *                         example: 20
 *                       compressor:
 *                         type: string
 *                         description: Compression algorithm (default zstd)
 *                         example: "zstd"
 *                       accept_threshold_percent:
 *                         type: integer
 *                         description: Accept threshold percentage (default 90)
 *                         example: 90
 *               binfmt:
 *                 type: object
 *                 description: binfmt_misc configuration for running foreign architecture binaries via QEMU user-mode emulation
 *                 properties:
 *                   enabled:
 *                     type: boolean
 *                     description: Enable binfmt_misc support
 *                     example: true
 *                   architectures:
 *                     type: array
 *                     items:
 *                       type: string
 *                     description: List of architectures to enable (e.g., aarch64, arm, riscv64). Use GET /vm/binfmt_architectures to see available architectures.
 *                     example: ["aarch64"]
 *               webui:
 *                 type: object
 *                 description: WebUI configuration settings. Changing ports, https_enabled, or listen_interfaces triggers nginx restart. Changing local_dns_searchname triggers certificate recreation and nginx restart.
 *                 properties:
 *                   ports:
 *                     type: object
 *                     description: WebUI port configuration
 *                     properties:
 *                       http:
 *                         type: integer
 *                         description: HTTP port for the WebUI (default 80). Changing this triggers nginx restart.
 *                         example: 80
 *                       https:
 *                         type: integer
 *                         description: HTTPS port for the WebUI (default 443). Changing this triggers nginx restart.
 *                         example: 443
 *                   https_enabled:
 *                     type: boolean
 *                     description: Enable HTTPS for the WebUI (default false). Changing this triggers nginx restart.
 *                     example: false
 *                   local_dns_searchname:
 *                     type: string
 *                     description: Local DNS search name for the WebUI. Changing this triggers certificate recreation and nginx restart.
 *                     example: "myserver.local"
 *                   listen_interfaces:
 *                     type: array
 *                     items:
 *                       type: string
 *                     description: Network interfaces for nginx to listen on (e.g. eth0, br0). Empty array means all interfaces. Changing this triggers nginx restart.
 *                     example: ["eth0", "br0"]
 *               update_check:
 *                 type: object
 *                 description: MOS system update check configuration. Changing enabled or schedule triggers mos-cron_update.
 *                 properties:
 *                   enabled:
 *                     type: boolean
 *                     description: Enable system update checking
 *                     example: true
 *                   update_check_schedule:
 *                     type: string
 *                     description: Cron schedule for update checks
 *                     example: "0 1 * * *"
 *     responses:
 *       200:
 *         description: System settings updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: Updated system settings
 *       400:
 *         description: Invalid request body
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

// POST: Update system settings
router.post('/settings/system', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object with valid fields.' });
    }
    const updated = await mosService.updateSystemSettings(req.body);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/settings/notifications/providers:
 *   get:
 *     summary: Get all notification providers
 *     description: Retrieve all notification provider configurations (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All providers retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties:
 *                 $ref: '#/components/schemas/NotificationProvider'
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
 *   post:
 *     summary: Create a new notification provider
 *     description: Create a new notification provider configuration (admin only). The name "email" is reserved.
 *     tags: [MOS]
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
 *                 example: "discord"
 *               enabled:
 *                 type: boolean
 *               user:
 *                 oneOf:
 *                   - type: boolean
 *                   - type: string
 *               token:
 *                 oneOf:
 *                   - type: boolean
 *                   - type: string
 *               url:
 *                 type: string
 *               method:
 *                 type: string
 *                 enum: [GET, POST, PUT, PATCH, DELETE]
 *               headers:
 *                 type: object
 *               body:
 *                 type: object
 *               alert_mapping:
 *                 type: object
 *               color_prio:
 *                 type: object
 *     responses:
 *       201:
 *         description: Provider created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/NotificationProvider'
 *       400:
 *         description: Invalid request (bad name, reserved name, or invalid fields)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: Provider already exists
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

/**
 * @swagger
 * /mos/settings/notifications/providers/{name}:
 *   get:
 *     summary: Get a single notification provider
 *     description: Retrieve a specific notification provider configuration by name (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Provider name (e.g. "discord", "gotify")
 *     responses:
 *       200:
 *         description: Provider retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/NotificationProvider'
 *       400:
 *         description: Invalid provider name
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Provider not found
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
 *   patch:
 *     summary: Update a notification provider
 *     description: Partially update a notification provider configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Provider name
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               enabled:
 *                 type: boolean
 *               user:
 *                 oneOf:
 *                   - type: boolean
 *                   - type: string
 *               token:
 *                 oneOf:
 *                   - type: boolean
 *                   - type: string
 *               url:
 *                 type: string
 *               method:
 *                 type: string
 *                 enum: [GET, POST, PUT, PATCH, DELETE]
 *               headers:
 *                 type: object
 *               body:
 *                 type: object
 *               alert_mapping:
 *                 type: object
 *               color_prio:
 *                 type: object
 *     responses:
 *       200:
 *         description: Provider updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/NotificationProvider'
 *       400:
 *         description: Invalid request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Provider not found
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
 *   delete:
 *     summary: Delete a notification provider
 *     description: Delete a notification provider configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Provider name
 *     responses:
 *       200:
 *         description: Provider deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid provider name
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Provider not found
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

// GET: List all notification providers
router.get('/settings/notifications/providers', async (req, res) => {
  try {
    const providers = await mosService.getNotificationProviders();
    res.json(providers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET: Get single notification provider
router.get('/settings/notifications/providers/:name', async (req, res) => {
  try {
    const provider = await mosService.getNotificationProvider(req.params.name);
    res.json(provider);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else if (error.message.includes('reserved') || error.message.includes('may only contain')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// POST: Create new notification provider
router.post('/settings/notifications/providers', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be a valid object.' });
    }
    const { name, ...config } = req.body;
    const created = await mosService.createNotificationProvider(name, config);
    res.status(201).json(created);
  } catch (error) {
    if (error.message.includes('already exists')) {
      res.status(409).json({ error: error.message });
    } else if (error.message.includes('reserved') || error.message.includes('may only contain') || error.message.includes('required') || error.message.includes('must be')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// PATCH: Update notification provider
router.patch('/settings/notifications/providers/:name', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be a valid object.' });
    }
    const updated = await mosService.updateNotificationProvider(req.params.name, req.body);
    res.json(updated);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else if (error.message.includes('reserved') || error.message.includes('may only contain') || error.message.includes('must be')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// DELETE: Delete notification provider
router.delete('/settings/notifications/providers/:name', async (req, res) => {
  try {
    const result = await mosService.deleteNotificationProvider(req.params.name);
    res.json(result);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else if (error.message.includes('reserved') || error.message.includes('may only contain')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/settings/notifications/email:
 *   get:
 *     summary: Get email notification provider config
 *     description: Retrieve the email notification provider configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Email config retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                 smtp_host:
 *                   type: string
 *                 smtp_port:
 *                   type: integer
 *                 smtp_tls:
 *                   type: boolean
 *                 smtp_user:
 *                   type: string
 *                 smtp_password:
 *                   type: string
 *                 from:
 *                   type: string
 *                 to:
 *                   type: array
 *                   items:
 *                     type: string
 *                 subject:
 *                   type: string
 *                 body:
 *                   type: string
 *                 alert_mapping:
 *                   type: object
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
 *   post:
 *     summary: Update email notification provider config
 *     description: Create or update the email notification provider configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               enabled:
 *                 type: boolean
 *               smtp_host:
 *                 type: string
 *                 example: "smtp.gmail.com"
 *               smtp_port:
 *                 type: integer
 *                 example: 587
 *               smtp_tls:
 *                 type: boolean
 *                 example: true
 *               smtp_user:
 *                 type: string
 *               smtp_password:
 *                 type: string
 *               from:
 *                 type: string
 *                 example: "server@example.com"
 *               to:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["admin@example.com"]
 *               subject:
 *                 type: string
 *                 example: "{{.Title}}"
 *               body:
 *                 type: string
 *                 example: "{{.Message}}"
 *               alert_mapping:
 *                 type: object
 *     responses:
 *       200:
 *         description: Email config updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       400:
 *         description: Invalid request (validation error)
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

// GET: Read email provider config
router.get('/settings/notifications/email', async (req, res) => {
  try {
    const config = await mosService.getEmailProvider();
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST: Update email provider config
router.post('/settings/notifications/email', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be a valid object.' });
    }
    const updated = await mosService.updateEmailProvider(req.body);
    res.json(updated);
  } catch (error) {
    if (error.message.includes('required') || error.message.includes('must be') || error.message.includes('Invalid')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/update_api:
 *   post:
 *     summary: Update the API service
 *     description: Update the API service immediately - useful after API updates (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *     responses:
 *       200:
 *         description: API update initiated successfully
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
 *                   example: "API update initiated"
 *                 service:
 *                   type: string
 *                   example: "api"
 *                 timestamp:
 *                   type: string
 *                   example: "2024-01-15T10:30:00.000Z"
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

// POST: Update the API service
router.post('/update_api', async (req, res) => {
  try {
    // Send response immediately
    res.json({
      success: true,
      message: "API update initiated",
      service: "api",
      timestamp: new Date().toISOString()
    });

    // Update the API service immediately (runs in detached process)
    setImmediate(async () => {
      try {
        await mosService.updateApi();
      } catch (error) {
        console.error('API update error:', error.message);
      }
    });

  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/update_ui:
 *   post:
 *     summary: Update the UI service (nginx)
 *     description: Update the UI service (nginx) immediately (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *     responses:
 *       200:
 *         description: UI update initiated successfully
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
 *                   example: "UI update initiated"
 *                 service:
 *                   type: string
 *                   example: "nginx"
 *                 timestamp:
 *                   type: string
 *                   example: "2024-01-15T10:30:00.000Z"
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

// POST: Update the UI service (nginx)
router.post('/update_ui', async (req, res) => {
  try {
    // Send response immediately
    res.json({
      success: true,
      message: "UI update initiated",
      service: "nginx",
      timestamp: new Date().toISOString()
    });

    // Update the UI service (nginx) immediately (runs in detached process)
    setImmediate(async () => {
      try {
        await mosService.updateNginx();
      } catch (error) {
        console.error('nginx update error:', error.message);
      }
    });

  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/recreatecerts:
 *   post:
 *     summary: Recreate SSL certificates
 *     description: Recreates SSL certificates via nginx recreatecerts and restarts nginx (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *     responses:
 *       200:
 *         description: Certificate recreation result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 recreatecerts:
 *                   type: string
 *                   description: Status of the recreatecerts command
 *                   example: "success"
 *                 nginx_restart:
 *                   type: string
 *                   description: Status of the nginx restart
 *                   example: "success"
 *                 timestamp:
 *                   type: string
 *                   example: "2024-01-15T10:30:00.000Z"
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

// POST: Recreate SSL certificates and restart nginx
router.post('/recreatecerts', async (req, res) => {
  try {
    const result = await mosService.recreateCerts();
    res.json({
      success: true,
      ...result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/certificates:
 *   get:
 *     summary: Get SSL certificate information
 *     description: Returns validity, subject, issuer, fingerprint and expiry information for the nginx and root CA certificates (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Certificate information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 nginx:
 *                   type: object
 *                   description: Nginx server certificate info
 *                   properties:
 *                     subject:
 *                       type: string
 *                       example: "CN = MOS"
 *                     issuer:
 *                       type: string
 *                       example: "CN = MOS Root CA"
 *                     not_before:
 *                       type: string
 *                       example: "Jan 15 10:30:00 2024 GMT"
 *                     not_after:
 *                       type: string
 *                       example: "Jan 15 10:30:00 2025 GMT"
 *                     serial:
 *                       type: string
 *                       example: "1000"
 *                     fingerprint_sha256:
 *                       type: string
 *                       example: "AA:BB:CC:..."
 *                     days_remaining:
 *                       type: integer
 *                       description: Days until certificate expires
 *                       example: 365
 *                     expired:
 *                       type: boolean
 *                       example: false
 *                     file:
 *                       type: string
 *                       example: "/boot/config/system/ssl/nginx.crt"
 *                 root_ca:
 *                   type: object
 *                   description: Root CA certificate info
 *                   properties:
 *                     subject:
 *                       type: string
 *                     issuer:
 *                       type: string
 *                     not_before:
 *                       type: string
 *                     not_after:
 *                       type: string
 *                     serial:
 *                       type: string
 *                     fingerprint_sha256:
 *                       type: string
 *                     days_remaining:
 *                       type: integer
 *                     expired:
 *                       type: boolean
 *                     file:
 *                       type: string
 *                       example: "/boot/config/system/ssl/root/ca.crt"
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

// GET: Certificate information
router.get('/certificates', async (req, res) => {
  try {
    const info = await mosService.getCertificatesInfo();
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/services:
 *   get:
 *     summary: Get all service status
 *     description: Retrieve current status of all MOS services including Docker, LXC, VM and network services in flat structure (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Service status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 docker:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: Docker service enabled in config
 *                       example: true
 *                     running:
 *                       type: boolean
 *                       description: Docker daemon is actually running (socket responding)
 *                       example: true
 *                 lxc:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: LXC service status
 *                       example: false
 *                 vm:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: VM service enabled in config
 *                       example: true
 *                     running:
 *                       type: boolean
 *                       description: libvirt daemon is actually running (PID check)
 *                       example: true
 *                 ssh:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: SSH service status
 *                       example: true
 *                 samba:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: Samba service status
 *                       example: true
 *                     workgroup:
 *                       type: string
 *                       description: Samba workgroup name
 *                       example: "WORKGROUP"
 *                     localmaster:
 *                       type: boolean
 *                       description: Samba local master browser status
 *                       example: false
 *                 samba_discovery:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: Samba discovery service (WSD) status
 *                       example: false
 *                 nfs:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: NFS service status
 *                       example: false
 *                 nut:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: Network UPS Tools service status
 *                       example: true
 *                 iscsi_target:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: iSCSI Target service status
 *                       example: true
 *                 iscsi_initiator:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: iSCSI Initiator service status
 *                       example: false
 *                 tailscale:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: Tailscale VPN service status
 *                       example: false
  *                 netbird:
  *                   type: object
  *                   properties:
  *                     enabled:
  *                       type: boolean
  *                       description: NetBird VPN service status
  *                       example: false
  *                 llm:
  *                   type: object
  *                   properties:
  *                     enabled:
  *                       type: boolean
  *                       description: LLM container is connected (heartbeat active)
  *                       example: true
  *                 mos:
 *                   type: object
 *                   properties:
 *                     supporter:
 *                       type: boolean
 *                       description: Whether a valid supporter key is configured
 *                       example: false
 *               additionalProperties:
 *                 type: object
 *                 properties:
 *                   enabled:
 *                     type: boolean
 *                 description: Additional network services (dynamically populated)
 *             example:
 *               docker:
 *                 enabled: true
 *                 running: true
 *               lxc:
 *                 enabled: false
 *               vm:
 *                 enabled: true
 *                 running: true
 *               ssh:
 *                 enabled: true
 *               samba:
 *                 enabled: true
 *               samba_discovery:
 *                 enabled: false
 *               nfs:
 *                 enabled: false
 *               nut:
 *                 enabled: true
 *               iscsi_target:
 *                 enabled: true
 *               iscsi_initiator:
 *                 enabled: false
 *               tailscale:
 *                 enabled: false
  *               netbird:
  *                 enabled: false
  *               llm:
  *                 enabled: true
  *               mos:
 *                 supporter: false
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
 *
 * @swagger
 * /mos/restart/service:
 *   post:
 *     summary: Restart generic service
 *     description: Restart generic service immediately - supports 'api' and 'nginx' (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - service
 *             properties:
 *               service:
 *                 type: string
 *                 enum: [api, nginx]
 *                 description: Service to restart
 *                 example: "api"
 *           example:
 *             service: "api"
 *     responses:
 *       200:
 *         description: Service restart scheduled successfully
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
 *                   example: "api restart initiated"
 *                 service:
 *                   type: string
 *                   example: "api"
 *                 timestamp:
 *                   type: string
 *                   example: "2024-01-15T10:30:00.000Z"
 *       400:
 *         description: Invalid request body or service name
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

// GET: Get all service status
router.get('/services', async (req, res) => {
  try {
    const serviceStatus = await mosService.getAllServiceStatus();
    res.json(serviceStatus);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST: Generic service restart
router.post('/restart/service', async (req, res) => {
  try {
    const { service } = req.body;

    if (!service) {
      return res.status(400).json({ error: 'service parameter is required' });
    }

    const result = await mosService.restartService(service);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/updateos:
 *   post:
 *     summary: Update MOS
 *     description: Initiate OS update using mos-os_update script (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - version
 *               - channel
 *             properties:
 *               version:
 *                 type: string
 *                 description: Version to update to - either "latest" or version number (e.g., 0.0.0, 1.223.1)
 *                 example: "latest"
 *               channel:
 *                 type: string
 *                 enum: [alpha, beta, stable]
 *                 description: Update channel
 *                 example: "stable"
 *               update_kernel:
 *                 type: boolean
 *                 description: Whether to update kernel (default true, omit from script if false)
 *                 example: true
 *               update_plugins:
 *                 type: boolean
 *                 description: Update all plugins before OS update (checks for updates, updates if available, sends notifications)
 *                 example: true
 *           example:
 *             version: "latest"
 *             channel: "stable"
 *             update_kernel: true
 *             update_plugins: true
 *     responses:
 *       200:
 *         description: OS update initiated successfully
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
 *                   example: "OS update initiated successfully"
 *                 version:
 *                   type: string
 *                   example: "latest"
 *                 channel:
 *                   type: string
 *                   example: "stable"
 *                 updateKernel:
 *                   type: boolean
 *                   example: true
 *                 command:
 *                   type: string
 *                   example: "/usr/local/bin/mos-os_update latest stable update_kernel"
 *                 output:
 *                   type: string
 *                   example: "Update process started..."
 *                 error:
 *                   type: string
 *                   nullable: true
 *                   example: null
 *                 timestamp:
 *                   type: string
 *                   example: "2024-01-15T10:30:00.000Z"
 *       400:
 *         description: Invalid request parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Version must be 'latest' or a version number (e.g., 0.0.0, 1.223.1)"
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

// POST: OS Update
router.post('/updateos', async (req, res) => {
  try {
    const { version, channel, update_kernel, update_plugins } = req.body;

    if (!version) {
      return res.status(400).json({
        success: false,
        error: 'version parameter is required'
      });
    }

    if (!channel) {
      return res.status(400).json({
        success: false,
        error: 'channel parameter is required'
      });
    }

    // update_kernel is optional and defaults to true
    const updateKernel = update_kernel !== false;

    const result = await mosService.updateOS(version, channel, updateKernel);

    // Update plugins in background (after OS update has completed)
    if (update_plugins) {
      (async () => {
        try {
          const versions = await pluginsService.checkUpdates();
          const updatable = versions.filter(v => v.update_available);
          if (updatable.length > 0) {
            await pluginsService.updatePlugins();
          } else {
            await pluginsService.sendNotification('Plugin', 'All Plugins up-to-date', 'normal');
          }
        } catch {
          // Plugin update errors should not block response
        }
      })();
    }

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * @swagger
 * /mos/rollbackos:
 *   post:
 *     summary: Rollback MOS
 *     description: Initiate OS rollback using mos-os_update rollback_mos script (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               kernel_rollback:
 *                 type: boolean
 *                 description: Whether to rollback kernel (default true, adds 'not_kernel' argument if false)
 *                 example: true
 *           example:
 *             kernel_rollback: true
 *     responses:
 *       200:
 *         description: OS rollback initiated successfully
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
 *                   example: "OS rollback initiated successfully"
 *                 kernelRollback:
 *                   type: boolean
 *                   example: true
 *                 command:
 *                   type: string
 *                   example: "/usr/local/bin/mos-os_update rollback_mos"
 *                 output:
 *                   type: string
 *                   example: "Rollback process started..."
 *                 error:
 *                   type: string
 *                   nullable: true
 *                   example: null
 *                 timestamp:
 *                   type: string
 *                   example: "2024-01-15T10:30:00.000Z"
 *       400:
 *         description: Invalid request or rollback failed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Rollback failed: No previous version available"
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

// POST: OS Rollback
router.post('/rollbackos', async (req, res) => {
  try {
    const { kernel_rollback } = req.body || {};

    // kernel_rollback is optional and defaults to true
    // only if explicitly set to false, "not_kernel" is passed to the script
    const kernelRollback = kernel_rollback !== false;

    const result = await mosService.rollbackOS(kernelRollback);

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * @swagger
 * /mos/getreleases:
 *   get:
 *     summary: Get available MOS releases
 *     description: Retrieve available releases grouped by channel (alpha, beta, stable) using mos-os_get_releases script (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Releases grouped by channel
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 alpha:
 *                   type: array
 *                   description: Alpha releases
 *                   items:
 *                     type: object
 *                     properties:
 *                       tag_name:
 *                         type: string
 *                         example: "0.0.1-alpha.2"
 *                       html_url:
 *                         type: string
 *                         example: "https://github.com/mos-nas/mos-releases/releases/tag/0.0.1-alpha.2"
 *                 beta:
 *                   type: array
 *                   description: Beta releases
 *                   items:
 *                     type: object
 *                     properties:
 *                       tag_name:
 *                         type: string
 *                         example: "0.0.1-beta.1"
 *                       html_url:
 *                         type: string
 *                         example: "https://github.com/mos-nas/mos-releases/releases/tag/0.0.1-beta.1"
 *                 stable:
 *                   type: array
 *                   description: Stable releases
 *                   items:
 *                     type: object
 *                     properties:
 *                       tag_name:
 *                         type: string
 *                         example: "1.0.0"
 *                       html_url:
 *                         type: string
 *                         example: "https://github.com/mos-nas/mos-releases/releases/tag/1.0.0"
 *               example:
 *                 alpha:
 *                   - tag_name: "0.0.1-alpha.2"
 *                     html_url: "https://github.com/mos-nas/mos-releases/releases/tag/0.0.1-alpha.2"
 *                   - tag_name: "0.0.1-alpha.1"
 *                     html_url: "https://github.com/mos-nas/mos-releases/releases/tag/0.0.1-alpha.1"
 *                 beta: []
 *                 stable: []
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
 *         description: Server error or script execution failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// GET: Available Releases
router.get('/getreleases', async (req, res) => {
  try {
    const releases = await mosService.getReleases();
    res.json(releases);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/osinfo:
 *   get:
 *     summary: Get current MOS and CPU information
 *     description: Retrieve current OS release information from /etc/mos-release.json combined with CPU details and hostname (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current OS and CPU information
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: OS information object including release info, hostname and CPU details
 *               properties:
 *                 hostname:
 *                   type: string
 *                   nullable: true
 *                   description: System hostname from /boot/config/system.json
 *                   example: "mos-server"
 *                 cpu:
 *                   type: object
 *                   properties:
 *                     manufacturer:
 *                       type: string
 *                       description: CPU manufacturer
 *                       example: "Intel"
 *                     brand:
 *                       type: string
 *                       description: CPU brand/model
 *                       example: "Intel(R) Core(TM) i7-12700K"
 *                     cores:
 *                       type: integer
 *                       description: Total number of CPU cores
 *                       example: 12
 *                     physicalCores:
 *                       type: integer
 *                       description: Number of physical CPU cores
 *                       example: 8
 *                 uptime:
 *                   type: object
 *                   description: System uptime information
 *                   properties:
 *                     pretty:
 *                       type: string
 *                       nullable: true
 *                       description: Human-readable uptime (without "up" prefix and leading spaces)
 *                       example: "2 hours, 34 minutes"
 *                     since:
 *                       type: string
 *                       nullable: true
 *                       description: System boot timestamp
 *                       example: "2025-10-26 10:30:00"
 *                 mos:
 *                   type: object
 *                   description: MOS release information
 *                   properties:
 *                     version:
 *                       type: string
 *                       description: Constructed MOS version (version + channel from release file)
 *                       example: "0.0.1-alpha.4"
 *                     channel:
 *                       type: string
 *                       description: Cleaned release channel (without suffixes like .4)
 *                       example: "alpha"
 *                     running_kernel:
 *                       type: string
 *                       description: Currently running kernel version
 *                       example: "5.15.0-generic"
 *                     arch:
 *                       type: string
 *                       description: System architecture (e.g. x86_64, aarch64)
 *                       example: "x86_64"
 *                 build_date:
 *                   type: string
 *                   description: Build date
 *                   example: "2025-08-24"
 *               example:
 *                 hostname: "mos-server"
 *                 cpu:
 *                   manufacturer: "Intel"
 *                   brand: "Intel(R) Core(TM) i7-12700K"
 *                   cores: 12
 *                   physicalCores: 8
 *                 uptime:
 *                   pretty: "2 hours, 34 minutes"
 *                   since: "2025-10-26 10:30:00"
 *                 mos:
 *                   version: "0.0.1-alpha.4"
 *                   channel: "alpha"
 *                   running_kernel: "5.15.0-generic"
 *                   arch: "x86_64"
 *                 build_date: "2025-08-24"
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
 *         description: Server error or file read failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// GET: Current OS Information (including CPU details)
router.get('/osinfo', async (req, res) => {
  try {
    const osInfo = await mosService.getCurrentRelease();
    res.json(osInfo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/getkernel:
 *   get:
 *     summary: Get available kernel releases
 *     description: Retrieve available kernel releases sorted by version (newest first) using mos-kernel_getreleases script (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Sorted array of kernel releases (newest first)
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               description: Array of kernel releases sorted by version (newest first)
 *               items:
 *                 type: object
 *                 properties:
 *                   tag_name:
 *                     type: string
 *                     description: Kernel version tag
 *                     example: "6.17.1-mos"
 *                   html_url:
 *                     type: string
 *                     description: URL to the kernel release
 *                     example: "https://github.com/mos-nas/kernel-releases/releases/tag/6.17.1-mos"
 *               example:
 *                 - tag_name: "6.17.1-mos"
 *                   html_url: "https://github.com/mos-nas/kernel-releases/releases/tag/6.17.1-mos"
 *                 - tag_name: "6.17.0-mos"
 *                   html_url: "https://github.com/mos-nas/kernel-releases/releases/tag/6.17.0-mos"
 *                 - tag_name: "6.1.0"
 *                   html_url: "https://github.com/mos-nas/kernel-releases/releases/tag/6.1.0"
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
 *         description: Server error or script execution failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// GET: Available Kernel Releases
router.get('/getkernel', async (req, res) => {
  try {
    const releases = await mosService.getKernelReleases();
    res.json(releases);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/getdrivers:
 *   get:
 *     summary: Get available driver releases
 *     description: Retrieve available driver releases grouped by category using mos-drivers_get_releases script (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: kernelVersion
 *         schema:
 *           type: string
 *         required: false
 *         description: Optional kernel version/uname. If not provided, uses current system kernel (uname -r)
 *         example: "6.17.1-mos"
 *       - in: query
 *         name: excludeinstalled
 *         schema:
 *           type: boolean
 *         required: false
 *         description: Optional. If true, filters out already installed drivers. If not provided, returns all available drivers
 *         example: true
 *     responses:
 *       200:
 *         description: Driver releases grouped by category
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: Driver releases grouped by category (e.g., dvb, coral), with driver names as keys and version arrays as values
 *               additionalProperties:
 *                 type: object
 *                 additionalProperties:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Array of available versions for this driver
 *               example:
 *                 dvb:
 *                   dvb-digital-devices: ["20250910-1", "20250911-1"]
 *                   dvb-libreelec: ["1231-1"]
 *                 coral:
 *                   coral: ["20240425-1"]
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
 *         description: Server error or script execution failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// GET: Available Driver Releases
router.get('/getdrivers', async (req, res) => {
  try {
    const { kernelVersion, excludeinstalled } = req.query;
    const excludeInstalledBool = excludeinstalled === 'true' || excludeinstalled === true;
    const releases = await mosService.getDriverReleases(kernelVersion, excludeInstalledBool);
    res.json(releases);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/installeddrivers:
 *   get:
 *     summary: Get installed drivers
 *     description: Retrieve installed drivers from /boot/optional/drivers/ for the current running kernel grouped by category (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Installed drivers grouped by category
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: Installed drivers grouped by category (e.g., dvb, coral), with driver names as keys and version arrays as values
 *               additionalProperties:
 *                 type: object
 *                 additionalProperties:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Array of installed versions for this driver
 *               example:
 *                 dvb:
 *                   dvb-digital-devices: ["20250910-1"]
 *                 coral:
 *                   coral: ["20240425-1"]
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

// GET: Installed Drivers
router.get('/installeddrivers', async (req, res) => {
  try {
    const installedDrivers = await mosService.getInstalledDrivers();
    res.json(installedDrivers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/drivers:
 *   post:
 *     summary: Download or upgrade drivers
 *     description: Download a specific driver (using complete packagename OR drivername+driverversion) or check for driver updates using mos-driver_download script (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             oneOf:
 *               - required:
 *                   - packagename
 *                 properties:
 *                   packagename:
 *                     type: string
 *                     description: Complete driver package filename (e.g., dvb-digital-devices_20250910-1+mos_amd64.deb)
 *                     example: "dvb-digital-devices_20250910-1+mos_amd64.deb"
 *                   kernelVersion:
 *                     type: string
 *                     description: Optional desired kernel version/uname for the driver
 *                     example: "6.17.1-mos"
 *               - required:
 *                   - drivername
 *                   - driverversion
 *                 properties:
 *                   drivername:
 *                     type: string
 *                     description: Driver name only (e.g., dvb-digital-devices)
 *                     example: "dvb-digital-devices"
 *                   driverversion:
 *                     type: string
 *                     description: Driver version only (e.g., 20250910-1)
 *                     example: "20250910-1"
 *                   kernelVersion:
 *                     type: string
 *                     description: Optional desired kernel version/uname for the driver
 *                     example: "6.17.1-mos"
 *               - required:
 *                   - upgrade
 *                 properties:
 *                   upgrade:
 *                     type: boolean
 *                     description: Set to true to check for driver updates
 *                     example: true
 *           examples:
 *             downloadWithPackageName:
 *               summary: Download using complete package filename
 *               value:
 *                 packagename: "dvb-digital-devices_20250910-1+mos_amd64.deb"
 *                 kernelVersion: "6.17.1-mos"
 *             downloadWithNameAndVersion:
 *               summary: Download using driver name and version separately
 *               value:
 *                 drivername: "dvb-digital-devices"
 *                 driverversion: "20250910-1"
 *             downloadOnlyNameAndVersion:
 *               summary: Download using name and version without kernel version
 *               value:
 *                 drivername: "dvb-digital-devices"
 *                 driverversion: "20250910-1"
 *             upgradeDrivers:
 *               summary: Check for driver updates
 *               value:
 *                 upgrade: true
 *     responses:
 *       200:
 *         description: Driver download/upgrade initiated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   description: Operation success status
 *                   example: true
 *                 message:
 *                   type: string
 *                   description: Success message
 *                   example: "Driver download initiated successfully"
 *                 upgrade:
 *                   type: boolean
 *                   description: Whether this was an upgrade check
 *                   example: false
 *                 packagename:
 *                   type: string
 *                   nullable: true
 *                   description: Complete driver package filename (if provided or built)
 *                   example: "dvb-digital-devices_20250910-1+mos_amd64.deb"
 *                 drivername:
 *                   type: string
 *                   nullable: true
 *                   description: Driver name (if provided separately)
 *                   example: "dvb-digital-devices"
 *                 driverversion:
 *                   type: string
 *                   nullable: true
 *                   description: Driver version (if provided separately)
 *                   example: "20250910-1"
 *                 kernelVersion:
 *                   type: string
 *                   nullable: true
 *                   description: Kernel version
 *                   example: "6.17.1-mos"
 *                 command:
 *                   type: string
 *                   description: The executed command
 *                   example: "/usr/local/bin/mos-driver_download \"dvb-digital-devices_20250910-1+mos_amd64.deb\" \"6.17.1-mos\""
 *                 output:
 *                   type: string
 *                   description: Command stdout output
 *                 error:
 *                   type: string
 *                   nullable: true
 *                   description: Command stderr output if any
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   description: Operation timestamp
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
 *         description: Server error or script execution failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// POST: Download or Upgrade Driver
router.post('/drivers', async (req, res) => {
  try {
    const result = await mosService.downloadDriver(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/drivers:
 *   delete:
 *     summary: Delete a driver
 *     description: Delete a specific driver package from /boot/optional/drivers/ (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             oneOf:
 *               - required:
 *                   - packagename
 *                 properties:
 *                   packagename:
 *                     type: string
 *                     description: Complete driver package filename (e.g., dvb-digital-devices_20250910-1+mos_amd64.deb)
 *                     example: "dvb-digital-devices_20250910-1+mos_amd64.deb"
 *               - required:
 *                   - drivername
 *                   - driverversion
 *                 properties:
 *                   drivername:
 *                     type: string
 *                     description: Driver name only (e.g., dvb-digital-devices)
 *                     example: "dvb-digital-devices"
 *                   driverversion:
 *                     type: string
 *                     description: Driver version only (e.g., 20250910-1)
 *                     example: "20250910-1"
 *           examples:
 *             deleteWithPackageName:
 *               summary: Delete using complete package filename
 *               value:
 *                 packagename: "dvb-digital-devices_20250910-1+mos_amd64.deb"
 *             deleteWithNameAndVersion:
 *               summary: Delete using driver name and version separately
 *               value:
 *                 drivername: "dvb-digital-devices"
 *                 driverversion: "20250910-1"
 *     responses:
 *       200:
 *         description: Driver deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   description: Operation success status
 *                   example: true
 *                 message:
 *                   type: string
 *                   description: Success message
 *                   example: "Driver deleted successfully"
 *                 packagename:
 *                   type: string
 *                   description: Complete driver package filename
 *                   example: "dvb-digital-devices_20250910-1+mos_amd64.deb"
 *                 drivername:
 *                   type: string
 *                   nullable: true
 *                   description: Driver name (if provided separately)
 *                   example: "dvb-digital-devices"
 *                 driverversion:
 *                   type: string
 *                   nullable: true
 *                   description: Driver version (if provided separately)
 *                   example: "20250910-1"
 *                 category:
 *                   type: string
 *                   description: Driver category
 *                   example: "dvb"
 *                 kernelVersion:
 *                   type: string
 *                   description: Kernel version
 *                   example: "6.17.1-mos"
 *                 path:
 *                   type: string
 *                   description: Path to the deleted driver
 *                   example: "/boot/optional/drivers/dvb/6.17.1-mos/dvb-digital-devices_20250910-1+mos_amd64.deb"
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   description: Operation timestamp
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
 *       404:
 *         description: Driver package not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error or deletion failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// DELETE: Delete Driver
router.delete('/drivers', async (req, res) => {
  try {
    const result = await mosService.deleteDriver(req.body);
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/updatekernel:
 *   post:
 *     summary: Update kernel
 *     description: Initiate kernel update using mos-kernel_update script (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - version
 *             properties:
 *               version:
 *                 type: string
 *                 description: Version to update to - either "recommended" or version number (e.g., 6.1.0, 6.17.1-mos)
 *                 example: "recommended"
 *           example:
 *             version: "recommended"
 *     responses:
 *       200:
 *         description: Kernel update initiated successfully
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
 *                   example: "Kernel update initiated successfully"
 *                 version:
 *                   type: string
 *                   example: "recommended"
 *                 command:
 *                   type: string
 *                   example: "/usr/local/bin/mos-kernel_update recommended"
 *                 output:
 *                   type: string
 *                   example: "Kernel update process started..."
 *                 error:
 *                   type: string
 *                   nullable: true
 *                   example: null
 *                 timestamp:
 *                   type: string
 *                   example: "2024-01-15T10:30:00.000Z"
 *       400:
 *         description: Invalid request parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Version must be 'recommended' or a version number (e.g., 6.1.0, 6.17.1-mos)"
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

// POST: Kernel Update
router.post('/updatekernel', async (req, res) => {
  try {
    const { version } = req.body;

    if (!version) {
      return res.status(400).json({
        success: false,
        error: 'version parameter is required'
      });
    }

    const result = await mosService.updateKernel(version);

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * @swagger
 * /mos/rollbackkernel:
 *   post:
 *     summary: Rollback kernel
 *     description: Initiate kernel rollback using mos-kernel_update rollback script (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Kernel rollback initiated successfully
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
 *                   example: "Kernel rollback initiated successfully"
 *                 command:
 *                   type: string
 *                   example: "/usr/local/bin/mos-kernel_update rollback"
 *                 output:
 *                   type: string
 *                   example: "Kernel rollback process started..."
 *                 error:
 *                   type: string
 *                   nullable: true
 *                   example: null
 *                 timestamp:
 *                   type: string
 *                   example: "2024-01-15T10:30:00.000Z"
 *       400:
 *         description: Invalid request or rollback failed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Kernel rollback failed: No previous kernel available"
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

// POST: Kernel Rollback
router.post('/rollbackkernel', async (req, res) => {
  try {
    const result = await mosService.rollbackKernel();

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * @swagger
 * /mos/bootbackupfiles:
 *   get:
 *     summary: Get boot backup files
 *     description: Retrieve array of .tar and .tar.gz backup files from the boot backup destination (admin only). Returns empty array if backup plugin not installed or no backup path configured
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Boot backup files retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: string
 *                 description: Full file path to backup archive
 *                 example: "/mnt/cache/backup/boot/backup-2024-01-15.tar.gz"
 *         example:
 *           - "/mnt/cache/backup/boot/backup-2026-05-24_05-00-01.tar"
 *           - "/mnt/cache/backup/boot/backup-2026-05-31_05-00-09.tar"
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

// GET: Get boot backup files
router.get('/bootbackupfiles', async (req, res) => {
  try {
    const files = await mosService.getBootBackupFiles();
    res.json(files);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/installtodisk:
 *   post:
 *     summary: Install MOS to disk
 *     description: Install MOS to a specified disk with the specified filesystem using mos-install script (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - disk
 *               - filesystem
 *             properties:
 *               disk:
 *                 type: string
 *                 description: Disk device path (e.g., /dev/sda, /dev/nvme0n1)
 *                 example: "/dev/sda"
 *               filesystem:
 *                 type: string
 *                 enum: [vfat, ext4, btrfs, xfs]
 *                 description: Filesystem type for the installation
 *                 example: "ext4"
 *               extra_partition:
 *                 type: boolean
 *                 description: Whether to create an extra partition
 *                 default: false
 *                 example: false
 *               tar_file:
 *                 type: string
 *                 description: Optional path to tar backup file for restoration
 *                 default: ""
 *                 example: "/mnt/cache/backup/boot/backup-2026-05-31_05-00-09.tar"
 *           example:
 *             disk: "/dev/sda"
 *             filesystem: "ext4"
 *             extra_partition: false
 *             tar_file: "/mnt/cache/backup/boot/backup-2026-05-31_05-00-09.tar"
 *     responses:
 *       200:
 *         description: MOS installation to disk initiated successfully
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
 *                   example: "MOS installation to disk initiated successfully"
 *                 disk:
 *                   type: string
 *                   example: "/dev/sda"
 *                 filesystem:
 *                   type: string
 *                   example: "ext4"
 *                 extra_partition:
 *                   type: boolean
 *                   example: false
 *                 tar_file:
 *                   type: string
 *                   example: "/mnt/cache/backup/boot/backup-2026-05-31_05-00-09.tar"
 *                 command:
 *                   type: string
 *                   example: "bash /usr/local/bin/mos-install /dev/sda ext4 quiet false"
 *                 output:
 *                   type: string
 *                   example: "Installation process started..."
 *                 error:
 *                   type: string
 *                   nullable: true
 *                   example: null
 *                 timestamp:
 *                   type: string
 *                   example: "2024-01-15T10:30:00.000Z"
 *       400:
 *         description: Invalid request parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "filesystem must be one of: vfat, ext4, btrfs, xfs"
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

// POST: Install MOS to disk
router.post('/installtodisk', async (req, res) => {
  try {
    const { disk, filesystem, extra_partition = false, tar_file = '' } = req.body;

    if (!disk) {
      return res.status(400).json({
        success: false,
        error: 'disk parameter is required'
      });
    }

    if (!filesystem) {
      return res.status(400).json({
        success: false,
        error: 'filesystem parameter is required'
      });
    }

    const result = await mosService.installToDisk(disk, filesystem, extra_partition, tar_file);

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * @swagger
 * /mos/dashboard:
 *   get:
 *     summary: Get dashboard layout
 *     description: Retrieve current dashboard card layout configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard layout retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 left:
 *                   type: array
 *                   description: Cards in the left column
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         description: Unique card identifier
 *                         example: "C1"
 *                       name:
 *                         type: string
 *                         description: Card display name
 *                         example: "Card1"
 *                 right:
 *                   type: array
 *                   description: Cards in the right column
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         description: Unique card identifier
 *                         example: "C2"
 *                       name:
 *                         type: string
 *                         description: Card display name
 *                         example: "Card2"
 *                 visibility:
 *                   type: object
 *                   description: Visibility state for each card (key is card name, value is boolean)
 *                   additionalProperties:
 *                     type: boolean
 *                   example:
 *                     Card1: true
 *                     Card2: false
 *                 interface:
 *                   type: string
 *                   description: Network interface to monitor on dashboard (default eth0)
 *                   example: "eth0"
 *             example:
 *               left:
 *                 - id: "C1"
 *                   name: "Card1"
 *               right:
 *                 - id: "C2"
 *                   name: "Card2"
 *               visibility:
 *                 Card1: true
 *                 Card2: false
 *               interface: "eth0"
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
 *   post:
 *     summary: Update dashboard layout
 *     description: Update dashboard card layout configuration (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - left
 *               - right
 *               - visibility
 *             properties:
 *               left:
 *                 type: array
 *                 description: Cards in the left column
 *                 items:
 *                   type: object
 *                   required:
 *                     - id
 *                     - name
 *                   properties:
 *                     id:
 *                       type: string
 *                       description: Unique card identifier
 *                       example: "C1"
 *                     name:
 *                       type: string
 *                       description: Card display name
 *                       example: "Card1"
 *               right:
 *                 type: array
 *                 description: Cards in the right column
 *                 items:
 *                   type: object
 *                   required:
 *                     - id
 *                     - name
 *                   properties:
 *                     id:
 *                       type: string
 *                       description: Unique card identifier
 *                       example: "C2"
 *                     name:
 *                       type: string
 *                       description: Card display name
 *                       example: "Card2"
 *               visibility:
 *                 type: object
 *                 description: Visibility state for each card (key is card name, value is boolean)
 *                 additionalProperties:
 *                   type: boolean
 *               interface:
 *                 type: string
 *                 description: Network interface to monitor on dashboard (default eth0)
 *                 example: "eth0"
 *           example:
 *             left:
 *               - id: "C1"
 *                 name: "Card1"
 *             right:
 *               - id: "C2"
 *                 name: "Card2"
 *             visibility:
 *               Card1: true
 *               Card2: false
 *             interface: "eth0"
 *     responses:
 *       200:
 *         description: Dashboard layout updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 left:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       name:
 *                         type: string
 *                 right:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       name:
 *                         type: string
 *                 visibility:
 *                   type: object
 *                   additionalProperties:
 *                     type: boolean
 *                 interface:
 *                   type: string
 *                   description: Network interface to monitor on dashboard
 *                   example: "eth0"
 *       400:
 *         description: Invalid request body
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

/**
 * @swagger
 * /mos/readfile:
 *   get:
 *     summary: Read a file from the filesystem
 *     description: Read the content of any file on the filesystem
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Absolute path to the file to read
 *         example: "/etc/config.txt"
 *     responses:
 *       200:
 *         description: File content retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 path:
 *                   type: string
 *                   example: "/etc/config.txt"
 *                 content:
 *                   type: string
 *                   description: The file content as a string
 *                   example: "file content here"
 *                 size:
 *                   type: integer
 *                   description: Size of the file in bytes
 *                   example: 1024
 *       400:
 *         description: Bad request - missing path parameter
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: File not found
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

// GET: Read a file from the filesystem
router.get('/readfile', checkRole(['admin']), async (req, res) => {
  try {
    const { path } = req.query;

    if (!path) {
      return res.status(400).json({ error: 'path query parameter is required' });
    }

    const result = await mosService.readFile(path);
    res.json(result);
  } catch (error) {
    if (error.message.includes('File does not exist')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/editfile:
 *   post:
 *     summary: Edit a file on the filesystem
 *     description: Edit any file on the filesystem. Creates a backup with .backup extension if create_backup is true
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - path
 *               - content
 *             properties:
 *               path:
 *                 type: string
 *                 description: Absolute path to the file to edit
 *                 example: "/etc/config.txt"
 *               content:
 *                 type: string
 *                 description: New content for the file
 *                 example: "new file content"
 *               create_backup:
 *                 type: boolean
 *                 description: Whether to create a backup file with .backup extension
 *                 example: true
 *                 default: false
 *     responses:
 *       200:
 *         description: File edited successfully
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
 *                   example: "File edited successfully"
 *                 backupPath:
 *                   type: string
 *                   nullable: true
 *                   description: Path to the backup file if create_backup was true
 *                   example: "/etc/config.txt.backup"
 *       400:
 *         description: Bad request - missing required parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: File not found
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

// POST: Edit a file on the filesystem
router.post('/editfile', checkRole(['admin']), async (req, res) => {
  try {
    const { path, content, create_backup = false } = req.body;

    if (!path) {
      return res.status(400).json({ error: 'path parameter is required' });
    }

    if (content === undefined) {
      return res.status(400).json({ error: 'content parameter is required' });
    }

    const result = await mosService.editFile(path, content, create_backup);
    res.json(result);
  } catch (error) {
    if (error.message.includes('File does not exist')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/rename:
 *   post:
 *     summary: Rename a file or directory
 *     description: |
 *       Renames a file or directory by changing only its name within the same parent directory.
 *       This is a synchronous operation and returns immediately.
 *
 *       **Validation:**
 *       - `new_name` must not contain forbidden characters: `\ / : * ? " < > |` or control characters
 *       - `new_name` must not have leading/trailing whitespace
 *       - `new_name` must not be identical to the current name
 *       - Case-only changes (e.g., `Movies` → `movies`) are allowed (Linux is case-sensitive)
 *       - An error is thrown if a file/directory with `new_name` already exists in the same directory
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - destination
 *               - new_name
 *             properties:
 *               destination:
 *                 type: string
 *                 description: Full path to the file or directory to rename
 *                 example: "/mnt/Pool1/media/old-folder"
 *               new_name:
 *                 type: string
 *                 description: New name (filename only, no path separators or invalid characters)
 *                 example: "new-folder"
 *           examples:
 *             renameDir:
 *               summary: Rename a directory
 *               value:
 *                 destination: "/mnt/Pool1/media/old-folder"
 *                 new_name: "new-folder"
 *             renameFile:
 *               summary: Rename a file
 *               value:
 *                 destination: "/mnt/Pool1/documents/report.txt"
 *                 new_name: "report-final.txt"
 *             caseChange:
 *               summary: Change case only
 *               value:
 *                 destination: "/mnt/Pool1/media/Movies"
 *                 new_name: "movies"
 *     responses:
 *       200:
 *         description: Rename successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 source:
 *                   type: string
 *                   description: Original full path
 *                   example: "/mnt/Pool1/media/old-folder"
 *                 destination:
 *                   type: string
 *                   description: New full path after rename
 *                   example: "/mnt/Pool1/media/new-folder"
 *                 new_name:
 *                   type: string
 *                   description: New name
 *                   example: "new-folder"
 *       400:
 *         description: Invalid parameters or name already exists
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               exists:
 *                 value:
 *                   error: "A file or directory with the name \"new-folder\" already exists in /mnt/Pool1/media"
 *               notfound:
 *                 value:
 *                   error: "Path does not exist: /mnt/Pool1/media/old-folder"
 *               invalid_chars:
 *                 value:
 *                   error: "new_name contains invalid characters. Forbidden: \\ / : * ? \" < > | and control characters"
 *               identical:
 *                 value:
 *                   error: "new_name is identical to the current name"
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */

// POST: Rename a file or directory
router.post('/rename', async (req, res) => {
  try {
    const { destination, new_name } = req.body;
    const result = await mosService.rename(destination, new_name);
    res.json(result);
  } catch (error) {
    if (error.message.includes('required') ||
        error.message.includes('does not exist') ||
        error.message.includes('already exists') ||
        error.message.includes('must be') ||
        error.message.includes('invalid characters') ||
        error.message.includes('identical') ||
        error.message.includes('must not be')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/createfile:
 *   post:
 *     summary: Create a new file on the filesystem
 *     description: Create a new file with optional content and ownership/permission settings
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - path
 *             properties:
 *               path:
 *                 type: string
 *                 description: Absolute path to the file to create
 *                 example: "/mnt/pool1/newfile.txt"
 *               content:
 *                 type: string
 *                 description: Content for the new file (default empty)
 *                 example: "file content here"
 *                 default: ""
 *               user:
 *                 type: string
 *                 description: User ID or username for file ownership
 *                 example: "500"
 *                 default: "500"
 *               group:
 *                 type: string
 *                 description: Group ID or group name for file ownership
 *                 example: "500"
 *                 default: "500"
 *               permissions:
 *                 type: string
 *                 description: File permissions in octal format
 *                 example: "777"
 *                 default: "777"
 *     responses:
 *       200:
 *         description: File created successfully
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
 *                   example: "File created successfully"
 *                 path:
 *                   type: string
 *                   example: "/mnt/pool1/newfile.txt"
 *                 user:
 *                   type: string
 *                   example: "500"
 *                 group:
 *                   type: string
 *                   example: "500"
 *                 permissions:
 *                   type: string
 *                   example: "777"
 *       400:
 *         description: Bad request - missing path or file already exists
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

// POST: Create a new file on the filesystem
router.post('/createfile', checkRole(['admin']), async (req, res) => {
  try {
    const { path, content = '', user = '500', group = '500', permissions = '777' } = req.body;

    if (!path) {
      return res.status(400).json({ error: 'path parameter is required' });
    }

    const result = await mosService.createFile(path, content, { user, group, permissions });
    res.json(result);
  } catch (error) {
    if (error.message.includes('already exists') || error.message.includes('Path already exists')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/createfolder:
 *   post:
 *     summary: Create a new folder on the filesystem
 *     description: Create a new folder with optional ownership/permission settings
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - path
 *             properties:
 *               path:
 *                 type: string
 *                 description: Absolute path to the folder to create
 *                 example: "/mnt/pool1/newfolder"
 *               user:
 *                 type: string
 *                 description: User ID or username for folder ownership
 *                 example: "500"
 *                 default: "500"
 *               group:
 *                 type: string
 *                 description: Group ID or group name for folder ownership
 *                 example: "500"
 *                 default: "500"
 *               permissions:
 *                 type: string
 *                 description: Folder permissions in octal format
 *                 example: "777"
 *                 default: "777"
 *     responses:
 *       200:
 *         description: Folder created successfully
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
 *                   example: "Folder created successfully"
 *                 path:
 *                   type: string
 *                   example: "/mnt/pool1/newfolder"
 *                 user:
 *                   type: string
 *                   example: "500"
 *                 group:
 *                   type: string
 *                   example: "500"
 *                 permissions:
 *                   type: string
 *                   example: "777"
 *       400:
 *         description: Bad request - missing path or folder already exists
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

// POST: Create a new folder on the filesystem
router.post('/createfolder', checkRole(['admin']), async (req, res) => {
  try {
    const { path, user = '500', group = '500', permissions = '777' } = req.body;

    if (!path) {
      return res.status(400).json({ error: 'path parameter is required' });
    }

    const result = await mosService.createFolder(path, { user, group, permissions });
    res.json(result);
  } catch (error) {
    if (error.message.includes('already exists') || error.message.includes('not a directory')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/delete:
 *   post:
 *     summary: Delete a file or folder from the filesystem
 *     description: |
 *       Delete a file or folder with optional force and recursive flags.
 *       - For files: deletes the file directly
 *       - For empty folders: deletes without recursive flag
 *       - For non-empty folders: requires recursive=true
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - path
 *             properties:
 *               path:
 *                 type: string
 *                 description: Absolute path to the file or folder to delete
 *                 example: "/mnt/pool1/oldfile.txt"
 *               force:
 *                 type: boolean
 *                 description: Force deletion (ignore nonexistent files)
 *                 example: true
 *                 default: true
 *               recursive:
 *                 type: boolean
 *                 description: Recursively delete directories (required for non-empty folders)
 *                 example: false
 *                 default: false
 *     responses:
 *       200:
 *         description: Item deleted successfully
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
 *                   example: "File deleted successfully"
 *                 path:
 *                   type: string
 *                   example: "/mnt/pool1/oldfile.txt"
 *                 type:
 *                   type: string
 *                   enum: [file, directory]
 *                   example: "file"
 *                 recursive:
 *                   type: boolean
 *                   example: false
 *                 force:
 *                   type: boolean
 *                   example: true
 *       400:
 *         description: Bad request - missing path or directory not empty
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Path not found (when force=false)
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

// POST: Delete a file or folder from the filesystem
router.post('/delete', checkRole(['admin']), async (req, res) => {
  try {
    const { path, force = true, recursive = false } = req.body;

    if (!path) {
      return res.status(400).json({ error: 'path parameter is required' });
    }

    const result = await mosService.deleteItem(path, { force, recursive });
    res.json(result);
  } catch (error) {
    if (error.message.includes('does not exist')) {
      return res.status(404).json({ error: error.message });
    }
    if (error.message.includes('not empty')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/chown:
 *   post:
 *     summary: Change ownership of a file or folder
 *     description: Change the user and group ownership of a file or folder, optionally recursive
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - path
 *             properties:
 *               path:
 *                 type: string
 *                 description: Absolute path to the file or folder
 *                 example: "/mnt/pool1/myfile.txt"
 *               user:
 *                 type: string
 *                 description: User ID or username for ownership
 *                 example: "500"
 *                 default: "500"
 *               group:
 *                 type: string
 *                 description: Group ID or group name for ownership
 *                 example: "500"
 *                 default: "500"
 *               recursive:
 *                 type: boolean
 *                 description: Apply ownership change recursively
 *                 example: false
 *                 default: false
 *     responses:
 *       200:
 *         description: Ownership changed successfully
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
 *                   example: "Ownership changed successfully"
 *                 path:
 *                   type: string
 *                   example: "/mnt/pool1/myfile.txt"
 *                 user:
 *                   type: string
 *                   example: "500"
 *                 group:
 *                   type: string
 *                   example: "500"
 *                 recursive:
 *                   type: boolean
 *                   example: false
 *       400:
 *         description: Bad request - missing path
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Path not found
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

// POST: Change ownership of a file or folder
router.post('/chown', checkRole(['admin']), async (req, res) => {
  try {
    const { path, user = '500', group = '500', recursive = false } = req.body;

    if (!path) {
      return res.status(400).json({ error: 'path parameter is required' });
    }

    const result = await mosService.chown(path, { user, group, recursive });
    res.json(result);
  } catch (error) {
    if (error.message.includes('does not exist')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/chmod:
 *   post:
 *     summary: Change permissions of a file or folder
 *     description: Change the permissions of a file or folder, optionally recursive
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - path
 *             properties:
 *               path:
 *                 type: string
 *                 description: Absolute path to the file or folder
 *                 example: "/mnt/pool1/myfile.txt"
 *               permissions:
 *                 type: string
 *                 description: Permissions in octal format
 *                 example: "777"
 *                 default: "777"
 *               recursive:
 *                 type: boolean
 *                 description: Apply permission change recursively
 *                 example: false
 *                 default: false
 *     responses:
 *       200:
 *         description: Permissions changed successfully
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
 *                   example: "Permissions changed successfully"
 *                 path:
 *                   type: string
 *                   example: "/mnt/pool1/myfile.txt"
 *                 permissions:
 *                   type: string
 *                   example: "777"
 *                 recursive:
 *                   type: boolean
 *                   example: false
 *       400:
 *         description: Bad request - missing path
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Path not found
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

// POST: Change permissions of a file or folder
router.post('/chmod', checkRole(['admin']), async (req, res) => {
  try {
    const { path, permissions = '777', recursive = false } = req.body;

    if (!path) {
      return res.status(400).json({ error: 'path parameter is required' });
    }

    const result = await mosService.chmod(path, { permissions, recursive });
    res.json(result);
  } catch (error) {
    if (error.message.includes('does not exist')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

// GET: Read dashboard interface setting
router.get('/dashboard/interface', async (req, res) => {
  try {
    const interfaceName = await mosService.getDashboardInterface();
    res.json({ interface: interfaceName });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST: Update dashboard interface setting
router.post('/dashboard/interface', async (req, res) => {
  try {
    const { interface: interfaceName } = req.body || {};
    const result = await mosService.updateDashboardInterface(interfaceName);

    // Invalidate websocket cache so it picks up the new interface immediately
    if (req.app.locals.systemLoadWebSocketManager) {
      req.app.locals.systemLoadWebSocketManager.invalidateDashboardInterfaceCache();
    }

    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET: Read dashboard layout
router.get('/dashboard', async (req, res) => {
  try {
    const layout = await mosService.getDashboardLayout();
    res.json(layout);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST: Update dashboard layout
router.post('/dashboard', async (req, res) => {
  try {
    if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object with left, right, and visibility properties.' });
    }

    const updatedLayout = await mosService.updateDashboardLayout(req.body);
    res.json(updatedLayout);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/dashboard/interface:
 *   get:
 *     summary: Get dashboard network interface setting
 *     description: Retrieve which network interface is monitored on the dashboard. Returns 'eth0' by default if not configured.
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard interface retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 interface:
 *                   type: string
 *                   description: Network interface name used for dashboard monitoring
 *                   example: "eth0"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *   post:
 *     summary: Update dashboard network interface setting
 *     description: |
 *       Set which network interface is monitored on the dashboard (system load websocket and /system/load endpoint).
 *       Valid interface names include eth0, eth1, br0, bond0, eth0.100 (VLAN), etc.
 *       If set to empty or invalid, defaults back to eth0.
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - interface
 *             properties:
 *               interface:
 *                 type: string
 *                 description: Network interface name to monitor
 *                 example: "br0"
 *     responses:
 *       200:
 *         description: Dashboard interface updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 interface:
 *                   type: string
 *                   description: Updated network interface name
 *                   example: "br0"
 *       400:
 *         description: Invalid interface name
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

/**
 * @swagger
 * /mos/fsnavigator:
 *   get:
 *     summary: Browse filesystem with directory/file picker
 *     description: |
 *       Navigate directories and files with optional virtual root.
 *       - Without `roots` parameter: Full filesystem access (real `/` with all directories)
 *       - With `roots` parameter: Virtual root showing only specified directories
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: path
 *         required: false
 *         schema:
 *           type: string
 *           default: "/"
 *         description: Path to browse
 *         examples:
 *           root:
 *             value: "/"
 *             summary: Browse root directory
 *           mnt:
 *             value: "/mnt"
 *             summary: Browse /mnt directory
 *           nested:
 *             value: "/mnt/nvme/appdata"
 *             summary: Browse nested directory
 *       - in: query
 *         name: type
 *         required: false
 *         schema:
 *           type: string
 *           enum: [directories, all]
 *           default: directories
 *         description: Type of items to return - "directories" shows only folders, "all" shows folders and files
 *         examples:
 *           directories:
 *             value: "directories"
 *             summary: Show only directories
 *           all:
 *             value: "all"
 *             summary: Show directories and files
 *       - in: query
 *         name: roots
 *         required: false
 *         schema:
 *           type: string
 *         description: |
 *           Optional comma-separated list of allowed root directories for virtual root.
 *           When specified with path="/", creates a virtual root showing only these directories.
 *           Without this parameter, full filesystem access is granted.
 *         examples:
 *           restricted:
 *             value: "/mnt,/var/mergerfs"
 *             summary: Virtual root with only /mnt and /var/mergerfs
 *           single:
 *             value: "/mnt"
 *             summary: Restrict to /mnt only
 *       - in: query
 *         name: includeHidden
 *         required: false
 *         schema:
 *           type: string
 *           enum: [true, false]
 *           default: false
 *         description: Whether to include hidden files and folders (starting with .)
 *         examples:
 *           show_hidden:
 *             value: "true"
 *             summary: Show hidden files and folders
 *           hide_hidden:
 *             value: "false"
 *             summary: Hide hidden files and folders (default)
 *     responses:
 *       200:
 *         description: Directory listing with navigation info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 isVirtualRoot:
 *                   type: boolean
 *                   description: True if showing virtual root
 *                   example: false
 *                 currentPath:
 *                   type: string
 *                   description: Current directory path
 *                   example: "/mnt/nvme"
 *                 parentPath:
 *                   type: string
 *                   nullable: true
 *                   description: Parent directory path (null if at virtual root)
 *                   example: "/mnt"
 *                 canGoUp:
 *                   type: boolean
 *                   description: Whether user can navigate to parent
 *                   example: true
 *                 items:
 *                   type: array
 *                   description: List of directories and/or files
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                         description: Item name
 *                         example: "appdata"
 *                       path:
 *                         type: string
 *                         description: Full path to item
 *                         example: "/mnt/nvme/appdata"
 *                       type:
 *                         type: string
 *                         enum: [directory, file]
 *                         description: Item type
 *                         example: "directory"
 *                       size:
 *                         type: integer
 *                         nullable: true
 *                         description: File size in bytes (null for directories)
 *                         example: null
 *                       size_human:
 *                         type: string
 *                         nullable: true
 *                         description: Human readable file size based on user byte_format preference (null for directories)
 *                         example: null
 *                       modified:
 *                         type: string
 *                         format: date-time
 *                         description: Last modified timestamp
 *                         example: "2024-11-25T14:30:00.000Z"
 *                       isSymlink:
 *                         type: boolean
 *                         description: Whether this item is a symbolic link
 *                         example: false
 *                       symlinkTarget:
 *                         type: string
 *                         nullable: true
 *                         description: Target path if this is a symlink (null if not a symlink)
 *                         example: null
 *                       permissions:
 *                         type: object
 *                         description: File/directory permissions information
 *                         properties:
 *                           octal:
 *                             type: string
 *                             description: Octal representation of permissions (e.g. 755, 644)
 *                             example: "755"
 *                           owner:
 *                             type: string
 *                             description: Owner username or UID
 *                             example: "root"
 *                           group:
 *                             type: string
 *                             description: Group name or GID
 *                             example: "root"
 *             examples:
 *               virtualRoot:
 *                 summary: Virtual root response
 *                 value:
 *                   isVirtualRoot: true
 *                   currentPath: "/"
 *                   parentPath: null
 *                   canGoUp: false
 *                   items:
 *                     - name: "mnt"
 *                       path: "/mnt"
 *                       type: "directory"
 *                       displayPath: "/mnt"
 *                     - name: "mergerfs"
 *                       path: "/var/mergerfs"
 *                       type: "directory"
 *                       displayPath: "/var/mergerfs"
 *               normalDirectory:
 *                 summary: Normal directory response
 *                 value:
 *                   isVirtualRoot: false
 *                   currentPath: "/mnt/nvme"
 *                   parentPath: "/mnt"
 *                   canGoUp: true
 *                   items:
 *                     - name: "appdata"
 *                       path: "/mnt/nvme/appdata"
 *                       type: "directory"
 *                       size: null
 *                       size_human: null
 *                       modified: "2024-11-25T14:30:00.000Z"
 *                       isSymlink: false
 *                       symlinkTarget: null
 *                       permissions:
 *                         octal: "755"
 *                         owner: "root"
 *                         group: "root"
 *                     - name: "backup"
 *                       path: "/mnt/nvme/backup"
 *                       type: "directory"
 *                       size: null
 *                       size_human: null
 *                       modified: "2024-11-20T10:15:00.000Z"
 *                       isSymlink: false
 *                       symlinkTarget: null
 *                       permissions:
 *                         octal: "755"
 *                         owner: "user"
 *                         group: "users"
 *                     - name: "bin"
 *                       path: "/bin"
 *                       type: "directory"
 *                       size: null
 *                       size_human: null
 *                       modified: "2024-11-15T08:20:00.000Z"
 *                       isSymlink: true
 *                       symlinkTarget: "/usr/bin"
 *                       permissions:
 *                         octal: "777"
 *                         owner: "root"
 *                         group: "root"
 *       400:
 *         description: Invalid type parameter
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Invalid type. Must be 'directories' or 'all'"
 *       403:
 *         description: Path outside allowed directories
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Path outside allowed directories"
 *       404:
 *         description: Path does not exist
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Path does not exist"
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

// GET: Filesystem Navigator - Browse directories and files
router.get('/fsnavigator', async (req, res) => {
  try {
    const { path = '/', type = 'directories', roots, includeHidden = 'false' } = req.query;

    // Validate type parameter
    if (type !== 'directories' && type !== 'all') {
      return res.status(400).json({
        error: 'Invalid type. Must be "directories" or "all"'
      });
    }

    // Parse roots parameter (comma-separated list)
    let allowedRoots = null;
    if (roots) {
      allowedRoots = roots.split(',').map(r => r.trim()).filter(r => r.length > 0);

      // Validate that roots are absolute paths
      for (const root of allowedRoots) {
        if (!root.startsWith('/')) {
          return res.status(400).json({
            error: `Invalid root path "${root}". Root paths must be absolute (start with /)`
          });
        }
      }
    }

    const result = await mosService.browseFilesystem(path, type, allowedRoots, includeHidden === 'true', req.user);
    res.json(result);
  } catch (error) {
    if (error.message.includes('outside allowed directories')) {
      res.status(403).json({ error: error.message });
    } else if (error.message.includes('does not exist')) {
      res.status(404).json({ error: error.message });
    } else if (error.message.includes('not a directory')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/download:
 *   get:
 *     summary: Download a file from the filesystem
 *     description: |
 *       Downloads a file as a binary stream. Supports any file type and size.
 *       The file is streamed directly without loading it entirely into memory.
 *       Use the filesystem navigator (`GET /mos/fsnavigator`) to browse available files.
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Absolute path to the file to download
 *         example: "/mnt/Pool1/backups/archive.tar.gz"
 *     responses:
 *       200:
 *         description: File download stream
 *         headers:
 *           Content-Disposition:
 *             schema:
 *               type: string
 *             description: Attachment with filename
 *             example: "attachment; filename=\"archive.tar.gz\""
 *           Content-Length:
 *             schema:
 *               type: integer
 *             description: File size in bytes
 *           Last-Modified:
 *             schema:
 *               type: string
 *             description: File last modification date
 *         content:
 *           application/octet-stream:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: Bad request - missing or invalid path parameter
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               missing:
 *                 value:
 *                   error: "path query parameter is required"
 *               directory:
 *                 value:
 *                   error: "Path is a directory, not a file: /mnt/Pool1"
 *               invalid:
 *                 value:
 *                   error: "Invalid file path"
 *       404:
 *         description: File not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "File does not exist: /mnt/Pool1/missing.txt"
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

// GET: Download a file from the filesystem as binary stream
router.get('/download', checkRole(['admin']), async (req, res) => {
  try {
    const filePath = req.query.path;

    if (!filePath) {
      return res.status(400).json({ error: 'path query parameter is required' });
    }

    const fileInfo = await mosService.getFileForDownload(filePath);

    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(fileInfo.filename)}"`,
      'Content-Length': fileInfo.size,
      'Last-Modified': fileInfo.modified.toUTCString()
    });

    const stream = fs.createReadStream(fileInfo.resolvedPath);

    stream.on('error', (err) => {
      console.error('File download stream error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream file' });
      } else {
        res.destroy();
      }
    });

    stream.pipe(res);
  } catch (error) {
    if (error.message.includes('File does not exist')) {
      return res.status(404).json({ error: error.message });
    }
    if (error.message.includes('directory, not a file') || error.message.includes('Invalid file path')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/upload:
 *   post:
 *     summary: Upload a file to the filesystem
 *     description: |
 *       Uploads a single file to the specified target directory.
 *       The file is sent as multipart/form-data.
 *       Use the filesystem navigator (`GET /mos/fsnavigator`) to browse available directories.
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *               - path
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: The file to upload
 *               path:
 *                 type: string
 *                 description: Absolute path to the target directory
 *                 example: "/mnt/Pool1/backups/"
 *     responses:
 *       200:
 *         description: File uploaded successfully
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
 *                   example: "File uploaded successfully"
 *                 file:
 *                   type: object
 *                   properties:
 *                     name:
 *                       type: string
 *                       example: "backup.tar.gz"
 *                     size:
 *                       type: integer
 *                       example: 1048576
 *                     path:
 *                       type: string
 *                       example: "/mnt/Pool1/backups/backup.tar.gz"
 *       400:
 *         description: Bad request (missing file or path)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Target directory not found
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

// POST: Upload a file to the filesystem
router.post('/upload', checkRole(['admin']), fileUpload({ useTempFiles: false }), async (req, res) => {
  try {
    if (!req.body.path) {
      return res.status(400).json({ error: 'path field is required' });
    }

    if (!req.files || !req.files.file) {
      return res.status(400).json({ error: 'file is required' });
    }

    const result = await mosService.uploadFile(req.body.path, req.files.file);
    res.json(result);
  } catch (error) {
    if (error.message.includes('does not exist')) {
      return res.status(404).json({ error: error.message });
    }
    if (error.message.includes('not a directory') || error.message.includes('Invalid')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// FILE OPERATIONS ENDPOINTS
// ============================================================

/**
 * @swagger
 * /mos/fileoperations:
 *   post:
 *     summary: Start a file copy or move operation
 *     description: |
 *       Starts a background file copy or move operation with progress tracking.
 *       The operation runs asynchronously - use the WebSocket namespace `/fileoperations`
 *       or poll `GET /mos/fileoperations` for progress updates.
 *
 *       **MergerFS Protection:**
 *       Copy operations within the same MergerFS pool are blocked to prevent data corruption.
 *       This includes paths under `/mnt/POOLNAME` and `/var/mergerfs/POOLNAME/`.
 *       Move operations are always allowed.
 *
 *       **Same-Filesystem Moves:**
 *       If source and destination are on the same filesystem, the move is instant (rename).
 *       The response will have `instantMove: true` in this case.
 *
 *       **Disk Space Check:**
 *       Before starting the transfer, available disk space at the destination is checked.
 *       The operation will fail if insufficient space is detected.
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - operation
 *               - source
 *               - destination
 *             properties:
 *               operation:
 *                 type: string
 *                 enum: [copy, move]
 *                 description: Type of file operation
 *                 example: "copy"
 *               source:
 *                 type: string
 *                 description: Source file or directory path
 *                 example: "/mnt/Pool1/media/movies"
 *               destination:
 *                 type: string
 *                 description: Destination directory path
 *                 example: "/mnt/ssd1/backup"
 *               onConflict:
 *                 type: string
 *                 enum: [fail, overwrite, skip]
 *                 default: fail
 *                 description: |
 *                   How to handle conflicts when destination already exists:
 *                   - `fail` - Abort the operation (default)
 *                   - `overwrite` - Overwrite existing files
 *                   - `skip` - Skip existing files
 *                 example: "fail"
 *           examples:
 *             copy:
 *               summary: Copy a directory
 *               value:
 *                 operation: "copy"
 *                 source: "/mnt/Pool1/media/movies"
 *                 destination: "/mnt/ssd1/backup"
 *                 onConflict: "fail"
 *             move:
 *               summary: Move a directory
 *               value:
 *                 operation: "move"
 *                 source: "/var/mergerfs/Pool1/disk1/old-data"
 *                 destination: "/var/mergerfs/Pool1/disk2"
 *             overwrite:
 *               summary: Copy with overwrite
 *               value:
 *                 operation: "copy"
 *                 source: "/mnt/Pool1/media"
 *                 destination: "/mnt/Pool2/media-backup"
 *                 onConflict: "overwrite"
 *     responses:
 *       200:
 *         description: Operation started successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/FileOperationUpdate'
 *             example:
 *               id: "1742742123456"
 *               operation: "copy"
 *               source: "/mnt/Pool1/media/movies"
 *               destination: "/mnt/ssd1/backup"
 *               destinationFull: "/mnt/ssd1/backup/movies"
 *               status: "preparing"
 *               instantMove: false
 *               onConflict: "fail"
 *               progress: 0
 *               speed: 0
 *               speed_human: "0 B/s"
 *               eta: null
 *               bytesTransferred: 0
 *               bytesTransferred_human: "0 B"
 *               bytesTotal: 0
 *               bytesTotal_human: "0 B"
 *               startedAt: "2025-03-23T14:30:00.000Z"
 *               completedAt: null
 *               error: null
 *       400:
 *         description: Invalid parameters or MergerFS copy blocked
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               invalid:
 *                 value:
 *                   error: "Invalid operation. Must be \"copy\" or \"move\""
 *               mergerfs:
 *                 value:
 *                   error: "Copy operation blocked: Source and destination both belong to pool \"Pool1\". Copying within the same MergerFS pool creates duplicates and corrupts the pool. Use \"move\" instead, or copy to a different pool/location"
 *               conflict:
 *                 value:
 *                   error: "Destination already exists: /mnt/ssd1/backup/movies. Use onConflict \"overwrite\" or \"skip\" to proceed"
 *               space:
 *                 value:
 *                   error: "Not enough disk space. Required: 2.6 GiB, Available: 1.2 GiB"
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *   get:
 *     summary: List all file operations
 *     description: |
 *       Returns all running and recently completed file operations (completed operations
 *       are retained for 5 minutes). Sorted by status (running first) then by start time.
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of file operations
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/FileOperationUpdate'
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */

/**
 * @swagger
 * /mos/fileoperations/{id}:
 *   delete:
 *     summary: Cancel a running file operation
 *     description: |
 *       Cancels a running copy or move operation by sending SIGINT to the rsync process.
 *       Partially transferred files may remain at the destination.
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Operation ID to cancel
 *         example: "1742742123456"
 *     responses:
 *       200:
 *         description: Operation cancelled successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/FileOperationUpdate'
 *       400:
 *         description: Operation already completed/cancelled
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Operation 1742742123456 is already completed"
 *       404:
 *         description: Operation not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Operation not found: 1742742123456"
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */

/**
 * @swagger
 * /mos/runningfsoperations:
 *   get:
 *     summary: Get count of running file operations
 *     description: Returns the number of currently running (preparing + running) file operations as an integer.
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Running operations count
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 count:
 *                   type: integer
 *                   description: Number of currently running file operations
 *                   example: 2
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */

const fileOperationsService = require('../services/fileoperations.service');

// POST: Start a file copy or move operation
router.post('/fileoperations', async (req, res) => {
  try {
    const { operation, source, destination, onConflict } = req.body;

    const result = await fileOperationsService.startOperation({
      operation,
      source,
      destination,
      onConflict,
      user: req.user
    });

    res.json(result);
  } catch (error) {
    if (error.message.includes('blocked') ||
        error.message.includes('Invalid') ||
        error.message.includes('already exists') ||
        error.message.includes('Not enough disk space') ||
        error.message.includes('must be') ||
        error.message.includes('required') ||
        error.message.includes('does not exist')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// GET: List all file operations
router.get('/fileoperations', async (req, res) => {
  try {
    const operations = fileOperationsService.getOperations(req.user);
    res.json(operations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET: Count of running file operations
router.get('/runningfsoperations', async (req, res) => {
  try {
    const count = fileOperationsService.getRunningCount();
    res.json({ count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE: Cancel a running file operation
router.delete('/fileoperations/:id', async (req, res) => {
  try {
    const result = fileOperationsService.cancelOperation(req.params.id, req.user);
    res.json(result);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else if (error.message.includes('already')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// ============================================================
// SENSOR MAPPING ENDPOINTS
// ============================================================

/**
 * @swagger
 * /mos/sensors:
 *   get:
 *     summary: Get mapped sensor values
 *     description: Returns sensor values grouped by type (fan, temperature, power, voltage, psu, other)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Grouped sensor values
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 fan:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorValue'
 *                 temperature:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorValue'
 *                 power:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorValue'
 *                 voltage:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorValue'
 *                 psu:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorValue'
 *                 other:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorValue'
 *             example:
 *               fan:
 *                 - id: "1735303800123"
 *                   index: 0
 *                   name: "Front Fan"
 *                   value: 30.5
 *                   unit: "%"
 *               temperature:
 *                 - id: "1735303801456"
 *                   index: 0
 *                   name: "CPU Temperature"
 *                   value: 45.2
 *                   unit: "°C"
 *               power: []
 *               voltage: []
 *               psu: []
 *               other: []
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.get('/sensors', async (req, res) => {
  try {
    const sensors = await mosService.getMappedSensors();
    res.json(sensors);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/sensors/unmapped:
 *   get:
 *     summary: Get unmapped sensors
 *     description: Returns sensor data in the same structure as /system/sensors, but with already mapped sources removed. Empty adapters (with no remaining sensors) are also removed.
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Sensor data structure with mapped entries removed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties:
 *                 type: object
 *                 description: Adapter with its sensors
 *             example:
 *               coretemp-isa-0000:
 *                 Adapter: "ISA adapter"
 *                 Package id 0:
 *                   temp1_input: 32
 *                   temp1_max: 80
 *               nct6798-isa-0290:
 *                 Adapter: "ISA adapter"
 *                 fan1:
 *                   fan1_input: 1200
 *                   fan1_min: 0
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.get('/sensors/unmapped', checkRole(['admin']), async (req, res) => {
  try {
    const unmapped = await mosService.getUnmappedSensors();
    res.json(unmapped);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/sensors/config:
 *   get:
 *     summary: Get sensor mapping configuration
 *     description: Returns full configuration for all sensor mappings grouped by type
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Grouped sensor configuration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 fan:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorConfig'
 *                 temperature:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorConfig'
 *                 power:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorConfig'
 *                 voltage:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorConfig'
 *                 psu:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorConfig'
 *                 other:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorConfig'
 *             example:
 *               fan:
 *                 - id: "1735303800123"
 *                   index: 0
 *                   name: "Front Fan"
 *                   source: "nct6798-isa-0290.pwm1.pwm1"
 *                   unit: "%"
 *                   value_range:
 *                     min: 0
 *                     max: 255
 *                   transform: "percentage"
 *                   enabled: true
 *               temperature:
 *                 - id: "1735303801456"
 *                   index: 0
 *                   name: "CPU Temperature"
 *                   source: "nct6798-isa-0290.CPUTIN.temp2_input"
 *                   unit: "°C"
 *                   value_range: null
 *                   transform: null
 *                   enabled: true
 *               power: []
 *               voltage: []
 *               psu: []
 *               other: []
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.get('/sensors/config', async (req, res) => {
  try {
    const config = await mosService.getSensorsConfig();
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/sensors/view:
 *   get:
 *     summary: Get sensors view settings
 *     description: Returns UI visibility settings for sensor columns
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: View settings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 index:
 *                   type: boolean
 *                 name:
 *                   type: boolean
 *                 type:
 *                   type: boolean
 *                 subtype:
 *                   type: boolean
 *                 manufacturer:
 *                   type: boolean
 *                 model:
 *                   type: boolean
 *                 value:
 *                   type: boolean
 *                 unit:
 *                   type: boolean
 *                 actions:
 *                   type: boolean
 *             example:
 *               index: true
 *               name: true
 *               type: true
 *               subtype: true
 *               manufacturer: true
 *               model: true
 *               value: true
 *               unit: true
 *               actions: true
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.get('/sensors/view', checkRole(['admin']), async (req, res) => {
  try {
    const view = await mosService.getSensorsView();
    res.json(view);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/sensors/view:
 *   post:
 *     summary: Update sensors view settings
 *     description: Update UI visibility settings for sensor columns
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               index:
 *                 type: boolean
 *               name:
 *                 type: boolean
 *               type:
 *                 type: boolean
 *               subtype:
 *                 type: boolean
 *               manufacturer:
 *                 type: boolean
 *               model:
 *                 type: boolean
 *               value:
 *                 type: boolean
 *               unit:
 *                 type: boolean
 *               actions:
 *                 type: boolean
 *           example:
 *             index: false
 *             name: true
 *             manufacturer: true
 *             model: true
 *             value: true
 *             unit: true
 *             actions: true
 *     responses:
 *       200:
 *         description: Updated view settings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.post('/sensors/view', checkRole(['admin']), async (req, res) => {
  try {
    const view = await mosService.updateSensorsView(req.body);
    res.json(view);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/sensors:
 *   post:
 *     summary: Create sensor mapping(s)
 *     description: Create one or multiple sensor mappings. Request body must be an array of sensor objects.
 *     tags: [MOS]
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
 *               required:
 *                 - name
 *                 - type
 *                 - source
 *                 - unit
 *               properties:
 *                 name:
 *                   type: string
 *                   description: Display name for the sensor
 *                 manufacturer:
 *                   type: string
 *                   nullable: true
 *                   description: Hardware manufacturer (optional)
 *                 model:
 *                   type: string
 *                   nullable: true
 *                   description: Hardware model (optional)
 *                 subtype:
 *                   type: string
 *                   nullable: true
 *                   description: Sensor subtype (optional)
 *                   enum: [voltage, wattage, amperage, speed, flow, temperature, rpm, percentage]
 *                 type:
 *                   type: string
 *                   enum: [fan, temperature, power, voltage, psu, other]
 *                 source:
 *                   type: string
 *                   description: Dot notation path to sensor value. Use \\. to escape literal dots in key names
 *                 unit:
 *                   type: string
 *                   description: Display unit
 *                 multiplier:
 *                   type: number
 *                   nullable: true
 *                   description: Multiplier for voltage dividers. Cannot be used with divisor.
 *                 divisor:
 *                   type: number
 *                   nullable: true
 *                   description: Divisor for scaled values. Cannot be used with multiplier.
 *                 value_range:
 *                   type: object
 *                   nullable: true
 *                   description: Value range for percentage transformation
 *                   properties:
 *                     min:
 *                       type: number
 *                     max:
 *                       type: number
 *                 transform:
 *                   type: string
 *                   nullable: true
 *                   enum: [percentage]
 *                   description: Value transformation type
 *                 enabled:
 *                   type: boolean
 *                   default: true
 *           examples:
 *             singleSensor:
 *               summary: Single sensor in array
 *               value:
 *                 - name: "Front Fan"
 *                   type: "fan"
 *                   source: "nct6798-isa-0290.pwm1.pwm1"
 *                   unit: "%"
 *                   value_range:
 *                     min: 0
 *                     max: 255
 *                   transform: "percentage"
 *             multipleSensors:
 *               summary: Multiple sensors
 *               value:
 *                 - name: "PSU Input Voltage"
 *                   manufacturer: "Corsair"
 *                   model: "HX750i"
 *                   subtype: "voltage"
 *                   type: "psu"
 *                   source: "corsairpsu-hid-3-2.v_in.in0_input"
 *                   unit: "V"
 *                 - name: "CPU Temperature"
 *                   type: "temperature"
 *                   source: "nct6798-isa-0290.CPUTIN.temp2_input"
 *                   unit: "°C"
 *             voltageWithMultiplier:
 *               summary: Voltage with multiplier (for voltage dividers)
 *               value:
 *                 - name: "12V Rail"
 *                   type: "voltage"
 *                   subtype: "voltage"
 *                   source: "nct6798-isa-0290.in7.in7_input"
 *                   unit: "V"
 *                   multiplier: 6
 *             powerWithDivisor:
 *               summary: Power with divisor (for sensors outputting milliwatts)
 *               value:
 *                 - name: "CPU Power"
 *                   type: "power"
 *                   subtype: "wattage"
 *                   source: "some-sensor.power.power1_input"
 *                   unit: "W"
 *                   divisor: 1000000
 *     responses:
 *       201:
 *         description: All sensors created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 created:
 *                   type: array
 *                   description: Successfully created sensors
 *                   items:
 *                     $ref: '#/components/schemas/SensorConfig'
 *                 errors:
 *                   type: array
 *                   description: Empty array when all succeeded
 *                   items:
 *                     type: object
 *             example:
 *               created:
 *                 - id: "1735403800123"
 *                   index: 0
 *                   name: "PSU Input Voltage"
 *                   manufacturer: "Corsair"
 *                   model: "HX750i"
 *                   subtype: "voltage"
 *                   type: "psu"
 *                   source: "corsairpsu-hid-3-2.v_in.in0_input"
 *                   unit: "V"
 *               errors: []
 *       207:
 *         description: Partial success - some sensors created, some failed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 created:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SensorConfig'
 *                 errors:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       index:
 *                         type: integer
 *                       name:
 *                         type: string
 *                       error:
 *                         type: string
 *       400:
 *         description: All sensors failed to create
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.post('/sensors', checkRole(['admin']), async (req, res) => {
  try {
    if (!Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an array of sensors' });
    }
    const sensorsToCreate = req.body;

    const created = [];
    const errors = [];

    for (let i = 0; i < sensorsToCreate.length; i++) {
      try {
        const sensor = await mosService.createSensorMapping(sensorsToCreate[i]);
        created.push(sensor);
      } catch (err) {
        errors.push({ index: i, name: sensorsToCreate[i].name || `Sensor ${i}`, error: err.message });
      }
    }

    const status = errors.length === 0 ? 201 : (created.length > 0 ? 207 : 400);
    res.status(status).json({ created, errors });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/sensors/{id}:
 *   patch:
 *     summary: Update an existing sensor mapping
 *     description: Partially update fields of an existing sensor mapping. Changing type will move sensor to new group.
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Sensor ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               manufacturer:
 *                 type: string
 *                 nullable: true
 *               model:
 *                 type: string
 *                 nullable: true
 *               subtype:
 *                 type: string
 *                 nullable: true
 *                 enum: [voltage, wattage, amperage, speed, flow, temperature, rpm, percentage]
 *               type:
 *                 type: string
 *                 enum: [fan, temperature, power, voltage, psu, other]
 *                 description: Changing type moves sensor to new group
 *               source:
 *                 type: string
 *               unit:
 *                 type: string
 *               multiplier:
 *                 type: number
 *                 nullable: true
 *                 description: Multiplier for voltage dividers. Cannot be used with divisor.
 *               divisor:
 *                 type: number
 *                 nullable: true
 *                 description: Divisor for scaled values. Cannot be used with multiplier.
 *               value_range:
 *                 type: object
 *                 nullable: true
 *               transform:
 *                 type: string
 *                 nullable: true
 *               enabled:
 *                 type: boolean
 *               index:
 *                 type: integer
 *                 description: New position index within group
 *     responses:
 *       200:
 *         description: Sensor mapping updated successfully
 *       400:
 *         description: Invalid input or source already defined
 *       404:
 *         description: Sensor not found
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.patch('/sensors/:id', checkRole(['admin']), async (req, res) => {
  try {
    const sensor = await mosService.updateSensorMapping(req.params.id, req.body);
    res.json(sensor);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else if (error.message.includes('Invalid type') ||
               error.message.includes('Invalid source') ||
               error.message.includes('Cannot validate source') ||
               error.message.includes('Source already defined')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/sensors:
 *   put:
 *     summary: Replace all sensor mappings
 *     description: Replace the entire sensor configuration. Useful for bulk reordering or replacing all sensors at once. Existing sensors not in the new config will be deleted.
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Grouped sensor configuration
 *             properties:
 *               fan:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/SensorConfig'
 *               temperature:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/SensorConfig'
 *               power:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/SensorConfig'
 *               voltage:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/SensorConfig'
 *               psu:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/SensorConfig'
 *               other:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/SensorConfig'
 *     responses:
 *       200:
 *         description: Sensor configuration replaced successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: Updated grouped sensor configuration
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.put('/sensors', checkRole(['admin']), async (req, res) => {
  try {
    const config = await mosService.replaceSensorsConfig(req.body);
    res.json(config);
  } catch (error) {
    if (error.message.includes('Invalid') || error.message.includes('must be')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/sensors/{id}:
 *   delete:
 *     summary: Delete a sensor mapping
 *     description: Delete a sensor mapping and reindex remaining sensors
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Sensor ID
 *     responses:
 *       200:
 *         description: Sensor mapping deleted successfully
 *       404:
 *         description: Sensor not found
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.delete('/sensors/:id', checkRole(['admin']), async (req, res) => {
  try {
    const sensor = await mosService.deleteSensorMapping(req.params.id);
    res.json(sensor);
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
 * /mos/tokens:
 *   get:
 *     summary: Get all tokens
 *     description: Retrieve all tokens (github, dockerhub, etc.) decrypted from /boot/config/system/tokens.json (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Tokens retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 github:
 *                   type: string
 *                   nullable: true
 *                   description: Decrypted GitHub token or null if not set
 *                 dockerhub:
 *                   type: string
 *                   nullable: true
 *                   description: Decrypted Docker Hub credentials (format username:token) or null if not set
 *             example:
 *               github: "ghp_1234567890abcdef"
 *               dockerhub: "myuser:dckr_pat_xyz123"
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 *   post:
 *     summary: Update tokens (partial updates supported)
 *     description: Update one or more tokens (encrypted with JWT_SECRET) in /boot/config/system/tokens.json. Only provided tokens will be updated. (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               github:
 *                 type: string
 *                 nullable: true
 *                 description: GitHub token to save (will be encrypted)
 *               dockerhub:
 *                 type: string
 *                 nullable: true
 *                 description: Docker Hub credentials (format username:token) to save (will be encrypted). Used for pulling private images from Docker Hub.
 *           examples:
 *             update_github_only:
 *               summary: Update only GitHub token
 *               value:
 *                 github: "ghp_1234567890abcdef"
 *             update_both:
 *               summary: Update both tokens
 *               value:
 *                 github: "ghp_1234567890abcdef"
 *                 dockerhub: "myuser:dckr_pat_xyz123"
 *             remove_token:
 *               summary: Remove a token
 *               value:
 *                 github: null
 *     responses:
 *       200:
 *         description: Tokens updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 updated:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: List of token keys that were updated
 *             example:
 *               success: true
 *               message: "Tokens updated successfully"
 *               updated: ["github"]
 *       400:
 *         description: Invalid request body
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */

// GET: Read all tokens
router.get('/tokens', checkRole(['admin']), async (req, res) => {
  try {
    const result = await mosService.getTokens();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST: Update tokens (partial update supported)
router.post('/tokens', checkRole(['admin']), async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object with token fields (github, dockerhub, etc.).' });
    }

    // Validate dockerhub format: must be "username:token" if provided
    if (req.body.dockerhub && req.body.dockerhub !== null) {
      if (!req.body.dockerhub.includes(':')) {
        return res.status(400).json({ error: 'Docker Hub token must be in format "username:token"' });
      }
    }

    const result = await mosService.updateTokens(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/validatetokens:
 *   get:
 *     summary: Validate configured tokens
 *     description: |
 *       Validates GitHub and DockerHub tokens and returns their status.
 *       - GitHub: Returns rate limit info (limit, remaining, reset, used, resource)
 *       - DockerHub: Returns validation status and rate limit info if available
 *       If both tokens are empty, returns an error.
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Token validation results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 github:
 *                   type: object
 *                   properties:
 *                     configured:
 *                       type: boolean
 *                       description: Whether the token is configured
 *                     valid:
 *                       type: boolean
 *                       description: Whether the token is valid
 *                     rate:
 *                       type: object
 *                       description: GitHub rate limit info
 *                       properties:
 *                         limit:
 *                           type: integer
 *                           example: 5000
 *                         remaining:
 *                           type: integer
 *                           example: 4999
 *                         reset:
 *                           type: integer
 *                           example: 1768734414
 *                         used:
 *                           type: integer
 *                           example: 1
 *                         resource:
 *                           type: string
 *                           example: "core"
 *                     error:
 *                       type: string
 *                       description: Error message if validation failed
 *                 dockerhub:
 *                   type: object
 *                   properties:
 *                     configured:
 *                       type: boolean
 *                       description: Whether the token is configured
 *                     valid:
 *                       type: boolean
 *                       description: Whether the token is valid
 *                     username:
 *                       type: string
 *                       description: DockerHub username
 *                     rate:
 *                       type: object
 *                       nullable: true
 *                       description: DockerHub rate limit info (if available)
 *                       properties:
 *                         limit:
 *                           type: integer
 *                           example: 200
 *                         remaining:
 *                           type: integer
 *                           example: 199
 *                     error:
 *                       type: string
 *                       description: Error message if validation failed
 *                 error:
 *                   type: string
 *                   description: Error message if both tokens are empty
 *             examples:
 *               valid_tokens:
 *                 summary: Both tokens valid
 *                 value:
 *                   github:
 *                     configured: true
 *                     valid: true
 *                     rate:
 *                       limit: 5000
 *                       remaining: 4999
 *                       reset: 1768734414
 *                       used: 1
 *                       resource: "core"
 *                   dockerhub:
 *                     configured: true
 *                     valid: true
 *                     username: "myuser"
 *                     rate:
 *                       limit: 200
 *                       remaining: 199
 *               both_empty:
 *                 summary: Both tokens empty (shows anonymous rate limits)
 *                 value:
 *                   github:
 *                     configured: false
 *                     rate:
 *                       limit: 60
 *                       remaining: 60
 *                       reset: 1768734414
 *                       used: 0
 *                       resource: "core"
 *                   dockerhub:
 *                     configured: false
 *                     rate:
 *                       limit: 100
 *                       remaining: 100
 *               invalid_token:
 *                 summary: Invalid token (shows error + anonymous rate limit)
 *                 value:
 *                   github:
 *                     configured: true
 *                     valid: false
 *                     error: "Invalid or expired token"
 *                     rate:
 *                       limit: 60
 *                       remaining: 60
 *                       reset: 1768734414
 *                       used: 0
 *                       resource: "core"
 *                   dockerhub:
 *                     configured: true
 *                     valid: true
 *                     username: "myuser"
 *                     rate:
 *                       limit: 200
 *                       remaining: 199
 *               github_only:
 *                 summary: Only GitHub configured
 *                 value:
 *                   github:
 *                     configured: true
 *                     valid: true
 *                     rate:
 *                       limit: 5000
 *                       remaining: 4999
 *                       reset: 1768734414
 *                       used: 1
 *                       resource: "core"
 *                   dockerhub:
 *                     configured: false
 *                     rate:
 *                       limit: 100
 *                       remaining: 100
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */

// GET: Validate tokens
router.get('/validatetokens', checkRole(['admin']), async (req, res) => {
  try {
    const result = await mosService.validateTokens();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ZRAM ENDPOINTS
// ============================================================

/**
 * @swagger
 * /mos/zram:
 *   get:
 *     summary: Get ZRAM configuration and status
 *     description: Retrieve current ZRAM configuration including module status (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: ZRAM configuration retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                   description: Whether ZRAM is globally enabled
 *                 zram_devices:
 *                   type: integer
 *                   description: Number of configured ZRAM devices
 *                 module_loaded:
 *                   type: boolean
 *                   description: Whether the ZRAM kernel module is loaded
 *                 devices:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ZramDevice'
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 *   post:
 *     summary: Update ZRAM configuration
 *     description: Update ZRAM settings. Changing enabled from false to true loads the module and activates devices. Changing from true to false checks for mounted ramdisks and unloads the module (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               enabled:
 *                 type: boolean
 *               zram_devices:
 *                 type: integer
 *                 description: Number of ZRAM devices (must match devices array length)
 *               devices:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/ZramDevice'
 *           example:
 *             enabled: true
 *             zram_devices: 2
 *             devices:
 *               - name: "ZRAM Swap"
 *                 enabled: true
 *                 index: 0
 *                 algorithm: "zstd"
 *                 size: "5G"
 *                 type: "swap"
 *                 config:
 *                   priority: -2
 *                   uuid: null
 *                   filesystem: null
 *               - name: "Temp Ramdisk"
 *                 enabled: false
 *                 index: 1
 *                 algorithm: "lz4"
 *                 size: "2G"
 *                 type: "ramdisk"
 *                 config:
 *                   priority: null
 *                   uuid: null
 *                   filesystem: "ext4"
 *     responses:
 *       200:
 *         description: ZRAM configuration updated successfully
 *       400:
 *         description: Invalid configuration or mounted ramdisks prevent disable
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 *
 * components:
 *   schemas:
 *     ZramDevice:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Unique device ID (timestamp-based)
 *         name:
 *           type: string
 *           description: User-defined device name
 *         enabled:
 *           type: boolean
 *           description: Whether this device should be activated
 *         index:
 *           type: integer
 *           description: ZRAM device index (0 = /dev/zram0)
 *         algorithm:
 *           type: string
 *           enum: [zstd, lz4, lzo, lzo-rle]
 *           description: Compression algorithm
 *         size:
 *           type: string
 *           description: Device size (e.g., "4G", "512M")
 *         type:
 *           type: string
 *           enum: [swap, ramdisk]
 *           description: Device type
 *         config:
 *           type: object
 *           properties:
 *             priority:
 *               type: integer
 *               nullable: true
 *               description: Swap priority (required for enabled swap type, can be null if disabled)
 *             uuid:
 *               type: string
 *               nullable: true
 *               description: Filesystem UUID (auto-generated if not provided for ramdisk type)
 *             filesystem:
 *               type: string
 *               nullable: true
 *               enum: [ext4, xfs, btrfs]
 *               description: Filesystem type (required for enabled ramdisk type, can be null if disabled)
 */

// GET: Read ZRAM configuration
router.get('/zram', async (req, res) => {
  try {
    const config = await zramService.getConfig();
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST: Update ZRAM configuration
router.post('/zram', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object.' });
    }
    const result = await zramService.updateConfig(req.body);
    res.json(result);
  } catch (error) {
    if (error.message.includes('mounted') || error.message.includes('Unmount')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /mos/zram/algorithms:
 *   get:
 *     summary: Get available compression algorithms
 *     description: Returns list of compression algorithms supported by the kernel for ZRAM
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of available algorithms
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: string
 *             example: ["lzo", "lzo-rle", "lz4", "lz4hc", "zstd", "deflate", "842"]
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */

// GET: Available compression algorithms
router.get('/zram/algorithms', async (req, res) => {
  try {
    const algorithms = await zramService.getAlgorithms();
    res.json(algorithms);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/zram/status:
 *   get:
 *     summary: Get ZRAM device status
 *     description: Get detailed status of all ZRAM devices including compression stats (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: ZRAM status retrieved successfully
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */

// GET: ZRAM device status
router.get('/zram/status', async (req, res) => {
  try {
    const status = await zramService.getStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/zram/devices:
 *   post:
 *     summary: Add a new ZRAM device
 *     description: Add a new ZRAM device configuration. For swap type, config.priority is required. For ramdisk type, config.filesystem is required and config.uuid will be auto-generated if not provided (admin only)
 *     tags: [MOS]
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
 *               - type
 *             properties:
 *               name:
 *                 type: string
 *               enabled:
 *                 type: boolean
 *                 default: false
 *               algorithm:
 *                 type: string
 *                 default: zstd
 *               size:
 *                 type: string
 *               type:
 *                 type: string
 *                 enum: [swap, ramdisk]
 *               config:
 *                 type: object
 *           examples:
 *             swap_device:
 *               summary: Create enabled swap device
 *               value:
 *                 name: "ZRAM Swap"
 *                 enabled: true
 *                 algorithm: "zstd"
 *                 size: "5G"
 *                 type: "swap"
 *                 config:
 *                   priority: -2
 *             ramdisk_device_enabled:
 *               summary: Create enabled ramdisk device (uuid auto-generated)
 *               value:
 *                 name: "Temp Ramdisk"
 *                 enabled: true
 *                 algorithm: "lz4"
 *                 size: "2G"
 *                 type: "ramdisk"
 *                 config:
 *                   filesystem: "ext4"
 *             ramdisk_device_disabled:
 *               summary: Create disabled ramdisk device (config can be null)
 *               value:
 *                 name: "Reserved Ramdisk"
 *                 enabled: false
 *                 type: "ramdisk"
 *                 config:
 *                   filesystem: null
 *                   uuid: null
 *     responses:
 *       200:
 *         description: Device created successfully
 *       400:
 *         description: Invalid device configuration
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */

// POST: Add new ZRAM device
router.post('/zram/devices', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object.' });
    }
    const device = await zramService.addDevice(req.body);
    res.json(device);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/zram/devices/{id}:
 *   post:
 *     summary: Update a ZRAM device
 *     description: Update an existing ZRAM device configuration. Disabling a device will reset it (swap will be disabled, ramdisk must not be mounted) (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Device ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Device updated successfully
 *       400:
 *         description: Invalid update or device is mounted
 *       404:
 *         description: Device not found
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 *   delete:
 *     summary: Delete a ZRAM device
 *     description: Delete a ZRAM device configuration. Device will be deactivated first (admin only)
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Device ID
 *     responses:
 *       200:
 *         description: Device deleted successfully
 *       400:
 *         description: Device is mounted and cannot be deleted
 *       404:
 *         description: Device not found
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */

// POST: Update ZRAM device
router.post('/zram/devices/:id', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object.' });
    }
    const device = await zramService.updateDevice(req.params.id, req.body);
    res.json(device);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else if (error.message.includes('mounted') || error.message.includes('Unmount')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// DELETE: Delete ZRAM device
router.delete('/zram/devices/:id', async (req, res) => {
  try {
    const deleted = await zramService.deleteDevice(req.params.id);
    res.json({ success: true, deleted });
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else if (error.message.includes('mounted') || error.message.includes('Unmount')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// ============================================================
// ZSWAP ENDPOINTS
// ============================================================

/**
 * @swagger
 * /mos/zswap/algorithms:
 *   get:
 *     summary: Get available zswap compression algorithms
 *     description: Returns list of compression algorithms supported by the kernel for zswap
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of available algorithms
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: string
 *               example: ["lzo", "lz4", "lz4hc", "zstd", "deflate", "842"]
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */

// GET: Available zswap compression algorithms
router.get('/zswap/algorithms', (req, res) => {
  try {
    const algorithms = swapService.getAlgorithms();
    res.json(algorithms);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /mos/zswap/status:
 *   get:
 *     summary: Get swap and zswap status
 *     description: Returns current swap status including active swaps, zswap configuration, and any pending operations
 *     tags: [MOS]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Swap status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 swaps:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       filename:
 *                         type: string
 *                       type:
 *                         type: string
 *                       size:
 *                         type: integer
 *                       used:
 *                         type: integer
 *                       priority:
 *                         type: integer
 *                 zswap:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                     compressor:
 *                       type: string
 *                     max_pool_percent:
 *                       type: integer
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */

// GET: Swap and zswap status
router.get('/zswap/status', async (req, res) => {
  try {
    const status = await swapService.getStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
