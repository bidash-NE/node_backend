const {
  initTopup,
  accountEnquiry,
  debitWithOtp,
  checkStatus,
} = require("../services/paymentService");

async function initTopupHandler(req, res, next) {
  try {
    const { userId, amount, email, description } = req.body;
    const data = await initTopup({
      userId,
      amount: Number(amount),
      email,
      description: description || "Wallet topup",
    });
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
}

async function accountEnquiryHandler(req, res, next) {
  try {
    const { orderNo, remitterBankId, remitterAccNo } = req.body;
    const data = await accountEnquiry({ orderNo, remitterBankId, remitterAccNo });
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
}

async function debitWithOtpHandler(req, res, next) {
  try {
    const { orderNo, otp } = req.body;
    const data = await debitWithOtp({ orderNo, otp });
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
}

async function statusHandler(req, res, next) {
  try {
    const { orderNo } = req.params;
    const data = await checkStatus(orderNo);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  initTopupHandler,
  accountEnquiryHandler,
  debitWithOtpHandler,
  statusHandler,
};
