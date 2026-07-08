
class VmWebSocketManager {
  constructor(io, vmService) {
    this.io = io;
    this.vmService = vmService;
    this.monitoringInterval = null;
    this.updateInterval = 2000; // 2 seconds (includes 1s CPU measurement internally)
    this.authCache = new Map();
    this.authCacheDuration = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Handle WebSocket connection for VM usage monitoring
   */
  handleConnection(socket) {
    // Subscribe to VM usage updates (all VMs or single VM)
    socket.on('subscribe-vm-usage', async (data) => {
      try {
        const { token, name } = data || {};

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          socket.emit('error', { message: authResult.message });
          return;
        }

        socket.userId = authResult.user.userId;
        socket.userRole = authResult.user.role;
        socket.vmFilter = name || null; // null = all VMs, string = single VM

        // Join VM usage room
        socket.join('vm-usage');
        const target = name ? `VM "${name}"` : 'all VMs';
        console.log(`Client ${socket.id} (${authResult.user.role}) subscribed to ${target} usage monitoring`);

        // Send immediate update
        await this.sendVmUsageUpdate(socket);

        // Start monitoring if not already running
        this.startMonitoring();

        socket.emit('vm-usage-subscription-confirmed', {
          interval: this.updateInterval,
          filter: name || 'all'
        });
      } catch (error) {
        console.error('Error in subscribe-vm-usage:', error);
        socket.emit('error', { message: 'Failed to subscribe to VM usage updates' });
      }
    });

    // Unsubscribe from VM usage
    socket.on('unsubscribe-vm-usage', () => {
      try {
        socket.leave('vm-usage');
        console.log(`Client ${socket.id} unsubscribed from VM usage`);

        // Check if we should stop monitoring
        this.checkStopMonitoring();

        socket.emit('vm-usage-unsubscription-confirmed');
      } catch (error) {
        console.error('Error in unsubscribe-vm-usage:', error);
      }
    });

    // Get immediate VM usage data (one-time request)
    socket.on('get-vm-usage', async (data) => {
      try {
        const { token } = data || {};

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          socket.emit('error', { message: authResult.message });
          return;
        }

        await this.sendVmUsageUpdate(socket);
      } catch (error) {
        console.error('Error in get-vm-usage:', error);
        socket.emit('error', { message: 'Failed to get VM usage data' });
      }
    });

    // Get all VMs with full details (one-time request, like GET /vm/machines)
    socket.on('get-vm-machines', async (data) => {
      try {
        const { token } = data || {};

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          socket.emit('error', { message: authResult.message });
          return;
        }

        const machines = await this.vmService.listVms();
        socket.emit('vm-machines-update', {
          machines,
          timestamp: Date.now()
        });
      } catch (error) {
        console.error('Error in get-vm-machines:', error);
        socket.emit('error', { message: 'Failed to get VM machines data' });
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
        // Restricted tokens need 'read' permission for 'vm'
        if (!isActionAllowed(adminTokenData.permissions, 'vm', 'read')) {
          return { success: false, message: "Access denied. This token does not have 'read' permission for 'vm'." };
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
   * Send VM usage update to a socket or room
   * Respects socket.vmFilter for single VM filtering
   */
  async sendVmUsageUpdate(target) {
    try {
      const allUsage = await this.vmService.getVmUsage();

      if (target && target.emit) {
        // Single socket - apply filter if set
        const usage = target.vmFilter
          ? allUsage.filter(vm => vm.name === target.vmFilter)
          : allUsage;

        target.emit('vm-usage-update', {
          vms: usage,
          timestamp: Date.now()
        });
      } else {
        // Room - send to each socket with their individual filter
        const room = this.io.adapter.rooms.get('vm-usage');
        if (!room) return;

        for (const socketId of room) {
          const socket = this.io.sockets.get(socketId);
          if (!socket) continue;

          const usage = socket.vmFilter
            ? allUsage.filter(vm => vm.name === socket.vmFilter)
            : allUsage;

          socket.emit('vm-usage-update', {
            vms: usage,
            timestamp: Date.now()
          });
        }
      }
    } catch (error) {
      console.error('Error sending VM usage update:', error);
    }
  }

  /**
   * Start monitoring if clients are subscribed
   */
  startMonitoring() {
    if (this.monitoringInterval) return;

    const room = this.io.adapter.rooms.get('vm-usage');
    if (!room || room.size === 0) return;

    console.log('Starting VM usage monitoring');

    this.monitoringInterval = setInterval(async () => {
      const room = this.io.adapter.rooms.get('vm-usage');
      if (!room || room.size === 0) {
        this.stopMonitoring();
        return;
      }

      await this.sendVmUsageUpdate();
    }, this.updateInterval);
  }

  /**
   * Stop monitoring
   */
  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
      console.log('Stopped VM usage monitoring');
    }
  }

  /**
   * Check if monitoring should be stopped
   */
  checkStopMonitoring() {
    const room = this.io.adapter.rooms.get('vm-usage');
    if (!room || room.size === 0) {
      this.stopMonitoring();
    }
  }

  /**
   * Get monitoring statistics
   */
  getStats() {
    const room = this.io.adapter.rooms.get('vm-usage');
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

module.exports = VmWebSocketManager;
