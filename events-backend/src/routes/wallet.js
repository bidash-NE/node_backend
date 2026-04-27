const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { getBalance } = require('../services/wallet');

router.get('/balance', requireAuth, async (req, res, next) => {
  try {
    const wallet = await getBalance(req.user.id);
    if (!wallet) return res.status(404).json({ success: false, message: 'Wallet not found' });
    res.json({
      success: true,
      data: {
        wallet_id: wallet.wallet_id,
        balance: parseFloat(wallet.amount),
        status: wallet.status,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
