const AuditJob = require('../models/AuditJob');
const { executeAudit } = require('./auditRunner');

let isProcessing = false;

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    while (true) {
      const job = await AuditJob.findOneAndUpdate(
        { status: 'PENDING' },
        { status: 'RUNNING', updatedAt: new Date() },
        { sort: { createdAt: 1 }, new: true }
      );

      if (!job) break;

      console.log(`[Queue] Processing job ${job._id} for URL: ${job.targetUrl}`);
      try {
        job.attempts += 1;
        await job.save();

        const report = await executeAudit(job.targetUrl, async (progress) => {
          job.progress = progress;
          job.updatedAt = new Date();
          await job.save().catch(err => console.error('[Queue] Error updating job progress:', err));
        });

        job.status = 'COMPLETED';
        job.reportId = report._id;
        job.progress = 100;
        job.error = undefined;
        job.updatedAt = new Date();
        await job.save();
        console.log(`[Queue] Job ${job._id} completed successfully.`);
      } catch (err) {
        console.error(`[Queue] Job ${job._id} failed:`, err);
        job.error = err.message || 'Unknown error occurred';

        if (job.attempts < job.maxAttempts) {
          job.status = 'PENDING';
          job.progress = 0;
          console.log(`[Queue] Job ${job._id} rescheduled for retry (${job.attempts}/${job.maxAttempts}).`);
        } else {
          job.status = 'FAILED';
          job.progress = 0;
          console.log(`[Queue] Job ${job._id} marked as FAILED.`);
        }
        job.updatedAt = new Date();
        await job.save();
      }
    }
  } catch (err) {
    console.error('[Queue] Exception in processQueue main loop:', err);
  } finally {
    isProcessing = false;
  }
}

async function addJob(url) {
  let job = await AuditJob.findOne({ targetUrl: url, status: { $in: ['PENDING', 'RUNNING'] } });
  if (job) {
    return job;
  }

  job = new AuditJob({ targetUrl: url });
  await job.save();

  processQueue().catch(err => console.error('[Queue] Trigger error:', err));

  return job;
}

async function resumeJobs() {
  try {
    const res = await AuditJob.updateMany(
      { status: 'RUNNING' },
      { status: 'PENDING', progress: 0, error: 'Resumed after server restart' }
    );
    console.log(`[Queue] Resumed ${res.modifiedCount} stuck running jobs to PENDING.`);
    processQueue().catch(err => console.error('[Queue] Trigger error on resume:', err));
  } catch (err) {
    console.error('[Queue] Error during job resumption:', err);
  }
}

module.exports = {
  addJob,
  processQueue,
  resumeJobs
};
