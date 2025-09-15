const testEndpoint = async () => {
  const baseUrl = 'https://gh-bot.hacolby.workers.dev';

  console.log('Testing Analysis Endpoint Fixes');
  console.log('================================');

  // Test 1: Valid repo (should return 200 now instead of 404)
  try {
    const response1 = await fetch(`${baseUrl}/research/analysis?repo=cloudflare/workers-sdk`);
    console.log(`\n1. Valid repo test: Status ${response1.status}`);
    const data1 = await response1.json();
    console.log(`   Message: ${data1.message || data1.error || 'No message'}`);
    if (response1.status === 200) {
      console.log('   ✅ FIXED: Returns 200 instead of 404');
    } else {
      console.log(`   ❌ Still returning ${response1.status}`);
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
  }

  // Test 2: SQL injection (should return 400)
  try {
    const response2 = await fetch(`${baseUrl}/research/analysis?repo=${encodeURIComponent("'; DROP TABLE projects; --")}`);
    console.log(`\n2. SQL injection test: Status ${response2.status}`);
    const data2 = await response2.json();
    console.log(`   Message: ${data2.message || data2.error || 'No message'}`);
    if (response2.status === 400) {
      console.log('   ✅ FIXED: SQL injection blocked with 400');
    } else {
      console.log(`   ❌ Unexpected status: ${response2.status}`);
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
  }

  // Test 3: Invalid format (should return 400)
  try {
    const response3 = await fetch(`${baseUrl}/research/analysis?repo=invalid-format`);
    console.log(`\n3. Invalid format test: Status ${response3.status}`);
    const data3 = await response3.json();
    console.log(`   Message: ${data3.message || data3.error || 'No message'}`);
    if (response3.status === 400) {
      console.log('   ✅ GOOD: Invalid format rejected');
    } else {
      console.log(`   ❌ Unexpected status: ${response3.status}`);
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
  }

  console.log('\n================================');
  console.log('Test completed!');
};

testEndpoint();
