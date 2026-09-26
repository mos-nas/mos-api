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

    // Encrypting a new member with a key the rest of the pool does not know would only fail
    // on the next mount, so the passphrase is checked against an existing member up front
    if (!isCreatingNewPool && options.format !== false) {
      await this.poolsService._assertLuksPassphraseMatchesPool(pool, passphrase, devices);
    }

    try {
      for (let i = 0; i < devices.length; i++) {
        const device = devices[i];

        // Explicit slots win: free slots are not necessarily contiguous, so deriving them
        // from startSlot + index would hand out a slot that is still in use
        const slot = Array.isArray(options.slots) && options.slots[i] !== undefined
          ? parseInt(options.slots[i])
          : (options.startSlot ? options.startSlot + i : (i + 1));

        // Check if device is already LUKS
        const deviceInfo = await this.poolsService.checkDeviceFilesystem(device);
        const isAlreadyLuks = deviceInfo.isFormatted && deviceInfo.filesystem === 'crypto_LUKS';

        // Calculate shouldEncrypt per device (must be inside loop to use current options.config)
        const shouldEncrypt = options.config?.encrypted && options.format !== false;

        let mappedDevice;

        if (isAlreadyLuks && options.format === false) {
          // Device is already LUKS - open it without reformatting
          console.log(`Device ${device} is already LUKS encrypted, opening...`);
          const luksDevices = await this.poolsService._openLuksDevicesWithSlots(
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
            options.config?.create_keyfile && i === 0, // Only create keyfile for first device
            Array.isArray(options.luksUuids) ? options.luksUuids[i] : null
          );

          // Open the encrypted device
          const luksDevices = await this.poolsService._openLuksDevicesWithSlots(
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
  async _setupDeviceEncryption(device, poolName, passphrase, createKeyfile = false, luksUuid = null) {
    const keyfilePath = path.join(this.luksKeyDir, `${poolName}.key`);
    const cleanPassphrase = this.poolsService._normalizeLuksPassphrase(passphrase);

    // NonRAID needs the container UUID before the array is started, so it is pinned here
    if (luksUuid && !/^[0-9a-fA-F-]{36}$/.test(luksUuid)) {
      throw new Error(`Invalid LUKS UUID '${luksUuid}' for device ${device}`);
    }
    const uuidArgs = luksUuid ? ['--uuid', luksUuid] : [];

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
          const base64Key = crypto.randomBytes(32).toString('base64');
          await fs.writeFile(keyfilePath, base64Key, { mode: 0o600 });
          console.log(`Created new keyfile for pool '${poolName}' at ${keyfilePath}`);
        }
      }

      const hasKeyfile = await fs.access(keyfilePath).then(() => true, () => false);

      if (!hasKeyfile && !cleanPassphrase) {
        throw new Error(`No keyfile found at ${keyfilePath} and no passphrase provided`);
      }

      console.log(`Formatting ${device} with LUKS encryption...`);

      // Format with the passphrase whenever there is one, then add the keyfile as a second
      // keyslot. Both have to unlock the device: the keyfile drives automount, the passphrase
      // is the only way back in once /boot is gone.
      if (cleanPassphrase) {
        await this.poolsService._execCryptsetupWithPassphrase(
          ['luksFormat', '--type', 'luks2', ...uuidArgs, device],
          cleanPassphrase
        );

        if (hasKeyfile) {
          console.log(`Adding keyfile to LUKS device ${device}...`);
          await this.poolsService._execCryptsetupWithPassphrase(
            ['luksAddKey', device, keyfilePath],
            cleanPassphrase
          );
        }
      } else {
        console.log(`Using keyfile for LUKS format on ${device}`);
        await execPromise(`cryptsetup luksFormat --type luks2 ${uuidArgs.join(' ')} ${device} --key-file ${keyfilePath}`.replace(/\s+/g, ' '));
      }

      console.log(`LUKS encryption setup completed for ${device}`);
    } catch (error) {
      throw new Error(`Failed to setup LUKS encryption on ${device}: ${error.message}`);
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
