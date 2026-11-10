const express = require('express');
const router = express.Router();
const cronService = require('../services/cron.service');
const { checkRole } = require('../middleware/auth.middleware');

/**
 * @swagger
 * tags:
 *   name: Cron
 *   description: Cron Jobs Management and Scheduling
 *
 * components:
 *   schemas:
 *     Error:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           description: Success status
 *           example: false
 *         error:
 *           type: string
 *           description: Error message
 *     CronJob:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Unique cron job identifier
 *           example: "job-123"
 *         name:
 *           type: string
 *           description: Cron job name
 *           example: "backup-database"
 *         schedule:
 *           type: string
 *           description: Cron schedule expression
 *           example: "0 2 * * *"
 *         command:
 *           type: string
 *           description: Command to execute
 *           example: "/usr/local/bin/backup-db.sh"
 *         enabled:
 *           type: boolean
 *           description: Whether cron job is enabled
 *           example: true
 *         scriptPath:
 *           type: string
 *           nullable: true
 *           description: Path to the generated script file
 *           example: "/boot/optional/scripts/cron/backup_database.sh"
 *         status:
 *           type: string
 *           enum: [running, stopped]
 *           description: Current runtime status (dynamically checked using pgrep)
 *           example: "stopped"
 *         created:
 *           type: string
 *           format: date-time
 *           description: Creation timestamp
 *           example: "2024-01-20T10:30:00.000Z"
 *         lastRun:
 *           type: string
 *           format: date-time
 *           nullable: true
 *           description: Last execution timestamp
 *           example: "2024-01-21T02:00:00.000Z"
 *         nextRun:
 *           type: string
 *           format: date-time
 *           nullable: true
 *           description: Next scheduled execution
 *           example: "2024-01-22T02:00:00.000Z"
 *     CreateCronJobRequest:
 *       type: object
 *       required:
 *         - name
 *         - schedule
 *       properties:
 *         name:
 *           type: string
 *           description: Unique cron job name
 *           example: "backup-database"
 *         schedule:
 *           type: string
 *           description: Cron schedule expression (minute hour day month weekday)
 *           pattern: '^(\*|([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])|\*\/([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])) (\*|([0-9]|1[0-9]|2[0-3])|\*\/([0-9]|1[0-9]|2[0-3])) (\*|([1-9]|1[0-9]|2[0-9]|3[0-1])|\*\/([1-9]|1[0-9]|2[0-9]|3[0-1])) (\*|([1-9]|1[0-2])|\*\/([1-9]|1[0-9]|2[0-9]|3[0-1])) (\*|([0-6])|\*\/([0-6]))$'
 *           example: "0 2 * * *"
 *         command:
 *           type: string
 *           description: Shell command to execute (required if script or scriptPath not provided)
 *           example: "/usr/local/bin/backup-db.sh"
 *         enabled:
 *           type: boolean
 *           description: Whether cron job should be enabled (defaults to true)
 *           example: true
 *         script:
 *           type: string
 *           description: Optional script content to create in /boot/optional/scripts/cron (mutually exclusive with scriptPath, auto-generates command)
 *           example: "#!/bin/bash\necho 'Starting backup...'\n/usr/bin/backup-tool\necho 'Backup completed'"
 *         scriptPath:
 *           type: string
 *           description: Optional path to existing script file (mutually exclusive with script, auto-generates command)
 *           example: "/boot/optional/scripts/cron/existing_script.sh"
 *         convert_to_unix:
 *           type: boolean
 *           description: Optional flag to convert script to Unix format using dos2unix (default false)
 *           example: true
 *     UpdateCronJobRequest:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: New cron job name
 *           example: "backup-database-v2"
 *         schedule:
 *           type: string
 *           description: New cron schedule expression
 *           example: "0 3 * * *"
 *         command:
 *           type: string
 *           description: New command to execute
 *           example: "/usr/local/bin/backup-db-v2.sh"
 *         enabled:
 *           type: boolean
 *           description: Whether cron job should be enabled
 *           example: true
 *         script:
 *           type: string
 *           description: New script content to create (mutually exclusive with scriptPath)
 *           example: "#!/bin/bash\necho 'New backup script...'\n/usr/bin/backup-tool-v2"
 *         scriptPath:
 *           type: string
 *           description: New path to existing script file (mutually exclusive with script)
 *           example: "/boot/optional/scripts/cron/new_script.sh"
 *         convert_to_unix:
 *           type: boolean
 *           description: Optional flag to convert script to Unix format using dos2unix (default false)
 *           example: true
 *     CronJobResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           description: Operation successful
 *           example: true
 *         cronJob:
 *           $ref: '#/components/schemas/CronJob'
 *         message:
 *           type: string
 *           description: Operation result message
 *           example: "Cron job created successfully"
 *     CronJobsListResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           description: Operation successful
 *           example: true
 *         cronJobs:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/CronJob'
 *         count:
 *           type: integer
 *           description: Total number of cron jobs
 *           example: 5
 */

/**
 * @swagger
 * /cron:
 *   get:
 *     summary: Get all cron jobs
 *     description: Retrieve a list of all cron jobs in the system (available to all authenticated users)
 *     tags: [Cron]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Cron jobs retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CronJobsListResponse'
 *             example:
 *               success: true
 *               cronJobs:
 *                 - id: "job-123"
 *                   name: "backup-database"
 *                   schedule: "0 2 * * *"
 *                   command: "/usr/local/bin/backup-db.sh"
 *                   enabled: true
 *                   status: "stopped"
 *                   created: "2024-01-20T10:30:00.000Z"
 *                   lastRun: "2024-01-21T02:00:00.000Z"
 *                   nextRun: "2024-01-22T02:00:00.000Z"
 *               count: 1
 *       401:
 *         description: Not authenticated
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
 *   post:
 *     summary: Create new cron job
 *     description: Create a new scheduled cron job (admin only)
 *     tags: [Cron]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateCronJobRequest'
 *           example:
 *             name: "backup-database"
 *             schedule: "0 2 * * *"
 *             command: "/usr/local/bin/backup-db.sh"
 *             script: "#!/bin/bash\necho 'Starting database backup...'\n/usr/bin/backup-tool --database\necho 'Backup completed'"
 *             convert_to_unix: true
 *     responses:
 *       201:
 *         description: Cron job created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CronJobResponse'
 *       400:
 *         description: Bad request - validation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               missing_fields:
 *                 summary: Missing required fields
 *                 value:
 *                   success: false
 *                   error: "Name, Schedule and Command are required"
 *               invalid_schedule:
 *                 summary: Invalid cron format
 *                 value:
 *                   success: false
 *                   error: "Invalid cron format"
 *               duplicate_name:
 *                 summary: Job name already exists
 *                 value:
 *                   success: false
 *                   error: "Cron job with this name already exists"
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

// Get all cron jobs
router.get('/', async (req, res) => {
  try {
    const cronJobs = await cronService.getCronJobs();
    res.json(cronJobs);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /cron/scripts:
 *   get:
 *     summary: List all cron scripts
 *     description: Retrieve a list of all available scripts in /boot/optional/scripts/cron (admin only)
 *     tags: [Cron]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Scripts retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 scripts:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                         example: "backup_database.sh"
 *                       path:
 *                         type: string
 *                         example: "/boot/optional/scripts/cron/backup_database.sh"
 *                       size:
 *                         type: integer
 *                         example: 1024
 *                       created:
 *                         type: string
 *                         format: date-time
 *                       modified:
 *                         type: string
 *                         format: date-time
 *                 count:
 *                   type: integer
 *                   example: 5
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */

// List all cron scripts (admin only)
router.get('/scripts', checkRole(['admin']), async (req, res) => {
  try {
    const scripts = await cronService.listCronScripts();
    res.json({
      success: true,
      scripts: scripts,
      count: scripts.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /cron/scripts/{scriptName}:
 *   get:
 *     summary: Get cron script content
 *     description: Retrieve the content and metadata of a specific cron script (admin only)
 *     tags: [Cron]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: scriptName
 *         required: true
 *         schema:
 *           type: string
 *         description: Script name (with or without .sh extension)
 *         example: "backup_database"
 *     responses:
 *       200:
 *         description: Script retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 script:
 *                   type: object
 *                   properties:
 *                     name:
 *                       type: string
 *                       example: "backup_database.sh"
 *                     path:
 *                       type: string
 *                       example: "/boot/optional/scripts/cron/backup_database.sh"
 *                     size:
 *                       type: integer
 *                       example: 1024
 *                     created:
 *                       type: string
 *                       format: date-time
 *                     modified:
 *                       type: string
 *                       format: date-time
 *                     content:
 *                       type: string
 *                       example: "#!/bin/bash\necho 'Starting backup...'"
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Script not found
 *       500:
 *         description: Server error
 */

// Get specific cron script (admin only)
router.get('/scripts/:scriptName', checkRole(['admin']), async (req, res) => {
  try {
    const script = await cronService.getCronScript(req.params.scriptName);
    res.json({
      success: true,
      script: script
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

/**
 * @swagger
 * /cron/scripts/{scriptName}:
 *   put:
 *     summary: Update cron script content
 *     description: Update the content of an existing cron script (admin only)
 *     tags: [Cron]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: scriptName
 *         required: true
 *         schema:
 *           type: string
 *         description: Script name (with or without .sh extension)
 *         example: "backup_database"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - content
 *             properties:
 *               content:
 *                 type: string
 *                 description: New script content
 *                 example: "#!/bin/bash\necho 'Updated backup script'\n/usr/bin/backup-tool"
 *     responses:
 *       200:
 *         description: Script updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 script:
 *                   $ref: '#/components/schemas/CronScript'
 *                 message:
 *                   type: string
 *                   example: "Script 'backup_database.sh' updated successfully"
 *       400:
 *         description: Bad request
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Script not found
 *       500:
 *         description: Server error
 */

// Update cron script (admin only)
router.put('/scripts/:scriptName', checkRole(['admin']), async (req, res) => {
  try {
    const { content } = req.body;

    if (!content) {
      return res.status(400).json({
        success: false,
        error: 'Script content is required'
      });
    }

    const script = await cronService.updateCronScript(req.params.scriptName, content);
    res.json({
      success: true,
      script: script,
      message: `Script '${script.name}' updated successfully`
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

/**
 * @swagger
 * /cron/scripts/{scriptName}:
 *   delete:
 *     summary: Delete cron script
 *     description: Delete a cron script (admin only, only if not used by any cron job)
 *     tags: [Cron]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: scriptName
 *         required: true
 *         schema:
 *           type: string
 *         description: Script name (with or without .sh extension)
 *         example: "backup_database"
 *       - in: query
 *         name: deleteDependentJobs
 *         required: false
 *         schema:
 *           type: boolean
 *         description: Whether to also delete dependent cron jobs (default false)
 *         example: true
 *     responses:
 *       200:
 *         description: Script deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 script:
 *                   $ref: '#/components/schemas/CronScript'
 *                 message:
 *                   type: string
 *                   example: "Script 'backup_database.sh' deleted successfully"
 *                 deletedJobs:
 *                   type: array
 *                   description: Array of deleted dependent cron jobs
 *                   items:
 *                     $ref: '#/components/schemas/CronJob'
 *                 dependentJobsCount:
 *                   type: integer
 *                   description: Number of dependent cron jobs
 *                   example: 2
 *       400:
 *         description: Bad request - script is in use
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Script not found
 *       500:
 *         description: Server error
 */

// Delete cron script (admin only)
router.delete('/scripts/:scriptName', checkRole(['admin']), async (req, res) => {
  try {
    const deleteDependentJobs = req.query.deleteDependentJobs === 'true';
    const result = await cronService.deleteCronScript(req.params.scriptName, deleteDependentJobs);

    let message = `Script '${result.name}' deleted successfully`;
    if (deleteDependentJobs && result.deletedJobs.length > 0) {
      message += ` (${result.deletedJobs.length} dependent cron job(s) also deleted)`;
    }

    res.json({
      success: true,
      script: result,
      message: message,
      deletedJobs: result.deletedJobs,
      dependentJobsCount: result.dependentJobsCount
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: error.message
      });
    } else if (error.message.includes('Cannot delete script') ||
               error.message.includes('it is used by')) {
      res.status(400).json({
        success: false,
        error: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

/**
 * @swagger
 * /cron/system:
 *   get:
 *     summary: Get system cron jobs
 *     description: Retrieve all system cron jobs from crontab that are marked with "# MOS" comments (admin only)
 *     tags: [Cron]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: System cron jobs retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 systemCronJobs:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                         description: Name extracted from the MOS comment
 *                         example: "Update Check Interval"
 *                       schedule:
 *                         type: string
 *                         description: Cron schedule expression
 *                         example: "15 9 * * *"
 *                       command:
 *                         type: string
 *                         description: Command to execute
 *                         example: "/usr/local/bin/mos-update_check > /dev/null 2>&1"
 *                 count:
 *                   type: integer
 *                   description: Total number of system cron jobs
 *                   example: 7
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Get system cron jobs (# MOS entries from crontab)
router.get('/system', checkRole(['admin']), async (req, res) => {
  try {
    const systemCronJobs = await cronService.getSystemCronJobs();
    res.json(systemCronJobs);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /cron/{identifier}:
 *   get:
 *     summary: Get specific cron job
 *     description: Retrieve a specific cron job by ID or name (available to all authenticated users)
 *     tags: [Cron]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: identifier
 *         required: true
 *         schema:
 *           type: string
 *         description: Cron job ID or name
 *         example: "backup-database"
 *     responses:
 *       200:
 *         description: Cron job retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CronJobResponse'
 *             example:
 *               success: true
 *               cronJob:
 *                 id: "job-123"
 *                 name: "backup-database"
 *                 schedule: "0 2 * * *"
 *                 command: "/usr/local/bin/backup-db.sh"
 *                 enabled: true
 *                 status: "stopped"
 *                 created: "2024-01-20T10:30:00.000Z"
 *                 lastRun: "2024-01-21T02:00:00.000Z"
 *                 nextRun: "2024-01-22T02:00:00.000Z"
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Cron job not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               success: false
 *               error: "Cron job 'backup-database' not found"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Get specific cron job by ID or name
router.get('/:identifier', async (req, res) => {
  try {
    const cronJob = await cronService.getCronJob(req.params.identifier);
    res.json({
      success: true,
      cronJob: cronJob
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

// Create new cron job (admin only)
router.post('/', checkRole(['admin']), async (req, res) => {
  try {
    const { name, schedule, command, script, scriptPath, enabled, convert_to_unix } = req.body;

    // Basic validation - name and schedule are always required
    if (!name || !schedule) {
      return res.status(400).json({
        success: false,
        error: 'Name and Schedule are required'
      });
    }

    // Command is only required if neither script nor scriptPath is provided
    if (!command && !script && !scriptPath) {
      return res.status(400).json({
        success: false,
        error: 'Either command, script, or scriptPath must be provided'
      });
    }

    const cronJob = await cronService.createCronJob({
      name,
      schedule,
      command,
      script,
      scriptPath,
      enabled,
      convert_to_unix
    });

    res.status(201).json({
      success: true,
      cronJob: cronJob,
      message: `Cron-Job "${cronJob.name}" created successfully`
    });
  } catch (error) {
    if (error.message.includes('already exists') ||
        error.message.includes('required') ||
        error.message.includes('Cron format') ||
        error.message.includes('Script file already exists') ||
        error.message.includes('Cannot specify both') ||
        error.message.includes('Referenced script does not exist')) {
      res.status(400).json({
        success: false,
        error: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

/**
 * @swagger
 * /cron/{identifier}:
 *   put:
 *     summary: Update cron job
 *     description: Update an existing cron job by ID or name (admin only)
 *     tags: [Cron]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: identifier
 *         required: true
 *         schema:
 *           type: string
 *         description: Cron job ID or name to update
 *         example: "backup-database"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateCronJobRequest'
 *           example:
 *             name: "backup-database-v2"
 *             schedule: "0 3 * * *"
 *             command: "/usr/local/bin/backup-db-v2.sh"
 *     responses:
 *       200:
 *         description: Cron job updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CronJobResponse'
 *             example:
 *               success: true
 *               cronJob:
 *                 id: "job-123"
 *                 name: "backup-database-v2"
 *                 schedule: "0 3 * * *"
 *                 command: "/usr/local/bin/backup-db-v2.sh"
 *                 enabled: true
 *                 status: "stopped"
 *                 created: "2024-01-20T10:30:00.000Z"
 *                 lastRun: "2024-01-21T02:00:00.000Z"
 *                 nextRun: "2024-01-22T03:00:00.000Z"
 *               message: "Cron job 'backup-database-v2' updated successfully"
 *       400:
 *         description: Bad request - validation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               no_fields:
 *                 summary: No fields provided
 *                 value:
 *                   success: false
 *                   error: "At least one field (name, schedule or command) must be provided"
 *               invalid_schedule:
 *                 summary: Invalid cron format
 *                 value:
 *                   success: false
 *                   error: "Invalid cron format"
 *               duplicate_name:
 *                 summary: Name already exists
 *                 value:
 *                   success: false
 *                   error: "Cron job with this name already exists"
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
 *       404:
 *         description: Cron job not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               success: false
 *               error: "Cron job 'backup-database' not found"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Update cron job by ID or name (admin only)
router.put('/:identifier', checkRole(['admin']), async (req, res) => {
  try {
    const { name, schedule, command, enabled, script, scriptPath, convert_to_unix } = req.body;
    const updates = {};

    // Only include provided fields in updates
    if (name !== undefined) updates.name = name;
    if (schedule !== undefined) updates.schedule = schedule;
    if (command !== undefined) updates.command = command;
    if (enabled !== undefined) updates.enabled = enabled;
    if (script !== undefined) updates.script = script;
    if (scriptPath !== undefined) updates.scriptPath = scriptPath;
    if (convert_to_unix !== undefined) updates.convert_to_unix = convert_to_unix;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one field (name, schedule, command, enabled, script, scriptPath or convert_to_unix) must be provided'
      });
    }

    const cronJob = await cronService.updateCronJob(req.params.identifier, updates);

    res.json({
      success: true,
      cronJob: cronJob,
      message: `Cron-Job "${cronJob.name}" updated successfully`
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: error.message
      });
    } else if (error.message.includes('already exists') ||
               error.message.includes('required') ||
               error.message.includes('Cron format') ||
               error.message.includes('Cannot specify both') ||
               error.message.includes('Script file already exists') ||
               error.message.includes('Referenced script does not exist')) {
      res.status(400).json({
        success: false,
        error: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

/**
 * @swagger
 * /cron/{identifier}:
 *   delete:
 *     summary: Delete cron job
 *     description: Delete an existing cron job by ID or name (admin only)
 *     tags: [Cron]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: identifier
 *         required: true
 *         schema:
 *           type: string
 *         description: Cron job ID or name to delete
 *         example: "backup-database"
 *       - in: query
 *         name: delete_script
 *         required: false
 *         schema:
 *           type: boolean
 *         description: Whether to also delete the associated script file (default false)
 *         example: true
 *     responses:
 *       200:
 *         description: Cron job deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CronJobResponse'
 *             example:
 *               success: true
 *               cronJob:
 *                 id: "job-123"
 *                 name: "backup-database"
 *                 schedule: "0 2 * * *"
 *                 command: "/usr/local/bin/backup-db.sh"
 *                 enabled: true
 *                 status: "stopped"
 *                 created: "2024-01-20T10:30:00.000Z"
 *                 lastRun: "2024-01-21T02:00:00.000Z"
 *                 nextRun: "2024-01-22T02:00:00.000Z"
 *               message: "Cron job 'backup-database' deleted successfully"
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Cron job not found
 *       500:
 *         description: Server error
 */

// Delete cron job by ID or name (admin only)
router.delete('/:identifier', checkRole(['admin']), async (req, res) => {
  try {
    const deleteScript = req.query.delete_script === 'true';
    const deletedJob = await cronService.deleteCronJob(req.params.identifier, deleteScript);

    let message = `Cron-Job "${deletedJob.name}" deleted successfully`;
    if (deleteScript && deletedJob.scriptPath) {
      message += ` (script also deleted)`;
    }

    res.json({
      success: true,
      cronJob: deletedJob,
      message: message
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

/**
 * @swagger
 * /cron/{identifier}/enable:
 *   post:
 *     summary: Enable cron job
 *     description: Enable a disabled cron job (admin only)
 *     tags: [Cron]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: identifier
 *         required: true
 *         schema:
 *           type: string
 *         description: Cron job ID or name to enable
 *         example: "backup-database"
 *     responses:
 *       200:
 *         description: Cron job enabled successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CronJobResponse'
 *             example:
 *               success: true
 *               cronJob:
 *                 id: "job-123"
 *                 name: "backup-database"
 *                 schedule: "0 2 * * *"
 *                 command: "/usr/local/bin/backup-db.sh"
 *                 enabled: true
 *                 status: "stopped"
 *                 created: "2024-01-20T10:30:00.000Z"
 *                 lastRun: "2024-01-21T02:00:00.000Z"
 *                 nextRun: "2024-01-22T02:00:00.000Z"
 *               message: "Cron job 'backup-database' enabled successfully"
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
 *       404:
 *         description: Cron job not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               success: false
 *               error: "Cron job 'backup-database' not found"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Enable cron job (admin only)
router.post('/:identifier/enable', checkRole(['admin']), async (req, res) => {
  try {
    const cronJob = await cronService.enableCronJob(req.params.identifier);
    res.json({
      success: true,
      cronJob: cronJob,
      message: `Cron-Job "${cronJob.name}" enabled successfully`
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

/**
 * @swagger
 * /cron/{identifier}/disable:
 *   post:
 *     summary: Disable cron job
 *     description: Disable an enabled cron job (admin only)
 *     tags: [Cron]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: identifier
 *         required: true
 *         schema:
 *           type: string
 *         description: Cron job ID or name to disable
 *         example: "backup-database"
 *     responses:
 *       200:
 *         description: Cron job disabled successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CronJobResponse'
 *             example:
 *               success: true
 *               cronJob:
 *                 id: "job-123"
 *                 name: "backup-database"
 *                 schedule: "0 2 * * *"
 *                 command: "/usr/local/bin/backup-db.sh"
 *                 enabled: false
 *                 status: "stopped"
 *                 created: "2024-01-20T10:30:00.000Z"
 *                 lastRun: "2024-01-21T02:00:00.000Z"
 *                 nextRun: "2024-01-22T02:00:00.000Z"
 *               message: "Cron job 'backup-database' disabled successfully"
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
 *       404:
 *         description: Cron job not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               success: false
 *               error: "Cron job 'backup-database' not found"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

// Disable cron job (admin only)
router.post('/:identifier/disable', checkRole(['admin']), async (req, res) => {
  try {
    const cronJob = await cronService.disableCronJob(req.params.identifier);
    res.json({
      success: true,
      cronJob: cronJob,
      message: `Cron-Job "${cronJob.name}" disabled successfully`
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

/**
 * @swagger
 * /cron/{identifier}/start:
 *   post:
 *     summary: Start cron job manually
 *     description: Start a cron job manually in the background (admin only, checks if already running)
 *     tags: [Cron]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: identifier
 *         required: true
 *         schema:
 *           type: string
 *         description: Cron job ID or name to start
 *         example: "backup-database"
 *     responses:
 *       200:
 *         description: Cron job started successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 cronJob:
 *                   $ref: '#/components/schemas/CronJob'
 *                 message:
 *                   type: string
 *                   example: "Cron-Job 'backup-database' started successfully"
 *             example:
 *               success: true
 *               cronJob:
 *                 id: "job-123"
 *                 name: "backup-database"
 *                 schedule: "0 2 * * *"
 *                 command: "/usr/local/bin/backup-db.sh"
 *                 enabled: true
 *                 status: "running"
 *               message: "Cron-Job 'backup-database' started successfully"
 *       400:
 *         description: Job is already running
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               success: false
 *               error: "Cron-Job 'backup-database' is already running"
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Cron job not found
 *       500:
 *         description: Server error
 */

// Start cron job manually (admin only)
router.post('/:identifier/start', checkRole(['admin']), async (req, res) => {
  try {
    const result = await cronService.startCronJob(req.params.identifier);
    res.json({
      success: true,
      cronJob: result,
      message: result.message
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: error.message
      });
    } else if (error.message.includes('already running')) {
      res.status(400).json({
        success: false,
        error: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

/**
 * @swagger
 * /cron/{identifier}/stop:
 *   post:
 *     summary: Stop running cron job
 *     description: Stop a currently running cron job (admin only)
 *     tags: [Cron]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: identifier
 *         required: true
 *         schema:
 *           type: string
 *         description: Cron job ID or name to stop
 *         example: "backup-database"
 *     responses:
 *       200:
 *         description: Cron job stopped successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 cronJob:
 *                   $ref: '#/components/schemas/CronJob'
 *                 message:
 *                   type: string
 *                   example: "Cron-Job 'backup-database' stopped successfully"
 *             example:
 *               success: true
 *               cronJob:
 *                 id: "job-123"
 *                 name: "backup-database"
 *                 schedule: "0 2 * * *"
 *                 command: "/usr/local/bin/backup-db.sh"
 *                 enabled: true
 *                 status: "stopped"
 *               message: "Cron-Job 'backup-database' stopped successfully"
 *       400:
 *         description: Job is not running
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               success: false
 *               error: "Cron-Job 'backup-database' is not currently running"
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       404:
 *         description: Cron job not found
 *       500:
 *         description: Server error
 */

// Stop cron job (admin only)
router.post('/:identifier/stop', checkRole(['admin']), async (req, res) => {
  try {
    const result = await cronService.stopCronJob(req.params.identifier);
    res.json({
      success: true,
      cronJob: result,
      message: result.message
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: error.message
      });
    } else if (error.message.includes('not currently running')) {
      res.status(400).json({
        success: false,
        error: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

module.exports = router;