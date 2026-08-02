
class NutWebSocketManager {
  constructor(io, nutService) {
    this.io = io;
    this.nutService = nutService;
    this.monitoringInterval = null;
    this.updateInterval = 5000; // 5 seconds
    this.authCache = new Map();
    this.authCacheDuration = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Handle WebSocket connection for NUT/UPS status monitoring
   */
  handleConnection(socket) {
    // Subscribe to UPS status updates
    socket.on('subscribe-nut-status', async (data) => {
      try {
        const { token } = data || {};

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          socket.emit('error', { message: authResult.message });
          return;
        }

        // NUT status is admin-only
        if (authResult.user.role !== 'admin') {
          socket.emit('error', { message: 'Admin role required for NUT status' });
          return;
        }

        socket.userId = authResult.user.userId;
        socket.userRole = authResult.user.role;

        // Join UPS status room
        socket.join('nut-status');
        console.log(`Client ${socket.id} (${authResult.user.role}) subscribed to NUT status monitoring`);

        // Send immediate update
        await this.sendStatusUpdate(socket);

        // Start monitoring if not already running
        this.startMonitoring();

        socket.emit('nut-status-subscription-confirmed', {
          interval: this.updateInterval
        });
      } catch (error) {
        console.error('Error in subscribe-nut-status:', error);
        socket.emit('error', { message: 'Failed to subscribe to NUT status updates' });
      }
    });

    // Unsubscribe from UPS status
    socket.on('unsubscribe-nut-status', () => {
      try {
        socket.leave('nut-status');
        console.log(`Client ${socket.id} unsubscribed from NUT status`);

        // Check if we should stop monitoring
        this.checkStopMonitoring();

        socket.emit('nut-status-unsubscription-confirmed');
      } catch (error) {
        console.error('Error in unsubscribe-nut-status:', error);
      }
    });

    // Get immediate UPS status (one-time request)
    socket.on('get-nut-status', async (data) => {
      try {
        const { token } = data || {};

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          socket.emit('error', { message: authResult.message });
          return;
        }

        // NUT status is admin-only
        if (authResult.user.role !== 'admin') {
          socket.emit('error', { message: 'Admin role required for NUT status' });
          return;
        }

        await this.sendStatusUpdate(socket);
      } catch (error) {
        console.error('Error in get-nut-status:', error);
        socket.emit('error', { message: 'Failed to get NUT status data' });
      }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      this.checkStopMonitoring();
    });
  }

  /**
   * Authenticate user from JWT token
   * Supports: Boot token, Admin API token, Regular JWT
   */
  async authenticateUser(token) {
    if (!token) {
      return { success: false, message: 'Authentication token is required' };
    }

    // Check cache first
    const cached = this.authCache.get(token);
    if (cached && Date.now() - cached.timestamp < this.authCacheDuration) {
      return { success: true, user: cached.user };
    }

    try {
      const jwt = require('jsonwebtoken');
      const { getBootToken, isActionAllowed } = require('../middleware/auth.middleware');
      const userService = require('../services/user.service');

      // Check if it's the boot token
      const bootToken = await getBootToken();
      if (bootToken && token === bootToken) {
        const user = {
          id: 'boot',
          userId: 'boot',
          username: 'boot',
          role: 'admin',
          isBootToken: true
        };
        this.authCache.set(token, { user, timestamp: Date.now() });
        return { success: true, user };
      }

      // Check if it's an admin API token
      const adminTokenData = await userService.validateAdminToken(token);
      if (adminTokenData) {
        // Restricted tokens need 'read' permission for 'nut'
        if (!isActionAllowed(adminTokenData.permissions, 'nut', 'read')) {
          return { success: false, message: "Access denied. This token does not have 'read' permission for 'nut'." };
        }
        const user = {
          ...adminTokenData,
          userId: adminTokenData.id
        };
        this.authCache.set(token, { user, timestamp: Date.now() });
        return { success: true, user };
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

      const user = {
        id: currentUser.id,
        userId: currentUser.id,
        username: currentUser.username,
        role: currentUser.role,
        byte_format: currentUser.byte_format
      };

      // Cache the result
      this.authCache.set(token, { user, timestamp: Date.now() });

      return { success: true, user };
    } catch (error) {
      return { success: false, message: 'Invalid or expired token' };
    }
  }

  /**
   * Send UPS status update to a socket or the whole room
   */
  async sendStatusUpdate(target) {
    try {
      const status = await this.nutService.getStatus();
      const payload = { ...status, timestamp: Date.now() };

      if (target && target.emit) {
        // Single socket
        target.emit('nut-status-update', payload);
      } else {
        // Broadcast to everyone in the room
        this.io.to('nut-status').emit('nut-status-update', payload);
      }
    } catch (error) {
      console.error('Error sending NUT status update:', error);
    }
  }

  /**
   * Start monitoring if clients are subscribed
   */
  startMonitoring() {
    if (this.monitoringInterval) return;

    const room = this.io.adapter.rooms.get('nut-status');
    if (!room || room.size === 0) return;

    console.log('Starting NUT status monitoring');

    this.monitoringInterval = setInterval(async () => {
      const room = this.io.adapter.rooms.get('nut-status');
      if (!room || room.size === 0) {
        this.stopMonitoring();
        return;
      }

      await this.sendStatusUpdate();
    }, this.updateInterval);
  }

  /**
   * Stop monitoring
   */
  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
      console.log('Stopped NUT status monitoring');
    }
  }

  /**
   * Check if monitoring should be stopped
   */
  checkStopMonitoring() {
    const room = this.io.adapter.rooms.get('nut-status');
    if (!room || room.size === 0) {
      this.stopMonitoring();
    }
  }

  /**
   * Get monitoring statistics
   */
  getStats() {
    const room = this.io.adapter.rooms.get('nut-status');
    return {
      activeSubscriptions: room ? room.size : 0,
      clientCount: this.io.sockets.size,
      subscription: this.monitoringInterval ? {
        interval: this.updateInterval,
        isActive: true
      } : null
    };
  }

  /**
   * Cleanup expired auth cache entries
   */
  cleanupAuthCache() {
    const now = Date.now();
    for (const [token, data] of this.authCache.entries()) {
      if (now - data.timestamp > this.authCacheDuration) {
        this.authCache.delete(token);
      }
    }
  }
}

module.exports = NutWebSocketManager;
