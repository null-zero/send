import Nanobus from 'nanobus';
import OwnedFile from './ownedFile';
import Keychain from './keychain';
import { arrayToB64, bytes } from './utils';
import { uploadWs } from './api';
import { encryptedSize } from './utils';

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

    this.uploadId = null;
    this.fileId = null;
    this.totalChunks = 0;
    this.uploadedChunks = 0;
    this.uploadedSize = 0;
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
      const r = Math.random() * 16 | 0;
      const v = c == 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  async uploadChunked(encryptedStream, metadata, authKey, timeLimit, dlimit, bearerToken) {
    this.metrics.startTime = Date.now();

    try {
      // Convert stream to array buffer
      const chunks = [];
      const reader = encryptedStream.getReader();
      let done = false;

      while (!done) {
        const result = await reader.read();
        done = result.done;
        if (!done) {
          chunks.push(result.value);
        }
      }

      const fullData = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        fullData.set(chunk, offset);
        offset += chunk.length;
      }

      // Calculate total chunks needed and store file size
      this.fileSize = fullData.length; // Store the actual encrypted file size
      this.totalChunks = Math.ceil(this.fileSize / this.config.chunkSize);

      // Initialize chunked upload session
      const initResponse = await this.initializeUpload(metadata, authKey, timeLimit, dlimit, bearerToken);

      if (this.cancelled) {
        throw new Error('Upload cancelled');
      }

      this.uploadId = initResponse.uploadId;
      this.fileId = initResponse.id;

      // Upload chunks
      const chunkPromises = [];
      for (let i = 0; i < this.totalChunks; i++) {
        const start = i * this.config.chunkSize;
        const end = Math.min(start + this.config.chunkSize, fullData.length);
        const chunkData = fullData.slice(start, end);

        chunkPromises.push(this.uploadChunk(i, chunkData, bearerToken));

        // Limit parallel uploads
        if (chunkPromises.length >= this.config.maxParallelChunks || i === this.totalChunks - 1) {
          await Promise.all(chunkPromises);
          chunkPromises.length = 0;
        }

        if (this.cancelled) {
          throw new Error('Upload cancelled');
        }
      }

      // Finalize upload
      await this.finalizeUpload(bearerToken);

      return {
        id: this.fileId,
        url: initResponse.url,
        ownerToken: initResponse.ownerToken,
        duration: Date.now() - this.metrics.startTime
      };
    } catch (error) {
      this.config.onError(error);
      throw error;
    }
  }

  async initializeUpload(metadata, authKey, timeLimit, dlimit, bearerToken) {
    // Create fileMetadata object with the actual file size
    // Convert encrypted metadata ArrayBuffer to base64 string (like WebSocket upload does)
    const metadataHeader = arrayToB64(new Uint8Array(metadata));

    const fileMetadata = {
      size: this.fileSize, // Use the encrypted file size
      metadata: metadataHeader, // Store the encrypted metadata as base64 string
      name: 'chunked-file', // Placeholder name
      type: 'application/octet-stream'
    };

    const response = await fetch('/api/upload/chunked/init', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bearerToken}`,
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
      const error = await response.json();
      throw new Error(`Init failed: ${error.error}`);
    }

    return await response.json();
  }

  async uploadChunk(chunkIndex, chunkData, _bearerToken) {
    const chunkStart = Date.now();

    // Calculate hash if integrity verification is enabled
    let chunkHash = null;
    if (this.config.enableIntegrityVerification) {
      const hashBuffer = await crypto.subtle.digest(this.config.hashAlgorithm, chunkData);
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
            'X-Total-Chunks': this.totalChunks.toString(),
            'X-Chunk-Hash': chunkHash,
            'X-Hash-Algorithm': this.config.hashAlgorithm,
            'Content-Type': 'application/octet-stream'
          },
          body: chunkData
        });

        if (!response.ok) {
          throw new Error(`Chunk ${chunkIndex} upload failed: ${response.statusText}`);
        }

        const result = await response.json();

        // Update progress
        this.uploadedChunks = result.receivedChunks;
        this.uploadedSize += chunkData.length;

        const chunkTime = Date.now() - chunkStart;
        this.metrics.chunkTimes.push(chunkTime);

        // Notify progress
        this.config.onProgress(this.uploadedSize, this.getTotalSize());
        this.config.onChunkComplete(chunkIndex, chunkData.length, chunkTime);

        return result;

      } catch (error) {
        retries++;
        this.metrics.totalRetries++;
        this.metrics.errors.push({ chunkIndex, error: error.message, retry: retries });

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
          averageChunkTime: this.metrics.chunkTimes.reduce((a, b) => a + b, 0) / this.metrics.chunkTimes.length
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

    if (timeDelta >= 500) { // Update speed every 500ms
      const instantSpeed = (bytesDelta / timeDelta) * 1000; // bytes per second

      // Keep a rolling average of the last 10 speed samples
      this.speedSamples.push(instantSpeed);
      if (this.speedSamples.length > 10) {
        this.speedSamples.shift();
      }

      // Calculate average speed from samples
      this.currentSpeed = this.speedSamples.reduce((sum, speed) => sum + speed, 0) / this.speedSamples.length;

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
        onProgress: (uploaded, total) => {
          this.progress = [uploaded, total];
          this.calculateSpeed(uploaded);
          this.emit('progress');
        },
        onChunkComplete: (chunkIndex, chunkSize, duration) => {
          console.log(`Chunk ${chunkIndex} uploaded: ${chunkSize} bytes in ${duration}ms`);
        },
        onError: (error) => {
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
