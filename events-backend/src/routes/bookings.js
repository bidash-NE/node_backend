const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const bookingsController = require('../controllers/bookings');

router.post('/', requireAuth, bookingsController.createBooking);
router.get('/me', requireAuth, bookingsController.myTickets);
router.delete('/:bookingId', requireAuth, bookingsController.deleteBooking);

module.exports = router;
