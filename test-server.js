import { spawn } from 'child_process';

console.log('Testing Parcel MCP Server...\n');
console.log('Testing with PARCEL_API_KEY environment variable (testing mode):\n');

const child = spawn('node', ['./dist/index.js'], {
  env: { ...process.env, PARCEL_API_KEY: 'test-api-key' },
  stdio: ['pipe', 'pipe', 'pipe']
});

const initMessage = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' }
  }
});

child.stdin.write(initMessage + '\n');

let output = '';
child.stdout.on('data', (data) => {
  output += data.toString();
  try {
    const response = JSON.parse(output);
    if (response.result) {
      console.log('✅ Server initialized successfully');
      console.log('✅ Server name:', response.result.serverInfo?.name || 'parcel-tracking');
      console.log('✅ Server version:', response.result.serverInfo?.version || '1.0.0');
      console.log('✅ Capabilities:', JSON.stringify(response.result.capabilities, null, 2));
      console.log('\nServer is ready for Smithery deployment!');
      console.log('\nConfiguration:');
      console.log('- Production: API key provided via Smithery config during installation');
      console.log('- Testing: Set PARCEL_API_KEY environment variable');
      console.log('\nTo deploy:');
      console.log('1. Push to GitHub');
      console.log('2. Deploy via smithery.ai dashboard');
      console.log('3. Install with: smithery install parcel-mcp-server --client <your-client>');
      child.kill();
      process.exit(0);
    }
  } catch (e) {
  }
});

child.stderr.on('data', (data) => {
  const msg = data.toString();
  if (msg.includes('testing mode')) {
    console.log('ℹ️  ' + msg.trim());
  }
});

child.on('error', (error) => {
  console.error('❌ Failed to start server:', error.message);
  process.exit(1);
});

setTimeout(() => {
  console.log('❌ Server initialization timed out');
  child.kill();
  process.exit(1);
}, 10000);
