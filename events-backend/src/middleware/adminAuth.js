const { requireAuth } = require('./auth');

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ success: false, message: 'Unauthorized' });
  if (req.user.role !== 'admin' && req.user.role !== 'super admin') {
    return res.status(403).json({ success: false, message: 'Forbidden: admin access required' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
