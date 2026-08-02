const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth.middleware');

/**
 * @swagger
 * components:
 *   schemas:
 *     NutStatusSubscription:
 *       type: object
 *       properties:
 *         token:
 *           type: string
 *           description: JWT authentication token (admin only)
 *           example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
 *     NutStatusUpdate:
 *       type: object
 *       description: UPS status (same structure as GET /nut/status) plus a timestamp
 *       properties:
 *         reachable:
 *           type: boolean
 *           description: False when NUT is disabled or upsd could not be queried
 *           example: true
 *         name:
 *           type: string
 *           nullable: true
 *           example: "ups"
 *         status:
 *           type: string
 *           nullable: true
 *           description: Raw ups.status flags, e.g. OL, OB, LB
 *           example: "OL"
 *         data:
 *           type: object
 *           description: Fixed, always-present subset of the common values (null when not reported)
 *         vars:
 *           type: object
 *           description: Complete raw upsc key/value map (all values are strings)
 *           additionalProperties:
 *             type: string
 *         timestamp:
 *           type: integer
 *           description: Unix timestamp in milliseconds
 *           example: 1234567890123
 */

/**
 * @swagger
 * /nut/websocket/events:
 *   get:
 *     summary: WebSocket Events Documentation
 *     description: |
 *       This endpoint documents the WebSocket events for real-time NUT/UPS status monitoring.
 *
 *       **Connection:** Connect to WebSocket at `/api/v1/nut` namespace
 *
 *       **Authorization:** Admin only. Non-admin users are rejected; admin API tokens
 *       additionally need `read` permission for the `nut` resource.
 *
 *       **Events to emit (client → server):**
 *
 *       - `subscribe-nut-status`: Subscribe to UPS status updates
 *       - `unsubscribe-nut-status`: Unsubscribe from UPS status updates
 *       - `get-nut-status`: Get immediate UPS status (one-time)
 *
 *       **Events to listen for (server → client):**
 *
 *       - `nut-status-update`: Real-time UPS status (every 5s)
 *       - `nut-status-subscription-confirmed`: Subscription confirmation
 *       - `nut-status-unsubscription-confirmed`: Unsubscription confirmation
 *       - `error`: General error messages
 *
 *       **Example Usage:**
 *
 *       Connect to WebSocket:
 *       ```javascript
 *       const socket = io('http://localhost:3000/api/v1/nut', {
 *         path: '/api/v1/socket.io/'
 *       });
 *       ```
 *
 *       Subscribe to UPS status:
 *       ```javascript
 *       socket.emit('subscribe-nut-status', { token: 'your-jwt-token' });
 *       ```
 *
 *       Listen for updates:
 *       ```javascript
 *       socket.on('nut-status-update', (data) => {
 *         console.log('UPS status:', data.status, data.data);
 *       });
 *       ```
 *     tags: [NUT WebSocket]
 *     responses:
 *       200:
 *         description: WebSocket events documentation
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 namespace:
 *                   type: string
 *                   example: "/api/v1/nut"
 *                 events:
 *                   type: object
 */

// WebSocket Events Documentation Endpoint
router.get('/websocket/events', (req, res) => {
  res.json({
    namespace: '/api/v1/nut',
    description: 'Real-time NUT/UPS status monitoring via WebSocket',
    events: {
      client_to_server: [
        {
          event: 'subscribe-nut-status',
          description: 'Subscribe to real-time UPS status updates',
          payload: {
            token: 'JWT token (required, admin only)'
          }
        },
        {
          event: 'unsubscribe-nut-status',
          description: 'Unsubscribe from UPS status updates',
          payload: {}
        },
        {
          event: 'get-nut-status',
          description: 'Get immediate UPS status (one-time request)',
          payload: {
            token: 'JWT token (required, admin only)'
          }
        }
      ],
      server_to_client: [
        {
          event: 'nut-status-update',
          description: 'Real-time UPS status (every 5s)',
          payload: {
            reachable: true,
            name: 'ups',
            status: 'OL',
            data: {},
            vars: {},
            timestamp: 1234567890123
          }
        },
        {
          event: 'nut-status-subscription-confirmed',
          description: 'Confirmation of successful subscription',
          payload: {
            interval: '5000ms'
          }
        },
        {
          event: 'nut-status-unsubscription-confirmed',
          description: 'Confirmation of successful unsubscription'
        },
        {
          event: 'error',
          description: 'General error messages',
          payload: {
            message: 'Error description'
          }
        }
      ]
    },
    examples: {
      subscribe: {
        event: 'subscribe-nut-status',
        data: {
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
        }
      },
      get_status: {
        event: 'get-nut-status',
        data: {
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
        }
      }
    },
    notes: {
      update_interval: 'Updates are sent every 5 seconds',
      authorization: 'Admin only; admin API tokens additionally need read permission for the nut resource',
      disabled: 'When NUT is disabled reachable=false and status=null are returned'
    }
  });
});

/**
 * @swagger
 * /nut/websocket/stats:
 *   get:
 *     summary: Get NUT WebSocket statistics
 *     description: Returns current statistics for the NUT status WebSocket
 *     tags: [NUT WebSocket]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: WebSocket statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 activeSubscriptions:
 *                   type: integer
 *                   description: Number of active status subscriptions
 *                   example: 2
 *                 clientCount:
 *                   type: integer
 *                   description: Total connected clients
 *                   example: 3
 *                 subscription:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     interval:
 *                       type: integer
 *                       description: Update interval in milliseconds
 *                       example: 5000
 *                     isActive:
 *                       type: boolean
 *                       example: true
 *       503:
 *         description: NUT WebSocket manager not initialized
 */
router.get('/websocket/stats', authenticateToken, async (req, res) => {
  try {
    const nutWebSocketManager = req.app.locals.nutWebSocketManager;

    if (!nutWebSocketManager) {
      return res.status(503).json({
        error: 'NUT WebSocket manager not initialized'
      });
    }

    const stats = nutWebSocketManager.getStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
