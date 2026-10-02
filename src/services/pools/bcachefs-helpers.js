const DATA_GROUP = 'hdd';
const CACHE_GROUP = 'ssd';

// Target layout per cache mode. ssd_durability 0 makes the cache devices pure cache whose
// loss costs no data, so they are not counted towards the replica requirement - and metadata
// must not be targeted at them because it could not be stored durably there.
const CACHE_MODES = {
  writeback: { foreground: CACHE_GROUP, promote: CACHE_GROUP, background: DATA_GROUP, metadata: CACHE_GROUP, ssd_durability: 1 },
  writethrough: { foreground: CACHE_GROUP, promote: CACHE_GROUP, background: DATA_GROUP, metadata: null, ssd_durability: 0 },
  writearound: { foreground: DATA_GROUP, promote: CACHE_GROUP, background: DATA_GROUP, metadata: CACHE_GROUP, ssd_durability: 1 }
};

const COMPRESSION_TYPES = ['none', 'lz4', 'gzip', 'zstd'];

/**
 * Helper functions for bcachefs pools
 */
class BcachefsHelpers {
  static get DATA_GROUP() {
    return DATA_GROUP;
  }

  static get CACHE_GROUP() {
    return CACHE_GROUP;
  }

  static get CACHE_MODES() {
    return CACHE_MODES;
  }

  /**
   * Build the bcachefs device label for a group/slot pair
   * Labels are derived instead of persisted, like LUKS mapper names
   * @param {string} group - Device group ('hdd' or 'ssd')
   * @param {number} slot - Device slot
   * @returns {string} Label such as 'hdd.hdd1'
   */
  static deviceLabel(group, slot) {
    return `${group}.${group}${slot}`;
  }

  /**
   * Build the default config for a bcachefs pool
   * @param {Object} config - User supplied config
   * @param {boolean} hasCache - Whether the pool has cache devices
   * @returns {Object} Normalized config
   */
  static buildConfig(config = {}, hasCache = false) {
    const dataReplicas = parseInt(config.data_replicas) || 1;

    return {
      data_replicas: dataReplicas,
      metadata_replicas: parseInt(config.metadata_replicas) || Math.min(dataReplicas, 2),
      erasure_code: config.erasure_code === true,
      compression: config.compression || 'none',
      background_compression: config.background_compression || 'none',
      cache_mode: hasCache ? (config.cache_mode || 'writethrough') : null
    };
  }

  /**
   * Validate bcachefs pool configuration against the given devices
   * @param {Object} config - Normalized config from buildConfig()
   * @param {Object[]} deviceEntries - Device entries from buildDeviceEntries()
   * @throws {Error} If the combination is not supported
   */
  static validateConfig(config, deviceEntries) {
    if (!Array.isArray(deviceEntries) || deviceEntries.length === 0) {
      throw new Error('At least one device is required for a bcachefs pool');
    }

    if (config.cache_mode && !CACHE_MODES[config.cache_mode]) {
      throw new Error(`Unsupported cache mode: ${config.cache_mode}. Supported: ${Object.keys(CACHE_MODES).join(', ')}`);
    }

    for (const key of ['compression', 'background_compression']) {
      if (!COMPRESSION_TYPES.includes(config[key])) {
        throw new Error(`Unsupported ${key}: ${config[key]}. Supported: ${COMPRESSION_TYPES.join(', ')}`);
      }
    }

    if (config.metadata_replicas < 1) {
      throw new Error('metadata_replicas must be at least 1');
    }

    // Cache devices with durability 0 hold no durable copy, so they cannot satisfy replicas
    const durableCount = deviceEntries.filter(d => d.durability > 0).length;
    if (durableCount === 0) {
      throw new Error('At least one device with durability greater than 0 is required');
    }

    if (config.erasure_code) {
      if (config.data_replicas < 2 || config.data_replicas > 3) {
        throw new Error('Erasure coding requires data_replicas of 2 (single parity) or 3 (double parity)');
      }
      // Reed-Solomon needs one failure domain per parity block on top of the data blocks
      if (durableCount < config.data_replicas + 1) {
        throw new Error(`Erasure coding with data_replicas=${config.data_replicas} requires at least ${config.data_replicas + 1} devices with durability greater than 0`);
      }
    } else if (config.data_replicas < 1 || config.data_replicas > 4) {
      throw new Error('data_replicas must be between 1 and 4');
    }

    if (config.data_replicas > durableCount) {
      throw new Error(`data_replicas=${config.data_replicas} exceeds the ${durableCount} device(s) with durability greater than 0`);
    }

    if (config.metadata_replicas > durableCount) {
      throw new Error(`metadata_replicas=${config.metadata_replicas} exceeds the ${durableCount} device(s) with durability greater than 0`);
    }

    return true;
  }

  /**
   * Validate that the members left after a removal can still carry the pool configuration
   * @param {Object} config - Pool config
   * @param {Object[]} remaining - Remaining data_devices entries with group and durability
   * @throws {Error} If the removal would break redundancy or the cache targets
   */
  static validateRemainingMembers(config, remaining) {
    if (!remaining.some(d => d.group === DATA_GROUP)) {
      throw new Error('At least one data device must remain in the pool');
    }

    // Targets are set at format time and keep pointing at the cache label
    if (config.cache_mode && !remaining.some(d => d.group === CACHE_GROUP)) {
      throw new Error('The last cache device cannot be removed while a cache mode is configured. Replace it instead.');
    }

    return BcachefsHelpers.validateConfig(config, remaining);
  }

  /**
   * Assign group, slot and durability to the prepared devices of a new pool
   * Expects data devices first, cache devices second - slots continue across both so they
   * line up with the LUKS mapper names the device strategy created from startSlot 1
   * @param {Object[]} preparedInfos - Device infos from strategy.prepareDevices()
   * @param {number} dataCount - Number of leading entries that are data devices
   * @param {Object} config - Normalized config from buildConfig()
   * @returns {Object[]} Entries of { slot, group, path, physicalDevice, durability }
   */
  static buildDeviceEntries(preparedInfos, dataCount, config = {}) {
    const mode = CACHE_MODES[config.cache_mode] || null;

    return preparedInfos.map((info, i) => {
      const group = i < dataCount ? DATA_GROUP : CACHE_GROUP;

      return {
        slot: i + 1,
        group,
        path: info.operationalDevice,
        physicalDevice: info.physicalDevice,
        durability: group === CACHE_GROUP && mode ? mode.ssd_durability : 1
      };
    });
  }

  /**
   * Build the argument list for `bcachefs format`
   * Device options are sticky for all following devices, so devices are emitted grouped and
   * every group repeats --durability to avoid inheriting the previous group's value
   * @param {string} name - Pool name (used as filesystem label)
   * @param {Object[]} deviceEntries - Device entries from buildDeviceEntries()
   * @param {Object} config - Normalized config from buildConfig()
   * @returns {string[]} Arguments for the bcachefs binary
   */
  static buildFormatArgs(name, deviceEntries, config) {
    const args = [
      'format',
      `--fs_label=${name}`,
      `--data_replicas=${config.data_replicas}`,
      `--metadata_replicas=${config.metadata_replicas}`
    ];

    if (config.erasure_code) {
      args.push('--erasure_code');
    }
    if (config.compression !== 'none') {
      args.push(`--compression=${config.compression}`);
    }
    if (config.background_compression !== 'none') {
      args.push(`--background_compression=${config.background_compression}`);
    }

    // Device options are sticky for all following devices and --rotational has no documented
    // off switch in `format`, so the cache group is emitted first and the rotational data
    // group last. Command order does not matter to bcachefs, labels carry the identity.
    for (const group of [CACHE_GROUP, DATA_GROUP]) {
      const inGroup = deviceEntries.filter(d => d.group === group);
      if (inGroup.length === 0) continue;

      args.push(`--durability=${inGroup[0].durability}`);
      if (group === DATA_GROUP) {
        args.push('--rotational');
      }

      for (const entry of inGroup) {
        args.push(`--label=${BcachefsHelpers.deviceLabel(group, entry.slot)}`, entry.path);
      }
    }

    args.push(...BcachefsHelpers.buildTargetArgs(deviceEntries, config));

    return args;
  }

  /**
   * Build the target options that implement the cache mode
   * Targets are only emitted when the pool actually has both groups
   * @param {Object[]} deviceEntries - Device entries from buildDeviceEntries()
   * @param {Object} config - Normalized config from buildConfig()
   * @returns {string[]} Target arguments (empty when there is no cache group)
   */
  static buildTargetArgs(deviceEntries, config) {
    const mode = CACHE_MODES[config.cache_mode];
    const hasCache = deviceEntries.some(d => d.group === CACHE_GROUP);
    const hasData = deviceEntries.some(d => d.group === DATA_GROUP);

    if (!mode || !hasCache || !hasData) {
      return [];
    }

    const args = [
      `--foreground_target=${mode.foreground}`,
      `--promote_target=${mode.promote}`,
      `--background_target=${mode.background}`
    ];

    if (mode.metadata) {
      args.push(`--metadata_target=${mode.metadata}`);
    }

    return args;
  }

  /**
   * Build the mount source for a bcachefs filesystem
   * @param {string[]} devicePaths - All member device paths
   * @returns {string} Colon separated device list
   */
  static buildMountSource(devicePaths) {
    if (!Array.isArray(devicePaths) || devicePaths.length === 0) {
      throw new Error('No member devices resolved for bcachefs pool');
    }
    if (devicePaths.some(p => !p)) {
      throw new Error('Could not resolve all member devices of the bcachefs pool');
    }
    return devicePaths.join(':');
  }
}

module.exports = BcachefsHelpers;
