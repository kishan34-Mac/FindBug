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
        // Increment attempts atomically
        await AuditJob.updateOne(
          { _id: job._id },
          { $inc: { attempts: 1 }, $set: { updatedAt: new Date() } }
        );
        
        // Fetch fresh job details for tracking attempts count
        const updatedJob = await AuditJob.findById(job._id);

        const report = await executeAudit(job.targetUrl, async (progress) => {
          await AuditJob.updateOne(
            { _id: job._id },
            { $set: { progress, updatedAt: new Date() } }
          ).catch(err => console.error('[Queue] Error updating job progress:', err));
        });

        await AuditJob.updateOne(
          { _id: job._id },
          {
            $set: {
              status: 'COMPLETED',
              reportId: report._id,
              progress: 100,
              updatedAt: new Date()
            },
            $unset: { error: "" }
          }
        );
        console.log(`[Queue] Job ${job._id} completed successfully.`);
      } catch (err) {
        console.error(`[Queue] Job ${job._id} failed:`, err);
        const errorMessage = err.message || 'Unknown error occurred';

        const freshJob = await AuditJob.findById(job._id);
        const attempts = freshJob ? freshJob.attempts : job.attempts;
        const maxAttempts = freshJob ? freshJob.maxAttempts : job.maxAttempts;

        if (attempts < maxAttempts) {
          await AuditJob.updateOne(
            { _id: job._id },
            {
              $set: {
                status: 'PENDING',
                progress: 0,
                error: errorMessage,
                updatedAt: new Date()
              }
            }
          );
          console.log(`[Queue] Job ${job._id} rescheduled for retry (${attempts}/${maxAttempts}).`);
        } else {
          await AuditJob.updateOne(
            { _id: job._id },
            {
              $set: {
                status: 'FAILED',
                progress: 0,
                error: errorMessage,
                updatedAt: new Date()
              }
            }
          );
          console.log(`[Queue] Job ${job._id} marked as FAILED.`);
        }
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

async function cleanupStuckJobs() {
  try {
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    const res = await AuditJob.updateMany(
      { status: 'RUNNING', updatedAt: { $lt: fifteenMinutesAgo } },
      { status: 'TIMED_OUT', error: 'Job timed out after 15 minutes of inactivity' }
    );
    if (res.modifiedCount > 0) {
      console.log(`[Queue] Automatically cleaned up and marked ${res.modifiedCount} stuck running jobs as TIMED_OUT.`);
    }
  } catch (err) {
    console.error('[Queue] Error during automatic stuck jobs cleanup:', err);
  }
}

module.exports = {
  addJob,
  processQueue,
  resumeJobs,
  cleanupStuckJobs
};
