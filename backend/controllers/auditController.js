const AuditJob = require('../models/AuditJob');
const AuditReport = require('../models/AuditReport');
const { addJob } = require('../utils/queue');

exports.submitAudit = async (req, res, next) => {
  try {
    const { url } = req.body;
    const job = await addJob(url);
    res.status(202).json({
      message: 'Audit submitted successfully',
      jobId: job._id,
      status: job.status,
      progress: job.progress
    });
  } catch (error) {
    next(error);
  }
};

exports.getAuditStatus = async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const job = await AuditJob.findById(jobId);

    if (!job) {
      return res.status(404).json({ error: 'Audit job not found' });
    }

    if (job.status === 'COMPLETED' && job.reportId) {
      const report = await AuditReport.findById(job.reportId);
      return res.status(200).json({
        status: job.status,
        progress: job.progress,
        report
      });
    }

    res.status(200).json({
      status: job.status,
      progress: job.progress,
      error: job.error
    });
  } catch (error) {
    next(error);
  }
};
