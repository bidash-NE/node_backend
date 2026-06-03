// models/orders/schemaSupport.js

async function ensureStatusReasonSupport() {
  return true;
}

async function ensureServiceTypeSupport() {
  return true;
}

async function ensureDeliveryExtrasSupport(_client = null) {
  return {
    hasLat: true,
    hasLng: true,
    hasFloor: true,
    hasInstr: true,
    hasMode: true,
    hasPhoto: true,
    hasPhotoList: true,
    hasDeliveryStatus: true,
    hasDeliveredAt: true,
    hasBatchId: true,
    hasDriverId: true,
    hasRideId: true,
  };
}

module.exports = {
  ensureStatusReasonSupport,
  ensureServiceTypeSupport,
  ensureDeliveryExtrasSupport,
};