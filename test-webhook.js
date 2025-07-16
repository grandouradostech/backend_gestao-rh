// Script para testar o webhook de provas
const axios = require('axios');

const TEST_URL = 'https://backend-gestao-rh-mdmw.onrender.com/webhook-score-prova';
// const TEST_URL = 'http://localhost:3000/webhook-score-prova'; // Para teste local

const testPayload = {
  form_response: {
    form_id: 'OrKerl6D', // Português e matemática
    answers: [
      {
        field: {
          id: 'syzxhm3Z3iGG'
        },
        text: 'João Silva Teste'
      },
      {
        field: {
          id: 'dcpqtJoWbXds'
        },
        text: '12345678901'
      }
    ],
    variables: [
      {
        key: 'quiz_score',
        number: 85
      }
    ]
  }
};

async function testWebhook() {
  try {
    console.log('🧪 Testando webhook de provas...');
    console.log('URL:', TEST_URL);
    console.log('Payload:', JSON.stringify(testPayload, null, 2));
    
    const response = await axios.post(TEST_URL, testPayload, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    console.log('✅ Sucesso!');
    console.log('Status:', response.status);
    console.log('Resposta:', response.data);
    
  } catch (error) {
    console.log('❌ Erro no teste:');
    if (error.response) {
      console.log('Status:', error.response.status);
      console.log('Dados:', error.response.data);
    } else {
      console.log('Erro:', error.message);
    }
  }
}

// Testar health check também
async function testHealthCheck() {
  try {
    const healthUrl = TEST_URL.replace('/webhook-score-prova', '/');
    console.log('\n🏥 Testando health check...');
    console.log('URL:', healthUrl);
    
    const response = await axios.get(healthUrl, {
      timeout: 5000
    });
    
    console.log('✅ Health check OK!');
    console.log('Status:', response.status);
    console.log('Resposta:', response.data);
    
  } catch (error) {
    console.log('❌ Erro no health check:');
    console.log('Erro:', error.message);
  }
}

// Executar testes
async function runTests() {
  await testHealthCheck();
  await testWebhook();
}

runTests(); 