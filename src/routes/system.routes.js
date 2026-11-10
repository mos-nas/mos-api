const express = require('express');
const router = express.Router();
const { checkRole, authenticateToken } = require('../middleware/auth.middleware');
const systemService = require('../services/system.service');
const mosService = require('../services/mos.service');

/**
 * @swagger
 * tags:
 *   name: System
 *   description: System Information and Management
 *
 * components:
 *   schemas:
 *     Error:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           description: Error message
 *     MemoryUsage:
 *       type: object
 *       properties:
 *         used:
 *           type: integer
 *           description: Used memory (dirty)
 *           example: 8589934592
 *         actuallyUsed:
 *           type: integer
 *           description: Actually used memory (clean)
 *           example: 4294967296
 *         dirtyCaches:
 *           type: integer
 *           description: Memory used by dirty caches
 *           example: 4294967296
 *     MemoryInfo:
 *       type: object
 *       properties:
 *         installed:
 *           type: integer
 *           description: Physically installed memory in bytes (from BIOS/UEFI)
 *           example: 137438953472
 *         installed_human:
 *           type: string
 *           description: Physically installed memory in human-readable format
 *           example: "128.0 GiB"
 *         reserved:
 *           type: integer
 *           description: Hardware-reserved memory in bytes (installed - total)
 *           example: 2583560192
 *         reserved_human:
 *           type: string
 *           description: Hardware-reserved memory in human-readable format
 *           example: "2.4 GiB"
 *         total:
 *           type: integer
 *           description: Total usable memory in bytes (OS perspective)
 *           example: 134855393280
 *         total_human:
 *           type: string
 *           description: Total usable memory in human-readable format
 *           example: "125.6 GiB"
 *         free:
 *           type: integer
 *           description: Available memory in bytes
 *           example: 101748690944
 *         free_human:
 *           type: string
 *           description: Available memory in human-readable format
 *           example: "94.8 GiB"
 *         used:
 *           type: integer
 *           description: Actually used memory in bytes (without dirty caches)
 *           example: 33106702336
 *         used_human:
 *           type: string
 *           description: Actually used memory in human-readable format
 *           example: "30.8 GiB"
 *         breakdown:
 *           type: object
 *           description: Memory breakdown by service type (Docker, LXC, VMs, ZRAM, System). Percentages are calculated relative to total memory. Sum of all breakdown percentages equals percentage.actuallyUsed.
 *           properties:
 *             system:
 *               type: object
 *               description: Host system memory usage (excluding Docker/LXC/VM/ZRAM memory)
 *               properties:
 *                 bytes:
 *                   type: integer
 *                   example: 0
 *                 bytes_human:
 *                   type: string
 *                   example: "0 B"
 *                 percentage:
 *                   type: integer
 *                   description: Percentage of total memory
 *                   example: 3
 *             docker:
 *               type: object
 *               description: Docker containers total memory usage (including caches)
 *               properties:
 *                 bytes:
 *                   type: integer
 *                   example: 15000000000
 *                 bytes_human:
 *                   type: string
 *                   example: "14.0 GiB"
 *                 percentage:
 *                   type: integer
 *                   description: Percentage of total memory
 *                   example: 11
 *             lxc:
 *               type: object
 *               description: LXC containers total memory usage (including caches)
 *               properties:
 *                 bytes:
 *                   type: integer
 *                   example: 14000000000
 *                 bytes_human:
 *                   type: string
 *                   example: "13.0 GiB"
 *                 percentage:
 *                   type: integer
 *                   description: Percentage of total memory
 *                   example: 10
 *             vms:
 *               type: object
 *               description: Virtual machines total memory usage
 *               properties:
 *                 bytes:
 *                   type: integer
 *                   example: 0
 *                 bytes_human:
 *                   type: string
 *                   example: "0 B"
 *                 percentage:
 *                   type: integer
 *                   description: Percentage of total memory
 *                   example: 0
 *             zram:
 *               type: object
 *               description: ZRAM compressed swap memory usage (actual RAM used for compressed storage)
 *               properties:
 *                 bytes:
 *                   type: integer
 *                   example: 536870912
 *                 bytes_human:
 *                   type: string
 *                   example: "512.0 MiB"
 *                 percentage:
 *                   type: integer
 *                   description: Percentage of total memory
 *                   example: 1
 *         dirty:
 *           type: object
 *           properties:
 *             free:
 *               type: integer
 *               description: Free memory (kernel perspective)
 *               example: 3138637824
 *             used:
 *               type: integer
 *               description: Used memory (kernel perspective)
 *               example: 131716755456
 *             dirtyCaches:
 *               type: integer
 *               description: Memory used by dirty caches
 *               example: 98610053120
 *         percentage:
 *           type: object
 *           properties:
 *             used:
 *               type: integer
 *               description: Used memory percentage (dirty)
 *               example: 98
 *             actuallyUsed:
 *               type: integer
 *               description: Actually used memory percentage (clean)
 *               example: 25
 *             dirtyCaches:
 *               type: integer
 *               description: Dirty caches percentage
 *               example: 73
 *     BasicSystemInfo:
 *       type: object
 *       properties:
 *         os:
 *           type: object
 *           properties:
 *             platform:
 *               type: string
 *               example: "linux"
 *             distro:
 *               type: string
 *               example: "Ubuntu"
 *             release:
 *               type: string
 *               example: "22.04.3 LTS"
 *             kernel:
 *               type: string
 *               example: "6.14.11-mos"
 *         cpu:
 *           type: object
 *           properties:
 *             manufacturer:
 *               type: string
 *               example: "Intel"
 *             brand:
 *               type: string
 *               example: "Intel(R) Core(TM) i7-12700K"
 *             cores:
 *               type: integer
 *               example: 12
 *             physicalCores:
 *               type: integer
 *               example: 8
 *         memory:
 *           $ref: '#/components/schemas/MemoryInfo'
 *     DetailedMemoryInfo:
 *       type: object
 *       properties:
 *         memory:
 *           type: object
 *           properties:
 *             total:
 *               type: integer
 *               description: Total memory in bytes
 *               example: 17179869184
 *             free:
 *               type: integer
 *               description: Free memory in bytes
 *               example: 2147483648
 *             available:
 *               type: integer
 *               description: Available memory in bytes
 *               example: 8589934592
 *             used:
 *               $ref: '#/components/schemas/MemoryUsage'
 *             percentage:
 *               type: object
 *               properties:
 *                 used:
 *                   type: integer
 *                   description: Used memory percentage (dirty)
 *                   example: 50
 *                 actuallyUsed:
 *                   type: integer
 *                   description: Actually used memory percentage (clean)
 *                   example: 25
 *                 dirtyCaches:
 *                   type: integer
 *                   description: Dirty caches percentage
 *                   example: 25
 *         swap:
 *           $ref: '#/components/schemas/SwapInfo'
 *     CoreLoad:
 *       type: object
 *       properties:
 *         number:
 *           type: integer
 *           description: Core number (0-based)
 *           example: 0
 *         load:
 *           type: object
 *           properties:
 *             total:
 *               type: number
 *               description: Core load percentage
 *               example: 45.67
 *         temperature:
 *           type: number
 *           nullable: true
 *           description: Core temperature in Celsius
 *           example: 65.5
 *         isPhysical:
 *           type: boolean
 *           description: Whether this is a physical core (true) or hyperthreaded core (false)
 *           example: true
 *         isHyperThreaded:
 *           type: boolean
 *           description: Whether this is a hyperthreaded core
 *           example: false
 *         physicalCoreNumber:
 *           type: integer
 *           description: The physical core number this logical core belongs to (0-based)
 *           example: 0
 *         coreArchitecture:
 *           type: string
 *           description: Core architecture type (Performance, Mixed/Efficiency, or Standard)
 *           enum: [Performance, Mixed/Efficiency, Standard]
 *           example: "Performance"
 *     SystemLoad:
 *       type: object
 *       properties:
 *         cpu:
 *           type: object
 *           properties:
 *             load:
 *               type: number
 *               description: Overall CPU load percentage
 *               example: 42.35
 *             cores:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/CoreLoad'
 *         temperature:
 *           type: object
 *           properties:
 *             main:
 *               type: number
 *               description: Main CPU temperature
 *               example: 68.2
 *             max:
 *               type: number
 *               description: Maximum core temperature
 *               example: 72.1
 *             min:
 *               type: number
 *               description: Minimum core temperature
 *               example: 61.3
 *             cores:
 *               type: array
 *               items:
 *                 type: number
 *               description: Temperature of each core
 *               example: [65.5, 67.2, 72.1, 61.3]
 *     Service:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Service name
 *           example: "nginx"
 *         running:
 *           type: boolean
 *           description: Service running status
 *           example: true
 *         startmode:
 *           type: string
 *           description: Service start mode
 *           example: "automatic"
 *         pids:
 *           type: array
 *           items:
 *             type: integer
 *           description: Process IDs
 *           example: [1234, 1235]
 *         cpu:
 *           type: number
 *           description: CPU usage percentage
 *           example: 2.5
 *         mem:
 *           type: number
 *           description: Memory usage percentage
 *           example: 1.8
 *     OperationResult:
 *       type: object
 *       properties:
 *         message:
 *           type: string
 *           description: Operation result message
 *           example: "System update completed successfully"
 *     SwapInfo:
 *       type: object
 *       description: Swap space usage information. Returns zero values when no swap is configured.
 *       properties:
 *         total:
 *           type: integer
 *           description: Total swap space in bytes
 *           example: 8589934592
 *         total_human:
 *           type: string
 *           description: Total swap space in human-readable format
 *           example: "8.0 GiB"
 *         available:
 *           type: integer
 *           description: Available (free) swap space in bytes
 *           example: 8589934592
 *         available_human:
 *           type: string
 *           description: Available swap space in human-readable format
 *           example: "8.0 GiB"
 *         used:
 *           type: integer
 *           description: Used swap space in bytes
 *           example: 0
 *         used_human:
 *           type: string
 *           description: Used swap space in human-readable format
 *           example: "0 B"
 *         percentage:
 *           type: integer
 *           description: Swap usage percentage (0 when no swap configured)
 *           example: 0
 */


/**
 * @swagger
 * /system/memory:
 *   get:
 *     summary: Get detailed memory information
 *     description: Retrieve detailed memory information with separate dirty cache tracking (available to all authenticated users)
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Detailed memory information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DetailedMemoryInfo'
 *             example:
 *               memory:
 *                 total: 17179869184
 *                 free: 2147483648
 *                 available: 8589934592
 *                 used:
 *                   total: 8589934592
 *                   actuallyUsed: 4294967296
 *                   dirtyCaches: 4294967296
 *                 percentage:
 *                   used: 50
 *                   actuallyUsed: 25
 *                   dirtyCaches: 25
 *               swap:
 *                 total: 2147483648
 *                 total_human: "2.0 GiB"
 *                 available: 2147483648
 *                 available_human: "2.0 GiB"
 *                 used: 0
 *                 used_human: "0 B"
 *                 percentage: 0
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
 *             example:
 *               error: "Error getting detailed memory info: systeminformation module failed"
 */

// Detailed memory information with separate dirty cache tracking
router.get('/memory', authenticateToken, async (req, res) => {
  try {
    const memoryInfo = await systemService.getDetailedMemory(req.user);
    res.json(memoryInfo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /system/detailed:
 *   get:
 *     summary: Get detailed system information
 *     description: Retrieve comprehensive system information including OS, CPU, memory, disks, network and processes (admin only)
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Detailed system information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 os:
 *                   type: object
 *                   description: Complete OS information
 *                 cpu:
 *                   type: object
 *                   description: Complete CPU information
 *                 memory:
 *                   type: object
 *                   description: Complete memory information with detailed stats
 *                 disks:
 *                   type: array
 *                   description: Filesystem information
 *                   items:
 *                     type: object
 *                 network:
 *                   type: array
 *                   description: Network interfaces information
 *                   items:
 *                     type: object
 *                 processes:
 *                   type: object
 *                   description: Process information
 *             example:
 *               os:
 *                 platform: "linux"
 *                 distro: "Ubuntu 22.04.3 LTS"
 *                 hostname: "server1"
 *                 kernel: "6.14.11-mos"
 *               cpu:
 *                 manufacturer: "Intel"
 *                 brand: "Intel(R) Core(TM) i7-12700K"
 *                 cores: 12
 *                 physicalCores: 8
 *                 speed: 3.6
 *               memory:
 *                 total: 17179869184
 *                 used: 8589934592
 *                 actuallyUsed: 4294967296
 *                 percentage:
 *                   used: 50
 *                   actuallyUsed: 25
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
 *             example:
 *               error: "Error getting detailed system info: systeminformation module failed"
 */

// Detailed system information (admin only)
router.get('/detailed', checkRole(['admin']), async (req, res) => {
  try {
    const detailedInfo = await systemService.getDetailedInfo();
    res.json(detailedInfo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /system/load:
 *   get:
 *     summary: Get system load, temperature, memory and network utilization
 *     description: Retrieve current system load, temperature information including per-core metrics, detailed memory usage with installed/reserved memory and services breakdown (Docker/LXC/VMs/ZRAM), and network utilization for all interfaces (available to all authenticated users)
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: System load, temperature, memory and network information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 cpu:
 *                   type: object
 *                   properties:
 *                     load:
 *                       type: number
 *                       description: Overall CPU load percentage
 *                       example: 42.35
 *                     info:
 *                       type: object
 *                       properties:
 *                         brand:
 *                           type: string
 *                           description: CPU brand name
 *                           example: "Intel(R) Core(TM) i7-12700K"
 *                         manufacturer:
 *                           type: string
 *                           description: CPU manufacturer
 *                           example: "Intel"
 *                         totalCores:
 *                           type: integer
 *                           description: Total number of logical cores
 *                           example: 20
 *                         physicalCores:
 *                           type: integer
 *                           description: Number of physical cores
 *                           example: 12
 *                         logicalCores:
 *                           type: integer
 *                           description: Number of logical cores (same as totalCores)
 *                           example: 20
 *                         hyperThreadingEnabled:
 *                           type: boolean
 *                           description: Whether hyperthreading is enabled
 *                           example: true
 *                         architecture:
 *                           type: string
 *                           description: CPU architecture information
 *                           example: "Family 6, Model 151"
 *                     cores:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/CoreLoad'
 *                 temperature:
 *                   type: object
 *                   properties:
 *                     main:
 *                       type: number
 *                       description: Main CPU temperature in Celsius
 *                       example: 68.2
 *                     max:
 *                       type: number
 *                       description: Maximum core temperature
 *                       example: 72.1
 *                     min:
 *                       type: number
 *                       description: Minimum core temperature
 *                       example: 61.3
 *                     cores:
 *                       type: array
 *                       items:
 *                         type: number
 *                       description: Per-core temperatures
 *                       example: [65.5, 67.2, 72.1, 61.3, 69.8, 63.4, 70.1, 64.9]
 *                 memory:
 *                   $ref: '#/components/schemas/MemoryInfo'
 *                 swap:
 *                   $ref: '#/components/schemas/SwapInfo'
 *                 network:
 *                   type: object
 *                   properties:
 *                     interfaces:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           interface:
 *                             type: string
 *                             description: Interface name
 *                             example: "eth0"
 *                           type:
 *                             type: string
 *                             description: Interface type
 *                             example: "wired"
 *                           state:
 *                             type: string
 *                             description: Interface state
 *                             example: "up"
 *                           speed:
 *                             type: integer
 *                             description: Interface speed in Mbps
 *                             example: 1000
 *                           ip4:
 *                             type: string
 *                             description: IPv4 address
 *                             example: "192.168.1.100"
 *                           ip6:
 *                             type: string
 *                             description: IPv6 address
 *                             example: "fe80::1"
 *                           mac:
 *                             type: string
 *                             description: MAC address
 *                             example: "00:11:22:33:44:55"
 *                           statistics:
 *                             type: object
 *                             properties:
 *                               rx:
 *                                 type: object
 *                                 properties:
 *                                   bytes:
 *                                     type: integer
 *                                     description: Received bytes
 *                                     example: 1073741824
 *                                   bytes_human:
 *                                     type: string
 *                                     description: Received bytes in human readable format
 *                                     example: "1.00 GB"
 *                                   packets:
 *                                     type: integer
 *                                     description: Received packets
 *                                     example: 1048576
 *                                   errors:
 *                                     type: integer
 *                                     description: Receive errors
 *                                     example: 0
 *                                   dropped:
 *                                     type: integer
 *                                     description: Dropped received packets
 *                                     example: 0
 *                                   speed_bps:
 *                                     type: integer
 *                                     description: Current receive speed in bytes per second
 *                                     example: 1048576
 *                                   speed_human:
 *                                     type: string
 *                                     description: Current receive speed in human readable format
 *                                     example: "1.00 MB/s"
 *                               tx:
 *                                 type: object
 *                                 properties:
 *                                   bytes:
 *                                     type: integer
 *                                     description: Transmitted bytes
 *                                     example: 536870912
 *                                   bytes_human:
 *                                     type: string
 *                                     description: Transmitted bytes in human readable format
 *                                     example: "512.00 MB"
 *                                   packets:
 *                                     type: integer
 *                                     description: Transmitted packets
 *                                     example: 524288
 *                                   errors:
 *                                     type: integer
 *                                     description: Transmit errors
 *                                     example: 0
 *                                   dropped:
 *                                     type: integer
 *                                     description: Dropped transmitted packets
 *                                     example: 0
 *                                   speed_bps:
 *                                     type: integer
 *                                     description: Current transmit speed in bytes per second
 *                                     example: 524288
 *                                   speed_human:
 *                                     type: string
 *                                     description: Current transmit speed in human readable format
 *                                     example: "512.00 KB/s"
 *                               total:
 *                                 type: object
 *                                 properties:
 *                                   bytes:
 *                                     type: integer
 *                                     description: Total bytes (rx + tx)
 *                                     example: 1610612736
 *                                   bytes_human:
 *                                     type: string
 *                                     description: Total bytes in human readable format
 *                                     example: "1.50 GB"
 *                                   packets:
 *                                     type: integer
 *                                     description: Total packets (rx + tx)
 *                                     example: 1572864
 *                                   speed_bps:
 *                                     type: integer
 *                                     description: Total current speed in bytes per second
 *                                     example: 1572864
 *                                   speed_human:
 *                                     type: string
 *                                     description: Total current speed in human readable format
 *                                     example: "1.50 MB/s"
 *                     summary:
 *                       type: object
 *                       properties:
 *                         total_interfaces:
 *                           type: integer
 *                           description: Total number of interfaces
 *                           example: 3
 *                         active_interfaces:
 *                           type: integer
 *                           description: Number of active (up) interfaces
 *                           example: 2
 *                         totals:
 *                           type: object
 *                           properties:
 *                             rx:
 *                               type: object
 *                               properties:
 *                                 bytes:
 *                                   type: integer
 *                                   description: Total received bytes across all interfaces
 *                                   example: 2147483648
 *                                 bytes_human:
 *                                   type: string
 *                                   description: Total received bytes in human readable format
 *                                   example: "2.00 GB"
 *                                 packets:
 *                                   type: integer
 *                                   description: Total received packets
 *                                   example: 2097152
 *                                 speed_bps:
 *                                   type: integer
 *                                   description: Total current receive speed
 *                                   example: 2097152
 *                                 speed_human:
 *                                   type: string
 *                                   description: Total current receive speed in human readable format
 *                                   example: "2.00 MB/s"
 *                             tx:
 *                               type: object
 *                               properties:
 *                                 bytes:
 *                                   type: integer
 *                                   description: Total transmitted bytes across all interfaces
 *                                   example: 1073741824
 *                                 bytes_human:
 *                                   type: string
 *                                   description: Total transmitted bytes in human readable format
 *                                   example: "1.00 GB"
 *                                 packets:
 *                                   type: integer
 *                                   description: Total transmitted packets
 *                                   example: 1048576
 *                                 speed_bps:
 *                                   type: integer
 *                                   description: Total current transmit speed
 *                                   example: 1048576
 *                                 speed_human:
 *                                   type: string
 *                                   description: Total current transmit speed in human readable format
 *                                   example: "1.00 MB/s"
 *                             combined:
 *                               type: object
 *                               properties:
 *                                 bytes:
 *                                   type: integer
 *                                   description: Total combined bytes (rx + tx) across all interfaces
 *                                   example: 3221225472
 *                                 bytes_human:
 *                                   type: string
 *                                   description: Total combined bytes in human readable format
 *                                   example: "3.00 GB"
 *                                 packets:
 *                                   type: integer
 *                                   description: Total combined packets
 *                                   example: 3145728
 *                                 speed_bps:
 *                                   type: integer
 *                                   description: Total combined current speed
 *                                   example: 3145728
 *                                 speed_human:
 *                                   type: string
 *                                   description: Total combined current speed in human readable format
 *                                   example: "3.00 MB/s"
 *             example:
 *               cpu:
 *                 load: 42.35
 *                 info:
 *                   brand: "Intel(R) Core(TM) i7-12700K"
 *                   manufacturer: "Intel"
 *                   totalCores: 20
 *                   physicalCores: 12
 *                   logicalCores: 20
 *                   hyperThreadingEnabled: true
 *                   architecture: "Family 6, Model 151"
 *                 cores:
 *                   - number: 0
 *                     load:
 *                       total: 45.67
 *                     temperature: 65.5
 *                     isPhysical: true
 *                     isHyperThreaded: false
 *                     physicalCoreNumber: 0
 *                     coreArchitecture: "Performance"
 *                   - number: 1
 *                     load:
 *                       total: 38.92
 *                     temperature: 67.2
 *                     isPhysical: true
 *                     isHyperThreaded: false
 *                     physicalCoreNumber: 1
 *                     coreArchitecture: "Performance"
 *                   - number: 12
 *                     load:
 *                       total: 22.15
 *                     temperature: 63.1
 *                     isPhysical: false
 *                     isHyperThreaded: true
 *                     physicalCoreNumber: 0
 *                     coreArchitecture: "Performance"
 *               temperature:
 *                 main: 68.2
 *                 max: 72.1
 *                 min: 61.3
 *                 cores: [65.5, 67.2, 72.1, 61.3, 69.8, 63.4, 70.1, 64.9]
 *               memory:
 *                 installed: 137438953472
 *                 installed_human: "128.0 GiB"
 *                 reserved: 2583560192
 *                 reserved_human: "2.4 GiB"
 *                 total: 134855393280
 *                 total_human: "125.6 GiB"
 *                 free: 101748690944
 *                 free_human: "94.8 GiB"
 *                 used: 33106702336
 *                 used_human: "30.8 GiB"
 *                 breakdown:
 *                   system:
 *                     bytes: 4000000000
 *                     bytes_human: "3.7 GiB"
 *                     percentage: 3
 *                   docker:
 *                     bytes: 15000000000
 *                     bytes_human: "14.0 GiB"
 *                     percentage: 11
 *                   lxc:
 *                     bytes: 14000000000
 *                     bytes_human: "13.0 GiB"
 *                     percentage: 10
 *                   vms:
 *                     bytes: 0
 *                     bytes_human: "0 B"
 *                     percentage: 0
 *                 dirty:
 *                   free: 3138637824
 *                   used: 131716755456
 *                   dirtyCaches: 98610053120
 *                 percentage:
 *                   used: 98
 *                   actuallyUsed: 25
 *                   dirtyCaches: 73
 *               swap:
 *                 total: 8589934592
 *                 total_human: "8.0 GiB"
 *                 available: 8589934592
 *                 available_human: "8.0 GiB"
 *                 used: 0
 *                 used_human: "0 B"
 *                 percentage: 0
 *               network:
 *                 interfaces:
 *                   - interface: "eth0"
 *                     type: "wired"
 *                     state: "up"
 *                     speed: 1000
 *                     ip4: "192.168.1.100"
 *                     mac: "00:11:22:33:44:55"
 *                     statistics:
 *                       rx:
 *                         bytes: 1073741824
 *                         bytes_human: "1.00 GiB"
 *                         packets: 1048576
 *                         speed_bps: 1048576
 *                         speed_human: "1.00 MiB/s"
 *                       tx:
 *                         bytes: 536870912
 *                         bytes_human: "512.00 MiB"
 *                         packets: 524288
 *                         speed_bps: 524288
 *                         speed_human: "512.00 KiB/s"
 *                       total:
 *                         bytes: 1610612736
 *                         bytes_human: "1.50 GiB"
 *                         packets: 1572864
 *                         speed_bps: 1572864
 *                         speed_human: "1.50 MiB/s"
 *                 summary:
 *                   total_interfaces: 2
 *                   active_interfaces: 1
 *                   totals:
 *                     rx:
 *                       bytes: 1073741824
 *                       bytes_human: "1.00 GiB"
 *                       packets: 1048576
 *                       speed_bps: 1048576
 *                       speed_human: "1.00 MiB/s"
 *                     tx:
 *                       bytes: 536870912
 *                       bytes_human: "512.00 MiB"
 *                       packets: 524288
 *                       speed_bps: 524288
 *                       speed_human: "512.00 KiB/s"
 *                     combined:
 *                       bytes: 1610612736
 *                       bytes_human: "1.50 GiB"
 *                       packets: 1572864
 *                       speed_bps: 1572864
 *                       speed_human: "1.50 MiB/s"
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
 *             example:
 *               error: "Error getting system load: systeminformation module failed"
 */

// System load (available to all authenticated users)
router.get('/load', authenticateToken, async (req, res) => {
  try {
    const dashboardInterface = await mosService.getDashboardInterface();
    const loadInfo = await systemService.getSystemLoad(req.user, dashboardInterface);
    res.json(loadInfo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /system/power/reboot:
 *   post:
 *     summary: Reboot system
 *     description: Perform a system reboot (admin only). The system will shutdown and restart.
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Reboot initiated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OperationResult'
 *             example:
 *               message: "System reboot initiated"
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
 *         description: Reboot failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               reboot_failed:
 *                 summary: Reboot command failed
 *                 value:
 *                   error: "System reboot failed: insufficient privileges"
 *               system_busy:
 *                 summary: System too busy to reboot
 *                 value:
 *                   error: "System reboot failed: critical processes running"
 */

// Power Management Endpoints (admin only)
router.post('/power/reboot', checkRole(['admin']), async (req, res) => {
  try {
    const message = await systemService.rebootSystem();
    res.json({ message });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /system/power/shutdown:
 *   post:
 *     summary: Shutdown system
 *     description: Perform a graceful system shutdown (admin only). The system will halt after shutting down all services.
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Shutdown initiated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OperationResult'
 *             example:
 *               message: "System shutdown initiated"
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
 *         description: Shutdown failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               shutdown_failed:
 *                 summary: Shutdown command failed
 *                 value:
 *                   error: "System shutdown failed: insufficient privileges"
 *               system_busy:
 *                 summary: System too busy to shutdown
 *                 value:
 *                   error: "System shutdown failed: critical processes running"
 */

router.post('/power/shutdown', checkRole(['admin']), async (req, res) => {
  try {
    const message = await systemService.shutdownSystem();
    res.json({ message });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /system/proxy:
 *   get:
 *     summary: Get proxy settings
 *     description: Retrieve current proxy configuration from /boot/config/system/proxy.json (admin only)
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Proxy settings retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 http_proxy:
 *                   type: string
 *                   description: HTTP proxy URL
 *                   example: "http://proxy-server:8080"
 *                 https_proxy:
 *                   type: string
 *                   description: HTTPS proxy URL
 *                   example: "http://proxy-server:8080"
 *                 ftp_proxy:
 *                   type: string
 *                   description: FTP proxy URL
 *                   example: "http://proxy-server:8080"
 *                 no_proxy:
 *                   type: string
 *                   description: Comma-separated list of hosts to bypass proxy
 *                   example: "localhost,127.0.0.1,localaddress,.localdomain.com"
 *             examples:
 *               with_proxy:
 *                 summary: System with proxy configured
 *                 value:
 *                   http_proxy: "http://proxy-server:8080"
 *                   https_proxy: "http://proxy-server:8080"
 *                   ftp_proxy: "http://proxy-server:8080"
 *                   no_proxy: "localhost,127.0.0.1,localaddress,.localdomain.com"
 *               no_proxy:
 *                 summary: System without proxy
 *                 value: {}
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
 *             example:
 *               error: "Error reading proxy settings: Permission denied"
 */

router.get('/proxy', checkRole(['admin']), async (req, res) => {
  try {
    const proxySettings = await systemService.getProxySettings();
    res.json(proxySettings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /system/proxy:
 *   put:
 *     summary: Update proxy settings
 *     description: Update proxy configuration in /boot/config/system/proxy.json. Supports partial updates - you can update individual fields or all at once (admin only)
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               http_proxy:
 *                 type: string
 *                 description: HTTP proxy URL
 *                 example: "http://proxy-server:8080"
 *               https_proxy:
 *                 type: string
 *                 description: HTTPS proxy URL
 *                 example: "http://proxy-server:8080"
 *               ftp_proxy:
 *                 type: string
 *                 description: FTP proxy URL
 *                 example: "http://proxy-server:8080"
 *               no_proxy:
 *                 type: string
 *                 description: Comma-separated list of hosts to bypass proxy
 *                 example: "localhost,127.0.0.1,localaddress,.localdomain.com"
 *           examples:
 *             full_update:
 *               summary: Update all proxy settings
 *               value:
 *                 http_proxy: "http://proxy-server:8080"
 *                 https_proxy: "http://proxy-server:8080"
 *                 ftp_proxy: "http://proxy-server:8080"
 *                 no_proxy: "localhost,127.0.0.1,localaddress,.localdomain.com"
 *             partial_update:
 *               summary: Update only HTTP proxy
 *               value:
 *                 http_proxy: "http://new-proxy:3128"
 *             disable_proxy:
 *               summary: Clear proxy settings
 *               value:
 *                 http_proxy: ""
 *                 https_proxy: ""
 *                 ftp_proxy: ""
 *                 no_proxy: ""
 *     responses:
 *       200:
 *         description: Proxy settings updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 http_proxy:
 *                   type: string
 *                   description: HTTP proxy URL
 *                   example: "http://proxy-server:8080"
 *                 https_proxy:
 *                   type: string
 *                   description: HTTPS proxy URL
 *                   example: "http://proxy-server:8080"
 *                 ftp_proxy:
 *                   type: string
 *                   description: FTP proxy URL
 *                   example: "http://proxy-server:8080"
 *                 no_proxy:
 *                   type: string
 *                   description: Comma-separated list of hosts to bypass proxy
 *                   example: "localhost,127.0.0.1,localaddress,.localdomain.com"
 *             example:
 *               http_proxy: "http://proxy-server:8080"
 *               https_proxy: "http://proxy-server:8080"
 *               ftp_proxy: "http://proxy-server:8080"
 *               no_proxy: "localhost,127.0.0.1,localaddress,.localdomain.com"
 *       400:
 *         description: Invalid proxy field provided
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Invalid proxy field: invalid_field. Allowed fields: http_proxy, https_proxy, ftp_proxy, no_proxy"
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
 *             example:
 *               error: "Error updating proxy settings: Permission denied"
 */

router.put('/proxy', checkRole(['admin']), async (req, res) => {
  try {
    const updatedSettings = await systemService.updateProxySettings(req.body);
    res.json(updatedSettings);
  } catch (error) {
    if (error.message.includes('Invalid proxy field')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /system/keymaps:
 *   get:
 *     summary: List available keymaps
 *     description: Retrieve a list of all available keyboard layouts/keymaps (admin only)
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Keymaps retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   name:
 *                     type: string
 *                     description: Keymap name
 *                     example: "de"
 *                   description:
 *                     type: string
 *                     description: Keymap description
 *                     example: "German"
 *             example:
 *               - name: "us"
 *                 description: "US English"
 *               - name: "de"
 *                 description: "German"
 *               - name: "fr"
 *                 description: "French"
 *               - name: "es"
 *                 description: "Spanish"
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
router.get('/keymaps', checkRole(['admin']), async (req, res) => {
  try {
    const keymaps = await mosService.listKeymaps();
    res.json(keymaps);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /system/timezones:
 *   get:
 *     summary: List available timezones
 *     description: Retrieve a list of all available system timezones (admin only)
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Timezones retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   name:
 *                     type: string
 *                     description: Timezone identifier
 *                     example: "Europe/Berlin"
 *                   description:
 *                     type: string
 *                     description: Timezone description
 *                     example: "Central European Time"
 *             example:
 *               - name: "Europe/Berlin"
 *                 description: "Central European Time"
 *               - name: "America/New_York"
 *                 description: "Eastern Standard Time"
 *               - name: "Asia/Tokyo"
 *                 description: "Japan Standard Time"
 *               - name: "UTC"
 *                 description: "Coordinated Universal Time"
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
router.get('/timezones', checkRole(['admin']), async (req, res) => {
  try {
    const timezones = await mosService.listTimezones();
    res.json(timezones);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /system/governors:
 *   get:
 *     summary: Get available CPU governors
 *     description: Get list of available CPU frequency governors from the system (admin only)
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of available CPU governors
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: string
 *               example: ["ondemand", "performance", "powersave", "conservative", "userspace"]
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
router.get('/governors', checkRole(['admin']), async (req, res) => {
  try {
    const governors = await mosService.getAvailableGovernors();
    res.json(governors);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /system/logs:
 *   get:
 *     summary: List all log files
 *     description: Retrieve a simple array of log file paths in /var/log recursively. Excludes empty files (admin only)
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Log files list retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: string
 *                 description: Relative path from /var/log
 *             example:
 *               - "alternatives.log"
 *               - "apt/history.log"
 *               - "apt/term.log"
 *               - "auth.log"
 *               - "dpkg.log"
 *               - "kern.log"
 *               - "nginx/access.log"
 *               - "nginx/error.log"
 *               - "syslog"
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
 *             example:
 *               error: "Error listing log files: Permission denied"
 */
router.get('/logs', checkRole(['admin']), async (req, res) => {
  try {
    const logs = await systemService.listLogFiles();
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /system/logs/content:
 *   get:
 *     summary: Read log file content
 *     description: Read content of a specific log file from /var/log. Supports reading from start or end of file (admin only)
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Relative path to log file from /var/log
 *         example: "syslog"
 *       - in: query
 *         name: lines
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 1000000
 *           default: 100
 *         description: Number of lines to read (max 1000000)
 *         example: 100
 *       - in: query
 *         name: tail
 *         required: false
 *         schema:
 *           type: boolean
 *           default: true
 *         description: Read from end of file (true) or start (false)
 *         example: true
 *     responses:
 *       200:
 *         description: Log file content retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 path:
 *                   type: string
 *                   description: Relative path to log file
 *                   example: "syslog"
 *                 full_path:
 *                   type: string
 *                   description: Full path to log file
 *                   example: "/var/log/syslog"
 *                 size:
 *                   type: integer
 *                   description: File size in bytes
 *                   example: 1048576
 *                 size_human:
 *                   type: string
 *                   description: Human readable file size
 *                   example: "1.0 MiB"
 *                 modified:
 *                   type: string
 *                   format: date-time
 *                   description: Last modification time
 *                   example: "2025-10-06T10:30:00.000Z"
 *                 lines_requested:
 *                   type: integer
 *                   description: Number of lines requested
 *                   example: 100
 *                 lines_returned:
 *                   type: integer
 *                   description: Number of lines returned
 *                   example: 100
 *                 content:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Array of log lines
 *                   example: ["Oct  6 10:30:01 server systemd[1]: Started Session 123.", "Oct  6 10:30:15 server kernel: [12345.678] USB disconnect"]
 *             example:
 *               path: "syslog"
 *               full_path: "/var/log/syslog"
 *               size: 1048576
 *               size_human: "1.0 MiB"
 *               modified: "2025-10-06T10:30:00.000Z"
 *               lines_requested: 100
 *               lines_returned: 100
 *               content:
 *                 - "Oct  6 10:30:01 server systemd[1]: Started Session 123."
 *                 - "Oct  6 10:30:15 server kernel: [12345.678] USB disconnect"
 *       400:
 *         description: Invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               missing_path:
 *                 summary: Missing path parameter
 *                 value:
 *                   error: "Path parameter is required"
 *               invalid_path:
 *                 summary: Invalid path
 *                 value:
 *                   error: "Invalid log path: Path must be within /var/log"
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
 *         description: Log file not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Log file not found"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Error reading log file: Permission denied"
 */
router.get('/logs/content', checkRole(['admin']), async (req, res) => {
  try {
    const { path, lines, tail } = req.query;

    if (!path) {
      return res.status(400).json({ error: 'Path parameter is required' });
    }

    const linesNum = lines ? parseInt(lines, 10) : 100;
    const tailBool = tail === 'false' ? false : true;

    const content = await systemService.readLogFile(path, linesNum, tailBool);
    res.json(content);
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else if (error.message.includes('Invalid log path')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * @swagger
 * /system/devices/pci:
 *   get:
 *     summary: Get PCI devices information
 *     description: |
 *       Retrieve detailed information about all PCI devices by parsing lspci output.
 *
 *       **Data Structure:**
 *       - Basic device info comes from `lspci -vmm -nn` (structured, reliable)
 *       - Detailed hierarchical data comes from `lspci -vvv -nn` (parsed by indentation)
 *
 *       **Details Object:**
 *       The `details` object contains a hierarchical structure where:
 *       - Keys from lspci output become object properties
 *       - Values are either strings, objects with nested properties, or arrays (for duplicate keys)
 *       - Lines without keys are stored in `_raw` arrays
 *       - Structure follows the indentation hierarchy of lspci output
 *
 *       This format is fully generic and automatically adapts to any changes in lspci output.
 *
 *       (Admin only)
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: PCI devices information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   slot:
 *                     type: string
 *                     description: PCI slot identifier (bus:device.function)
 *                     example: "01:00.0"
 *                   class:
 *                     type: string
 *                     description: Device class name
 *                     example: "VGA compatible controller"
 *                   class_id:
 *                     type: string
 *                     description: Device class ID (hexadecimal)
 *                     example: "0300"
 *                   vendor:
 *                     type: string
 *                     description: Vendor name
 *                     example: "NVIDIA Corporation"
 *                   vendor_id:
 *                     type: string
 *                     description: Vendor ID (hexadecimal)
 *                     example: "10de"
 *                   name:
 *                     type: string
 *                     description: Device name
 *                     example: "TU117GLM [Quadro T400 Mobile]"
 *                   device_id:
 *                     type: string
 *                     description: Device ID (hexadecimal)
 *                     example: "1fb2"
 *                   revision:
 *                     type: string
 *                     description: Device revision (hexadecimal)
 *                     example: "a1"
 *                   subsystem_vendor:
 *                     type: string
 *                     description: Subsystem vendor name
 *                     example: "NVIDIA Corporation"
 *                   subsystem_vendor_id:
 *                     type: string
 *                     description: Subsystem vendor ID
 *                     example: "10de"
 *                   subsystem:
 *                     type: string
 *                     description: Subsystem device name
 *                     example: "TU117GLM [Quadro T400 Mobile]"
 *                   subsystem_device_id:
 *                     type: string
 *                     description: Subsystem device ID
 *                     example: "1489"
 *                   subsystem_id:
 *                     type: string
 *                     description: Combined subsystem ID (vendor:device)
 *                     example: "10de:1489"
 *                   prog_if:
 *                     type: string
 *                     description: Programming interface
 *                     example: "00"
 *                   details:
 *                     type: object
 *                     description: |
 *                       Dynamically parsed details from lspci -vv output.
 *                       Keys are extracted from the output (e.g., "Subsystem", "Flags", "I/O ports at", "Memory at", "Capabilities", "Kernel driver in use").
 *                       Values can be strings or arrays (if the same key appears multiple times).
 *                     additionalProperties: true
 *                     example:
 *                       Subsystem: "Marvell Technology Group Ltd. 88SE9215 PCIe 2.0 x1 4-port SATA 6 Gb/s Controller"
 *                       Flags: "bus master, fast devsel, latency 0, IRQ 37"
 *                       I/O ports at:
 *                         - "c050 [size=8]"
 *                         - "c040 [size=4]"
 *                         - "c030 [size=8]"
 *                         - "c020 [size=4]"
 *                         - "c000 [size=32]"
 *                       Memory at:
 *                         - "f7a10000 (32-bit, non-prefetchable) [size=2K]"
 *                       Expansion ROM at: "f7a00000 [disabled] [size=64K]"
 *                       Capabilities:
 *                         - "[40] Power Management version 3"
 *                         - "[50] MSI: Enable+ Count=1/1 Maskable- 64bit-"
 *                         - "[70] Express Legacy Endpoint, MSI 00"
 *                         - "[e0] SATA HBA v0.0"
 *                         - "[100] Advanced Error Reporting"
 *                       Kernel driver in use: "ahci"
 *             example:
 *               - slot: "06:00.0"
 *                 class: "SATA controller"
 *                 class_id: "0106"
 *                 vendor: "Marvell Technology Group Ltd."
 *                 vendor_id: "1b4b"
 *                 name: "88SE9215 PCIe 2.0 x1 4-port SATA 6 Gb/s Controller"
 *                 device_id: "9215"
 *                 revision: "11"
 *                 subsystem_vendor: "Marvell Technology Group Ltd."
 *                 subsystem_vendor_id: "1b4b"
 *                 subsystem: "88SE9215 PCIe 2.0 x1 4-port SATA 6 Gb/s Controller"
 *                 subsystem_device_id: "9215"
 *                 subsystem_id: "1b4b:9215"
 *                 prog_if: "01"
 *                 details:
 *                   Subsystem: "Marvell Technology Group Ltd. 88SE9215 PCIe 2.0 x1 4-port SATA 6 Gb/s Controller"
 *                   Flags: "bus master, fast devsel, latency 0, IRQ 37"
 *                   I/O ports at:
 *                     - "c050 [size=8]"
 *                     - "c040 [size=4]"
 *                     - "c030 [size=8]"
 *                     - "c020 [size=4]"
 *                     - "c000 [size=32]"
 *                   Memory at:
 *                     - "f7a10000 (32-bit, non-prefetchable) [size=2K]"
 *                   Expansion ROM at: "f7a00000 [disabled] [size=64K]"
 *                   Capabilities:
 *                     - "[40] Power Management version 3"
 *                     - "[50] MSI: Enable+ Count=1/1 Maskable- 64bit-"
 *                     - "[70] Express Legacy Endpoint, MSI 00"
 *                     - "[e0] SATA HBA v0.0"
 *                     - "[100] Advanced Error Reporting"
 *                   Kernel driver in use: "ahci"
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
 *             example:
 *               error: "Error getting PCI devices: lspci command not found"
 */
router.get('/devices/pci', checkRole(['admin']), async (req, res) => {
  try {
    const devices = await systemService.getPciDevices();
    res.json(devices);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /system/devices/usb:
 *   get:
 *     summary: Get USB devices information
 *     description: |
 *       Retrieve detailed information about all USB devices by parsing lsusb output.
 *
 *       **Data Structure:**
 *       - Basic device info comes from `lsusb` (bus, device, vendor_id, product_id, description)
 *       - Detailed hierarchical data comes from `lsusb -v` (parsed by indentation)
 *
 *       **Details Object:**
 *       The `details` object contains a hierarchical structure where:
 *       - Keys from lsusb output become object properties
 *       - Values are either strings, objects with nested properties, or arrays (for duplicate keys)
 *       - Structure follows the indentation hierarchy of lsusb output
 *       - Elements with children have a `value` property containing the header line
 *
 *       This format is fully generic and automatically adapts to any changes in lsusb output.
 *
 *       (Admin only)
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: USB devices information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   bus:
 *                     type: string
 *                     description: USB bus number
 *                     example: "002"
 *                   device:
 *                     type: string
 *                     description: Device number on bus
 *                     example: "001"
 *                   vendor_id:
 *                     type: string
 *                     description: USB vendor ID (hexadecimal)
 *                     example: "1d6b"
 *                   product_id:
 *                     type: string
 *                     description: USB product ID (hexadecimal)
 *                     example: "0002"
 *                   description:
 *                     type: string
 *                     description: Device description
 *                     example: "Linux Foundation 2.0 root hub"
 *                   details:
 *                     type: object
 *                     description: |
 *                       Hierarchical structure parsed from lsusb -v output.
 *                       Keys are dynamically determined from lsusb output.
 *                       Common keys include: Device Descriptor, Configuration Descriptor, Interface Descriptor, Endpoint Descriptor, Hub Descriptor, Device Status.
 *
 *                       Objects may contain:
 *                       - Simple string values
 *                       - Nested objects (for items with sub-details)
 *                       - Arrays (for duplicate keys like multiple Descriptors)
 *                       - value property (when an item has both a value and children)
 *                     additionalProperties: true
 *             example:
 *               - bus: "002"
 *                 device: "001"
 *                 vendor_id: "1d6b"
 *                 product_id: "0002"
 *                 description: "Linux Foundation 2.0 root hub"
 *                 details:
 *                   Device Descriptor:
 *                     bLength: "18"
 *                     bDescriptorType: "1"
 *                     bcdUSB: "2.00"
 *                     bDeviceClass: "9 Hub"
 *                     bMaxPacketSize0: "64"
 *                     idVendor: "0x1d6b Linux Foundation"
 *                     idProduct: "0x0002 2.0 root hub"
 *                     iManufacturer: "3 Linux 6.17.4-mos xhci-hcd"
 *                     bNumConfigurations: "1"
 *                   Configuration Descriptor:
 *                     value: ""
 *                     bLength: "9"
 *                     bDescriptorType: "2"
 *                     wTotalLength: "0x0019"
 *                     bNumInterfaces: "1"
 *                     bmAttributes: "0xe0\nSelf Powered\nRemote Wakeup"
 *                     Interface Descriptor:
 *                       value: ""
 *                       bLength: "9"
 *                       bInterfaceNumber: "0"
 *                       bInterfaceClass: "9 Hub"
 *                   Hub Descriptor:
 *                     bLength: "11"
 *                     bDescriptorType: "41"
 *                     nNbrPorts: "14"
 *                     wHubCharacteristic: "0x000a\nNo power switching (usb 1.0)\nPer-port overcurrent protection"
 *                   Device Status: "0x0001\nSelf Powered"
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
 *             example:
 *               error: "Error getting USB devices: lsusb command not found"
 */
router.get('/devices/usb', checkRole(['admin']), async (req, res) => {
  try {
    const devices = await systemService.getUsbDevices();
    res.json(devices);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /system/gpus:
 *   get:
 *     summary: Get GPU information
 *     description: Returns information about all GPUs in the system grouped by vendor (Intel, AMD, NVIDIA)
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: GPU information by vendor
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 Intel:
 *                   type: array
 *                   nullable: true
 *                   items:
 *                     type: object
 *                     properties:
 *                       vendor:
 *                         type: string
 *                         example: "Intel"
 *                       name:
 *                         type: string
 *                         example: "Intel Corporation Xeon E3-1200 v3/4th Gen Core Processor Integrated Graphics Controller(rev 06)"
 *                       vendor_id:
 *                         type: string
 *                         example: "8086"
 *                       device_id:
 *                         type: string
 *                         example: "0412"
 *                       pci:
 *                         type: string
 *                         example: "00:02.0"
 *                       card:
 *                         type: string
 *                         example: "/dev/dri/card0"
 *                       render:
 *                         type: string
 *                         example: "/dev/dri/renderD128"
 *                 AMD:
 *                   type: array
 *                   nullable: true
 *                   items:
 *                     type: object
 *                 NVIDIA:
 *                   type: array
 *                   nullable: true
 *                   items:
 *                     type: object
 *                     properties:
 *                       vendor:
 *                         type: string
 *                         example: "NVIDIA"
 *                       name:
 *                         type: string
 *                         example: "NVIDIA Corporation TU117GLM [Quadro T400 Mobile](rev a1)"
 *                       vendor_id:
 *                         type: string
 *                         example: "10de"
 *                       device_id:
 *                         type: string
 *                         example: "1fb2"
 *                       pci:
 *                         type: string
 *                         example: "01:00.0"
 *                       uuid:
 *                         type: string
 *                         example: "GPU-09e16239-57bc-2ca8-39ca-c72ed08bac48"
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
 *             example:
 *               error: "Error getting GPUs: mos-get_gpus command not found"
 */
router.get('/gpus', checkRole(['admin']), async (req, res) => {
  try {
    const gpus = await systemService.getGpus();
    res.json(gpus);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /system/sensors:
 *   get:
 *     summary: Get hardware sensor data
 *     description: Retrieve hardware sensor data from lm-sensors (temperatures, voltages, fan speeds, etc.)
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Sensor data retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: Raw JSON output from sensors command, structure depends on installed sensors
 *             example:
 *               coretemp-isa-0000:
 *                 Adapter: "ISA adapter"
 *                 Core 0:
 *                   temp2_input: 45.000
 *                   temp2_max: 100.000
 *                   temp2_crit: 100.000
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
 *             example:
 *               error: "Error getting sensors: sensors command not found"
 */
router.get('/sensors', authenticateToken, async (req, res) => {
  try {
    const sensors = await systemService.getSensors();
    res.json(sensors);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /system/timedate:
 *   get:
 *     summary: Get current system date and time
 *     description: Retrieve the current system date and time
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current date and time retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 date:
 *                   type: string
 *                   description: Date in YYYY-MM-DD format
 *                   example: "2026-01-06"
 *                 time:
 *                   type: string
 *                   description: Time in HH:MM:SS format
 *                   example: "12:01:00"
 *       401:
 *         description: Not authenticated
 *       500:
 *         description: Server error
 */
router.get('/timedate', authenticateToken, async (req, res) => {
  try {
    const dateTime = await systemService.getDateTime();
    res.json(dateTime);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /system/timedate:
 *   put:
 *     summary: Set system date and/or time
 *     description: Set the system date and/or time. At least one of date or time must be provided. Requires admin privileges.
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               date:
 *                 type: string
 *                 description: Date in YYYY-MM-DD format
 *                 example: "2026-01-06"
 *               time:
 *                 type: string
 *                 description: Time in HH:MM or HH:MM:SS format
 *                 example: "12:30:00"
 *           examples:
 *             both:
 *               summary: Set both date and time
 *               value:
 *                 date: "2026-01-06"
 *                 time: "12:30:00"
 *             dateOnly:
 *               summary: Set only date
 *               value:
 *                 date: "2026-01-06"
 *             timeOnly:
 *               summary: Set only time
 *               value:
 *                 time: "12:30:00"
 *     responses:
 *       200:
 *         description: Date/time set successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *       400:
 *         description: Invalid request (missing or invalid date/time format)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               missing:
 *                 value:
 *                   error: "Either date or time must be provided"
 *               invalidDate:
 *                 value:
 *                   error: "Invalid date format. Use YYYY-MM-DD"
 *               invalidTime:
 *                 value:
 *                   error: "Invalid time format. Use HH:MM or HH:MM:SS"
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
router.put('/timedate', checkRole(['admin']), async (req, res) => {
  try {
    const { date, time } = req.body;
    const result = await systemService.setDateTime({ date, time });
    res.json(result);
  } catch (error) {
    if (error.message.includes('must be provided') || error.message.includes('Invalid')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

module.exports = router;