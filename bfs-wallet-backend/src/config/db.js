// Very simple in-memory store just for example.
// Replace with your real DB implementation.
const payments = new Map(); // key: orderNo, value: payment row

function createPayment(row) {
  payments.set(row.order_no, row);
  return row;
}

function updatePayment(orderNo, patch) {
  const existing = payments.get(orderNo);
  if (!existing) return null;
  const updated = { ...existing, ...patch, updated_at: new Date() };
  payments.set(orderNo, updated);
  return updated;
}

function getPayment(orderNo) {
  return payments.get(orderNo) || null;
}

module.exports = {
  createPayment,
  updatePayment,
  getPayment,
};
