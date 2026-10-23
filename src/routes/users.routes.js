const express = require('express');
const router = express.Router();
const { checkRole, authenticateToken } = require('../middleware/auth.middleware');
const userService = require('../services/user.service');

/**
 * @swagger
 * tags:
 *   name: Users
 *   description: User Management (SMB Users and System Users)
 *
 * components:
 *   schemas:
 *     User:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Unique user ID
 *           example: "1"
 *         username:
 *           type: string
 *           description: Username
 *           example: "testuser"
 *         role:
 *           type: string
 *           enum: [admin, user, samba_only]
 *           description: User role
 *           example: "user"
 *         language:
 *           type: string
 *           description: User language preference
 *           example: "en"
 *         primary_color:
 *           type: string
 *           description: Primary color theme
 *           example: "#607d8b"
 *         darkmode:
 *           type: boolean
 *           description: Dark mode preference
 *           example: false
 *         theme:
 *           type: string
 *           nullable: true
 *           description: Theme preference
 *           default: null
 *           example: "vertical"
 *         byte_format:
 *           type: string
 *           enum: [binary, decimal]
 *           description: Byte format preference for displaying file sizes
 *           default: "binary"
 *           example: "binary"
 *         samba_user:
 *           type: boolean
 *           description: Whether user has SMB/CIFS access
 *           example: false
 *         created_at:
 *           type: string
 *           format: date-time
 *           description: User creation timestamp
 *           example: "2024-01-15T10:30:00Z"
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
 *     ChangePasswordRequest:
 *       type: object
 *       required:
 *         - password
 *       properties:
 *         password:
 *           type: string
 *           description: New password (minimum 4 characters)
 *           minLength: 4
 *           example: "newpassword"
 *     OperationResult:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           description: Operation successful
 *           example: true
 *         message:
 *           type: string
 *           description: Operation message
 *           example: "Operation completed successfully"
 */







/**
 * @swagger
 * /users/root:
 *   put:
 *     summary: Change root password
 *     description: Change the password for the system root user (admin only)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ChangePasswordRequest'
 *           example:
 *             password: "newrootpassword123"
 *     responses:
 *       200:
 *         description: Root password changed successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OperationResult'
 *             example:
 *               success: true
 *               message: "Root password changed successfully"
 *       400:
 *         description: Bad request - validation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               missing_password:
 *                 summary: Password missing
 *                 value:
 *                   success: false
 *                   error: "Password is required"
 *               weak_password:
 *                 summary: Password too short
 *                 value:
 *                   success: false
 *                   error: "Password must be at least 4 characters long"
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

// Change root password (admin only)
router.put('/root', checkRole(['admin']), async (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({
        success: false,
        error: 'Password is required'
      });
    }

    // Validierung der Passwort-Stärke
    if (password.length < 4) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 4 characters long'
      });
    }

    const result = await userService.changeRootPassword(password);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /users:
 *   get:
 *     summary: Get users (admin sees all, user sees only themselves)
 *     description: Retrieve users - admins can see all users, normal users only see their own profile (both return arrays)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User data retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/User'
 *               description: Array of users (all users for admin, single user array for normal users)
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
 */

// Get users - admins see all, normal users see only themselves
router.get('/', authenticateToken, async (req, res) => {
  try {
    if (req.user.role === 'admin' || req.user.isBootToken || req.user.isAdminToken) {
      // Admin can see all users
      const users = await userService.getUsers();
      res.json(users);
    } else {
      // Normal user can only see their own profile (as array for consistency)
      const users = await userService.loadUsers();
      const user = users.find(u => u.id === req.user.id);

      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      res.json([userService._sanitizeUser(user)]);
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /users/me:
 *   get:
 *     summary: Get own user profile
 *     description: Retrieve the authenticated user's own profile information
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Own user profile retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *             example:
 *               id: "1"
 *               username: "testuser"
 *               role: "user"
 *               language: "en"
 *               primary_color: "#607d8b"
 *               darkmode: false
 *               hide_inactive_menus: true
 *               group_menus: false
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: User not found
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

// Get own profile
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await userService._ensureUserDefaults(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    res.json(userService._sanitizeUser(user));
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /users/me:
 *   put:
 *     summary: Update own user profile
 *     description: Update the authenticated user's own profile (limited fields for normal users)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               language:
 *                 type: string
 *                 description: User language preference
 *                 example: "de"
 *               primary_color:
 *                 type: string
 *                 description: Primary color theme
 *                 example: "#2196f3"
 *               darkmode:
 *                 type: boolean
 *                 description: Dark mode preference
 *                 example: true
 *               theme:
 *                 type: string
 *                 nullable: true
 *                 description: Theme preference
 *                 default: null
 *                 example: "vertical"
 *               byte_format:
 *                 type: string
 *                 enum: [binary, decimal]
 *                 description: Byte format preference for displaying file sizes
 *                 default: "binary"
 *                 example: "binary"
 *               hide_inactive_menus:
 *                 type: boolean
 *                 description: Hide inactive menus
 *                 default: true
 *                 example: true
 *               group_menus:
 *                 type: boolean
 *                 description: Group menus
 *                 default: false
 *                 example: false
 *               password:
 *                 type: string
 *                 description: New password (minimum 4 characters)
 *                 minLength: 4
 *                 example: "newpassword123"
 *     responses:
 *       200:
 *         description: Profile updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       400:
 *         description: Bad request - validation failed
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
 *       404:
 *         description: User not found
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

// Update own profile
router.put('/me', authenticateToken, async (req, res) => {
  try {
    const updates = req.body;
    const user = await userService.updateUser(req.user.id, updates, req.user);
    res.json(user);
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /users/{id}:
 *   get:
 *     summary: Get specific user (admin only)
 *     description: Retrieve information about a specific user by ID (admin only)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID
 *         example: "123"
 *     responses:
 *       200:
 *         description: User information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
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
 *         description: User not found
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

// Get specific user (admin only)
router.get('/:id', checkRole(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const users = await userService.loadUsers();
    const user = users.find(u => u.id === id);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    res.json(userService._sanitizeUser(user));
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /users/{id}:
 *   put:
 *     summary: Update user (admin only for other users)
 *     description: Update user information - admins can update any user, normal users redirected to /users/me
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID
 *         example: "123"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *                 description: Username (admin only)
 *               role:
 *                 type: string
 *                 enum: [admin, user]
 *                 description: User role (admin only)
 *               language:
 *                 type: string
 *                 description: User language preference
 *               primary_color:
 *                 type: string
 *                 description: Primary color theme
 *               darkmode:
 *                 type: boolean
 *                 description: Dark mode preference
 *               theme:
 *                 type: string
 *                 nullable: true
 *                 description: Theme preference
 *                 default: null
 *               byte_format:
 *                 type: string
 *                 enum: [binary, decimal]
 *                 description: Byte format preference for displaying file sizes
 *                 default: "binary"
 *               password:
 *                 type: string
 *                 description: New password (minimum 4 characters)
 *                 minLength: 4
 *     responses:
 *       200:
 *         description: User updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       400:
 *         description: Bad request - validation failed
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
 *         description: No permission to update this user
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: User not found
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

// Update user (admin only for other users)
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Check if user is trying to update their own profile
    if (req.user.id === id) {
      // Redirect to own profile logic
      const user = await userService.updateUser(id, updates, req.user);
      res.json(user);
    } else {
      // Only admins can update other users
      if (req.user.role !== 'admin' && !req.user.isBootToken && !req.user.isAdminToken) {
        return res.status(403).json({
          success: false,
          error: 'You can only update your own profile. Use /users/me endpoint.'
        });
      }

      const user = await userService.updateUser(id, updates, req.user);
      res.json(user);
    }
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /users/{id}:
 *   delete:
 *     summary: Delete user (admin only)
 *     description: Delete a specific user from the system (admin only)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID to delete
 *         example: "123"
 *     responses:
 *       200:
 *         description: User deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "User deleted successfully"
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
 *         description: User not found
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

// Delete user (admin only)
router.delete('/:id', checkRole(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    await userService.deleteUser(id);
    res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    const statusCode = error.message.includes('not found') ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router; 