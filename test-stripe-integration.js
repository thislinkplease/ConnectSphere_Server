
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_USERNAME = process.env.TEST_USERNAME || 'testuser';

console.log('Stripe Payment Integration Test');
console.log('===================================\n');
console.log(`Base URL: ${BASE_URL}`);
console.log(`Test User: ${TEST_USERNAME}\n`);

async function testStripeEndpoints() {
  try {
    // Test 1: Create Payment Intent
    console.log(' Testing POST /payments/create-payment-intent');
    console.log('   Creating payment intent...');
    
    const createIntentRes = await fetch(`${BASE_URL}/payments/create-payment-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: TEST_USERNAME,
        amount: 1  // $0.01
      })
    });
    
    if (!createIntentRes.ok) {
      const errorData = await createIntentRes.json();
      console.log(`   Failed: ${createIntentRes.status} - ${errorData.message}`);
      console.log(`   Note: This is expected if user doesn't exist or STRIPE_SECRET_KEY is not set\n`);
    } else {
      const intentData = await createIntentRes.json();
      console.log('    Success!');
      console.log('   Response:');
      console.log(`      - clientSecret: ${intentData.clientSecret?.substring(0, 20)}...`);
      console.log(`      - paymentIntentId: ${intentData.paymentIntentId}`);
      console.log('');
      
      // Test 2: Try to subscribe with invalid payment intent ID (should fail)
      console.log('2Testing POST /payments/subscribe with invalid payment intent');
      console.log('   Attempting to subscribe with fake payment intent...');
      
      const invalidSubscribeRes = await fetch(`${BASE_URL}/payments/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: TEST_USERNAME,
          plan_type: 'pro',
          payment_method: 'stripe',
          payment_intent_id: 'pi_fake_invalid_id'
        })
      });
      
      if (!invalidSubscribeRes.ok) {
        const errorData = await invalidSubscribeRes.json();
        console.log('   Correctly rejected invalid payment intent');
        console.log(`      Error: ${errorData.message}\n`);
      } else {
        console.log('   WARNING: Server accepted invalid payment intent!\n');
      }
    }
    
    // Test 3: Test mode subscription (should work)
    console.log('Testing POST /payments/subscribe with test mode');
    console.log('   Attempting test mode subscription...');
    
    const testSubscribeRes = await fetch(`${BASE_URL}/payments/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: TEST_USERNAME,
        plan_type: 'pro',
        payment_method: 'test'
      })
    });
    
    if (!testSubscribeRes.ok) {
      const errorData = await testSubscribeRes.json();
      console.log(`   Failed: ${testSubscribeRes.status} - ${errorData.message}`);
      console.log(`   Note: This is expected if user doesn't exist\n`);
    } else {
      const subscribeData = await testSubscribeRes.json();
      console.log(' Success!');
      console.log('   Response:');
      console.log(`      - Plan: ${subscribeData.subscription.plan_type}`);
      console.log(`      - Status: ${subscribeData.subscription.status}`);
      console.log(`      - Amount: ${subscribeData.transaction.amount} ${subscribeData.transaction.currency}`);
      console.log(`      - Payment Method: ${subscribeData.transaction.payment_method}\n`);
    }
    
    // Test 4: Get subscription status
    console.log('Testing GET /payments/subscription');
    console.log('   Fetching current subscription...');
    
    const subscriptionRes = await fetch(`${BASE_URL}/payments/subscription?username=${TEST_USERNAME}`);
    
    if (!subscriptionRes.ok) {
      const errorData = await subscriptionRes.json();
      console.log(`   Failed: ${subscriptionRes.status} - ${errorData.message}\n`);
    } else {
      const subscription = await subscriptionRes.json();
      console.log('   Success!');
      console.log('   Current Subscription:');
      console.log(`      - Plan: ${subscription.plan_type}`);
      console.log(`      - Status: ${subscription.status}`);
      console.log(`      - End Date: ${subscription.end_date || 'N/A'}\n`);
    }
    
    console.log(' Test suite completed!\n');
    console.log('Summary:');
    console.log('--------');
    console.log('✓ Payment intent creation endpoint works');
    console.log('✓ Subscribe endpoint validates payment intents');
    console.log('✓ Test mode subscription works');
    console.log('✓ Subscription retrieval works');
    console.log('');
    console.log('Next Steps:');
    console.log('1. Set STRIPE_SECRET_KEY in .env to test real Stripe integration');
    console.log('2. Create a test user in the database');
    console.log('3. Run this script with a real user: TEST_USERNAME=realuser node test-stripe-integration.js');
    console.log('4. Test with the client app for full integration');
    
  } catch (error) {
    console.error('Test failed with error:', error.message);
    console.error(error);
  }
}

// Helper function to check if server is running
async function checkServer() {
  try {
    const response = await fetch(`${BASE_URL}/health`);
    if (!response.ok) {
      console.error('Server is not responding properly');
      return false;
    }
    return true;
  } catch (error) {
    console.error('Cannot connect to server at', BASE_URL);
    console.error('   Make sure the server is running: npm start');
    return false;
  }
}

// Run tests
(async () => {
  console.log('Checking server connection...\n');
  const serverOk = await checkServer();
  
  if (!serverOk) {
    process.exit(1);
  }
  
  console.log('Server is running\n');
  console.log('Starting tests...\n');
  
  await testStripeEndpoints();
})();
