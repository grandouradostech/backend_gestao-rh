require('dotenv').config();
const express = require('express');
const cors = require('cors');
const supabase = require('./supabaseClient');
const { analisarCandidatura, estruturarDados } = require('./services/openai-analise');
const fetch = require('node-fetch');
const axios = require('axios');
const qs = require('qs');

const app = express();
app.use(cors());
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
  console.log('BODY:', JSON.stringify(req.body));
  try {
    // Aceita tanto com wrapper form_response quanto direto
    const response = req.body.form_response || req.body;
    // Garante que response_id nunca é null
    const responseId = response.response_id || response.token || ('id-teste-' + Date.now());
    console.log('response_id:', responseId);
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
        response_id: responseId,
        raw_data: response,
        dados_estruturados,
        analise_ia: analise,
        curriculo_path: caminhoCurriculo,
        tem_curriculo: !!caminhoCurriculo,
        updated_at: new Date().toISOString()
      }, { onConflict: 'response_id' });
    if (error) throw error;

    // Enviar mensagem UltraMsg se status for Reprovado
    let status = analise?.status || analise?.kanban_status || analise?.resultado || null;
    let nome = (dados_estruturados && dados_estruturados.pessoal && dados_estruturados.pessoal.nome) || 'Candidato';
    // Sempre envia para o número fixo fornecido
    const telefone = '+5567992992381';
    if (status && typeof status === 'string' && status.toLowerCase().includes('reprov')) {
      const msg = `Olá, ${nome}! Tudo bem?\n\nAgradecemos por demonstrar interesse em fazer parte da nossa equipe.\nApós análise do seu perfil, não seguiremos com o seu processo no momento.\nDesejamos sucesso na sua jornada profissional!\n\nAtenciosamente,\nGente e Gestão.`;
      const data = qs.stringify({
        "token": "nz7n5zoux1sjduar",
        "to": telefone,
        "body": msg
      });
      const config = {
        method: 'post',
        url: 'https://api.ultramsg.com/instance117326/messages/chat',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: data
      };
      axios(config)
        .then(function (response) {
          console.log('UltraMsg enviado:', JSON.stringify(response.data));
        })
        .catch(function (error) {
          console.error('Erro UltraMsg:', error);
        });
    }

    res.status(200).send('Dados salvos com sucesso!');
  } catch (err) {
    console.error('Erro:', err);
    res.status(500).send('Erro ao processar os dados');
  }
});

// Endpoint PATCH para atualizar status e enviar UltraMsg se reprovado
app.patch('/candidaturas/:response_id/status', async (req, res) => {
  const { response_id } = req.params;
  const { status } = req.body;
  try {
    // Atualiza status no Supabase
    const { data, error } = await supabase
      .from('candidaturas')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('response_id', response_id)
      .select();
    if (error || !data || !data[0]) {
      console.error('Erro ao atualizar status:', error);
      return res.status(500).json({ error: 'Erro ao atualizar status' });
    }
    const candidato = data[0];
    // Busca nome e telefone
    let nome = 'Candidato';
    let telefone = null;
    if (candidato.dados_estruturados && candidato.dados_estruturados.pessoal) {
      nome = candidato.dados_estruturados.pessoal.nome || nome;
      telefone = candidato.dados_estruturados.pessoal.telefone || null;
    }
    // Se reprovado, envia UltraMsg
    if (status && typeof status === 'string' && status.toLowerCase().includes('reprov')) {
      if (telefone) {
        // Normaliza telefone
        telefone = telefone.replace(/[^\d+]/g, '');
        if (!telefone.startsWith('+')) {
          telefone = '+55' + telefone;
        }
        const msg = `Olá, ${nome}! Tudo bem?\n\nAgradecemos por demonstrar interesse em fazer parte da nossa equipe.\nApós análise do seu perfil, não seguiremos com o seu processo no momento.\nDesejamos sucesso na sua jornada profissional!\n\nAtenciosamente,\nGente e Gestão.`;
        const dataMsg = qs.stringify({
          "token": "nz7n5zoux1sjduar",
          "to": telefone,
          "body": msg
        });
        const config = {
          method: 'post',
          url: 'https://api.ultramsg.com/instance117326/messages/chat',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          data: dataMsg
        };
        axios(config)
          .then(function (response) {
            console.log('UltraMsg enviado:', JSON.stringify(response.data));
          })
          .catch(function (error) {
            console.error('Erro UltraMsg:', error);
          });
      } else {
        console.log('Telefone não encontrado para envio UltraMsg');
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Erro PATCH status:', err);
    res.status(500).json({ error: 'Erro ao atualizar status' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
}); 