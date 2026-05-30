
class PoolWebSocketManager {
  constructor(io, poolsService, disksService = null) {
    this.io = io;
    this.poolsService = poolsService;
    this.disksService = disksService;
    this.activeSubscriptions = new Map();
    this.dataCache = new Map();
    this.cacheDuration = 8000; // 8 seconds cache
    this.defaultInterval = 10000; // 10 seconds default update interval
    this.performanceInterval = 2000; // 2 seconds for performance updates

    // Client preferences: Map<socketId, { includePerformance: boolean, user: Object }>
    this.clientPreferences = new Map();
  }

  /**
   * Handle WebSocket connection for pool monitoring
   */
  handleConnection(socket) {
    console.log(`Client connected for pool monitoring: ${socket.id}`);

    // Subscribe to pools with filters (replaces both single pool and all pools)
    socket.on('subscribe-pools', async (data) => {
      try {
        const { interval = this.defaultInterval, token, filters = {}, includePerformance = false } = data;

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          socket.emit('error', { message: authResult.message });
          return;
        }

        socket.userId = authResult.user.userId;
        socket.userRole = authResult.user.role;
        socket.user = authResult.user;

        // Store client preferences
        this.clientPreferences.set(socket.id, {
          includePerformance,
          user: authResult.user,
          filters
        });

        // Join pools room
        socket.join('pools');
        console.log(`Client ${socket.id} (${authResult.user.role}) subscribed to pools with filters:`, filters,
          includePerformance ? '(with performance)' : '');

        // Start disk stats sampling if performance is requested
        if (includePerformance && this.disksService && !this.disksService.isDiskStatsSamplingActive()) {
          this.disksService.startDiskStatsSampling(this.performanceInterval);
        }

        // Send immediate update
        await this.sendPoolsUpdate(socket, false, filters);

        // Start monitoring
        this.startPoolsMonitoring(interval, filters);

        // Start performance monitoring if requested
        if (includePerformance) {
          this.startPerformanceMonitoring();
        }

        socket.emit('pools-subscription-confirmed', {
          interval,
          filters,
          includePerformance,
          performanceInterval: includePerformance ? this.performanceInterval : null
        });
      } catch (error) {
        console.error('Error in subscribe-pools:', error);
        socket.emit('error', { message: 'Failed to subscribe to pools updates' });
      }
    });

    // Unsubscribe from pools
    socket.on('unsubscribe-pools', () => {
      try {
        socket.leave('pools');
        this.clientPreferences.delete(socket.id);
        console.log(`Client ${socket.id} unsubscribed from pools`);

        // Check if we should stop monitoring
        this.checkStopPoolsMonitoring();

        socket.emit('pools-unsubscription-confirmed');
      } catch (error) {
        console.error('Error in unsubscribe-pools:', error);
      }
    });

    // Get immediate pools data (one-time request)
    socket.on('get-pools', async (data) => {
      try {
        const { token, filters = {} } = data;

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          socket.emit('error', { message: authResult.message });
          return;
        }

        await this.sendPoolsUpdate(socket, true, filters); // Force refresh
      } catch (error) {
        console.error('Error in get-pools:', error);
        socket.emit('error', { message: 'Failed to get pools data' });
      }
    });

    // Update user preferences (e.g., byte_format changed)
    socket.on('update-preferences', async (data) => {
      try {
        const { byte_format } = data || {};

        if (byte_format && (byte_format === 'binary' || byte_format === 'decimal')) {
          // Update socket.user
          if (socket.user) {
            socket.user.byte_format = byte_format;
          }

          // Update clientPreferences
          const prefs = this.clientPreferences.get(socket.id);
          if (prefs && prefs.user) {
            prefs.user.byte_format = byte_format;
            this.clientPreferences.set(socket.id, prefs);
          }

          // Clear all pools caches to force refresh with new format
          for (const [key] of this.dataCache) {
            if (key.startsWith('pools-data-') || key.startsWith('pools-last-hash-')) {
              this.dataCache.delete(key);
            }
          }

          // Send immediate update with new format
          const filters = prefs?.filters || {};
          await this.sendPoolsUpdate(socket, true, filters);

          socket.emit('preferences-updated', { byte_format });
          console.log(`Client ${socket.id} updated byte_format to: ${byte_format}`);
        }
      } catch (error) {
        console.error('Error in update-preferences:', error);
        socket.emit('error', { message: 'Failed to update preferences' });
      }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      console.log(`Client disconnected: ${socket.id}`);
      this.clientPreferences.delete(socket.id);
      // Socket.io automatically handles room cleanup
      // Check if monitoring needs to be stopped
      this.checkStopPoolsMonitoring();
    });
  }

  /**
   * Start monitoring pools with filters if not already active
   */
  startPoolsMonitoring(interval = this.defaultInterval, filters = {}) {
    const monitoringKey = `pools-${JSON.stringify(filters)}`;

    if (this.activeSubscriptions.has(monitoringKey)) {
      return; // Already monitoring
    }

    console.log(`Starting pools monitoring with ${interval}ms interval and filters:`, filters);

    const intervalId = setInterval(async () => {
      try {
        // Check if anyone is still subscribed
        const room = this.io.adapter.rooms.get('pools');
        if (!room || room.size === 0) {
          console.log('No clients subscribed to pools, stopping monitoring');
          clearInterval(intervalId);
          this.activeSubscriptions.delete(monitoringKey);
          return;
        }

        // Send update to all subscribers with same filters
        await this.sendPoolsUpdate(null, false, filters);
      } catch (error) {
        console.error('Error in pools monitoring:', error);
      }
    }, interval);

    this.activeSubscriptions.set(monitoringKey, {
      intervalId,
      interval,
      startTime: Date.now(),
      filters
    });
  }

  /**
   * Check if monitoring should be stopped
   */
  checkStopPoolsMonitoring() {
    const room = this.io.adapter.rooms.get('pools');
    if (!room || room.size === 0) {
      // Stop all monitoring subscriptions
      for (const [key, subscription] of this.activeSubscriptions) {
        if (key.startsWith('pools-')) {
          console.log(`Stopping pools monitoring: ${key}`);
          clearInterval(subscription.intervalId);
          this.activeSubscriptions.delete(key);
        }
      }
      // Clear all pools cache
      for (const [key] of this.dataCache) {
        if (key.startsWith('pools-data-') || key.startsWith('pools-last-hash-')) {
          this.dataCache.delete(key);
        }
      }

      // Stop performance monitoring
      this.stopPerformanceMonitoring();

      // Clear client preferences
      this.clientPreferences.clear();
    }
  }

  /**
   * Send pools update to socket or room
   * Uses same data structure as REST API GET /pools
   */
  async sendPoolsUpdate(socket, forceRefresh = false, filters = {}, user = null) {
    try {
      // Get user from socket if not provided
      const effectiveUser = user || socket?.user || this.getFirstConnectedUser();
      const poolsData = await this.getPoolsDataWithCache(forceRefresh, filters, effectiveUser);

      // Generate hash of current data for change detection
      const currentHash = this.generateDataHash(poolsData);
      const lastHashKey = `pools-last-hash-${JSON.stringify(filters)}`;
      const lastHash = this.dataCache.get(lastHashKey);

      // Only send if data actually changed or it's a forced refresh
      if (!forceRefresh && lastHash === currentHash) {
        return;
      }

      // Store new hash
      this.dataCache.set(lastHashKey, currentHash);

      // Send pools data as pure array, identical to REST API GET /pools
      if (socket) {
        socket.emit('pools-update', poolsData);
      } else {
        this.io.to('pools').emit('pools-update', poolsData);
      }

      // Debug
      //console.log('Pools data changed, update sent to clients with filters:', filters);

    } catch (error) {
      console.error('Failed to send pools update:', error);

      const errorMsg = {
        error: error.message,
        timestamp: new Date().toISOString()
      };

      if (socket) {
        socket.emit('error', errorMsg);
      } else {
        this.io.to('pools').emit('error', errorMsg);
      }
    }
  }

  /**
   * Get first connected user from pools room for byte format preference
   */
  getFirstConnectedUser() {
    const room = this.io.adapter.rooms.get('pools');
    if (!room || room.size === 0) return null;

    const iterator = room.keys();
    const firstSocketId = iterator.next().value;
    const prefs = this.clientPreferences.get(firstSocketId);
    return prefs?.user || null;
  }

  /**
   * Get pools data with caching (includes complete disk details)
   * Reuses the pools service method to maintain consistency with REST API
   */
  async getPoolsDataWithCache(forceRefresh = false, filters = {}, user = null) {
    // Include byte_format in cache key to avoid serving wrong format
    const byteFormat = user?.byte_format || 'binary';
    const cacheKey = `pools-data-${JSON.stringify(filters)}-${byteFormat}`;
    const cached = this.dataCache.get(cacheKey);

    // Return cached data if valid and not forcing refresh
    if (!forceRefresh && cached && (Date.now() - cached.timestamp) < this.cacheDuration) {
      return cached.data;
    }

    try {
      // Use pools service with same filtering as REST API GET /pools
      const pools = await this.poolsService.listPools(filters, user);

      // Enrich with SMART data (smartWarning + temperatureStatus) - same as REST API
      const smartService = require('../services/smart.service');
      for (const pool of pools) {
        for (const device of pool.data_devices || []) {
          const serial = device.diskInfo?.diskSerial;
          device.smartWarning = serial ? smartService.hasDiskWarning(serial) : false;
          device.temperatureStatus = serial ? smartService.getDiskTemperatureStatus(serial) : null;
        }
        for (const device of pool.parity_devices || []) {
          const serial = device.diskInfo?.diskSerial;
          device.smartWarning = serial ? smartService.hasDiskWarning(serial) : false;
          device.temperatureStatus = serial ? smartService.getDiskTemperatureStatus(serial) : null;
        }
      }

      // Cache the result
      this.dataCache.set(cacheKey, {
        data: pools,
        timestamp: Date.now()
      });

      return pools;

    } catch (error) {
      console.error('Error getting pools data:', error);
      throw error;
    }
  }


  /**
   * Emit pools update after file operations (called from other services)
   */
  async emitPoolsUpdate(poolId = null) {
    try {
      const room = this.io.adapter.rooms.get('pools');
      if (room && room.size > 0) {
        // Clear all pools cache to force fresh data
        for (const [key] of this.dataCache) {
          if (key.startsWith('pools-data-') || key.startsWith('pools-last-hash-')) {
            this.dataCache.delete(key);
          }
        }
        // Send update with no filters to get all pools
        await this.sendPoolsUpdate(null, true, {});
      }
    } catch (error) {
      console.error('Failed to emit pools update:', error);
    }
  }

  /**
   * Cleanup when clients disconnect
   */
  cleanupDisconnectedClient() {
    // Check if monitoring should be stopped
    this.checkStopPoolsMonitoring();
  }

  /**
   * Get monitoring statistics
   */
  getMonitoringStats() {
    const stats = {
      activeSubscriptions: this.activeSubscriptions.size,
      cachedPools: this.dataCache.size,
      subscriptions: []
    };

    for (const [poolId, subscription] of this.activeSubscriptions) {
      const room = this.io.adapter.rooms.get(`pool-${poolId}`);
      stats.subscriptions.push({
        poolId,
        clientCount: room ? room.size : 0,
        interval: subscription.interval,
        uptime: Date.now() - subscription.startTime
      });
    }

    return stats;
  }

  // ============================================================
  // PERFORMANCE MONITORING (I/O throughput for pools)
  // ============================================================

  /**
   * Start performance monitoring for pools
   * Sends pool throughput updates every 2 seconds to clients who requested it
   */
  startPerformanceMonitoring() {
    if (this.activeSubscriptions.has('pools-performance')) {
      return; // Already running
    }

    if (!this.disksService) {
      console.warn('[PoolsWebSocket] DisksService not available, cannot start performance monitoring');
      return;
    }

    console.log(`[PoolsWebSocket] Starting performance monitoring (${this.performanceInterval}ms)`);

    const intervalId = setInterval(async () => {
      try {
        const room = this.io.adapter.rooms.get('pools');
        if (!room || room.size === 0) {
          this.stopPerformanceMonitoring();
          return;
        }

        // Check if any client wants performance data
        let anyClientWantsPerformance = false;
        for (const [, prefs] of this.clientPreferences) {
          if (prefs.includePerformance) {
            anyClientWantsPerformance = true;
            break;
          }
        }

        if (!anyClientWantsPerformance) {
          this.stopPerformanceMonitoring();
          return;
        }

        // Get pools and calculate performance for each
        await this.broadcastPerformanceUpdates();
      } catch (error) {
        console.error('Error in pools performance monitoring:', error);
      }
    }, this.performanceInterval);

    this.activeSubscriptions.set('pools-performance', {
      intervalId,
      interval: this.performanceInterval,
      startTime: Date.now(),
      type: 'performance'
    });
  }

  /**
   * Stop performance monitoring
   */
  stopPerformanceMonitoring() {
    const perfSub = this.activeSubscriptions.get('pools-performance');
    if (perfSub) {
      clearInterval(perfSub.intervalId);
      this.activeSubscriptions.delete('pools-performance');
      console.log('[PoolsWebSocket] Stopped performance monitoring');
    }
  }

  /**
   * Broadcast performance updates to clients who requested it
   */
  async broadcastPerformanceUpdates() {
    const room = this.io.adapter.rooms.get('pools');
    if (!room) return;

    try {
      // Get first user for byte format preference
      const firstUser = this.getFirstConnectedUser();

      // Use cached pools structure (8s TTL) to avoid calling expensive listPools() every 2 seconds
      // Performance data from diskStatsHistory (/proc/diskstats) is always live
      const pools = await this.getPoolsDataWithCache(false, {}, firstUser);

      // Calculate performance for each pool
      const poolsPerformance = [];
      for (const pool of pools) {
        // Get all disk devices from the pool
        const poolDevices = this.extractPoolDevices(pool);

        if (poolDevices.length > 0) {
          const throughput = this.disksService.getPoolThroughput(poolDevices, firstUser);

          poolsPerformance.push({
            poolId: pool.id || pool.name,
            poolName: pool.name,
            performance: throughput
          });
        }
      }

      // Send to each client who requested performance
      for (const socketId of room) {
        const socket = this.io.sockets.get(socketId);
        if (!socket) continue;

        const prefs = this.clientPreferences.get(socketId);
        if (!prefs || !prefs.includePerformance) continue;

        // Recalculate with client's byte format preference
        const clientPerformance = poolsPerformance.map(pp => {
          const throughput = this.disksService.getPoolThroughput(
            this.extractPoolDevices(pools.find(p => (p.id || p.name) === pp.poolId)),
            prefs.user
          );
          return {
            poolId: pp.poolId,
            poolName: pp.poolName,
            performance: throughput
          };
        });

        socket.emit('pools-performance-update', {
          pools: clientPerformance,
          timestamp: Date.now()
        });
      }
    } catch (error) {
      console.error('Error broadcasting performance updates:', error);
    }
  }

  /**
   * Extract disk devices from a pool structure
   * @param {Object} pool - Pool object
   * @returns {Array<string>} Array of device paths
   */
  extractPoolDevices(pool) {
    const devices = [];

    if (!pool) return devices;

    // Handle data_devices array (MergerFS/SnapRAID style)
    if (pool.data_devices && Array.isArray(pool.data_devices)) {
      for (const disk of pool.data_devices) {
        if (disk.device) devices.push(disk.device);
      }
    }

    // Handle parity_devices array (SnapRAID parity)
    if (pool.parity_devices && Array.isArray(pool.parity_devices)) {
      for (const disk of pool.parity_devices) {
        if (disk.device) devices.push(disk.device);
      }
    }

    // Handle disks array
    if (pool.disks && Array.isArray(pool.disks)) {
      for (const disk of pool.disks) {
        if (disk.device) devices.push(disk.device);
        else if (disk.path) devices.push(disk.path);
      }
    }

    // Handle vdevs structure (ZFS-style)
    if (pool.vdevs && Array.isArray(pool.vdevs)) {
      for (const vdev of pool.vdevs) {
        if (vdev.disks && Array.isArray(vdev.disks)) {
          for (const disk of vdev.disks) {
            if (disk.device) devices.push(disk.device);
            else if (disk.path) devices.push(disk.path);
          }
        }
      }
    }

    // Handle devices array directly
    if (pool.devices && Array.isArray(pool.devices)) {
      for (const device of pool.devices) {
        if (typeof device === 'string') devices.push(device);
        else if (device.device) devices.push(device.device);
        else if (device.path) devices.push(device.path);
      }
    }

    return devices;
  }

  /**
   * Authenticate user
   */
  async authenticateUser(token) {
    if (!token) {
      return { success: false, message: 'Authentication token is required' };
    }

    try {
      const jwt = require('jsonwebtoken');
      const { getBootToken } = require('../middleware/auth.middleware');
      const userService = require('../services/user.service');

      // Check if it's the boot token
      const bootToken = await getBootToken();
      if (bootToken && token === bootToken) {
        return {
          success: true,
          user: {
            id: 'boot',
            username: 'boot',
            role: 'admin',
            isBootToken: true
          }
        };
      }

      // Check if it's an admin API token
      const adminTokenData = await userService.validateAdminToken(token);
      if (adminTokenData) {
        return {
          success: true,
          user: adminTokenData
        };
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

      return {
        success: true,
        user: {
          id: currentUser.id,
          username: currentUser.username,
          role: currentUser.role,
          byte_format: currentUser.byte_format
        }
      };

    } catch (authError) {
      return { success: false, message: 'Invalid authentication token' };
    }
  }


  /**
   * Generate hash for change detection
   */
  generateDataHash(data) {
    const crypto = require('crypto');
    return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
  }

}

module.exports = PoolWebSocketManager;
