const AuditJob = require('../models/AuditJob');
const AuditReport = require('../models/AuditReport');
const { addJob } = require('../utils/queue');
const logger = require('../utils/logger');

exports.submitAudit = async (req, res, next) => {
  logger.info("STEP START: API Request");
  logger.info("STEP START: Submit URL");
  try {
    const { url } = req.body;
    
    logger.info("STEP START: Job Creation");
    const job = await addJob(url);
    logger.info("STEP COMPLETE: Job Creation");
    
    logger.info("STEP COMPLETE: Submit URL");
    logger.info("STEP COMPLETE: API Request");
    
    res.status(202).json({
      message: 'Audit submitted successfully',
      jobId: job._id,
      status: job.status,
      progress: job.progress
    });
  } catch (error) {
    logger.error("STEP FAILED: Submit URL / API Request", error);
    next(error);
  }
};

exports.getAuditStatus = async (req, res, next) => {
  logger.info("STEP START: Report Retrieval");
  try {
    const { jobId } = req.params;
    const job = await AuditJob.findById(jobId);

    if (!job) {
      logger.warn(`STEP FAILED: Report Retrieval - Job ID ${jobId} not found`);
      return res.status(404).json({ error: 'Audit job not found' });
    }

    if (job.status === 'COMPLETED' && job.reportId) {
      const report = await AuditReport.findById(job.reportId);
      logger.info("STEP COMPLETE: Report Retrieval");
      return res.status(200).json({
        status: job.status,
        progress: job.progress,
        report
      });
    }

    logger.info("STEP COMPLETE: Report Retrieval");
    res.status(200).json({
      status: job.status,
      progress: job.progress,
      error: job.error
    });
  } catch (error) {
    logger.error("STEP FAILED: Report Retrieval", error);
    next(error);
  }
};
