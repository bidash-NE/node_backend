const BFS_BASE = process.env.BFS_BASE_URL;

async function bfsRequest(method, path, body) {
  const res = await fetch(`${BFS_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await res.json();

  if (!json.ok) {
    const err = new Error(json.error || 'BFS payment gateway error');
    err.status = res.status === 200 ? 422 : res.status;
    throw err;
  }

  return json.data;
}

// Step 1 — Init payment, returns orderNo + bankList
async function initPayment({ userId, amount, email, description }) {
  return bfsRequest('POST', '/api/wallet/topup/init', {
    userId,
    amount,
    email,
    description: description || 'Event ticket payment',
  });
}

// Step 2 — Verify bank account
async function accountEnquiry({ orderNo, remitterBankId, remitterAccNo }) {
  return bfsRequest('POST', '/api/wallet/topup/account-enquiry', {
    orderNo,
    remitterBankId,
    remitterAccNo,
  });
}

// Step 3 — Debit with OTP, returns { status: 'SUCCESS'|'FAILED', code, message, amount }
async function debitWithOtp({ orderNo, otp }) {
  return bfsRequest('POST', '/api/wallet/topup/debit', { orderNo, otp });
}

// Check payment status
async function getStatus(orderNo) {
  return bfsRequest('GET', `/api/wallet/topup/status/${orderNo}`);
}

module.exports = { initPayment, accountEnquiry, debitWithOtp, getStatus };
