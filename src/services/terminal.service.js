const pty = require('node-pty');
const fs = require('fs').promises;
const path = require('path');

class TerminalService {
  constructor() {
    this.sessions = new Map(); // sessionId -> { ptyProcess, options, startTime }

    // Default character dimensions for pixel conversion
    this.charWidth = 9;   // pixels per character (monospace)
    this.charHeight = 20; // pixels per line
  }

  /**
   * Convert pixel dimensions to rows and columns
   * @param {number} width - Width in pixels
   * @param {number} height - Height in pixels
   * @returns {Object} - { cols, rows }
   */
  pixelsToSize(width, height) {
    const cols = Math.floor(width / this.charWidth);
    const rows = Math.floor(height / this.charHeight);

    // Ensure minimum values
    return {
      cols: Math.max(cols, 20),
      rows: Math.max(rows, 10)
    };
  }

  /**
   * Create a new terminal session
   * @param {string} sessionId - Unique session ID
   * @param {Object} options - Terminal options
   * @returns {Object} Session information
   */
  async createSession(sessionId, options = {}) {
    try {
      // Standard options
      const defaultOptions = {
        readOnly: false,    // Only for logs/output, no input
        cols: 80,
        rows: 24,
        shell: '/bin/bash',
        cwd: '/',
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
          HISTFILE: '/root/.bash_history',
          HISTSIZE: '10000',
          HISTFILESIZE: '20000'
        }
      };

      const config = { ...defaultOptions, ...options };

      // Convert pixel dimensions to rows/cols if provided
      if (options.width && options.height) {
        const size = this.pixelsToSize(options.width, options.height);
        config.cols = size.cols;
        config.rows = size.rows;
      }

      // Ensure cols/rows are valid integers
      config.cols = parseInt(config.cols, 10) || defaultOptions.cols;
      config.rows = parseInt(config.rows, 10) || defaultOptions.rows;

      console.log(`Creating terminal session ${sessionId} with size: ${config.cols}x${config.rows}`);
      let ptyProcess;

      // Flexible terminal - can execute anything
      if (config.command) {
        // Arbitrary command with arguments - no login shell
        const args = config.args || [];
        ptyProcess = pty.spawn(config.command, args, {
          name: 'xterm-256color',
          cols: config.cols,
          rows: config.rows,
          cwd: config.cwd,
          env: config.env
        });
      } else {
        // Standard Shell - start as login shell to load /etc/profile.d scripts
        // Only for normal shell sessions (no command)
        const shellArgs = config.shell === '/bin/bash' ? ['-l'] : [];
        ptyProcess = pty.spawn(config.shell, shellArgs, {
          name: 'xterm-256color',
          cols: config.cols,
          rows: config.rows,
          cwd: config.cwd,
          env: config.env
        });
      }

      ptyProcess.on('exit', (code, signal) => {
        console.log(`Terminal process exited for session ${sessionId}: code=${code}, signal=${signal}`);
        // Session is automatically cleaned up by socket handler
      });

      // Buffer to store initial output before client connects
      const outputBuffer = [];
      const maxBufferSize = 500000; // ~500KB buffer for initial output (handles 1000+ lines)
      let bufferSize = 0;

      // Capture initial output immediately
      const bufferData = (data) => {
        const dataSize = Buffer.byteLength(data, 'utf8');
        if (bufferSize + dataSize <= maxBufferSize) {
          outputBuffer.push(data);
          bufferSize += dataSize;
        }
      };

      ptyProcess.on('data', bufferData);

      // Session saved
      const session = {
        ptyProcess,
        options: config,
        startTime: new Date(),
        outputBuffer,
        bufferData
      };

      this.sessions.set(sessionId, session);

      return {
        sessionId,
        command: config.command || config.shell,
        args: config.args || [],
        readOnly: config.readOnly,
        cols: config.cols,
        rows: config.rows,
        cwd: config.cwd,
        created: session.startTime
      };

    } catch (error) {
      throw new Error(`Failed to create terminal session: ${error.message}`);
    }
  }

  /**
   * Get session
   * @param {string} sessionId - Session ID
   * @returns {Object|null} Session or null
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Send data to terminal
   * @param {string} sessionId - Session ID
   * @param {string} data - Data to send
   */
  writeToSession(sessionId, data) {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    if (session.options.readOnly) {
      throw new Error('Session is read-only');
    }

    session.ptyProcess.write(data);
  }

  /**
   * Resize terminal
   * @param {string} sessionId - Session ID
   * @param {Object} dimensions - { cols, rows } OR { width, height }
   */
  resizeSession(sessionId, dimensions) {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    let cols, rows;

    // Support both pixel dimensions and direct cols/rows
    if (dimensions.width && dimensions.height) {
      const size = this.pixelsToSize(dimensions.width, dimensions.height);
      cols = size.cols;
      rows = size.rows;
    } else {
      cols = parseInt(dimensions.cols, 10);
      rows = parseInt(dimensions.rows, 10);
    }

    // Validate
    if (!cols || !rows || cols < 1 || rows < 1) {
      throw new Error(`Invalid resize dimensions: cols=${cols}, rows=${rows}`);
    }

    console.log(`Resizing terminal session ${sessionId}: ${session.options.cols}x${session.options.rows} -> ${cols}x${rows}`);

    session.ptyProcess.resize(cols, rows);
    session.options.cols = cols;
    session.options.rows = rows;

    return { cols, rows };
  }

  /**
   * End session
   * @param {string} sessionId - Session ID
   */
  killSession(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) {
      return false;
    }

    try {
      // Remove buffer listener if it still exists
      if (session.bufferData) {
        session.ptyProcess.removeListener('data', session.bufferData);
      }

      // Get PID before attempting kill
      const pid = session.ptyProcess.pid;

      // Try node-pty kill first
      try {
        session.ptyProcess.kill('SIGKILL');
      } catch (e) {
        // Ignore node-pty kill errors
      }

      // Also kill the process directly via OS to ensure termination
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (e) {
          // Ignore errors - process may already be dead
        }
      }
    } catch (error) {
      console.warn(`Warning killing session ${sessionId}:`, error.message);
    }

    this.sessions.delete(sessionId);
    return true;
  }

  /**
   * List all sessions
   * @returns {Array} Array of session information
   */
  listSessions() {
    const sessions = [];
    for (const [sessionId, session] of this.sessions.entries()) {
      sessions.push({
        sessionId,
        command: session.options.command || session.options.shell,
        args: session.options.args || [],
        readOnly: session.options.readOnly,
        startTime: session.startTime,
        cols: session.options.cols,
        rows: session.options.rows,
        cwd: session.options.cwd
      });
    }
    return sessions;
  }

  /**
   * Service shutdown - close all sessions
   */
  shutdown() {
    console.log(`Shutting down terminal service, closing ${this.sessions.size} active sessions`);
    for (const sessionId of this.sessions.keys()) {
      this.killSession(sessionId);
    }
  }


}

module.exports = new TerminalService();
