require('dotenv').config();
const express = require('express');
const cors = require('cors');
const supabase = require('./supabaseClient');
const { analisarCandidatura, estruturarDados } = require('./services/openai-analise');
const fetch = require('node-fetch');
const axios = require('axios');
const qs = require('qs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'your-secret-key';
console.log('JWT_SECRET em uso:', SECRET);
const fs = require('fs');
const path = require('path');
const { extrairCampoTextoPorId, MAPA_CAMPOS, normalizeText } = require('./importar-candidaturas');
const fileUpload = require('express-fileupload');
const setupUsuariosRoutes = require('./usuarios');

const app = express();
app.use(cors());
app.use(express.json());
app.use(fileUpload({
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  abortOnLimit: true,
  useTempFiles: true,
  tempFileDir: '/tmp/'
}));

// Função para verificar e criar bucket avatares
async function ensureAvataresBucket() {
  try {
    // Verificar se o bucket existe
    const { data: buckets, error: listError } = await supabase.storage.listBuckets();
    
    if (listError) {
      console.error('Erro ao listar buckets:', listError);
      return;
    }

    const avataresBucket = buckets.find(bucket => bucket.name === 'avatares');
    
    if (!avataresBucket) {
      console.log('Criando bucket avatares...');
      const { data, error } = await supabase.storage.createBucket('avatares', {
        public: true,
        allowedMimeTypes: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'],
        fileSizeLimit: 5242880 // 5MB
      });
      
      if (error) {
        console.error('Erro ao criar bucket avatares:', error);
      } else {
        console.log('Bucket avatares criado com sucesso');
      }
    } else {
      console.log('Bucket avatares já existe');
    }
  } catch (error) {
    console.error('Erro ao verificar/criar bucket avatares:', error);
  }
}

// Verificar bucket na inicialização
ensureAvataresBucket();

async function processarAnexos(response, responseId) {
  try {
    // Buscar campo de currículo nas respostas
    const fileField = response.answers?.find(ans => 
      ans.type === 'file_upload' || 
      ans.field?.type === 'file_upload'
    );

    if (!fileField) {
      return null;
    }

    const fileUrl = fileField.file_url;
    const fileName = fileField.file_name || 'curriculo.pdf';

    // Baixar arquivo do Typeform
    const resposta = await fetch(fileUrl);
    if (!resposta.ok) {
      return null;
    }

    const buffer = await resposta.arrayBuffer();

    // Upload para Supabase Storage
    const { data, error } = await supabase.storage
      .from('curriculos')
      .upload(`${responseId}/${fileName}`, buffer, {
        contentType: 'application/pdf',
        upsert: true
      });

    if (error) {
      return null;
    }

    return `${responseId}/${fileName}`;
  } catch (error) {
    return null;
  }
}

// Middleware de autenticação JWT
function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Token mal formatado' });
  }

  try {
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido' });
  }
}

// Middleware para gestor
function onlyGestor(req, res, next) {
  if (req.user?.role !== 'gestor') return res.status(403).json({ error: 'Apenas gestor pode realizar esta ação' });
  next();
}

// Função para padronizar nome da vaga (igual frontend)
function padronizarVaga(vaga) {
  let v = (vaga || '').normalize('NFD').replace(/\u0300-\u036f/g, '').toLowerCase().trim();
  if (v === 'auxiliar de entrega' || v === 'auxiliar de distribuicao') v = 'auxiliar de distribuicao';
  if (v === 'motorista de entrega' || v === 'motorista de distribuicao') v = 'motorista de distribuicao';
  if (v === 'assistente financeiro') v = 'auxiliar financeiro';
  return v;
}

// Funções auxiliares do webhook de provas
function normalizeCpf(cpf) {
  return (cpf || '').replace(/\D/g, '');
}
function normalizeNomeParaComparacao(nome) {
  return (nome || '')
    .normalize('NFD')
    .replace(/\u0300-\u036f/g, '')
    .replace(/[^ -\x7f\w\s-]/g, '')
    .replace(/[\s]+/g, ' ')
    .toLowerCase()
    .trim();
}
function nomesParecidos(nomeA, nomeB) {
  if (!nomeA || !nomeB) return false;
  const a = normalizeNomeParaComparacao(nomeA);
  const b = normalizeNomeParaComparacao(nomeB);
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const palavrasA = a.split(' ');
  const palavrasB = b.split(' ');
  const iguais = palavrasA.filter(p => palavrasB.includes(p)).length;
  const minLen = Math.min(palavrasA.length, palavrasB.length);
  return minLen > 0 && (iguais / minLen) >= 0.8;
}

// Rota para receber webhook do Typeform (multi-formulário, análise IA completa)
app.post('/typeform-webhook', async (req, res) => {
  try {
    const response = req.body.form_response || req.body;
    const formId = response.form_id;
    const FORM_IDS = ['ynFUyrAc', 'i6GB06nW', 'OejwZ32V'];
    
    if (!FORM_IDS.includes(formId)) {
      return res.status(400).json({ error: 'form_id não permitido' });
    }

    // Garante que response_id nunca é null
    const responseId = response.response_id || response.token || ('id-teste-' + Date.now());
    
    // --- NOVO: Só processa se for o 502º ou posterior ---
    // Busca todas as respostas desse formulário
    let totalRespostas = 0;
    try {
      const resTypeform = await fetch(`https://api.typeform.com/forms/${formId}/responses?page_size=1000`, {
        headers: { Authorization: `Bearer ${process.env.TYPEFORM_TOKEN}` }
      });
      if (resTypeform.ok) {
        const dataTypeform = await resTypeform.json();
        const todasIds = (dataTypeform.items || []).map(item => item.response_id);
        const idx = todasIds.indexOf(responseId);
        totalRespostas = todasIds.length;
        if (idx > -1 && idx < 501) {
          console.log(`[WEBHOOK] Ignorando resposta ${responseId} (posição ${idx+1} < 502)`);
          return res.status(200).json({ success: true, ignored: true, reason: 'Abaixo do 502º da lista' });
        }
      }
    } catch (e) {
      console.warn('[WEBHOOK] Não foi possível checar posição do candidato na lista Typeform:', e.message);
    }
    // --- FIM NOVO ---

    console.log(`[WEBHOOK] Processando resposta do formulário ${formId} (ID: ${responseId})`);

    // Processar anexos (currículo)
    const caminhoCurriculo = await processarAnexos(response, responseId);
    
    // Estruturar dados
    let dados_estruturados = null;
    try {
      dados_estruturados = await estruturarDados(response);
    } catch (e) {
      console.error('[WEBHOOK] Erro ao estruturar dados:', e.message);
    }

    // Extrair campos usando o mesmo MAPA_CAMPOS do importar-candidaturas
    const nome = extrairCampoTextoPorId(formId, response.answers, MAPA_CAMPOS, 'nome') || 'Não identificado';
    const cpf = extrairCampoTextoPorId(formId, response.answers, MAPA_CAMPOS, 'cpf');
    const telefone = extrairCampoTextoPorId(formId, response.answers, MAPA_CAMPOS, 'telefone');
    const email = extrairCampoTextoPorId(formId, response.answers, MAPA_CAMPOS, 'email');

    // Checagem de duplicidade de CPF
    if (cpf) {
      const { data: candidatosCpf, error: erroCpf } = await supabase
        .from('candidaturas')
        .select('id')
        .eq('dados_estruturados->pessoal->>cpf', cpf);
      if (!erroCpf && candidatosCpf && candidatosCpf.length > 0) {
        console.log(`[WEBHOOK] ⚠️ Candidato com CPF ${cpf} já existe no sistema. Pulando response_id ${responseId}`);
        return res.status(200).json({ success: true, ignored: true, reason: 'CPF já existe' });
      }
    }

    // Extrair data de nascimento e idade
    const dataNascimentoTexto = extrairCampoTextoPorId(formId, response.answers, MAPA_CAMPOS, 'dataNascimento');
    const dataNascimento = dataNascimentoTexto ? require('./importar-candidaturas').extrairDataNascimento(dataNascimentoTexto) : null;
    const idade = dataNascimento ? require('./importar-candidaturas').calcularIdade(dataNascimento) : null;

    if (!dados_estruturados.pessoal) dados_estruturados.pessoal = {};
    dados_estruturados.pessoal.nome = nome;
    dados_estruturados.pessoal.cpf = cpf;
    dados_estruturados.pessoal.telefone = telefone;
    dados_estruturados.pessoal.email = email;
    dados_estruturados.pessoal.data_nascimento = dataNascimento;
    dados_estruturados.pessoal.idade = idade;

    if (dataNascimentoTexto) {
      console.log(`[WEBHOOK] Data de nascimento extraída: "${dataNascimentoTexto}" -> "${dataNascimento}" (Idade: ${idade})`);
    } else {
      console.log(`[WEBHOOK] Campo de data de nascimento não encontrado`);
    }

    // Buscar requisitos da vaga
    let vaga_nome = dados_estruturados?.profissional?.vaga || null;
    let requisitosVaga = null;

    if (vaga_nome) {
      const vaga_normalizada = normalizeText(vaga_nome);
      const { data: todasVagas } = await supabase.from('requisitos').select('*');
      requisitosVaga = todasVagas.find(v => normalizeText(v.vaga_nome) === vaga_normalizada);
    }

    const prompt = requisitosVaga
      ? `Vaga: ${vaga_nome}\nRequisitos: ${requisitosVaga.requisito}\nDiferenciais: ${requisitosVaga.diferencial}\n${caminhoCurriculo ? `\nCurrículo: ${caminhoCurriculo}` : ''}\nAnalise se o candidato atende aos requisitos. Dê um score de 0 a 100.`
      : `Dados do candidato:\n${JSON.stringify(dados_estruturados, null, 2)}`;

    console.log('[WEBHOOK] Analisando candidatura...');
    const analise = await analisarCandidatura({ ...response, prompt_custom: prompt }, caminhoCurriculo, requisitosVaga);

    // Preparar informações de tokens para salvar
    const tokensGastos = {
      analise: analise.tokens_gastos || null,
      estruturacao: dados_estruturados?.tokens_estruturacao || null,
      total_tokens: (analise.tokens_gastos?.total_tokens || 0) + (dados_estruturados?.tokens_estruturacao?.total_tokens || 0),
      timestamp: new Date().toISOString()
    };

    console.log(`[WEBHOOK] Tokens gastos - Análise: ${analise.tokens_gastos?.total_tokens || 0}, Estruturação: ${dados_estruturados?.tokens_estruturacao?.total_tokens || 0}, Total: ${tokensGastos.total_tokens}`);
    console.log('[WEBHOOK] Salvando no banco...');
    const { data: upsertData, error: upsertError } = await supabase.from('candidaturas').upsert({
      response_id: responseId,
      raw_data: response,
      dados_estruturados,
      analise_ia: analise,
      tokens_gastos: tokensGastos,
      curriculo_path: caminhoCurriculo,
      tem_curriculo: !!caminhoCurriculo,
      updated_at: new Date().toISOString(),
      status: response.status || 'Analisado por IA',
      nome
    }, { onConflict: 'response_id' });

    if (upsertError) {
      console.error(`[WEBHOOK] ❌ Erro no upsert response_id ${responseId}:`, upsertError);
      return res.status(500).json({ error: 'Erro ao salvar candidatura' });
    }

    console.log(`[WEBHOOK] ✅ Candidatura ${responseId} processada com sucesso`);
    return res.status(200).json({ success: true, response_id: responseId });

  } catch (error) {
    console.error('[WEBHOOK] 💥 Erro fatal:', error.message);
    return res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Webhook de provas
app.post('/webhook-score-prova', async (req, res) => {
  console.log('Payload recebido:', JSON.stringify(req.body, null, 2));
  try {
    const formResponse = req.body.form_response;
    if (!formResponse) {
      console.error('Payload não contém form_response');
      return res.status(400).json({ error: 'Payload não contém form_response' });
    }
    const formId = formResponse.form_id;
    let nome = null;
    let cpf = null;
    let score = null;

    // IDs dos campos para cada formulário
    let nomeFieldId, cpfFieldId;
    if (formId === 'OrKerl6D') { // Português e matemática
      nomeFieldId = 'syzxhm3Z3iGG';
      cpfFieldId = 'dcpqtJoWbXds';
    } else if (formId === 'Z59Mv1sY') { // Direção
      nomeFieldId = 'cPBR2RtoMRBN';
      cpfFieldId = 'ZwvjaHmu1l0b';
    } else if (formId === 'qWTxbaIK') { // Português p/ ADM
      nomeFieldId = 'wR9LPPhM4Fw5';
      cpfFieldId = 'csRM2ZPjJAuZ';
    } else {
      return res.status(400).json({ error: 'Formulário não reconhecido: ' + formId });
    }

    // Extrair nome e CPF pelos IDs dos campos
    if (Array.isArray(formResponse.answers)) {
      const nomeField = formResponse.answers.find(a => a.field?.id === nomeFieldId);
      if (nomeField) nome = nomeField.text || nomeField.value;
      const cpfField = formResponse.answers.find(a => a.field?.id === cpfFieldId);
      if (cpfField) cpf = cpfField.text || cpfField.value;
    }
    // Extrair score do campo variables (quiz_score)
    if (Array.isArray(formResponse.variables)) {
      const scoreVar = formResponse.variables.find(v => v.key === 'quiz_score');
      if (scoreVar) score = scoreVar.number;
    }

    if (!nome && !cpf) {
      console.error('Não foi possível extrair nome nem CPF do payload.');
      return res.status(400).json({ error: 'Nome ou CPF não encontrados no payload.' });
    }
    if (score === null || score === undefined) {
      console.error('Não foi possível extrair score do payload.');
      return res.status(400).json({ error: 'Score não encontrado no payload.' });
    }

    console.log('Nome extraído:', nome);
    console.log('CPF extraído:', cpf);
    console.log('Score extraído:', score);

    // Busca todos os candidatos com o CPF igual (jsonb)
    let candidato = null;
    let buscaPor = '';
    let candidatosCpf = [];
    if (cpf) {
      const cpfNormalizado = normalizeCpf(cpf);
      const { data: candidatos, error } = await supabase
        .from('candidaturas')
        .select('id, nome, score_prova, status, dados_estruturados, scores_provas');
      if (error) {
        console.error('Erro ao buscar candidatos:', error.message);
        return res.status(500).json({ error: 'Erro ao buscar candidatos.' });
      }
      candidatosCpf = (candidatos || []).filter(c => {
        const cpfBanco = c.dados_estruturados?.pessoal?.cpf || '';
        return normalizeCpf(cpfBanco) === cpfNormalizado;
      });
      if (candidatosCpf.length === 1) {
        candidato = candidatosCpf[0];
        buscaPor = 'cpf (jsonb) único';
      } else if (candidatosCpf.length > 1) {
        // Tenta achar o nome mais parecido
        candidato = candidatosCpf.find(c => nomesParecidos(c.nome, nome));
        if (candidato) {
          buscaPor = 'cpf (jsonb) + nome parecido';
        } else {
          // Se não achou nome parecido, pega o primeiro (mas loga)
          candidato = candidatosCpf[0];
          buscaPor = 'cpf (jsonb) múltiplos, pegou primeiro';
          console.warn('Mais de um candidato com o mesmo CPF, nenhum nome parecido. Atualizando o primeiro.');
        }
      }
    }
    // Se não achou por CPF, tenta por nome (parecido)
    if (!candidato && nome) {
      const { data: candidatosNome, error: errorNome } = await supabase
        .from('candidaturas')
        .select('id, nome, score_prova, status, dados_estruturados, scores_provas');
      if (errorNome) {
        console.error('Erro ao buscar candidatos por nome:', errorNome.message);
        return res.status(500).json({ error: 'Erro ao buscar candidatos por nome.' });
      }
      candidato = (candidatosNome || []).find(c => nomesParecidos(c.nome, nome));
    }

    if (!candidato) {
      console.error('Candidato não encontrado por nome nem CPF.');
      return res.status(404).json({ error: 'Candidato não encontrado por nome nem CPF.' });
    }

    console.log(`Candidato encontrado por ${buscaPor}: ${candidato.nome} (id: ${candidato.id})`);

    // Atualiza scores_provas (JSONB) e mantém status 'Provas'
    // Chave da prova será o formId
    const provaKey = formId;
    // Busca o objeto atual de scores (ou inicia vazio)
    let scoresProvas = candidato.scores_provas || {};
    // Se vier como string, tenta converter
    if (typeof scoresProvas === 'string') {
      try { scoresProvas = JSON.parse(scoresProvas); } catch { scoresProvas = {}; }
    }
    // Atualiza/adiciona o score da prova atual
    scoresProvas[provaKey] = score;
    const { error: updateError } = await supabase
      .from('candidaturas')
      .update({ scores_provas: scoresProvas, status: 'Provas' })
      .eq('id', candidato.id);

    if (updateError) {
      console.error('Erro ao atualizar score_prova:', updateError.message);
      return res.status(500).json({ error: 'Erro ao atualizar score_prova.' });
    }

    console.log(`Score atualizado com sucesso para o candidato ${candidato.nome} (id: ${candidato.id})!`);
    return res.json({ success: true, candidato: candidato.nome, id: candidato.id, score });
  } catch (err) {
    console.error('Erro inesperado:', err.message);
    return res.status(500).json({ error: 'Erro inesperado.' });
  }
});

// Health check para Render
app.get('/', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Backend Gestão RH funcionando',
    timestamp: new Date().toISOString(),
    endpoints: {
      webhook_provas: '/webhook-score-prova',
      webhook_principal: '/typeform-webhook'
    }
  });
});

// Após definição do app e do middleware de autenticação
setupUsuariosRoutes(app, auth);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Health check disponível em: http://localhost:${PORT}/`);
  console.log(`Webhook de provas: http://localhost:${PORT}/webhook-score-prova`);
}); 