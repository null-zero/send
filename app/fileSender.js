import Nanobus from 'nanobus';
import OwnedFile from './ownedFile';
import Keychain from './keychain';
import { arrayToB64, bytes, encryptedSize } from './utils';
import { uploadWs } from './api';

// Import the chunked uploader (renamed from enterprise)
class ChunkedUploader {
  constructor(config = {}) {
    this.config = {
      chunkSize: config.chunkSize || 5 * 1024 * 1024, // 5MB default
      maxParallelChunks: config.maxParallelChunks || 3,
      enableIntegrityVerification: config.enableIntegrityVerification !== false,
      hashAlgorithm: config.hashAlgorithm || 'SHA-256',
      maxRetries: config.maxRetries || 3,
      retryDelay: config.retryDelay || 1000,
      sessionId: this.generateSessionId(),
      onProgress: config.onProgress || (() => {}),
      onChunkComplete: config.onChunkComplete || (() => {}),
      onError: config.onError || (() => {})
    };

    this.originalFileSize = config.originalFileSize || 0; // Store original file size
    this.uploadId = null;
    this.fileId = null;
    this.totalChunks = 0;
    this.uploadedChunks = 0;
    this.uploadedSize = 0;
    this.actualUploadedSize = 0; // Track actual uploaded bytes for progress
    this.metrics = {
      startTime: 0,
      chunkTimes: [],
      totalRetries: 0,
      errors: []
    };

    this.cancelled = false;
  }

  generateSessionId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    // Fallback for older browsers
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = (Math.random() * 16) | 0;
      const v = c == 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  async uploadChunked(
    encryptedStream,
    metadata,
    authKey,
    timeLimit,
    dlimit,
    bearerToken
  ) {
    this.metrics.startTime = Date.now();

    // Initialize chunked upload session first
    const initResponse = await this.initializeUpload(
      metadata,
      authKey,
      timeLimit,
      dlimit,
      bearerToken
    );

    if (this.cancelled) {
      throw new Error('Upload cancelled');
    }

    this.uploadId = initResponse.uploadId;
    this.fileId = initResponse.id;

    // Stream chunks directly without loading entire file into memory
    const reader = encryptedStream.getReader();
    let done = false;
    let chunkIndex = 0;
    let totalSize = 0;
    const activeUploads = new Map(); // Track active uploads

    while (!done) {
      // Check for cancellation
      if (this.cancelled) {
        throw new Error('Upload cancelled');
      }

      // Read chunks up to our buffer limit
      const chunkBuffer = [];
      let bufferSize = 0;

      // Fill buffer up to chunk size or until stream is done
      while (!done && bufferSize < this.config.chunkSize) {
        const result = await reader.read();
        done = result.done;

        if (!done) {
          chunkBuffer.push(result.value);
          bufferSize += result.value.length;
        }
      }

      if (chunkBuffer.length > 0) {
        // Combine buffer into chunk
        const chunkData = new Uint8Array(bufferSize);
        let offset = 0;
        for (const chunk of chunkBuffer) {
          chunkData.set(chunk, offset);
          offset += chunk.length;
        }

        totalSize += chunkData.length;

        // Upload chunk with concurrency control
        const chunkSize = chunkData.length;
        const uploadPromise = this.uploadChunk(
          chunkIndex,
          chunkData,
          bearerToken
        ).then(result => {
          this.actualUploadedSize += chunkSize;
          // Use the estimated total size from initialization for more accurate progress
          const estimatedTotal =
            this.originalFileSize > 0
              ? encryptedSize(this.originalFileSize)
              : totalSize;
          const progressTotal = Math.max(estimatedTotal, totalSize);
          this.config.onProgress(this.actualUploadedSize, progressTotal);
          return result;
        });

        activeUploads.set(chunkIndex, uploadPromise);

        // Control concurrency - wait for oldest uploads to complete
        if (activeUploads.size >= this.config.maxParallelChunks) {
          const oldestIndex = Math.min(...activeUploads.keys());
          await activeUploads.get(oldestIndex);
          activeUploads.delete(oldestIndex);
        }

        chunkIndex++;
      }
    }

    // Wait for all remaining uploads to complete
    await Promise.all(activeUploads.values());

    this.totalChunks = chunkIndex;
    this.fileSize = totalSize;

    // Report final progress as 100% using actual uploaded size
    this.config.onProgress(this.actualUploadedSize, this.actualUploadedSize);

    // Handle case of empty file
    if (this.totalChunks === 0) {
      console.warn('No chunks uploaded - file may be empty');
      throw new Error('No data to upload - file appears to be empty');
    }

    // Finalize the upload
    const finalizeResponse = await this.finalizeUpload(bearerToken);

    if (this.cancelled) {
      throw new Error('Upload cancelled');
    }

    this.metrics.endTime = Date.now();
    const duration = this.metrics.endTime - this.metrics.startTime;

    return {
      id: this.fileId,
      url:
        finalizeResponse.url ||
        `${window.location.origin}/download/${this.fileId}/`,
      ownerToken: finalizeResponse.ownerToken,
      duration: duration
    };
  }

  async initializeUpload(metadata, authKey, timeLimit, dlimit, bearerToken) {
    // Create fileMetadata object - estimate size from original file size
    // Convert encrypted metadata ArrayBuffer to base64 string (like WebSocket upload does)
    const metadataHeader = arrayToB64(new Uint8Array(metadata));

    // Estimate encrypted size if we have original file size
    const estimatedSize =
      this.originalFileSize > 0 ? encryptedSize(this.originalFileSize) : 0;

    const fileMetadata = {
      size: estimatedSize, // Use estimated encrypted size
      metadata: metadataHeader, // Store the encrypted metadata as base64 string
      name: 'chunked-file', // Placeholder name
      type: 'application/octet-stream'
    };

    const response = await fetch('/api/upload/chunked/init', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearerToken}`,
        'X-Session-ID': this.config.sessionId
      },
      body: JSON.stringify({
        fileMetadata: fileMetadata,
        authorization: `Bearer ${authKey}`,
        bearer: bearerToken,
        timeLimit,
        dlimit,
        chunkSize: this.config.chunkSize,
        sessionId: this.config.sessionId,
        timestamp: Date.now(),
        securityConfig: {
          enableVerification: this.config.enableIntegrityVerification,
          hashAlgorithm: this.config.hashAlgorithm
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      try {
        const error = JSON.parse(errorText);
        throw new Error(
          `Init failed: ${error.error || error.message || errorText}`
        );
      } catch (parseError) {
        throw new Error(`Init failed: ${errorText}`);
      }
    }

    return await response.json();
  }

  async uploadChunk(chunkIndex, chunkData, _bearerToken) {
    const chunkStart = Date.now();

    // Calculate hash if integrity verification is enabled
    let chunkHash = null;
    if (this.config.enableIntegrityVerification) {
      const hashBuffer = await crypto.subtle.digest(
        this.config.hashAlgorithm,
        chunkData
      );
      chunkHash = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
    }

    let retries = 0;
    while (retries <= this.config.maxRetries) {
      try {
        const response = await fetch('/api/upload/chunked/chunk', {
          method: 'PUT',
          headers: {
            'X-Session-ID': this.config.sessionId,
            'X-Upload-ID': this.uploadId,
            'X-Chunk-Index': chunkIndex.toString(),
            'X-Total-Chunks': (this.totalChunks || 0).toString(), // Use 0 if not known yet
            'X-Chunk-Hash': chunkHash,
            'X-Hash-Algorithm': this.config.hashAlgorithm,
            'Content-Type': 'application/octet-stream'
          },
          body: chunkData
        });

        if (!response.ok) {
          throw new Error(
            `Chunk ${chunkIndex} upload failed: ${response.statusText}`
          );
        }

        const result = await response.json();

        // Update progress (but don't call this.config.onProgress here as it's handled in the main loop)
        this.uploadedChunks = result.receivedChunks || this.uploadedChunks + 1;

        const chunkTime = Date.now() - chunkStart;
        this.metrics.chunkTimes.push(chunkTime);

        // Notify chunk completion
        this.config.onChunkComplete(chunkIndex, chunkData.length, chunkTime);

        return result;
      } catch (error) {
        retries++;
        this.metrics.totalRetries++;
        this.metrics.errors.push({
          chunkIndex,
          error: error.message,
          retry: retries
        });

        if (retries > this.config.maxRetries) {
          throw error;
        }

        // Exponential backoff
        await new Promise(resolve =>
          setTimeout(resolve, this.config.retryDelay * Math.pow(2, retries - 1))
        );
      }
    }
  }

  async finalizeUpload(_bearerToken) {
    // Collect integrity hashes for final verification
    const integrityHashes = [];
    if (this.config.enableIntegrityVerification) {
      for (let i = 0; i < this.totalChunks; i++) {
        // These would be stored during chunk upload
        integrityHashes.push({ index: i, hash: `chunk-${i}-hash` });
      }
    }

    const response = await fetch('/api/upload/chunked/finalize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-ID': this.config.sessionId
      },
      body: JSON.stringify({
        uploadId: this.uploadId,
        sessionId: this.config.sessionId,
        totalChunks: this.totalChunks,
        totalSize: this.uploadedSize,
        integrityHashes,
        metrics: {
          clientProcessingTime: Date.now() - this.metrics.startTime,
          totalRetries: this.metrics.totalRetries,
          averageChunkTime:
            this.metrics.chunkTimes.reduce((a, b) => a + b, 0) /
            this.metrics.chunkTimes.length
        }
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Finalize failed: ${error.error}`);
    }

    const finalizeResult = await response.json();
    return finalizeResult;
  }

  getTotalSize() {
    return this.totalChunks * this.config.chunkSize;
  }

  cancel() {
    this.cancelled = true;
  }
}

export default class FileSender extends Nanobus {
  constructor() {
    super('FileSender');
    this.keychain = new Keychain();
    this.reset();
  }

  get progressRatio() {
    return this.progress[0] / this.progress[1];
  }

  get progressIndefinite() {
    return (
      ['fileSizeProgress', 'notifyUploadEncryptDone'].indexOf(this.msg) === -1
    );
  }

  get sizes() {
    return {
      partialSize: bytes(this.progress[0]),
      totalSize: bytes(this.progress[1])
    };
  }

  get speed() {
    return {
      current: this.currentSpeed,
      formatted: this.formatSpeed(this.currentSpeed)
    };
  }

  formatSpeed(bytesPerSecond) {
    if (bytesPerSecond === 0) return '0 B/s';

    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    const k = 1024;
    const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k));
    const value = bytesPerSecond / Math.pow(k, i);

    return `${value.toFixed(1)} ${units[i]}`;
  }

  calculateSpeed(currentBytes) {
    const now = Date.now();

    if (!this.startTime) {
      this.startTime = now;
      this.lastProgressTime = now;
      this.lastProgressBytes = 0;
      return;
    }

    if (!this.lastProgressTime) {
      this.lastProgressTime = now;
      this.lastProgressBytes = currentBytes;
      return;
    }

    const timeDelta = now - this.lastProgressTime;
    const bytesDelta = currentBytes - this.lastProgressBytes;

    if (timeDelta >= 500) {
      // Update speed every 500ms
      const instantSpeed = (bytesDelta / timeDelta) * 1000; // bytes per second

      // Keep a rolling average of the last 10 speed samples
      this.speedSamples.push(instantSpeed);
      if (this.speedSamples.length > 10) {
        this.speedSamples.shift();
      }

      // Calculate average speed from samples
      this.currentSpeed =
        this.speedSamples.reduce((sum, speed) => sum + speed, 0) /
        this.speedSamples.length;

      this.lastProgressTime = now;
      this.lastProgressBytes = currentBytes;
    }
  }

  reset() {
    this.uploadRequest = null;
    this.chunkedUploader = null;
    this.msg = 'importingFile';
    this.progress = [0, 1];
    this.cancelled = false;

    // Speed tracking properties
    this.startTime = null;
    this.lastProgressTime = null;
    this.lastProgressBytes = 0;
    this.speedSamples = [];
    this.currentSpeed = 0;
  }

  cancel() {
    this.cancelled = true;
    if (this.uploadRequest) {
      this.uploadRequest.cancel();
    }
    if (this.chunkedUploader) {
      this.chunkedUploader.cancel();
    }
  }

  async upload(archive, bearerToken) {
    if (this.cancelled) {
      throw new Error(0);
    }
    this.msg = 'encryptingFile';
    this.emit('encrypting');

    const totalSize = encryptedSize(archive.size);
    const encStream = await this.keychain.encryptStream(archive.stream);
    const metadata = await this.keychain.encryptMetadata(archive);
    const authKeyB64 = await this.keychain.authKeyB64();

    // Decide whether to use chunked upload based on file size
    const useChunkedUpload = archive.size > 10 * 1024 * 1024; // 10MB threshold

    if (useChunkedUpload) {
      // Use chunked upload for large files
      this.chunkedUploader = new ChunkedUploader({
        originalFileSize: archive.size, // Pass the original file size
        onProgress: (uploaded, total) => {
          this.progress = [uploaded, total];
          this.calculateSpeed(uploaded);
          this.emit('progress');
        },
        onChunkComplete: (chunkIndex, chunkSize, duration) => {
          console.log(
            `Chunk ${chunkIndex} uploaded: ${chunkSize} bytes in ${duration}ms`
          );
        },
        onError: error => {
          console.error('Chunked upload error:', error);
        }
      });

      if (this.cancelled) {
        throw new Error(0);
      }

      this.msg = 'fileSizeProgress';
      this.emit('progress');

      try {
        const result = await this.chunkedUploader.uploadChunked(
          encStream,
          metadata,
          authKeyB64,
          archive.timeLimit,
          archive.dlimit,
          bearerToken
        );

        this.msg = 'notifyUploadEncryptDone';
        this.progress = [1, 1];

        const secretKey = arrayToB64(this.keychain.rawSecret);
        const ownedFile = new OwnedFile({
          id: result.id,
          url: `${result.url}#${secretKey}`,
          name: archive.name,
          size: archive.size,
          manifest: archive.manifest,
          time: result.duration,
          speed: archive.size / (result.duration / 1000),
          createdAt: Date.now(),
          expiresAt: Date.now() + archive.timeLimit * 1000,
          secretKey: secretKey,
          nonce: this.keychain.nonce,
          ownerToken: result.ownerToken,
          dlimit: archive.dlimit,
          timeLimit: archive.timeLimit
        });

        return ownedFile;
      } catch (e) {
        this.msg = 'errorPageHeader';
        this.chunkedUploader = null;
        throw e;
      }
    } else {
      // Use traditional WebSocket upload for smaller files
      this.uploadRequest = uploadWs(
        encStream,
        metadata,
        authKeyB64,
        archive.timeLimit,
        archive.dlimit,
        bearerToken,
        p => {
          this.progress = [p, totalSize];
          this.calculateSpeed(p);
          this.emit('progress');
        }
      );

      if (this.cancelled) {
        throw new Error(0);
      }

      this.msg = 'fileSizeProgress';
      this.emit('progress');

      try {
        const result = await this.uploadRequest.result;
        this.msg = 'notifyUploadEncryptDone';
        this.uploadRequest = null;
        this.progress = [1, 1];

        const secretKey = arrayToB64(this.keychain.rawSecret);
        const ownedFile = new OwnedFile({
          id: result.id,
          url: `${result.url}#${secretKey}`,
          name: archive.name,
          size: archive.size,
          manifest: archive.manifest,
          time: result.duration,
          speed: archive.size / (result.duration / 1000),
          createdAt: Date.now(),
          expiresAt: Date.now() + archive.timeLimit * 1000,
          secretKey: secretKey,
          nonce: this.keychain.nonce,
          ownerToken: result.ownerToken,
          dlimit: archive.dlimit,
          timeLimit: archive.timeLimit
        });

        return ownedFile;
      } catch (e) {
        this.msg = 'errorPageHeader';
        this.uploadRequest = null;
        throw e;
      }
    }
  }
}
