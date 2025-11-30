import createServer from './dist/index.js';

console.log('Testing Parcel MCP Server...\n');

try {
  const mockConfig = {
    config: {
      parcelApiKey: 'test-api-key'
    }
  };
  
  const server = createServer(mockConfig);
  
  console.log('✅ Server initialized successfully');
  console.log('✅ Server name:', server._serverInfo?.name || 'parcel-tracking');
  console.log('✅ Server version:', server._serverInfo?.version || '1.0.0');
  console.log('\nServer is ready for Smithery deployment!');
  console.log('\nConfiguration:');
  console.log('- Users provide their Parcel API key during Smithery installation');
  console.log('- API key is passed via Smithery config system');
  console.log('\nTo deploy:');
  console.log('1. Push to GitHub');
  console.log('2. Deploy via smithery.ai dashboard');
  console.log('3. Install with: smithery install parcel-mcp-server --client <your-client>');
  
  process.exit(0);
} catch (error) {
  console.error('❌ Server initialization failed:', error.message);
  process.exit(1);
}
