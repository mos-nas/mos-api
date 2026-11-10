const express = require('express');
const router = express.Router();
const terminalService = require('../services/terminal.service');
const { checkRole } = require('../middleware/auth.middleware');

/**
 * @swagger
 * components:
 *   schemas:
 *     TerminalSession:
 *       type: object
 *       properties:
 *         sessionId:
 *           type: string
 *           description: Eindeutige Session-ID
 *           example: "terminal-1704123456789-x8f9g2k3l"
 *         command:
 *           type: string
 *           description: Ausgeführter Befehl oder Shell
 *           example: "docker"
 *         args:
 *           type: array
 *           items:
 *             type: string
 *           description: Befehl-Argumente
 *           example: ["exec", "-it", "nginx", "/bin/sh"]
 *         readOnly:
 *           type: boolean
 *           description: Ob das Terminal nur lesend ist
 *           example: false
 *         cols:
 *           type: integer
 *           description: Anzahl Spalten
 *           example: 80
 *         rows:
 *           type: integer
 *           description: Anzahl Zeilen
 *           example: 24
 *         cwd:
 *           type: string
 *           description: Arbeitsverzeichnis
 *           example: "/"
 *         created:
 *           type: string
 *           format: date-time
 *           description: Erstellungszeit
 *
 *     TerminalConfig:
 *       type: object
 *       properties:
 *         command:
 *           type: string
 *           description: |
 *             Command to execute (optional, if omitted shell is used)
 *
 *             Examples:
 *             - "docker" for container access
 *             - "tail" for log viewing
 *             - "lxc-attach" for LXC containers
 *             - "watch" for monitoring
 *           example: "docker"
 *         args:
 *           type: array
 *           items:
 *             type: string
 *           description: |
 *             Command arguments
 *
 *             Examples:
 *             - ["exec", "-it", "nginx", "/bin/sh"] for Docker
 *             - ["-f", "-n", "100", "/var/log/syslog"] for tail
 *             - ["-n", "ubuntu"] for lxc-attach
 *           example: ["exec", "-it", "nginx", "/bin/sh"]
 *         shell:
 *           type: string
 *           default: "/bin/bash"
 *           description: Default shell (only if no command is specified)
 *           example: "/bin/bash"
 *         width:
 *           type: integer
 *           minimum: 180
 *           maximum: 3000
 *           description: |
 *             Terminal width in pixels (recommended, easier for frontend)
 *             Automatically converted to cols (~9px per character)
 *             Alternative to 'cols'
 *           example: 800
 *         height:
 *           type: integer
 *           minimum: 200
 *           maximum: 2000
 *           description: |
 *             Terminal height in pixels (recommended, easier for frontend)
 *             Automatically converted to rows (~20px per line)
 *             Alternative to 'rows'
 *           example: 600
 *         cols:
 *           type: integer
 *           minimum: 20
 *           maximum: 200
 *           default: 80
 *           description: |
 *             Terminal width in columns
 *             Alternative to 'width' (legacy)
 *         rows:
 *           type: integer
 *           minimum: 10
 *           maximum: 50
 *           default: 24
 *           description: |
 *             Terminal height in rows
 *             Alternative to 'height' (legacy)
 *         cwd:
 *           type: string
 *           default: "/"
 *           description: Working directory for the command
 *           example: "/home/user"
 *         readOnly:
 *           type: boolean
 *           default: false
 *           description: |
 *             Terminal is read-only (recommended for logs/monitoring)
 *
 *             When readOnly=true, no input can be made
 *           example: true
 */

/**
 * @swagger
 * /terminal/sessions:
 *   get:
 *     summary: List all terminal sessions
 *     description: |
 *       Shows all active terminal sessions with details (admin only)
 *
 *       Useful for monitoring and session management.
 *     tags: [Terminal]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of terminal sessions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sessions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       sessionId:
 *                         type: string
 *                       command:
 *                         type: string
 *                       args:
 *                         type: array
 *                         items:
 *                           type: string
 *                       readOnly:
 *                         type: boolean
 *                       startTime:
 *                         type: string
 *                         format: date-time
 *                       cols:
 *                         type: integer
 *                       rows:
 *                         type: integer
 *                       cwd:
 *                         type: string
 *             example:
 *               sessions:
 *                 - sessionId: "terminal-1704123456789-x8f9g2k3l"
 *                   command: "docker"
 *                   args: ["exec", "-it", "nginx", "/bin/sh"]
 *                   readOnly: false
 *                   startTime: "2024-01-01T12:00:00.000Z"
 *                   cols: 120
 *                   rows: 40
 *                   cwd: "/"
 *                 - sessionId: "terminal-1704123456790-y7h8j3m2p"
 *                   command: "tail"
 *                   args: ["-f", "/var/log/syslog"]
 *                   readOnly: true
 *                   startTime: "2024-01-01T11:30:00.000Z"
 *                   cols: 80
 *                   rows: 24
 *                   cwd: "/"
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.get('/sessions', checkRole('admin'), (req, res) => {
  try {
    const sessions = terminalService.listSessions();
    res.json({ sessions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /terminal/create:
 *   post:
 *     summary: Create new terminal session
 *     description: |
 *       Creates a new terminal session with flexible options (admin only)
 *
 *       **Usage Examples:**
 *
 *       **Root Shell (with Pixel Dimensions - recommended):**
 *       ```json
 *       {
 *         "shell": "/bin/bash",
 *         "cwd": "/",
 *         "width": 1024,
 *         "height": 768
 *       }
 *       ```
 *
 *       **Root Shell (with Cols/Rows - legacy):**
 *       ```json
 *       {
 *         "shell": "/bin/bash",
 *         "cwd": "/",
 *         "cols": 120,
 *         "rows": 40
 *       }
 *       ```
 *
 *       **Docker Container:**
 *       ```json
 *       {
 *         "command": "docker",
 *         "args": ["exec", "-it", "nginx", "/bin/sh"]
 *       }
 *       ```
 *
 *       **LXC Container:**
 *       ```json
 *       {
 *         "command": "lxc-attach",
 *         "args": ["-n", "ubuntu", "--", "/bin/bash"]
 *       }
 *       ```
 *
 *       **Log Viewing (Read-Only):**
 *       ```json
 *       {
 *         "command": "tail",
 *         "args": ["-f", "-n", "200", "/var/log/syslog"],
 *         "readOnly": true
 *       }
 *       ```
 *
 *       **Docker Logs:**
 *       ```json
 *       {
 *         "command": "docker",
 *         "args": ["logs", "-f", "--tail", "100", "nginx"],
 *         "readOnly": true
 *       }
 *       ```
 *
 *       **System Monitoring:**
 *       ```json
 *       {
 *         "command": "htop"
 *       }
 *       ```
 *
 *       After creation, connect via WebSocket using the session ID.
 *     tags: [Terminal]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TerminalConfig'
 *           examples:
 *             shell:
 *               summary: Root Shell (Pixel)
 *               description: Standard Bash Shell with pixel dimensions
 *               value:
 *                 shell: "/bin/bash"
 *                 cwd: "/"
 *                 width: 1024
 *                 height: 768
 *             docker:
 *               summary: Docker Container
 *               description: Access Docker container
 *               value:
 *                 command: "docker"
 *                 args: ["exec", "-it", "nginx", "/bin/sh"]
 *                 width: 800
 *                 height: 600
 *             logs:
 *               summary: Log Viewer
 *               description: Read-Only Log Viewing
 *               value:
 *                 command: "tail"
 *                 args: ["-f", "-n", "100", "/var/log/syslog"]
 *                 readOnly: true
 *                 width: 1200
 *                 height: 800
 *             lxc:
 *               summary: LXC Container
 *               description: LXC Container Attach
 *               value:
 *                 command: "lxc-attach"
 *                 args: ["-n", "ubuntu"]
 *                 width: 900
 *                 height: 600
 *     responses:
 *       201:
 *         description: Terminal session created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TerminalSession'
 *             example:
 *               sessionId: "terminal-1704123456789-x8f9g2k3l"
 *               command: "docker"
 *               args: ["exec", "-it", "nginx", "/bin/sh"]
 *               readOnly: false
 *               cols: 80
 *               rows: 24
 *               cwd: "/"
 *               created: "2024-01-01T12:00:00.000Z"
 *       400:
 *         description: Invalid configuration or command not available
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               invalid_shell:
 *                 summary: Shell not available
 *                 value:
 *                   error: "Failed to create terminal session: spawn /bin/invalid ENOENT"
 *               docker_error:
 *                 summary: Docker container not available
 *                 value:
 *                   error: "Failed to create terminal session: docker exec failed"
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       500:
 *         $ref: '#/components/responses/InternalServerError'
 */
router.post('/create', checkRole('admin'), async (req, res) => {
  try {
    const sessionId = `terminal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const session = await terminalService.createSession(sessionId, req.body);
    res.status(201).json(session);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /terminal/{sessionId}:
 *   get:
 *     summary: Terminal session info
 *     description: Shows information about a specific terminal session (admin only)
 *     tags: [Terminal]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *         description: Terminal Session ID
 *     responses:
 *       200:
 *         description: Session information
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TerminalSession'
 *       404:
 *         description: Session not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.get('/:sessionId', checkRole('admin'), (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = terminalService.getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({
      sessionId,
      command: session.options.command || session.options.shell,
      args: session.options.args || [],
      readOnly: session.options.readOnly,
      cols: session.options.cols,
      rows: session.options.rows,
      cwd: session.options.cwd,
      startTime: session.startTime
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /terminal/{sessionId}/resize:
 *   post:
 *     summary: Resize terminal
 *     description: |
 *       Changes the terminal size for a session (admin only)
 *
 *       Supports two modes:
 *       - **Pixel-based (recommended)**: `width` and `height` in pixels
 *       - **Legacy**: `cols` and `rows` in characters/lines
 *     tags: [Terminal]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *         description: Terminal Session ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             oneOf:
 *               - required: [width, height]
 *               - required: [cols, rows]
 *             properties:
 *               width:
 *                 type: integer
 *                 minimum: 180
 *                 maximum: 3000
 *                 description: Terminal width in pixels (recommended)
 *                 example: 1024
 *               height:
 *                 type: integer
 *                 minimum: 200
 *                 maximum: 2000
 *                 description: Terminal height in pixels (recommended)
 *                 example: 768
 *               cols:
 *                 type: integer
 *                 minimum: 20
 *                 maximum: 200
 *                 description: Terminal width in columns (legacy)
 *                 example: 120
 *               rows:
 *                 type: integer
 *                 minimum: 10
 *                 maximum: 50
 *                 description: Terminal height in rows (legacy)
 *                 example: 40
 *           examples:
 *             pixels:
 *               summary: Pixel-based (recommended)
 *               value:
 *                 width: 1024
 *                 height: 768
 *             legacy:
 *               summary: Cols/Rows (legacy)
 *               value:
 *                 cols: 120
 *                 rows: 40
 *     responses:
 *       200:
 *         description: Terminal size changed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 cols:
 *                   type: integer
 *                   description: Calculated column count
 *                 rows:
 *                   type: integer
 *                   description: Calculated row count
 *                 width:
 *                   type: integer
 *                   description: Optional - Original width in pixels (if sent with width/height)
 *                 height:
 *                   type: integer
 *                   description: Optional - Original height in pixels (if sent with width/height)
 *             examples:
 *               pixels:
 *                 summary: Response for pixel input
 *                 value:
 *                   success: true
 *                   cols: 113
 *                   rows: 38
 *                   width: 1024
 *                   height: 768
 *               legacy:
 *                 summary: Response for cols/rows input
 *                 value:
 *                   success: true
 *                   cols: 120
 *                   rows: 40
 *       400:
 *         description: |
 *           Invalid parameters
 *           - Neither (width, height) nor (cols, rows) provided
 *           - Values outside allowed ranges
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               missing:
 *                 summary: Missing parameters
 *                 value:
 *                   error: "Either (width, height) or (cols, rows) must be provided"
 *               invalid:
 *                 summary: Invalid values
 *                 value:
 *                   error: "Invalid width/height values (width: 180-3000px, height: 200-2000px)"
 *       404:
 *         description: Session not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.post('/:sessionId/resize', checkRole('admin'), (req, res) => {
  try {
    const { sessionId } = req.params;
    const { cols, rows, width, height } = req.body;

    // Support both pixel dimensions and cols/rows
    if (width && height) {
      // Pixel-based resize
      if (width < 180 || width > 3000 || height < 200 || height > 2000) {
        return res.status(400).json({ error: 'Invalid width/height values (width: 180-3000px, height: 200-2000px)' });
      }
      const result = terminalService.resizeSession(sessionId, { width, height });
      res.json({ success: true, ...result, width, height });
    } else if (cols && rows) {
      // Traditional cols/rows resize
      if (cols < 20 || cols > 200 || rows < 10 || rows > 50) {
        return res.status(400).json({ error: 'Invalid cols/rows values' });
      }
      const result = terminalService.resizeSession(sessionId, { cols, rows });
      res.json({ success: true, ...result });
    } else {
      return res.status(400).json({ error: 'Either (width, height) or (cols, rows) must be provided' });
    }
  } catch (error) {
    if (error.message === 'Session not found') {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /terminal/{sessionId}:
 *   delete:
 *     summary: Terminate terminal session
 *     description: Terminates a terminal session (admin only)
 *     tags: [Terminal]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *         description: Terminal Session ID
 *     responses:
 *       200:
 *         description: Session terminated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       404:
 *         description: Session not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.delete('/:sessionId', checkRole('admin'), (req, res) => {
  try {
    const { sessionId } = req.params;
    const killed = terminalService.killSession(sessionId);

    if (!killed) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({ success: true, message: 'Session terminated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});



module.exports = router;