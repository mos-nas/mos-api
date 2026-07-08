class TerminalWebSocketManager {
  constructor(io, terminalService) {
    this.io = io;
    this.terminalService = terminalService;
    this.activeSessions = new Map(); // sessionId -> { socket, session }
    this.defaultInterval = 30000; // 30 seconds heartbeat
  }

  /**
   * Handle WebSocket connection for terminal sessions
   */
  handleConnection(socket) {
    console.log(`Terminal WebSocket client connected: ${socket.id}`);

    // Join a terminal session
    socket.on('join-session', async (data) => {
      try {
        const { sessionId, token } = data;

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          socket.emit('error', { message: authResult.message });
          return;
        }

        // Check if user is admin (terminal access is admin-only)
        if (authResult.user.role !== 'admin') {
          socket.emit('error', { message: 'Terminal access requires admin privileges' });
          return;
        }

        const session = this.terminalService.getSession(sessionId);
        if (!session) {
          socket.emit('error', { message: 'Terminal session not found' });
          return;
        }

        // Join socket room for this session
        socket.join(sessionId);
        socket.terminalSessionId = sessionId;

        // Send buffered output if available
        if (session.outputBuffer && session.outputBuffer.length > 0) {
          // Send all buffered data to the client
          for (const data of session.outputBuffer) {
            socket.emit('terminal-output', data);
          }
          // Remove the buffer listener and clear the buffer
          if (session.bufferData) {
            session.ptyProcess.removeListener('data', session.bufferData);
            delete session.bufferData;
          }
          // Clear the buffer to free memory
          session.outputBuffer = [];
        }

        // Check if there are already real listeners (not the buffer listener)
        const existingListeners = session.ptyProcess.listeners('data').filter(
          listener => listener !== session.bufferData
        ).length;

        if (existingListeners === 0) {
          // No existing listeners, add new ones for this session
          const onData = (data) => {
            this.io.to(sessionId).emit('terminal-output', data);
          };

          const onExit = (code) => {
            this.io.to(sessionId).emit('terminal-exit', { code });
            // Clean up session from map without killing (process already exited)
            this.terminalService.sessions.delete(sessionId);
            session.ptyProcess.removeListener('data', onData);
            session.ptyProcess.removeListener('exit', onExit);
          };

          session.ptyProcess.on('data', onData);
          session.ptyProcess.on('exit', onExit);

          // Store listeners for cleanup
          socket.terminalListeners = { onData, onExit };

          // For new sessions with log commands, send initial trigger
          const isLogCommand = session.options.command === 'docker' &&
                             session.options.args &&
                             session.options.args.includes('logs');

          if (isLogCommand) {
            setTimeout(() => {
              if (session.ptyProcess && !session.ptyProcess.killed) {
                try {
                  session.ptyProcess.write('\n');
                } catch (e) {
                  console.log(`Could not write to session ${sessionId}: ${e.message}`);
                }
              }
            }, 100);
          }
        } else {
          // For existing sessions, send any remaining buffered output
          if (session.outputBuffer && session.outputBuffer.length > 0) {
            for (const data of session.outputBuffer) {
              socket.emit('terminal-output', data);
            }
          }

          // Add individual socket listener for this client
          const onData = (data) => {
            socket.emit('terminal-output', data);
          };

          const onExit = (code) => {
            socket.emit('terminal-exit', { code });
            socket.leave(sessionId);
          };

          session.ptyProcess.on('data', onData);
          session.ptyProcess.on('exit', onExit);

          // Store listeners for cleanup
          socket.terminalListeners = { onData, onExit };

          // For existing Docker log sessions, send trigger to get current output
          const isLogCommand = session.options.command === 'docker' &&
                             session.options.args &&
                             session.options.args.includes('logs');

          if (isLogCommand) {
            setTimeout(() => {
              if (session.ptyProcess && !session.ptyProcess.killed) {
                try {
                  session.ptyProcess.write('\n');
                } catch (e) {
                  console.log(`Could not write to existing log session ${sessionId}: ${e.message}`);
                }
              }
            }, 100);
          }
        }

        socket.emit('session-joined', {
          sessionId,
          command: session.options.command || session.options.shell,
          args: session.options.args || [],
          readOnly: session.options.readOnly,
          cols: session.options.cols,
          rows: session.options.rows,
          cwd: session.options.cwd
        });

        console.log(`Client ${socket.id} (${authResult.user.role}) joined terminal session: ${sessionId}`);

      } catch (error) {
        console.error(`Terminal join error: ${error.message}`);
        socket.emit('error', { message: 'Authentication failed' });
      }
    });

    // Create a new terminal session
    socket.on('create-session', async (data) => {
      try {
        const { token, options = {} } = data;

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          socket.emit('error', { message: authResult.message });
          return;
        }

        // Check if user is admin
        if (authResult.user.role !== 'admin') {
          socket.emit('error', { message: 'Terminal access requires admin privileges' });
          return;
        }

        // Generate unique session ID
        const sessionId = `terminal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Create terminal session
        const sessionInfo = await this.terminalService.createSession(sessionId, options);

        // For newly created sessions, we should automatically join them to start receiving output
        const session = this.terminalService.getSession(sessionId);
        if (session) {
          // Join the session immediately after creation
          socket.join(sessionId);
          socket.terminalSessionId = sessionId;

          // Store active session
          this.activeSessions.set(sessionId, { socket, session });

          // Send buffered output if available
          if (session.outputBuffer && session.outputBuffer.length > 0) {
            // Send all buffered data to the client
            for (const data of session.outputBuffer) {
              socket.emit('terminal-output', data);
            }
            // Remove the buffer listener and clear the buffer
            if (session.bufferData) {
              session.ptyProcess.removeListener('data', session.bufferData);
              delete session.bufferData;
            }
            // Clear the buffer to free memory
            session.outputBuffer = [];
          }

          // Setup PTY event listeners for immediate output
          const onData = (data) => {
            socket.emit('terminal-output', data);
            this.io.to(sessionId).emit('terminal-output', data);
          };

          const onExit = (code) => {
            socket.emit('terminal-exit', { code });
            this.io.to(sessionId).emit('terminal-exit', { code });
            socket.leave(sessionId);
            this.activeSessions.delete(sessionId);
            // Clean up session from map without killing (process already exited)
            this.terminalService.sessions.delete(sessionId);
            session.ptyProcess.removeListener('data', onData);
            session.ptyProcess.removeListener('exit', onExit);
          };

          session.ptyProcess.on('data', onData);
          session.ptyProcess.on('exit', onExit);

          // Store listeners for cleanup
          socket.terminalListeners = { onData, onExit };

          // For commands or read-only sessions, send initial trigger
          if (options.readOnly || options.command) {
            setTimeout(() => {
              if (session.ptyProcess && !session.ptyProcess.killed) {
                try {
                  // Send initial newline to trigger output for log commands
                  session.ptyProcess.write('\n');
                } catch (e) {
                  // Ignore write errors for read-only
                }
              }
            }, 50);
          }
        }

        socket.emit('session-created', sessionInfo);

        console.log(`Client ${socket.id} created terminal session: ${sessionId}`);

      } catch (error) {
        console.error(`Terminal create error: ${error.message}`);
        socket.emit('error', { message: `Failed to create terminal session: ${error.message}` });
      }
    });

    // Send input to terminal
    socket.on('terminal-input', (data) => {
      try {
        if (!socket.terminalSessionId) {
          socket.emit('error', { message: 'No active terminal session' });
          return;
        }

        this.terminalService.writeToSession(socket.terminalSessionId, data);
      } catch (error) {
        console.error(`Terminal input error:`, error);
        socket.emit('error', { message: error.message });
      }
    });

    // Resize terminal
    socket.on('terminal-resize', (data) => {
      try {
        if (!socket.terminalSessionId) {
          socket.emit('error', { message: 'No active terminal session' });
          return;
        }

        console.log(`Terminal resize request for session ${socket.terminalSessionId}:`, JSON.stringify(data));

        const { cols, rows, width, height } = data;

        // Support both pixel dimensions and cols/rows
        let dimensions;
        if (width && height) {
          dimensions = { width, height };
        } else if (cols && rows) {
          dimensions = { cols, rows };
        } else {
          socket.emit('error', { message: 'Either (width, height) or (cols, rows) must be provided' });
          return;
        }

        const result = this.terminalService.resizeSession(socket.terminalSessionId, dimensions);

        socket.emit('terminal-resized', result);
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });

    // Get session list
    socket.on('list-sessions', async (data) => {
      try {
        const { token } = data;

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          socket.emit('error', { message: authResult.message });
          return;
        }

        // Check if user is admin
        if (authResult.user.role !== 'admin') {
          socket.emit('error', { message: 'Terminal access requires admin privileges' });
          return;
        }

        const sessions = this.terminalService.listSessions();
        socket.emit('sessions-list', sessions);

      } catch (error) {
        console.error(`Terminal list error: ${error.message}`);
        socket.emit('error', { message: 'Failed to list terminal sessions' });
      }
    });

    // Kill a terminal session
    socket.on('kill-session', async (data) => {
      try {
        const { sessionId, token } = data;

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          socket.emit('error', { message: authResult.message });
          return;
        }

        // Check if user is admin
        if (authResult.user.role !== 'admin') {
          socket.emit('error', { message: 'Terminal access requires admin privileges' });
          return;
        }

        const killed = this.terminalService.killSession(sessionId);
        if (killed) {
          // Clean up active session
          this.activeSessions.delete(sessionId);
          // Notify all clients in the session room
          this.io.to(sessionId).emit('session-killed', { sessionId });
        }

        socket.emit('session-kill-result', { sessionId, killed });

      } catch (error) {
        console.error(`Terminal kill error: ${error.message}`);
        socket.emit('error', { message: 'Failed to kill terminal session' });
      }
    });

    // Leave terminal session
    socket.on('leave-session', () => {
      if (socket.terminalSessionId) {
        const sessionId = socket.terminalSessionId;
        socket.leave(sessionId);

        // Clean up listeners if they exist
        if (socket.terminalListeners) {
          const session = this.terminalService.getSession(sessionId);
          if (session && session.ptyProcess) {
            session.ptyProcess.removeListener('data', socket.terminalListeners.onData);
            session.ptyProcess.removeListener('exit', socket.terminalListeners.onExit);
          }
          delete socket.terminalListeners;
        }

        this.activeSessions.delete(sessionId);
        socket.terminalSessionId = null;

        socket.emit('session-left', { sessionId });
        console.log(`Client ${socket.id} left terminal session: ${sessionId}`);

        // Check if there are any other clients still connected to this session
        // Since this.io is a namespace, use this.io.adapter directly
        const room = this.io.adapter.rooms.get(sessionId);
        const hasOtherClients = room && room.size > 0;

        if (!hasOtherClients) {
          // No other clients connected, kill the session
          console.log(`No clients remaining for session ${sessionId}, terminating session`);
          this.terminalService.killSession(sessionId);
        }
      }
    });

    // Get terminal statistics
    socket.on('get-stats', async (data) => {
      try {
        const { token } = data;

        // Authenticate user
        const authResult = await this.authenticateUser(token);
        if (!authResult.success) {
          socket.emit('error', { message: authResult.message });
          return;
        }

        // Check if user is admin
        if (authResult.user.role !== 'admin') {
          socket.emit('error', { message: 'Terminal access requires admin privileges' });
          return;
        }

        const stats = this.getTerminalStats();
        socket.emit('terminal-stats', stats);

      } catch (error) {
        console.error(`Terminal stats error: ${error.message}`);
        socket.emit('error', { message: 'Failed to get terminal statistics' });
      }
    });

    // Client disconnect
    socket.on('disconnect', () => {
      console.log(`Terminal WebSocket client disconnected: ${socket.id}`);

      if (socket.terminalSessionId) {
        const sessionId = socket.terminalSessionId;

        // Clean up listeners if they exist
        if (socket.terminalListeners) {
          const session = this.terminalService.getSession(sessionId);
          if (session && session.ptyProcess) {
            session.ptyProcess.removeListener('data', socket.terminalListeners.onData);
            session.ptyProcess.removeListener('exit', socket.terminalListeners.onExit);
          }
        }

        socket.leave(sessionId);
        this.activeSessions.delete(sessionId);

        // Check if there are any other clients still connected to this session
        // Since this.io is a namespace, use this.io.adapter directly
        const room = this.io.adapter.rooms.get(sessionId);
        const hasOtherClients = room && room.size > 0;

        if (!hasOtherClients) {
          // No other clients connected, kill the session
          console.log(`No clients remaining for session ${sessionId}, terminating session`);
          this.terminalService.killSession(sessionId);
        }
      }
    });
  }

  /**
   * Get terminal statistics
   */
  getTerminalStats() {
    const sessions = this.terminalService.listSessions();
    const activeSessions = Array.from(this.activeSessions.keys());

    return {
      totalSessions: sessions.length,
      activeSessions: activeSessions.length,
      connectedClients: this.io.sockets.size,
      sessions: sessions.map(session => ({
        ...session,
        isActive: activeSessions.includes(session.sessionId)
      }))
    };
  }

  /**
   * Cleanup when clients disconnect
   */
  cleanupDisconnectedClient(sessionId) {
    this.activeSessions.delete(sessionId);
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
      const { getBootToken, isActionAllowed } = require('../middleware/auth.middleware');
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
        // Restricted tokens need 'write' permission for 'terminal' (shell access)
        if (!isActionAllowed(adminTokenData.permissions, 'terminal', 'write')) {
          return { success: false, message: "Access denied. This token does not have 'write' permission for 'terminal'." };
        }
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
          role: currentUser.role
        }
      };

    } catch (authError) {
      return { success: false, message: 'Invalid authentication token' };
    }
  }
}

module.exports = TerminalWebSocketManager;
