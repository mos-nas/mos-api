const fs = require('fs').promises;
const net = require('net');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const NUT_JSON = '/boot/config/system/nut.json';
const NETWORK_JSON = '/boot/config/network.json';
const SCRIPT_DIR = '/boot/config/system/nut';
const STATE_DIR = '/var/mos/nut';
const STATE_FILE = '/var/mos/nut/power-state.json';
const MOS_NOTIFY_SOCKET = '/var/run/mos-notify.sock';

// Human readable message per upsmon NOTIFYTYPE
const EVENT_MESSAGES = {
  ONLINE: 'UPS is back on line power',
  ONBATT: 'UPS is on battery',
  SHUTDOWN: 'System shutdown in progress',
  LOWBATT: 'UPS battery is low',
  FSD: 'UPS forced shutdown in progress',
  COMMBAD: 'Communication with UPS lost',
  NOCOMM: 'UPS is unavailable',
  NOPARENT: 'upsmon parent process died - shutdown impossible',
  REPLBATT: 'UPS battery needs to be replaced'
};

// Events sent with alert priority
const ALERT_EVENTS = new Set(['ONBATT', 'LOWBATT', 'FSD', 'COMMBAD', 'NOCOMM', 'NOPARENT', 'REPLBATT']);

/**
 * NUT Service - Manages Network UPS Tools configuration, status and event handling.
 * The data model lives in nut.json; the init scripts render /etc/nut from it.
 */
class NutService {
  // ============================================================
  // DEFAULT CONFIGURATION
  // ============================================================

  /**
   * Get default NUT configuration
   * @returns {Object} Default NUT model
   */
  _getDefaults() {
    return {
      enabled: false,
      mode: 'standalone',
      spindown_disks: false,
      server: {
        listen: [{ address: '0.0.0.0', port: 3493 }],
        // override.battery.runtime.low forces LB (and thus shutdown) at 15 min remaining runtime
        ups: { name: 'ups', driver: 'usbhid-ups', port: 'auto', desc: '', extra: { 'override.battery.runtime.low': 900 } },
        users: [
          { username: 'admin', password: 'adminpass', actions: ['set', 'fsd'], instcmds: ['all'], upsmon: null },
          { username: 'monuser', password: 'monpass', actions: [], instcmds: [], upsmon: 'primary' }
        ]
      },
      monitor: { upsname: 'ups', host: '127.0.0.1', port: 3493, powervalue: 1, username: 'monuser', password: 'monpass', role: 'primary' },
      shutdown: { command: '/sbin/shutdown -h +0', mode: 'lowbattery', timer_seconds: 180, finaldelay: 5, minsupplies: 1, powerdownflag: '/etc/killpower' },
      timers: { pollfreq: 5, pollfreqalert: 5, hostsync: 15, deadtime: 15, rbwarntime: 43200, nocommwarntime: 300 },
      stop_services: { docker: [], lxc: [], vms: [] }
    };
  }

  // ============================================================
  // HELPERS
  // ============================================================

  /**
   * Recursively merge source into target (objects only; arrays/scalars are replaced)
   * @param {Object} target - Base object
   * @param {Object} source - Overrides
   * @returns {Object} Merged object
   */
  _deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      const val = source[key];
      if (val && typeof val === 'object' && !Array.isArray(val) &&
          result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
        result[key] = this._deepMerge(result[key], val);
      } else if (val !== undefined) {
        result[key] = val;
      }
    }
    return result;
  }

  /**
   * Coerce a value to a number, tolerating numeric strings and comma decimals
   * @param {number|string} value - Value to coerce
   * @param {Object} [opts]
   * @param {boolean} [opts.integer=true] - Truncate to integer
   * @returns {number} Parsed number
   */
  _coerceNumber(value, { integer = true } = {}) {
    if (typeof value === 'number') return integer ? Math.trunc(value) : value;
    if (typeof value === 'string') {
      const cleaned = value.replace(',', '.').trim();
      if (cleaned === '') throw new Error('numeric value must not be empty');
      const num = Number(cleaned);
      if (!Number.isFinite(num)) throw new Error(`invalid numeric value: ${value}`);
      return integer ? Math.trunc(num) : num;
    }
    throw new Error(`invalid numeric value: ${value}`);
  }

  /**
   * Coerce all known numeric fields of the model in place
   * @param {Object} model - NUT model
   * @returns {Object} Same model with numeric fields normalized
   */
  _coerceModel(model) {
    if (model.server && Array.isArray(model.server.listen)) {
      model.server.listen = model.server.listen.map(l => ({ ...l, port: this._coerceNumber(l.port) }));
    }
    if (model.monitor) {
      if (model.monitor.port !== undefined) model.monitor.port = this._coerceNumber(model.monitor.port);
      if (model.monitor.powervalue !== undefined) model.monitor.powervalue = this._coerceNumber(model.monitor.powervalue);
    }
    if (model.shutdown) {
      for (const k of ['timer_seconds', 'finaldelay', 'minsupplies']) {
        if (model.shutdown[k] !== undefined) model.shutdown[k] = this._coerceNumber(model.shutdown[k]);
      }
    }
    if (model.timers) {
      for (const k of Object.keys(model.timers)) {
        if (model.timers[k] !== undefined) model.timers[k] = this._coerceNumber(model.timers[k]);
      }
    }
    return model;
  }

  // ============================================================
  // CONFIG READ / WRITE
  // ============================================================

  /**
   * Read the model from nut.json, filled with defaults.
   * On first run (no nut.json) the enabled flag is migrated from network.json.
   * @returns {Promise<Object>} NUT model
   */
  async _readModel() {
    try {
      const data = await fs.readFile(NUT_JSON, 'utf8');
      return this._deepMerge(this._getDefaults(), JSON.parse(data));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const defaults = this._getDefaults();
      try {
        const netCfg = JSON.parse(await fs.readFile(NETWORK_JSON, 'utf8'));
        if (netCfg.services && netCfg.services.nut && typeof netCfg.services.nut.enabled === 'boolean') {
          defaults.enabled = netCfg.services.nut.enabled;
        }
      } catch (_) {}
      return defaults;
    }
  }

  /**
   * Write the model to nut.json atomically (tmp file + rename)
   * @param {Object} model - NUT model
   * @returns {Promise<void>}
   */
  async _writeModel(model) {
    const tmp = `${NUT_JSON}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(model, null, 2), 'utf8');
    await fs.rename(tmp, NUT_JSON);
  }

  // ============================================================
  // SETTINGS API
  // ============================================================

  /**
   * Get the full NUT settings model
   * @returns {Promise<Object>} NUT model
   */
  async getSettings() {
    return this._readModel();
  }

  /**
   * Deep-merge and persist settings; restart services only on essential changes
   * @param {Object} input - Partial NUT model
   * @returns {Promise<Object>} The merged model
   */
  async updateSettings(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('settings must be an object');
    }
    const current = await this._readModel();
    const merged = this._coerceModel(this._deepMerge(current, input));
    // enabled is managed via the network services endpoint only
    merged.enabled = current.enabled;
    await this._writeModel(merged);

    if (this._essentialChanged(current, merged)) {
      await this._applyRestart();
    }
    return merged;
  }

  /**
   * Whether anything other than stop_services changed (stop_services is runtime-only)
   * @param {Object} oldModel - Previous model
   * @param {Object} newModel - New model
   * @returns {boolean}
   */
  _essentialChanged(oldModel, newModel) {
    const strip = (m) => { const clone = { ...m }; delete clone.stop_services; return JSON.stringify(clone); };
    return strip(oldModel) !== strip(newModel);
  }

  // ============================================================
  // SERVICE CONTROL
  // ============================================================

  /**
   * Whether NUT is enabled
   * @returns {Promise<boolean>}
   */
  async isEnabled() {
    const model = await this._readModel();
    return !!model.enabled;
  }

  /**
   * Toggle the enabled flag and restart the services if it changed
   * @param {boolean} enabled - Desired state
   * @returns {Promise<Object>} Updated model
   */
  async setEnabled(enabled) {
    const current = await this._readModel();
    if (current.enabled === enabled) return current;
    current.enabled = enabled;
    await this._writeModel(current);
    await this._applyRestart();
    return current;
  }

  /**
   * Restart the NUT services. nut-server renders /etc/nut and starts first,
   * nut-client (upsmon) follows.
   * @private
   * @returns {Promise<void>}
   */
  async _applyRestart() {
    await execPromise('/etc/init.d/nut-server restart').catch(() => {});
    await execPromise('/etc/init.d/nut-client restart').catch(() => {});
  }

  // ============================================================
  // STATUS
  // ============================================================

  /**
   * Parse a upsc value to a number, tolerating comma decimals; null when absent/invalid
   * @private
   * @param {string} value
   * @returns {number|null}
   */
  _num(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(String(value).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Project the dynamic upsc vars onto a fixed, always-present shape (missing = null).
   * The full raw map is still returned separately as `vars`.
   * @private
   * @param {Object} vars - Raw upsc key/value map
   * @returns {Object} Normalized data
   */
  _normalizeVars(vars) {
    const s = (k) => (vars[k] !== undefined ? vars[k] : null);
    const n = (k) => this._num(vars[k]);
    return {
      model: s('device.model') ?? s('ups.model'),
      manufacturer: s('device.mfr') ?? s('ups.mfr'),
      serial: s('device.serial') ?? s('ups.serial'),
      load: n('ups.load'),
      realpowerNominal: n('ups.realpower.nominal'),
      battery: {
        charge: n('battery.charge'),
        chargeLow: n('battery.charge.low'),
        runtime: n('battery.runtime'),
        voltage: n('battery.voltage'),
        type: s('battery.type')
      },
      input: { voltage: n('input.voltage'), frequency: n('input.frequency') },
      output: { voltage: n('output.voltage'), frequency: n('output.frequency') }
    };
  }

  /**
   * Get live UPS status via upsc. reachable=false when NUT is disabled or upsd
   * can't be queried (the enabled flag itself is exposed via the services endpoint).
   * The response shape is always identical: fixed fields in `data` (null when missing),
   * plus the complete raw key/value map in `vars`.
   * @returns {Promise<Object>} Status object
   */
  async getStatus() {
    const model = await this._readModel();
    if (!model.enabled || model.mode === 'none') {
      return { reachable: false, name: null, status: null, data: this._normalizeVars({}), vars: {} };
    }
    const name = model.monitor.upsname || 'ups';
    const host = model.monitor.host || '127.0.0.1';
    const port = model.monitor.port || 3493;
    try {
      const { stdout } = await execPromise(`upsc ${name}@${host}:${port}`);
      const vars = {};
      for (const line of stdout.split('\n')) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        vars[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      return {
        reachable: true,
        name,
        status: vars['ups.status'] || null,
        data: this._normalizeVars(vars),
        vars
      };
    } catch (error) {
      return { reachable: false, name, status: null, data: this._normalizeVars({}), vars: {}, error: error.message };
    }
  }

  // ============================================================
  // EVENT HANDLING
  // ============================================================

  /**
   * Handle a NUT event (called from upsmon via mos-api_cli): notify, orchestrate
   * workloads on power transitions and run the optional user script.
   * @param {string} type - NUT NOTIFYTYPE (e.g. ONBATT, ONLINE)
   * @returns {Promise<Object>}
   */
  async handleEvent(type) {
    const event = String(type || '').toUpperCase();
    await this._sendNotification('UPS', EVENT_MESSAGES[event] || `UPS event: ${event}`, ALERT_EVENTS.has(event) ? 'alert' : 'normal');

    if (event === 'ONBATT') {
      await this.stopServices();
      const model = await this._readModel();
      if (model.spindown_disks) await this._spindownDisks();
    } else if (event === 'ONLINE') {
      await this.restoreServices();
    }

    this._runEventScript(event);
    return { event };
  }

  // ============================================================
  // WORKLOAD ORCHESTRATION
  // ============================================================

  /**
   * Stop the managed workloads that are currently running and remember them,
   * so they can be restored when power returns.
   * @returns {Promise<Object>} The stored state
   */
  async stopServices() {
    const model = await this._readModel();
    const cfg = model.stop_services || {};
    const managed = {
      docker: (cfg.docker || []).filter(e => e && e.enabled).map(e => e.name),
      lxc: (cfg.lxc || []).filter(e => e && e.enabled).map(e => e.name),
      vms: (cfg.vms || []).filter(e => e && e.enabled).map(e => e.name)
    };

    const [dockerRunning, lxcRunning, vmRunning] = await Promise.all([
      this._runningDocker(), this._runningLxc(), this._runningVms()
    ]);

    // Only remember workloads that were actually running
    const state = {
      docker: managed.docker.filter(n => dockerRunning.has(n)),
      lxc: managed.lxc.filter(n => lxcRunning.has(n)),
      vms: managed.vms.filter(n => vmRunning.has(n))
    };

    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');

    const tasks = [];
    for (const n of state.docker) tasks.push(execPromise(`docker stop ${n}`).catch(() => {}));
    for (const n of state.lxc) tasks.push(require('./lxc.service').stopContainer(n).catch(() => {}));
    for (const n of state.vms) tasks.push(require('./vm.service').stopVm(n).catch(() => {}));
    await Promise.allSettled(tasks);
    return state;
  }

  /**
   * Restart the workloads recorded by stopServices() and drop the state file.
   * @returns {Promise<Object>}
   */
  async restoreServices() {
    let state;
    try {
      state = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    } catch (error) {
      return { restored: false };
    }

    for (const n of state.docker || []) await execPromise(`docker start ${n}`).catch(() => {});
    for (const n of state.lxc || []) await require('./lxc.service').startContainer(n).catch(() => {});
    for (const n of state.vms || []) await require('./vm.service').startVm(n).catch(() => {});

    await fs.rm(STATE_FILE, { force: true }).catch(() => {});
    return { restored: true, state };
  }

  /**
   * Put all spin-capable disks into standby (skips nvme/md/zram which have no standby).
   * @private
   * @returns {Promise<void>}
   */
  async _spindownDisks() {
    try {
      const disksService = require('./disks.service');
      const disks = await disksService.getAllDisks({ skipStandby: true, includePerformance: false });
      const names = (disks || [])
        .filter(d => d && d.name && d.type !== 'ramdisk' && !/^(nvme|md|nmd|zram)/.test(d.name))
        .map(d => d.name);
      if (names.length) await disksService.sleepMultipleDisks(names, 'standby');
    } catch (_) {}
  }

  /**
   * Names of currently running docker containers
   * @private
   * @returns {Promise<Set<string>>}
   */
  async _runningDocker() {
    try {
      const { stdout } = await execPromise('docker ps --format "{{.Names}}" --filter "status=running"');
      return new Set(stdout.trim().split('\n').filter(Boolean));
    } catch (_) { return new Set(); }
  }

  /**
   * Names of currently running LXC containers
   * @private
   * @returns {Promise<Set<string>>}
   */
  async _runningLxc() {
    try {
      const { stdout } = await execPromise('lxc-ls --running -1');
      return new Set(stdout.trim().split('\n').filter(Boolean));
    } catch (_) { return new Set(); }
  }

  /**
   * Names of currently running VMs
   * @private
   * @returns {Promise<Set<string>>}
   */
  async _runningVms() {
    try {
      const { stdout } = await execPromise('virsh list --name');
      return new Set(stdout.trim().split('\n').filter(Boolean));
    } catch (_) { return new Set(); }
  }

  // ============================================================
  // USER SCRIPT / NOTIFICATION
  // ============================================================

  /**
   * Run the optional per-event script detached so it survives this process exiting.
   * @private
   * @param {string} event - NUT event type
   */
  _runEventScript(event) {
    const script = `${SCRIPT_DIR}/${event.toLowerCase()}.sh`;
    fs.stat(script).then(st => {
      if (st.isFile() && st.size > 0) {
        exec(`setsid sh ${script} </dev/null >/dev/null 2>&1 &`);
      }
    }).catch(() => {});
  }

  /**
   * Send a notification via the mos-notify socket
   * @private
   * @param {string} title - Notification title
   * @param {string} message - Notification body
   * @param {string} [priority='normal'] - Priority level
   * @returns {Promise<boolean>} Whether the notification was delivered
   */
  _sendNotification(title, message, priority = 'normal') {
    return new Promise((resolve) => {
      const client = net.createConnection(MOS_NOTIFY_SOCKET, () => {
        client.write(JSON.stringify({ title, message, priority }));
        client.end();
        resolve(true);
      });
      client.on('error', () => resolve(false));
    });
  }
}

module.exports = new NutService();
