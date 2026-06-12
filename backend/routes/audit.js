const express = require('express');
const router = express.Router();
const { submitAudit, getAuditStatus } = require('../controllers/auditController');
const { validateAuditRequest } = require('../middleware/validation');

router.post('/', validateAuditRequest, submitAudit);
router.get('/status/:jobId', getAuditStatus);

module.exports = router;
