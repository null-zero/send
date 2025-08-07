import Nanobus from 'nanobus';
import Keychain from './keychain';
import { delay, bytes, streamToArrayBuffer } from './utils';
import { downloadFile, metadata, getApiUrl, reportLink } from './api';
import { blobStream } from './streams';
import Zip from './zip';

export default class FileReceiver extends Nanobus {
  constructor(fileInfo) {
    super('FileReceiver');
    this.keychain = new Keychain(fileInfo.secretKey, fileInfo.nonce);
    if (fileInfo.requiresPassword) {
      this.keychain.setPassword(fileInfo.password, fileInfo.url);
    }
    this.fileInfo = fileInfo;
    this.reset();
  }

  get progressRatio() {
    return this.progress[0] / this.progress[1];
  }

  get progressIndefinite() {
    return this.state !== 'downloading';
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

  cancel() {
    if (this.downloadRequest) {
      this.downloadRequest.cancel();
    }
  }

  reset() {
    this.msg = 'fileSizeProgress';
    this.state = 'initialized';
    this.progress = [0, 1];

    // Speed tracking properties
    this.startTime = null;
    this.lastProgressTime = null;
    this.lastProgressBytes = 0;
    this.speedSamples = [];
    this.currentSpeed = 0;
  }

  async getMetadata() {
    try {
      // Validate that we have a valid keychain
      if (!this.keychain || !this.keychain.nonce) {
        throw new Error('Invalid keychain configuration');
      }

      const meta = await metadata(this.fileInfo.id, this.keychain);

      this.fileInfo.name = meta.name;
      this.fileInfo.type = meta.type;
      this.fileInfo.iv = meta.iv;
      this.fileInfo.size = +meta.size;
      this.fileInfo.manifest = meta.manifest;
      this.state = 'ready';
    } catch (error) {
      console.error('💥 Error in getMetadata:', error);
      console.error('📋 Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack,
        constructor: error.constructor.name
      });

      // Handle OperationError specifically - often indicates corrupted crypto state
      if (error instanceof DOMException && error.name === 'OperationError') {
        console.error('🚨 OperationError detected - possible crypto key corruption');

        // Try to recreate the keychain with fresh crypto keys
        try {
          const originalFileInfo = { ...this.fileInfo };
          this.keychain = new Keychain(originalFileInfo.secretKey, originalFileInfo.nonce);
          if (originalFileInfo.requiresPassword) {
            this.keychain.setPassword(originalFileInfo.password, originalFileInfo.url);
          }

          // Retry once with the new keychain
          const meta = await metadata(this.fileInfo.id, this.keychain);

          this.fileInfo.name = meta.name;
          this.fileInfo.type = meta.type;
          this.fileInfo.iv = meta.iv;
          this.fileInfo.size = +meta.size;
          this.fileInfo.manifest = meta.manifest;
          this.state = 'ready';
          return;
        } catch (retryError) {
          console.error('💥 Keychain recreation failed:', retryError);
          throw new Error('Cryptographic operation failed - file may be corrupted or inaccessible');
        }
      }

      // Convert other DOMExceptions to more meaningful errors
      if (error instanceof DOMException) {
        console.error('🚨 DOMException detected:', {
          name: error.name,
          message: error.message,
          code: error.code
        });

        // Create a more specific error message based on the DOMException
        if (error.name === 'NetworkError' || error.message.includes('network')) {
          throw new Error('Network connection failed');
        } else if (error.name === 'AbortError') {
          throw new Error('Request was cancelled');
        } else if (error.name === 'TimeoutError') {
          throw new Error('Request timed out');
        } else if (error.name === 'NotSupportedError') {
          throw new Error('Crypto operation not supported');
        } else if (error.name === 'InvalidAccessError') {
          throw new Error('Invalid cryptographic key');
        } else {
          throw new Error(`Connection error: ${error.message}`);
        }
      }

      // Re-throw other errors as-is
      throw error;
    }
  }

  async reportLink(reason) {
    await reportLink(this.fileInfo.id, this.keychain, reason);
  }

  async sendMessageToSw(msg) {
    // Check if service worker is available
    if (!navigator.serviceWorker) {
      throw new Error('Service worker not supported');
    }

    try {
      // Wait for service worker to be ready
      await navigator.serviceWorker.ready;
    } catch (e) {
      throw new Error('Service worker not ready');
    }

    // Check if service worker controller is available
    if (!navigator.serviceWorker.controller) {
      throw new Error('Service worker controller not available');
    }

    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();

      // Set up timeout to prevent hanging
      const timeout = setTimeout(() => {
        reject(new Error('Service worker communication timeout'));
      }, 10000); // 10 second timeout

      channel.port1.onmessage = function(event) {
        clearTimeout(timeout);
        if (event.data === undefined) {
          reject(new Error('bad response from serviceWorker'));
        } else if (event.data.error !== undefined) {
          reject(new Error(event.data.error));
        } else {
          resolve(event.data);
        }
      };

      try {
        navigator.serviceWorker.controller.postMessage(msg, [channel.port2]);
      } catch (error) {
        clearTimeout(timeout);
        reject(new Error(`Failed to send message to service worker: ${error.message}`));
      }
    });
  }

  async downloadBlob(noSave = false) {
    this.state = 'downloading';
    this.downloadRequest = await downloadFile(
      this.fileInfo.id,
      this.keychain,
      p => {
        this.progress = [p, this.fileInfo.size];
        this.calculateSpeed(p);
        this.emit('progress');
      }
    );
    try {
      const ciphertext = await this.downloadRequest.result;
      this.downloadRequest = null;
      this.msg = 'decryptingFile';
      this.state = 'decrypting';
      this.emit('decrypting');
      let size = this.fileInfo.size;
      let plainStream = this.keychain.decryptStream(blobStream(ciphertext));
      if (this.fileInfo.type === 'send-archive') {
        const zip = new Zip(this.fileInfo.manifest, plainStream);
        plainStream = zip.stream;
        size = zip.size;
      }
      const plaintext = await streamToArrayBuffer(plainStream, size);
      if (!noSave) {
        await saveFile({
          plaintext,
          name: decodeURIComponent(this.fileInfo.name),
          type: this.fileInfo.type
        });
      }
      this.msg = 'downloadFinish';
      this.emit('complete');
      this.state = 'complete';
    } catch (e) {
      this.downloadRequest = null;
      throw e;
    }
  }

  async downloadStream(noSave = false) {
    const start = Date.now();
    const onprogress = p => {
      this.progress = [p, this.fileInfo.size];
      this.calculateSpeed(p);
      this.emit('progress');
    };

    this.downloadRequest = {
      cancel: () => {
        try {
          this.sendMessageToSw({ request: 'cancel', id: this.fileInfo.id });
        } catch (e) {
          console.warn('Failed to send cancel message to service worker:', e);
        }
      }
    };

    try {
      this.state = 'downloading';

      const info = {
        request: 'init',
        id: this.fileInfo.id,
        filename: this.fileInfo.name,
        type: this.fileInfo.type,
        manifest: this.fileInfo.manifest,
        key: this.fileInfo.secretKey,
        requiresPassword: this.fileInfo.requiresPassword,
        password: this.fileInfo.password,
        url: this.fileInfo.url,
        size: this.fileInfo.size,
        nonce: this.keychain.nonce,
        noSave
      };

      // Try to initialize service worker communication with fallback
      try {
        await this.sendMessageToSw(info);
      } catch (swError) {
        console.warn('Service worker initialization failed, falling back to blob download:', swError);
        // Fall back to blob download if service worker is not available
        return this.downloadBlob(noSave);
      }

      onprogress(0);

      if (noSave) {
        const res = await fetch(getApiUrl(`/api/download/${this.fileInfo.id}`));
        if (res.status !== 200) {
          throw new Error(res.status);
        }
      } else {
        const downloadPath = `/api/download/${this.fileInfo.id}`;
        let downloadUrl = getApiUrl(downloadPath);
        if (downloadUrl === downloadPath) {
          downloadUrl = `${location.protocol}//${location.host}${downloadPath}`;
        }
        const a = document.createElement('a');
        a.href = downloadUrl;
        document.body.appendChild(a);
        a.click();
      }

      let prog = 0;
      let hangs = 0;
      while (prog < this.fileInfo.size) {
        let msg;
        try {
          msg = await this.sendMessageToSw({
            request: 'progress',
            id: this.fileInfo.id
          });
        } catch (swError) {
          console.warn('Service worker progress check failed:', swError);
          // If service worker communication fails, break the loop and complete the download
          break;
        }

        if (msg && msg.progress === prog) {
          hangs++;
        } else if (msg) {
          hangs = 0;
          prog = msg.progress;
        }

        if (hangs > 30) {
          // TODO: On Chrome we don't get a cancel
          // signal so one is indistinguishable from
          // a hang. We may be able to detect
          // which end is hung in the service worker
          // to improve on this.
          const e = new Error('hung download');
          e.duration = Date.now() - start;
          e.size = this.fileInfo.size;
          e.progress = prog;
          throw e;
        }

        if (msg) {
          onprogress(msg.progress);
        }
        await delay(1000);
      }

      this.downloadRequest = null;
      this.msg = 'downloadFinish';
      this.emit('complete');
      this.state = 'complete';
    } catch (e) {
      this.downloadRequest = null;
      if (e === 'cancelled' || e.message === '400') {
        throw new Error(0);
      }
      throw e;
    }
  }

  download(options) {
    if (options.stream) {
      return this.downloadStream(options.noSave);
    }
    return this.downloadBlob(options.noSave);
  }
}

async function saveFile(file) {
  return new Promise(function(resolve, reject) {
    const dataView = new DataView(file.plaintext);
    const blob = new Blob([dataView], { type: file.type });

    if (navigator.msSaveBlob) {
      navigator.msSaveBlob(blob, file.name);
      return resolve();
    } else {
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      URL.revokeObjectURL(downloadUrl);
      setTimeout(resolve, 100);
    }
  });
}
