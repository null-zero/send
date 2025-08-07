/**
 * Chunked Upload Routes (Standard Implementation)
 *
 * Simplified chunked upload routes that integrate with the standard Send upload flow
 */

const express = require('express');
const {
  initChunkedUpload,
  uploadChunk,
  finalizeChunkedUpload,
  cleanupUpload,
  chunkedUploadMiddleware,
  systemMetrics
} = require('./standardChunkedUpload');

const router = express.Router();

/**
 * Initialize chunked upload session
 * POST /api/upload/chunked/init
 */
router.post('/init', chunkedUploadMiddleware, async (req, res) => {
  await initChunkedUpload(req, res);
});

/**
 * Upload individual chunk
 * PUT /api/upload/chunked/chunk
 */
router.put('/chunk', chunkedUploadMiddleware, (req, res) => {
  // Handle raw binary data for chunks
  if (!req.rawBody) {
    let body = Buffer.alloc(0);
    let received = 0;

    console.log(`[DEBUG] Starting to receive chunk data...`);

    req.on('data', chunk => {
      body = Buffer.concat([body, chunk]);
      received += chunk.length;
      console.log(`[DEBUG] Received ${chunk.length} bytes, total: ${received}`);
    });

    req.on('end', async () => {
      console.log(`[DEBUG] Finished receiving chunk data: ${body.length} bytes`);
      req.rawBody = body;
      await uploadChunk(req, res);
    });

    req.on('error', (error) => {
      console.log(`[DEBUG] Error receiving chunk data:`, error);
      res.status(400).json({
        error: 'Failed to receive chunk data',
        code: 'CHUNK_DATA_ERROR'
      });
    });
  } else {
    console.log(`[DEBUG] Raw body already available: ${req.rawBody.length} bytes`);
    uploadChunk(req, res);
  }
});

/**
 * Finalize chunked upload
 * POST /api/upload/chunked/finalize
 */
router.post('/finalize', chunkedUploadMiddleware, async (req, res) => {
  await finalizeChunkedUpload(req, res);
});

/**
 * Cleanup failed upload
 * DELETE /api/upload/chunked/cleanup/:uploadId
 */
router.delete('/cleanup/:uploadId', chunkedUploadMiddleware, async (req, res) => {
  await cleanupUpload(req, res);
});

/**
 * Get upload status
 * GET /api/upload/chunked/status/:uploadId
 */
router.get('/status/:uploadId', chunkedUploadMiddleware, async (req, res) => {
  try {
    const { uploadId } = req.params;
    const { uploadSessions } = require('./standardChunkedUpload');

    const session = uploadSessions.get(uploadId);
    if (!session) {
      return res.status(404).json({
        error: 'Upload session not found',
        code: 'SESSION_NOT_FOUND'
      });
    }

    // Return safe session information
    const safeSession = {
      uploadId: session.uploadId,
      receivedChunks: session.receivedChunks,
      totalChunks: session.totalChunks,
      totalSize: session.totalSize,
      lastActivity: session.lastActivity,
      createdAt: session.createdAt,
      progress: session.totalChunks > 0 ? (session.receivedChunks / session.totalChunks) * 100 : 0
    };

    res.json({
      success: true,
      session: safeSession,
      isComplete: session.receivedChunks === session.totalChunks
    });

  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({
      error: 'Status check failed',
      code: 'STATUS_ERROR'
    });
  }
});

/**
 * Health check
 * GET /api/upload/chunked/health
 */
router.get('/health', (req, res) => {
  try {
    const health = {
      status: 'healthy',
      timestamp: Date.now(),
      uptime: process.uptime(),
      activeUploads: systemMetrics.activeUploads,
      totalUploads: systemMetrics.totalUploads,
      errorRate: systemMetrics.errorRate
    };

    // Simple health checks
    const memoryUsage = process.memoryUsage();
    const memoryUsagePercent = (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100;

    if (memoryUsagePercent > 90 || systemMetrics.errorRate > 10) {
      health.status = 'warning';
    }

    if (memoryUsagePercent > 95 || systemMetrics.errorRate > 25) {
      health.status = 'critical';
      return res.status(503).json(health);
    }

    res.json(health);

  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: Date.now()
    });
  }
});

module.exports = router;
