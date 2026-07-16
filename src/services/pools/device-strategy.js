const { exec, spawn } = require('child_process');
const util = require('util');
const fs = require('fs').promises;
const path = require('path');
const execPromise = util.promisify(exec);

/**
 * Base Device Strategy Interface
 * Defines the contract for handling devices (plain vs LUKS encrypted)
 */
class DeviceStrategy {
  /**
   * Prepare devices for pool creation/modification
   * @param {string[]} devices - Array of device paths
   * @param {Object} pool - Pool object
   * @param {Object} options - Options (passphrase, format, etc.)
   * @returns {Promise<Object[]>} Prepared devices info
   */
  async prepareDevices(devices, pool, options) {
    throw new Error('prepareDevices must be implemented');
  }

  /**
   * Get UUID for a device
   * @param {Object} deviceInfo - Device info object
   * @param {Object} pool - Pool object
   * @returns {Promise<string>} Device UUID
   */
  async getDeviceUuid(deviceInfo, pool) {
    throw new Error('getDeviceUuid must be implemented');
  }

  /**
   * Mount a device
   * @param {Object} deviceInfo - Device info object
   * @param {string} mountPoint - Mount point path
   * @param {Object} options - Mount options
   * @returns {Promise<void>}
   */
  async mountDevice(deviceInfo, mountPoint, options) {
    throw new Error('mountDevice must be implemented');
  }

  /**
   * Unmount/cleanup devices
   * @param {Object[]} deviceInfos - Array of device info objects
   * @param {Object} pool - Pool object
   * @returns {Promise<void>}
   */
  async cleanup(deviceInfos, pool) {
    throw new Error('cleanup must be implemented');
  }

  /**
   * Get physical device path for storage in pool config
   * @param {Object} deviceInfo - Device info object
   * @returns {string} Physical device path
   */
  getPhysicalDevicePath(deviceInfo) {
    throw new Error('getPhysicalDevicePath must be implemented');
  }

  /**
   * Get device path for mounting/operations
   * @param {Object} deviceInfo - Device info object
   * @returns {string} Device path for operations
   */
  getOperationalDevicePath(deviceInfo) {
    throw new Error('getOperationalDevicePath must be implemented');
  }
}

/**
 * Plain (non-encrypted) Device Strategy
 * Handles regular devices without LUKS encryption
 */
class PlainDeviceStrategy extends DeviceStrategy {
  constructor(poolsService) {
    super();
    this.poolsService = poolsService;
  }

  async prepareDevices(devices, pool, options) {
    const preparedDevices = [];

    for (const device of devices) {
      // Reject LUKS devices in import mode, pool must be configured as encrypted
      if (options?.format === false) {
        const fsInfo = await this.poolsService.checkDeviceFilesystem(device);
        if (fsInfo.filesystem === 'crypto_LUKS') {
          throw new Error(`Device ${device} is LUKS encrypted. Set config.encrypted to true and provide a passphrase to import it.`);
        }
      }

      preparedDevices.push({
        originalDevice: device,
        physicalDevice: device,
        operationalDevice: device,
        isEncrypted: false
      });
    }

    return preparedDevices;
  }

  async getDeviceUuid(deviceInfo, pool) {
    return await this.poolsService.getDeviceUuid(deviceInfo.operationalDevice);
  }

  async mountDevice(deviceInfo, mountPoint, options) {
    // Use the operational device for mounting
    return await this.poolsService.mountDevice(
      deviceInfo.operationalDevice,
      mountPoint,
      options
    );
  }

  async cleanup(deviceInfos, pool) {
    // No cleanup needed for plain devices
    return;
  }

  getPhysicalDevicePath(deviceInfo) {
    return deviceInfo.physicalDevice;
  }

  getOperationalDevicePath(deviceInfo) {
    return deviceInfo.operationalDevice;
  }
}

/**
 * LUKS Encrypted Device Strategy
 * Handles LUKS encrypted devices with keyfile support
 */
class LuksDeviceStrategy extends DeviceStrategy {
  constructor(poolsService) {
    super();
    this.poolsService = poolsService;
    this.luksKeyDir = '/boot/config/system/luks';
  }

  /**
   * Prepare LUKS encrypted devices
   */
  async prepareDevices(devices, pool, options) {
    const preparedDevices = [];
    const poolName = pool.name;
    const passphrase = options.passphrase;

    // Check if devices are already LUKS encrypted or need encryption
    const isCreatingNewPool = !pool.id;

    // Import mode requires a passphrase or existing keyfile to open LUKS devices
    if (options.format === false && (!passphrase || passphrase.trim() === '')) {
      const keyfilePath = path.join(this.luksKeyDir, `${poolName}.key`);
      const hasKeyfile = await fs.access(keyfilePath).then(() => true, () => false);
      if (!hasKeyfile) {
        throw new Error(`Importing encrypted devices for pool '${poolName}' requires a passphrase (no keyfile found).`);
      }
    }

    try {
      for (let i = 0; i < devices.length; i++) {
        const device = devices[i];
        const slot = options.startSlot ? options.startSlot + i : (i + 1);

        // Check if device is already LUKS
        const deviceInfo = await this.poolsService.checkDeviceFilesystem(device);
        const isAlreadyLuks = deviceInfo.isFormatted && deviceInfo.filesystem === 'crypto_LUKS';

        // Calculate shouldEncrypt per device (must be inside loop to use current options.config)
        const shouldEncrypt = options.config?.encrypted && options.format !== false;

        let mappedDevice;

        if (isAlreadyLuks && options.format === false) {
          // Device is already LUKS - open it without reformatting
          console.log(`Device ${device} is already LUKS encrypted, opening...`);
          const luksDevices = await this._openLuksDevicesWithSlots(
            [device],
            poolName,
            [slot],
            passphrase,
            options.isParity
          );
          mappedDevice = luksDevices[0].mappedDevice;
        } else if (shouldEncrypt || (isAlreadyLuks && options.format === true)) {
          // Need to encrypt (or re-encrypt) and open
          if (isAlreadyLuks && options.format === true) {
            console.log(`Device ${device} is already LUKS encrypted, re-encrypting with format=true`);
          } else {
            console.log(`Setting up LUKS encryption on device ${device}`);
          }

          // Setup encryption (creates keyfile if requested)
          await this._setupDeviceEncryption(
            device,
            poolName,
            passphrase,
            options.config?.create_keyfile && i === 0 // Only create keyfile for first device
          );

          // Open the encrypted device
          const luksDevices = await this._openLuksDevicesWithSlots(
            [device],
            poolName,
            [slot],
            passphrase,
            options.isParity
          );
          mappedDevice = luksDevices[0].mappedDevice;
        } else {
          throw new Error(`Device ${device} encryption state mismatch`);
        }

        preparedDevices.push({
          originalDevice: device,
          physicalDevice: device,
          operationalDevice: mappedDevice,
          mappedDevice: mappedDevice,
          slot: slot,
          isEncrypted: true,
          isParity: options.isParity || false
        });
      }

      return preparedDevices;
    } catch (error) {
      // Cleanup: Close all LUKS devices that were successfully opened
      console.error(`Error preparing LUKS devices: ${error.message}`);
      if (preparedDevices.length > 0) {
        console.log(`Cleaning up ${preparedDevices.length} already opened LUKS device(s)...`);
        try {
          await this.cleanup(preparedDevices, pool);
        } catch (cleanupError) {
          console.warn(`Warning: Could not cleanup LUKS devices: ${cleanupError.message}`);
        }
      }
      throw error;
    }
  }

  async getDeviceUuid(deviceInfo, pool) {
    // For LUKS, always return UUID from physical device
    return await this.poolsService.getDeviceUuid(deviceInfo.physicalDevice);
  }

  async mountDevice(deviceInfo, mountPoint, options) {
    // Use the mapped device for mounting
    return await this.poolsService.mountDevice(
      deviceInfo.operationalDevice,
      mountPoint,
      options
    );
  }

  async cleanup(deviceInfos, pool) {
    if (!deviceInfos || deviceInfos.length === 0) return;

    const devices = deviceInfos.filter(d => d.isEncrypted);
    if (devices.length === 0) return;

    const physicalDevices = devices.map(d => d.physicalDevice);
    const slots = devices.map(d => d.slot);
    const isParity = devices[0].isParity || false;

    console.log(`Closing LUKS devices for pool '${pool.name}' (slots: ${slots.join(', ')})`);

    await this.poolsService._closeLuksDevicesWithSlots(
      physicalDevices,
      pool.name,
      slots,
      isParity
    );
  }

  getPhysicalDevicePath(deviceInfo) {
    return deviceInfo.physicalDevice;
  }

  getOperationalDevicePath(deviceInfo) {
    return deviceInfo.operationalDevice || deviceInfo.mappedDevice;
  }

  /**
   * Setup LUKS encryption on a single device
   * @private
   */
  async _setupDeviceEncryption(device, poolName, passphrase, createKeyfile = false) {
    const keyfilePath = path.join(this.luksKeyDir, `${poolName}.key`);

    try {
      // Create keyfile if requested and it doesn't already exist
      if (createKeyfile) {
        await fs.mkdir(this.luksKeyDir, { recursive: true });

        // Check if keyfile already exists
        try {
          await fs.access(keyfilePath);
          console.log(`Keyfile already exists for pool '${poolName}', reusing existing key`);
        } catch (error) {
          // Keyfile doesn't exist, create it
          const crypto = require('crypto');
          const randomBytes = crypto.randomBytes(32);
          const base64Key = randomBytes.toString('base64').replace(/\n/g, '');
          await fs.writeFile(keyfilePath, base64Key, 'utf8');
          await execPromise(`chmod 600 ${keyfilePath}`);
          console.log(`Created new keyfile for pool '${poolName}' at ${keyfilePath}`);
        }
      }

      // Check if keyfile exists to decide whether to use it for formatting
      let useKeyfileForFormat = false;
      try {
        await fs.access(keyfilePath);
        useKeyfileForFormat = true;
      } catch (error) {
        useKeyfileForFormat = false;
      }

      // Format device with LUKS
      console.log(`Formatting ${device} with LUKS encryption...`);
      if (useKeyfileForFormat) {
        // Use keyfile for formatting (for adding to existing encrypted pool)
        console.log(`Using keyfile for LUKS format on ${device}`);
        await execPromise(`cryptsetup luksFormat --type luks2 ${device} --key-file ${keyfilePath}`);
      } else {
        // Use passphrase for formatting (for new encrypted pool)
        await this.poolsService._execCryptsetupWithPassphrase(
          ['luksFormat', '--type', 'luks2', device],
          passphrase
        );

        // Add keyfile to device if it was just created
        if (createKeyfile) {
          try {
            await fs.access(keyfilePath);
            console.log(`Adding keyfile to LUKS device ${device}...`);
            await this.poolsService._execCryptsetupWithPassphrase(
              ['luksAddKey', device, keyfilePath],
              passphrase
            );
            console.log(`Keyfile added to ${device}`);
          } catch (error) {
            console.warn(`Warning: Could not add keyfile to device ${device}: ${error.message}`);
          }
        }
      }

      console.log(`LUKS encryption setup completed for ${device}`);
    } catch (error) {
      throw new Error(`Failed to setup LUKS encryption on ${device}: ${error.message}`);
    }
  }

  /**
   * Open LUKS devices with slot-based naming
   * @private
   */
  async _openLuksDevicesWithSlots(devices, poolName, slots, passphrase = null, isParity = false) {
    const keyfilePath = path.join(this.luksKeyDir, `${poolName}.key`);
    const mappedDevices = [];
    let useKeyfile = false;

    // Check if keyfile exists
    try {
      await fs.access(keyfilePath);
      useKeyfile = true;
      console.log(`Using keyfile for LUKS devices: ${keyfilePath}`);
    } catch (error) {
      if (!passphrase) {
        throw new Error(`No keyfile found at ${keyfilePath} and no passphrase provided`);
      }
      console.log(`No keyfile found, using passphrase for LUKS devices`);
    }

    for (let i = 0; i < devices.length; i++) {
      const device = devices[i];
      const slot = slots[i];

      // Use slot-based naming scheme
      let luksName;
      if (isParity) {
        luksName = `parity_${poolName}_${slot}`;
      } else {
        luksName = `${poolName}_${slot}`;
      }

      try {
        // Open LUKS device
        if (useKeyfile) {
          await execPromise(`cryptsetup luksOpen ${device} ${luksName} --key-file ${keyfilePath}`);
        } else {
          await this.poolsService._execCryptsetupWithPassphrase(
            ['luksOpen', device, luksName],
            passphrase
          );
        }

        const mappedDevicePath = `/dev/mapper/${luksName}`;
        console.log(`Opened LUKS device: ${device} -> ${mappedDevicePath}`);

        mappedDevices.push({
          originalDevice: device,
          mappedDevice: mappedDevicePath,
          slot: slot
        });
      } catch (error) {
        // Cleanup already opened devices
        for (const opened of mappedDevices) {
          try {
            const name = opened.mappedDevice.replace('/dev/mapper/', '');
            await execPromise(`cryptsetup luksClose ${name}`);
          } catch (cleanupError) {
            console.warn(`Warning: Could not close ${opened.mappedDevice}: ${cleanupError.message}`);
          }
        }
        throw new Error(`Failed to open LUKS device ${device}: ${error.message}`);
      }
    }

    return mappedDevices;
  }

  /**
   * Cleanup existing LUKS mappers for a pool name
   * @private
   */
  async _cleanupExistingLuksMappers(poolName) {
    try {
      const { stdout } = await execPromise('ls /dev/mapper/ 2>/dev/null || echo ""');
      const mappers = stdout.trim().split('\n').filter(m =>
        m.includes(poolName) && (m.startsWith(poolName + '_') || m.startsWith('parity_' + poolName))
      );

      for (const mapper of mappers) {
        try {
          await execPromise(`cryptsetup luksClose ${mapper}`);
          console.log(`Cleaned up existing LUKS mapper: ${mapper}`);
        } catch (error) {
          try {
            await execPromise(`dmsetup remove ${mapper}`);
            console.log(`Force removed existing LUKS mapper: ${mapper}`);
          } catch (dmError) {
            console.warn(`Warning: Could not remove mapper ${mapper}: ${dmError.message}`);
          }
        }
      }
    } catch (error) {
      console.warn(`Warning: Could not cleanup existing LUKS mappers: ${error.message}`);
    }
  }
}

/**
 * Factory to get the appropriate device strategy
 */
class DeviceStrategyFactory {
  static getStrategy(pool, poolsService) {
    const isEncrypted = pool?.config?.encrypted === true;
    return isEncrypted
      ? new LuksDeviceStrategy(poolsService)
      : new PlainDeviceStrategy(poolsService);
  }
}

module.exports = {
  DeviceStrategy,
  PlainDeviceStrategy,
  LuksDeviceStrategy,
  DeviceStrategyFactory
};
