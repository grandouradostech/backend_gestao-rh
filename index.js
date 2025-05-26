require('dotenv').config();
const express = require('express');
const supabase = require('./supabaseClient');
const { analisarCandidatura, estruturarDados } = require('./services/openai-analise');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

async function processarAnexos(response) {
  try {
    const campoCurriculo = response.answers.find(a => 
      a.field.id === 'dmlXVJZuZ7BH' // ID do campo de currículo
    );
    if (!campoCurriculo) return null;
    if (campoCurriculo.type !== 'file_url' || !campoCurriculo.file_url) return null;
    const fileUrl = campoCurriculo.file_url;
    const fileName = fileUrl.split('/').pop();
    const ext = fileName.split('.').pop().toLowerCase();
    let contentType = 'application/octet-stream';
    if (ext === 'pdf') contentType = 'application/pdf';
    if (['jpg', 'jpeg'].includes(ext)) contentType = 'image/jpeg';
    if (ext === 'png') contentType = 'image/png';
    const resposta = await fetch(fileUrl, {
      headers: { Authorization: `Bearer ${process.env.TYPEFORM_TOKEN}` }
    });
    if (!resposta.ok) return null;
    const buffer = await resposta.buffer();
    const { data, error } = await supabase.storage
      .from('curriculo')
      .upload(
        `${response.response_id}/${fileName}`,
        buffer,
        { 
          contentType,
          upsert: true,
          cacheControl: '3600'
        }
      );
    if (error) return null;
    return `${response.response_id}/${fileName}`;
  } catch (error) {
    return null;
  }
}

// Rota para receber webhook do Typeform
app.post('/typeform-webhook', async (req, res) => {
  try {
    const response = req.body.form_response;
    // Upload currículo
    const caminhoCurriculo = await processarAnexos(response);
    // Estruturar dados
    let dados_estruturados = null;
    try {
      dados_estruturados = await estruturarDados(response);
    } catch (e) {
      console.error('Erro ao estruturar dados:', e.message);
    }
    // Analisar candidatura
    const analise = await analisarCandidatura(response, caminhoCurriculo);
    // Salvar no Supabase
    const { error } = await supabase
      .from('candidaturas')
      .upsert({
        response_id: response.response_id,
        raw_data: response,
        dados_estruturados,
        analise_ia: analise,
        curriculo_path: caminhoCurriculo,
        tem_curriculo: !!caminhoCurriculo,
        updated_at: new Date().toISOString()
      }, { onConflict: 'response_id' });
    if (error) throw error;
    res.status(200).send('Dados salvos com sucesso!');
  } catch (err) {
    console.error('Erro:', err);
    res.status(500).send('Erro ao processar os dados');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
}); 