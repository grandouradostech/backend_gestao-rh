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
const fs = require('fs');
const path = require('path');

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

// Middleware para autenticação
function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Token não enviado' });
  const token = authHeader.split(' ')[1];
  try {
    const user = jwt.verify(token, SECRET);
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }
}

// Middleware para gestor
function onlyGestor(req, res, next) {
  if (req.user?.role !== 'gestor') return res.status(403).json({ error: 'Apenas gestor pode realizar esta ação' });
  next();
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

    // Enviar mensagem UltraMsg se status for Reprovado
    let status = analise?.status || analise?.kanban_status || analise?.resultado || null;
    let telefone = (dados_estruturados && dados_estruturados.pessoal && dados_estruturados.pessoal.telefone) || null;
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
  const { status, assumido_por, assumido_por_nome } = req.body;
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
}); 