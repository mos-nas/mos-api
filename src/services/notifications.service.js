const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

class NotificationsService {
  constructor() {
    this.notificationsPath = '/var/mos/notify/notifications.json';
    this._knownIds = new Set();
    this._watcher = null;
    this._debounceTimer = null;
    this._initFileWatcher();
  }

  /**
   * Initializes a file watcher on notifications.json to detect new notifications
   * and automatically send Web Push to all subscribers
   * @private
   */
  _initFileWatcher() {
    const dir = path.dirname(this.notificationsPath);
    const filename = path.basename(this.notificationsPath);

    // Ensure directory exists before watching
    fsSync.mkdirSync(dir, { recursive: true });

    // Load initial IDs so we don't push existing notifications on startup
    this._loadKnownIds();

    // Watch the directory instead of the file:
    // - Works even if the file doesn't exist yet (no retry loop needed)
    // - Survives file deletion/recreation (inotify watches the directory inode)
    // - Zero CPU cost when idle (kernel inotify, no polling)
    this._watcher = fsSync.watch(dir, (eventType, changedFile) => {
      if (changedFile !== filename) return;

      // Debounce: the file may be written multiple times in quick succession
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => this._onFileChanged(), 500);
    });

    // If directory is deleted, watcher dies — restart immediately (mkdirSync recreates it)
    this._watcher.on('error', () => {
      this._watcher.close();
      this._watcher = null;
      setTimeout(() => this._initFileWatcher(), 1000);
    });
  }

  /**
   * Loads all current notification IDs into the known set
   * @private
   */
  async _loadKnownIds() {
    try {
      const data = await fs.readFile(this.notificationsPath, 'utf8');
      const notifications = JSON.parse(data);
      if (Array.isArray(notifications)) {
        this._knownIds = new Set(notifications.map(n => n.id));
      }
    } catch {
      this._knownIds = new Set();
    }
  }

  /**
   * Called when notifications.json changes, detects new notifications and sends Web Push
   * @private
   */
  async _onFileChanged() {
    try {
      const data = await fs.readFile(this.notificationsPath, 'utf8');
      const notifications = JSON.parse(data);
      if (!Array.isArray(notifications)) return;

      // Find notifications with IDs we haven't seen before
      const newNotifications = notifications.filter(n => !this._knownIds.has(n.id));

      // Update known IDs
      this._knownIds = new Set(notifications.map(n => n.id));

      if (newNotifications.length === 0) return;

      // Send Web Push for each new notification
      const webpushService = require('./webpush.service');
      await webpushService.init();

      for (const notification of newNotifications) {
        if (notification.priority === 'info') continue;
        const title = notification.title || 'MOS';
        const body = notification.message || '';
        const priority = notification.priority || 'normal';
        await webpushService.sendToAll(title, body, priority);
      }
    } catch (error) {
      // Silent fail — web push is best-effort, don't break notification reading
      if (error.code !== 'ENOENT') {
        console.error('Web Push dispatch error:', error.message);
      }
    }
  }

  /**
   * Reads all notifications from the notifications.json file
   * @param {Object} options - Filter options
   * @param {boolean} options.read - Filter by read status (true/false)
   * @param {number} options.limit - Limit number of results
   * @param {string} options.order - Sort order ('asc' or 'desc', default: 'desc')
   * @returns {Promise<Array>} Array of notification objects
   */
  async getNotifications(options = {}) {
    try {
      const data = await fs.readFile(this.notificationsPath, 'utf8');
      const notifications = JSON.parse(data);

      // Ensure it's an array
      if (!Array.isArray(notifications)) {
        throw new Error('Notifications file does not contain a valid array');
      }

      // Ensure all notifications have 'id' and 'read' fields
      let notificationsWithDefaults = notifications.map(notification => ({
        ...notification,
        id: notification.id !== undefined ? notification.id : Date.now(),
        read: notification.read !== undefined ? notification.read : false
      }));

      // Filter by read status if specified
      if (options.read !== undefined) {
        const readFilter = options.read === true || options.read === 'true';
        notificationsWithDefaults = notificationsWithDefaults.filter(
          notification => notification.read === readFilter
        );
      }

      // Sort by timestamp (default: newest first)
      const order = options.order === 'asc' ? 'asc' : 'desc';
      notificationsWithDefaults.sort((a, b) => {
        const dateA = new Date(a.timestamp);
        const dateB = new Date(b.timestamp);
        return order === 'asc' ? dateA - dateB : dateB - dateA;
      });

      // Apply limit if specified
      if (options.limit !== undefined) {
        const limit = parseInt(options.limit, 10);
        if (!isNaN(limit) && limit > 0) {
          notificationsWithDefaults = notificationsWithDefaults.slice(0, limit);
        }
      }

      return notificationsWithDefaults;
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File doesn't exist, return empty array
        return [];
      }
      throw new Error(`Error reading notifications: ${error.message}`);
    }
  }

  /**
   * Deletes a notification by ID
   * @param {string|number} id - The ID of the notification to delete
   * @returns {Promise<Object>} Result object with success status and message
   */
  async deleteNotification(id) {
    try {
      const notifications = await this.getNotifications();

      // Find the notification with the matching ID
      // Convert string ID from URL params to number
      const numericId = typeof id === 'string' ? Number(id) : id;
      const initialLength = notifications.length;
      const filteredNotifications = notifications.filter(notification =>
        notification.id !== numericId
      );

      if (filteredNotifications.length === initialLength) {
        return {
          success: false,
          message: `Notification with ID ${id} not found`
        };
      }

      // Write the filtered notifications back to the file
      await this._writeNotifications(filteredNotifications);

      return {
        success: true,
        message: `Notification with ID ${id} deleted successfully`,
        remainingCount: filteredNotifications.length
      };
    } catch (error) {
      throw new Error(`Error deleting notification: ${error.message}`);
    }
  }

  /**
   * Deletes all notifications
   * @returns {Promise<Object>} Result object with success status and message
   */
  async deleteAllNotifications() {
    try {
      await this._writeNotifications([]);

      return {
        success: true,
        message: 'All notifications deleted successfully',
        remainingCount: 0
      };
    } catch (error) {
      throw new Error(`Error deleting all notifications: ${error.message}`);
    }
  }

  /**
   * Marks a single notification as read by ID
   * @param {string|number} id - The ID of the notification to mark as read
   * @returns {Promise<Object>} Result object with success status and message
   */
  async markNotificationAsRead(id) {
    try {
      const notifications = await this.getNotifications();

      // Find and update the notification
      // Convert string ID from URL params to number
      const numericId = typeof id === 'string' ? Number(id) : id;
      let notificationFound = false;
      const updatedNotifications = notifications.map(notification => {
        if (notification.id === numericId) {
          notificationFound = true;
          return { ...notification, read: true };
        }
        return notification;
      });

      if (!notificationFound) {
        return {
          success: false,
          message: `Notification with ID ${id} not found`
        };
      }

      // Write the updated notifications back to the file
      await this._writeNotifications(updatedNotifications);

      return {
        success: true,
        message: `Notification with ID ${id} marked as read`,
        totalCount: updatedNotifications.length
      };
    } catch (error) {
      throw new Error(`Error marking notification as read: ${error.message}`);
    }
  }

  /**
   * Marks multiple notifications as read by IDs
   * @param {Array<string|number>} ids - Array of notification IDs to mark as read
   * @returns {Promise<Object>} Result object with success status and details
   */
  async markMultipleNotificationsAsRead(ids) {
    try {
      if (!Array.isArray(ids) || ids.length === 0) {
        return {
          success: false,
          message: 'Invalid IDs array provided'
        };
      }

      const notifications = await this.getNotifications();
      // Convert all IDs to numbers
      const numericIds = ids.map(id => typeof id === 'string' ? Number(id) : id);
      const idSet = new Set(numericIds);
      let markedCount = 0;

      // Update notifications that match the provided IDs
      const updatedNotifications = notifications.map(notification => {
        if (idSet.has(notification.id) && !notification.read) {
          markedCount++;
          return { ...notification, read: true };
        }
        return notification;
      });

      if (markedCount === 0) {
        return {
          success: false,
          message: 'No matching unread notifications found for the provided IDs'
        };
      }

      // Write the updated notifications back to the file
      await this._writeNotifications(updatedNotifications);

      return {
        success: true,
        message: `${markedCount} notification(s) marked as read`,
        markedCount,
        totalCount: updatedNotifications.length
      };
    } catch (error) {
      throw new Error(`Error marking multiple notifications as read: ${error.message}`);
    }
  }

  /**
   * Marks all notifications as read
   * @returns {Promise<Object>} Result object with success status and message
   */
  async markAllNotificationsAsRead() {
    try {
      const notifications = await this.getNotifications();
      let markedCount = 0;

      // Mark all unread notifications as read
      const updatedNotifications = notifications.map(notification => {
        if (!notification.read) {
          markedCount++;
          return { ...notification, read: true };
        }
        return notification;
      });

      if (markedCount === 0) {
        return {
          success: true,
          message: 'All notifications are already marked as read',
          markedCount: 0,
          totalCount: notifications.length
        };
      }

      // Write the updated notifications back to the file
      await this._writeNotifications(updatedNotifications);

      return {
        success: true,
        message: `All ${markedCount} unread notification(s) marked as read`,
        markedCount,
        totalCount: updatedNotifications.length
      };
    } catch (error) {
      throw new Error(`Error marking all notifications as read: ${error.message}`);
    }
  }

  /**
   * Gets notification statistics including read/unread counts
   * @returns {Promise<Object>} Statistics object
   */
  async getNotificationStats() {
    try {
      const notifications = await this.getNotifications();

      const stats = {
        total: notifications.length,
        read: 0,
        unread: 0,
        priorities: {
          high: 0,
          normal: 0,
          low: 0
        }
      };

      notifications.forEach(notification => {
        // Count read/unread
        if (notification.read) {
          stats.read++;
        } else {
          stats.unread++;
        }

        // Count priorities
        const priority = notification.priority || 'normal';
        if (stats.priorities[priority] !== undefined) {
          stats.priorities[priority]++;
        }
      });

      return stats;
    } catch (error) {
      throw new Error(`Error getting notification statistics: ${error.message}`);
    }
  }


  /**
   * Writes notifications array to the file
   * @private
   * @param {Array} notifications - Array of notifications to write
   */
  async _writeNotifications(notifications) {
    try {
      // Ensure the directory exists
      const dir = path.dirname(this.notificationsPath);
      await fs.mkdir(dir, { recursive: true });

      // Write the notifications to the file
      await fs.writeFile(
        this.notificationsPath,
        JSON.stringify(notifications, null, 2),
        'utf8'
      );
    } catch (error) {
      throw new Error(`Error writing notifications file: ${error.message}`);
    }
  }

  /**
   * Validates notification object structure
   * @private
   * @param {Object} notification - Notification object to validate
   * @returns {boolean} True if valid
   */
  _validateNotification(notification) {
    return (
      notification &&
      typeof notification === 'object' &&
      typeof notification.id === 'number' &&
      typeof notification.title === 'string' &&
      typeof notification.message === 'string' &&
      typeof notification.timestamp === 'string' &&
      (notification.priority === undefined ||
       ['high', 'normal', 'low'].includes(notification.priority)) &&
      (notification.read === undefined || typeof notification.read === 'boolean')
    );
  }

  /**
   * Stops the file watcher (for graceful shutdown)
   */
  destroy() {
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
  }
}

module.exports = new NotificationsService();
