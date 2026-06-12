const { z } = require('zod');

const validateAuditRequest = (req, res, next) => {
  const schema = z.object({
    url: z.string().trim().min(1, 'URL is required').refine((val) => {
      try {
        const parsed = new URL(val);
        const host = parsed.hostname;
        return host.includes('.') || host === 'localhost';
      } catch (e) {
        return false;
      }
    }, {
      message: 'Invalid URL format'
    })
  });

  try {
    let url = req.body.url;
    if (url) {
      url = url.trim();
      if (!/^https?:\/\//i.test(url)) {
        url = 'https://' + url;
      }
      req.body.url = url;
    }

    schema.parse(req.body);
    next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.issues.map(err => err.message).join(', ')
      });
    }
    next(error);
  }
};

module.exports = {
  validateAuditRequest
};
