/**
 * Test script to verify chunked uploads are working
 * Run this in your browser console after uploading a file
 */

// Test function to check if chunked upload endpoints are working
async function testChunkedUploadEndpoints() {
  console.log('🧪 Testing chunked upload endpoints...');

  try {
    // Test health endpoint
    const healthResponse = await fetch('/api/upload/chunked/health');
    const healthData = await healthResponse.json();

    console.log('✅ Health endpoint working:', healthData.status);
    console.log('📊 Active uploads:', healthData.activeUploads);
    console.log('📈 Total uploads:', healthData.totalUploads);

    return true;
  } catch (error) {
    console.error('❌ Chunked upload endpoints not available:', error);
    return false;
  }
}

// Function to monitor network requests during upload
function monitorChunkedUploads() {
  console.log('🔍 Monitoring network requests for chunked uploads...');
  console.log('📝 Instructions:');
  console.log('1. Upload a file > 10MB to see chunked upload in action');
  console.log('2. Check Network tab in DevTools');
  console.log('3. Look for these patterns:');
  console.log('   - POST /api/upload/chunked/init (initialization)');
  console.log('   - PUT /api/upload/chunked/chunk (multiple chunk uploads)');
  console.log('   - POST /api/upload/chunked/finalize (completion)');
  console.log('4. Files < 10MB will use traditional WebSocket upload');

  // Override fetch to log chunked upload requests
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    const url = args[0];
    if (typeof url === 'string' && url.includes('/api/upload/chunked/')) {
      const method = args[1] && args[1].method ? args[1].method : 'GET';
      console.log(`🔗 Chunked upload request: ${method} ${url}`);

      if (url.includes('/chunk')) {
        const headers = (args[1] && args[1].headers) ? args[1].headers : {};
        console.log(`   📦 Chunk ${headers['X-Chunk-Index']}/${headers['X-Total-Chunks']}`);
      }
    }
    return originalFetch.apply(this, args);
  };

  console.log('✅ Network monitoring active. Upload a file to see chunked requests.');
}

// Auto-run tests
console.log('🚀 Chunked Upload Verification Script');
console.log('=====================================');

testChunkedUploadEndpoints().then(working => {
  if (working) {
    monitorChunkedUploads();
  }
});

// Export functions for manual testing
window.sendTestUtils = {
  testChunkedUploadEndpoints,
  monitorChunkedUploads,

  // Test function to create a large file for testing
  createTestFile: function(sizeMB = 15) {
    const size = sizeMB * 1024 * 1024;
    const array = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      array[i] = Math.floor(Math.random() * 256);
    }
    const blob = new Blob([array], { type: 'application/octet-stream' });
    const file = new File([blob], `test-file-${sizeMB}MB.bin`, { type: 'application/octet-stream' });

    console.log(`📁 Created test file: ${file.name} (${file.size} bytes)`);
    console.log('📋 To test: Drag and drop this file onto the Send upload area');

    return file;
  },

  // Check current upload method
  checkUploadMethod: function(fileSize) {
    const useChunked = fileSize > 10 * 1024 * 1024;
    const method = useChunked ? 'Chunked Upload' : 'WebSocket Upload';
    const sizeStr = (fileSize / 1024 / 1024).toFixed(1) + 'MB';

    console.log(`📊 File size: ${sizeStr}`);
    console.log(`📤 Upload method: ${method}`);
    console.log(`🔄 Chunked: ${useChunked ? 'Yes' : 'No'}`);

    return { useChunked, method, size: sizeStr };
  }
};

console.log('📋 Available test functions in window.sendTestUtils:');
console.log('   - testChunkedUploadEndpoints()');
console.log('   - monitorChunkedUploads()');
console.log('   - createTestFile(sizeMB)');
console.log('   - checkUploadMethod(fileSize)');
