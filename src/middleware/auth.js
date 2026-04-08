const jwt = require('jsonwebtoken');

/**
 * Middleware: Verify team JWT from Authorization header.
 * Attaches req.team = { teamId, teamName }
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Missing or invalid authorization header',
      retryable: false,
    });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.team = {
      teamId: decoded.teamId,
      teamName: decoded.teamName,
    };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'TOKEN_EXPIRED',
        message: 'Session expired. Please rejoin.',
        retryable: false,
      });
    }
    return res.status(401).json({
      error: 'INVALID_TOKEN',
      message: 'Invalid authentication token',
      retryable: false,
    });
  }
}

module.exports = authMiddleware;
