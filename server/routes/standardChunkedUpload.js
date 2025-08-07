/**
 * Standard Chunked Upload Implementation
 *
 * Simplified chunked upload system integrated with the existing Send workflow
 */

const crypto = require('crypto');
const storage = require('../storage');
const config = require('../config');
const mozlog = require('../log');
const { encryptedSize } = require('../../app/utils');

const log = mozlog('send.chunked-upload');

// In-memory storage for upload sessions (in production, use Redis or similar)
const uploadSessions = new Map();

// System metrics
const systemMetrics = {
  activeUploads: 0,
  totalUploads: 0,
  errorRate: 0,
  errors: []
};

/**
 * Simple security middleware
 */
function chunkedUploadMiddleware(req, res, next) {
  // Basic rate limiting (simplified from enterprise version)
  const clientIP = req.ip || req.connection.remoteAddress;

  // Simple CORS headers
  const allowedOrigins = config.allowed_origins || [];
  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin) || config.env === 'development') {
    res.header('Access-Control-Allow-Origin', origin);
  }

  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization, ' +
    'X-Session-ID, X-Upload-ID, X-Chunk-Index, X-Total-Chunks, X-Chunk-Hash, X-Hash-Algorithm'
  );

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  // Basic logging
  log.info('chunked-upload-request', {
    method: req.method,
    path: req.path,
    ip: clientIP,
    userAgent: req.headers['user-agent']
  });

  next();
}

/**
 * Initialize chunked upload session
 */
async function initChunkedUpload(req, res) {
  try {
    console.log('[DEBUG] Init chunked upload request received');
    console.log('[DEBUG] Request body:', JSON.stringify(req.body, null, 2));

    const {
      fileMetadata,
      authorization,
      bearer,
      timeLimit = 300,
      dlimit = 1,
      chunkSize = 5 * 1024 * 1024,
      sessionId,
      timestamp,
      securityConfig = {}
    } = req.body;

    console.log('[DEBUG] Extracted parameters:', {
      fileMetadata: fileMetadata ? `size: ${fileMetadata.size}` : 'missing',
      authorization: authorization ? 'present' : 'missing',
      bearer: bearer ? 'present' : 'missing',
      timeLimit,
      dlimit,
      chunkSize,
      sessionId: sessionId ? 'present' : 'missing'
    });

    // Validate required fields
    if (!fileMetadata || !fileMetadata.size) {
      console.log('[DEBUG] Missing or invalid fileMetadata');
      return res.status(400).json({
        error: 'Missing or invalid file metadata',
        code: 'INVALID_FILE_METADATA'
      });
    }

    if (!authorization) {
      console.log('[DEBUG] Missing authorization');
      return res.status(400).json({
        error: 'Missing authorization',
        code: 'MISSING_AUTHORIZATION'
      });
    }

    // Generate upload ID and file ID
    const uploadId = crypto.randomBytes(16).toString('hex');
    const fileId = crypto.randomBytes(8).toString('hex');
    console.log('[DEBUG] Generated uploadId:', uploadId, 'fileId:', fileId);

    // Create metadata for the file (similar to regular upload)
    const owner = crypto.randomBytes(10).toString('hex');
    const nonce = crypto.randomBytes(16).toString('base64');
    const metadata = {
      owner,
      metadata: fileMetadata.metadata || fileMetadata,
      auth: authorization.replace('Bearer ', ''),
      nonce,
      dlimit,
      dl: 0, // Download counter starts at 0
      pwd: false, // No password protection
      timeLimit: timeLimit * 1000
    };

    console.log('[DEBUG] Created metadata:', {
      owner,
      hasMetadata: !!metadata.metadata,
      hasAuth: !!metadata.auth,
      nonce,
      dlimit,
      timeLimit: metadata.timeLimit
    });

    // Store upload session
    const session = {
      uploadId,
      fileId: fileId,
      sessionId,
      totalSize: fileMetadata.size,
      chunkSize,
      totalChunks: Math.ceil(fileMetadata.size / chunkSize),
      receivedChunks: 0,
      chunks: new Map(),
      createdAt: Date.now(),
      lastActivity: Date.now(),
      timeLimit,
      dlimit,
      metadata: metadata, // Store the metadata for later use
      securityConfig
    };

    uploadSessions.set(uploadId, session);
    systemMetrics.activeUploads++;
    systemMetrics.totalUploads++;

    log.info('chunked-upload-initialized', {
      uploadId,
      fileId: fileId,
      totalChunks: session.totalChunks,
      chunkSize
    });

    const response = {
      success: true,
      uploadId,
      id: fileId,
      url: `${config.deriveBaseUrl(req)}/download/${fileId}/`,
      ownerToken: req.ownerToken || 'generated-token',
      totalChunks: session.totalChunks,
      chunkSize,
      sessionId
    };

    res.json(response);

  } catch (error) {
    console.log('[DEBUG] Init chunked upload error:', error);
    console.log('[DEBUG] Error stack:', error.stack);

    log.error('chunked-upload-init-error', { error: error.message, stack: error.stack });
    systemMetrics.errors.push({ type: 'init', error: error.message, timestamp: Date.now() });

    res.status(500).json({
      error: 'Upload initialization failed',
      code: 'INIT_ERROR',
      details: error.message
    });
  }
}

/**
 * Upload individual chunk
 */
async function uploadChunk(req, res) {
  try {
    const uploadId = req.headers['x-upload-id'];
    const chunkIndex = parseInt(req.headers['x-chunk-index']);
    const totalChunks = parseInt(req.headers['x-total-chunks']);
    const chunkHash = req.headers['x-chunk-hash'];

    console.log(`[DEBUG] Chunk upload request: uploadId=${uploadId}, chunkIndex=${chunkIndex}, totalChunks=${totalChunks}`);

    if (!uploadId) {
      console.log('[DEBUG] Missing upload ID');
      return res.status(400).json({
        error: 'Missing upload ID',
        code: 'MISSING_UPLOAD_ID'
      });
    }

    const session = uploadSessions.get(uploadId);
    if (!session) {
      console.log(`[DEBUG] Session not found for uploadId: ${uploadId}`);
      return res.status(404).json({
        error: 'Upload session not found',
        code: 'SESSION_NOT_FOUND'
      });
    }

    // Get chunk data
    const chunkData = req.rawBody;
    if (!chunkData || chunkData.length === 0) {
      console.log('[DEBUG] No chunk data received');
      return res.status(400).json({
        error: 'No chunk data received',
        code: 'NO_CHUNK_DATA'
      });
    }

    console.log(`[DEBUG] Chunk data received: ${chunkData.length} bytes for chunk ${chunkIndex}`);

    // Verify chunk hash if provided
    if (chunkHash && session.securityConfig.enableVerification) {
      const hashAlgorithm = req.headers['x-hash-algorithm'] || 'SHA-256';
      const calculatedHash = crypto.createHash(hashAlgorithm.toLowerCase().replace('-', '')).update(chunkData).digest('base64');

      if (calculatedHash !== chunkHash) {
        console.log(`[DEBUG] Hash mismatch for chunk ${chunkIndex}: expected=${chunkHash}, calculated=${calculatedHash}`);
        return res.status(400).json({
          error: 'Chunk integrity verification failed',
          code: 'INTEGRITY_ERROR'
        });
      }
    }

    // Store chunk (check for duplicates)
    const wasAlreadyStored = session.chunks.has(chunkIndex);
    session.chunks.set(chunkIndex, chunkData);
    session.receivedChunks = session.chunks.size;
    session.lastActivity = Date.now();

    console.log(`[DEBUG] Chunk ${chunkIndex} stored (duplicate: ${wasAlreadyStored}). Progress: ${session.receivedChunks}/${session.totalChunks}`);

    log.debug('chunk-uploaded', {
      uploadId,
      chunkIndex,
      chunkSize: chunkData.length,
      receivedChunks: session.receivedChunks,
      totalChunks: session.totalChunks,
      wasAlreadyStored
    });

    const response = {
      success: true,
      uploadId,
      chunkIndex,
      receivedChunks: session.receivedChunks,
      totalChunks: session.totalChunks,
      isComplete: session.receivedChunks === session.totalChunks
    };

    console.log(`[DEBUG] Sending chunk response:`, response);
    res.json(response);

  } catch (error) {
    console.log(`[DEBUG] Chunk upload error:`, error);
    log.error('chunk-upload-error', { error: error.message });
    systemMetrics.errors.push({ type: 'chunk', error: error.message, timestamp: Date.now() });

    res.status(500).json({
      error: 'Chunk upload failed',
      code: 'CHUNK_ERROR'
    });
  }
}

/**
 * Finalize chunked upload
 */
async function finalizeChunkedUpload(req, res) {
  try {
    const { uploadId, sessionId, totalChunks, totalSize, metrics } = req.body;
    const session = uploadSessions.get(uploadId);

    if (!session) {
      console.log(`[DEBUG] Finalize failed: Session not found for uploadId ${uploadId}`);
      return res.status(404).json({
        error: 'Upload session not found',
        code: 'SESSION_NOT_FOUND'
      });
    }

    // Verify all chunks are received
    if (session.receivedChunks !== totalChunks) {
      console.log(`[DEBUG] Finalize failed: Missing chunks (received=${session.receivedChunks}, total=${totalChunks})`);
      return res.status(400).json({
        error: 'Missing chunks',
        code: 'INCOMPLETE_UPLOAD',
        expected: totalChunks,
        received: session.receivedChunks
      });
    }

    // Reconstruct file from chunks
    const chunks = [];
    for (let i = 0; i < totalChunks; i++) {
      const chunk = session.chunks.get(i);
      if (!chunk) {
        throw new Error(`Missing chunk ${i}`);
      }
      chunks.push(chunk);
    }

    const completeFile = Buffer.concat(chunks);

    // Store the complete file using Send's storage system
    const fileStream = require('stream').Readable.from(completeFile);
    await storage.set(session.fileId, fileStream, session.metadata, session.timeLimit);

    // Cleanup session
    uploadSessions.delete(uploadId);
    systemMetrics.activeUploads--;

    log.info('chunked-upload-finalized', {
      uploadId,
      fileId: session.fileId,
      totalSize: completeFile.length,
      duration: Date.now() - session.createdAt,
      chunks: totalChunks
    });

    const response = {
      success: true,
      fileId: session.fileId,
      url: `${config.deriveBaseUrl(req)}/download/${session.fileId}/`,
      size: completeFile.length,
      chunks: totalChunks,
      duration: Date.now() - session.createdAt
    };

    res.json(response);

  } catch (error) {
    log.error('chunked-upload-finalize-error', { error: error.message });
    systemMetrics.errors.push({ type: 'finalize', error: error.message, timestamp: Date.now() });

    res.status(500).json({
      error: 'Upload finalization failed',
      code: 'FINALIZE_ERROR'
    });
  }
}

/**
 * Cleanup failed upload
 */
async function cleanupUpload(req, res) {
  try {
    const { uploadId } = req.params;

    const session = uploadSessions.get(uploadId);
    if (session) {
      // Clean up file if it exists
      try {
        await storage.delete(session.fileId);
      } catch (err) {
        // File might not exist yet, ignore
      }

      uploadSessions.delete(uploadId);
      systemMetrics.activeUploads--;

      log.info('chunked-upload-cleaned-up', { uploadId, fileId: session.fileId });
    }

    res.json({
      success: true,
      message: 'Upload cleaned up'
    });

  } catch (error) {
    log.error('chunked-upload-cleanup-error', { error: error.message });

    res.status(500).json({
      error: 'Cleanup failed',
      code: 'CLEANUP_ERROR'
    });
  }
}

// Periodic cleanup of expired sessions
setInterval(() => {
  const now = Date.now();
  const timeout = 3600000; // 1 hour

  for (const [uploadId, session] of uploadSessions.entries()) {
    if (now - session.lastActivity > timeout) {
      uploadSessions.delete(uploadId);
      systemMetrics.activeUploads--;

      // Try to cleanup the file
      storage.delete(session.fileId).catch(() => {
        // Ignore errors - file might not exist
      });

      log.info('session-timeout-cleanup', { uploadId, fileId: session.fileId });
    }
  }
}, 300000); // 5 minutes

module.exports = {
  initChunkedUpload,
  uploadChunk,
  finalizeChunkedUpload,
  cleanupUpload,
  chunkedUploadMiddleware,
  uploadSessions,
  systemMetrics
};
