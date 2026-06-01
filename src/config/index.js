const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const CONFIG_DIR = '/boot/config/api';
const ENV_FILE = path.join(CONFIG_DIR, 'env');

class Config {
  constructor() {
    this.config = null;
  }

  async createDirectoryStructure() {
    try {
      await fs.mkdir('/boot/config', { recursive: true });
      await fs.mkdir(CONFIG_DIR, { recursive: true });

      // Check if we can write to the directory
      try {
        const testFile = path.join(CONFIG_DIR, '.test');
        await fs.writeFile(testFile, 'test');
        await fs.unlink(testFile);
      } catch (error) {
        throw new Error('No write permission to CONFIG_DIR');
      }
    } catch (error) {
      throw error;
    }
  }

  async ensureEnvFile() {
    try {
      let envContent;
      let envVars = {};
      let fileExists = true;

      try {
        envContent = await fs.readFile(ENV_FILE, 'utf8');

        // Parse existing env vars
        envContent.split('\n').forEach(line => {
          const [key, value] = line.split('=');
          if (key && value) {
            envVars[key.trim()] = value.trim();
          }
        });

      } catch {
        fileExists = false;
        // Create new env file if it doesn't exist
        const jwtSecret = crypto.randomBytes(32).toString('hex');
        envVars = {
          PORT: '998',
          LISTEN_TCP: 'false',
          JWT_SECRET: jwtSecret,
          JWT_EXPIRY_DAYS: '7',
          RATE_LIMIT_WINDOW: '1',
          RATE_LIMIT_MAX: '20',
          RATE_LIMIT_MAX_LOGIN: '5',
          RATE_LIMIT_LOGIN_WINDOW: '15',
          RATE_LIMIT_LOGIN_BLOCK: '30',
          NODE_ENV: 'production'
        };
      }

      // Ensure all required env vars exist with defaults
      const requiredEnvVars = {
        PORT: '998',
        LISTEN_TCP: 'false',
        JWT_SECRET: crypto.randomBytes(32).toString('hex'),
        JWT_EXPIRY_DAYS: '7',
        RATE_LIMIT_WINDOW: '1',
        RATE_LIMIT_MAX: '20',
        RATE_LIMIT_MAX_LOGIN: '5',
        RATE_LIMIT_LOGIN_WINDOW: '15',
        RATE_LIMIT_LOGIN_BLOCK: '30',
        NODE_ENV: 'production'
      };

      let wasUpdated = false;
      for (const [key, defaultValue] of Object.entries(requiredEnvVars)) {
        if (!envVars[key]) {
          // Don't overwrite JWT_SECRET if it already exists
          if (key === 'JWT_SECRET' && envVars[key]) {
            continue;
          }
          envVars[key] = defaultValue;
          wasUpdated = true;
        }
      }

      // Write file if it's new or was updated
      if (!fileExists || wasUpdated) {
        const newEnvContent = Object.entries(envVars)
          .map(([key, value]) => `${key}=${value}`)
          .join('\n');

        await fs.writeFile(ENV_FILE, newEnvContent, { mode: 0o600 });

        if (!fileExists) {
          console.info('New environment configuration created at:', ENV_FILE);
        } else {
          console.info('Environment configuration updated with missing variables at:', ENV_FILE);
        }
      }

      // Load environment variables into process.env
      Object.entries(envVars).forEach(([key, value]) => {
        process.env[key] = value;
      });

      return envVars;
    } catch (error) {
      throw new Error('Error creating/loading env file: ' + error.message);
    }
  }

  async load() {
    try {
      await this.createDirectoryStructure();

      // Load/Create env file first
      await this.ensureEnvFile();

      const configFile = path.join(CONFIG_DIR, 'api.json');
      const defaultConfig = {
        usersFile: path.join(CONFIG_DIR, 'users.json'),
        tokenFile: path.join(CONFIG_DIR, 'token'),
        adminTokensFile: path.join(CONFIG_DIR, 'admin-tokens.json')
      };

      // Try to load config
      try {
        const configData = await fs.readFile(configFile, 'utf8');
        this.config = { ...defaultConfig, ...JSON.parse(configData) };
      } catch (error) {
        this.config = defaultConfig;
        await fs.writeFile(configFile, JSON.stringify(defaultConfig, null, 2));
      }

      // Check and generate boot token if needed
      await this.ensureBootToken();

    } catch (error) {
      console.error('Configuration error:', error.message);
      throw error;
    }
  }

  async ensureBootToken() {
    try {
      const tokenFile = this.config.tokenFile;
      let token;

      try {
        // If file exists, just read it - even if empty
        token = await fs.readFile(tokenFile, 'utf8');

        // Check if token is empty
        if (!this.isValidToken(token)) {
          console.info('Boot token clear');
          return;
        }

        console.info('Boot token is in place and valid');
      } catch {
        // Only generate new token if file doesn't exist
        token = crypto.randomBytes(32).toString('hex');
        await fs.mkdir(path.dirname(tokenFile), { recursive: true });
        await fs.writeFile(tokenFile, token, { mode: 0o600 });
        console.info('New boot token generated');
      }

      console.info('Boot token available at:', tokenFile);
    } catch (error) {
      throw new Error('Failed to ensure boot token: ' + error.message);
    }
  }

  isValidToken(token) {
    return token && token.trim().length > 0;
  }

  async getBootToken() {
    try {
      const token = await fs.readFile(this.config.tokenFile, 'utf8');
      return this.isValidToken(token) ? token.trim() : null;
    } catch (error) {
      return null;
    }
  }

  get usersFilePath() {
    return this.config?.usersFile;
  }

  get tokenFilePath() {
    return this.config?.tokenFile;
  }

  get adminTokensFilePath() {
    return this.config?.adminTokensFile;
  }

  get jwtExpiryDays() {
    return parseInt(process.env.JWT_EXPIRY_DAYS) || 7;
  }

  get jwtExpiryString() {
    const days = this.jwtExpiryDays;
    return `${days}d`;
  }
}

module.exports = new Config();
