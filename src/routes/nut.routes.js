const express = require('express');
const router = express.Router();
const nutService = require('../services/nut.service');
const { checkRole } = require('../middleware/auth.middleware');

router.use(checkRole(['admin']));

/**
 * @swagger
 * tags:
 *   name: NUT
 *   description: Network UPS Tools configuration and status
 *
 * components:
 *   schemas:
 *     NutSettings:
 *       type: object
 *       description: NUT configuration model. The enabled flag is not part of this model; it is managed via the network services endpoint.
 *       properties:
 *         mode:
 *           type: string
 *           enum: [standalone, netserver, netclient, none]
 *         spindown_disks:
 *           type: boolean
 *           description: Put all spin-capable disks into standby on ONBATT.
 *         server:
 *           type: object
 *           properties:
 *             listen:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   address: { type: string }
 *                   port: { type: integer }
 *             ups:
 *               type: object
 *               properties:
 *                 name: { type: string }
 *                 driver: { type: string }
 *                 port: { type: string }
 *                 desc: { type: string }
 *                 extra: { type: object, additionalProperties: { type: string } }
 *             users:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   username: { type: string }
 *                   password: { type: string }
 *                   actions: { type: array, items: { type: string } }
 *                   instcmds: { type: array, items: { type: string } }
 *                   upsmon: { type: string, nullable: true, enum: [primary, secondary, null] }
 *         monitor:
 *           type: object
 *           properties:
 *             upsname: { type: string }
 *             host: { type: string }
 *             port: { type: integer }
 *             powervalue: { type: integer }
 *             username: { type: string }
 *             password: { type: string }
 *             role: { type: string, enum: [primary, secondary] }
 *         shutdown:
 *           type: object
 *           properties:
 *             command: { type: string }
 *             mode: { type: string, enum: [lowbattery, timer] }
 *             timer_seconds: { type: integer }
 *             finaldelay: { type: integer }
 *             minsupplies: { type: integer }
 *             powerdownflag: { type: string }
 *         timers:
 *           type: object
 *           properties:
 *             pollfreq: { type: integer }
 *             pollfreqalert: { type: integer }
 *             hostsync: { type: integer }
 *             deadtime: { type: integer }
 *             rbwarntime: { type: integer }
 *             nocommwarntime: { type: integer }
 *         stop_services:
 *           type: object
 *           description: Workloads to stop on ONBATT and restart on ONLINE (if they were running).
 *           properties:
 *             docker: { $ref: '#/components/schemas/NutWorkloadList' }
 *             lxc: { $ref: '#/components/schemas/NutWorkloadList' }
 *             vms: { $ref: '#/components/schemas/NutWorkloadList' }
 *     NutWorkloadList:
 *       type: array
 *       items:
 *         type: object
 *         properties:
 *           name: { type: string }
 *           enabled: { type: boolean }
 *     NutSettingsResponse:
 *       allOf:
 *         - $ref: '#/components/schemas/NutSettings'
 *         - type: object
 *           properties:
 *             enabled:
 *               type: boolean
 *               description: Managed via the network services endpoint (read-only here).
 *     NutStatus:
 *       type: object
 *       properties:
 *         reachable:
 *           type: boolean
 *           description: False when NUT is disabled or upsd could not be queried (the enabled flag is exposed via the services endpoint).
 *         name: { type: string, nullable: true }
 *         status: { type: string, nullable: true, description: "Raw ups.status flags, e.g. OL, OB, LB." }
 *         data:
 *           type: object
 *           description: Fixed, always-present subset of the common values (null when the UPS does not report them).
 *           properties:
 *             model: { type: string, nullable: true }
 *             manufacturer: { type: string, nullable: true }
 *             serial: { type: string, nullable: true }
 *             load: { type: number, nullable: true, description: "Load in percent" }
 *             realpowerNominal: { type: number, nullable: true, description: "Nominal real power in watts" }
 *             battery:
 *               type: object
 *               properties:
 *                 charge: { type: number, nullable: true, description: "Percent" }
 *                 chargeLow: { type: number, nullable: true, description: "Low threshold in percent" }
 *                 runtime: { type: number, nullable: true, description: "Seconds" }
 *                 voltage: { type: number, nullable: true, description: "Volts" }
 *                 type: { type: string, nullable: true }
 *             input:
 *               type: object
 *               properties:
 *                 voltage: { type: number, nullable: true, description: "Volts" }
 *                 frequency: { type: number, nullable: true, description: "Hz" }
 *             output:
 *               type: object
 *               properties:
 *                 voltage: { type: number, nullable: true, description: "Volts" }
 *                 frequency: { type: number, nullable: true, description: "Hz" }
 *         vars:
 *           type: object
 *           description: Complete raw upsc key/value map (all values are strings).
 *           additionalProperties: { type: string }
 *         error: { type: string }
 */

/**
 * @swagger
 * /nut/settings:
 *   get:
 *     summary: Get NUT settings
 *     description: Returns the full NUT configuration model, filled with defaults for missing fields (admin only).
 *     tags: [NUT]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: NUT settings
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/NutSettingsResponse'
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/settings', async (req, res) => {
  try {
    const settings = await nutService.getSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /nut/settings:
 *   post:
 *     summary: Update NUT settings
 *     description: Deep-merges the given fields into the model and restarts the NUT services only when an essential (non stop_services) setting changed. Numeric fields accept numbers or strings (comma decimals allowed). The enabled flag is managed via the network services endpoint and is ignored here.
 *     tags: [NUT]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/NutSettings'
 *           example:
 *             mode: netclient
 *             monitor:
 *               upsname: ups
 *               host: 192.168.1.10
 *               username: monuser
 *               password: monpass
 *               role: secondary
 *     responses:
 *       200:
 *         description: Updated NUT settings
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/NutSettingsResponse'
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/settings', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be an object with NUT settings.' });
    }
    const updated = await nutService.updateSettings(req.body);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /nut/status:
 *   get:
 *     summary: Get UPS status
 *     description: Returns live UPS status via upsc. reachable=false when NUT is disabled or upsd cannot be queried.
 *     tags: [NUT]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: UPS status
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/NutStatus'
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin permission required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/status', async (req, res) => {
  try {
    const status = await nutService.getStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
