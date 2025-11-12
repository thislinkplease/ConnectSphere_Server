/**
 * Test Script for Payment & Subscription System
 * 
 * This script demonstrates the payment flow and can be used to manually test
 * the payment endpoints without needing the client app.
 * 
 * Prerequisites:
 * - Server must be running
 * - User must exist in database
 * - Set BASE_URL and TEST_USERNAME below
 */

const BASE_URL = 'http://localhost:3000'; // Change to your server URL
const TEST_USERNAME = 'testuser'; // Change to existing username

async function testPaymentFlow() {
  console.log('🧪 Starting Payment Flow Test\n');
  
  try {
    // 1. Get available plans
    console.log('1️⃣ Getting available plans...');
    const plansRes = await fetch(`${BASE_URL}/payments/plans`);
    const { plans } = await plansRes.json();
    console.log('✅ Plans:', plans.map(p => `${p.name} - ${p.price} ${p.currency}`).join(', '));
    console.log('');
    
    // 2. Get current subscription (should be free or create new)
    console.log('2️⃣ Getting current subscription...');
    const subRes = await fetch(`${BASE_URL}/payments/subscription?username=${TEST_USERNAME}`);
    const currentSub = await subRes.json();
    console.log('✅ Current subscription:', currentSub.plan_type, '(status:', currentSub.status + ')');
    console.log('');
    
    // 3. Get user profile to check current settings
    console.log('3️⃣ Checking user profile before upgrade...');
    const userRes = await fetch(`${BASE_URL}/users/username/${TEST_USERNAME}`);
    const userBefore = await userRes.json();
    console.log('✅ User settings:');
    console.log('   - is_premium:', userBefore.is_premium);
    console.log('   - max_friends:', userBefore.max_friends);
    console.log('   - theme_preference:', userBefore.theme_preference);
    console.log('');
    
    // 4. Subscribe to Pro plan
    console.log('4️⃣ Subscribing to Pro plan...');
    const subscribeRes = await fetch(`${BASE_URL}/payments/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: TEST_USERNAME,
        plan_type: 'pro',
        payment_method: 'test'
      })
    });
    const subscribeResult = await subscribeRes.json();
    console.log('✅ Subscription successful!');
    console.log('   - Plan:', subscribeResult.subscription.plan_type);
    console.log('   - Status:', subscribeResult.subscription.status);
    console.log('   - Start date:', subscribeResult.subscription.start_date);
    console.log('   - End date:', subscribeResult.subscription.end_date);
    console.log('   - Transaction amount:', subscribeResult.transaction.amount, subscribeResult.transaction.currency);
    console.log('');
    
    // 5. Verify user profile updated
    console.log('5️⃣ Verifying user profile after upgrade...');
    const userAfterRes = await fetch(`${BASE_URL}/users/username/${TEST_USERNAME}`);
    const userAfter = await userAfterRes.json();
    console.log('✅ User settings updated:');
    console.log('   - is_premium:', userAfter.is_premium);
    console.log('   - max_friends:', userAfter.max_friends);
    console.log('   - theme_preference:', userAfter.theme_preference);
    console.log('');
    
    // 6. Get payment history
    console.log('6️⃣ Getting payment history...');
    const historyRes = await fetch(`${BASE_URL}/payments/history?username=${TEST_USERNAME}`);
    const history = await historyRes.json();
    console.log('✅ Payment history:');
    history.forEach((tx, i) => {
      console.log(`   ${i + 1}. ${tx.amount} ${tx.currency} - ${tx.status} (${new Date(tx.transaction_date).toLocaleDateString()})`);
    });
    console.log('');
    
    // 7. Cancel subscription
    console.log('7️⃣ Cancelling subscription...');
    const cancelRes = await fetch(`${BASE_URL}/payments/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: TEST_USERNAME })
    });
    const cancelResult = await cancelRes.json();
    console.log('✅ Subscription cancelled');
    console.log('   - Plan:', cancelResult.subscription.plan_type);
    console.log('   - Status:', cancelResult.subscription.status);
    console.log('');
    
    // 8. Verify downgrade
    console.log('8️⃣ Verifying downgrade to Free plan...');
    const userFinalRes = await fetch(`${BASE_URL}/users/username/${TEST_USERNAME}`);
    const userFinal = await userFinalRes.json();
    console.log('✅ User settings after cancellation:');
    console.log('   - is_premium:', userFinal.is_premium);
    console.log('   - max_friends:', userFinal.max_friends);
    console.log('   - theme_preference:', userFinal.theme_preference);
    console.log('');
    
    console.log('🎉 Payment flow test completed successfully!\n');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error);
  }
}

// Run the test if executed directly
if (require.main === module) {
  console.log('⚠️  Make sure to:');
  console.log('   1. Start the server');
  console.log('   2. Create a test user in the database');
  console.log('   3. Update BASE_URL and TEST_USERNAME in this file');
  console.log('');
  
  // Wait a bit for user to read the warning
  setTimeout(() => {
    testPaymentFlow();
  }, 2000);
}

module.exports = { testPaymentFlow };
