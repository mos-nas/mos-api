const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth.middleware');

/**
 * @swagger
 * tags:
 *   name: File Operations WebSocket
 *   description: Real-time file copy/move operations via WebSocket
 *
 * components:
 *   schemas:
 *     FileOperationUpdate:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Unique operation identifier (timestamp-based)
 *           example: "1742742123456"
 *         operation:
 *           type: string
 *           enum: [copy, move]
 *           description: Type of file operation
 *           example: "copy"
 *         source:
 *           oneOf:
 *             - type: string
 *               description: Single source path
 *             - type: array
 *               items:
 *                 type: string
 *               description: Multiple source paths
 *           description: Source path(s) - mirrors the request shape (string stays string, array stays array)
 *           example: "/mnt/Pool1/media/movies"
 *         destination:
 *           type: string
 *           description: Destination directory path
 *           example: "/mnt/ssd1/backup"
 *         destinationFull:
 *           oneOf:
 *             - type: string
 *               description: Full destination path including source basename
 *             - type: array
 *               items:
 *                 type: string
 *               description: Full destination path per source, same order as source
 *           description: Full destination path(s) including source basename(s)
 *           example: "/mnt/ssd1/backup/movies"
 *         status:
 *           type: string
 *           enum: [preparing, running, completed, failed, cancelled]
 *           description: Current operation status
 *           example: "running"
 *         instantMove:
 *           type: boolean
 *           description: Whether this was an instant same-filesystem move (no copy needed)
 *           example: false
 *         onConflict:
 *           type: string
 *           enum: [fail, overwrite, skip]
 *           description: Conflict resolution strategy
 *           example: "fail"
 *         progress:
 *           type: number
 *           description: Transfer progress percentage (0-100)
 *           example: 45.2
 *         speed:
 *           type: number
 *           description: Current transfer speed in bytes per second
 *           example: 129345678
 *         speed_human:
 *           type: string
 *           description: Human-readable transfer speed (respects user byte_format)
 *           example: "123.4 MiB/s"
 *         eta:
 *           type: string
 *           nullable: true
 *           description: Estimated time remaining (HH:MM:SS format from rsync)
 *           example: "0:01:23"
 *         bytesTransferred:
 *           type: integer
 *           description: Bytes transferred so far
 *           example: 1234567890
 *         bytesTransferred_human:
 *           type: string
 *           description: Human-readable bytes transferred (respects user byte_format)
 *           example: "1.1 GiB"
 *         bytesTotal:
 *           type: integer
 *           description: Total bytes to transfer
 *           example: 2740000000
 *         bytesTotal_human:
 *           type: string
 *           description: Human-readable total bytes (respects user byte_format)
 *           example: "2.6 GiB"
 *         startedAt:
 *           type: string
 *           format: date-time
 *           description: Operation start timestamp
 *           example: "2025-03-23T14:30:00.000Z"
 *         completedAt:
 *           type: string
 *           format: date-time
 *           nullable: true
 *           description: Operation completion timestamp (null while running)
 *           example: null
 *         error:
 *           type: string
 *           nullable: true
 *           description: Error message if operation failed
 *           example: null
 *
 * /mos/fileoperations/websocket/events:
 *   get:
 *     summary: WebSocket Events Documentation
 *     description: |
 *       This endpoint documents the WebSocket events for real-time file operation monitoring.
 *
 *       **Connection:** Connect to WebSocket at `/api/v1/fileoperations` namespace
 *
 *       **Events to emit (client → server):**
 *       - `subscribe-operation` - Subscribe to a specific operation by ID
 *       - `subscribe-all` - Subscribe to all file operations
 *       - `unsubscribe-operation` - Unsubscribe from a specific operation
 *       - `unsubscribe-all` - Unsubscribe from all file operations
 *       - `update-preferences` - Update byte_format preference
 *
 *       **Events to listen for (server → client):**
 *       - `fileoperations-update` - Progress update for a single operation
 *       - `fileoperations-list` - All operations (sent on subscribe-all)
 *       - `fileoperations-subscription-confirmed` - Subscription confirmed
 *       - `fileoperations-unsubscription-confirmed` - Unsubscription confirmed
 *       - `preferences-updated` - Preferences updated confirmation
 *       - `error` - Error occurred
 *
 *       **Update Interval:** Progress updates are broadcast every 2 seconds.
 *       State changes (completed, failed, cancelled) are sent immediately.
 *
 *       **Important:** Operations continue running in the background even when
 *       no WebSocket clients are connected. The WebSocket is only for monitoring.
 *       Operations are started and cancelled via REST endpoints.
 *
 *       **Example Usage:**
 *
 *       Connect to WebSocket:
 *       ```javascript
 *       const socket = io('http://localhost:998/api/v1/fileoperations', {
 *         path: '/api/v1/socket.io/'
 *       });
 *       ```
 *
 *       Subscribe to a specific operation:
 *       ```javascript
 *       socket.emit('subscribe-operation', {
 *         token: 'your-jwt-token',
 *         operationId: '1742742123456'
 *       });
 *       ```
 *
 *       Subscribe to all operations:
 *       ```javascript
 *       socket.emit('subscribe-all', {
 *         token: 'your-jwt-token'
 *       });
 *       ```
 *
 *       Listen for updates:
 *       ```javascript
 *       // Single operation update (progress, status changes)
 *       socket.on('fileoperations-update', (data) => {
 *         console.log(`[${data.id}] ${data.operation} ${data.status}`);
 *         console.log(`  Progress: ${data.progress}%`);
 *         console.log(`  Speed: ${data.speed_human}`);
 *         console.log(`  ETA: ${data.eta}`);
 *         console.log(`  ${data.bytesTransferred_human} / ${data.bytesTotal_human}`);
 *
 *         if (data.instantMove) {
 *           console.log('  Instant move (same filesystem)');
 *         }
 *
 *         if (data.status === 'completed') {
 *           console.log('  Completed at:', data.completedAt);
 *         }
 *         if (data.status === 'failed') {
 *           console.error('  Error:', data.error);
 *         }
 *       });
 *
 *       // All operations list (sent on subscribe-all)
 *       socket.on('fileoperations-list', (operations) => {
 *         console.log(`${operations.length} operations`);
 *         operations.forEach(op => {
 *           console.log(`  ${op.id}: ${op.operation} ${op.status} ${op.progress}%`);
 *         });
 *       });
 *       ```
 *
 *       Update byte format preference:
 *       ```javascript
 *       socket.emit('update-preferences', { byte_format: 'decimal' });
 *       ```
 *
 *       Unsubscribe:
 *       ```javascript
 *       socket.emit('unsubscribe-operation', { operationId: '1742742123456' });
 *       socket.emit('unsubscribe-all');
 *       ```
 *     tags: [File Operations WebSocket]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: WebSocket events documentation
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "File Operations WebSocket documentation. Connect via Socket.IO to /api/v1/fileoperations namespace."
 *                 events:
 *                   type: object
 *                   properties:
 *                     client_to_server:
 *                       type: array
 *                       items:
 *                         type: string
 *                       example: ["subscribe-operation", "subscribe-all", "unsubscribe-operation", "unsubscribe-all", "update-preferences"]
 *                     server_to_client:
 *                       type: array
 *                       items:
 *                         type: string
 *                       example: ["fileoperations-update", "fileoperations-list", "fileoperations-subscription-confirmed", "fileoperations-unsubscription-confirmed", "preferences-updated", "error"]
 */
router.get('/websocket/events', authenticateToken, (req, res) => {
  res.json({
    message: 'File Operations WebSocket documentation. Connect via Socket.IO to /api/v1/fileoperations namespace.',
    namespace: '/fileoperations',
    path: '/api/v1/socket.io/',
    broadcastInterval: '2000ms',
    events: {
      client_to_server: [
        'subscribe-operation',
        'subscribe-all',
        'unsubscribe-operation',
        'unsubscribe-all',
        'update-preferences'
      ],
      server_to_client: [
        'fileoperations-update',
        'fileoperations-list',
        'fileoperations-subscription-confirmed',
        'fileoperations-unsubscription-confirmed',
        'preferences-updated',
        'error'
      ]
    }
  });
});

module.exports = router;
