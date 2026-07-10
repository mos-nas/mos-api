const express = require('express');
const cors = require('cors');
const { rateLimit } = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');
const swaggerSpecs = require('./config/swagger');
const config = require('./config');
const http = require('http');
const { Server } = require('socket.io');
const { execSync } = require('child_process');
const net = require('net');
const WebSocket = require('ws');
const fs = require('fs');

// Define socket path
const SOCKET_PATH = '/run/mos-api.sock';

// Enable timestamp logging and format as YYYY-MM-DD HH:MM:SS (local time)
require('log-timestamp')(function() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return '[' + now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + ' ' +
    pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds()) + ']';
});

// Set high priority for API process (only affects this process, not child processes)
try {
  // renice -n -10 -p <pid> (higher priority, requires root)
  execSync(`renice -n -10 -p ${process.pid}`, { stdio: 'ignore' });
  console.info('API process priority set to -10 (high priority)');
} catch (err) {
  console.warn('Could not set process priority (requires root for negative nice values)');
}

// Set I/O priority for API process (best-effort, highest priority)
try {
  // ionice -c 2 -n 0 -p <pid> (class 2 = best-effort, priority 0 = highest)
  execSync(`ionice -c 2 -n 0 -p ${process.pid}`, { stdio: 'ignore' });
  console.info('API I/O priority set to best-effort class, priority 0 (highest)');
} catch (err) {
  console.warn('Could not set I/O priority:', err.message);
}

// Routes
const authRoutes = require('./routes/auth.routes');
const systemRoutes = require('./routes/system.routes');
const disksRoutes = require('./routes/disks.routes');
const poolsRoutes = require('./routes/pools.routes');
const dockerRoutes = require('./routes/docker.routes');
const dockerComposeRoutes = require('./routes/dockercompose.routes');
const lxcRoutes = require('./routes/lxc.routes');
const vmRoutes = require('./routes/vm.routes');
const mosRoutes = require('./routes/mos.routes');
const sharesRoutes = require('./routes/shares.routes');
const remotesRoutes = require('./routes/remotes.routes');
const iscsiRoutes = require('./routes/iscsi.routes');
const iscsiInitiatorRoutes = require('./routes/iscsi-initiator.routes');
const usersRoutes = require('./routes/users.routes');
const cronRoutes = require('./routes/cron.routes');
const terminalRoutes = require('./routes/terminal.routes');
const notificationsRoutes = require('./routes/notifications.routes');
const hubRoutes = require('./routes/hub.routes');
const pluginsRoutes = require('./routes/plugins.routes');
const smartRoutes = require('./routes/smart.routes');
const diagnosticsRoutes = require('./routes/diagnostics.routes');
const llmRoutes = require('./routes/llm.routes');
const poolsWebSocketRoutes = require('./routes/websocket/pools.websocket.routes');
const systemWebSocketRoutes = require('./routes/websocket/system.websocket.routes');
const terminalWebSocketRoutes = require('./routes/websocket/terminal.websocket.routes');
const dockerWebSocketRoutes = require('./routes/websocket/docker.websocket.routes');
const disksWebSocketRoutes = require('./routes/websocket/disks.websocket.routes');
const vmWebSocketRoutes = require('./routes/websocket/vm.websocket.routes');
const lxcWebSocketRoutes = require('./routes/websocket/lxc.websocket.routes');
const fileOperationsWebSocketRoutes = require('./routes/websocket/fileoperations.websocket.routes');

// Middleware
const { authenticateToken } = require('./middleware/auth.middleware');
const errorHandler = require('./middleware/error.middleware');

async function startServer() {
  // Load configuration
  await config.load();

  const app = express();

  // Trust proxy settings for local Nginx only
  app.set('trust proxy', '127.0.0.1');

  // Basic Middleware
  app.use(cors());
  app.use(express.json());

  // Rate Limiting
  const limiter = rateLimit({
    windowMs: (process.env.RATE_LIMIT_WINDOW || 1) * 1000,
    max: process.env.RATE_LIMIT_MAX || 20,
    keyGenerator: (req, res) => {
      if (req.headers['x-real-ip']) {
        return req.headers['x-real-ip'];
      }
      return req.ip;
    },
    standardHeaders: true,
    legacyHeaders: false
  });
  app.use(limiter);

  // Swagger Documentation Route
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpecs, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'MOS API Documentation',
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true
    }
  }));

  /**
   * @swagger
   * /swagger.json:
   *   get:
   *     summary: Swagger JSON Specification
   *     description: Get the raw OpenAPI 3.0 JSON specification for this API
   *     tags: [API]
   *     responses:
   *       200:
   *         description: OpenAPI 3.0 JSON specification
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               description: Complete OpenAPI 3.0 specification
   *               properties:
   *                 openapi:
   *                   type: string
   *                   example: "3.0.0"
   *                 info:
   *                   type: object
   *                   properties:
   *                     title:
   *                       type: string
   *                       example: "MOS API"
   *                     version:
   *                       type: string
   *                       example: "1.0.0"
   *                 paths:
   *                   type: object
   *                   description: All API endpoints
   *                 components:
   *                   type: object
   *                   description: Reusable components (schemas, responses, etc.)
   */

  // Swagger JSON endpoint
  app.get('/swagger.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpecs);
  });

  // Routes
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/system', authenticateToken, systemRoutes);
  app.use('/api/v1/disks/smart', authenticateToken, smartRoutes);
  app.use('/api/v1/disks', authenticateToken, disksRoutes);
  app.use('/api/v1/pools', authenticateToken, poolsRoutes);
  app.use('/api/v1/docker/mos/compose', authenticateToken, dockerComposeRoutes);
  app.use('/api/v1/docker', authenticateToken, dockerRoutes);
  app.use('/api/v1/lxc', authenticateToken, lxcRoutes);
  app.use('/api/v1/vm', authenticateToken, vmRoutes);
  app.use('/api/v1/mos', authenticateToken, mosRoutes);
  app.use('/api/v1/mos/diag', authenticateToken, diagnosticsRoutes);
  app.use('/api/v1/mos/hub', authenticateToken, hubRoutes);
  app.use('/api/v1/llm', authenticateToken, llmRoutes);
  app.use('/api/v1/mos/plugins', authenticateToken, pluginsRoutes);
  app.use('/api/v1/shares', authenticateToken, sharesRoutes);
  app.use('/api/v1/remotes', authenticateToken, remotesRoutes);
  app.use('/api/v1/iscsi', authenticateToken, iscsiRoutes);
  app.use('/api/v1/iscsi/initiator', authenticateToken, iscsiInitiatorRoutes);
  app.use('/api/v1/users', authenticateToken, usersRoutes);
  app.use('/api/v1/cron', authenticateToken, cronRoutes);
  app.use('/api/v1/terminal', authenticateToken, terminalRoutes);
  app.use('/api/v1/notifications', authenticateToken, notificationsRoutes);
  app.use('/api/v1/pools', poolsWebSocketRoutes);
  app.use('/api/v1/system', systemWebSocketRoutes);
  app.use('/api/v1/terminal', terminalWebSocketRoutes);
  app.use('/api/v1/docker', dockerWebSocketRoutes);
  app.use('/api/v1/disks', disksWebSocketRoutes);
  app.use('/api/v1/vm', vmWebSocketRoutes);
  app.use('/api/v1/lxc', lxcWebSocketRoutes);
  app.use('/api/v1/mos', fileOperationsWebSocketRoutes);

  // Error Handling
  app.use(errorHandler);

  /**
   * @swagger
   * tags:
   *   name: API
   *   description: Core API endpoints and utilities
   *
   * components:
   *   schemas:
   *     HealthCheck:
   *       type: object
   *       properties:
   *         status:
   *           type: string
   *           description: API health status
   *           example: "OK"
   *         timestamp:
   *           type: string
   *           format: date-time
   *           description: Current server timestamp
   *           example: "2024-01-20T10:30:00.000Z"
   *         documentation:
   *           type: string
   *           description: Link to API documentation
   *           example: "/api-docs"
   */

  /**
   * @swagger
   * /:
   *   get:
   *     summary: API Documentation Redirect
   *     description: Redirects to the Swagger API documentation interface
   *     tags: [API]
   *     responses:
   *       302:
   *         description: Redirect to API documentation
   *         headers:
   *           Location:
   *             schema:
   *               type: string
   *               example: "/api-docs"
   */

  // Root redirect to API Documentation
  app.get('/', (req, res) => {
    res.redirect('/api-docs');
  });

  /**
   * @swagger
   * /health:
   *   get:
   *     summary: Health Check
   *     description: Check API server health and availability
   *     tags: [API]
   *     responses:
   *       200:
   *         description: API is healthy and operational
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/HealthCheck'
   *             example:
   *               status: "OK"
   *               timestamp: "2024-01-20T10:30:00.000Z"
   *               documentation: "/api-docs"
   *       500:
   *         description: API server error
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 status:
   *                   type: string
   *                   example: "ERROR"
   *                 error:
   *                   type: string
   *                   example: "Internal server error"
   */

  // Health Check
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      documentation: '/api-docs'
    });
  });

  const PORT = process.env.PORT || 998;
  const TCP_ENABLED = String(process.env.LISTEN_TCP).toLowerCase() === 'true';

  // Track all active HTTP servers
  const servers = [];

  // Initialize Socket.io
  const io = new Server({
    path: "/api/v1/socket.io/",
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  // Setup Socket.io handlers
  const terminalService = require('./services/terminal.service');
  const systemService = require('./services/system.service');
  const dockerService = require('./services/docker.service');
  const dockerComposeService = require('./services/dockercompose.service');
  const PoolWebSocketManager = require('./websockets/pools.websocket');
  const SystemLoadWebSocketManager = require('./websockets/system.websocket');
  const TerminalWebSocketManager = require('./websockets/terminal.websocket');
  const DockerWebSocketManager = require('./websockets/docker.websocket');
  const DisksWebSocketManager = require('./websockets/disks.websocket');
  const VmWebSocketManager = require('./websockets/vm.websocket');
  const LxcWebSocketManager = require('./websockets/lxc.websocket');
  const FileOperationsWebSocketManager = require('./websockets/fileoperations.websocket');

  // Initialize event emitter for service communication
  const EventEmitter = require('events');
  const serviceEventEmitter = new EventEmitter();

  // Create separate namespaces to avoid interference
  const poolsNamespace = io.of('/pools');
  const systemNamespace = io.of('/system');
  const terminalNamespace = io.of('/terminal');
  const dockerNamespace = io.of('/docker');
  const disksNamespace = io.of('/disks');
  const vmNamespace = io.of('/vm');
  const lxcNamespace = io.of('/lxc');
  const fileOperationsNamespace = io.of('/fileoperations');

  // Initialize pool WebSocket manager with pools namespace
  const PoolsService = require('./services/pools.service');

  // Create a simple wrapper for WebSocket compatibility
  class PoolsServiceWebSocketWrapper {
    constructor(eventEmitter) {
      this.poolsService = new PoolsService(eventEmitter);
    }

    async listPools(filters = {}, user = null) {
      return await this.poolsService.listPools(filters, user);
    }

    async getPoolById(id, user = null) {
      const pools = await this.listPools({}, user);
      return pools.find(p => p.id === id);
    }

    async getPoolStatus(poolId) {
      const pool = await this.getPoolById(poolId);
      if (!pool) {
        throw new Error(`Pool with ID "${poolId}" not found`);
      }
      return await this.poolsService._getPoolStatus(pool);
    }
  }

  // Initialize Disks service (shared between pool and disks WebSocket managers)
  // Note: disks.service exports a singleton instance, not a class
  const disksServiceInstance = require('./services/disks.service');

  const poolsServiceInstance = new PoolsServiceWebSocketWrapper(serviceEventEmitter);
  // Pass disksService to pool WebSocket manager for performance monitoring
  const poolWebSocketManager = new PoolWebSocketManager(poolsNamespace, poolsServiceInstance, disksServiceInstance);

  // Initialize system load WebSocket manager with system namespace
  // Pass poolsService and disksService for dashboard pools performance monitoring
  const systemLoadWebSocketManager = new SystemLoadWebSocketManager(
    systemNamespace,
    systemService,
    poolsServiceInstance,
    disksServiceInstance
  );

  // Initialize terminal WebSocket manager with terminal namespace
  const terminalWebSocketManager = new TerminalWebSocketManager(terminalNamespace, terminalService);

  // Initialize Docker WebSocket manager with docker namespace
  const dockerWebSocketManager = new DockerWebSocketManager(dockerNamespace, dockerService, dockerComposeService);

  // Initialize Disks WebSocket manager with disks namespace
  const disksWebSocketManager = new DisksWebSocketManager(disksNamespace, disksServiceInstance);

  // Initialize VM WebSocket manager with vm namespace
  const vmService = require('./services/vm.service');
  const vmWebSocketManager = new VmWebSocketManager(vmNamespace, vmService);

  // Initialize LXC WebSocket manager with lxc namespace
  const lxcService = require('./services/lxc.service');
  const lxcWebSocketManager = new LxcWebSocketManager(lxcNamespace, lxcService);

  // Initialize File Operations WebSocket manager with fileoperations namespace
  const fileOperationsService = require('./services/fileoperations.service');
  const fileOperationsWebSocketManager = new FileOperationsWebSocketManager(fileOperationsNamespace, fileOperationsService);

  // Make WebSocket managers available to routes
  app.locals.poolWebSocketManager = poolWebSocketManager;
  app.locals.systemLoadWebSocketManager = systemLoadWebSocketManager;
  app.locals.terminalWebSocketManager = terminalWebSocketManager;
  app.locals.dockerWebSocketManager = dockerWebSocketManager;
  app.locals.disksWebSocketManager = disksWebSocketManager;
  app.locals.vmWebSocketManager = vmWebSocketManager;
  app.locals.lxcWebSocketManager = lxcWebSocketManager;
  app.locals.fileOperationsWebSocketManager = fileOperationsWebSocketManager;

  // Setup namespace handlers
  poolsNamespace.on('connection', (socket) => {
    console.info(`Pools WebSocket client connected: ${socket.id}`);
    poolWebSocketManager.handleConnection(socket);
  });

  systemNamespace.on('connection', (socket) => {
    console.info(`System Load WebSocket client connected: ${socket.id}`);
    systemLoadWebSocketManager.handleConnection(socket);
  });

  // Terminal namespace for terminal connections
  terminalNamespace.on('connection', (socket) => {
    console.info(`Terminal WebSocket client connected: ${socket.id}`);
    terminalWebSocketManager.handleConnection(socket);
  });

  // Docker namespace for Docker operations
  dockerNamespace.on('connection', (socket) => {
    console.info(`Docker WebSocket client connected: ${socket.id}`);
    dockerWebSocketManager.handleConnection(socket);
  });

  // Disks namespace for disk I/O and temperature monitoring
  disksNamespace.on('connection', (socket) => {
    console.info(`Disks WebSocket client connected: ${socket.id}`);
    disksWebSocketManager.handleConnection(socket);
  });

  // VM namespace for VM usage monitoring
  vmNamespace.on('connection', (socket) => {
    console.info(`VM WebSocket client connected: ${socket.id}`);
    vmWebSocketManager.handleConnection(socket);
  });

  // LXC namespace for container usage monitoring
  lxcNamespace.on('connection', (socket) => {
    console.info(`LXC WebSocket client connected: ${socket.id}`);
    lxcWebSocketManager.handleConnection(socket);
  });

  // File Operations namespace for copy/move progress monitoring
  fileOperationsNamespace.on('connection', (socket) => {
    console.info(`FileOps WebSocket client connected: ${socket.id}`);
    fileOperationsWebSocketManager.handleConnection(socket);
  });

  // ============================================================
  // VNC WebSocket Proxy
  // ============================================================
  const vncService = require('./services/vnc.service');

  // Create WebSocket server for VNC (no server attached - we handle upgrade manually)
  const vncWss = new WebSocket.Server({ noServer: true });

  // Handle VNC WebSocket connections
  vncWss.on('connection', (ws, req, session) => {
    console.info(`VNC WebSocket connected for VM "${session.vmName}" (user: ${session.userId})`);

    // Connect to VNC port via TCP
    const tcp = net.connect(session.vncPort, '127.0.0.1', () => {
      console.info(`VNC TCP connected to port ${session.vncPort}`);
      vncService.markConnected(session.token);
    });

    // Error handling for TCP
    tcp.on('error', (err) => {
      console.error(`VNC TCP error for ${session.vmName}:`, err.message);
      ws.close(1011, 'VNC connection failed');
    });

    // Bidirectional data piping
    tcp.on('data', (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    ws.on('message', (data) => {
      if (tcp.writable) {
        tcp.write(data);
      }
    });

    // Cleanup on WebSocket close
    ws.on('close', () => {
      console.info(`VNC WebSocket closed for VM "${session.vmName}"`);
      tcp.destroy();
      vncService.endSession(session.token);
    });

    ws.on('error', (err) => {
      console.error(`VNC WebSocket error for ${session.vmName}:`, err.message);
      tcp.destroy();
      vncService.endSession(session.token);
    });

    // Cleanup on TCP close
    tcp.on('close', () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'VNC connection closed');
      }
    });

    // Heartbeat to detect dead connections
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
  });

  // Heartbeat interval for VNC connections
  const vncHeartbeat = setInterval(() => {
    vncWss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  vncWss.on('close', () => {
    clearInterval(vncHeartbeat);
  });

  // Handle HTTP upgrade requests for VNC WebSocket
  function handleVncUpgrade(req, socket, head) {
    const pathname = req.url;

    // Check if this is a VNC WebSocket request
    const vncMatch = pathname.match(/^\/api\/v1\/vm\/vnc\/ws\/([a-f0-9]{64})$/);

    if (vncMatch) {
      const token = vncMatch[1];
      const session = vncService.validateToken(token);

      if (!session) {
        console.warn(`VNC WebSocket rejected: invalid or expired token`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // Store token in session for later cleanup
      session.token = token;

      // Upgrade to WebSocket
      vncWss.handleUpgrade(req, socket, head, (ws) => {
        vncWss.emit('connection', ws, req, session);
      });
    }
  }

  // Initialize Startup-Caches, SMART monitoring and Pools
  async function initServices() {
    try {
      const disksService = require('./services/disks.service');
      await disksService.initializeStartupCache({ wakeStandbyDisks: false });
    } catch (error) {
      console.error(`Error initializing Disk Startup-Cache: ${error.message}`);
    }

    try {
      const smartService = require('./services/smart.service');
      await smartService.initialize();
    } catch (error) {
      console.error(`Error initializing SMART service: ${error.message}`);
    }

    try {
      const PoolsService = require('./services/pools.service');
      const poolsService = new PoolsService();
      await poolsService.listPools();
    } catch (error) {
      console.error(`Error initializing Pools: ${error.message}`);
    }

    try {
      const VpoolsService = require('./services/vpools.service');
      const vpoolsService = new VpoolsService();
      await vpoolsService.listVpools();
    } catch (error) {
      console.error(`Error initializing Vpools: ${error.message}`);
    }

    try {
      const mosService = require('./services/mos.service');
      await mosService.initSupporterStatus();
    } catch (error) {
      console.error(`Error initializing supporter status: ${error.message}`);
    }
  }

  // Create HTTP server, attach Socket.io and VNC upgrade handling
  function createApiServer() {
    const srv = http.createServer(app);
    io.attach(srv);
    srv.on('upgrade', handleVncUpgrade);
    return srv;
  }

  // Start listening on the Unix socket, optional TCP
  async function startListening() {
    const transports = ['socket'];
    if (TCP_ENABLED) transports.push('tcp');

    for (const transport of transports) {
      const srv = createApiServer();

      if (transport === 'socket') {
        // Remove stale socket file from a previous run
        try {
          if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
        } catch (err) {
          console.warn(`Could not remove stale socket ${SOCKET_PATH}: ${err.message}`);
        }

        await new Promise((resolve, reject) => {
          srv.once('error', reject);
          srv.listen(SOCKET_PATH, () => {
            srv.removeListener('error', reject);
            // Set permissions so nginx can talk to the socket with fallback
            const socketGroup = process.env.SOCKET_GROUP || 'www-data';
            try {
              execSync(`chgrp ${socketGroup} ${SOCKET_PATH}`, { stdio: 'ignore' });
              fs.chmodSync(SOCKET_PATH, 0o660);
            } catch (err) {
              console.warn(`Could not set group "${socketGroup}" on ${SOCKET_PATH} (${err.message}); falling back to 0o666`);
              try {
                fs.chmodSync(SOCKET_PATH, 0o666);
              } catch (chmodErr) {
                console.warn(`Could not chmod socket ${SOCKET_PATH}: ${chmodErr.message}`);
              }
            }
            console.info(`API listening on Unix socket ${SOCKET_PATH}`);
            resolve();
          });
        });
      } else {
        await new Promise((resolve, reject) => {
          srv.once('error', reject);
          srv.listen(PORT, '0.0.0.0', () => {
            srv.removeListener('error', reject);
            console.info(`API listening on TCP port ${PORT}`);
            resolve();
          });
        });
      }

      servers.push(srv);
    }

    await initServices();
  }

  await startListening();
}

startServer().catch(error => {
  console.error('Server startup failed:', error.message);
  process.exit(1);
});

// Remove the Unix socket file on shutdown so the next start can bind cleanly
function cleanupSocketFile() {
  try {
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
  } catch (err) {
    console.warn(`Could not remove socket file ${SOCKET_PATH} on shutdown: ${err.message}`);
  }
}

// Graceful shutdown - end Terminal-Sessions and VNC sessions
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  const terminalService = require('./services/terminal.service');
  const vncService = require('./services/vnc.service');
  terminalService.shutdown();
  vncService.shutdown();
  cleanupSocketFile();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  const terminalService = require('./services/terminal.service');
  const vncService = require('./services/vnc.service');
  terminalService.shutdown();
  vncService.shutdown();
  cleanupSocketFile();
  process.exit(0);
});
