const express = require('express');
const router = express.Router();
const userService = require('../services/user.service');
const { authenticateToken, checkRole, getBootToken } = require('../middleware/auth.middleware');
const { loginRateLimiter, resetLoginAttempts } = require('../middleware/login-rate-limit.middleware');

/**
 * @swagger
 * tags:
 *   name: Authentication
 *   description: User authentication, JWT settings and admin token management
 *
 * components:
 *   schemas:
 *     Error:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           description: Error message
 *     LoginRequest:
 *       type: object
 *       required:
 *         - username
 *         - password
 *       properties:
 *         username:
 *           type: string
 *           description: Username
 *           example: "admin"
 *         password:
 *           type: string
 *           description: Password
 *           example: "password123"
 *     LoginResponse:
 *       type: object
 *       properties:
 *         token:
 *           type: string
 *           description: JWT Access Token
 *           example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
 *         user:
 *           $ref: '#/components/schemas/User'
 *     User:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: User ID
 *           example: "123"
 *         username:
 *           type: string
 *           description: Username
 *           example: "admin"
 *         role:
 *           type: string
 *           enum: [admin, user, samba_only]
 *           description: User role
 *           example: "admin"
 *         samba_user:
 *           type: boolean
 *           description: Whether user has SMB/CIFS access
 *           example: false
 *     CreateUserRequest:
 *       type: object
 *       required:
 *         - username
 *         - password
 *         - role
 *       properties:
 *         username:
 *           type: string
 *           description: Username
 *           example: "newuser"
 *         password:
 *           type: string
 *           description: Password
 *           example: "securepassword"
 *         role:
 *           type: string
 *           enum: [admin, user, samba_only]
 *           description: User role
 *           example: "user"
 *         samba_user:
 *           type: boolean
 *           description: Create SMB/CIFS user for file sharing (automatically true for samba_only role)
 *           default: false
 *           example: false
 *     UpdateUserRequest:
 *       type: object
 *       properties:
 *         username:
 *           type: string
 *           description: Username
 *         password:
 *           type: string
 *           description: New password
 *         role:
 *           type: string
 *           enum: [admin, user, samba_only]
 *           description: User role
 *         samba_user:
 *           type: boolean
 *           description: Enable/disable SMB/CIFS user for file sharing
 *     JwtSettings:
 *       type: object
 *       properties:
 *         expiryDays:
 *           type: integer
 *           description: JWT token expiry in days
 *           example: 7
 *     UpdateJwtExpiryRequest:
 *       type: object
 *       required:
 *         - expiryDays
 *       properties:
 *         expiryDays:
 *           type: integer
 *           minimum: 1
 *           maximum: 365
 *           description: Number of days for JWT expiry
 *           example: 7
 *     AdminToken:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Token ID
 *           example: "1640995200000"
 *         name:
 *           type: string
 *           description: Token name
 *           example: "CI/CD Pipeline"
 *         description:
 *           type: string
 *           description: Token description
 *           example: "Token for automated deployments"
 *         token:
 *           type: string
 *           description: The API token value
 *           example: "a1b2c3d4e5f6..."
 *         createdAt:
 *           type: string
 *           format: date-time
 *           description: Creation timestamp
 *         lastUsed:
 *           type: string
 *           format: date-time
 *           description: Last usage timestamp
 *         isActive:
 *           type: boolean
 *           description: Token active status
 *         permissions:
 *           $ref: '#/components/schemas/TokenPermissions'
 *     TokenPermissions:
 *       type: object
 *       nullable: true
 *       description: >
 *         Token permission scope. null or mode 'full' = unrestricted (admin).
 *         'readonly' = only read (GET/HEAD) requests are allowed, except for sensitive
 *         resources (auth, users) which are always blocked for readonly tokens.
 *         'custom' = per-resource levels (none/read/write); unlisted resources default
 *         to 'none'. Sensitive resources can be granted explicitly in custom mode.
 *       properties:
 *         mode:
 *           type: string
 *           enum: [full, readonly, custom]
 *           example: readonly
 *         resources:
 *           type: object
 *           description: >
 *             Only used when mode is 'custom'. Maps a resource name (the first path
 *             segment after /api/v1/) to an access level. Resources not listed default
 *             to 'none'. Sub-paths inherit the parent resource, e.g. /docker/mos/compose
 *             counts as 'docker', /mos/diag as 'mos', /disks/smart as 'disks'.
 *           propertyNames:
 *             enum:
 *               - system
 *               - disks
 *               - pools
 *               - docker
 *               - lxc
 *               - vm
 *               - mos
 *               - llm
 *               - shares
 *               - remotes
 *               - iscsi
 *               - users
 *               - cron
 *               - terminal
 *               - notifications
 *               - auth
 *           additionalProperties:
 *             type: string
 *             enum: [none, read, write]
 *           example:
 *             docker: write
 *             vm: read
 *     CreateAdminTokenRequest:
 *       type: object
 *       required:
 *         - name
 *       properties:
 *         name:
 *           type: string
 *           description: Descriptive name for the token
 *           example: "API Integration"
 *         description:
 *           type: string
 *           description: Optional description
 *           example: "Token for third-party API integration"
 *         permissions:
 *           $ref: '#/components/schemas/TokenPermissions'
 */

/**
 * @swagger
 * /auth/firstsetup:
 *   get:
 *     summary: Get first setup token
 *     description: Returns the boot token if it exists in the token file, otherwise returns null. Used for initial system setup. This endpoint requires no authentication.
 *     tags: [Authentication]
 *     security: []
 *     responses:
 *       200:
 *         description: First setup token status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 firstsetup:
 *                   type: string
 *                   nullable: true
 *                   description: Boot token if exists, null otherwise
 *                   example: "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456"
 *             examples:
 *               with_token:
 *                 summary: Token exists
 *                 value:
 *                   firstsetup: "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456"
 *               no_token:
 *                 summary: No token
 *                 value:
 *                   firstsetup: null
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/firstsetup', async (req, res) => {
  try {
    const bootToken = await getBootToken();
    res.json({
      firstsetup: bootToken
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: User login
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LoginRequest'
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LoginResponse'
 *             example:
 *               token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
 *               user:
 *                 id: "1"
 *                 username: "admin"
 *                 role: "admin"
 *       401:
 *         description: Invalid credentials
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               error: "Invalid username or password"
 *       429:
 *         description: Too many login attempts
 *         headers:
 *           Retry-After:
 *             description: Seconds until the block expires
 *             schema:
 *               type: integer
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Too many login attempts. Please try again later."
 *                 retryAfter:
 *                   type: integer
 *                   description: Seconds until the block expires
 *                   example: 7200
 *       400:
 *         description: Bad request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/login', loginRateLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await userService.authenticate(username, password);
    resetLoginAttempts(req);
    res.json(result);
  } catch (error) {
    const remaining = res.locals.remainingLoginAttempts;
    const triesText = remaining === 1 ? '1 attempt remaining' : `${remaining} attempts remaining`;
    res.status(401).json({
      error: `${error.message} (${triesText})`,
      mfa_required: false
    });
  }
});

/**
 * @swagger
 * /auth/mfa:
 *   post:
 *     summary: Verify MFA code during login
 *     description: Verify TOTP code or recovery code to complete MFA login. Accepts the temporary mfa_token from login response. If recovery code is used, MFA is automatically disabled.
 *     tags: [Authentication]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - mfa_token
 *               - code
 *             properties:
 *               mfa_token:
 *                 type: string
 *                 description: Temporary MFA JWT token from login response
 *               code:
 *                 type: string
 *                 description: 6-digit TOTP code or recovery code (XXXX-XXXX-XXXX)
 *     responses:
 *       200:
 *         description: MFA verification successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *                 mfa_disabled:
 *                   type: boolean
 *                   description: True if recovery code was used and MFA was disabled
 *       401:
 *         description: Invalid MFA code or expired token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/mfa', loginRateLimiter, async (req, res) => {
  try {
    const { mfa_token, code } = req.body;

    if (!mfa_token || !code) {
      return res.status(400).json({ error: 'mfa_token and code are required' });
    }

    const result = await userService.verifyMfa(mfa_token, code);
    resetLoginAttempts(req);
    res.json(result);
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

/**
 * @swagger
 * /auth/mfa/setup:
 *   post:
 *     summary: Setup or confirm MFA
 *     description: |
 *       Two-step MFA setup:
 *       - Without `code`: Generates TOTP secret, returns QR code and secret for manual entry
 *       - With `code`: Verifies TOTP code and activates MFA, returns recovery code
 *       Password is always required for security.
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - password
 *             properties:
 *               password:
 *                 type: string
 *                 description: Current password for confirmation
 *               code:
 *                 type: string
 *                 description: 6-digit TOTP code from authenticator app (for confirmation step)
 *     responses:
 *       200:
 *         description: MFA setup or confirmation successful
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - type: object
 *                   description: Setup response (without code)
 *                   properties:
 *                     secret:
 *                       type: string
 *                     otpauth_url:
 *                       type: string
 *                     qr_code:
 *                       type: string
 *                       description: Base64-encoded PNG QR code
 *                 - type: object
 *                   description: Confirmation response (with code)
 *                   properties:
 *                     mfa_enabled:
 *                       type: boolean
 *                     recovery_code:
 *                       type: string
 *                       description: Single-use recovery code (XXXX-XXXX-XXXX)
 *       400:
 *         description: Bad request or MFA already enabled
 *       401:
 *         description: Not authenticated or invalid password
 */
router.post('/mfa/setup', authenticateToken, async (req, res) => {
  try {
    const { password, code } = req.body;

    if (code) {
      // Step 2: Confirm MFA with TOTP code (password not needed, was verified in step 1)
      const result = await userService.confirmMfa(req.user.id, code);
      res.json(result);
    } else {
      // Step 1: Generate secret and QR code (password required)
      if (!password) {
        return res.status(400).json({ error: 'Password is required' });
      }
      const result = await userService.setupMfa(req.user.id, password);
      res.json(result);
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /auth/mfa:
 *   delete:
 *     summary: Disable MFA
 *     description: Disable MFA for the authenticated user. Requires password confirmation. Removes all MFA data.
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - password
 *             properties:
 *               password:
 *                 type: string
 *                 description: Current password for confirmation
 *     responses:
 *       200:
 *         description: MFA disabled successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: Bad request or MFA not enabled
 *       401:
 *         description: Not authenticated or invalid password
 */
router.delete('/mfa', authenticateToken, async (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    const result = await userService.disableMfa(req.user.id, password);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /auth/users:
 *   post:
 *     summary: Create new user (admin only)
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateUserRequest'
 *     responses:
 *       201:
 *         description: User created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       400:
 *         description: Bad request
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
 */
router.post('/users', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const { username, password, role, language, primary_color, darkmode, samba_user } = req.body;
    const user = await userService.createUser(username, password, role, language, primary_color, darkmode, samba_user, req.user);
    res.status(201).json(user);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /auth/users:
 *   get:
 *     summary: Get users (admin sees all, user sees only themselves)
 *     description: Retrieve users - admins can see all users with optional filtering, normal users only see their own profile (both return arrays)
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: samba_user
 *         schema:
 *           type: boolean
 *         description: Filter users by samba_user status (admin only). Set to true to get only Samba users, false to get only non-Samba users.
 *         example: true
 *     responses:
 *       200:
 *         description: Users retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/User'
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
router.get('/users', authenticateToken, async (req, res) => {
  try {
    if (req.user.role === 'admin' || req.user.isBootToken || req.user.isAdminToken) {
      // Admin can see all users with optional filtering
      const filters = {};

      // Parse samba_user filter from query parameters
      if (req.query.samba_user !== undefined) {
        if (req.query.samba_user === 'true') {
          filters.samba_user = true;
        } else if (req.query.samba_user === 'false') {
          filters.samba_user = false;
        }
      }

      const users = await userService.getUsers(filters);
      res.json(users);
    } else {
      // Regular user can only see their own profile (no filtering allowed)
      const users = await userService.loadUsers();
      const user = users.find(u => u.id === req.user.id);

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json([userService._sanitizeUser(user)]);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /auth/users/{id}:
 *   put:
 *     summary: Update user (admin can update any user, users can update themselves)
 *     description: Update user information - admins can update any user, normal users can only update their own profile with limited fields
 *     tags: [Authentication]
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
 *             $ref: '#/components/schemas/UpdateUserRequest'
 *     responses:
 *       200:
 *         description: User updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       400:
 *         description: Bad request
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
 */
router.put('/users/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Check if user is trying to update their own profile
    if (req.user.id === id) {
      // User updating their own profile
      const user = await userService.updateUser(id, updates, req.user);
      res.json(user);
    } else {
      // Only admins can update other users
      if (req.user.role !== 'admin' && !req.user.isBootToken && !req.user.isAdminToken) {
        return res.status(403).json({
          error: 'You can only update your own profile'
        });
      }

      const user = await userService.updateUser(id, updates, req.user);
      res.json(user);
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /auth/profile:
 *   get:
 *     summary: Get own user profile
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User profile retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *             example:
 *               id: "1"
 *               username: "admin"
 *               role: "admin"
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
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const user = await userService._ensureUserDefaults(req.user.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(userService._sanitizeUser(user));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /auth/users/{id}:
 *   delete:
 *     summary: Delete user (admin only)
 *     tags: [Authentication]
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
 *       204:
 *         description: User deleted successfully
 *       400:
 *         description: Bad request (e.g., cannot delete yourself)
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
 */
router.delete('/users/:id', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    await userService.deleteUser(id);
    res.status(204).send();
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: User logout
 *     description: Invalidate the current session. Note that JWT tokens cannot be truly invalidated server-side, but this endpoint provides a consistent logout mechanism.
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Logout successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Logout successful"
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    // JWTs are stateless, so we cannot invalidate them server-side
    // The client should delete the token
    res.json({
      message: 'Logout successful. Please delete the token on client side.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// JWT Settings Management

/**
 * @swagger
 * /auth/jwt-settings:
 *   get:
 *     summary: Get JWT settings
 *     description: Retrieve current JWT token expiry settings (admin only)
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: JWT settings retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/JwtSettings'
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */
router.get('/jwt-settings', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const settings = await userService.getJwtSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /auth/jwt-settings:
 *   put:
 *     summary: Update JWT expiry time
 *     description: Update JWT token expiry time in days (admin only)
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateJwtExpiryRequest'
 *     responses:
 *       200:
 *         description: JWT expiry updated successfully
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
 *                   example: "JWT expiry updated to 7 day(s)"
 *                 data:
 *                   type: object
 *                   properties:
 *                     expiryDays:
 *                       type: integer
 *                       example: 7
 *                     updated_at:
 *                       type: string
 *                       format: date-time
 *       400:
 *         description: Bad request - validation failed
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */
router.put('/jwt-settings', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const { expiryDays } = req.body;

    if (!expiryDays || !Number.isInteger(expiryDays)) {
      return res.status(400).json({
        success: false,
        error: 'expiryDays must be provided as an integer'
      });
    }

    const result = await userService.updateJwtExpiryDays(expiryDays);
    res.json(result);
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// Admin Token Management

/**
 * @swagger
 * /auth/admin-tokens:
 *   get:
 *     summary: Get all admin tokens
 *     description: Retrieve list of all admin API tokens (admin only)
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Admin tokens retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/AdminToken'
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */
router.get('/admin-tokens', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const tokens = await userService.getAdminTokens();
    res.json(tokens);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /auth/admin-tokens:
 *   post:
 *     summary: Create admin token
 *     description: Create a new permanent admin API token (admin only)
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateAdminTokenRequest'
 *           examples:
 *             fullAccess:
 *               summary: Full access (admin) - omit permissions or use mode 'full'
 *               value:
 *                 name: "CI/CD Pipeline"
 *                 description: "Full access token for deployments"
 *             readonly:
 *               summary: Read-only - all GET endpoints except auth/users
 *               value:
 *                 name: "Monitoring"
 *                 description: "Dashboard read-only access"
 *                 permissions:
 *                   mode: "readonly"
 *             customDocker:
 *               summary: Custom - write on docker, read on vm/system
 *               value:
 *                 name: "Docker Bot"
 *                 description: "Manages containers, can view VMs and system"
 *                 permissions:
 *                   mode: "custom"
 *                   resources:
 *                     docker: "write"
 *                     vm: "read"
 *                     system: "read"
 *     responses:
 *       201:
 *         description: Admin token created successfully
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
 *                   example: "Admin token created successfully"
 *                 data:
 *                   $ref: '#/components/schemas/AdminToken'
 *       400:
 *         description: Bad request - validation failed
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */
router.post('/admin-tokens', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const { name, description, permissions } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Token name is required and must be a non-empty string'
      });
    }

    // permissions is optional (null/omitted = full access / admin)
    const result = await userService.createAdminToken(name.trim(), description || '', permissions || null);
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /auth/admin-tokens/me:
 *   get:
 *     summary: Get current token permissions
 *     description: Introspect the permissions of the token used for this request. Only reachable when authenticated with an API token (boot token or admin token).
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current token permissions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                   nullable: true
 *                 name:
 *                   type: string
 *                   nullable: true
 *                 role:
 *                   type: string
 *                   example: admin
 *                 isBootToken:
 *                   type: boolean
 *                 permissions:
 *                   $ref: '#/components/schemas/TokenPermissions'
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Only available for API tokens
 */
router.get('/admin-tokens/me', authenticateToken, async (req, res) => {
  // This endpoint is only meaningful for API tokens, not for JWT users
  if (!req.user.isAdminToken && !req.user.isBootToken) {
    return res.status(403).json({
      error: 'This endpoint is only available for API tokens.'
    });
  }

  // Boot tokens always have full (unrestricted) access
  const permissions = req.user.isBootToken ? { mode: 'full' } : (req.user.permissions || { mode: 'full' });

  res.json({
    id: req.user.id || null,
    name: req.user.name || (req.user.isBootToken ? 'boot-token' : null),
    role: 'admin',
    isBootToken: !!req.user.isBootToken,
    permissions
  });
});

/**
 * @swagger
 * /auth/admin-tokens/{id}/permissions:
 *   put:
 *     summary: Update admin token permissions
 *     description: Update the permission scope of an existing admin API token (admin only)
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Token ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               permissions:
 *                 $ref: '#/components/schemas/TokenPermissions'
 *           examples:
 *             promoteToFull:
 *               summary: Grant full access
 *               value:
 *                 permissions:
 *                   mode: "full"
 *             makeReadonly:
 *               summary: Restrict to read-only
 *               value:
 *                 permissions:
 *                   mode: "readonly"
 *             customScopes:
 *               summary: Custom per-resource scopes
 *               value:
 *                 permissions:
 *                   mode: "custom"
 *                   resources:
 *                     docker: "write"
 *                     vm: "read"
 *     responses:
 *       200:
 *         description: Admin token permissions updated successfully
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
 *                   example: "Admin token permissions updated successfully"
 *                 data:
 *                   $ref: '#/components/schemas/AdminToken'
 *       400:
 *         description: Bad request - validation failed or token not found
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */
router.put('/admin-tokens/:id/permissions', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Token ID is required'
      });
    }

    // permissions may be null (full access) or a permissions object
    const permissions = Object.prototype.hasOwnProperty.call(req.body, 'permissions')
      ? req.body.permissions
      : null;

    const result = await userService.updateAdminTokenPermissions(id, permissions);
    res.json(result);
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /auth/admin-tokens/{id}:
 *   delete:
 *     summary: Delete admin token
 *     description: Permanently delete an admin API token (admin only)
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Token ID
 *     responses:
 *       200:
 *         description: Admin token deleted successfully
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
 *                   example: "Admin token deleted successfully"
 *       400:
 *         description: Bad request - token not found
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */
router.delete('/admin-tokens/:id', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Token ID is required'
      });
    }

    const result = await userService.deleteAdminToken(id);
    res.json(result);
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /auth/admin-tokens/{id}/deactivate:
 *   put:
 *     summary: Deactivate admin token
 *     description: Deactivate an admin API token without deleting it (admin only)
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Token ID
 *     responses:
 *       200:
 *         description: Admin token deactivated successfully
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
 *                   example: "Admin token deactivated successfully"
 *       400:
 *         description: Bad request - token not found
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin permission required
 *       500:
 *         description: Server error
 */
router.put('/admin-tokens/:id/deactivate', authenticateToken, checkRole(['admin']), async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Token ID is required'
      });
    }

    const result = await userService.deactivateAdminToken(id);
    res.json(result);
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router; 
