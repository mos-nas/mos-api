const jwt = require('jsonwebtoken');
const fs = require('fs').promises;
const path = require('path');

const BOOT_TOKEN_PATH = '/boot/config/api/token';

const getBootToken = async () => {
  try {
    const token = await fs.readFile(BOOT_TOKEN_PATH, 'utf8');
    const trimmedToken = token.trim();
    return trimmedToken.length > 0 ? trimmedToken : null;
  } catch (error) {
    return null;
  }
};

// Paths that are always reachable regardless of token permissions
// (e.g. a restricted token must always be able to introspect its own rights)
const ALWAYS_ALLOWED_PATHS = [
  '/api/v1/auth/admin-tokens/me'
];

// Resources that readonly tokens should never access.
const SENSITIVE_RESOURCES = ['auth', 'users'];

// Derive the resource name from the request URL (first segment after /api/v1/)
const deriveResource = (req) => {
  const pathOnly = (req.originalUrl || '').split('?')[0];
  const match = pathOnly.match(/^\/api\/v1\/([^/]+)/);
  return match ? match[1] : '';
};

// Derive the action from the HTTP method (GET/HEAD = read, everything else = write)
const deriveAction = (method) => {
  return method === 'GET' || method === 'HEAD' ? 'read' : 'write';
};

// Evaluate whether a token's permissions allow a given resource + action.
// permissions === null/undefined => full access (backwards compatible, admin token)
const isActionAllowed = (permissions, resource, action) => {
  if (!permissions || permissions.mode === 'full') {
    return true;
  }

  if (permissions.mode === 'readonly') {
    return action === 'read';
  }

  if (permissions.mode === 'custom') {
    const level = (permissions.resources && permissions.resources[resource]) || 'none';
    if (level === 'write') {
      return true;
    }
    if (level === 'read') {
      return action === 'read';
    }
    return false;
  }

  // Unknown mode => deny to be safe
  return false;
};

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access denied. Token required.' });
  }

  try {
    // Check if it's the boot token
    const bootToken = await getBootToken();
    if (bootToken && token === bootToken) {
      req.user = { role: 'admin', isBootToken: true };
      return next();
    }

    // Check if it's an admin API token
    const userService = require('../services/user.service');
    const adminTokenData = await userService.validateAdminToken(token);
    if (adminTokenData) {
      req.user = adminTokenData;

      // Enforce token permissions (null/full = unrestricted, backwards compatible)
      const pathOnly = (req.originalUrl || '').split('?')[0].replace(/\/+$/, '');
      if (!ALWAYS_ALLOWED_PATHS.includes(pathOnly)) {
        const resource = deriveResource(req);
        const action = deriveAction(req.method);
        const isReadonly = adminTokenData.permissions && adminTokenData.permissions.mode === 'readonly';

        // Readonly tokens can never access sensitive resources (token/user info).
        // Custom tokens are handled by isActionAllowed (must be granted explicitly).
        if (isReadonly && SENSITIVE_RESOURCES.includes(resource)) {
          return res.status(403).json({
            error: `Access denied. Readonly tokens cannot access the '${resource}' resource.`
          });
        }

        if (!isActionAllowed(adminTokenData.permissions, resource, action)) {
          return res.status(403).json({
            error: `Access denied. This token does not have '${action}' permission for '${resource}'.`
          });
        }
      }

      return next();
    }

    // Regular JWT verification
    const decodedUser = jwt.verify(token, process.env.JWT_SECRET);

    // Reject MFA-only tokens - these are only valid on /auth/mfa
    if (decodedUser.purpose === 'mfa_verify') {
      return res.status(401).json({ error: 'MFA verification required. This token cannot be used for API access.' });
    }

    // Check if user still exists
    const users = await userService.loadUsers();
    const currentUser = users.find(u => u.id === decodedUser.id);

    if (!currentUser) {
      return res.status(403).json({ error: 'User no longer exists.' });
    }

    // samba_only users are not allowed to access the API
    if (currentUser.role === 'samba_only') {
      return res.status(403).json({
        error: 'Access denied. This account is for file sharing only.'
      });
    }

    // Check if role has changed
    if (currentUser.role !== decodedUser.role) {
      return res.status(403).json({
        error: 'Token invalid due to role change. Please login again.'
      });
    }

    // Use current user data instead of token data
    req.user = {
      id: currentUser.id,
      username: currentUser.username,
      role: currentUser.role,
      byte_format: currentUser.byte_format
    };

    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired token.' });
  }
};

const checkRole = (roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    // Boot token and admin tokens always have full access
    if (req.user.isBootToken || req.user.isAdminToken) {
      return next();
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions for this action.' });
    }

    next();
  };
};

module.exports = {
  authenticateToken,
  checkRole,
  getBootToken,
  deriveResource,
  deriveAction,
  isActionAllowed,
  SENSITIVE_RESOURCES
}; 
