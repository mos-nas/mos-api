const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const MOS_NOTIFY_SOCKET = '/var/run/mos-notify.sock';
const TEMP_DIR = '/var/mos/diag-temp';
const OUTPUT_DIR = '/boot/diagnostics';

// Lazy-load services to allow usage without full API context (e.g. CLI)
const getService = (name) => require(`./${name}.service`);
const getPoolsService = () => {
  const PoolsService = getService('pools');
  return new PoolsService();
};

/**
 * Collector types:
 *   - file:      copies a file from `source` into the temp dir
 *   - directory: copies all files from `source` directory into the temp dir
 *   - command:   runs a shell command, writes stdout into the temp dir
 *   - service:   calls an async function, writes the JSON result into the temp dir
 *
 * If a collector fails, the error is appended to a central errors.txt.
 */
const collectors = [
  // Service calls (processed API data, skipped when running via CLI)
  { type: 'service', call: () => getPoolsService().listPools(), target: 'api/pools.json' },
  { type: 'service', call: () => getService('disks').getAllDisks(), target: 'api/disks.json' },
  { type: 'service', call: () => getService('shares').getShares(), target: 'api/shares.json' },
  { type: 'service', call: () => getService('cron').getCronJobs(), target: 'api/cron.json' },
  { type: 'service', call: () => getService('mos').getAllServiceStatus(), target: 'api/services.json' },
  { type: 'service', call: () => getService('mos').getMappedSensors(), target: 'api/sensors.json' },

  // Raw config files
  { type: 'file', source: '/etc/mos-release.json', target: 'mos-release.json' },
  { type: 'file', source: '/boot/config/dashboard.json', target: 'config/dashboard.json' },
  { type: 'file', source: '/boot/config/docker.json', target: 'config/docker.json' },
  { type: 'file', source: '/boot/config/lxc.json', target: 'config/lxc.json' },
  { type: 'file', source: '/boot/config/network.json', target: 'config/network.json' },
  { type: 'file', source: '/boot/config/pools.json', target: 'config/pools.json' },
  { type: 'file', source: '/boot/config/remotes.json', target: 'config/remotes.json' },
  { type: 'file', source: '/boot/config/shares.json', target: 'config/shares.json' },
  { type: 'file', source: '/boot/config/system.json', target: 'config/system.json' },
  { type: 'file', source: '/boot/config/vm.json', target: 'config/vm.json' },
  { type: 'file', source: '/boot/config/system/cron.json', target: 'config/system/cron.json' },
  { type: 'file', source: '/boot/config/system/hub.json', target: 'config/system/hub.json' },
  { type: 'file', source: '/boot/config/system/proxy.json', target: 'config/system/proxy.json' },
  { type: 'file', source: '/boot/config/system/sensors.json', target: 'config/system/sensors.json' },
  { type: 'file', source: '/boot/config/system/smart.json', target: 'config/system/smart.json' },
  { type: 'file', source: '/boot/config/system/zram.json', target: 'config/system/zram.json' },
  { type: 'file', source: '/boot/config/system/iscsi/initiator.json', target: 'config/system/iscsi/initiator.json' },
  { type: 'file', source: '/boot/config/system/iscsi/target.json', target: 'config/system/iscsi/target.json' },
  { type: 'file', source: '/boot/config/system/lxc/default.conf', target: 'config/system/lxc/default.conf' },
  { type: 'file', source: '/boot/config/system/nut/nut.conf', target: 'config/system/nut/nut.conf' },
  { type: 'file', source: '/boot/config/system/nut/ups.conf', target: 'config/system/nut/ups.conf' },
  { type: 'file', source: '/boot/config/system/nut/upsd.conf', target: 'config/system/nut/upsd.conf' },
  { type: 'file', source: '/boot/config/system/nut/upsd.users', target: 'config/system/nut/upsd.users' },
  { type: 'file', source: '/boot/config/system/nut/upsmon.conf', target: 'config/system/nut/upsmon.conf' },
  { type: 'file', source: '/boot/config/system/nut/upssched.conf', target: 'config/system/nut/upssched.conf' },
  { type: 'file', source: '/boot/grub/grub.cfg', target: 'grub/grub.cfg' },
  { type: 'file', source: '/etc/nginx/nginx.conf', target: 'system/nginx.conf' },
  { type: 'file', source: '/var/log/api', target: 'logs/api.txt' },
  { type: 'file', source: '/var/log/boot', target: 'logs/boot.txt' },
  { type: 'file', source: '/var/log/docker', target: 'logs/docker.txt' },
  { type: 'file', source: '/var/log/syslog', target: 'logs/syslog.txt' },
  { type: 'file', source: '/var/log/samba/samba.log', target: 'logs/samba.txt' },
  { type: 'file', source: '/etc/exports', target: 'nfs/exports.txt' },

  // Directories
  { type: 'directory', source: '/var/log/libvirt', target: 'logs/libvirt' },
  { type: 'directory', source: '/var/log/libvirt/qemu', target: 'logs/qemu' },
  { type: 'directory', source: '/boot/config/snapraid', target: 'config/snapraid' },

  // System commands
  { type: 'command', command: 'tree /boot 2>/dev/null', target: 'boot_tree.txt' },
  { type: 'command', command: 'uname --all 2>/dev/null', target: 'uname.txt' },
  { type: 'command', command: 'lscpu 2>/dev/null', target: 'system/cpu.txt' },
  { type: 'command', command: 'dmidecode -qt 2,4 2>/dev/null', target: 'system/motherboard.txt' },
  { type: 'command', command: 'dmidecode -qt 0 2>/dev/null', target: 'system/bios.txt' },
  { type: 'command', command: 'dmidecode -qt 17 2>/dev/null', target: 'system/memory.txt' },
  { type: 'command', command: 'testparm -s 2>/dev/null', target: 'samba/testparm.txt' },
  { type: 'command', command: 'df -h 2>/dev/null', target: 'system/df.txt' },
  { type: 'command', command: 'crontab -l 2>/dev/null', target: 'system/cron.txt' },
  { type: 'command', command: 'ls -lA /sys/class/drm/*/device/driver 2>/dev/null', target: 'system/dri.txt' },
  { type: 'command', command: 'ls -lA /sys/class/dvb/*/device/driver 2>/dev/null', target: 'system/dvb.txt' },
  { type: 'command', command: 'nvidia-smi --query 2>/dev/null', target: 'system/nvidia-smi.txt' },
  { type: 'command', command: 'dmesg --nopager 2>/dev/null', target: 'system/dmesg.txt' },
  { type: 'command', command: 'lspci -knn 2>/dev/null', target: 'system/lspci.txt' },
  { type: 'command', command: `lspci -vv 2>/dev/null | awk -b '/ASPM/{print $0}' RS= | grep -P '(^[a-z0-9:.]+|ASPM |Disabled;|Enabled;)'`, target: 'system/aspm.txt' },
  { type: 'command', command: 'lsusb -vt 2>/dev/null', target: 'system/lsusb.txt' },
  { type: 'command', command: 'ip -br addr | grep -vE "^(veth|docker0|virbr|tunl0|br-[a-f0-9]{12}|lxcbr)"', target: 'system/interfaces.txt' },
];

class DiagnosticsService {
  async collect({ types } = {}) {
    await fs.mkdir(TEMP_DIR, { recursive: true });
    const tempDir = await fs.mkdtemp(path.join(TEMP_DIR, 'run-'));
    const errors = [];
    const activeCollectors = types
      ? collectors.filter(c => types.includes(c.type))
      : collectors;

    for (const collector of activeCollectors) {
      try {
        const targetPath = path.join(tempDir, collector.target);
        await fs.mkdir(path.dirname(targetPath), { recursive: true });

        if (collector.type === 'file') {
          await this._collectFile(collector, targetPath);
        } else if (collector.type === 'directory') {
          await this._collectDirectory(collector, targetPath);
        } else if (collector.type === 'command') {
          await this._collectCommand(collector, targetPath);
        } else if (collector.type === 'service') {
          await this._collectService(collector, targetPath);
        }
      } catch (err) {
        errors.push(`[${collector.type}] ${collector.target}: ${err.message}`);
      }
    }

    if (errors.length > 0) {
      await fs.writeFile(path.join(tempDir, 'errors.txt'), errors.join('\n') + '\n', 'utf8');
    }

    return tempDir;
  }

  async _collectFile(collector, targetPath) {
    await fs.copyFile(collector.source, targetPath);
  }

  async _collectDirectory(collector, targetPath) {
    if (collector.recursive) {
      await fs.cp(collector.source, targetPath, { recursive: true });
    } else {
      const entries = await fs.readdir(collector.source, { withFileTypes: true });
      const files = entries.filter(e => e.isFile());
      if (files.length === 0) return;
      await fs.mkdir(targetPath, { recursive: true });
      for (const file of files) {
        await fs.copyFile(
          path.join(collector.source, file.name),
          path.join(targetPath, file.name)
        );
      }
    }
  }

  async _collectCommand(collector, targetPath) {
    const { stdout } = await execPromise(collector.command, { timeout: 15000 });
    if (!stdout || stdout.trim().length === 0) return;
    await fs.writeFile(targetPath, stdout, 'utf8');
  }

  async _collectService(collector, targetPath) {
    const result = await collector.call();
    if (result === undefined || result === null) return;
    await fs.writeFile(targetPath, JSON.stringify(result, null, 2), 'utf8');
  }

  async createArchive(tempDir) {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
    const hostname = os.hostname();
    const archivePath = path.join(OUTPUT_DIR, `${hostname}_${date}.tar.gz`);
    await execPromise(`tar -czf "${archivePath}" -C "${tempDir}" .`);
    await this._sendNotification('Diagnostics', `Diagnostics created: ${archivePath}`);
    return archivePath;
  }

  getArchiveStream(archivePath) {
    return fsSync.createReadStream(archivePath);
  }

  async cleanup(tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }

  /**
   * Send notification via mos-notify socket, falls back to notify CLI
   * @private
   */
  async _sendNotification(title, message, priority = 'normal') {
    try {
      await this._sendViaSocket(title, message, priority);
    } catch {
      await this._sendViaCli(title, message, priority).catch(() => {});
    }
  }

  /** @private */
  async _sendViaSocket(title, message, priority) {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(MOS_NOTIFY_SOCKET, () => {
        const payload = JSON.stringify({ title, message, priority });
        client.write(payload);
        client.end();
        resolve(true);
      });
      client.on('error', (err) => reject(err));
    });
  }

  /** @private */
  async _sendViaCli(title, message, priority) {
    await execPromise(`notify -t "${title}" -m "${message}" -p ${priority}`);
  }
}

module.exports = new DiagnosticsService();
