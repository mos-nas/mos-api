const express = require('express');
const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Terminal WebSocket
 *   description: Terminal WebSocket management and documentation
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     TerminalSession:
 *       type: object
 *       properties:
 *         sessionId:
 *           type: string
 *           description: Unique session identifier
 *           example: "terminal_1694123456789_abc123def"
 *         command:
 *           type: string
 *           description: Command or shell being executed
 *           example: "/bin/bash"
 *         args:
 *           type: array
 *           items:
 *             type: string
 *           description: Command arguments
 *           example: []
 *         readOnly:
 *           type: boolean
 *           description: Whether the session is read-only
 *           example: false
 *         startTime:
 *           type: string
 *           format: date-time
 *           description: Session start time
 *           example: "2024-01-20T10:30:00.000Z"
 *         lastActivity:
 *           type: string
 *           format: date-time
 *           description: Last activity time
 *           example: "2024-01-20T10:35:00.000Z"
 *         cols:
 *           type: integer
 *           description: Terminal columns
 *           example: 80
 *         rows:
 *           type: integer
 *           description: Terminal rows
 *           example: 24
 *         cwd:
 *           type: string
 *           description: Current working directory
 *           example: "/home/user"
 *         isActive:
 *           type: boolean
 *           description: Whether the session has active WebSocket connections
 *           example: true
 *
 *     TerminalStats:
 *       type: object
 *       properties:
 *         totalSessions:
 *           type: integer
 *           description: Total number of terminal sessions
 *           example: 3
 *         activeSessions:
 *           type: integer
 *           description: Number of sessions with active WebSocket connections
 *           example: 2
 *         connectedClients:
 *           type: integer
 *           description: Number of connected WebSocket clients
 *           example: 1
 *         sessions:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/TerminalSession'
 *           description: List of all terminal sessions
 *
 *     TerminalWebSocketEvents:
 *       type: object
 *       properties:
 *         clientEvents:
 *           type: object
 *           description: Events that clients can send to the server
 *           properties:
 *             join-session:
 *               type: object
 *               description: Join an existing terminal session
 *               properties:
 *                 sessionId:
 *                   type: string
 *                   description: Session ID to join
 *                 token:
 *                   type: string
 *                   description: JWT authentication token
 *             create-session:
 *               type: object
 *               description: Create a new terminal session
 *               properties:
 *                 token:
 *                   type: string
 *                   description: JWT authentication token
 *                 options:
 *                   type: object
 *                   description: Terminal options
 *                   properties:
 *                     command:
 *                       type: string
 *                       description: Command to execute (optional)
 *                     args:
 *                       type: array
 *                       items:
 *                         type: string
 *                       description: Command arguments
 *                     cols:
 *                       type: integer
 *                       description: Terminal columns
 *                       default: 80
 *                     rows:
 *                       type: integer
 *                       description: Terminal rows
 *                       default: 24
 *                     cwd:
 *                       type: string
 *                       description: Working directory
 *                       default: "/"
 *                     readOnly:
 *                       type: boolean
 *                       description: Read-only mode
 *                       default: false
 *             terminal-input:
 *               type: string
 *               description: Send input to the active terminal session
 *             terminal-resize:
 *               type: object
 *               description: Resize the terminal
 *               properties:
 *                 cols:
 *                   type: integer
 *                   description: New column count
 *                 rows:
 *                   type: integer
 *                   description: New row count
 *             list-sessions:
 *               type: object
 *               description: Get list of all terminal sessions
 *               properties:
 *                 token:
 *                   type: string
 *                   description: JWT authentication token
 *             kill-session:
 *               type: object
 *               description: Kill a terminal session
 *               properties:
 *                 sessionId:
 *                   type: string
 *                   description: Session ID to kill
 *                 token:
 *                   type: string
 *                   description: JWT authentication token
 *             leave-session:
 *               type: object
 *               description: Leave the current terminal session
 *             get-stats:
 *               type: object
 *               description: Get terminal statistics
 *               properties:
 *                 token:
 *                   type: string
 *                   description: JWT authentication token
 *         serverEvents:
 *           type: object
 *           description: Events that the server sends to clients
 *           properties:
 *             session-joined:
 *               type: object
 *               description: Confirmation that session was joined
 *               properties:
 *                 sessionId:
 *                   type: string
 *                 command:
 *                   type: string
 *                 args:
 *                   type: array
 *                   items:
 *                     type: string
 *                 readOnly:
 *                   type: boolean
 *                 cols:
 *                   type: integer
 *                 rows:
 *                   type: integer
 *                 cwd:
 *                   type: string
 *             session-created:
 *               $ref: '#/components/schemas/TerminalSession'
 *               description: New session created successfully
 *             terminal-output:
 *               type: string
 *               description: Output from the terminal
 *             terminal-exit:
 *               type: object
 *               description: Terminal process has exited
 *               properties:
 *                 code:
 *                   type: integer
 *                   description: Exit code
 *             terminal-resized:
 *               type: object
 *               description: Terminal was resized
 *               properties:
 *                 cols:
 *                   type: integer
 *                 rows:
 *                   type: integer
 *             sessions-list:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/TerminalSession'
 *               description: List of terminal sessions
 *             session-killed:
 *               type: object
 *               description: Session was killed
 *               properties:
 *                 sessionId:
 *                   type: string
 *             session-kill-result:
 *               type: object
 *               description: Result of kill operation
 *               properties:
 *                 sessionId:
 *                   type: string
 *                 killed:
 *                   type: boolean
 *             session-left:
 *               type: object
 *               description: Left the session
 *               properties:
 *                 sessionId:
 *                   type: string
 *             terminal-stats:
 *               $ref: '#/components/schemas/TerminalStats'
 *               description: Terminal statistics
 *             error:
 *               type: object
 *               description: Error message
 *               properties:
 *                 message:
 *                   type: string
 *                   description: Error description
 */

/**
 * @swagger
 * /terminal/websocket/events:
 *   get:
 *     summary: Terminal WebSocket Events Documentation
 *     description: |
 *       Get comprehensive documentation for Terminal WebSocket events and usage.
 *
 *       ## Connection
 *       Connect to the Terminal WebSocket namespace:
 *       ```javascript
 *       const socket = io('http://localhost:3000/terminal', {
 *         path: '/api/v1/socket.io/',
 *         auth: {
 *           token: 'your-jwt-token'
 *         }
 *       });
 *       ```
 *
 *       ## Authentication
 *       All terminal operations require admin-level authentication. Include your JWT token in event data.
 *
 *       ## Basic Usage
 *
 *       ### 1. Create a new terminal session:
 *       ```javascript
 *       socket.emit('create-session', {
 *         token: 'your-jwt-token',
 *         options: {
 *           cols: 80,
 *           rows: 24,
 *           cwd: '/home/user'
 *         }
 *       });
 *       ```
 *
 *       ### 2. Join an existing session:
 *       ```javascript
 *       socket.emit('join-session', {
 *         sessionId: 'terminal_1694123456789_abc123def',
 *         token: 'your-jwt-token'
 *       });
 *       ```
 *
 *       ### 3. Send input to terminal:
 *       ```javascript
 *       socket.emit('terminal-input', 'ls -la\n');
 *       ```
 *
 *       ### 4. Listen for output:
 *       ```javascript
 *       socket.on('terminal-output', (data) => {
 *         console.log(data);
 *       });
 *       ```
 *
 *       ### 5. Resize terminal:
 *       ```javascript
 *       socket.emit('terminal-resize', { cols: 120, rows: 30 });
 *       ```
 *
 *       ## Session Management
 *
 *       ### List all sessions:
 *       ```javascript
 *       socket.emit('list-sessions', { token: 'your-jwt-token' });
 *       socket.on('sessions-list', (sessions) => {
 *         console.log(sessions);
 *       });
 *       ```
 *
 *       ### Kill a session:
 *       ```javascript
 *       socket.emit('kill-session', {
 *         sessionId: 'terminal_1694123456789_abc123def',
 *         token: 'your-jwt-token'
 *       });
 *       ```
 *
 *       ### Get statistics:
 *       ```javascript
 *       socket.emit('get-stats', { token: 'your-jwt-token' });
 *       socket.on('terminal-stats', (stats) => {
 *         console.log(stats);
 *       });
 *       ```
 *
 *       ## Error Handling
 *       Always listen for error events:
 *       ```javascript
 *       socket.on('error', (error) => {
 *         console.error('Terminal error:', error.message);
 *       });
 *       ```
 *     tags: [Terminal WebSocket]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Terminal WebSocket events documentation
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TerminalWebSocketEvents'
 *       401:
 *         description: Unauthorized - Admin access required
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Admin access required"
 */
router.get('/websocket/events', (req, res) => {
  // Check if user is admin
  if (req.user.role !== 'admin') {
    return res.status(401).json({ error: 'Admin access required' });
  }

  const events = {
    namespace: '/terminal',
    connectionUrl: `${req.protocol}://${req.get('host')}/terminal`,
    socketPath: '/api/v1/socket.io/',
    authentication: 'JWT token required for all operations',
    adminOnly: true,
    clientEvents: {
      'join-session': {
        description: 'Join an existing terminal session',
        parameters: {
          sessionId: 'string - Session ID to join',
          token: 'string - JWT authentication token'
        }
      },
      'create-session': {
        description: 'Create a new terminal session',
        parameters: {
          token: 'string - JWT authentication token',
          options: {
            command: 'string (optional) - Command to execute',
            args: 'array (optional) - Command arguments',
            cols: 'integer (optional) - Terminal columns (default: 80)',
            rows: 'integer (optional) - Terminal rows (default: 24)',
            cwd: 'string (optional) - Working directory (default: /)',
            readOnly: 'boolean (optional) - Read-only mode (default: false)'
          }
        }
      },
      'terminal-input': {
        description: 'Send input to the active terminal session',
        parameters: 'string - Input data to send to terminal'
      },
      'terminal-resize': {
        description: 'Resize the terminal',
        parameters: {
          cols: 'integer - New column count',
          rows: 'integer - New row count'
        }
      },
      'list-sessions': {
        description: 'Get list of all terminal sessions',
        parameters: {
          token: 'string - JWT authentication token'
        }
      },
      'kill-session': {
        description: 'Kill a terminal session',
        parameters: {
          sessionId: 'string - Session ID to kill',
          token: 'string - JWT authentication token'
        }
      },
      'leave-session': {
        description: 'Leave the current terminal session',
        parameters: 'none'
      },
      'get-stats': {
        description: 'Get terminal statistics',
        parameters: {
          token: 'string - JWT authentication token'
        }
      }
    },
    serverEvents: {
      'session-joined': 'Confirmation that session was joined successfully',
      'session-created': 'New session created successfully',
      'terminal-output': 'Output data from the terminal',
      'terminal-exit': 'Terminal process has exited',
      'terminal-resized': 'Terminal was resized successfully',
      'sessions-list': 'List of all terminal sessions',
      'session-killed': 'Session was killed',
      'session-kill-result': 'Result of kill operation',
      'session-left': 'Successfully left the session',
      'terminal-stats': 'Terminal statistics',
      'error': 'Error message'
    }
  };

  res.json(events);
});

/**
 * @swagger
 * /terminal/websocket/stats:
 *   get:
 *     summary: Get Terminal WebSocket Statistics
 *     description: |
 *       Get real-time statistics about terminal WebSocket connections and sessions.
 *
 *       This endpoint provides information about:
 *       - Total number of terminal sessions
 *       - Number of active sessions with WebSocket connections
 *       - Number of connected WebSocket clients
 *       - Detailed information about each session
 *     tags: [Terminal WebSocket]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Terminal WebSocket statistics
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TerminalStats'
 *             example:
 *               totalSessions: 3
 *               activeSessions: 2
 *               connectedClients: 1
 *               sessions:
 *                 - sessionId: "terminal_1694123456789_abc123def"
 *                   command: "/bin/bash"
 *                   args: []
 *                   readOnly: false
 *                   startTime: "2024-01-20T10:30:00.000Z"
 *                   lastActivity: "2024-01-20T10:35:00.000Z"
 *                   cols: 80
 *                   rows: 24
 *                   cwd: "/home/user"
 *                   isActive: true
 *       401:
 *         description: Unauthorized - Admin access required
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Admin access required"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Failed to get terminal statistics"
 */
router.get('/websocket/stats', (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(401).json({ error: 'Admin access required' });
    }

    // Get terminal WebSocket manager from app locals
    const terminalWebSocketManager = req.app.locals.terminalWebSocketManager;

    if (!terminalWebSocketManager) {
      return res.status(500).json({ error: 'Terminal WebSocket manager not available' });
    }

    const stats = terminalWebSocketManager.getTerminalStats();
    res.json(stats);

  } catch (error) {
    console.error('Error getting terminal WebSocket stats:', error);
    res.status(500).json({ error: 'Failed to get terminal statistics' });
  }
});

module.exports = router;
