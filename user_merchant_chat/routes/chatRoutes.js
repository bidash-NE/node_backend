// File: routes/chatRoutes.js
const express = require("express");
const router = express.Router();

const chat = require("../controllers/chatController");
const upload = require("../middlewares/upload");

function jsonUnlessMultipart() {
  const jsonParser = express.json();
  return (req, res, next) => {
    const ct = String(req.headers["content-type"] || "");
    if (ct.includes("multipart/form-data")) return next();
    return jsonParser(req, res, next);
  };
}

function maybeUploadSingle(field) {
  return (req, res, next) => {
    const ct = String(req.headers["content-type"] || "");
    if (ct.includes("multipart/form-data")) {
      return upload.single(field)(req, res, next);
    }
    return next();
  };
}

router.post(
  "/conversations/order/:orderId",
  express.json(),
  chat.getOrCreateConversationForOrder,
);

router.get("/conversations", chat.listConversations);
router.get("/messages/:conversationId", chat.getMessages);

router.post(
  "/messages/:conversationId",
  jsonUnlessMultipart(),
  maybeUploadSingle("chat_image"),
  chat.sendMessage,
);

router.post("/read/:conversationId", express.json(), chat.markRead);

module.exports = router;
