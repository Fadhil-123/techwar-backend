const jwt = require('jsonwebtoken');

/**
 * Middleware: Verify admin JWT using separate secret.
 * Admin tokens are issued via POST /api/admin/login
 */
function adminAuthMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'ADMIN_UNAUTHORIZED',
      message: 'Admin authentication required',
      retryable: false,
    });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    if (!decoded.isAdmin) {
      return res.status(403).json({
        error: 'ADMIN_FORBIDDEN',
        message: 'Not an admin token',
        retryable: false,
      });
    }
    req.admin = { isAdmin: true };
    next();
  } catch (err) {
    return res.status(401).json({
      error: 'ADMIN_INVALID_TOKEN',
      message: 'Invalid admin token',
      retryable: false,
    });
  }
}

module.exports = adminAuthMiddleware;
