// routes/idRoutes.js
const express = require("express");
const router = express.Router();
const {
  createTxnIdCtrl,
  createJournalCodeCtrl,
  createBothCtrl,
} = require("../controllers/idController");

router.post("/transaction", createTxnIdCtrl);
router.post("/journal", createJournalCodeCtrl);
router.post("/both", createBothCtrl);

module.exports = router;
