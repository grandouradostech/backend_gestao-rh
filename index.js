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
const SECRET = process.env.JWT_SECRET || 'supersecret';
console.log('JWT_SECRET em uso:', SECRET);
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

async function processarAnexos(response) {
  try {
    console.log('[WEBHOOK] processarAnexos - response:', JSON.stringify(response.answers, null, 2));
    const campoCurriculo = response.answers.find(a => 
      a.field.id === 'dmlXVJZuZ7BH' // ID do campo de currículo
    );
    if (!campoCurriculo) {
      console.log('[WEBHOOK] Campo de currículo não encontrado.');
      return null;
    }
    if (campoCurriculo.type !== 'file_url' || !campoCurriculo.file_url) {
      console.log('[WEBHOOK] Campo de currículo sem URL do arquivo.');
      return null;
    }
    const fileUrl = campoCurriculo.file_url;
    const fileName = fileUrl.split('/').pop();
    const ext = fileName.split('.').pop().toLowerCase();
    let contentType = 'application/octet-stream';
    if (ext === 'pdf') contentType = 'application/pdf';
    if (['jpg', 'jpeg'].includes(ext)) contentType = 'image/jpeg';
    if (ext === 'png') contentType = 'image/png';
    console.log(`[WEBHOOK] Baixando arquivo ${fileName} (${fileUrl})...`);
    const resposta = await fetch(fileUrl, {
      headers: { Authorization: `Bearer ${process.env.TYPEFORM_TOKEN}` }
    });
    if (!resposta.ok) {
      console.log(`[WEBHOOK] Falha ao baixar arquivo do Typeform. Status: ${resposta.status}`);
      return null;
    }
    const buffer = await resposta.buffer();
    console.log(`[WEBHOOK] Upload para Supabase Storage...`);
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
    if (error) {
      console.log(`[WEBHOOK] Erro no upload para Supabase:`, error.message);
      return null;
    }
    console.log(`[WEBHOOK] Upload concluído em ${response.response_id}/${fileName}`);
    return `${response.response_id}/${fileName}`;
  } catch (error) {
    console.error('[WEBHOOK] Erro no upload do currículo:', error.message);
    return null;
  }
}

// Middleware para autenticação
function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  console.log('Authorization header:', authHeader);
  if (!authHeader) return res.status(401).json({ error: 'Token não enviado' });
  const token = authHeader.split(' ')[1];
  try {
    const user = jwt.verify(token, SECRET);
    req.user = user;
    next();
  } catch (e) {
    console.log('Erro JWT:', e.message);
    return res.status(401).json({ error: 'Token inválido' });
  }
}

// Middleware para gestor
function onlyGestor(req, res, next) {
  if (req.user?.role !== 'gestor') return res.status(403).json({ error: 'Apenas gestor pode realizar esta ação' });
  next();
}

// Rota para receber webhook do Typeform (multi-formulário, análise IA completa)
app.post('/typeform-webhook', async (req, res) => {
  try {
    const response = req.body.form_response || req.body;
    const formId = response.form_id;
    const FORM_IDS = ['ynFUyrAc', 'i6GB06nW', 'OejwZ32V', 'CSwzgeg5'];
    if (!FORM_IDS.includes(formId)) {
      return res.status(400).json({ error: 'form_id não permitido' });
    }
    // Garante que response_id nunca é null
    const responseId = response.response_id || response.token || ('id-teste-' + Date.now());
    // Processar anexos (currículo)
    const caminhoCurriculo = await processarAnexos(response);
    // Estruturar dados
    let dados_estruturados = null;
    try {
      dados_estruturados = await estruturarDados(response);
    } catch (e) {
      console.error('Erro ao estruturar dados:', e.message);
    }
    // Buscar requisitos da vaga
    let vaga_nome = dados_estruturados?.profissional?.vaga || null;
    let requisitosVaga = null;
    if (vaga_nome) {
      const { data: reqs, error: reqsError } = await supabase
        .from('requisitos')
        .select('*')
        .ilike('vaga_nome', `%${vaga_nome}%`)
        .maybeSingle();
      if (reqsError) {
        console.error('Erro ao buscar requisitos:', reqsError.message);
      }
      requisitosVaga = reqs;
    }
    // Montar prompt para IA
    let prompt = '';
    if (requisitosVaga) {
      prompt = `Vaga: ${vaga_nome}
Requisitos obrigatórios: ${requisitosVaga.requisito || '-'}
Diferenciais: ${requisitosVaga.diferencial || '-'}
\nDados do candidato:\n${JSON.stringify(dados_estruturados, null, 2)}\n`;
      if (caminhoCurriculo) {
        prompt += `\nCurrículo: (arquivo em ${caminhoCurriculo})`;
      }
      prompt += '\nAnalise se o candidato atende a cada requisito e diferencial. Dê um score de 0 a 100 de aderência à vaga e explique brevemente.';
    } else {
      prompt = `Dados do candidato:\n${JSON.stringify(dados_estruturados, null, 2)}\n`;
    }
    // Chamar IA (usando função existente, mas passando prompt customizado)
    let analise = null;
    try {
      analise = await analisarCandidatura({ ...response, prompt_custom: prompt }, caminhoCurriculo);
    } catch (e) {
      console.error('Erro na análise IA:', e.message);
    }
    // Extrair nome do candidato
    function nomeValido(nome) {
      if (!nome) return false;
      if (/^\d{11}$/.test(nome)) return false;
      if (/^\d{10,}$/.test(nome)) return false;
      if (nome.toLowerCase() === 'texto') return false;
      if (nome.length < 2) return false;
      return true;
    }
    let nome = dados_estruturados?.pessoal?.nome || '';
    if (!nomeValido(nome)) {
      // Busca nos campos do Typeform
      let nomeTypeform = null;
      if (Array.isArray(response.answers)) {
        const nomeAnswer = response.answers.find(ans => ans.field && (ans.field.id === 'oq4YGUe70Wk6' || ans.field.id === '6VkDMDJph5Jc'));
        if (nomeAnswer && nomeAnswer.text) {
          nomeTypeform = nomeAnswer.text;
        }
      }
      nome = nomeValido(nomeTypeform) ? nomeTypeform : 'Não identificado';
    }
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
        updated_at: new Date().toISOString(),
        status: response.status || 'Analisado por IA',
        nome
      }, { onConflict: 'response_id' });
    if (error) throw error;
    res.status(200).send('Dados salvos com sucesso!');
  } catch (err) {
    console.error('Erro:', err);
    res.status(500).send('Erro ao processar os dados');
  }
});

// Endpoint PATCH para atualizar status e enviar UltraMsg se reprovado
app.patch('/candidaturas/:response_id/status', async (req, res) => {
  const { response_id } = req.params;
  const { status, assumido_por, assumido_por_nome, data_entrevista, observacao } = req.body;
  try {
    // Busca o candidato atual para ver se já tem assumido_em e status_history
    const { data: candidatoAtual, error: errorBusca } = await supabase
      .from('candidaturas')
      .select('*')
      .eq('response_id', response_id)
      .single();
    if (errorBusca) {
      console.error('Erro ao buscar candidato:', errorBusca);
      return res.status(500).json({ error: 'Erro ao buscar candidato' });
    }
    // Mapeamento de status para campos de fase (case-insensitive)
    const faseCampos = {
      'analisado por ia': 'fase_analisado',
      'provas': 'fase_provas',
      'aprovado': 'fase_aprovados',
      'entrevista': 'fase_entrevista',
    };
    const statusKey = (status || '').toLowerCase().trim();
    // Descobre a fase anterior (último status diferente do novo)
    let faseAnterior = null;
    let faseAnteriorCampo = null;
    if (Array.isArray(candidatoAtual.status_history) && candidatoAtual.status_history.length > 0) {
      for (let i = candidatoAtual.status_history.length - 1; i >= 0; i--) {
        const prev = candidatoAtual.status_history[i];
        const prevKey = (prev.status || '').toLowerCase().trim();
        if (prevKey !== statusKey && faseCampos[prevKey]) {
          faseAnterior = prev.status;
          faseAnteriorCampo = faseCampos[prevKey];
          break;
        }
      }
    }
    // Fase atual (nova)
    const faseAtualCampo = faseCampos[statusKey];
    // Monta objeto de update
    const updateObj = { status, updated_at: new Date().toISOString() };
    if (assumido_por) updateObj.assumido_por = assumido_por;
    if (assumido_por_nome) updateObj.assumido_por_nome = assumido_por_nome;
    if (!candidatoAtual.assumido_em && assumido_por) {
      updateObj.assumido_em = new Date().toISOString();
    }
    if (data_entrevista) updateObj.data_entrevista = data_entrevista;
    if (typeof observacao === 'string') updateObj.observacao = observacao;
    // Atualiza status_history
    const agora = new Date().toISOString();
    let novoHistorico = Array.isArray(candidatoAtual.status_history) ? [...candidatoAtual.status_history] : [];
    if (!novoHistorico.length || novoHistorico[novoHistorico.length - 1].status !== status) {
      novoHistorico.push({ status, data: agora });
    }
    updateObj.status_history = novoHistorico;
    // Atualiza início da nova fase
    if (faseAtualCampo && !candidatoAtual[`${faseAtualCampo}_inicio`]) {
      updateObj[`${faseAtualCampo}_inicio`] = agora;
    }
    // Atualiza fim da fase anterior
    if (faseAnteriorCampo && !candidatoAtual[`${faseAnteriorCampo}_fim`]) {
      updateObj[`${faseAnteriorCampo}_fim`] = agora;
    }
    // Preencher contratado_em ou reprovado_em ao entrar nesses status
    if (statusKey === 'contratado' && !candidatoAtual.contratado_em) {
      updateObj.contratado_em = agora;
    }
    if (statusKey === 'reprovado' && !candidatoAtual.reprovado_em) {
      updateObj.reprovado_em = agora;
    }
    // Atualiza status e quem assumiu no Supabase
    const { data, error } = await supabase
      .from('candidaturas')
      .update(updateObj)
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
        telefone = telefone.replace(/[^\d+]/g, '');
        if (!telefone.startsWith('+')) {
          telefone = '+55' + telefone;
        }
        const msg = `Olá, ${nome}! Tudo bem?\n\nAgradecemos por demonstrar interesse em fazer parte da nossa equipe.\nApós análise do seu perfil, não seguiremos com o seu processo no momento.\nDesejamos sucesso na sua jornada profissional!\n\nAtenciosamente,\n\nGente e Gestão.`;
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
    // Enviar mensagem de banco de talentos
    if (statusKey === 'banco de talentos') {
      if (telefone) {
        telefone = telefone.replace(/[^\d+]/g, '');
        if (!telefone.startsWith('+')) {
          telefone = '+55' + telefone;
        }
        const msg = `BANCO DE TALENTOS\n\nOlá ${nome}! Tudo bem?\n\nAgradecemos por sua participação em nosso processo seletivo.\nGostaríamos de informar que seu currículo foi incluído em nosso banco de talentos. Caso surjam futuras oportunidades que estejam alinhadas ao seu perfil, entraremos em contato.\nDesejamos sucesso em sua trajetória profissional e esperamos poder contar com você em breve!\n\nAtenciosamente,\n\nGente e Gestão.`;
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
            console.log('UltraMsg enviado (banco de talentos):', JSON.stringify(response.data));
          })
          .catch(function (error) {
            console.error('Erro UltraMsg (banco de talentos):', error);
          });
      } else {
        console.log('Telefone não encontrado para envio UltraMsg (banco de talentos)');
      }
    }
    // Enviar mensagem de entrevista se status for Entrevista
    if (statusKey === 'entrevista') {
      if (telefone) {
        telefone = telefone.replace(/[^\d+]/g, '');
        if (!telefone.startsWith('+')) {
          telefone = '+55' + telefone;
        }
        // Formatar data para mensagem (sem segundos)
        let dataEntrevistaStr = candidato.data_entrevista ? new Date(candidato.data_entrevista).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' }) : 'a definir';
        const msg = `Olá, ${nome}. Tudo bem?\n\nSua entrevista ficou marcada para ${dataEntrevistaStr}.\n\nREGRAS PARA ACESSO NA AMBEV – GRAN DOURADOS:\n1. Deve-se apresentar documento de identificação com foto.\n2. Caso esteja utilizando um veículo, é possível estacionar no estacionamento externo ou na via lateral da rodovia.\n3. Todos os visitantes passarão por um breve treinamento de segurança sobre circulação interna.\n4. Não vir de blusa de time, chinelo.\n5. Vir de calça jeans e tênis ou botina.\n\nEndereço: Rodovia BR-163, km 268, sem número (Após a PRF).`;
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
            console.log('UltraMsg enviado (entrevista):', JSON.stringify(response.data));
          })
          .catch(function (error) {
            console.error('Erro UltraMsg (entrevista):', error);
          });
      } else {
        console.log('Telefone não encontrado para envio UltraMsg (entrevista)');
      }
    }
    // Enviar mensagem de provas se status for Provas
    if (statusKey === 'provas') {
      // Buscar vaga do candidato
      let vaga = candidato.dados_estruturados?.profissional?.vaga || candidato.dados_completos?.profissional?.vaga || '';
      vaga = vaga.toLowerCase();
      // Regras para provas
      let provasLinks = [
        'Português e Matemática: https://granddos.typeform.com/to/OrKerl6D'
      ];
      if (vaga.includes('cnh') || vaga.includes('motorista')) {
        provasLinks.push('Prova de Direção: https://granddos.typeform.com/to/Z59Mv1sY');
      }
      if (vaga.includes('admin')) {
        provasLinks = [
          'Noções básicas da língua portuguesa para vagas administrativas: https://admin.typeform.com/form/qWTxbaIK/create?block=682f389f-7324-4f8c-90dc-6e6459ef6615'
        ];
      }
      // Mensagem formal
      const msg = `Olá! Você avançou para a fase de provas do nosso processo seletivo. Para continuarmos com sua candidatura, precisamos que você responda as seguintes provas:\n\n${provasLinks.join('\n')}\n\nElas são essenciais para a continuidade do processo e não vão levar muito tempo. Contamos com sua participação!`;
      // Enviar via UltraMsg
      if (telefone) {
        let tel = telefone.replace(/[^\d+]/g, '');
        if (!tel.startsWith('+')) {
          tel = '+55' + tel;
        }
        const dataMsg = qs.stringify({
          "token": "nz7n5zoux1sjduar",
          "to": tel,
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
            console.log('UltraMsg enviado (provas):', JSON.stringify(response.data));
          })
          .catch(function (error) {
            console.error('Erro UltraMsg (provas):', error);
          });
      } else {
        console.log('Telefone não encontrado para envio UltraMsg (provas)');
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Erro PATCH status:', err);
    res.status(500).json({ error: 'Erro ao atualizar status' });
  }
});

// Login
app.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ error: 'Email e senha obrigatórios' });
  const { data: users, error } = await supabase.from('usuarios_rh').select('*').eq('email', email).limit(1);
  if (error || !users || users.length === 0) return res.status(401).json({ error: 'Usuário não encontrado' });
  const user = users[0];
  const ok = await bcrypt.compare(senha, user.senha);
  if (!ok) return res.status(401).json({ error: 'Senha inválida' });
  const token = jwt.sign({ id: user.id, nome: user.nome, email: user.email, role: user.role, imagem_url: user.imagem_url }, SECRET, { expiresIn: '12h' });
  res.json({ token, user: { id: user.id, nome: user.nome, email: user.email, role: user.role, imagem_url: user.imagem_url } });
});

// Dados do usuário autenticado
app.get('/me', auth, async (req, res) => {
  res.json({ user: req.user });
});

// Criar novo usuário (apenas gestor)
app.post('/usuarios', auth, onlyGestor, async (req, res) => {
  const { nome, email, senha, role, imagem_url } = req.body;
  if (!nome || !email || !senha || !role) return res.status(400).json({ error: 'Campos obrigatórios' });
  if (!['gestor', 'convidado'].includes(role)) return res.status(400).json({ error: 'Role inválido' });
  const hash = await bcrypt.hash(senha, 10);
  const { data, error } = await supabase.from('usuarios_rh').insert([{ nome, email, senha: hash, role, imagem_url }]);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Endpoint para listar vagas com data de abertura
app.get('/vagas', (req, res) => {
  const vagasPath = path.join(__dirname, 'vagas.json');
  fs.readFile(vagasPath, 'utf8', (err, data) => {
    if (err) {
      return res.status(500).json({ error: 'Erro ao ler vagas.json' });
    }
    try {
      const vagas = JSON.parse(data);
      res.json(vagas);
    } catch (e) {
      res.status(500).json({ error: 'Erro ao parsear vagas.json' });
    }
  });
});

// Endpoint para remover candidato
app.delete('/candidaturas/:response_id', async (req, res) => {
  const { response_id } = req.params;
  try {
    const { error } = await supabase
      .from('candidaturas')
      .delete()
      .eq('response_id', response_id);
    if (error) {
      console.error('Erro ao deletar candidato:', error);
      return res.status(500).json({ error: 'Erro ao deletar candidato' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao deletar candidato:', err);
    res.status(500).json({ error: 'Erro ao deletar candidato' });
  }
});

// Endpoint para atualizar manualmente a vaga do candidato
app.patch('/candidaturas/:response_id/vaga', async (req, res) => {
  const { response_id } = req.params;
  const { nova_vaga } = req.body;
  try {
    // Busca o candidato atual
    const { data: candidatoAtual, error: errorBusca } = await supabase
      .from('candidaturas')
      .select('dados_estruturados')
      .eq('response_id', response_id)
      .single();
    if (errorBusca || !candidatoAtual) {
      return res.status(404).json({ error: 'Candidato não encontrado' });
    }
    // Atualiza o campo de vaga
    const dados = candidatoAtual.dados_estruturados || {};
    if (!dados.profissional) dados.profissional = {};
    dados.profissional.vaga = nova_vaga;
    const { error } = await supabase
      .from('candidaturas')
      .update({ dados_estruturados: dados, updated_at: new Date().toISOString() })
      .eq('response_id', response_id);
    if (error) {
      return res.status(500).json({ error: 'Erro ao atualizar vaga' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar vaga' });
  }
});

// Endpoint para calcular tempo médio por fase de uma vaga
app.get('/vagas/:vaga_id/tempo-medio-fases', async (req, res) => {
  const { vaga_id } = req.params;
  try {
    // Busca todas as candidaturas dessa vaga
    const { data: candidaturas, error } = await supabase
      .from('candidaturas')
      .select(`fase_analisado_inicio, fase_analisado_fim, fase_provas_inicio, fase_provas_fim, fase_aprovados_inicio, fase_aprovados_fim, fase_entrevista_inicio, fase_entrevista_fim, dados_estruturados`)
      .neq('deleted', true); // caso tenha soft delete
    if (error) return res.status(500).json({ error: 'Erro ao buscar candidaturas' });
    // Filtra candidaturas da vaga
    const candidaturasVaga = candidaturas.filter(c => c.dados_estruturados?.profissional?.vaga === vaga_id);
    // Função para calcular média em dias
    function mediaDias(lista) {
      if (!lista.length) return null;
      return lista.reduce((a, b) => a + b, 0) / lista.length;
    }
    // Para cada fase, calcula a diferença em dias
    const fases = [
      { nome: 'fase_analisado', ini: 'fase_analisado_inicio', fim: 'fase_analisado_fim' },
      { nome: 'fase_provas', ini: 'fase_provas_inicio', fim: 'fase_provas_fim' },
      { nome: 'fase_aprovados', ini: 'fase_aprovados_inicio', fim: 'fase_aprovados_fim' },
      { nome: 'fase_entrevista', ini: 'fase_entrevista_inicio', fim: 'fase_entrevista_fim' },
    ];
    const resultado = {};
    fases.forEach(fase => {
      const difs = candidaturasVaga
        .map(c => {
          const ini = c[fase.ini] ? new Date(c[fase.ini]) : null;
          const fim = c[fase.fim] ? new Date(c[fase.fim]) : null;
          if (ini && fim) {
            return (fim - ini) / (1000 * 60 * 60 * 24); // dias
          }
          return null;
        })
        .filter(v => v !== null && !isNaN(v));
      resultado[fase.nome] = mediaDias(difs);
    });
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao calcular tempo médio por fase' });
  }
});

// Endpoint para receber webhook das provas do Typeform
app.post('/webhook-prova', async (req, res) => {
  try {
    const response = req.body.form_response || req.body;
    // Extrair possíveis identificadores do Typeform
    let email = null, cpf = null, telefone = null, nome = null, responseId = null, criterioUsado = null;
    if (Array.isArray(response.answers)) {
      for (const ans of response.answers) {
        // E-mail
        if (ans.email) email = ans.email;
        if (ans.text && /^[\w.-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(ans.text)) email = ans.text;
        // CPF (11 dígitos)
        if (ans.text && /^\d{11}$/.test(ans.text.replace(/\D/g, ''))) cpf = ans.text.replace(/\D/g, '');
        // Telefone (>=10 dígitos)
        if (ans.phone_number) telefone = ans.phone_number.replace(/\D/g, '');
        if (ans.text && /^\d{10,}$/.test(ans.text.replace(/\D/g, ''))) telefone = ans.text.replace(/\D/g, '');
        // Nome (duas palavras, cada uma com pelo menos 2 letras)
        if (ans.text && /[A-Za-zÀ-ÿ]{2,}\s+[A-Za-zÀ-ÿ]{2,}/.test(ans.text)) nome = ans.text.trim();
      }
    }
    responseId = response.response_id || response.token;
    console.log('[WEBHOOK DEBUG] Extraído:', { email, cpf, telefone, nome, responseId });
    // 1. Tenta por e-mail
    let { data: candidato } = await supabase
      .from('candidaturas')
      .select('*')
      .eq('email', email)
      .single();
    if (candidato) criterioUsado = 'email';
    // 2. Se não achou, tenta por CPF
    if (!candidato && cpf) {
      const { data } = await supabase
        .from('candidaturas')
        .select('*')
        .eq('cpf', cpf)
        .single();
      candidato = data;
      if (candidato) criterioUsado = 'cpf';
    }
    // 3. Se não achou, tenta por telefone
    if (!candidato && telefone) {
      const { data } = await supabase
        .from('candidaturas')
        .select('*')
        .eq('telefone', telefone)
        .single();
      candidato = data;
      if (candidato) criterioUsado = 'telefone';
    }
    // 4. Se não achou, tenta por response_id
    if (!candidato && responseId) {
      const { data } = await supabase
        .from('candidaturas')
        .select('*')
        .eq('response_id', responseId)
        .single();
      candidato = data;
      if (candidato) criterioUsado = 'response_id';
    }
    // 5. Se não achou, tenta por nome (atenção: pode dar falso positivo)
    if (!candidato && nome) {
      // Função para sanitizar nome: remove parênteses, acentos, espaços extras e deixa minúsculo
      function sanitizarNome(str) {
        if (!str) return '';
        return str
          .normalize('NFD').replace(/[ -]/g, '') // remove acentos
          .replace(/[()]/g, '') // remove parênteses
          .replace(/\s+/g, ' ') // espaços múltiplos para um só
          .trim()
          .toLowerCase();
      }
      const nomeSanitizado = sanitizarNome(nome);
      // Busca todos os candidatos e compara nome sanitizado
      const { data: candidatos } = await supabase
        .from('candidaturas')
        .select('*, dados_estruturados')
        .limit(1000); // limite de segurança
      if (Array.isArray(candidatos)) {
        candidato = candidatos.find(c => {
          const nomeBanco = sanitizarNome(c.nome);
          const nomeEstruturado = sanitizarNome(c.dados_estruturados?.pessoal?.nome);
          return nomeBanco === nomeSanitizado || nomeEstruturado === nomeSanitizado;
        });
        if (candidato) criterioUsado = 'nome';
      }
    }
    if (!candidato) {
      console.log('[WEBHOOK DEBUG] Nenhum candidato encontrado por nenhum critério!');
      return res.status(404).json({ error: 'Candidato não encontrado por nenhum identificador' });
    }
    console.log(`[WEBHOOK DEBUG] Candidato encontrado! id: ${candidato.id}, critério: ${criterioUsado}`);
    // Montar prompt para IA
    const respostas = (response.answers || []).map(ans => {
      if (ans.text) return ans.text;
      if (ans.email) return ans.email;
      if (ans.number) return ans.number.toString();
      if (ans.boolean !== undefined) return ans.boolean ? 'Sim' : 'Não';
      return '';
    }).join('\n');
    const prompt = `Avalie as respostas abaixo de 0 a 100, considerando clareza, correção e completude. Apenas retorne o número:\n\n${respostas}`;
    // Chamar IA (OpenAI modelo barato)
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 10,
        temperature: 0
      })
    });
    const openaiData = await openaiRes.json();
    const nota = parseInt(openaiData.choices?.[0]?.message?.content.match(/\d+/)?.[0] || '0', 10);
    // Mapear form_id para coluna
    const formId = response.form_id;
    const FORM_IDS = {
      simples: 'OrKerl6D', // Português e Matemática
      direcao: 'Z59Mv1sY', // Prova de Direção
      admin: 'qWTxbaIK' // Português para Administrativo
    };
    let updateObj = {};
    let colunaNota = null;
    if (formId === FORM_IDS.simples) { updateObj.nota_prova_simples = nota; colunaNota = 'nota_prova_simples'; }
    else if (formId === FORM_IDS.direcao) { updateObj.nota_prova_direcao = nota; colunaNota = 'nota_prova_direcao'; }
    else if (formId === FORM_IDS.admin) { updateObj.nota_prova_admin = nota; colunaNota = 'nota_prova_admin'; }
    console.log(`[WEBHOOK DEBUG] formId: ${formId}, coluna a atualizar: ${colunaNota}, nota: ${nota}`);
    if (Object.keys(updateObj).length > 0) {
      await supabase
        .from('candidaturas')
        .update(updateObj)
        .eq('response_id', candidato.response_id);
    }
    res.json({ ok: true, nota, coluna: colunaNota, criterio: criterioUsado, candidato_id: candidato.id });
  } catch (err) {
    console.error('Erro no webhook de prova:', err);
    res.status(500).json({ error: 'Erro ao processar webhook de prova' });
  }
});

// DEBUG LOG para todas as requisições de requisitos
app.use((req, res, next) => {
  if (req.url.startsWith('/requisitos')) {
    console.log('[DEBUG][REQUISITOS] Método:', req.method, 'URL:', req.url, 'Body:', req.body);
  }
  next();
});

// ENDPOINTS DE REQUISITOS (NOVO MODELO)
// Listar requisitos
app.get('/requisitos', async (req, res) => {
  try {
    const { data, error } = await supabase.from('requisitos').select('id, vaga_nome, requisito, diferencial').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar requisitos' });
  }
});
// Inserir requisito
app.post('/requisitos', async (req, res) => {
  const { vaga_nome, requisito, diferencial } = req.body;
  if (!vaga_nome || !requisito) return res.status(400).json({ error: 'Campos obrigatórios' });
  try {
    const { data, error } = await supabase.from('requisitos').insert([{ vaga_nome, requisito, diferencial }]).select();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao inserir requisito' });
  }
});
// Remover requisito
app.delete('/requisitos/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabase.from('requisitos').delete().eq('id', id);
    console.log('[DEBUG][DELETE /requisitos/:id] id:', id, 'error:', error);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    console.error('[DEBUG][DELETE /requisitos/:id] catch:', err);
    res.status(500).json({ error: 'Erro ao remover requisito' });
  }
});

// --- ANOTAÇÕES DO GESTOR ---

// Listar anotações do gestor logado
app.get('/anotacoes', auth, async (req, res) => {
  const { user } = req;
  const { data, error } = await supabase
    .from('anotacoes')
    .select('*')
    .eq('usuario_id', user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Criar nova anotação
app.post('/anotacoes', auth, async (req, res) => {
  const { anotacao } = req.body;
  const { user } = req;
  if (!anotacao || !anotacao.trim()) return res.status(400).json({ error: 'Anotação obrigatória' });
  const { data, error } = await supabase
    .from('anotacoes')
    .insert([{
      usuario_id: user.id,
      usuario_nome: user.nome,
      anotacao
    }])
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

// Atualizar anotação (só do próprio usuário)
app.patch('/anotacoes/:id', auth, async (req, res) => {
  const { id } = req.params;
  const { anotacao } = req.body;
  const { user } = req;
  if (!anotacao || !anotacao.trim()) return res.status(400).json({ error: 'Anotação obrigatória' });
  const { data, error } = await supabase
    .from('anotacoes')
    .update({ anotacao, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('usuario_id', user.id)
    .select();
  if (error || !data || !data[0]) return res.status(500).json({ error: error?.message || 'Não encontrado' });
  res.json(data[0]);
});

// Deletar anotação (só do próprio usuário)
app.delete('/anotacoes/:id', auth, async (req, res) => {
  const { id } = req.params;
  const { user } = req;
  const { error } = await supabase
    .from('anotacoes')
    .delete()
    .eq('id', id)
    .eq('usuario_id', user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
}); 