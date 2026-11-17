const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth.middleware');

/**
 * @swagger
 * tags:
 *   name: Install To Disk WebSocket
 *   description: Real-time MOS installation to disk via WebSocket
 *
 * /mos/installtodisk/websocket/events:
 *   get:
 *     summary: Install To Disk WebSocket Events Documentation
 *     description: |
 *       This endpoint documents the WebSocket events for running the MOS installation
 *       to disk (`mos-install`) with real-time streamed output.
 *
 *       It mirrors POST `/mos/installtodisk` with the same parameters, but streams the
 *       installer output live, supports cancel and survives reconnects.
 *
 *       **Connection:** Connect to WebSocket at `/api/v1/mos/installtodisk` namespace
 *
 *       **Authorization:** Admin only. Admin API tokens additionally need
 *       `write` permission for the `terminal` resource (shell access).
 *
 *       **Lifecycle:** The installer runs detached in its own process group with
 *       working directory `/var/mos`. It keeps running after client disconnects and can be
 *       re-attached via `installtodisk-get-operations` (including buffered output replay,
 *       last 100 KiB per operation). Cancel kills the entire process group (SIGTERM, then
 *       SIGKILL after 5 seconds) and unmounts the installer mount points afterwards. Only
 *       one installation can run at a time.
 *
 *       **Events to emit (client → server):**
 *
 *       - `installtodisk-run`: Start installation. Payload: `{ token, disk, filesystem, extra_partition?, tar_file?, backup_label? }`
 *         - `disk`: Disk device path (e.g. /dev/sda) - required
 *         - `filesystem`: One of vfat, ext4, btrfs, xfs - required
 *         - `extra_partition`: Create an extra partition (default false)
 *         - `tar_file`: Optional path to tar backup file for restoration
 *         - `backup_label`: Whether to add backup label (default false)
 *       - `installtodisk-cancel`: Cancel a running installation. Payload: `{ token, operationId }`
 *       - `installtodisk-get-operations`: List operations, replay output and rejoin running operations. Payload: `{ token }`
 *
 *       **Events to listen for (server → client):**
 *
 *       - `installtodisk-update`: All lifecycle updates, discriminated by `status`:
 *         - `started` - installation started (includes parameters and `pid`)
 *         - `running` - output chunk (`output`, `stream: stdout|stderr`, `replay: true` for buffered replay)
 *         - `cancelling` - cancellation requested
 *         - `completed` - installer exited (`exitCode`, `signal`, `duration`)
 *         - `cancelled` - installer killed via cancel (`exitCode`, `signal`, `duration`)
 *         - `operations-list` - list of all known operations
 *         - `error` - error (`message`)
 *
 *       **Example Usage:**
 *
 *       Connect to WebSocket:
 *       ```javascript
 *       const socket = io('http://localhost:3000/api/v1/mos/installtodisk', {
 *         path: '/api/v1/socket.io/'
 *       });
 *       ```
 *
 *       Start installation:
 *       ```javascript
 *       socket.emit('installtodisk-run', {
 *         token: 'your-jwt-token',
 *         disk: '/dev/sdb',
 *         filesystem: 'ext4',
 *         extra_partition: false,
 *         tar_file: '',
 *         backup_label: false
 *       });
 *       ```
 *
 *       Listen for updates:
 *       ```javascript
 *       socket.on('installtodisk-update', (data) => {
 *         if (data.status === 'running') appendOutput(data.output);
 *         else console.log(data.status, data);
 *       });
 *       ```
 *     tags: [Install To Disk WebSocket]
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
 *                   example: "/api/v1/mos/installtodisk"
 *                 events:
 *                   type: object
 */
router.get('/installtodisk/websocket/events', (req, res) => {
  res.json({
    namespace: '/api/v1/mos/installtodisk',
    description: 'Real-time MOS installation to disk via WebSocket (same parameters as POST /mos/installtodisk)',
    events: {
      client_to_server: [
        {
          event: 'installtodisk-run',
          description: 'Start MOS installation to disk with streamed output',
          payload: {
            token: 'JWT/admin/boot token (required, admin only)',
            disk: '/dev/sda',
            filesystem: 'ext4 (vfat|ext4|btrfs|xfs)',
            extra_partition: false,
            tar_file: '',
            backup_label: false
          }
        },
        {
          event: 'installtodisk-cancel',
          description: 'Cancel a running installation (kills process group including children)',
          payload: {
            token: 'JWT token (required)',
            operationId: 'install-1742742123456-abc123'
          }
        },
        {
          event: 'installtodisk-get-operations',
          description: 'List operations, replay buffered output and rejoin running operations',
          payload: {
            token: 'JWT token (required)'
          }
        }
      ],
      server_to_client: [
        {
          event: 'installtodisk-update',
          description: 'Lifecycle update, discriminated by status: started|running|cancelling|completed|cancelled|operations-list|error',
          payload: {
            status: 'running',
            operationId: 'install-1742742123456-abc123',
            timestamp: 1234567890123,
            output: 'Formatting boot Partition with ext4\n',
            stream: 'stdout'
          }
        }
      ]
    },
    notes: {
      authorization: 'Admin only; admin API tokens additionally need write permission for the terminal resource',
      parameters: 'Same parameters as POST /mos/installtodisk (disk, filesystem, extra_partition, tar_file, backup_label)',
      working_directory: '/var/mos',
      single_flight: 'Only one installation can run at a time',
      persistence: 'Installation survives client disconnects and API restarts (detached process group)',
      cancel: 'SIGTERM to process group, SIGKILL after 5 seconds, installer mount points unmounted afterwards',
      output_buffer: 'Last 100 KiB of output kept per operation for rejoining clients'
    }
  });
});

/**
 * @swagger
 * /mos/installtodisk/websocket/stats:
 *   get:
 *     summary: Get Install To Disk WebSocket statistics
 *     description: Returns current statistics for installation operations
 *     tags: [Install To Disk WebSocket]
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
 *                 totalOperations:
 *                   type: integer
 *                   description: Number of known operations (running + recently completed)
 *                   example: 1
 *                 running:
 *                   type: integer
 *                   description: Number of currently running installations
 *                   example: 1
 *                 operations:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       operationId:
 *                         type: string
 *                         example: "install-1742742123456-abc123"
 *                       disk:
 *                         type: string
 *                         example: "/dev/sda"
 *                       filesystem:
 *                         type: string
 *                         example: "ext4"
 *                       status:
 *                         type: string
 *                         enum: [running, completed, cancelled, failed]
 *                         example: "running"
 *                       duration:
 *                         type: integer
 *                         description: Duration in milliseconds
 *                         example: 45000
 *       503:
 *         description: Install To Disk WebSocket manager not initialized
 */
router.get('/installtodisk/websocket/stats', authenticateToken, async (req, res) => {
  try {
    const installToDiskWebSocketManager = req.app.locals.installToDiskWebSocketManager;

    if (!installToDiskWebSocketManager) {
      return res.status(503).json({
        error: 'Install To Disk WebSocket manager not initialized'
      });
    }

    const stats = installToDiskWebSocketManager.getStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
