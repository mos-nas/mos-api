const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const notificationsService = require('../services/notifications.service');
const webpushService = require('../services/webpush.service');
const { checkRole } = require('../middleware/auth.middleware');

/**
 * @swagger
 * tags:
 *   name: Notifications
 *   description: System Notifications Management
 *
 * components:
 *   schemas:
 *     Notification:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Unique notification ID (millisecond timestamp)
 *           example: "1727725946123"
 *         title:
 *           type: string
 *           description: Notification title
 *           example: "chipsServer - test"
 *         message:
 *           type: string
 *           description: Notification message content
 *           example: "hallo"
 *         priority:
 *           type: string
 *           enum: [high, normal, low]
 *           description: Notification priority level
 *           example: "normal"
 *         timestamp:
 *           type: string
 *           format: date-time
 *           description: ISO timestamp when notification was created
 *           example: "2025-09-07T19:16:34.620280755+02:00"
 *         read:
 *           type: boolean
 *           description: Whether the notification has been read
 *           example: false
 *     DeleteResult:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           description: Whether the operation was successful
 *         message:
 *           type: string
 *           description: Result message
 *           example: "Notification deleted successfully"
 *         remainingCount:
 *           type: integer
 *           description: Number of notifications remaining after deletion
 *           example: 4
 *     ReadResult:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           description: Whether the operation was successful
 *         message:
 *           type: string
 *           description: Result message
 *           example: "Notification marked as read"
 *         markedCount:
 *           type: integer
 *           description: Number of notifications marked as read
 *           example: 1
 *         totalCount:
 *           type: integer
 *           description: Total number of notifications
 *           example: 5
 *     NotificationStats:
 *       type: object
 *       properties:
 *         total:
 *           type: integer
 *           description: Total number of notifications
 *           example: 10
 *         read:
 *           type: integer
 *           description: Number of read notifications
 *           example: 3
 *         unread:
 *           type: integer
 *           description: Number of unread notifications
 *           example: 7
 *         priorities:
 *           type: object
 *           properties:
 *             high:
 *               type: integer
 *               example: 2
 *             normal:
 *               type: integer
 *               example: 6
 *             low:
 *               type: integer
 *               example: 2
 *     Error:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           description: Error message
 */

/**
 * @swagger
 * /notifications/ticket:
 *   post:
 *     summary: Get WebSocket ticket for the notification live feed
 *     description: >
 *       Issues a short-lived HMAC-signed ticket for connecting to the notification WebSocket at `/api/v1/notify?ticket=...`.
 *       Available to any authenticated user (JWT, admin API token or boot token) - no admin role required,
 *       because the ticket only grants read access to the notification broadcast.
 *       The ticket is signed with the API JWT_SECRET and validated by the mos-notify service. Valid for 15 seconds.
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Ticket issued successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ticket:
 *                   type: string
 *                   description: Signed ticket (base64url payload + HMAC signature), pass as `?ticket=` query parameter
 *                   example: "eyJpYXQiOjE3Mjc3MjU5NDYsImV4cCI6MTcyNzcyNTk2NiwidWlkIjoiMSIsInJvbGUiOiJ1c2VyIn0.2f1a..."
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       503:
 *         description: JWT secret not available (during initial setup)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
const WS_TICKET_TTL_SECONDS = 15;

router.post('/ticket', async (req, res) => {
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(503).json({ error: 'JWT secret not available yet. Please retry after startup.' });
    }

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iat: now,
      exp: now + WS_TICKET_TTL_SECONDS,
      uid: req.user.id || null,
      role: req.user.role || null
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');

    res.json({ ticket: `${body}.${signature}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Only Admin can access the following routes
router.use(checkRole(['admin']));

/**
 * @swagger
 * /notifications:
 *   get:
 *     summary: Get all notifications
 *     description: Retrieve all system notifications with optional filtering by read status, limit, and sort order - admin only
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: read
 *         schema:
 *           type: boolean
 *         description: Filter by read status (true for read, false for unread)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *         description: Limit the number of notifications returned
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *         description: Sort order by timestamp (asc = oldest first, desc = newest first)
 *     responses:
 *       200:
 *         description: Notifications retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Notification'
 *             example:
 *               - id: "1727725946123"
 *                 title: "chipsServer - test"
 *                 message: "hallo2"
 *                 priority: "normal"
 *                 timestamp: "2025-09-07T19:16:35.939580764+02:00"
 *                 read: false
 *               - id: "1727725946122"
 *                 title: "chipsServer - test"
 *                 message: "hallo"
 *                 priority: "normal"
 *                 timestamp: "2025-09-07T19:16:34.620280755+02:00"
 *                 read: true
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
router.get('/', async (req, res) => {
  try {
    const { read, limit, order } = req.query;

    const options = {};

    // Parse read parameter
    if (read !== undefined) {
      options.read = read === 'true' || read === true;
    }

    // Parse limit parameter
    if (limit !== undefined) {
      const parsedLimit = parseInt(limit, 10);
      if (!isNaN(parsedLimit) && parsedLimit > 0) {
        options.limit = parsedLimit;
      }
    }

    // Parse order parameter (default: desc)
    if (order !== undefined) {
      options.order = order === 'asc' ? 'asc' : 'desc';
    }

    const notifications = await notificationsService.getNotifications(options);
    res.json(notifications);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


/**
 * @swagger
 * /notifications/{id}:
 *   delete:
 *     summary: Delete notification by ID
 *     description: Delete a specific notification using its ID - admin only
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the notification to delete
 *         example: "1727725946123"
 *     responses:
 *       200:
 *         description: Notification deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DeleteResult'
 *       404:
 *         description: Notification not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DeleteResult'
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
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ error: 'ID parameter is required' });
    }

    const result = await notificationsService.deleteNotification(id);

    if (result.success) {
      res.json(result);
    } else {
      res.status(404).json(result);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /notifications:
 *   delete:
 *     summary: Delete all notifications
 *     description: Delete all system notifications - admin only
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All notifications deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DeleteResult'
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
router.delete('/', async (req, res) => {
  try {
    const result = await notificationsService.deleteAllNotifications();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /notifications/stats:
 *   get:
 *     summary: Get notification statistics
 *     description: Get statistics about notifications including read/unread counts and priority breakdown - admin only
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/NotificationStats'
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
router.get('/stats', async (req, res) => {
  try {
    const stats = await notificationsService.getNotificationStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /notifications/{id}/read:
 *   put:
 *     summary: Mark notification as read
 *     description: Mark a specific notification as read using its ID - admin only
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the notification to mark as read
 *         example: "1727725946123"
 *     responses:
 *       200:
 *         description: Notification marked as read successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReadResult'
 *       404:
 *         description: Notification not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReadResult'
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
router.put('/:id/read', async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ error: 'ID parameter is required' });
    }

    const result = await notificationsService.markNotificationAsRead(id);

    if (result.success) {
      res.json(result);
    } else {
      res.status(404).json(result);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /notifications/read/multiple:
 *   put:
 *     summary: Mark multiple notifications as read
 *     description: Mark multiple notifications as read using their IDs - admin only
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: array
 *             items:
 *               type: number
 *             description: Array of notification IDs to mark as read
 *             example: [1727725946123, 1727725946122]
 *     responses:
 *       200:
 *         description: Notifications marked as read successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReadResult'
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: No matching notifications found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReadResult'
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
router.put('/read/multiple', async (req, res) => {
  try {
    const ids = req.body;

    if (!Array.isArray(ids)) {
      return res.status(400).json({ error: 'Request body must be an array of notification IDs' });
    }

    const result = await notificationsService.markMultipleNotificationsAsRead(ids);

    if (result.success) {
      res.json(result);
    } else {
      res.status(404).json(result);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /notifications/read/all:
 *   put:
 *     summary: Mark all notifications as read
 *     description: Mark all notifications as read - admin only
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All notifications marked as read successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReadResult'
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
router.put('/read/all', async (req, res) => {
  try {
    const result = await notificationsService.markAllNotificationsAsRead();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /notifications/push/vapid-key:
 *   get:
 *     summary: Get VAPID public key
 *     description: Returns the VAPID public key needed by the frontend to create a push subscription - admin only
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: VAPID public key retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 publicKey:
 *                   type: string
 *                   description: VAPID public key (base64url encoded)
 *                   example: "BNbxGYNMhEIi..."
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
router.get('/push/vapid-key', async (req, res) => {
  try {
    await webpushService.init();
    const publicKey = webpushService.getPublicKey();
    res.json({ publicKey });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /notifications/push/subscribe:
 *   post:
 *     summary: Subscribe to push notifications
 *     description: Register a browser push subscription for the authenticated user. The subscription object is provided by the browser Push API - admin only
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - endpoint
 *               - keys
 *             properties:
 *               endpoint:
 *                 type: string
 *                 description: Push service endpoint URL (provided by browser)
 *                 example: "https://fcm.googleapis.com/fcm/send/..."
 *               keys:
 *                 type: object
 *                 required:
 *                   - p256dh
 *                   - auth
 *                 properties:
 *                   p256dh:
 *                     type: string
 *                     description: User public encryption key (base64url)
 *                   auth:
 *                     type: string
 *                     description: User auth secret (base64url)
 *     responses:
 *       201:
 *         description: Push subscription registered
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
 *                   example: "Push subscription registered"
 *       400:
 *         description: Invalid subscription object
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
router.post('/push/subscribe', async (req, res) => {
  try {
    await webpushService.init();
    const { endpoint, keys } = req.body;

    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: 'Invalid push subscription. Required: endpoint, keys.p256dh, keys.auth' });
    }

    const userId = req.user.id || 'admin';
    const username = req.user.username || 'admin';
    const result = await webpushService.subscribe(userId, username, { endpoint, keys });
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /notifications/push/subscribe:
 *   delete:
 *     summary: Unsubscribe from push notifications
 *     description: Remove a browser push subscription. The endpoint URL identifies the subscription to remove - admin only
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - endpoint
 *             properties:
 *               endpoint:
 *                 type: string
 *                 description: Push service endpoint URL to unsubscribe
 *                 example: "https://fcm.googleapis.com/fcm/send/..."
 *     responses:
 *       200:
 *         description: Push subscription removed
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
 *                   example: "Push subscription removed"
 *       400:
 *         description: Endpoint is required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Subscription not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Subscription not found"
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
router.delete('/push/subscribe', async (req, res) => {
  try {
    await webpushService.init();
    const { endpoint } = req.body;

    if (!endpoint) {
      return res.status(400).json({ error: 'Endpoint is required' });
    }

    const result = await webpushService.unsubscribe(endpoint);

    if (result.success) {
      res.json(result);
    } else {
      res.status(404).json(result);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;