const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth.middleware');

/**
 * @swagger
 * tags:
 *   name: Pools WebSocket
 *   description: Real-time pool monitoring via WebSocket
 *
 * components:
 *   schemas:
 *     WebSocketPoolsSubscription:
 *       type: object
 *       properties:
 *         interval:
 *           type: number
 *           description: Update interval in milliseconds
 *           default: 30000
 *           example: 30000
 *         token:
 *           type: string
 *           description: JWT authentication token
 *           example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
 *         includePerformance:
 *           type: boolean
 *           description: Include real-time I/O throughput metrics (read/write speed per pool)
 *           default: false
 *           example: true
 *         filters:
 *           type: object
 *           description: Pool filters (same as REST API GET /pools)
 *           properties:
 *             id:
 *               type: string
 *               description: Specific pool ID to monitor
 *               example: "1746318722394"
 *             type:
 *               type: string
 *               enum: [mergerfs, nonraid, btrfs, bcachefs, single]
 *               description: Filter by pool type
 *               example: "mergerfs"
 *             exclude_type:
 *               type: string
 *               enum: [mergerfs, nonraid, btrfs, bcachefs, single]
 *               description: Exclude pools of specific type
 *               example: "btrfs"
 *     WebSocketPoolsPerformance:
 *       type: object
 *       properties:
 *         pools:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               poolId:
 *                 type: string
 *                 example: "tank"
 *               poolName:
 *                 type: string
 *                 example: "tank"
 *               performance:
 *                 type: object
 *                 properties:
 *                   readSpeed:
 *                     type: number
 *                     description: Read speed in bytes/s
 *                     example: 157286400
 *                   writeSpeed:
 *                     type: number
 *                     description: Write speed in bytes/s
 *                     example: 31457280
 *                   readSpeed_human:
 *                     type: string
 *                     description: Human-readable read speed
 *                     example: "150 MiB/s"
 *                   writeSpeed_human:
 *                     type: string
 *                     description: Human-readable write speed
 *                     example: "30 MiB/s"
 *                   readBytes_total:
 *                     type: number
 *                     description: Total bytes read since boot
 *                   writeBytes_total:
 *                     type: number
 *                     description: Total bytes written since boot
 *                   disks:
 *                     type: array
 *                     description: Per-disk throughput breakdown
 *                     items:
 *                       type: object
 *                       properties:
 *                         device:
 *                           type: string
 *                           example: "sda"
 *                         readSpeed:
 *                           type: number
 *                         writeSpeed:
 *                           type: number
 *         timestamp:
 *           type: number
 *           example: 1702296720000
 *     WebSocketPoolsUpdate:
 *       type: array
 *       description: Array of pools (identical structure to GET /pools response)
 *       items:
 *         $ref: '#/components/schemas/Pool'
 *
 * /pools/websocket/stats:
 *   get:
 *     summary: Get WebSocket monitoring statistics
 *     tags: [Pools WebSocket]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: WebSocket monitoring statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     activeSubscriptions:
 *                       type: number
 *                       description: Number of active monitoring subscriptions
 *                       example: 2
 *                     cachedPools:
 *                       type: number
 *                       description: Number of cached pool datasets
 *                       example: 3
 *                     subscriptions:
 *                       type: array
 *                       description: Details of active subscriptions
 *                       items:
 *                         type: object
 *                         properties:
 *                           filters:
 *                             type: object
 *                             description: Applied filters for this subscription
 *                             example: {"type": "mergerfs"}
 *                           clientCount:
 *                             type: number
 *                             description: Number of connected clients
 *                             example: 1
 *                           interval:
 *                             type: number
 *                             description: Update interval in milliseconds
 *                             example: 30000
 *                           uptime:
 *                             type: number
 *                             description: Subscription uptime in milliseconds
 *                             example: 120000
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal server error
 *
 * /pools/websocket/events:
 *   get:
 *     summary: WebSocket Events Documentation
 *     description: |
 *       This endpoint documents the WebSocket events for real-time pool monitoring.
 *
 *       **Connection:** Connect to WebSocket at `/api/v1/pools` namespace
 *
 *       **Events to emit (client → server):**
 *
 *       - `subscribe-pools`: Subscribe to pool updates with filters
 *       - `unsubscribe-pools`: Unsubscribe from pool updates
 *       - `get-pools`: Get immediate pool data (one-time)
 *
 *       **Events to listen for (server → client):**
 *
 *       - `pools-update`: Real-time pool data updates
 *       - `pools-performance-update`: Real-time I/O throughput (if includePerformance=true, every 2s)
 *       - `pools-error`: Error messages
 *       - `pools-subscription-confirmed`: Subscription confirmation
 *       - `pools-unsubscription-confirmed`: Unsubscription confirmation
 *       - `error`: General error messages
 *
 *       **Example Usage:**
 *
 *       Connect to WebSocket:
 *       ```
 *       const socket = io('http://localhost:3000/api/v1/pools', {
 *         path: '/socket.io/'
 *       });
 *       ```
 *
 *       Subscribe to all MergerFS pools:
 *       ```
 *       socket.emit('subscribe-pools', {
 *         token: 'your-jwt-token',
 *         interval: 30000,
 *         filters: { type: 'mergerfs' }
 *       });
 *       ```
 *
 *       Listen for updates:
 *       ```
 *       socket.on('pools-update', (data) => {
 *         console.log('Pools updated:', data.pools);
 *       });
 *       ```
 *     tags: [Pools WebSocket]
 *     responses:
 *       200:
 *         description: WebSocket events documentation
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 events:
 *                   type: object
 *                   properties:
 *                     client_to_server:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           event:
 *                             type: string
 *                           description:
 *                             type: string
 *                           payload:
 *                             $ref: '#/components/schemas/WebSocketPoolsSubscription'
 *                     server_to_client:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           event:
 *                             type: string
 *                           description:
 *                             type: string
 *                           payload:
 *                             $ref: '#/components/schemas/WebSocketPoolsUpdate'
 */
// WebSocket Events Documentation Endpoint
router.get('/websocket/events', (req, res) => {
  res.json({
    events: {
      client_to_server: [
        {
          event: 'subscribe-pools',
          description: 'Subscribe to real-time pool updates with optional filters and performance metrics',
          payload: {
            interval: 30000,
            token: 'JWT token',
            includePerformance: 'boolean (optional, default: false) - Enable I/O throughput monitoring',
            filters: {
              id: 'specific-pool-id (optional)',
              type: 'mergerfs|nonraid|btrfs|bcachefs|single (optional)',
              exclude_type: 'mergerfs|nonraid|btrfs|bcachefs|single (optional)'
            }
          }
        },
        {
          event: 'unsubscribe-pools',
          description: 'Unsubscribe from pool updates',
          payload: {}
        },
        {
          event: 'get-pools',
          description: 'Get immediate pool data (one-time request)',
          payload: {
            token: 'JWT token',
            filters: 'Same as subscribe-pools'
          }
        }
      ],
      server_to_client: [
        {
          event: 'pools-update',
          description: 'Real-time pool data updates (identical to GET /pools response)',
          payload: 'Array of pool objects (same as GET /pools)'
        },
        {
          event: 'pools-performance-update',
          description: 'Real-time I/O throughput for pools (sent every 2s if includePerformance=true)',
          payload: {
            pools: 'Array of { poolId, poolName, performance: { readSpeed, writeSpeed, disks: [...] } }',
            timestamp: 'Unix timestamp'
          }
        },
        {
          event: 'pools-subscription-confirmed',
          description: 'Confirmation of successful subscription',
          payload: {
            interval: 'Update interval',
            filters: 'Applied filters',
            includePerformance: 'Whether performance monitoring is enabled',
            performanceInterval: 'Performance update interval (2000ms if enabled)'
          }
        },
        {
          event: 'pools-unsubscription-confirmed',
          description: 'Confirmation of successful unsubscription'
        },
        {
          event: 'error',
          description: 'General error messages'
        }
      ]
    },
    examples: {
      subscribe_all_pools: {
        event: 'subscribe-pools',
        data: {
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
          interval: 30000,
          filters: {}
        }
      },
      subscribe_mergerfs_pools: {
        event: 'subscribe-pools',
        data: {
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
          interval: 30000,
          filters: { type: 'mergerfs' }
        }
      },
      subscribe_specific_pool: {
        event: 'subscribe-pools',
        data: {
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
          interval: 30000,
          filters: { id: '1746318722394' }
        }
      }
    }
  });
});

router.get('/websocket/stats', authenticateToken, async (req, res) => {
  try {
    // Get WebSocket manager instance from app locals
    const poolWebSocketManager = req.app.locals.poolWebSocketManager;

    if (!poolWebSocketManager) {
      return res.status(500).json({
        success: false,
        message: 'WebSocket manager not initialized'
      });
    }

    const stats = poolWebSocketManager.getMonitoringStats();

    // Update stats structure to match new simplified system
    const updatedStats = {
      ...stats,
      subscriptions: stats.subscriptions.map(sub => ({
        filters: sub.filters || {},
        clientCount: sub.clientCount,
        interval: sub.interval,
        uptime: sub.uptime
      }))
    };

    res.json({
      success: true,
      data: stats
    });

  } catch (error) {
    console.error('Error getting WebSocket stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get WebSocket statistics',
      error: error.message
    });
  }
});

module.exports = router;
