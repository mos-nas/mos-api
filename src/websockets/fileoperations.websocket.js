/**
 * File Operations WebSocket Manager
 * Provides real-time progress updates for copy/move operations
 *
 * Events:
 * - subscribe-operation: Subscribe to a specific operation by ID
 * - subscribe-all: Subscribe to all file operations
 * - unsubscribe-operation: Unsubscribe from a specific operation
 * - unsubscribe-all: Unsubscribe from all file operations
 *
 * Emits:
 * - fileoperations-update: Operation progress update (single operation object)
 * - fileoperations-list: All operations (on subscribe-all)
 * - fileoperations-subscription-confirmed: Subscription confirmed
 * - error: Error occurred
 */

class FileOperationsWebSocketManager {
  constructor(io, fileOperationsService) {
    this.io = io;
    this.fileOperationsService = fileOperationsService;
    this.broadcastInterval = 2000; // 2 seconds
    this.activeSubscriptions = new Map();
    this.authCache = new Map();
    this.authCacheDuration = 5 * 60 * 1000; // 5 minutes

    // Client subscriptions: Map<socketId, { user: Object, operationIds: Set<string>, subscribedAll: boolean }>
    this.clientSubscriptions = new Map();

    // Listen for operation updates from the service
    this.fileOperationsService.on('operation-update', (operationId, rawOp) => {
      this._handleOperationUpdate(operationId, rawOp);
    });

    // Start periodic broadcast for progress updates
    this._startBroadcastLoop();
  }

  /**
   * Handle WebSocket connection for file operations monitoring
   */
  handleConnection(socket) {
    // Subscribe to a specific operation by ID
    socket.on('subscribe-operation', async (data) => {
      try {
        const { token, operationId } = data;

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          socket.emit('error', { message: authResult.message });
          return;
        }

        if (!operationId) {
          socket.emit('error', { message: 'operationId is required' });
          return;
        }

        socket.userId = authResult.user.id;
        socket.userRole = authResult.user.role;
        socket.user = authResult.user;

        // Initialize client subscription if not exists
        if (!this.clientSubscriptions.has(socket.id)) {
          this.clientSubscriptions.set(socket.id, {
            user: authResult.user,
            operationIds: new Set(),
            subscribedAll: false
          });
        }

        const sub = this.clientSubscriptions.get(socket.id);
        sub.operationIds.add(operationId);
        sub.user = authResult.user;

        // Join operation-specific room
        socket.join(`operation-${operationId}`);

        console.log(`Client ${socket.id} subscribed to file operation: ${operationId}`);

        // Send immediate current state of the operation
        const op = this.fileOperationsService.getOperation(operationId, authResult.user);
        if (op) {
          socket.emit('fileoperations-update', op);
        }

        socket.emit('fileoperations-subscription-confirmed', {
          operationId,
          interval: this.broadcastInterval
        });
      } catch (error) {
        console.error('Error in subscribe-operation:', error);
        socket.emit('error', { message: 'Failed to subscribe to operation' });
      }
    });

    // Subscribe to all file operations
    socket.on('subscribe-all', async (data) => {
      try {
        const { token } = data;

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          socket.emit('error', { message: authResult.message });
          return;
        }

        socket.userId = authResult.user.id;
        socket.userRole = authResult.user.role;
        socket.user = authResult.user;

        // Initialize client subscription
        if (!this.clientSubscriptions.has(socket.id)) {
          this.clientSubscriptions.set(socket.id, {
            user: authResult.user,
            operationIds: new Set(),
            subscribedAll: false
          });
        }

        const sub = this.clientSubscriptions.get(socket.id);
        sub.subscribedAll = true;
        sub.user = authResult.user;

        // Join all-operations room
        socket.join('fileoperations-all');

        console.log(`Client ${socket.id} subscribed to all file operations`);

        // Send immediate list of all operations
        const ops = this.fileOperationsService.getOperations(authResult.user);
        socket.emit('fileoperations-list', ops);

        socket.emit('fileoperations-subscription-confirmed', {
          all: true,
          interval: this.broadcastInterval
        });
      } catch (error) {
        console.error('Error in subscribe-all:', error);
        socket.emit('error', { message: 'Failed to subscribe to file operations' });
      }
    });

    // Unsubscribe from a specific operation
    socket.on('unsubscribe-operation', (data) => {
      try {
        const { operationId } = data || {};
        if (!operationId) return;

        socket.leave(`operation-${operationId}`);

        const sub = this.clientSubscriptions.get(socket.id);
        if (sub) {
          sub.operationIds.delete(operationId);
        }

        console.log(`Client ${socket.id} unsubscribed from file operation: ${operationId}`);
        socket.emit('fileoperations-unsubscription-confirmed', { operationId });
      } catch (error) {
        console.error('Error in unsubscribe-operation:', error);
      }
    });

    // Unsubscribe from all file operations
    socket.on('unsubscribe-all', () => {
      try {
        socket.leave('fileoperations-all');

        const sub = this.clientSubscriptions.get(socket.id);
        if (sub) {
          sub.subscribedAll = false;
        }

        console.log(`Client ${socket.id} unsubscribed from all file operations`);
        socket.emit('fileoperations-unsubscription-confirmed', { all: true });
      } catch (error) {
        console.error('Error in unsubscribe-all:', error);
      }
    });

    // Update user preferences (e.g., byte_format changed)
    socket.on('update-preferences', async (data) => {
      try {
        const { byte_format } = data || {};

        if (byte_format && (byte_format === 'binary' || byte_format === 'decimal')) {
          if (socket.user) {
            socket.user.byte_format = byte_format;
          }

          const sub = this.clientSubscriptions.get(socket.id);
          if (sub && sub.user) {
            sub.user.byte_format = byte_format;
            this.clientSubscriptions.set(socket.id, sub);
          }

          socket.emit('preferences-updated', { byte_format });
          console.log(`FileOps client ${socket.id} updated byte_format to: ${byte_format}`);
        }
      } catch (error) {
        console.error('Error in update-preferences:', error);
        socket.emit('error', { message: 'Failed to update preferences' });
      }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      console.log(`FileOps WebSocket client disconnected: ${socket.id}`);
      this.clientSubscriptions.delete(socket.id);
      // Operations continue running in the service regardless of WS disconnects
    });
  }

  /**
   * Handle operation update from the service (status changes like completed/failed/cancelled)
   * These are emitted immediately, not waiting for the broadcast interval
   * @private
   */
  _handleOperationUpdate(operationId, rawOp) {
    // Only immediately push for state changes (not progress updates during running)
    if (['completed', 'failed', 'cancelled', 'preparing'].includes(rawOp.status)) {
      this._broadcastOperationToSubscribers(operationId, rawOp);
    }
  }

  /**
   * Broadcast a single operation update to all relevant subscribers
   * @private
   */
  _broadcastOperationToSubscribers(operationId, rawOp) {
    const disksService = require('../services/disks.service');

    // Send to operation-specific room
    const operationRoom = this.io.adapter.rooms.get(`operation-${operationId}`);
    if (operationRoom) {
      for (const socketId of operationRoom) {
        const socket = this.io.sockets.get(socketId);
        if (!socket) continue;
        const sub = this.clientSubscriptions.get(socketId);
        const user = sub?.user || null;
        socket.emit('fileoperations-update', this._formatOperation(rawOp, user, disksService));
      }
    }

    // Send to all-operations room
    const allRoom = this.io.adapter.rooms.get('fileoperations-all');
    if (allRoom) {
      for (const socketId of allRoom) {
        // Skip if already sent via operation-specific room
        if (operationRoom && operationRoom.has(socketId)) continue;
        const socket = this.io.sockets.get(socketId);
        if (!socket) continue;
        const sub = this.clientSubscriptions.get(socketId);
        const user = sub?.user || null;
        socket.emit('fileoperations-update', this._formatOperation(rawOp, user, disksService));
      }
    }
  }

  /**
   * Start periodic broadcast loop for progress updates (every 2s)
   * @private
   */
  _startBroadcastLoop() {
    this.broadcastIntervalId = setInterval(() => {
      this._broadcastProgressUpdates();
    }, this.broadcastInterval);
  }

  /**
   * Broadcast progress updates for all running operations
   * @private
   */
  _broadcastProgressUpdates() {
    // Check if any clients are subscribed
    const allRoom = this.io.adapter.rooms.get('fileoperations-all');
    const hasAllSubscribers = allRoom && allRoom.size > 0;
    const hasAnySubscribers = hasAllSubscribers || this.clientSubscriptions.size > 0;

    if (!hasAnySubscribers) return;

    const disksService = require('../services/disks.service');

    // Get all running operations
    for (const [id, op] of this.fileOperationsService.operations) {
      if (op.status !== 'running') continue;

      const rawOp = {
        id: op.id,
        operation: op.operation,
        source: op.source,
        destination: op.destination,
        destinationFull: op.destinationFull,
        status: op.status,
        instantMove: op.instantMove,
        onConflict: op.onConflict,
        progress: op.progress,
        speed: op.speed,
        eta: op.eta,
        bytesTransferred: op.bytesTransferred,
        bytesTotal: op.bytesTotal,
        startedAt: op.startedAt,
        completedAt: op.completedAt,
        error: op.error
      };

      // Send to operation-specific room
      const operationRoom = this.io.adapter.rooms.get(`operation-${id}`);
      if (operationRoom) {
        for (const socketId of operationRoom) {
          const socket = this.io.sockets.get(socketId);
          if (!socket) continue;
          const sub = this.clientSubscriptions.get(socketId);
          const user = sub?.user || null;
          socket.emit('fileoperations-update', this._formatOperation(rawOp, user, disksService));
        }
      }

      // Send to all-operations room
      if (hasAllSubscribers) {
        for (const socketId of allRoom) {
          if (operationRoom && operationRoom.has(socketId)) continue;
          const socket = this.io.sockets.get(socketId);
          if (!socket) continue;
          const sub = this.clientSubscriptions.get(socketId);
          const user = sub?.user || null;
          socket.emit('fileoperations-update', this._formatOperation(rawOp, user, disksService));
        }
      }
    }
  }

  /**
   * Format raw operation data with human-readable fields for a specific user
   * @private
   */
  _formatOperation(rawOp, user, disksService) {
    return {
      id: rawOp.id,
      operation: rawOp.operation,
      source: rawOp.source,
      destination: rawOp.destination,
      destinationFull: rawOp.destinationFull,
      status: rawOp.status,
      instantMove: rawOp.instantMove,
      onConflict: rawOp.onConflict,
      progress: rawOp.progress,
      speed: rawOp.speed,
      speed_human: disksService.formatSpeed(rawOp.speed, user),
      eta: rawOp.eta,
      bytesTransferred: rawOp.bytesTransferred,
      bytesTransferred_human: disksService.formatBytes(rawOp.bytesTransferred, user),
      bytesTotal: rawOp.bytesTotal,
      bytesTotal_human: disksService.formatBytes(rawOp.bytesTotal, user),
      startedAt: rawOp.startedAt,
      completedAt: rawOp.completedAt,
      error: rawOp.error
    };
  }

  /**
   * Get monitoring statistics
   */
  getMonitoringStats() {
    const allRoom = this.io.adapter.rooms.get('fileoperations-all');

    return {
      subscribedClients: this.clientSubscriptions.size,
      allSubscribers: allRoom ? allRoom.size : 0,
      runningOperations: this.fileOperationsService.getRunningCount(),
      broadcastInterval: this.broadcastInterval
    };
  }

  /**
   * Authenticate user with caching
   */
  async authenticateUser(token) {
    if (!token) {
      return { success: false, message: 'Authentication token is required' };
    }

    const jwt = require('jsonwebtoken');
    const { getBootToken, isActionAllowed } = require('../middleware/auth.middleware');
    const userService = require('../services/user.service');

    // Check cache first
    const cached = this.authCache.get(token);
    if (cached && (Date.now() - cached.timestamp) < this.authCacheDuration) {
      // Refresh byte_format from database for regular users
      if (cached.data.success && cached.data.user && !cached.data.user.isBootToken && cached.data.user.id !== 'boot') {
        try {
          const users = await userService.loadUsers();
          const currentUser = users.find(u => u.id === cached.data.user.id);
          if (currentUser) {
            return {
              ...cached.data,
              user: {
                ...cached.data.user,
                byte_format: currentUser.byte_format
              }
            };
          }
        } catch (e) {
          // Fallback to cached data
        }
      }
      return cached.data;
    }

    try {
      // Check if it's the boot token
      const bootToken = await getBootToken();
      if (bootToken && token === bootToken) {
        const result = {
          success: true,
          user: {
            id: 'boot',
            username: 'boot',
            role: 'admin',
            isBootToken: true,
            byte_format: 'binary'
          }
        };
        this.authCache.set(token, { data: result, timestamp: Date.now() });
        return result;
      }

      // Check if it's an admin API token
      const adminTokenData = await userService.validateAdminToken(token);
      if (adminTokenData) {
        // Restricted tokens need 'read' permission for 'mos' (file operations)
        if (!isActionAllowed(adminTokenData.permissions, 'mos', 'read')) {
          return { success: false, message: "Access denied. This token does not have 'read' permission for 'mos'." };
        }
        const result = {
          success: true,
          user: adminTokenData
        };
        this.authCache.set(token, { data: result, timestamp: Date.now() });
        return result;
      }

      // Regular JWT verification
      const decodedUser = jwt.verify(token, process.env.JWT_SECRET);

      // Check if user still exists
      const users = await userService.loadUsers();
      const currentUser = users.find(u => u.id === decodedUser.id);

      if (!currentUser) {
        return { success: false, message: 'User no longer exists' };
      }

      // samba_only users are not allowed
      if (currentUser.role === 'samba_only') {
        return { success: false, message: 'Access denied. This account is for file sharing only' };
      }

      // Check if role has changed
      if (currentUser.role !== decodedUser.role) {
        return { success: false, message: 'Token invalid due to role change. Please login again' };
      }

      const result = {
        success: true,
        user: {
          id: currentUser.id,
          username: currentUser.username,
          role: currentUser.role,
          byte_format: currentUser.byte_format || 'binary'
        }
      };

      this.authCache.set(token, { data: result, timestamp: Date.now() });
      return result;

    } catch (authError) {
      const errorResult = { success: false, message: 'Invalid authentication token' };
      this.authCache.set(token, { data: errorResult, timestamp: Date.now() });
      return errorResult;
    }
  }
}

module.exports = FileOperationsWebSocketManager;
