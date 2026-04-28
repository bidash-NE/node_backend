const {
  initPayment,
  accountEnquiry,
  pay,
  checkStatus,
} = require("../services/onlinePaymentService");

async function initPaymentHandler(req, res, next) {
  try {
    const { amount, email, description } = req.body;
    const data = await initPayment({
      amount: Number(amount),
      email,
      description: description || "Online payment",
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

async function payHandler(req, res, next) {
  try {
    const { orderNo, otp } = req.body;
    const data = await pay({ orderNo, otp });
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
  initPaymentHandler,
  accountEnquiryHandler,
  payHandler,
  statusHandler,
};
