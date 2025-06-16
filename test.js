require('dotenv').config();
const fetch = require('node-fetch');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log('[DEBUG] URL:', SUPABASE_URL);
console.log('[DEBUG] CHAVE:', SUPABASE_SERVICE_ROLE_KEY?.slice(0, 20));

async function testarRequisicaoDireta() {
  try {
    const url = `${SUPABASE_URL}/rest/v1/candidaturas?select=response_id`;

    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });

    const texto = await res.text();

    console.log('STATUS:', res.status);
    console.log('BODY:', texto);
  } catch (err) {
    console.error('💥 ERRO AO FAZER REQUISIÇÃO:', err.message);
  }
}

testarRequisicaoDireta();
