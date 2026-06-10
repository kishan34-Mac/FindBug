const express = require('express');
const router = express.Router();
const { runAudit } = require('../controllers/auditController');

router.post('/', runAudit);

module.exports = router;
